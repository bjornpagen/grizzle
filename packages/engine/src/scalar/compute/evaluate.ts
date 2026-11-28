import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { xsdPattern } from "@bjornpagen/grizzle-text/regex/xsd"
import {
	asciiLowered,
	collapsed,
	cutBefore,
	cutFrom,
	replacedAll,
	translated
} from "@bjornpagen/grizzle-text/text"
import { resolveReference } from "@bjornpagen/grizzle-text/uri"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { regexTextMaxBytes } from "#compiler/core/errors.ts"
import type { ExprId, ParamId } from "#compiler/core/ids.ts"
import { sha256Digest } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import { declaredOrder } from "#compiler/ir/codes.ts"
import { dateOfEpochDay, dayNumber, epochDayOf, epochDayRange } from "#compiler/ir/date.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import {
	type ColumnRef,
	describeOp,
	type ExprTable,
	type TableExpr,
	type TableExprOf,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import {
	baseOf,
	type Carrier,
	isRefined,
	numericTypmodOf,
	type RegexRef,
	regexRefOf,
	type ScalarType,
	typeLabel,
	type VariantInfo
} from "#compiler/ir/scalar.ts"
import type { CastValue, HostCast } from "#compiler/scalar/compute/cast.ts"
import { floatBits, totalFloat } from "#compiler/scalar/compute/float.ts"
import { hostOfLiteral, type LiteralMeeting, literalAt } from "#compiler/scalar/compute/literal.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import {
	castOf,
	firstOperand,
	type NativeFn,
	type NativeOp,
	nativeOp,
	nullRules,
	type Undefined
} from "#compiler/scalar/compute/registry.ts"
import { decimalOfText, doubleOfText } from "#compiler/scalar/lexical.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import { normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import {
	compareValues,
	equalByIdentity,
	evaluatedValue,
	type HostValue,
	heldValue,
	hostOf,
	type OrderSpec,
	type VariantValue
} from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	type NetCarrier,
	type NetValue,
	netOverlaps,
	netStrictlyWithin,
	netValueOf,
	netWithin
} from "#compiler/scalar/values/net.ts"
import { hostVariantDigest } from "#compiler/scalar/variant-digest.ts"

/**
 * Why an evaluation has no value: the precondition an operation's operands fail, which no admitted expression meets
 * (every partial operation stands with its proof), or an expression the evaluator does not evaluate (a read other than
 * the VALUE, an operation outside a check's vocabulary, an operand of another kind).
 */
export type EvalStop =
	| { readonly kind: "undefined"; readonly precondition: Undefined }
	| { readonly kind: "unsupported"; readonly what: string }

/**
 * SQL's NULL, a value of every type: what C.at reads at a key its closed relation holds no row at, and what a strict
 * operation, a cast or a closed read reads of a NULL operand. AND, OR and NOT judge it by Kleene's three-valued logic,
 * LEAST and GREATEST skip it, BETWEEN and IN judge it as the comparisons they are, and a conditional takes its other
 * branch at it, each as PostgreSQL does, so a selection or a guard it leaves unknown holds of no row.
 */
export const sqlNull: unique symbol = Symbol("NULL")

/** What an expression evaluates to: a value of its type, or NULL. */
export type SqlValue = HostValue | typeof sqlNull

/** A value of an operation's or a cast's type, which no NULL operand reaches. */
type EvalResult = Result.Result<HostValue, EvalStop>

/** What an expression evaluates to, or why the host has no value for it. */
export type SqlResult = Result.Result<SqlValue, EvalStop>

/**
 * A closed read as the closed relations answer it: the read's own node, its kind, its relation and C.at's field and
 * type, without its operands, whose values the evaluation reads first. Its kind is the read, so no reader spells the
 * three again.
 */
export type ClosedReadNode =
	| Pick<TableExprOf<"closedAt">, "kind" | "relation" | "field" | "type">
	| Pick<TableExprOf<"closedRow" | "closedHas">, "kind" | "relation">

/**
 * What an evaluated expression's leaves read, each value its type's host value (scalar/values/identity.ts CarrierHost),
 * the codec's own: a contract predicate's VALUE, a row's columns, each by its name, its value, NULL, or undefined where
 * the row holds none, which the evaluation then refuses as unsupported; and the closed relations a closed read applies,
 * `closed(read, args)` at its key values `args`, none of them NULL: C.at's cell, the value of its field at the key, NULL
 * where the relation holds no tuple there; C.row's set, the completions of the key prefix, empty where none completes
 * it; C.has's truth, whether a tuple holds the key, false where none does; and undefined where the reader holds no
 * closed relation, which the evaluation refuses as unsupported; and a declared parameter, by its id, its value as the
 * call's admission holds it, or undefined where the evaluation reads no call's parameters, which it refuses as
 * unsupported (a computed field's term over the call: runtime/write/binding.ts ComputedFields).
 */
export interface EvalLeaves {
	readonly value: HostValue | undefined
	readonly column: (ref: ColumnRef) => SqlValue | undefined
	readonly closed: (read: ClosedReadNode, args: ReadonlyArray<HostValue>) => SqlValue | undefined
	readonly param: (param: ParamId) => SqlValue | undefined
}

/** The parameter leaf of an evaluation that reads no call's parameters (EvalLeaves `param`): none of them. */
export const noParamLeaf: EvalLeaves["param"] = () => undefined

/**
 * An expression compiled (compiledExpr): its value over one evaluation's leaves, regex membership read by `patterns`,
 * the value PostgreSQL computes for it, NULL included (sqlNull), or why the host has none (EvalStop).
 */
export type CompiledExpr = (leaves: EvalLeaves, patterns: PatternReads) => SqlResult

/** A truth value of Kleene's logic: true, false, or NULL, unknown. */
type Truth = boolean | typeof sqlNull

/** The AND of truth values: false where one is false, else NULL where one is NULL, else true. */
const conjunction = (values: ReadonlyArray<Truth>): Truth =>
	values.includes(false) ? false : values.includes(sqlNull) ? sqlNull : true

/** The OR of truth values: true where one is true, else NULL where one is NULL, else false. */
const disjunction = (values: ReadonlyArray<Truth>): Truth =>
	values.includes(true) ? true : values.includes(sqlNull) ? sqlNull : false

const undefinedAt = (precondition: Undefined): Result.Err<EvalStop> =>
	Result.err({ kind: "undefined", precondition })
const unsupported = (what: string): Result.Err<EvalStop> =>
	Result.err({ kind: "unsupported", what })

/** NULL, the one value an evaluation reads of a strict operation over a NULL operand. */
const nullValue: SqlResult = Result.ok(sqlNull)

/** A regex refinement's membership of a text, by the caller's patterns: a regex refines a text type alone. */
const regexHolds = (patterns: PatternReads, regex: RegexRef, v: HostValue): boolean =>
	patterns.member(regex, hostOf("text", v))

const lift = <A extends HostValue>(r: Result.Result<A, Undefined>): EvalResult =>
	r.ok ? Result.ok(r.value) : undefinedAt(r.error)

/**
 * The order the evaluator compares values of `type` by (scalar/values/identity.ts compareValues), its base's: a closed
 * id's and a set's ranked by their roster's declaration (ir/codes.ts declaredOrder). An ordered roster's is its codes'
 * order, the one a codec's spec ranks them by (HandleOrder), so the evaluator needs no installation's codes and agrees
 * with PostgreSQL's order of the stored ids; an unordered roster's closed ids admit no ordering comparison, so only
 * their equality reads it. A variant's tag is ranked so too, and its arm's fields by their own types' orders: a
 * variant has no stated order, so only its equality reads it.
 */
