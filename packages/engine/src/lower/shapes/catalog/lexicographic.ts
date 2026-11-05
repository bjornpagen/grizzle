import { firstIndex } from "#compiler/core/array.ts"
import type { ColumnRef, ScalarExpr } from "#compiler/ir/expr.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { columnRef, opView, required } from "#compiler/lower/shapes/catalog/exprs.ts"
import { firstOperand, nativeOp } from "#compiler/scalar/compute/registry.ts"

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
 *
 * The one fold engine reads it (ir/fold.ts), each connective waiting on a stack on the heap while its operands are
 * read, so a predicate nested to any depth never deepens the call stack. Operands are read in order and the first that
 * is no native comparison of one pair ends the parse, so the pairs are numbered in the order a reading of the operands
 * in turn meets them; an expression the predicate holds in two places is read once, one formula in both.
 */
const parse = (pred: ScalarExpr, classify: Classify, pairs: Array<Pair>): Formula | undefined =>
	new Fold<ScalarExpr, Formula | undefined>(function* (e) {
		const v = opView(e)
		const fn = v?.fn
		if (v === undefined || fn === undefined) {
			return undefined
		}
		if (fn === "and" || fn === "or") {
			const args: Array<Formula> = []
			for (const operand of v.args) {
				const f = yield operand
				if (f === undefined) {
					return undefined
				}
				args.push(f)
			}
			return { kind: fn, args }
		}
		if (fn === "not") {
			const [only] = v.args
			if (only === undefined) {
				return undefined
			}
			const arg = yield only
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
	}).of(pred)

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

/** One of the three signs of a pair, b - a under the pair's native order. */
type Sign = -1 | 0 | 1

/** A truth value of the predicate, once every pair it still tests is decided. */
interface Leaf {
	readonly kind: "leaf"
	readonly id: number
	readonly value: boolean
}

/** A test of one pair's sign, with the diagram for each sign; every pair it leads to is a later one. */
interface Test {
	readonly kind: "test"
	readonly id: number
	readonly pair: number
	readonly below: Diagram
	readonly equal: Diagram
	readonly above: Diagram
}

/**
 * A reduced ordered decision diagram over the pairs' signs (Bryant's, three-way): the pairs tested in first-use order,
 * no test whose three children are one diagram, and no two tests of one pair over the same children. It is canonical:
 * two formulas compute one function of the sign vector exactly when they build one diagram.
 */
type Diagram = Leaf | Test

const child = (t: Test, sign: Sign): Diagram => (sign < 0 ? t.below : sign > 0 ? t.above : t.equal)

/**
 * An operation on diagrams: the negation of a test, the conjunction or disjunction of two tests (`x` the one made
 * first), or a test of an earlier pair than `pair` with that pair's sign fixed to `sign`. Each is one object per
 * operation and operands (Diagrams #operation), so the fold that computes it keeps its diagram by that object.
 */
type Operation =
	| { readonly kind: "negate"; readonly test: Test }
	| { readonly kind: "apply"; readonly op: "and" | "or"; readonly x: Test; readonly y: Test }
	| { readonly kind: "restrict"; readonly test: Test; readonly pair: number; readonly sign: Sign }

/** What the fold of a recognition computes a diagram of: a formula, or an operation on diagrams. */
type Vertex = Formula | Operation

/**
 * The diagrams of one predicate, built and shared within one recognition: each test is made once per pair and children
 * (the unique table), and each operation is one object per operands, computed once by the one fold engine
 * (ir/fold.ts), so a diagram is never built twice. The fold keeps the operations it is inside on a stack on the heap, so
 * neither a formula nested to any depth nor a diagram over any number of pairs deepens the call stack; each step reads
 * its operands in the order a recursion would, so every test is made, and numbered, in that order.
 */
class Diagrams {
	readonly #truth: Leaf = { kind: "leaf", id: 0, value: true }
	readonly #falsity: Leaf = { kind: "leaf", id: 1, value: false }
	#next = 2
	readonly #unique = new Map<string, Test>()
	readonly #operations = new Map<string, Operation>()
	readonly #fold = new Fold<Vertex, Diagram>((v) => this.#step(v))

	/** The diagram of `f`. */
	of(f: Formula): Diagram {
		return this.#fold.of(f)
	}

	/** The diagram `d` with `pair`'s sign fixed to `sign`. */
	restrict(d: Diagram, pair: number, sign: Sign): Diagram {
		return drive(this.#restrict(d, pair, sign), (v) => this.#fold.of(v))
	}

	#leaf(value: boolean): Leaf {
		return value ? this.#truth : this.#falsity
	}

	#test(pair: number, below: Diagram, equal: Diagram, above: Diagram): Diagram {
		if (below === equal && equal === above) {
			return below
		}
		const key = `${pair}/${below.id}/${equal.id}/${above.id}`
		const known = this.#unique.get(key)
		if (known !== undefined) {
			return known
		}
		const made: Test = { kind: "test", id: this.#next++, pair, below, equal, above }
		this.#unique.set(key, made)
		return made
	}

	/** The one object of the operation `key` names, `operation` when it is the first. */
	#operation(key: string, operation: Operation): Operation {
		const known = this.#operations.get(key)
		if (known !== undefined) {
			return known
		}
		this.#operations.set(key, operation)
		return operation
	}

	/** The fold's step: the diagram of a vertex, from the diagrams of the vertices it yields. */
	*#step(v: Vertex): Generator<Vertex, Diagram, Diagram> {
		switch (v.kind) {
			case "atom":
				return this.#test(
					v.pair,
					this.#leaf(holds(v.cmp, -1)),
					this.#leaf(holds(v.cmp, 0)),
					this.#leaf(holds(v.cmp, 1))
				)
			case "not": {
				const d = yield v.arg
				return yield* this.#not(d)
			}
			case "and":
			case "or": {
				const op = v.kind
				let acc: Diagram = this.#leaf(op === "and")
				for (const a of v.args) {
					const d = yield a
					acc = yield* this.#apply(op, acc, d)
				}
				return acc
			}
			case "negate": {
				const t = v.test
				const below = yield* this.#not(t.below)
				const equal = yield* this.#not(t.equal)
				const above = yield* this.#not(t.above)
				return this.#test(t.pair, below, equal, above)
			}
			case "apply": {
				const { op, x, y } = v
				const pair = Math.min(x.pair, y.pair)
				const at = (d: Test, sign: Sign): Diagram => (d.pair === pair ? child(d, sign) : d)
				const below = yield* this.#apply(op, at(x, -1), at(y, -1))
				const equal = yield* this.#apply(op, at(x, 0), at(y, 0))
				const above = yield* this.#apply(op, at(x, 1), at(y, 1))
				return this.#test(pair, below, equal, above)
			}
			case "restrict": {
				const { test: t, pair, sign } = v
				const below = yield* this.#restrict(t.below, pair, sign)
				const equal = yield* this.#restrict(t.equal, pair, sign)
				const above = yield* this.#restrict(t.above, pair, sign)
				return this.#test(t.pair, below, equal, above)
			}
		}
	}

	/** The negation of `d`: a leaf's at once, a test's by its operation. */
	*#not(d: Diagram): Generator<Vertex, Diagram, Diagram> {
		if (d.kind === "leaf") {
			return this.#leaf(!d.value)
		}
		return yield this.#operation(`n${d.id}`, { kind: "negate", test: d })
	}

	/** `a` and `b`, or `a` or `b`: with a leaf, or of one diagram, at once; of two tests, by their operation. */
	*#apply(op: "and" | "or", a: Diagram, b: Diagram): Generator<Vertex, Diagram, Diagram> {
		if (a.kind === "leaf") {
			return this.#withLeaf(op, a, b)
		}
		if (b.kind === "leaf") {
			return this.#withLeaf(op, b, a)
		}
		if (a === b) {
			return a
		}
		const [x, y] = a.id < b.id ? [a, b] : [b, a]
		return yield this.#operation(`${op}${x.id},${y.id}`, { kind: "apply", op, x, y })
	}

	/** `leaf` and `other`, or `leaf` or `other`. */
	#withLeaf(op: "and" | "or", leaf: Leaf, other: Diagram): Diagram {
		return op === "and" ? (leaf.value ? other : this.#falsity) : leaf.value ? this.#truth : other
	}

	/**
	 * `d` with `pair`'s sign fixed to `sign`: a leaf or a test of a later pair as it is, a test of `pair` its child at
	 * `sign`, a test of an earlier pair by its operation.
	 */
	*#restrict(d: Diagram, pair: number, sign: Sign): Generator<Vertex, Diagram, Diagram> {
		if (d.kind === "leaf" || d.pair > pair) {
			return d
		}
		if (d.pair === pair) {
			return child(d, sign)
		}
		return yield this.#operation(`r${d.id}:${pair}:${sign}`, {
			kind: "restrict",
			test: d,
			pair,
			sign
		})
	}
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
 * of the order.
 *
 * Complete for every arrangement of every number of pairs: each question the recursion asks (is the predicate
 * constant once the pairs chosen so far tie, and is it constant on each side of one more) is a property of the
 * function the predicate computes, which its decision diagram (Diagrams) represents exactly and canonically, so a
 * question is answered by restricting the diagram and asking whether a leaf is left: the answer every sign vector's
 * evaluation would give, without evaluating 3^pairs of them. The work is polynomial in the diagrams built, a few tests
 * per pair for the lexicographic spellings, since the nested expansion and its disjunctive normal form test the pairs
 * in first-use order. No method is polynomial for every arrangement: whether one is lexicographic is coNP-hard. For a
 * formula φ over atoms `b < a` of distinct pairs and two pairs p and q it does not read, `p.b < p.a and (φ or q.b <
 * q.a)` is lexicographic (the strict order of p alone) exactly when φ is a tautology: otherwise no pair decides it
 * whenever its fields differ, since p's does not once φ and q's comparison can both be false, and every other pair's
 * leaves it varying with p's.
 */
