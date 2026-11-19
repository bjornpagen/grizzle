/** What check-cost.test.ts reads: the schema, its template, the space, and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { findNodes, parsePlan, planNodes, rowsTouched } from "#bench/harness/explain.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { violationCheck } from "#compiler/deploy/render/sql.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { type FromSource, isSetQuery, type Select, type SelectCore } from "#compiler/sql/ast.ts"
import { sqlText, writeDoBlock } from "#compiler/sql/print.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"

/** A package's elements, by package, document and place, each of a kind, as pantry stores QTI content. */
const Node = relation(
	"Node",
	{
		pkg: pg.integer,
		path: pg.integer,
		at: pg.integer,
		kind: pg.integer,
		tag: pg.integer,
		grp: pg.integer,
		band: pg.integer
	},
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
 * __node_kind_in_declaration, whose check a migration runs over every row once. And every element of tag, group and
 * band 5 is one's, a selection over three columns that every element holds alike, which PostgreSQL estimates as the
 * product of the three, as QTI's __attribute_lexical_document_type_kind_name_in, whose name, kind and document type
 * it estimated at one row of 15,035.
 */
const Base = schema(
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
		),
		contained(
			on(
				select(Node, (n) => n.and(n.eq(n.tag, 5), n.eq(n.grp, 5), n.eq(n.band, 5))),
				"pkg",
				"path",
				"at"
			),
			on(Decl, "pkg", "path", "at")
		)
	]
)

/** Each declared element with its declaration's weight: Node joined to Decl at its place, as QTI's ChoiceNode. */
const Declared = derived(
	"Declared",
	query(Base).rule((r) => {
		const { pkg, path, at, kind } = v(Node, "n")
		const { w } = v(Decl, "d")
		return r
			.match(Node, { pkg, path, at, kind })
			.match(Decl, { pkg, path, at, w })
			.find({ pkg, path, at, kind, w })
	})
)

/**
 * And no two declared elements of one document and kind share a weight: a key over a join of two stored relations
 * whose terms read both, as QTI's __choice_node_key_package_path_kind_identifier, whose check derived choice ⋈ node
 * twice when it was a self-join of the side.
 */
