import { isCanonicalName } from "#compiler/analysis/derived/canonical.ts"
import type {
	InsertsFact,
	IsolationInput,
	MemberFacts,
	Reference,
	RelationFacts,
	RoleFacts,
	TriggerLaw
} from "#compiler/analysis/isolation/facts.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { columnKey } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { OwnedRelation } from "#compiler/schema/own.ts"

/**
 * One role of one login as the isolation facts read it: the login's and the role's names, what its grant plan is read
 * from (`checked`, its checked schema), the names its members' statements are resolved through, and its change
 * members, each by its name with its compile as the extractor takes it. The builder reads none of them but the names:
 * each goes to the function that reads it.
 */
export interface RoleSource<Checked, Names, Compiled> {
	readonly login: string
	readonly role: string
	readonly checked: Checked
	readonly names: Names
	readonly members: SourceMembers<Compiled>
}

/**
 * A role's change members as the builder takes them: `served`, each by its name with its compile, none where every one
 * of them has no READ COMMITTED form; or `none`, where it has no change member, so its writes are unknown (RoleWrites).
 */
export type SourceMembers<Compiled> =
	| {
			readonly kind: "served"
			readonly members: ReadonlyArray<{ readonly name: string; readonly compiled: Compiled }>
	  }
	| { readonly kind: "none" }

/**
 * What an installation's isolation facts are built from: its law model, over every relation, every
 * role of every login over its base, and the function that gives each part of the facts, each its owner's:
 *
 * - `triggerLawsOver` (laws/model/model.ts): the laws a relation's rule-over-query triggers still discharge, each with
 *   its rule's witnesses;
 * - `grantedPrivileges` (physical/ddl/roles.ts): a role's table privileges by relation, as its grant plan holds them;
 * - `readableRelations` (physical/ddl/roles.ts): every relation a statement of a role can read, as its grants let it,
 *   which bounds the reads of a role with no change member;
 * - `memberFacts` (program/isolation/extract.ts): a change member's statements, one set per variant of it that sends
 *   any.
 *
 * Each is required, so a fact no builder gives is a type error, never a default.
 */
export interface IsolationSources<Checked, Names, Compiled> {
	readonly model: LawModel
	readonly roles: ReadonlyArray<RoleSource<Checked, Names, Compiled>>
	readonly triggerLawsOver: (model: LawModel, relation: string) => ReadonlyArray<TriggerLaw>
	readonly grantedPrivileges: (
		model: LawModel,
		checked: Checked
	) => ReadonlyMap<string, ReadonlySet<TablePrivilege>>
	readonly readableRelations: (model: LawModel, checked: Checked) => ReadonlyArray<string>
	readonly memberFacts: (
		name: string,
		compiled: Compiled,
		names: Names
	) => ReadonlyArray<MemberFacts>
}

/** Values by the declared name of the relation each belongs to, each relation's in the order given. */
const byRelation = <V>(
	entries: ReadonlyArray<readonly [string, V]>
): ReadonlyMap<string, ReadonlyArray<V>> => {
	const grouped = new Map<string, Array<V>>()
	for (const [relation, value] of entries) {
		grouped.getOrInsertComputed(relation, () => []).push(value)
	}
	return grouped
}

/**
 * The declared keys of each relation by its declared name, each by its columns' texts (ir/law.ts columnKey): its
 * primary key's native and each UNIQUE native, a law column by its identifier, so a key a law adds over law columns (a
 * selected side's, a family's slot) is the key PostgreSQL enforces, which a check by those columns
 * finds one row of at most and no read of fields alone binds whole. A span key (WITHOUT OVERLAPS) is no key a read by its
 * columns is a point read of.
 */
const nativeKeys = (model: LawModel): ReadonlyMap<string, ReadonlyArray<ReadonlyArray<string>>> =>
	byRelation(
		model.natives.flatMap(({ object }): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
			if (object.kind === "PrimaryKey") {
				return [[object.relation.name, object.columns.map((field) => field.name)]]
			}
			return object.kind === "Unique" ? [[object.relation.name, object.columns.map(columnKey)]] : []
		})
	)

/**
 * The counted groups of each member relation by its declared name: for each family whose owner is immutable, so the
 * count the owner holds is fixed once it is written, the member's group fields, by name in key order.
 */
const countedGroups = (
	model: LawModel
): ReadonlyMap<string, ReadonlyArray<ReadonlyArray<string>>> =>
	byRelation(
		model.families.flatMap((family): ReadonlyArray<readonly [string, ReadonlyArray<string>]> =>
			family.owner.mutable ? [] : [[family.member.name, family.group.map((g) => g.member.name)]]
		)
	)

/**
 * The references of each relation by its declared name: every foreign key it holds, deferrable or not, a native one, a
 * lowered containment's and a PERIOD key's alike, by the relation it references, that relation's columns it references
 * by their texts in the order of its key, a law column by its identifier as the relation's keys name it, and its ON
 * UPDATE action. A PERIOD key's span is left out, which its check reads by overlap, and its action is NO ACTION.
 */
const nativeReferences = (model: LawModel): ReadonlyMap<string, ReadonlyArray<Reference>> =>
	byRelation(
		model.natives.flatMap(({ object }): ReadonlyArray<readonly [string, Reference]> => {
			if (object.kind === "ForeignKey") {
				const reference: Reference = {
					relation: object.target.name,
					columns: object.targetColumns.map(columnKey),
					onUpdate: object.onUpdate
				}
				return [[object.relation.name, reference]]
			}
			if (object.kind === "PeriodForeignKey") {
				const reference: Reference = {
					relation: object.target.name,
					columns: object.targetColumns.map(columnKey),
					onUpdate: "noAction"
				}
				return [[object.relation.name, reference]]
			}
			return []
		})
	)