export const evaluatorOrder = (type: ScalarType): OrderSpec => {
	const base = baseOf(type)
	switch (base.carrier) {
		case "code":
		case "bits":
			return { carrier: base.carrier, roster: declaredOrder(base.roster) }
		case "variant":
			return {
				carrier: "variant",
				roster: declaredOrder(base.variant.roster),
				arms: new Map(
					base.variant.arms.map(
						(arm) =>
							[
								arm.handle,
								{
									fields: arm.fields.map((f) => ({ name: f.name, spec: evaluatorOrder(f.type) }))
								}
							] as const
					)
				)
			}
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "vector":
		case "tsvector":
		case "range4":
		case "range8":
		case "rangeDate":
		case "exactInteger":
		case "exactMoney":
			return { carrier: base.carrier }
	}
}

/** PostgreSQL's order of two values of one type, the host's one comparison (identity.ts compareValues). */
type Compare = (a: HostValue, b: HostValue) => -1 | 0 | 1

/** PostgreSQL's order of two values of `type` (Compare), its order read once (evaluatorOrder). */
const orderOf = (type: ScalarType): Compare => {
	const order = evaluatorOrder(type)
	return (a, b) => compareValues(order, hostOf(order.carrier, a), hostOf(order.carrier, b))
}

/** The comparisons of values of one type: the six orderings, BETWEEN and IN. */
export type ComparisonFn = Extract<
	NativeFn,
	"eq" | "ne" | "lt" | "le" | "gt" | "ge" | "between" | "in"
>

/** PostgreSQL's equality of two values of `type`: their identity where its carrier's is (identity.ts equalByIdentity), else its order's 0. */
const equalityOf = (type: ScalarType): ((a: HostValue, b: HostValue) => boolean) => {
	if (equalByIdentity[baseOf(type).carrier]) {
		return (a, b) => a === b
	}
	const compare = orderOf(type)
	return (a, b) => compare(a, b) === 0
}

/** The operand `i` of an operation `fn` its arity holds, read off its operands, which the IR's typing guarantees. */
const operandOf = (fn: string, i: number): ((values: ReadonlyArray<HostValue>) => HostValue) => {
	const invariant = `operand ${i} of ${fn}`
	return (values) => defined(values[i], invariant)
}

/**
 * The truth of a comparison `fn` of values of one type `type`, none NULL, staged once: `=` and `<>` of its two operands
 * and IN of its first among the rest by the type's equality (equalityOf), and `<`, `<=`, `>`, `>=` and BETWEEN of its
 * first between its second and third by its order (orderOf). The one evaluation of a comparison, the evaluator's, staged
 * where its expression is compiled, and constant folding's (lower/optimize/simplify/boolean.ts, comparisonHolds). An
 * operand its arity holds that is missing is a defect of the IR that built it.
 */
const comparison = (
	fn: ComparisonFn,
	type: ScalarType
): ((values: ReadonlyArray<HostValue>) => boolean) => {
	const first = operandOf(fn, 0)
	const second = operandOf(fn, 1)
	/** The comparison of its first two operands by the type's order, holding where `holds` holds of their order. */
	const ordered = (holds: (order: -1 | 0 | 1) => boolean) => {
		const compare = orderOf(type)
		return (values: ReadonlyArray<HostValue>) => holds(compare(first(values), second(values)))
	}
	switch (fn) {
		case "eq": {
			const equal = equalityOf(type)
			return (values) => equal(first(values), second(values))
		}
		case "ne": {
			const equal = equalityOf(type)
			return (values) => !equal(first(values), second(values))
		}
		case "in": {
			const equal = equalityOf(type)
			return (values) => {
				const a = first(values)
				return values.some((v, i) => i > 0 && equal(a, v))
			}
		}
		case "lt":
			return ordered((order) => order < 0)
		case "le":
			return ordered((order) => order <= 0)
		case "gt":
			return ordered((order) => order > 0)
		case "ge":
			return ordered((order) => order >= 0)
		case "between": {
			const compare = orderOf(type)
			const third = operandOf(fn, 2)
			return (values) => {
				const a = first(values)
				return compare(a, second(values)) >= 0 && compare(a, third(values)) <= 0
			}
		}
	}
}

/** The truth of a comparison of values of one type, none NULL (comparison), staged and applied at once. */
export const comparisonHolds = (
	fn: ComparisonFn,
	values: ReadonlyArray<HostValue>,
	type: ScalarType
): boolean => comparison(fn, type)(values)

/**
 * An integer operand's exact value, widened at the operation, read by the carrier `c` of its operand: smallint's and
 * integer's JavaScript integers as bigints, bigint's and an exact integer's as they are. An operand of no integer
 * carrier is a defect of the IR's typing, which a reader of it throws.
 */
const integerOf = (c: Carrier): ((v: HostValue) => bigint) => {
	switch (c) {
		case "int2":
		case "int4":
			return (v) => BigInt(hostOf(c, v))
		case "int8":
		case "exactInteger":
			return (v) => hostOf(c, v)
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "exactMoney":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "variant":
			return () => {
				defect(`an integer operand, not a ${c}`)
			}
	}
}

/**
 * An exact integer as the host value of `type`'s carrier: a smallint's or an integer's a JavaScript integer, which the
 * operation's proof keeps within the carrier, a bigint's and an exact integer's the bigint. A result of no integer
 * carrier is a defect of the IR's typing, which a writer of it throws.
 */
const integerHost = (type: ScalarType): ((x: bigint) => HostValue) => {
	const c = baseOf(type).carrier
	switch (c) {
		case "int2":
		case "int4":
			return (x) => Number(x)
		case "int8":
		case "exactInteger":
			return (x) => x
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "exactMoney":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "variant":
			return () => {
				defect(`an integer result, not a ${c}`)
			}
	}
}

/**
 * A float quotient as grizzle's SQL computes it (lower/conservative/expr/total.ts guardedForm): IEEE 754's, but a
 * quotient by zero is the infinity of the dividend's sign, NaN over a zero or NaN dividend, whichever zero divides, so
 * equal operands give equal quotients, as every scalar operation gives equal results of equal operands, and a set's
 * merge of -0 and +0 changes no value computed after it.
 */
const quotient = (a: number, b: number): number =>
	b !== 0
		? a / b
		: Number.isNaN(a) || a === 0
			? Number.NaN
			: a > 0
				? Number.POSITIVE_INFINITY
				: Number.NEGATIVE_INFINITY

/**
 * IEEE 754 arithmetic of a float carrier, as the host's own: binary64 for double precision, binary32 for real by one
 * rounding of the binary64 result (correct for +, -, *, / and the square root, whose binary64 results round to binary32
 * exactly as a binary32 operation does), each zero's sign as IEEE 754 keeps it, and a quotient by zero `quotient`'s.
 */
const ieee = (
	fn: "add" | "sub" | "mul" | "div",
	a: number,
	b: number,
	carrier: Carrier
): number => {
	const r = fn === "add" ? a + b : fn === "sub" ? a - b : fn === "mul" ? a * b : quotient(a, b)
	return carrier === "float4" ? Math.fround(r) : r
}

/**
 * PostgreSQL's right(text, n): the last n characters, every one where n passes the text's length, and for a negative n
 * all but the first -n. A text's characters are its code points, as char_length counts them.
 */
