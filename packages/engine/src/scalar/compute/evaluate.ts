import { regexTextMaxBytes } from "#compiler/core/errors.ts"
import type { ExprId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { asciiLowered, collapsed, translated } from "#compiler/core/text.ts"
import { declaredOrder } from "#compiler/ir/codes.ts"
import { dayNumber } from "#compiler/ir/date.ts"
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
import { hostOfLiteral, irLiteral } from "#compiler/scalar/compute/literal.ts"
import * as N from "#compiler/scalar/compute/numeric.ts"
import {
	castOf,
	firstOperand,
	type NativeFn,
	type NativeOp,
	nativeOp,
	type Undefined
} from "#compiler/scalar/compute/registry.ts"
import { decimalOfText, doubleOfText } from "#compiler/scalar/lexical.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"
import { normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { canonicalZero } from "#compiler/scalar/values/float.ts"
import {
	compareValues,
	type HostValue,
	hostOf,
	type OrderSpec
} from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"

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
type SqlResult = Result.Result<SqlValue, EvalStop>

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
 * closed relation, which the evaluation refuses as unsupported.
 */
export interface EvalLeaves {
	readonly value: HostValue | undefined
	readonly column: (ref: ColumnRef) => SqlValue | undefined
	readonly closed: (read: ClosedReadNode, args: ReadonlyArray<HostValue>) => SqlValue | undefined
}

/** Whether a value is a value of its type, not NULL. */
const isPresent = (v: SqlValue): v is HostValue => v !== sqlNull

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

/** A text's membership in a regex refinement, by the caller's patterns: a regex refines a text type alone. */
const regexHolds = (patterns: PatternReads, regex: RegexRef, v: HostValue): boolean =>
	patterns.member(regex, hostOf("text", v))

const lift = <A extends HostValue>(r: Result.Result<A, Undefined>): EvalResult =>
	r.ok ? Result.ok(r.value) : undefinedAt(r.error)

/**
 * The order the evaluator compares values of `type` by (scalar/values/identity.ts compareValues), its base's: a closed
 * id's and a set's ranked by their roster's declaration (ir/codes.ts declaredOrder). An ordered roster's is its codes'
 * order, the one a codec's spec ranks them by (HandleOrder), so the evaluator needs no installation's codes and agrees
 * with PostgreSQL's order of the stored ids; an unordered roster's closed ids admit no ordering comparison, so only
 * their equality reads it.
 */
export const evaluatorOrder = (type: ScalarType): OrderSpec => {
	const base = baseOf(type)
	switch (base.carrier) {
		case "code":
		case "bits":
			return { carrier: base.carrier, roster: declaredOrder(base.roster) }
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
		case "text":
		case "bytes":
		case "vector":
		case "range4":
		case "range8":
		case "rangeDate":
		case "exactInteger":
		case "exactMoney":
			return { carrier: base.carrier }
	}
}

/** PostgreSQL's order of two values of `type`, the host's one comparison (identity.ts compareValues, evaluatorOrder). */
const compare = (a: HostValue, b: HostValue, type: ScalarType): -1 | 0 | 1 => {
	const order = evaluatorOrder(type)
	return compareValues(order, hostOf(order.carrier, a), hostOf(order.carrier, b))
}

/** The comparisons of values of one type: the six orderings, BETWEEN and IN. */
export type ComparisonFn = Extract<
	NativeFn,
	"eq" | "ne" | "lt" | "le" | "gt" | "ge" | "between" | "in"
>

/**
 * The truth of a comparison of values of one type `type`, none NULL, by the type's order (compare): `=`, `<>`, `<`,
 * `<=`, `>` and `>=` of its two operands, BETWEEN of its first between its second and third, IN of its first among the
 * rest. The one evaluation of a comparison, the evaluator's and constant folding's (lower/optimize/simplify/boolean.ts).
 * An operand its arity holds that is missing is a defect of the IR that built it.
 */
export const comparisonHolds = (
	fn: ComparisonFn,
	values: ReadonlyArray<HostValue>,
	type: ScalarType
): boolean => {
	const [first, ...rest] = values
	const a = defined(first, `the first operand of ${fn}`)
	const at = (i: number): HostValue => defined(values[i], `operand ${i} of ${fn}`)
	switch (fn) {
		case "eq":
			return compare(a, at(1), type) === 0
		case "ne":
			return compare(a, at(1), type) !== 0
		case "lt":
			return compare(a, at(1), type) < 0
		case "le":
			return compare(a, at(1), type) <= 0
		case "gt":
			return compare(a, at(1), type) > 0
		case "ge":
			return compare(a, at(1), type) >= 0
		case "between":
			return compare(a, at(1), type) >= 0 && compare(a, at(2), type) <= 0
		case "in":
			return rest.some((v) => compare(a, v, type) === 0)
	}
}

/** The integer carriers, a term's exact integers among them, whose values the evaluator computes as bigints. */
type IntegerCarrier = "int2" | "int4" | "int8" | "exactInteger"

const isIntegerCarrier = (c: Carrier): c is IntegerCarrier =>
	c === "int2" || c === "int4" || c === "int8" || c === "exactInteger"

/**
 * An integer operand's exact value, widened at the operation: smallint's and integer's JavaScript integers as bigints,
 * bigint's and an exact integer's as they are. An operand of no integer carrier is a defect of the IR's typing.
 */
const integerOf = (c: Carrier, v: HostValue): bigint => {
	if (!isIntegerCarrier(c)) {
		throw defect(`an integer operand, not a ${c}`)
	}
	switch (c) {
		case "int2":
		case "int4":
			return BigInt(hostOf(c, v))
		case "int8":
		case "exactInteger":
			return hostOf(c, v)
	}
}

/**
 * An exact integer as the host value of `type`'s carrier: a smallint's or an integer's a JavaScript integer, which the
 * operation's proof keeps within the carrier, a bigint's and an exact integer's the bigint. A result of no integer
 * carrier is a defect of the IR's typing.
 */
const integerHost = (type: ScalarType, x: bigint): HostValue => {
	const c = baseOf(type).carrier
	if (!isIntegerCarrier(c)) {
		throw defect(`an integer result, not a ${c}`)
	}
	switch (c) {
		case "int2":
		case "int4":
			return Number(x)
		case "int8":
		case "exactInteger":
			return x
	}
}

/** An operand its operation's arity holds, which the IR's typing guarantees. */
const operandAt = (args: ReadonlyArray<HostValue>, i: number, op: NativeOp): HostValue =>
	defined(args[i], `operand ${i} of ${op.fn}`)

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

/**
 * Arithmetic over operands of the carrier `c`, the result of `type`: a date's difference in days, numeric as numeric.c
 * computes it, floats as IEEE 754, money exactly in minor units and money / money as a double, and integers exactly,
 * truncated division and remainder defined where the divisor is not zero. Any other operation of a carrier is no
 * check's, unsupported.
 */
const arithmetic = (
	fn: "add" | "sub" | "mul" | "div" | "mod",
	c: Carrier,
	a: HostValue,
	b: HostValue,
	type: ScalarType
): EvalResult => {
	switch (c) {
		case "date":
			return fn === "sub"
				? Result.ok(integerHost(type, BigInt(dayNumber(hostOf(c, a)) - dayNumber(hostOf(c, b)))))
				: unsupported(`${fn} over date`)
		case "numeric":
			return lift(
				{ add: N.add, sub: N.sub, mul: N.mul, div: N.div, mod: N.mod }[fn](
					hostOf(c, a),
					hostOf(c, b)
				)
			)
		case "float4":
		case "float8":
			return fn === "mod"
				? unsupported(`mod over ${c}`)
				: Result.ok(ieee(fn, hostOf(c, a), hostOf(c, b), c))
		case "money":
		case "exactMoney": {
			const x = hostOf(c, a)
			const y = hostOf(c, b)
			switch (fn) {
				case "add":
					return Result.ok(Money.exact(x.minorUnits + y.minorUnits))
				case "sub":
					return Result.ok(Money.exact(x.minorUnits - y.minorUnits))
				case "div":
					return y.minorUnits === 0n
						? undefinedAt("nonzero")
						: Result.ok(canonicalZero(Number(x.minorUnits) / Number(y.minorUnits)))
				case "mul":
				case "mod":
					return unsupported(`${fn} over ${c}`)
			}
		}
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger": {
			const x = integerOf(c, a)
			const y = integerOf(c, b)
			switch (fn) {
				case "add":
					return Result.ok(integerHost(type, x + y))
				case "sub":
					return Result.ok(integerHost(type, x - y))
				case "mul":
					return Result.ok(integerHost(type, x * y))
				case "div":
					return y === 0n ? undefinedAt("nonzero") : Result.ok(integerHost(type, x / y))
				case "mod":
					return y === 0n ? undefinedAt("nonzero") : Result.ok(integerHost(type, x % y))
			}
		}
		case "bool":
		case "uuid":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			return unsupported(`${fn} over ${c}`)
	}
}

/** neg, abs and sign of an operand of the carrier `c`: numeric's, a float's in total IEEE 754, an integer's exactly. */
const signed = (
	fn: "neg" | "abs" | "sign",
	c: Carrier,
	a: HostValue,
	type: ScalarType
): EvalResult => {
	switch (c) {
		case "numeric":
			return lift({ neg: N.neg, abs: N.abs, sign: N.sign }[fn](hostOf(c, a)))
		case "float4":
		case "float8":
			return Result.ok(canonicalZero(totalFloat[fn](hostOf(c, a))))
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger": {
			const x = integerOf(c, a)
			return Result.ok(
				integerHost(
					type,
					fn === "neg" ? -x : fn === "abs" ? (x < 0n ? -x : x) : x < 0n ? -1n : x > 0n ? 1n : 0n
				)
			)
		}
		case "money":
		case "exactMoney":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			return unsupported(`${fn} over ${c}`)
	}
}

