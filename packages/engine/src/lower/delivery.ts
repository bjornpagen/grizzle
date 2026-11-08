/**
 * The one SQL form of a statement's delivered rows (codec/delivery.ts): every outermost select grizzle sends whose rows
 * the host reads, a query's, an attachment's, a write's RETURNING, a family's read, is built here from its columns'
 * delivery, so a bytes column is never cast to a text, and the host's reader reads exactly the form sent.
 */
import { type CellKind, type Delivery, deliveryOf, resultWidth } from "#compiler/codec/delivery.ts"
import { resultTextCasts } from "#compiler/codec/scalar.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { Expr, FromItem, FromSource, Select, SetCore, Target } from "#compiler/sql/ast.ts"
import {
	binary,
	call,
	cast,
	col,
	derived,
	eq,
	lit,
	provedCore,
	target,
	targetAs,
	types,
	windowOf
} from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"

/** A text column: the casts that make its result text. */
interface TextDelivered {
	readonly kind: "text"
	readonly casts: ReadonlyArray<"numeric" | "text">
}

/** One delivered column: a text column with the casts that make its result text, or a bytes column. */
export type DeliveredColumn = TextDelivered | { readonly kind: "bytes" }

/** Whether a column is a text column. */
const isText = (column: DeliveredColumn): column is TextDelivered => column.kind === "text"

/** The delivered column of a value of type `type`: bytes in chunks, every other type as its result text. */
export const deliveredColumn = (type: ScalarType): DeliveredColumn =>
	type.carrier === "bytes" ? { kind: "bytes" } : { kind: "text", casts: resultTextCasts(type) }

/** A column whose value is a text already, a fused attachment's array: its result text is itself cast to text. */
export const textColumn: DeliveredColumn = Object.freeze({ kind: "text", casts: ["text"] as const })

/** A column whose value is its own result text, a MERGE's merge_action(): no cast. */
export const textItself: DeliveredColumn = Object.freeze({ kind: "text", casts: [] as const })

/** The cell kind a delivered column's cell travels as. */
const kindOf = (column: DeliveredColumn): CellKind => column.kind

/** The delivery the host reads rows of `columns` by (codec/delivery.ts deliveryOf). */
export const deliveryOfColumns = (columns: ReadonlyArray<DeliveredColumn>): Delivery =>
	deliveryOf(columns.map(kindOf))

/** `e` cast to its result text by `casts`, in order. */
const resultCast = (e: Expr, casts: ReadonlyArray<"numeric" | "text">): Expr =>
	casts.reduce<Expr>((acc, t) => cast(acc, t === "numeric" ? types.numeric : types.text), e)

/** A plain set core: no DISTINCT, so a target joins it in place. */
export type PlainCore = Extract<SetCore, { readonly distinct: false }>

/** A query of a plain core: the rows a statement delivers, each target a column's value, in its columns' order. */
export type PlainQuery = Omit<Select, "body"> & { readonly body: PlainCore }

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/**
 * Each target of `core` with its delivered column. The one site of the fact that a delivered query's targets are its
 * columns, position by position: every caller builds both from one heading, and the AST's target list carries no
 * count, so a miss is a defect.
 */
const targetsWith = <C extends DeliveredColumn>(
	core: PlainCore,
	columns: ReadonlyArray<C>
): ReadonlyArray<{ readonly target: Target; readonly column: C }> => {
	if (core.targets.length !== columns.length) {
		throw defect("a delivered query's targets are its columns")
	}
	return columns.map((column, at) => ({
		target: defined(core.targets[at], "a delivered query's target of each of its columns"),
		column
	}))
}

/**
 * The rows of `rows`, whose targets are the values of `columns` in order, as their delivery sends them
 * (codec/delivery.ts), each result row led by the constant targets `leading`, a union arm's tag:
 *
 * - whole, no column bytes: `rows` with each target cast to its result text in place (`resultCast`);
 * - chunked: every chunk of every row, from `rows` numbered in its own order:
 *
 *       WITH <rows' WITH>
 *       SELECT <leading>, d.ord::text, g.i::text,
 *              CASE WHEN g.i = 0 THEN <d.c result text> ELSE '' END,                    -- each text column
 *              encode(substring(d.b, g.i * C + 1, C), 'base64url'),                    -- each bytes column
 *              CASE WHEN g.i = 0 THEN octet_length(d.b)::text ELSE '' END              -- each bytes column
 *       FROM (SELECT <rows' targets>, row_number() OVER (ORDER BY <rows' order>) ... <rows' ORDER BY, LIMIT>)
 *              AS d(c1, …, cn, ord)
 *       CROSS JOIN LATERAL generate_series(0, greatest(1, (octet_length(d.b) + C - 1) / C, …) - 1) AS g(i)
 *
 *   with C `chunkLength`. A row's number is its place in `rows`' order, any place where it has none, so the host,
 *   which reads the chunks in whatever order they arrive, puts the rows back in it. Its WITH moves out to the
 *   statement, where a data-modifying CTE must stand, and the derived table reads it from there.
 */
