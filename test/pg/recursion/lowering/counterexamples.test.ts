import { layer } from "@effect/vitest"
import { drawn } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { filter, map } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Schema } from "effect"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { unrollRule } from "#compiler/lower/shapes/recursion/index.ts"
import { formsHold, reachableRecursions } from "#test/pg/recursion/graph/support.ts"
import {
	feedbackUnionAll,
	lowerCase,
	optimizedFeedbackUnionAll,
	optimizedLowering,
	withEncodedParams
} from "#test/pg/recursion/lowering/support.ts"
import { repeatsStates } from "#test/pg/recursion/oracle/support.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import {
	defaultRecursiveLimits,
	type GraphLimits,
	type RecursiveCase,
	type RecursiveFeature,
	type RecursiveLimits,
	recursiveCaseGen,
	vertexKinds
} from "#test/support/oracle/gen/recursive.ts"

import {
	defaultRunOptions,
	type Lowering,
	oracleCheck,
	printOutcome,
	runOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The UNION ALL feedback mutant against the optimized lowering: a UNION ALL feedback mutant is killed by the diamond
 * case.
 *
 * The mutant is applied in the shape an optimizer emits: the V6 form, recursive UNION with plain seed and step
 * SELECTs, with that UNION then turned into UNION ALL. The optimized lowering is that V6 form (its seed, step and
 * feedback scan carry no DISTINCT, test/pg/recursion/lowering/walks.test.ts), so the mutant here is its own output with
 * each recursion's feedback union made UNION ALL: the recursive CTE's UNION, or the unrolled levels' set UNION
 * (lower/shapes/recursion). Two paths through a diamond can produce the same state, although the
 * diamond's edges are a pure set, it is acyclic and the walk is bounded; on every generated diamond rooted at its top
 * the mutant repeats a state the optimized lowering delivers once, with the same distinct rows, in both forms: a walk
 * whose counter proves its depth within core/policy.ts recursionUnrollMax is unrolled, an unbounded one stays a
 * recursive CTE. Each case's program shows its recursion in exactly one form, observed over the whole statement AST.
 */

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

class NotKilled extends Schema.TaggedError<NotKilled, { readonly brand: unique symbol }>()(
	"NotKilled",
	{
		report: Schema.String
	}
) {}

const run = (c: RecursiveCase, left: Lowering, right: Lowering) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label: "mutant" })
		return yield* runOracle(c, left, right, {
			...defaultRunOptions,
			schema: { kind: "named", name: schema }
		})
	})

/**
 * Physical names for counting sites without an installation. A generated text vertex carries a regex refinement, and
 * the optimized delivery casts an unproved refined output (a relation parameter's root, a base-typed recursive state
 * column) to its structural text domain (lower/shapes/refined), so the names must name one, as an
 * installation's names do: a stand-in domain per pattern (naming.ts standInNames).
 */
const siteNames: PhysicalNames = standInNames("Graph")

/**
 * How many feedback unions the mutant rewrites in a case's optimized program, and the forms the program took: unrolled
 * when the unroll certificate records a recursion unrolled into joins, recursive when a statement of the query itself
 * holds a WITH RECURSIVE at any depth of its AST (the lowering nests one inside a derived table under any consumer
 * node).
 */
const sites = (c: RecursiveCase) => {
	const program = lowerCase(c, siteNames)
	if (!program.ok) {
		throw new Error(program.error.message)
	}
	const mutated = feedbackUnionAll(program.value)
	if (!mutated.ok) {
		throw new Error(mutated.error.message)
	}
	return {
		sites: mutated.value.sites,
		unrolled: Arr.some(program.value.certificates, (x) => x.rule === unrollRule),
		recursive: Arr.some(
			flight(program.value.roots),
			(st) => st.role.kind !== "attachment" && has(shapeOf(st.ast), "with recursive")
		)
	}
}

/** What the population notes: its generator's features and the form each kill took. */
type DiamondFeature = RecursiveFeature | "killed unrolled" | "killed recursive"

/** The population must reach every vertex type and parallel edges, and kill the mutant in both forms of the lowering. */
const situations = [
	...Arr.map(vertexKinds, (k): RecursiveFeature => `vertex:${k}`),
	"parallel edges",
	"killed unrolled",
	"killed recursive"
] as const satisfies ReadonlyArray<DiamondFeature>

layer(Substrate.layer)("the UNION ALL feedback mutant of the optimized lowering", (it) => {
	it.effect(
		"every generated diamond rooted at its top kills it in both forms, whatever its vertex type, edges, seed or state",
		(ctx) =>
			searched(
				ctx,
				Effect.suspend(() => {
					const limits = diamondLimits({
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
						maxBound: 4
					})
					/** Walks need at least two hops to meet at the bottom of a diamond. */
					const generator = map(
						filter(
							recursiveCaseGen(limits),
							(c) => c.parts.form !== "walks" || c.parts.bound >= 2,
							100
						),
						withEncodedParams
					)
					return oracleCheck(
						drawn(generator),
						{
							suite: "recursion/optimized-diamond-kills",
							literal: Formatter.format,
							coverage: required<DiamondFeature>(situations, { cases: 300, sense: notesOnly }),
							kept: [],
							runs: 300,
							shrink: completeShrink,
							caseHang: Duration.minutes(2),
							perturb: "none"
						},
						(c, notes) =>
							Effect.gen(function* () {
								notes.noteAll(c.features)
								if (!c.features.includes("diamond") || !c.terminatesAsBag) {
									return yield* NotKilled.make({
										report: `not a terminating diamond: ${Arr.join(c.features, ", ")}`
									})
								}
								const counted = sites(c)
								const recursions = reachableRecursions(c.query.dag.roots[0])
								if (!formsHold(recursions, counted)) {
									return yield* NotKilled.make({
										report: `${recursions} reachable recursions shown as unrolled: ${counted.unrolled}, recursive: ${counted.recursive}`
									})
								}
								if (counted.sites === 0) {
									return yield* NotKilled.make({
										report: "the mutant found no feedback union to rewrite"
									})
								}
								const outcome = yield* run(
									c,
									optimizedLowering("optimized"),
									optimizedFeedbackUnionAll
								)
								if (!repeatsStates(outcome)) {
									return yield* NotKilled.make({ report: `not killed:\n${printOutcome(outcome)}` })
								}
								if (counted.unrolled) {
									notes.note("killed unrolled")
								}
								if (counted.recursive) {
									notes.note("killed recursive")
								}
							})
					)
				})
			),
		600_000
	)
})
