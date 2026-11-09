import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import type { Source } from "@grizzle/testing/source"
import { type Swarm, swarm, weightOf } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Order } from "effect"
import { maxOf } from "#compiler/core/array.ts"
import type {
	Expr,
	FrameBound,
	FunctionCall,
	OperandBody,
	OperandSelect,
	OrderItem,
	Select,
	SetOperand,
	WindowSpec
} from "#compiler/sql/ast.ts"
import type { SetOperator } from "#test/support/kernel/shape.ts"

import {
	asc,
	asOperand,
	binary,
	call,
	cast,
	col,
	continued,
	core,
	countStar,
	cUtf8Collation,
	derived,
	desc,
	distinctCore,
	lit,
	operandSelect,
	provedCore,
	select,
	tableCol,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"

import { whereIndex } from "#test/support/oracle/pick.ts"

/** The decisions a generator takes from its source, in order: one of some options, the first the simplest, or a count. */
class Draws {
	readonly #source: Source
	constructor(source: Source) {
		this.#source = source
	}
	from<A>(options: Arr.NonEmptyReadonlyArray<A>): A {
		return this.#source.draw(element(options))
	}
	count(min: number, max: number): number {
		return this.#source.draw(int(min, max))
	}
}

/**
 * SQL ASTs with the value the host computes for them: what PostgreSQL must compute from their print.
 *
 * Each generator draws its decisions in order from its source, an expression's under a swarm (the kernel's form,
 * sqlgen.ts), so every part of a failing case shrinks at once and the shrunk case still means what it says. A
 * relational case is a sketch, its rows and its form as data, which a kept case states and `resolveRelational` turns
 * into the statement and the rows the host computes.
 *
 * - Expressions of three types: bigint (+, -, *, shifts, + and - spelled OPERATOR(pg_catalog.op), negation, CASE,
 *   GREATEST and LEAST, char_length), boolean (the six comparisons, AND and OR, NOT, IS TRUE, BETWEEN and NOT BETWEEN
 *   over bigints and over texts whose lower bound is collated, bare or under ||, IN and NOT IN over a list, a row IN a
 *   list of rows, equality of booleans), and text (||, a bigint cast to text, COLLATE). Every text comparison collates one side to pg_catalog.pg_c_utf8, so it orders by code point whatever the
 *   database's default, as the host does over ASCII. Leaves are small, so a product of sixteen of them stays inside
 *   bigint: the printer's parentheses decide the value, and nothing else can.
 * - Set-operation trees over small VALUES lists, nested on either side, an arm or a whole level parenthesized with its
 *   own ORDER BY and LIMIT, with the multiset SQL's set semantics give them.
 * - Grouped aggregates over (group, value) pairs: count, sum, min, max and array_agg, with DISTINCT and their own
 *   ORDER BY, and count(*) FILTER, each cast to text, with the text PostgreSQL gives each group.
 * - The relational forms of the catalog over two small VALUES relations: a CROSS JOIN, IN and NOT IN over a subquery
 *   that may be empty, and sum and count(*) over a window of drawn ROWS frame bounds (unbounded, an offset preceding or
 *   following, the current row; the running and remaining frames among them), partitioned or not, ordered either way,
 *   with the multiset and the per-row frames the host computes.
 */
const expressionFeatures = [
	"arithmetic",
	"shift",
	"qualified operator",
	"negate",
	"case",
	"greatest",
	"char_length",
	"comparison",
	"connectives",
	"not",
	"is true",
	"between",
	"in list",
	"row in",
	"boolean equality",
	"concat",
	"text cast",
	"collate"
] as const

type ExpressionFeature = (typeof expressionFeatures)[number]

export type Evaluated =
	| { readonly type: "int"; readonly expr: Expr; readonly value: bigint }
	| { readonly type: "bool"; readonly expr: Expr; readonly value: boolean }
	| { readonly type: "text"; readonly expr: Expr; readonly value: string }

type IntCase = Extract<Evaluated, { type: "int" }>
type BoolCase = Extract<Evaluated, { type: "bool" }>
type TextCase = Extract<Evaluated, { type: "text" }>

const maxDepth = 4

/** ASCII only, so code-point order is the host's string order. */
const texts = ["", "a", "B", "ab", "a b", "z", "%", "_", "10", "9"] as const

const compare = {
	"=": (a: number, b: number) => a === b,
	"<>": (a: number, b: number) => a !== b,
	"<": (a: number, b: number) => a < b,
	"<=": (a: number, b: number) => a <= b,
	">": (a: number, b: number) => a > b,
	">=": (a: number, b: number) => a >= b
} as const

const comparisons = ["=", "<>", "<", "<=", ">", ">="] as const

/** -1, 0 or 1 as a and b order. */
const order = <A extends bigint | string>(a: A, b: A): number => (a < b ? -1 : a > b ? 1 : 0)

class Expressions {
	readonly #swarm: Swarm<ExpressionFeature>
	readonly #tape: Draws
	readonly reached = new Set<"collated between bound">()

	constructor(drawn: Swarm<ExpressionFeature>, draws: Draws) {
		this.#swarm = drawn
		this.#tape = draws
	}

	/** The floor, or one of the forms whose feature is on, at a depth that may still nest. */
	#choose<A>(floor: A, depth: number, forms: ReadonlyArray<readonly [ExpressionFeature, A]>): A {
		if (depth <= 0) {
			return floor
		}
		return this.#tape.from([
			floor,
			...Arr.map(
				Arr.filter(forms, ([f]) => weightOf(this.#swarm, f) > 0),
				([, form]) => form
			)
		])
	}

	int(depth: number): IntCase {
		const t = this.#tape
		/**
		 * char_length is an integer; the cast makes it a bigint operand like every other.
		 *
		 * + and - spelled OPERATOR(pg_catalog.op), which PostgreSQL parses at the level of any other operator
		 * whatever the symbol, so (a OPERATOR(pg_catalog.-) b) - c keeps its parentheses.
		 *
		 * bigint << integer and bigint >> integer: arithmetic like BigInt's, at the level of PostgreSQL's other
		 * operators, below + and -.
		 */
		const form = this.#choose<
			"leaf" | "arithmetic" | "shift" | "qualified" | "negate" | "case" | "greatest" | "char_length"
		>("leaf", depth, [
			["arithmetic", "arithmetic"],
			["shift", "shift"],
			["qualified operator", "qualified"],
			["negate", "negate"],
			["case", "case"],
			["greatest", "greatest"],
			["char_length", "char_length"]
		])
		switch (form) {
			case "leaf": {
				const n = t.count(-9, 9)
				return { type: "int", expr: lit.int(n, types.bigint), value: BigInt(n) }
			}
			case "arithmetic": {
				const op = t.from(["+", "-", "*"] as const)
				const a = this.int(depth - 1)
				const b = this.int(depth - 1)
				return {
					type: "int",
					expr: binary(op, a.expr, b.expr),
					value: op === "+" ? a.value + b.value : op === "-" ? a.value - b.value : a.value * b.value
				}
			}
			case "shift": {
				const op = t.from(["<<", ">>"] as const)
				const a = this.int(depth - 1)
				const k = t.count(0, 3)
				return {
					type: "int",
					expr: binary(op, a.expr, lit.int(k, types.integer)),
					value: op === "<<" ? a.value << BigInt(k) : a.value >> BigInt(k)
				}
			}
			case "qualified": {
				const op = t.from(["+", "-"] as const)
				const a = this.int(depth - 1)
				const b = this.int(depth - 1)
				return {
					type: "int",
					expr: { kind: "binary", op, left: a.expr, right: b.expr, schema: "pg_catalog" },
					value: op === "+" ? a.value + b.value : a.value - b.value
				}
			}
			case "negate": {
				const a = this.int(depth - 1)
				return { type: "int", expr: { kind: "negate", expr: a.expr }, value: -a.value }
			}
			case "case": {
				const p = this.bool(depth - 1)
				const a = this.int(depth - 1)
				const b = this.int(depth - 1)
				return {
					type: "int",
					expr: {
						kind: "case",
						whens: [{ when: p.expr, result: a.expr }],
						else: b.expr,
						operand: undefined
					},
					value: p.value ? a.value : b.value
				}
			}
			case "greatest": {
				const kind = t.from(["greatest", "least"] as const)
				const a = this.int(depth - 1)
				const b = this.int(depth - 1)
				const greater = a.value > b.value ? a.value : b.value
				const lesser = a.value < b.value ? a.value : b.value
				return {
					type: "int",
					expr: { kind, args: [a.expr, b.expr] },
					value: kind === "greatest" ? greater : lesser
				}
			}
			case "char_length": {
				const s = this.text(depth - 1)
				return {
					type: "int",
					expr: cast(call("char_length", [s.expr]), types.bigint),
					value: BigInt(Arr.fromIterable(s.value).length)
				}
			}
		}
	}

	bool(depth: number): BoolCase {
		const t = this.#tape
		/**
		 * BETWEEN's lower bound is PostgreSQL's b_expr, which has no COLLATE: a collated bound, bare or under ||,
		 * parses only inside parentheses, so the value says whether the printer gave them. The left operand is
		 * collated too, so both comparisons order by code point, the host's order over ASCII.
		 */
		const form = this.#choose<
			| "leaf"
			| "comparison"
			| "text comparison"
			| "connective"
			| "not"
			| "is true"
			| "between"
			| "text between"
			| "in list"
			| "row in"
			| "equality"
		>("leaf", depth, [
			["comparison", "comparison"],
			["comparison", "text comparison"],
			["connectives", "connective"],
			["not", "not"],
			["is true", "is true"],
			["between", "between"],
			["between", "text between"],
			["in list", "in list"],
			["row in", "row in"],
			["boolean equality", "equality"]
		])
		switch (form) {
			case "leaf": {
				const b = t.from([false, true])
				return { type: "bool", expr: lit.bool(b), value: b }
			}
			case "comparison": {
				const op = t.from(comparisons)
				const a = this.int(depth - 1)
				const b = this.int(depth - 1)
				return {
					type: "bool",
					expr: binary(op, a.expr, b.expr),
					value: compare[op](order(a.value, b.value), 0)
				}
			}
			case "text comparison": {
				const op = t.from(comparisons)
				const a = this.text(depth - 1)
				const b = this.text(depth - 1)
				const collated: Expr = { kind: "collate", expr: a.expr, collation: cUtf8Collation }
				return {
					type: "bool",
					expr: binary(op, collated, b.expr),
					value: compare[op](order(a.value, b.value), 0)
				}
			}
			case "connective": {
				const kind = t.from(["and", "or"] as const)
				const args = Arr.makeBy(t.count(2, 3), () => this.bool(depth - 1))
				return {
					type: "bool",
					expr: { kind, args: Arr.map(args, (a) => a.expr) },
					value: kind === "and" ? Arr.every(args, (a) => a.value) : Arr.some(args, (a) => a.value)
				}
			}
			case "not": {
				const p = this.bool(depth - 1)
				return { type: "bool", expr: { kind: "not", expr: p.expr }, value: !p.value }
			}
			case "is true": {
				const p = this.bool(depth - 1)
				return { type: "bool", expr: { kind: "isTrue", expr: p.expr }, value: p.value }
			}
			case "between": {
				const negated = t.from([false, true])
				const a = this.int(depth - 1)
				const low = this.int(depth - 1)
				const high = this.int(depth - 1)
				const inside = low.value <= a.value && a.value <= high.value
				return {
					type: "bool",
					expr: { kind: "between", expr: a.expr, low: low.expr, high: high.expr, not: negated },
					value: negated ? !inside : inside
				}
			}
			case "text between": {
				this.reached.add("collated between bound")
				const negated = t.from([false, true])
				const a = this.text(depth - 1)
				const low = this.text(depth - 1)
				const lower = (): TextCase => {
					const collated: Expr = { kind: "collate", expr: low.expr, collation: cUtf8Collation }
					if (!t.from([false, true])) {
						return { type: "text", expr: collated, value: low.value }
					}
					const tail = this.text(depth - 1)
					return {
						type: "text",
						expr: binary("||", collated, tail.expr),
						value: low.value + tail.value
					}
				}
				const bound = lower()
				const high = this.text(depth - 1)
				const inside = order(bound.value, a.value) <= 0 && order(a.value, high.value) <= 0
				return {
					type: "bool",
					expr: {
						kind: "between",
						expr: { kind: "collate", expr: a.expr, collation: cUtf8Collation },
						low: bound.expr,
						high: high.expr,
						not: negated
					},
					value: negated ? !inside : inside
				}
			}
			case "in list": {
				const negated = t.from([false, true])
				const a = this.int(depth - 1)
				const extra = t.count(0, 2)
				const list: Arr.NonEmptyReadonlyArray<IntCase> = [
					this.int(depth - 1),
					...Array.from({ length: extra }, () => this.int(depth - 1))
				]
				const member = Arr.some(list, (x) => x.value === a.value)
				return {
					type: "bool",
					expr: { kind: "inList", expr: a.expr, list: Arr.map(list, (x) => x.expr), not: negated },
					value: negated ? !member : member
				}
			}
			case "row in": {
				const a = [this.int(depth - 1), this.int(depth - 1)] as const
				const row = () => [this.int(depth - 1), this.int(depth - 1)] as const
				const extra = t.count(0, 1)
				const rows: Arr.NonEmptyReadonlyArray<ReturnType<typeof row>> = [
					row(),
					...Array.from({ length: extra }, row)
				]
				return {
					type: "bool",
					expr: {
						kind: "inList",
						expr: { kind: "row", items: Arr.map(a, (x) => x.expr) },
						list: Arr.map(rows, (r): Expr => ({ kind: "row", items: Arr.map(r, (x) => x.expr) })),
						not: false
					},
					value: Arr.some(rows, ([x, y]) => x.value === a[0].value && y.value === a[1].value)
				}
			}
			case "equality": {
				const p = this.bool(depth - 1)
				const q = this.bool(depth - 1)
				return {
					type: "bool",
					expr: binary("=", p.expr, q.expr),
					value: p.value === q.value
				}
			}
		}
	}

	text(depth: number): TextCase {
		const t = this.#tape
		const form = this.#choose<"leaf" | "concat" | "cast" | "collate">("leaf", depth, [
			["concat", "concat"],
			["text cast", "cast"],
			["collate", "collate"]
		])
		switch (form) {
			case "leaf": {
				const s = t.from(texts)
				return { type: "text", expr: lit.text(s, types.text), value: s }
			}
			case "concat": {
				const a = this.text(depth - 1)
				const b = this.text(depth - 1)
				return {
					type: "text",
					expr: binary("||", a.expr, b.expr),
					value: a.value + b.value
				}
			}
			case "cast": {
				const a = this.int(depth - 1)
				return { type: "text", expr: cast(a.expr, types.text), value: a.value.toString() }
			}
			case "collate": {
				const a = this.text(depth - 1)
				return {
					type: "text",
					expr: { kind: "collate", expr: a.expr, collation: cUtf8Collation },
					value: a.value
				}
			}
		}
	}
}