export const deliveredRows = (
	rows: PlainQuery,
	columns: ReadonlyArray<DeliveredColumn>,
	leading: ReadonlyArray<Target>,
	supply: NameSupply,
	chunkLength: number
): PlainQuery => {
	if (columns.every(isText)) {
		return {
			...rows,
			body: {
				...rows.body,
				targets: [
					...leading,
					...targetsWith(rows.body, columns).map(({ target: t, column }) => ({
						...t,
						expr: resultCast(t.expr, column.casts)
					}))
				]
			}
		}
	}
	const paired = targetsWith(rows.body, columns)
	const bytes = paired.flatMap(({ column }, at) => (column.kind === "bytes" ? [at] : []))
	const d = supply.relation(internal("delivered rows"))
	const values = paired.map(() => supply.column(internal("delivered value")))
	const ord = supply.column(internal("delivered row number"))
	const g = supply.relation(internal("delivered chunks"))
	const i = supply.column(internal("delivered chunk number"))
	const numbered: PlainQuery = {
		...rows,
		with: undefined,
		body: {
			...rows.body,
			targets: [
				...rows.body.targets,
				target({ ...call("row_number", []), over: windowOf([], rows.orderBy) })
			]
		}
	}
	const valueAt = (at: number): Expr =>
		col(d, defined(values[at], "a derived column of each delivered value"))
	const chunk = col(g, i)
	const first = eq(chunk, lit.int(0, types.integer))
	const onFirst = (e: Expr): Expr => ({
		kind: "case",
		operand: undefined,
		whens: [{ when: first, result: e }],
		else: lit.text("", types.text)
	})
	const length = (at: number): Expr => call("octet_length", [valueAt(at)])
	const size = lit.int(chunkLength, types.integer)
	const cells = paired.map(({ target: t, column }, at): Target => ({
		...t,
		expr:
			column.kind === "text"
				? onFirst(resultCast(valueAt(at), column.casts))
				: call("encode", [
						call("substring", [
							valueAt(at),
							binary("+", binary("*", chunk, size), lit.int(1, types.integer)),
							size
						]),
						lit.text("base64url", types.text)
					])
	}))
	const lengths = bytes.map((at) =>
		targetAs(onFirst(cast(length(at), types.text)), supply.column(internal("delivered length")))
	)
	const chunksOf = (at: number): Expr =>
		binary("/", binary("+", length(at), lit.int(chunkLength - 1, types.integer)), size)
	const last = binary(
		"-",
		{
			kind: "greatest",
			args: [lit.int(1, types.integer), ...bytes.map(chunksOf)]
		},
		lit.int(1, types.integer)
	)
	const series: FromSource = {
		kind: "function",
		call: call("generate_series", [lit.int(0, types.integer), last]),
		alias: g,
		columns: [i],
		lateral: true
	}
	return {
		kind: "select",
		with: rows.with,
		body: provedCore(
			"keyed",
			[
				...leading,
				targetAs(cast(col(d, ord), types.text), supply.column(internal("delivered row"))),
				targetAs(cast(chunk, types.text), supply.column(internal("delivered chunk"))),
				...cells,
				...lengths
			],
			[
				{
					kind: "joins",
					first: derived(numbered, d, [...values, ord], false),
					steps: [{ kind: "cross", source: series }]
				}
			],
			undefined
		),
		orderBy: [],
		limit: undefined,
		offset: undefined
	}
}

/** One arm of a UNION ALL of tagged deliveries: its tag, its columns' values with their deliveries, and its rows. */
export interface TaggedArm {
	readonly tag: string
	readonly columns: ReadonlyArray<{ readonly expr: Expr; readonly delivered: DeliveredColumn }>
	readonly from: ReadonlyArray<FromItem>
	readonly where: Expr | undefined
}

/** The cells of the result rows of columns `columns`, an arm's after its tag (codec/delivery.ts resultWidth). */
export const deliveredWidth = (columns: ReadonlyArray<DeliveredColumn>): number =>
	resultWidth(deliveryOfColumns(columns))

/**
 * One arm of a UNION ALL of tagged deliveries, disjoint by its tag, a text under `tagColumn`: its rows delivered after
 * the tag (deliveredRows), its i-th cell named `column(i)`, padded with empty texts to `width` cells, the widest arm's
 * (deliveredWidth). The host splits the rows by tag and reads each arm's by its own delivery.
 */
export const taggedArm = (
	arm: TaggedArm,
	tagColumn: string,
	column: (at: number) => string,
	width: number,
	supply: NameSupply,
	chunkLength: number
): PlainCore => {
	const delivered = deliveredRows(
		{
			kind: "select",
			with: undefined,
			body: provedCore(
				"keyed",
				arm.columns.map((c, at) => targetAs(c.expr, column(at))),
				arm.from,
				arm.where
			),
			orderBy: [],
			limit: undefined,
			offset: undefined
		},
		arm.columns.map((c) => c.delivered),
		[targetAs(lit.text(arm.tag, types.text), tagColumn)],
		supply,
		chunkLength
	).body
	const own = deliveredWidth(arm.columns.map((c) => c.delivered))
	return {
		...delivered,
		targets: [
			...delivered.targets,
			...Array.from({ length: width - own }, (_, j) =>
				targetAs(lit.text("", types.text), column(own + j))
			)
		]
	}
}
