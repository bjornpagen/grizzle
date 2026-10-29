import { firstIndex } from "#compiler/core/array.ts"
import type { ColumnRef, ScalarExpr } from "#compiler/ir/expr.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { columnRef, opView, required } from "#compiler/lower/shapes/catalog/exprs.ts"
import { firstOperand, nativeOp } from "#compiler/scalar/compute/registry.ts"

const maxPairs = 6

type Side = "a" | "b"

/**
 * Which side a field belongs to and its identity there, or none when the column is no compared field. A pair is
 * the `b` field and the `a` field one atom compares; each field belongs to at most one pair, so the signs of the
 * pairs are independent.
 */
type Classify = (ref: ColumnRef) => { readonly side: Side; readonly id: string } | undefined

interface Pair {
	readonly b: string
	readonly a: string
}

type Cmp = "eq" | "ne" | "lt" | "le" | "gt" | "ge"

/** b <cmp> a. */
type Formula =
	| { readonly kind: "and" | "or"; readonly args: ReadonlyArray<Formula> }
	| { readonly kind: "not"; readonly arg: Formula }
	| { readonly kind: "atom"; readonly pair: number; readonly cmp: Cmp }

const flip: Readonly<Record<Cmp, Cmp>> = {
	eq: "eq",
	ne: "ne",
	lt: "gt",
	le: "ge",
	gt: "lt",
	ge: "le"
}

const isCmp = (fn: string): fn is Cmp =>
	fn === "eq" || fn === "ne" || fn === "lt" || fn === "le" || fn === "gt" || fn === "ge"

interface LexOrder {
	/** The pairs in priority order with their directions: under "asc" b precedes a when b < a. */
	readonly order: ReadonlyArray<Pair & { readonly dir: "asc" | "desc" }>
	readonly inclusive: boolean
}

/**
 * Parses a predicate over paired fields, or none when some part of it is not a native comparison of one pair. Each
 * pair it compares is added to `pairs`, numbered in first-use order.
 *
 * A field compared with two different fields would make the pairs' signs dependent.
 */
const parse = (e: ScalarExpr, classify: Classify, pairs: Array<Pair>): Formula | undefined => {
	const v = opView(e)
	const fn = v?.fn
	if (v === undefined || fn === undefined) {
		return undefined
	}
	if (fn === "and" || fn === "or") {
		const args: Array<Formula> = []
		for (const a of v.args) {
			const f = parse(a, classify, pairs)
			if (f === undefined) {
				return undefined
			}
			args.push(f)
		}
		return { kind: fn, args }
	}
	if (fn === "not") {
		const [only] = v.args
		const arg = only === undefined ? undefined : parse(only, classify, pairs)
		return arg === undefined ? undefined : { kind: "not", arg }
	}
	const [l, r] = v.args
	if (!isCmp(fn) || v.args.length !== 2 || l === undefined || r === undefined) {
		return undefined
	}
	const lRef = columnRef(l)
	const rRef = columnRef(r)
	const lc = lRef === undefined ? undefined : classify(lRef)
	const rc = rRef === undefined ? undefined : classify(rRef)
	if (lc === undefined || rc === undefined || lc.side === rc.side) {
		return undefined
	}
	const b = lc.side === "b" ? lc.id : rc.id
	const a = lc.side === "a" ? lc.id : rc.id
	/** One carrier on both sides under its own native comparison. */
	const carrier = baseOf(l.type).carrier
	const native = nativeOp(v.op)
	if (
		baseOf(r.type).carrier !== carrier ||
		native === undefined ||
		firstOperand(native.operands) !== carrier
	) {
		return undefined
	}
	let index = firstIndex(pairs, (p) => p.b === b && p.a === a)
	if (index === undefined) {
		if (pairs.some((p) => p.b === b || p.a === a)) {
			return undefined
		}
		pairs.push({ b, a })
		index = pairs.length - 1
	}
	return { kind: "atom", pair: index, cmp: lc.side === "b" ? fn : flip[fn] }
}

const holds = (cmp: Cmp, sign: number): boolean => {
	switch (cmp) {
		case "eq":
			return sign === 0
		case "ne":
			return sign !== 0
		case "lt":
			return sign < 0
		case "le":
			return sign <= 0
		case "gt":
			return sign > 0
		case "ge":
			return sign >= 0
	}
}

const evaluate = (f: Formula, signs: ReadonlyArray<number>): boolean => {
	switch (f.kind) {
		case "and":
			return f.args.every((a) => evaluate(a, signs))
		case "or":
			return f.args.some((a) => evaluate(a, signs))
		case "not":
			return !evaluate(f.arg, signs)
		case "atom":
			return holds(f.cmp, required(signs[f.pair], `a sign for the pair ${f.pair}`))
	}
}

