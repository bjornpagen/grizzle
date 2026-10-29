import { handleColumn } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { captureLoc, childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type CompareOp,
	type ComputeFn,
	decodeDesc,
	type ExprDesc,
	type FieldDesc,
	type LiteralDesc,
	type ScaledComputeFn
} from "#compiler/ir/desc.ts"
import type { LiteralExpr, OpenExpr } from "#compiler/ir/open.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { baseOf, type ScalarType, spanOf, typeLabel } from "#compiler/ir/scalar.ts"
import { admittedClosedId, closedIdParts } from "#compiler/scalar/closed-id.ts"
import {
	exprEmitter,
	type LowerEnv,
	type Lowered,
	lowerPredicate,
	lowerTerm
} from "#compiler/scalar/compute/lower.ts"

import {
	type EndpointSql,
	type IntegralSql,
	type NumericSql,
	type PlainHost,
	type PlainSql,
	type PowerSql,
	plainColumns,
	quotientSql,
	type SignedSql
} from "#compiler/scalar/compute/tables.ts"

import {
	type PredicateValue,
	predicateExpr,
	predicateValue,
	registerTerm,
	type ScalarTerm,
	type TermCarrier,
	termOf,
	typedTermOf
} from "#compiler/scalar/compute/term.ts"
import { compatible, plainType, valueType, withoutSerial } from "#compiler/scalar/compute/types.ts"
import {
	carrierSql,
	describeField,
	isDescriptorCopy,
	isOwnedDescriptor,
	literalDescFor,
	type SqlTag
} from "#compiler/scalar/registry.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"

const malformed = (loc: SourceLoc, capability: string): never => {
	throw malformedDescription(loc, capability)
}

/**
 * What a field descriptor carries for the compiler beside its public members (scalar/registry.ts): its Description and
 * its ScalarType, decoded here into owned copies, and its carrier, its column and SQL type.
 */
interface DescribedField {
	readonly desc: FieldDesc
	readonly scalar: ScalarType
	readonly carrier: TermCarrier
}

/** A descriptor's SQL type, admitted: one of carrierSql's names. */
const sqlTags: ReadonlySet<string> = new Set<string>(Object.values(carrierSql))
const isSqlTag = (value: unknown): value is SqlTag =>
	typeof value === "string" && sqlTags.has(value)

/** A column a descriptor carries, admitted by its kind and its members' kinds. */
const isColumnLike = (value: unknown): value is TermCarrier["column"] => {
	if (!hasProperties(value)) {
		return false
	}
	switch (value["kind"]) {
		case "convert":
			return typeof value["convert"] === "function"
		case "handle":
			return isList(value["handles"]) && value["handles"].length > 0
		case "constant":
			return (
				isList(value["values"]) &&
				value["values"].length > 0 &&
				typeof value["convert"] === "function"
			)
		default:
			return false
	}
}

/**
 * What describedField reads of a caller's value: a descriptor the registry resolves, the members of one read
 * structurally, or neither.
 */
type FieldReading =
	| { readonly kind: "registry" }
	| {
			readonly kind: "structural"
			readonly desc: object
			readonly scalar: object
			readonly sql: SqlTag
			readonly column: TermCarrier["column"]
	  }
	| { readonly kind: "none" }

const readField = (value: unknown): FieldReading => {
	if (
		isOwnedDescriptor(value) ||
		isDescriptorCopy(value) ||
		(hasProperties(value) && value["sql"] === "text" && hasProperties(value["pattern"]))
	) {
		return { kind: "registry" }
	}
	if (!hasProperties(value)) {
		return { kind: "none" }
	}
	const { desc, scalar, sql, column } = value
	if (!hasProperties(desc) || !hasProperties(scalar) || !isSqlTag(sql) || !isColumnLike(column)) {
		return { kind: "none" }
	}
	return { kind: "structural", desc, scalar, sql, column }
}

/**
 * A descriptor the field registry defined, or a str.regex text descriptor (read from its public pattern), is resolved
 * by the registry itself (describeField), so every descriptor family the public API builds is accepted here, and a
 * copy of one (a branded value no builder registered) is refused there; any other value is read structurally and
 * decoded strictly. Reading the caller's value can run its code (the brand test runs a proxy's `has` trap, a member
 * read its `get` trap or a getter), so it is read once through hostRead, and a value whose reading throws is refused,
 * never escaping as a defect.
 */
