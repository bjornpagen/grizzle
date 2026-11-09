import { nominal } from "#compiler/core/brand.ts"
import { bitsColumn, codeColumn } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { defined } from "#compiler/core/invariant.ts"
import { captureLoc, childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import {
	booleanField,
	type CompareOp,
	type ComputeFn,
	connectiveExpr,
	decodeDesc,
	type ExprDesc,
	type FieldDesc,
	type LiteralDesc,
	type ScaledComputeFn
} from "#compiler/ir/desc.ts"
import type { LiteralExpr, OpenExpr } from "#compiler/ir/open.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { baseOf, rosterOf, type ScalarType, spanOf, typeLabel } from "#compiler/ir/scalar.ts"
import { admittedClosedId, closedIdParts } from "#compiler/scalar/closed-id.ts"
import {
	exprEmitter,
	type LowerEnv,
	type Lowered,
	lowerPredicate,
	adoptedType,
	lowerTerm,
	noClosedRelations,
	noParams,
	withinGuards
} from "#compiler/scalar/compute/lower.ts"

import {
	arithmeticSql,
	divisorSql,
	type EndpointSql,
	type IntegralSql,
	type NumericSql,
	type PlainHost,
	type PlainSql,
	type PowerSql,
	plainColumns,
	quotientSql,
	remainderSql,
	type SignedSql,
	spanWidthSql
} from "#compiler/scalar/compute/tables.ts"

import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import {
	type GuardTest,
	type GuardValue,
	guarded,
	guardOf,
	headOf,
	headOnlyOperand,
	type PredicateValue,
	predicateExpr,
	predicateValue,
	registerGuard,
	registerTerm,
	type ScalarTerm,
	type TermCarrier,
	termOf,
	typedTermOf
} from "#compiler/scalar/compute/term.ts"
import { compatible, isFloat, plainType } from "#compiler/scalar/compute/types.ts"
import { admitMatch, matchRefusalAt } from "#compiler/scalar/regex/admit.ts"
import { Pattern } from "#compiler/scalar/regex/pattern.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { replaceMap } from "#compiler/scalar/regex/whitespace.ts"
import {
	carrierSql,
	describeField,
	isDescriptorCopy,
	isOwnedDescriptor,
	literalDescFor,
	type SqlTag
} from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"
import { Money } from "#compiler/scalar/values/money.ts"

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
		(hasProperties(value) && value["sql"] === "text" && hasProperties(value["patterns"]))
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
		() =>
			malformedDescription(
				loc,
				"a field descriptor whose properties can be read: no refusing proxy"
			),
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

declare const checkedBrand: unique symbol

/**
 * A checked Compute expression: what it records, and the type the overload resolution gave it. Minted only by Call's
 * constructors, one per level of what a builder returns (finish, finishCarried, finishPlain), each after the build-mode
 * lowering typed the call, so no builder states a type it did not check.
 */
type Checked = {
	readonly expr: OpenExpr
	readonly type: ScalarType
	readonly [checkedBrand]: true
}

const mintChecked = nominal<{ readonly expr: OpenExpr; readonly type: ScalarType }, Checked>()

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
	/** The field descriptors the call met, with their types; a connective's unit is typed by booleanField. */
	readonly fields = new Map<FieldDesc, ScalarType>([[booleanField, plainType("bool")]])
	/** The admitted patterns the call's typing reads (scalar/regex/patterns.ts): the call is the term's admission. */
	readonly patterns = new CompilePatterns()

	constructor(label: string) {
		this.loc = captureLoc(label, [])
	}

	placeholder(type: ScalarType): ExprDesc {
		this.types.push(type)
		return { kind: "var", var: `#${this.types.length - 1}` }
	}

	/** A term, which stands first, a parameter among them: never a literal, which takes the type of the term it meets. */
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
			const head = headOf(value)
			if (head !== undefined) {
				return malformed(this.loc, headOnlyOperand(`a term as ${what}`, head.desc))
			}
			return malformed(this.loc, `a term as ${what}: a literal never stands first`)
		}
		return {
			real: term.expr,
			ph: this.placeholder(term.type),
			type: term.type,
			carrier: term.carrier
		}
	}

	/** A predicate, or a boolean term, a parameter among them, which is a predicate here. */
	predicate(value: unknown, what: string): { readonly real: OpenExpr; readonly ph: ExprDesc } {
		const expr = predicateExpr(value)
		if (expr !== undefined) {
			return { real: expr, ph: this.placeholder(plainType("bool")) }
		}
		const term = termOf(value)
		if (term?.typing.kind === "typed") {
			return { real: term.expr, ph: this.placeholder(term.typing.type) }
		}
		return malformed(this.loc, `a predicate as ${what}`)
	}

	/**
	 * A literal operand opposite a term of `anchor`, checked here at the type the lowering gives it (adoptedType, as an
	 * operand, the more permissive role), since its placeholder, not the literal, is what the builder's lowering meets:
	 * a value no role admits is refused when the term is built. A contract's predicate and a regex stay compilation's.
	 */
	literal(value: unknown, anchor: ScalarType): LiteralDesc {
		const literal = literalDescFor(anchor, value)
		if (!literal.ok) {
			return malformed(this.loc, describeFault(literal.error))
		}
		const carried = irLiteral(literal.value, adoptedType(anchor, "operand"))
		if (!carried.ok) {
			return malformed(this.loc, carried.error)
		}
		return literal.value
	}

	/**
	 * An operand opposite a term of `anchor`: a term, a parameter among them, or, where `literals` admits one, a literal
	 * of anchor's base. A literal takes the type of the term it meets, so its placeholder is a value of `anchor`, and no
	 * operand is typed on its own: a conditional, least and greatest are their first operand's type.
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
		return { real: literal, ph: this.placeholder(anchor) }
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
			closed: noClosedRelations(
				"a builder types its term over its operands, which hold any closed read already typed"
			),
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
			params: noParams,
			fieldType: (desc) => {
				const type = this.fields.get(desc)
				return type === undefined
					? Result.err(malformedDescription(this.loc, "a field descriptor"))
					: Result.ok(type)
			},
			patterns: this.patterns
		}
	}

	/** The call checked: `real` typed by the build-mode lowering of its placeholder `ph`. */
	finish(real: OpenExpr, ph: ExprDesc): Checked {
		const typed: Result.Result<Lowered, CompileError> = lowerTerm(ph, this.env())
		if (!typed.ok) {
			throw typed.error
		}
		return mintChecked({ expr: real, type: typed.value.nominal })
	}

	/** finish of an expression whose value is its first term's, delivered through that term's carrier. */
	finishCarried(real: OpenExpr, ph: ExprDesc, carrier: TermCarrier): CarriedChecked {
		return { ...this.finish(real, ph), carrier }
	}

	/**
	 * finish of an expression whose value is plain: a closed id's, a set's, a span's, a vector's and bytes' values are no
	 * plain value.
	 */
	finishPlain(real: OpenExpr, ph: ExprDesc): PlainChecked {
		const checked = this.finish(real, ph)
		const carrier = baseOf(checked.type).carrier
		if (
			carrier === "code" ||
			carrier === "bits" ||
			carrier === "range4" ||
			carrier === "range8" ||
			carrier === "rangeDate" ||
			carrier === "vector" ||
			carrier === "bytes"
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
	if (!isList(values)) {
		return malformed(call.loc, "a finite list of literals")
	}
	const list: ReadonlyArray<unknown> = values
	const literals: ReadonlyArray<LiteralDesc> = list.map((v) => call.literal(v, x.type))
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
	(a: unknown, extra: ReadonlyArray<unknown>): PlainChecked => {
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
	(a: unknown, scale: ReadonlyArray<unknown>): PlainChecked => {
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
	(xs: ReadonlyArray<unknown>): CarriedChecked => {
		if (xs.length === 0) {
			return malformed(captureLoc(`Compute.${fn}`, []), `at least one term for ${fn}`)
		}
		const { call, real, ph, carrier } = computeCall(fn, "term", xs)
		return call.finishCarried(real, ph, carrier)
	}

/**
 * A set's union, intersection or difference with another set over its roster: the first operand's value, so its
 * carrier's. The second is a term or a parameter of the first's type, or a set value over its roster (Bits.of), a
 * literal that takes the first operand's type, as a comparison's does.
 */
const setOperation =
	(fn: "union" | "intersection" | "difference") =>
	(a: unknown, b: unknown, extra: ReadonlyArray<unknown>): CarriedChecked => {
		if (extra.length > 0) {
			return malformed(captureLoc(`Compute.${fn}`, []), `two sets for ${fn}`)
		}
		const { call, real, ph, carrier } = computeCall(fn, "literal", [a, b])
		return call.finishCarried(real, ph, carrier)
	}

/** A checked Compute expression whose value is a set over a roster, with the roster's declared name. */
interface SetChecked extends Checked {
	readonly roster: string
}

/**
 * Compute.singleton: the set over a closed id's roster holding exactly its handle. Its value is no operand's, so it is
 * carried by the column of a set over that roster, which its checked type names.
 */
const singleton = (id: unknown, extra: ReadonlyArray<unknown>): SetChecked => {
	const call = new Call("Compute.singleton")
	if (extra.length > 0) {
		return malformed(call.loc, "one closed id for singleton")
	}
	const x = call.term(id, "singleton's operand")
	const checked = call.finish(
		{ kind: "compute", fn: "singleton", args: [x.real] },
		{ kind: "compute", fn: "singleton", args: [x.ph] }
	)
	const roster = defined(rosterOf(checked.type), "Compute.singleton is typed a set over a roster")
	return { ...checked, roster: roster.closed }
}

/** Compute.and and Compute.or, total: of no predicate the constant true and false, of one that predicate. */
const boolean =
	(kind: "and" | "or") =>
	(ps: ReadonlyArray<unknown>): PredicateValue => {
		const call = new Call(`Compute.${kind}`)
		const operands = ps.map((p, i) => call.predicate(p, `${kind}'s operand ${i + 1}`))
		return call.finishPredicate(
			connectiveExpr(
				kind,
				operands.map((p) => p.real)
			),
			connectiveExpr(
				kind,
				operands.map((p) => p.ph)
			)
		)
	}

/**
 * A conditional: its first branch is a term, a parameter among them, never a literal; the other is a term that meets
 * it or a literal of its type. Their common type carries the first branch's carrier: two branches that meet share a
 * carrier, but for an exact value beside a plain value of its family, which the lowering refuses (lower.ts
 * exactBeside), so the conditional's column is the first branch's.
 */
const cond = (p: unknown, then: unknown, otherwise: unknown): CarriedChecked => {
	const call = new Call("Compute.cond")
	const pred = call.predicate(p, "cond's condition")
	const t = call.term(then, "cond's first branch")
	const e = call.operand(otherwise, t.type, "literal")
	return call.finishCarried(
		{ kind: "cond", pred: pred.real, onTrue: t.real, onFalse: e.real },
		{ kind: "cond", pred: pred.ph, onTrue: t.ph, onFalse: e.ph },
		t.carrier
	)
}

/** Zero as the host value of a subject's type, which a guard compares it with. */
const zeroOf = (t: ScalarType): unknown => {
	switch (baseOf(t).carrier) {
		case "int8":
		case "exactInteger":
			return 0n
		case "numeric":
			return Decimal.zero
		case "money":
		case "exactMoney":
			return Money.zero
		case "int2":
		case "int4":
		case "float4":
		case "float8":
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
			return 0
	}
}

/** An infinity as the host value of a numeric or float subject's type, -1 for the negative one. */
const infinityOf = (t: ScalarType, sign: 1 | -1): unknown =>
	baseOf(t).carrier === "numeric"
		? sign > 0
			? Decimal.infinity
			: Decimal.negativeInfinity
		: sign > 0
			? Number.POSITIVE_INFINITY
			: Number.NEGATIVE_INFINITY

/** A guard builder's name, as its diagnostics spell it. */
const guardNames = {
	nonzero: "Compute.nonzero",
	nonnegative: "Compute.nonnegative",
	positive: "Compute.positive",
	finite: "Compute.isFinite"
} as const

/**
 * What a guard builder records: its test, the guard Compute.when reads, its subject term, and the subject's expression,
 * type and carrier, from which the term its branch receives is made.
 */
interface GuardParts {
	readonly expr: OpenExpr
	readonly guardTest: GuardTest
	readonly subject: object
	readonly real: OpenExpr
	readonly type: ScalarType
	readonly carrier: TermCarrier
}

/**
 * A guard over one subject term: the predicate it tests of the subject's value (`<> 0`, `>= 0`, `> 0`, `> -Infinity
 * AND < Infinity`), usable wherever a predicate is, and the guard Compute.when reads to refine the subject inside its
 * branch. The comparison reads Compute.base(subject), so its constant is a value of the subject's value type, never
 * of its contract: a guard tests any value its subject's SQL type holds, and a contract need hold no zero, and a
 * numeric typmod no infinity.
 */
const factGuard =
	(kind: "nonzero" | "nonnegative" | "positive" | "finite") =>
	(subject: unknown): GuardParts => {
		const call = new Call(guardNames[kind])
		const s = call.term(subject, `${guardNames[kind]}'s subject`)
		if (!hasProperties(subject)) {
			return malformed(call.loc, "a term as a guard's subject")
		}
		if (kind === "finite" && baseOf(s.type).carrier !== "numeric" && !isFloat(s.type)) {
			return malformed(
				call.loc,
				`Compute.isFinite over a numeric or float term, not ${typeLabel(s.type)}, which is finite by its type`
			)
		}
		const value: OpenExpr = { kind: "base", arg: s.real }
		const valuePh: ExprDesc = { kind: "base", arg: s.ph }
		const literal = (constant: unknown): LiteralExpr => ({
			kind: "literal",
			value: call.literal(constant, s.type),
			type: undefined
		})
		const comparisons = (): ReadonlyArray<readonly [CompareOp, LiteralExpr]> => {
			switch (kind) {
				case "nonzero":
					return [["ne", literal(zeroOf(s.type))]]
				case "nonnegative":
					return [["ge", literal(zeroOf(s.type))]]
				case "positive":
					return [["gt", literal(zeroOf(s.type))]]
				case "finite":
					return [
						["gt", literal(infinityOf(s.type, -1))],
						["lt", literal(infinityOf(s.type, 1))]
					]
			}
		}
		const atoms = comparisons()
		const real: ReadonlyArray<OpenExpr> = atoms.map(([op, right]) => ({
			kind: "compare",
			op,
			left: value,
			right
		}))
		const ph: ReadonlyArray<ExprDesc> = atoms.map(([op, right]) => ({
			kind: "compare",
			op,
			left: valuePh,
			right
		}))
		const realTest = connectiveExpr("and", real)
		const phTest = connectiveExpr("and", ph)
		call.finishPredicate(realTest, phTest)
		return {
			expr: realTest,
			guardTest: { kind: "refines", guard: { kind } },
			subject,
			real: s.real,
			type: s.type,
			carrier: s.carrier
		}
	}

/** A guard that its subject lies within two literal bounds: `BETWEEN low AND high`, and so finite. */
const within = (subject: unknown, low: unknown, high: unknown): GuardParts => {
	const call = new Call("Compute.within")
	const s = call.term(subject, "Compute.within's subject")
	if (!hasProperties(subject)) {
		return malformed(call.loc, "a term as a guard's subject")
	}
	if (!withinGuards(baseOf(s.type).carrier)) {
		return malformed(call.loc, `Compute.within over a number, not ${typeLabel(s.type)}`)
	}
	const lo = call.literal(low, s.type)
	const hi = call.literal(high, s.type)
	const lowLit: LiteralExpr = { kind: "literal", value: lo, type: undefined }
	const highLit: LiteralExpr = { kind: "literal", value: hi, type: undefined }
	const real: OpenExpr = { kind: "between", arg: s.real, low: lowLit, high: highLit }
	const ph: ExprDesc = { kind: "between", arg: s.ph, low: lowLit, high: highLit }
	call.finishPredicate(real, ph)
	return {
		expr: real,
		guardTest: { kind: "refines", guard: { kind: "within", low: lo, high: hi } },
		subject,
		real: s.real,
		type: s.type,
		carrier: s.carrier
	}
}

/**
 * Compute.pattern(source): a Compute.matches pattern, `source` in grizzle's pattern grammar under the flags "u",
 * admitted here, once (scalar/regex/admit.ts admitMatch), so a source outside the grammar or PostgreSQL's regex compile
 * space, or one no text matches, is refused where it is written, and every match over the pattern reads its admission.
 */
const admittedPattern = <S extends string>(source: S): Pattern<S> => {
	refuseNonString(source)
	const admission = admitMatch(source)
	if (admission.kind === "refused") {
		throw matchRefusalAt(admission, captureLoc("Compute.pattern", []))
	}
	return Pattern.admitted(admission)
}

/** A JavaScript caller's Compute.pattern source the types forbid: a malformed argument, thrown synchronously. */
const refuseNonString = (source: unknown): void => {
	if (typeof source !== "string") {
		malformed(captureLoc("Compute.pattern", []), "a pattern source string")
	}
}

/**
 * Compute.matches(subject, pattern): whether the text subject holds a match of the pattern, a predicate and a guard.
 * The pattern is a Pattern, admitted where it was made (scalar/regex/pattern.ts), whose source the description holds as
 * a literal, so inside Compute.when's branch its subject is text of the pattern's language; or a text term, whose every
 * value is admitted where the term is compiled (compute/lower.ts patternAdmissions), and whose values hold no one
 * language, so its branch knows nothing more of the subject. A string is no pattern: Compute.pattern(source) makes one.
 */
const matches = (subject: unknown, pattern: unknown): GuardParts => {
	const call = new Call("Compute.matches")
	const s = call.term(subject, "matches's subject")
	if (!hasProperties(subject)) {
		return malformed(call.loc, "a term as matches's subject")
	}
	if (typeof pattern === "string") {
		return malformed(
			call.loc,
			"a Pattern as matches's pattern, Compute.pattern(source), or a text term: a string is no pattern"
		)
	}
	const read: {
		readonly operand: { readonly real: OpenExpr; readonly ph: ExprDesc }
		readonly test: GuardTest
	} = Pattern.is(pattern)
		? {
				operand: call.operand(pattern.source, s.type, "literal"),
				test: { kind: "refines", guard: { kind: "matches", pattern: pattern.source } }
			}
		: { operand: call.operand(pattern, s.type, "term"), test: { kind: "tests" } }
	const real: OpenExpr = { kind: "compute", fn: "matches", args: [s.real, read.operand.real] }
	call.finishPredicate(real, { kind: "compute", fn: "matches", args: [s.ph, read.operand.ph] })
	return {
		expr: real,
		guardTest: read.test,
		subject,
		real: s.real,
		type: s.type,
		carrier: s.carrier
	}
}

/**
 * A translation of the text term `x` by the map from and to state: both stand in the description as literals, so the
 * builder's own typing of the term (compute/lower.ts translate) sees the map and refuses one it does not admit
 * (scalar/regex/translate.ts charMapOf) where the call is written, as compilation does again.
 */
const translation = (
	call: Call,
	what: string,
	x: unknown,
	from: string,
	to: string
): PlainChecked => {
	const s = call.term(x, what)
	const f: LiteralExpr = { kind: "literal", value: from, type: undefined }
	const t: LiteralExpr = { kind: "literal", value: to, type: undefined }
	return call.finishPlain(
		{ kind: "compute", fn: "translate", args: [s.real, f, t] },
		{ kind: "compute", fn: "translate", args: [s.ph, f, t] }
	)
}

/**
 * Compute.translate(x, from, to): a text term with each character of from replaced by the character of to at its
 * position, from and to strings of one length, from holding each character once.
 */
const translate = (
	x: unknown,
	from: unknown,
	to: unknown,
	extra: ReadonlyArray<unknown>
): PlainChecked => {
	const call = new Call("Compute.translate")
	if (extra.length > 0) {
		return malformed(call.loc, "three operands for translate: a text term, from and to")
	}
	if (typeof from !== "string" || typeof to !== "string") {
		return malformed(
			call.loc,
			"strings as translate's from and to, which state its map where the call is written"
		)
	}
	return translation(call, "translate's subject", x, from, to)
}

/** The ASCII capital letters and their small letters, position for position: lowerAscii's map. */
const asciiCapitals = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const asciiSmalls = "abcdefghijklmnopqrstuvwxyz"

/**
 * Compute.lowerAscii(x): translate over the ASCII capitals and their small letters, so every other character, a
 * non-ASCII letter included, stays as it is.
 */
const lowerAscii = (x: unknown, extra: ReadonlyArray<unknown>): PlainChecked => {
	const call = new Call("Compute.lowerAscii")
	if (extra.length > 0) {
		return malformed(call.loc, "one operand for lowerAscii: a text term")
	}
	return translation(call, "lowerAscii's subject", x, asciiCapitals, asciiSmalls)
}

/**
 * Compute.replaceWhitespace(x): XML Schema's whiteSpace replace, translate of tab, LF and CR each to a space
 * (scalar/regex/whitespace.ts replaceMap).
 */
const replaceWhitespace = (x: unknown, extra: ReadonlyArray<unknown>): PlainChecked => {
	const call = new Call("Compute.replaceWhitespace")
	if (extra.length > 0) {
		return malformed(call.loc, "one operand for replaceWhitespace: a text term")
	}
	return translation(call, "replaceWhitespace's subject", x, replaceMap.from, replaceMap.to)
}

/**
 * A guard's predicate value, registered with its guard and its subject term, holding under `guarded` the term its
 * Compute.when branch receives: the subject's expression, carried by `carrier`, which a guard refines inside the branch.
 */
const guardValue = <T, S extends SqlTag>(
	parts: GuardParts,
	carrier: TermCarrier<T, S>
): GuardValue<ScalarTerm<T, S>> =>
	registerGuard(
		Object.freeze({
			...builtMark,
			predicate: true,
			expr: parts.expr,
			[guarded]: scalarTerm(parts.real, parts.type, carrier)
		}),
		parts.expr,
		parts.guardTest,
		parts.subject
	)

const guardRequired =
	"a guard a Compute guard builder made: Compute.nonzero, Compute.nonnegative, Compute.positive, Compute.isFinite, Compute.within or Compute.matches of a literal pattern"

/**
 * Compute.when: the one guard of a partial operation, over the branch its function of the guard's subject built from
 * the term the guard refines; CASE WHEN <guard> THEN <branch> ELSE <otherwise> END, so the branch is computed only where
 * the guard holds, and the other branch is the caller's value for the rest.
 */
const when = (guard: unknown, branch: unknown, otherwise: unknown): CarriedChecked => {
	const call = new Call("Compute.when")
	const g = guardOf(guard)
	if (g === undefined) {
		return malformed(call.loc, guardRequired)
	}
	if (g.guardTest.kind === "tests") {
		return cond(guard, branch, otherwise)
	}
	const s = call.term(g.subject, "when's subject")
	const t = call.term(branch, "when's branch, which types the conditional")
	const e = call.operand(otherwise, t.type, "literal")
	return call.finishCarried(
		{ kind: "when", guard: g.guardTest.guard, subject: s.real, proved: t.real, otherwise: e.real },
		{ kind: "when", guard: g.guardTest.guard, subject: s.ph, proved: t.ph, otherwise: e.ph },
		t.carrier
	)
}

/** A literal of a descriptor's type, built by `call`: the value is checked as a value of that type. */
const typedLiteral = (call: Call, field: DescribedField, value: unknown): Checked => {
	const t = field.scalar
	const desc: LiteralExpr = { kind: "literal", value: call.literal(value, t), type: field.desc }
	return call.finish(desc, desc)
}

/**
 * Compute.literal(F, x): x at F's type. A roster's descriptor is refused, MalformedDescription: a member of roster X is
 * X.handle(member), the one typed constant of a member, whose column delivers the member.
 */
const literal = (type: unknown, value: unknown): Checked => {
	const call = new Call("Compute.literal")
	const field = call.field(type, "the literal's type")
	if (field.desc.kind === "closedId") {
		return malformed(
			call.loc,
			`a descriptor that is no roster's: a member of roster ${field.desc.roster} is ${field.desc.roster}.handle(member)`
		)
	}
	return typedLiteral(call, field, value)
}

/**
 * X.handle(member): the member's literal at X's closed id, whose column is that one handle. A member off the roster, or
 * anything but a string from a JavaScript caller, is refused, MalformedDescription.
 */
export const handleTerm = <M extends string>(closed: unknown, member: M): ScalarTerm<M, "code"> => {
	const { roster } = closedIdParts(closed)
	const call = new Call(`${roster.closed}.handle`)
	const checked = typedLiteral(
		call,
		call.field(admittedClosedId(closed), "the literal's type"),
		member
	)
	return scalarTerm(checked.expr, checked.type, {
		column: codeColumn<M>(roster.closed, [member]),
		sql: "code"
	})
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
	(s: unknown, endpoint: unknown, extra: ReadonlyArray<unknown>): PlainChecked => {
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
	minScale: unary("minScale"),
	numeric: unary("numeric"),
	cond,
	when,
	nonzero: factGuard("nonzero"),
	nonnegative: factGuard("nonnegative"),
	positive: factGuard("positive"),
	isFinite: factGuard("finite"),
	within,
	lower: spanPart("lower"),
	upper: spanPart("upper"),
	width: spanPart("width"),
	charLength: unary("charLength"),
	octetLength: unary("octetLength"),
	concat: binary("concat", "literal"),
	startsWith: binary("startsWith", "literal"),
	endsWith: binary("endsWith", "literal"),
	matches,
	translate,
	lowerAscii,
	replaceWhitespace,
	collapse: unary("collapse"),
	parseDouble: unary("parseDouble"),
	parseDecimal: unary("parseDecimal"),
	cosineDistance: binary("cosineDistance", "literal"),
	union: setOperation("union"),
	intersection: setOperation("intersection"),
	difference: setOperation("difference"),
	cardinality: unary("cardinality"),
	subset: binary("subset", "literal"),
	disjoint: binary("disjoint", "literal"),
	singleton
})

/** The predicates, the same for a typed and a JavaScript caller, and's and or's operands as one list. */
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
 * capability. The ContractLiteral check, and the refusal of charLength and octetLength in a query, are compilation's.
 *
 * Literal operands are recorded as the host value of the base of the term they meet (scalar/registry.ts literalDescFor), so a
 * JavaScript number is refused where a numeric literal is required and an exact decimal string is parsed
 * at construction. A parameter is a term of its descriptor's type, recorded by name and descriptor, so it stands
 * wherever a term of that type stands, first included.
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
	add: <S extends NumericSql>(a: OfSql<S>, b: unknown) =>
		plain(checks.add(a, b), arithmeticSql[a.sql]),
	sub: <S extends NumericSql>(a: OfSql<S>, b: unknown) =>
		plain(checks.sub(a, b), arithmeticSql[a.sql]),
	mul: <S extends SignedSql>(a: OfSql<S>, b: unknown) =>
		plain(checks.mul(a, b), arithmeticSql[a.sql]),
	div: <S extends NumericSql>(a: OfSql<S>, b: unknown) =>
		plain(checks.div(a, b), quotientSql[a.sql]),
	mod: <S extends IntegralSql>(a: OfSql<S>, b: unknown) =>
		plain(checks.mod(a, b), remainderSql[a.sql]),
	neg: <S extends SignedSql>(a: OfSql<S>) => plain(checks.neg(a, []), arithmeticSql[a.sql]),
	quot: (a: unknown, b: unknown) => plain(checks.quot(a, b), "numeric"),
	rem: (a: unknown, b: unknown) => plain(checks.rem(a, b), "numeric"),
	abs: <S extends SignedSql>(a: OfSql<S>) => plain(checks.abs(a, []), arithmeticSql[a.sql]),
	sign: <S extends SignedSql>(a: OfSql<S>) => plain(checks.sign(a, []), a.sql),
	round: (a: unknown, ...scale: ReadonlyArray<unknown>) => plain(checks.round(a, scale), "numeric"),
	trunc: (a: unknown, ...scale: ReadonlyArray<unknown>) => plain(checks.trunc(a, scale), "numeric"),
	ceil: (a: unknown) => plain(checks.ceil(a, []), "numeric"),
	floor: (a: unknown) => plain(checks.floor(a, []), "numeric"),
	gcd: <S extends IntegralSql>(a: OfSql<S>, b: unknown) =>
		plain(checks.gcd(a, b), divisorSql[a.sql]),
	lcm: <S extends IntegralSql>(a: OfSql<S>, b: unknown) =>
		plain(checks.lcm(a, b), divisorSql[a.sql]),
	power: <S extends PowerSql>(a: OfSql<S>, b: unknown) => plain(checks.power(a, b), a.sql),
	sqrt: <S extends PowerSql>(a: OfSql<S>) => plain(checks.sqrt(a, []), a.sql),
	least: <T, S extends SqlTag>(
		first: TermCarrier<T, S>,
		rest: ReadonlyArray<unknown>
	): ScalarTerm<T, S> => carried(checks.least([first, ...rest]), first),
	greatest: <T, S extends SqlTag>(
		first: TermCarrier<T, S>,
		rest: ReadonlyArray<unknown>
	): ScalarTerm<T, S> => carried(checks.greatest([first, ...rest]), first),
	widthBucket: (x: unknown, low: unknown, high: unknown, count: unknown) =>
		plain(checks.widthBucket(x, low, high, count), "integer"),
	minScale: (a: unknown) => plain(checks.minScale(a, []), "integer"),
	numeric: (a: unknown) => plain(checks.numeric(a, []), "numeric"),
	cond: <T, S extends SqlTag>(
		p: unknown,
		then: TermCarrier<T, S>,
		otherwise: unknown
	): ScalarTerm<T, S> => carried(checks.cond(p, then, otherwise), then),
	/** The branch is the term the caller's function built from the guard's `guarded` term (public/compute.ts). */
	when: <T, S extends SqlTag>(
		guard: unknown,
		branch: TermCarrier<T, S>,
		otherwise: unknown
	): ScalarTerm<T, S> => carried(checks.when(guard, branch, otherwise), branch),
	nonzero: <T, S extends SqlTag>(x: TermCarrier<T, S>) => guardValue(checks.nonzero(x), x),
	nonnegative: <T, S extends SqlTag>(x: TermCarrier<T, S>) => guardValue(checks.nonnegative(x), x),
	positive: <T, S extends SqlTag>(x: TermCarrier<T, S>) => guardValue(checks.positive(x), x),
	isFinite: <T, S extends SqlTag>(x: TermCarrier<T, S>) => guardValue(checks.isFinite(x), x),
	within: <T, S extends SqlTag>(x: TermCarrier<T, S>, low: unknown, high: unknown) =>
		guardValue(checks.within(x, low, high), x),
	lower: <T, S extends SqlTag>(s: unknown, endpoint: TermCarrier<T, S>): ScalarTerm<T, S> =>
		carried(checks.lower(s, endpoint, []), endpoint),
	upper: <T, S extends SqlTag>(s: unknown, endpoint: TermCarrier<T, S>): ScalarTerm<T, S> =>
		carried(checks.upper(s, endpoint, []), endpoint),
	width: <S extends EndpointSql>(s: unknown, endpoint: OfSql<S>) =>
		plain(checks.width(s, endpoint, []), spanWidthSql[endpoint.sql]),
	charLength: (s: unknown) => plain(checks.charLength(s, []), "integer"),
	octetLength: (s: unknown) => plain(checks.octetLength(s, []), "integer"),
	concat: (a: unknown, b: unknown) => plain(checks.concat(a, b), "text"),
	startsWith: (a: unknown, b: unknown) => plain(checks.startsWith(a, b), "boolean"),
	endsWith: (a: unknown, b: unknown) => plain(checks.endsWith(a, b), "boolean"),
	translate: (x: unknown, from: unknown, to: unknown) =>
		plain(checks.translate(x, from, to, []), "text"),
	lowerAscii: (x: unknown) => plain(checks.lowerAscii(x, []), "text"),
	replaceWhitespace: (x: unknown) => plain(checks.replaceWhitespace(x, []), "text"),
	collapse: (x: unknown) => plain(checks.collapse(x, []), "text"),
	parseDouble: (x: unknown) => plain(checks.parseDouble(x, []), "double precision"),
	parseDecimal: (x: unknown) => plain(checks.parseDecimal(x, []), "numeric"),
	pattern: admittedPattern,
	matches: <T, S extends SqlTag>(subject: TermCarrier<T, S>, pattern: unknown) =>
		guardValue(checks.matches(subject, pattern), subject),
	cosineDistance: (a: unknown, b: unknown) =>
		plain(checks.cosineDistance(a, b), "double precision"),
	union: <T, S extends SqlTag>(a: TermCarrier<T, S>, b: unknown): ScalarTerm<T, S> =>
		carried(checks.union(a, b, []), a),
	intersection: <T, S extends SqlTag>(a: TermCarrier<T, S>, b: unknown): ScalarTerm<T, S> =>
		carried(checks.intersection(a, b, []), a),
	difference: <T, S extends SqlTag>(a: TermCarrier<T, S>, b: unknown): ScalarTerm<T, S> =>
		carried(checks.difference(a, b, []), a),
	cardinality: (a: unknown) => plain(checks.cardinality(a, []), "bigint"),
	subset: (a: unknown, b: unknown) => plain(checks.subset(a, b), "boolean"),
	disjoint: (a: unknown, b: unknown) => plain(checks.disjoint(a, b), "boolean"),
	/** The set's host type T is the public signature's, which its column, a set's over the roster, delivers. */
	singleton: <T>(id: unknown): ScalarTerm<T, "bits"> => {
		const checked = checks.singleton(id, [])
		return scalarTerm(checked.expr, checked.type, {
			column: bitsColumn<T>(checked.roster),
			sql: "bits"
		})
	}
})

/** A JavaScript caller's plain result: the plain column of the checked result's SQL type. */
const plainBy = (checked: PlainChecked): ScalarTerm => {
	const carrier: TermCarrier = { column: plainColumns[checked.sql], sql: checked.sql }
	return scalarTerm(checked.expr, checked.type, carrier)
}

/** A JavaScript caller's descriptor's carrier, which the checks admitted as a descriptor. */
/** A JavaScript caller's guard: its branch's term carried by the subject's own carrier. */
const guardBy = (parts: GuardParts): GuardValue<ScalarTerm> => guardValue(parts, parts.carrier)

const fieldCarrier = (value: unknown): TermCarrier =>
	describedField(value, SourceLoc("a checked descriptor", [])).carrier

/**
 * The admission cores, one per Compute member: each takes what a JavaScript caller may pass, refuses a malformed operand
 * with CompileError, and returns the term or predicate it records. A test of what a JavaScript caller passes calls a
 * core directly.
 */
export const computeCore = Object.freeze({
	...predicates,
	and: (...ps: ReadonlyArray<unknown>) => predicates.and(ps),
	or: (...ps: ReadonlyArray<unknown>) => predicates.or(ps),
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
	neg: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.neg(a, extra)),
	quot: (a: unknown, b: unknown) => plainBy(checks.quot(a, b)),
	rem: (a: unknown, b: unknown) => plainBy(checks.rem(a, b)),
	abs: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.abs(a, extra)),
	sign: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.sign(a, extra)),
	round: (a: unknown, ...scale: ReadonlyArray<unknown>) => plainBy(checks.round(a, scale)),
	trunc: (a: unknown, ...scale: ReadonlyArray<unknown>) => plainBy(checks.trunc(a, scale)),
	ceil: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.ceil(a, extra)),
	floor: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.floor(a, extra)),
	gcd: (a: unknown, b: unknown) => plainBy(checks.gcd(a, b)),
	lcm: (a: unknown, b: unknown) => plainBy(checks.lcm(a, b)),
	power: (a: unknown, b: unknown) => plainBy(checks.power(a, b)),
	sqrt: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.sqrt(a, extra)),
	least: (...xs: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.least(xs)
		return scalarTerm(checked.expr, checked.type, checked.carrier)
	},
	greatest: (...xs: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.greatest(xs)
		return scalarTerm(checked.expr, checked.type, checked.carrier)
	},
	widthBucket: (x: unknown, low: unknown, high: unknown, count: unknown) =>
		plainBy(checks.widthBucket(x, low, high, count)),
	minScale: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.minScale(a, extra)),
	numeric: (a: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.numeric(a, extra)),
	cond: (p: unknown, then: unknown, otherwise: unknown): ScalarTerm => {
		const checked = checks.cond(p, then, otherwise)
		return scalarTerm(checked.expr, checked.type, checked.carrier)
	},
	/** A JavaScript caller's branch: its function, applied to the guard's subject. */
	when: (guard: unknown, then: unknown, otherwise: unknown): ScalarTerm => {
		const subject = guardOf(guard)?.subject
		if (subject === undefined) {
			return malformed(captureLoc("Compute.when", []), guardRequired)
		}
		if (typeof then !== "function") {
			return malformed(
				captureLoc("Compute.when", []),
				"a function of the guarded subject as when's branch"
			)
		}
		const branch: unknown = Reflect.apply(then, undefined, [subject])
		const checked = checks.when(guard, branch, otherwise)
		return scalarTerm(checked.expr, checked.type, checked.carrier)
	},
	nonzero: (x: unknown) => guardBy(checks.nonzero(x)),
	nonnegative: (x: unknown) => guardBy(checks.nonnegative(x)),
	positive: (x: unknown) => guardBy(checks.positive(x)),
	isFinite: (x: unknown) => guardBy(checks.isFinite(x)),
	within: (x: unknown, low: unknown, high: unknown) => guardBy(checks.within(x, low, high)),
	lower: (s: unknown, endpoint: unknown, ...extra: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.lower(s, endpoint, extra)
		return scalarTerm(checked.expr, checked.type, fieldCarrier(endpoint))
	},
	upper: (s: unknown, endpoint: unknown, ...extra: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.upper(s, endpoint, extra)
		return scalarTerm(checked.expr, checked.type, fieldCarrier(endpoint))
	},
	width: (s: unknown, endpoint: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.width(s, endpoint, extra)),
	charLength: (s: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.charLength(s, extra)),
	octetLength: (s: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.octetLength(s, extra)),
	concat: (a: unknown, b: unknown) => plainBy(checks.concat(a, b)),
	startsWith: (a: unknown, b: unknown) => plainBy(checks.startsWith(a, b)),
	endsWith: (a: unknown, b: unknown) => plainBy(checks.endsWith(a, b)),
	translate: (x: unknown, from: unknown, to: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.translate(x, from, to, extra)),
	lowerAscii: (x: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.lowerAscii(x, extra)),
	replaceWhitespace: (x: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.replaceWhitespace(x, extra)),
	collapse: (x: unknown, ...extra: ReadonlyArray<unknown>) => plainBy(checks.collapse(x, extra)),
	parseDouble: (x: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.parseDouble(x, extra)),
	parseDecimal: (x: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.parseDecimal(x, extra)),
	pattern: (source: unknown): Pattern =>
		typeof source === "string"
			? admittedPattern(source)
			: malformed(captureLoc("Compute.pattern", []), "a pattern source string"),
	matches: (subject: unknown, pattern: unknown) => guardBy(checks.matches(subject, pattern)),
	cosineDistance: (a: unknown, b: unknown) => plainBy(checks.cosineDistance(a, b)),
	union: (a: unknown, b: unknown, ...extra: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.union(a, b, extra)
		return scalarTerm(checked.expr, checked.type, checked.carrier)
	},
	intersection: (a: unknown, b: unknown, ...extra: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.intersection(a, b, extra)
		return scalarTerm(checked.expr, checked.type, checked.carrier)
	},
	difference: (a: unknown, b: unknown, ...extra: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.difference(a, b, extra)
		return scalarTerm(checked.expr, checked.type, checked.carrier)
	},
	cardinality: (a: unknown, ...extra: ReadonlyArray<unknown>) =>
		plainBy(checks.cardinality(a, extra)),
	subset: (a: unknown, b: unknown) => plainBy(checks.subset(a, b)),
	disjoint: (a: unknown, b: unknown) => plainBy(checks.disjoint(a, b)),
	singleton: (id: unknown, ...extra: ReadonlyArray<unknown>): ScalarTerm => {
		const checked = checks.singleton(id, extra)
		return scalarTerm(checked.expr, checked.type, {
			column: bitsColumn(checked.roster),
			sql: "bits"
		})
	}
})