/** A resolved expression and what it reached. */
export interface EvaluatedCase {
	readonly item: Evaluated
	readonly reached: ReadonlySet<"collated between bound">
}

/** An expression of a drawn type, under a swarm of the expression forms. */
export const evaluatedGen: Gen<EvaluatedCase> = (source) => {
	const e = new Expressions(source.draw(swarm(expressionFeatures)), new Draws(source))
	const item = ((): Evaluated => {
		switch (source.draw(element(["int", "bool", "text"] as const))) {
			case "int":
				return e.int(maxDepth)
			case "bool":
				return e.bool(maxDepth)
			case "text":
				return e.text(maxDepth)
		}
	})()
	return { item, reached: e.reached }
}

export interface SetCase {
	readonly statement: Select
	/** The result, sorted. */
	readonly rows: ReadonlyArray<number>
}

type SetTree =
	| { readonly kind: "leaf"; readonly values: Arr.NonEmptyReadonlyArray<number> }
	| {
			readonly kind: "op"
			readonly op: SetOperator
			readonly left: SetTree
			readonly right: SetTree
	  }
	| { readonly kind: "top"; readonly tree: SetTree; readonly k: number }

const setOperators = ["UNION", "UNION ALL", "INTERSECT", "EXCEPT"] as const

/**
 * A tree of at most `depth` levels. A parenthesized level holds no parenthesized level directly below it: PostgreSQL
 * would merge the two levels' clauses, which the audit refuses (a lowering nests a derived table instead).
 */
