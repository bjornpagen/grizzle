import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { CompileError, prose, type ProseTag, unsupported } from "#compiler/core/errors.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { ExprDesc, FieldDesc, LiteralDesc, Located, Refs, Spelled } from "#compiler/ir/desc.ts"
import {
	builtExpr,
	type Effects,
	type ExprSpec,
	type Failure,
	type ScalarExpr
} from "#compiler/ir/expr.ts"

import {
	baseOf,
	contractOf,
	isRefined,
	numericTypmodOf,
	type ScalarType,
	spanOf,
	textOf,
	typeLabel,
	type ValueType
} from "#compiler/ir/scalar.ts"
import type { IntCarrier } from "#compiler/scalar/compute/cast.ts"
import { admitLiteral, type RegexMember } from "#compiler/scalar/compute/evaluate.ts"
import { bareLiteralKind, type CarriedLiteral } from "#compiler/scalar/compute/literal.ts"
import {
	type CastOp,
	castOf,
	type ExtremeOp,
	extremeOf,
	type FixedFn,
	type FixedOp,
	type NativeOp,
	overloadOf,
	registeredCast
} from "#compiler/scalar/compute/registry.ts"

import {
	commonType,
	compatible,
	isFloat,
	isInteger,
	plainType,
	sameRegex,
	valueType,
	wildcardText,
	withoutSerial,
	withoutSpanWidth
} from "#compiler/scalar/compute/types.ts"
import { Decimal, numericMaxIntegerDigits } from "#compiler/scalar/values/decimal.ts"

export type LowerMode = "query" | "total" | "build"

/**
 * A lowered operand: the node's recorded entry, the type the caller's term has (nominal), and the SQL type the node
 * computes (actual), which differ only for a total-fragment integer that was cast to numeric, and the node's effects as
 * its table derived them (ir/expr.ts exprEffects).
 */
export interface Lowered extends Effects {
	readonly expr: ScalarExpr
	readonly nominal: ScalarType
	readonly actual: ScalarType
	readonly known: Known
}

/**
 * What the lowering knows of a node beyond its types: its literal, when the node is one (a divisor's nonzero check and
 * the integer-to-numeric fold read it); in the total fragment, an upper bound on the integer digits of the numeric
 * value it computes, where a widening or an arithmetic result derives one; or nothing more, its digits then read from
 * its type (Lowering.digits).
 */
type Known =
	| { readonly kind: "type" }
	| { readonly kind: "literal"; readonly literal: CarriedLiteral }
	| { readonly kind: "digits"; readonly digits: number }

export const typeOnly: Known = Object.freeze({ kind: "type" })

/** The value of a node's literal, when it is one. */
const literalValue = (x: Lowered): CarriedLiteral["value"] | undefined =>
	x.known.kind === "literal" ? x.known.literal.value : undefined

/** A digit bound as what is known, nothing when there is none. */
const digitsKnown = (digits: number | undefined): Known =>
	digits === undefined ? typeOnly : Object.freeze({ kind: "digits", digits })

/**
 * What a leaf reference names: a rule variable, a check's field, the contract's VALUE, or an attachment's parent head
 * variable, as the expression's references admit them (ir/desc.ts Refs).
 */
export type LeafDesc<R extends Refs = Spelled> = R["leaf"]

/**
 * The parameters an expression reads: none (a contract predicate or a row check reads only its value or row, and a
 * law's violation query reads only its relations), or the lowering of one meeting a term whose type it adopts.
 */
export type LowerParams<R extends Refs> =
	| { readonly kind: "none" }
	| {
			readonly kind: "scope"
			readonly lower: (
				param: R["param"],
				type: ScalarType,
				loc: SourceLoc
			) => Result.Result<ExprSpec, CompileError>
	  }

export const noParams: { readonly kind: "none" } = Object.freeze({ kind: "none" })

/**
 * The emitter of a lowering no DAG receives (a contract predicate, a builder typing its term): each expression built
 * over its arguments (ir/expr.ts builtExpr) under a fresh label `prefix#n`.
 */
export const exprEmitter = (prefix: string): ((spec: ExprSpec) => ScalarExpr) => {
	let next = 0
	return (spec) => builtExpr(spec, ExprId(`${prefix}#${next++}`))
}

/** Whether a branch is a parameter or an untyped literal, which adopts the type of the other branch. */
const isUntypedInput = <R extends Refs>(d: ExprDesc<Located, R>): boolean =>
	(d.kind === "literal" && d.type === undefined) || d.kind === "param"

/** The predicates other packages lower: r.allen, r.pointIn and r.not. */
type LowerExtension<R extends Refs> = (
	desc: Extract<ExprDesc<Located, R>, { readonly kind: "allen" | "pointIn" | "absent" }>,
	loc: SourceLoc,
	lower: (child: ExprDesc<Located, R>) => Result.Result<Lowered, CompileError>
) => Result.Result<Lowered, CompileError>

/** No package lowers a predicate of its own here: r.allen, r.pointIn and r.not are refused. */
export const noExtension: LowerExtension<Spelled> = (desc, loc) =>
	Result.err(
		unsupported(loc, `${desc.kind}: lowered by its own package, not the Compute catalogue`)
	)

interface LowerCommon<R extends Refs> {
	/** The source location of the expression, the prefix of every diagnostic. */
	readonly loc: SourceLoc
	/**
	 * Records a node and returns its entry, built over its arguments' entries (ir/expr.ts builtExpr): a DagBuilder's
	 * `record`, or a contract predicate's table.
	 */
	readonly emit: (spec: ExprSpec) => ScalarExpr
	/** The node a leaf reference records at each use. */
	readonly leaf: (desc: LeafDesc<R>, loc: SourceLoc) => Result.Result<ExprSpec, CompileError>
	readonly params: LowerParams<R>
	/** The ScalarType of a descriptor's Description, for Compute.literal and Compute.cast (the descriptor registry). */
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
}

/**
 * What each mode reads besides: a query and the total fragment check a literal against its regex refinement, by the
 * text package's membership they carry, and only a query lowers the predicates of other packages (the total fragment refuses them); a builder checks no literal
 * and lowers none.
 */
export type LowerEnv<R extends Refs = Spelled> =
	| (LowerCommon<R> & {
			readonly mode: "query"
			readonly regexMember: RegexMember
			readonly extension: LowerExtension<R>
	  })
	| (LowerCommon<R> & { readonly mode: "total"; readonly regexMember: RegexMember })
	| (LowerCommon<R> & { readonly mode: "build" })