/**
 * The native operations a check admits (registry.ts computeSpecs, check) applied to their evaluated operands, each a host value
 * of its operand's type and the result one of `type`, each defined on every value or where its proved precondition
 * holds: integer and money arithmetic exactly (an exact integer, exact money), numeric as numeric.c computes it, floats
 * as IEEE 754, comparisons, BETWEEN and IN by the type's order (comparisonHolds), NOT, char_length, a text's UTF-16 code
 * units (String.length, within the bytes PostgreSQL's regex engine reads), a text's concatenation, prefix and suffix
 * tests, regex match (by the pattern's automaton) and translation (by code points, as PostgreSQL's translate reads
 * them), a double's parse from its decimal text, a decimal's from its text, a bytes value's SHA-256 digest, worked out
 * by core/sha256.ts sha256Hex where the value was admitted (scalar/values/bytes.ts AdmittedBytes), span endpoints,
 * LEAST and GREATEST by the type's order, and a set's union, intersection, difference, cardinality, subset and
 * disjointness, and a set with one more handle, over its handles. Each case reads its operands as the host values of
 * the carriers its overload takes (identity.ts hostOf); the IR's typing guarantees them, so another is a defect. `and`,
 * `or` and casts are evaluated by their nodes, never applied.
 */
const apply = (
	op: NativeOp,
	args: ReadonlyArray<HostValue>,
	argTypes: ReadonlyArray<ScalarType>,
	type: ScalarType,
	patterns: PatternReads
): EvalResult => {
	const a = operandAt(args, 0, op)
	const b = (): HostValue => operandAt(args, 1, op)
	const c = firstOperand(op.operands)
	switch (op.fn) {
		case "add":
		case "sub":
		case "mul":
		case "div":
		case "mod":
			return arithmetic(op.fn, c, a, b(), type)
		case "quot":
			return lift(N.divTrunc(hostOf("numeric", a), hostOf("numeric", b())))
		case "rem":
			return lift(N.mod(hostOf("numeric", a), hostOf("numeric", b())))
		case "neg":
		case "abs":
		case "sign":
			return signed(op.fn, c, a, type)
		case "gcd":
		case "lcm": {
			if (c === "numeric") {
				return unsupported(`${op.fn} over numeric, outside a check`)
			}
			const x = integerOf(c, a)
			const y = integerOf(c, b())
			const g = gcdOf(x, y)
			if (op.fn === "gcd") {
				return Result.ok(integerHost(type, g))
			}
			const product = x * y
			return Result.ok(integerHost(type, g === 0n ? 0n : (product < 0n ? -product : product) / g))
		}
		case "lower":
		case "upper": {
			if (c !== "range4" && c !== "range8" && c !== "rangeDate") {
				throw defect(`${op.fn} of a span, not of a ${c}`)
			}
			const span = hostOf(c, a)
			return Result.ok(op.fn === "lower" ? span.start : span.end)
		}
		case "charLength":
			return Result.ok(integerHost(type, BigInt(Array.from(hostOf("text", a)).length)))
		case "octetLength":
			return Result.ok(integerHost(type, BigInt(utf8Length(hostOf("text", a)))))
		case "utf16Length": {
			const text = hostOf("text", a)
			return utf8Length(text) > regexTextMaxBytes
				? undefinedAt("bounded")
				: Result.ok(integerHost(type, BigInt(text.length)))
		}
		case "concat":
			return Result.ok(hostOf("text", a) + hostOf("text", b()))
		case "startsWith":
			return Result.ok(hostOf("text", a).startsWith(hostOf("text", b())))
		case "endsWith":
			return Result.ok(hostOf("text", a).endsWith(hostOf("text", b())))
		case "right":
			return Result.ok(
				rightOf(
					hostOf("text", a),
					integerOf(baseOf(defined(argTypes[1], "right's count")).carrier, b())
				)
			)
		case "matches":
			return Result.ok(patterns.matches(hostOf("text", b()), hostOf("text", a)))
		case "collapse":
			return Result.ok(collapsed(hostOf("text", a)))
		case "lowerAscii":
			return Result.ok(asciiLowered(hostOf("text", a)))
		case "sha256":
			return Result.ok(hostOf("bytes", a).digest)
		case "replace":
		case "btrim":
			return unsupported(`${op.fn} alone, which only collapse's SQL reads`)
		case "regexpCount":
			return unsupported("regexp_count alone, which only utf16Length's SQL reads")
		case "parseDouble": {
			const value = doubleOfText(hostOf("text", a))
			return value === undefined ? undefinedAt("lexical") : Result.ok(value)
		}
		case "parseDecimal": {
			const value = decimalOfText(hostOf("text", a))
			return value === undefined ? undefinedAt("lexical") : Result.ok(value)
		}
		case "translate":
			return Result.ok(
				translated(hostOf("text", a), hostOf("text", b()), hostOf("text", operandAt(args, 2, op)))
			)
		case "eq":
		case "ne":
		case "lt":
		case "le":
		case "gt":
		case "ge":
		case "between":
		case "in":
			return Result.ok(
				comparisonHolds(op.fn, args, defined(argTypes[0], `the operand type of ${op.fn}`))
			)
		case "not":
			return Result.ok(!hostOf("bool", a))
		case "union":
			return Result.ok(new Set([...hostOf("bits", a), ...hostOf("bits", b())]))
		case "intersection": {
			const y = hostOf("bits", b())
			return Result.ok(new Set([...hostOf("bits", a)].filter((h) => y.has(h))))
		}
		case "difference": {
			const y = hostOf("bits", b())
			return Result.ok(new Set([...hostOf("bits", a)].filter((h) => !y.has(h))))
		}
		case "cardinality":
			return Result.ok(integerHost(type, BigInt(hostOf("bits", a).size)))
		case "subset": {
			const y = hostOf("bits", b())
			return Result.ok([...hostOf("bits", a)].every((h) => y.has(h)))
		}
		case "disjoint": {
			const y = hostOf("bits", b())
			return Result.ok(![...hostOf("bits", a)].some((h) => y.has(h)))
		}
		case "adjoin":
			return Result.ok(new Set([...hostOf("bits", a), hostOf("code", b())]))
		case "complement":
			return unsupported("complement, which no Compute operation yields")
		case "least":
		case "greatest": {
			const t = defined(argTypes[0], `the operand type of ${op.fn}`)
			let chosen = a
			for (const v of args.slice(1)) {
				const order = compare(v, chosen, t)
				if (op.fn === "greatest" ? order > 0 : order < 0) {
					chosen = v
				}
			}
			return Result.ok(chosen)
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
			return unsupported(`${op.fn}, outside a check's vocabulary`)
		case "and":
		case "or":
		case "cast":
			return unsupported(`${op.fn} evaluated by its node`)
	}
}

/**
 * Evaluates a contract predicate, `root` in its expression table `exprs`, over its VALUE `value`, reading regex
 * membership by `patterns`.
 */
const evaluatePredicate = (
	exprs: Readonly<Record<ExprId, TableExpr>>,
	root: ExprId,
	value: HostValue,
	patterns: PatternReads
): SqlResult =>
	evaluateTable(exprs, root, { value, column: () => undefined, closed: () => undefined }, patterns)

/**
 * The host's value of the expression `root` in its table `exprs`, its leaves read from `leaves` and regex membership
 * by `patterns`: the value PostgreSQL computes for it, NULL included (sqlNull), or why the host has none (EvalStop).
 * The one evaluation of a contract predicate over its VALUE and of a generation expression, a row check, a selection
 * or a guard over its row.
 */
export const evaluateTable = (
	exprs: Readonly<Record<ExprId, TableExpr>>,
	root: ExprId,
	leaves: EvalLeaves,
	patterns: PatternReads
): SqlResult => {
	const at = (id: ExprId): TableExpr | undefined =>
		Object.hasOwn(exprs, id) ? exprs[id] : undefined
	/**
	 * AND or OR over `args` by Kleene's logic, left to right as PostgreSQL evaluates them: the deciding operand, false
	 * for AND and true for OR, ends it; otherwise it is NULL where an operand is NULL.
	 */
	const connective = (fn: "and" | "or", args: ReadonlyArray<ExprId>): SqlResult => {
		const deciding = fn === "or"
		const read: Array<Truth> = []
		for (const a of args) {
			const v = run(a)
			if (!v.ok || v.value === deciding) {
				return v
			}
			read.push(v.value === sqlNull ? sqlNull : !deciding)
		}
		return Result.ok(fn === "and" ? conjunction(read) : disjunction(read))
	}
	/** A native operation of the type `type` over its arguments' values, each evaluated left to right (nullAware). */
	const applied = (op: NativeOp, args: ReadonlyArray<ExprId>, type: ScalarType): SqlResult => {
		const values: Array<SqlValue> = []
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
		return nullAware(op, values, types, type, patterns)
	}
	const run = (id: ExprId): SqlResult => {
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
				return Result.ok(hostOfLiteral(baseOf(expr.type).carrier, expr.value))
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
				if (arg === undefined || !v.ok || v.value === sqlNull) {
					return v
				}
				return castTo(v.value, arg.type, expr.type)
			}
			case "domainCast": {
				const [operand] = expr.args
				const arg = at(operand)
				const v = run(operand)
				if (arg === undefined || !v.ok || v.value === sqlNull) {
					return v
				}
				const coerced = castTo(v.value, arg.type, baseOf(expr.type))
				if (!coerced.ok) {
					return coerced
				}
				const member = membership(coerced.value, expr.type, patterns)
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
					: applied(op, expr.args, expr.type)
			}
			case "closedAt":
			case "closedRow":
			case "closedHas": {
				const values: Array<SqlValue> = []
				for (const a of expr.args) {
					const v = run(a)
					if (!v.ok) {
						return v
					}
					values.push(v.value)
				}
				const args = values.filter(isPresent)
				if (args.length < values.length) {
					return Result.ok(sqlNull)
				}
				const read = leaves.closed(expr, args)
				return read === undefined
					? unsupported(`a read of the closed relation ${expr.relation}`)
					: Result.ok(read)
			}
		}
	}
	return run(root)
}

