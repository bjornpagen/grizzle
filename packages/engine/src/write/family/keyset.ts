/**
 * How a family write statement reads its stored tables (write/family/removals.ts, write/delete/unit.ts): from rows the
 * statement holds, a CTE of its own (a slot's facts, a CTE over them, or keys it found before), one hop at a time, each
 * hop a stored relation's rows reached through an access path its installation indexes: the relation's primary key, a
 * tree's root, which the tree relation's primary key leads with, or a family's group on its members, which the owner
 * axis's index on the member leads with (laws/model/plan.ts). A hop names its access path and the value of each field
 * the path binds; the equalities are built here, from the path, so no read built of hops is a condition over every
 * stored row. Such a condition, an OR of EXISTS over the held rows, plans as no semi-join but a sequential scan: a
 * whole-table read per call and a relation SIRead lock, which fails overlapping SERIALIZABLE writers of the relation
 * with 40001.
 */
import { defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { typedEq } from "#compiler/ir/compare.ts"
import type { Family, TreeShape } from "#compiler/ir/family.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { Cte, Expr, FromItem, FromSource, JoinStep, OperandSelect } from "#compiler/sql/ast.ts"
import {
	and,
	col,
	core,
	cte,
	cteRefAs,
	distinctCore,
	select,
	setOperation,
	simpleSelect,
	target
} from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import { internal, one, tableAs } from "#compiler/write/family/written.ts"
import type { WriteContext } from "#compiler/write/insert/statement.ts"

/** A field of a family's group: the member's field and the owner primary-key field it names. */
type GroupPair = Family["group"][number]

/**
 * An access path of a relation that binds its own fields: its primary key, every primary field; or a tree's root, its
 * root fields, which the tree relation's primary key leads with (ir/family.ts TreeShape).
 */
export type Access =
	| { readonly kind: "key"; readonly relation: RelationInfo }
	| { readonly kind: "root"; readonly relation: RelationInfo; readonly tree: TreeShape }

/** The fields an access path binds, in order. */
const accessFields = (access: Access): NonEmptyReadonlyArray<LawField> =>
	access.kind === "key" ? access.relation.primaryFields : access.tree.root

/**
 * One hop of a keyed read: a stored relation's rows under `alias`, reached through an access path its installation
 * indexes, each field the path binds equal to the value `at` gives it from the rows before the hop: its own fields'
 * (`Access`), or, at a family's group, each member field of the group bound to the value of the owner field it names.
 */
export type Hop =
	| (Access & { readonly alias: string; readonly at: (field: LawField) => Expr })
	| {
			readonly kind: "group"
			readonly family: Family
			readonly alias: string
			readonly at: (pair: GroupPair) => Expr
	  }

/** The stored row of `relation` at `alias`, at `field`. */
const storedAt = (w: WriteContext, relation: RelationInfo, alias: string, field: LawField): Expr =>
	col(alias, w.names.column(relation.name, field.name))

/** The equalities a hop's access path binds: each field it binds, as the hop's row holds it, equal to its value. */
const bindings = (w: WriteContext, hop: Hop): NonEmptyReadonlyArray<Expr> =>
	hop.kind === "group"
		? mapNonEmpty(hop.family.group, (g) =>
				typedEq(
					g.member.type,
					storedAt(w, hop.family.member, hop.alias, g.member),
					hop.at(g),
					w.names
				)
			)
		: mapNonEmpty(accessFields(hop), (f) =>
				typedEq(f.type, storedAt(w, hop.relation, hop.alias, f), hop.at(f), w.names)
			)

/** The table a hop reads, under its alias. */
const hopSource = (w: WriteContext, hop: Hop): FromSource =>
	tableAs(w, hop.kind === "group" ? hop.family.member.name : hop.relation.name, hop.alias)

/**
 * The rows one hop reaches from rows outside the query, which its values read, narrowed by `filter`: `SELECT 1 FROM
 * <table> AS <alias> WHERE <bindings> AND <filter>`, for an EXISTS over them.
 */
export const reachedRows = (
	w: WriteContext,
	hop: Hop,
	filter: ReadonlyArray<Expr>
): OperandSelect =>
	simpleSelect([target(one)], [hopSource(w, hop)], and([...bindings(w, hop), ...filter]))

/**
 * Rows a statement holds and the hops that reach stored rows from them: `<held> JOIN <hop> ON <bindings> JOIN ...`,
 * each hop joined to the rows before it; the held rows alone for no hop.
 */
interface Reach {
	/** A CTE of the statement's own and the alias it is read under. */
	readonly held: { readonly cte: string; readonly alias: string }
	readonly hops: ReadonlyArray<Hop>
}

/** A reach as one FROM item. */
const reachFrom = (w: WriteContext, reach: Reach): FromItem => {
	const held = cteRefAs(reach.held.cte, reach.held.alias)
	const step = (hop: Hop): JoinStep => ({
		kind: "on",
		source: hopSource(w, hop),
		on: and(bindings(w, hop))
	})
	const [first, ...rest] = reach.hops
	return first === undefined
		? held
		: { kind: "joins", first: held, steps: [step(first), ...rest.map(step)] }
}

/**
 * One way a family statement finds the keys of an access path: a reach from rows it holds, `where` narrowing the rows
 * it reaches, at the path's fields (`key`, one expression per field in order, as the held rows or the last hop hold
 * it).
 */
export interface KeyArm extends Reach {
	readonly where: Expr | undefined
	readonly key: NonEmptyReadonlyArray<Expr>
}

/**
 * The keys of an access path a family statement finds stored rows at: one CTE, the union of its arms (`KeyArm`), each
 * a reach from rows the statement holds, one column per field the path binds, in order; a relation's primary keys, or
 * a tree's roots.
 */
export interface Keyset {
	readonly name: string
	readonly access: Access
	readonly columns: NonEmptyReadonlyArray<string>
}

/**
 * The keyset of `arms` at `access`, its CTE pushed onto `ctes` as `materialized` says: SELECT DISTINCT for one arm,
 * UNION for more.
 */
export const keysetOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	access: Access,
	arms: NonEmptyReadonlyArray<KeyArm>,
	materialized: Cte["materialized"]
): Keyset => {
	const name = supply.relation(internal("keyset"))
	const columns = mapNonEmpty(accessFields(access), () => supply.column(internal("keyset key")))
	const [first, second, ...rest] = arms
	const armCore = (arm: KeyArm) =>
		core(
			arm.key.map((e) => target(e)),
			[reachFrom(w, arm)],
			arm.where
		)
	ctes.push({
		...cte(
			name,
			[...columns],
			select(
				second === undefined
					? distinctCore(
							mapNonEmpty(first.key, (e) => target(e)),
							[reachFrom(w, first)],
							first.where
						)
					: setOperation("UNION", [armCore(first), armCore(second), ...rest.map(armCore)])
			)
		),
		materialized
	})
	return { name, access, columns }
}