/**
 * Internal control flow: the first refusal deep inside a lowering is thrown as a Refusal and caught at the boundary
 * (catchRefusal, core/canonical.ts).
 */
const stop = (
	reason: Extract<ProseTag, "MalformedDescription" | "UnsupportedOperation" | "ContractLiteral">,
	loc: SourceLoc,
	capability: string
): never => {
	throw new Refusal(CompileError.make(prose(reason, loc, capability)))
}

const unwrap = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/**
 * How a cast converts: a registered native cast (total when the caller proves it so), a binary-coercible widening
 * into a base the value already has, or a coercion into a contract domain, which PostgreSQL validates.
 */
type CastHow =
	| { readonly kind: "native"; readonly op: NativeOp; readonly total: boolean }
	| { readonly kind: "widen" }
	| { readonly kind: "domain" }

type Role = "compare" | "operand"

/** The arithmetic Compute operations of the total fragment, and the other members it admits. */
const totalArithmetic: ReadonlySet<string> = new Set(["add", "sub", "mul", "div", "mod", "neg"])
const totalMembers: ReadonlySet<string> = new Set([
	...totalArithmetic,
	"abs",
	"sign",
	"charLength",
	"lower",
	"upper",
	"width"
])

class Lowering<R extends Refs> {
	readonly env: LowerEnv<R>
	readonly total: boolean

	constructor(env: LowerEnv<R>) {
		this.env = env
		this.total = env.mode === "total"
	}

	/** The type a literal or parameter adopts opposite a term of type t (see the header). */
	adopt(t: ScalarType, role: Role): ScalarType {
		if (role === "compare" && contractOf(t) !== undefined) {
			return withoutSerial(t)
		}
		const v = valueType(t)
		if (v.carrier === "numeric" && v.typmod !== undefined) {
			return plainType("numeric")
		}
		if (role === "operand" && v.carrier === "text") {
			return wildcardText
		}
		return withoutSpanWidth(v)
	}

	/** The node of `spec`, recorded: of its own type nominally and actually, with the effects its table derives. */
	emit(spec: ExprSpec): Lowered {
		const entry = this.env.emit(spec)
		return {
			expr: entry,
			nominal: entry.type,
			actual: entry.type,
			volatility: entry.volatility,
			failure: entry.failure,
			known: typeOnly
		}
	}

	/** A node of the registry's `op` over `args`, which fails as the op can. */
	native(op: NativeOp, args: ReadonlyArray<Lowered>, type: ScalarType): Lowered {
		return this.nativeNode(op, args, type, op.failures.length > 0 ? "canFail" : "total")
	}

	/**
	 * A node of the registry's `op` over `args` that the caller proves total: the total fragment's arithmetic over
	 * bounded numeric operands and nonzero literal divisors, and a call under a guard that holds exactly where it is.
	 */
	nativeTotal(op: NativeOp, args: ReadonlyArray<Lowered>, type: ScalarType): Lowered {
		return this.nativeNode(op, args, type, "total")
	}

	nativeNode(op: NativeOp, args: ReadonlyArray<Lowered>, type: ScalarType, own: Failure): Lowered {
		return this.emit({
			kind: "op",
			op: op.id,
			args: args.map((a) => a.expr),
			type,
			nonNull: "strict",
			volatility: op.volatility,
			failure: own
		})
	}

	/**
	 * A cast node from `arg`'s actual type to `to`, converting as `how` states, checked where the cast itself can fail
	 * (castChecked).
	 */
	castNode(arg: Lowered, to: ScalarType, how: CastHow): Lowered {
		return this.emit({
			kind: "cast",
			checked: this.castChecked(how),
			args: [arg.expr],
			type: to,
			nonNull: "strict",
			volatility: how.kind === "native" ? how.op.volatility : "immutable"
		})
	}

	/**
	 * Whether a cast can fail by itself, so it is checked. A native cast the caller proves total (`total`) is unchecked,
	 * such as sign's result cast back to its operand's type, whose value is -1, 0 or 1.
	 *
	 * A coercion into a contract's domain: PostgreSQL validates the value against the domain, as a domainCast
	 * does (ir/expr.ts exprEffects), so it can fail.
	 */
	castChecked(how: CastHow): boolean {
		switch (how.kind) {
			case "native":
				return !how.total && how.op.failures.length > 0
			case "widen":
				return false
			case "domain":
				return true
		}
	}

	literalNode(typed: CarriedLiteral, type: ScalarType): Lowered {
		return {
			...this.emit({ kind: "literal", value: typed.literal, args: [], type, nonNull: "literal" }),
			known: { kind: "literal", literal: typed }
		}
	}

	/**
	 * A literal adopting `type`, admitted as every typed slot admits one (evaluate.ts admitLiteral): the base first, then,
	 * outside a builder, the contract and the regex refinement.
	 */
	literal(value: LiteralDesc, type: ScalarType, at: SourceLoc): Lowered {
		const admitted = admitLiteral(
			value,
			type,
			this.env.mode === "build"
				? { kind: "shape" }
				: { kind: "refinements", regexMember: this.env.regexMember }
		)
		if (!admitted.ok) {
			return stop(admitted.error.reason, at, admitted.error.capability)
		}
		return this.literalNode(admitted.value, type)
	}

	/**
	 * The placeholder is bound as the parameter's base type, never a refined domain, which is the node's actual type even where
	 * the parameter adopts a contract or a regex refinement.
	 */
	param(param: R["param"], type: ScalarType, at: SourceLoc): Lowered {
		const params = this.env.params
		if (params.kind === "none") {
			return stop(
				"UnsupportedOperation",
				at,
				"a parameter: a contract predicate or a row check reads only its value or its row"
			)
		}
		return { ...this.emit(unwrap(params.lower(param, type, at))), nominal: type }
	}

	/** A term: anything but an untyped literal or a parameter, which take the type of the term they meet. */
	term(desc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		if (desc.kind === "param") {
			return stop(
				"MalformedDescription",
				at,
				"a term here: a parameter takes the type of the term it meets and never stands first"
			)
		}
		if (desc.kind === "literal" && desc.type === undefined) {
			return stop(
				"MalformedDescription",
				at,
				"a term here: a literal takes the type of the term it meets and never stands first"
			)
		}
		return this.lower(desc, at)
	}