/**
 * A native operation over operand values that may be NULL, as PostgreSQL applies it: over values alone, `apply`;
 * otherwise LEAST and GREATEST over their values that are no NULL, NULL where none is; BETWEEN as `a >= low AND a <=
 * high` and IN as the OR of its equalities, by Kleene's logic; and every other operation, which is strict, NULL. Each
 * operation states its NULL behaviour here, so a new one is a case to decide.
 */
const nullAware = (
	op: NativeOp,
	values: ReadonlyArray<SqlValue>,
	types: ReadonlyArray<ScalarType>,
	type: ScalarType,
	patterns: PatternReads
): SqlResult => {
	const present = values.filter(isPresent)
	if (present.length === values.length) {
		return apply(op, present, types, type, patterns)
	}
	const [first, ...rest] = values
	const a = defined(first, `the first operand of ${op.fn}`)
	const t = defined(types[0], `the operand type of ${op.fn}`)
	/** One comparison of `a` with `b` by `holds` over their order, NULL where either is NULL. */
	const compared = (b: SqlValue, holds: (order: -1 | 0 | 1) => boolean): Truth =>
		a === sqlNull || b === sqlNull ? sqlNull : holds(compare(a, b, t))
	switch (op.fn) {
		case "least":
		case "greatest":
			return present.length === 0
				? Result.ok(sqlNull)
				: apply(
						op,
						present,
						types.filter((_, i) => values[i] !== sqlNull),
						type,
						patterns
					)
		case "between": {
			const [low, high] = rest
			return Result.ok(
				conjunction([
					compared(defined(low, "BETWEEN's low"), (order) => order >= 0),
					compared(defined(high, "BETWEEN's high"), (order) => order <= 0)
				])
			)
		}
		case "in":
			return Result.ok(disjunction(rest.map((item) => compared(item, (order) => order === 0))))
		case "and":
		case "or":
		case "cast":
			return unsupported(`${op.fn} evaluated by its node`)
		case "abs":
		case "add":
		case "adjoin":
		case "btrim":
		case "cardinality":
		case "ceil":
		case "charLength":
		case "collapse":
		case "complement":
		case "concat":
		case "cosineDistance":
		case "difference":
		case "disjoint":
		case "div":
		case "endsWith":
		case "eq":
		case "floor":
		case "gcd":
		case "ge":
		case "gt":
		case "intersection":
		case "lcm":
		case "le":
		case "lower":
		case "lowerAscii":
		case "lt":
		case "matches":
		case "minScale":
		case "mod":
		case "mul":
		case "ne":
		case "neg":
		case "not":
		case "octetLength":
		case "parseDecimal":
		case "parseDouble":
		case "power":
		case "quot":
		case "regexpCount":
		case "rem":
		case "replace":
		case "right":
		case "round":
		case "sha256":
		case "sign":
		case "sqrt":
		case "startsWith":
		case "sub":
		case "subset":
		case "translate":
		case "trunc":
		case "union":
		case "upper":
		case "utf16Length":
		case "widthBucket":
			return Result.ok(sqlNull)
	}
}