export const lexicographicOrder = (pred: ScalarExpr, classify: Classify): LexOrder | undefined => {
	const pairs: Array<Pair> = []
	const formula = parse(pred, classify, pairs)
	if (formula === undefined || pairs.length === 0) {
		return undefined
	}
	const diagrams = new Diagrams()
	const order: Array<Pair & { dir: "asc" | "desc" }> = []
	let remaining: ReadonlyArray<number> = [...pairs.keys()]
	/** The direction pair `c` decides the predicate in whenever its fields differ, given the pairs tied so far. */
	const decision = (current: Diagram, c: number): "asc" | "desc" | undefined => {
		const below = diagrams.restrict(current, c, -1)
		const above = diagrams.restrict(current, c, 1)
		if (below.kind !== "leaf" || above.kind !== "leaf" || below.value === above.value) {
			return undefined
		}
		return below.value ? "asc" : "desc"
	}
	const decide = (
		current: Diagram
	): { readonly index: number; readonly dir: "asc" | "desc" } | undefined => {
		for (const c of remaining) {
			const dir = decision(current, c)
			if (dir !== undefined) {
				return { index: c, dir }
			}
		}
		return undefined
	}
	for (let current = diagrams.of(formula); ;) {
		if (current.kind === "leaf") {
			return { order, inclusive: current.value }
		}
		const chosen = decide(current)
		if (chosen === undefined) {
			return undefined
		}
		order.push({
			...required(pairs[chosen.index], `the pair ${chosen.index}`),
			dir: chosen.dir
		})
		current = diagrams.restrict(current, chosen.index, 0)
		remaining = remaining.filter((p) => p !== chosen.index)
	}
}