	/**
	 * An operand opposite `against`: a literal or parameter adopts its type, anything else is a term of a compatible
	 * nominal type.
	 */
	operand(desc: ExprDesc<Located, R>, against: Lowered, role: Role, at: SourceLoc): Lowered {
		if (desc.kind === "literal" && desc.type === undefined) {
			return this.literal(desc.value, this.adopt(against.nominal, role), at)
		}
		if (desc.kind === "param") {
			return this.param(desc, this.adopt(against.nominal, role), at)
		}
		const term = this.lower(desc, at)
		this.requireCompatible(against.nominal, term.nominal, at)
		return term
	}

	requireCompatible(a: ScalarType, b: ScalarType, at: SourceLoc): void {
		if (!compatible(a, b)) {
			stop(
				"MalformedDescription",
				at,
				`operands of one type: ${typeLabel(a)} never meets ${typeLabel(b)} without Compute.base`
			)
		}
	}

	/** Total fragment: an integer operand cast to numeric, an exact widening. */
	numericize(x: Lowered): Lowered {
		const carrier = baseOf(x.actual).carrier
		if (carrier !== "int2" && carrier !== "int4" && carrier !== "int8") {
			return x
		}
		const node = this.castNode(x, plainType("numeric"), {
			kind: "native",
			op: registeredCast(carrier, "numeric"),
			total: false
		})
		return {
			...node,
			nominal: x.nominal,
			known: { kind: "digits", digits: integerDigits[carrier] }
		}
	}

	/**
	 * Total fragment: the bound on a numeric operand's integer digits, or undefined when its values reach numeric's
	 * format limit (bare numeric). A numeric(p, s) value is below 10^(p - s); a literal has its own digits; NaN and the
	 * infinities never overflow an operation.
	 */
	digits(x: Lowered): number | undefined {
		if (x.known.kind === "digits") {
			return x.known.digits
		}
		const value = literalValue(x)
		if (value instanceof Decimal) {
			return value.isFinite() ? Math.max(value.coefficient.toString().length - value.scale, 0) : 0
		}
		const base = baseOf(x.actual)
		if (base.carrier !== "numeric") {
			return undefined
		}
		const { typmod } = base
		return typmod === undefined ? undefined : Math.max(typmod.precision - typmod.scale, 0)
	}

	/**
	 * Total fragment: the bound of an arithmetic result over operands whose bounds are known, refused when an operand
	 * is unbounded or the result could pass numeric's 131072 integer digits, where PostgreSQL raises 22003.
	 */
	bounded(
		fn: string,
		x: Lowered,
		y: Lowered,
		combine: (dx: number, dy: number) => number,
		at: SourceLoc
	): number {
		const digitsOf = (o: Lowered): number => {
			const d = this.digits(o)
			if (d === undefined) {
				return stop(
					"UnsupportedOperation",
					at,
					`${fn} over a bare numeric in a contract predicate or row check: its values reach numeric's limit of ${numericMaxIntegerDigits} integer digits, where arithmetic raises 22003, and a predicate never raises; declare the operand with a precision`
				)
			}
			return d
		}
		const dx = digitsOf(x)
		const dy = digitsOf(y)
		const bound = combine(dx, dy)
		if (bound > numericMaxIntegerDigits) {
			return stop(
				"UnsupportedOperation",
				at,
				`${fn} in a contract predicate or row check: the result can pass numeric's limit of ${numericMaxIntegerDigits} integer digits, where it raises 22003, and a predicate never raises`
			)
		}
		return bound
	}

	overload(
		fn: Exclude<FixedFn, "cast">,
		carriers: ReadonlyArray<ScalarType>,
		at: SourceLoc
	): FixedOp {
		const op = overloadOf(
			fn,
			carriers.map((t) => baseOf(t).carrier)
		)
		if (op === undefined) {
			return stop(
				"UnsupportedOperation",
				at,
				`${fn}: PostgreSQL has no ${fn} over ${carriers.map(typeLabel).join(", ")} that Compute admits`
			)
		}
		return op
	}

	/** LEAST or GREATEST over operands of `type`. */
	extreme(fn: "least" | "greatest", type: ScalarType, at: SourceLoc): ExtremeOp {
		const op = extremeOf(fn, baseOf(type).carrier)
		if (op === undefined) {
			return stop(
				"UnsupportedOperation",
				at,
				`${fn}: PostgreSQL has no ${fn} over ${typeLabel(type)} that Compute admits`
			)
		}
		return op
	}

	/** The result type of a fixed-result operation, its registered plain carrier: a numeric result is unconstrained numeric. */
	resultType(op: FixedOp): ScalarType {
		return plainType(op.result)
	}

	lower(desc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		switch (desc.kind) {
			case "var":
			case "field":
			case "value":
			case "parent":
				return this.emit(unwrap(this.env.leaf(desc, at)))
			case "param":
				return this.term(desc, at)
			case "literal": {
				if (desc.type !== undefined) {
					const t = unwrap(this.env.fieldType(desc.type, at))
					return this.literal(desc.value, t, at)
				}
				return this.bareLiteral(desc.value, at)
			}
			case "compute":
				return this.compute(desc, at)
			case "cast":
				return this.cast(desc, at)
			case "base": {
				const arg = this.term(desc.arg, childLoc(at, "base"))
				return { ...arg, nominal: valueType(arg.nominal) }
			}
			case "cond":
				return this.cond(desc, at)
			case "compare": {
				const left = this.term(desc.left, childLoc(at, desc.op, "left"))
				const right = this.operand(desc.right, left, "compare", childLoc(at, desc.op, "right"))
				return this.comparison(desc.op, [left, right], at)
			}
			case "between": {
				const arg = this.term(desc.arg, childLoc(at, "between"))
				const low = this.operand(desc.low, arg, "compare", childLoc(at, "between", "low"))
				const high = this.operand(desc.high, arg, "compare", childLoc(at, "between", "high"))
				return this.comparison("between", [arg, low, high], at)
			}
			case "in": {
				const arg = this.term(desc.arg, childLoc(at, "in"))
				const type = this.adopt(arg.nominal, "compare")
				const values = desc.values.map((v, i) => this.literal(v, type, childLoc(at, "in", i)))
				return this.comparison("in", [arg, ...values], at)
			}
			case "and":
			case "or": {
				const args = desc.args.map((a, i) => this.predicate(a, childLoc(at, desc.kind, i)))
				const op = this.overload(desc.kind, [plainType("bool")], at)
				return this.native(op, args, plainType("bool"))
			}
			case "not": {
				const arg = this.predicate(desc.arg, childLoc(at, "not"))
				return this.native(this.overload("not", [plainType("bool")], at), [arg], plainType("bool"))
			}
			case "allen":
			case "pointIn":
			case "absent": {
				if (this.env.mode !== "query") {
					return stop(
						"UnsupportedOperation",
						at,
						`${desc.kind}: lowered by its own package, not the Compute catalogue`
					)
				}
				return unwrap(
					this.env.extension(desc, at, (child) =>
						catchRefusal(() => this.lower(child, childLoc(at, desc.kind)))
					)
				)
			}
		}
	}