/**
 * A registered cast's host conversion of `v`, a host value of the cast's source carrier `source`, read as its family's
 * (cast.ts HostCast): an integer widened to a bigint, a float or money as it is. The IR's typing makes `source` one of
 * the family's carriers, so another is a defect.
 */
const castOperand = (
	host: HostCast,
	v: HostValue,
	source: Carrier,
	to: ScalarType
): Result.Result<CastValue, Undefined> => {
	switch (host.from) {
		case "integer":
			return host.convert(integerOf(source, v))
		case "numeric":
			return host.convert(hostOf("numeric", v))
		case "float":
			if (source !== "float4" && source !== "float8") {
				throw defect(`a cast from a float, not from a ${source}`)
			}
			return host.convert(hostOf(source, v))
		case "money":
			if (source !== "money" && source !== "exactMoney") {
				throw defect(`a cast from money, not from a ${source}`)
			}
			return host.convert(hostOf(source, v))
		case "text":
			return host.convert(hostOf("text", v), baseOf(to))
	}
}

/**
 * A cast's result as the host value of its target `to`: an integer's bigint narrowed to its carrier's (integerHost),
 * every other result its target's host value as the cast computes it.
 */
const castHost = (to: ScalarType, value: CastValue): HostValue => {
	if (!isIntegerCarrier(baseOf(to).carrier)) {
		return value
	}
	if (typeof value !== "bigint") {
		throw defect(`a cast into ${typeLabel(to)} yields an integer`)
	}
	return integerHost(to, value)
}

