import { constantColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import { type CompareOp, connectiveExpr, type LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr, OpenHead } from "#compiler/ir/open.ts"
import { spanCarrierOf, spanOf } from "#compiler/ir/scalar.ts"
import { buildLoc } from "#compiler/query/build/scope.ts"
import { type AggregateName, aggregateOverload } from "#compiler/scalar/aggregate.ts"
import { computeCore, scalarTerm } from "#compiler/scalar/compute/builders.ts"
import {
	type AvgSql,
	avgSql,
	type NumericSql,
	type PlainHost,
	plainColumns,
	type SumSql,
	sumSql
} from "#compiler/scalar/compute/tables.ts"

import {
	type PredicateValue,
	predicateExpr,
	predicateValue,
	registerCarried,
	registerUntyped,
	type ScalarTerm,
	type TermCarrier,
	type TermOf,
	type Typing,
	termCarrier,
	termExpr,
	termOf,
	typed,
	untyped
} from "#compiler/scalar/compute/term.ts"
import { compatible, withoutSerial } from "#compiler/scalar/compute/types.ts"
import { describeField, literalDescFor, type SqlTag } from "#compiler/scalar/registry.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { untypedLiteral } from "#compiler/schema/literal.ts"
import { malformed } from "#compiler/schema/protocol.ts"
import type { HeadValue } from "#compiler/types/query/terms.ts"

/**
 * Head-only values: aggregates and producers. Their Description and result type live here, keyed by the value, and
 * each carries the column and SQL type of what it delivers.
 */
interface HeadDesc {
	readonly desc: OpenHead
	readonly typing: Typing
}
const headValues = new WeakMap<object, HeadDesc>()

export const headValueOf = (value: unknown): HeadDesc | undefined =>
	hasProperties(value) ? headValues.get(value) : undefined

/** An aggregate: its fold, and the carrier of its result. */
interface AggregateValue<out T, out S extends SqlTag> extends Built, TermCarrier<T, S> {
	readonly aggregate: AggregateName
}

/** A producer: its function, and the carrier of the spans it yields, its operand's. */
interface ProducerValue<out T, out S extends SqlTag> extends Built, TermCarrier<T, S> {
	readonly produces: "intersection" | "difference" | "pack"
}

const headValue = <V extends Built>(value: V, desc: OpenHead, typing: Typing): V => {
	headValues.set(value, { desc, typing })
	return value
}

/** The untyped term: comparisons recorded as written, literal operands carried by host kind for the checker to type. */
export interface UntypedTerm extends Built {
	readonly expr: OpenExpr
	readonly eq: (other: unknown) => PredicateValue
	readonly ne: (other: unknown) => PredicateValue
	readonly lt: (other: unknown) => PredicateValue
	readonly le: (other: unknown) => PredicateValue
	readonly gt: (other: unknown) => PredicateValue
	readonly ge: (other: unknown) => PredicateValue
	readonly between: (low: unknown, high: unknown) => PredicateValue
	readonly in: (values: unknown) => PredicateValue
}

export const untypedTerm = (expr: OpenExpr): UntypedTerm => {
	const self = (): UntypedTerm => term
	const term: UntypedTerm = Object.freeze({
		...builtMark,
		expr,
		eq: (other: unknown) => compare("eq")(self(), other),
		ne: (other: unknown) => compare("ne")(self(), other),
		lt: (other: unknown) => compare("lt")(self(), other),
		le: (other: unknown) => compare("le")(self(), other),
		gt: (other: unknown) => compare("gt")(self(), other),
		ge: (other: unknown) => compare("ge")(self(), other),
		between: (low: unknown, high: unknown) => between(self(), low, high),
		in: (values: unknown) => inSet(self(), values)
	})
	return registerUntyped(term, expr)
}

/**
 * A carried term: its carrier is known, but its type the checker reads from the term it meets. A JavaScript value in a
 * head is one, and so is a variable over a union's field whose arms disagree on its type.
 */
interface CarriedTerm<out T, out S extends SqlTag> extends UntypedTerm, TermCarrier<T, S> {}

const carriedTerm = <T, S extends SqlTag>(
	expr: OpenExpr,
	carrier: TermCarrier<T, S>
): CarriedTerm<T, S> => {
	const self = (): CarriedTerm<T, S> => term
	const term: CarriedTerm<T, S> = Object.freeze({
		...builtMark,
		expr,
		column: carrier.column,
		sql: carrier.sql,
		eq: (other: unknown) => compare("eq")(self(), other),
		ne: (other: unknown) => compare("ne")(self(), other),
		lt: (other: unknown) => compare("lt")(self(), other),
		le: (other: unknown) => compare("le")(self(), other),
		gt: (other: unknown) => compare("gt")(self(), other),
		ge: (other: unknown) => compare("ge")(self(), other),
		between: (low: unknown, high: unknown) => between(self(), low, high),
		in: (values: unknown) => inSet(self(), values)
	})
	return registerCarried(term, expr)
}

/**
 * The scalar vocabulary of a rule.
 *
 * Terms and predicates follow the term protocol of scalar/compute/term.ts: a term is a frozen value with an `expr`
 * member holding its expression (ir/open.ts OpenExpr), its type, when known, registered with it; a predicate has `predicate: true` and an
 * `expr`; a parameter is a term over `{ kind: "param", name, type }` of its descriptor's type. Every term and predicate made here is
 * registered by identity in that module's registry, which is what termExpr reads, so a copy of one is no term. A
 * variable or parent variable whose type the builder knows is a Compute term (Compute's scalarTerm), so Compute
 * arithmetic, casts and comparisons compose with it and type their literal operands by it; one whose type the builder
 * cannot know (a field of a query whose head holds a parameter, or of a query rebuilt from its Description) is an
 * untyped term with the same comparisons, recorded as written for the checker to type.
 *
 * The comparisons, `between` and `inSet` delegate to Compute whenever the first operand's type is known and the other
 * operand is not an untyped term, so a JavaScript caller's mismatch that the TypeScript signatures forbid is refused at
 * construction, exactly as Compute refuses it. A literal never stands first; a literal
 * opposite a term is a value of that term's base, checked for its host representation now and against
 * any contract or regex refinement by the checker (ContractLiteral). `r.not` is relational negation only;
 * a mask is an Allen mask over the thirteen basic relations, nonempty because the empty
 * mask can never hold. Aggregates and producers are head terms only.
 *
 * A term over a heading field: typed when the builder knows its type, carried by its carrier.
 */
export const fieldTerm = <T, S extends SqlTag>(
	expr: OpenExpr,
	typing: Typing,
	carrier: TermCarrier<T, S>
): ScalarTerm<T, S> | CarriedTerm<T, S> =>
	typing.kind === "typed" ? scalarTerm(expr, typing.type, carrier) : carriedTerm(expr, carrier)

export const isTerm = (value: unknown): boolean => termExpr(value) !== undefined

/** The equality of a primitive's host values. */
const samePrimitive = (literal: unknown, host: unknown): boolean => literal === host

const sameDecimal = (literal: unknown, host: unknown): boolean =>
	literal instanceof Decimal && host instanceof Decimal && literal.equals(host)

const sameMoney = (literal: unknown, host: unknown): boolean =>
	literal instanceof Money && host instanceof Money && literal.equals(host)

/** A head literal's SQL type, that type's conversion of its output text, and its equality of host values. */
interface LiteralType {
	readonly sql: SqlTag
	readonly convert: (text: string) => unknown
	readonly equal: (literal: unknown, host: unknown) => boolean
}

/**
 * The SQL type a JavaScript value's kind gives it when it meets nothing, as the checker types it (check/checker.ts
 * bareLiteralType): a string is text, a number an integer, a bigint a bigint, a Decimal a numeric, a Money money and a
 * boolean a boolean.
 */
const literalType = (value: HeadValue): LiteralType => {
	if (typeof value === "string") {
		return {
			sql: "text",
			convert: convertByCarrier.text({ carrier: "text" }),
			equal: samePrimitive
		}
	}
	if (typeof value === "number") {
		return {
			sql: "integer",
			convert: convertByCarrier.int4({ carrier: "int4" }),
			equal: samePrimitive
		}
	}
	if (typeof value === "bigint") {
		return {
			sql: "bigint",
			convert: convertByCarrier.int8({ carrier: "int8" }),
			equal: samePrimitive
		}
	}
	if (typeof value === "boolean") {
		return {
			sql: "boolean",
			convert: convertByCarrier.bool({ carrier: "bool" }),
			equal: samePrimitive
		}
	}
	if (value instanceof Decimal) {
		return {
			sql: "numeric",
			convert: convertByCarrier.numeric({ carrier: "numeric", typmod: undefined }),
			equal: sameDecimal
		}
	}
	return { sql: "money", convert: convertByCarrier.money({ carrier: "money" }), equal: sameMoney }
}

/**
 * A JavaScript value in a head (schema/record.ts headRecord): a carried term over the value, a string, number, bigint,
 * boolean, Decimal or Money, whose column is the value itself, read by its SQL type's conversion and matched by that
 * type's equality, and whose type the checker reads from what it meets, as it types a parameter.
 */
export const literalTerm = <const X extends HeadValue>(
	value: X,
	label: string
): CarriedTerm<X, SqlTag> => {
	const { sql, convert, equal } = literalType(value)
	return carriedTerm(
		{ kind: "literal", value: untypedLiteral(value, label), type: undefined },
		{ column: constantColumn(value, convert, equal), sql }
	)
}

/**
 * A scalar parameter, r.param(name, descriptor): a term over the parameter of the descriptor's type, a serial's being
 * its integer's, carried by the descriptor. The Description records it by name and descriptor, and it stands wherever a
 * term of that type stands, first included.
 */
export const paramTerm = <H, S extends SqlTag>(
	name: string,
	descriptor: TermCarrier<H, S>,
	label: string
): ScalarTerm<H, S> => {
	const described = describeField(descriptor, SourceLoc(label, []))
	if (!described.ok) {
		throw described.error
	}
	return scalarTerm(
		{ kind: "param", name, type: described.value.desc },
		withoutSerial(described.value.scalar),
		{ column: descriptor.column, sql: descriptor.sql }
	)
}

const isUntypedTerm = (value: unknown): boolean => termOf(value)?.typing.kind === "untyped"

/** A literal against a term: of its type's base when the builder knows the type, by host kind alone otherwise. */
const literalAgainst = (anchor: Typing, value: unknown, label: string): LiteralDesc => {
	if (anchor.kind === "untyped") {
		return untypedLiteral(value, label)
	}
	const literal = literalDescFor(anchor.type, value)
	if (!literal.ok) {
		throw malformed(label, describeFault(literal.error))
	}
	return literal.value
}

/** The operand opposite a term: another term, a parameter among them, or a literal of the term's base. */
export const operand = (value: unknown, anchor: Typing, label: string): OpenExpr => {
	const expr = termExpr(value)
	if (expr !== undefined) {
		return expr
	}
	if (predicateExpr(value) !== undefined) {
		throw malformed(label, "a scalar operand, not a predicate")
	}
	if (headValueOf(value) !== undefined) {
		throw malformed(label, "a scalar operand: an aggregate or producer is a head term")
	}
	return { kind: "literal", value: literalAgainst(anchor, value, label), type: undefined }
}

/** A term that stands first, with what the builder knows of its type. */
const firstTerm = (value: unknown, label: string): TermOf => {
	const term = termOf(value)
	if (term === undefined) {
		if (predicateExpr(value) !== undefined) {
			throw malformed(label, "a term first, not a predicate")
		}
		throw malformed(
			label,
			"a term first: a variable, a parent variable, a parameter or a Compute term; a literal never stands first"
		)
	}
	if (term.expr.kind === "literal" && term.expr.type === undefined) {
		throw malformed(label, "a term first: a literal takes its place opposite a term")
	}
	return term
}

/** Whether Compute can type this call: a typed first operand and no untyped term among the others. */
const computable = (first: unknown, others: ReadonlyArray<unknown>): boolean =>
	termOf(first)?.typing.kind === "typed" &&
	!others.some((o) => isUntypedTerm(o) || headValueOf(o) !== undefined)

export const compare =
	(op: CompareOp) =>
	(a: unknown, b: unknown): PredicateValue => {
		if (computable(a, [b])) {
			return computeCore[op](a, b)
		}
		const left = firstTerm(a, `r.${op}`)
		return predicateValue({
			kind: "compare",
			op,
			left: left.expr,
			right: operand(b, left.typing, `r.${op}`)
		})
	}

export const between = (a: unknown, low: unknown, high: unknown): PredicateValue => {
	if (computable(a, [low, high])) {
		return computeCore.between(a, low, high)
	}
	const x = firstTerm(a, "r.between")
	return predicateValue({
		kind: "between",
		arg: x.expr,
		low: operand(low, x.typing, "r.between low"),
		high: operand(high, x.typing, "r.between high")
	})
}

export const inSet = (a: unknown, values: unknown): PredicateValue => {
	if (termOf(a)?.typing.kind === "typed") {
		return computeCore.in(a, values)
	}
	const x = firstTerm(a, "r.inSet")
	if (!isList(values)) {
		throw malformed("r.inSet", "a finite list of literals")
	}
	const literals = values.map((v) => literalAgainst(x.typing, v, "r.inSet"))
	return predicateValue({ kind: "in", arg: x.expr, values: literals })
}

export const predicateOperand = (value: unknown, label: string): OpenExpr => {
	const expr = predicateExpr(value)
	if (expr !== undefined) {
		return expr
	}
	if (isTerm(value)) {
		throw malformed(label, "a predicate: compare a boolean term with r.eq(flag, true)")
	}
	throw malformed(label, "a predicate built from comparisons, r.and, r.or, r.not or Compute")
}

/** r.and and r.or, total: of no predicate the constant true and false, of one that predicate (connectiveExpr). */
const connective =
	(kind: "and" | "or") =>
	(ps: ReadonlyArray<unknown>): PredicateValue =>
		predicateValue(
			connectiveExpr(
				kind,
				ps.map((p) => predicateOperand(p, `r.${kind}`))
			)
		)

export const and = connective("and")
export const or = connective("or")

const spanTerm = (value: unknown, label: string): TermOf => {
	const t = firstTerm(value, label)
	if (t.typing.kind === "typed" && spanCarrierOf(t.typing.type) === undefined) {
		throw malformed(
			label,
			"a span term: span(pg.integer), span(pg.bigint) or a span over a contract on them"
		)
	}
	return t
}

/** The span opposite a span term: a span term of the same span type, a span parameter among them. */
const spanOperand = (value: unknown, anchor: Typing, label: string): OpenExpr => {
	const other = termOf(value)
	if (other === undefined) {
		throw malformed(label, "a span term or a span parameter, r.param(name, span(...))")
	}
	if (other.typing.kind === "typed") {
		if (spanCarrierOf(other.typing.type) === undefined) {
			throw malformed(label, "a span term")
		}
		if (anchor.kind === "typed" && !compatible(other.typing.type, anchor.type)) {
			throw malformed(
				label,
				"two spans over one endpoint type: a day span and a cents span never meet"
			)
		}
	}
	return other.expr
}

export const allenMaskMax = 8191

export const allen = (left: unknown, mask: unknown, right: unknown): PredicateValue => {
	const l = spanTerm(left, "r.allen")
	if (typeof mask !== "number" || !Number.isInteger(mask) || mask < 1 || mask > allenMaskMax) {
		throw malformed(
			"r.allen",
			"an Allen mask: a nonempty union of ALLEN's thirteen basic relations, an integer in 1..8191; the empty mask never holds"
		)
	}
	return predicateValue({
		kind: "allen",
		left: l.expr,
		mask,
		right: spanOperand(right, l.typing, "r.allen")
	})
}

/** A point in a span term or a span parameter of the point's endpoint type. */
export const pointIn = (point: unknown, span: unknown): PredicateValue => {
	const p = firstTerm(point, "r.pointIn")
	const s = termOf(span)
	if (s === undefined) {
		throw malformed("r.pointIn", "a span term or a span parameter, r.param(name, span(...))")
	}
	if (s.typing.kind === "typed") {
		if (spanCarrierOf(s.typing.type) === undefined) {
			throw malformed("r.pointIn", "a span term")
		}
		const endpoint = spanOf(s.typing.type)?.endpoint
		if (
			p.typing.kind === "typed" &&
			endpoint !== undefined &&
			!compatible(p.typing.type, endpoint)
		) {
			throw malformed("r.pointIn", "a point of the span's endpoint type")
		}
	}
	return predicateValue({ kind: "pointIn", point: p.expr, span: s.expr })
}

/**
 * A term operand that carries its column: a field of a query rebuilt from its Description alone carries none, so no
 * aggregate or producer, which deliver their operand's or its result's column, takes one.
 */
const carried = (value: unknown, label: string): TermCarrier => {
	const carrier = termCarrier(value)
	if (carrier === undefined) {
		throw malformed(
			label,
			"a term whose column the builder knows: a field of a query rebuilt from its Description alone has none"
		)
	}
	return carrier
}

/** Producers: head terms yielding zero or more spans per binding, of their left operand's span type. */
const producer = <T, S extends SqlTag>(
	fn: "intersection" | "difference",
	left: TermCarrier<T, S>,
	right: unknown
): ProducerValue<T, S> => {
	const l = spanTerm(left, `r.${fn}`)
	carried(left, `r.${fn}`)
	const r = spanOperand(right, l.typing, `r.${fn}`)
	return headValue(
		Object.freeze({ ...builtMark, produces: fn, column: left.column, sql: left.sql }),
		{ kind: "producer", fn, args: [l.expr, r] },
		l.typing
	)
}

export const intersection = <T, S extends SqlTag>(
	left: TermCarrier<T, S>,
	right: unknown
): ProducerValue<T, S> => producer("intersection", left, right)

export const difference = <T, S extends SqlTag>(
	left: TermCarrier<T, S>,
	right: unknown
): ProducerValue<T, S> => producer("difference", left, right)

export const pack = <T, S extends SqlTag>(spans: TermCarrier<T, S>): ProducerValue<T, S> => {
	const s = spanTerm(spans, "r.pack")
	carried(spans, "r.pack")
	return headValue(
		Object.freeze({ ...builtMark, produces: "pack", column: spans.column, sql: spans.sql }),
		{ kind: "producer", fn: "pack", args: [s.expr] },
		s.typing
	)
}

/**
 * Aggregates: PostgreSQL's own result type over a typed argument, refused where PostgreSQL defines no such aggregate,
 * as the Compute builders refuse an undefined operation. Its Description, and its result type when the argument's is
 * known.
 */
const aggregateHead = (fn: AggregateName, arg: unknown): HeadDesc => {
	const label = `r.${fn}`
	if (fn === "count") {
		const overload = aggregateOverload({ name: "count" }, buildLoc(label, []))
		if (!overload.ok) {
			throw overload.error
		}
		return { desc: { kind: "aggregate", fn: "count" }, typing: typed(overload.value.result) }
	}
	const x = firstTerm(arg, label)
	carried(arg, label)
	if (x.typing.kind === "untyped") {
		return { desc: { kind: "aggregate", fn, arg: x.expr }, typing: untyped }
	}
	const overload = aggregateOverload({ name: fn, arg: x.typing.type }, buildLoc(label, []))
	if (!overload.ok) {
		throw overload.error
	}
	return { desc: { kind: "aggregate", fn, arg: x.expr }, typing: typed(overload.value.result) }
}

const aggregateValue = <T, S extends SqlTag>(
	fn: AggregateName,
	head: HeadDesc,
	carrier: TermCarrier<T, S>
): AggregateValue<T, S> =>
	headValue(
		Object.freeze({ ...builtMark, aggregate: fn, column: carrier.column, sql: carrier.sql }),
		head.desc,
		head.typing
	)

/**
 * count is bigint; sum and mean take their result type's plain column off the SUM and AVG tables keyed by their
 * argument's SQL type (scalar/compute/tables.ts); min and max deliver their argument's column, contract included.
 */
export const count = (extra: ReadonlyArray<unknown>): AggregateValue<bigint, "bigint"> => {
	if (extra.length > 0) {
		throw malformed(
			"r.count",
			"r.count() takes no argument: it counts the rule's distinct bindings"
		)
	}
	return aggregateValue("count", aggregateHead("count", undefined), {
		column: plainColumns.bigint,
		sql: "bigint"
	})
}

export const sum = <S extends NumericSql>(
	term: OfSql<S>
): AggregateValue<PlainHost[SumSql[S]], SumSql[S]> => {
	const head = aggregateHead("sum", term)
	const sql = sumSql[term.sql]
	return aggregateValue("sum", head, { column: plainColumns[sql], sql })
}

export const mean = <S extends keyof AvgSql>(
	term: OfSql<S>
): AggregateValue<PlainHost[AvgSql[S]], AvgSql[S]> => {
	const head = aggregateHead("mean", term)
	const sql = avgSql[term.sql]
	return aggregateValue("mean", head, { column: plainColumns[sql], sql })
}

export const min = <T, S extends SqlTag>(term: TermCarrier<T, S>): AggregateValue<T, S> =>
	aggregateValue("min", aggregateHead("min", term), term)

export const max = <T, S extends SqlTag>(term: TermCarrier<T, S>): AggregateValue<T, S> =>
	aggregateValue("max", aggregateHead("max", term), term)

/** What an aggregate reads of a typed argument: its SQL type. */
interface OfSql<S extends SqlTag> {
	readonly sql: S
}

/**
 * A head term, as find holds its head (schema/record.ts headRecord): a term (a parameter, a typed constant, or the
 * head literal of a JavaScript value, typically a discriminant, among them), an aggregate or a producer. A predicate
 * is not a head term: Compute.cond(p, flag, false) states a computed boolean.
 */
export const headTerm = (value: unknown, label: string): HeadDesc => {
	const head = headValueOf(value)
	if (head !== undefined) {
		return head
	}
	const term = termOf(value)
	if (term !== undefined) {
		return { desc: term.expr, typing: term.typing }
	}
	if (predicateExpr(value) !== undefined) {
		throw malformed(
			label,
			"a head term, not a predicate: Compute.cond(p, flag, false) is a computed boolean"
		)
	}
	throw malformed(
		label,
		"a head term: a term, an aggregate, a producer or a JavaScript value; a roster's member is X.handle(m), any other typed constant Compute.literal(F, x)"
	)
}
