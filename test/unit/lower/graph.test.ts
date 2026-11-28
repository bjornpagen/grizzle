/**
 * Proved root pushdown (lower/optimize/graph/seed.ts) and the carried columns it rests on
 * (shapes/attach-recursive/carried.ts). The PostgreSQL agreement of every rewrite here is test/pg/recursion/graph.
 *
 * - A carried column is a state column the step delivers unchanged from the state it extends: over generated
 *   recursions, exactly the origin the generator's recursion keeps (a walk's or reach's origin column, a pair closure's
 *   fixed end), never the advanced endpoint or a computed counter; and every generated recursion is positive linear.
 * - A predicate moves into a recursion's seed exactly when it reads only a carried column and the recursion has no
 *   other reader: exhausted over the Network example (each recursion, column, spelling of the predicate and sharing),
 *   where a recursion also delivered as a root, read by another node, or imported twice, its two imports one node the
 *   consumer reads at both (check/checker.ts importedKey), never moves;
 *   the pass leaves a query it moves nothing in as it was, and is idempotent.
 * - Two conjuncts on a carried column alike but for one part, a literal, a parameter, an operator, a closed relation's
 *   field or a closed read's key, are two predicates: over a reach between closed ids, each is moved into the seed, the
 *   second whatever the first placed there, and one conjunct is moved once.
 * - Over generated origin filters of every vertex type, double precision included, the recursion's seed applies the
 *   filter after the pass, whether the pass placed it there or the seed applied it already, and the pass is
 *   idempotent; over generated recursions read by every other consumer, the pass fires no rule.
 *
 * Oracle: the generator's own model of the recursion it built (the origin it keeps, the consumer that reads it), and
 * the carried-column rule as a checker over the planted spaces (specifications). A pass's output is compared to its
 * input by canonical structure, never by object identity.
 *
 * Features: each recursion form, origin and linearity; each spelling moved or kept and each sharing kept; one conjunct
 * or two moved; an origin filter applied over any vertex type and over double precision; each other consumer.
 */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import { graphPass } from "#compiler/lower/optimize/graph/index.ts"
import { carriedColumns, positiveLinear } from "#compiler/lower/shapes/attach-recursive/carried.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { succeeded } from "#test/support/assert.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import {
	defaultRecursiveLimits,
	recursiveCaseGen,
	type RecursiveFeature,
	resolveRecursiveCase
} from "#test/support/oracle/gen/recursive.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { nodeOfKind } from "#test/support/unit/lower/support.ts"
import {
	alikeQuery,
	caseContext,
	type Column,
	type Conjuncts,
	context,
	generatedQuery,
	type GraphFeature,
	graphRules,
	Kinds,
	kindsCatalog,
	logical,
	optimizedOf,
	originFilterLimits,
	originFilterSketches,
	otherConsumerLimits,
	otherConsumerSketches,
	type Part,
	type PushFeature,
	pushQuery,
	seedApplications,
	seedPushdowns,
	shared,
	type Sharing,
	type Spelling
} from "#test/unit/lower/graph.fixtures.ts"

/**
 * Carried state columns (shapes/attach-recursive/carried.ts) on generated recursions, carries exactly the origin the
 * recursion keeps, and every one is positive linear.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/lower/graph.test.ts:118 at 8cad5bce, its runs and its coverage's cases).
 */
