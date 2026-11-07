import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import { bitInputText } from "#compiler/core/hex.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { moneyMinorUnits, vectorPayload } from "#compiler/ir/carriers.ts"
import { codecOf, codeOf, handlesHex } from "#compiler/ir/codes.ts"
import { datePartSlices } from "#compiler/ir/date.ts"
import {
	type ColumnRef,
	describeOp,
	type TypedLiteral,
	type ScalarExpr
} from "#compiler/ir/expr.ts"
import { baseTypeRef, type PhysicalNames } from "#compiler/ir/physical.ts"
import {
	baseOf,
	type Roster,
	rosterOf,
	type ScalarType,
	spanCarrierOf
} from "#compiler/ir/scalar.ts"
import { moneyText } from "#compiler/lower/conservative/expr/index.ts"
import { defaultOps } from "#compiler/lower/conservative/expr/ops.ts"
import { lowerSpanOp } from "#compiler/lower/conservative/span/index.ts"
import { lowerVectorOp } from "#compiler/lower/conservative/vector/index.ts"
import { columnType } from "#compiler/physical/ddl/names.ts"
import { isDateParse } from "#compiler/scalar/compute/registry.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { cast, lit, tableCol } from "#compiler/sql/build.ts"
import { type ClosedRead, closedRead } from "#compiler/sql/constants.ts"
import { dateOfText } from "#compiler/sql/lexical.ts"

const refusePersistent = (tag: ProseTag, loc: SourceLoc, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, loc, capability)))
}

/** A literal typed by `type`'s base, never cast to a domain: a persistent expression compares a domain column with a
 * base-typed value, because a constant cast to the domain would be rechecked against the domain's current constraints
 * and a tightened domain would make every later insert fail.
 *
 * A money literal is a quoted literal of the exact plain amount, never a currency-formatted string, and never the
 * numeric constant cast `1.25::money` a query uses: numeric_cash is STABLE and reads lc_monetary each time it runs, so
 * in a CHECK, a domain CHECK, an index predicate or a generated column it would depend on the writing session's
 * lc_monetary, which any role can set, and PostgreSQL refuses it in an index predicate or a generated column (42P17). A
 * quoted money literal is converted once, by cash_in at DDL time under the migration identity's pinned C.UTF-8
 * monetary context, and stored as a constant count of minor units. A vector literal is pgvector's input text, its
 * canonical payload, -0 written as 0. */
export const persistentLiteral = (
	names: PhysicalNames,
	literal: TypedLiteral,
	type: ScalarType
): Expr => {
	const sqlType = baseTypeRef(names, type)
	switch (literal.kind) {
		case "int":
			return lit.int(literal.value, sqlType)
		case "numeric":
			return lit.decimal(literal.value.parts, sqlType)
		case "float":
			return lit.float(literal.value, sqlType)
		case "floatSpecial":
			return lit.float(
				literal.value === "NaN"
					? Number.NaN
					: literal.value === "Infinity"
						? Number.POSITIVE_INFINITY
						: Number.NEGATIVE_INFINITY,
				sqlType
			)
		case "money":
			return lit.text(moneyText(moneyMinorUnits(literal.value)), sqlType)
		case "bool":
			return lit.bool(literal.value)
		case "text":
		case "uuid":
		case "date":
			return lit.text(literal.value, sqlType)
		case "handle":
			return lit.int(codeOf(codecOf(names.codes, rosterAt(type)), literal.handle), sqlType)
		case "handles":
			return lit.bits(handlesHex(codecOf(names.codes, rosterAt(type)), literal.handles), sqlType)
		case "span":
			return lit.text(`[${literal.start.toString()},${literal.end.toString()})`, sqlType)
		case "vector":
			return lit.text(vectorPayload(literal.value), sqlType)
	}
}

/** The roster of a closed id's or a set's type: a handle literal meets only one, by literalProblem (ir/expr.ts). */
const rosterAt = (type: ScalarType): Roster =>
	rosterOf(baseOf(type)) ??
	refusePersistent(
		"MalformedDescription",
		SourceLoc("persistent literal", []),
		"a handle literal of a closed id's or a set's type"
	)

/**
 * The text an element of an array literal of `type` spells `literal` with, the text its base type's input function
 * reads: a dictionary's element. A quoted spelling's own text, a bare one's digits or word.
 */
export const persistentText = (
	names: PhysicalNames,
	literal: TypedLiteral,
	type: ScalarType
): string => {
	const value = persistentLiteral(names, literal, type)
	if (value.kind !== "literal") {
		return refusePersistent(
			"MalformedDescription",
			SourceLoc("persistent literal", []),
			"a literal of a type an array literal can hold"
		)
	}
	const v = value.value
	switch (v.kind) {
		case "bool":
			return v.value ? "true" : "false"
		case "int":
			return v.value.toString()
		case "float":
			return String(v.value)
		case "decimal":
		case "floatSpecial":
		case "text":
			return v.value
		case "bits":
			return bitInputText(v.hex)
	}
}

/** What a persistent expression reads: a row, a table CHECK's or a span endpoint check's, whose column references
 * name installed columns (`column` answers undefined for one outside the constrained row); or a domain CHECK's
 * VALUE, where no column is in scope. */