const rightOf = (text: string, n: bigint): string => {
	const characters = Array.from(text)
	const kept = n >= 0n ? BigInt(characters.length) - n : -n
	return characters.slice(Number(kept < 0n ? 0n : kept)).join("")
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

/** An operation of one operand, staged once for its operation, over its operand's value. */
type Unary = (a: HostValue) => EvalResult

/** An operation of two operands, staged once for its operation, over their values. */
type Binary = (a: HostValue, b: HostValue) => EvalResult

/** An operation the evaluator refuses whatever its operands, staged once: the same stop at every value. */
const refused = (what: string): (() => EvalResult) => {
	const stop = unsupported(what)
	return () => stop
}

/**
 * Arithmetic over operands of the carrier `c`, the result of `type`, staged once: a date's difference in days, numeric
 * as numeric.c computes it, floats as IEEE 754, money exactly in minor units and money / money as a double, and
 * integers exactly, truncated division and remainder defined where the divisor is not zero. Any other operation of a
 * carrier is no check's, unsupported.
 */
const arithmetic = (
	fn: "add" | "sub" | "mul" | "div" | "mod",
	c: Carrier,
	type: ScalarType
): Binary => {
	switch (c) {
		case "date": {
			const days = integerHost(type)
			return fn === "sub"
				? (a, b) => Result.ok(days(BigInt(dayNumber(hostOf(c, a)) - dayNumber(hostOf(c, b)))))
				: refused(`${fn} over date`)
		}
		case "numeric": {
			const f = { add: N.add, sub: N.sub, mul: N.mul, div: N.div, mod: N.mod }[fn]
			return (a, b) => lift(f(hostOf(c, a), hostOf(c, b)))
		}
		case "float4":
		case "float8":
			return fn === "mod"
				? refused(`mod over ${c}`)
				: (a, b) => Result.ok(ieee(fn, hostOf(c, a), hostOf(c, b), c))
		case "money":
		case "exactMoney":
			switch (fn) {
				case "add":
					return (a, b) => Result.ok(Money.exact(hostOf(c, a).minorUnits + hostOf(c, b).minorUnits))
				case "sub":
					return (a, b) => Result.ok(Money.exact(hostOf(c, a).minorUnits - hostOf(c, b).minorUnits))
				case "div":
					return (a, b) => {
						const x = hostOf(c, a)
						const y = hostOf(c, b)
						return y.minorUnits === 0n
							? undefinedAt("nonzero")
							: Result.ok(Number(x.minorUnits) / Number(y.minorUnits))
					}
				case "mul":
				case "mod":
					return refused(`${fn} over ${c}`)
			}
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger": {
			const read = integerOf(c)
			const host = integerHost(type)
			switch (fn) {
				case "add":
					return (a, b) => Result.ok(host(read(a) + read(b)))
				case "sub":
					return (a, b) => Result.ok(host(read(a) - read(b)))
				case "mul":
					return (a, b) => Result.ok(host(read(a) * read(b)))
				case "div":
					return (a, b) => {
						const x = read(a)
						const y = read(b)
						return y === 0n ? undefinedAt("nonzero") : Result.ok(host(x / y))
					}
				case "mod":
					return (a, b) => {
						const x = read(a)
						const y = read(b)
						return y === 0n ? undefinedAt("nonzero") : Result.ok(host(x % y))
					}
			}
		}
		case "bool":
		case "uuid":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "variant":
			return refused(`${fn} over ${c}`)
	}
}

/**
 * neg, abs and sign of an operand of the carrier `c`, staged once: numeric's, a float's in total IEEE 754, an integer's
 * exactly.
 */
const signed = (fn: "neg" | "abs" | "sign", c: Carrier, type: ScalarType): Unary => {
	switch (c) {
		case "numeric": {
			const f = { neg: N.neg, abs: N.abs, sign: N.sign }[fn]
			return (a) => lift(f(hostOf(c, a)))
		}
		case "float4":
		case "float8": {
			const f = totalFloat[fn]
			return (a) => Result.ok(f(hostOf(c, a)))
		}
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger": {
			const read = integerOf(c)
			const host = integerHost(type)
			switch (fn) {
				case "neg":
					return (a) => Result.ok(host(-read(a)))
				case "abs":
					return (a) => {
						const x = read(a)
						return Result.ok(host(x < 0n ? -x : x))
					}
				case "sign":
					return (a) => {
						const x = read(a)
						return Result.ok(host(x < 0n ? -1n : x > 0n ? 1n : 0n))
					}
			}
		}
		case "money":
		case "exactMoney":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "variant":
			return refused(`${fn} over ${c}`)
	}
}

/**
 * A native operation over its operands' values, none NULL, staged once where its expression is compiled (applied): a
 * value of its type, the one LEAST and GREATEST choose among them, or why the host has none.
 */
type Apply = (args: ReadonlyArray<HostValue>, patterns: PatternReads) => SqlResult

/**
 * The native operations a check admits (registry.ts computeSpecs, check), each staged once for its overload, its
 * operands' types and its type `type`, and then applied to their evaluated operands, each a host value of its
 * operand's type and the result one of `type`, each defined on every value or where its proved precondition holds:
 * integer and money arithmetic exactly (an exact integer, exact money), numeric as numeric.c computes it, floats as
 * IEEE 754, comparisons, BETWEEN and IN by the type's order (comparison), NOT, char_length, a text's UTF-16 code units
 * (String.length, within the bytes PostgreSQL's regex engine reads), a text's concatenation, prefix and suffix tests,
 * regex match (by the pattern's automaton) and translation (by code points, as PostgreSQL's translate reads them), a
 * double's parse from its decimal text, a decimal's from its text, a bytes value's SHA-256 digest, its bytes read off
 * the hex digest worked out where the value was admitted (scalar/values/bytes.ts AdmittedBytes), and a text's, the
 * digest of its UTF-8 as core/sha256.ts sha256Digest hashes a well-formed text, which every text a check reads is, a
 * date's epoch day, an epoch day's date and a date some days after another by the proleptic Gregorian day count
 * (ir/date.ts), span endpoints, LEAST
 * and GREATEST by the type's order, and a set's union, intersection, difference, cardinality, subset and
 * disjointness, and a set with one more handle, over its handles. Each case reads its operands as the host values of
 * the carriers its overload takes (identity.ts hostOf); the IR's typing guarantees them, so another is a defect. `and`,
 * `or` and casts are evaluated by their nodes, never applied.
 */
