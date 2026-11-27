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
 *
 * Keysets relate to each other by one GROUP BY over their keys, each tagged by its keyset (`keysetWhere`,
 * `flaggedKeys`), never by a join of two: a CTE holds no statistics, so PostgreSQL estimates it at a row and may pair
 * every row of one with every row of the other.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { operatorSchemaOf, typedEq } from "#compiler/ir/compare.ts"
import type { Family, TreeShape } from "#compiler/ir/family.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type {
	Cte,
	Expr,
	FromItem,
	FromSource,
	JoinStep,
	OperandSelect,
	Select,
	Target
} from "#compiler/sql/ast.ts"
import {
	and,
	call,
	col,
	core,
	cte,
	cteRefAs,
	derived,
	distinctCore,
	eq,
	lit,
	not,
	operandSelect,
	operandUnionAll,
	provedCore,
	select,
	setOperation,
	simpleSelect,
	target,
	types
} from "#compiler/sql/build.ts"
import { namedBody, namedQuery, type NameSupply } from "#compiler/sql/naming.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import { internal, one, tableAs } from "#compiler/write/family/written.ts"
import type { WriteContext } from "#compiler/write/insert/statement.ts"
import { amongHeld } from "#compiler/write/probe.ts"

/** A field of a family's group: the member's field and the owner primary-key field it names. */
type GroupPair = Family["group"][number]

/**
 * An access path of a relation that binds its own fields: its primary key, every primary field; its stated key, every
 * primary field but a place, which no fact carries and a delete of a place's relation leaves unbound, removing whole
 * groups (write/frontend/instants.ts Removal); or a tree's root, its root fields, which the tree relation's primary key
 * leads with (ir/family.ts TreeShape).
 */
export type Access =
	| { readonly kind: "key"; readonly relation: RelationInfo }
	| { readonly kind: "stated"; readonly relation: RelationInfo }
	| { readonly kind: "root"; readonly relation: RelationInfo; readonly tree: TreeShape }

/** The primary fields of `relation` a fact states: every one but a place. */
export const statedKey = (relation: RelationInfo): NonEmptyReadonlyArray<LawField> => {
	const stated = relation.primaryFields.filter((f) => f.writing.kind !== "place")
	if (!isNonEmpty(stated)) {
		defect(`the primary key of ${relation.name}, a place alone`)
	}
	return stated
}

/** The fields an access path binds, in order. */
const accessFields = (access: Access): NonEmptyReadonlyArray<LawField> => {
	switch (access.kind) {
		case "key":
			return access.relation.primaryFields
		case "stated":
			return statedKey(access.relation)
		case "root":
			return access.tree.root
	}
}

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

/** A reach as one FROM item: its first hop also among the held rows' values (`heldAmong`). */
export const reachFrom = (w: WriteContext, supply: NameSupply, reach: Reach): FromItem => {
	const held = cteRefAs(reach.held.cte, reach.held.alias)
	const step = (hop: Hop, among: ReadonlyArray<Expr>): JoinStep => ({
		kind: "on",
		source: hopSource(w, hop),
		on: and([...bindings(w, hop), ...among])
	})
	const [first, ...rest] = reach.hops
	return first === undefined
		? held
		: {
				kind: "joins",
				first: held,
				steps: [
					step(first, heldAmong(w, supply, reach.held, first)),
					...rest.map((hop) => step(hop, []))
				]
			}
}

/**
 * The stored rows a hop from held rows reaches among the held rows' values: each field it binds among its value's, the
 * value's reads of the held rows read again in the array (write/probe.ts amongHeld). Its bindings, which imply it, stand
 * beside it.
 */