/** A native cast between the value types of two descriptors, then the target's numeric typmod coercion. */
const castTo = (v: HostValue, from: ScalarType, to: ScalarType): EvalResult => {
	const source = baseOf(from).carrier
	const target = baseOf(to).carrier
	let out: HostValue = v
	if (source !== target) {
		const native = castOf(source, target)
		if (native === undefined) {
			return unsupported(`a cast from ${source} to ${target}`)
		}
		const cast = castOperand(native.host, v, source, to)
		if (!cast.ok) {
			return undefinedAt(cast.error)
		}
		out = castHost(to, cast.value)
	}
	const typmod = numericTypmodOf(baseOf(to))
	if (typmod !== undefined) {
		const normalized = normalizeNumeric(hostOf("numeric", out), typmod)
		if (!normalized.ok) {
			return undefinedAt("fits")
		}
		out = normalized.value
	}
	return Result.ok(out)
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
 * Every value is its type's host value, the codec's own (scalar/values/identity.ts CarrierHost), so a row's field and an
 * evaluated term are read and written as they are, with no form of the evaluator's own: an integer operation widens its
 * operands to bigints and narrows its result to its type's carrier, so smallint's and integer's values stay JavaScript
 * integers. Comparison is PostgreSQL's total order of the type (identity.ts compareValues, the host's one): NaN above
 * every number and equal to itself, -0 equal to 0, numeric by value, text in code point order under the fixed C.UTF-8
 * collation, bytes by bytes, closed ids in roster order, which is code order (evaluatorOrder), vectors as vector_cmp. A regex
 * refinement's membership is the text package's NFA, which the caller supplies.
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
): Result.Result<TypedLiteral, LiteralRefusal> => {
	const typed = irLiteral(value, type)
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
			capability: `a literal of ${typeLabel(type)}: the literal violates its ${contractOf(type) === undefined ? "regex refinement" : "contract"}`
		})
	}
	return Result.ok(literal)
}

