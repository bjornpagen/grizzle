import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { floatSpecials, Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import { bitInputText } from "#compiler/core/hex.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { moneyMinorUnits, vectorPayload } from "#compiler/ir/carriers.ts"
import { codecOf, codeOf, handlesHex } from "#compiler/ir/codes.ts"
import { datePartSlices } from "#compiler/ir/date.ts"
import {
	builtExpr,
	type ColumnRef,
	describeOp,
	predicateTable,
	type ScalarExpr,
	spanLiteralText,
	type TypedLiteral
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
import { closedLeaf, type ClosedRows } from "#compiler/runtime/write/fill.ts"
import {
	type EvalLeaves,
	evaluateTable,
	hostLiteralOf,
	sqlNull
} from "#compiler/scalar/compute/evaluate.ts"
import { isDateParse, nativeOp, overloadOf } from "#compiler/scalar/compute/registry.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { and, cast, lit, tableCol } from "#compiler/sql/build.ts"
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
			return lit.float(floatSpecials[literal.value], sqlType)
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
			return lit.text(spanLiteralText(literal, type), sqlType)
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
	/** The closed relations a closed read in a constant subterm applies, by name (`persistentClosed`). */
	readonly closed: EvalLeaves["closed"]
	/** Where a refusal is reported. */
	readonly loc: SourceLoc
}

/** The closed relations of a checked schema as a constant subterm's closed reads apply them, its rows by key. */
export const persistentClosed = (checked: CheckedSchema): EvalLeaves["closed"] =>
	closedLeaf(
		new Map(
			[...checked.closed].map(([name, c]): readonly [string, ClosedRows] => [
				name,
				{ heading: c.heading, key: c.relation.primaryFields.length, rows: c.rows }
			])
		)
	)

/** What a persistent expression that reads no closed relation applies to a closed read: none, as it holds none. */
export const noPersistentClosed: EvalLeaves["closed"] = () => undefined

/**
 * The compound subterms of `expr` that read no row: no column, no VALUE and no parameter at any depth, each a constant.
 * One pass over the tree, children first.
 */
const constantSubterms = (expr: ScalarExpr): ReadonlySet<ScalarExpr> => {
	const constant = new Set<ScalarExpr>()
	const visit = (e: ScalarExpr): boolean => {
		const children = e.args.map(visit)
		const reads = e.kind === "column" || e.kind === "value" || e.kind === "param"
		if (reads || children.includes(false)) {
			return false
		}
		if (e.kind !== "literal") {
			constant.add(e)
		}
		return true
	}
	visit(expr)
	return constant
}

/**
 * A constant subterm as its value, the host's exact evaluation of it, which computes what PostgreSQL computes under
 * pg_c_utf8 (scalar/compute/evaluate.ts): the literal of its value, typed by its base; NULL, where it is a boolean, as
 * NULLIF(true, true); undefined where it is NULL of another type, or the host has no value for it, which the caller
 * lowers as written, its own constant subterms each folded. So no collatable function of constants reaches
 * PostgreSQL, which pre-evaluates one in a generation expression before it assigns the expression's collations and
 * refuses it with 42P22 (upstream/generated-column-collation-before-planning); a NULL of another type reaches it only
 * through a closed read and the strict operations over it, which PostgreSQL folds to NULL without calling them.
 */
const foldedConstant = (
	names: PhysicalNames,
	expr: ScalarExpr,
	closed: EvalLeaves["closed"]
): Expr | undefined => {
	const table = predicateTable(expr)
	const value = evaluateTable(
		table.exprs,
		table.root,
		{ value: undefined, column: () => undefined, closed },
		ProgramPatterns.of(tablePatterns(table))
	)
	if (!value.ok) {
		return undefined
	}
	if (value.value !== sqlNull) {
		return persistentLiteral(names, hostLiteralOf(value.value, expr.type), expr.type)
	}
	return baseOf(expr.type).carrier === "bool"
		? { kind: "nullif", expr: lit.bool(true), absent: lit.bool(true) }
		: undefined
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
 * - a parameter has no meaning in the schema and is refused;
 * - a compound subterm that reads no row is its value (`foldedConstant`).
 *
 * The IS TRUE wrapper of a CHECK is not added here: the printer wraps every CHECK. */
export const lowerPersistent = (
	names: PhysicalNames,
	expr: ScalarExpr,
	scope: PersistentScope
): Expr => persistent(names, expr, scope, constantSubterms(expr))

/** `expr` lowered in `scope`, each of `constants`, the tree's constant subterms, as its value where it has one. */
const persistent = (
	names: PhysicalNames,
	expr: ScalarExpr,
	scope: PersistentScope,
	constants: ReadonlySet<ScalarExpr>
): Expr => {
	const value = constants.has(expr) ? foldedConstant(names, expr, scope.closed) : undefined
	if (value !== undefined) {
		return value
	}
	const at = childLoc(scope.loc, "expressions", expr.id)
	/** The expression's operands: a column of the constrained row, VALUE only in a domain CHECK, and no parameter. */
	const lower = (a: ScalarExpr): Expr => persistent(names, a, scope, constants)
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
			const lowered = isConstantBetween(expr, constants)
				? composedBetween(names, expr, scope, constants)
				: defaultOps(expr, args)
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

/** Whether a subterm reads no row: a literal, or a compound subterm of the tree's constants. */
const readsNoRow = (e: ScalarExpr, constants: ReadonlySet<ScalarExpr>): boolean =>
	e.kind === "literal" || constants.has(e)

/**
 * Whether `expr` is a BETWEEN whose operand reads no row: PostgreSQL reads every BETWEEN as `x >= low AND x <= high`,
 * so x and a bound that reads no row would compare two constants, which a generation expression refuses (42P22). A
 * BETWEEN whose operand reads the row compares it alone with each bound.
 */
const isConstantBetween = (
	expr: ScalarExpr & { readonly kind: "op" },
	constants: ReadonlySet<ScalarExpr>
): boolean => {
	const [x] = expr.args
	return nativeOp(expr.op)?.fn === "between" && x !== undefined && readsNoRow(x, constants)
}

/**
 * A BETWEEN as the conjunction PostgreSQL reads it as, `x >= low AND x <= high`, each comparison of two operands that
 * read no row as its value (foldedConstant), as every constant subterm is.
 */
const composedBetween = (
	names: PhysicalNames,
	expr: ScalarExpr & { readonly kind: "op" },
	scope: PersistentScope,
	constants: ReadonlySet<ScalarExpr>
): Expr => {
	const [x, low, high] = expr.args
	if (x === undefined || low === undefined || high === undefined) {
		throw defect("a BETWEEN of an operand and two bounds")
	}
	const carrier = baseOf(x.type).carrier
	const side = (fn: "ge" | "le", bound: ScalarExpr): Expr => {
		const op = overloadOf(fn, [carrier, carrier])
		if (op === undefined || op.partial) {
			throw defect(`a total ${fn} over ${carrier}, of which every BETWEEN over it is composed`)
		}
		const comparison = builtExpr(
			{
				kind: "op",
				op: op.id,
				args: [x, bound],
				type: plainType("bool"),
				nonNull: "strict",
				volatility: op.volatility
			},
			ExprId(`${expr.id}.${fn}`)
		)
		const value = readsNoRow(bound, constants)
			? foldedConstant(names, comparison, scope.closed)
			: undefined
		return value ?? persistent(names, comparison, scope, constants)
	}
	return and([side("ge", low), side("le", high)])
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
