/**
 * Semantic simplification (lower/optimize/simplify): the host decides only comparisons and truth values, never
 * arithmetic; finite folding decides a filter over declared facts; branch removal keeps every union's discriminant
 * readable; equality propagation hands the region the filter's evidence; and every rewrite leaves the delivered result
 * unchanged and the DAG one the strict re-reader admits. No evaluation raises (scalar/compute/registry.ts Totality), so
 * folding drops, and merging moves, any evaluation.
 *
 * - Literal folding compares literals under PostgreSQL's equality and order: numeric by value whatever its scale,
 *   float8's NaN above every number and equal to itself, -0 equal to 0, text by code points.
 * - BETWEEN and IN over literals are decided; IN over vectors, which the host never orders, is left to PostgreSQL.
 * - Arithmetic is never evaluated on the host; a connective's deciding literal decides it, dropping the other operand.
 * - A filter over a roster's declared facts is the satisfying facts, as a set.
 * - An empty input is removed, whatever evaluations it drops.
 * - A filter every conjunct of which becomes a region equality gives the region its evidence, so an order total by it
 *   stays so.
 *
 * Oracle: each rule's documented statement (simplify/rules.ts, boolean.ts) as a checker over every shape of a small
 * space, the literal order computed independently of the compiler (a second implementation of PostgreSQL's order), the
 * reference evaluator's delivery on every database of a few posting and account facts, and the strict DAG re-reader.
 * The merges of filters and of projections are the rewrite population's (rewrite/generated.test.ts, which requires
 * simplify.mergeFilters and plants simplify.mergeProjections), held to the same delivery.
 *
 * Features: each decision and each type compared; a vector membership left to PostgreSQL; facts satisfying and none;
 * each kind of branch removed; every conjunct an equality, and a conjunct left.
 *
 * Plants, each failing its search: NaN equal to every number (simplify-nan-order); BETWEEN strict on both bounds
 * (simplify-between-strict); a decided connective folding to the opposite value (simplify-connective-decider); finite
 * folding keeping the rejected facts (simplify-finite-inverted); branch removal keeping empty arms
 * (simplify-empty-arms); equality propagation leaving the region its own metadata (simplify-equality-meta).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, oneOf, subset } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { VectorText } from "#compiler/ir/carriers.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import {
	Account,
	asc,
	keyed,
	Posting,
	Q,
	T,
	uuidOf
} from "#test/unit/lower/conservative/fixtures.ts"

import { canonicalZero } from "#compiler/ir/carriers.ts"
import { caseHang } from "#test/support/limits.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	passContext,
	deliversAlikeOn,
	factSubsets,
	ledgerCatalog,
	nodesOf,
	queryOf,
	type Ran,
	rulesOf,
	runPasses
} from "#test/unit/lower/rewrite/support.ts"

const u = (n: number): TypedLiteral => ({ kind: "uuid", value: uuidOf(n) })
const i8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })
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

const postings = (q: Q) =>
	q.region([
		{
			source: q.base(Posting, conservativeMeta),
			bind: { id: "id", account: "account", amount: "amount" },
			constants: {}
		}
	])

/** Whether the reference evaluator judges a case's delivery: it computes no vector comparison. */
type Judged = "by the reference" | "outside the reference"

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

const simplified = (dag: RelDag): Ran => simplifiedJudged(dag, "by the reference")

/** A predicate that reads a column: amount > 6. */
const predicate = (q: Q, node: RelNode): ScalarExpr =>
	q.op("int8gt", [q.col(node, "amount"), q.int(6, T.int8)], T.bool)

/**
 * What a filter over the postings became: decided true (gone, its input in its place), decided false (the empty
 * relation), or left to PostgreSQL with its predicate as it was.
 */
type Decision = "true" | "false" | "undecided"

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

const numericLit = (text: string): Typed => ({
	type: "numeric",
	literal: { kind: "numeric", value: defined(DecimalText.parse(text)) },
	rank: [Number(text)]
})

