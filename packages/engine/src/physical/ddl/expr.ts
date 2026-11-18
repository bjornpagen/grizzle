import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import { bitInputText } from "#compiler/core/hex.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import {
	builtExpr,
	type ColumnRef,
	predicateTable,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import { fieldColumnType, type PhysicalNames } from "#compiler/ir/physical.ts"
import { baseOf, type ScalarType, spanCarrierOf } from "#compiler/ir/scalar.ts"
import {
	lowerLiteral,
	lowerScalar,
	type ScalarSite
} from "#compiler/lower/conservative/expr/index.ts"
import { closedLeaf, type ClosedRows } from "#compiler/runtime/write/fill.ts"
import {
	type EvalLeaves,
	evaluateTable,
	hostLiteralOf,
	sqlNull
} from "#compiler/scalar/compute/evaluate.ts"
import { nativeOp, overloadOf } from "#compiler/scalar/compute/registry.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { and, lit, tableCol } from "#compiler/sql/build.ts"

const refusePersistent = (tag: ProseTag, loc: SourceLoc, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, loc, capability)))
}

/**
 * The text an element of an array literal of `type` spells `literal` with, the text its base type's input function
 * reads: a dictionary's element. A quoted spelling's own text, a bare one's digits or word.
 */
export const persistentText = (
	names: PhysicalNames,
	literal: TypedLiteral,
	type: ScalarType
): string => {
	const value = lowerLiteral(names, literal, type)
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
		return lowerLiteral(names, hostLiteralOf(value.value, expr.type), expr.type)
	}
	return baseOf(expr.type).carrier === "bool"
		? { kind: "nullif", expr: lit.bool(true), absent: lit.bool(true) }
		: undefined
}

/** The SQL of the expression tree `expr` in `scope`: the scalar IR of a CHECK, a domain CHECK, a partial-index predicate or a
 * STORED generated column, lowered by the one scalar lowering (lower/conservative/expr/index.ts lowerScalar) at its
 * persistent site. Throws a Refusal, which the installer's boundary turns into a Result.
 *
 * What differs from a query is the site:
 *
 * - a column is the row's own, unqualified (`"budget"`), resolved to its installed identifier; a CHECK reads no other
 *   row;
 * - VALUE is the domain's value, admitted only in a domain CHECK;
 * - a parameter has no meaning in the schema and is refused;
 * - a cast names its type's installed column type;
 * - a compound subterm that reads no row is its value (`foldedConstant`), and a BETWEEN whose operand reads none is the
 *   conjunction PostgreSQL reads it as (`composedBetween`).
 *
 * The IS TRUE wrapper of a CHECK is not added here: the printer wraps every CHECK. */
export const lowerPersistent = (
	names: PhysicalNames,
	expr: ScalarExpr,
	scope: PersistentScope
): Expr => lowerScalar(expr, persistentSite(names, scope, constantSubterms(expr)))

/** The persistent site of a tree in `scope` (lowerPersistent), each of `constants`, its constant subterms, as its value
 * where it has one. */
const persistentSite = (
	names: PhysicalNames,
	scope: PersistentScope,
	constants: ReadonlySet<ScalarExpr>
): ScalarSite => {
	const site: ScalarSite = {
		names,
		at: (expr) => childLoc(scope.loc, "expressions", expr.id),
		leaf: (expr) => {
			const at = site.at(expr)
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
			}
		},
		castType: (type) => fieldColumnType(names, type).type,
		whole: (expr) =>
			(constants.has(expr) ? foldedConstant(names, expr, scope.closed) : undefined) ??
			(expr.kind === "op" && isConstantBetween(expr, constants)
				? composedBetween(names, expr, scope, site, constants)
				: undefined)
	}
	return site
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
	const all = [expr.type, ...expr.args.map((a) => a.type)]
	return (
		nativeOp(expr.op)?.fn === "between" &&
		x !== undefined &&
		readsNoRow(x, constants) &&
		!all.some((t) => spanCarrierOf(t) !== undefined || t.carrier === "vector")
	)
}

/**
 * A BETWEEN as the conjunction PostgreSQL reads it as, `x >= low AND x <= high`, each comparison of two operands that
 * read no row as its value (foldedConstant), as every constant subterm is.
 */
const composedBetween = (
	names: PhysicalNames,
	expr: ScalarExpr & { readonly kind: "op" },
	scope: PersistentScope,
	site: ScalarSite,
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
		return value ?? lowerScalar(comparison, site)
	}
	return and([side("ge", low), side("le", high)])
}