const Checked = schema.extend(
	Base,
	"CheckCost_1",
	[Declared],
	[key(on(Declared, "pkg", "path", "kind", "w"))]
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
		ambient: ordinarySession,
		review: noPlaceholders
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

/**
 * The elements of `c` as one INSERT's SELECT over generate_series's i: package, document, place, kind, and its tag,
 * group and band, each i mod 20.
 */
const elementsOf = (c: CheckCase): string => {
	switch (c.layout) {
		case "spread":
			return `SELECT i % 7, i % 13, i, i % 4, i % 20, i % 20, i % 20 FROM pg_catalog.generate_series(1, ${c.size}) AS g(i)`
		case "documents":
			return `SELECT i / 1000, (i / 50) % 20, i % 50, CASE WHEN i % 25 = 0 THEN 1 WHEN i % 31 = 0 THEN 2 ELSE 3 + i % 5 END, i % 20, i % 20, i % 20 FROM pg_catalog.generate_series(0, ${c.size - 1}) AS g(i)`
	}
}

/** The columns of a derived table a core reads, as `<alias>.<column>`, where its query is a set; none for any other source. */
const setColumns = (source: FromSource): ReadonlyArray<string> =>
	source.kind === "derived" && isSetQuery(source.query)
		? Arr.map(source.columns, (column) => `${source.alias}.${column}`)
		: []

/**
 * The deduplications of `query` that a set makes needless: each SELECT DISTINCT whose every source is a derived table of
 * a set, and whose targets read every column of each as it is, so that no two rows it reads deliver one row.
 */
const needlessDeduplications = (query: Select): ReadonlyArray<SelectCore> => {
	const needless: Array<SelectCore> = []
	transformSelect(query, {
		...identityHooks,
		core: (c) => {
			const sources = Arr.flatMap(c.from, (item) =>
				item.kind === "joins" ? [item.first, ...Arr.map(item.steps, (step) => step.source)] : [item]
			)
			const read = new Set(
				Arr.flatMap(c.targets, (t) =>
					t.expr.kind === "column" && t.expr.table !== undefined
						? [`${t.expr.table}.${t.expr.column}`]
						: []
				)
			)
			if (
				c.distinct === true &&
				sources.length > 0 &&
				Arr.every(sources, (source) => {
					const columns = setColumns(source)
					return columns.length > 0 && Arr.every(columns, (column) => read.has(column))
				})
			) {
				needless.push(c)
			}
			return c
		}
	})
	return needless
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
 * a declaration at each of a declaring kind or of tag 5, weighed by its place, the tables analyzed; then the rule's
 * check, as the migration that adds the rule runs it (deploy/render/sql.ts violationCheck), each statement it plans
 * explained with ANALYZE, and the block run. The rules' checks are each planned and run so. Every plan reads each table
 * by one node, so it derives no relation twice, and handles each row it reads a bounded number of times: its rows
 * touched (bench/harness/explain.ts rowsTouched, every row each node handled over all its loops, a join's examined
 * pairs among them) at most its nodes times the rows of the two tables, since a filter, a projection, a deduplication,
 * a hash, a sort and a merge pass each row of their input once, and an anti join over sets passes each outer row once
 * and meets each inner row once in its hash or merge. A plan that reads a set again for each row of another, a nested
 * loop over a materialized set, handles the product of the two, past the bound once the outer holds more rows than the
 * plan has nodes. The block raises nothing; then, with one element of a declaring kind and of tag, group and band 5 and
 * no declaration added, and two declared elements of one document and kind of one weight, each raises SQLSTATE 23000
 * under its law's identity.
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
			`INSERT INTO ${declTable} SELECT pkg, path, at, at FROM ${nodeTable} WHERE kind IN (1, 2) OR tag = 5`,
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
		assert.equal(checks.rules.length, 3, "the schema's three rules")
		for (const rule of checks.rules) {
			assert.equal(
				needlessDeduplications(rule.query).length,
				0,
				`${rule.law}: the check deduplicates no set it reads whole`
			)
		}
		const blocks = Arr.map(checks.rules, (rule) => ({
			law: rule.law,
			text: sqlText(SourceLoc("check-cost", []), (out) =>
				writeDoBlock(out, violationCheck(rule.law, rule.query))
			)
		}))
		for (const { text } of blocks) {
			const planned = plannedStatements(text)
			assert.equal(planned.length, 1, "a check plans one statement over the tables")
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
				const scans = Arr.flatMap(
					findNodes(plan, (n) => Option.isSome(n.relation) && n.nodeType !== "Bitmap Index Scan"),
					(n) => Option.toArray(n.relation)
				)
				assert.deepEqual(
					scans,
					Arr.dedupe(scans),
					`${Formatter.format(c)}: the check reads each table once`
				)
			}
			yield* connection.query(text, [])
		}
		k.note("a law that holds")
		for (const sql of [
			`INSERT INTO ${nodeTable} VALUES (1000000, 0, 0, 1, 5, 5, 5), (1000000, 0, 1, 1, 0, 0, 0), (1000000, 0, 2, 1, 0, 0, 0)`,
			`INSERT INTO ${declTable} VALUES (1000000, 0, 1, 7), (1000000, 0, 2, 7)`
		]) {
			yield* connection.query(sql, [])
		}
		for (const { law, text } of blocks) {
			const refused = yield* Effect.flip(connection.query(text, []))
			const fields = pgErrorFields(refused)
			assert.equal(
				fields?.code,
				"23000",
				`${Formatter.format(c)}: the check refuses the undeclared element`
			)
			assert.equal(fields?.constraint, law, `${Formatter.format(c)}: under the law's identity`)
		}
		k.note("a violation found")
	})