type PersistentReading =
	| { readonly kind: "row"; readonly column: (ref: ColumnRef) => string | undefined }
	| { readonly kind: "domain" }

interface PersistentScope {
	readonly reads: PersistentReading
	/** Where a refusal is reported. */
	readonly loc: SourceLoc
}

/** The SQL of the expression tree `expr` in `scope`: the scalar IR of a CHECK, a domain CHECK, a partial-index predicate or a
 * STORED generated column. Throws a Refusal, which the installer's boundary turns into a Result.
 *
 * One IR node is one PostgreSQL operator, function or cast, so each lowers to one SQL node, the operators through the
 * conservative lowering's Compute vocabulary and its span and vector plug-ins, so a predicate installed in the schema
 * and the same predicate in a query are one native expression tree. What differs from a query is the scope and the
 * literal typing:
 *
 * - a column is the row's own, unqualified (`"budget"`), resolved to its installed identifier; a CHECK reads no other
 *   row;
 * - VALUE is the domain's value, admitted only in a domain CHECK;
 * - a literal is typed by its base type (`persistentLiteral`);
 * - a parameter has no meaning in the schema and is refused.
 *
 * The IS TRUE wrapper of a CHECK is not added here: the printer wraps every CHECK. */
export const lowerPersistent = (
	names: PhysicalNames,
	expr: ScalarExpr,
	scope: PersistentScope
): Expr => {
	const at = childLoc(scope.loc, "expressions", expr.id)
	/** The expression's operands: a column of the constrained row, VALUE only in a domain CHECK, and no parameter. */
	const lower = (a: ScalarExpr): Expr => lowerPersistent(names, a, scope)
	switch (expr.kind) {
		case "column": {
			const column = scope.reads.kind === "row" ? scope.reads.column(expr.column) : undefined
			return column === undefined
				? refusePersistent(
						"MalformedDescription",
						at,
						`a column ${expr.column.name} of the constrained row`
					)
				: tableCol(column)
		}
		case "value":
			return scope.reads.kind === "domain"
				? { kind: "domainValue" }
				: refusePersistent("MalformedDescription", at, "VALUE only inside a domain CHECK")
		case "param":
			return refusePersistent(
				"MalformedDescription",
				at,
				"a persistent expression without parameters"
			)
		case "literal":
			return persistentLiteral(names, expr.value, expr.type)
		case "cast":
			return isDateParse(expr.cast)
				? dateOfText(lower(expr.args[0]), datePartSlices)
				: cast(lower(expr.args[0]), columnType(names, expr.type).type)
		case "domainCast":
			return cast(lower(expr.args[0]), columnType(names, expr.type).type)
		case "cond": {
			const [when, result, otherwise] = expr.args
			return {
				kind: "case",
				whens: [{ when: lower(when), result: lower(result) }],
				else: lower(otherwise),
				operand: undefined
			}
		}
		case "closedAt":
			return closedReadOf(
				names,
				expr,
				expr.relation,
				{ kind: "at", field: expr.field },
				expr.args.map(lower),
				at
			)
		case "closedRow":
			return closedReadOf(names, expr, expr.relation, { kind: "row" }, expr.args.map(lower), at)
		case "closedHas":
			return closedReadOf(names, expr, expr.relation, { kind: "has" }, expr.args.map(lower), at)
		case "op": {
			const args = expr.args.map(lower)
			const all = [expr.type, ...expr.args.map((a) => a.type)]
			if (all.some((t) => spanCarrierOf(t) !== undefined)) {
				return lowerSpanOp(expr, args, at)
			}
			if (all.some((t) => t.carrier === "vector")) {
				return lowerVectorOp(expr, args, at, names.vectorSchema)
			}
			const lowered = defaultOps(expr, args)
			if (lowered === undefined) {
				return refusePersistent(
					"UnsupportedOperation",
					at,
					`a lowering for the operation ${describeOp(expr.op)} over ${args.length} operand(s)`
				)
			}
			return lowered
		}
	}
}

/**
 * A closed read over its relation's installed constants (sql/constants.ts closedRead): C.at's payload field, C.row's
 * completions or a membership test at the key its arguments name, cast to its type's base. An absent key reads NULL
 * for C.at and the empty set for C.row, and a NULL argument reads NULL. A NULL is judged by the expression's
 * three-valued logic: a CHECK refuses its row only where the whole predicate is not true, a selection keeps a row only
 * where it is true, and a generated column's NOT NULL refuses a NULL term. Every domain admits NULL (sql/print.ts), so
 * no cast refuses it first.
 */
const closedReadOf = (
	names: PhysicalNames,
	expr: ScalarExpr,
	relation: string,
	read: ClosedRead,
	args: ReadonlyArray<Expr>,
	at: SourceLoc
): Expr => {
	const lowered = closedRead(
		names.closed(relation),
		relation,
		read,
		args,
		baseTypeRef(names, expr.type)
	)
	return lowered.ok ? lowered.value : refusePersistent("MalformedDescription", at, lowered.error)
}
