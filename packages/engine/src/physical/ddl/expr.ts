import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import { bitInputText } from "#compiler/core/hex.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import {
	builtExpr,
	type ColumnRef,
	type LiveArgs,
	outsideSpec,
	predicateTable,
	sameArgs,
	type ScalarExpr,
	type TypedLiteral,
	withArgs
} from "#compiler/ir/expr.ts"
import type { TableRelation } from "#compiler/ir/law.ts"
import { fieldColumnType, type PhysicalNames } from "#compiler/ir/physical.ts"
import { baseOf, type ScalarType, spanCarrierOf } from "#compiler/ir/scalar.ts"
import {
	lowerLiteral,
	lowerScalar,
	printedSize,
	type ScalarSite
} from "#compiler/lower/conservative/expr/index.ts"
import { sharedExpr } from "#compiler/lower/conservative/expr/share.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { closedLeaf } from "#compiler/runtime/write/fill.ts"
import {
	type EvalLeaves,
	compiledExpr,
	type SqlValue,
	sqlNull
} from "#compiler/scalar/compute/evaluate.ts"
import { literalOfHost } from "#compiler/scalar/compute/literal.ts"
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

/** What a persistent expression reads: a row, a table CHECK's, a span endpoint check's or a backfill's, whose column
 * references are each the row's value at it (`column` answers undefined for one outside the row); or a domain CHECK's
 * VALUE, where no column is in scope. */
type PersistentReading =
	| { readonly kind: "row"; readonly column: (ref: ColumnRef) => Expr | undefined }
	| { readonly kind: "domain" }

interface PersistentScope {
	readonly reads: PersistentReading
	/** Where a refusal is reported. */
	readonly loc: SourceLoc
}

/** Whether `e` is AND or OR, and which: the connectives PostgreSQL's planner reduces by an operand's value. */
const connectiveOf = (e: ScalarExpr): "and" | "or" | undefined => {
	if (e.kind !== "op") {
		return undefined
	}
	const fn = nativeOp(e.op)?.fn
	return fn === "and" || fn === "or" ? fn : undefined
}

/**
 * The compound subterms of `expr` PostgreSQL's planner folds to constants, each with its planned form: the subterm as
 * the planner reduces it, which reads no row. cookDefault checks a generation expression's immutability by
 * expression_planner before it assigns the expression's collations (upstream/generated-column-collation-before-planning),
 * and eval_const_expressions there reduces more than a subterm that reads no row:
 *
 * - a column, VALUE or parameter reads the row, and a literal is a constant;
 * - a CASE whose condition folds to a value is the arm it selects, the THEN arm where it holds and the ELSE arm where
 *   it is false or NULL, so a row read in the other arm is no read;
 * - an AND or OR one of whose operands folds to its deciding value, false for AND and true for OR, is that value, a row
 *   read in another operand no read;
 * - any other subterm, and an AND, OR or CASE that none of these decides, is a constant where every operand is, over
 *   its operands' planned forms, as simplify_function evaluates an immutable function of constants.
 *
 * So `GREATEST(CASE WHEN 0 <> 0 THEN t ELSE '' END, '')` is the planner's `GREATEST('', '')`, which it evaluates before
 * any collation is assigned, and the host folds it whole. A condition or an operand the host has no value for decides
 * nothing here. One pass over the tree, children first, each shared subterm planned once.
 */