const floatLit = (value: number): Typed => ({
	type: "float8",
	literal: { kind: "float", value: canonicalZero(value) },
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

type Comparison = "eq" | "ne" | "lt" | "le" | "gt" | "ge"

const holds: Readonly<Record<Comparison, (sign: number) => boolean>> = {
	eq: (s) => s === 0,
	ne: (s) => s !== 0,
	lt: (s) => s < 0,
	le: (s) => s <= 0,
	gt: (s) => s > 0,
	ge: (s) => s >= 0
}

const operatorOf = (type: Typed["type"], cmp: Comparison): string =>
	type === "numeric"
		? `numeric_${cmp}`
		: type === "float8"
			? `float8${cmp}`
			: cmp === "eq"
				? "texteq"
				: cmp === "ne"
					? "textne"
					: `text_${cmp}`

const scalarOf = (type: Typed["type"]): ScalarType =>
	type === "numeric" ? T.numeric : type === "float8" ? T.float8 : T.text

/** NaN stands in a tier above every float8 number, infinities included, and equals itself. */
const tierOf = (t: Typed): number =>
	t.literal.kind === "floatSpecial" && t.literal.value === "NaN" ? 1 : 0

const comparedSign = (a: Typed, b: Typed): number => {
	const tier = tierOf(a) - tierOf(b)
	return tier !== 0 ? Math.sign(tier) : tierOf(a) === 1 ? 0 : lexCompare(a.rank, b.rank)
}

const comparisons = element<Comparison>(["eq", "ne", "lt", "le", "gt", "ge"])

const literalPairs = oneOf(
	Arr.map(
		dictionary,
		(values): Gen<readonly [Typed, Typed]> =>
			(source) =>
				[source.draw(element(values)), source.draw(element(values))] as const
	)
)

/** What the folding suites reach: each decision, and each type compared. */
type FoldFeature =
	| `decided ${Decision}`
	| `compared ${Typed["type"]}`
	| "a vector membership left to PostgreSQL"

/** A filter over the postings whose predicate `pred` builds, simplified, and its decision. */
const decide = (pred: (q: Q, region: RelNode) => ScalarExpr, judged: Judged): Decision => {
	const q = new Q()
	const region = postings(q)
	const p = pred(q, region)
	const f = q.filter(region, p)
	return decisionOf(simplifiedJudged(q.build(f).dag, judged), region, f, p)
}

describe("literal folding", () => {
	it.effect(
		"compares literals under PostgreSQL's equality and order: numeric scale, NaN, -0, code points",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every comparison between every two literals of one type of the dictionary: numerics either side of an integer, float8's NaN, infinities and signed zeros, text ordered by code points and by prefixes",
						oracle: {
							kind: "second-implementation",
							name: "PostgreSQL's equality and order of each type, ranked independently of the compiler"
						},
						suite: "unit/lower/rewrite/simplify-literal-order",
						literal: Formatter.format,
						generator: (source) => [source.draw(literalPairs), source.draw(comparisons)] as const,
						limit: 462,
						coverage: requiredInSpace<FoldFeature>([
							"decided true",
							"decided false",
							"compared numeric",
							"compared float8",
							"compared text"
						]),
						caseHang
					},
					([[a, b], cmp], c) =>
						Effect.sync(() => {
							const expected: Decision = holds[cmp](comparedSign(a, b)) ? "true" : "false"
							c.note(`compared ${a.type}`)
							c.note(`decided ${expected}`)
							const type = scalarOf(a.type)
							assert.equal(
								decide(
									(q) =>
										q.op(
											operatorOf(a.type, cmp),
											[q.lit(a.literal, type), q.lit(b.literal, type)],
											T.bool
										),
									"by the reference"
								),
								expected
							)
						})
				)
			)
	)

	it.effect(
		"decides BETWEEN and IN over literals, and leaves IN over vectors, which the host never orders, to PostgreSQL",
		(ctx) => {
			type Form =
				| { readonly kind: "between"; readonly x: number; readonly lo: number; readonly hi: number }
				| { readonly kind: "in"; readonly x: number; readonly among: ReadonlyArray<number> }
				| { readonly kind: "vectors"; readonly same: boolean }
			const values = int(0, 2)
			const forms = oneOf<Form>([
				map(
					(source) => [source.draw(values), source.draw(values), source.draw(values)] as const,
					([x, lo, hi]): Form => ({ kind: "between", x, lo, hi })
				),
				map(
					(source) =>
						[source.draw(values), source.draw(array(values, { min: 1, max: 2 }))] as const,
					([x, among]): Form => ({ kind: "in", x, among })
				),
				map(boolean, (same): Form => ({ kind: "vectors", same }))
			])
			return searched(
				ctx,
				exhaust(
					{
						box: "BETWEEN over three of 0..2, IN of one of 0..2 among one or two, and IN over a vector equal to the list's or not",
						oracle: {
							kind: "specification",
							name: "BETWEEN and IN decided by their bounds and members; IN over vectors left to PostgreSQL"
						},
						suite: "unit/lower/rewrite/simplify-between-in",
						literal: Formatter.format,
						generator: forms,
						limit: 65,
						coverage: requiredInSpace<FoldFeature>([
							"decided true",
							"decided false",
							"a vector membership left to PostgreSQL"
						]),
						caseHang
					},
					(form, c) =>
						Effect.sync(() => {
							const expected: Decision =
								form.kind === "between"
									? form.lo <= form.x && form.x <= form.hi
										? "true"
										: "false"
									: form.kind === "in"
										? form.among.includes(form.x)
											? "true"
											: "false"
										: "undecided"
							c.note(
								form.kind === "vectors"
									? "a vector membership left to PostgreSQL"
									: `decided ${expected}`
							)
							const decision = decide(
								(q) => {
									if (form.kind === "between") {
										return q.op(
											"between:bigint",
											Arr.map([form.x, form.lo, form.hi], (n) => q.int(n, T.int8)),
											T.bool
										)
									}
									if (form.kind === "in") {
										return q.op(
											"in:bigint",
											Arr.map([form.x, ...form.among], (n) => q.int(n, T.int8)),
											T.bool
										)
									}
									const vector = (...xs: ReadonlyArray<number>) =>
										q.lit(
											{ kind: "vector", value: succeeded(VectorText.of(Float32Array.from(xs))) },
											T.vector3
										)
									return q.op(
										"in:vector",
										[vector(1, 2, 3), form.same ? vector(1, 2, 3) : vector(3, 2, 1)],
										T.bool
									)
								},
								form.kind === "vectors" ? "outside the reference" : "by the reference"
							)
							assert.equal(decision, expected)
						})
				)
			)
		}
	)

	it.effect(
		"never evaluates arithmetic on the host, and keeps an evaluation that could raise",
		(ctx) => {
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
			const shapes = oneOf<Shape>([
				map(
					(source) =>
						[
							source.draw(
								element<"int8pl" | "int8mi" | "int8mul">(["int8pl", "int8mi", "int8mul"])
							),
							source.draw(int(0, 2))
						] as const,
					([op, against]): Shape => ({ kind: "arithmetic", op, against })
				),
				map(
					(source) =>
						[source.draw(element<"and" | "or">(["and", "or"])), source.draw(boolean)] as const,
					([connective, literalFirst]): Shape => ({ kind: "connective", connective, literalFirst })
				)
			])
			return searched(
				ctx,
				exhaust(
					{
						box: "each arithmetic operator over literals compared with 0..2, and each connective with a deciding literal on either side of a column predicate",
						oracle: {
							kind: "specification",
							name: "no computed number folded; a connective's deciding literal decides it"
						},
						suite: "unit/lower/rewrite/simplify-frontier-folding",
						literal: Formatter.format,
						generator: shapes,
						limit: 17,
						coverage: requiredInSpace<FoldFeature>([
							"decided true",
							"decided false",
							"decided undecided"
						]),
						caseHang
					},
					(shape, c) =>
						Effect.sync(() => {
							/**
							 * The documented fragment: no computed number is ever folded; a connective's deciding literal drops the
							 * other operand.
							 */
							const expected: Decision =
								shape.kind === "arithmetic"
									? "undecided"
									: shape.connective === "and"
										? "false"
										: "true"
							c.note(`decided ${expected}`)
							const decision = decide((q, region) => {
								if (shape.kind === "arithmetic") {
									return q.op(
										"int8eq",
										[
											q.op(shape.op, [q.int(1, T.int8), q.int(1, T.int8)], T.int8),
											q.int(shape.against, T.int8)
										],
										T.bool
									)
								}
								const literal = q.lit({ kind: "bool", value: shape.connective === "or" }, T.bool)
								const other = predicate(q, region)
								return q.op(
									shape.connective,
									shape.literalFirst ? [literal, other] : [other, literal],
									T.bool
								)
							}, "by the reference")
							assert.equal(decision, expected)
						})
				)
			)
		}
	)
})

