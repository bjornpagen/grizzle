import { Array as Arr, Option, Result } from "effect"
import type { ParamId } from "#compiler/core/ids.ts"
import * as Engine from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import {
	type ColumnRef,
	describeOp,
	type OpId,
	predicateTree,
	type ScalarExpr
} from "#compiler/ir/expr.ts"

import type { VectorText } from "#compiler/ir/carriers.ts"
import {
	baseOf,
	type Carrier,
	contractOf,
	numericTypmodOf,
	type RegexRef,
	type ScalarType,
	textOf
} from "#compiler/ir/scalar.ts"
import type { CastValue, HostCast, IntCarrier } from "#compiler/scalar/compute/cast.ts"
import { compareValues, literalValue } from "#compiler/scalar/compute/evaluate.ts"
import { totalFloat } from "#compiler/scalar/compute/float.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import * as TotalNumeric from "#compiler/scalar/compute/numeric.ts"
import {
	castOf,
	firstOperand,
	type NativeOp,
	nativeOp,
	nativeOps
} from "#compiler/scalar/compute/registry.ts"
import { decimalTextMaxBytes } from "#compiler/scalar/lexical.ts"
import { matches } from "#compiler/scalar/regex/match.ts"
import { matchFlags } from "#compiler/scalar/regex/matcher.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { canonicalZero } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { referenceDecimal } from "#test/support/oracle/evaluate/decimal-text.ts"
import { referenceDouble } from "#test/support/oracle/evaluate/double-text.ts"
import * as F from "#test/support/oracle/evaluate/float.ts"
import {
	intAbs,
	intAdd,
	intDiv,
	intGcd,
	intLcm,
	intMod,
	intMul,
	intNeg,
	intSub
} from "#test/support/oracle/evaluate/integer.ts"
import * as N from "#test/support/oracle/evaluate/numeric.ts"
import { power as numericPower } from "#test/support/oracle/evaluate/power.ts"

/**
 * How the oracle computes a node's value. It never claims a value it cannot reproduce bit for bit:
 * - "exact": as PostgreSQL computes it, in exact arithmetic: integers, numeric, IEEE 754's +, -, *, / and sqrt, the
 *   casts and the comparisons;
 * - "estimated": PostgreSQL's algorithm, some of whose choices hang on an estimate through its platform libm (numeric
 *   power's result scale): the oracle claims a value only where every libm within the error bound makes the same
 *   choices, and declines the rest (power.ts libmEstimate);
 * - "database": never, PostgreSQL alone computes it: a float's pow goes through the platform libm, which V8's Math.pow
 *   does not reproduce in the last place, and pgvector's operations are the extension's.
 *
 * A set's algebra over a roster's handles (union, intersection, difference, cardinality, subset, disjoint, and a set
 * with one more handle, singleton's) is exact: a bits value is the set of its handles, and bit(n)'s &, |, bit_count
 * and set_bit compute exactly the Set operations over them.
 * A double's parse from its decimal text is IEEE 754's conversion from decimal written from its definition
 * (double-text.ts), apart from the engine's and ECMAScript's.
 * A text's concatenation, prefix and suffix tests and translation are exact over its code points, and its regex match is grizzle's own
 * automaton over the pattern's parse (src's scalar/regex/nfa.ts), which PostgreSQL's `~` over the pattern's ARE agrees
 * with (test/pg/compute/text.test.ts).
 * There is no complement (OPEN-4), which PostgreSQL alone would compute over the roster's live codes, and no SHA-256 of
 * its own: a bytes value's digest is PostgreSQL's alone, against which test/pg/compute/digest.test.ts holds the host's.
 */
export type Evaluation = "exact" | "estimated" | "database"

/** Each node's evaluation, by its function and carrier. */
export const evaluationOf = (op: NativeOp): Evaluation => {
	switch (op.fn) {
		case "power":
			return firstOperand(op.operands) === "numeric" ? "estimated" : "database"
		case "cosineDistance":
		case "complement":
		case "regexpReplace":
		case "btrim":
		case "sha256":
			return "database"
		case "union":
		case "intersection":
		case "difference":
		case "cardinality":
		case "subset":
		case "disjoint":
		case "adjoin":
		case "add":
		case "sub":
		case "mul":
		case "div":
		case "mod":
		case "neg":
		case "abs":
		case "quot":
		case "rem":
		case "sign":
		case "round":
		case "trunc":
		case "ceil":
		case "floor":
		case "gcd":
		case "lcm":
		case "sqrt":
		case "least":
		case "greatest":
		case "widthBucket":
		case "minScale":
		case "lower":
		case "upper":
		case "charLength":
		case "octetLength":
		case "concat":
		case "startsWith":
		case "endsWith":
		case "right":
		case "matches":
		case "translate":
		case "collapse":
		case "parseDouble":
		case "parseDecimal":
		case "eq":
		case "ne":
		case "lt":
		case "le":
		case "gt":
		case "ge":
		case "between":
		case "in":
		case "and":
		case "or":
		case "not":
		case "cast":
			return "exact"
	}
}

