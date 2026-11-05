import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import type * as Result from "#compiler/core/result.ts"
import { conservativeMeta, type Heading, type NodeOf, type RelNode } from "#compiler/ir/rel.ts"
import { emptyEnv, LowerContext } from "#compiler/lower/conservative/context.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import { optimizedDispatch, ShapeState } from "#compiler/lower/shapes/index.ts"
import { recursionLowerer } from "#compiler/lower/shapes/recursion/index.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { assert, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import { heading } from "#test/unit/ir/fixture.ts"
import {
	asc,
	Edge,
	type OccurrenceSpec,
	Q,
	Reading,
	T
} from "#test/unit/lower/conservative/fixtures.ts"
import { conservativeShapeFacts } from "#test/unit/lower/shapes/support.ts"
import { nodeOfKind } from "#test/unit/lower/support.ts"

/**
 * The admission of a recursion's feedback by every lowering: the conservative one (lower/conservative/recursive
 * requireAdmittedFeedback, and conservative/self-ref for a second scan) and the optimized recursion lowerer
 * (lower/shapes/recursion/index.ts), which refuses through the same walk before it lowers. The rule, as their
 * headers state it: a recursion lowers only when its feedback is positive and linear, so no path from the step to its
 * SelfRef passes through an operator that is not monotone and distributive over the feedback (a fold, a bound, the
 * negated side of an anti-join or a difference, either side of an intersection), the step scans the feedback once, and
 * every state column has a hash operator class. Otherwise every lowering refuses it as UnsupportedOperation, alike:
 * the two artifacts of a template refuse alike. Without the refusal an aggregate or bound over the feedback would fold
 * one iteration instead of the fixed point, a wrong answer and not an error, and an unhashable state column would fail
 * the recursive CTE with 0A000.
 *
 * The checker never admits these steps, so the property is exhaustive over hand-built steps: each construction states
 * what the rule reads of it (whether an operator on the way to the feedback blocks it, how often the step scans it),
 * crossed with a hashable or a money state and a few counter depths, every one of which lowers to the recursive CTE.
 */

const names = productionNames("Ledger", { kind: "declared" }, localVectorSchema)

type State = "hashable" | "money"

const states: Readonly<Record<State, Heading>> = {
	hashable: heading(["src", T.int4], ["dst", T.int4], ["hops", T.int4]),
	/** money has no hash operator class. */
	money: heading(["src", T.int4], ["dst", T.int4], ["hops", T.int4], ["paid", T.money])
}

/**
 * What a step is built from: the builder, its SelfRef, `hop` (the linear one-step transition (src, dst, hops + 1)
 * over the feedback from below the closure's counter depth, joined to the extra occurrences given), and `seed` (a fresh
 * projection of Edge at hops 0, a relation that reads no feedback, of the state heading).
 */
interface Parts {
	readonly q: Q
	readonly self: RelNode
	readonly hop: (extra: ReadonlyArray<OccurrenceSpec>) => RelNode
	readonly seed: () => RelNode
}

/**
 * A construction of a step, and what the rule reads of it: whether an operator on a path from the step to its SelfRef
 * is not monotone and distributive over the feedback, and how many times the step scans the feedback.
 */
interface Construction {
	readonly blocks: boolean
	readonly scans: number
	readonly step: (p: Parts) => RelNode
}

