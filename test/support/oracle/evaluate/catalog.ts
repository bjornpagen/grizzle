import { Array as Arr, Result } from "effect"
import type { ParamId } from "#compiler/core/ids.ts"
import * as Engine from "#compiler/core/result.ts"
import {
	type ColumnRef,
	describeOp,
	type OpId,
	predicateTree,
	type ScalarExpr
} from "#compiler/ir/expr.ts"

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
import { compareValues, literalValue, type RegexMember } from "#compiler/scalar/compute/evaluate.ts"
import { totalFloat } from "#compiler/scalar/compute/float.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import * as TotalNumeric from "#compiler/scalar/compute/numeric.ts"
import {
	castOf,
	type FailureCode,
	firstOperand,
	type NativeOp,
	nativeOp,
	nativeOps
} from "#compiler/scalar/compute/registry.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
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
	intRange,
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
 */
export type Evaluation = "exact" | "estimated" | "database"

/** Each node's evaluation, by its function and carrier. */
export const evaluationOf = (op: NativeOp): Evaluation => {
	switch (op.fn) {
		case "power":
			return firstOperand(op.operands) === "numeric" ? "estimated" : "database"
		case "cosineDistance":
			return "database"
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
		case "scale":
		case "minScale":
		case "trimScale":
		case "lower":
		case "upper":
		case "charLength":
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
 * Why an evaluation has no value: PostgreSQL's failure; an expression the oracle does not evaluate (a read its
 * environment has not, an operand of another kind); or a node it declines by design (declinedOps), whose value
 * PostgreSQL alone computes.
 */
export type CatalogStop =
	| { readonly kind: "failure"; readonly code: FailureCode }
	| { readonly kind: "unsupported"; readonly what: string }
	| { readonly kind: "declined"; readonly op: OpId; readonly what: string }

export type CatalogResult = Result.Result<CarrierValue, CatalogStop>

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

const failure = (code: FailureCode): CatalogResult => Result.fail({ kind: "failure", code })
const unsupported = (what: string): CatalogResult => Result.fail({ kind: "unsupported", what })

/** A node the oracle declines: PostgreSQL alone computes its value, which the host does not reproduce bit for bit. */
const declined = (op: NativeOp, why: string): CatalogResult =>
	Result.fail({ kind: "declined", op: op.id, what: why })

const lift = <A extends CarrierValue>(r: Result.Result<A, FailureCode>): CatalogResult =>
	Result.isSuccess(r) ? Result.succeed(r.success) : failure(r.failure)

/** A compiler Compute operation's answer, or the numeric port's, which answer the engine's Result. */
const liftEngine = <A extends CarrierValue>(r: Engine.Result<A, FailureCode>): CatalogResult =>
	r.ok ? Result.succeed(r.value) : failure(r.error)

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

const isIntCarrier = (c: string | undefined): c is IntCarrier =>
	c === "int2" || c === "int4" || c === "int8"

/** An operand of a kind the IR's typing rules out. */
const mismatch = (op: NativeOp): CatalogResult =>
	unsupported(`${op.fn} over operands that are not values of ${firstOperand(op.operands)}`)

const moneyFit = (minor: bigint): CatalogResult =>
	minor < intRange.int8[0] || minor > intRange.int8[1]
		? failure("22003")
		: Result.succeed(Money.of(minor))

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
	const cmp = compareValues(a, b, t)
	return cmp === undefined
		? unsupported(`${op.fn} over ${firstOperand(op.operands)}`)
		: Result.succeed(holds(cmp))
}

