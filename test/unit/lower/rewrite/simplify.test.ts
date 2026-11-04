import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	subarray
} from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
import { VectorText } from "#compiler/ir/carriers.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { simplifyPass } from "#compiler/lower/optimize/simplify/index.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
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

/**
 * Semantic simplification: the host decides only comparisons and truth values, never arithmetic; finite folding
 * decides a filter over declared facts; branch removal keeps every union's discriminant readable; and every rewrite
 * leaves the delivered result unchanged. No evaluation raises (scalar/compute/registry.ts Totality), so folding drops,
 * and merging moves, any evaluation.
 *
 * Each rule is held to its documented statement (lower/optimize/simplify/rules.ts, boolean.ts) as the oracle, over
 * every shape of a small space: the literals a comparison may meet, and the reference evaluator's delivery on every
 * database of a few posting and account facts.
 */

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
 * The dictionary: numeric scale (1.0, 1.00), float8's NaN, infinities and signed zeros, and text whose code points
 * order otherwise than their letters would suggest (é above z) and proper prefixes.
 */
const dictionary: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Typed>> = [
	[numericLit("-0.5"), numericLit("1.0"), numericLit("1.00"), numericLit("2")],
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
						caseHang: Duration.minutes(2)
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
						suite: "unit/lower/rewrite/simplify-between-in",
						literal: Formatter.format,
						generator: forms,
						limit: 65,
						coverage: requiredInSpace<FoldFeature>([
							"decided true",
							"decided false",
							"a vector membership left to PostgreSQL"
						]),
						caseHang: Duration.minutes(2)
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
						suite: "unit/lower/rewrite/simplify-frontier-folding",
						literal: Formatter.format,
						generator: shapes,
						limit: 17,
						coverage: requiredInSpace<FoldFeature>([
							"decided true",
							"decided false",
							"decided undecided"
						]),
						caseHang: Duration.minutes(2)
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
					suite: "unit/lower/rewrite/simplify-finite-fold",
					literal: Formatter.format,
					generator: (source) =>
						[
							source.draw(filter(subarray(roster), (facts) => facts.length > 0, 1)),
							source.draw(element<"enum_eq" | "enum_ne">(["enum_eq", "enum_ne"])),
							source.draw(element<Handle>(roster))
						] as const,
					limit: 12,
					coverage: requiredInSpace<"some facts satisfy" | "no fact satisfies">([
						"some facts satisfy",
						"no fact satisfies"
					]),
					caseHang: Duration.minutes(2)
				},
				([facts, op, against], c) =>
					Effect.sync(() => {
						const q = new Q()
						const kinds = q.closed(
							"Kind",
							[{ name: "id", type: T.kind }],
							Arr.map(facts, (h) => [{ kind: "enum", handle: h }])
						)
						const pred = q.op(
							op,
							[q.col(kinds, "id"), q.lit({ kind: "enum", handle: against }, T.kind)],
							T.bool
						)
						const ran = simplified(
							q.build(q.project(q.filter(kinds, pred), [["id", "id"]], conservativeMeta)).dag
						)
						const satisfying = Arr.filter(facts, (h) => (op === "enum_eq") === (h === against))
						c.note(satisfying.length > 0 ? "some facts satisfy" : "no fact satisfies")
						assert.deepEqual(nodesOf(ran.query.dag, "Filter"), [])
						assert.deepEqual(
							Arr.flatMap(nodesOf(ran.query.dag, "Closed"), (n) => n.rows),
							Arr.map(satisfying, (h): ReadonlyArray<TypedLiteral> => [{ kind: "enum", handle: h }])
						)
					})
			)
		)
	})
})

