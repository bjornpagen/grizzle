/**
 * A family's members drawn in SQL, in slot order, inside the statement that writes them: the values the host once drew
 * from a read of the stored group, computed by PostgreSQL from the group as the statement finds it.
 *
 * A scan walks each group of one family from its first drawn slot to its last, one member per step of a recursive CTE,
 * the step reading the member before it, as the family's laws chain them:
 *
 *   WITH RECURSIVE "r9"("c1", ..., "c20") AS (
 *     SELECT <a group's first drawn member, at slot 0, from the family's base>
 *       FROM "r3" AS "r10" JOIN "r5" AS "r11" ON <its owner> WHERE <its slot is 0, its group's first>
 *     UNION ALL
 *     SELECT <a group's first drawn member past slot 0, from its seed, the member stored before it>
 *       FROM "r3" AS "r12" JOIN "r5" AS "r13" ON <its owner> JOIN "r4" AS "r14" ON <its seed>
 *       WHERE <its slot is its group's first>
 *     UNION ALL
 *     SELECT <the next member, from the one before it>
 *       FROM "r9" AS "r15" JOIN "r3" AS "r16" ON <same group, the next slot> JOIN "r5" AS "r17" ON <its owner>
 *   )
 *
 * Each drawn column is its fill rule (ir/fill.ts), the one the nested walk fills by: an index its slot, a copy of the
 * count the group's count, an owner copy the owner's column, a predecessor copy the member before it's column (the
 * family's base at slot 0), and a fold plane's after `combine(befores, x)` where the fold's selection holds and its
 * before elsewhere, combined as the fold's CHECK proves it. A generated field a rule reads is its generation over the
 * row, as PostgreSQL stores it. So every lawful schema is drawn: the step is the law itself, whatever the monoid, the
 * copies' chains or the generated fields between them, which no window aggregate could follow.
 *
 * Every drawn column is cast to its type's base, so PostgreSQL's recursive type agreement never rests on an operator's
 * result type, and no domain's CHECK runs before the write that stores the value, which judges it there.
 */
