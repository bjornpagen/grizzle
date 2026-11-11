import { codeColumn } from "#compiler/core/decoder.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { isList } from "#compiler/core/record.ts"
import {
	type CompareOp,
	connectiveExpr,
	type ExprDesc,
	type FieldDesc,
	type Located,
	type Refs
} from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { plainColumns } from "#compiler/scalar/compute/tables.ts"
import {
	predicateExpr,
	registerTerm,
	registerUntyped,
	termExpr
} from "#compiler/scalar/compute/term.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { describeField, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { literalFor, untypedLiteral } from "#compiler/schema/literal.ts"
import {
	type HeadingTyping,
	isParam,
	malformed,
	predicateValue,
	type PredicateValue,
	builderRefusal
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
 * What a term's literal operands adopt: a field's descriptor and roster, when this package knows them, and the term's
 * typing (the type and carrier the term protocol registers for it, which Compute reads).
 */
interface TermType {
	readonly desc: FieldDesc
	/** The handles of the closed relation a closedId field references, when its host descriptor carries them. */
	readonly roster: ReadonlyArray<string> | undefined
	readonly typing: HeadingTyping
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
): HeadingTyping => {
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
	return { kind: "literal", value: literal }
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
const rowTerm = (expr: OpenExpr, type: TermType): RowTerm => termOver(expr, type, type.typing)

/**
 * A term over `expr`, typed for Compute by `typing`, whose literal operands adopt `type` where its field's descriptor is
 * known, and are recorded as written where it is not, for the schema's compilation to type.
 */
const termOver = (expr: OpenExpr, type: TermType | undefined, typing: HeadingTyping): RowTerm => {
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
	if (typing.kind === "untyped") {
		const term: RowTerm = Object.freeze({ ...builtMark, expr, ...comparisons })
		if (type !== undefined) {
			types.set(term, type)
		}
		return registerUntyped(term, expr)
	}
	const term = Object.freeze({
		...builtMark,
		expr,
		column: typing.carrier.column,
		sql: typing.carrier.sql,
		...comparisons
	})
	if (type !== undefined) {
		types.set(term, type)
	}
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
 * A callback's row: the helpers, and each field a getter that builds the field's term (`term`) where the callback reads
 * it, so a field it never reads has no term built. A field named like a helper is the field.
 */
const rowOf = <A>(
	fields: Iterable<readonly [string, A]>,
	term: (name: string, field: A) => RowTerm
): Readonly<Record<string, unknown>> => {
	const row: Record<string, unknown> = { ...rowHelpers }
	for (const [name, field] of fields) {
		Object.defineProperty(row, name, { enumerable: true, get: () => term(name, field) })
	}
	return Object.freeze(row)
}

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
): Readonly<Record<string, unknown>> =>
	rowOf(Object.entries(fields), (name, desc) => {
		const roster = rosterOf(name)
		return rowTerm(
			{ kind: "field", field: name },
			{ desc, roster, typing: typingOf(desc, descriptors[name], roster) }
		)
	})

/**
 * The row a check's or a selection's callback over a derived relation receives: each field of its definition's heading
 * as a term over `{ kind: "field" }`, typed for Compute as the builder typed the definition's head, beside the helpers.
 * A derived field's descriptor is inferred where the schema compiles, so a literal operand is recorded as written and
 * typed there (analysis/theory/query.ts), as one opposite a Compute term is.
 */
export const derivedRowScalars = (
	heading: ReadonlyMap<string, HeadingTyping>
): Readonly<Record<string, unknown>> =>
	rowOf(heading, (name, typing) => termOver({ kind: "field", field: name }, undefined, typing))

/**
 * The ExprDesc a check's callback returned, refusing anything but a predicate and any input a row check cannot have:
 * a parameter, a query variable, a parent column, a contract's VALUE or a relational negation. Its builders checked
 * every node where they made it (scalar/compute/term.ts), so what remains is read as it is, its references closed
 * (rowExpr), never decoded again.
 */
export const checkPredicate = (built: unknown, label: string): ExprDesc => {
	const expr = predicateExpr(built)
	if (expr === undefined) {
		throw malformed(label, "a predicate built from the row's comparisons")
	}
	const closed = rowExpr(expr)
	if (closed instanceof ForeignInput) {
		throw closed.refuse(label)
	}
	return closed
}

/** An input a row check cannot have, by the refusal checkPredicate states of it at a check's label. */
class ForeignInput {
	readonly refuse: (label: string) => CompileError

	constructor(refuse: (label: string) => CompileError) {
		this.refuse = refuse
	}
}

/** An input a row check cannot have, named `what`. */
const foreign = (what: string): ForeignInput =>
	new ForeignInput((label) =>
		malformed(label, `a predicate over the row's own fields only, not ${what}`)
	)

/** A parameter, which a schema predicate never reads: a rule the types name too. */
const parameterInput = new ForeignInput((label) =>
	builderRefusal(label, "a schema predicate reads no parameter")
)

/**
 * A row predicate's open expression as a Description's: a field or a literal as its builder made it, frozen, and every
 * other node rebuilt over its operands', so the expression's references are closed; or the first input a row check
 * cannot have, found in foreignInput's order.
 */
const rowExpr = (expr: OpenExpr): ExprDesc | ForeignInput => {
	switch (expr.kind) {
		case "field":
		case "literal":
			return Object.freeze(expr)
		case "var":
			return foreign("a query variable")
		case "param":
			return parameterInput
		case "parent":
			return foreign("a parent column")
		case "value":
			return foreign("a contract's value")
		case "absent":
			return foreign("a relational negation")
		case "compute": {
			const args = rowExprs(expr.args)
			return args instanceof ForeignInput ? args : Object.freeze({ ...expr, args })
		}
		case "cast":
		case "base":
		case "not":
		case "in": {
			const arg = rowExpr(expr.arg)
			return arg instanceof ForeignInput ? arg : Object.freeze({ ...expr, arg })
		}
		case "cond": {
			const pred = rowExpr(expr.pred)
			if (pred instanceof ForeignInput) {
				return pred
			}
			const onTrue = rowExpr(expr.onTrue)
			if (onTrue instanceof ForeignInput) {
				return onTrue
			}
			const onFalse = rowExpr(expr.onFalse)
			return onFalse instanceof ForeignInput
				? onFalse
				: Object.freeze({ ...expr, pred, onTrue, onFalse })
		}
		case "when": {
			const subject = rowExpr(expr.subject)
			if (subject instanceof ForeignInput) {
				return subject
			}
			const proved = rowExpr(expr.proved)
			if (proved instanceof ForeignInput) {
				return proved
			}
			const otherwise = rowExpr(expr.otherwise)
			return otherwise instanceof ForeignInput
				? otherwise
				: Object.freeze({ ...expr, subject, proved, otherwise })
		}
		case "compare":
		case "allen": {
			const left = rowExpr(expr.left)
			if (left instanceof ForeignInput) {
				return left
			}
			const right = rowExpr(expr.right)
			return right instanceof ForeignInput ? right : Object.freeze({ ...expr, left, right })
		}
		case "between": {
			const arg = rowExpr(expr.arg)
			if (arg instanceof ForeignInput) {
				return arg
			}
			const low = rowExpr(expr.low)
			if (low instanceof ForeignInput) {
				return low
			}
			const high = rowExpr(expr.high)
			return high instanceof ForeignInput ? high : Object.freeze({ ...expr, arg, low, high })
		}
		case "pointIn": {
			const point = rowExpr(expr.point)
			if (point instanceof ForeignInput) {
				return point
			}
			const span = rowExpr(expr.span)
			return span instanceof ForeignInput ? span : Object.freeze({ ...expr, point, span })
		}
		case "and":
		case "or":
		case "closedAt":
		case "closedHas": {
			const args = rowExprsNonEmpty(expr.args)
			return args instanceof ForeignInput ? args : Object.freeze({ ...expr, args })
		}
		case "closedRow": {
			const args = rowExprs(expr.args)
			return args instanceof ForeignInput ? args : Object.freeze({ ...expr, args })
		}
	}
}

/** Each of `exprs` as rowExpr reads it, in order, frozen, or the first foreign input among them. */
const rowExprs = (exprs: ReadonlyArray<OpenExpr>): ReadonlyArray<ExprDesc> | ForeignInput => {
	const out: Array<ExprDesc> = []
	for (const e of exprs) {
		const closed = rowExpr(e)
		if (closed instanceof ForeignInput) {
			return closed
		}
		out.push(closed)
	}
	return Object.freeze(out)
}

/** rowExprs over a nonempty list, still nonempty. */
const rowExprsNonEmpty = (
	exprs: NonEmptyReadonlyArray<OpenExpr>
): NonEmptyReadonlyArray<ExprDesc> | ForeignInput => {
	const [head, ...tail] = exprs
	const first = rowExpr(head)
	if (first instanceof ForeignInput) {
		return first
	}
	const rest = rowExprs(tail)
	if (rest instanceof ForeignInput) {
		return rest
	}
	const out: NonEmptyReadonlyArray<ExprDesc> = [first, ...rest]
	return Object.freeze(out)
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
