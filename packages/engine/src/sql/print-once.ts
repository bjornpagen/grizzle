import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	builtinFunctions,
	type Expr as SubqueryExpr,
	type SelectCore,
	type Cte,
	type Dml,
	type Expr,
	type FromItem,
	type FromSource,
	type OperandSelect,
	type PlBlock,
	type PlFunction,
	type SqlStatement,
	type With
} from "#compiler/sql/ast.ts"
import {
	assertBlockPulledUp,
	assertPulledUp,
	pulledUpBlock,
	pulledUpStatement
} from "#compiler/sql/pull-up.ts"
import { assertScoped } from "#compiler/sql/scope.ts"
import {
	type AstHooks,
	identityHooks,
	inertVisitor,
	Transform,
	transformQuery,
	transformStatement,
	visitDml,
	visitSelect
} from "#compiler/sql/transform.ts"

/**
 * Print once: a statement's text states a CTE only where PostgreSQL plans it as one.
 *
 * PostgreSQL inlines a CTE that its query reads exactly once, that is not MATERIALIZED, not recursive, writes nothing
 * and calls no VOLATILE function (subselect.c SS_process_ctes), and it inlines each such CTE by a walk of the whole
 * statement (inline_cte, inline_cte_walker): k inlined CTEs cost k walks, O(k * size), which in a megabyte statement of
 * hundreds of single-use CTEs was the larger part of its planning (lane PLANSIZE: 38-62% of a read's, 16-28% of a
 * write's). So the printer prints every such CTE in place, as the derived table PostgreSQL's inlining makes of it,
 * `(<its query>) AS "<the reference's alias>"(<its columns>)`, and PostgreSQL meets no CTE to inline: the same query,
 * the same plan, planned at O(size).
 *
 * A lowering names a sub-result by a CTE where it reads it; whether that CTE is printed as one is decided here alone,
 * by the one fact that decides it, how many references the statement holds to it after every rewrite of the statement
 * (write/program/slot-carriers.ts). A CTE read by two references or more, a MATERIALIZED one, a recursive WITH's, a
 * data-modifying one and one whose query calls a VOLATILE function (sql/ast.ts QualifiedFunctionRef and
 * builtinFunctions volatility; a context source calls the refusal function) stays a CTE, as PostgreSQL keeps it.
 *
 * A CTE PostgreSQL would inline that is still printed as one is an internal compiler error (assertPrintedOnce), the
 * invariant every statement is held to before it is printed (sql/print.ts printStatement).
 */

/** Where a reference to a CTE of a statement's own WITH stands: inside one of its CTEs, by place, or in its body. */
export type ReferenceSite =
	| { readonly kind: "cte"; readonly at: number }
	| { readonly kind: "body" }

/** Whether a CTE read by `references` references is printed in place (the module header). */
const printableInPlace = (cte: Cte, references: number): boolean =>
	references === 1 &&
	cte.materialized !== "MATERIALIZED" &&
	cte.query.kind === "select" &&
	!callsVolatile(cte.query)

/** Whether a query calls a VOLATILE function anywhere, its sub-queries' calls included (contain_volatile_functions). */
const callsVolatile = (query: OperandSelect): boolean => {
	let volatile = false
	visitSelect(query, {
		...inertVisitor,
		expr: (e: Expr) => {
			if (e.kind === "call") {
				volatile ||=
					e.fn.kind === "qualified"
						? e.fn.volatility === "VOLATILE"
						: builtinFunctions[e.fn.name].volatility === "VOLATILE"
			}
		},
		fromItem: (item: FromItem) => {
			volatile ||= item.kind === "context"
		}
	})
	return volatile
}

/** A statement holding a WITH of its own: a query, or a data-modifying statement. */
type Holder = OperandSelect | Exclude<Dml, { readonly kind: "select" }>

/** Every FROM item of `holder`, its own WITH's CTEs and every sub-query included. */
const visitItems = (holder: Holder, fromItem: (item: FromItem) => void): void => {
	if (holder.kind === "select") {
		visitSelect(holder, { ...inertVisitor, fromItem })
	} else {
		visitDml(holder, { ...inertVisitor, fromItem })
	}
}

