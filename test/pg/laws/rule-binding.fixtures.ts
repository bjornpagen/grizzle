/** What the property of rule-binding.test.ts reads: its schemas and templates, its space, and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { parsePlan, planNodes, rowsTouched } from "#bench/harness/explain.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, key, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import {
	type JudgedStatement,
	judgedStatementsOf,
	plannedQueryOf,
	raisedRule
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"

/**
 * A package's documents as edullm's qti stores them: each node of a document keyed by its package, its path and its
 * start, its parent's start beside it (qti.node); a reference at a node, naming a resource of its document by its ref
 * (qti.dependency); and a resource's name at its node, distinct in its package (qti.resource_id, "DocumentId key").
 */
const Node = relation(
	"Node",
	{ pkg: pg.integer, path: pg.integer, start: pg.integer, parent: pg.integer },
	["pkg", "path", "start"]
)

const Ref = relation(
	"Ref",
	{ pkg: pg.integer, path: pg.integer, start: pg.integer, ref: pg.integer },
	["pkg", "path", "start"]
)

const Named = relation(
	"Named",
	{ pkg: pg.integer, path: pg.integer, start: pg.integer, name: pg.integer },
	["pkg", "path", "start"]
)

/** How a rule's judge reads what a transaction wrote: by probes over its rows, or whole over the units they hold. */
const judgings = ["probed", "whole"] as const
type Judged = (typeof judgings)[number]

/**
 * The rules each judgment holds, the relations mutable where it probes and immutable where it judges whole, each
 * document a unit of (pkg, path):
 *
 * - Resolved: every reference names a resource of its document, qti's "Dependency target" over DependencyResolved: a
 *   containment of Ref into a derived join of Ref, its node and the resource its ref names, which a probe of Ref's rows
 *   and the whole rule's read of a document both read under a negation, at a reference's (pkg, path, start);
 * - Placed: every resource's parent is a node of its document, a containment of a derived join of Named and its node
 *   into Node, which the whole rule's read of a document joins within it, as "Document lang" joins XmlLang and the
 *   categories naming a document.
 */
const bindingSchema = (judged: Judged) => {
	const name = judged === "probed" ? "ProbedBinding" : "WholeBinding"
	const Base = schema(
		name,
		[Node, Ref, Named],
		[
			key(on(Named, "pkg", "name")),
			...(judged === "probed" ? [mutable(Node), mutable(Ref), mutable(Named)] : [])
		]
	)
	const Resolved = derived(
		"Resolved",
		query(Base).rule((r) => {
			const { pkg, path, ref, start } = v(Ref, "ref")
			const { parent: resource } = v(Node, "node")
			const { start: target } = v(Named, "target")
			return r
				.match(Ref, { pkg, path, ref, start })
				.match(Node, { pkg, parent: resource, path, start })
				.match(Named, { name: ref, pkg, path, start: target })
				.find({ pkg, path, resource, start, target })
		})
	)
	const Placed = derived(
		"Placed",
		query(Base).rule((r) => {
			const { pkg, path, start } = v(Named, "named")
			const { parent } = v(Node, "node")
			return r
				.match(Named, { pkg, path, start })
				.match(Node, { pkg, parent, path, start })
				.find({ pkg, path, start, parent })
		})
	)
	return schema.extend(
		Base,
		`${name}_1`,
		[Resolved, Placed],
		[
			contained(on(Ref, "pkg", "path", "start"), on(Resolved, "pkg", "path", "start")),
			contained(on(Placed, "pkg", "path", "parent"), on(Node, "pkg", "path", "start"))
		]
	)
}