const setTree = (t: Draws, depth: number, topped: boolean): SetTree => {
	const kind =
		depth <= 0
			? "leaf"
			: t.from(topped ? (["leaf", "op"] as const) : (["leaf", "op", "op", "top"] as const))
	switch (kind) {
		case "leaf": {
			const first = t.count(0, 3)
			return {
				kind: "leaf",
				values: [first, ...Array.from({ length: t.count(0, 3) }, () => t.count(0, 3))]
			}
		}
		case "op":
			return {
				kind: "op",
				op: t.from(setOperators),
				left: setTree(t, depth - 1, false),
				right: setTree(t, depth - 1, false)
			}
		case "top":
			return { kind: "top", tree: setTree(t, depth - 1, true), k: t.count(1, 3) }
	}
}

const distinct = (xs: ReadonlyArray<number>): ReadonlyArray<number> => [...new Set(xs)]

const setRows = (tree: SetTree): ReadonlyArray<number> => {
	switch (tree.kind) {
		case "leaf":
			return tree.values
		case "top":
			return Arr.sort([...setRows(tree.tree)], Order.flip(Order.Number)).slice(0, tree.k)
		case "op": {
			const left = setRows(tree.left)
			const right = setRows(tree.right)
			switch (tree.op) {
				case "UNION ALL":
					return [...left, ...right]
				case "UNION":
					return distinct([...left, ...right])
				case "INTERSECT":
					return distinct(Arr.filter(left, (x) => right.includes(x)))
				case "EXCEPT":
					return distinct(Arr.filter(left, (x) => !right.includes(x)))
			}
		}
	}
}

