import {
	boolean,
	element,
	type Gen,
	int,
	oneOf,
	subarray,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { assert } from "#test/support/assert.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * A world of closed relations over two rosters, Kind (k0 … k(K−1)) and Flag (f0 … f(F−1)), in which a read finds no
 * row at some keys:
 *
 * - Pick: at each kind it holds, a payload of a flag, an integer, a numeric(3, 1) in tenths, a text, a boolean, a double
 *   precision and a real;
 * - Wt: at each flag it holds, an integer weight;
 * - Succ: at each flag it holds, a flag, so a flag read at a flag Pick reads NULL at is a read at a NULL key;
 * - Next: each flag's completions, empty for a flag it completes nowhere;
 * - Allowed: the flags each kind admits, the target of a selection's containment.
 *
 * No closed relation holds a span (closed.relation refuses a span field), so a span never reads NULL: a span's endpoint
 * meets a NULL only beside a NULL operand of its parent.
 */
export interface World {
	readonly kinds: number
	readonly flags: number
	readonly pick: ReadonlyArray<Payload | undefined>
	readonly weight: ReadonlyArray<number | undefined>
	readonly succ: ReadonlyArray<number | undefined>
	readonly next: ReadonlyArray<ReadonlyArray<number>>
	readonly allowed: ReadonlyArray<ReadonlyArray<number>>
}

/** Pick's payload at a kind: a flag's code, an integer, a numeric in tenths, a text, a boolean and two floats. */
interface Payload {
	readonly flag: number
	readonly n: number
	readonly d: number
	readonly t: string
	readonly b: boolean
	readonly x: number
	readonly y: number
}

/**
 * A row of every open relation: its kind's and flag's codes, a set of flags, two integers, a numeric in tenths, a
 * text, a boolean, a double precision, a real and a span of integers [start, end).
 */
export interface Item {
	readonly kind: number
	readonly flag: number
	readonly flags: ReadonlyArray<number>
	readonly n: number
	readonly m: number
	readonly d: number
	readonly t: string
	readonly b: boolean
	readonly x: number
	readonly y: number
	readonly s: readonly [start: number, end: number]
}

/**
 * The sorts of the language's terms, each a type grizzle types a term at: an integer (pg.integer), an exact integer
 * (integer arithmetic's result), a bigint, a numeric, a text, a closed id of Flag, a set of Flag, a boolean, a double
 * precision (f8) and a real (f4).
 */
export type Sort = "int" | "exact" | "big" | "num" | "text" | "code" | "set" | "bool" | "f8" | "f4"

/** The float sorts. */
export type FloatSort = "f8" | "f4"

/** A row field and its sort. */
const fieldSorts = {
	n: "int",
	m: "int",
	d: "num",
	t: "text",
	flag: "code",
	flags: "set",
	b: "bool",
	x: "f8",
	y: "f4"
} as const satisfies Readonly<Record<string, Sort>>
type Field = keyof typeof fieldSorts

/** Pick's payload fields and their sorts. */
const pickSorts = {
	n: "int",
	d: "num",
	t: "text",
	flag: "code",
	b: "bool",
	x: "f8",
	y: "f4"
} as const satisfies Readonly<Record<keyof Payload, Sort>>
export type PickField = keyof typeof pickSorts

/** Where a Pick read takes its kind: the row's own, or a handle written in the term. */
export type KindKey = { readonly k: "own" } | { readonly k: "handle"; readonly code: number }

/** A literal of a sort: an integer, tenths of a numeric, a text, a flag's code, a set's codes, a boolean, a float. */
export type Literal =
	| { readonly sort: "int" | "big" | FloatSort; readonly value: number }
	| { readonly sort: "num"; readonly tenths: number }
	| { readonly sort: "text"; readonly value: string }
	| { readonly sort: "code"; readonly code: number }
	| { readonly sort: "set"; readonly codes: ReadonlyArray<number> }
	| { readonly sort: "bool"; readonly value: boolean }

/** A literal of a list: an integer of any integer sort, tenths, a text, a flag's code or a float. */
export type ListLiteral =
	| { readonly sort: "int" | "exact" | "big" | FloatSort; readonly value: number }
	| { readonly sort: "num"; readonly tenths: number }
	| { readonly sort: "text"; readonly value: string }
	| { readonly sort: "code"; readonly code: number }

export type CompareOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge"

/**
 * A term. Its sort follows from its shape and its operands' sorts (sortOf). The NULL sources are `at`, `weight` and
 * `row`, closed reads at a key their relation holds no row at, or at a NULL key; every other operation yields NULL
 * from a NULL operand by its SQL semantics, but where it decides otherwise: a conditional, a guard and an extremum.
 */
export type Term =
	| { readonly t: "field"; readonly field: Field }
	| { readonly t: "lit"; readonly literal: Literal }
	| { readonly t: "at"; readonly field: PickField; readonly key: KindKey }
	| { readonly t: "weight"; readonly flag: Term }
	| { readonly t: "succ"; readonly flag: Term }
	| { readonly t: "singleton"; readonly a: Term }
	| { readonly t: "row"; readonly flag: Term }
	| { readonly t: "arith"; readonly op: "add" | "sub" | "mul"; readonly a: Term; readonly b: Term }
	| {
			readonly t: "farith"
			readonly op: "add" | "sub" | "mul" | "div"
			readonly a: Term
			readonly b: Term
	  }
	| { readonly t: "tofloat"; readonly e: Term }
	| { readonly t: "unary"; readonly op: "neg" | "abs" | "sign"; readonly a: Term }
	| {
			readonly t: "extremum"
			readonly op: "greatest" | "least"
			readonly a: Term
			readonly b: Term
	  }
	| { readonly t: "cond"; readonly p: Pred; readonly a: Term; readonly b: Term }
	| {
			readonly t: "divide"
			readonly op: "div" | "mod"
			readonly a: Term
			readonly d: Term
			readonly o: Term
	  }
	| { readonly t: "narrow"; readonly e: Term; readonly o: Term }
	| { readonly t: "widen"; readonly e: Term }
	| { readonly t: "concat"; readonly a: Term; readonly b: Term }
	| { readonly t: "charLength"; readonly a: Term }
	| {
			readonly t: "affix"
			readonly op: "startsWith" | "endsWith"
			readonly a: Term
			readonly b: Term
	  }
	| {
			readonly t: "setop"
			readonly op: "union" | "intersection" | "difference"
			readonly a: Term
			readonly b: Term
	  }
	| { readonly t: "card"; readonly a: Term }
	| {
			readonly t: "settest"
			readonly op: "subset" | "disjoint"
			readonly a: Term
			readonly b: Term
	  }
	| { readonly t: "endpoint"; readonly op: "lower" | "upper" | "width" }

/**
 * The key a presence reads, `C.has`: Pick's at a kind, never NULL; Wt's at a flag term; Next's at two flag terms. A
 * flag term is NULL where it reads a closed relation at an absent or a NULL key, so a key value is NULL in each key
 * position of a one-field and a two-field key.
 */
export type HasKey =
	| { readonly rel: "pick"; readonly key: KindKey }
	| { readonly rel: "wt"; readonly flag: Term }
	| { readonly rel: "next"; readonly from: Term; readonly to: Term }

/** A predicate: a comparison, BETWEEN, IN over a list of literals, a presence, and AND, OR and NOT. */
export type Pred =
	| { readonly p: "cmp"; readonly op: CompareOp; readonly a: Term; readonly b: Term }
	| { readonly p: "has"; readonly key: HasKey }
	| { readonly p: "between"; readonly a: Term; readonly lo: Term; readonly hi: Term }
	| { readonly p: "in"; readonly a: Term; readonly values: NonEmptyReadonlyArray<ListLiteral> }
	| { readonly p: "and" | "or"; readonly args: readonly [Pred, Pred] }
	| { readonly p: "not"; readonly arg: Pred }

/** The bound a narrowing's `within` guard states, either side of zero. */
export const narrowBound = 1000

/** The sort two operands of one comparison or conditional meet at, or undefined where they never meet. */
const meet = (a: Sort, b: Sort): Sort | undefined =>
	a === b
		? a
		: (a === "exact" && (b === "int" || b === "big")) ||
			  (b === "exact" && (a === "int" || a === "big"))
			? "exact"
			: undefined

/** A term's sort. */
export const sortOf = (term: Term): Sort => {
	switch (term.t) {
		case "field":
			return fieldSorts[term.field]
		case "lit":
			return term.literal.sort
		case "at":
			return pickSorts[term.field]
		case "weight":
		case "narrow":
		case "charLength":
			return "int"
		case "succ":
			return "code"
		case "row":
		case "setop":
		case "singleton":
			return "set"
		case "arith":
			return sortOf(term.a) === "num" ? "num" : "exact"
		case "unary": {
			const operand = sortOf(term.a)
			return operand === "num" || operand === "f8" || operand === "f4"
				? operand
				: term.op === "sign"
					? operand
					: "exact"
		}
		case "farith":
			return sortOf(term.a)
		case "tofloat":
			return "f8"
		case "extremum":
		case "cond":
			return meet(sortOf(term.a), sortOf(term.b)) ?? sortOf(term.a)
		case "divide":
			return term.op === "div" ? "exact" : "int"
		case "widen":
		case "card":
			return "big"
		case "concat":
			return "text"
		case "affix":
		case "settest":
			return "bool"
		case "endpoint":
			return term.op === "width" ? "exact" : "int"
	}
}

/** Whether a term reads a closed relation anywhere in it, its conditions' terms included. */
export const readsClosed = (term: Term): boolean => {
	switch (term.t) {
		case "at":
		case "weight":
		case "row":
		case "succ":
			return true
		case "field":
		case "lit":
		case "endpoint":
			return false
		case "unary":
		case "charLength":
		case "card":
		case "singleton":
			return readsClosed(term.a)
		case "widen":
		case "tofloat":
			return readsClosed(term.e)
		case "narrow":
			return readsClosed(term.e) || readsClosed(term.o)
		case "arith":
		case "farith":
		case "extremum":
		case "concat":
		case "affix":
		case "setop":
		case "settest":
			return readsClosed(term.a) || readsClosed(term.b)
		case "cond":
			return predReadsClosed(term.p) || readsClosed(term.a) || readsClosed(term.b)
		case "divide":
			return readsClosed(term.a) || readsClosed(term.d) || readsClosed(term.o)
	}
}

/** Whether a predicate reads a closed relation anywhere in it. */
const predReadsClosed = (pred: Pred): boolean => {
	switch (pred.p) {
		case "cmp":
			return readsClosed(pred.a) || readsClosed(pred.b)
		case "between":
			return readsClosed(pred.a) || readsClosed(pred.lo) || readsClosed(pred.hi)
		case "in":
			return readsClosed(pred.a)
		case "has":
			return true
		case "and":
		case "or":
			return predReadsClosed(pred.args[0]) || predReadsClosed(pred.args[1])
		case "not":
			return predReadsClosed(pred.arg)
	}
}

/**
 * Where a term or predicate stands, which decides its vocabulary: a check's (a row check, a selection, a generated
 * field, a fold's step), whose operations are those the host evaluates, or a query's, which also admits least.
 */
type Vocabulary = "check" | "query"

/** The text at index i over {a, b} in bijective base 2: "", "a", "b", "aa", "ab", "ba", "bb", … */
const textAt = (i: number): string =>
	i === 0 ? "" : `${textAt(Math.floor((i - 1) / 2))}${i % 2 === 1 ? "a" : "b"}`

const smallInt = int(-2, 3)

/**
 * The floats the language draws, those float4 and float8 hold exactly: zero, two finite values of either sign, and
 * the special values whose order and arithmetic PostgreSQL defines apart (NaN above every number and equal to
 * itself, the infinities).
 */
const floatValues: NonEmptyReadonlyArray<number> = [
	0,
	0.5,
	-1.5,
	2,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	Number.NaN
]
const floatGen: Gen<number> = element(floatValues)
const tenthsGen: Gen<number> = (s) => s.draw(int(-3, 3)) * 5
const textGen: Gen<string> = (s) => textAt(s.draw(int(0, 6)))

/** Codes 0 … n − 1. */
const codesBelow = (n: number): ReadonlyArray<number> => upTo(n, (code) => code)

const payloadGen =
	(flags: number): Gen<Payload> =>
	(s) => ({
		flag: s.draw(int(0, flags - 1)),
		n: s.draw(smallInt),
		d: s.draw(tenthsGen),
		t: s.draw(textGen),
		b: s.draw(boolean),
		x: s.draw(floatGen),
		y: s.draw(floatGen)
	})

/** A world of one to three kinds and one to four flags, each closed relation holding a drawn part of its keys. */
export const worldGen: Gen<World> = (s) => {
	const kinds = s.draw(int(1, 3))
	const flags = s.draw(int(1, 4))
	const codes = codesBelow(flags)
	return {
		kinds,
		flags,
		pick: Arr.map(codesBelow(kinds), () =>
			s.draw(boolean) ? s.draw(payloadGen(flags)) : undefined
		),
		weight: Arr.map(codes, () => (s.draw(boolean) ? s.draw(smallInt) : undefined)),
		succ: Arr.map(codes, () => (s.draw(boolean) ? s.draw(int(0, flags - 1)) : undefined)),
		next: Arr.map(codes, () => s.draw(subarray(codes))),
		allowed: Arr.map(codesBelow(kinds), () => s.draw(subarray(codes)))
	}
}

/** A row of the world's kinds and flags. */
export const itemGen =
	(w: World): Gen<Item> =>
	(s) => {
		const start = s.draw(int(-2, 2))
		return {
			kind: s.draw(int(0, w.kinds - 1)),
			flag: s.draw(int(0, w.flags - 1)),
			flags: s.draw(subarray(codesBelow(w.flags))),
			n: s.draw(smallInt),
			m: s.draw(smallInt),
			d: s.draw(tenthsGen),
			t: s.draw(textGen),
			b: s.draw(boolean),
			x: s.draw(floatGen),
			y: s.draw(floatGen),
			s: [start, start + s.draw(int(1, 3))]
		}
	}

/** A literal term of a sort, an exact integer's written as an integer, which meets it. */
const literalGen = (w: World, sort: Sort): Gen<Literal> => {
	switch (sort) {
		case "int":
		case "exact":
			return (s) => ({ sort: "int", value: s.draw(smallInt) })
		case "big":
			return (s) => ({ sort: "big", value: s.draw(smallInt) })
		case "num":
			return (s) => ({ sort, tenths: s.draw(tenthsGen) })
		case "text":
			return (s) => ({ sort, value: s.draw(textGen) })
		case "code":
			return (s) => ({ sort, code: s.draw(int(0, w.flags - 1)) })
		case "set":
			return (s) => ({ sort, codes: s.draw(subarray(codesBelow(w.flags))) })
		case "bool":
			return (s) => ({ sort, value: s.draw(boolean) })
		case "f8":
		case "f4":
			return (s) => ({ sort, value: s.draw(floatGen) })
	}
}

/** The sorts a list of literals holds, an IN's: every sort but a set and a boolean. */
export type ListSort = ListLiteral["sort"]

const listLiteralGen = (w: World, sort: ListSort): Gen<ListLiteral> => {
	switch (sort) {
		case "int":
		case "exact":
		case "big":
			return (s) => ({ sort, value: s.draw(smallInt) })
		case "num":
			return (s) => ({ sort, tenths: s.draw(tenthsGen) })
		case "text":
			return (s) => ({ sort, value: s.draw(textGen) })
		case "code":
			return (s) => ({ sort, code: s.draw(int(0, w.flags - 1)) })
		case "f8":
		case "f4":
			return (s) => ({ sort, value: s.draw(floatGen) })
	}
}

const kindKeyGen =
	(w: World): Gen<KindKey> =>
	(s) =>
		s.draw(boolean) ? { k: "own" } : { k: "handle", code: s.draw(int(0, w.kinds - 1)) }

/** The Pick field of a sort, where Pick holds one. */
const pickFieldOf = (sort: Sort): PickField | undefined => {
	switch (sort) {
		case "int":
			return "n"
		case "num":
			return "d"
		case "text":
			return "t"
		case "code":
			return "flag"
		case "bool":
			return "b"
		case "f8":
			return "x"
		case "f4":
			return "y"
		case "exact":
		case "big":
		case "set":
			return undefined
	}
}

/** The row field of a sort, where the row holds one. */
const fieldOf = (sort: Sort): Field | undefined => {
	switch (sort) {
		case "int":
			return "n"
		case "num":
			return "d"
		case "text":
			return "t"
		case "code":
			return "flag"
		case "set":
			return "flags"
		case "bool":
			return "b"
		case "f8":
			return "x"
		case "f4":
			return "y"
		case "exact":
		case "big":
			return undefined
	}
}

/** The leaves of a sort past its literal: a field, a closed read, or a term no operand of the sort's own reaches. */
const leavesOf = (w: World, sort: Sort): ReadonlyArray<Weighted<Term>> => {
	const field = fieldOf(sort)
	const picked = pickFieldOf(sort)
	const flagLeaf: Gen<Term> = (s) => s.draw(termGen(w, "code", 0, "check"))
	const weightLeaf: Gen<Term> = (s) => ({ t: "weight", flag: s.draw(flagLeaf) })
	const rowLeaf: Gen<Term> = (s) => ({ t: "row", flag: s.draw(flagLeaf) })
	const widthLeaf: Gen<Term> = () => ({ t: "endpoint", op: "width" })
	const cardLeaf: Gen<Term> = (s) => ({ t: "card", a: s.draw(termGen(w, "set", 0, "check")) })
	const baseFlag: Gen<Term> = oneOf<Term>([
		() => ({ t: "field", field: "flag" }),
		(s) => ({ t: "lit", literal: s.draw(literalGen(w, "code")) }),
		(s) => ({ t: "at", field: "flag", key: s.draw(kindKeyGen(w)) })
	])
	const succLeaf: Gen<Term> = (s) => ({ t: "succ", flag: s.draw(baseFlag) })
	const singletonLeaf: Gen<Term> = (s) => ({ t: "singleton", a: s.draw(flagLeaf) })
	const options: ReadonlyArray<Weighted<Term> | undefined> = [
		field === undefined ? undefined : [2, () => ({ t: "field", field })],
		picked === undefined
			? undefined
			: [3, (s) => ({ t: "at", field: picked, key: s.draw(kindKeyGen(w)) })],
		sort === "int" ? [2, weightLeaf] : undefined,
		sort === "set" ? [3, rowLeaf] : undefined,
		sort === "set" ? [2, singletonLeaf] : undefined,
		sort === "code" ? [2, succLeaf] : undefined,
		sort === "exact" ? [1, widthLeaf] : undefined,
		sort === "big" ? [2, cardLeaf] : undefined
	]
	return Arr.filter(options, (option): option is Weighted<Term> => option !== undefined)
}

/** A leaf of a sort: a literal, a field, or a closed read, which is NULL at a key its relation holds no row at. */
const leafGen = (w: World, sort: Sort): Gen<Term> =>
	weighted([
		[1, (s): Term => ({ t: "lit", literal: s.draw(literalGen(w, sort)) })],
		...leavesOf(w, sort)
	])

/** An integer-like operand of arithmetic: an integer or an exact integer. */
const intLike = (w: World, depth: number, v: Vocabulary): Gen<Term> =>
	weighted([
		[3, termGen(w, "int", depth, v)],
		[1, termGen(w, "exact", depth, v)]
	])

/** The operations that yield a term of a sort from operands one level shallower. */
const stepsOf = (
	w: World,
	sort: Sort,
	depth: number,
	v: Vocabulary
): NonEmptyReadonlyArray<Gen<Term>> => {
	const d = depth - 1
	const sub = (of: Sort): Gen<Term> => termGen(w, of, d, v)
	const cond: Gen<Term> = (s) => ({
		t: "cond",
		p: s.draw(predGen(w, d, v)),
		a: s.draw(sub(sort)),
		b: s.draw(sub(sort))
	})
	const charLength: Gen<Term> = (s) => ({ t: "charLength", a: s.draw(sub("text")) })
	const floatArith: Gen<Term> = (s) => ({
		t: "farith",
		op: s.draw(element(["add", "sub", "mul", "div"] as const)),
		a: s.draw(sub(sort)),
		b: s.draw(sub(sort))
	})
	const concat: Gen<Term> = (s) => ({ t: "concat", a: s.draw(sub("text")), b: s.draw(sub("text")) })
	const extremum: Gen<Term> = (s) => ({
		t: "extremum",
		op: v === "query" && s.draw(boolean) ? "least" : "greatest",
		a: s.draw(sub(sort)),
		b: s.draw(sub(sort))
	})
	switch (sort) {
		case "int":
			return [
				cond,
				extremum,
				(s) => ({ t: "unary", op: "sign", a: s.draw(sub("int")) }),
				...(v === "check" ? [charLength] : []),
				(s) => ({ t: "endpoint", op: s.draw(element(["lower", "upper"] as const)) }),
				(s) => ({
					t: "divide",
					op: "mod",
					a: s.draw(sub("int")),
					d: s.draw(sub("int")),
					o: s.draw(sub("int"))
				}),
				(s) => ({ t: "narrow", e: s.draw(exactGen(w, d, v)), o: s.draw(sub("int")) }),
				(s) => ({ t: "weight", flag: s.draw(sub("code")) })
			]
		case "exact":
			return [
				(s) => ({
					t: "arith",
					op: s.draw(element(["add", "sub", "mul"] as const)),
					a: s.draw(intLike(w, d, v)),
					b: s.draw(intLike(w, d, v))
				}),
				(s) => ({
					t: "unary",
					op: s.draw(element(["neg", "abs"] as const)),
					a: s.draw(intLike(w, d, v))
				}),
				(s) => ({
					t: "divide",
					op: "div",
					a: s.draw(sub("int")),
					d: s.draw(sub("int")),
					o: s.draw(exactGen(w, d, v))
				})
			]
		case "big":
			return [
				(s) => ({ t: "widen", e: s.draw(sub("int")) }),
				(s) => ({ t: "widen", e: s.draw(additiveGen(w, d, v)) }),
				(s) => ({ t: "card", a: s.draw(sub("set")) }),
				cond
			]
		case "num":
			return [
				cond,
				extremum,
				(s) => ({
					t: "arith",
					op: s.draw(element(["add", "sub"] as const)),
					a: s.draw(sub("num")),
					b: s.draw(sub("num"))
				}),
				(s) => ({
					t: "unary",
					op: s.draw(element(["neg", "abs", "sign"] as const)),
					a: s.draw(sub("num"))
				})
			]
		case "text":
			return [cond, extremum, ...(v === "check" ? [concat] : [])]
		case "code":
			return [cond, extremum]
		case "set":
			return [
				cond,
				(s) => ({ t: "row", flag: s.draw(sub("code")) }),
				(s) => ({ t: "singleton", a: s.draw(sub("code")) }),
				(s) => ({
					t: "setop",
					op: s.draw(element(["union", "intersection", "difference"] as const)),
					a: s.draw(sub("set")),
					b: s.draw(sub("set"))
				})
			]
		case "bool":
			return [
				cond,
				extremum,
				(s) => ({
					t: "affix",
					op: s.draw(element(["startsWith", "endsWith"] as const)),
					a: s.draw(sub("text")),
					b: s.draw(sub("text"))
				}),
				(s) => ({
					t: "settest",
					op: s.draw(element(["subset", "disjoint"] as const)),
					a: s.draw(sub("set")),
					b: s.draw(sub("set"))
				})
			]
		case "f8":
			return [
				cond,
				extremum,
				(s) => ({
					t: "unary",
					op: s.draw(element(["neg", "abs", "sign"] as const)),
					a: s.draw(sub("f8"))
				}),
				(s) => ({ t: "tofloat", e: s.draw(sub(s.draw(element(["int", "f4"] as const)))) }),
				...(v === "query" ? [floatArith] : [])
			]
		case "f4":
			return [
				cond,
				extremum,
				(s) => ({ t: "unary", op: s.draw(element(["neg", "abs"] as const)), a: s.draw(sub("f4")) }),
				...(v === "query" ? [floatArith] : [])
			]
	}
}

/** A term of a sort, at most `depth` operations deep, in a vocabulary. */
export const termGen = (w: World, sort: Sort, depth: number, v: Vocabulary): Gen<Term> =>
	depth <= 0
		? leafGen(w, sort)
		: weighted([
				[2, leafGen(w, sort)],
				[3, oneOf(stepsOf(w, sort, depth, v))]
			])

/** A term of the exact sort itself, never an integer that meets it: what a narrowing's guard bounds. */
const exactGen = (w: World, depth: number, v: Vocabulary): Gen<Term> =>
	depth <= 0 ? () => ({ t: "endpoint", op: "width" }) : oneOf(stepsOf(w, "exact", depth, v))

/**
 * An exact integer of sums, differences, negations and absolute values of integers, closed reads among them: one of
 * at most a few more digits than an integer, so a cast of it into a bigint is total.
 */
const additiveGen = (w: World, depth: number, v: Vocabulary): Gen<Term> => {
	const operand: Gen<Term> = depth <= 0 ? termGen(w, "int", 0, v) : additiveOrInt(w, depth - 1, v)
	return oneOf<Term>([
		(s) => ({
			t: "arith",
			op: s.draw(element(["add", "sub"] as const)),
			a: s.draw(operand),
			b: s.draw(operand)
		}),
		(s) => ({ t: "unary", op: s.draw(element(["neg", "abs"] as const)), a: s.draw(operand) })
	])
}

const additiveOrInt = (w: World, depth: number, v: Vocabulary): Gen<Term> =>
	weighted([
		[2, termGen(w, "int", depth, v)],
		[1, additiveGen(w, depth, v)]
	])

/** A term of exactly a sort: an exact integer's is never an integer that meets it. */
const strictGen = (w: World, sort: Sort, depth: number, v: Vocabulary): Gen<Term> =>
	sort === "exact" ? exactGen(w, depth, v) : termGen(w, sort, depth, v)

/** The sorts a comparison draws, and the sort each meets on its other side. */
const comparedSorts: NonEmptyReadonlyArray<Sort> = [
	"int",
	"exact",
	"big",
	"num",
	"text",
	"code",
	"set",
	"bool",
	"f8",
	"f4"
]

/** A sort that meets `sort`: itself, or for an integer or a bigint, sometimes an exact integer. */
const partnerGen =
	(sort: Sort): Gen<Sort> =>
	(s) =>
		(sort === "int" || sort === "big") && s.draw(boolean)
			? "exact"
			: sort === "exact" && s.draw(boolean)
				? s.draw(element(["int", "big"] as const))
				: sort

/** The sorts a BETWEEN orders: every sort but a set and an exact integer. */
const orderedSorts = ["int", "big", "num", "text", "code", "bool", "f8", "f4"] as const

/** The sorts an IN tests. */
const listSorts: NonEmptyReadonlyArray<ListSort> = [
	"int",
	"exact",
	"big",
	"num",
	"text",
	"code",
	"f8",
	"f4"
]

/**
 * A query's one place for a concatenation: a side of an equality or inequality, which PostgreSQL decides without
 * building it.
 */
const concatCompareGen =
	(w: World, depth: number): Gen<Pred> =>
	(s) => ({
		p: "cmp",
		op: s.draw(element(["eq", "ne"] as const)),
		a: {
			t: "concat",
			a: s.draw(termGen(w, "text", depth, "query")),
			b: s.draw(termGen(w, "text", depth, "query"))
		},
		b: s.draw(termGen(w, "text", depth, "query"))
	})

/** The comparisons only a query's vocabulary holds: a concatenation beside an equality. */
const queryArms = (w: World, depth: number, v: Vocabulary): ReadonlyArray<Weighted<Pred>> =>
	v === "query" ? [[1, concatCompareGen(w, depth)]] : []

/** A presence's key, its flag terms at most `depth` deep. */
const hasKeyGen = (w: World, depth: number, v: Vocabulary): Gen<HasKey> => {
	const flag = termGen(w, "code", depth, v)
	return oneOf<HasKey>([
		(s) => ({ rel: "pick", key: s.draw(kindKeyGen(w)) }),
		(s) => ({ rel: "wt", flag: s.draw(flag) }),
		(s) => ({ rel: "next", from: s.draw(flag), to: s.draw(flag) })
	])
}

/** A comparison, BETWEEN, IN or a presence whose terms are at most `depth` deep. */
const comparisonGen = (w: World, depth: number, v: Vocabulary): Gen<Pred> =>
	weighted([
		[1, (s): Pred => ({ p: "has", key: s.draw(hasKeyGen(w, depth, v)) })],
		[
			4,
			(s): Pred => {
				const sort = s.draw(element(comparedSorts))
				const other = s.draw(partnerGen(sort))
				return {
					p: "cmp",
					op: s.draw(
						element(
							sort === "set"
								? (["eq", "ne"] as const)
								: (["eq", "ne", "lt", "le", "gt", "ge"] as const)
						)
					),
					a: s.draw(strictGen(w, sort, depth, v)),
					b: s.draw(strictGen(w, other, depth, v))
				}
			}
		],
		[
			1,
			(s): Pred => {
				const sort = s.draw(element(orderedSorts))
				return {
					p: "between",
					a: s.draw(termGen(w, sort, depth, v)),
					lo: s.draw(termGen(w, sort, depth, v)),
					hi: s.draw(termGen(w, sort, depth, v))
				}
			}
		],
		[
			1,
			(s): Pred => {
				const sort = s.draw(element(listSorts))
				const term = s.draw(strictGen(w, sort, depth, v))
				const value = listLiteralGen(w, sort)
				return {
					p: "in",
					a: term,
					values: [s.draw(value), ...s.draw(arrayOf(value, 2))]
				}
			}
		],
		...queryArms(w, depth, v)
	])

const arrayOf =
	<A>(item: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	(s) =>
		upTo(s.draw(int(0, max)), () => s.draw(item))

/** A predicate at most `depth` connectives deep over terms at most `depth` deep. */
export const predGen = (w: World, depth: number, v: Vocabulary): Gen<Pred> =>
	depth <= 0
		? comparisonGen(w, 0, v)
		: weighted([
				[3, comparisonGen(w, depth - 1, v)],
				[
					2,
					(s): Pred => ({
						p: s.draw(element(["and", "or"] as const)),
						args: [s.draw(predGen(w, depth - 1, v)), s.draw(predGen(w, depth - 1, v))]
					})
				],
				[1, (s): Pred => ({ p: "not", arg: s.draw(predGen(w, depth - 1, v)) })]
			])

/**
 * The sorts a generated field stores: each with a field type its term is typed at exactly. `num` is a numeric(3, 1),
 * so its terms are those typed at it: its field, its closed read, its literal, and their conditionals and extrema.
 */
export type StoredSort = "int" | "big" | "num" | "text" | "code" | "set" | "bool" | "f8" | "f4"

const storedSorts: NonEmptyReadonlyArray<StoredSort> = [
	"int",
	"big",
	"num",
	"text",
	"code",
	"set",
	"bool",
	"f8",
	"f4"
]

/** A numeric(3, 1) term: a leaf, or a conditional or an extremum of such. */
const storedNumGen = (w: World, depth: number): Gen<Term> =>
	depth <= 0
		? leafGen(w, "num")
		: weighted([
				[2, leafGen(w, "num")],
				[
					1,
					(s): Term => ({
						t: "cond",
						p: s.draw(predGen(w, depth - 1, "check")),
						a: s.draw(storedNumGen(w, depth - 1)),
						b: s.draw(storedNumGen(w, depth - 1))
					})
				],
				[
					1,
					(s): Term => ({
						t: "extremum",
						op: "greatest",
						a: s.draw(storedNumGen(w, depth - 1)),
						b: s.draw(storedNumGen(w, depth - 1))
					})
				]
			])

/** A term a generated field of a stored sort holds, at most `depth` deep. */
const storedGen = (w: World, sort: StoredSort, depth: number): Gen<Term> =>
	sort === "num" ? storedNumGen(w, depth) : termGen(w, sort, depth, "check")

/** The operator families a NULL operand reaches, each judged by its own SQL semantics. */
export const families = [
	"compare",
	"between",
	"in",
	"connective",
	"not",
	"arith",
	"extremum",
	"cast",
	"text",
	"set",
	"span",
	"cond",
	"guard",
	"presence"
] as const
export type Family = (typeof families)[number]

/** Where NULL comes from: a read at a key its relation holds no row at, or at a NULL key. */
export type Source = "a read at an absent key" | "a read at a NULL key"

/**
 * What a node decides of a NULL operand that two-valued logic would decide otherwise: the semantics the defects broke.
 */
export type Decision =
	| "NOT keeps unknown unknown"
	| "OR holds over unknown"
	| "AND fails over unknown"
	| "a guard takes its otherwise at NULL"
	| "a conditional takes its else at unknown"
	| "greatest or least skips a NULL"
	| "BETWEEN is false with one bound unknown"
	| "IN is unknown at a NULL subject"
	| "a set read at a flag completed nowhere is empty"
	| "a float quotient of NULL by zero is NULL"
	| "a singleton of an id read at an absent key is NULL"
	| "a singleton of an id read at a NULL key is NULL"
	| "a singleton of an id an operation leaves NULL is NULL"
	| "a presence of a key no row holds is false"

/** What an evaluation notes of the nodes it evaluates. */
export interface Trace {
	readonly reached: (family: Family) => void
	readonly source: (source: Source) => void
	readonly decided: (decision: Decision) => void
}

/** A trace that notes nothing. */
export const silent: Trace = { reached: () => {}, source: () => {}, decided: () => {} }

/**
 * A value of the model: an integer of any integer sort, and a numeric's tenths, as a bigint; a flag's code, a set's
 * mask of codes (bit `code` for each member) and a float as a number; a text; a boolean. NULL is null. A float's zero
 * is 0, never -0, as grizzle delivers it, and every float operation's zero is too.
 */
export type Val = bigint | number | string | boolean

/** Kleene's truth values, unknown null. */
export type Truth = boolean | null

const maskOf = (codes: ReadonlyArray<number>): number =>
	Arr.reduce(codes, 0, (mask, code) => mask | (1 << code))

/** A row field's value. */
const fieldValue = (item: Item, field: Field): Val => {
	switch (field) {
		case "n":
		case "m":
		case "d":
			return BigInt(item[field])
		case "t":
		case "b":
		case "flag":
		case "x":
		case "y":
			return item[field]
		case "flags":
			return maskOf(item.flags)
	}
}

/** A literal's value. */
const literalValue = (literal: Literal | ListLiteral): Val => {
	switch (literal.sort) {
		case "int":
		case "exact":
		case "big":
			return BigInt(literal.value)
		case "num":
			return BigInt(literal.tenths)
		case "text":
		case "bool":
		case "f8":
		case "f4":
			return literal.value
		case "code":
			return literal.code
		case "set":
			return maskOf(literal.codes)
	}
}

/** A Pick payload field's value. */
const payloadValue = (payload: Payload, field: PickField): Val =>
	field === "n" || field === "d" ? BigInt(payload[field]) : payload[field]

/**
 * The order of two values of one sort, PostgreSQL's: a text by its code points (every text of the language is ASCII),
 * and a float with NaN above every number and equal to itself.
 */
const order = (a: Val, b: Val): -1 | 0 | 1 =>
	typeof a === "number" && typeof b === "number" && (Number.isNaN(a) || Number.isNaN(b))
		? Number.isNaN(a) && Number.isNaN(b)
			? 0
			: Number.isNaN(a)
				? 1
				: -1
		: a < b
			? -1
			: a > b
				? 1
				: 0

/** A float operation's result at a float sort: rounded once to binary32 for a real, its zero 0. */
export const floatOf = (sort: Sort, x: number): number => {
	const rounded = sort === "f4" ? Math.fround(x) : x
	return rounded === 0 ? 0 : rounded
}

/**
 * IEEE 754's +, -, * and /, as grizzle's SQL computes them: a quotient by zero is an infinity of the dividend's sign,
 * and NaN over a zero or NaN dividend.
 */
const floatArithmetic = (op: "add" | "sub" | "mul" | "div", a: number, b: number): number => {
	switch (op) {
		case "add":
			return a + b
		case "sub":
			return a - b
		case "mul":
			return a * b
		case "div":
			return b !== 0
				? a / b
				: Number.isNaN(a) || a === 0
					? Number.NaN
					: a > 0
						? Number.POSITIVE_INFINITY
						: Number.NEGATIVE_INFINITY
	}
}

/** A float's negation, absolute value and sign, as float.c computes them: sign(NaN) is 0. */
const floatUnary = (op: "neg" | "abs" | "sign", a: number): number =>
	op === "neg" ? -a : op === "abs" ? Math.abs(a) : a > 0 ? 1 : a < 0 ? -1 : 0

const truthOf = (holds: boolean): Truth => holds

const both = (a: Truth, b: Truth): Truth =>
	a === false || b === false ? false : a === true && b === true ? true : null

const either = (a: Truth, b: Truth): Truth =>
	a === true || b === true ? true : a === false && b === false ? false : null

const holdsOf = (op: CompareOp, o: -1 | 0 | 1): boolean => {
	switch (op) {
		case "eq":
			return o === 0
		case "ne":
			return o !== 0
		case "lt":
			return o < 0
		case "le":
			return o <= 0
		case "gt":
			return o > 0
		case "ge":
			return o >= 0
	}
}

/** A value of an integer or numeric sort, which the sorts of a well-sorted term guarantee. */
const asBig = (v: Val): bigint =>
	typeof v === "bigint" ? v : assert.fail(`an integer or a numeric's tenths, not ${String(v)}`)
/** A flag's code or a set's mask. */
const asNumber = (v: Val): number =>
	typeof v === "number" ? v : assert.fail(`a code or a mask, not ${String(v)}`)
/** A text. */
const asText = (v: Val): string =>
	typeof v === "string" ? v : assert.fail(`a text, not ${String(v)}`)

/** Truncated division and remainder, as PostgreSQL's div and mod over integers. */
const divide = (op: "div" | "mod", a: bigint, d: bigint): bigint => (op === "div" ? a / d : a % d)

/** Where a singleton's NULL id comes from: a read at a key its relation holds no row at, at a NULL key, or an operation. */
const singletonOfNull = (w: World, item: Item, id: Term): Decision =>
	id.t === "at" || (id.t === "succ" && evalTerm(w, item, id.flag, silent) !== null)
		? "a singleton of an id read at an absent key is NULL"
		: id.t === "succ"
			? "a singleton of an id read at a NULL key is NULL"
			: "a singleton of an id an operation leaves NULL is NULL"

/** The model's value of a term over a row: SQL's, NULL included, each node noting what it reached. */
export const evalTerm = (w: World, item: Item, term: Term, trace: Trace): Val | null => {
	const ev = (t: Term): Val | null => evalTerm(w, item, t, trace)
	const spanned = (operands: ReadonlyArray<Term>): void => {
		if (Arr.some(operands, (o) => o.t === "endpoint")) {
			trace.reached("span")
		}
	}
	switch (term.t) {
		case "field":
			return fieldValue(item, term.field)
		case "lit":
			return literalValue(term.literal)
		case "at": {
			const payload = w.pick[term.key.k === "own" ? item.kind : term.key.code]
			if (payload === undefined) {
				trace.source("a read at an absent key")
				return null
			}
			return payloadValue(payload, term.field)
		}
		case "weight": {
			const flag = ev(term.flag)
			if (flag === null) {
				trace.source("a read at a NULL key")
				return null
			}
			const weight = w.weight[asNumber(flag)]
			if (weight === undefined) {
				trace.source("a read at an absent key")
				return null
			}
			return BigInt(weight)
		}
		case "succ": {
			const flag = ev(term.flag)
			if (flag === null) {
				trace.source("a read at a NULL key")
				return null
			}
			const to = w.succ[asNumber(flag)]
			if (to === undefined) {
				trace.source("a read at an absent key")
				return null
			}
			return to
		}
		case "singleton": {
			const a = ev(term.a)
			if (a === null) {
				trace.reached("set")
				trace.decided(singletonOfNull(w, item, term.a))
				return null
			}
			return 1 << asNumber(a)
		}
		case "row": {
			const flag = ev(term.flag)
			if (flag === null) {
				trace.source("a read at a NULL key")
				return null
			}
			const completions = w.next[asNumber(flag)] ?? []
			if (completions.length === 0) {
				trace.decided("a set read at a flag completed nowhere is empty")
			}
			return maskOf(completions)
		}
		case "arith": {
			const a = ev(term.a)
			const b = ev(term.b)
			if (a === null || b === null) {
				trace.reached("arith")
				spanned([term.a, term.b])
				return null
			}
			const x = asBig(a)
			const y = asBig(b)
			return term.op === "add" ? x + y : term.op === "sub" ? x - y : x * y
		}
		case "farith": {
			const a = ev(term.a)
			const b = ev(term.b)
			if (a === null || b === null) {
				trace.reached("arith")
				if (term.op === "div" && a === null && b === 0) {
					trace.decided("a float quotient of NULL by zero is NULL")
				}
				return null
			}
			return floatOf(sortOf(term), floatArithmetic(term.op, asNumber(a), asNumber(b)))
		}
		case "tofloat": {
			const e = ev(term.e)
			if (e === null) {
				trace.reached("cast")
				return null
			}
			return typeof e === "bigint" ? Number(e) : asNumber(e)
		}
		case "unary": {
			const a = ev(term.a)
			if (a === null) {
				trace.reached("arith")
				return null
			}
			if (typeof a === "number") {
				return floatOf(sortOf(term), floatUnary(term.op, a))
			}
			const x = asBig(a)
			const unit = sortOf(term.a) === "num" ? 10n : 1n
			return term.op === "neg"
				? -x
				: term.op === "abs"
					? x < 0n
						? -x
						: x
					: x < 0n
						? -unit
						: x > 0n
							? unit
							: 0n
		}
		case "extremum": {
			const a = ev(term.a)
			const b = ev(term.b)
			if (a === null || b === null) {
				trace.reached("extremum")
				spanned([term.a, term.b])
				if (a !== b) {
					trace.decided("greatest or least skips a NULL")
				}
				return a ?? b
			}
			const o = order(a, b)
			return term.op === "greatest" ? (o >= 0 ? a : b) : o <= 0 ? a : b
		}
		case "cond": {
			const p = evalPred(w, item, term.p, trace)
			if (p === null) {
				trace.reached("cond")
				trace.decided("a conditional takes its else at unknown")
			}
			const chosen = ev(p === true ? term.a : term.b)
			if (chosen === null) {
				trace.reached("cond")
			}
			return chosen
		}
		case "divide": {
			const d = ev(term.d)
			if (d === null) {
				trace.reached("guard")
				trace.decided("a guard takes its otherwise at NULL")
				return ev(term.o)
			}
			if (asBig(d) === 0n) {
				return ev(term.o)
			}
			const a = ev(term.a)
			if (a === null) {
				trace.reached("guard")
				return null
			}
			return divide(term.op, asBig(a), asBig(d))
		}
		case "narrow": {
			const e = ev(term.e)
			if (e === null) {
				trace.reached("guard")
				trace.decided("a guard takes its otherwise at NULL")
				return ev(term.o)
			}
			const x = asBig(e)
			return x >= BigInt(-narrowBound) && x <= BigInt(narrowBound) ? x : ev(term.o)
		}
		case "widen": {
			const e = ev(term.e)
			if (e === null) {
				trace.reached("cast")
			}
			return e
		}
		case "concat": {
			const a = ev(term.a)
			const b = ev(term.b)
			if (a === null || b === null) {
				trace.reached("text")
				return null
			}
			return `${asText(a)}${asText(b)}`
		}
		case "charLength": {
			const a = ev(term.a)
			if (a === null) {
				trace.reached("text")
				return null
			}
			return BigInt(asText(a).length)
		}
		case "affix": {
			const a = ev(term.a)
			const b = ev(term.b)
			if (a === null || b === null) {
				trace.reached("text")
				return null
			}
			return term.op === "startsWith"
				? Str.startsWith(asText(b))(asText(a))
				: Str.endsWith(asText(b))(asText(a))
		}
		case "setop": {
			const a = ev(term.a)
			const b = ev(term.b)
			if (a === null || b === null) {
				trace.reached("set")
				return null
			}
			const x = asNumber(a)
			const y = asNumber(b)
			return term.op === "union" ? x | y : term.op === "intersection" ? x & y : x & ~y
		}
		case "card": {
			const a = ev(term.a)
			if (a === null) {
				trace.reached("set")
				return null
			}
			return BigInt(
				Arr.filter(codesBelow(w.flags), (code) => ((asNumber(a) >> code) & 1) === 1).length
			)
		}
		case "settest": {
			const a = ev(term.a)
			const b = ev(term.b)
			if (a === null || b === null) {
				trace.reached("set")
				return null
			}
			const x = asNumber(a)
			const y = asNumber(b)
			return term.op === "subset" ? (x & ~y) === 0 : (x & y) === 0
		}
		case "endpoint": {
			const [start, end] = item.s
			return BigInt(term.op === "lower" ? start : term.op === "upper" ? end : end - start)
		}
	}
}

/** The model's truth of a predicate over a row: Kleene's, each node noting what it reached. */
/**
 * A presence's truth at a row: NULL where a key value is NULL, else whether its relation holds the key, false where
 * none does.
 */
const heldOf = (w: World, item: Item, key: HasKey, trace: Trace): Truth => {
	const code = (t: Term): number | null => {
		const v = evalTerm(w, item, t, trace)
		return v === null ? null : asNumber(v)
	}
	const unknown = (): Truth => {
		trace.reached("presence")
		trace.source("a read at a NULL key")
		return null
	}
	const decided = (held: boolean): Truth => {
		if (!held) {
			trace.decided("a presence of a key no row holds is false")
		}
		return held
	}
	switch (key.rel) {
		case "pick":
			return decided(w.pick[key.key.k === "own" ? item.kind : key.key.code] !== undefined)
		case "wt": {
			const flag = code(key.flag)
			return flag === null ? unknown() : decided(w.weight[flag] !== undefined)
		}
		case "next": {
			const from = code(key.from)
			const to = code(key.to)
			return from === null || to === null ? unknown() : decided(w.next[from]?.includes(to) === true)
		}
	}
}

export const evalPred = (w: World, item: Item, pred: Pred, trace: Trace): Truth => {
	const ev = (t: Term): Val | null => evalTerm(w, item, t, trace)
	switch (pred.p) {
		case "has":
			return heldOf(w, item, pred.key, trace)
		case "cmp": {
			const a = ev(pred.a)
			const b = ev(pred.b)
			if (a === null || b === null) {
				trace.reached("compare")
				if (pred.a.t === "endpoint" || pred.b.t === "endpoint") {
					trace.reached("span")
				}
				return null
			}
			return truthOf(holdsOf(pred.op, order(a, b)))
		}
		case "between": {
			const a = ev(pred.a)
			const lo = ev(pred.lo)
			const hi = ev(pred.hi)
			const above = a === null || lo === null ? null : order(a, lo) >= 0
			const below = a === null || hi === null ? null : order(a, hi) <= 0
			const holds = both(above, below)
			if (a === null || lo === null || hi === null) {
				trace.reached("between")
				if (holds === false) {
					trace.decided("BETWEEN is false with one bound unknown")
				}
			}
			return holds
		}
		case "in": {
			const a = ev(pred.a)
			if (a === null) {
				trace.reached("in")
				trace.decided("IN is unknown at a NULL subject")
				return null
			}
			return Arr.some(pred.values, (v) => order(a, literalValue(v)) === 0)
		}
		case "and":
		case "or": {
			const x = evalPred(w, item, pred.args[0], trace)
			const y = evalPred(w, item, pred.args[1], trace)
			const holds = pred.p === "and" ? both(x, y) : either(x, y)
			if (x === null || y === null) {
				trace.reached("connective")
				if (pred.p === "and" && holds === false) {
					trace.decided("AND fails over unknown")
				}
				if (pred.p === "or" && holds === true) {
					trace.decided("OR holds over unknown")
				}
			}
			return holds
		}
		case "not": {
			const x = evalPred(w, item, pred.arg, trace)
			if (x === null) {
				trace.reached("not")
				trace.decided("NOT keeps unknown unknown")
				return null
			}
			return !x
		}
	}
}

/** A numeric's tenths as PostgreSQL prints a numeric(3, 1). */
export const tenthsText = (tenths: number): string =>
	`${tenths < 0 ? "-" : ""}${Math.floor(Math.abs(tenths) / 10)}.${Math.abs(tenths) % 10}`

/** A set's mask as a bit string of `flags` bits, bit `code` at position `code`. */
const maskBits = (mask: number, flags: number): string =>
	Arr.join(
		Arr.map(codesBelow(flags), (code) => (((mask >> code) & 1) === 1 ? "1" : "0")),
		""
	)

/** A set's codes as a bit string of `flags` bits. */
const codesBits = (codes: ReadonlyArray<number>, flags: number): string =>
	maskBits(maskOf(codes), flags)

const sqlText = (text: string): string => `'${text}'::text`

/** A literal in plain SQL. */
const literalSql = (w: World, literal: Literal | ListLiteral): string => {
	switch (literal.sort) {
		case "int":
			return `(${literal.value})::integer`
		case "exact":
		case "big":
			return `(${literal.value})::bigint`
		case "num":
			return `(${tenthsText(literal.tenths)})::numeric`
		case "text":
			return sqlText(literal.value)
		case "code":
			return `(${literal.code})::integer`
		case "set":
			return `B'${codesBits(literal.codes, w.flags)}'`
		case "bool":
			return literal.value ? "true" : "false"
		case "f8":
		case "f4":
			return floatSql(literal.value, literal.sort)
	}
}

/** A float as PostgreSQL reads it at a float sort, its special values by name. */
const floatSql = (x: number, sort: FloatSort): string => {
	const type = floatType(sort)
	return Number.isNaN(x)
		? `'NaN'::${type}`
		: x === Number.POSITIVE_INFINITY
			? `'Infinity'::${type}`
			: x === Number.NEGATIVE_INFINITY
				? `'-Infinity'::${type}`
				: `(${x})::${type}`
}

const floatType = (sort: FloatSort): string => (sort === "f8" ? "float8" : "real")

/** A term's float sort, which its typing guarantees where the term is a float operation's operand. */
const floatSortOf = (term: Term): FloatSort => {
	const sort = sortOf(term)
	return sort === "f8" || sort === "f4" ? sort : assert.fail(`a float term, not one of ${sort}`)
}

/**
 * A term in plain SQL over the world's relations as values (worldSql) and the row `r`, written from the language's
 * meaning alone: a closed read is a scalar subquery, NULL where no row is; integers compute as numeric; a set is a bit
 * string, bit `code` at position `code`; a guard is a CASE.
 */
const termSql = (w: World, term: Term): string => {
	const sql = (t: Term): string => termSql(w, t)
	switch (term.t) {
		case "field":
			return `r.${term.field}`
		case "lit":
			return literalSql(w, term.literal)
		case "at":
			return `(SELECT p.${term.field} FROM pick p WHERE p.kind = ${term.key.k === "own" ? "r.kind" : `${term.key.code}`})`
		case "weight":
			return `(SELECT x.w FROM wt x WHERE x.flag = ${sql(term.flag)})`
		case "row":
			return `(SELECT x.bits FROM nxt x WHERE x.flag = ${sql(term.flag)})`
		case "succ":
			return `(SELECT x.target FROM succ x WHERE x.flag = ${sql(term.flag)})`
		case "singleton":
			return `set_bit(B'${maskBits(0, w.flags)}', ${sql(term.a)}, 1)`
		case "arith":
			return `((${sql(term.a)})::numeric ${term.op === "add" ? "+" : term.op === "sub" ? "-" : "*"} (${sql(term.b)})::numeric)`
		case "unary": {
			const operand = sortOf(term.a)
			const cast = operand === "f8" || operand === "f4" ? "" : "::numeric"
			return term.op === "neg"
				? `(-(${sql(term.a)})${cast})`
				: `${term.op}((${sql(term.a)})${cast})`
		}
		case "farith": {
			const a = sql(term.a)
			const b = sql(term.b)
			const type = floatType(floatSortOf(term))
			return term.op === "div"
				? `(CASE WHEN (${a}) IS NULL OR (${b}) IS NULL THEN NULL WHEN (${b}) = 0 THEN CASE WHEN (${a}) = 'NaN'::${type} OR (${a}) = 0 THEN 'NaN'::${type} WHEN (${a}) > 0 THEN 'Infinity'::${type} ELSE '-Infinity'::${type} END ELSE (${a}) / (${b}) END)`
				: `((${a}) ${term.op === "add" ? "+" : term.op === "sub" ? "-" : "*"} (${b}))`
		}
		case "tofloat":
			return `(${sql(term.e)})::float8`
		case "extremum":
			return `${term.op === "greatest" ? "GREATEST" : "LEAST"}(${sql(term.a)}, ${sql(term.b)})`
		case "cond":
			return `(CASE WHEN ${predSql(w, term.p)} THEN ${sql(term.a)} ELSE ${sql(term.b)} END)`
		case "divide":
			return `(CASE WHEN (${sql(term.d)}) <> 0 THEN ${term.op}((${sql(term.a)})::numeric, (${sql(term.d)})::numeric) ELSE (${sql(term.o)})::numeric END)`
		case "narrow":
			return `(CASE WHEN (${sql(term.e)}) BETWEEN -${narrowBound} AND ${narrowBound} THEN (${sql(term.e)})::numeric ELSE (${sql(term.o)})::numeric END)`
		case "widen":
			return `(${sql(term.e)})::bigint`
		case "concat":
			return `((${sql(term.a)}) || (${sql(term.b)}))`
		case "charLength":
			return `char_length(${sql(term.a)})`
		case "affix":
			return term.op === "startsWith"
				? `starts_with(${sql(term.a)}, ${sql(term.b)})`
				: `(right(${sql(term.a)}, char_length(${sql(term.b)})) = (${sql(term.b)}))`
		case "setop":
			return term.op === "union"
				? `((${sql(term.a)}) | (${sql(term.b)}))`
				: term.op === "intersection"
					? `((${sql(term.a)}) & (${sql(term.b)}))`
					: `((${sql(term.a)}) & ~(${sql(term.b)}))`
		case "card":
			return `bit_count(${sql(term.a)})`
		case "settest":
			return term.op === "subset"
				? `(((${sql(term.a)}) & ~(${sql(term.b)})) = B'${maskBits(0, w.flags)}')`
				: `(((${sql(term.a)}) & (${sql(term.b)})) = B'${maskBits(0, w.flags)}')`
		case "endpoint":
			return term.op === "lower"
				? "lower(r.s)"
				: term.op === "upper"
					? "upper(r.s)"
					: "(upper(r.s) - lower(r.s))"
	}
}

const compareSql: Readonly<Record<CompareOp, string>> = {
	eq: "=",
	ne: "<>",
	lt: "<",
	le: "<=",
	gt: ">",
	ge: ">="
}

/**
 * A presence in plain SQL from its meaning alone: NULL where a key value is NULL, else whether its relation's rows hold
 * the key, Next's as the bit of the key's last flag among its first flag's completions.
 */
const hasSql = (w: World, key: HasKey): string => {
	switch (key.rel) {
		case "pick":
			return `(EXISTS (SELECT FROM pick p WHERE p.kind = ${key.key.k === "own" ? "r.kind" : `${key.key.code}`}))`
		case "wt": {
			const flag = termSql(w, key.flag)
			return `(CASE WHEN (${flag}) IS NULL THEN NULL ELSE EXISTS (SELECT FROM wt x WHERE x.flag = (${flag})) END)`
		}
		case "next": {
			const from = termSql(w, key.from)
			const to = termSql(w, key.to)
			return `(CASE WHEN (${from}) IS NULL OR (${to}) IS NULL THEN NULL ELSE EXISTS (SELECT FROM nxt x WHERE x.flag = (${from}) AND get_bit(x.bits, (${to})) = 1) END)`
		}
	}
}

/** A predicate in plain SQL. */
const predSql = (w: World, pred: Pred): string => {
	switch (pred.p) {
		case "has":
			return hasSql(w, pred.key)
		case "cmp":
			return `((${termSql(w, pred.a)}) ${compareSql[pred.op]} (${termSql(w, pred.b)}))`
		case "between":
			return `((${termSql(w, pred.a)}) BETWEEN (${termSql(w, pred.lo)}) AND (${termSql(w, pred.hi)}))`
		case "in":
			return `((${termSql(w, pred.a)}) IN (${Arr.join(
				Arr.map(pred.values, (v) => literalSql(w, v)),
				", "
			)}))`
		case "and":
		case "or":
			return `((${predSql(w, pred.args[0])}) ${pred.p === "and" ? "AND" : "OR"} (${predSql(w, pred.args[1])}))`
		case "not":
			return `(NOT (${predSql(w, pred.arg)}))`
	}
}

/** A term's value as text PostgreSQL prints for the model to read (parseAnswer): a numeric as its tenths. */
export const answerSql = (w: World, term: Term): string => {
	const sql = termSql(w, term)
	switch (sortOf(term)) {
		case "int":
		case "exact":
		case "big":
			return `(${sql})::bigint::text`
		case "num":
			return `((${sql}) * 10)::bigint::text`
		case "text":
			return `(${sql})`
		case "code":
		case "set":
		case "bool":
		case "f8":
		case "f4":
			return `(${sql})::text`
	}
}

/** A predicate's truth as text PostgreSQL prints. */
export const truthSql = (w: World, pred: Pred): string => `(${predSql(w, pred)})::text`

/** The value of a term PostgreSQL printed (answerSql), NULL as null. */
export const parseAnswer = (sort: Sort, text: unknown): Val | null => {
	if (text === null || typeof text !== "string") {
		return null
	}
	switch (sort) {
		case "int":
		case "exact":
		case "big":
		case "num":
			return BigInt(text)
		case "text":
			return text
		case "code":
			return Number(text)
		case "set":
			return Arr.reduce(Arr.fromIterable(text), 0, (mask, bit, code) =>
				bit === "1" ? mask | (1 << code) : mask
			)
		case "bool":
			return text === "true"
		case "f8":
		case "f4":
			return floatOf(sort, Number(text))
	}
}

/** A predicate's truth PostgreSQL printed (truthSql). */
export const parseTruth = (text: unknown): Truth =>
	text === "true" ? true : text === "false" ? false : null

const valuesCte = (
	name: string,
	columns: string,
	rows: ReadonlyArray<string>,
	empty: string
): string =>
	rows.length === 0
		? `${name}(${columns}) AS (SELECT ${empty} WHERE false)`
		: `${name}(${columns}) AS (VALUES ${Arr.join(rows, ", ")})`

/** A row's values in plain SQL, in the order worldSql's `items` lists its columns. */
const itemSql = (w: World, id: number, item: Item): string =>
	`(${id}, ${item.kind}, ${item.flag}, B'${codesBits(item.flags, w.flags)}', ${item.n}, ${item.m}, (${tenthsText(item.d)})::numeric, ${sqlText(item.t)}, ${item.b ? "true" : "false"}, ${floatSql(item.x, "f8")}, ${floatSql(item.y, "f4")}, int4range(${item.s[0]}, ${item.s[1]}))`

/**
 * One SELECT that evaluates `columns` at every row of `rows`, each row `r` under its id: the world's closed relations
 * as values (pick, wt, nxt), each column a text PostgreSQL prints (answerSql, truthSql).
 */
export const worldSql = (
	w: World,
	rows: ReadonlyArray<readonly [id: number, item: Item]>,
	columns: NonEmptyReadonlyArray<string>
): string => {
	const pick = valuesCte(
		"pick",
		"kind, flag, n, d, t, b, x, y",
		Arr.flatMap(w.pick, (payload, kind) =>
			payload === undefined
				? []
				: [
						`(${kind}, ${payload.flag}, ${payload.n}, (${tenthsText(payload.d)})::numeric, ${sqlText(payload.t)}, ${payload.b ? "true" : "false"}, ${floatSql(payload.x, "f8")}, ${floatSql(payload.y, "f4")})`
					]
		),
		"0, 0, 0, 0::numeric, ''::text, false, 0::float8, 0::real"
	)
	const wt = valuesCte(
		"wt",
		"flag, w",
		Arr.flatMap(w.weight, (weight, flag) => (weight === undefined ? [] : [`(${flag}, ${weight})`])),
		"0, 0"
	)
	const succ = valuesCte(
		"succ",
		"flag, target",
		Arr.flatMap(w.succ, (target, flag) => (target === undefined ? [] : [`(${flag}, ${target})`])),
		"0, 0"
	)
	const nxt = valuesCte(
		"nxt",
		"flag, bits",
		Arr.map(w.next, (completions, flag) => `(${flag}, B'${codesBits(completions, w.flags)}')`),
		`0, B'${maskBits(0, w.flags)}'`
	)
	const items = valuesCte(
		"items",
		"id, kind, flag, flags, n, m, d, t, b, x, y, s",
		Arr.map(rows, ([id, item]) => itemSql(w, id, item)),
		`0, 0, 0, B'${maskBits(0, w.flags)}', 0, 0, 0::numeric, ''::text, false, 0::float8, 0::real, int4range(0, 1)`
	)
	return `WITH ${pick}, ${wt}, ${succ}, ${nxt}, ${items} SELECT r.id::text, ${Arr.join(columns, ", ")} FROM items r ORDER BY r.id`
}

/** The world an aim draws under: its last kind held by no Pick row, so a read at it is NULL at every row. */
export const aimedWorld = (w: World): World => ({
	...w,
	pick: Arr.map(w.pick, (payload, kind) => (kind === w.kinds - 1 ? undefined : payload))
})

/**
 * An aimed world with two kinds at least, the first held by Pick and the last not: a row written at every kind is on
 * a selection that reads Pick at its own kind at the first, and unknown to it at the last, under one integer.
 */
export const twoKindWorld = (w: World): World => {
	const kinds = Math.max(2, w.kinds)
	const held: Payload = w.pick[0] ?? { flag: 0, n: 0, d: 0, t: "", b: false, x: 0, y: 0 }
	return {
		...w,
		kinds,
		pick: upTo(kinds, (kind) =>
			kind === kinds - 1 ? undefined : kind === 0 ? held : w.pick[kind]
		),
		allowed: upTo(kinds, (kind) => w.allowed[kind] ?? [])
	}
}

/** A selection that holds at a row whose kind Pick holds and is unknown at one it holds none at. */
export const heldKindPred: Pred = {
	p: "cmp",
	op: "eq",
	a: { t: "at", field: "n", key: { k: "own" } },
	b: { t: "at", field: "n", key: { k: "own" } }
}

/** A term of a sort that is NULL at every row of an aimed world: a read at its last kind, or an operation over one. */
const nullOf = (w: World, sort: Sort): Term => {
	const absent: KindKey = { k: "handle", code: w.kinds - 1 }
	const at = (field: PickField): Term => ({ t: "at", field, key: absent })
	switch (sort) {
		case "int":
			return at("n")
		case "num":
			return at("d")
		case "text":
			return at("t")
		case "code":
			return at("flag")
		case "bool":
			return at("b")
		case "set":
			return { t: "row", flag: at("flag") }
		case "big":
			return { t: "widen", e: at("n") }
		case "exact":
			return { t: "arith", op: "add", a: at("n"), b: { t: "field", field: "n" } }
		case "f8":
			return at("x")
		case "f4":
			return at("y")
	}
}

/** A comparison operator over a sort: a set's equality alone. */
const compareOpGen = (sort: Sort): Gen<CompareOp> =>
	element(
		sort === "set" ? (["eq", "ne"] as const) : (["eq", "ne", "lt", "le", "gt", "ge"] as const)
	)

/** A comparison of a term with a drawn term of its own sort. */
const comparedWith =
	(w: World, term: Term, v: Vocabulary): Gen<Pred> =>
	(s) => {
		const sort = sortOf(term)
		return {
			p: "cmp",
			op: s.draw(compareOpGen(sort)),
			a: term,
			b: s.draw(strictGen(w, sort, 1, v))
		}
	}

/** A comparison whose left side is NULL at every row of an aimed world. */
const nullCompare =
	(w: World, v: Vocabulary): Gen<Pred> =>
	(s) =>
		s.draw(comparedWith(w, nullOf(w, s.draw(element(comparedSorts))), v))

/**
 * A predicate in which a node of `family` meets a NULL operand at every row of an aimed world. A presence of a NULL
 * key stands under NOT, where one read as false would hold.
 */
export const aimedPredGen = (w: World, family: Family, v: Vocabulary): Gen<Pred> => {
	switch (family) {
		case "compare":
			return nullCompare(w, v)
		case "between":
			return (s) => {
				const sort = s.draw(element(orderedSorts))
				const other = (): Term => s.draw(termGen(w, sort, 1, v))
				const at = s.draw(int(0, 2))
				return {
					p: "between",
					a: at === 0 ? nullOf(w, sort) : other(),
					lo: at === 1 ? nullOf(w, sort) : other(),
					hi: at === 2 ? nullOf(w, sort) : other()
				}
			}
		case "in":
			return (s) => {
				const sort = s.draw(element(listSorts))
				const value = listLiteralGen(w, sort)
				return {
					p: "in",
					a: nullOf(w, sort),
					values: [s.draw(value), ...s.draw(arrayOf(value, 2))]
				}
			}
		case "presence":
			return (s) => {
				const absent = nullOf(w, "code")
				const other = s.draw(termGen(w, "code", 1, v))
				const keys: NonEmptyReadonlyArray<HasKey> = [
					{ rel: "wt", flag: absent },
					{ rel: "next", from: absent, to: other },
					{ rel: "next", from: other, to: absent }
				]
				return { p: "not", arg: { p: "has", key: s.draw(element(keys)) } }
			}
		case "connective":
			return (s) => {
				const unknown = s.draw(nullCompare(w, v))
				const other = s.draw(predGen(w, 1, v))
				return {
					p: s.draw(element(["and", "or"] as const)),
					args: s.draw(boolean) ? [unknown, other] : [other, unknown]
				}
			}
		case "not":
			return (s) => ({ p: "not", arg: s.draw(nullCompare(w, v)) })
		case "arith":
		case "extremum":
		case "cast":
		case "text":
		case "set":
		case "span":
		case "cond":
		case "guard":
			return (s) => s.draw(comparedWith(w, s.draw(aimedTermGen(w, family, v)), v))
	}
}

/** A term in which a node of `family` meets a NULL operand at every row of an aimed world. */
const aimedTermGen = (w: World, family: Family, v: Vocabulary): Gen<Term> => {
	const int1 = termGen(w, "int", 1, v)
	switch (family) {
		case "arith": {
			const exact: Gen<Term> = (s) => ({
				t: "arith",
				op: s.draw(element(["add", "sub", "mul"] as const)),
				a: nullOf(w, "int"),
				b: s.draw(int1)
			})
			const float: Gen<Term> = (s) => {
				const sort = s.draw(element(["f8", "f4"] as const))
				const zero: Term = { t: "lit", literal: { sort, value: 0 } }
				return {
					t: "farith",
					op: s.draw(element(["add", "sub", "mul", "div"] as const)),
					a: nullOf(w, sort),
					b: s.draw(boolean) ? zero : s.draw(termGen(w, sort, 1, v))
				}
			}
			return v === "query" ? oneOf<Term>([exact, float]) : exact
		}
		case "extremum":
			return (s) => {
				const sort = s.draw(element(["int", "num", "text", "code", "bool", "f8", "f4"] as const))
				return {
					t: "extremum",
					op: v === "query" && s.draw(boolean) ? "least" : "greatest",
					a: nullOf(w, sort),
					b: s.draw(termGen(w, sort, 1, v))
				}
			}
		case "cast":
			return oneOf<Term>([
				() => ({ t: "widen", e: nullOf(w, "int") }),
				(s) => ({ t: "tofloat", e: nullOf(w, s.draw(element(["int", "f4"] as const))) })
			])
		case "text": {
			const affix: Gen<Term> = (s) => ({
				t: "affix",
				op: s.draw(element(["startsWith", "endsWith"] as const)),
				a: nullOf(w, "text"),
				b: s.draw(termGen(w, "text", 1, v))
			})
			return v === "query"
				? affix
				: oneOf<Term>([
						(s) => ({ t: "concat", a: nullOf(w, "text"), b: s.draw(termGen(w, "text", 1, v)) }),
						() => ({ t: "charLength", a: nullOf(w, "text") }),
						affix
					])
		}
		case "set":
			return oneOf<Term>([
				(s) => ({
					t: "setop",
					op: s.draw(element(["union", "intersection", "difference"] as const)),
					a: nullOf(w, "set"),
					b: s.draw(termGen(w, "set", 1, v))
				}),
				() => ({ t: "card", a: nullOf(w, "set") }),
				() => ({ t: "singleton", a: nullOf(w, "code") }),
				() => ({ t: "singleton", a: { t: "succ", flag: nullOf(w, "code") } }),
				(s) => ({
					t: "settest",
					op: s.draw(element(["subset", "disjoint"] as const)),
					a: nullOf(w, "set"),
					b: s.draw(termGen(w, "set", 1, v))
				})
			])
		case "span":
			return (s) => ({
				t: "extremum",
				op: "greatest",
				a: { t: "endpoint", op: s.draw(element(["lower", "upper"] as const)) },
				b: nullOf(w, "int")
			})
		case "cond":
			return (s) => ({ t: "cond", p: s.draw(nullCompare(w, v)), a: s.draw(int1), b: s.draw(int1) })
		case "guard":
			return oneOf<Term>([
				(s) => {
					const op = s.draw(element(["div", "mod"] as const))
					return {
						t: "divide",
						op,
						a: s.draw(int1),
						d: nullOf(w, "int"),
						o: s.draw(op === "div" ? exactGen(w, 1, v) : int1)
					}
				},
				(s) => ({ t: "narrow", e: nullOf(w, "exact"), o: s.draw(int1) })
			])
		case "compare":
		case "between":
		case "in":
		case "connective":
		case "not":
		case "presence":
			return (s) => ({
				t: "cond",
				p: s.draw(aimedPredGen(w, family, v)),
				a: s.draw(int1),
				b: s.draw(int1)
			})
	}
}

/**
 * A query's filter over a float quotient of NULL by zero, at every row of an aimed world: NULL, so the row is dropped,
 * where a quotient by zero that forgot its dividend would be a float, which `ne` keeps whichever float it is and an
 * order keeps on its side.
 */
export const nullQuotientGen =
	(w: World, ops: NonEmptyReadonlyArray<CompareOp>): Gen<Pred> =>
	(s) => {
		const sort = s.draw(element(["f8", "f4"] as const))
		return {
			p: "cmp",
			op: s.draw(element(ops)),
			a: {
				t: "farith",
				op: "div",
				a: nullOf(w, sort),
				b: { t: "lit", literal: { sort, value: 0 } }
			},
			b: { t: "lit", literal: { sort, value: 0.5 } }
		}
	}

/** Where a singleton's NULL id comes from, as an aim builds it. */
export type NullIdSource = "absent key" | "NULL key" | "operation"

/**
 * A singleton's id NULL at every row of an aimed world, from `source`: Pick's flag at the absent kind, Succ's flag at
 * that NULL, or greatest of two such reads.
 */
export const nullIdOf = (w: World, source: NullIdSource): Term => {
	const absent = nullOf(w, "code")
	switch (source) {
		case "absent key":
			return absent
		case "NULL key":
			return { t: "succ", flag: absent }
		case "operation":
			return { t: "extremum", op: "greatest", a: absent, b: { t: "succ", flag: absent } }
	}
}

/**
 * A predicate over a singleton of a NULL id: unequal to the set of the first flag, so it is unknown, and a singleton
 * that read its NULL id as the empty set would make it true.
 */
export const nullSingletonPred = (w: World, source: NullIdSource): Pred => ({
	p: "cmp",
	op: "ne",
	a: { t: "singleton", a: nullIdOf(w, source) },
	b: { t: "lit", literal: { sort: "set", codes: [0] } }
})

/** A generated field's sort and term. */
export interface Stored {
	readonly sort: StoredSort
	readonly term: Term
}

/** The stored sort of a term an aim built, where a generated field stores it: never an exact integer. */
const storedOf = (term: Term, otherwise: Term): Stored => {
	const sort = sortOf(term)
	return sort === "exact"
		? { sort: "int", term: { t: "narrow", e: term, o: otherwise } }
		: { sort, term }
}

/** A generated field in which a node of `family` meets a NULL operand at every row of an aimed world. */
export const aimedStoredGen =
	(w: World, family: Family): Gen<Stored> =>
	(s) => {
		const term = s.draw(aimedTermGen(w, family, "check"))
		return term.t === "extremum" && sortOf(term) === "num"
			? { sort: "num", term: { ...term, b: s.draw(storedNumGen(w, 1)) } }
			: storedOf(term, s.draw(termGen(w, "int", 1, "check")))
	}

/** A generated field of a drawn stored sort. */
export const storedFieldGen =
	(w: World): Gen<Stored> =>
	(s) => {
		const sort = s.draw(element(storedSorts))
		return { sort, term: s.draw(storedGen(w, sort, 2)) }
	}
