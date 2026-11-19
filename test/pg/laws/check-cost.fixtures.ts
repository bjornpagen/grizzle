/** What check-cost.test.ts reads: the schema, its template, the space, and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { parsePlan, planNodes, rowsTouched } from "#bench/harness/explain.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { violationCheck } from "#compiler/deploy/render/sql.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { contained, on, relation, schema, select } from "#compiler/public/schema.ts"
import { sqlText, writeDoBlock } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { type Installed, migratedTemplate } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"

/** A package's elements, by package, document and place, each of a kind, as pantry stores QTI content. */
const Node = relation(
	"Node",
	{ pkg: pg.integer, path: pg.integer, at: pg.integer, kind: pg.integer },
	["pkg", "path", "at"]
)

/** A declaration, at the element that declares it. */
const Decl = relation(
	"Decl",
	{ pkg: pg.integer, path: pg.integer, at: pg.integer, w: pg.integer },
	["pkg", "path", "at"]
)

/**
 * Every element of a declaring kind, 1 or 2, is a declaration's: the rule the judge holds, as QTI's
 * __node_kind_in_declaration, whose check a migration runs over every row once.
 */
const Checked = schema(
	"CheckCost",
	[Node, Decl],
	[
		contained(
			on(
				select(Node, (n) => n.or(n.eq(n.kind, 1), n.eq(n.kind, 2))),
				"pkg",
				"path",
				"at"
			),
			on(Decl, "pkg", "path", "at")
		)
	]
)

/** The schema installed through its first migration, its tables empty. */
export const checkCostTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "check cost",
	content: { schema: Checked.name, logins: [] },
	versions: [{ schema: Checked, logins: [], declarations: noDeclarations }],
	options: {
		label: "check_cost",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession
	}
})

/**
 * How the elements are laid out: `spread`, the i-th of n at package i mod 7, document i mod 13 and place i, every
 * second of a declaring kind; `documents`, packages of 20 documents of 50 elements, every 25th and every 31st of a
 * declaring kind.
 */
const layouts = ["spread", "documents"] as const

/** The sizes of the box, in elements, each twice the one before. */
const sizes = [500, 1000, 2000, 4000, 8000, 16000] as const

export interface CheckCase {
	readonly layout: (typeof layouts)[number]
	readonly size: (typeof sizes)[number]
}

/** The box: every layout at every size. */
export const checkCaseGen: Gen<CheckCase> = (s) => ({
	layout: s.draw(element(layouts)),
	size: s.draw(element(sizes))
})

export type CheckFeature = "a law that holds" | "a violation found"

/** The elements of `c` as one INSERT's SELECT over generate_series's i: package, document, place and kind. */
const elementsOf = (c: CheckCase): string => {
	switch (c.layout) {
		case "spread":
			return `SELECT i % 7, i % 13, i, i % 4 FROM pg_catalog.generate_series(1, ${c.size}) AS g(i)`
		case "documents":
			return `SELECT i / 1000, (i / 50) % 20, i % 50, CASE WHEN i % 25 = 0 THEN 1 WHEN i % 31 = 0 THEN 2 ELSE 3 + i % 5 END FROM pg_catalog.generate_series(0, ${c.size - 1}) AS g(i)`
	}
}

/**
 * The statements PostgreSQL plans for a check's block, from its text, each as PL/pgSQL plans it: a PERFORM as the
 * SELECT whose keyword it replaces, for every row (pl_exec.c exec_stmt_perform), an IF's condition as SELECT
 * <condition> (exec_eval_expr), an EXISTS sublink in it for its first row. FOUND, the probe's own flag, reads no table.
 */
const plannedStatements = (text: string): ReadonlyArray<string> =>
	Arr.flatMap(Str.split(text, "\n"), (line) => {
		const statement = Str.trim(line)
		if (Str.startsWith("PERFORM ")(statement) && Str.endsWith(";")(statement)) {
			return [`SELECT ${Str.slice("PERFORM ".length, -1)(statement)}`]
		}
		if (
			Str.startsWith("IF ")(statement) &&
			Str.endsWith(" THEN")(statement) &&
			statement !== "IF FOUND THEN"
		) {
			return [`SELECT ${Str.slice("IF ".length, -" THEN".length)(statement)}`]
		}
		return []
	})

