import type { ExprId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import {
	type ColumnRef,
	describeOp,
	type ExprTable,
	type TableExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import {
	baseOf,
	type Carrier,
	contractOf,
	isRefined,
	numericTypmodOf,
	type RegexRef,
	type ScalarType,
	textOf,
	typeLabel
} from "#compiler/ir/scalar.ts"
import type { CastValue, HostCast } from "#compiler/scalar/compute/cast.ts"
import { totalFloat } from "#compiler/scalar/compute/float.ts"
import {
	type CarrierValue,
	irLiteral,
	type CarriedLiteral
} from "#compiler/scalar/compute/literal.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import {
	castOf,
	firstOperand,
	type NativeOp,
	nativeOp,
	type Undefined
} from "#compiler/scalar/compute/registry.ts"
import { matchFlags } from "#compiler/scalar/regex/admit.ts"
import { buildNfa, matches } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { translated } from "#compiler/scalar/regex/translate.ts"
import { collapsed } from "#compiler/scalar/regex/whitespace.ts"
import { compareDecimal, Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { canonicalZero, compareFloat } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"

/**
 * Why an evaluation has no value: the precondition an operation's operands fail, which no admitted expression meets
 * (every partial operation stands with its proof), or an expression the evaluator does not evaluate (a read other than
 * the VALUE, an operation outside a check's vocabulary, an operand of another kind).
 */
export type EvalStop =
	| { readonly kind: "undefined"; readonly precondition: Undefined }
	| { readonly kind: "unsupported"; readonly what: string }

type EvalResult = Result.Result<CarrierValue, EvalStop>

/**
 * What an evaluated expression's leaves read: a contract predicate's VALUE, a row's columns, each by its name, its
 * value or undefined where the row holds none, which the evaluation then refuses as unsupported; and the closed
 * relations a closed read applies: `closed(relation, field, args)` is C.at's cell, the value of `field` at the key
 * `args`, and with no field C.row's set, the completions of the key prefix `args`; undefined where the reader holds no
 * closed relation, or C.at's relation holds no tuple at the key, which the evaluation refuses as unsupported.
 */
export interface EvalLeaves {
	readonly value: CarrierValue | undefined
	readonly column: (ref: ColumnRef) => CarrierValue | undefined
	readonly closed: (
		relation: string,
		field: string | undefined,
		args: ReadonlyArray<CarrierValue>
	) => CarrierValue | undefined
}

/**
 * Membership of a text value in a regex refinement: the text package's NFA (never RegExp), which the caller supplies,
 * since the text package reads the scalar package and not the other way round.
 */
export type RegexMember = (regex: RegexRef, text: string) => boolean

const undefinedAt = (precondition: Undefined): EvalResult =>
	Result.err({ kind: "undefined", precondition })
const unsupported = (what: string): EvalResult => Result.err({ kind: "unsupported", what })

/** A value's membership in a regex refinement, by the caller's NFA; a value that is not text has none to judge. */
const regexHolds = (
	regexMember: RegexMember,
	regex: RegexRef,
	v: CarrierValue
): Result.Result<boolean, EvalStop> =>
	isString(v)
		? Result.ok(regexMember(regex, v))
		: Result.err({ kind: "unsupported", what: "regex membership of a value that is not text" })

const lift = <A extends CarrierValue>(r: Result.Result<A, Undefined>): EvalResult =>
	r.ok ? Result.ok(r.value) : undefinedAt(r.error)

/** The exact carrier value of a typed IR literal. */
export const literalValue = (literal: TypedLiteral): CarrierValue => {
	switch (literal.kind) {
		case "int":
			return literal.value
		case "numeric":
			return Decimal.fromValue(literal.value)
		case "float":
			return literal.value
		case "floatSpecial":
			return literal.value === "NaN"
				? Number.NaN
				: literal.value === "Infinity"
					? Number.POSITIVE_INFINITY
					: Number.NEGATIVE_INFINITY
		case "money":
			return Money.fromValue(literal.value)
		case "bool":
			return literal.value
		case "text":
		case "uuid":
		case "date":
			return literal.value
		case "handle":
			return literal.handle
		case "handles":
			return new Set(literal.handles)
		case "span":
			return { start: literal.start, end: literal.end }
		case "vector":
			return { vector: literal.value }
	}
}

/**
 * The host kinds of the exact carriers, checked: an operand of another kind reaches `unsupported`, never a wrong answer.
 */
const isBigint = (v: unknown): v is bigint => typeof v === "bigint"
const isNumber = (v: unknown): v is number => typeof v === "number"
const isString = (v: unknown): v is string => typeof v === "string"
const isDecimal = (v: unknown): v is Decimal => v instanceof Decimal
const isMoney = (v: unknown): v is Money => v instanceof Money
const isSet = (v: unknown): v is ReadonlySet<string> => v instanceof Set

/**
 * A set's membership over its roster's handles in declared order, one 0 or 1 per handle: two sets of one roster are
 * equal exactly when their texts are, and the texts' order is the host's own total order of sets, since a set has no
 * order of PostgreSQL's. Undefined when the set holds a member the roster does not.
 */
const membershipText = (
	set: ReadonlySet<string>,
	roster: ReadonlyArray<string>
): string | undefined =>
	[...set].every((member) => roster.includes(member))
		? roster.map((handle) => (set.has(handle) ? "1" : "0")).join("")
		: undefined
type SpanValue = { readonly start: bigint; readonly end: bigint }
const isSpanValue = (v: unknown): v is SpanValue =>
	typeof v === "object" &&
	v !== null &&
	"start" in v &&
	"end" in v &&
	isBigint(v.start) &&
	isBigint(v.end)

/**
 * PostgreSQL's comparison of two values of one type, or undefined when either is no value of it (another host kind, a
 * handle outside the roster): the host claims no order it cannot reproduce.
 */
export const compareValues = (
	a: CarrierValue,
	b: CarrierValue,
	t: ScalarType
): -1 | 0 | 1 | undefined => {
	const base = baseOf(t)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
			if (!isBigint(a) || !isBigint(b)) {
				return undefined
			}
			return a < b ? -1 : a > b ? 1 : 0
		case "numeric":
			return isDecimal(a) && isDecimal(b) ? compareDecimal(a, b) : undefined
		case "float4":
		case "float8":
			return isNumber(a) && isNumber(b) ? compareFloat(a, b) : undefined
		case "money":
		case "exactMoney":
			return isMoney(a) && isMoney(b) ? a.compare(b) : undefined
		case "bool":
			if (typeof a !== "boolean" || typeof b !== "boolean") {
				return undefined
			}
			return a === b ? 0 : a ? 1 : -1
		case "uuid":
			if (!isString(a) || !isString(b)) {
				return undefined
			}
			return a === b ? 0 : a < b ? -1 : 1
		case "date":
			if (!isString(a) || !isString(b)) {
				return undefined
			}
			return a === b ? 0 : a < b ? -1 : 1
		case "text":
			return isString(a) && isString(b) ? compareCodePoints(a, b) : undefined
		case "code": {
			if (!isString(a) || !isString(b)) {
				return undefined
			}
			const { handles } = base.roster
			const i = handles.indexOf(a)
			const j = handles.indexOf(b)
			if (i < 0 || j < 0) {
				return undefined
			}
			return i < j ? -1 : i > j ? 1 : 0
		}
		case "bits": {
			if (!isSet(a) || !isSet(b)) {
				return undefined
			}
			const x = membershipText(a, base.roster.handles)
			const y = membershipText(b, base.roster.handles)
			if (x === undefined || y === undefined) {
				return undefined
			}
			return x === y ? 0 : x < y ? -1 : 1
		}
		case "range4":
		case "range8": {
			if (!isSpanValue(a) || !isSpanValue(b)) {
				return undefined
			}
			if (a.start !== b.start) {
				return a.start < b.start ? -1 : 1
			}
			return a.end < b.end ? -1 : a.end > b.end ? 1 : 0
		}
		case "vector":
			return undefined
	}
}

/** An operand of a kind the IR's typing rules out. */
const mismatch = (op: NativeOp): EvalResult =>
	unsupported(`${op.fn} over operands that are not values of ${firstOperand(op.operands)}`)

/**
 * IEEE 754 arithmetic of a float carrier, as the host's own: binary64 for double precision, binary32 for real by one
 * rounding of the binary64 result (correct for +, -, *, / and the square root, whose binary64 results round to binary32
 * exactly as a binary32 operation does), the one zero.
 */
const ieee = (
	fn: "add" | "sub" | "mul" | "div",
	a: number,
	b: number,
	carrier: Carrier
): number => {
	const r = fn === "add" ? a + b : fn === "sub" ? a - b : fn === "mul" ? a * b : a / b
	return canonicalZero(carrier === "float4" ? Math.fround(r) : r)
}

/** Truncated integer division and remainder, defined where the divisor is not zero. */
const intDiv = (a: bigint, b: bigint): EvalResult =>
	b === 0n ? undefinedAt("nonzero") : Result.ok(a / b)
const intMod = (a: bigint, b: bigint): EvalResult =>
	b === 0n ? undefinedAt("nonzero") : Result.ok(a % b)

/**
 * PostgreSQL's right(text, n): the last n characters, every one where n passes the text's length, and for a negative n
 * all but the first -n. A text's characters are its code points, as char_length counts them.
 */
const rightOf = (text: string, n: bigint): string => {
	const characters = Array.from(text)
	const kept = n >= 0n ? BigInt(characters.length) - n : -n
	return characters.slice(Number(kept < 0n ? 0n : kept)).join("")
}

/**
 * Whether `text` holds a match of the pattern `source`, read under the flags of every Compute.matches pattern: the NFA
 * of its parse (scalar/regex/nfa.ts), the automaton a str.regex refinement's membership reads, which agrees with
 * PostgreSQL's `~` over the pattern's ARE. A source outside the grammar is no pattern any admitted node holds.
 */
const patternMatch = (text: string, source: string): EvalResult => {
	const parsed = parsePattern(source, matchFlags)
	return parsed.ok
		? Result.ok(matches(buildNfa(parsed.value), text))
		: unsupported(`the pattern /${source}/${matchFlags}, outside the admitted grammar`)
}

const gcdOf = (a: bigint, b: bigint): bigint => {
	let x = a < 0n ? -a : a
	let y = b < 0n ? -b : b
	while (y !== 0n) {
		const r = x % y
		x = y
		y = r
	}
	return x
}

/**
 * The native operations a check admits (lower.ts checkMembers) applied to their evaluated operands, each defined on
 * every value or where its proved precondition holds: integer and money arithmetic exactly (an exact integer, exact
 * money), numeric as numeric.c computes it, floats as IEEE 754, comparisons, BETWEEN, IN, NOT, char_length, a text's
 * concatenation, prefix and suffix tests, regex match (by the pattern's automaton) and translation (by code points,
 * as PostgreSQL's translate reads them), span endpoints, LEAST and
 * GREATEST by the type's order, and a set's union, intersection, difference, cardinality, subset and disjointness,
 * over its handles. Each case checks its operands' host kinds; the IR's typing guarantees them, so a mismatch is
 * `unsupported`. `and`, `or` and casts are evaluated by their nodes, never applied.
 */
const apply = (
	op: NativeOp,
	args: ReadonlyArray<CarrierValue>,
	argTypes: ReadonlyArray<ScalarType>
): EvalResult => {
	const [a, b] = args
	const c = firstOperand(op.operands)
	switch (op.fn) {
		case "add":
		case "sub":
		case "mul":
		case "div":
		case "mod": {
			const fn = op.fn
			if (c === "numeric") {
				if (!isDecimal(a) || !isDecimal(b)) {
					return mismatch(op)
				}
				return lift({ add: N.add, sub: N.sub, mul: N.mul, div: N.div, mod: N.mod }[fn](a, b))
			}
			if (c === "float4" || c === "float8") {
				return isNumber(a) && isNumber(b) && fn !== "mod"
					? Result.ok(ieee(fn, a, b, c))
					: mismatch(op)
			}
			if (c === "money" || c === "exactMoney") {
				if (!isMoney(a) || !isMoney(b)) {
					return mismatch(op)
				}
				if (fn === "div") {
					return b.minorUnits === 0n
						? undefinedAt("nonzero")
						: Result.ok(canonicalZero(Number(a.minorUnits) / Number(b.minorUnits)))
				}
				return fn === "add"
					? Result.ok(Money.exact(a.minorUnits + b.minorUnits))
					: fn === "sub"
						? Result.ok(Money.exact(a.minorUnits - b.minorUnits))
						: mismatch(op)
			}
			if (!isBigint(a) || !isBigint(b)) {
				return mismatch(op)
			}
			switch (fn) {
				case "add":
					return Result.ok(a + b)
				case "sub":
					return Result.ok(a - b)
				case "mul":
					return Result.ok(a * b)
				case "div":
					return intDiv(a, b)
				case "mod":
					return intMod(a, b)
			}
		}
		case "quot":
			return isDecimal(a) && isDecimal(b) ? lift(N.divTrunc(a, b)) : mismatch(op)
		case "rem":
			return isDecimal(a) && isDecimal(b) ? lift(N.mod(a, b)) : mismatch(op)
		case "neg":
		case "abs":
		case "sign": {
			const fn = op.fn
			if (isDecimal(a)) {
				return lift({ neg: N.neg, abs: N.abs, sign: N.sign }[fn](a))
			}
			if (isNumber(a)) {
				return Result.ok(canonicalZero(totalFloat[fn](a)))
			}
			if (isBigint(a)) {
				return Result.ok(
					fn === "neg" ? -a : fn === "abs" ? (a < 0n ? -a : a) : a < 0n ? -1n : a > 0n ? 1n : 0n
				)
			}
			return mismatch(op)
		}
		case "gcd":
		case "lcm": {
			if (!isBigint(a) || !isBigint(b)) {
				return isDecimal(a) && isDecimal(b)
					? unsupported(`${op.fn} over numeric, outside a check`)
					: mismatch(op)
			}
			const g = gcdOf(a, b)
			if (op.fn === "gcd") {
				return Result.ok(g)
			}
			const product = a * b
			return Result.ok(g === 0n ? 0n : (product < 0n ? -product : product) / g)
		}
		case "lower":
			return isSpanValue(a) ? Result.ok(a.start) : mismatch(op)
		case "upper":
			return isSpanValue(a) ? Result.ok(a.end) : mismatch(op)
		case "charLength":
			return isString(a) ? Result.ok(BigInt(Array.from(a).length)) : mismatch(op)
		case "octetLength":
			return isString(a) ? Result.ok(BigInt(utf8Length(a))) : mismatch(op)
		case "concat":
			return isString(a) && isString(b) ? Result.ok(a + b) : mismatch(op)
		case "startsWith":
			return isString(a) && isString(b) ? Result.ok(a.startsWith(b)) : mismatch(op)
		case "endsWith":
			return isString(a) && isString(b) ? Result.ok(a.endsWith(b)) : mismatch(op)
		case "right":
			return isString(a) && isBigint(b) ? Result.ok(rightOf(a, b)) : mismatch(op)
		case "matches":
			return isString(a) && isString(b) ? patternMatch(a, b) : mismatch(op)
		case "collapse":
			return isString(a) ? Result.ok(collapsed(a)) : mismatch(op)
		case "regexpReplace":
		case "btrim":
			return unsupported(`${op.fn} alone, which only collapse's SQL reads`)
		case "translate": {
			const to = args[2]
			return isString(a) && isString(b) && isString(to)
				? Result.ok(translated(a, b, to))
				: mismatch(op)
		}
		case "eq":
		case "ne":
		case "lt":
		case "le":
		case "gt":
		case "ge": {
			const [t] = argTypes
			if (a === undefined || b === undefined || t === undefined) {
				return mismatch(op)
			}
			const cmp = compareValues(a, b, t)
			if (cmp === undefined) {
				return unsupported(`comparison over ${c}`)
			}
			const holds = {
				eq: cmp === 0,
				ne: cmp !== 0,
				lt: cmp < 0,
				le: cmp <= 0,
				gt: cmp > 0,
				ge: cmp >= 0
			}[op.fn]
			return Result.ok(holds)
		}
		case "between": {
			const [t] = argTypes
			const high = args[2]
			if (a === undefined || b === undefined || high === undefined || t === undefined) {
				return mismatch(op)
			}
			const lo = compareValues(a, b, t)
			const hi = compareValues(a, high, t)
			if (lo === undefined || hi === undefined) {
				return unsupported(`BETWEEN over ${c}`)
			}
			return Result.ok(lo >= 0 && hi <= 0)
		}
		case "in": {
			const [t] = argTypes
			if (a === undefined || t === undefined) {
				return mismatch(op)
			}
			const comparisons = args.slice(1).map((v) => compareValues(a, v, t))
			return comparisons.includes(undefined)
				? unsupported(`IN over ${c}`)
				: Result.ok(comparisons.includes(0))
		}
		case "not":
			return typeof a === "boolean" ? Result.ok(!a) : mismatch(op)
		case "union":
			return isSet(a) && isSet(b) ? Result.ok(new Set([...a, ...b])) : mismatch(op)
		case "intersection":
			return isSet(a) && isSet(b)
				? Result.ok(new Set([...a].filter((h) => b.has(h))))
				: mismatch(op)
		case "difference":
			return isSet(a) && isSet(b)
				? Result.ok(new Set([...a].filter((h) => !b.has(h))))
				: mismatch(op)
		case "cardinality":
			return isSet(a) ? Result.ok(BigInt(a.size)) : mismatch(op)
		case "subset":
			return isSet(a) && isSet(b) ? Result.ok([...a].every((h) => b.has(h))) : mismatch(op)
		case "disjoint":
			return isSet(a) && isSet(b) ? Result.ok(![...a].some((h) => b.has(h))) : mismatch(op)
		case "complement":
			return unsupported("complement, which no Compute operation yields")
		case "round":
		case "trunc":
		case "ceil":
		case "floor":
		case "least":
		case "greatest": {
			const [t] = argTypes
			if (a === undefined || t === undefined) {
				return mismatch(op)
			}
			let chosen: CarrierValue = a
			for (const v of args.slice(1)) {
				const cmp = compareValues(v, chosen, t)
				if (cmp === undefined) {
					return unsupported(`${op.fn} over ${c}`)
				}
				if (op.fn === "greatest" ? cmp > 0 : cmp < 0) {
					chosen = v
				}
			}
			return Result.ok(chosen)
		}
		case "power":
		case "sqrt":
		case "widthBucket":
		case "minScale":
		case "cosineDistance":
			return unsupported(`${op.fn}, outside a check's vocabulary`)
		case "and":
		case "or":
		case "cast":
			return unsupported(`${op.fn} evaluated by its node`)
	}
}

/**
 * Evaluates a contract predicate, `root` in its expression table `exprs`, over its VALUE `value`, reading regex
 * membership by `regexMember`.
 */
const evaluatePredicate = (
	exprs: Readonly<Record<ExprId, TableExpr>>,
	root: ExprId,
	value: CarrierValue,
	regexMember: RegexMember
): EvalResult =>
	evaluateTable(
		exprs,
		root,
		{ value, column: () => undefined, closed: () => undefined },
		regexMember
	)

/**
 * The host's value of the expression `root` in its table `exprs`, its leaves read from `leaves` and regex membership
 * by `regexMember`: the value PostgreSQL computes for it, or why the host has none (EvalStop). The one evaluation of a
 * contract predicate over its VALUE and of a generation expression or a row check over its row.
 */
export const evaluateTable = (
	exprs: Readonly<Record<ExprId, TableExpr>>,
	root: ExprId,
	leaves: EvalLeaves,
	regexMember: RegexMember
): EvalResult => {
	const at = (id: ExprId): TableExpr | undefined =>
		Object.hasOwn(exprs, id) ? exprs[id] : undefined
	/** AND or OR over `args`, left to right, stopping at the deciding operand. */
	const connective = (fn: "and" | "or", args: ReadonlyArray<ExprId>): EvalResult => {
		for (const a of args) {
			const v = run(a)
			if (!v.ok || v.value === (fn === "or")) {
				return v
			}
		}
		return Result.ok(fn === "and")
	}
	/** A native operation over its arguments' values, each evaluated left to right. */
	const applied = (op: NativeOp, args: ReadonlyArray<ExprId>): EvalResult => {
		const values: Array<CarrierValue> = []
		const types: Array<ScalarType> = []
		for (const a of args) {
			const v = run(a)
			const operand = at(a)
			if (!v.ok || operand === undefined) {
				return !v.ok ? v : unsupported(`an expression named ${a}`)
			}
			values.push(v.value)
			types.push(operand.type)
		}
		return apply(op, values, types)
	}
	const run = (id: ExprId): EvalResult => {
		const expr = at(id)
		if (expr === undefined) {
			return unsupported(`an expression named ${id}`)
		}
		switch (expr.kind) {
			case "value":
				return leaves.value === undefined
					? unsupported("a contract's VALUE outside a contract predicate")
					: Result.ok(leaves.value)
			case "column": {
				const read = leaves.column(expr.column)
				return read === undefined ? unsupported(`the column ${expr.column.name}`) : Result.ok(read)
			}
			case "param":
				return unsupported(`the parameter ${expr.param}`)
			case "literal":
				return Result.ok(literalValue(expr.value))
			case "cond": {
				const [p, t, e] = expr.args
				const c = run(p)
				if (!c.ok) {
					return c
				}
				return run(c.value === true ? t : e)
			}
			case "cast": {
				const [operand] = expr.args
				const arg = at(operand)
				const v = run(operand)
				if (arg === undefined || !v.ok) {
					return v
				}
				return castTo(v.value, arg.type, expr.type)
			}
			case "domainCast": {
				const [operand] = expr.args
				const arg = at(operand)
				const v = run(operand)
				if (arg === undefined || !v.ok) {
					return v
				}
				const coerced = castTo(v.value, arg.type, baseOf(expr.type))
				if (!coerced.ok) {
					return coerced
				}
				const member = membership(coerced.value, expr.type, regexMember)
				if (!member.ok) {
					return member
				}
				return member.value ? coerced : undefinedAt("contract")
			}
			case "op": {
				/**
				 * Left to right, stopping at the deciding operand.
				 */
				const op = nativeOp(expr.op)
				if (op === undefined) {
					return unsupported(`the operator ${describeOp(expr.op)}`)
				}
				return op.fn === "and" || op.fn === "or"
					? connective(op.fn, expr.args)
					: applied(op, expr.args)
			}
			case "closedHas":
				return unsupported(
					`the membership test of the closed relation ${expr.relation}, which only a query's closed rewrite states`
				)
			case "closedAt":
			case "closedRow": {
				const args: Array<CarrierValue> = []
				for (const a of expr.args) {
					const v = run(a)
					if (!v.ok) {
						return v
					}
					args.push(v.value)
				}
				const read = leaves.closed(
					expr.relation,
					expr.kind === "closedAt" ? expr.field : undefined,
					args
				)
				return read === undefined
					? unsupported(`a read of the closed relation ${expr.relation}`)
					: Result.ok(read)
			}
		}
	}
	return run(root)
}

/**
 * A registered cast's host conversion of `v`, a value of the cast's source family; a value of another kind is
 * unsupported.
 */
const converted = (r: Result.Result<CastValue, Undefined>): EvalResult =>
	!r.ok ? undefinedAt(r.error) : Result.ok(r.value)

const hostCast = (host: HostCast, v: CarrierValue, source: Carrier, to: ScalarType): EvalResult => {
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
			return isString(v)
				? converted(host.convert(v, baseOf(to)))
				: unsupported(`a cast from ${source}`)
	}
}