const describedField = (value: unknown, loc: SourceLoc): DescribedField => {
	const reading = hostRead(
		malformedDescription(loc, "a field descriptor whose properties can be read: no refusing proxy"),
		() => Result.ok(readField(value))
	)
	if (!reading.ok) {
		throw reading.error
	}
	const read = reading.value
	switch (read.kind) {
		case "registry": {
			const described = describeField(value, loc)
			if (!described.ok) {
				throw described.error
			}
			return {
				desc: described.value.desc,
				scalar: described.value.scalar,
				carrier: { column: described.value.column, sql: described.value.sql }
			}
		}
		case "structural": {
			const desc = decodeDesc("field", read.desc)
			if (!desc.ok) {
				throw desc.error
			}
			const scalar = decodeScalarType(read.scalar)
			if (!scalar.ok) {
				throw scalar.error
			}
			return {
				desc: desc.value,
				scalar: scalar.value,
				carrier: { column: read.column, sql: read.sql }
			}
		}
		case "none":
			return malformed(
				loc,
				"a field descriptor: pg.*, uuid, str.regex, contract, span, closedId or pg.vector"
			)
	}
}

/** A checked Compute expression: what it records, and the type the overload resolution gave it. */
interface Checked {
	readonly expr: OpenExpr
	readonly type: ScalarType
}

/** A checked Compute expression whose value is the value of its first term, with that term's carrier. */
interface CarriedChecked extends Checked {
	readonly carrier: TermCarrier
}

/**
 * A checked Compute expression whose value is a plain value (tables.ts PlainHost), with the plain SQL type of its base's
 * carrier.
 */
interface PlainChecked extends Checked {
	readonly sql: PlainSql
}

/**
 * One builder call: its operands, recorded twice, as the real expression and as a placeholder whose leaves name the
 * operands' known types, so the call can be typed before the leaves mean anything.
 */
class Call {
	readonly loc: SourceLoc
	readonly types: Array<ScalarType> = []
	readonly fields = new Map<FieldDesc, ScalarType>()

	constructor(label: string) {
		this.loc = captureLoc(label, [])
	}

	placeholder(type: ScalarType): ExprDesc {
		this.types.push(type)
		return { kind: "var", var: `#${this.types.length - 1}` }
	}

	/** A term, which stands first: never a literal, nor a parameter, which the checker types from the term it meets. */
	term(
		value: unknown,
		what: string
	): {
		readonly real: OpenExpr
		readonly ph: ExprDesc
		readonly type: ScalarType
		readonly carrier: TermCarrier
	} {
		const term = typedTermOf(value)
		if (term === undefined) {
			if (predicateExpr(value) !== undefined) {
				return malformed(this.loc, `a term as ${what}, not a predicate`)
			}
			return malformed(this.loc, `a term as ${what}: a literal never stands first`)
		}
		if (term.expr.kind === "param") {
			return malformed(this.loc, `a term as ${what}: a parameter takes its place opposite a term`)
		}
		return {
			real: term.expr,
			ph: this.placeholder(term.type),
			type: term.type,
			carrier: term.carrier
		}
	}

	/** A predicate, or a boolean term, which is a predicate here; never a parameter. */
	predicate(value: unknown, what: string): { readonly real: OpenExpr; readonly ph: ExprDesc } {
		const expr = predicateExpr(value)
		if (expr !== undefined) {
			return { real: expr, ph: this.placeholder(plainType("bool")) }
		}
		const term = termOf(value)
		if (term?.typing.kind === "typed" && term.expr.kind !== "param") {
			return { real: term.expr, ph: this.placeholder(term.typing.type) }
		}
		return malformed(this.loc, `a predicate as ${what}`)
	}

	literal(value: unknown, anchor: ScalarType): LiteralDesc {
		const literal = literalDescFor(anchor, value)
		if (!literal.ok) {
			return malformed(this.loc, describeFault(literal.error))
		}
		return literal.value
	}

	/**
	 * An operand opposite a term of `anchor`: a term, a parameter among them, or, where `literals` admits one, a literal
	 * of anchor's base.
	 */
	operand(
		value: unknown,
		anchor: ScalarType,
		literals: "literal" | "term"
	): {
		readonly real: OpenExpr
		readonly ph: ExprDesc
	} {
		const term = termOf(value)
		if (term?.typing.kind === "typed") {
			return { real: term.expr, ph: this.placeholder(term.typing.type) }
		}
		if (predicateExpr(value) !== undefined) {
			return malformed(this.loc, "a scalar operand, not a predicate")
		}
		if (literals === "term") {
			return malformed(this.loc, "a term or a parameter here, never a literal")
		}
		const literal: LiteralExpr = {
			kind: "literal",
			value: this.literal(value, anchor),
			type: undefined
		}
		return { real: literal, ph: literal }
	}

