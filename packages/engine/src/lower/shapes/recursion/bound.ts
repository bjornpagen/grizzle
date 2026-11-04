import { firstIndex, appendAll } from "#compiler/core/array.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { inputsOf, type NodeOf, type RelDag, type RelNode, type VarDecl } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { type NativeFn, nativeOp } from "#compiler/scalar/compute/registry.ts"

/** The integer carriers a counter may live in, with their ranges. */
const integerRanges: Readonly<Record<string, readonly [bigint, bigint]>> = {
	int2: [-32768n, 32767n],
	int4: [-2147483648n, 2147483647n],
	int8: [-9223372036854775808n, 9223372036854775807n]
}

/**
 * The values a counter of type `t` can hold: an integer carrier's range, or an exact integer's, below 10^digits, which
 * no step overflows.
 */
const integerRange = (t: ScalarType): readonly [bigint, bigint] | undefined => {
	const base = baseOf(t)
	if (base.carrier === "exactInteger") {
		const bound = 10n ** BigInt(base.digits)
		return [-bound + 1n, bound - 1n]
	}
	return integerRanges[base.carrier]
}

/** A bounded counter that proves the recursion's iteration bound. */
export interface CounterProof {
	/** The state column. */
	readonly column: string
	/** The step every derived row advances it by, nonzero. */
	readonly delta: bigint
	/**
	 * The last current value the step advances from: the upper bound for an increasing counter, the lower for a
	 * decreasing one.
	 */
	readonly limit: bigint
	/** The seeds' counter values, ascending. */
	readonly seeds: ReadonlyArray<bigint>
	/** N: the step's image of the seeds is empty after N iterations. */
	readonly depth: number
}

/** Why no counter proves a bound, for diagnostics and tests. */
type UnrollRefusal = "noCounter" | "unboundedSeeds" | "noLiteralBound" | "counterOverflow"

export type CounterAnalysis =
	| { readonly kind: "bounded"; readonly proof: CounterProof }
	| { readonly kind: "unbounded"; readonly reason: UnrollRefusal }

/** What a counter analysis reads of a recursion: its seeds, its step, its feedback and its state heading. */
export type RecursionParts = Pick<NodeOf<"Recursive">, "base" | "step" | "self" | "heading">

/** One side of what holds of the current counter: no bound on that side, or an inclusive bound. */
type Bound = { readonly kind: "unbounded" } | { readonly kind: "at"; readonly value: bigint }

const unbounded: Bound = { kind: "unbounded" }
const at = (value: bigint): Bound => ({ kind: "at", value })

/** What the bound conjuncts say about the current counter: an upper and a lower bound, each possibly none. */
interface Guard {
	readonly upper: Bound
	readonly lower: Bound
}

/** The guard of no conjunct. */
const anyCounter: Guard = { upper: unbounded, lower: unbounded }

/** The stronger of two bounds on one side, `stronger(x, y)` when x is the stronger value; no bound is the weakest. */
const strongest = (a: Bound, b: Bound, stronger: (x: bigint, y: bigint) => boolean): Bound =>
	a.kind === "unbounded" ? b : b.kind === "unbounded" ? a : stronger(b.value, a.value) ? b : a

/** The weaker of two bounds on one side; no bound is the weakest. */
const weakest = (a: Bound, b: Bound, stronger: (x: bigint, y: bigint) => boolean): Bound =>
	a.kind === "unbounded" ? a : b.kind === "unbounded" ? b : stronger(b.value, a.value) ? a : b

const below = (x: bigint, y: bigint): boolean => x < y
const above = (x: bigint, y: bigint): boolean => x > y

/** The guard both of two guards' conjuncts state. */
const meet = (a: Guard, b: Guard): Guard => ({
	upper: strongest(a.upper, b.upper, below),
	lower: strongest(a.lower, b.lower, above)
})

/** The guard that holds for every row of a union: the weakest arm's, or none for a union of no arm. */
const join = (guards: ReadonlyArray<Guard>): Guard => {
	const [first, ...rest] = guards
	return first === undefined
		? anyCounter
		: rest.reduce<Guard>(
				(g, h) => ({
					upper: weakest(g.upper, h.upper, below),
					lower: weakest(g.lower, h.lower, above)
				}),
				first
			)
}