/** A native cast between the value types of two descriptors, then the target's numeric typmod coercion. */
const castTo = (v: CarrierValue, from: ScalarType, to: ScalarType): EvalResult => {
	const source = baseOf(from).carrier
	const target = baseOf(to).carrier
	let out: CarrierValue = v
	if (source !== target) {
		const native = castOf(source, target)
		if (native === undefined) {
			return unsupported(`a cast from ${source} to ${target}`)
		}
		const cast = hostCast(native.host, v, source, to)
		if (!cast.ok) {
			return cast
		}
		out = cast.value
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
	return Result.ok(out)
}

/**
 * How a literal's admission judges its type's refinements: against the contract's predicates and the regex refinements,
 * by `regexMember`, or not at all, where a builder only shapes a term (compute/lower.ts "build" mode).
 */
type LiteralJudgment =
	| { readonly kind: "refinements"; readonly regexMember: RegexMember }
	| { readonly kind: "shape" }

/** A literal's refusal at a typed slot. */
interface LiteralRefusal {
	readonly reason: "MalformedDescription" | "ContractLiteral" | "UnsupportedOperation"
	readonly capability: string
}

/**
 * The pure evaluator of a check's scalar expression IR over exact carriers: the language's one semantics, on the host.
 *
 * The places grizzle evaluates an expression outside PostgreSQL are a literal that adopts a contract, which the compiler
 * checks against the contract's predicate at compile time (a refusal is CompileError ContractLiteral), and constant
 * folding of a comparison, BETWEEN or IN over literals (lower/optimize/simplify/boolean.ts, by compareValues and
 * literalValue). A contract predicate reads only its VALUE through a check's vocabulary (lower.ts checkMembers), whose
 * every operation is total or proved where it stands, so its evaluation never meets an undefined operation, and this
 * evaluator covers exactly that: comparisons, BETWEEN, IN, boolean composition, integer arithmetic exactly (bigint),
 * money exactly, numeric as numeric.c computes it, floats as IEEE 754, abs, sign and neg, gcd and lcm of integers,
 * char_length, a text's concatenation, prefix and suffix tests, regex match and translation, span endpoints, a set's
 * algebra,
 * conditionals, guards and the casts between them, and the closed reads its
 * leaves answer (EvalLeaves closed). Any other operation, and any read its leaves do not hold, is `unsupported`, never
 * an approximation. The host never substitutes JavaScript arithmetic for a SQL
 * expression in a query.
 *
 * Values are exact carriers: integers and exact integers as bigint, numeric as Decimal, floats as number, money and
 * exact money as Money, booleans, text,
 * uuids and closed ids' handles as primitives, sets as fresh Sets of handles, spans as { start, end } bigints.
 * Comparison follows PostgreSQL's total orders: NaN above every number and equal to itself, -0 equal to 0, numeric by
 * value, text in code point order under the fixed C.UTF-8 collation, closed ids in roster order, which is code order. A regex refinement's membership is the text package's NFA,
 * which the caller supplies.
 *
 * The one admission of a literal at a typed slot, in one order wherever it appears, bound by a match, compared, cast or
 * computed: its host kind and range against the base type first, MalformedDescription when it is none of the base's
 * values whatever contract the type carries; then a value of the base against the contract's predicates and the regex
 * refinements, ContractLiteral when they refuse it and UnsupportedOperation when the check cannot be evaluated.
 */
export const admitLiteral = (
	value: LiteralDesc,
	type: ScalarType,
	judgment: LiteralJudgment
): Result.Result<CarriedLiteral, LiteralRefusal> => {
	const typed = irLiteral(value, type)
	if (!typed.ok) {
		return Result.err({
			reason: "MalformedDescription",
			capability: `a literal of ${typeLabel(type)}: ${typed.error}`
		})
	}
	return judgment.kind === "shape"
		? Result.ok(typed.value)
		: refined(typed.value, type, judgment.regexMember)
}

/**
 * A value of `type`'s base held to `type`'s refinements at every level, a contract's predicate and a pattern: the
 * ContractLiteral judgment, which admitLiteral makes after the value's base, and which a closed relation's admitted cell
 * meets alone, its base proved where it was admitted (ir/desc.ts AdmittedClosedRelation). A type with no refinement
 * holds every value of its base.
 */
export const refined = (
	carried: CarriedLiteral,
	type: ScalarType,
	regexMember: RegexMember
): Result.Result<CarriedLiteral, LiteralRefusal> => {
	if (!isRefined(type)) {
		return Result.ok(carried)
	}
	const member = membership(carried.value, type, regexMember)
	if (!member.ok) {
		return Result.err({
			reason: "UnsupportedOperation",
			capability: `the ContractLiteral check of ${typeLabel(type)}: ${member.error.kind === "unsupported" ? member.error.what : `an operation its predicate holds undefined at the literal (${member.error.precondition})`}`
		})
	}
	if (!member.value) {
		return Result.err({
			reason: "ContractLiteral",
			capability: `a literal of ${typeLabel(type)}: the literal violates its ${contractOf(type) === undefined ? "regex refinement" : "contract"}`
		})
	}
	return Result.ok(carried)
}

/** Whether a contract's predicate holds of `v`: a contract without one constrains nothing. */
const predicateHolds = (
	predicate: ExprTable | undefined,
	v: CarrierValue,
	regexMember: RegexMember
): Result.Result<boolean, EvalStop> => {
	if (predicate === undefined) {
		return Result.ok(true)
	}
	const holds = evaluatePredicate(predicate.exprs, predicate.root, v, regexMember)
	return !holds.ok ? Result.err(holds.error) : Result.ok(holds.value === true)
}

/**
 * Whether a value of a contract's base satisfies the contract at every level: each level's base refinement (a regex),
 * then its predicate, innermost first, as PostgreSQL checks a domain over a domain. Each predicate reads its VALUE and
 * regex membership by `regexMember`.
 */
const membership = (
	v: CarrierValue,
	t: ScalarType,
	regexMember: RegexMember
): Result.Result<boolean, EvalStop> => {
	const levels: Array<ScalarType> = []
	for (let at: ScalarType | undefined = t; at !== undefined; at = contractOf(at)?.base) {
		levels.push(at)
	}
	for (const level of levels.toReversed()) {
		const contract = contractOf(level)
		const pattern = contract === undefined ? textOf(level)?.regex : undefined
		const member =
			pattern === undefined || pattern === "wildcard"
				? Result.ok(true)
				: regexHolds(regexMember, pattern, v)
		if (!member.ok || !member.value) {
			return member
		}
		const holds = predicateHolds(contract?.predicate, v, regexMember)
		if (!holds.ok || !holds.value) {
			return holds
		}
	}
	return Result.ok(true)
}

/**
 * Whether a typed literal is a value of `type`'s refinements at every level (membership), or undefined where the
 * evaluator cannot decide it: the ContractLiteral judgment of a literal cast into a refined type.
 */
export const literalMember = (
	literal: TypedLiteral,
	type: ScalarType,
	regexMember: RegexMember
): boolean | undefined => valueMember(literalValue(literal), type, regexMember)

/**
 * Whether a carrier value is a value of `type`'s refinements at every level (membership), or undefined where the
 * evaluator cannot decide it: what the host judges a stored value against when a domain refused it.
 */
export const valueMember = (
	value: CarrierValue,
	type: ScalarType,
	regexMember: RegexMember
): boolean | undefined => {
	const member = membership(value, type, regexMember)
	return member.ok ? member.value : undefined
}
