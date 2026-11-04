import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { fullSwarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import type { Expr, Select, SelectCore, SetOperand, SqlStatement } from "#compiler/sql/ast.ts"
import { mapTargets, target } from "#compiler/sql/build.ts"
import { bodyPositionNames, renameToPublicHeading } from "#compiler/sql/naming.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { resolveStatement, statementGen } from "#test/support/kernel/sqlgen.ts"
import { auditStatementViolations, auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"

/**
 * Outermost-only public renaming (sql/naming.ts renameToPublicHeading), over generated queries.
 *
 * The rename gives the statement's own output the public heading, position by position, in every arm of a set
 * operation and in an ORDER BY that names the outputs, and touches nothing nested: so the renamed query passes both
 * audits, whose naming rule refuses any nested name that is not a generated c<n>, and its output names are the heading.
 * A heading of another width than the output is refused. Each query is also renamed with its set operation's first
 * arm unaliased where it passes columns through: PostgreSQL names such an output after its column, and an ORDER BY
 * names it so.
 */
const headings = ["id", "Total", "select", "is null", 'say "hi"', "c1", "c 2", "üml"] as const

const admitted = (s: SqlStatement): void => {
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
const passthrough = (q: Select): Select | undefined => {
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
		body: { ...q.body, arms: [unaliased(left), bareRight] },
		orderBy
	}
}

/**
 * What a renamed query was: a core or a set operation, a set operation with its first arm unaliased, and a heading of
 * the wrong width refused.
 */
type RenameFeature = "core" | "set operation" | "passthrough arm" | "wrong width"

/** A generated statement, and the offset its heading starts at in the heading dictionary. */
type Renamed = readonly [SqlStatement, number]

const renamedGen: Gen<Renamed> = (source) =>
	[source.draw(statementGen(sqlCatalog)), source.draw(int(0, headings.length - 1))] as const

/**
 * Planted: a UNION of two cores of one column each, a sketch of the set operation alone and an empty tape, whose first
 * arm passes its columns through, which the drawn statements hold a few times a run.
 */
const keptRenames: ReadonlyArray<Kept<Renamed, RenameFeature>> = [
	{
		note: "a UNION of two one-column cores",
		sketch: [resolveStatement(sqlCatalog, { swarm: fullSwarm(["set operation"]), tape: [] }), 0],
		draws: "",
		reaches: ["passthrough arm"]
	}
]

describe("outermost-only public renaming", () => {
	it.effect(
		"names the output by the heading, in every arm and its ORDER BY, and nothing nested",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/sql/rename",
						draw: drawn(renamedGen),
						literal: Formatter.format,
						coverage: required<RenameFeature>(
							["core", "set operation", "passthrough arm", "wrong width"],
							{ cases: 300, sense: notesOnly }
						),
						kept: keptRenames,
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([statement, offset], c) =>
						Effect.sync(() => {
							if (statement.kind !== "select") {
								return
							}
							const queries = [
								statement,
								...Arr.flatMap([passthrough(statement)], (p) => (p === undefined ? [] : [p]))
							]
							for (const q of queries) {
								admitted(q)
								const width = bodyPositionNames(q.body).length
								const heading = [...headings.slice(offset), ...headings.slice(0, offset)].slice(
									0,
									width
								)
								assert.equal(
									heading.length,
									width,
									"the heading dictionary holds every generated width"
								)
								const renamed = renameToPublicHeading(q, heading)
								if (!renamed.ok) {
									assert.fail(`refused a heading of the output's width: ${renamed.error.message}`)
								}
								admitted(renamed.value)
								assert.deepEqual(bodyPositionNames(renamed.value.body), heading)
								for (const wrong of [heading.slice(1), [...heading, "extra"]]) {
									const refused = renameToPublicHeading(q, wrong)
									assert.equal(!refused.ok && refused.error.reason._tag, "MalformedDescription")
									c.note("wrong width")
								}
								c.note(q.body.kind === "core" ? "core" : "set operation")
								if (q !== statement) {
									c.note("passthrough arm")
								}
							}
						})
				)
			)
	)
})