/** Whether a contract's predicate holds of `v`: a contract without one constrains nothing. */
const predicateHolds = (
	predicate: ExprTable | undefined,
	v: HostValue,
	patterns: PatternReads
): Result.Result<boolean, EvalStop> => {
	if (predicate === undefined) {
		return Result.ok(true)
	}
	const holds = evaluatePredicate(predicate.exprs, predicate.root, v, patterns)
	return !holds.ok ? Result.err(holds.error) : Result.ok(holds.value === true)
}

/**
 * Whether a value of a contract's base satisfies the contract at every level: each level's base refinement (a regex),
 * then its predicate, innermost first, as PostgreSQL checks a domain over a domain. Each predicate reads its VALUE and
 * regex membership by `patterns`.
 */
const membership = (
	v: HostValue,
	t: ScalarType,
	patterns: PatternReads
): Result.Result<boolean, EvalStop> => {
	const levels: Array<ScalarType> = []
	for (let at: ScalarType | undefined = t; at !== undefined; at = contractOf(at)?.base) {
		levels.push(at)
	}
	for (const level of levels.toReversed()) {
		const contract = contractOf(level)
		const pattern = contract === undefined ? textOf(level)?.regex : undefined
		if (pattern !== undefined && pattern !== "wildcard" && !regexHolds(patterns, pattern, v)) {
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
