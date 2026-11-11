import { layer } from "@effect/vitest"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Formatter } from "effect"
import {
	type RecursionOracleFeature,
	recursiveEquivalence
} from "#test/pg/recursion/oracle/support.ts"
import {
	defaultRecursiveLimits,
	graphShapes,
	type RecursiveFeature,
	recursiveCaseGen,
	vertexKinds
} from "#test/support/oracle/gen/recursive.ts"
import { conservative, reference } from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The recursion equivalence suite.
 *
 * Seeded graph-shaped recursive queries over chains, trees, diamonds, self-loops, dense cycles, random graphs,
 * parallel edges and multiple roots carrying origin, each run on PostgreSQL 19 through the conservative lowering and
 * computed by definition through the reference evaluator, compared statement by statement as raw text sets with
 * no repeated row on the lowering's side (every statement delivers a set). The population covers every
 * recursion family (endpoint closure, bounded computed walks, left- and right-linear pair closure), every root binding
 * (a parameter, a literal, a relation parameter of roots that may repeat or name no vertex, every vertex, two base
 * arms), zero-or-more and one-or-more seeds, all three directions and alternative edge relations as
 * factored transition arms, explicit existence matches over dangling edges,
 * negation of a fixed relation and of an earlier completed stratum in the step, and every consumer: the
 * complete state, a state-dropping projection, a minimum-length filter, aggregates over
 * the completed recursion and over its edges by edge id, two differently bound imports, a
 * second recursive stage, an attachment by origin, a negated completed closure, and
 * predicates on the completed recursion's end vertex and origin, which an optimizer must not push into
 * the seed or the step unless they name the origin. Text vertices are seeded from relation parameters and parent-key
 * recordsets like every other type.
 *
 * recursiveEquivalence is the reusable form: the graph suite runs the same population with the optimized lowering on the left
 * and the conservative lowering on the right.
 *
 * @cpu-bound
 *
 * Plants (main's test phase): recursion-conservative-feedback-union-all.patch.
 */

const cases = 1600

/** What the population must reach. */
const situations = [
	...Arr.map(graphShapes, (s): RecursiveFeature => `shape:${s}`),
	...Arr.map(vertexKinds, (k): RecursiveFeature => `vertex:${k}`),
	"self-loop",
	"parallel edges",
	"cycle",
	"diamond",
	"multiple roots carrying origin",
	"keyed edges",
	"set edges",
	"containment",
	"dangling edges",
	"second edge relation",
	"form:reach",
	"form:walks",
	"form:pairs",
	"roots:param",
	"roots:literal",
	"roots:input",
	"roots:all",
	"roots:arms",
	"zero-or-more",
	"one-or-more",
	"direction:forward",
	"direction:reverse",
	"direction:both",
	"alternative relations",
	"existence match",
	"negation:relation",
	"negation:stratum",
	"step filter:notLiteral",
	"step filter:increasing",
	"hops:int2",
	"hops:int4",
	"hops:int8",
	"left-linear",
	"right-linear",
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
	"consumer:endNe",
	"consumer:originFilter",
	"result filter:param",
	"result filter:literal",
	"relation roots over text"
] as const satisfies ReadonlyArray<RecursionOracleFeature>

const explored = recursiveEquivalence(
	recursiveCaseGen(defaultRecursiveLimits),
	conservative,
	reference,
	{
		suite: "recursion/reference",
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator, computing each recursion by definition"
		},
		literal: Formatter.format,
		coverage: required<RecursionOracleFeature>([...situations, "nonempty"], {
			cases: 2 * cases,
			sense: notesOnly
		}),
		kept: [],
		runs: 2 * cases,
		shrink: completeShrink,
		perturb: "all"
	}
)

layer(Substrate.layer)(
	"recursive queries: the conservative lowering against the reference evaluator",
	(it) => {
		it.effect(
			"agree on seeded graph-shaped recursive queries of every shape, family, binding and consumer, with no repeated row",
			(ctx) => searched(ctx, explored)
		)
	}
)