const applied = (op: NativeOp, argTypes: ReadonlyArray<ScalarType>, type: ScalarType): Apply => {
	const a = operandOf(op.fn, 0)
	const b = operandOf(op.fn, 1)
	const c = firstOperand(op.operands)
	const fn = op.fn
	switch (fn) {
		case "add":
		case "sub":
		case "mul":
		case "div":
		case "mod": {
			const f = arithmetic(fn, c, type)
			return (args) => f(a(args), b(args))
		}
		case "quot":
			return (args) => lift(N.divTrunc(hostOf("numeric", a(args)), hostOf("numeric", b(args))))
		case "rem":
			return (args) => lift(N.mod(hostOf("numeric", a(args)), hostOf("numeric", b(args))))
		case "neg":
		case "abs":
		case "sign": {
			const f = signed(fn, c, type)
			return (args) => f(a(args))
		}
		case "gcd":
		case "lcm": {
			if (c === "numeric") {
				return refused(`${fn} over numeric, outside a check`)
			}
			const read = integerOf(c)
			const host = integerHost(type)
			return (args) => {
				const x = read(a(args))
				const y = read(b(args))
				const g = gcdOf(x, y)
				if (fn === "gcd") {
					return Result.ok(host(g))
				}
				const product = x * y
				return Result.ok(host(g === 0n ? 0n : (product < 0n ? -product : product) / g))
			}
		}
		case "lower":
		case "upper": {
			if (c !== "range4" && c !== "range8" && c !== "rangeDate") {
				return () => {
					defect(`${fn} of a range, not of a ${c}`)
				}
			}
			return fn === "lower"
				? (args) => Result.ok(hostOf(c, a(args)).start)
				: (args) => Result.ok(hostOf(c, a(args)).end)
		}
		case "charLength": {
			const host = integerHost(type)
			return (args) => Result.ok(host(BigInt(Array.from(hostOf("text", a(args))).length)))
		}
		case "octetLength": {
			const host = integerHost(type)
			return (args) => Result.ok(host(BigInt(utf8Length(hostOf("text", a(args))))))
		}
		case "utf16Length": {
			const host = integerHost(type)
			return (args) => {
				const text = hostOf("text", a(args))
				return utf8Length(text) > regexTextMaxBytes
					? undefinedAt("bounded")
					: Result.ok(host(BigInt(text.length)))
			}
		}
		case "concat":
			return (args) => Result.ok(hostOf("text", a(args)) + hostOf("text", b(args)))
		case "startsWith":
			return (args) => Result.ok(hostOf("text", a(args)).startsWith(hostOf("text", b(args))))
		case "endsWith":
			return (args) => Result.ok(hostOf("text", a(args)).endsWith(hostOf("text", b(args))))
		case "contains":
			return (args) => Result.ok(hostOf("text", a(args)).includes(hostOf("text", b(args))))
		case "right": {
			const count = integerOf(baseOf(defined(argTypes[1], "right's count")).carrier)
			return (args) => Result.ok(rightOf(hostOf("text", a(args)), count(b(args))))
		}
		case "matches":
			return (args, patterns) =>
				Result.ok(patterns.matches(hostOf("text", b(args)), hostOf("text", a(args))))
		case "collapse":
			return (args) => Result.ok(collapsed(hostOf("text", a(args))))
		case "lowerAscii":
			return (args) => Result.ok(asciiLowered(hostOf("text", a(args))))
		case "resolveReference":
			return (args) => Result.ok(resolveReference(hostOf("text", a(args)), hostOf("text", b(args))))
		case "cutBefore":
			return (args) => Result.ok(cutBefore(hostOf("text", a(args)), hostOf("text", b(args))))
		case "cutFrom":
			return (args) => Result.ok(cutFrom(hostOf("text", a(args)), hostOf("text", b(args))))
		case "isXsdPattern":
			return (args) => Result.ok(xsdPattern(hostOf("text", a(args))).ok)
		case "sha256":
			return c === "bytes"
				? (args) => Result.ok(Uint8Array.fromHex(hostOf("bytes", a(args)).digest))
				: (args) => Result.ok(sha256Digest(wellFormed(hostOf("text", a(args)))))
		case "floatBits": {
			const carrier =
				baseOf(defined(argTypes[0], "floatBits's operand")).carrier === "float4"
					? "float4"
					: "float8"
			const host = integerHost(type)
			return (args) => Result.ok(host(floatBits(hostOf(carrier, a(args)))))
		}
		case "replace": {
			const third = operandOf(fn, 2)
			return (args) =>
				Result.ok(
					replacedAll(hostOf("text", a(args)), hostOf("text", b(args)), hostOf("text", third(args)))
				)
		}
		case "btrim":
			return refused(`${fn} alone, which only collapse's SQL reads`)
		case "regexpCount":
			return refused("regexp_count alone, which only utf16Length's SQL reads")
		case "strpos":
			return refused("strpos alone, which only contains's SQL reads")
		case "parseFloat8":
			return (args) => {
				const value = doubleOfText(hostOf("text", a(args)))
				return value === undefined ? undefinedAt("lexical") : Result.ok(value)
			}
		case "parseNumeric":
			return (args) => {
				const value = decimalOfText(hostOf("text", a(args)))
				return value === undefined ? undefinedAt("lexical") : Result.ok(value)
			}
		case "translate": {
			const third = operandOf(fn, 2)
			return (args) =>
				Result.ok(
					translated(hostOf("text", a(args)), hostOf("text", b(args)), hostOf("text", third(args)))
				)
		}
		case "eq":
		case "ne":
		case "lt":
		case "le":
		case "gt":
		case "ge":
		case "between":
		case "in": {
			const holds = comparison(fn, defined(argTypes[0], `the operand type of ${fn}`))
			return (args) => Result.ok(holds(args))
		}
		case "not":
			return (args) => Result.ok(!hostOf("bool", a(args)))
		case "union":
			return (args) => Result.ok(new Set([...hostOf("bits", a(args)), ...hostOf("bits", b(args))]))
		case "intersection":
			return (args) => {
				const y = hostOf("bits", b(args))
				return Result.ok(new Set([...hostOf("bits", a(args))].filter((h) => y.has(h))))
			}
		case "difference":
			return (args) => {
				const y = hostOf("bits", b(args))
				return Result.ok(new Set([...hostOf("bits", a(args))].filter((h) => !y.has(h))))
			}
		case "cardinality": {
			const host = integerHost(type)
			return (args) => Result.ok(host(BigInt(hostOf("bits", a(args)).size)))
		}
		case "subset":
			return (args) => {
				const y = hostOf("bits", b(args))
				return Result.ok([...hostOf("bits", a(args))].every((h) => y.has(h)))
			}
		case "disjoint":
			return (args) => {
				const y = hostOf("bits", b(args))
				return Result.ok(![...hostOf("bits", a(args))].some((h) => y.has(h)))
			}
		case "adjoin":
			return (args) => Result.ok(new Set([...hostOf("bits", a(args)), hostOf("code", b(args))]))
		case "netWithin":
		case "netStrictlyWithin":
		case "netOverlaps": {
			const left = netCarrierOf(defined(argTypes[0], `${fn}'s first operand`))
			const right = netCarrierOf(defined(argTypes[1], `${fn}'s second operand`))
			const holds = netTests[fn]
			return (args) =>
				Result.ok(
					holds(netValueOf(hostOf(left, a(args)), left), netValueOf(hostOf(right, b(args)), right))
				)
		}
		case "epochDay": {
			const host = integerHost(type)
			return (args) => Result.ok(host(BigInt(epochDayOf(hostOf("date", a(args))))))
		}
		case "dateOfEpochDay": {
			const days = integerOf(c)
			return (args) => {
				const n = days(a(args))
				return n < epochDayRange.low || n > epochDayRange.high
					? undefinedAt("fits")
					: Result.ok(dateOfEpochDay(n))
			}
		}
		case "datePlus": {
			const days = integerOf(baseOf(defined(argTypes[1], "datePlus's days")).carrier)
			return (args) => {
				const n = BigInt(epochDayOf(hostOf("date", a(args)))) + days(b(args))
				return n < epochDayRange.low || n > epochDayRange.high
					? undefinedAt("fits")
					: Result.ok(dateOfEpochDay(n))
			}
		}
		case "wall":
			return refused(
				"Time.wall, a zone's wall clock by PostgreSQL's tzdata, which the host does not hold"
			)
		case "complement":
			return refused("complement, which no scalar operation yields")
		case "canonical": {
			const carrier = c === "float4" ? "float4" : "float8"
			return (args) => Result.ok(hostOf(carrier, a(args)) + 0)
		}
		case "least":
		case "greatest": {
			const extreme = extremum(fn, argTypes)
			return (args) => Result.ok(extreme(args))
		}
		case "round":
		case "trunc":
		case "ceil":
		case "floor":
		case "power":
		case "sqrt":
		case "widthBucket":
		case "minScale":
		case "cosineDistance":
			return refused(`${fn}, outside a check's vocabulary`)
		case "searchPart":
		case "searchConcat":
		case "websearchMatches":
		case "plainMatches":
		case "websearchRank":
		case "plainRank":
		case "websearchRankCd":
		case "plainRankCd":
			return refused(`${fn}, PostgreSQL's full text search, which the host does not evaluate`)
		case "and":
		case "or":
		case "cast":
			return refused(`${fn} evaluated by its node`)
	}
}