describe("branch removal", () => {
	it.effect("an empty input is removed, whatever evaluations it drops", (ctx) => {
		type Site = "region" | "union arm" | "anti-join right side"
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/lower/rewrite/simplify-empty",
					literal: Formatter.format,
					generator: element<Site>(["region", "union arm", "anti-join right side"]),
					limit: 3,
					coverage: requiredInSpace<`${Site} removed`>([
						"region removed",
						"union arm removed",
						"anti-join right side removed"
					]),
					caseHang: Duration.minutes(2)
				},
				(site, c) =>
					Effect.sync(() => {
						const q = new Q()
						const p = postings(q)
						const checked = q.filter(p, predicate(q, p))
						const vacuous = q.project(
							q.region([
								{ source: checked, bind: { id: "id", account: "account" }, constants: {} },
								{
									source: q.closed("Nothing", [{ name: "account", type: T.uuid }], []),
									bind: { account: "account" },
									constants: {}
								}
							]),
							[["id", "id"]],
							conservativeMeta
						)
						const live = () => q.project(postings(q), [["id", "id"]], conservativeMeta)
						const root =
							site === "region"
								? vacuous
								: site === "union arm"
									? q.union([live(), vacuous], [])
									: q.anti(live(), vacuous, [["id", "id"]])
						const ran = simplified(q.build(root).dag)
						c.note(`${site} removed`)
						assert.equal(rulesOf(ran.certificates).includes("simplify.empty"), true)
						const dag = ran.query.dag
						if (site === "union arm") {
							assert.equal(
								Arr.flatMap(nodesOf(dag, "Union"), (n) => Arr.flatMap(n.groups, (g) => g.arms))
									.length,
								1
							)
						}
						if (site === "anti-join right side") {
							assert.equal(nodesOf(dag, "AntiJoin").length, 0)
						}
						if (site === "region") {
							assert.equal(ran.query.dag.roots[0].kind, "Closed")
						}
					})
			)
		)
	})
})

describe("normalization", () => {
	it.effect(
		"gives the region the filter's evidence when every conjunct becomes an equality, so an order total by it stays so",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/simplify-equality",
						literal: Formatter.format,
						generator: (source) => [source.draw(boolean), source.draw(boolean)] as const,
						limit: 4,
						coverage: requiredInSpace<"every conjunct an equality" | "a conjunct left">([
							"every conjunct an equality",
							"a conjunct left"
						]),
						caseHang: Duration.minutes(2)
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

describe("merging", () => {
	it.effect("an outer filter is merged into the filter below it", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/lower/rewrite/simplify-merge-filters",
					literal: Formatter.format,
					generator: boolean,
					limit: 2,
					coverage: noCoverage,
					caseHang: Duration.minutes(2)
				},
				(projected) =>
					Effect.sync(() => {
						const q = new Q()
						const p = postings(q)
						const inner = q.filter(p, predicate(q, p))
						const outer = q.filter(inner, predicate(q, inner))
						const root = projected ? q.project(outer, [["id", "id"]], conservativeMeta) : outer
						const ran = simplified(q.build(root).dag)
						assert.equal(rulesOf(ran.certificates).includes("simplify.mergeFilters"), true)
						assert.equal(nodesOf(ran.query.dag, "Filter").length, 1)
					})
			)
		)
	)

	it.effect(
		"a projection of a projection is merged, whatever expressions the composition drops",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/rewrite/simplify-merge-projections",
						literal: Formatter.format,
						generator: (source) => [source.draw(boolean), source.draw(boolean)] as const,
						limit: 4,
						coverage: noCoverage,
						caseHang: Duration.minutes(2)
					},
					([computed, outerReads]) =>
						Effect.sync(() => {
							const q = new Q()
							const p = postings(q)
							const expr = computed
								? q.op("int8pl", [q.col(p, "amount"), q.int(1, T.int8)], T.int8)
								: q.col(p, "amount")
							const inner = q.project(
								p,
								[
									["id", "id"],
									["bumped", [expr, T.int8]]
								],
								conservativeMeta
							)
							const outer = q.project(
								inner,
								outerReads
									? [
											["b", "bumped"],
											["id", "id"]
										]
									: [["id", "id"]],
								conservativeMeta
							)
							const ran = simplified(q.build(outer).dag)
							assert.equal(rulesOf(ran.certificates).includes("simplify.mergeProjections"), true)
							assert.equal(nodesOf(ran.query.dag, "ProjectSet").length, 1)
						})
				)
			)
	)
})