export const carriedStateColumnsShapesAttachRecursiveCarriedTsOnGeneratedRecursionsCarriesExactlyTheOriginTheRecursionKeepsAndEveryOneIsPositiveLinear =
	property.explore(recursiveCaseGen({ ...defaultRecursiveLimits, consumers: ["state"] }), {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			"form:reach",
			"form:walks",
			"form:pairs",
			"origin",
			"left-linear",
			"right-linear"
		] satisfies ReadonlyArray<Reached<RecursiveFeature>>,
		check: (_, note: Case<RecursiveFeature>) => (c) =>
			Effect.sync(() => {
				const q = { dag: validateDag(c.query.dag), params: genParamDecls(c.query) }
				/** The state consumer delivers the case's recursion itself; a stratum it negates is another recursion. */
				const recursion = nodeOfKind(q.dag.roots[0], "Recursive")
				/** The end a pair closure's step keeps, or the origin a walk or a reach carries from its seed. */
				const parts = c.parts
				const kept =
					parts.form === "pairs"
						? [parts.leftLinear ? "dst" : "src"]
						: parts.origin
							? ["origin"]
							: []
				unorderedEqual([...carriedColumns(recursion)], kept, c.label)
				assert.equal(positiveLinear(recursion), true, c.label)
				note.noteAll(c.features)
			}),
		oracle: {
			kind: "specification",
			name: "the origin the generator's recursion keeps, and positive linear feedback"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/attach-recursive/carried.ts",
				original:
					"\tnew Set(\n\t\trec.heading.filter((c) => carriedFrom(rec.step, c.name, rec.self, c.name)).map((c) => c.name)\n\t)",
				replacement: "\tnew Set(rec.heading.map((c) => c.name))",
				why: "carriedColumns (carried.ts) takes every state column as carried; the carried-column search fails, and the Network pushdown and origin-filter searches with it."
			}
		]
	})

/** Proved root pushdown (graph.seedPushdown) moves a predicate on a carried column of a recursion its consumer alone reads, and nothing else. */
export const provedRootPushdownGraphSeedPushdownMovesAPredicateOnACarriedColumnOfARecursionItsConsumerAloneReadsAndNothingElse =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(
						element<Column>(["Reach.origin", "Reach.person", "Walks.person", "Walks.hops"])
					),
					source.draw(element<Spelling>(["where", "constant"])),
					source.draw(
						element<Sharing>([
							"sole reader",
							"also a root",
							"read by another node",
							"imported twice"
						])
					)
				] as const
		),
		{
			needs: {},
			situations: [
				"moved where",
				"moved constant",
				"kept where",
				"kept constant",
				"also a root kept",
				"read by another node kept",
				"imported twice kept"
			] satisfies ReadonlyArray<Reached<PushFeature>>,
			check:
				(_, c: Case<PushFeature>) =>
				([column, spelling, sharing]) =>
					Effect.sync(() => {
						const checked = logical(pushQuery(column, spelling, sharing === "imported twice"))
						const q = shared(checked, sharing)
						/**
						 * Only a recursion the consumer alone reads, filtered on its carried origin, moves. Two imports of
						 * one closed query are one node (check/checker.ts importedKey), which the consumer reads twice.
						 */
						const moves = column === "Reach.origin" && sharing === "sole reader" ? 1 : 0
						const ctx = context()
						const once = succeeded(graphPass.run(q, ctx))
						const rules = Arr.map(ctx.certificates.all(), (x) => x.rule)
						assert.equal(seedPushdowns(rules), moves)
						assert.equal(
							canonicalEquals(once, q),
							moves === 0,
							"the query is as it was exactly where nothing moves"
						)
						assert.ok(
							canonicalEquals(succeeded(graphPass.run(once, context())), once),
							"idempotent"
						)
						c.note(`${moves === 1 ? "moved" : "kept"} ${spelling}`)
						if (moves === 0 && column === "Reach.origin") {
							c.note(`${sharing} kept`)
						}
					}),
			oracle: {
				kind: "specification",
				name: "a predicate on a carried column of a recursion its consumer alone reads moves, and nothing else"
			},
			box: "each of four columns of Reach and Walks, each spelling of the predicate, each sharing of the recursion",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/attach-recursive/carried.ts",
					original:
						"\tnew Set(\n\t\trec.heading.filter((c) => carriedFrom(rec.step, c.name, rec.self, c.name)).map((c) => c.name)\n\t)",
					replacement: "\tnew Set(rec.heading.map((c) => c.name))",
					why: "carriedColumns (carried.ts) takes every state column as carried; the carried-column search fails, and the Network pushdown and origin-filter searches with it."
				},
				{
					file: "packages/engine/src/lower/optimize/graph/seed.ts",
					original: "\treturn readers.length === 1 && readers[0] === reader",
					replacement: "\treturn readers.includes(reader)",
					why: "seed.ts's readOnlyBy admits a recursion another node also reads, so it is restricted at its seed; the Network pushdown search fails."
				},
				{
					file: "packages/engine/src/lower/optimize/graph/seed.ts",
					original:
						"\tconst carried = carriedColumns(finished)\n\treturn new Set(node.heading.filter((c) => carried.has(c.name)).map((c) => c.name))",
					replacement: "\treturn new Set(node.heading.map((c) => c.name))",
					why: "seed.ts's restrictable takes every state column of a recursion, the advanced endpoint included, while carriedColumns stays right; the Network pushdown and origin-filter searches fail."
				}
			]
		}
	)