const templateOf = (judged: Judged) => {
	const value = bindingSchema(judged)
	return migratedTemplate({
		declaredIn: import.meta,
		name: `${judged} binding`,
		content: { schema: value.name, logins: [] },
		versions: [{ schema: value, logins: [], declarations: noDeclarations }],
		options: {
			label: `${judged}_binding`,
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})
}

export const wholeBindingTemplate = templateOf("whole")
export const probedBindingTemplate = templateOf("probed")

/** The nodes a document holds, each size twice the one before. */
const sizes = [64, 128, 256] as const

/**
 * The documents stored beside the written ones, in a package of their own, each as large as a written one, loaded with
 * the captures off: tables of thousands of rows, which PostgreSQL reads at a key by an index, where it scans a table of
 * a page or two at every lookup, its scan priced below the index's.
 */
const stored = 40

/**
 * A case: how its rules are judged, its documents and each one's nodes, and the statistics PostgreSQL holds when the
 * judge's statements are planned: none, as in tables filled in the transaction that publishes into them, or the
 * written rows analyzed.
 */
export interface Binding {
	readonly judged: Judged
	readonly documents: 1 | 3
	readonly nodes: (typeof sizes)[number]
	readonly statistics: "none" | "analyzed"
}

export const bindingGen: Gen<Binding> = (s) => ({
	judged: s.draw(element(judgings)),
	documents: s.draw(element([1, 3] as const)),
	nodes: s.draw(element(sizes)),
	statistics: s.draw(element(["none", "analyzed"] as const))
})

export type BindingFeature =
	| "a probed rule's negated join"
	| "a whole rule's negated join"
	| "a whole rule's join within a unit"
	| "planned with no statistics"
	| "planned analyzed"

/**
 * The rows of documents 1 to `documents` of package `pkg`, each of `nodes` nodes: its root at 0 and every other node its
 * child; a resource named at every node but the root, its name its path's and its start's, so distinct in the package;
 * and a reference at each eighth node, naming the resource of the next node in its document. Every rule holds of them.
 */
const documentRows = (
	installed: Installed,
	pkg: number,
	documents: number,
	nodes: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const docs = `generate_series(1, ${documents}) AS d(path)`
	const starts = `generate_series(1, ${nodes - 1}) AS s(start)`
	return [
		`INSERT INTO ${names.table(Node)} (pkg, path, start, parent) SELECT ${pkg}, path, 0, 0 FROM ${docs}`,
		`INSERT INTO ${names.table(Node)} (pkg, path, start, parent) SELECT ${pkg}, path, start, 0 FROM ${docs}, ${starts}`,
		`INSERT INTO ${names.table(Named)} (pkg, path, start, name) SELECT ${pkg}, path, start, path * 1000000 + start FROM ${docs}, ${starts}`,
		`INSERT INTO ${names.table(Ref)} (pkg, path, start, ref) SELECT ${pkg}, path, start, path * 1000000 + start % ${nodes - 1} + 1 FROM ${docs}, ${starts} WHERE start % 8 = 0`
	]
}

/** The rows a case writes through the captures: its documents' nodes, resources and references. */
const writtenRows = (b: Binding): number =>
	b.documents * (2 * b.nodes - 1 + Math.floor((b.nodes - 1) / 8))

/** The deltas a judged statement reads: its tables of pg_temp, each by name once. */
const deltasRead = (statement: JudgedStatement): ReadonlyArray<string> => {
	const names = new Set<string>()
	visitSelect(statement.query, {
		...inertVisitor,
		fromItem: (item) => {
			if (
				item.kind === "table" &&
				typeof item.table !== "string" &&
				item.table.schema === temporarySchema
			) {
				names.add(item.table.name)
			}
		}
	})
	return [...names]
}

/**
 * Whether every delta a judged statement reads stands in the session, as the judge runs it: the judge stands up the
 * deltas a transaction writes and those a whole rule's region reads beside them (physical/ddl/rules.ts partsOf), and a
 * probe of a side no write of the case fills, a delete's, reads a delta that never stood.
 */
const standing = (connection: PgConnection, statement: JudgedStatement) =>
	Effect.map(
		connection.queryValues(
			`SELECT pg_catalog.bool_and(pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'pg_temp', d)) IS NOT NULL)::text FROM pg_catalog.unnest($1::text[]) AS t(d)`,
			[deltasRead(statement)]
		),
		(rows) => rows[0]?.[0] === "true"
	)

/**
 * One case in its one transaction, which the case's end rolls back: `stored` documents of package 2 loaded with the
 * captures off, then the case's documents of package 1 written through the captures, all into tables the transaction
 * filled, ANALYZE where the case draws it, and the judge run, which accepts them; then every statement the judge runs of
 * either rule (`standing`), explained with ANALYZE as PL/pgSQL plans it (test/support/judge.ts plannedQueryOf). Each
 * reads every relation a join of it reads by the columns the rows before it bound, a lookup a row of what the
 * transaction wrote: its rows touched, every row each node of its plan handled over all of its loops, at most its plan's
 * nodes times the rows written, whatever PostgreSQL estimates. A join read under its correlation alone, Resolved's
 * negated Node and Named at (pkg, path) or Placed's Named and Node within a document, is a product PostgreSQL filters
 * after: each reference reads its document's nodes and resources again, and each resource its document's nodes, past
 * the bound once a document holds more nodes than the plan has nodes.
 */
export const runBinding = (
	installed: Installed,
	connection: PgConnection,
	b: Binding,
	c: Case<BindingFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const tables = Arr.map([Node, Ref, Named], (t) => names.table(t))
		const statistics = b.statistics === "analyzed" ? Arr.map(tables, (t) => `ANALYZE ${t}`) : []
		for (const sql of [
			...Arr.map(tables, (t) => `ALTER TABLE ${t} DISABLE TRIGGER USER`),
			...documentRows(installed, 2, stored, b.nodes),
			...Arr.map(tables, (t) => `ALTER TABLE ${t} ENABLE TRIGGER USER`),
			...documentRows(installed, 1, b.documents, b.nodes),
			...statistics,
			"SET CONSTRAINTS ALL IMMEDIATE"
		]) {
			yield* connection.query(sql, [])
		}
		const rows = writtenRows(b)
		const statements = judgedStatementsOf(installed.installation)
		for (const rule of installed.installation.laws.rules) {
			const identity = identifierOf(rule.named)
			const read = Arr.filter(statements, (s) => Option.contains(raisedRule(s), identity))
			assert.ok(read.length > 0, `the judge tests ${identity}`)
			const ran = yield* Effect.filter(read, (s) => standing(connection, s))
			assert.ok(ran.length > 0, `the judge runs a statement of ${identity} over the rows written`)
			for (const statement of ran) {
				const explained = yield* connection.queryValues(
					`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${plannedQueryOf(statement)}`,
					[]
				)
				const plan = succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan
				const nodes = Arr.fromIterable(planNodes(plan)).length
				const touched = rowsTouched(plan)
				assert.ok(
					touched <= nodes * rows,
					`${Formatter.format(b)}: ${identity}'s statement touches ${touched} rows, past its ${nodes} nodes times the ${rows} rows the transaction wrote`
				)
			}
		}
		c.note(b.statistics === "none" ? "planned with no statistics" : "planned analyzed")
		if (b.judged === "probed") {
			c.note("a probed rule's negated join")
		} else {
			c.note("a whole rule's negated join")
			c.note("a whole rule's join within a unit")
		}
	})
