import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { type CallerParamDecl, callerParams } from "#compiler/ir/products.ts"
import {
	arraysSource,
	type LowerContext,
	relationColumns,
	withLeading
} from "#compiler/lower/conservative/context.ts"
import type { Cte, Expr, Select, Target } from "#compiler/sql/ast.ts"
import {
	arrays,
	cast,
	core,
	countStar,
	operandSelect,
	sameTypeRef,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { namedQuery, type NameSupply } from "#compiler/sql/naming.ts"

/**
 * A call's admission: every caller parameter whose type PostgreSQL checks beyond its base (a contract's domain, a
 * pattern's parameter domain), each read through the placeholder its statements read it through, so it is cast as they
 * cast it, and each relation parameter's refined columns, read through their arrays as a statement reads them and
 * counted:
 *
 *   SELECT $1::"<schema>"."__param_code_…"::text AS "c1",
 *          (SELECT count(*) FROM (SELECT pg_catalog.unnest($2::"<schema>"."__param_rows_slug_…"[]::text[]) AS "c3")
 *             AS "r0")::text AS "c2"
 *
 * A placeholder's first use, its cast to its domain, fixes the parameter's type to it as the statement is parsed
 * (PostgreSQL 19 parser/parse_param.c variable_coerce_param_hook), so the server converts each value through the
 * domain's input as it binds the statement (tcop/postgres.c exec_bind_message), whether or not anything evaluates the
 * cast, and a value outside its type is refused naming the parameter's own domain: ParamRejected at the parameter. So
 * the parameters a call is refused for are the ones it declares, never only those its statements' logic still reads.
 * A write's admission is the first statement of its flight (write/admission/statement.ts); a read's is an entry of its
 * one statement (withAdmission).
 */

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/**
 * The caller parameters of `params` whose type PostgreSQL checks beyond its base: a scalar whose checked type is not
 * its base, and a relation parameter of a refined column, with its refined columns alone.
 */
export const checkedParams = (
	cx: LowerContext,
	params: ReadonlyArray<CallerParamDecl>
): ReadonlyArray<CallerParamDecl> =>
	params.flatMap((p): ReadonlyArray<CallerParamDecl> => {
		if (p.kind === "scalar") {
			const domain = cx.paramTypeRef(p.type, { kind: "scalar", name: p.id })
			return sameTypeRef(domain, cx.baseTypeRef(p.type)) ? [] : [p]
		}
		const heading = p.heading.filter((c) => cx.arrayCheck(c.type, p.id, c.name).kind === "domain")
		return isNonEmpty(heading) ? [{ ...p, heading }] : []
	})

/**
 * Each of `params`, checked parameters (checkedParams), read once in the statement `cx` lowers, as text: a scalar
 * through its placeholder, a relation parameter's rows counted through its arrays, each cast to its column's check.
 */
export const admittedTargets = (
	cx: LowerContext,
	supply: NameSupply,
	params: NonEmptyReadonlyArray<CallerParamDecl>,
	at: string
): NonEmptyReadonlyArray<Target> => {
	const admitted = (expr: Expr): Target =>
		targetAs(cast(expr, types.text), supply.column(internal("admitted parameter")))
	return mapNonEmpty(params, (p): Target => {
		if (p.kind === "scalar") {
			return admitted(cx.scalarParam(p.id, p.type, at))
		}
		const slots = cx.params.relation(p.id, () =>
			relationColumns(
				p.heading,
				() => supply.column(internal("admitted column")),
				(type) => cx.baseTypeRef(type),
				(column) => cx.arrayCheck(column.type, p.id, column.name)
			)
		)
		const rows = arrays(arraysSource(slots), supply.relation(internal("admitted rows")))
		return admitted({
			kind: "subquery",
			query: operandSelect(core([{ expr: countStar(), alias: undefined }], [rows], undefined))
		})
	})
}

/**
 * The admission of the query `cx` lowers, as an entry of the statement being lowered: a CTE reading each checked
 * caller parameter (checkedParams) the statement holds no placeholder of, its logic having left it unread (a rule a
 * constant false filter empties, one whose arm the analysis proves empty), which nothing reads. PostgreSQL plans no
 * CTE no query reads, yet parses it, so the call is refused for such a parameter exactly as for one its logic reads
 * (see the header). A statement holding a placeholder of every checked parameter has none, so its text is the logic's
 * alone; so has a lowering that is no query's: a read-back's, whose write's admission binds every parameter first, a
 * rule's or a violation's probe, which reads no caller parameter.
 */
const admissionEntry = (cx: LowerContext): Cte | undefined => {
	if (cx.options.subject.kind !== "query") {
		return undefined
	}
	const held = new Set(
		cx.params.slots.flatMap((slot) =>
			slot.kind === "scalar" || slot.kind === "relation" ? [slot.param] : []
		)
	)
	const unread = checkedParams(
		cx,
		callerParams(cx.options.params).filter((p) => !held.has(p.id))
	)
	if (!isNonEmpty(unread)) {
		return undefined
	}
	const supply = cx.supply
	const targets = admittedTargets(cx, supply, unread, "admission of the query's parameters")
	return {
		name: supply.relation(internal("admission")),
		materialized: undefined,
		query: namedQuery(
			operandSelect(core(targets, [], undefined)),
			targets.map(() => supply.column(internal("admitted parameter")))
		)
	}
}

/**
 * `query`, the statement being lowered by `cx`, delivered with its admission (admissionEntry) first among its WITH
 * entries; unchanged where it has none.
 */
export const withAdmission = (cx: LowerContext, query: Select): Select => {
	const entry = admissionEntry(cx)
	if (entry === undefined) {
		return query
	}
	return withLeading(query, [entry])
}