/** What an insertion into a relation meets at its primary key: a raced relation's race at that key's fields, any other's
 * a repeatable insertion's. */
const insertsOf = (relation: OwnedRelation): InsertsFact =>
	relation.kind === "relation" && relation.inserts === "race"
		? { kind: "race", key: relation.desc.primaryKey }
		: { kind: "repeatable" }

/** What an insertion into a stored canonical relation's table meets, as into a derived relation's: its upkeep's rows. */
const derivedInserts: InsertsFact = Object.freeze({ kind: "repeatable" })

/**
 * The stored relations a write of each relation keeps, by the relation's name (RelationFacts `upkept`): each stored
 * relation whose upkeep reads its rows (analysis/theory/unit.ts StoredUpkeep `reads`), then each whose upkeep reads one
 * of those, until none is added, each once, in name order.
 */
const upkeptOf = (model: LawModel): ReadonlyMap<string, ReadonlyArray<string>> => {
	const readers = new Map<string, Set<string>>()
	for (const u of model.theory.upkeeps) {
		for (const r of u.reads) {
			readers.getOrInsertComputed(r.relation, () => new Set()).add(u.relation)
		}
	}
	return new Map(
		[...readers.keys()].map((relation) => {
			const kept = new Set<string>()
			const pending = [...(readers.get(relation) ?? [])]
			for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
				if (!kept.has(next)) {
					kept.add(next)
					for (const reader of readers.get(next) ?? []) {
						pending.push(reader)
					}
				}
			}
			return [relation, [...kept].toSorted(compareStrings)] as const
		})
	)
}

/**
 * The facts of every relation the installation holds, by its name (analysis/isolation/facts.ts RelationFacts): each
 * relation the model's owned schema states, at every level, stored, closed and derived alike, by its declared name, and
 * each stored canonical relation of an import no declaration names (analysis/derived/canonical.ts), `__canonical_
 * <digest>`, whose table a write's upkeep keeps, a rule's witness reads by its name and a role reads through its whole
 * view (program/isolation/member-facts.ts extractNames), as a derived relation's: the laws its rule-over-query triggers
 * still discharge (`triggerLawsOver`), its declared keys, its counted groups, its references, what an insertion into
 * it meets, and the stored relations a write of it keeps (`upkeptOf`). The relation half of isolationInput, which the borrow rules' installation reads too
 * (program/isolation/borrows.ts borrowInstallationOf). Before it stated the owned schema's alone, so every role whose
 * writes kept, probed or read an anonymous stored canonical relation failed `facts` by it: edullm's pantry generate at
 * qti-pie 3ab19845, by __canonical_6f6bf243b1e97b31 and __canonical_948062b0814e796f.
 */
export const relationFacts = (
	model: LawModel,
	triggerLawsOver: (model: LawModel, relation: string) => ReadonlyArray<TriggerLaw>
): ReadonlyMap<string, RelationFacts> => {
	const keys = nativeKeys(model)
	const counted = countedGroups(model)
	const references = nativeReferences(model)
	const upkept = upkeptOf(model)
	const factsOf = (name: string, inserts: InsertsFact): readonly [string, RelationFacts] => [
		name,
		{
			triggerLaws: triggerLawsOver(model, name),
			keys: keys.get(name) ?? [],
			countedGroups: counted.get(name) ?? [],
			references: references.get(name) ?? [],
			inserts,
			upkept: upkept.get(name) ?? []
		}
	]
	return new Map<string, RelationFacts>([
		...Object.entries(model.owned.relations).map(([name, relation]) =>
			factsOf(name, insertsOf(relation))
		),
		...model.checked.derived.flatMap((d) =>
			isCanonicalName(d.name) ? [factsOf(d.name, derivedInserts)] : []
		)
	])
}

/**
 * The isolation facts of an installation (analysis/isolation/facts.ts IsolationInput), total by construction: one
 * RelationFacts for every relation it holds (relationFacts), each its owned schema states, at every level, stored,
 * closed and derived alike, by its declared name, and each stored canonical relation no declaration names, by its
 * canonical name, and one RoleFacts for every role of `sources`, in their order, its privileges its grant plan's and its
 * members' facts the extractor's for each of its change members, in member order, every variant's: its writes served,
 * or unknown where it has no change member, so it writes by direct SQL alone, bounded by what its grants let it read
 * (RoleWrites).
 */
export const isolationInput = <Checked, Names, Compiled>(
	sources: IsolationSources<Checked, Names, Compiled>
): IsolationInput => {
	const { model } = sources
	const relations = relationFacts(model, sources.triggerLawsOver)
	const roles = sources.roles.map((role): RoleFacts => ({
		login: role.login,
		role: role.role,
		privileges: sources.grantedPrivileges(model, role.checked),
		writes:
			role.members.kind === "none"
				? { kind: "unknown", readable: sources.readableRelations(model, role.checked) }
				: {
						kind: "served",
						members: role.members.members.flatMap((member) =>
							sources.memberFacts(member.name, member.compiled, role.names)
						)
					}
	}))
	return { relations, roles }
}