export const heldAmong = (
	w: WriteContext,
	supply: NameSupply,
	held: Reach["held"],
	hop: Hop
): NonEmptyReadonlyArray<Expr> => {
	/** `value` read of a held row given under `h`. */
	const readAt = (value: Expr, h: string): Expr =>
		transformExpr(value, {
			...identityHooks,
			expr: (e) => (e.kind === "column" && e.table === held.alias ? { ...e, table: h } : e)
		})
	/** The stored field `field` of `relation` among the held rows' values of it. */
	const among = (relation: RelationInfo, field: LawField, value: Expr): Expr =>
		amongHeld(
			supply,
			storedAt(w, relation, hop.alias, field),
			held.cte,
			(h) => readAt(value, h),
			operatorSchemaOf(w.names, field.type)
		)
	return hop.kind === "group"
		? mapNonEmpty(hop.family.group, (g) => among(hop.family.member, g.member, hop.at(g)))
		: mapNonEmpty(accessFields(hop), (f) => among(hop.relation, f, hop.at(f)))
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
 * A keyset of stored rows of one relation at its primary key, each key with the tid of the row it was read from, in its
 * column `row`. Every CTE of a statement reads under the statement's one snapshot, so the tid is the version of the row
 * each read of the statement meets, and a write of the same statement meets the row at it: one heap fetch, by a TID
 * scan, never a read of an index over the key, which PostgreSQL may take for a shallower index that binds only a prefix
 * of the key and then filter the rest of the key over every row of that prefix. A tid never leaves its statement: none
 * is stored, returned or handed to another statement, as deploy/diff/backfill.ts's rowColumn argues for the backfill.
 */
export interface RowKeyset extends Keyset {
	readonly access: { readonly kind: "key"; readonly relation: RelationInfo }
	readonly row: string
}

/** A key arm whose last hop reads the stored row its key is read from: `row`, that row's tid. */
export interface RowArm extends KeyArm {
	readonly row: Expr
}

/** The tid of the stored row under alias `alias`, PostgreSQL's system column. */
export const rowOf = (alias: string): Expr => col(alias, "ctid")

/** The union of `arms`, each projecting `targetsOf` it: SELECT DISTINCT for one arm, UNION for more. */
const unionOf = <A extends KeyArm>(
	w: WriteContext,
	supply: NameSupply,
	arms: NonEmptyReadonlyArray<A>,
	targetsOf: (arm: A) => NonEmptyReadonlyArray<Expr>
): Select => {
	const [first, second, ...rest] = arms
	const armCore = (arm: A) =>
		core(
			targetsOf(arm).map((e) => target(e)),
			[reachFrom(w, supply, arm)],
			arm.where
		)
	return select(
		second === undefined
			? distinctCore(
					mapNonEmpty(targetsOf(first), (e) => target(e)),
					[reachFrom(w, supply, first)],
					first.where
				)
			: setOperation("UNION", [armCore(first), armCore(second), ...rest.map(armCore)])
	)
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
	ctes.push({
		...cte(
			name,
			namedBody(
				unionOf(w, supply, arms, (arm) => arm.key),
				[...columns]
			)
		),
		materialized
	})
	return { name, access, columns }
}

/**
 * The row keyset of `arms`, stored rows of `relation` at its primary key, each key with its row's tid (`RowKeyset`), its
 * CTE pushed onto `ctes` as `materialized` says: SELECT DISTINCT for one arm, UNION for more.
 */
export const rowKeysetOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	relation: RelationInfo,
	arms: NonEmptyReadonlyArray<RowArm>,
	materialized: Cte["materialized"]
): RowKeyset => {
	const access = { kind: "key", relation } as const
	const name = supply.relation(internal("keyset"))
	const columns = mapNonEmpty(accessFields(access), () => supply.column(internal("keyset key")))
	const row = supply.column(internal("keyset row"))
	ctes.push({
		...cte(
			name,
			namedBody(
				unionOf(w, supply, arms, (arm) => appendNonEmpty(arm.key, arm.row)),
				[...columns, row]
			)
		),
		materialized
	})
	return { name, access, columns, row }
}

/** The columns a row keyset relates to others by: its key, then its row's tid. */
const rowColumns = (keyset: RowKeyset): NonEmptyReadonlyArray<string> =>
	appendNonEmpty(keyset.columns, keyset.row)

/**
 * The rows of a GROUP BY over keysets at one access path, each key once with the keysets that hold it: `SELECT <key>,
 * <aggregates> FROM (SELECT <key>, 0 FROM <keyset 0> UNION ALL SELECT <key>, 1 FROM <keyset 1> ...) AS u(<key>, tag)
 * GROUP BY <key> [HAVING <having>]`, `holds(i)` the aggregate `bool_or(tag = i)`, whether keyset `i` holds the key.
 * PostgreSQL holds no statistics of a CTE and estimates a join of two at a row each, which it may run as a nested loop
 * pairing every row of one with every row of the other; a GROUP BY reads each row once, by one sort or hash, whatever
 * it estimates. `columnsOf` gives the columns each keyset is grouped by, its key, or its key and its row's tid for row
 * keysets, one tid to a key in the statement's one snapshot.
 */
