import {
	AllenReading,
	allenExpr,
	joinedPairs,
	type PairJoin,
	type PairPredicate,
	samePair
} from "#compiler/check/allen.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { RootedDag } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

/** The operands of one connective over one pair, in their order, beside the first one's predicate. */
interface PairSlot {
	readonly kind: "pair"
	readonly first: PairPredicate
	readonly members: Array<ScalarExpr>
}

type Slot = PairSlot | { readonly kind: "other"; readonly expr: ScalarExpr }

/** The normalization of the predicates of one editor's DAG. */
class Normalizer {
	readonly #editor: DagEditor
	readonly #reading = new AllenReading()

	constructor(editor: DagEditor) {
		this.#editor = editor
	}

	#emit(p: PairPredicate, bool: ScalarType): ScalarExpr {
		return allenExpr(p.mask, p.a.expr, p.b.expr, p.a.carrier, bool, (spec) =>
			this.#editor.expr(spec)
		)
	}

	/** `e` in Allen normal form: `e` itself where nothing in it changes. */
	normal(e: ScalarExpr): ScalarExpr {
		const whole = this.#reading.pair(e)
		if (whole !== undefined) {
			return whole.endpoint ? this.#emit(whole, e.type) : e
		}
		if (e.kind !== "op") {
			return e
		}
		const fn = nativeOp(e.op)?.fn
		if (fn !== "not" && fn !== "and" && fn !== "or") {
			return e
		}
		const args =
			fn === "not" ? e.args.map((a) => this.normal(a)) : this.#connective(e.args, fn, e.type)
		if (args.length === e.args.length && args.every((a, i) => a === e.args[i])) {
			return e
		}
		return this.#editor.expr({ ...e, args })
	}

	/**
	 * A connective's operands: those over one pair, with an endpoint among them, as one mask at the first
	 * one's place; every other operand normalized inside.
	 */
	#connective(
		args: ReadonlyArray<ScalarExpr>,
		join: PairJoin,
		bool: ScalarType
	): ReadonlyArray<ScalarExpr> {
		const slots: Array<Slot> = []
		const pairs: Array<PairSlot> = []
		for (const arg of args) {
			const p = this.#reading.pair(arg)
			if (p === undefined) {
				slots.push({ kind: "other", expr: arg })
				continue
			}
			const slot = pairs.find((s) => samePair(s.first, p))
			if (slot !== undefined) {
				slot.members.push(arg)
				continue
			}
			const made: PairSlot = { kind: "pair", first: p, members: [arg] }
			pairs.push(made)
			slots.push(made)
		}
		return slots.flatMap((slot): ReadonlyArray<ScalarExpr> => {
			if (slot.kind === "other") {
				return [this.normal(slot.expr)]
			}
			const group = joinedPairs(
				slot.members.map((m) => this.#reading.pair(m)),
				join
			)
			return group?.endpoint === true ? [this.#emit(group, bool)] : slot.members
		})
	}
}

/**
 * The endpoint comparisons and memberships between two spans among `roots`' expressions: what a normalization leaves
 * none of in the combinations it rewrites, so it is the measure every application of simplify.allen decreases.
 */
export const endpointPredicates = (roots: ReadonlyArray<ScalarExpr>): number => {
	const reading = new AllenReading()
	let count = 0
	for (const e of exprClosure(roots)) {
		if (reading.leaf(e)?.endpoint === true) {
			count++
		}
	}
	return count
}

/**
 * `pred` in Allen normal form over the editor's DAG, or undefined where it is in normal form already: a rewrite that
 * leaves as many endpoint predicates as it found changes nothing a reader of the filter sees.
 *
 * The Allen normal form of a filter's predicate: every boolean combination of predicates over one pair of spans that
 * states an endpoint comparison or membership, written as the table formula of its Allen mask.
 *
 * A predicate over one pair of spans is its mask (check/allen.ts), so an endpoint spelling of a relation between two
 * spans is no special case: written as the mask's table formula, its range operators are what the access extraction
 * reads as a span atom and a GiST index drives, where `lower(card) > lower(month)` was an operand computed from a local
 * column, which no index serves.
 *
 * - Within each conjunction and disjunction, the operands that are predicates over one unordered pair, at least one of
 *   them stating an endpoint, become one mask, oriented as the first of them states its pair: A is the span whose
 *   endpoint it compares first or tests as the point, or an Allen formula's left span, the side a GiST index drives.
 *   A combination over one pair that states no endpoint is an Allen formula the checker wrote and stays as it is.
 *   Every other operand is normalized inside, and every other predicate is untouched.
 * - The empty mask is the false literal and the full mask the true literal, which folding (rules.ts simplify.fold)
 *   decides in its connective; every other mask is its table formula (check/allen.ts allenExpr).
 * - An empty or full mask drops the evaluation of its operands, none of which raises.
 *
 * It runs in the optimized lowering only, as the simplification rule simplify.allen (rules.ts), before predicate
 * movement and every other rewrite reads the filter. The conservative lowering, the differential's comparator, keeps
 * the endpoint form as written, so the optimized-vs-conservative differential judges the rewrite on every generated
 * query that states one. The workload compiler reads each query's checked IR in this normal form (allenNormalDag), so
 * the access extraction plans the span index the optimized artifact's formula is read through.
 */
export const allenNormal = (editor: DagEditor, pred: ScalarExpr): ScalarExpr | undefined => {
	const normal = new Normalizer(editor).normal(pred)
	return normal !== pred && endpointPredicates([normal]) < endpointPredicates([pred])
		? normal
		: undefined
}

/**
 * A query's checked DAG with every filter's predicate in Allen normal form: what the access extraction reads of a
 * query, whose optimized lowering puts every filter in this form first.
 */
export const allenNormalDag = (dag: RootedDag): Result.Result<RootedDag, CompileError> =>
	catchRefusal(() => {
		const editor = new DagEditor(dag)
		for (const cell of editor.topoOrder()) {
			const node = cell.current
			if (node.kind !== "Filter") {
				continue
			}
			const pred = allenNormal(editor, node.pred)
			if (pred !== undefined) {
				editor.set(cell, { ...node, pred })
			}
		}
		return editor.version === 0 ? dag : editor.finish()
	})