/** The comparisons of the counter with a literal that bound it. */
type GuardOp = "lt" | "le" | "eq" | "ge" | "gt"

const guardOpOf = (fn: NativeFn): GuardOp | undefined =>
	fn === "lt" || fn === "le" || fn === "eq" || fn === "ge" || fn === "gt" ? fn : undefined

/** `bound op counter` is `counter flipped[op] bound`. */
const flipped: { readonly [O in GuardOp]: GuardOp } = {
	lt: "gt",
	le: "ge",
	eq: "eq",
	ge: "le",
	gt: "lt"
}

/** The guard `counter op bound` states. */
const comparisonGuard: { readonly [O in GuardOp]: (bound: bigint) => Guard } = {
	lt: (bound) => ({ upper: at(bound - 1n), lower: unbounded }),
	le: (bound) => ({ upper: at(bound), lower: unbounded }),
	eq: (bound) => ({ upper: at(bound), lower: at(bound) }),
	ge: (bound) => ({ upper: unbounded, lower: at(bound) }),
	gt: (bound) => ({ upper: unbounded, lower: at(bound + 1n) })
}

/**
 * The columns of a union's arm under the group's heading names: the arms share the group heading (UNION renames
 * them by position), so a column is found by its name in the arm's own heading.
 */
const armColumn = (arm: RelNode, column: string, position: number): string | undefined =>
	arm.heading.some((c) => c.name === column) ? column : arm.heading[position]?.name

/**
 * Each arm of a union with the name it gives `column`, group by group, lazily: none in place of an arm that has no such
 * column and of a group whose heading lacks it, where a reader stops.
 */
function* unionArms(
	node: NodeOf<"Union">,
	column: string
): Generator<{ readonly arm: RelNode; readonly name: string } | undefined> {
	for (const group of node.groups) {
		const position = firstIndex(group.heading, (c) => c.name === column)
		if (position === undefined) {
			yield undefined
			return
		}
		for (const arm of group.arms) {
			const name = armColumn(arm, column, position)
			yield name === undefined ? undefined : { arm, name }
		}
	}
}

/** Every source column an occurrence of a region binds to the variable `v`, in occurrence and binding order. */
const boundTo = (
	node: NodeOf<"MatchRegion">,
	v: VarDecl
): ReadonlyArray<{ readonly source: RelNode; readonly column: string }> =>
	node.occurrences.flatMap((o) =>
		o.bindings.filter((b) => b.var === v).map((b) => ({ source: o.source, column: b.column }))
	)

/** The integers a closed relation's column holds, when every row holds one. */
const closedSeeds = (node: NodeOf<"Closed">, column: string): ReadonlySet<bigint> | undefined => {
	const position = firstIndex(node.heading, (c) => c.name === column)
	if (position === undefined) {
		return undefined
	}
	const values = new Set<bigint>()
	for (const row of node.rows) {
		const v = row[position]
		if (v?.kind !== "int") {
			return undefined
		}
		values.add(v.value)
	}
	return values
}

class CounterReader {
	readonly rec: RecursionParts
	/**
	 * The recursion's DAG's nodes by label, for the node a column reference names: a name, read tolerantly, a label no
	 * node holds knowing no seed and no step.
	 */
	readonly labels: ReadonlyMap<NodeId, RelNode>
	/** Every integer carrier the counter's steps compute in. */
	readonly carriers: Array<readonly [bigint, bigint]> = []

	constructor(labels: ReadonlyMap<NodeId, RelNode>, rec: RecursionParts) {
		this.labels = labels
		this.rec = rec
	}

	/** The integer value of a literal, or of a literal cast within the integer carriers in range of its target. */
	literal(e: ScalarExpr): bigint | undefined {
		if (e.kind === "literal") {
			return e.value.kind === "int" ? e.value.value : undefined
		}
		if (e.kind !== "cast") {
			return undefined
		}
		const range = integerRange(e.type)
		const inner = this.literal(e.args[0])
		if (range === undefined || inner === undefined || inner < range[0] || inner > range[1]) {
			return undefined
		}
		return inner
	}

