/** What the properties of simplify.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { floatLiteral } from "#compiler/ir/carriers.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { Account, Posting, Q, T, uuidOf } from "#test/support/unit/lower/conservative/fixtures.ts"
import {
	deliversAlikeOn,
	factSubsets,
	ledgerCatalog,
	nodesOf,
	passContext,
	queryOf,
	type Ran,
	rulesOf,
	runPasses
} from "#test/support/unit/lower/rewrite/support.ts"

/** A uuid literal of the ledger fixture's n-th id (conservative/fixtures.ts uuidOf). */
export const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })

/** A bigint literal. */
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** A text literal. */
const textLit = (value: string): TypedLiteral => ({ kind: "text", value })

/**
 * Every database of these posting and account facts: postings of two accounts and of one no account holds, amounts on
 * either side of 6, and accounts with and without postings.
 */
const databases = factSubsets({
	Posting: [
		[u(1), u(10), i8(5)],
		[u(2), u(10), i8(7)],
		[u(3), u(12), i8(7)]
	],
	Account: [
		[u(10), textLit("a")],
		[u(11), textLit("b")]
	]
})

/** A region over every posting, binding its id, account and amount. */
export const postings = (q: Q) =>
	q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { id: "id", account: "account", amount: "amount" },
			constants: {}
		}
	])

/** Whether the reference evaluator judges a case's delivery: it computes no vector comparison. */
type Judged = "by the reference" | "outside the reference"

/** Runs the simplifier over the DAG, validating its result, held to the reference where `judged` says. */
const simplifiedJudged = (dag: RelDag, judged: Judged): Ran => {
	const query = queryOf(dag, [])
	const ran = succeeded(
		runPasses(query, [simplifyPass], passContext({ catalog: ledgerCatalog, evidence: "snapshot" }))
	)
	validateDag(ran.query.dag)
	if (judged === "by the reference") {
		deliversAlikeOn(databases, [Posting, Account], [], query, ran.query)
	}
	return ran
}

/** Runs the simplifier over the DAG, held to the reference's delivery. */
export const simplified = (dag: RelDag): Ran => simplifiedJudged(dag, "by the reference")

/** A predicate that reads a column: amount > 6. */
export const predicate = (q: Q, node: RelNode): ScalarExpr =>
	q.op("int8gt", [q.col(node, "amount"), q.int(6, T.int8)], T.bool)

/**
 * What a filter over the postings became: decided true (gone, its input in its place), decided false (the empty
 * relation), or left to PostgreSQL with its predicate as it was.
 */
export type Decision = "true" | "false" | "undecided"

/**
 * The decision simplification took on `filter`, read off the rewritten query, holding each outcome to its rule:
 * an always-true filter disappears into its input, its one reference; an always-false one is the empty relation; an
 * undecided one keeps its predicate and records no fold.
 */
const decisionOf = (ran: Ran, region: RelNode, filterNode: RelNode, pred: ScalarExpr): Decision => {
	const dag = ran.query.dag
	const root = dag.roots[0]
	if (root.id === region.id) {
		assert.deepEqual(nodesOf(dag, "Filter"), [])
		return "true"
	}
	if (root.kind === "Closed") {
		assert.deepEqual(root.rows, [])
		return "false"
	}
	const kept = nodesByLabel(dag).get(filterNode.id)
	assert.equal(kept?.kind === "Filter" ? kept.pred.id : undefined, pred.id)
	assert.equal(rulesOf(ran.certificates).includes("simplify.fold"), false)
	return "undecided"
}

/**
 * One typed literal of the comparison dictionary, with its place in PostgreSQL's total order of its type, computed
 * here independently of the compiler: numeric by value whatever its scale, float8 with -0 equal to 0 and NaN above
 * every number and equal to itself, text by code points (C.UTF-8).
 */
interface Typed {
	readonly type: "numeric" | "float8" | "text"
	readonly literal: TypedLiteral
	readonly rank: ReadonlyArray<number>
}

/** A numeric literal of the dictionary, ranked by its value. */
const numericLit = (text: string): Typed => ({
	type: "numeric",
	literal: { kind: "numeric", value: defined(DecimalText.parse(text)) },
	rank: [Number(text)]
})

/** A float8 literal of the dictionary, ranked with -0 as 0. */
const floatLit = (value: number): Typed => ({
	type: "float8",
	literal: floatLiteral(value),
	rank: [value === 0 ? 0 : value]
})

/** NaN is ordered by its tier (tierOf), above every number. */
const floatSpecial = (value: "NaN" | "Infinity" | "-Infinity"): Typed => ({
	type: "float8",
	literal: { kind: "floatSpecial", value },
	rank: [
		value === "Infinity"
			? Number.POSITIVE_INFINITY
			: value === "-Infinity"
				? Number.NEGATIVE_INFINITY
				: 0
	]
})

/** The code points, then a terminator below every code point, so a proper prefix ranks below. */
const textTyped = (value: string): Typed => ({
	type: "text",
	literal: { kind: "text", value },
	rank: [
		...Array.from(value, (ch) =>
			Option.getOrThrowWith(Str.codePointAt(ch, 0), () => new Error("a code point"))
		),
		-1
	]
})

/**
 * The dictionary: numeric values on either side of an integer, each the one literal of its value, float8's NaN,
 * infinities and signed zeros, and text whose code points order otherwise than their letters would suggest (é above z)
 * and proper prefixes.
 */
