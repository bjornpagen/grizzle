import { layer } from "@effect/vitest"
import { drawn } from "@grizzle/testing/explore"
import { type Coverage, noCoverage, required, type Situations } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import * as Result from "#compiler/core/result.ts"
import { rooted } from "#compiler/ir/dag.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import {
	formsBroken,
	type GraphOptimizedFeature,
	hostNormalized,
	isGraphRule,
	type Note,
	optimizedFeatures,
	optimizedLoweringWith,
	seededStatements
} from "#test/pg/recursion/graph/support.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import {
	defaultGraphLimits,
	defaultRecursiveLimits,
	fixedLengthCaseGen,
	graphShapes,
	type RecursiveCase,
	type RecursiveFeature,
	type RecursiveLimits,
	recursiveCaseGen,
	vertexKinds
} from "#test/support/oracle/gen/recursive.ts"

import {
	comparisonFailed,
	conservative,
	defaultRunOptions,
	type Lowering,
	oracleCheck,
	printOutcome,
	PropertyFailed,
	runOracle,
	type SentProgram
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The optimized lowering with graph recognition against the conservative lowering on PostgreSQL 19.
 *
 * Seeded graph-shaped recursive queries (test/support/oracle/gen/recursive.ts: chains, trees, diamonds, self-loops,
 * dense cycles, random graphs, parallel edges, multiple roots carrying origin) are lowered by the full optimized
 * pipeline, graph pass and R37 seeding included, and by the conservative lowering, run on PostgreSQL, and compared
 * statement by statement as raw text sets, with no repeated row on the optimized side.
 *
 * - The general population covers every consumer and recursion family; every recursion, bounded or not, is the
 *   recursive CTE (its kernel feature registry).
 * - The attachment population is every recursion attached to its roots by origin: each is seeded once
 *   from the delivered parents' key recordset (R37), and the suite requires every attachment statement to be seeded:
 *   equal values have one canonical cell text, so every origin type stitches by key.
 * - The seed-filter population is three result predicates: a filter on the origin, which the graph
 *   pass pushes into the seed (graph.seedPushdown), and a filter on the end vertex and a final inequality, which it
 *   must not move. The suite requires the pushdown to have fired on origin filters and agreement everywhere. The
 *   generator filters the recursion directly, the filter site; the constant and region sites agree in
 *   seed-sites.test.ts.
 * - Fixed-length connected matches give the same set through joins and through a bounded recursive relation, both
 *   optimized (the conservative pair is test/pg/recursion/oracle/fixed-length.test.ts).
 * - In every population each case's optimized program shows a WITH RECURSIVE anywhere in a statement when its query
 *   reaches a recursion, and none when it reaches none (graph/support.ts formsBroken), and a case that breaks it
 *   fails.
 *
 * @cpu-bound
 *
 * Plants (main's test phase): recursion-optimized-feedback-union-all.patch, recursion-r37-attachment-unseeded.patch,
 * recursion-seed-pushdown-off.patch.
 */

const general = 1200
const attached = 400
const filtered = 400
const fixedLength = 250

/** Every feature a graph population notes: its generator's, its optimized programs', and rows. */
type GraphFeature = RecursiveFeature | GraphOptimizedFeature | "nonempty"

/**
 * What the general population must reach: every graph shape, vertex type, recursion family
 * and consumer, the recursive CTE, an attachment seeded
 * from its parents' keys, an origin filter pushed into the seed, and rows.
 */
const generalRequired: Situations<GraphFeature> = [
	...Arr.map(graphShapes, (s): RecursiveFeature => `shape:${s}`),
	...Arr.map(vertexKinds, (k): RecursiveFeature => `vertex:${k}`),
	"self-loop",
	"parallel edges",
	"cycle",
	"diamond",
	"multiple roots carrying origin",
	"form:reach",
	"form:walks",
	"form:pairs",
	"direction:both",
	"alternative relations",
	"negation:relation",
	"negation:stratum",
	"hops:int2",
	"hops:int4",
	"hops:int8",
	"consumer:state",
	"consumer:endpoints",
	"consumer:minLength",
	"consumer:count",
	"consumer:edgeCount",
	"consumer:join2",
	"consumer:stage2",
	"consumer:attach",
	"consumer:unreached",
	"consumer:endFilter",
	"consumer:originFilter",
	"recursive CTE",
	"seeded attachment",
	"graph.seedPushdown.filter",
	"nonempty"
]

/**
 * A per-case requirement beyond agreement: a message when the case breaks it, given its program and the features its
 * lowering noted.
 * A population's own check of each agreeing case: what it finds broken, nothing where the case holds.
 */
type CaseCheck = (agreed: {
	readonly c: RecursiveCase
	readonly program: SentProgram
	readonly noted: ReadonlyArray<GraphOptimizedFeature>
}) => ReadonlyArray<string>

/** The check of a population that states none beyond the agreement. */
const agreementOnly: CaseCheck = () => []

interface Population {
	/** The recursive population drawn: every consumer, or only the ones a population plants. */
	readonly limits: RecursiveLimits
	readonly runs: number
	readonly suite: string
	readonly coverage: Coverage<GraphFeature>
	readonly check: CaseCheck
}

const agreeOn = (population: Population) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label: "graph" })
		return yield* oracleCheck(
			drawn(recursiveCaseGen(population.limits)),
			{
				suite: population.suite,
				oracle: {
					kind: "second-implementation",
					name: "the conservative lowering's raw text sets, no repeated row on the optimized side"
				},
				literal: Formatter.format,
				coverage: population.coverage,
				kept: [],
				runs: population.runs,
				shrink: completeShrink,
				perturb: "all"
			},
			(c, notes) =>
				Effect.gen(function* () {
					notes.noteAll(c.features)
					const noted: Array<GraphOptimizedFeature> = []
					const left = optimizedLoweringWith((fs) => {
						notes.noteAll(fs)
						appendAll(noted, fs)
					}, "snapshot")
					const outcome = yield* runOracle(hostNormalized(c), left, conservative, {
						...defaultRunOptions,
						schema: { kind: "named", name: schema }
					})
					if (!outcome.comparison.equal) {
						return yield* comparisonFailed(outcome)
					}
					if (Arr.some(outcome.left.run.statements, (st) => st.rows.length > 0)) {
						notes.note("nonempty")
					}
					const program = outcome.left.program
					const unseen = formsBroken(c.query.dag.roots[0], program)
					if (unseen !== undefined) {
						return yield* new PropertyFailed({ report: `${unseen}\n${printOutcome(outcome)}` })
					}
					const broken = population.check({ c, program, noted })
					if (broken.length > 0) {
						return yield* new PropertyFailed({
							report: `${Arr.join(broken, "\n")}\n${printOutcome(outcome)}`
						})
					}
				})
		)
	})