	/**
	 * The integer values a seed column can hold, when every row fixes it to a known literal.
	 *
	 * A node no known literal flows through.
	 */
	seeds(node: RelNode, column: string, depth: number): ReadonlySet<bigint> | undefined {
		if (depth > 256) {
			return undefined
		}
		switch (node.kind) {
			case "ProjectSet": {
				const out = node.out.find((o) => o.name === column)
				return out === undefined ? undefined : this.exprSeeds(out.expr, depth + 1)
			}
			case "Filter":
				return this.seeds(node.input, column, depth + 1)
			case "SemiJoin":
			case "AntiJoin":
				return this.seeds(node.left, column, depth + 1)
			case "Union":
				return this.unionSeeds(node, column, depth)
			case "MatchRegion":
				return this.regionSeeds(node, column, depth)
			case "Closed":
				return closedSeeds(node, column)
			case "Base":
			case "Context":
			case "InputSet":
			case "Delta":
			case "Intersect":
			case "Difference":
			case "Take":
			case "Group":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Attach":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
				return undefined
		}
	}

	/** Every seed of every arm, or nothing when an arm's column is not known. */
	unionSeeds(
		node: NodeOf<"Union">,
		column: string,
		depth: number
	): ReadonlySet<bigint> | undefined {
		const out = new Set<bigint>()
		for (const arm of unionArms(node, column)) {
			const values = arm === undefined ? undefined : this.seeds(arm.arm, arm.name, depth + 1)
			if (values === undefined) {
				return undefined
			}
			for (const v of values) {
				out.add(v)
			}
		}
		return out
	}

	/** A correlated variable's seeds, else the smallest seed set of a source column bound to the variable. */
	regionSeeds(
		node: NodeOf<"MatchRegion">,
		column: string,
		depth: number
	): ReadonlySet<bigint> | undefined {
		const v = node.vars.find((x) => x.name === column)
		if (v === undefined) {
			return undefined
		}
		const correlated = node.correlated.find((c) => c.var === v)
		if (correlated !== undefined) {
			return this.exprSeeds(correlated.expr, depth + 1)
		}
		const candidates = boundTo(node, v).flatMap((b) => {
			const values = this.seeds(b.source, b.column, depth + 1)
			return values === undefined ? [] : [values]
		})
		return candidates.reduce<ReadonlySet<bigint> | undefined>(
			(best, values) => (best !== undefined && best.size <= values.size ? best : values),
			undefined
		)
	}

	exprSeeds(e: ScalarExpr, depth: number): ReadonlySet<bigint> | undefined {
		if (e.kind === "column") {
			const source = this.labels.get(e.column.node)
			return source === undefined ? undefined : this.seeds(source, e.column.name, depth + 1)
		}
		const v = this.literal(e)
		return v === undefined ? undefined : new Set([v])
	}

	/**
	 * The step d such that every row of `node` has `column` = the current state's counter + d, when one holds. With
	 * `collect`, the carriers of the counter's step expressions are recorded.
	 *
	 * A node that steps no counter by a constant.
	 */
	advance(
		node: RelNode,
		column: string,
		counter: string,
		collect: boolean,
		depth: number
	): bigint | undefined {
		if (depth > 256) {
			return undefined
		}
		if (node === this.rec.self) {
			return column === counter ? 0n : undefined
		}
		switch (node.kind) {
			case "ProjectSet": {
				const out = node.out.find((o) => o.name === column)
				return out === undefined
					? undefined
					: this.exprAdvance(out.expr, counter, collect, depth + 1)
			}
			case "Filter":
				return this.advance(node.input, column, counter, collect, depth + 1)
			case "SemiJoin":
			case "AntiJoin":
				return this.advance(node.left, column, counter, collect, depth + 1)
			case "Union":
				return this.unionAdvance(node, column, counter, collect, depth)
			case "MatchRegion":
				return this.regionAdvance(node, column, counter, collect, depth)
			case "Base":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "Intersect":
			case "Difference":
			case "Take":
			case "Group":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Attach":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
				return undefined
		}
	}