/** Every assignment of -1, 0, 1 to `free`, the other pairs as `fixed`. */
const assignments = function* (
	count: number,
	free: ReadonlyArray<number>,
	fixed: ReadonlyMap<number, number>
) {
	const signs = [...Array.from({ length: count }).keys()].map((i) => fixed.get(i) ?? 0)
	const total = 3 ** free.length
	for (let n = 0; n < total; n++) {
		let m = n
		for (const p of free) {
			signs[p] = (m % 3) - 1
			m = Math.floor(m / 3)
		}
		yield signs
	}
}

/**
 * The one value `formula` takes over every assignment of the `free` pairs, or none when it varies. There is always
 * at least one assignment, the empty one when nothing is free.
 */
const constantOver = (
	formula: Formula,
	count: number,
	free: ReadonlyArray<number>,
	fixed: ReadonlyMap<number, number>
): boolean | undefined => {
	const values = new Set<boolean>()
	for (const signs of assignments(count, free, fixed)) {
		values.add(evaluate(formula, signs))
	}
	const [only] = values
	return values.size === 1 && only !== undefined ? only : undefined
}

/**
 * The lexicographic order a predicate states between the `b` and `a` fields of its pairs ("b precedes a"), or
 * none when it is not one.
 *
 * Recognizing a lexicographic comparison of two tuples.
 *
 * The catalog's shared condition: "the comparison is exactly the lexicographic comparison of that tuple under each
 * field's native B-tree order and collation". A composition may spell that comparison in any Boolean arrangement of
 * native comparisons between paired fields: the nested expansion, its disjunctive normal form, operands
 * swapped, inclusive or strict. The recognizer does not pattern-match one spelling. It decides the predicate's truth
 * table instead: every atom compares the `b` field of one pair with the `a` field of the same pair, both of one
 * carrier under its native B-tree comparison, so the atom's truth depends only on the sign of b - a in that order,
 * and the predicate is a function of the sign vector, one of -1, 0, 1 per pair. Native B-tree comparison is a total
 * order on every carrier the vocabulary orders, NaN included, and it is the order a window's ORDER BY uses.
 *
 * The predicate is "b precedes a" under a lexicographic order exactly when, recursively, some pair decides it
 * whenever its fields differ, the strictly smaller side preceding under that pair's direction, and the remaining
 * pairs decide the ties the same way. The recursion yields the order (pair and direction, first pair first) and
 * whether equal tuples satisfy it: inclusive (<=) or strict (<). Pairs the predicate never depends on are not part
 * of the order. The search evaluates at most 3^pairs sign vectors per step over at most `maxPairs` pairs, a fixed
 * bound.
 */
export const lexicographicOrder = (pred: ScalarExpr, classify: Classify): LexOrder | undefined => {
	const pairs: Array<Pair> = []
	const formula = parse(pred, classify, pairs)
	if (formula === undefined || pairs.length === 0 || pairs.length > maxPairs) {
		return undefined
	}
	const count = pairs.length
	const order: Array<Pair & { dir: "asc" | "desc" }> = []
	const fixed = new Map<number, number>()
	let remaining: ReadonlyArray<number> = [...pairs.keys()]
	/** The direction pair `c` decides the predicate in whenever its fields differ, given the pairs fixed so far. */
	const decision = (c: number): "asc" | "desc" | undefined => {
		const others = remaining.filter((p) => p !== c)
		const below = constantOver(formula, count, others, new Map(fixed).set(c, -1))
		const above = constantOver(formula, count, others, new Map(fixed).set(c, 1))
		if (below === undefined || above === undefined || below === above) {
			return undefined
		}
		return below ? "asc" : "desc"
	}
	const decide = (): { readonly index: number; readonly dir: "asc" | "desc" } | undefined => {
		for (const c of remaining) {
			const dir = decision(c)
			if (dir !== undefined) {
				return { index: c, dir }
			}
		}
		return undefined
	}
	for (;;) {
		/** Constant over the remaining pairs: the tuple ends here. */
		const constant = constantOver(formula, count, remaining, fixed)
		if (constant !== undefined) {
			return { order, inclusive: constant }
		}
		const chosen = decide()
		if (chosen === undefined) {
			return undefined
		}
		order.push({
			...required(pairs[chosen.index], `the pair ${chosen.index}`),
			dir: chosen.dir
		})
		fixed.set(chosen.index, 0)
		remaining = remaining.filter((p) => p !== chosen.index)
	}
}