/**
 * How many references `holder` holds to each CTE of its own WITH `w`: a CTE reference's (FromSource `cte`), a met rows
 * source's to its proposed rows and its insert, and an enclosing source's. A CTE that a met rows or an enclosing source
 * reads is printed by name there, so it is never printed in place, however many references read it (`pinned`).
 */
const referencesOf = (
	holder: Holder,
	w: With
): { readonly counts: ReadonlyMap<string, number>; readonly pinned: ReadonlySet<string> } => {
	const counts = new Map<string, number>(w.ctes.map((c) => [c.name, 0]))
	const pinned = new Set<string>()
	const read = (name: string, byName: boolean): void => {
		const n = counts.get(name)
		if (n !== undefined) {
			counts.set(name, n + 1)
			if (byName) {
				pinned.add(name)
			}
		}
	}
	visitItems(holder, (item) => {
		if (item.kind === "cte") {
			read(item.name, false)
		} else if (item.kind === "metRows") {
			read(item.proposed, true)
			read(item.insert, true)
		} else if (item.kind === "enclosing") {
			read(item.name, true)
		}
	})
	return { counts, pinned }
}

/** The CTEs of `holder`'s own WITH printed in place, by name (printableInPlace), none in a recursive WITH. */
const inPlaceCtes = (holder: Holder, w: With): ReadonlyMap<string, Cte> => {
	if (w.recursive) {
		return new Map()
	}
	const { counts, pinned } = referencesOf(holder, w)
	return new Map(
		w.ctes
			.filter((c) => !pinned.has(c.name) && printableInPlace(c, counts.get(c.name) ?? 0))
			.map((c) => [c.name, c])
	)
}

/**
 * The hooks that print each CTE of `chosen` at its one reference: the derived table of its query, the references that
 * query makes to others of `chosen` printed in place in it too, under the reference's alias, or its name where the
 * reference has none, and its columns.
 */
const inPlaceHooks = (chosen: ReadonlyMap<string, Cte>): AstHooks => {
	const hooks: AstHooks = {
		...identityHooks,
		replaceSource: (source: FromSource): FromSource | undefined => {
			if (source.kind !== "cte") {
				return undefined
			}
			const cte = chosen.get(source.name)
			if (cte?.query.kind !== "select") {
				return undefined
			}
			return {
				kind: "derived",
				query: transformQuery(cte.query, hooks),
				alias: source.alias ?? cte.name,
				lateral: false
			}
		}
	}
	return hooks
}

/** `w` without the CTEs of `chosen`: none, where it held no other. */
const withoutChosen = (w: With, chosen: ReadonlyMap<string, Cte>): With | undefined => {
	const kept = w.ctes.filter((c) => !chosen.has(c.name))
	return isNonEmpty(kept) ? { ...w, ctes: kept } : undefined
}

/** A query whose own WITH holds no CTE printed in place: each printed at its reference. */
const queryPrintedOnce = (query: OperandSelect): OperandSelect => {
	const w = query.with
	const chosen = w === undefined ? new Map<string, Cte>() : inPlaceCtes(query, w)
	return w === undefined || chosen.size === 0
		? query
		: transformQuery({ ...query, with: withoutChosen(w, chosen) }, inPlaceHooks(chosen))
}

/**
 * The statement as it is printed (the module header): every CTE PostgreSQL would inline printed in place, its
 * sub-queries' first, then its own WITH's, a data-modifying statement's among them, and then every simple sub-query of
 * a FROM list flattened into its reader, as PostgreSQL pulls it up (sql/pull-up.ts), an inlined CTE among them. The
 * statement as the lowering built it is held to the scope every name it reads is bound in (sql/scope.ts assertScoped),
 * since scope is the lowering's meaning and an escape a flatten happened to remove is still the lowering's defect,
 * visible the day its sub-query is not flattenable; the printed statement to assertPrintedOnce and assertPulledUp,
 * inlining and the flatten keeping every name in its scope. A PL/pgSQL function is its printed form (printedFunction),
 * made once.
 */