/** The four arithmetic operators and the remainder over two operands of the carrier `c`. */
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
				return lift(intAdd(a, b, c))
			case "sub":
				return lift(intSub(a, b, c))
			case "mul":
				return lift(intMul(a, b, c))
			case "div":
				return lift(intDiv(a, b, c))
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
		const f = F.floatArithmetic[fn]
		return lift(f(a, b, c))
	}
	if (c === "money") {
		if (!isMoney(a) || !isMoney(b)) {
			return mismatch(op)
		}
		const x = a.minorUnits
		const y = b.minorUnits
		if (fn === "add") {
			return moneyFit(x + y)
		}
		if (fn === "sub") {
			return moneyFit(x - y)
		}
		if (fn === "div") {
			return y === 0n ? failure("22012") : Result.succeed(Number(x) / Number(y))
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
		return declined(op, "PostgreSQL alone evaluates it")
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
				return isBigint(a) ? lift(op.fn === "neg" ? intNeg(a, c) : intAbs(a, c)) : mismatch(op)
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
				return isBigint(a) && isBigint(b) ? lift(intGcd(a, b, c)) : mismatch(op)
			}
			return isDecimal(a) && isDecimal(b) ? liftEngine(N.gcd(a, b)) : mismatch(op)
		case "lcm":
			if (isIntCarrier(c)) {
				return isBigint(a) && isBigint(b) ? lift(intLcm(a, b, c)) : mismatch(op)
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
				? failure(stop.code)
				: declined(op, `its result hangs on ${stop.what}`)
		}
		case "sqrt":
			if (c === "float8") {
				return isNumber(a) ? lift(F.floatSqrt(a)) : mismatch(op)
			}
			return isDecimal(a) ? liftEngine(N.sqrt(a)) : mismatch(op)
		case "widthBucket": {
			const [x, low, high, count] = args
			if (!isDecimal(x) || !isDecimal(low) || !isDecimal(high) || !isBigint(count)) {
				return mismatch(op)
			}
			return liftEngine(N.widthBucket(x, low, high, count))
		}
		case "scale":
			return isDecimal(a) ? liftEngine(Engine.map(N.scaleOf(a), BigInt)) : mismatch(op)
		case "minScale":
			return isDecimal(a) ? liftEngine(Engine.map(N.minScaleOf(a), BigInt)) : mismatch(op)
		case "trimScale":
			return isDecimal(a) ? liftEngine(N.trimScale(a)) : mismatch(op)
		case "least":
		case "greatest": {
			if (a === undefined || t === undefined) {
				return mismatch(op)
			}
			const seed: CatalogResult = Result.succeed(a)
			return Arr.reduce(args.slice(1), seed, (acc, v) =>
				Result.flatMap(acc, (best) => {
					const cmp = compareValues(best, v, t)
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
			const lo = compareValues(a, b, t)
			const hi = compareValues(a, high, t)
			if (lo === undefined || hi === undefined) {
				return unsupported(`BETWEEN over ${c}`)
			}
			return Result.succeed(lo >= 0 && hi <= 0)
		}
		case "in": {
			if (a === undefined || t === undefined) {
				return mismatch(op)
			}
			const comparisons = Arr.map(args.slice(1), (v) => compareValues(a, v, t))
			return comparisons.includes(undefined)
				? unsupported(`IN over ${c}`)
				: Result.succeed(comparisons.includes(0))
		}
		case "not":
			return typeof a === "boolean" ? Result.succeed(!a) : mismatch(op)
		case "cosineDistance":
			return declined(op, "PostgreSQL alone evaluates it")
		case "and":
		case "or":
		case "cast":
			return unsupported(`${op.fn} evaluated by its node`)
	}
}

const converted = (r: Engine.Result<CastValue, FailureCode>): CatalogResult =>
	r.ok ? Result.succeed(r.value) : failure(r.error)

/**
 * A registered cast's host conversion of `v`, a value of the cast's source family; a value of another kind is
 * unsupported.
 */
const hostCast = (host: HostCast, v: CarrierValue, source: Carrier): CatalogResult => {
	switch (host.from) {
		case "integer":
			return isBigint(v) ? converted(host.convert(v)) : unsupported(`a cast from ${source}`)
		case "numeric":
			return isDecimal(v) ? converted(host.convert(v)) : unsupported(`a cast from ${source}`)
		case "float":
			return isNumber(v) ? converted(host.convert(v)) : unsupported(`a cast from ${source}`)
		case "money":
			return isMoney(v) ? converted(host.convert(v)) : unsupported(`a cast from ${source}`)
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
		const cast = hostCast(native.host, v, source)
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
			return failure("22003")
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
 * square roots, width_bucket and the scale functions (numeric.ts); numeric power (power.ts, PostgreSQL's numeric_power
 * step for step); char_length, span endpoints, LEAST and GREATEST; and the registry's casts and domain casts. The host
 * never claims a value it cannot reproduce bit for bit: a node PostgreSQL alone computes (Evaluation "database": a
 * float's pow through the platform libm, pgvector's operations), and numeric power where a libm estimate decides it and
 * the host's may not agree, answer "declined" rather than an approximation, and their consumers leave them to
 * PostgreSQL.
 *
 * Values are exact carriers (src's scalar/compute/literal.ts CarrierValue), compared by PostgreSQL's total orders
 * (src's compareValues, which constant folding reads). A regex refinement's membership is the text package's NFA, which
 * the caller supplies.
 *
 * Evaluates the expression tree `root` (a DAG's expression, or a contract predicate parsed from its table) under `env`,
 * over the whole catalogue.
 */
export const evaluate = (root: ScalarExpr, env: EvalEnv): CatalogResult =>
	evaluateOver(root, env, unsupported("a VALUE"))

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
				return castTo(v.success, operand.type, expr.type)
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
				return member.success ? coerced : failure("23514")
			}
			case "op": {
				const op = nativeOp(expr.op)
				if (op === undefined) {
					return unsupported(`the operator ${describeOp(expr.op)}`)
				}
				if (op.fn === "and" || op.fn === "or") {
					return connective(op.fn === "or", expr.args)
				}
				return Result.flatMap(operands(expr.args), ({ values, types }) =>
					catalogApply(op, values, types)
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