/**
 * The nodes the oracle declines by design for some or all values (evaluation "estimated" or "database"): its declined
 * stop names one, and PostgreSQL alone computes it.
 */
export const declinedOps: ReadonlySet<OpId> = new Set(
	Arr.map(
		Arr.filter(nativeOps, (op) => evaluationOf(op) !== "exact"),
		(op) => op.id
	)
)

/**
 * Why an evaluation has no value: an operation evaluated where its precondition fails, which no admitted expression
 * meets (every partial operation stands with its proof), and which the oracle's consumers treat as a defect; an
 * expression the oracle does not evaluate (a read its environment has not, an operand of another kind); or a node it
 * declines by design (declinedOps), whose value PostgreSQL alone computes.
 */
export type CatalogStop =
	| { readonly kind: "undefined"; readonly what: string }
	| { readonly kind: "unsupported"; readonly what: string }
	| {
			readonly kind: "declined"
			readonly op: OpId
			readonly evaluation: Exclude<Evaluation, "exact">
			readonly what: string
	  }

export type CatalogResult = Result.Result<CarrierValue, CatalogStop>

/** Membership of a text value in a regex refinement, the caller's (reference/evaluate.ts patternMember). */
type RegexMember = (regex: RegexRef, text: string) => boolean

/**
 * What an evaluation reads besides its expressions: nothing (a constant expression), or a row's columns and the
 * parameters bound for it. A read the environment has not is unsupported.
 */
export type EvalEnv =
	| { readonly kind: "constant" }
	| {
			readonly kind: "row"
			readonly column: (ref: ColumnRef) => CarrierValue | undefined
			readonly param: (id: ParamId) => CarrierValue | undefined
			readonly regexMember: RegexMember
	  }

export const constantEnv: EvalEnv = Object.freeze({ kind: "constant" })

const undefinedAt = (what: string): CatalogResult => Result.fail({ kind: "undefined", what })
const unsupported = (what: string): CatalogResult => Result.fail({ kind: "unsupported", what })

/** UTF-8, the database's encoding, by the host's own encoder: what octet_length counts. */
const utf8Encoder = new TextEncoder()

/**
 * A node the oracle declines: PostgreSQL alone computes its value, which the host does not reproduce bit for bit,
 * under the evaluation that declines it: a libm estimate, or the database's own computation.
 */
const declined = (
	op: NativeOp,
	evaluation: Exclude<Evaluation, "exact">,
	why: string
): CatalogResult => Result.fail({ kind: "declined", op: op.id, evaluation, what: why })

const lift = <A extends CarrierValue>(r: Result.Result<A, string>): CatalogResult =>
	Result.isSuccess(r) ? Result.succeed(r.success) : undefinedAt(r.failure)

/** A compiler Compute operation's answer, or the numeric port's, which answer the engine's Result. */
const liftEngine = <A extends CarrierValue>(r: Engine.Result<A, string>): CatalogResult =>
	r.ok ? Result.succeed(r.value) : undefinedAt(r.error)

/**
 * The host kinds of the exact carriers, checked: an operand of another kind reaches `unsupported`, never a wrong answer.
 */
const isBigint = (v: unknown): v is bigint => typeof v === "bigint"
const isNumber = (v: unknown): v is number => typeof v === "number"
const isString = (v: unknown): v is string => typeof v === "string"
const isDecimal = (v: unknown): v is Decimal => v instanceof Decimal
const isMoney = (v: unknown): v is Money => v instanceof Money
type SpanValue = { readonly start: bigint; readonly end: bigint }
const isSpanValue = (v: unknown): v is SpanValue =>
	typeof v === "object" &&
	v !== null &&
	"start" in v &&
	"end" in v &&
	isBigint(v.start) &&
	isBigint(v.end)

const isIntCarrier = (c: string | undefined): c is IntCarrier | "exactInteger" =>
	c === "int2" || c === "int4" || c === "int8" || c === "exactInteger"

