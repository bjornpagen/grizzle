import type {
	IsolationInput,
	MemberFacts,
	Reference,
	RelationFacts,
	RoleFacts
} from "#compiler/analysis/isolation/facts.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"

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
	readonly members: ReadonlyArray<{ readonly name: string; readonly compiled: Compiled }>
}

/**
 * What an installation's isolation facts are built from: its whole law model, over every relation (everySlice), every
 * role of every login over its base, and the function that gives each part of the facts, each its owner's:
 *
 * - `triggerLawsOver` (laws/model/model.ts): the laws a relation's rule-over-query triggers still discharge;
 * - `grantedPrivileges` (physical/ddl/roles.ts): a role's table privileges by relation, as its grant plan holds them;
 * - `memberFacts` (program/isolation/extract.ts): a change member's statements, one set per variant of it that sends
 *   any.
 *
 * Each is required, so a fact no builder gives is a type error, never a default.
 */
export interface IsolationSources<Checked, Names, Compiled> {
	readonly model: LawModel
	readonly roles: ReadonlyArray<RoleSource<Checked, Names, Compiled>>
	readonly triggerLawsOver: (model: LawModel, relation: string) => ReadonlyArray<LawId>
	readonly grantedPrivileges: (
		model: LawModel,
		checked: Checked
	) => ReadonlyMap<string, ReadonlySet<TablePrivilege>>
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
		const held = grouped.get(relation)
		if (held === undefined) {
			grouped.set(relation, [value])
		} else {
			held.push(value)
		}
	}
	return grouped
}

/** The fields of native columns by name, in order, each law column left out. */
const fieldsOf = (columns: ReadonlyArray<NativeColumn>): ReadonlyArray<string> =>
	columns.flatMap((column) => (column.kind === "field" ? [column.field.name] : []))

/**
 * The declared keys of each relation by its declared name, each by its field names: its primary key's native and each
 * UNIQUE native over fields alone. A UNIQUE over a law column is a family's or a fold's, no key a call writes by, and
 * a span key (WITHOUT OVERLAPS) is no key a read by its fields is a point read of.
 */
const nativeKeys = (model: LawModel): ReadonlyMap<string, ReadonlyArray<ReadonlyArray<string>>> =>
	byRelation(
		model.natives.flatMap(({ object }): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
			if (object.kind === "PrimaryKey") {
				return [[object.relation.name, object.columns.map((field) => field.name)]]
			}
			if (object.kind !== "Unique") {
				return []
			}
			const fields = fieldsOf(object.columns)
			return fields.length === object.columns.length ? [[object.relation.name, fields]] : []
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
 * lowered containment's and a PERIOD key's alike, by the relation it references, that relation's fields it references
 * in the order of its key and its ON UPDATE action. A law column the key references is left out of its fields, since its
 * value is no field's, so a check by it is never read as a point read; a PERIOD key's span is left out too, which its
 * check reads by overlap, and its action is NO ACTION.
 */
const nativeReferences = (model: LawModel): ReadonlyMap<string, ReadonlyArray<Reference>> =>
	byRelation(
		model.natives.flatMap(({ object }): ReadonlyArray<readonly [string, Reference]> => {
			if (object.kind === "ForeignKey") {
				const reference: Reference = {
					relation: object.target.name,
					fields: fieldsOf(object.targetColumns),
					onUpdate: object.onUpdate
				}
				return [[object.relation.name, reference]]
			}
			if (object.kind === "PeriodForeignKey") {
				const reference: Reference = {
					relation: object.target.name,
					fields: fieldsOf(object.targetColumns),
					onUpdate: "noAction"
				}
				return [[object.relation.name, reference]]
			}
			return []
		})
	)

/**
 * The isolation facts of an installation (analysis/isolation/facts.ts IsolationInput), total by construction: one
 * RelationFacts for every relation its owned schema states, at every level, stored, closed and derived alike, by its
 * declared name, and one RoleFacts for every role of `sources`, in their order, its privileges its grant plan's and its
 * members' facts the extractor's for each of its change members, in member order, every variant's.
 */
export const isolationInput = <Checked, Names, Compiled>(
	sources: IsolationSources<Checked, Names, Compiled>
): IsolationInput => {
	const { model } = sources
	const keys = nativeKeys(model)
	const counted = countedGroups(model)
	const references = nativeReferences(model)
	const relations = new Map<string, RelationFacts>(
		Object.keys(model.owned.relations).map((name) => [
			name,
			{
				triggerLaws: sources.triggerLawsOver(model, name),
				keys: keys.get(name) ?? [],
				countedGroups: counted.get(name) ?? [],
				references: references.get(name) ?? []
			}
		])
	)
	const roles = sources.roles.map((role): RoleFacts => ({
		login: role.login,
		role: role.role,
		privileges: sources.grantedPrivileges(model, role.checked),
		members: role.members.flatMap((member) =>
			sources.memberFacts(member.name, member.compiled, role.names)
		)
	}))
	return { relations, roles }
}
