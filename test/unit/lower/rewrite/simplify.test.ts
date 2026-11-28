/**
 * Semantic simplification (lower/optimize/simplify): the host decides only comparisons and truth values, never
 * arithmetic; finite folding decides a filter over declared facts; branch removal keeps every union's discriminant
 * readable; equality propagation hands the region the filter's evidence; and every rewrite leaves the delivered result
 * unchanged and the DAG one the strict re-reader admits. No evaluation raises (scalar/compute/registry.ts Totality), so
 * folding drops, and merging moves, any evaluation.
 *
 * - Literal folding compares literals under PostgreSQL's equality and order: numeric by value whatever its scale,
 *   float8's NaN above every number and equal to itself, -0 equal to 0, text by code points.
 * - BETWEEN and IN over literals are decided, IN over vectors by pgvector's equality, the host's vector_cmp order.
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
 * Features: each decision and each type compared; a vector membership decided; facts satisfying and none;
 * each kind of branch removed; every conjunct an equality, and a conjunct left.
 */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite, int, subset } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { VectorText } from "#compiler/ir/carriers.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { succeeded } from "#test/support/assert.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import {
	Account,
	asc,
	keyed,
	Posting,
	Q,
	T
} from "#test/support/unit/lower/conservative/fixtures.ts"
import { nodesOf, rulesOf } from "#test/support/unit/lower/rewrite/support.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	comparedSign,
	comparisons,
	decide,
	type Decision,
	type FoldFeature,
	forms,
	type Handle,
	holds,
	literalPairs,
	operatorOf,
	postings,
	predicate,
	type Removed,
	roster,
	scalarOf,
	shapes,
	simplified,
	u
} from "#test/unit/lower/rewrite/simplify.fixtures.ts"

/** Literal folding compares literals under PostgreSQL's equality and order: numeric scale, NaN, -0, code points. */
export const literalFoldingComparesLiteralsUnderPostgreSQLsEqualityAndOrderNumericScaleNaN0CodePoints =
	property.exhaust(
		finite((source) => [source.draw(literalPairs), source.draw(comparisons)] as const),
		{
			needs: {},
			situations: [
				"decided true",
				"decided false",
				"compared numeric",
				"compared float8",
				"compared text"
			] satisfies ReadonlyArray<Reached<FoldFeature>>,
			check:
				(_, c: Case<FoldFeature>) =>
				([[a, b], cmp]) =>
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
					}),
			oracle: {
				kind: "second-implementation",
				name: "PostgreSQL's equality and order of each type, ranked independently of the compiler"
			},
			box: "every comparison between every two literals of one type of the dictionary: numerics either side of an integer, float8's NaN, infinities and signed zeros, text ordered by code points and by prefixes",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/identity.ts",
					original: "\tfloat8: (x, y) => compareFloat(x, y),",
					replacement:
						"\tfloat8: (x, y) => (Number.isNaN(x) || Number.isNaN(y) ? 0 : compareFloat(x, y)),",
					why: "The host's double precision order takes NaN as equal to every number (scalar/values/identity.ts compareValues, which folding reads through compute/evaluate.ts comparisonHolds); the simplify-literal-order search fails."
				}
			]
		}
	)

/** Literal folding decides BETWEEN and IN over literals, IN over vectors among them by pgvector's equality. */
export const literalFoldingDecidesBETWEENAndINOverLiteralsINOverVectorsAmongThemByPgvectorsEquality =
	property.exhaust(finite(forms), {
		needs: {},
		situations: [
			"decided true",
			"decided false",
			"a vector membership decided"
		] satisfies ReadonlyArray<Reached<FoldFeature>>,
		check: (_, c: Case<FoldFeature>) => (form) =>
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
							: form.same
								? "true"
								: "false"
				c.note(form.kind === "vectors" ? "a vector membership decided" : `decided ${expected}`)
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
			}),
		oracle: {
			kind: "specification",
			name: "BETWEEN and IN decided by their bounds and members, a vector's by its components"
		},
		box: "BETWEEN over three of 0..2, IN of one of 0..2 among one or two, and IN over a vector equal to the list's or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					"\t\t\t\treturn compare(a, second(values)) >= 0 && compare(a, third(values)) <= 0",
				replacement:
					"\t\t\t\treturn compare(a, second(values)) > 0 && compare(a, third(values)) < 0",
				why: "BETWEEN decided strict on both bounds (compute/evaluate.ts comparisonHolds, which folding reads over literals); the simplify-between-in search fails."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tvector: (x, y) => Vector.compare(x, y),",
				replacement: "\tvector: () => 0,",
				why: "The host takes every two vectors as equal, so IN over a vector the list does not hold is decided true; the simplify-between-in search fails."
			}
		]
	})