const isHandleSet = (v: unknown): v is ReadonlySet<string> => v instanceof Set

/**
 * A set operation over bits values, each the set of its roster's handles: union, intersection and difference are the
 * Set operations, cardinality the count, subset and disjointness the membership tests, as bit(n)'s |, & and bit_count
 * compute them over one roster's codes.
 */
type SetFn = "union" | "intersection" | "difference" | "cardinality" | "subset" | "disjoint"

const setAlgebra = (fn: SetFn, op: NativeOp, args: ReadonlyArray<CarrierValue>): CatalogResult => {
	const [a, b] = args
	if (!isHandleSet(a) || (fn !== "cardinality" && !isHandleSet(b))) {
		return mismatch(op)
	}
	const other: ReadonlySet<string> = isHandleSet(b) ? b : new Set()
	switch (fn) {
		case "union":
			return Result.succeed(new Set([...a, ...other]))
		case "intersection":
			return Result.succeed(new Set(Arr.filter([...a], (h) => other.has(h))))
		case "difference":
			return Result.succeed(new Set(Arr.filter([...a], (h) => !other.has(h))))
		case "cardinality":
			return Result.succeed(BigInt(a.size))
		case "subset":
			return Result.succeed(Arr.every([...a], (h) => other.has(h)))
		case "disjoint":
			return Result.succeed(!Arr.some([...a], (h) => other.has(h)))
	}
}

/** A text's code points, its characters as PostgreSQL counts them. */
const characters = (text: string): ReadonlyArray<string> => Array.from(text)

/** A text with its characters in reverse order. */
const reversed = (text: string): string => Arr.join(Arr.reverse(characters(text)), "")

/** Whether `prefix`'s characters begin `text`'s, one by one: starts_with's code point prefix. */
const codePrefix = (prefix: string, text: string): boolean => {
	const p = characters(prefix)
	const t = characters(text)
	return p.length <= t.length && Arr.every(p, (c, i) => t[i] === c)
}

/** PostgreSQL's right(text, n): the last n characters, all of them past the text's length, all but -n for n < 0. */
const lastCharacters = (text: string, n: bigint): string => {
	const cs = characters(text)
	const drop = n >= 0n ? Math.max(cs.length - Number(n), 0) : Number(-n)
	return Arr.join(cs.slice(drop), "")
}

/**
 * PostgreSQL's translate(text, from, to) as oracle_compat.c reads it, character by character: each character of text
 * is looked up in from from its start, and replaced by the character of to at the first position it holds there,
 * deleted where to ends before that position, and copied where from does not hold it.
 */
const characterMap = (text: string, from: string, to: string): string => {
	const f = characters(from)
	const t = characters(to)
	return Arr.join(
		Arr.flatMap(characters(text), (c) => {
			const at = f.indexOf(c)
			const target = at < 0 ? c : t[at]
			return target === undefined ? [] : [target]
		}),
		""
	)
}

/** XML's white space characters: space, tab, LF and CR. */
const xmlSpace: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r"])

/**
 * XML Schema's whiteSpace collapse as its definition reads: the text cut at every run of white space, the empty pieces
 * dropped, and the rest joined by one space each.
 */
const collapsedText = (text: string): string => {
	const pieces: Array<string> = [""]
	for (const c of characters(text)) {
		if (xmlSpace.has(c)) {
			pieces.push("")
		} else {
			pieces[pieces.length - 1] = `${pieces.at(-1) ?? ""}${c}`
		}
	}
	return Arr.join(
		Arr.filter(pieces, (p) => p.length > 0),
		" "
	)
}

/** A text's match of a pattern, read under the flags of every Compute.matches pattern, by its parse's automaton. */
const patternMatch = (text: string, source: string): CatalogResult => {
	const parsed = parsePattern(source, matchFlags)
	return parsed.ok
		? Result.succeed(matches(buildNfa(parsed.value), text))
		: unsupported(`the pattern /${source}/${matchFlags}, outside the grammar`)
}

/** An operand of a kind the IR's typing rules out. */
const mismatch = (op: NativeOp): CatalogResult =>
	unsupported(`${op.fn} over operands that are not values of ${firstOperand(op.operands)}`)

/**
 * A value's membership in a regex refinement, by the environment's NFA: a constant evaluation has none, so a regex
 * level there is unsupported.
 */