	predicate(desc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		const p = this.term(desc, at)
		if (baseOf(p.actual).carrier !== "bool") {
			return stop("MalformedDescription", at, `a predicate, not ${typeLabel(p.nominal)}`)
		}
		return p
	}

	/** A literal that meets no term. */
	bareLiteral(value: LiteralDesc, at: SourceLoc): Lowered {
		const kind = bareLiteralKind(value)
		const type = (() => {
			switch (kind) {
				case "integer":
					return plainType("int4")
				case "bigint":
					return plainType("int8")
				case "numeric":
					return plainType("numeric")
				case "money":
					return plainType("money")
				case "boolean":
					return plainType("bool")
				case "text":
					return wildcardText
				case undefined:
					return stop(
						"MalformedDescription",
						at,
						"a literal that meets no term: an integer, a bigint, a Decimal, a Money, a boolean or a string"
					)
			}
		})()
		return this.literal(value, type, at)
	}

	comparison(
		fn: "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "between" | "in",
		operands: ReadonlyArray<Lowered>,
		at: SourceLoc
	): Lowered {
		let args = operands
		if (
			this.total &&
			args.some((a) => !isInteger(a.actual) && baseOf(a.actual).carrier === "numeric")
		) {
			args = args.map((a) => this.numericize(a))
		}
		const [first] = args
		if (first === undefined) {
			return stop("MalformedDescription", at, `an operand for ${fn}`)
		}
		const capability = fn === "eq" || fn === "ne" || fn === "in" ? "equality" : "ordering"
		if (!first.actual.caps.includes(capability)) {
			return stop(
				"UnsupportedOperation",
				at,
				`${capability}: ${typeLabel(first.nominal)} has no ${fn}`
			)
		}
		const op = this.overload(fn, fn === "in" ? [first.actual] : args.map((a) => a.actual), at)
		return this.native(op, args, plainType("bool"))
	}

	cond(desc: Extract<ExprDesc<Located, R>, { readonly kind: "cond" }>, at: SourceLoc): Lowered {
		if (this.total) {
			return stop(
				"UnsupportedOperation",
				at,
				"cond in a contract predicate or row check: the total fragment is comparisons, between, in, boolean composition, abs, sign, arithmetic and charLength"
			)
		}
		const p = this.predicate(desc.pred, childLoc(at, "cond"))
		/**
		 * The two branches, typed: a branch that fixes its type first and the other adopting it; a literal opposite a
		 * literal or a parameter fixes the type, and the other adopts it. Two parameters fix none.
		 */
		const thenAt = childLoc(at, "cond", "then")
		const elseAt = childLoc(at, "cond", "else")
		let onTrue: Lowered
		let onFalse: Lowered
		if (!isUntypedInput(desc.onTrue)) {
			onTrue = this.term(desc.onTrue, thenAt)
			onFalse = this.operand(desc.onFalse, onTrue, "compare", elseAt)
		} else if (!isUntypedInput(desc.onFalse)) {
			onFalse = this.term(desc.onFalse, elseAt)
			onTrue = this.operand(desc.onTrue, onFalse, "compare", thenAt)
		} else if (desc.onTrue.kind === "literal") {
			onTrue = this.bareLiteral(desc.onTrue.value, thenAt)
			onFalse = this.operand(desc.onFalse, onTrue, "compare", elseAt)
		} else if (desc.onFalse.kind === "literal") {
			onFalse = this.bareLiteral(desc.onFalse.value, elseAt)
			onTrue = this.operand(desc.onTrue, onFalse, "compare", thenAt)
		} else {
			return stop(
				"MalformedDescription",
				at,
				"a conditional branch that fixes the type: a parameter adopts the other branch's type, so both cannot be parameters"
			)
		}
		/**
		 * A parameter branch is an emitted value of the type it adopted, so it is cast into that type's contract or
		 * refinement, which PostgreSQL validates (an emitted parameter is cast to its domain); a comparison binds it as its base type instead.
		 */
		const emitted = (b: Lowered, d: ExprDesc<Located, R>, where: SourceLoc): Lowered =>
			d.kind === "param" && !sameShape(b.actual, b.nominal) ? this.castTo(b, b.nominal, where) : b
		onTrue = emitted(onTrue, desc.onTrue, thenAt)
		onFalse = emitted(onFalse, desc.onFalse, elseAt)
		const type = commonType(onTrue.nominal, onFalse.nominal)
		/**
		 * A branch of another shape converts into the common type: a coercion into its contract's domain when it has one,
		 * else a binary-coercible widening (a contract's base, a numeric typmod, a text refinement or a span width
		 * dropped: types.ts widensTo).
		 */
		const how: CastHow = contractOf(type) === undefined ? { kind: "widen" } : { kind: "domain" }
		const widen = (b: Lowered): Lowered =>
			sameShape(b.actual, type) ? b : this.castNode(b, type, how)
		const t = widen(onTrue)
		const e = widen(onFalse)
		return this.emit({ kind: "cond", args: [p.expr, t.expr, e.expr], type, nonNull: "cond" })
	}

	cast(desc: Extract<ExprDesc<Located, R>, { readonly kind: "cast" }>, at: SourceLoc): Lowered {
		if (this.total) {
			return stop(
				"UnsupportedOperation",
				at,
				"a cast in a contract predicate or row check: a checked cast can fail, and a predicate never raises"
			)
		}
		const arg = this.term(desc.arg, childLoc(at, "cast"))
		const to = withoutSerial(unwrap(this.env.fieldType(desc.to, childLoc(at, "cast", "to"))))
		return this.castTo(arg, to, childLoc(at, "cast"))
	}