	field(value: unknown, what: string): DescribedField {
		const field = describedField(value, childLoc(this.loc, what))
		this.fields.set(field.desc, field.scalar)
		return field
	}

	env(): LowerEnv {
		return {
			mode: "build",
			loc: this.loc,
			emit: exprEmitter("b"),
			leaf: (desc) => {
				const index =
					desc.kind === "var" && desc.var.startsWith("#") ? Number(desc.var.slice(1)) : undefined
				const type = index === undefined ? undefined : this.types[index]
				if (type === undefined) {
					return Result.err(malformedDescription(this.loc, "an operand"))
				}
				return Result.ok({ kind: "value", args: [], type, nonNull: "storage" })
			},
			params: {
				kind: "scope",
				lower: ({ name }, type) =>
					Result.ok({
						kind: "param",
						param: ParamId(name),
						role: "compare",
						args: [],
						type: valueType(type),
						nonNull: "codec"
					})
			},
			fieldType: (desc) => {
				const type = this.fields.get(desc)
				return type === undefined
					? Result.err(malformedDescription(this.loc, "a field descriptor"))
					: Result.ok(type)
			}
		}
	}

	finish(real: OpenExpr, ph: ExprDesc): Checked {
		const typed: Result.Result<Lowered, CompileError> = lowerTerm(ph, this.env())
		if (!typed.ok) {
			throw typed.error
		}
		return { expr: real, type: typed.value.nominal }
	}

	/** finish of an expression whose value is plain: an enum's, a span's and a vector's values are no plain value. */
	finishPlain(real: OpenExpr, ph: ExprDesc): PlainChecked {
		const checked = this.finish(real, ph)
		const carrier = baseOf(checked.type).carrier
		if (
			carrier === "enum" ||
			carrier === "range4" ||
			carrier === "range8" ||
			carrier === "vector"
		) {
			return malformed(this.loc, `a value of a plain SQL type, not ${typeLabel(checked.type)}`)
		}
		return { ...checked, sql: carrierSql[carrier] }
	}

	finishPredicate(real: OpenExpr, ph: ExprDesc): PredicateValue {
		const typed = lowerPredicate(ph, this.env())
		if (!typed.ok) {
			throw typed.error
		}
		return predicateValue(real)
	}
}

const comparison =
	(op: CompareOp) =>
	(a: unknown, b: unknown): PredicateValue => {
		const call = new Call(`Compute.${op}`)
		const left = call.term(a, `${op}'s first operand`)
		const right = call.operand(b, left.type, "literal")
		return call.finishPredicate(
			{ kind: "compare", op, left: left.real, right: right.real },
			{ kind: "compare", op, left: left.ph, right: right.ph }
		)
	}

const between = (a: unknown, low: unknown, high: unknown): PredicateValue => {
	const call = new Call("Compute.between")
	const x = call.term(a, "between's operand")
	const lo = call.operand(low, x.type, "literal")
	const hi = call.operand(high, x.type, "literal")
	return call.finishPredicate(
		{ kind: "between", arg: x.real, low: lo.real, high: hi.real },
		{ kind: "between", arg: x.ph, low: lo.ph, high: hi.ph }
	)
}

const inList = (a: unknown, values: unknown): PredicateValue => {
	const call = new Call("Compute.in")
	const x = call.term(a, "in's operand")
	if (!isList(values) || values.length === 0) {
		return malformed(call.loc, "a nonempty finite list of literals")
	}
	const list: ReadonlyArray<unknown> = values
	const [first, ...rest] = list.map((v) => call.literal(v, x.type))
	if (first === undefined) {
		return malformed(call.loc, "a nonempty finite list of literals")
	}
	const literals: readonly [LiteralDesc, ...Array<LiteralDesc>] = [first, ...rest]
	return call.finishPredicate(
		{ kind: "in", arg: x.real, values: literals },
		{ kind: "in", arg: x.ph, values: literals }
	)
}

/**
 * A scalar term over `expr` whose literal operands adopt `t`, with a Scalar's comparisons, carried by `carrier`: its
 * column delivers T and S is its SQL type.
 */