/** Each network containment test over two network values (scalar/values/net.ts), false across the families. */
const netTests = {
	netWithin,
	netStrictlyWithin,
	netOverlaps
} as const satisfies {
	readonly [F in "netWithin" | "netStrictlyWithin" | "netOverlaps"]: (
		a: NetValue,
		b: NetValue
	) => boolean
}

/** The network carrier of a containment operand's type: inet or cidr, as its typing proved (typing.ts netContainment). */
const netCarrierOf = (type: ScalarType): NetCarrier => {
	const carrier = baseOf(type).carrier
	if (carrier !== "inet" && carrier !== "cidr") {
		defect(`a network containment operand of inet or cidr, not of ${carrier}`)
	}
	return carrier
}

/**
 * LEAST or GREATEST of its operands' values, NULL skipped, staged once over its operands' types `argTypes`: the first
 * value that is no NULL, replaced by each later one past it in the order of that first value's type (orderOf), NULL
 * where every operand is NULL.
 */
const extremum = (
	fn: "least" | "greatest",
	argTypes: ReadonlyArray<ScalarType>
): ((values: ReadonlyArray<SqlValue>) => SqlValue) => {
	const orders = argTypes.map(orderOf)
	return (values) => {
		let chosen: { readonly value: HostValue; readonly compare: Compare } | undefined
		for (const [i, v] of values.entries()) {
			if (v === sqlNull) {
				continue
			}
			if (chosen === undefined) {
				chosen = { value: v, compare: defined(orders[i], `the operand type of ${fn}`) }
				continue
			}
			const order = chosen.compare(v, chosen.value)
			if (fn === "greatest" ? order > 0 : order < 0) {
				chosen = { value: v, compare: chosen.compare }
			}
		}
		return chosen === undefined ? sqlNull : chosen.value
	}
}

/**
 * A native operation over operand values that may be NULL, as PostgreSQL applies it, staged once where its expression is
 * compiled: over values alone, `present`; otherwise, where one or more is NULL, `absent`.
 */
interface Operation {
	readonly present: Apply
	readonly absent: (values: ReadonlyArray<SqlValue>) => SqlResult
}

/**
 * The native operation `op` over operands of the types `argTypes`, of the type `type`, staged once (Operation): over
 * values alone, its application (applied); over a NULL operand, as its NULL rule says (registry.ts nullRules), the one
 * statement of it, which grizzle's library functions are declared STRICT by too: LEAST and GREATEST over their values
 * that are no NULL, NULL where none is; BETWEEN as `a >= low AND a <= high` and IN as the OR of its equalities, by
 * Kleene's logic; AND, OR and a cast by their own nodes; and every strict operation NULL.
 */
const operation = (
	op: NativeOp,
	argTypes: ReadonlyArray<ScalarType>,
	type: ScalarType
): Operation => {
	const present = applied(op, argTypes, type)
	const rule = nullRules[op.fn]
	switch (rule) {
		case "least":
		case "greatest": {
			const extreme = extremum(rule, argTypes)
			return { present, absent: (values) => Result.ok(extreme(values)) }
		}
		case "between":
		case "in": {
			const compare = orderOf(defined(argTypes[0], `the operand type of ${rule}`))
			/** One comparison of `a` with `b` by `holds` over their order, NULL where either is NULL. */
			const compared = (a: SqlValue, b: SqlValue, holds: (order: -1 | 0 | 1) => boolean): Truth =>
				a === sqlNull || b === sqlNull ? sqlNull : holds(compare(a, b))
			return rule === "between"
				? {
						present,
						absent: ([a, low, high]) =>
							Result.ok(
								conjunction([
									compared(
										defined(a, `the first operand of ${rule}`),
										defined(low, "BETWEEN's low"),
										(order) => order >= 0
									),
									compared(
										defined(a, `the first operand of ${rule}`),
										defined(high, "BETWEEN's high"),
										(order) => order <= 0
									)
								])
							)
					}
				: {
						present,
						absent: ([a, ...items]) =>
							Result.ok(
								disjunction(
									items.map((item) =>
										compared(
											defined(a, `the first operand of ${rule}`),
											item,
											(order) => order === 0
										)
									)
								)
							)
					}
		}
		case "node": {
			const stop = unsupported(`${op.fn} evaluated by its node`)
			return { present, absent: () => stop }
		}
		case "strict":
			return { present, absent: () => nullValue }
	}
}

/** The integer carriers, a term's exact integers among them, whose values the evaluator computes as bigints. */
type IntegerCarrier = "int2" | "int4" | "int8" | "exactInteger"

const isIntegerCarrier = (c: Carrier): c is IntegerCarrier =>
	c === "int2" || c === "int4" || c === "int8" || c === "exactInteger"

/**
 * A registered cast's host conversion of a host value of the cast's source carrier `source`, read as its family's
 * (cast.ts HostCast), staged once: an integer widened to a bigint, a float or money as it is. The IR's typing makes
 * `source` one of the family's carriers, so another is a defect, which the conversion throws.
 */
const castOperand = (
	host: HostCast,
	source: Carrier,
	to: ScalarType
): ((v: HostValue) => Result.Result<CastValue, Undefined>) => {
	switch (host.from) {
		case "integer": {
			const read = integerOf(source)
			return (v) => host.convert(read(v))
		}
		case "numeric":
			return (v) => host.convert(hostOf("numeric", v))
		case "float":
			if (source !== "float4" && source !== "float8") {
				return () => {
					defect(`a cast from a float, not from a ${source}`)
				}
			}
			return (v) => host.convert(hostOf(source, v))
		case "money":
			if (source !== "money" && source !== "exactMoney") {
				return () => {
					defect(`a cast from money, not from a ${source}`)
				}
			}
			return (v) => host.convert(hostOf(source, v))
		case "text": {
			const base = baseOf(to)
			return (v) => host.convert(hostOf("text", v), base)
		}
	}
}

/**
 * A cast's result as the host value of its target `to`, staged once: an integer's bigint narrowed to its carrier's
 * (integerHost), every other result its target's host value as the cast computes it.
 */
const castHost = (to: ScalarType): ((value: CastValue) => HostValue) => {
	if (!isIntegerCarrier(baseOf(to).carrier)) {
		return (value) => value
	}
	const host = integerHost(to)
	return (value) => {
		if (typeof value !== "bigint") {
			defect(`a cast into ${typeLabel(to)} yields an integer`)
		}
		return host(value)
	}
}