	/**
	 * Compute.cast: a native conversion of the value types, then a checked domain cast into a contract or
	 * a regex-refined text type. A cast that changes nothing emits nothing.
	 *
	 * A numeric typmod coercion rounds and can overflow: a checked narrowing.
	 */
	castTo(arg: Lowered, to: ScalarType, at: SourceLoc): Lowered {
		const target = baseOf(to)
		const from = valueType(arg.actual)
		let value = arg
		const sameBase = from.carrier === target.carrier
		if (!sameBase) {
			const op = castOf(from.carrier, target.carrier)
			if (op === undefined) {
				return stop(
					"UnsupportedOperation",
					at,
					`cast: PostgreSQL has no cast from ${typeLabel(from)} to ${typeLabel(target)} that Compute admits`
				)
			}
			value = this.castNode(
				arg,
				numericTypmodOf(target) === undefined ? target : plainType("numeric"),
				{
					kind: "native",
					op,
					total: false
				}
			)
		} else if (target.carrier !== "numeric" && !compatibleCore(from, target)) {
			return stop(
				"UnsupportedOperation",
				at,
				`cast: ${typeLabel(from)} and ${typeLabel(target)} are different types with no cast between them`
			)
		}
		if (numericTypmodOf(target) !== undefined && !sameShape(value.actual, target)) {
			value = this.castNode(value, target, {
				kind: "native",
				op: registeredCast("numeric", "numeric"),
				total: false
			})
		}
		if (isRefined(to) && !sameRefinement(arg.actual, to)) {
			return this.emit({ kind: "domainCast", args: [value.expr], type: to, nonNull: "strict" })
		}
		return {
			...value,
			nominal: to,
			actual:
				contractOf(value.actual) === undefined && contractOf(to) === undefined ? to : value.actual
		}
	}

	compute(
		desc: Extract<ExprDesc<Located, R>, { readonly kind: "compute" }>,
		at: SourceLoc
	): Lowered {
		const { fn } = desc
		const here = childLoc(at, fn)
		if (this.total && !totalMembers.has(fn)) {
			return stop(
				"UnsupportedOperation",
				here,
				`${fn} in a contract predicate or row check: the total fragment is comparisons, between, in, boolean composition, abs, sign, arithmetic with nonzero literal divisors, charLength and span endpoints`
			)
		}
		const arity: Readonly<Record<string, number | undefined>> = {
			neg: 1,
			abs: 1,
			sign: 1,
			round: 1,
			trunc: 1,
			ceil: 1,
			floor: 1,
			sqrt: 1,
			scale: 1,
			minScale: 1,
			trimScale: 1,
			lower: 1,
			upper: 1,
			width: 1,
			charLength: 1,
			add: 2,
			sub: 2,
			mul: 2,
			div: 2,
			mod: 2,
			quot: 2,
			rem: 2,
			gcd: 2,
			lcm: 2,
			power: 2,
			cosineDistance: 2,
			widthBucket: 4
		}
		const expected = arity[fn]
		if (expected !== undefined && desc.args.length !== expected) {
			return stop(
				"MalformedDescription",
				here,
				`${expected} argument(s) for ${fn}, not ${desc.args.length}`
			)
		}
		const args = desc.args
		const arg = (i: number): ExprDesc<Located, R> => {
			const a = args[i]
			if (a === undefined) {
				return stop("MalformedDescription", here, `argument ${i + 1} for ${fn}`)
			}
			return a
		}
		switch (desc.fn) {
			case "add":
			case "sub":
			case "mul":
			case "div":
			case "mod":
				return this.arithmetic(desc.fn, arg(0), arg(1), here)
			case "neg":
			case "abs": {
				const a = this.term(arg(0), here)
				const v = valueType(a.nominal)
				if (this.total) {
					return this.#totalNegAbs(desc.fn, a, v, here)
				}
				const op = this.overload(desc.fn, [v], here)
				return this.native(op, [a], this.resultType(op))
			}
			case "sign":
				return this.sign(this.term(arg(0), here), here)
			case "quot":
			case "rem":
			case "power": {
				const a = this.term(arg(0), here)
				const b = this.operand(arg(1), a, "operand", here)
				const v = valueType(a.nominal)
				if (desc.fn !== "power") {
					this.requireNumeric(v, desc.fn, here)
				}
				const op = this.overload(desc.fn, [v, v], here)
				return this.native(op, [a, b], this.resultType(op))
			}
			case "round":
			case "trunc": {
				const a = this.term(arg(0), here)
				this.requireNumeric(a.nominal, desc.fn, here)
				if (desc.scale === undefined) {
					const op = this.overload(desc.fn, [a.nominal], here)
					return this.native(op, [a], this.resultType(op))
				}
				const digits = this.literal(desc.scale, plainType("int4"), childLoc(here, "scale"))
				const op = this.overload(desc.fn, [a.nominal, plainType("int4")], here)
				return this.native(op, [a, digits], this.resultType(op))
			}
			case "scale":
			case "minScale": {
				const a = this.term(arg(0), here)
				this.requireNumeric(a.nominal, desc.fn, here)
				return this.scaleOf(desc.fn, a, here)
			}
			case "ceil":
			case "floor":
			case "sqrt":
			case "trimScale": {
				const a = this.term(arg(0), here)
				const v = valueType(a.nominal)
				if (desc.fn !== "sqrt") {
					this.requireNumeric(v, desc.fn, here)
				}
				const op = this.overload(desc.fn, [v], here)
				return this.native(op, [a], this.resultType(op))
			}
			case "gcd":
			case "lcm":
				return this.gcdLcm(desc.fn, arg(0), arg(1), here)
			case "least":
			case "greatest": {
				const [, ...rest] = args
				const a = this.term(arg(0), childLoc(here, 0))
				const others = rest.map((d, i) => {
					if (d.kind === "literal" && d.type === undefined) {
						return stop(
							"MalformedDescription",
							childLoc(here, i + 1),
							`${desc.fn} takes terms or parameters, never a bare literal`
						)
					}
					return this.operand(d, a, "compare", childLoc(here, i + 1))
				})
				const all = [a, ...others]
				const type = all.reduce((t, x) => commonType(t, x.nominal), a.nominal)
				if (!type.caps.includes("ordering")) {
					return stop(
						"UnsupportedOperation",
						here,
						`ordering: ${typeLabel(type)} has no ${desc.fn}`
					)
				}
				const op = this.extreme(desc.fn, type, here)
				return this.native(op, all, type)
			}
			case "widthBucket":
				return this.widthBucket(args, here)
			case "lower":
			case "upper": {
				const s = this.span(arg(0), here)
				const endpoint = withoutSerial(s.span)
				const op = this.overload(desc.fn, [s.lowered.actual], here)
				return this.native(op, [s.lowered], endpoint)
			}
			case "width":
				return this.width(arg(0), here)
			case "charLength": {
				if (this.env.mode === "query") {
					return stop(
						"UnsupportedOperation",
						here,
						"charLength in a query: it exists only in contract predicates and row checks, because queries have no text functions"
					)
				}
				const a = this.term(arg(0), here)
				if (baseOf(a.actual).carrier !== "text") {
					return stop(
						"MalformedDescription",
						here,
						`a text term for charLength, not ${typeLabel(a.nominal)}`
					)
				}
				const op = this.overload("charLength", [a.actual], here)
				return this.native(op, [a], this.resultType(op))
			}
			case "cosineDistance": {
				const a = this.term(arg(0), here)
				const b = this.operand(arg(1), a, "compare", here)
				const v = baseOf(a.nominal)
				if (v.carrier !== "vector") {
					return stop(
						"UnsupportedOperation",
						here,
						"vectorDistance: cosine distance is defined only over a vector"
					)
				}
				const op = this.overload("cosineDistance", [v, v], here)
				return this.native(op, [a, b], this.resultType(op))
			}
		}
	}