/**
 * The column of a keyset holding the field named as `field` is, by name: a family's group names its owner's key fields
 * as its own law fields, which need not be the very handles the owner relation's are.
 */
export const keysetColumn = (keyset: Keyset, field: LawField): string =>
	defined(
		keyset.columns[accessFields(keyset.access).findIndex((f) => f.name === field.name)],
		`the keyset column of ${keyset.access.relation.name}.${field.name}`
	)

/** The hop from a keyset's row at alias `k` to the stored rows at its keys, under alias `s`. */
export const atKeyset = (k: string, keyset: Keyset, s: string): Hop => ({
	...keyset.access,
	alias: s,
	at: (f: LawField) => col(k, keysetColumn(keyset, f))
})

/** Whether the stored row at alias `s` is at the key of the keyset's row at alias `k`, at every field it binds. */
export const keyedAt = (w: WriteContext, k: string, keyset: Keyset, s: string): Expr =>
	and(bindings(w, atKeyset(k, keyset, s)))

/** The stored rows of `relation` under alias `s` at the keys its arms find (`Keyset`): the keyset joined to them. */
export const storedAtKeys = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	relation: RelationInfo,
	s: string,
	arms: NonEmptyReadonlyArray<KeyArm>
): FromItem => {
	const keyset = keysetOf(w, supply, ctes, { kind: "key", relation }, arms, undefined)
	const k = supply.relation(internal("keyset row"))
	return reachFrom(w, { held: { cte: keyset.name, alias: k }, hops: [atKeyset(k, keyset, s)] })
}

/** The fields an access path binds as the stored row at alias `s` holds them: a primary key, or a tree's root. */
export const storedKey = (
	w: WriteContext,
	access: Access,
	s: string
): NonEmptyReadonlyArray<Expr> =>
	mapNonEmpty(accessFields(access), (f) => storedAt(w, access.relation, s, f))