/** Literal folding never evaluates arithmetic on the host, and keeps an evaluation that could raise. */
export const literalFoldingNeverEvaluatesArithmeticOnTheHostAndKeepsAnEvaluationThatCouldRaise =
	property.exhaust(finite(shapes), {
		needs: {},
		situations: ["decided true", "decided false", "decided undecided"] satisfies ReadonlyArray<
			Reached<FoldFeature>
		>,
		check: (_, c: Case<FoldFeature>) => (shape) =>
			Effect.sync(() => {
				/**
				 * The documented fragment: no computed number is ever folded; a connective's deciding literal drops the
				 * other operand.
				 */
				const expected: Decision =
					shape.kind === "arithmetic" ? "undecided" : shape.connective === "and" ? "false" : "true"
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
			}),
		oracle: {
			kind: "specification",
			name: "no computed number folded; a connective's deciding literal decides it"
		},
		box: "each arithmetic operator over literals compared with 0..2, and each connective with a deciding literal on either side of a column predicate",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/simplify/boolean.ts",
				original: '\t\t\t\treturn { kind: "value", value: decider }',
				replacement: '\t\t\t\treturn { kind: "value", value: !decider }',
				why: "A connective its deciding operand decides folds to the opposite value; the simplify-frontier-folding search fails."
			}
		]
	})

/** Finite folding a filter over declared facts is the satisfying facts. */
export const finiteFoldingAFilterOverDeclaredFactsIsTheSatisfyingFacts = property.exhaust(
	finite(
		(source) =>
			[
				source.draw(subset(roster, { min: 1, max: roster.length })),
				source.draw(element<"code:int2eq" | "code:int2ne">(["code:int2eq", "code:int2ne"])),
				source.draw(element<Handle>(roster))
			] as const
	),
	{
		needs: {},
		situations: ["some facts satisfy", "no fact satisfies"] satisfies ReadonlyArray<
			Reached<"some facts satisfy" | "no fact satisfies">
		>,
		check:
			(_, c: Case<"some facts satisfy" | "no fact satisfies">) =>
			([facts, op, against]) =>
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
						Arr.map(satisfying, (h): ReadonlyArray<TypedLiteral> => [{ kind: "handle", handle: h }])
					)
				}),
		oracle: {
			kind: "specification",
			name: "the filter's satisfying facts, decided fact by fact"
		},
		box: "every non-empty set of the roster's facts under equality and inequality with each handle",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/simplify/rules.ts",
				original: "\t\t\tif (folded.value) {",
				replacement: "\t\t\tif (!folded.value) {",
				why: "Finite folding keeps the facts the filter rejects in place of those it keeps; the simplify-finite-fold search fails."
			}
		]
	}
)

/** Branch removal an empty input is removed, whatever evaluations it drops. */
export const branchRemovalAnEmptyInputIsRemovedWhateverEvaluationsItDrops = property.exhaust(
	finite((source) => {
		const arms = source.draw(int(1, 3))
		return {
			arms,
			vacuous: source.draw(int(0, 2 ** arms - 1)),
			anti: source.draw(boolean)
		}
	}),
	{
		needs: {},
		situations: [
			"an empty region",
			"an empty union arm",
			"an empty anti-join right side",
			"every input empty"
		] satisfies ReadonlyArray<Reached<Removed>>,
		check:
			(_, c: Case<Removed>) =>
			({ arms, vacuous, anti }) =>
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
					assert.equal(rulesOf(ran.certificates).includes("simplify.empty"), vacuous !== 0 || anti)
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
				}),
		oracle: {
			kind: "specification",
			name: "every empty input removed, the empty relation where nothing is left"
		},
		box: "one to three arms, every subset of them empty, under an anti-join with an empty right side or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/simplify/rules.ts",
				original: "\t\t\t\tconst live = g.arms.filter((a) => !gone(a))",
				replacement: "\t\t\t\tconst live = g.arms",
				why: "Branch removal keeps a union's empty arms; the simplify-empty search fails."
			}
		]
	}
)

/** Normalization gives the region the filter's evidence when every conjunct becomes an equality, so an order total by it stays so. */
export const normalizationGivesTheRegionTheFiltersEvidenceWhenEveryConjunctBecomesAnEqualitySoAnOrderTotalByItStaysSo =
	property.exhaust(
		finite((source) => [source.draw(boolean), source.draw(boolean)] as const),
		{
			needs: {},
			situations: ["every conjunct an equality", "a conjunct left"] satisfies ReadonlyArray<
				Reached<"every conjunct an equality" | "a conjunct left">
			>,
			check:
				(_, c: Case<"every conjunct an equality" | "a conjunct left">) =>
				([swapped, extra]) =>
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
					}),
			oracle: {
				kind: "specification",
				name: "every var = var conjunct a region equality, the region carrying the filter's evidence where none is left"
			},
			box: "an equality of the posting's account and the account's id, either way round, alone or beside another conjunct",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/simplify/rules.ts",
					original: "\t\ted.set(regionCell, { ...region, equalities, meta: filter.meta })",
					replacement: "\t\ted.set(regionCell, { ...region, equalities })",
					why: "Equality propagation leaves the region its own metadata, not the filter's evidence it takes over; the simplify-equality search fails."
				}
			]
		}
	)