	requireNumeric(t: ScalarType, fn: string, at: SourceLoc): void {
		if (baseOf(t).carrier !== "numeric") {
			stop("MalformedDescription", at, `a numeric term for ${fn}, not ${typeLabel(t)}`)
		}
	}

	/**
	 * scale and min_scale return NULL for NaN and the infinities, and no expression may absorb a NULL, so the native call stands under a guard that raises instead: CASE WHEN x > '-Infinity' AND
	 * x < 'Infinity' THEN scale(x) ELSE x::integer END. The guard holds exactly for finite x, under it the call never
	 * returns NULL, and the ELSE branch is reached only for NaN and the infinities, whose integer cast raises 0A000.
	 */
	scaleOf(fn: "scale" | "minScale", a: Lowered, at: SourceLoc): Lowered {
		const numeric = plainType("numeric")
		const int4 = plainType("int4")
		const bool = plainType("bool")
		const bound = (value: Decimal) =>
			this.literalNode({ literal: { kind: "numeric", value }, value }, numeric)
		const gt = this.overload("gt", [numeric, numeric], at)
		const lt = this.overload("lt", [numeric, numeric], at)
		const above = this.native(gt, [a, bound(Decimal.negativeInfinity)], bool)
		const below = this.native(lt, [a, bound(Decimal.infinity)], bool)
		const finite = this.native(this.overload("and", [bool], at), [above, below], bool)
		const call = this.nativeTotal(this.overload(fn, [numeric], at), [a], int4)
		const raise = this.castNode(a, int4, {
			kind: "native",
			op: registeredCast("numeric", "int4"),
			total: false
		})
		return this.emit({
			kind: "cond",
			args: [finite.expr, call.expr, raise.expr],
			type: int4,
			nonNull: "cond"
		})
	}

	floatArithmetic(fn: string, t: ScalarType, at: SourceLoc): never {
		return stop(
			"UnsupportedOperation",
			at,
			`${fn} over ${typeLabel(t)} in a contract predicate or row check: float and money arithmetic can overflow, and a predicate never raises`
		)
	}

	arithmetic(
		fn: "add" | "sub" | "mul" | "div" | "mod",
		left: ExprDesc<Located, R>,
		right: ExprDesc<Located, R>,
		at: SourceLoc
	): Lowered {
		const a = this.term(left, at)
		const b = this.operand(right, a, "operand", at)
		const v = valueType(a.nominal)
		if (!this.total) {
			const op = this.overload(fn, [v, v], at)
			return this.native(op, [a, b], this.resultType(op))
		}
		if (isFloat(v) || v.carrier === "money") {
			return this.floatArithmetic(fn, v, at)
		}
		/** The nominal type is the query's: the native result over the value type. */
		const nominalOp = this.overload(fn, [v, v], at)
		if (fn === "div" || fn === "mod") {
			const divisor = literalValue(b)
			if (divisor === undefined) {
				return stop(
					"UnsupportedOperation",
					at,
					`${fn} in a contract predicate or row check by a nonliteral divisor: a divisor is a nonzero literal, so the predicate cannot fail`
				)
			}
			if (divisor === 0n || (divisor instanceof Decimal && divisor.isZero())) {
				return stop("UnsupportedOperation", at, `${fn} by zero: a divisor is a nonzero literal`)
			}
		}
		const x = this.numericize(a)
		const y = this.numericize(b)
		const divisor = literalValue(b)
		const divisorExponent =
			typeof divisor === "bigint" || divisor instanceof Decimal ? leadingExponent(divisor) : 0
		/**
		 * |x / d| <= |x| * 10^-e for a divisor |d| >= 10^e, and one more digit for the quotient's rounding.
		 */
		const digits = this.bounded(
			fn,
			x,
			y,
			(ix, iy) => {
				switch (fn) {
					case "add":
					case "sub":
						return Math.max(ix, iy) + 1
					case "mul":
						return ix + iy
					case "mod":
						return ix
					case "div":
						return ix + Math.max(0, -divisorExponent) + 1
				}
			},
			at
		)
		/** An integer quotient truncates toward zero: div(numeric, numeric), never numeric /. */
		const op = this.overload(fn === "div" && isInteger(v) ? "quot" : fn, [x.actual, y.actual], at)
		return {
			...this.nativeTotal(op, [x, y], this.resultType(op)),
			nominal: this.resultType(nominalOp),
			known: { kind: "digits", digits }
		}
	}