const tagged = <K extends Keyset>(
	supply: NameSupply,
	keysets: NonEmptyReadonlyArray<K>,
	columnsOf: (keyset: K) => NonEmptyReadonlyArray<string>,
	project: (
		holds: (i: number) => Expr,
		key: NonEmptyReadonlyArray<Expr>
	) => {
		readonly targets: ReadonlyArray<Target>
		readonly having: Expr | undefined
	}
): Select => {
	const [first] = keysets
	const u = supply.relation(internal("tagged keys"))
	const key = mapNonEmpty(columnsOf(first), () => supply.column(internal("tagged key")))
	const tag = supply.column(internal("tag"))
	const arm = (keyset: K, i: number) => {
		const k = supply.relation(internal("tagged keyset"))
		return core(
			[...columnsOf(keyset).map((c) => target(col(k, c))), target(lit.int(i, types.integer))],
			[cteRefAs(keyset.name, k)],
			undefined
		)
	}
	const keyExprs = mapNonEmpty(key, (c) => col(u, c))
	const holds = (i: number): Expr => call("bool_or", [eq(col(u, tag), lit.int(i, types.integer))])
	const chosen = project(holds, keyExprs)
	return select({
		...provedCore(
			"grouped",
			chosen.targets,
			[
				derived(
					namedQuery(operandSelect(operandUnionAll(mapNonEmpty(keysets, arm))), [...key, tag]),
					u,
					false
				)
			],
			undefined
		),
		groupBy: [...keyExprs],
		having: chosen.having
	})
}

/** The keysets `all` and `none` of a keyset relation, in the order `tagged` tags them, with the HAVING that keeps a key
 * every keyset of `all` holds and no keyset of `none` holds. */
const allAndNone = <K extends Keyset>(sets: {
	readonly all: NonEmptyReadonlyArray<K>
	readonly none: ReadonlyArray<K>
}): {
	readonly keysets: NonEmptyReadonlyArray<K>
	readonly having: (holds: (i: number) => Expr) => Expr
} => ({
	keysets: extendNonEmpty(sets.all, sets.none),
	having: (holds) =>
		and([
			...mapNonEmpty(sets.all, (_, i) => holds(i)),
			...sets.none.map((_, j) => not(holds(sets.all.length + j)))
		])
})

/**
 * The keyset of the keys at one access path that every keyset of `all` holds and no keyset of `none` holds, by one
 * GROUP BY over them (`tagged`), its CTE pushed onto `ctes` as `materialized` says; `all`'s one keyset itself where
 * there is nothing to judge.
 */
export const keysetWhere = (
	supply: NameSupply,
	ctes: Array<Cte>,
	sets: { readonly all: NonEmptyReadonlyArray<Keyset>; readonly none: ReadonlyArray<Keyset> },
	materialized: Cte["materialized"]
): Keyset => {
	const [first, ...more] = sets.all
	if (!isNonEmpty(more) && !isNonEmpty(sets.none)) {
		return first
	}
	const name = supply.relation(internal("keyset"))
	const columns = mapNonEmpty(first.columns, () => supply.column(internal("keyset key")))
	const { keysets, having } = allAndNone(sets)
	ctes.push({
		...cte(
			name,
			namedBody(
				tagged(
					supply,
					keysets,
					(k) => k.columns,
					(holds, key) => ({ targets: key.map((e) => target(e)), having: having(holds) })
				),
				[...columns]
			)
		),
		materialized
	})
	return { name, access: first.access, columns }
}

/**
 * The row keyset of the stored rows that every row keyset of `all` holds and no row keyset of `none` holds, each with its
 * row's tid, by one GROUP BY over their keys and tids (`tagged`), its CTE pushed onto `ctes` as `materialized` says;
 * `all`'s one row keyset itself where there is nothing to judge.
 */
export const rowsWhere = (
	supply: NameSupply,
	ctes: Array<Cte>,
	sets: { readonly all: NonEmptyReadonlyArray<RowKeyset>; readonly none: ReadonlyArray<RowKeyset> },
	materialized: Cte["materialized"]
): RowKeyset => {
	const [first, ...more] = sets.all
	if (!isNonEmpty(more) && !isNonEmpty(sets.none)) {
		return first
	}
	const name = supply.relation(internal("keyset"))
	const columns = mapNonEmpty(first.columns, () => supply.column(internal("keyset key")))
	const row = supply.column(internal("keyset row"))
	const { keysets, having } = allAndNone(sets)
	ctes.push({
		...cte(
			name,
			namedBody(
				tagged(supply, keysets, rowColumns, (holds, key) => ({
					targets: key.map((e) => target(e)),
					having: having(holds)
				})),
				[...columns, row]
			)
		),
		materialized
	})
	return { name, access: first.access, columns, row }
}

/** A row keyset whose every row carries whether another row keyset holds it, in its column `flag`. */
export interface Flagged extends RowKeyset {
	readonly flag: string
}

/**
 * Each row of `of` with whether `holds`, a row keyset of some of its rows, holds it, by one GROUP BY over the two at
 * their keys and tids (`tagged`), its CTE pushed onto `ctes`, materialized: each row keeps its tid, so a read of the
 * row it flags fetches it there (`flaggedRowsAt`), never at its key.
 */
