import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Reached, Situations } from "@bjornpagen/testing/features"
import type { Budget, Case, Kill } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { rooted } from "#compiler/ir/dag.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { costChosen } from "#compiler/sql/emit.ts"
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
	oracleProperty,
	printOutcome,
	PropertyFailed,
	runOracle,
	type SentProgram
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"

/** Every feature a graph population notes: its generator's, its optimized programs', and rows. */
export type GraphFeature = RecursiveFeature | GraphOptimizedFeature | "nonempty"

/**
 * What the general population must reach: every graph shape, vertex type, recursion family
 * and consumer, the recursive CTE, an attachment seeded
 * from its parents' keys, an origin filter pushed into the seed, and rows.
 */
export const generalRequired: Situations<GraphFeature> = [
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
export const agreementOnly: CaseCheck = () => []

interface Population {
	/** The recursive population drawn: every consumer, or only the ones a population plants. */
	readonly limits: RecursiveLimits
	readonly situations: ReadonlyArray<Reached<GraphFeature>>
	/** Its search budget: the old suite's runs and coverage cases, cited where it is stated. */
	readonly budget: Budget
	readonly kills: ReadonlyArray<Kill>
	readonly check: CaseCheck
}

export const agreeOn = (population: Population) =>
	oracleProperty(recursiveCaseGen(population.limits), {
		situations: population.situations,
		perturb: "all",
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering's raw text sets, no repeated row on the optimized side"
		},
		kept: [],
		kills: population.kills,
		budget: population.budget,
		show: Formatter.format,
		check: (notes: Case<GraphFeature>) => (c) =>
			Effect.gen(function* () {
				const seat = yield* OracleSeat
				const schema = yield* seat.schema("graph")
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
	})

/**
 * The optimized lowering of one root of a case's DAG: a fixed-length case carries its connected match through joins as
 * its first root and the same answer through a bounded recursive relation as its second.
 */
export const optimizedAt = (note: Note, which: 0 | 1): Lowering => ({
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
				binding: costChosen,
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

/** Every attachment statement of an attaching program is seeded from its parent keys (R37), and at least one is. */
export const everyAttachmentSeeded: CaseCheck = ({ program }) => {
	const seeded = seededStatements(program)
	const statements = Arr.filter(flight(program.roots), (s) => s.role.kind === "attachment").length
	return statements > 0 && seeded === statements
		? []
		: [
				`${seeded} of ${statements} attachment statements seeded, expected every one of at least one`
			]
}

/** The graph pass fires none of its rules on a program whose recursion is filtered at its end vertex or by inequality. */
export const noGraphRuleFired: CaseCheck = ({ noted }) => {
	const moved = Arr.filter(noted, isGraphRule)
	return moved.length === 0 ? [] : [`the graph pass fired ${Arr.join(moved, ", ")}`]
}