/**
 * The body of a tree and what an ORDER BY over it names: a VALUES leaf is a core read through its own column, an
 * operation reads the output c1, and a parenthesized level is a query ordering that body by it.
 */
interface Built {
	readonly body: OperandBody
	readonly key: Expr
}

const output: Expr = tableCol("c1")

/**
 * `body` then `arm` under `op`, left to right, as `continued` combines them; a UNION ALL is an operand, its rows those
 * of its arms, repeats and all.
 */
const joined = (op: SetOperator, body: OperandBody, arm: SetOperand): OperandBody => {
	if (op !== "UNION ALL") {
		return continued(op, body, arm)
	}
	if (body.kind === "setOp" && body.op === "UNION ALL" && body.rows === "operand") {
		const [first, second, ...rest] = body.arms
		return { ...body, arms: [first, second, ...rest, arm] }
	}
	return { kind: "setOp", op, rows: "operand", arms: [asOperand(body), arm] }
}

const setBody = (tree: SetTree, alias: () => string): Built => {
	switch (tree.kind) {
		case "leaf": {
			const r = alias()
			return {
				body: core(
					[targetAs(col(r, "c1"), "c1")],
					[
						{
							kind: "values",
							rows: Arr.map(tree.values, (v) => [lit.int(v, types.integer)]),
							alias: r,
							columns: ["c1"]
						}
					],
					undefined
				),
				key: col(r, "c1")
			}
		}
		case "op":
			return {
				body: joined(
					tree.op,
					setBody(tree.left, alias).body,
					asOperand(setBody(tree.right, alias).body)
				),
				key: output
			}
		case "top": {
			const inner = setBody(tree.tree, alias)
			return {
				body: {
					...operandSelect(inner.body),
					orderBy: [desc(inner.key)],
					limit: lit.int(tree.k, types.bigint)
				},
				key: output
			}
		}
	}
}

