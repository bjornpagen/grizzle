/** What the properties of naming.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	bodyPositionNames,
	type Expr,
	type Select,
	type SelectCore,
	type SetOperand,
	type SqlStatement
} from "#compiler/sql/ast.ts"
import { mapTargets, setBodyOf, target, withArms } from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { columnSetOperationGen, statementGen } from "#test/support/kernel/sqlgen.ts"
import { auditStatementViolations, auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"

/**
 * The public headings' names, each an awkward spelling: a capital, a keyword, a space, a quote, a generated name, a
 * letter outside ASCII.
 */
export const headings = [
	"id",
	"Total",
	"select",
	"is null",
	'say "hi"',
	"c1",
	"c 2",
	"üml"
] as const

/** Asserts that both SQL audits admit a statement: the statement audit and the text audit of its print. */
export const admitted = (s: SqlStatement): void => {
	const text = printStatement(s)
	assert.deepEqual(
		Arr.map(auditStatementViolations(s), (v) => `${v.rule}: ${v.detail}`),
		[],
		text
	)
	assert.deepEqual(
		Arr.map(auditTextViolations(text), (v) => `${v.rule}: ${v.detail}`),
		[],
		text
	)
}

/**
 * The query with its set operation's first arm unaliased where every output passes a column through under distinct
 * column names, its ORDER BY naming those columns; undefined when the query has no such arm.
 */
export const passthrough = (q: Select): Select | undefined => {
	if (q.body.kind !== "setOp" || q.body.arms.length !== 2) {
		return undefined
	}
	const [left, right] = q.body.arms
	if (left.kind !== "core") {
		return undefined
	}
	const columns = Arr.map(left.targets, (t) =>
		t.expr.kind === "column" ? t.expr.column : undefined
	)
	const named = Arr.flatMap(columns, (c) => (c === undefined ? [] : [c]))
	if (named.length !== columns.length || new Set(named).size !== named.length) {
		return undefined
	}
	const old = bodyPositionNames(left)
	const orderBy = Arr.map(q.orderBy, (item) => {
		const e = item.expr
		if (e.kind !== "column" || e.table !== undefined) {
			return item
		}
		const column = named[old.indexOf(e.column)]
		const renamed: Expr = column === undefined ? e : { ...e, column }
		return { ...item, expr: renamed }
	})
	const unaliased = (core: SelectCore): SelectCore => mapTargets(core, (t) => target(t.expr))
	const bareRight: SetOperand | undefined =
		right.kind === "core"
			? unaliased(right)
			: right.body.kind === "core"
				? { ...right, body: unaliased(right.body) }
				: undefined
	if (bareRight === undefined) {
		return undefined
	}
	return {
		...q,
		body: setBodyOf(
			withArms(q.body, [unaliased(left), bareRight]),
			"unaliasing a set operation's arms"
		),
		orderBy
	}
}

/**
 * What a renamed query was: a core or a set operation, a set operation with its first arm unaliased, and a heading of
 * the wrong width refused.
 */
export type RenameFeature = "core" | "set operation" | "passthrough arm" | "wrong width"

/** A generated statement, and the offset its heading starts at in the heading dictionary. */
type Renamed = readonly [SqlStatement, number]

/**
 * A statement of the full generator, or, a quarter of the time, a set operation with the value-shaping features off
 * (columnSetOperationGen), about one in four of which has a first arm that passes its columns through: the full
 * generator draws that arm about one statement in two hundred, too rarely for the label-fixed streams to be sure of it.
 */
export const renamedGen: Gen<Renamed> = (source) =>
	[
		source.draw(
			weighted([
				[3, statementGen(sqlCatalog)],
				[1, columnSetOperationGen(sqlCatalog)]
			])
		),
		source.draw(int(0, headings.length - 1))
	] as const
