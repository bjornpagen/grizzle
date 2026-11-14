import { isNonEmpty } from "#compiler/core/nonempty.ts"
import type { CallerParamDecl } from "#compiler/ir/products.ts"
import { arraysSource, relationColumns } from "#compiler/lower/conservative/context.ts"
import type { Expr, Target } from "#compiler/sql/ast.ts"
import {
	arrays,
	cast,
	core,
	countStar,
	operandSelect,
	provedSelect,
	sameTypeRef,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import {
	type AdmissionResult,
	buildStatement,
	ownBuild,
	type WriteContext,
	type WriteStatement
} from "#compiler/write/insert/statement.ts"

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/**
 * The admission of a write's caller parameters `params`, the first statement of its flight: one row of every caller
 * parameter whose type PostgreSQL checks beyond its base (a contract's domain, a pattern's parameter domain), each read
 * through the placeholder its statements read it through, so it is cast as they cast it, and each relation parameter's
 * refined columns, read through their arrays as a statement reads them (sql/print.ts printArrayColumn), counted:
 *
 *   SELECT $1::"<schema>"."__param_code_…"::text AS "c1",
 *          (SELECT count(*) FROM (SELECT pg_catalog.unnest($2::"<schema>"."__param_rows_slug_…"[]::text[]) AS "c3")
 *             AS "r0")::text AS "c2"
 *
 * Each placeholder's first and only use is its cast to its domain, which fixes the parameter's type to it as the
 * statement is parsed (PostgreSQL 19 parser/parse_param.c variable_coerce_param_hook), so the server converts each value
 * through the domain's input as it binds the statement (tcop/postgres.c exec_bind_message), before the statement or any
 * after it runs, and a value outside its type is refused naming the parameter's own domain: ParamRejected at the
 * parameter. A statement after it that fails, one the runtime skips (skipWhenEmpty) and a take bound cast to its base
 * then never meet an unchecked parameter. None where no caller parameter has a check. Its one row carries nothing to
 * decode.
 */
export const buildAdmission = (
	w: WriteContext,
	params: ReadonlyArray<CallerParamDecl>
): WriteStatement<AdmissionResult> | undefined => {
	const at = "admission of the write's parameters"
	const checked = params.flatMap((p): ReadonlyArray<CallerParamDecl> => {
		if (p.kind === "scalar") {
			const domain = w.cx.paramTypeRef(p.type, { kind: "scalar", param: p.id })
			return sameTypeRef(domain, w.cx.baseTypeRef(p.type)) ? [] : [p]
		}
		const heading = p.heading.filter((c) => w.cx.arrayCheck(c.type, p.id, c.name).kind === "domain")
		return isNonEmpty(heading) ? [{ ...p, heading }] : []
	})
	if (!isNonEmpty(checked)) {
		return undefined
	}
	return buildStatement(w, ownBuild, (supply) => {
		const admitted = (expr: Expr): Target =>
			targetAs(cast(expr, types.text), supply.column(internal("admitted parameter")))
		const targets = checked.map((p): Target => {
			if (p.kind === "scalar") {
				return admitted(w.cx.scalarParam(p.id, p.type, at))
			}
			const slots = w.cx.params.relation(p.id, () =>
				relationColumns(
					p.heading,
					() => supply.column(internal("admitted column")),
					(type) => w.cx.baseTypeRef(type),
					(column) => w.cx.arrayCheck(column.type, p.id, column.name)
				)
			)
			const rows = arrays(arraysSource(slots), supply.relation(internal("admitted rows")))
			return admitted({
				kind: "subquery",
				query: operandSelect(core([{ expr: countStar(), alias: undefined }], [rows], undefined))
			})
		})
		return {
			ast: provedSelect("oneRow", targets, [], undefined),
			role: "main",
			result: { kind: "admission" },
			skipWhenEmpty: undefined
		}
	})
}