/**
 * A set-operation tree of up to three levels, and whether a whole tree that is one parenthesized level sits one more
 * parenthesized level below the statement, with no clauses of its own there.
 */
export const setCaseGen: Gen<SetCase> = (source) => {
	const tree = setTree(new Draws(source), 3, false)
	const wrapped = source.draw(boolean)
	let n = 0
	const { body } = setBody(tree, () => {
		n += 1
		return `r${n}`
	})
	/** The tree's rows may repeat, under UNION ALL or a VALUES leaf: the statement reads them as a set. */
	const query: OperandSelect =
		body.kind === "select" ? (wrapped ? operandSelect(body) : body) : operandSelect(body)
	const statement: Select = select(
		distinctCore(
			[targetAs(col("r0", "c1"), "c1")],
			[derived(query, "r0", ["c1"], false)],
			undefined
		)
	)
	return { statement, rows: Arr.sort([...distinct(setRows(tree))], Order.Number) }
}

export interface AggregateCase {
	readonly statement: Select
	readonly rows: ReadonlyArray<ReadonlyArray<string>>
}

type AggregateSpec =
	| { readonly fn: "count" | "sum" | "min" | "max"; readonly distinct: boolean }
	| { readonly fn: "array_agg"; readonly distinct: boolean; readonly direction: "ASC" | "DESC" }
	| { readonly fn: "count filter"; readonly above: number }

const aggregateSpec = (t: Draws): AggregateSpec => {
	const fn = t.from(["count", "sum", "min", "max", "array_agg", "count filter"] as const)
	switch (fn) {
		case "array_agg":
			return { fn, distinct: t.from([false, true]), direction: t.from(["ASC", "DESC"] as const) }
		case "count filter":
			return { fn, above: t.count(0, 3) }
		case "count":
		case "sum":
		case "min":
		case "max":
			return { fn, distinct: t.from([false, true]) }
	}
}

const value = col("r1", "c2")

const aggregateCall = (spec: AggregateSpec): FunctionCall => {
	switch (spec.fn) {
		case "count filter":
			return { ...countStar(), filter: binary(">", value, lit.int(spec.above, types.integer)) }
		case "array_agg":
			return {
				...call("array_agg", [value]),
				distinct: spec.distinct,
				orderBy: [spec.direction === "ASC" ? asc(value) : desc(value)]
			}
		case "count":
		case "sum":
		case "min":
		case "max":
			return { ...call(spec.fn, [value]), distinct: spec.distinct }
	}
}