	/** The one step every arm advances the counter by: none when two arms differ or a union has no arm. */
	unionAdvance(
		node: NodeOf<"Union">,
		column: string,
		counter: string,
		collect: boolean,
		depth: number
	): bigint | undefined {
		const steps: Array<bigint> = []
		for (const arm of unionArms(node, column)) {
			const d =
				arm === undefined ? undefined : this.advance(arm.arm, arm.name, counter, collect, depth + 1)
			if (d === undefined || steps.some((x) => x !== d)) {
				return undefined
			}
			steps.push(d)
		}
		return steps[0]
	}

	/** A correlated variable's step, else the first step a source column bound to the variable takes. */
	regionAdvance(
		node: NodeOf<"MatchRegion">,
		column: string,
		counter: string,
		collect: boolean,
		depth: number
	): bigint | undefined {
		const v = node.vars.find((x) => x.name === column)
		if (v === undefined) {
			return undefined
		}
		const correlated = node.correlated.find((c) => c.var === v)
		if (correlated !== undefined) {
			return this.exprAdvance(correlated.expr, counter, collect, depth + 1)
		}
		for (const b of boundTo(node, v)) {
			const d = this.advance(b.source, b.column, counter, collect, depth + 1)
			if (d !== undefined) {
				return d
			}
		}
		return undefined
	}

	exprAdvance(e: ScalarExpr, counter: string, collect: boolean, depth: number): bigint | undefined {
		if (e.kind === "column") {
			const source = this.labels.get(e.column.node)
			return source === undefined
				? undefined
				: this.advance(source, e.column.name, counter, collect, depth + 1)
		}
		if (e.kind === "cast") {
			if (integerRange(e.type) === undefined) {
				return undefined
			}
			return this.exprAdvance(e.args[0], counter, collect, depth + 1)
		}
		if (e.kind !== "op" || e.args.length !== 2) {
			return undefined
		}
		const op = nativeOp(e.op)
		if (op === undefined || (op.fn !== "add" && op.fn !== "sub")) {
			return undefined
		}
		const range = integerRange(e.type)
		if (range === undefined) {
			return undefined
		}
		const [a, b] = e.args
		if (a === undefined || b === undefined) {
			return undefined
		}
		const delta = this.stepOf(op.fn, a, b, counter, collect, depth)
		if (delta !== undefined && collect) {
			this.carriers.push(range)
		}
		return delta
	}

	/** The step `a op b` takes the counter by, with a literal on either side of a sum and on the right of a difference. */
	stepOf(
		fn: "add" | "sub",
		a: ScalarExpr,
		b: ScalarExpr,
		counter: string,
		collect: boolean,
		depth: number
	): bigint | undefined {
		const left = this.exprAdvance(a, counter, collect, depth + 1)
		const kb = this.literal(b)
		if (left !== undefined && kb !== undefined) {
			return fn === "add" ? left + kb : left - kb
		}
		if (fn !== "add") {
			return undefined
		}
		const right = this.exprAdvance(b, counter, collect, depth + 1)
		const ka = this.literal(a)
		return right === undefined || ka === undefined ? undefined : right + ka
	}

	/**
	 * What holds of the current state's counter for every row of `node`.
	 *
	 * A node whose rows the counter's guards do not restrict.
	 */
	guard(node: RelNode, counter: string, depth: number): Guard {
		if (depth > 256 || node === this.rec.self) {
			return anyCounter
		}
		switch (node.kind) {
			case "Filter":
				return meet(
					this.guard(node.input, counter, depth + 1),
					this.predGuard(node.pred, counter, depth + 1)
				)
			case "ProjectSet":
				return this.guard(node.input, counter, depth + 1)
			case "SemiJoin":
			case "AntiJoin":
				return this.guard(node.left, counter, depth + 1)
			case "MatchRegion": {
				let g: Guard = anyCounter
				for (const o of node.occurrences) {
					g = meet(g, this.guard(o.source, counter, depth + 1))
				}
				return g
			}
			case "Union":
				return join(
					node.groups.flatMap((group) =>
						group.arms.map((arm) => this.guard(arm, counter, depth + 1))
					)
				)
			case "Base":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "Intersect":
			case "Difference":
			case "Take":
			case "Group":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Attach":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
				return anyCounter
		}
	}