/** Proved root pushdown (graph.seedPushdown) moves each of two conjuncts alike but for one part into the seed, and one conjunct once. */
export const provedRootPushdownGraphSeedPushdownMovesEachOfTwoConjunctsAlikeButForOnePartIntoTheSeedAndOneConjunctOnce =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(
						element<Part>(["literal", "parameter", "operator", "field", "completions", "presence"])
					),
					source.draw(element<Conjuncts>(["one", "two"]))
				] as const
		),
		{
			needs: {},
			situations: ["one moved", "two moved"] satisfies ReadonlyArray<Reached<`${Conjuncts} moved`>>,
			check:
				(_, c: Case<`${Conjuncts} moved`>) =>
				([part, conjuncts]) =>
					Effect.sync(() => {
						const desc = queryValueDesc(alikeQuery(part, conjuncts))
						if (desc === undefined) {
							throw new Error("not a query value")
						}
						const q = succeeded(checkQuery(checking(Kinds), desc, checkOptions("query")))
						const passContext = () =>
							makePassContext({ evidenceContext: "snapshot", catalog: kindsCatalog })
						const run = passContext()
						const once = succeeded(graphPass.run(q, run))
						assert.equal(
							seedPushdowns(Arr.map(run.certificates.all(), (x) => x.rule)),
							conjuncts === "one" ? 1 : 2,
							`${part}: every conjunct on the carried origin moves`
						)
						assert.ok(
							canonicalEquals(succeeded(graphPass.run(once, passContext())), once),
							"idempotent"
						)
						c.note(`${conjuncts} moved`)
					}),
			oracle: {
				kind: "specification",
				name: "every conjunct on the carried origin moves, once"
			},
			box: "each part two conjuncts on the carried origin differ in, one conjunct or both",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/graph/seed.ts",
					original: '\t\t\treturn y.kind === "literal" && canonicalEquals(x.value, y.value)',
					replacement: '\t\t\treturn y.kind === "literal"',
					why: "seed.ts's sameAtSeed takes two literals for alike whatever their values, so the second conjunct is taken as already in the seed; the alike-conjuncts search fails."
				}
			]
		}
	)

/**
 * Proved root pushdown (graph.seedPushdown) on generated cases, applies an origin filter of every vertex type in the
 * seed.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/lower/graph.test.ts:661 at 8cad5bce, its runs and its coverage's cases).
 */