export const printedOnce = (statement: SqlStatement): SqlStatement => {
	if (statement.kind === "createFunction" && statement.language === "plpgsql") {
		return printedFunction(statement)
	}
	const known = printedStatements.get(statement)
	if (known !== undefined) {
		return known
	}
	assertScoped(statement)
	const nested = transformStatement(statement, { ...identityHooks, select: queryPrintedOnce })
	const printed = pulledUpStatement(isDmlWithWith(nested) ? dmlPrintedOnce(nested) : nested)
	assertPrintedOnce(printed)
	assertPulledUp(printed)
	printedStatements.set(statement, printed)
	return printed
}

/**
 * Each statement's printed form (printedOnce), by the statement it prints, made once: the binding binds each statement in
 * its printed form (sql/bind.ts), and the printer prints the bound one.
 */
const printedStatements = new WeakMap<SqlStatement, SqlStatement>()

/** Each PL/pgSQL function's printed form (printedFunction), by the function it prints and by itself. */
const printedFunctions = new WeakMap<PlFunction, PlFunction>()

/**
 * A PL/pgSQL function as it is printed: its body printed as every block is (printedBlock), made once per function, a
 * printed function its own form. The one form its text is printed from, so its CREATE FUNCTION's body and the source
 * its snapshot records the digest of (sql/print.ts functionSource) are one print of one body, never a print of the
 * body as it was lowered beside the printed one's.
 */
export const printedFunction = (fn: PlFunction): PlFunction => {
	const known = printedFunctions.get(fn)
	if (known !== undefined) {
		return known
	}
	assertScoped(fn)
	const body = printedBlock(fn.body)
	const printed: PlFunction = body === fn.body ? fn : { ...fn, body }
	printedFunctions.set(fn, printed)
	printedFunctions.set(printed, printed)
	return printed
}

/** Every sub-expression of `e` at its own level, `e` first, never entering a sub-link's query. */
const ownLevel = (e: SubqueryExpr, f: (x: SubqueryExpr) => void): void => {
	f(e)
	for (const c of childrenOf(e)) {
		ownLevel(c, f)
	}
}

/** The direct sub-expressions of `e`, a sub-link's query excluded but its operand included. */
const childrenOf = (e: SubqueryExpr): ReadonlyArray<SubqueryExpr> => {
	switch (e.kind) {
		case "column":
		case "excluded":
		case "returning":
		case "param":
		case "clock":
		case "literal":
		case "exists":
		case "subquery":
		case "array":
		case "domainValue":
		case "user":
		case "plVar":
		case "plSpecial":
		case "field":
		case "regclass":
			return []
		case "cast":
		case "access":
		case "collate":
		case "negate":
		case "not":
		case "isTrue":
		case "complement":
		case "lowerAscii":
			return [e.expr]
		case "binary":
			return [e.left, e.right]
		case "and":
		case "or":
		case "greatest":
		case "least":
		case "coalesce":
			return e.args
		case "between":
			return [e.expr, e.low, e.high]
		case "inList":
			return [e.expr, ...e.list]
		case "equalsAny":
			return [e.expr, e.array]
		case "row":
			return e.items
		case "case":
			return [
				...(e.operand === undefined ? [] : [e.operand]),
				...e.whens.flatMap((w) => [w.when, w.result]),
				e.else
			]
		case "call":
			return e.star
				? e.filter === undefined
					? []
					: [e.filter]
				: [
						...e.args,
						...e.orderBy.map((o) => o.expr),
						...e.withinGroup.map((o) => o.expr),
						...(e.over === undefined
							? []
							: [...e.over.partitionBy, ...e.over.orderBy.map((o) => o.expr)])
					]
		case "nullif":
			return [e.expr, e.absent]
		case "subscript":
			return [e.array, e.index]
		case "attribute":
			return [e.record]
	}
}

/**
 * The functions that return rows, which a query PostgreSQL pulls up into its reader may not call in its targets
 * (prepjointree.c is_simple_subquery, hasTargetSRFs).
 */