	/** Whether an expression is the current state's counter, unchanged. */
	isCurrent(e: ScalarExpr, counter: string, depth: number): boolean {
		return this.exprAdvance(e, counter, false, depth) === 0n
	}

	/** The bounds a filter's top-level conjuncts put on the current counter. */
	predGuard(e: ScalarExpr, counter: string, depth: number): Guard {
		if (e.kind !== "op") {
			return anyCounter
		}
		const op = nativeOp(e.op)
		if (op === undefined) {
			return anyCounter
		}
		if (op.fn === "and") {
			return e.args.reduce<Guard>(
				(g, a) => meet(g, this.predGuard(a, counter, depth + 1)),
				anyCounter
			)
		}
		if (op.fn === "between" && e.args.length === 3) {
			const [x, lo, hi] = e.args
			if (
				x === undefined ||
				lo === undefined ||
				hi === undefined ||
				!this.isCurrent(x, counter, depth + 1)
			) {
				return anyCounter
			}
			const low = this.literal(lo)
			const high = this.literal(hi)
			return {
				upper: high === undefined ? unbounded : at(high),
				lower: low === undefined ? unbounded : at(low)
			}
		}
		const guardOp = guardOpOf(op.fn)
		const [a, b] = e.args
		if (guardOp === undefined || e.args.length !== 2 || a === undefined || b === undefined) {
			return anyCounter
		}
		if (this.isCurrent(a, counter, depth + 1)) {
			const bound = this.literal(b)
			return bound === undefined ? anyCounter : comparisonGuard[guardOp](bound)
		}
		if (this.isCurrent(b, counter, depth + 1)) {
			const bound = this.literal(a)
			return bound === undefined ? anyCounter : comparisonGuard[flipped[guardOp]](bound)
		}
		return anyCounter
	}
}

/**
 * The nodes the lowering of `roots` reads, following data inputs: what one unrolled level inlines.
 *
 * The iterator reads the length at every step, so the inputs pushed below are visited too.
 */
export const reachable = (roots: ReadonlyArray<RelNode>): ReadonlyArray<RelNode> => {
	const seen = new Set<RelNode>()
	const out: Array<RelNode> = []
	const queue = [...roots]
	for (const node of queue) {
		if (seen.has(node)) {
			continue
		}
		seen.add(node)
		out.push(node)
		appendAll(queue, inputsOf(node))
	}
	return out
}

/** The depth of one candidate counter column, or why it proves none. */
export const counterDepth = (
	labels: ReadonlyMap<NodeId, RelNode>,
	rec: RecursionParts,
	column: string
): CounterAnalysis => {
	const counterColumn = rec.heading.find((c) => c.name === column)
	const range = counterColumn === undefined ? undefined : integerRange(counterColumn.type)
	if (range === undefined) {
		return { kind: "unbounded", reason: "noCounter" }
	}
	const reader = new CounterReader(labels, rec)
	const delta = reader.advance(rec.step, column, column, true, 0)
	if (delta === undefined || delta === 0n) {
		return { kind: "unbounded", reason: "noCounter" }
	}
	const seedSet = reader.seeds(rec.base, column, 0)
	if (seedSet === undefined || seedSet.size === 0) {
		return { kind: "unbounded", reason: "unboundedSeeds" }
	}
	const guard = reader.guard(rec.step, column, 0)
	const bound = delta > 0n ? guard.upper : guard.lower
	if (bound.kind === "unbounded") {
		return { kind: "unbounded", reason: "noLiteralBound" }
	}
	const limit = bound.value
	const seeds = [...seedSet].toSorted((x, y) => (x < y ? -1 : x > y ? 1 : 0))
	const step = delta > 0n ? delta : -delta
	let depth = 0n
	for (const s of seeds) {
		const room = delta > 0n ? limit - s : s - limit
		const n = room < 0n ? 0n : room / step + 1n
		if (n > depth) {
			depth = n
		}
	}
	/** Every value a counter step computes for every seed, s + j·k for j up to N, in every carrier it passes through. */
	const carriers = [range, ...reader.carriers]
	for (const s of seeds) {
		const last = s + depth * delta
		if (carriers.some(([min, max]) => s < min || s > max || last < min || last > max)) {
			return { kind: "unbounded", reason: "counterOverflow" }
		}
	}
	if (depth > BigInt(Number.MAX_SAFE_INTEGER)) {
		return { kind: "unbounded", reason: "noLiteralBound" }
	}
	return { kind: "bounded", proof: { column, delta, limit, seeds, depth: Number(depth) } }
}

