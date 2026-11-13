import { Array as Arr } from "effect"
import type { Step } from "#compiler/deploy/diff/plan.ts"
import type { Expr, FromSource, SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr, transformStatement } from "#compiler/sql/transform.ts"

/**
 * The per-row reads of a migration's backfill, the oracle of "a backfill is set-based": every statement of its slot
 * (structure.backfill) is a join of row sets, each computed once, never a read PostgreSQL runs again for each row of
 * another. Before any index of a table exists, which structure.backfill runs ahead of, such a read scans the table once
 * per row. Two forms make one, both judged on the drafted statement's SQL AST:
 *
 * - a subquery (a scalar one, EXISTS, IN or ARRAY) that reads a column of a FROM item outside it, or a column it does
 *   not qualify, which PostgreSQL runs as a SubPlan once per outer row;
 * - a LATERAL source, a derived table or a function's rows, or a write's probe of a stored table, run once per row
 *   that drives it.
 *
 * A subquery that reads only what it holds is run once, its rows an InitPlan, and is no per-row read.
 */
export const perRowReads = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
	Arr.flatMap(steps, (step) =>
		step.slot === "structure.backfill" && step.draft.kind === "statement"
			? statementReads(step.draft.statement)
			: []
	)

/** Each per-row read of one statement, by what it is. */
const statementReads = (statement: SqlStatement): ReadonlyArray<string> => {
	const found: Array<string> = []
	transformStatement(statement, {
		...identityHooks,
		fromSource: (source) => {
			const lateral = lateralSource(source)
			if (lateral !== undefined) {
				found.push(lateral)
			}
			return source
		},
		expr: (e) => {
			const outer = isSubquery(e) ? outerReads(e) : []
			if (outer.length > 0) {
				found.push(`a subquery reading ${Arr.join(outer, ", ")} from outside it`)
			}
			return e
		}
	})
	return found
}

/** A FROM source PostgreSQL reads once per row that drives it, by what it is. */
const lateralSource = (source: FromSource): string | undefined =>
	(source.kind === "derived" || source.kind === "function") && source.lateral
		? `a LATERAL source "${source.alias}"`
		: source.kind === "probe" || source.kind === "met"
			? `a probe "${source.alias}"`
			: undefined

/** Whether an expression is a subquery: a scalar one, EXISTS, IN or ARRAY. */
const isSubquery = (e: Expr): boolean =>
	e.kind === "subquery" || e.kind === "exists" || e.kind === "inQuery" || e.kind === "array"

/** The name a FROM source's columns are read under. */
const aliasOf = (source: FromSource): string | undefined =>
	source.kind === "cte"
		? (source.alias ?? source.name)
		: "alias" in source
			? source.alias
			: undefined

/** The columns a subquery reads from outside it: each qualified by a FROM item it does not hold, and each unqualified
 * one, which may name an outer row's. */
const outerReads = (subquery: Expr): ReadonlyArray<string> => {
	const held = new Set<string>()
	const read: Array<{ readonly table: string | undefined; readonly column: string }> = []
	transformExpr(subquery, {
		...identityHooks,
		fromSource: (source) => {
			const alias = aliasOf(source)
			if (alias !== undefined) {
				held.add(alias)
			}
			return source
		},
		expr: (e) => {
			if (e.kind === "column") {
				read.push({ table: e.table, column: e.column })
			}
			return e
		}
	})
	return Arr.dedupe(
		Arr.flatMap(read, (c) =>
			c.table === undefined
				? [`"${c.column}"`]
				: held.has(c.table)
					? []
					: [`"${c.table}"."${c.column}"`]
		)
	)
}