/**
 * One case in its one transaction, which the case's end rolls back: the elements of `c` loaded with the triggers off,
 * a declaration at each of a declaring kind, the tables analyzed; then the rule's check, as the migration that adds the
 * rule runs it (deploy/render/sql.ts violationCheck), each statement it plans explained with ANALYZE, and the block run.
 * Every plan handles each row it reads a bounded number of times: its rows touched (bench/harness/explain.ts rowsTouched,
 * every row each node handled over all its loops, a join's examined pairs among them) at most its nodes times the rows
 * of the two tables, since a filter, a projection, a deduplication, a hash, a sort and a merge pass each row of their
 * input once, and an anti join over sets passes each outer row once and meets each inner row once in its hash or
 * merge. A plan that reads a set again for each row of another, a nested loop over a materialized set, handles the
 * product of the two, past the bound once the outer holds more rows than the plan has nodes. The block raises nothing;
 * then, with one element of a declaring kind and no declaration added, it raises SQLSTATE 23000 under the law's
 * identity.
 */
export const runCheck = (
	installed: Installed,
	connection: PgConnection,
	c: CheckCase,
	k: Case<CheckFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const nodeTable = names.table(Node)
		const declTable = names.table(Decl)
		for (const sql of [
			`ALTER TABLE ${nodeTable} DISABLE TRIGGER USER`,
			`ALTER TABLE ${declTable} DISABLE TRIGGER USER`,
			`INSERT INTO ${nodeTable} ${elementsOf(c)}`,
			`INSERT INTO ${declTable} SELECT pkg, path, at, 0 FROM ${nodeTable} WHERE kind IN (1, 2)`,
			`ANALYZE ${nodeTable}`,
			`ANALYZE ${declTable}`
		]) {
			yield* connection.query(sql, [])
		}
		const counted = yield* connection.queryValues(
			`SELECT (SELECT pg_catalog.count(*) FROM ${nodeTable}) + (SELECT pg_catalog.count(*) FROM ${declTable})`,
			[]
		)
		const rows = Number(defined(counted[0]?.[0], "the two tables' count"))
		const checks = lawChecks(installed.installation)
		assert.equal(checks.rules.length, 1, "the schema's one rule")
		const rule = defined(checks.rules[0], "the rule's check")
		const text = sqlText(SourceLoc("check-cost", []), (out) =>
			writeDoBlock(out, violationCheck(rule.law, rule.query))
		)
		const planned = plannedStatements(text)
		assert.equal(planned.length, 1, "the check plans one statement over the tables")
		for (const statement of planned) {
			const explained = yield* connection.queryValues(
				`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${statement}`,
				[]
			)
			const plan = succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan
			const nodes = Arr.fromIterable(planNodes(plan)).length
			const touched = rowsTouched(plan)
			assert.ok(
				touched <= nodes * rows,
				`${Formatter.format(c)}: the check touches ${touched} rows, past its ${nodes} nodes times the ${rows} rows it reads, ${Formatter.format(Arr.map(Arr.fromIterable(planNodes(plan)), (n) => n.nodeType))}`
			)
		}
		yield* connection.query(text, [])
		k.note("a law that holds")
		yield* connection.query(`INSERT INTO ${nodeTable} VALUES (1000000, 0, 0, 1)`, [])
		const refused = yield* Effect.flip(connection.query(text, []))
		const fields = pgErrorFields(refused)
		assert.equal(
			fields?.code,
			"23000",
			`${Formatter.format(c)}: the check refuses the undeclared element`
		)
		assert.equal(fields?.constraint, rule.law, `${Formatter.format(c)}: under the law's identity`)
		k.note("a violation found")
	})