describe("finite folding", () => {
	it.effect("a filter over declared facts is the satisfying facts", (ctx) => {
		const roster = ["Automatic", "Manual"] as const
		type Handle = (typeof roster)[number]
		return searched(
			ctx,
			exhaust(
				{
					box: "every non-empty set of the roster's facts under equality and inequality with each handle",
					oracle: {
						kind: "specification",
						name: "the filter's satisfying facts, decided fact by fact"
					},
					suite: "unit/lower/rewrite/simplify-finite-fold",
					literal: Formatter.format,
					generator: (source) =>
						[
							source.draw(subset(roster, { min: 1, max: roster.length })),
							source.draw(element<"code:int2eq" | "code:int2ne">(["code:int2eq", "code:int2ne"])),
							source.draw(element<Handle>(roster))
						] as const,
					limit: 12,
					coverage: requiredInSpace<"some facts satisfy" | "no fact satisfies">([
						"some facts satisfy",
						"no fact satisfies"
					]),
					caseHang
				},
				([facts, op, against], c) =>
					Effect.sync(() => {
						const q = new Q()
						const kinds = q.closed(
							"Kind",
							[{ name: "id", type: T.kind }],
							Arr.map(facts, (h) => [{ kind: "handle", handle: h }])
						)
						const pred = q.op(
							op,
							[q.col(kinds, "id"), q.lit({ kind: "handle", handle: against }, T.kind)],
							T.bool
						)
						const ran = simplified(
							q.build(q.project(q.filter(kinds, pred), [["id", "id"]], conservativeMeta)).dag
						)
						const satisfying = Arr.filter(facts, (h) => (op === "code:int2eq") === (h === against))
						c.note(satisfying.length > 0 ? "some facts satisfy" : "no fact satisfies")
						assert.deepEqual(nodesOf(ran.query.dag, "Filter"), [])
						unorderedEqual(
							Arr.flatMap(nodesOf(ran.query.dag, "Closed"), (n) => n.rows),
							Arr.map(satisfying, (h): ReadonlyArray<TypedLiteral> => [
								{ kind: "handle", handle: h }
							])
						)
					})
			)
		)
	})
})