export const scalarTerm = <T, S extends SqlTag>(
	expr: OpenExpr,
	t: ScalarType,
	carrier: TermCarrier<T, S>
): ScalarTerm<T, S> => {
	const self = (): ScalarTerm<T, S> => term
	const term: ScalarTerm<T, S> = Object.freeze({
		...builtMark,
		expr,
		column: carrier.column,
		sql: carrier.sql,
		eq: (other: unknown) => comparison("eq")(self(), other),
		ne: (other: unknown) => comparison("ne")(self(), other),
		lt: (other: unknown) => comparison("lt")(self(), other),
		le: (other: unknown) => comparison("le")(self(), other),
		gt: (other: unknown) => comparison("gt")(self(), other),
		ge: (other: unknown) => comparison("ge")(self(), other),
		between: (low: unknown, high: unknown) => between(self(), low, high),
		in: (values: unknown) => inList(self(), values)
	})
	return registerTerm(term, expr, t)
}

/**
 * A Compute function's call over a first term and further operands, literal or term only: what it records, its
 * placeholder form, which its builder finishes, and the first term's carrier.
 */
const computeCall = (
	fn: Exclude<ComputeFn, ScaledComputeFn>,
	literals: "literal" | "term",
	args: ReadonlyArray<unknown>
): {
	readonly call: Call
	readonly real: OpenExpr
	readonly ph: ExprDesc
	readonly carrier: TermCarrier
} => {
	const call = new Call(`Compute.${fn}`)
	const [first, ...rest] = args
	const a = call.term(first, `${fn}'s first operand`)
	const others = rest.map((v) => call.operand(v, a.type, literals))
	const real: OpenExpr = { kind: "compute", fn, args: [a.real, ...others.map((o) => o.real)] }
	const ph: ExprDesc = { kind: "compute", fn, args: [a.ph, ...others.map((o) => o.ph)] }
	return { call, real, ph, carrier: a.carrier }
}

const unary =
	(fn: Exclude<ComputeFn, ScaledComputeFn>) =>
	(a: unknown, ...extra: ReadonlyArray<unknown>): PlainChecked => {
		const call = new Call(`Compute.${fn}`)
		if (extra.length > 0) {
			return malformed(call.loc, `one operand for ${fn}`)
		}
		const x = call.term(a, `${fn}'s operand`)
		return call.finishPlain(
			{ kind: "compute", fn, args: [x.real] },
			{ kind: "compute", fn, args: [x.ph] }
		)
	}

const binary =
	(fn: Exclude<ComputeFn, ScaledComputeFn>, literals: "literal" | "term") =>
	(a: unknown, b: unknown, ...extra: ReadonlyArray<unknown>): PlainChecked => {
		if (extra.length > 0) {
			return malformed(captureLoc(`Compute.${fn}`, []), `two operands for ${fn}`)
		}
		const { call, real, ph } = computeCall(fn, literals, [a, b])
		return call.finishPlain(real, ph)
	}

/** round and trunc, with no scale (none given, or undefined) or an integer one. */
const scaled =
	(fn: ScaledComputeFn) =>
	(a: unknown, ...scale: ReadonlyArray<unknown>): PlainChecked => {
		const call = new Call(`Compute.${fn}`)
		const x = call.term(a, `${fn}'s operand`)
		const [digits, ...extra] = scale
		if (extra.length > 0) {
			return malformed(call.loc, `${fn}(x) or ${fn}(x, scale)`)
		}
		if (digits !== undefined && (typeof digits !== "number" || !Number.isSafeInteger(digits))) {
			return malformed(call.loc, `an integer scale for ${fn}`)
		}
		return call.finishPlain(
			{ kind: "compute", fn, args: [x.real], scale: digits },
			{ kind: "compute", fn, args: [x.ph], scale: digits }
		)
	}

const variadic =
	(fn: "least" | "greatest") =>
	(...xs: ReadonlyArray<unknown>): CarriedChecked => {
		if (xs.length === 0) {
			return malformed(captureLoc(`Compute.${fn}`, []), `at least one term for ${fn}`)
		}
		const { call, real, ph, carrier } = computeCall(fn, "term", xs)
		return { ...call.finish(real, ph), carrier }
	}