const regexHolds = (
	env: EvalEnv,
	regex: RegexRef,
	v: CarrierValue
): Result.Result<boolean, CatalogStop> => {
	if (env.kind === "constant") {
		return Result.fail({ kind: "unsupported", what: "regex membership, the text package's NFA" })
	}
	return isString(v)
		? Result.succeed(env.regexMember(regex, v))
		: Result.fail({ kind: "unsupported", what: "regex membership of a value that is not text" })
}

/** A carried value's vector, where it is one. */
const vectorOf = (v: CarrierValue): VectorText | undefined =>
	typeof v === "object" && "vector" in v ? v.vector : undefined

/**
 * pgvector's vector_cmp: component by component as binary32 values, the first that differ deciding, then the shorter
 * vector first. A vector holds the one zero, so two vectors compare 0 exactly when they are one value.
 */
const compareVectors = (a: CarrierValue, b: CarrierValue): -1 | 0 | 1 | undefined => {
	const x = vectorOf(a)
	const y = vectorOf(b)
	if (x === undefined || y === undefined) {
		return undefined
	}
	return Option.match(
		Arr.findFirst(Arr.zip(x.components, y.components), ([p, q]) => p !== q),
		{
			onSome: ([p, q]): -1 | 1 => (p < q ? -1 : 1),
			onNone: (): -1 | 0 | 1 =>
				x.components.length < y.components.length
					? -1
					: x.components.length > y.components.length
						? 1
						: 0
		}
	)
}

/**
 * PostgreSQL's comparison of two values of one type: the host's total orders (scalar/compute/evaluate.ts
 * compareValues), and pgvector's order over vectors, the extension's, which the host leaves to the database.
 */
export const compareCarried = (
	a: CarrierValue,
	b: CarrierValue,
	t: ScalarType
): -1 | 0 | 1 | undefined =>
	baseOf(t).carrier === "vector" ? compareVectors(a, b) : compareValues(a, b, t)

/** PostgreSQL's comparison of two values under `holds`, unsupported when the host claims no order between them. */
const compared = (
	op: NativeOp,
	a: CarrierValue | undefined,
	b: CarrierValue | undefined,
	t: ScalarType | undefined,
	holds: (cmp: -1 | 0 | 1) => boolean
): CatalogResult => {
	if (a === undefined || b === undefined || t === undefined) {
		return mismatch(op)
	}
	const cmp = compareCarried(a, b, t)
	return cmp === undefined
		? unsupported(`${op.fn} over ${firstOperand(op.operands)}`)
		: Result.succeed(holds(cmp))
}

/**
 * The four arithmetic operators and the remainder over two operands of the carrier `c`: exact over the integers and
 * money, an exact integer and exact money, IEEE 754 over the floats, and numeric's own over numeric.
 */
const arithmetic = (
	op: NativeOp,
	fn: "add" | "sub" | "mul" | "div" | "mod",
	a: CarrierValue | undefined,
	b: CarrierValue | undefined,
	c: Carrier
): CatalogResult => {
	if (isIntCarrier(c)) {
		if (!isBigint(a) || !isBigint(b)) {
			return mismatch(op)
		}
		switch (fn) {
			case "add":
				return Result.succeed(intAdd(a, b))
			case "sub":
				return Result.succeed(intSub(a, b))
			case "mul":
				return Result.succeed(intMul(a, b))
			case "div":
				return lift(intDiv(a, b))
			case "mod":
				return lift(intMod(a, b))
		}
	}
	if (c === "float4" || c === "float8") {
		if (!isNumber(a) || !isNumber(b)) {
			return mismatch(op)
		}
		if (fn === "mod") {
			return unsupported("float %")
		}
		return Result.succeed(F.floatArithmetic[fn](a, b, c))
	}
	if (c === "money" || c === "exactMoney") {
		if (!isMoney(a) || !isMoney(b)) {
			return mismatch(op)
		}
		const x = a.minorUnits
		const y = b.minorUnits
		if (fn === "add") {
			return Result.succeed(Money.exact(x + y))
		}
		if (fn === "sub") {
			return Result.succeed(Money.exact(x - y))
		}
		if (fn === "div") {
			return y === 0n ? undefinedAt("nonzero") : Result.succeed(Number(x) / Number(y))
		}
		return unsupported(`${fn} over ${c}`)
	}
	if (!isDecimal(a) || !isDecimal(b)) {
		return mismatch(op)
	}
	const f = {
		add: TotalNumeric.add,
		sub: TotalNumeric.sub,
		mul: TotalNumeric.mul,
		div: TotalNumeric.div,
		mod: TotalNumeric.mod
	}[fn]
	return liftEngine(f(a, b))
}

