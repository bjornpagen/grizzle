import type {
	IsolationInput,
	MemberFacts,
	RelationFacts,
	RoleFacts
} from "#compiler/analysis/isolation/facts.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
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
 * - `memberFacts` (program/isolation/extract.ts): a change member's statements, one set per variant of it.
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
	) => NonEmptyReadonlyArray<MemberFacts>
}

/**
 * The declared keys of each relation by its declared name, each by its field names: its primary key's native and each
 * UNIQUE native over fields alone. A UNIQUE over a law column is a family's or a fold's, no key a call writes by.
 */
const nativeKeys = (model: LawModel): ReadonlyMap<string, ReadonlyArray<ReadonlyArray<string>>> => {
	const keys = new Map<string, Array<ReadonlyArray<string>>>()
	const add = (relation: string, fields: ReadonlyArray<string>): void => {
		const held = keys.get(relation) ?? []
		held.push(fields)
		keys.set(relation, held)
	}
	for (const { object } of model.natives) {
		if (object.kind === "PrimaryKey") {
			add(
				object.relation.name,
				object.columns.map((field) => field.name)
			)
		} else if (object.kind === "Unique") {
			const fields = object.columns.flatMap((column) =>
				column.kind === "field" ? [column.field.name] : []
			)
			if (fields.length === object.columns.length) {
				add(object.relation.name, fields)
			}
		}
	}
	return keys
}

/**
 * The counted groups of each member relation by its declared name: for each family whose owner is immutable, so the
 * count the owner holds is fixed once it is written, the member's group fields, by name in key order.
 */
const countedGroups = (
	model: LawModel
): ReadonlyMap<string, ReadonlyArray<ReadonlyArray<string>>> => {
	const groups = new Map<string, Array<ReadonlyArray<string>>>()
	for (const family of model.families) {
		if (family.owner.mutable) {
			continue
		}
		const held = groups.get(family.member.name) ?? []
		held.push(family.group.map((g) => g.member.name))
		groups.set(family.member.name, held)
	}
	return groups
}

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
	const relations = new Map<string, RelationFacts>(
		Object.keys(model.owned.relations).map((name) => [
			name,
			{
				triggerLaws: sources.triggerLawsOver(model, name),
				keys: keys.get(name) ?? [],
				countedGroups: counted.get(name) ?? []
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