const boolean =
	(kind: "and" | "or") =>
	(...ps: ReadonlyArray<unknown>): PredicateValue => {
		const call = new Call(`Compute.${kind}`)
		if (ps.length === 0) {
			return malformed(call.loc, `at least one predicate for ${kind}`)
		}
		const [first, ...rest] = ps.map((p, i) => call.predicate(p, `${kind}'s operand ${i + 1}`))
		if (first === undefined) {
			return malformed(call.loc, `at least one predicate for ${kind}`)
		}
		return call.finishPredicate(
			{ kind, args: [first.real, ...rest.map((p) => p.real)] },
			{ kind, args: [first.ph, ...rest.map((p) => p.ph)] }
		)
	}

/**
 * A conditional: its first branch is a term, never a literal or a parameter, and types the conditional; the other is a
 * term of its type, a parameter among them, or a literal of it.
 */
const cond = (p: unknown, then: unknown, otherwise: unknown): CarriedChecked => {
	const call = new Call("Compute.cond")
	const pred = call.predicate(p, "cond's condition")
	const t = call.term(then, "cond's first branch, which types the conditional")
	const e = call.operand(otherwise, t.type, "literal")
	const checked = call.finish(
		{ kind: "cond", pred: pred.real, onTrue: t.real, onFalse: e.real },
		{ kind: "cond", pred: pred.ph, onTrue: t.ph, onFalse: e.ph }
	)
	return { ...checked, carrier: t.carrier }
}

/** A literal of a descriptor's type, built by the call `label` names: the value is checked as a value of that type. */
const typedLiteral = (label: string, type: unknown, value: unknown): Checked => {
	const call = new Call(label)
	const field = call.field(type, "the literal's type")
	const t = withoutSerial(field.scalar)
	const desc: LiteralExpr = { kind: "literal", value: call.literal(value, t), type: field.desc }
	return call.finish(desc, desc)
}

const literal = (type: unknown, value: unknown): Checked =>
	typedLiteral("Compute.literal", type, value)

/**
 * X.handle(member), a roster's typed handle: the literal Compute.literal(closedId(X), member) records, at X's enum,
 * whose column is that one handle. A member off the roster, or anything but a string from a JavaScript caller, is
 * refused as that literal is, MalformedDescription.
 */
export const handleTerm = <M extends string>(closed: unknown, member: M): ScalarTerm<M, "enum"> => {
	const { roster } = closedIdParts(closed)
	const checked = typedLiteral(`${roster.closed}.handle`, admittedClosedId(closed), member)
	return scalarTerm(checked.expr, checked.type, { column: handleColumn<M>([member]), sql: "enum" })
}

const base = (x: unknown): PlainChecked => {
	const call = new Call("Compute.base")
	const a = call.term(x, "base's operand")
	return call.finishPlain({ kind: "base", arg: a.real }, { kind: "base", arg: a.ph })
}

const cast = (x: unknown, to: unknown): Checked => {
	const call = new Call("Compute.cast")
	const a = call.term(x, "cast's operand")
	const field = call.field(to, "the cast's target")
	return call.finish(
		{ kind: "cast", to: field.desc, arg: a.real },
		{ kind: "cast", to: field.desc, arg: a.ph }
	)
}

const not = (p: unknown): PredicateValue => {
	const call = new Call("Compute.not")
	const x = call.predicate(p, "not's operand")
	return call.finishPredicate({ kind: "not", arg: x.real }, { kind: "not", arg: x.ph })
}

const widthBucket = (x: unknown, low: unknown, high: unknown, count: unknown): PlainChecked => {
	const call = new Call("Compute.widthBucket")
	const a = call.term(x, "width_bucket's operand")
	const l = call.term(low, "width_bucket's low bound")
	const h = call.term(high, "width_bucket's high bound")
	const c = call.operand(count, plainType("int4"), "literal")
	return call.finishPlain(
		{ kind: "compute", fn: "widthBucket", args: [a.real, l.real, h.real, c.real] },
		{ kind: "compute", fn: "widthBucket", args: [a.ph, l.ph, h.ph, c.ph] }
	)
}

/**
 * A span's endpoints and its width, over the endpoint descriptor the caller states: it is the span's own endpoint, or
 * the call is refused naming both, since the descriptor carries the column the result is read with.
 */