/**
 * A native cast between the value types of two descriptors, then the target's numeric typmod coercion, staged once:
 * the registered cast between their carriers resolved (castOf), none where they are one carrier.
 */
const caster = (from: ScalarType, to: ScalarType): Unary => {
	const source = baseOf(from).carrier
	const target = baseOf(to).carrier
	const typmod = numericTypmodOf(baseOf(to))
	const converted = ((): Unary => {
		if (source === target) {
			return (v) => Result.ok(v)
		}
		const native = castOf(source, target)
		if (native === undefined) {
			return refused(`a cast from ${source} to ${target}`)
		}
		const operand = castOperand(native.host, source, to)
		const host = castHost(to)
		return (v) => {
			const cast = operand(v)
			return cast.ok ? Result.ok(host(cast.value)) : undefinedAt(cast.error)
		}
	})()
	if (typmod === undefined) {
		return converted
	}
	return (v) => {
		const out = converted(v)
		if (!out.ok) {
			return out
		}
		const normalized = normalizeNumeric(hostOf("numeric", out.value), typmod)
		return normalized.ok ? Result.ok(normalized.value) : undefinedAt("fits")
	}
}

/** An expression the evaluator refuses wherever it is evaluated, compiled once: the same stop at every evaluation. */
const refusedExpr = (what: string): CompiledExpr => {
	const stop = unsupported(what)
	return () => stop
}

/**
 * AND or OR over its operands by Kleene's logic, left to right as PostgreSQL evaluates them: the deciding operand, false
 * for AND and true for OR, ends it; otherwise it is NULL where an operand is NULL, and the other truth where none is.
 */
const connective = (fn: "and" | "or", args: ReadonlyArray<CompiledExpr>): CompiledExpr => {
	const deciding = fn === "or"
	const undecided: SqlResult = Result.ok(!deciding)
	return (leaves, patterns) => {
		let unknown = false
		for (const arg of args) {
			const v = arg(leaves, patterns)
			if (!v.ok || v.value === deciding) {
				return v
			}
			unknown ||= v.value === sqlNull
		}
		return unknown ? nullValue : undecided
	}
}

/**
 * A native operation of its type over its operands, each evaluated left to right, the first stop ending it, then applied
 * as PostgreSQL applies it over values that may be NULL (Operation): its application over values alone, read as they
 * are evaluated, and its NULL behaviour where one is NULL, read once every operand is evaluated.
 */
const operationExpr = (args: ReadonlyArray<CompiledExpr>, op: Operation): CompiledExpr => {
	/** The operands past the first NULL one at `values`, evaluated, then the operation's NULL behaviour over them. */
	const absent = (
		values: Array<SqlValue>,
		leaves: EvalLeaves,
		patterns: PatternReads
	): SqlResult => {
		for (const arg of args.slice(values.length)) {
			const v = arg(leaves, patterns)
			if (!v.ok) {
				return v
			}
			values.push(v.value)
		}
		return op.absent(values)
	}
	return (leaves, patterns) => {
		const present: Array<HostValue> = []
		for (const arg of args) {
			const v = arg(leaves, patterns)
			if (!v.ok) {
				return v
			}
			if (v.value === sqlNull) {
				return absent([...present, sqlNull], leaves, patterns)
			}
			present.push(v.value)
		}
		return op.present(present, patterns)
	}
}

/**
 * A read of a closed relation (C.at, C.row, C.has) at its operands' values, each evaluated left to right, the first
 * stop ending it: NULL where one is NULL, else what the leaves' closed relations answer, unsupported where they hold
 * none.
 */
const closedExpr = (
	read: TableExprOf<"closedAt" | "closedRow" | "closedHas">,
	args: ReadonlyArray<CompiledExpr>
): CompiledExpr => {
	const stop = unsupported(`a read of the closed relation ${read.relation}`)
	return (leaves, patterns) => {
		const key: Array<HostValue> = []
		let absent = false
		for (const arg of args) {
			const v = arg(leaves, patterns)
			if (!v.ok) {
				return v
			}
			if (v.value === sqlNull) {
				absent = true
			} else {
				key.push(v.value)
			}
		}
		if (absent) {
			return nullValue
		}
		const value = leaves.closed(read, key)
		return value === undefined ? stop : Result.ok(value)
	}
}

/**
 * A strict declared function's call (nonNull "strict") at its operands' values, each evaluated left to right, the first
 * stop ending it: NULL where one is NULL, as PostgreSQL answers a STRICT function's call without running its body;
 * unsupported where every one is a value, since PostgreSQL alone runs a body.
 */
const strictCallExpr = (
	call: TableExprOf<"call">,
	args: ReadonlyArray<CompiledExpr>
): CompiledExpr => {
	const stop = unsupported(
		`a call of the declared function ${call.function.name} at values, which PostgreSQL alone evaluates`
	)
	return (leaves, patterns) => {
		let absent = false
		for (const arg of args) {
			const v = arg(leaves, patterns)
			if (!v.ok) {
				return v
			}
			absent ||= v.value === sqlNull
		}
		return absent ? nullValue : stop
	}
}

/**
 * The operands before a dangling one, each evaluated left to right, the first stop ending it, and then the dangling
 * operand's own stop: what an operation over an operand its table does not hold evaluates to.
 */
const danglingExpr =
	(before: ReadonlyArray<CompiledExpr>, dangling: CompiledExpr): CompiledExpr =>
	(leaves, patterns) => {
		for (const arg of before) {
			const v = arg(leaves, patterns)
			if (!v.ok) {
				return v
			}
		}
		return dangling(leaves, patterns)
	}

/**
 * A variant's operation evaluated over its operands (ir/expr.ts ScalarExpr `variant`), NULL where an operand is: its
 * tag, the handle its value holds; one field of an arm, the value its arm holds there, NULL where its value holds
 * another arm, as its composite's absent attribute reads; a value of an arm, its handle and its fields, each operand one
 * field of the arm in declared order; its identity image (scalar/variant-digest.ts hostVariantDigest).
 */
const variantExpr = (
	expr: TableExprOf<"variant">,
	args: ReadonlyArray<CompiledExpr>,
	argTypes: ReadonlyArray<ScalarType | undefined>
): CompiledExpr => {
	const { op } = expr
	switch (op.kind) {
		case "digest": {
			const subject = defined(args[0], "a variant digest's subject")
			const type = argTypes[0]
			const base = type === undefined ? undefined : baseOf(type)
			if (base?.carrier !== "variant") {
				return refusedExpr("a digest of a variant's value")
			}
			return (leaves, patterns) =>
				Result.map(subject(leaves, patterns), (v): SqlValue =>
					v === sqlNull ? sqlNull : hostVariantDigest(base.variant, hostOf("variant", v))
				)
		}
		case "tag":
		case "field": {
			const subject = defined(args[0], "a variant operation's subject")
			return (leaves, patterns) =>
				Result.map(subject(leaves, patterns), (v): SqlValue => {
					if (v === sqlNull) {
						return sqlNull
					}
					const held = hostOf("variant", v)
					if (op.kind === "tag") {
						return held.tag
					}
					return held.tag === op.handle ? evaluatedValue(expr.type, held[op.field]) : sqlNull
				})
		}
		case "make": {
			const base = baseOf(expr.type)
			if (base.carrier !== "variant") {
				return refusedExpr("a made value of a variant")
			}
			const arm = base.variant.arms.find((a) => a.handle === op.handle)
			if (arm === undefined) {
				return refusedExpr(`the arm ${op.handle} of variant ${base.variant.name}`)
			}
			return (leaves, patterns) => {
				const value: Record<string, unknown> = { tag: op.handle }
				for (const [i, field] of arm.fields.entries()) {
					const v = defined(args[i], `the field ${field.name} of a made value`)(leaves, patterns)
					if (!v.ok) {
						return v
					}
					if (v.value === sqlNull) {
						return Result.ok(sqlNull)
					}
					value[field.name] = heldValue(field.type, v.value)
				}
				return Result.ok(Object.freeze({ ...value, tag: op.handle }))
			}
		}
	}
}