const setReturningFunctions: ReadonlySet<string> = new Set([
	"unnest",
	"string_to_table",
	"regexp_split_to_table",
	"generate_subscripts",
	"generate_series"
])

/**
 * Whether a target calls, at its own level, an aggregate, a window function (OVER), a set-returning function or a
 * VOLATILE one: any of them keeps its query from being pulled up (is_simple_subquery: hasAggs, hasWindowFuncs,
 * hasTargetSRFs, contain_volatile_functions over the targets).
 */
const fencingTarget = (e: SubqueryExpr): boolean => {
	let fenced = false
	ownLevel(e, (x) => {
		if (x.kind === "call") {
			fenced ||=
				x.over !== undefined ||
				(x.fn.kind === "qualified"
					? x.fn.volatility === "VOLATILE"
					: builtinFunctions[x.fn.name].reach === "rows" ||
						builtinFunctions[x.fn.name].volatility === "VOLATILE" ||
						setReturningFunctions.has(x.fn.name))
		}
	})
	return fenced
}

/**
 * Whether PostgreSQL pulls a FROM query up into the query that reads it (prepjointree.c is_simple_subquery): a plain
 * core, no WITH, DISTINCT, grouping, HAVING, order, bound or set operation, and no target that folds, windows, returns
 * rows or calls a VOLATILE function. Its scans then join their reader's, and its targets are their expressions there.
 */
const pulledUp = (q: OperandSelect): q is OperandSelect & { readonly body: SelectCore } =>
	q.with === undefined &&
	q.orderBy.length === 0 &&
	q.limit === undefined &&
	q.offset === undefined &&
	q.body.kind === "core" &&
	q.body.distinct === false &&
	q.body.groupBy.length === 0 &&
	q.body.having === undefined &&
	!q.body.targets.some((t) => fencingTarget(t.expr))

/** Whether a target is plain: a column, a constant, a cast of one, or a row of them. */
const plainTarget = (e: SubqueryExpr): boolean =>
	e.kind === "column" || e.kind === "param" || e.kind === "literal" || e.kind === "clock"
		? true
		: e.kind === "cast" || e.kind === "collate"
			? plainTarget(e.expr)
			: e.kind === "row" && e.items.every(plainTarget)

/**
 * What a parenthesized query is (print once's taxonomy of derivations): a `read`, no derivation, of one relation as it
 * stands, `SELECT [DISTINCT] <plain targets> FROM <a table, a CTE or such a read> AS <alias>`, or a constant row of no
 * FROM; `pulled`, a query PostgreSQL pulls up into the query whose FROM reads it (pulledUp), each site's restriction
 * entering it; else a `derivation`, which PostgreSQL computes where it stands: a VALUES list, a fold, a set operation, a
 * bound, a DISTINCT over a join or a filter, any query a fence keeps apart. Where it stands (a FROM, a CTE's body, a
 * sub-link) is its site's to say, never its form's.
 */
const subqueryForm = (q: OperandSelect): "read" | "pulled" | "derivation" => {
	const body = q.body
	if (
		q.with === undefined &&
		q.orderBy.length === 0 &&
		q.limit === undefined &&
		q.offset === undefined &&
		body.kind === "core" &&
		body.where === undefined &&
		body.groupBy.length === 0 &&
		body.having === undefined &&
		(body.distinct === false || body.distinct === true) &&
		body.targets.every((t) => plainTarget(t.expr))
	) {
		const [only, ...more] = body.from
		if (
			more.length === 0 &&
			(only === undefined ||
				only.kind === "table" ||
				only.kind === "cte" ||
				(only.kind === "derived" && !only.lateral && subqueryForm(only.query) === "read"))
		) {
			return "read"
		}
	}
	if (
		body.kind === "core" &&
		body.from.length === 0 &&
		q.with === undefined &&
		body.where === undefined &&
		body.targets.every((t) => plainTarget(t.expr))
	) {
		return "read"
	}
	return pulledUp(q) ? "pulled" : "derivation"
}