const aggregateText = (spec: AggregateSpec, values: Arr.NonEmptyReadonlyArray<number>): string => {
	if (spec.fn === "count filter") {
		return String(Arr.filter(values, (v) => v > spec.above).length)
	}
	const xs = spec.distinct ? distinct(values) : values
	switch (spec.fn) {
		case "count":
			return String(xs.length)
		case "sum":
			return String(Arr.reduce(xs, 0, (a, b) => a + b))
		case "min":
			return String(Arr.reduce(xs, Number.POSITIVE_INFINITY, (least, x) => Math.min(least, x)))
		case "max":
			return String(maxOf(xs, Number.NEGATIVE_INFINITY))
		case "array_agg":
			return `{${Arr.join(
				Arr.map(
					Arr.sort(xs, spec.direction === "ASC" ? Order.Number : Order.flip(Order.Number)),
					(x) => String(x)
				),
				","
			)}}`
	}
}

/** Grouped (group, value) pairs and up to three aggregates over them, with the text PostgreSQL gives each group. */
export const aggregateCaseGen: Gen<AggregateCase> = (source) => {
	const t = new Draws(source)
	const pair = (): readonly [number, number] => [t.count(0, 1), t.count(0, 3)]
	const pairs: Arr.NonEmptyReadonlyArray<readonly [number, number]> = [
		pair(),
		...Array.from({ length: t.count(0, 5) }, pair)
	]
	const specs = [aggregateSpec(t), ...Array.from({ length: t.count(0, 2) }, () => aggregateSpec(t))]
	const groups = Arr.sort([...new Set(Arr.map(pairs, ([g]) => g))], Order.Number)
	return {
		statement: {
			...select({
				...provedCore(
					"grouped",
					[
						targetAs(col("r1", "c1"), "c1"),
						...Arr.map(specs, (spec, i) =>
							targetAs(cast(aggregateCall(spec), types.text), `c${i + 2}`)
						)
					],
					[
						{
							kind: "values",
							rows: Arr.map(pairs, ([g, v]) => [
								lit.int(g, types.integer),
								lit.int(v, types.integer)
							]),
							alias: "r1",
							columns: ["c1", "c2"]
						}
					],
					undefined
				),
				groupBy: [col("r1", "c1")]
			}),
			orderBy: [asc(col("r1", "c1"))]
		},
		rows: Arr.map(groups, (g) => {
			const [first, ...rest] = Arr.map(
				Arr.filter(pairs, ([h]) => h === g),
				([, v]) => v
			)
			if (first === undefined) {
				throw new Error(`the group ${g} holds no value`)
			}
			return [String(g), ...Arr.map(specs, (spec) => aggregateText(spec, [first, ...rest]))]
		})
	}
}

/** What a relational case reached: its form, and for a window its frame's bound kinds, partitioning and direction. */
export type RelationalFeature =
	| "cross join"
	| "in"
	| "not in"
	| "empty subquery"
	| `frame ${FrameBound["kind"]} to ${FrameBound["kind"]}`
	| "partitioned window"
	| "descending window"
	| "empty frame"

export interface RelationalCase {
	readonly statement: Select
	/** The rows PostgreSQL returns in the statement's order, every cell as text, NULL as null. */
	readonly rows: ReadonlyArray<ReadonlyArray<string | null>>
	readonly reached: ReadonlyArray<RelationalFeature>
}

/** A frame bound's position on the line of rows around the current one: unbounded ends at the infinities. */
const boundRank = (bound: FrameBound): number => {
	switch (bound.kind) {
		case "unboundedPreceding":
			return Number.NEGATIVE_INFINITY
		case "currentRow":
			return 0
		case "unboundedFollowing":
			return Number.POSITIVE_INFINITY
		case "offset":
			return bound.direction === "PRECEDING" ? -Number(bound.offset) : Number(bound.offset)
	}
}

/** The side of the current row a bound names: preceding, the row itself, or following. */
const boundSide = (bound: FrameBound): number =>
	bound.kind === "unboundedPreceding" ||
	(bound.kind === "offset" && bound.direction === "PRECEDING")
		? -1
		: bound.kind === "currentRow"
			? 0
			: 1

const byRowId: Order.Order<{ readonly id: number }> = Order.mapInput(
	Order.Number,
	(r: { readonly id: number }) => r.id
)