/**
 * The whole catalogue's operations, applied to their evaluated operands. Each case checks its operands' host kinds;
 * the IR's typing guarantees them, so a mismatch is `unsupported`. `and`, `or` and casts are evaluated by their nodes,
 * never applied.
 *
 * ExecEvalMinMax keeps the first of equal values.
 */
const catalogApply = (
	op: NativeOp,
	args: ReadonlyArray<CarrierValue>,
	argTypes: ReadonlyArray<ScalarType>
): CatalogResult => {
	if (evaluationOf(op) === "database") {
		return declined(op, "database", "PostgreSQL alone evaluates it")
	}
	const [a, b] = args
	const [t] = argTypes
	const c = firstOperand(op.operands)
	switch (op.fn) {
		case "add":
		case "sub":
		case "mul":
		case "div":
		case "mod":
			return arithmetic(op, op.fn, a, b, c)
		case "quot":
			return isDecimal(a) && isDecimal(b) ? liftEngine(TotalNumeric.divTrunc(a, b)) : mismatch(op)
		case "neg":
		case "abs":
			if (isIntCarrier(c)) {
				return isBigint(a) ? Result.succeed(op.fn === "neg" ? intNeg(a) : intAbs(a)) : mismatch(op)
			}
			if (c === "float4" || c === "float8") {
				return isNumber(a) ? Result.succeed(totalFloat[op.fn](a)) : mismatch(op)
			}
			return isDecimal(a)
				? liftEngine({ neg: TotalNumeric.neg, abs: TotalNumeric.abs }[op.fn](a))
				: mismatch(op)
		case "sign":
			if (c === "float8") {
				return isNumber(a) ? Result.succeed(totalFloat.sign(a)) : mismatch(op)
			}
			if (isBigint(a)) {
				return Result.succeed(a > 0n ? 1n : a < 0n ? -1n : 0n)
			}
			return isDecimal(a) ? liftEngine(TotalNumeric.sign(a)) : mismatch(op)
		case "rem":
			return isDecimal(a) && isDecimal(b) ? liftEngine(TotalNumeric.mod(a, b)) : mismatch(op)
		case "round":
		case "trunc": {
			if (!isDecimal(a)) {
				return mismatch(op)
			}
			if (args.length > 1 && !isBigint(b)) {
				return mismatch(op)
			}
			const digits = isBigint(b) ? Number(b) : 0
			return liftEngine(op.fn === "round" ? N.round(a, digits) : N.trunc(a, digits))
		}
		case "ceil":
			return isDecimal(a) ? liftEngine(N.ceil(a)) : mismatch(op)
		case "floor":
			return isDecimal(a) ? liftEngine(N.floor(a)) : mismatch(op)
		case "gcd":
			if (isIntCarrier(c)) {
				return isBigint(a) && isBigint(b) ? Result.succeed(intGcd(a, b)) : mismatch(op)
			}
			return isDecimal(a) && isDecimal(b) ? liftEngine(N.gcd(a, b)) : mismatch(op)
		case "lcm":
			if (isIntCarrier(c)) {
				return isBigint(a) && isBigint(b) ? Result.succeed(intLcm(a, b)) : mismatch(op)
			}
			return isDecimal(a) && isDecimal(b) ? liftEngine(N.lcm(a, b)) : mismatch(op)
		case "power": {
			if (!isDecimal(a) || !isDecimal(b)) {
				return mismatch(op)
			}
			const p = numericPower(a, b)
			if (Result.isSuccess(p)) {
				return Result.succeed(p.success)
			}
			const stop = p.failure
			return stop.kind === "failure"
				? undefinedAt(stop.code)
				: declined(op, "estimated", `its result hangs on ${stop.what}`)
		}
		case "sqrt":
			if (c === "float8") {
				return isNumber(a) ? Result.succeed(F.floatSqrt(a)) : mismatch(op)
			}
			return isDecimal(a) ? liftEngine(N.sqrt(a)) : mismatch(op)
		case "widthBucket": {
			const [x, low, high, count] = args
			if (!isDecimal(x) || !isDecimal(low) || !isDecimal(high) || !isBigint(count)) {
				return mismatch(op)
			}
			return liftEngine(N.widthBucket(x, low, high, count))
		}
		case "minScale":
			return isDecimal(a) ? liftEngine(Engine.map(N.minScaleOf(a), BigInt)) : mismatch(op)
		case "least":
		case "greatest": {
			if (a === undefined || t === undefined) {
				return mismatch(op)
			}
			const seed: CatalogResult = Result.succeed(a)
			return Arr.reduce(args.slice(1), seed, (acc, v) =>
				Result.flatMap(acc, (best) => {
					const cmp = compareCarried(best, v, t)
					if (cmp === undefined) {
						return unsupported(`${op.fn} over ${c}`)
					}
					return Result.succeed((op.fn === "least" ? cmp > 0 : cmp < 0) ? v : best)
				})
			)
		}
		case "lower":
			return isSpanValue(a) ? Result.succeed(a.start) : mismatch(op)
		case "upper":
			return isSpanValue(a) ? Result.succeed(a.end) : mismatch(op)
		case "charLength":
			return isString(a) ? Result.succeed(BigInt(Array.from(a).length)) : mismatch(op)
		case "octetLength":
			return isString(a) ? Result.succeed(BigInt(utf8Encoder.encode(a).length)) : mismatch(op)
		case "concat":
			return isString(a) && isString(b) ? Result.succeed(`${a}${b}`) : mismatch(op)
		case "startsWith":
			return isString(a) && isString(b) ? Result.succeed(codePrefix(b, a)) : mismatch(op)
		case "endsWith":
			return isString(a) && isString(b)
				? Result.succeed(codePrefix(reversed(b), reversed(a)))
				: mismatch(op)
		case "right":
			return isString(a) && isBigint(b) ? Result.succeed(lastCharacters(a, b)) : mismatch(op)
		case "matches":
			return isString(a) && isString(b) ? patternMatch(a, b) : mismatch(op)
		case "translate": {
			const to = args[2]
			return isString(a) && isString(b) && isString(to)
				? Result.succeed(characterMap(a, b, to))
				: mismatch(op)
		}
		case "eq":
			return compared(op, a, b, t, (cmp) => cmp === 0)
		case "ne":
			return compared(op, a, b, t, (cmp) => cmp !== 0)
		case "lt":
			return compared(op, a, b, t, (cmp) => cmp < 0)
		case "le":
			return compared(op, a, b, t, (cmp) => cmp <= 0)
		case "gt":
			return compared(op, a, b, t, (cmp) => cmp > 0)
		case "ge":
			return compared(op, a, b, t, (cmp) => cmp >= 0)
		case "between": {
			const high = args[2]
			if (a === undefined || b === undefined || high === undefined || t === undefined) {
				return mismatch(op)
			}
			const lo = compareCarried(a, b, t)
			const hi = compareCarried(a, high, t)
			if (lo === undefined || hi === undefined) {
				return unsupported(`BETWEEN over ${c}`)
			}
			return Result.succeed(lo >= 0 && hi <= 0)
		}
		case "in": {
			if (a === undefined || t === undefined) {
				return mismatch(op)
			}
			const comparisons = Arr.map(args.slice(1), (v) => compareCarried(a, v, t))
			return comparisons.includes(undefined)
				? unsupported(`IN over ${c}`)
				: Result.succeed(comparisons.includes(0))
		}
		case "not":
			return typeof a === "boolean" ? Result.succeed(!a) : mismatch(op)
		case "cosineDistance":
		case "complement":
		case "regexpReplace":
		case "btrim":
		case "sha256":
			return declined(op, "database", "PostgreSQL alone evaluates it")
		case "collapse":
			return isString(a) ? Result.succeed(collapsedText(a)) : mismatch(op)
		case "parseDouble": {
			if (!isString(a)) {
				return mismatch(op)
			}
			const value = referenceDouble(a)
			return value === undefined ? undefinedAt("lexical") : Result.succeed(value)
		}
		case "parseDecimal": {
			if (!isString(a)) {
				return mismatch(op)
			}
			const read = referenceDecimal(a)
			const value =
				read === undefined || utf8Length(a) > decimalTextMaxBytes.value
					? undefined
					: Decimal.fromParts(read.negative, read.digits, Number(read.scale))
			return value?.ok === true ? Result.succeed(value.value) : undefinedAt("lexical")
		}
		case "union":
		case "intersection":
		case "difference":
		case "cardinality":
		case "subset":
		case "disjoint":
			return setAlgebra(op.fn, op, args)
		case "adjoin": {
			const [set, handle] = args
			return isHandleSet(set) && isString(handle)
				? Result.succeed(new Set([...set, handle]))
				: mismatch(op)
		}
		case "and":
		case "or":
		case "cast":
			return unsupported(`${op.fn} evaluated by its node`)
	}
}