export const provedRootPushdownGraphSeedPushdownOnGeneratedCasesAppliesAnOriginFilterOfEveryVertexTypeInTheSeed =
	property.explore(originFilterSketches, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			"the seed applies an origin filter",
			"the seed applies an origin filter over double precision"
		] satisfies ReadonlyArray<Reached<GraphFeature>>,
		check: (_, c: Case<GraphFeature>) => (sketch) =>
			Effect.sync(() => {
				const q = resolveRecursiveCase(sketch, originFilterLimits, "unmutated")
				const once = succeeded(graphPass.run(generatedQuery(q), caseContext(q)))
				assert.deepEqual(
					Arr.dedupe(seedApplications(once)),
					["applied"],
					`${q.label}: the seed applies the origin filter`
				)
				assert.ok(
					canonicalEquals(succeeded(graphPass.run(once, caseContext(q))), once),
					`${q.label}: idempotent`
				)
				c.note(
					q.graph.kind === "float8"
						? "the seed applies an origin filter over double precision"
						: "the seed applies an origin filter"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the seed applies every conjunct of an origin filter that reads the recursion alone"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/lower/graph.test.ts#provedRootPushdownGraphSeedPushdownOnGeneratedCasesAppliesAnOriginFilterOfEveryVertexTypeInTheSeed:-:1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason: "an origin filter over float8",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/lower/graph.test.ts#provedRootPushdownGraphSeedPushdownOnGeneratedCasesAppliesAnOriginFilterOfEveryVertexTypeInTheSeed:-:0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason: "a pair closure from a literal root its origin filter names again",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/graph/seed.ts",
				original:
					"\treturn new Set(node.heading.filter((c) => carried.has(c.name)).map((c) => c.name))",
				replacement:
					'\treturn new Set(\n\t\tnode.heading\n\t\t\t.filter((c) => carried.has(c.name) && baseOf(c.type).carrier !== "float8")\n\t\t\t.map((c) => c.name)\n\t)',
				why: "seed.ts's restrictable leaves a double precision state column out of the restrictable set, so an origin filter over float8 vertices never moves; the origin-filter search fails."
			}
		]
	})

/**
 * Proved root pushdown (graph.seedPushdown) on generated cases, fires on nothing else.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/lower/graph.test.ts:661 at 8cad5bce, its runs and its coverage's cases).
 */
export const provedRootPushdownGraphSeedPushdownOnGeneratedCasesFiresOnNothingElse =
	property.explore(otherConsumerSketches, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			"consumer:endFilter",
			"consumer:endNe",
			["consumer:minLength", "form:walks"]
		] satisfies ReadonlyArray<Reached<RecursiveFeature>>,
		check: (_, c: Case<RecursiveFeature>) => (sketch) =>
			Effect.sync(() => {
				const q = resolveRecursiveCase(sketch, otherConsumerLimits, "unmutated")
				assert.deepEqual(graphRules(optimizedOf(q)), [], q.label)
				c.noteAll(q.features)
				c.pair(`consumer:${q.parts.consumer}`, `form:${q.parts.form}`)
			}),
		oracle: {
			kind: "specification",
			name: "no graph rule fires on a recursion read by any consumer but an origin filter"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/lower/graph.test.ts#provedRootPushdownGraphSeedPushdownOnGeneratedCasesFiresOnNothingElse:-:1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason: "walks under a minimum length",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/attach-recursive/carried.ts",
				original:
					"\tnew Set(\n\t\trec.heading.filter((c) => carriedFrom(rec.step, c.name, rec.self, c.name)).map((c) => c.name)\n\t)",
				replacement: "\tnew Set(rec.heading.map((c) => c.name))",
				why: "carriedColumns (carried.ts) takes every state column as carried; the carried-column search fails, and the Network pushdown and origin-filter searches with it."
			},
			{
				file: "packages/engine/src/lower/optimize/graph/seed.ts",
				original:
					"\tconst carried = carriedColumns(finished)\n\treturn new Set(node.heading.filter((c) => carried.has(c.name)).map((c) => c.name))",
				replacement: "\treturn new Set(node.heading.map((c) => c.name))",
				why: "seed.ts's restrictable takes every state column of a recursion, the advanced endpoint included, while carriedColumns stays right; the Network pushdown and origin-filter searches fail."
			}
		]
	})