/** What branch removal removed: an empty region, an empty union arm, an anti-join's empty right side, or everything. */
type Removed =
	| "an empty region"
	| "an empty union arm"
	| "an empty anti-join right side"
	| "every input empty"

describe("branch removal", () => {
	it.effect("an empty input is removed, whatever evaluations it drops", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					box: "one to three arms, every subset of them empty, under an anti-join with an empty right side or not",
					oracle: {
						kind: "specification",
						name: "every empty input removed, the empty relation where nothing is left"
					},
					suite: "unit/lower/rewrite/simplify-empty",
					literal: Formatter.format,
					/**
					 * One to three arms, each a projection of the postings or of a region over the empty relation, one arm
					 * the root itself and more a union of them; `vacuous` holds a bit per empty arm, and `anti` subtracts an
					 * empty right side from them.
					 */
					generator: (source) => {
						const arms = source.draw(int(1, 3))
						return {
							arms,
							vacuous: source.draw(int(0, 2 ** arms - 1)),
							anti: source.draw(boolean)
						}
					},
					limit: 28,
					coverage: requiredInSpace<Removed>([
						"an empty region",
						"an empty union arm",
						"an empty anti-join right side",
						"every input empty"
					]),
					caseHang
				},
				({ arms, vacuous, anti }, c) =>
					Effect.sync(() => {
						const q = new Q()
						const empty = () => {
							const p = postings(q)
							return q.project(
								q.region([
									{
										source: q.filter(p, predicate(q, p)),
										bind: { id: "id", account: "account" },
										constants: {}
									},
									{
										source: q.closed("Nothing", [{ name: "account", type: T.uuid }], []),
										bind: { account: "account" },
										constants: {}
									}
								]),
								[["id", "id"]],
								conservativeMeta
							)
						}
						const isEmpty = (arm: number) => (vacuous & (1 << arm)) !== 0
						const built = nonEmptyList(
							upTo(arms, (arm) =>
								isEmpty(arm) ? empty() : q.project(postings(q), [["id", "id"]], conservativeMeta)
							),
							"the arms"
						)
						const [first] = built
						const left = arms === 1 ? first : q.union(built, [])
						const ran = simplified(q.build(anti ? q.anti(left, empty(), [["id", "id"]]) : left).dag)
						const dag = ran.query.dag
						const [root] = dag.roots
						const live = Arr.filter(
							upTo(arms, (arm) => arm),
							(arm) => !isEmpty(arm)
						).length
						assert.equal(
							rulesOf(ran.certificates).includes("simplify.empty"),
							vacuous !== 0 || anti
						)
						if (vacuous !== 0) {
							c.note(arms === 1 ? "an empty region" : "an empty union arm")
						}
						if (anti) {
							c.note("an empty anti-join right side")
						}
						if (live === 0) {
							c.note("every input empty")
							assert.ok(root.kind === "Closed" && root.rows.length === 0, "the empty relation")
							return
						}
						assert.deepEqual(
							Arr.filter(nodesOf(dag, "Closed"), (n) => n.rows.length === 0),
							[]
						)
						if (arms > 1) {
							assert.equal(
								Arr.flatMap(nodesOf(dag, "Union"), (n) => Arr.flatMap(n.groups, (g) => g.arms))
									.length,
								live
							)
						}
						if (anti) {
							assert.equal(nodesOf(dag, "AntiJoin").length, 0)
						}
					})
			)
		)
	)
})