	/**
	 * sign returns the operand's value type, unconstrained. PostgreSQL has sign(numeric) and sign(double precision) only,
	 * whose results carry no typmod (a numeric(p, s) operand's sign is a numeric, 1 and not 1.00), so sign over an
	 * integer type is sign(x::numeric) cast back, and over real sign(x::double precision) cast back; the cast back is
	 * total, because the value is -1, 0 or 1, one integer digit whatever the operand's bound.
	 */
	sign(a: Lowered, at: SourceLoc): Lowered {
		const v = valueType(a.actual)
		const carrier = v.carrier
		switch (carrier) {
			case "numeric":
			case "float8": {
				const op = this.overload("sign", [v], at)
				return {
					...this.native(op, [a], this.resultType(op)),
					known: { kind: "digits", digits: 1 }
				}
			}
			case "int2":
			case "int4":
			case "int8":
				return this.signThrough(
					a,
					v,
					"numeric",
					registeredCast(carrier, "numeric"),
					registeredCast("numeric", carrier),
					at
				)
			case "float4":
				return this.signThrough(
					a,
					v,
					"float8",
					registeredCast("float4", "float8"),
					registeredCast("float8", "float4"),
					at
				)
			case "money":
			case "bool":
			case "uuid":
			case "text":
			case "enum":
			case "range4":
			case "range8":
			case "vector":
				return stop("UnsupportedOperation", at, `sign: PostgreSQL has no sign over ${typeLabel(v)}`)
		}
	}

	/** sign over a carrier PostgreSQL has none of: the operand widened to `via` by `widen`, its sign cast back by `back`. */
	signThrough(
		a: Lowered,
		v: ScalarType,
		via: "numeric" | "float8",
		widen: CastOp,
		back: CastOp,
		at: SourceLoc
	): Lowered {
		const wide = this.castNode(a, plainType(via), { kind: "native", op: widen, total: false })
		const op = this.overload("sign", [wide.actual], at)
		const s = this.native(op, [wide], this.resultType(op))
		return {
			...this.castNode(s, v, { kind: "native", op: back, total: true }),
			nominal: valueType(a.nominal)
		}
	}

	/**
	 * gcd and lcm over integer, bigint and numeric; over smallint PostgreSQL resolves neither (gcd(smallint, smallint)
	 * is ambiguous), so they are the integer forms cast back to smallint, a checked cast, because gcd(-32768, 0) is
	 * 32768.
	 */
	gcdLcm(
		fn: "gcd" | "lcm",
		left: ExprDesc<Located, R>,
		right: ExprDesc<Located, R>,
		at: SourceLoc
	): Lowered {
		if (right.kind === "literal" && right.type === undefined) {
			return stop("MalformedDescription", at, `${fn} takes a term or a parameter, never a literal`)
		}
		const a = this.term(left, at)
		const b = this.operand(right, a, "operand", at)
		const v = valueType(a.nominal)
		if (v.carrier === "int2") {
			const int4 = plainType("int4")
			const widen: CastHow = { kind: "native", op: registeredCast("int2", "int4"), total: false }
			const x = this.castNode(a, int4, widen)
			const y = this.castNode(b, int4, widen)
			const op = this.overload(fn, [int4, int4], at)
			const r = this.native(op, [x, y], int4)
			return this.castNode(r, v, {
				kind: "native",
				op: registeredCast("int4", "int2"),
				total: false
			})
		}
		const op = this.overload(fn, [v, v], at)
		return this.native(op, [a, b], this.resultType(op))
	}

	widthBucket(args: ReadonlyArray<ExprDesc<Located, R>>, at: SourceLoc): Lowered {
		const [x, low, high, count] = args
		if (x === undefined || low === undefined || high === undefined || count === undefined) {
			return stop("MalformedDescription", at, "4 argument(s) for widthBucket")
		}
		const nx = this.term(x, childLoc(at, "operand"))
		const nl = this.term(low, childLoc(at, "low"))
		const nh = this.term(high, childLoc(at, "high"))
		for (const [t, which] of [
			[nx, "operand"],
			[nl, "low"],
			[nh, "high"]
		] as const) {
			this.requireNumeric(t.nominal, `widthBucket's ${which}`, at)
		}
		const int4 = plainType("int4")
		/** The count, an int4: a parameter or literal adopts it, any other term is an integer, int2 widened. */
		let nc: Lowered
		if (count.kind === "param") {
			nc = this.param(count, int4, childLoc(at, "count"))
		} else if (count.kind === "literal" && count.type === undefined) {
			nc = this.literal(count.value, int4, childLoc(at, "count"))
		} else {
			nc = this.term(count, childLoc(at, "count"))
			const c = valueType(nc.nominal).carrier
			if (c === "int2") {
				nc = this.castNode(nc, int4, {
					kind: "native",
					op: registeredCast("int2", "int4"),
					total: false
				})
			} else if (c !== "int4") {
				return stop(
					"MalformedDescription",
					childLoc(at, "count"),
					`an integer count, not ${typeLabel(nc.nominal)}`
				)
			}
		}
		const numeric = plainType("numeric")
		const op = this.overload("widthBucket", [numeric, numeric, numeric, int4], at)
		return this.native(op, [nx, nl, nh, nc], this.resultType(op))
	}

	/** neg or abs in the total fragment: a float or money negation by its own arithmetic, any other over numeric. */
	#totalNegAbs(fn: "neg" | "abs", a: Lowered, v: ValueType, at: SourceLoc): Lowered {
		if (fn === "neg" && (isFloat(v) || v.carrier === "money")) {
			return this.floatArithmetic(fn, v, at)
		}
		const x = this.numericize(a)
		const op = this.overload(fn, [x.actual], at)
		return {
			...this.nativeTotal(op, [x], this.resultType(op)),
			nominal: v,
			known: digitsKnown(this.digits(x))
		}
	}

	span(
		desc: ExprDesc<Located, R>,
		at: SourceLoc
	): { readonly lowered: Lowered; readonly span: ScalarType } {
		const s = this.term(desc, at)
		const info = spanOf(s.nominal)
		if (info === undefined) {
			return stop("MalformedDescription", at, `a span term, not ${typeLabel(s.nominal)}`)
		}
		return { lowered: s, span: info.endpoint }
	}

	/**
	 * width(s) = upper(s) - lower(s), typed as the endpoint's base; in the total fragment both endpoints
	 * are cast to numeric first, so a width never overflows.
	 */
	width(desc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		const s = this.span(desc, at)
		const endpoint = valueType(s.span)
		const upper = this.native(this.overload("upper", [s.lowered.actual], at), [s.lowered], endpoint)
		const lower = this.native(this.overload("lower", [s.lowered.actual], at), [s.lowered], endpoint)
		if (!this.total) {
			const op = this.overload("sub", [endpoint, endpoint], at)
			return this.native(op, [upper, lower], endpoint)
		}
		const x = this.numericize(upper)
		const y = this.numericize(lower)
		const digits = this.bounded("width", x, y, (dx, dy) => Math.max(dx, dy) + 1, at)
		const op = this.overload("sub", [x.actual, y.actual], at)
		return {
			...this.nativeTotal(op, [x, y], this.resultType(op)),
			nominal: endpoint,
			known: { kind: "digits", digits }
		}
	}
}

