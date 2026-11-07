import { codeColumn } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty } from "#compiler/core/nonempty.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { isList } from "#compiler/core/record.ts"
import {
	type CompareOp,
	connectiveExpr,
	decodeDesc,
	type ExprDesc,
	type FieldDesc,
	type Located,
	type Refs
} from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { Roster, type ScalarType } from "#compiler/ir/scalar.ts"
import { plainColumns } from "#compiler/scalar/compute/tables.ts"
import {
	predicateExpr,
	registerTerm,
	registerUntyped,
	type TermCarrier,
	termExpr
} from "#compiler/scalar/compute/term.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import { describeField, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { literalFor, untypedLiteral } from "#compiler/schema/literal.ts"
import {
	isParam,
	malformed,
	orThrow,
	type PredicateValue,
	predicateValue
} from "#compiler/schema/protocol.ts"

export interface RowTerm extends Built {
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

/**
 * What Compute reads of a row term: its ScalarType and its carrier, the field's column and SQL type, when the field
 * registry resolves the field.
 */
type RowTyping =
	| { readonly kind: "typed"; readonly scalar: ScalarType; readonly carrier: TermCarrier }
	| { readonly kind: "untyped" }

/**
 * What a term's literal operands adopt: a field's descriptor and roster, when this package knows them, and the term's
 * typing (the type and carrier the term protocol registers for it, which Compute reads).
 */
interface TermType {
	readonly desc: FieldDesc
	/** The handles of the closed relation a closedId field references, when its host descriptor carries them. */
	readonly roster: ReadonlyArray<string> | undefined
	readonly typing: RowTyping
}

const types = new WeakMap<object, TermType>()

const typeOf = (value: unknown): TermType | undefined =>
	typeof value === "object" && value !== null ? types.get(value) : undefined

/**
 * The typing of a field: the registry's own reading of a descriptor it defined or of a str.regex descriptor, its
 * column among it; otherwise its reading of the Description with the roster the host descriptor carries, whose
 * handles are the column. A field the registry cannot type here is untyped; its row comparisons still work, and
 * Compute refuses it as an operand.
 */
const typingOf = (
	desc: FieldDesc,
	descriptor: unknown,
	roster: ReadonlyArray<string> | undefined
): RowTyping => {
	const described =
		descriptor === undefined ? undefined : describeField(descriptor, SourceLoc("check field", []))
	if (described?.ok === true) {
		return {
			kind: "typed",
			scalar: described.value.scalar,
			carrier: { column: described.value.column, sql: described.value.sql }
		}
	}
	if (roster === undefined || !isNonEmpty(roster) || desc.kind !== "closedId") {
		return { kind: "untyped" }
	}
	const scalar = scalarTypeOf(
		desc,
		{ kind: "builder", roster: (name) => new Roster(name, roster) },
		SourceLoc("check field", [])
	)
	return scalar.ok
		? {
				kind: "typed",
				scalar: scalar.value,
				carrier: { column: codeColumn(desc.roster, roster), sql: "code" }
			}
		: { kind: "untyped" }
}

/** The operand opposite a term: another term, or a literal of the term's type. A check has no parameters. */
const operand = (value: unknown, type: TermType | undefined, label: string): OpenExpr => {
	const term = termExpr(value)
	if (term !== undefined) {
		return term
	}
	if (predicateExpr(value) !== undefined) {
		throw malformed(label, "a scalar operand, not a predicate")
	}
	if (isParam(value)) {
		throw malformed(label, "a literal or a field of the row: a row check has no parameters")
	}
	const literal =
		type === undefined
			? untypedLiteral(value, label)
			: literalFor(type.desc, value, label, type.roster)
	return { kind: "literal", value: literal, type: undefined }
}

const termOperand = (
	value: unknown,
	label: string
): { readonly expr: OpenExpr; readonly type: TermType | undefined } => {
	const expr = termExpr(value)
	if (expr === undefined) {
		throw malformed(label, "a scalar term: a field of the row or a Compute expression")
	}
	return { expr, type: typeOf(value) }
}

const literalList = (values: unknown, type: TermType | undefined, label: string) => {
	if (!isList(values)) {
		throw malformed(label, "a finite list of literals")
	}
	return values.map((v) =>
		type === undefined ? untypedLiteral(v, label) : literalFor(type.desc, v, label, type.roster)
	)
}

const compare =
	(op: CompareOp, left: OpenExpr, type: TermType | undefined) =>
	(other: unknown): PredicateValue =>
		predicateValue({ kind: "compare", op, left, right: operand(other, type, `${op} operand`) })

/** A term over `expr` whose literal operands adopt `type`. */
const rowTerm = (expr: OpenExpr, type: TermType): RowTerm => {
	const comparisons = {
		eq: compare("eq", expr, type),
		ne: compare("ne", expr, type),
		lt: compare("lt", expr, type),
		le: compare("le", expr, type),
		gt: compare("gt", expr, type),
		ge: compare("ge", expr, type),
		between: (low: unknown, high: unknown) =>
			predicateValue({
				kind: "between",
				arg: expr,
				low: operand(low, type, "between low"),
				high: operand(high, type, "between high")
			}),
		in: (values: unknown) =>
			predicateValue({ kind: "in", arg: expr, values: literalList(values, type, "in") })
	}
	const typing = type.typing
	if (typing.kind === "untyped") {
		const term: RowTerm = Object.freeze({ ...builtMark, expr, ...comparisons })
		types.set(term, type)
		return registerUntyped(term, expr)
	}
	const term = Object.freeze({
		...builtMark,
		expr,
		column: typing.carrier.column,
		sql: typing.carrier.sql,
		...comparisons
	})
	types.set(term, type)
	return registerTerm(term, expr, typing.scalar)
}

const predicateOperand = (value: unknown, label: string): OpenExpr => {
	const expr = predicateExpr(value)
	if (expr === undefined) {
		throw malformed(label, "a predicate built from comparisons")
	}
	return expr
}

/** A row check's and and or, total: of no predicate the constant true and false, of one that predicate. */
const connective =
	(kind: "and" | "or") =>
	(...ps: ReadonlyArray<unknown>): PredicateValue =>
		predicateValue(
			connectiveExpr(
				kind,
				ps.map((p) => predicateOperand(p, kind))
			)
		)

const isTextDesc = (desc: FieldDesc): boolean =>
	desc.kind === "text" || (desc.kind === "contract" && isTextDesc(desc.base))

const integerDesc: FieldDesc = { kind: "pg", type: "integer" }
const integerType: TermType = {
	desc: integerDesc,
	roster: undefined,
	typing: {
		kind: "typed",
		scalar: plainType("int4"),
		carrier: { column: plainColumns.integer, sql: "integer" }
	}
}

const helperCompare =
	(op: CompareOp) =>
	(a: unknown, b: unknown): PredicateValue => {
		const left = termOperand(a, op)
		return predicateValue({
			kind: "compare",
			op,
			left: left.expr,
			right: operand(b, left.type, `${op} operand`)
		})
	}

/** The Compute helpers a row check may use. */
export const rowHelpers = Object.freeze({
	eq: helperCompare("eq"),
	ne: helperCompare("ne"),
	lt: helperCompare("lt"),
	le: helperCompare("le"),
	gt: helperCompare("gt"),
	ge: helperCompare("ge"),
	between: (a: unknown, low: unknown, high: unknown): PredicateValue => {
		const arg = termOperand(a, "between")
		return predicateValue({
			kind: "between",
			arg: arg.expr,
			low: operand(low, arg.type, "between low"),
			high: operand(high, arg.type, "between high")
		})
	},
	in: (a: unknown, values: unknown): PredicateValue => {
		const arg = termOperand(a, "in")
		return predicateValue({
			kind: "in",
			arg: arg.expr,
			values: literalList(values, arg.type, "in")
		})
	},
	and: connective("and"),
	or: connective("or"),
	not: (p: unknown): PredicateValue =>
		predicateValue({ kind: "not", arg: predicateOperand(p, "not") }),
	/** char_length over text: admitted in contract predicates and row checks only, never in a query. */
	charLength: (s: unknown): RowTerm => {
		const arg = termOperand(s, "charLength")
		if (arg.type !== undefined && !isTextDesc(arg.type.desc)) {
			throw malformed("charLength", "a text term: charLength counts the code points of text")
		}
		return rowTerm({ kind: "compute", fn: "charLength", args: [arg.expr] }, integerType)
	},
	/** octet_length over text: admitted in contract predicates and row checks only, never in a query. */
	octetLength: (s: unknown): RowTerm => {
		const arg = termOperand(s, "octetLength")
		if (arg.type !== undefined && !isTextDesc(arg.type.desc)) {
			throw malformed("octetLength", "a text term: octetLength counts the UTF-8 bytes of text")
		}
		return rowTerm({ kind: "compute", fn: "octetLength", args: [arg.expr] }, integerType)
	}
})

/**
 * The scalar terms a row check is built from.
 *
 * `check(name, R, (row) => predicate)` runs its callback once, at construction, over a RowScalars value and records the
 * predicate's ExprDesc (callbacks build descriptions; they never run per row). RowScalars exposes each field
 * of R as a Scalar, a term with the comparisons eq, ne, lt, le, gt, ge, between and in, beside the Compute helpers a
 * check may use: eq, ne, lt, le, gt, ge, between, in, and, or, not and charLength.
 *
 * A literal operand adopts the type of the term it meets and is checked at construction:
 * over a numeric field a JavaScript number is refused. Whether each partial operation's precondition is proved, a
 * divisor's nonzero among them, is the checker's judgment at compilation; this module records what was written. A row check reads its own row only: a parameter, a query variable or a
 * relational negation inside it is refused here, because a check has no inputs.
 *
 * A term of another package (a Compute expression) composes through the term protocol of protocol.ts: a term
 * any builder made and registered (scalar/compute/term.ts) is a term, and its literal operands are typed by the
 * checker.
 *
 * The row a check's callback receives: each field as a term over `{ kind: "field" }`, beside the helpers. A field
 * named like a helper is the field: the declared heading wins over the vocabulary. A field is typed by its descriptor,
 * or by the roster it holds where it has none (a closed relation's id).
 */
export const rowScalars = (
	fields: Readonly<Record<string, FieldDesc>>,
	descriptors: Readonly<Record<string, unknown>>,
	rosterOf: (field: string) => ReadonlyArray<string> | undefined
): Readonly<Record<string, unknown>> => {
	const row: Record<string, unknown> = { ...rowHelpers }
	for (const [name, desc] of Object.entries(fields)) {
		const roster = rosterOf(name)
		row[name] = rowTerm(
			{ kind: "field", field: name },
			{ desc, roster, typing: typingOf(desc, descriptors[name], roster) }
		)
	}
	return Object.freeze(row)
}

/**
 * The ExprDesc a check's callback returned, refusing anything but a predicate and any input a row check cannot have:
 * a parameter, a query variable, a parent column, a contract's VALUE or a relational negation. What remains holds no
 * builder reference, so it parses as a Description's expression.
 */
export const checkPredicate = (built: unknown, label: string): ExprDesc => {
	const expr = predicateExpr(built)
	if (expr === undefined) {
		throw malformed(label, "a predicate built from the row's comparisons")
	}
	const foreign = foreignInput(expr)
	if (foreign !== undefined) {
		throw malformed(label, `a predicate over the row's own fields only, not ${foreign}`)
	}
	return orThrow(decodeDesc("expr", expr))
}

export const foreignInput = <R extends Refs>(expr: ExprDesc<Located, R>): string | undefined => {
	switch (expr.kind) {
		case "field":
		case "literal":
			return undefined
		case "var":
			return "a query variable"
		case "param":
			return "a parameter"
		case "parent":
			return "a parent column"
		case "value":
			return "a contract's value"
		case "absent":
			return "a relational negation"
		case "compute":
			return firstForeign(expr.args)
		case "cast":
		case "base":
		case "not":
			return foreignInput(expr.arg)
		case "cond":
			return firstForeign([expr.pred, expr.onTrue, expr.onFalse])
		case "when":
			return firstForeign([expr.subject, expr.proved, expr.otherwise])
		case "compare":
			return firstForeign([expr.left, expr.right])
		case "between":
			return firstForeign([expr.arg, expr.low, expr.high])
		case "in":
			return foreignInput(expr.arg)
		case "and":
		case "or":
			return firstForeign(expr.args)
		case "allen":
			return firstForeign([expr.left, expr.right])
		case "pointIn":
			return firstForeign([expr.point, expr.span])
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return firstForeign(expr.args)
	}
}

const firstForeign = <R extends Refs>(
	exprs: ReadonlyArray<ExprDesc<Located, R>>
): string | undefined => {
	for (const e of exprs) {
		const found = foreignInput(e)
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}