const spanPart =
	(fn: "lower" | "upper" | "width") =>
	(s: unknown, endpoint: unknown, ...extra: ReadonlyArray<unknown>): PlainChecked => {
		const call = new Call(`Compute.${fn}`)
		if (extra.length > 0) {
			return malformed(call.loc, `${fn}(span, endpoint)`)
		}
		const x = call.term(s, `${fn}'s span`)
		const field = call.field(endpoint, `${fn}'s endpoint`)
		const span = spanOf(x.type)
		if (span !== undefined && !compatible(span.endpoint, field.scalar)) {
			return malformed(
				call.loc,
				`the span's own endpoint descriptor: ${typeLabel(field.scalar)} is no endpoint of ${typeLabel(x.type)}`
			)
		}
		return call.finishPlain(
			{ kind: "compute", fn, args: [x.real] },
			{ kind: "compute", fn, args: [x.ph] }
		)
	}

/** Each member checked once: what it records and the type it has, or a predicate. */
const checks = Object.freeze({
	literal,
	base,
	cast,
	add: binary("add", "literal"),
	sub: binary("sub", "literal"),
	mul: binary("mul", "literal"),
	div: binary("div", "literal"),
	mod: binary("mod", "literal"),
	neg: unary("neg"),
	quot: binary("quot", "literal"),
	rem: binary("rem", "literal"),
	abs: unary("abs"),
	sign: unary("sign"),
	round: scaled("round"),
	trunc: scaled("trunc"),
	ceil: unary("ceil"),
	floor: unary("floor"),
	gcd: binary("gcd", "term"),
	lcm: binary("lcm", "term"),
	power: binary("power", "literal"),
	sqrt: unary("sqrt"),
	least: variadic("least"),
	greatest: variadic("greatest"),
	widthBucket,
	scale: unary("scale"),
	minScale: unary("minScale"),
	trimScale: unary("trimScale"),
	cond,
	lower: spanPart("lower"),
	upper: spanPart("upper"),
	width: spanPart("width"),
	charLength: unary("charLength"),
	cosineDistance: binary("cosineDistance", "literal")
})

/** The predicates, the same for a typed and a JavaScript caller. */
const predicates = Object.freeze({
	not,
	and: boolean("and"),
	or: boolean("or"),
	eq: comparison("eq"),
	ne: comparison("ne"),
	lt: comparison("lt"),
	le: comparison("le"),
	gt: comparison("gt"),
	ge: comparison("ge"),
	between,
	in: inList
})

/** A plain result: the plain column of its SQL type. */
const plain = <S extends PlainSql>(checked: Checked, sql: S): ScalarTerm<PlainHost[S], S> =>
	scalarTerm(checked.expr, checked.type, { column: plainColumns[sql], sql })

/** A result carried by the operand or descriptor whose value it is. */
const carried = <T, S extends SqlTag>(
	checked: Checked,
	carrier: TermCarrier<T, S>
): ScalarTerm<T, S> =>
	scalarTerm(checked.expr, checked.type, { column: carrier.column, sql: carrier.sql })

/** What a typed builder reads of an operand: its SQL type. */
interface OfSql<S extends SqlTag> {
	readonly sql: S
}

/**
 * The Compute catalogue's builders.
 *
 * Every Compute member is a pure, synchronous builder that records an expression and returns a term or a predicate
 * (callbacks build descriptions, they never run per row). A builder types the term it builds with the same
 * overload resolution the checker uses (lower.ts, in its "build" mode): it needs the result type to type the literal
 * operands the term meets later, and a builder diagnoses a malformed declaration synchronously. A
 * mistake the TypeScript signatures already forbid, such as a contract meeting its bare base or a JavaScript number as
 * a numeric literal, throws CompileError MalformedDescription from a JavaScript caller; an operation PostgreSQL does
 * not define over the operand types, such as % over double precision, throws UnsupportedOperation with the missing
 * capability. The ContractLiteral check, and the refusal of charLength in a query, are compilation's.
 *
 * Literal operands are recorded as the host value of the base of the term they meet (scalar/registry.ts literalDescFor), so a
 * JavaScript number is refused where a numeric literal is required and an exact decimal string is parsed
 * at construction. A parameter is a term of its descriptor's type, recorded by name: the checker types it from the term
 * it meets, so it never stands first.
 *
 * Each member is checked once (`checks`), and its term is carried by a column: the column of the operand or descriptor
 * whose value it returns (LEAST, GREATEST, a conditional, a cast, a literal, a span's endpoints), or the plain column of
 * its result's SQL type (tables.ts). The typed builders (`compute`), which public/compute.ts binds to the public
 * signature, read that SQL type off their operand's `sql`, so the column's host type is the result's by construction; the
 * untyped cores (`computeCore`), which take what a JavaScript caller may pass, read it off the checked result's carrier.
 *
 * The typed builders, one per Compute member, which public/compute.ts binds to the public signature ComputeApi: each
 * types its result by the carrier of the operand or descriptor whose value it returns, or by the result table keyed by
 * its operand's SQL type (tables.ts), so its column delivers the result's host type by construction.
 */