export const flaggedRows = (
	supply: NameSupply,
	ctes: Array<Cte>,
	of: RowKeyset,
	holds: RowKeyset
): Flagged => {
	const name = supply.relation(internal("flagged rows"))
	const columns = mapNonEmpty(of.columns, () => supply.column(internal("flagged key")))
	const row = supply.column(internal("flagged row"))
	const flag = supply.column(internal("flag"))
	ctes.push({
		...cte(
			name,
			namedBody(
				tagged(supply, [of, holds], rowColumns, (held, key) => ({
					targets: [...key.map((e) => target(e)), target(held(1))],
					having: undefined
				})),
				[...columns, row, flag]
			)
		),
		materialized: "MATERIALIZED"
	})
	return { name, access: of.access, columns, row, flag }
}

/**
 * The rows of a flagged row keyset, read as `f`, with the stored row each was read from, under `s`, at its tid: `<flagged>
 * AS f JOIN <relation> AS s ON s.ctid = f.row AND s.ctid = ANY (ARRAY(SELECT DISTINCT row FROM <flagged>))`, a TID scan
 * of one heap fetch a row whatever PostgreSQL estimates the flagged rows at (`RowKeyset`), never a read through an index
 * over the key, which it may take for a shallower one that binds only a prefix of it and filter the rest over every row
 * of that prefix.
 */
export const flaggedRowsAt = (
	w: WriteContext,
	supply: NameSupply,
	flagged: Flagged,
	f: string,
	s: string
): FromItem => ({
	kind: "joins",
	first: cteRefAs(flagged.name, f),
	steps: [
		{
			kind: "on",
			source: tableAs(w, flagged.access.relation.name, s),
			on: and([rowAt(f, flagged, s), rowsAmong(supply, flagged, s)])
		}
	]
})

/**
 * The column of a keyset holding the field named as `field` is, by name: a family's group names its owner's key fields
 * as its own law fields, which need not be the very handles the owner relation's are.
 */
export const keysetColumn = (keyset: Keyset, field: LawField): string =>
	defined(
		keyset.columns[accessFields(keyset.access).findIndex((f) => f.name === field.name)],
		`the keyset column of ${keyset.access.relation.name}.${field.name}`
	)

/** Whether a keyset's rows hold `field`: a field its access binds, whose value each row holds in its column (keysetColumn). */
export const keysetHolds = (keyset: Keyset, field: LawField): boolean =>
	accessFields(keyset.access).some((f) => f.name === field.name)

/** The hop from a keyset's row at alias `k` to the stored rows at its keys, under alias `s`. */
export const atKeyset = (k: string, keyset: Keyset, s: string): Hop => ({
	...keyset.access,
	alias: s,
	at: (f: LawField) => col(k, keysetColumn(keyset, f))
})

/** Whether the stored row at alias `s` is at the key of the keyset's row at alias `k`, at every field it binds. */
export const keyedAt = (w: WriteContext, k: string, keyset: Keyset, s: string): Expr =>
	and(bindings(w, atKeyset(k, keyset, s)))

/**
 * The stored rows at alias `s` among the keyset's keys: each field the keyset's access binds `= ANY (ARRAY(SELECT
 * DISTINCT ...))` of the keyset's values of it, one condition its index serves, the array read once, however many rows
 * PostgreSQL estimates the keyset at (write/probe.ts keyedAmong). Stated beside `keyedAt`, whose equalities it implies.
 */
export const keysetAmong = (
	w: WriteContext,
	supply: NameSupply,
	keyset: Keyset,
	s: string
): NonEmptyReadonlyArray<Expr> => {
	const k = supply.relation(internal("keyset row"))
	return heldAmong(w, supply, { cte: keyset.name, alias: k }, atKeyset(k, keyset, s))
}

/** Whether the stored row at alias `s` is the row of the row keyset's row at alias `k`: the one at its tid. */
export const rowAt = (k: string, keyset: RowKeyset, s: string): Expr =>
	eq(rowOf(s), col(k, keyset.row))

/**
 * The stored rows at alias `s` among the rows of the row keyset: `ctid = ANY (ARRAY(SELECT DISTINCT row FROM keyset))`,
 * which PostgreSQL reads by a TID scan of the array (write/probe.ts amongHeld).
 */
export const rowsAmong = (supply: NameSupply, keyset: RowKeyset, s: string): Expr =>
	amongHeld(supply, rowOf(s), keyset.name, (h) => col(h, keyset.row), undefined)

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
	return reachFrom(w, supply, {
		held: { cte: keyset.name, alias: k },
		hops: [atKeyset(k, keyset, s)]
	})
}

/** The fields an access path binds as the stored row at alias `s` holds them: a primary key, or a tree's root. */
export const storedKey = (
	w: WriteContext,
	access: Access,
	s: string
): NonEmptyReadonlyArray<Expr> =>
	mapNonEmpty(accessFields(access), (f) => storedAt(w, access.relation, s, f))