const constructions = {
	"the linear step": { blocks: false, scans: 1, step: (p) => p.hop([]) },
	"an aggregate as the step": {
		blocks: true,
		scans: 1,
		step: (p) => {
			const state = Arr.map(p.self.heading, (c) => c.name)
			const m = p.q.region([
				{ source: p.self, bind: Rec.fromEntries(Arr.map(state, (c) => [c, c])), constants: {} }
			])
			return p.q.group(
				m,
				state,
				Arr.filter(state, (c) => c !== "hops"),
				[{ name: "hops", fn: "max", op: "int4_max", args: ["hops"], type: T.int4 }],
				conservativeMeta
			)
		}
	},
	"an aggregate joined to the step": {
		blocks: true,
		scans: 2,
		step: (p) => {
			const m = p.q.region([
				{ source: p.self, bind: { src: "src", dst: "dst", hops: "hops" }, constants: {} }
			])
			const g = p.q.group(
				m,
				["src", "dst", "hops"],
				["src"],
				[{ name: "most", fn: "max", op: "int4_max", args: ["dst"], type: T.int4 }],
				conservativeMeta
			)
			return p.hop([{ source: g, bind: { src: "src" }, constants: {} }])
		}
	},
	"a bound over the step": {
		blocks: true,
		scans: 1,
		step: (p) => {
			const h = p.hop([])
			return p.q.take(
				h,
				asc(...argumentsOf(Arr.map(h.heading, (c) => c.name))),
				{ kind: "literal", k: 1n },
				[],
				conservativeMeta
			)
		}
	},
	"a bound joined to the step": {
		blocks: true,
		scans: 2,
		step: (p) =>
			p.hop([
				{
					source: p.q.take(
						p.self,
						asc(...argumentsOf(Arr.map(p.self.heading, (c) => c.name))),
						{ kind: "literal", k: 1n },
						[],
						conservativeMeta
					),
					bind: { src: "src" },
					constants: {}
				}
			])
	},
	"a negated feedback": {
		blocks: true,
		scans: 2,
		step: (p) =>
			p.q.anti(p.hop([]), p.self, [
				["src", "src"],
				["dst", "dst"]
			])
	},
	"a negated fixed relation": {
		blocks: false,
		scans: 1,
		step: (p) =>
			p.q.anti(p.hop([]), p.seed(), [
				["src", "src"],
				["dst", "dst"]
			])
	},
	"a difference removing the feedback": {
		blocks: true,
		scans: 2,
		step: (p) => p.q.setOp("Difference", p.hop([]), p.self)
	},
	"a difference keeping the feedback": {
		blocks: false,
		scans: 1,
		step: (p) => p.q.setOp("Difference", p.hop([]), p.seed())
	},
	"an intersection over the step": {
		blocks: true,
		scans: 1,
		step: (p) => p.q.setOp("Intersect", p.hop([]), p.seed())
	},
	"an intersection of a fixed relation with the step": {
		blocks: true,
		scans: 1,
		step: (p) => p.q.setOp("Intersect", p.seed(), p.hop([]))
	},
	"an intersection with the feedback on its left, joined": {
		blocks: true,
		scans: 2,
		step: (p) =>
			p.hop([
				{ source: p.q.setOp("Intersect", p.self, p.seed()), bind: { src: "src" }, constants: {} }
			])
	},
	"an intersection with the feedback on its right, joined": {
		blocks: true,
		scans: 2,
		step: (p) =>
			p.hop([
				{ source: p.q.setOp("Intersect", p.seed(), p.self), bind: { src: "src" }, constants: {} }
			])
	},
	"a nonlinear self-join": {
		blocks: false,
		scans: 2,
		step: (p) => p.hop([{ source: p.self, bind: { src: "mid" }, constants: {} }])
	},
	"two transition arms": {
		blocks: false,
		scans: 2,
		step: (p) => p.q.union([p.hop([]), p.hop([])], [])
	},
	"a transition arm beside a fixed arm": {
		blocks: false,
		scans: 1,
		step: (p) => p.q.union([p.hop([]), p.seed()], [])
	}
} as const satisfies Record<string, Construction>

type ConstructionName = keyof typeof constructions

const constructionNames: Arr.NonEmptyReadonlyArray<ConstructionName> = [
	"the linear step",
	"an aggregate as the step",
	"an aggregate joined to the step",
	"a bound over the step",
	"a bound joined to the step",
	"a negated feedback",
	"a negated fixed relation",
	"a difference removing the feedback",
	"a difference keeping the feedback",
	"an intersection over the step",
	"an intersection of a fixed relation with the step",
	"an intersection with the feedback on its left, joined",
	"an intersection with the feedback on its right, joined",
	"a nonlinear self-join",
	"two transition arms",
	"a transition arm beside a fixed arm"
]

/** The rule: lowered exactly when the feedback is positive and linear and every state column hashes. */
const lowersByRule = (c: Construction, state: State): boolean =>
	!c.blocks && c.scans === 1 && state === "hashable"

interface Built {
	readonly dag: ReturnType<Q["build"]>["dag"]
	readonly rec: NodeOf<"Recursive">
}

/**
 * A closure over Edge (and Reading for a money state) seeded at hops 0, whose step the construction builds, its hop
 * stepping from below hops `depth`.
 */