export const compute = Object.freeze({
	...predicates,
	literal: <T, S extends SqlTag>(type: TermCarrier<T, S>, value: unknown): ScalarTerm<T, S> =>
		carried(checks.literal(type, value), type),
	base: <S extends PlainSql>(x: OfSql<S>): ScalarTerm<PlainHost[S], S> =>
		plain(checks.base(x), x.sql),
	cast: <T, S extends SqlTag>(x: unknown, to: TermCarrier<T, S>): ScalarTerm<T, S> =>
		carried(checks.cast(x, to), to),
	add: <S extends NumericSql>(a: OfSql<S>, b: unknown) => plain(checks.add(a, b), a.sql),
	sub: <S extends NumericSql>(a: OfSql<S>, b: unknown) => plain(checks.sub(a, b), a.sql),
	mul: <S extends SignedSql>(a: OfSql<S>, b: unknown) => plain(checks.mul(a, b), a.sql),
	div: <S extends NumericSql>(a: OfSql<S>, b: unknown) =>
		plain(checks.div(a, b), quotientSql[a.sql]),
	mod: <S extends IntegralSql>(a: OfSql<S>, b: unknown) => plain(checks.mod(a, b), a.sql),
	neg: <S extends SignedSql>(a: OfSql<S>) => plain(checks.neg(a), a.sql),
	quot: (a: unknown, b: unknown) => plain(checks.quot(a, b), "numeric"),
	rem: (a: unknown, b: unknown) => plain(checks.rem(a, b), "numeric"),
	abs: <S extends SignedSql>(a: OfSql<S>) => plain(checks.abs(a), a.sql),
	sign: <S extends SignedSql>(a: OfSql<S>) => plain(checks.sign(a), a.sql),
	round: (a: unknown, ...scale: ReadonlyArray<unknown>) =>
		plain(checks.round(a, ...scale), "numeric"),
	trunc: (a: unknown, ...scale: ReadonlyArray<unknown>) =>
		plain(checks.trunc(a, ...scale), "numeric"),
	ceil: (a: unknown) => plain(checks.ceil(a), "numeric"),
	floor: (a: unknown) => plain(checks.floor(a), "numeric"),
	gcd: <S extends IntegralSql>(a: OfSql<S>, b: unknown) => plain(checks.gcd(a, b), a.sql),
	lcm: <S extends IntegralSql>(a: OfSql<S>, b: unknown) => plain(checks.lcm(a, b), a.sql),
	power: <S extends PowerSql>(a: OfSql<S>, b: unknown) => plain(checks.power(a, b), a.sql),
	sqrt: <S extends PowerSql>(a: OfSql<S>) => plain(checks.sqrt(a), a.sql),
	least: <T, S extends SqlTag>(
		first: TermCarrier<T, S>,
		...rest: ReadonlyArray<unknown>
	): ScalarTerm<T, S> => carried(checks.least(first, ...rest), first),
	greatest: <T, S extends SqlTag>(
		first: TermCarrier<T, S>,
		...rest: ReadonlyArray<unknown>
	): ScalarTerm<T, S> => carried(checks.greatest(first, ...rest), first),
	widthBucket: (x: unknown, low: unknown, high: unknown, count: unknown) =>
		plain(checks.widthBucket(x, low, high, count), "integer"),
	scale: (a: unknown) => plain(checks.scale(a), "integer"),
	minScale: (a: unknown) => plain(checks.minScale(a), "integer"),
	trimScale: (a: unknown) => plain(checks.trimScale(a), "numeric"),
	cond: <T, S extends SqlTag>(
		p: unknown,
		then: TermCarrier<T, S>,
		otherwise: unknown
	): ScalarTerm<T, S> => carried(checks.cond(p, then, otherwise), then),
	lower: <T, S extends EndpointSql>(s: unknown, endpoint: TermCarrier<T, S>): ScalarTerm<T, S> =>
		carried(checks.lower(s, endpoint), endpoint),
	upper: <T, S extends EndpointSql>(s: unknown, endpoint: TermCarrier<T, S>): ScalarTerm<T, S> =>
		carried(checks.upper(s, endpoint), endpoint),
	width: <S extends EndpointSql>(s: unknown, endpoint: OfSql<S>) =>
		plain(checks.width(s, endpoint), endpoint.sql),
	charLength: (s: unknown) => plain(checks.charLength(s), "integer"),
	cosineDistance: (a: unknown, b: unknown) => plain(checks.cosineDistance(a, b), "double precision")
})

