/** What the properties of feedback.test.ts read: its spaces, models and helpers. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { boolean, element, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { conservativeMeta, type Heading, type NodeOf, type RelNode } from "#compiler/ir/rel.ts"
import {
	carriesNothing,
	emptyEnv,
	evaluatedAsItStands,
	LowerContext
} from "#compiler/lower/conservative/context.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import { optimizedDispatch, ShapeState } from "#compiler/lower/shapes/index.ts"
import { recursionLowerer } from "#compiler/lower/shapes/recursion/index.ts"
import { noKeys } from "#compiler/lower/shapes/share/keyed.ts"
import { placeOf, refusalLoc } from "#test/support/assert.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
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

const names = productionNames("Ledger", { kind: "declared" }, localVectorSchema, emptyCodebook)

export type State = "hashable" | "money"

export const states: Readonly<Record<State, Heading>> = {
	hashable: heading(["src", T.int4], ["dst", T.int4], ["hops", T.int4]),
	/** money has no hash operator class. */
	money: heading(["src", T.int4], ["dst", T.int4], ["hops", T.int4], ["paid", T.money])
}

/**
 * A relation of the state heading a step's operator reads: the feedback (the recursion's one SelfRef), a transition hop
 * over it ((src, dst, hops + 1) from below the closure's counter), or the fixed seed (Edge at hops 0), which reads none.
 */
type Leaf = "feedback" | "hop" | "seed"

/** An operator over leaves: a leaf alone, a fold or a bound over one, or a binary operator over two. */
type Operator =
	| { readonly kind: "leaf"; readonly leaf: Leaf }
	| { readonly kind: "aggregate" | "bound"; readonly of: Leaf }
	| {
			readonly kind: "anti" | "difference" | "intersect" | "union"
			readonly left: Leaf
			readonly right: Leaf
	  }

/** A step: its operator, the step itself or joined by its rows' start to a transition hop. */
interface Step {
	readonly joined: boolean
	readonly operator: Operator
}

const leaves: Arr.NonEmptyReadonlyArray<Leaf> = ["feedback", "hop", "seed"]

const reading: Arr.NonEmptyReadonlyArray<Leaf> = ["feedback", "hop"]

/**
 * Two leaves of a binary operator: never the one feedback node twice, and, where the operator must read the feedback,
 * a reading leaf beside a seed.
 */
const pairGen =
	(mustRead: boolean): Gen<readonly [Leaf, Leaf]> =>
	(source) => {
		const left = source.draw(element(leaves))
		const right = source.draw(
			element<Leaf>(
				left === "feedback" ? ["hop", "seed"] : left === "seed" && mustRead ? reading : leaves
			)
		)
		return [left, right]
	}

/** An operator, one that reads the feedback where `mustRead`: the step itself must, a joined operator need not. */
const operatorGen = (mustRead: boolean): Gen<Operator> =>
	oneOf<Operator>([
		map(element<Leaf>(mustRead ? ["hop"] : leaves), (leaf): Operator => ({ kind: "leaf", leaf })),
		map(
			(source) =>
				[
					source.draw(element<"aggregate" | "bound">(["aggregate", "bound"])),
					source.draw(element(mustRead ? reading : leaves))
				] as const,
			([kind, of]): Operator => ({ kind, of })
		),
		map(
			(source) =>
				[
					source.draw(
						element<"anti" | "difference" | "intersect" | "union">([
							"anti",
							"difference",
							"intersect",
							"union"
						])
					),
					source.draw(pairGen(mustRead))
				] as const,
			([kind, [left, right]]): Operator => ({ kind, left, right })
		)
	])

export const stepGen: Gen<Step> = (source) => {
	const joined = source.draw(boolean)
	return { joined, operator: source.draw(operatorGen(!joined)) }
}

/** How often a leaf scans the feedback. */
const scansOf = (leaf: Leaf): number => (leaf === "seed" ? 0 : 1)

/**
 * What the rule reads of a step: how often it scans the feedback, and whether the feedback flows into an input that is
 * not positive: a fold's or a bound's, the right of an anti-join or a difference, either side of an intersection.
 */
const readOf = (step: Step): { readonly scans: number; readonly blocks: boolean } => {
	const own = operatorRead(step.operator)
	return step.joined ? { scans: own.scans + 1, blocks: own.blocks } : own
}