/**
 * Every value a bounded counter's step computes, from its seeds through the step past its bound, which PostgreSQL may
 * compute on the working table's last rows before the step's filter drops them: [low, high].
 */
export const counterInterval = (p: CounterProof): readonly [bigint, bigint] => {
	const ends = p.seeds.flatMap((s) => [s, s + BigInt(p.depth + 1) * p.delta])
	const [first, ...rest] = ends
	const start = first ?? 0n
	return [
		rest.reduce((m, x) => (x < m ? x : m), start),
		rest.reduce((m, x) => (x > m ? x : m), start)
	]
}

/**
 * The tightest bounded counter of a recursion: the proof with the smallest depth over its integer state columns, or
 * the first refusal met when none proves a bound.
 *
 * The iteration bound that admits unrolling a recursion.
 *
 * "For small statically bounded traversals, the compiler may produce a proved union of unrolled joins under the fixed
 * measured policy." The proof is read from the relational IR alone, never from the termination certificate's state
 * estimate, which bounds states and not iterations. It is a bounded counter: a state column c of an integer carrier
 * such that
 *
 * - every seed fixes c to an integer literal, so the seeds' counters form a known finite set S (a projection of a
 *   literal, or of a literal cast within the integer carriers, through filters, joins and set unions);
 * - every row the step produces sets c to the current state's c plus one nonzero integer literal k, the same for every
 *   row (a projection of `c + k` or `c - k` over the feedback's own c, through filters, joins, renames and unions
 *   whose every arm advances it alike);
 * - every row the step produces satisfies a top-level conjunct bounding the current c by an integer literal L on the
 *   side it moves towards (`c < L`, `c <= L`, `c = L` or `between` for k > 0, the mirror for k < 0).
 *
 * Then every state derived in iteration n has c = s + n·k for a seed s in S, and the step derives nothing from a state
 * whose c is past L, so the step's n-th image of the seeds is empty for every n > N, where
 *
 *   N = max over s in S of (s <= L ? floor((L - s) / k) + 1 : 0)   for k > 0, and the mirror for k < 0.
 *
 * Positive linear feedback distributes over set union, so the least fixed point is the set union of the seeds and
 * the step's first N images of them: the union of N + 1 unrolled levels, each the step over the
 * previous one. A bound on the next value, a bound under `r.or`, a parameter bound or seed, or an arm that advances
 * the counter by another step establishes no N here and keeps the recursive CTE; so does any arm of the step that
 * does not read the feedback, whose rows recur in every iteration.
 *
 * An unrolled level is inlined into its successors, so PostgreSQL may evaluate an expression of a later level on a row
 * an earlier level's filter would have removed, which the recursive CTE's working table never shows it. No expression
 * raises on such a row (every operation is total, scalar/compute/registry.ts Totality); unrolling is admitted when
 * every value the counter's steps compute for every seed, s + j·k for j up to N, lies in the range of every integer
 * carrier the counter passes through.
 */
export const counterBound = (dag: RelDag, rec: NodeOf<"Recursive">): CounterAnalysis => {
	const labels = nodesByLabel(dag)
	const analyses = rec.heading
		.filter((c) => integerRange(c.type) !== undefined)
		.map((c) => counterDepth(labels, rec, c.name))
	const best = analyses.reduce<CounterProof | undefined>(
		(chosen, a) =>
			a.kind === "bounded" && !(chosen !== undefined && chosen.depth <= a.proof.depth)
				? a.proof
				: chosen,
		undefined
	)
	if (best !== undefined) {
		return { kind: "bounded", proof: best }
	}
	const refusals = analyses.flatMap((a) =>
		a.kind === "unbounded" && a.reason !== "noCounter" ? [a.reason] : []
	)
	return { kind: "unbounded", reason: refusals[0] ?? "noCounter" }
}