const plannedConstants = (
	expr: ScalarExpr,
	closed: EvalLeaves["closed"]
): ReadonlyMap<ScalarExpr, ScalarExpr> => {
	const constants = new Map<ScalarExpr, ScalarExpr>()
	const planned = new Map<ScalarExpr, ScalarExpr | undefined>()
	/** The boolean literal `value`, the planned form of a connective its operand decides. */
	const truth = (like: ScalarExpr, value: boolean): ScalarExpr =>
		builtExpr(
			{
				kind: "literal",
				value: { kind: "bool", value },
				args: [],
				type: like.type,
				nonNull: "literal"
			},
			ExprId(`${like.id}.planned`)
		)
	/** `e` over its operands' planned forms, itself where none changed. */
	const over = (e: ScalarExpr, forms: ReadonlyMap<ScalarExpr, ScalarExpr>): ScalarExpr => {
		const spec = withArgs<LiveArgs, LiveArgs>(outsideSpec(e), (a) => forms.get(a) ?? a)
		return sameArgs(e, spec) ? e : builtExpr(spec, ExprId(`${e.id}.planned`))
	}
	const plan = (e: ScalarExpr): ScalarExpr | undefined => {
		const known = planned.get(e)
		if (known !== undefined || planned.has(e)) {
			return known
		}
		const forms = new Map<ScalarExpr, ScalarExpr>()
		for (const a of e.args) {
			const form = plan(a)
			if (form !== undefined) {
				forms.set(a, form)
			}
		}
		const form = reduced(e, forms)
		planned.set(e, form)
		if (form !== undefined && e.kind !== "literal") {
			constants.set(e, form)
		}
		return form
	}
	const reduced = (
		e: ScalarExpr,
		forms: ReadonlyMap<ScalarExpr, ScalarExpr>
	): ScalarExpr | undefined => {
		const every = e.args.every((a) => forms.has(a))
		switch (e.kind) {
			case "column":
			case "value":
			case "param":
				return undefined
			case "literal":
				return e
			case "cond": {
				const [p, t, f] = e.args
				const condition = forms.get(p)
				const holds = condition === undefined ? undefined : evaluated(condition, closed)
				return holds === undefined
					? every
						? over(e, forms)
						: undefined
					: forms.get(holds === true ? t : f)
			}
			case "op": {
				const connective = connectiveOf(e)
				const deciding = connective === "or"
				const decided =
					connective !== undefined &&
					e.args.some((a) => {
						const form = forms.get(a)
						return form !== undefined && evaluated(form, closed) === deciding
					})
				return decided ? truth(e, deciding) : every ? over(e, forms) : undefined
			}
			case "cast":
			case "domainCast":
			case "closedAt":
			case "closedRow":
			case "closedHas":
				return every ? over(e, forms) : undefined
			case "call":
				return undefined
		}
	}
	plan(expr)
	return constants
}

/**
 * The host's value of `form`, which reads no row, its closed reads applied by `closed`: what PostgreSQL computes under
 * pg_c_utf8 (scalar/compute/evaluate.ts), NULL included, or undefined where the host has no value for it.
 */
const evaluated = (form: ScalarExpr, closed: EvalLeaves["closed"]): SqlValue | undefined => {
	const table = predicateTable(form)
	const value = compiledExpr(table)(
		{ value: undefined, column: () => undefined, closed },
		ProgramPatterns.of(tablePatterns(table))
	)
	return value.ok ? value.value : undefined
}

/**
 * A subterm PostgreSQL's planner folds as its value, the host's exact evaluation of its planned form
 * (`plannedConstants`), which computes what PostgreSQL computes under pg_c_utf8 (scalar/compute/evaluate.ts): the
 * literal of its value, typed by its base; NULL, where it is a boolean, as NULLIF(true, true); undefined where it is NULL
 * of another type, or the host has no value for it, which the caller lowers as written, its own folded subterms each
 * folded. So no collatable function of constants reaches
 * PostgreSQL, which pre-evaluates one in a generation expression before it assigns the expression's collations and
 * refuses it with 42P22 (upstream/generated-column-collation-before-planning); a NULL of another type reaches it only
 * through a closed read and the strict operations over it, which PostgreSQL folds to NULL without calling them.
 */