/** Bounds in frame order: by position, then by side. */
const boundOrder: Order.Order<FrameBound> = Order.combine(
	Order.mapInput(Order.Number, boundRank),
	Order.mapInput(Order.Number, boundSide)
)

/** A bound a frame may start or end at: an offset of 0 to 2 rows, the current row, or the unbounded end on its side. */
const frameBound =
	(unbounded: "unboundedPreceding" | "unboundedFollowing"): Gen<FrameBound> =>
	(source) => {
		const t = new Draws(source)
		const kind = t.from(["unbounded", "preceding", "current", "following"] as const)
		switch (kind) {
			case "unbounded":
				return { kind: unbounded }
			case "current":
				return { kind: "currentRow" }
			case "preceding":
				return { kind: "offset", offset: BigInt(t.count(0, 2)), direction: "PRECEDING" }
			case "following":
				return { kind: "offset", offset: BigInt(t.count(0, 2)), direction: "FOLLOWING" }
		}
	}

/** A row of r1 as a sketch states it: its value and its group; its id is its place, from 1. */
export interface RelationalRow {
	readonly value: number
	readonly group: number
}

/**
 * What a relational case computes over its relations: a CROSS JOIN; IN or NOT IN over the subquery of r2's values above
 * a floor; or sum and count(*) over a window between two bounds, in the order drawn, partitioned by r1's group or
 * not, ordered by r1's id either way.
 */
export type RelationalForm =
	| { readonly kind: "cross join" }
	| { readonly kind: "in" | "not in"; readonly floor: number }
	| {
			readonly kind: "window"
			readonly bounds: readonly [FrameBound, FrameBound]
			readonly partitioned: boolean
			readonly descending: boolean
	  }

/** A relational case as data: r1(c1, c2, c3) as its rows, r2(c1) as its values, and the form over them. */
export interface RelationalSketch {
	readonly r1: Arr.NonEmptyReadonlyArray<RelationalRow>
	readonly r2: Arr.NonEmptyReadonlyArray<number>
	readonly form: RelationalForm
}

/**
 * Relational cases: r1 holds 1 to 6 rows, each a value 0 to 3 and a group 0 or 1; r2 holds 1 to 4 values 0 to 3,
 * repeats allowed. Windows take two shares of the forms: their frames are the widest part of the space. The running
 * and remaining frames the running-aggregate lowering prints are planted, a quarter of the windows each; the other
 * half draw both bounds.
 */
export const relationalSketchGen: Gen<RelationalSketch> = (source) => {
	const t = new Draws(source)
	const rowGen = (row: Source): RelationalRow => ({
		value: row.draw(int(0, 3)),
		group: row.draw(int(0, 1))
	})
	const r1: Arr.NonEmptyReadonlyArray<RelationalRow> = [
		source.draw(rowGen),
		...source.draw(array(rowGen, { min: 0, max: 5 }))
	]
	const r2: Arr.NonEmptyReadonlyArray<number> = [
		source.draw(int(0, 3)),
		...source.draw(array(int(0, 3), { min: 0, max: 3 }))
	]
	const kind = t.from(["cross join", "in", "not in", "window", "window"] as const)
	switch (kind) {
		case "cross join":
			return { r1, r2, form: { kind } }
		case "in":
		case "not in":
			return { r1, r2, form: { kind, floor: t.count(-1, 3) } }
		case "window": {
			const frame = t.from(["running", "remaining", "drawn", "drawn"] as const)
			const bounds: readonly [FrameBound, FrameBound] =
				frame === "running"
					? [{ kind: "unboundedPreceding" }, { kind: "currentRow" }]
					: frame === "remaining"
						? [{ kind: "currentRow" }, { kind: "unboundedFollowing" }]
						: [
								source.draw(frameBound("unboundedPreceding")),
								source.draw(frameBound("unboundedFollowing"))
							]
			return {
				r1,
				r2,
				form: {
					kind,
					bounds,
					partitioned: t.from([false, true]),
					descending: t.from([false, true])
				}
			}
		}
	}
}