describe("normalization", () => {
	it.effect(
		"gives the region the filter's evidence when every conjunct becomes an equality, so an order total by it stays so",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "an equality of the posting's account and the account's id, either way round, alone or beside another conjunct",
						oracle: {
							kind: "specification",
							name: "every var = var conjunct a region equality, the region carrying the filter's evidence where none is left"
						},
						suite: "unit/lower/rewrite/simplify-equality",
						literal: Formatter.format,
						generator: (source) => [source.draw(boolean), source.draw(boolean)] as const,
						limit: 4,
						coverage: requiredInSpace<"every conjunct an equality" | "a conjunct left">([
							"every conjunct an equality",
							"a conjunct left"
						]),
						caseHang
					},
					([swapped, extra], c) =>
						Effect.sync(() => {
							const q = new Q()
							const region = q.region([
								{
									source: q.base(Posting, conservativeMeta),
									bind: { id: "id", account: "account" },
									constants: {}
								},
								{ source: q.base(Account, conservativeMeta), bind: { id: "acct" }, constants: {} }
							])
							const sides = [q.col(region, "account"), q.col(region, "acct")]
							const equality = q.op("uuid_eq", swapped ? Arr.reverse(sides) : sides, T.bool)
							const other = q.op("uuid_ne", [q.col(region, "id"), q.lit(u(9), T.uuid)], T.bool)
							/** The filter's rows are keyed by id, each posting meeting its one account; the bare region's are not. */
							const f = q.b.node({
								kind: "Filter",
								input: region,
								pred: extra ? q.op("and", [equality, other], T.bool) : equality,
								heading: region.heading,
								meta: keyed(["id"], "many"),
								loc: undefined
							})
							const ran = simplified(
								q.build(q.take(f, asc("id"), { kind: "literal", k: 1n }, [], conservativeMeta)).dag
							)
							c.note(extra ? "a conjunct left" : "every conjunct an equality")
							assert.equal(rulesOf(ran.certificates).includes("simplify.equality"), true)
							assert.equal(nodesOf(ran.query.dag, "Filter").length, extra ? 1 : 0)
						})
				)
			)
	)
})