/**
 * The expression `root` of its table `exprs` compiled (CompiledExpr), each expression of the table compiled once,
 * however many expressions read it (compiledNode): each literal converted to its host value, each operator resolved to
 * its native operation and staged over its operands' types (operation), each comparison's order read and each cast
 * resolved, so an evaluation reads no table, converts no literal and resolves no operator. An expression the table does
 * not hold, an operator the registry does not list, a parameter and a VALUE outside a contract predicate are
 * unsupported where they are evaluated, as a branch the evaluation does not take never reads them.
 */
const compiledTable = (exprs: Readonly<Record<ExprId, TableExpr>>, root: ExprId): CompiledExpr => {
	const compiled = new Map<ExprId, CompiledExpr>()
	const entryOf = (id: ExprId): TableExpr | undefined =>
		Object.hasOwn(exprs, id) ? exprs[id] : undefined
	const node = (id: ExprId): CompiledExpr => {
		const known = compiled.get(id)
		if (known !== undefined) {
			return known
		}
		const made = compiledNode(id, entryOf(id))
		compiled.set(id, made)
		return made
	}
	/** One expression of the table compiled, its operands compiled first (node). */
	const compiledNode = (id: ExprId, expr: TableExpr | undefined): CompiledExpr => {
		if (expr === undefined) {
			return refusedExpr(`an expression named ${id}`)
		}
		switch (expr.kind) {
			case "value": {
				const stop = unsupported("a domain's VALUE outside a domain predicate")
				return (leaves) => (leaves.value === undefined ? stop : Result.ok(leaves.value))
			}
			case "column": {
				const ref = expr.column
				const stop = unsupported(`the column ${ref.name}`)
				return (leaves) => {
					const read = leaves.column(ref)
					return read === undefined ? stop : Result.ok(read)
				}
			}
			case "param": {
				const param = expr.param
				const stop = unsupported(`the parameter ${param}`)
				return (leaves) => {
					const read = leaves.param(param)
					return read === undefined ? stop : Result.ok(read)
				}
			}
			case "literal": {
				const value: SqlResult = Result.ok(hostOfLiteral(baseOf(expr.type).carrier, expr.value))
				return () => value
			}
			case "cond": {
				const [p, t, e] = expr.args
				const condition = node(p)
				const then = node(t)
				const otherwise = node(e)
				return (leaves, patterns) => {
					const c = condition(leaves, patterns)
					if (!c.ok) {
						return c
					}
					return c.value === true ? then(leaves, patterns) : otherwise(leaves, patterns)
				}
			}
			case "cast":
				return castExpr(expr.args[0], expr.type)
			case "domainCast": {
				/**
				 * A domain cast is its coercion into the target's base: whether the value is a member of the target's
				 * domain is the domain's to judge where the value is stored or read, PostgreSQL's CHECK on a write, by the
				 * domain's law, and rowEvaluator's DomainRefused on a row, never this evaluation's precondition. Over a row
				 * inside its domains a proved cast's value is a member; over a written row past its own domain, which only
				 * PostgreSQL holds to it, the value is still the one PostgreSQL computes before its domain refuses it.
				 */
				const base = baseOf(expr.type)
				return castExpr(expr.args[0], base)
			}
			case "op": {
				const op = nativeOp(expr.op)
				if (op === undefined) {
					return refusedExpr(`the operator ${describeOp(expr.op)}`)
				}
				const args = expr.args.map(node)
				if (op.fn === "and" || op.fn === "or") {
					return connective(op.fn, args)
				}
				const types: Array<ScalarType> = []
				for (const [i, a] of expr.args.entries()) {
					const operand = entryOf(a)
					if (operand === undefined) {
						return danglingExpr(args.slice(0, i), node(a))
					}
					types.push(operand.type)
				}
				return operationExpr(args, operation(op, types, expr.type))
			}
			case "closedAt":
			case "closedRow":
			case "closedHas":
				return closedExpr(expr, expr.args.map(node))
			case "variant":
				return variantExpr(
					expr,
					expr.args.map(node),
					expr.args.map((a) => entryOf(a)?.type)
				)
			case "call":
				switch (expr.nonNull) {
					case "returned":
						return refusedExpr(
							`a call of the declared function ${expr.function.name}, which PostgreSQL alone evaluates`
						)
					case "strict":
						return strictCallExpr(expr, expr.args.map(node))
				}
		}
	}
	/** A cast of the operand `operand` into `to`, its value NULL where the operand's is (caster). */
	const castExpr = (operand: ExprId, to: ScalarType): CompiledExpr => {
		const arg = entryOf(operand)
		const run = node(operand)
		if (arg === undefined) {
			return run
		}
		const cast = caster(arg.type, to)
		return (leaves, patterns) => {
			const v = run(leaves, patterns)
			return !v.ok || v.value === sqlNull ? v : cast(v.value)
		}
	}
	return node(root)
}

/** Every table compiled, by the table: an immutable table's compiled form, kept with it for as long as it lives. */
const compiledTables = new WeakMap<ExprTable, CompiledExpr>()

/**
 * The host's evaluation of a table's root expression (CompiledExpr), compiled where the table is first evaluated
 * (compiledTable) and kept with the table: a table is immutable, so every later evaluation of it, over any row, reads
 * the same compiled form, and interprets nothing. The one evaluation of a contract predicate over its VALUE and of a
 * generation expression, a row check, a selection or a guard over its row.
 */
export const compiledExpr = (table: ExprTable): CompiledExpr => {
	const known = compiledTables.get(table)
	if (known !== undefined) {
		return known
	}
	const made = compiledTable(table.exprs, table.root)
	compiledTables.set(table, made)
	return made
}

/**
 * How a literal's admission judges its type's refinements: against the contract's predicates and the regex refinements,
 * by `patterns`, or not at all, where a builder only shapes a term (compute/typing.ts literal).
 */