const converted = (r: Engine.Result<CastValue, string>): CatalogResult =>
	r.ok ? Result.succeed(r.value) : undefinedAt(r.error)

/**
 * A registered cast's host conversion of `v`, a value of the cast's source family; a value of another kind is
 * unsupported.
 */
const hostCast = (
	host: HostCast,
	v: CarrierValue,
	source: Carrier,
	to: ScalarType
): CatalogResult => {
	switch (host.from) {
		case "integer":
			return isBigint(v) ? converted(host.convert(v)) : unsupported(`a cast from ${source}`)
		case "numeric":
			return isDecimal(v) ? converted(host.convert(v)) : unsupported(`a cast from ${source}`)
		case "float":
			return isNumber(v) ? converted(host.convert(v)) : unsupported(`a cast from ${source}`)
		case "money":
			return isMoney(v) ? converted(host.convert(v)) : unsupported(`a cast from ${source}`)
		case "text":
			return typeof v === "string"
				? converted(host.convert(v, baseOf(to)))
				: unsupported(`a cast from ${source}`)
	}
}

/** A native cast between the value types of two descriptors, then the target's numeric typmod coercion. */
const castTo = (v: CarrierValue, from: ScalarType, to: ScalarType): CatalogResult => {
	const source = baseOf(from).carrier
	const target = baseOf(to).carrier
	let out: CarrierValue = v
	if (source !== target) {
		const native = castOf(source, target)
		if (native === undefined) {
			return unsupported(`a cast from ${source} to ${target}`)
		}
		const cast = hostCast(native.host, v, source, to)
		if (Result.isFailure(cast)) {
			return cast
		}
		out = cast.success
	}
	const typmod = numericTypmodOf(baseOf(to))
	if (typmod !== undefined) {
		if (!isDecimal(out)) {
			return unsupported("a numeric cast's result")
		}
		const normalized = normalizeNumeric(out, typmod)
		if (!normalized.ok) {
			return undefinedAt("fits")
		}
		out = normalized.value
	}
	return Result.succeed(out)
}

