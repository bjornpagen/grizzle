/**
 * The chains a refill's reads follow (write/frontend/refill.ts): from a change of a stratum to the rows it reaches,
 * through each owner axis it cascades along and each refilled family's groups, to the groups a refill rewrites or the
 * owner rows a cascade carries a change through. A chain's rows are read in the one read flight before any write
 * (write/family/statements.ts chainReadSql).
 */
import { familyKey } from "#compiler/analysis/theory/families.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"

/**
 * Rows of one relation a chain reaches: a put's rows by the keys of its slot's facts; the members of the groups the
 * previous rows own in `family` (a cascade along its owner axis); the owners of the previous groups; or their members
 * from each group's least slot.
 */
export type RowsOf =
	| { readonly kind: "put"; readonly relation: RelationInfo; readonly slot: ParamId }
	| { readonly kind: "cascade"; readonly family: Family; readonly from: RowsOf }
	| { readonly kind: "owners"; readonly family: Family; readonly from: GroupsOf }
	| { readonly kind: "members"; readonly family: Family; readonly from: GroupsOf }

/**
 * Groups of one family a chain reaches: the groups the stratum's edit of the family's members touches, as its own read
 * keys them; or the groups the previous rows stand in, each from the least slot of those rows.
 */
export type GroupsOf =
	| { readonly kind: "touched"; readonly family: Family }
	| { readonly kind: "groups"; readonly family: Family; readonly from: RowsOf }

/** The relation rows a chain reaches are of. */
export const rowsRelation = (rows: RowsOf): RelationInfo => {
	switch (rows.kind) {
		case "put":
			return rows.relation
		case "cascade":
		case "members":
			return rows.family.member
		case "owners":
			return rows.family.owner
	}
}

/**
 * A read a stratum's refills need: a refilled family's groups a chain reaches, read as a family's suffix read reads
 * them, a tree's whole; or the rows of an owner a cascade reaches before it carries a change into a member of `family`
 * a write or a refill of the stratum rewrites. Either reads every row its chain passes whole.
 */
export type RefillRead =
	| { readonly kind: "groups"; readonly groups: Extract<GroupsOf, { readonly kind: "groups" }> }
	| { readonly kind: "rows"; readonly rows: RowsOf; readonly family: Family }

/** Rows' chain as text that two chains share exactly when they are one chain. */
export const rowsKey = (rows: RowsOf): string => {
	switch (rows.kind) {
		case "put":
			return `put(${rows.relation.name})`
		case "cascade":
			return `cascade(${familyKey(rows.family.id)},${rowsKey(rows.from)})`
		case "owners":
			return `owners(${familyKey(rows.family.id)},${groupsKey(rows.from)})`
		case "members":
			return `members(${familyKey(rows.family.id)},${groupsKey(rows.from)})`
	}
}

/** Groups' chain as text that two chains share exactly when they are one chain. */
export const groupsKey = (groups: GroupsOf): string =>
	groups.kind === "touched"
		? `touched(${familyKey(groups.family.id)})`
		: `groups(${familyKey(groups.family.id)},${rowsKey(groups.from)})`