type LiteralJudgment =
	| { readonly kind: "refinements"; readonly patterns: PatternReads }
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
 * checks against the contract's predicate at compile time (a refusal is CompileError ContractLiteral), constant folding
 * of a comparison, BETWEEN or IN over literals (lower/optimize/simplify/boolean.ts, by comparisonHolds), a constant
 * subterm of a persistent expression (physical/ddl/expr.ts), and a write's fills and witness over its rows
 * (runtime/write/fill.ts, runtime/write/witness.ts). A contract predicate reads only its VALUE through a check's
 * vocabulary (registry.ts computeSpecs, check), whose every operation is total or proved where it stands, so its evaluation never
 * meets an undefined operation, and this evaluator covers exactly that: comparisons, BETWEEN, IN, boolean composition,
 * integer arithmetic exactly, money exactly, numeric as numeric.c computes it, floats as IEEE 754, abs, sign and neg,
 * gcd and lcm of integers, char_length, a text's concatenation, prefix and suffix tests, regex match and translation,
 * span endpoints, a set's algebra, conditionals, guards and the casts between them, and the closed reads its leaves
 * answer (EvalLeaves closed). Any other operation, and any read its leaves do not hold, is `unsupported`, never an
 * approximation. The host never substitutes JavaScript arithmetic for a SQL expression in a query.
 *
 * Every value is its type carrier's host value, the codec's own (scalar/values/identity.ts CarrierHost), so a row's field
 * and an evaluated term are read and written as they are, with no form of the evaluator's own, but an integer numeric's,
 * numeric(p, 0), whose field holds a bigint and whose evaluated value is the Numeric numeric.c computes with: a field
 * enters at evaluatedValue and a generated value leaves at heldValue (identity.ts). An integer operation widens its
 * operands to bigints and narrows its result to its type's carrier, so smallint's and integer's values stay JavaScript
 * integers. Comparison is PostgreSQL's total order of the type (identity.ts compareValues, the host's one): NaN above
 * every number and equal to itself, -0 equal to 0, numeric by value, text in code point order under the fixed C.UTF-8
 * collation, bytes by bytes, closed ids in roster order, which is code order (evaluatorOrder), vectors as vector_cmp. A regex
 * refinement's membership is the text package's NFA, which the caller supplies.
 *
 * The one admission of a literal at a typed slot, in one order wherever it appears, bound by a match, compared, cast or
 * computed: its host kind and range against the base type first, as it meets the type (literal.ts LiteralMeeting: a
 * stored value coerced to a typmod, a compared one held to it as written), MalformedDescription when it is none of the
 * base's values whatever contract the type carries; then a value of the base against the contract's predicates and the
 * regex refinements, ContractLiteral when they refuse it and UnsupportedOperation when the check cannot be evaluated.
 */
export const admitLiteral = (
	value: LiteralDesc,
	type: ScalarType,
	judgment: LiteralJudgment,
	meeting: LiteralMeeting
): Result.Result<TypedLiteral, LiteralRefusal> => {
	const typed = literalAt[meeting](value, type)
	if (!typed.ok) {
		return Result.err({
			reason: "MalformedDescription",
			capability: `a literal of ${typeLabel(type)}: ${typed.error}`
		})
	}
	return judgment.kind === "shape"
		? Result.ok(typed.value)
		: refined(typed.value, type, judgment.patterns)
}

/**
 * A value of `type`'s base held to `type`'s refinements at every level, a contract's predicate and a pattern: the
 * ContractLiteral judgment, which admitLiteral makes after the value's base, and which a closed relation's admitted cell
 * meets alone, its base proved where it was admitted (ir/desc.ts AdmittedClosedRelation). A type with no refinement
 * holds every value of its base.
 */
export const refined = (
	literal: TypedLiteral,
	type: ScalarType,
	patterns: PatternReads
): Result.Result<TypedLiteral, LiteralRefusal> => {
	if (!isRefined(type)) {
		return Result.ok(literal)
	}
	const member = membership(hostOfLiteral(baseOf(type).carrier, literal), type, patterns)
	if (!member.ok) {
		return Result.err({
			reason: "UnsupportedOperation",
			capability: `the ContractLiteral check of ${typeLabel(type)}: ${member.error.kind === "unsupported" ? member.error.what : `an operation its predicate holds undefined at the literal (${member.error.precondition})`}`
		})
	}
	if (!member.value) {
		return Result.err({
			reason: "ContractLiteral",
			capability: `a literal of ${typeLabel(type)}: the literal violates its ${type.contract === undefined ? "regex refinement" : "contract"}`
		})
	}
	return Result.ok(literal)
}

/** A contract predicate's read of what it holds none of: a column and a closed relation, which it never reads. */
const noRead = (): undefined => undefined

/**
 * Whether a contract's predicate holds of `v`, its VALUE, regex membership read by `patterns`: a contract without one
 * constrains nothing.
 */
const predicateHolds = (
	predicate: ExprTable | undefined,
	v: HostValue,
	patterns: PatternReads
): Result.Result<boolean, EvalStop> => {
	if (predicate === undefined) {
		return Result.ok(true)
	}
	const holds = compiledExpr(predicate)(
		{ value: v, column: noRead, closed: noRead, param: noParamLeaf },
		patterns
	)
	return !holds.ok ? Result.err(holds.error) : Result.ok(holds.value === true)
}

/**
 * Whether a value of a contract's base satisfies the contract at every level: each level's base refinement (a regex),
 * then its predicate, innermost first, as PostgreSQL checks a domain over a domain. Each predicate reads its VALUE and
 * regex membership by `patterns`. A variant's value is judged as its domain's CHECK judges it (variantMembership).
 */
const membership = (
	v: HostValue,
	t: ScalarType,
	patterns: PatternReads
): Result.Result<boolean, EvalStop> => {
	const base = baseOf(t)
	if (base.carrier === "variant") {
		return variantMembership(hostOf("variant", v), base.variant, patterns)
	}
	const levels: Array<ScalarType> = []
	for (let at: ScalarType | undefined = t; at !== undefined; at = at.contract?.base) {
		levels.push(at)
	}
	for (const level of levels.toReversed()) {
		const { contract } = level
		const pattern = contract === undefined ? regexRefOf(level) : undefined
		if (pattern !== undefined && !regexHolds(patterns, pattern, v)) {
			return Result.ok(false)
		}
		const holds = predicateHolds(contract?.predicate, v, patterns)
		if (!holds.ok || !holds.value) {
			return holds
		}
	}
	return Result.ok(true)
}

/**
 * Whether a variant's value is a member of its domain, as the domain's CHECK holds it (physical/ddl/variants.ts
 * armCheck), from the one VariantInfo the CHECK is printed from: each field of its tagged arm a member of that field's
 * own type (a contract's, a pattern's), as the CHECK's cast of the field's attribute to its column's type judges it,
 * then the arm's check, a predicate over the value. The value's codec admitted its shape, its tag a live handle of the
 * roster and each of the arm's fields a value of its base, so the other arms' fields are absent.
 */
const variantMembership = (
	value: VariantValue,
	variant: VariantInfo,
	patterns: PatternReads
): Result.Result<boolean, EvalStop> => {
	const arm = variant.arms.find((a) => a.handle === value.tag)
	if (arm === undefined) {
		defect(`an admitted value's arm ${value.tag} is an arm of variant ${variant.name}`)
	}
	for (const field of arm.fields) {
		const member = membership(evaluatedValue(field.type, value[field.name]), field.type, patterns)
		if (!member.ok || !member.value) {
			return member
		}
	}
	return predicateHolds(arm.check, value, patterns)
}

/**
 * Whether a typed literal is a value of `type`'s refinements at every level (membership), or undefined where the
 * evaluator cannot decide it: the ContractLiteral judgment of a literal cast into a refined type.
 */
export const literalMember = (
	literal: TypedLiteral,
	type: ScalarType,
	patterns: PatternReads
): boolean | undefined => valueMember(hostOfLiteral(baseOf(type).carrier, literal), type, patterns)

/**
 * Whether a host value is a value of `type`'s refinements at every level (membership), or undefined where the
 * evaluator cannot decide it: what the host judges a stored value against when a domain refused it.
 */
export const valueMember = (
	value: HostValue,
	type: ScalarType,
	patterns: PatternReads
): boolean | undefined => {
	const member = membership(value, type, patterns)
	return member.ok ? member.value : undefined
}