/** The general population: every recursion, bounded or not, kept the recursive CTE. */
const generalPopulation: Population = {
	limits: defaultRecursiveLimits,
	runs: general,
	suite: "recursion/graph",
	coverage: required<GraphFeature>(generalRequired, { cases: general, sense: notesOnly }),
	check: agreementOnly
}

/**
 * The optimized lowering of one root of a case's DAG: a fixed-length case carries its connected match through joins as
 * its first root and the same answer through a bounded recursive relation as its second.
 */
const optimizedAt = (note: Note, which: 0 | 1): Lowering => ({
	name: which === 0 ? "optimized joins" : "optimized recursive CTE",
	lower: ({ case: c, names }) => {
		const root = c.query.dag.roots[which]
		if (root === undefined) {
			throw new Error("a fixed-length case carries two roots")
		}
		/** The query's root first, the other root after it. */
		const dag = rooted([root, ...Arr.filter(c.query.dag.roots, (r) => r !== root)])
		return Result.map(
			lowerAligned({ dag, params: genParamDecls(c.query) }, "query", {
				names,
				context: "snapshot",
				catalog: genCatalog(c.schema)
			}),
			(p) => {
				note(optimizedFeatures(p))
				return p
			}
		)
	}
})

layer(Substrate.layer)("graph recognition and R37 against the conservative lowering", (it) => {
	it.effect("agree on seeded recursive queries of every family and consumer", (ctx) =>
		searched(ctx, agreeOn(generalPopulation))
	)

	it.effect("seed every attached recursion from the parent keys and agree (R37)", (ctx) =>
		searched(
			ctx,
			agreeOn({
				limits: {
					...defaultRecursiveLimits,
					consumers: ["attach"]
				},
				runs: attached,
				suite: "recursion/graph-attach",
				coverage: required<GraphFeature>(["seeded attachment"], {
					cases: attached,
					sense: notesOnly
				}),
				check: ({ program }) => {
					const seeded = seededStatements(program)
					const statements = Arr.filter(
						flight(program.roots),
						(s) => s.role.kind === "attachment"
					).length
					return statements > 0 && seeded === statements
						? []
						: [
								`${seeded} of ${statements} attachment statements seeded, expected every one of at least one`
							]
				}
			})
		)
	)

	it.effect("push origin filters into the seed", (ctx) =>
		searched(
			ctx,
			agreeOn({
				limits: {
					...defaultRecursiveLimits,
					consumers: ["originFilter"]
				},
				runs: filtered / 2,
				suite: "recursion/graph-origin-filter",
				coverage: required<GraphFeature>(["graph.seedPushdown.filter"], {
					cases: filtered / 2,
					sense: notesOnly
				}),
				check: agreementOnly
			})
		)
	)

	it.effect("move no end-vertex filter or final inequality", (ctx) =>
		searched(
			ctx,
			agreeOn({
				limits: {
					...defaultRecursiveLimits,
					consumers: ["endFilter", "endNe"]
				},
				runs: filtered / 2,
				suite: "recursion/graph-endpoint-filter",
				coverage: noCoverage,
				check: ({ noted }) => {
					const moved = Arr.filter(noted, isGraphRule)
					return moved.length === 0 ? [] : [`the graph pass fired ${Arr.join(moved, ", ")}`]
				}
			})
		)
	)

	it.effect(
		"give fixed-length connected matches the same set through joins and recursive CTEs",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ create: false, label: "graphfixed" })
					return yield* oracleCheck(
						drawn(fixedLengthCaseGen(defaultGraphLimits)),
						{
							suite: "recursion/graph-fixed-length",
							oracle: {
								kind: "second-implementation",
								name: "the conservative lowering's raw text sets, no repeated row on the optimized side"
							},
							literal: Formatter.format,
							coverage: required<GraphFeature>(["recursive CTE"], {
								cases: fixedLength,
								sense: notesOnly
							}),
							kept: [],
							runs: fixedLength,
							shrink: completeShrink,
							perturb: "all"
						},
						(c, notes) =>
							Effect.gen(function* () {
								/** The features each root's lowering noted, the joins' and the recursive relation's. */
								const noting: Note = (fs) => {
									notes.noteAll(fs)
								}
								const both = yield* runOracle(c, optimizedAt(noting, 0), optimizedAt(noting, 1), {
									...defaultRunOptions,
									schema: { kind: "named", name: schema }
								})
								const cmp = both.comparison
								if (!cmp.equal) {
									return yield* comparisonFailed(both)
								}
								if (both.right.kind === "reference") {
									return yield* new PropertyFailed({
										report: `no optimized program of root 1\n${printOutcome(both)}`
									})
								}
								/**
								 * Each root shows the form of what it reaches: the joins no recursion, the recursive relation
								 * its one.
								 */
								const sides = [
									[0, both.left.program],
									[1, both.right.program]
								] as const
								for (const [which, program] of sides) {
									const root = c.query.dag.roots[which]
									if (root === undefined) {
										return yield* new PropertyFailed({
											report: `no optimized program of root ${which}\n${printOutcome(both)}`
										})
									}
									const unseen = formsBroken(root, program)
									if (unseen !== undefined) {
										return yield* new PropertyFailed({
											report: `root ${which}: ${unseen}\n${printOutcome(both)}`
										})
									}
								}
							})
					)
				})
			)
	)
})