/** The integer digits of each integer type's widest value: the bound a widened integer operand carries. */
const integerDigits: { readonly [C in IntCarrier]: number } = { int2: 5, int4: 10, int8: 19 }

/** The decimal exponent of a nonzero divisor literal's leading digit, |d| >= 10^e; an integer literal is an integer. */
const leadingExponent = (d: bigint | Decimal): number => {
	if (typeof d === "bigint") {
		return (d < 0n ? -d : d).toString().length - 1
	}
	if (!d.isFinite()) {
		return 0
	}
	return d.coefficient.toString().length - 1 - d.scale
}

/** Same carrier, numeric typmod, contract name and regex refinement. */
const sameShape = (a: ScalarType, b: ScalarType): boolean => {
	if (a.carrier !== b.carrier) {
		return false
	}
	const ta = numericTypmodOf(a)
	const tb = numericTypmodOf(b)
	if (ta?.precision !== tb?.precision || ta?.scale !== tb?.scale) {
		return false
	}
	if (contractOf(a)?.name !== contractOf(b)?.name) {
		return false
	}
	return sameRegex(textOf(a)?.regex, textOf(b)?.regex)
}

/** Whether a value already carries the refinement a cast target names: the same contract, or the same regex. */
const sameRefinement = (a: ScalarType, to: ScalarType): boolean => {
	const contract = contractOf(to)
	if (contract !== undefined) {
		return contractOf(a)?.name === contract.name && compatible(a, to)
	}
	return sameShape(withoutSerial(a), to)
}

const compatibleCore = (a: ScalarType, b: ScalarType): boolean =>
	compatible(valueType(a), valueType(b))

const run = <R extends Refs>(
	env: LowerEnv<R>,
	f: (l: Lowering<R>) => Lowered
): Result.Result<Lowered, CompileError> => catchRefusal(() => f(new Lowering(env)))

/**
 * Typing and lowering of scalar expression descriptions to the scalar IR.
 *
 * An ExprDesc<Located, R>, as a builder recorded it or a description carried it, is resolved against the static overload registry
 * into ScalarExprs, one node per PostgreSQL operator, function, cast or construct. The caller supplies the
 * sink the nodes go to (a DagBuilder's `expr`, or a contract predicate's table) and the leaves (rule variables, a check's
 * fields, a contract's VALUE, parameters), so the same typing serves query filters and outputs, contract predicates
 * and row checks. Typing follows PostgreSQL's overload resolution, never JavaScript's number-versus-bigint distinction:
 *
 * - Operands of one operation share a nominal type (types.ts compatible): a contract and its bare base never meet
 *   without Compute.base, and arithmetic over a contract yields the base.
 * - A literal never stands first and has no type of its own: it adopts the type of the term it meets. In
 *   a comparison, an IN list, BETWEEN bounds or a conditional's branch it adopts that term's contract or regex
 *   refinement and is checked against it here, the ContractLiteral check; in arithmetic it adopts the
 *   term's value type, the unconstrained base. A parameter adopts the same types, and the caller binds it.
 * - When both branches of Compute.cond are literals, number literals are integer and every other literal is its own
 *   host type.
 *
 * Three modes:
 * - "query": queries and Compute outputs, where an execution failure is an admitted typed outcome; every
 *   node records whether it can fail.
 * - "total": contract predicates and row checks, the total fragment:
 *   comparisons, BETWEEN, IN, boolean composition, abs, sign, arithmetic whose divisors are nonzero literals,
 *   char_length over text, and span endpoints and widths, with Compute.base. Integer operands are cast to numeric
 *   before arithmetic and abs, so nothing overflows; a divisor is a nonzero literal, so nothing divides by zero; and
 *   float and money arithmetic, which can overflow, is refused, so a predicate never raises and a refused value is
 *   always a constraint violation. Numeric arithmetic itself overflows past 131072 integer digits (22003), so each
 *   numeric operand carries an upper bound on its integer digits: an integer type's, a numeric(p, s) typmod's p - s,
 *   a literal's own; arithmetic over a bare numeric operand, whose values reach the format's limit, or whose result
 *   bound could pass the limit, is refused. Integer division keeps its meaning: an integer quotient widened to numeric
 *   is div(numeric, numeric), which truncates toward zero as int8div does, never numeric /. Each lowered operand keeps
 *   its nominal type (the public type the caller wrote) beside its actual SQL type, so compatibility is judged as in a
 *   query while the arithmetic is numeric.
 * - "build": a builder typing the term it constructs (builders.ts), before it knows where the term is used: query
 *   typing that admits charLength, which a contract predicate may use, and leaves the ContractLiteral check to
 *   compilation, where every semantic diagnostic is reported.
 *
 * Lowers a term: a Compute expression, a reference, or a typed literal.
 */
export const lowerTerm = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: LowerEnv<R>
): Result.Result<Lowered, CompileError> =>
	run(env, (l) => {
		const lowered = l.term(desc, env.loc)
		if (env.mode === "total" && lowered.failure === "canFail") {
			stop(
				"UnsupportedOperation",
				env.loc,
				"a total expression: a contract predicate or row check never raises"
			)
		}
		return lowered
	})

/** Lowers a predicate: a non-null SQL Boolean expression. */
export const lowerPredicate = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: LowerEnv<R>
): Result.Result<Lowered, CompileError> =>
	run(env, (l) => {
		const lowered = l.predicate(desc, env.loc)
		if (env.mode === "total" && lowered.failure === "canFail") {
			stop(
				"UnsupportedOperation",
				env.loc,
				"a total predicate: a contract predicate or row check never raises"
			)
		}
		return lowered
	})
