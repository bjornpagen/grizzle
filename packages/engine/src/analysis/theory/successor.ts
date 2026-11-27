/**
 * A successor read: the one row of a relation a rule's fold reads, found by one descent of a key's order.
 *
 * A rule that matches a relation M at every field of one of its keys but one, `f`, bound to a variable x of M's own,
 * holds x past a cut, `x > b` (or `x >= b`), b a term of values bound before, and folds x to its least in its head,
 * reads, of M's rows at those values, only the least one past the cut: the head's `min(x)` is that row's x, whatever
 * other rows past the cut hold, and the rule's other terms read nothing of M's rows (no other condition, match or head
 * term reads x or another variable of M's own, and the fold is the head's one aggregate), so a row of M past the least
 * changes no fact. Mirrored, a `max(x)` below a cut `x < b` reads the greatest. That row is the first a B-tree on the
 * key meets walking from the cut, its leading fields fixed: one descent (sql/ordered-probe.ts), where the rule as
 * written reads every row past the cut and folds them, P rows of M for each of P matches before it (ledger's
 * presentedSpans, each presentation's least later moment of its sitting, 180 to 244 pages a write).
 *
 * One recognizer decides it for every reader: the unit walk, which admits a stored relation whose rule reaches M so
 * (analysis/theory/unit.ts ruleClosure, StepBy `successor`), and navigation, which reads M by that one row
 * (analysis/theory/navigate.ts #chain, a step of the first row of M's order past the cut), so the cost admission
 * claims is the plan the statement runs.
 */

import type { Direction } from "#compiler/core/order.ts"
import { exprChildren, type InferredExpr, type InferredRule } from "#compiler/ir/desc.ts"

/** A successor read (see the header): the key field the fold reads, the variable bound there, and the walk's direction. */
export interface Successor {
	readonly field: string
	readonly variable: string
	/** `asc` for the least past a lower cut, a `min` above `>` or `>=`; `desc` for the greatest below an upper one. */
	readonly dir: Direction
}

/** The rule a read stands in, as the recognizer reads it. */
export interface SuccessorRule {
	readonly head: InferredRule["head"]
	/** Its conditions, each read by its conjuncts. */
	readonly conditions: ReadonlyArray<InferredExpr>
	/** Every other term of the rule that may read a variable of the read's: the other matches' bindings. */
	readonly beside: ReadonlyArray<InferredExpr>
}

/** The variables `e` reads at any depth, a relational filter's bindings among them. */
const readsIn = (e: InferredExpr): ReadonlyArray<string> =>
	e.kind === "var" ? [e.var] : exprChildren(e).flatMap((c) => readsIn(c.term))

/** The conjuncts of a condition, through every nested conjunction. */
const conjunctsIn = (e: InferredExpr): ReadonlyArray<InferredExpr> =>
	e.kind === "and" ? e.args.flatMap(conjunctsIn) : [e]

/** The comparisons that cut a fold's order at a bound, by the fold, with the variable on the left. */
const cuts: { readonly [F in "min" | "max"]: ReadonlySet<string> } = {
	min: new Set(["gt", "ge"]),
	max: new Set(["lt", "le"])
}

/** A comparison's operator with its sides swapped: `b < x` is `x > b`. */
const swapped: Readonly<Record<string, string>> = { lt: "gt", le: "ge", gt: "lt", ge: "le" }

/**
 * The successor read `bindings` is within `rule` (see the header), M's keys `keys`, `known` holding of a variable bound
 * before the read: undefined where any condition of it fails. A rule that states no cut reads M's first row at the key's other fields (its last, for a
 * greatest fold): the extreme of x there, one descent from the key's prefix (ledger's latestMoments, a sitting's latest
 * moment).
 */
export const successorOf = (
	bindings: Readonly<Record<string, InferredExpr>>,
	keys: ReadonlyArray<ReadonlyArray<string>>,
	rule: SuccessorRule,
	known: (variable: string) => boolean
): Successor | undefined => {
	const conjuncts = rule.conditions.flatMap(conjunctsIn)
	const bound = (e: InferredExpr): boolean => readsIn(e).every(known)
	const own = new Map<string, string>()
	for (const [field, e] of Object.entries(bindings)) {
		if (bound(e)) {
			continue
		}
		if (e.kind !== "var") {
			return undefined
		}
		own.set(e.var, field)
	}
	const [fold, ...more] = Object.values(rule.head).filter((h) => h.kind === "aggregate")
	if (fold === undefined || more.length > 0 || !("arg" in fold) || fold.arg.kind !== "var") {
		return undefined
	}
	const fn = fold.fn
	const variable = fold.arg.var
	const field = own.get(variable)
	if ((fn !== "min" && fn !== "max") || field === undefined) {
		return undefined
	}
	const prefixed = keys.some(
		(key) =>
			key.includes(field) &&
			key.every((f) => {
				const e = bindings[f]
				return f === field || (e !== undefined && bound(e))
			})
	)
	const reading = (e: InferredExpr): boolean => readsIn(e).some((v) => own.has(v))
	const [cut, ...others] = conjuncts.filter(reading)
	if (
		!prefixed ||
		others.length > 0 ||
		rule.beside.some(reading) ||
		Object.values(rule.head).some(
			(h) =>
				h !== fold &&
				(h.kind === "producer" ? h.args.some(reading) : h.kind !== "aggregate" && reading(h))
		)
	) {
		return undefined
	}
	const dir = fn === "min" ? "asc" : "desc"
	if (cut === undefined) {
		return { field, variable, dir }
	}
	if (cut.kind !== "compare") {
		return undefined
	}
	const [op, past] =
		cut.left.kind === "var" && cut.left.var === variable
			? [cut.op, cut.right]
			: cut.right.kind === "var" && cut.right.var === variable
				? [swapped[cut.op], cut.left]
				: [undefined, cut.left]
	return op === undefined || !cuts[fn].has(op) || reading(past) || !bound(past)
		? undefined
		: { field, variable, dir }
}