const foldedConstant = (
	names: PhysicalNames,
	expr: ScalarExpr,
	closed: EvalLeaves["closed"]
): Expr | undefined => {
	const value = evaluated(expr, closed)
	if (value === undefined) {
		return undefined
	}
	if (value !== sqlNull) {
		return lowerLiteral(names, literalOfHost(value, expr.type), expr.type)
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
 * - a compound subterm PostgreSQL's planner folds (`plannedConstants`) is its value (`foldedConstant`), and a BETWEEN
 *   whose operand the planner folds is the conjunction PostgreSQL reads it as (`composedBetween`);
 * - like a query's, its shared subterms are evaluated once (lower/conservative/expr/share.ts sharedExpr), each rewrite
 *   measured by the text this site prints.
 *
 * The IS TRUE wrapper of a CHECK is not added here: the printer wraps every CHECK. */
export const lowerPersistent = (
	names: PhysicalNames,
	expr: ScalarExpr,
	scope: PersistentScope
): Expr => {
	const host = closedLeaf(names.closedIndex)
	const lowered = (e: ScalarExpr): Expr =>
		lowerScalar(e, persistentSite(names, scope, host, plannedConstants(e, host)))
	return lowered(
		sharedExpr(expr, {
			closed: names.closedRelations,
			host,
			size: (e) => printedSize(() => lowered(e))
		})
	)
}

/** A row expression of `relation`'s own columns, a CHECK's predicate, a generated field's expression or a law column's
 * selection or term, lowered as persistent SQL over the table's columns: a field's by its name, or a law column the
 * law model adds to the relation by its identifier, which a family's CHECKs and a generated law column read (`at <
 * ‹n›`, a fold's `after = combine(before, x)`). A reference to anything else is refused as MalformedDescription. */
export const lowerRow = (
	b: Pick<InstallBuilder, "names" | "lawColumnsOf">,
	relation: Pick<TableRelation, "name" | "fields">,
	expr: ScalarExpr,
	label: string
): Expr => {
	const lawColumns = b.lawColumnsOf(relation.name)
	return lowerPersistent(b.names, expr, {
		reads: {
			kind: "row",
			column: (ref) => {
				const column =
					relation.fields.find((f) => f.name === ref.name)?.column ??
					(lawColumns.has(ref.name) ? ref.name : undefined)
				return column === undefined ? undefined : tableCol(column)
			}
		},
		loc: SourceLoc(label, [])
	})
}

/** The persistent site of a tree in `scope` (lowerPersistent), each of `constants`, the subterms PostgreSQL's planner
 * folds, as the value of its planned form where the host, its closed reads `host`'s, has one. */
const persistentSite = (
	names: PhysicalNames,
	scope: PersistentScope,
	host: EvalLeaves["closed"],
	constants: ReadonlyMap<ScalarExpr, ScalarExpr>
): ScalarSite => {
	const site: ScalarSite = {
		names,
		at: (expr) => childLoc(scope.loc, "expressions", expr.id),
		leaf: (expr) => {
			const at = site.at(expr)
			switch (expr.kind) {
				case "column": {
					const column = scope.reads.kind === "row" ? scope.reads.column(expr.column) : undefined
					return (
						column ??
						refusePersistent(
							"MalformedDescription",
							at,
							`a column ${expr.column.name} of the constrained row`
						)
					)
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
		whole: (expr) => {
			const planned = constants.get(expr)
			return (
				(planned === undefined ? undefined : foldedConstant(names, planned, host)) ??
				(expr.kind === "op" && isConstantBetween(expr, constants)
					? composedBetween(names, expr, site, host, constants)
					: undefined)
			)
		}
	}
	return site
}

/** Whether PostgreSQL's planner folds a subterm: a literal, or a compound subterm of the tree's constants. */
const readsNoRow = (e: ScalarExpr, constants: ReadonlyMap<ScalarExpr, ScalarExpr>): boolean =>
	e.kind === "literal" || constants.has(e)

/** A subterm as PostgreSQL's planner reads it: its planned form where it folds, otherwise itself. */
const plannedOf = (e: ScalarExpr, constants: ReadonlyMap<ScalarExpr, ScalarExpr>): ScalarExpr =>
	constants.get(e) ?? e

/**
 * Whether `expr` is a BETWEEN whose operand reads no row: PostgreSQL reads every BETWEEN as `x >= low AND x <= high`,
 * so x and a bound that reads no row would compare two constants, which a generation expression refuses (42P22). A
 * BETWEEN whose operand reads the row compares it alone with each bound.
 */
const isConstantBetween = (
	expr: ScalarExpr & { readonly kind: "op" },
	constants: ReadonlyMap<ScalarExpr, ScalarExpr>
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
 * A BETWEEN as the conjunction PostgreSQL reads it as, `x >= low AND x <= high`, each comparison of two operands
 * PostgreSQL's planner folds as the value of their planned forms (foldedConstant), as every constant subterm is.
 */
const composedBetween = (
	names: PhysicalNames,
	expr: ScalarExpr & { readonly kind: "op" },
	site: ScalarSite,
	host: EvalLeaves["closed"],
	constants: ReadonlyMap<ScalarExpr, ScalarExpr>
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
		const comparison = (subject: ScalarExpr, limit: ScalarExpr): ScalarExpr =>
			builtExpr(
				{
					kind: "op",
					op: op.id,
					args: [subject, limit],
					type: plainType("bool"),
					nonNull: "strict",
					volatility: op.volatility
				},
				ExprId(`${expr.id}.${fn}`)
			)
		const value = readsNoRow(bound, constants)
			? foldedConstant(
					names,
					comparison(plannedOf(x, constants), plannedOf(bound, constants)),
					host
				)
			: undefined
		return value ?? lowerScalar(comparison(x, bound), site)
	}
	return and([side("ge", low), side("le", high)])
}
