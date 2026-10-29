import type { ExprId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { describeOp, type ExprTable, type TableExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
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
	type FailureCode,
	firstOperand,
	type NativeOp,
	nativeOp
} from "#compiler/scalar/compute/registry.ts"
import { compareDecimal, Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { compareFloat } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"

/**
 * Why an evaluation has no value: PostgreSQL's failure, or an expression the evaluator does not evaluate (a read other
 * than the VALUE, an operation outside the total fragment, an operand of another kind).
 */
type EvalStop =
	| { readonly kind: "failure"; readonly code: FailureCode }
	| { readonly kind: "unsupported"; readonly what: string }

type EvalResult = Result.Result<CarrierValue, EvalStop>

/**
 * Membership of a text value in a regex refinement: the text package's NFA (never RegExp), which the caller supplies,
 * since the text package reads the scalar package and not the other way round.
 */
export type RegexMember = (regex: RegexRef, text: string) => boolean

const failure = (code: FailureCode): EvalResult => Result.err({ kind: "failure", code })
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

const lift = <A extends CarrierValue>(r: Result.Result<A, FailureCode>): EvalResult =>
	r.ok ? Result.ok(r.value) : failure(r.error)

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
			return literal.value
		case "enum":
			return literal.handle
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
		case "text":
			return isString(a) && isString(b) ? compareCodePoints(a, b) : undefined
		case "enum": {
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
 * The total fragment's native operations (total.ts) applied to their evaluated operands: comparisons, BETWEEN, IN, NOT,
 * numeric arithmetic, abs, sign and neg of a numeric or float, char_length and span endpoints. Each case checks its
 * operands' host kinds; the IR's typing guarantees them, so a mismatch is `unsupported`. Every other operation is
 * outside the fragment: unsupported. `and`, `or` and casts are evaluated by their nodes, never applied.
 */
const totalApply = (
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
			if (c !== "numeric") {
				return unsupported(`${op.fn} over ${c}, outside the total fragment`)
			}
			if (!isDecimal(a) || !isDecimal(b)) {
				return mismatch(op)
			}
			const f = { add: N.add, sub: N.sub, mul: N.mul, div: N.div, mod: N.mod }[op.fn]
			return lift(f(a, b))
		}
		case "quot":
			return isDecimal(a) && isDecimal(b) ? lift(N.divTrunc(a, b)) : mismatch(op)
		case "neg":
		case "abs":
		case "sign":
			if (c === "numeric") {
				return isDecimal(a)
					? lift({ neg: N.neg, abs: N.abs, sign: N.sign }[op.fn](a))
					: mismatch(op)
			}
			if (c === "float4" || c === "float8") {
				return isNumber(a) ? Result.ok(totalFloat[op.fn](a)) : mismatch(op)
			}
			return unsupported(`${op.fn} over ${c}, outside the total fragment`)
		case "lower":
			return isSpanValue(a) ? Result.ok(a.start) : mismatch(op)
		case "upper":
			return isSpanValue(a) ? Result.ok(a.end) : mismatch(op)
		case "charLength":
			return isString(a) ? Result.ok(BigInt(Array.from(a).length)) : mismatch(op)
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
		case "rem":
		case "round":
		case "trunc":
		case "ceil":
		case "floor":
		case "gcd":
		case "lcm":
		case "power":
		case "sqrt":
		case "least":
		case "greatest":
		case "widthBucket":
		case "scale":
		case "minScale":
		case "trimScale":
		case "cosineDistance":
			return unsupported(`${op.fn}, outside the total fragment`)
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
		return totalApply(op, values, types)
	}
	const run = (id: ExprId): EvalResult => {
		const expr = at(id)
		if (expr === undefined) {
			return unsupported(`an expression named ${id}`)
		}
		switch (expr.kind) {
			case "value":
				return Result.ok(value)
			case "column":
				return unsupported(`the column ${expr.column.name}`)
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
				return member.value ? coerced : failure("23514")
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
		}
	}
	return run(root)
}

/**
 * A registered cast's host conversion of `v`, a value of the cast's source family; a value of another kind is
 * unsupported.
 */
const converted = (r: Result.Result<CastValue, FailureCode>): EvalResult =>
	!r.ok ? failure(r.error) : Result.ok(r.value)

const hostCast = (host: HostCast, v: CarrierValue, source: Carrier): EvalResult => {
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
const castTo = (v: CarrierValue, from: ScalarType, to: ScalarType): EvalResult => {
	const source = baseOf(from).carrier
	const target = baseOf(to).carrier
	let out: CarrierValue = v
	if (source !== target) {
		const native = castOf(source, target)
		if (native === undefined) {
			return unsupported(`a cast from ${source} to ${target}`)
		}
		const cast = hostCast(native.host, v, source)
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
			return failure("22003")
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
 * The pure evaluator of the total fragment of scalar expression IR over exact carriers.
 *
 * The places grizzle evaluates an expression outside PostgreSQL are a literal that adopts a contract, which the compiler
 * checks against the contract's predicate at compile time (a refusal is CompileError ContractLiteral), and constant
 * folding of a comparison, BETWEEN or IN over literals (lower/optimize/simplify/boolean.ts, by compareValues and
 * literalValue). A contract predicate is in the total fragment (total.ts) and reads only its VALUE, so its evaluation
 * never fails, and this evaluator covers exactly that: comparisons, BETWEEN, IN, boolean composition, numeric
 * arithmetic, abs, sign and neg, char_length, span endpoints and the casts between them. Any other operation, and any
 * read but the VALUE, is `unsupported`, never an approximation.  The host never substitutes JavaScript arithmetic for a SQL
 * expression in a query.
 *
 * Values are exact carriers: integers as bigint, numeric as Decimal, floats as number, money as Money, booleans, text,
 * uuids and enum handles as primitives, spans as { start, end } bigints. Comparison follows PostgreSQL's total orders:
 * NaN above every number and equal to itself, -0 equal to 0, numeric display scale ignored, text in code point order
 * under the fixed C.UTF-8 collation, enums in roster order. A regex refinement's membership is the text package's NFA,
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
	if (judgment.kind === "shape" || !isRefined(type)) {
		return Result.ok(typed.value)
	}
	const member = membership(typed.value.value, type, judgment.regexMember)
	if (!member.ok) {
		return Result.err({
			reason: "UnsupportedOperation",
			capability: `the ContractLiteral check of ${typeLabel(type)}: ${member.error.kind === "unsupported" ? member.error.what : member.error.code}`
		})
	}
	if (!member.value) {
		return Result.err({
			reason: "ContractLiteral",
			capability: `a literal of ${typeLabel(type)}: the literal violates its ${contractOf(type) === undefined ? "regex refinement" : "contract"}`
		})
	}
	return Result.ok(typed.value)
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
 * regex membership by `regexMember`, and is evaluated in the total fragment.
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