const closure = (c: Construction, h: Heading, depth: number): Built => {
	const q = new Q()
	const rec = q.b.reserve()
	const self = q.node({
		kind: "SelfRef",
		recursive: rec,
		heading: h,
		loc: undefined,
		meta: conservativeMeta
	})
	const money = Arr.some(h, (col) => col.name === "paid")
	const seed = () =>
		q.project(
			q.region([
				{ source: q.base(Edge, conservativeMeta), bind: { src: "src", dst: "dst" }, constants: {} },
				...(money
					? [
							{
								source: q.base(Reading, conservativeMeta),
								bind: { id: "src", paid: "paid" },
								constants: {}
							}
						]
					: [])
			]),
			[
				["src", "src"],
				["dst", "dst"],
				["hops", [q.int(0, T.int4), T.int4]],
				...(money ? [["paid", "paid"] as const] : [])
			],
			conservativeMeta
		)
	const hop = (extra: ReadonlyArray<OccurrenceSpec>) => {
		const m = q.region([
			{
				source: self,
				bind: { src: "src", dst: "mid", hops: "hops", ...(money ? { paid: "paid" } : {}) },
				constants: {}
			},
			{ source: q.base(Edge, conservativeMeta), bind: { src: "mid", dst: "dst" }, constants: {} },
			...extra
		])
		const f = q.filter(m, q.op("int4lt", [q.col(m, "hops"), q.int(depth, T.int4)], T.bool))
		return q.project(
			f,
			[
				["src", "src"],
				["dst", "dst"],
				["hops", [q.op("int4pl", [q.col(f, "hops"), q.int(1, T.int4)], T.int4), T.int4]],
				...(money ? [["paid", "paid"] as const] : [])
			],
			conservativeMeta
		)
	}
	const root = q.b.define(rec, {
		kind: "Recursive",
		name: "closure",
		base: seed(),
		step: c.step({ q, self, hop, seed }),
		self,
		termination: { kind: "finiteCarrier", stateEstimate: 100n, premises: [] },
		origin: [],
		heading: h,
		loc: undefined,
		meta: conservativeMeta
	})
	const built = q.build(root)
	return { ...built, rec: nodeOfKind(root, "Recursive") }
}

const conservative = (b: Built): Result.Result<unknown, CompileError> =>
	lowerConservative(conservativeInput(b), {
		names,
		params: [],
		subject: { kind: "query" }
	})

/** The optimized recursion lowerer over the optimized dispatch. */
const optimized = (b: Built): Result.Result<unknown, CompileError> => {
	const facts = conservativeShapeFacts({ realization: () => "distinct" })
	const cx = new LowerContext(
		b.dag,
		{
			names,
			params: [],
			subject: { kind: "query" }
		},
		optimizedDispatch(facts, new ShapeState<RelationInput>("small", emptyCtePlan))
	)
	return catchRefusal(() => recursionLowerer(facts)(b.rec, cx, emptyEnv))
}

/** A refusal's contract shared by the two artifacts: its reason, where it is, and what is missing. */
const located = (e: CompileError) => ({
	reason: e.reason._tag,
	location: formatLoc(refusalLoc(e)),
	message: e.message
})

type FeedbackFeature = "lowered" | "refused"

describe("every lowering admits exactly positive linear feedback over a hashable state", () => {
	it.effect("lowers or refuses each construction alike in every lowering", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/lower/feedback/admission",
					/** The hop's counter depth: one hop, a few, and more. */
					generator: (source) =>
						[
							source.draw(element(constructionNames)),
							source.draw(element<State>(["hashable", "money"])),
							source.draw(element([1, 4, 5]))
						] as const,
					literal: Formatter.format,
					limit: 200,
					coverage: requiredInSpace<FeedbackFeature>(["lowered", "refused"]),
					caseHang
				},
				([name, state, depth], c) =>
					Effect.sync(() => {
						const construction = constructions[name]
						const b = closure(construction, states[state], depth)
						const fromConservative = conservative(b)
						const fromOptimized = optimized(b)
						if (lowersByRule(construction, state)) {
							succeeded(fromConservative, name)
							succeeded(fromOptimized, name)
							c.note("lowered")
						} else {
							const expected = refused(fromConservative, "UnsupportedOperation", name)
							const got = refused(fromOptimized, "UnsupportedOperation", name)
							assert.deepEqual(located(got), located(expected), name)
							c.note("refused")
						}
					})
			)
		)
	)
})