/** The statement a relational sketch prints, the rows PostgreSQL returns for it, and what it reached. */
export const resolveRelational = (sketch: RelationalSketch): RelationalCase => {
	const r1 = Arr.map(sketch.r1, (row, i) => ({ id: i + 1, value: row.value, group: row.group }))
	/** r2 is a relation, a set: its values once each. */
	const r2 = Arr.dedupe(sketch.r2)
	const r1From = {
		kind: "values" as const,
		rows: Arr.map(r1, (r) => [
			lit.int(r.id, types.integer),
			lit.int(r.value, types.integer),
			lit.int(r.group, types.integer)
		]),
		alias: "r1",
		columns: ["c1", "c2", "c3"] as const
	}
	const r2Values = (alias: string) => ({
		kind: "values" as const,
		rows: Arr.map(r2, (x) => [lit.int(x, types.integer)]),
		alias,
		columns: ["c1"] as const
	})
	const form = sketch.form
	switch (form.kind) {
		case "cross join":
			return {
				statement: {
					...select(
						provedCore(
							"keyed",
							[targetAs(col("r1", "c1"), "c1"), targetAs(col("r2", "c1"), "c2")],
							[
								{ kind: "joins", first: r1From, steps: [{ kind: "cross", source: r2Values("r2") }] }
							],
							undefined
						)
					),
					orderBy: [asc(col("r1", "c1")), asc(col("r2", "c1"))]
				},
				rows: Arr.flatMap(r1, (r) =>
					Arr.map(Arr.sort([...r2], Order.Number), (x) => [String(r.id), String(x)])
				),
				reached: ["cross join"]
			}
		case "in":
		case "not in": {
			/** The subquery keeps the values above the floor, which may keep none. */
			const kept = Arr.filter(r2, (x) => x > form.floor)
			const subquery = operandSelect(
				core(
					[target(col("r2", "c1"))],
					[r2Values("r2")],
					binary(">", col("r2", "c1"), lit.int(form.floor, types.integer))
				)
			)
			const matches = (x: number): boolean => kept.includes(x) === (form.kind === "in")
			return {
				statement: {
					...select(
						provedCore("keyed", [targetAs(col("r1", "c1"), "c1")], [r1From], {
							kind: "inQuery",
							expr: col("r1", "c2"),
							query: subquery,
							not: form.kind === "not in"
						})
					),
					orderBy: [asc(col("r1", "c1"))]
				},
				rows: Arr.map(
					Arr.filter(r1, (r) => matches(r.value)),
					(r) => [String(r.id)]
				),
				reached: kept.length === 0 ? [form.kind, "empty subquery"] : [form.kind]
			}
		}
		case "window": {
			const [first, second] = form.bounds
			const { partitioned, descending } = form
			/**
			 * The earlier bound starts the frame: an unbounded preceding start or following end stays on its side, and of
			 * two bounds on the current row (an offset of 0) the preceding one, the current row, then the following one,
			 * since PostgreSQL refuses a frame starting at or after the current row with preceding rows.
			 */
			const [start, end] = boundOrder(first, second) <= 0 ? [first, second] : [second, first]
			const windowOrder: OrderItem = descending ? desc(col("r1", "c1")) : asc(col("r1", "c1"))
			const over: WindowSpec = {
				partitionBy: partitioned ? [col("r1", "c3")] : [],
				orderBy: [windowOrder],
				frame: { start, end }
			}
			/** Each row's frame: the rows of its partition, in the window's order, between the bounds around it. */
			const framed = Arr.map(Arr.sort(r1, byRowId), (row) => {
				const inPartition = Arr.filter(r1, (r) => !partitioned || r.group === row.group)
				const partition = Arr.sort(inPartition, descending ? Order.flip(byRowId) : byRowId)
				const at = Option.getOrThrow(Arr.findFirstIndex(partition, (r) => r.id === row.id))
				return {
					row,
					rows: whereIndex(partition, (i) => i - at >= boundRank(start) && i - at <= boundRank(end))
				}
			})
			const empty = Arr.some(framed, (f) => f.rows.length === 0)
			const rows = Arr.map(framed, (f) => [
				String(f.row.id),
				f.rows.length === 0 ? null : String(Arr.reduce(f.rows, 0, (acc, r) => acc + r.value)),
				String(f.rows.length)
			])
			return {
				statement: {
					...select(
						provedCore(
							"keyed",
							[
								targetAs(col("r1", "c1"), "c1"),
								targetAs(cast({ ...call("sum", [col("r1", "c2")]), over }, types.text), "c2"),
								targetAs(cast({ ...countStar(), over }, types.text), "c3")
							],
							[r1From],
							undefined
						)
					),
					orderBy: [asc(col("r1", "c1"))]
				},
				rows,
				reached: [
					`frame ${start.kind} to ${end.kind}`,
					...(partitioned ? (["partitioned window"] as const) : []),
					...(descending ? (["descending window"] as const) : []),
					...(empty ? (["empty frame"] as const) : [])
				]
			}
		}
	}
}