const dictionary: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Typed>> = [
	[numericLit("-0.5"), numericLit("1"), numericLit("1.5"), numericLit("2")],
	[
		floatSpecial("NaN"),
		floatSpecial("Infinity"),
		floatSpecial("-Infinity"),
		floatLit(-0),
		floatLit(0),
		floatLit(1.5)
	],
	[textTyped(""), textTyped("a"), textTyped("ab"), textTyped("z"), textTyped("é")]
]

/** Two ranks compared lexicographically, a prefix first: negative, zero or positive. */
const lexCompare = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
	for (const [i, x] of a.entries()) {
		const y = b[i]
		if (y === undefined) {
			return 1
		}
		if (x !== y) {
			return x < y ? -1 : 1
		}
	}
	return a.length === b.length ? 0 : -1
}

/** A comparison operator's name. */
type Comparison = "eq" | "ne" | "lt" | "le" | "gt" | "ge"

/** Whether each comparison holds of two literals whose order is `sign`. */
export const holds: Readonly<Record<Comparison, (sign: number) => boolean>> = {
	eq: (s) => s === 0,
	ne: (s) => s !== 0,
	lt: (s) => s < 0,
	le: (s) => s <= 0,
	gt: (s) => s > 0,
	ge: (s) => s >= 0
}

/** The registry operator of a comparison over a type. */
export const operatorOf = (type: Typed["type"], cmp: Comparison): string =>
	type === "numeric"
		? `numeric_${cmp}`
		: type === "float8"
			? `float8${cmp}`
			: cmp === "eq"
				? "texteq"
				: cmp === "ne"
					? "textne"
					: `text_${cmp}`

/** The scalar type of a dictionary type. */
export const scalarOf = (type: Typed["type"]): ScalarType =>
	type === "numeric" ? T.numeric : type === "float8" ? T.float8 : T.text

/** NaN stands in a tier above every float8 number, infinities included, and equals itself. */
const tierOf = (t: Typed): number =>
	t.literal.kind === "floatSpecial" && t.literal.value === "NaN" ? 1 : 0

/** The order of two literals of one type, by PostgreSQL's total order of it: negative, zero or positive. */
export const comparedSign = (a: Typed, b: Typed): number => {
	const tier = tierOf(a) - tierOf(b)
	return tier !== 0 ? Math.sign(tier) : tierOf(a) === 1 ? 0 : lexCompare(a.rank, b.rank)
}

/** Every comparison operator. */
export const comparisons = element<Comparison>(["eq", "ne", "lt", "le", "gt", "ge"])

/** Every pair of literals of one type of the dictionary. */
export const literalPairs = oneOf(
	Arr.map(
		dictionary,
		(values): Gen<readonly [Typed, Typed]> =>
			(source) =>
				[source.draw(element(values)), source.draw(element(values))] as const
	)
)

/** What the folding suites reach: each decision, and each type compared. */
export type FoldFeature =
	| `decided ${Decision}`
	| `compared ${Typed["type"]}`
	| "a vector membership decided"

/** A filter over the postings whose predicate `pred` builds, simplified, and its decision. */
export const decide = (pred: (q: Q, region: RelNode) => ScalarExpr, judged: Judged): Decision => {
	const q = new Q()
	const region = postings(q)
	const p = pred(q, region)
	const f = q.filter(region, p)
	return decisionOf(simplifiedJudged(q.build(f).dag, judged), region, f, p)
}

/** What branch removal removed: an empty region, an empty union arm, an anti-join's empty right side, or everything. */
export type Removed =
	| "an empty region"
	| "an empty union arm"
	| "an empty anti-join right side"
	| "every input empty"

/** BETWEEN over three of 0..2, IN of one among one or two, or IN over vectors equal or not. */
type Form =
	| { readonly kind: "between"; readonly x: number; readonly lo: number; readonly hi: number }
	| { readonly kind: "in"; readonly x: number; readonly among: ReadonlyArray<number> }
	| { readonly kind: "vectors"; readonly same: boolean }

/** A value of 0..2. */
const values = int(0, 2)

/** Every form of the box. */
export const forms = oneOf<Form>([
	map(
		(source) => [source.draw(values), source.draw(values), source.draw(values)] as const,
		([x, lo, hi]): Form => ({ kind: "between", x, lo, hi })
	),
	map(
		(source) => [source.draw(values), source.draw(array(values, { min: 1, max: 2 }))] as const,
		([x, among]): Form => ({ kind: "in", x, among })
	),
	map(boolean, (same): Form => ({ kind: "vectors", same }))
])

/**
 * Arithmetic compared with a literal (true or false had the host computed it), or a connective whose literal
 * operand decides it beside a column predicate, on either side.
 */
type Shape =
	| {
			readonly kind: "arithmetic"
			readonly op: "int8pl" | "int8mi" | "int8mul"
			readonly against: number
	  }
	| {
			readonly kind: "connective"
			readonly connective: "and" | "or"
			readonly literalFirst: boolean
	  }

/** Every shape of the box. */
export const shapes = oneOf<Shape>([
	map(
		(source) =>
			[
				source.draw(element<"int8pl" | "int8mi" | "int8mul">(["int8pl", "int8mi", "int8mul"])),
				source.draw(int(0, 2))
			] as const,
		([op, against]): Shape => ({ kind: "arithmetic", op, against })
	),
	map(
		(source) => [source.draw(element<"and" | "or">(["and", "or"])), source.draw(boolean)] as const,
		([connective, literalFirst]): Shape => ({ kind: "connective", connective, literalFirst })
	)
])

/** The fixture roster's handles, in order. */
export const roster = ["Automatic", "Manual"] as const

/** A handle of the fixture roster. */
export type Handle = (typeof roster)[number]