import { defect, defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { Family, FamilyFold } from "#compiler/ir/family.ts"
import type { FillColumn } from "#compiler/ir/fill.ts"
import type { LawRelation, NativeColumn } from "#compiler/ir/law.ts"
import { columnReads } from "#compiler/laws/model/uniques.ts"
import type { ColumnMap, Env } from "#compiler/lower/conservative/context.ts"
import { lowerExpr, lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import type { Cte, Expr, FromItem, Target, TypeRef } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	cast,
	col,
	cteRefAs,
	eq,
	gt,
	join,
	lit,
	provedCore,
	select,
	targetAs,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import { type ColumnKey, columnKey, fieldKey } from "#compiler/write/family/fold.ts"
import type { WriteContext } from "#compiler/write/insert/statement.ts"

/** A CTE's rows by the native columns they hold, each under a column name of the CTE. */
export interface Shaped {
	readonly name: string
	readonly columns: ReadonlyMap<ColumnKey, string>
}

/** A CTE of rows of a family's groups: each row's group key columns, in the family's group order, beside its columns. */
export interface PerGroup extends Shaped {
	readonly group: NonEmptyReadonlyArray<string>
}

/**
 * The members a scan walks, one row per member at its final slot: its group's key, its slot, its group's first drawn
 * slot and count, every column of the member the family's rules read, and every column of its owner its owner copies
 * read (`owner`), as the members copy them.
 */
export interface ScanRows extends PerGroup {
	readonly slot: string
	readonly first: string
	readonly count: string
	readonly owner: ReadonlyMap<ColumnKey, string>
}

/** A scan's own rows: the members it walked, each with the columns it carries and the ones it drew, by key. */
export interface Scanned extends PerGroup {
	readonly slot: string
	readonly first: string
	readonly count: string
}

/** What a scan draws: a family's member columns, each with its rule, in the order the family fills them. */
export interface ScanSpec {
	readonly family: Family
	readonly member: LawRelation
	readonly drawn: ReadonlyArray<FillColumn>
	readonly rows: ScanRows
	/** Each group's member before its first drawn slot, for every group drawn from past slot 0. */
	readonly seed: PerGroup
}

/** A scan: its recursive CTE, and the CTE's rows as the scan shapes them, every column it carries or draws by key. */
export interface Scan {
	readonly cte: Cte
	readonly rows: Scanned
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** A row a rule reads columns of, by key: the member's own, the member before it, or its owner. */
export type Read = (key: ColumnKey) => Expr | undefined

/** A column's value at an alias, by its name in its CTE's shape. */
export const readAt =
	(alias: string, shape: Shaped): Read =>
	(key) => {
		const column = shape.columns.get(key)
		return column === undefined ? undefined : col(alias, column)
	}

/** Whether two rows' group key columns name one group, column by column. */
const sameGroup = (
	a: string,
	aGroup: NonEmptyReadonlyArray<string>,
	b: string,
	bGroup: NonEmptyReadonlyArray<string>
): Expr =>
	and(
		mapNonEmpty(aGroup, (column, i) =>
			eq(col(a, column), col(b, defined(bGroup[i], "a group key column of each side")))
		)
	)

/**
 * One fold plane's after from the befores and the step value, at the plane's base type `to`, as the fold's CHECK
 * proves it (laws/model/plan.ts #combine): count adds one, sum adds in exact arithmetic and casts back, max takes the
 * greater, or and twos unite and intersect the sets' bits, concat appends the text.
 */
const combine = (
	fold: FamilyFold,
	plane: 0 | 1,
	befores: ReadonlyArray<Expr>,
	x: Expr | undefined,
	to: TypeRef
): Expr => {
	const before = defined(befores[plane], `the before of plane ${plane}`)
	const step = (): Expr => defined(x, `the step value of a ${fold.monoid} fold`)
	switch (fold.monoid) {
		case "count":
			return binary("+", before, lit.int(1, to))
		case "sum":
			return cast(binary("+", cast(before, types.numeric), cast(step(), types.numeric)), to)
		case "max":
			return { kind: "greatest", args: [before, step()] }
		case "or":
			return binary("|", before, step())
		case "twos":
			return plane === 0
				? binary("|", before, step())
				: binary("|", before, binary("&", defined(befores[0], "the ones plane's before"), step()))
		case "concat":
			return binary("||", before, step())
	}
}

/** A row expression's value over a row's columns, each field it reads by `value` at its key. */
const generation = (w: WriteContext, expr: ScalarExpr, value: (key: ColumnKey) => Expr): Expr => {
	const env = new Map<Parameters<Env["get"]>[0], ColumnMap>()
	for (const read of columnReads(expr)) {
		const columns = new Map(env.get(read.node) ?? [])
		columns.set(read.name, value(fieldKey(read.name)))
		env.set(read.node, columns)
	}
	return lowerExpr(w.cx, expr, env)
}

/** A fold's selection over the member's row, its conjuncts ANDed, none where it steps over every member. */
const selection = (
	w: WriteContext,
	fold: FamilyFold,
	value: (key: ColumnKey) => Expr
): Expr | undefined => {
	const [first, ...rest] = fold.where.map((c) => generation(w, c, value))
	return first === undefined ? undefined : and([first, ...rest])
}

/**
 * A row's value at each column (`value`), as a write reads it: its own column where it holds one, else a generated
 * field's generation over its other columns. A column the row neither holds nor generates is a defect: a caller's rows
 * hold every column a rule or a generation reads.
 */
const ownValue =
	(relation: LawRelation, own: Read, w: WriteContext) =>
	(key: ColumnKey): Expr => {
		const value = (k: ColumnKey): Expr => {
			const held = own(k)
			if (held !== undefined) {
				return held
			}
			const field = relation.fields.find((f) => fieldKey(f.name) === k)
			if (field?.writing.kind === "generated") {
				return generation(w, field.writing.expr, value)
			}
			throw defect(`the column ${k} of ${relation.name}, which a write reads`)
		}
		return value(key)
	}

/**
 * The value of each column of a scanned member, `spec.drawn`'s rules in fill order over `row`, the member's own columns,
 * its `slot` and its group's `count`, `prev`, the member before it ("base" at slot 0), and `owner`: each column a rule
 * draws, else the member's own (`ownValue`).
 */
const memberValues = (
	w: WriteContext,
	spec: ScanSpec,
	row: Read,
	slot: Expr,
	count: Expr,
	prev: Read | "base",
	owner: Read
): ((key: ColumnKey) => Expr) => {
	const drawn = new Map<ColumnKey, Expr>()
	const own = ownValue(spec.member, row, w)
	const value = (key: ColumnKey): Expr => drawn.get(key) ?? own(key)
	const read = (side: Read, column: NativeColumn, what: string): Expr =>
		defined(side(columnKey(column)), `the ${what} column ${columnKey(column)} a rule reads`)
	for (const c of spec.drawn) {
		const rule = c.rule
		const to = w.cx.baseTypeRef(c.type)
		const draw = (e: Expr): void => {
			drawn.set(columnKey(c.column), cast(e, to))
		}
		switch (rule.kind) {
			case "index":
				draw(slot)
				break
			case "copy":
				draw(count)
				break
			case "ownerCopy":
				draw(read(owner, rule.to, "owner's"))
				break
			case "predecessor":
				draw(
					prev === "base"
						? lowerLiteral(w.names, rule.base, c.type)
						: read(prev, rule.to, "previous member's")
				)
				break
			case "after": {
				const befores = rule.befores.map((b) => value(columnKey(b)))
				const x = rule.x === undefined ? undefined : value(columnKey(rule.x))
				const plane = rule.plane
				const stepped = combine(rule.fold, plane, befores, x, to)
				const selected = selection(w, rule.fold, value)
				draw(
					selected === undefined
						? stepped
						: {
								kind: "case",
								operand: undefined,
								whens: [{ when: selected, result: stepped }],
								else: defined(befores[plane], `the before of plane ${plane}`)
							}
				)
				break
			}
			case "given":
			case "owner":
			case "self":
			case "own":
			case "count":
			case "start":
			case "end":
			case "parentStart":
			case "last":
			case "generated":
				throw defect(
					`a ${rule.kind} rule among the columns a scan of ${spec.family.id.owner}.${spec.family.id.count} draws`
				)
		}
	}
	return value
}

/**
 * The scan of `spec` (see the header): a recursive CTE of every row `spec.rows` holds, each with the columns it carries
 * and the family's columns its rules draw, by key. The rows a previous member's rule reads are the scan's own, so the
 * scan carries every column of `spec.rows`.
 */
export const scanOf = (w: WriteContext, supply: NameSupply, spec: ScanSpec): Scan => {
	const name = supply.relation(internal("family scan"))
	const rows = spec.rows
	const drawnKeys = new Set(spec.drawn.map((c) => columnKey(c.column)))
	const carried = [...rows.columns].filter(([key]) => !drawnKeys.has(key))
	const group = mapNonEmpty(spec.family.group, () => supply.column(internal("scan group")))
	const slot = supply.column(internal("scan slot"))
	const first = supply.column(internal("scan first slot"))
	const count = supply.column(internal("scan count"))
	const columns = new Map<ColumnKey, string>([
		...carried.map(([key]) => [key, supply.column(internal("scan carried"))] as const),
		...spec.drawn.map((c) => [columnKey(c.column), supply.column(internal("scan drawn"))] as const)
	])
	const out: Scanned = { name, group, slot, first, count, columns }
	const term = (r: string, prev: Read | "base"): ReadonlyArray<Target> => {
		const value = memberValues(
			w,
			spec,
			readAt(r, rows),
			col(r, rows.slot),
			col(r, rows.count),
			prev,
			readAt(r, { name: rows.name, columns: rows.owner })
		)
		return [
			...mapNonEmpty(rows.group, (c, i) =>
				targetAs(col(r, c), defined(group[i], "a scan group column"))
			),
			targetAs(col(r, rows.slot), slot),
			targetAs(col(r, rows.first), first),
			targetAs(col(r, rows.count), count),
			...carried.map(([key, column]) =>
				targetAs(col(r, column), defined(columns.get(key), "a carried column"))
			),
			...spec.drawn.map((c) => {
				const key = columnKey(c.column)
				return targetAs(value(key), defined(columns.get(key), "a drawn column"))
			})
		]
	}
	const zero = lit.int(0, types.bigint)
	const r0 = supply.relation(internal("scan base row"))
	const r1 = supply.relation(internal("scan seeded row"))
	const d1 = supply.relation(internal("scan seed"))
	const seeded: FromItem = join(
		cteRefAs(rows.name, r1),
		cteRefAs(spec.seed.name, d1),
		sameGroup(r1, rows.group, d1, spec.seed.group)
	)
	const p2 = supply.relation(internal("scan previous row"))
	const r2 = supply.relation(internal("scan next row"))
	const next: FromItem = join(
		cteRefAs(name, p2),
		cteRefAs(rows.name, r2),
		and([
			sameGroup(r2, rows.group, p2, group),
			eq(col(r2, rows.slot), binary("+", col(p2, slot), lit.int(1, types.bigint)))
		])
	)
	const body = select(
		unionAll("disjoint", [
			provedCore(
				"keyed",
				term(r0, "base"),
				[cteRefAs(rows.name, r0)],
				and([eq(col(r0, rows.slot), col(r0, rows.first)), eq(col(r0, rows.first), zero)])
			),
			provedCore(
				"keyed",
				term(r1, readAt(d1, spec.seed)),
				[seeded],
				and([eq(col(r1, rows.slot), col(r1, rows.first)), gt(col(r1, rows.first), zero)])
			),
			provedCore("keyed", term(r2, readAt(p2, out)), [next], undefined)
		])
	)
	return {
		cte: {
			name,
			columns: [...group, slot, first, count, ...columns.values()],
			materialized: undefined,
			query: body
		},
		rows: out
	}
}