/** What the rule reads of an operator over its leaves. */
const operatorRead = (o: Operator): { readonly scans: number; readonly blocks: boolean } => {
	switch (o.kind) {
		case "leaf":
			return { scans: scansOf(o.leaf), blocks: false }
		case "aggregate":
		case "bound":
			return { scans: scansOf(o.of), blocks: scansOf(o.of) > 0 }
		case "anti":
		case "difference":
			return { scans: scansOf(o.left) + scansOf(o.right), blocks: scansOf(o.right) > 0 }
		case "intersect":
			return {
				scans: scansOf(o.left) + scansOf(o.right),
				blocks: scansOf(o.left) + scansOf(o.right) > 0
			}
		case "union":
			return { scans: scansOf(o.left) + scansOf(o.right), blocks: false }
	}
}

export type Verdict =
	| "lowered"
	| "refused for a block"
	| "refused for an unhashable state"
	| "refused for a second scan"

/** The rule, in the order the lowerings apply it: the walk for a block, the state's hashing, then the scans. */
export const verdictOf = (step: Step, state: State): Verdict => {
	const read = readOf(step)
	return read.blocks
		? "refused for a block"
		: state === "money"
			? "refused for an unhashable state"
			: read.scans > 1
				? "refused for a second scan"
				: "lowered"
}

interface Built {
	readonly dag: ReturnType<Q["build"]>["dag"]
	readonly rec: NodeOf<"Recursive">
}

/**
 * A closure over Edge (and Reading for a money state) seeded at hops 0, whose step is `step`'s, its hops stepping from
 * below one hop.
 */
export const closure = (step: Step, h: Heading): Built => {
	const q = new Q()
	const rec = q.b.reserve()
	const self = q.node({
		kind: "SelfRef",
		recursive: rec,
		heading: h,
		loc: undefined,
		meta: conservativeMeta
	})
	const state = Arr.map(h, (col) => col.name)
	const money = Arr.contains(state, "paid")
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
		const f = q.filter(m, q.op("int4lt", [q.col(m, "hops"), q.int(1, T.int4)], T.bool))
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
	const leaf = (l: Leaf): RelNode => (l === "feedback" ? self : l === "hop" ? hop([]) : seed())
	const operator = (o: Operator): RelNode => {
		switch (o.kind) {
			case "leaf":
				return leaf(o.leaf)
			case "aggregate":
				return q.group(
					q.region([
						{
							source: leaf(o.of),
							bind: Rec.fromEntries(Arr.map(state, (c) => [c, c])),
							constants: {}
						}
					]),
					state,
					Arr.filter(state, (c) => c !== "hops"),
					[{ name: "hops", fn: "max", op: "int4_max", args: ["hops"], type: T.int4 }],
					conservativeMeta
				)
			case "bound":
				return q.take(
					leaf(o.of),
					asc(...argumentsOf(state)),
					{ kind: "literal", k: 1n },
					[],
					conservativeMeta
				)
			case "anti":
				return q.anti(leaf(o.left), leaf(o.right), [
					["src", "src"],
					["dst", "dst"]
				])
			case "difference":
				return q.setOp("Difference", leaf(o.left), leaf(o.right))
			case "intersect":
				return q.setOp("Intersect", leaf(o.left), leaf(o.right))
			case "union":
				return q.union([leaf(o.left), leaf(o.right)], [])
		}
	}
	const root = q.b.define(rec, {
		kind: "Recursive",
		name: "closure",
		base: seed(),
		step: step.joined
			? hop([{ source: operator(step.operator), bind: { src: "src" }, constants: {} }])
			: operator(step.operator),
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

export const conservative = (b: Built): Result.Result<unknown, CompileError> =>
	lowerConservative(conservativeInput(b), {
		names,
		params: [],
		subject: { kind: "query" }
	})

/** The optimized recursion lowerer over the optimized dispatch. */
export const optimized = (b: Built): Result.Result<unknown, CompileError> => {
	const facts = conservativeShapeFacts({ realization: () => "distinct" })
	const cx = new LowerContext(
		b.dag,
		{
			names,
			params: [],
			subject: { kind: "query" }
		},
		optimizedDispatch(facts, new ShapeState(emptyCtePlan, noKeys)).dispatch,
		evaluatedAsItStands,
		carriesNothing
	)
	return catchRefusal(() => recursionLowerer(facts)(b.rec, cx, emptyEnv))
}

/** A refusal's contract shared by the two artifacts: its reason and its place, never its prose. */
export const located = (e: CompileError) => ({
	reason: e.reason._tag,
	place: placeOf(refusalLoc(e))
})