/**
 * The test kernel's evaluator of the whole Compute catalogue over exact carriers: the oracle that states PostgreSQL's
 * answer for every operation the host can state exactly, independently of PostgreSQL (test/pg/compute compares it with
 * PostgreSQL), and that the reference evaluators read for scalar expressions.
 *
 * It evaluates every node the registry holds: comparisons, BETWEEN, IN, boolean composition and conditionals; integer,
 * numeric, float and money arithmetic (integer.ts, src's scalar/compute/numeric.ts, float.ts); rounding, gcd and lcm,
 * square roots, width_bucket and min_scale (numeric.ts); numeric power (power.ts, PostgreSQL's numeric_power
 * step for step); char_length, span endpoints, LEAST and GREATEST; and the registry's casts and domain casts. The host
 * never claims a value it cannot reproduce bit for bit: a node PostgreSQL alone computes (Evaluation "database": a
 * float's pow through the platform libm, pgvector's operations), and numeric power where a libm estimate decides it and
 * the host's may not agree, answer "declined" rather than an approximation, and their consumers leave them to
 * PostgreSQL.
 *
 * Values are exact carriers (src's scalar/compute/literal.ts CarrierValue), each in its one form: a Decimal has no
 * display scale and every operation and cast result's float zero is 0 (oneZero), as grizzle delivers them. They are
 * compared by PostgreSQL's total orders (src's compareValues, which constant folding reads). A regex refinement's membership is the text package's NFA, which
 * the caller supplies.
 *
 * Evaluates the expression tree `root` (a DAG's expression, or a contract predicate parsed from its table) under `env`,
 * over the whole catalogue.
 */
export const evaluate = (root: ScalarExpr, env: EvalEnv): CatalogResult =>
	evaluateOver(root, env, unsupported("a VALUE"))

/**
 * A value with the one zero: a float operation's -0 (a negation, a product, a root) as 0, the value grizzle delivers
 * and every float the oracle holds; any other value as it is.
 */
const oneZero = (v: CarrierValue): CarrierValue => (typeof v === "number" ? canonicalZero(v) : v)

