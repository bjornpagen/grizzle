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
import type { ConservativeOptions } from "#compiler/lower/conservative/types.ts"
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
 * pattern's parameter domain), each read through a placeholder cast as its statements cast it, and each relation
 * parameter's refined columns, read through their arrays as a statement reads them and counted, as an entry of the
 * statement that carries it, which nothing reads:
 *
 *   WITH "r9"("c7", "c8") AS (SELECT $1::"<schema>"."__param_code_…"::text AS "c5",
 *          (SELECT count(*) FROM (SELECT pg_catalog.unnest($2::"<schema>"."__param_rows_slug_…"[]::text[]) AS "c3")
 *             AS "r8")::text AS "c6"), ...
 *
 * A placeholder's first use, its cast to its domain, fixes the parameter's type to it as the statement is parsed
 * (PostgreSQL 19 parser/parse_param.c variable_coerce_param_hook), so the server converts each value through the
 * domain's input as it binds the statement (tcop/postgres.c exec_bind_message), whether or not anything evaluates the
 * cast, and a value outside its type is refused naming the parameter's own domain: ParamRejected at the parameter.
 * PostgreSQL plans no CTE no query reads, yet parses it. So the parameters a call is refused for are the ones it
 * declares, never only those its statements' logic still reads. A read's admission is an entry of its one statement
 * (withAdmission); a write's rides the statements its flight may send first (write/program/admission.ts).
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
const admittedTargets = (
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
 * The admission of `params`, checked parameters (checkedParams), as an entry of the statement `cx` lowers (see the
 * header): a CTE under a name of the statement's supply, each of its columns one parameter's reading, which nothing
 * reads.
 */
export const admissionCte = (
	cx: LowerContext,
	params: NonEmptyReadonlyArray<CallerParamDecl>,
	at: string
): Cte => {
	const supply = cx.supply
	const targets = admittedTargets(cx, supply, params, at)
	return {
		name: supply.relation(internal("admission")),
		materialized: undefined,
		query: namedQuery(
			operandSelect(core(targets, [], undefined)),
			targets.map(() => supply.column(internal("admitted parameter")))
		)
	}
}

/** Whether a lowering admits the caller parameters its statement holds no placeholder of (`admissionEntry`): a query's,
 * and a read-back's that leads its write's flight (ReadBackAdmission `own`). */
const admitsItsOwn = (subject: ConservativeOptions["subject"]): boolean =>
	subject.kind === "query" || (subject.kind === "readBack" && subject.admission === "own")

/**
 * The admission of the query `cx` lowers, as an entry of the statement being lowered (admissionCte): of each checked
 * caller parameter (checkedParams) the statement holds no placeholder of, its logic having left it unread (a rule a
 * constant false filter empties, one whose arm the analysis proves empty). A statement holding a placeholder of every
 * checked parameter has none, so its text is the logic's alone. A read-back that leads its write's flight, a ChangeSet
 * of reads alone, admits as a query does (ReadBackAdmission `own`), its write's parameters its own; every other
 * lowering that is no query's has none: a read-back after a statement of its write's own, whose admission binds every
 * parameter in the statement its call sends first, a rule's or a violation's probe, which reads no caller parameter.
 */
const admissionEntry = (cx: LowerContext): Cte | undefined => {
	if (!admitsItsOwn(cx.options.subject)) {
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
	return isNonEmpty(unread)
		? admissionCte(cx, unread, "admission of the query's parameters")
		: undefined
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