/**
 * A PL/pgSQL block as it is printed, a function's body (printedFunction) or a DO statement's (sql/print.ts
 * writeDoBlock), a migration's violation and zone checks among them: every query of it printed once
 * (queryPrintedOnce), then pulled up (sql/pull-up.ts pulledUpBlock), held to both invariants. The one route every
 * block is printed by, so no block's query is printed past either.
 */
export const printedBlock = (block: PlBlock): PlBlock => {
	const printed = pulledUpBlock(
		new Transform({ ...identityHooks, select: queryPrintedOnce }).plBlock(block)
	)
	assertBlockPrintedOnce(printed)
	assertBlockPulledUp(printed)
	return printed
}

/** A data-modifying statement whose own WITH holds no CTE printed in place: each printed at its reference. */
const dmlPrintedOnce = (
	statement: Exclude<Dml, { readonly kind: "select" }> & { readonly with: With }
): SqlStatement => {
	const chosen = inPlaceCtes(statement, statement.with)
	return chosen.size === 0
		? statement
		: transformStatement(
				{ ...statement, with: withoutChosen(statement.with, chosen) },
				inPlaceHooks(chosen)
			)
}

/** A data-modifying statement with a WITH of its own. */
const isDmlWithWith = (
	statement: SqlStatement
): statement is Exclude<Dml, { readonly kind: "select" }> & { readonly with: With } =>
	(statement.kind === "insert" ||
		statement.kind === "update" ||
		statement.kind === "delete" ||
		statement.kind === "merge") &&
	statement.with !== undefined

/**
 * Where each CTE of a single statement's own WITH that is printed in place has its one reference (ReferenceSite):
 * inside which of its CTEs, by place, or in its body. A single statement's units read it to keep each such CTE's text in
 * the unit that reads it (write/program/single.ts partedOf).
 */
export const inPlaceSites = (query: OperandSelect): ReadonlyMap<string, ReferenceSite> => {
	const w = query.with
	if (w === undefined) {
		return new Map()
	}
	const chosen = inPlaceCtes(query, w)
	const sites = new Map<string, ReferenceSite>()
	let site: ReferenceSite = { kind: "body" }
	const note = (item: FromItem): void => {
		if (item.kind === "cte" && chosen.has(item.name)) {
			sites.set(item.name, site)
		}
	}
	w.ctes.forEach((c, at) => {
		site = { kind: "cte", at }
		visitItems(c.query, note)
	})
	site = { kind: "body" }
	visitItems({ ...query, with: undefined }, note)
	return sites
}

/**
 * The invariant every printed statement is held to: no query or data-modifying statement of it holds in its own WITH a
 * CTE PostgreSQL would inline (printableInPlace). A statement that breaks it is a defect of the printer, which prints
 * every such CTE in place (printedOnce), never a property of the lowering's input.
 */
export const assertPrintedOnce = (statement: SqlStatement): void => {
	transformStatement(statement, refusingHooks)
	if (isDmlWithWith(statement)) {
		refuseInlinable(statement, statement.with)
	}
}

/** assertPrintedOnce of a PL/pgSQL block, a function's body or a DO statement's (printedBlock). */
const assertBlockPrintedOnce = (block: PlBlock): void => {
	new Transform(refusingHooks).plBlock(block)
}

/** A refusal of `holder`'s WITH `w`, where it holds a CTE PostgreSQL would inline (the module header). */
const refuseInlinable = (holder: Holder, w: With): void => {
	for (const cte of inPlaceCtes(holder, w).values()) {
		defect(
			`print once: the CTE ${cte.name} is read once, is not MATERIALIZED, writes nothing and calls no VOLATILE function, so PostgreSQL would inline it by a walk of the whole statement; the printer prints it in place (sql/print-once.ts)`
		)
	}
}

/** The hooks that refuse each query whose own WITH holds a CTE PostgreSQL would inline (refuseInlinable). */
const refusingHooks: AstHooks = {
	...identityHooks,
	select: (query) => {
		if (query.with !== undefined) {
			refuseInlinable(query, query.with)
		}
		return query
	}
}