/** `root` under `env`, the VALUE (a contract predicate's only read) evaluating to `value`. */
const evaluateOver = (root: ScalarExpr, env: EvalEnv, value: CatalogResult): CatalogResult => {
	/** An AND (`decisive` false) or an OR (`decisive` true), its operands evaluated in order until one decides it. */
	const connective = (decisive: boolean, args: ReadonlyArray<ScalarExpr>): CatalogResult => {
		for (const a of args) {
			const v = run(a)
			if (Result.isFailure(v)) {
				return v
			}
			if (v.success === decisive) {
				return Result.succeed(decisive)
			}
		}
		return Result.succeed(!decisive)
	}
	/** The values of an operation's operands in order, each with its type, or the first operand's stop. */
	const operands = (
		args: ReadonlyArray<ScalarExpr>
	): Result.Result<
		{ readonly values: ReadonlyArray<CarrierValue>; readonly types: ReadonlyArray<ScalarType> },
		CatalogStop
	> => {
		const values: Array<CarrierValue> = []
		const types: Array<ScalarType> = []
		for (const a of args) {
			const v = run(a)
			if (Result.isFailure(v)) {
				return Result.fail(v.failure)
			}
			values.push(v.success)
			types.push(a.type)
		}
		return Result.succeed({ values, types })
	}
	const run = (expr: ScalarExpr): CatalogResult => {
		switch (expr.kind) {
			case "value":
				return value
			case "column": {
				const v = env.kind === "row" ? env.column(expr.column) : undefined
				return v === undefined ? unsupported(`the column ${expr.column.name}`) : Result.succeed(v)
			}
			case "param": {
				const v = env.kind === "row" ? env.param(expr.param) : undefined
				return v === undefined ? unsupported(`the parameter ${expr.param}`) : Result.succeed(v)
			}
			case "literal":
				return Result.succeed(literalValue(expr.value))
			case "cond": {
				const [p, t, e] = expr.args
				const c = run(p)
				if (Result.isFailure(c)) {
					return c
				}
				return run(c.success === true ? t : e)
			}
			case "cast": {
				const [operand] = expr.args
				const v = run(operand)
				if (Result.isFailure(v)) {
					return v
				}
				return Result.map(castTo(v.success, operand.type, expr.type), oneZero)
			}
			case "domainCast": {
				const [operand] = expr.args
				const v = run(operand)
				if (Result.isFailure(v)) {
					return v
				}
				const coerced = castTo(v.success, operand.type, baseOf(expr.type))
				if (Result.isFailure(coerced)) {
					return coerced
				}
				const member = membership(coerced.success, expr.type, env)
				if (Result.isFailure(member)) {
					return Result.fail(member.failure)
				}
				return member.success ? coerced : undefinedAt("contract")
			}
			case "closedAt":
			case "closedRow":
			case "closedHas":
				return unsupported(`the closed read ${expr.kind} of ${expr.relation}`)
			case "op": {
				const op = nativeOp(expr.op)
				if (op === undefined) {
					return unsupported(`the operator ${describeOp(expr.op)}`)
				}
				if (op.fn === "and" || op.fn === "or") {
					return connective(op.fn === "or", expr.args)
				}
				return Result.map(
					Result.flatMap(operands(expr.args), ({ values, types }) =>
						catalogApply(op, values, types)
					),
					oneZero
				)
			}
		}
	}
	return run(root)
}

/**
 * Whether a value of a domain cast's target satisfies it at every level: each level's base refinement (a regex), then
 * its contract predicate, innermost first, as PostgreSQL checks a domain over a domain. Each predicate reads its VALUE,
 * and regex membership as `env` reads it.
 */
const membership = (
	v: CarrierValue,
	t: ScalarType,
	env: EvalEnv
): Result.Result<boolean, CatalogStop> => {
	const levels: Array<ScalarType> = []
	for (let at: ScalarType | undefined = t; at !== undefined; at = contractOf(at)?.base) {
		levels.push(at)
	}
	for (const level of Arr.reverse(levels)) {
		const contract = contractOf(level)
		const pattern = contract === undefined ? textOf(level)?.regex : undefined
		const member =
			pattern !== undefined && pattern !== "wildcard"
				? regexHolds(env, pattern, v)
				: Result.succeed(true)
		if (Result.isFailure(member) || !member.success) {
			return member
		}
		if (contract?.predicate === undefined) {
			continue
		}
		const tree = predicateTree(contract.predicate)
		if (!tree.ok) {
			return Result.fail({
				kind: "unsupported",
				what: `the contract predicate of ${contract.name}`
			})
		}
		const holds = evaluateOver(tree.value, env, Result.succeed(v))
		if (Result.isFailure(holds)) {
			return Result.fail(holds.failure)
		}
		if (holds.success !== true) {
			return Result.succeed(false)
		}
	}
	return Result.succeed(true)
}