/** A JavaScript caller's plain result: the plain column of the checked result's SQL type. */
const plainBy = (checked: PlainChecked): ScalarTerm => {
	const carrier: TermCarrier = { column: plainColumns[checked.sql], sql: checked.sql }
	return scalarTerm(checked.expr, checked.type, carrier)
}

/** A JavaScript caller's descriptor's carrier, which the checks admitted as a descriptor. */
const fieldCarrier = (value: unknown): TermCarrier =>
	describedField(value, SourceLoc("a checked descriptor", [])).carrier

/**
 * The admission cores, one per Compute member: each takes what a JavaScript caller may pass, refuses a malformed operand
 * with CompileError, and returns the term or predicate it records. A test of what a JavaScript caller passes calls a
 * core directly.
 */
export const computeCore = Object.freeze({
	...predicates,
	literal: (type: unknown, value: unknown): ScalarTerm => {
		const checked = checks.literal(type, value)
		return scalarTerm(checked.expr, checked.type, fieldCarrier(type))
	},
	base: (x: unknown) => plainBy(checks.base(x)),
	cast: (x: unknown, to: unknown): ScalarTerm => {
		const checked = checks.cast(x, to)
		return scalarTerm(checked.expr, checked.type, fieldCarrier(to))
	},
	add: (a: unknown, b: unknown) => plainBy(checks.add(a, b)),
	sub: (a: unknown, b: unknown) => plainBy(checks.sub(a, b)),
	mul: (a: unknown, b: unknown) => plainBy(checks.mul(a, b)),
	div: (a: unknown, b: unknown) => plainBy(checks.div(a, b)),
	mod: (a: unknown, b: unknown) => plainBy(checks.mod(a, b)),
	neg: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.neg(a, ...extra)),
	quot: (a: unknown, b: unknown) => plainBy(checks.quot(a, b)),
	rem: (a: unknown, b: unknown) => plainBy(checks.rem(a, b)),
	abs: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.abs(a, ...extra)),
	sign: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.sign(a, ...extra)),
	round: (a: unknown, ...scale: ReadonlyArray<unknown>) => plainBy(checks.round(a, ...scale)),
	trunc: (a: unknown, ...scale: ReadonlyArray<unknown>) => plainBy(checks.trunc(a, ...scale)),
	ceil: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.ceil(a, ...extra)),
	floor: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.floor(a, ...extra)),
	gcd: (a: unknown, b: unknown) => plainBy(checks.gcd(a, b)),
	lcm: (a: unknown, b: unknown) => plainBy(checks.lcm(a, b)),
	power: (a: unknown, b: unknown) => plainBy(checks.power(a, b)),
	sqrt: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.sqrt(a, ...extra)),
	least: (...xs: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.least(...xs)
		return scalarTerm(checked.expr, checked.type, checked.carrier)
	},
	greatest: (...xs: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.greatest(...xs)
		return scalarTerm(checked.expr, checked.type, checked.carrier)
	},
	widthBucket: (x: unknown, low: unknown, high: unknown, count: unknown) =>
		plainBy(checks.widthBucket(x, low, high, count)),
	scale: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.scale(a, ...extra)),
	minScale: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.minScale(a, ...extra)),
	trimScale: (a: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.trimScale(a, ...extra)),
	cond: (p: unknown, then: unknown, otherwise: unknown): ScalarTerm => {
		const checked = checks.cond(p, then, otherwise)
		return scalarTerm(checked.expr, checked.type, checked.carrier)
	},
	lower: (s: unknown, endpoint: unknown, ...extra: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.lower(s, endpoint, ...extra)
		return scalarTerm(checked.expr, checked.type, fieldCarrier(endpoint))
	},
	upper: (s: unknown, endpoint: unknown, ...extra: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.upper(s, endpoint, ...extra)
		return scalarTerm(checked.expr, checked.type, fieldCarrier(endpoint))
	},
	width: (s: unknown, endpoint: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.width(s, endpoint, ...extra)),
	charLength: (s: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.charLength(s, ...extra)),
	cosineDistance: (a: unknown, b: unknown) => plainBy(checks.cosineDistance(a, b))
})
