import type { Reached } from "@bjornpagen/testing/features"
import type { Gen } from "@bjornpagen/testing/gen"
import type { Budget, Case, Kill } from "@bjornpagen/testing/property"
import { Data, Effect, Formatter } from "effect"
import {
	type CaseLowering,
	forCase,
	type RecursionOracleFeature
} from "#test/pg/recursion/oracle/support.ts"
import {
	defaultRecursiveLimits,
	type EndChoice,
	type GraphLimits,
	type RecursiveCase,
	type RecursiveLimits,
	vertexKinds
} from "#test/support/oracle/gen/recursive.ts"
import {
	conservative,
	defaultRunOptions,
	type Lowering,
	type OracleOutcome,
	oracleProperty,
	printOutcome,
	runOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"

/**
 * The diamond 0 -> {1, 2} -> 3 over integer vertices 0, 1, -1, 2 (the first value classes), its edges a pure set,
 * contained in V, rooted at the top by a literal.
 */
export const diamondLimits = (
	overrides: Partial<Omit<RecursiveLimits, "graph">> & { readonly graph: Partial<GraphLimits> }
): RecursiveLimits => ({
	...defaultRecursiveLimits,
	...overrides,
	graph: {
		...defaultRecursiveLimits.graph,
		shapes: ["diamond"],
		kinds: ["int4"],
		edges: "set",
		contained: true,
		second: false,
		blocked: false,
		loops: false,
		minVertices: 4,
		...overrides.graph
	},
	forms: ["reach"],
	roots: ["literal"],
	directions: ["forward"],
	stepFilters: ["none"],
	blockings: ["none"],
	consumers: ["state"],
	exists: false,
	origin: false,
	viaSecond: false,
	oneOrMore: false,
	leftLinear: false,
	rootPick: { kind: "forced", vertex: 0 },
	...withoutGraph(overrides)
})

const withoutGraph = <A extends { readonly graph: unknown }>(a: A): Omit<A, "graph"> => {
	const { graph: omitted, ...rest } = a
	return rest
}

/** Result predicates over closures of vertex 0 along forward edges, no step predicate, negation or second relation. */
export const resultLimits = (
	consumer: "endFilter" | "endNe" | "originFilter",
	shapes: GraphLimits["shapes"],
	forms: RecursiveLimits["forms"],
	end: EndChoice
): RecursiveLimits => ({
	...defaultRecursiveLimits,
	graph: {
		...defaultRecursiveLimits.graph,
		shapes,
		kinds: vertexKinds,
		contained: true,
		second: false,
		blocked: false,
		loops: false,
		minVertices: 3
	},
	forms,
	roots: ["literal"],
	rootPick: { kind: "forced", vertex: 0 },
	directions: ["forward"],
	stepFilters: ["none"],
	blockings: ["none"],
	consumers: [consumer],
	oneOrMore: false,
	leftLinear: false,
	viaSecond: false,
	end
})

class NotKilled extends Data.TaggedError("NotKilled")<{ readonly message: string }> {}

const run = (c: RecursiveCase, left: Lowering, right: Lowering) =>
	Effect.gen(function* () {
		const seat = yield* OracleSeat
		const schema = yield* seat.schema("counterexample")
		return yield* runOracle(c, left, right, {
			...defaultRunOptions,
			schema: { kind: "named", name: schema }
		})
	})

/**
 * A kill population: every case the suite explores tells `mutant` apart from the conservative lowering in the given
 * shape, and is the kind of case the population is about (`about`: a message when it is not), each case's generator
 * features noted through its case, the population reaching what its `coverage` requires.
 */
export interface Kills {
	readonly situations: ReadonlyArray<Reached<RecursionOracleFeature>>
	/** Its search budget: the old suite's runs and coverage cases, cited where it is stated. */
	readonly budget: Budget
	readonly kills: ReadonlyArray<Kill>
	readonly mutant: CaseLowering<RecursiveCase>
	readonly shape: (o: OracleOutcome) => boolean
	/**
	 * The cases the population is about, and what a case outside them lacks: every case, for a population whose
	 * generator plants its precondition.
	 */
	readonly about: { readonly holds: (c: RecursiveCase) => boolean; readonly otherwise: string }
}

/** The `about` of a population whose every case is the kind it is about. */
export const everyCase: Kills["about"] = { holds: () => true, otherwise: "" }

export const killsEvery = (generator: Gen<RecursiveCase>, kills: Kills) =>
	oracleProperty(generator, {
		situations: kills.situations,
		perturb: "none",
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering's raw text sets, which each invalid rewrite must break as its population states"
		},
		kept: [],
		kills: kills.kills,
		budget: kills.budget,
		show: Formatter.format,
		check: (notes: Case<RecursionOracleFeature>) => (c) =>
			Effect.gen(function* () {
				notes.noteAll(c.features)
				if (!kills.about.holds(c)) {
					return yield* new NotKilled({
						message: `outside the population: ${kills.about.otherwise}`
					})
				}
				const outcome = yield* run(c, conservative, forCase(kills.mutant, c))
				if (!kills.shape(outcome)) {
					return yield* new NotKilled({
						message: `not killed as expected:\n${printOutcome(outcome)}`
					})
				}
			})
	})

export const parallelLimits = (parallel: "always" | "never") =>
	({
		...defaultRecursiveLimits,
		graph: {
			...defaultRecursiveLimits.graph,
			parallel,
			edges: "keyed",
			contained: true,
			second: false
		},
		forms: ["reach", "walks"],
		roots: ["all"],
		consumers: ["edgeCount"],
		oneOrMore: false,
		stepFilters: ["none"],
		blockings: ["none"]
	}) satisfies RecursiveLimits
