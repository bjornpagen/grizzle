import { map } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect } from "effect"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { partRecursive } from "#test/support/compile.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import {
	defaultRecursiveLimits,
	type GraphLimits,
	type RecursiveCase,
	type RecursiveFeature,
	type RecursiveLimits,
	recursiveCaseGen,
	vertexKinds
} from "#test/support/oracle/gen/recursive.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { defaultRunOptions, type Lowering, runOracle } from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import {
	feedbackUnionAll,
	lowerCase,
	withEncodedParams
} from "#test/support/pg/recursion/lowering/support.ts"

/**
 * The diamond 0 -> {1, 2} -> 3 over integer vertices 0, 1, -1, 2 (the first value classes), its edges a pure set,
 * contained in V, rooted at the top by a literal.
 */
const diamondLimits = (
	overrides: Partial<Omit<RecursiveLimits, "graph">> & { readonly graph: Partial<GraphLimits> }
): RecursiveLimits => {
	const { graph, ...rest } = overrides
	return {
		...defaultRecursiveLimits,
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
			...graph
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
		...rest
	}
}

export class NotKilled extends Data.TaggedError("NotKilled")<{ readonly message: string }> {}

export const run = (c: RecursiveCase, left: Lowering, right: Lowering) =>
	Effect.gen(function* () {
		const seat = yield* OracleSeat
		const schema = yield* seat.schema("mutant")
		return yield* runOracle(c, left, right, {
			...defaultRunOptions,
			schema: { kind: "named", name: schema }
		})
	})

/**
 * Physical names for counting a case's sites without an installation. A generated text vertex carries a regex
 * refinement, and the optimized delivery casts an unproved refined output (a relation parameter's root, a base-typed
 * recursive state column) to its structural text domain (lower/shapes/refined), so the names must name one, as an
 * installation's names do: a stand-in domain per pattern (naming.ts standInNames). A closed-id vertex's literal is its
 * handle's code under the case's own codes, a roster's history with holes (gen/recursive.ts vertexRoster), which an
 * installation of the case holds too.
 */
const siteNames = (c: RecursiveCase): PhysicalNames => standInNames("Graph", schemaCodes(c.schema))

/**
 * How many feedback unions the mutant rewrites in a case's optimized program, and whether a statement of the query
 * itself holds a WITH RECURSIVE at any depth of its AST (the lowering nests one inside a derived table under any
 * consumer node).
 */
export const sites = (c: RecursiveCase) => {
	const program = lowerCase(c, siteNames(c))
	if (!program.ok) {
		throw new Error(program.error.message)
	}
	const mutated = feedbackUnionAll(program.value)
	if (!mutated.ok) {
		throw new Error(mutated.error.message)
	}
	return {
		sites: mutated.value.sites,
		recursive: Arr.some(
			flight(program.value.roots),
			(part) => part.role.kind !== "attachment" && partRecursive(program.value, part.answer)
		)
	}
}

/** What the population notes: its generator's features and each kill. */
export type DiamondFeature = RecursiveFeature | "killed"

/** The population must reach every vertex type and parallel edges, and kill the mutant. */
export const diamondSituations = [
	...Arr.map(vertexKinds, (k): RecursiveFeature => `vertex:${k}`),
	"parallel edges",
	"killed"
] as const satisfies ReadonlyArray<DiamondFeature>

/** The population: generated diamonds rooted at their top, every vertex type, edge model, seed and state, parameters encoded. */
export const diamondCases = map(
	recursiveCaseGen(
		diamondLimits({
			graph: {
				shapes: ["diamond"],
				kinds: vertexKinds,
				edges: "any",
				contained: true,
				second: false,
				blocked: false,
				loops: false,
				minVertices: 4
			},
			forms: ["reach", "walks", "pairs"],
			roots: ["literal", "input", "all", "arms"],
			origin: "any",
			exists: "any",
			oneOrMore: "any",
			minBound: 2,
			maxBound: 4
		})
	),
	withEncodedParams
)
