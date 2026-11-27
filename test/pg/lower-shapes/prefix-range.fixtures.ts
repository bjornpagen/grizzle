/** What prefix-range.test.ts reads: its schema, its read and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { descentsOf, planNodes } from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { planAsRun } from "#test/support/judge.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import {
	countedAsVacuumed,
	type StatedDistinct,
	statedDistinct
} from "#test/support/substrate/fill.ts"

const i = pg.integer

/**
 * A sitting's served documents and their content, as metis's sitting reads qti-pie's: each document a sitting serves,
 * by the sitting and the document's package and path; each node of a document, keyed by the document and the node's
 * place `start`; and each attribute of a node, keyed by the node and the attribute's predecessor in the node's list.
 */
const Served = relation("Served", { sitting: i, package: i, path: i }, [
	"sitting",
	"package",
	"path"
])
const Node = relation("Node", { package: i, path: i, start: i, kind: i }, [
	"package",
	"path",
	"start"
])
const Attribute = relation(
	"Attribute",
	{ package: i, path: i, start: i, predecessor: i, value: i },
	["package", "path", "start", "predecessor"]
)
const Content = schema("PrefixRange", [Served, Node, Attribute], [])

/**
 * The sitting's content: each node of each document it serves, with each of the node's attributes, at the parameter:
 * in one region, the attributes a step of its chain after the node; or attached to each node, as metis's sitting reads
 * its served items' nodes, the node relation at its key set over the served documents, and each node's attributes per
 * node key.
 */
export type Form = "in one region" | "attached to each node"

const forms = ["in one region", "attached to each node"] as const satisfies ReadonlyArray<Form>

const contentRead = query(Content).rule((r) => {
	const { package: pkg, path } = v(Served, "served")
	const { start, kind } = v(Node, "node")
	const { predecessor, value } = v(Attribute, "attribute")
	return r
		.match(Served, { sitting: r.param("sitting", i), package: pkg, path })
		.match(Node, { package: pkg, path, start, kind })
		.match(Attribute, { package: pkg, path, start, predecessor, value })
		.find({ package: pkg, path, start, kind, predecessor, value })
})

const attachedRead = query(Content)
	.rule((r) => {
		const { package: pkg, path } = v(Served, "served")
		const { start, kind } = v(Node, "node")
		return r
			.match(Served, { sitting: r.param("sitting", i), package: pkg, path })
			.match(Node, { package: pkg, path, start, kind })
			.find({ package: pkg, path, start, kind })
	})
	.attach(
		"attributes",
		(head) =>
			query(Content).rule((r) => {
				const { predecessor, value } = v(Attribute, "attribute")
				return r
					.match(Attribute, {
						package: head.package,
						path: head.path,
						start: head.start,
						predecessor,
						value
					})
					.find({ predecessor, value })
			}),
		"array"
	)

/** The read of a form. */
const readOf = (form: Form) => (form === "in one region" ? contentRead : attachedRead)

/** The schema installed through its first migration, with a reader whose workload's indexes the read earns. */
export const prefixRangeTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "prefix range",
	fixture: Content,
	programs: { contentRead, attachedRead },
	label: "prefix_range",
	ambient: ordinarySession
})

/** How a case's columns' statistics stand: as the stored rows' counts leave them, or stated (fill.ts statedDistinct). */
export type Statistics = "counted" | StatedDistinct

/**
 * A case: the sitting's `documents` served documents, each of `nodes` nodes of `attributes` attributes each, beside
 * `others` documents no sitting of the case serves; then `more` nodes stored in each document before the read is
 * explained again; and how the columns' statistics stand.
 */
export interface PrefixCase {
	readonly form: Form
	readonly documents: number
	readonly nodes: number
	readonly attributes: number
	readonly others: number
	readonly more: number
	readonly statistics: Statistics
}

export const prefixGen: Gen<PrefixCase> = (s) => ({
	form: s.draw(element<Form>(forms)),
	documents: s.draw(int(1, 6)),
	nodes: s.draw(int(2, 8)),
	attributes: s.draw(int(1, 3)),
	others: s.draw(int(0, 20)),
	more: s.draw(int(40, 120)),
	statistics: s.draw(element<Statistics>(["counted", "unique", "one value"]))
})

export type PrefixFeature =
	| Form
	| "one document"
	| "several documents"
	| "under counted statistics"
	| "under statistics stating each value its own"
	| "under statistics stating every row one value"

/** The sitting and the package every document is of. */
const sitting = 1
const pkg = 1

/** The case's tables, quoted. */
const tablesOf = (installed: Installed): ReadonlyArray<string> => {
	const names = namesOf(installed)
	return Arr.map([Served, Node, Attribute], (t) => names.table(t))
}

/**
 * The statements storing nodes `from` to `to` of every document, the sitting's and the others', each node with its
 * attributes; the sitting's served documents where `first`; then each table counted as a VACUUM counts it, and its
 * columns' statistics as the case states them. The sitting's documents are paths 1 to `documents`, the others' past them.
 */
const stored = (
	installed: Installed,
	c: PrefixCase,
	from: number,
	to: number,
	first: boolean
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const documents = `generate_series(1, ${String(c.documents + c.others)}) AS d(p)`
	const nodes = `generate_series(${String(from)}, ${String(to)}) AS n(s)`
	const attributes = `generate_series(0, ${String(c.attributes - 1)}) AS a(q)`
	const tables = tablesOf(installed)
	const statistics = c.statistics
	return [
		...(first
			? [
					`INSERT INTO ${names.table(Served)} (sitting, package, path) SELECT ${String(sitting)}, ${String(pkg)}, p FROM generate_series(1, ${String(c.documents)}) AS d(p)`
				]
			: []),
		`INSERT INTO ${names.table(Node)} (package, path, start, kind) SELECT ${String(pkg)}, p, s, s % 5 FROM ${documents}, ${nodes}`,
		`INSERT INTO ${names.table(Attribute)} (package, path, start, predecessor, value) SELECT ${String(pkg)}, p, s, q, s * 10 + q FROM ${documents}, ${nodes}, ${attributes}`,
		...Arr.map(tables, countedAsVacuumed),
		...(statistics === "counted" ? [] : Arr.map(tables, (t) => statedDistinct(t, statistics)))
	]
}

/**
 * One case in its one transaction, which the case's end rolls back: the documents stored with their nodes and the
 * nodes' attributes, the read of the sitting's content explained; then `more` nodes stored in every document, and the
 * read explained again. Both times the read descends the attributes' indexes at most once for each served document,
 * however many nodes each holds: the nodes the read holds of a document are every node of it, so the document's
 * attributes are one range of the attributes' key, read once, the nodes joined in, where read at each node's key it
 * descends once for each node.
 */
export const runPrefixRange = (
	installed: Installed,
	connection: PgConnection,
	c: PrefixCase,
	k: Case<PrefixFeature>
) =>
	Effect.gen(function* () {
		for (const sql of stored(installed, c, 1, c.nodes, true)) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const template = succeeded(
			compileTemplate(readOf(c.form), undefined, options),
			"the read compiles"
		)
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const params = paramTexts(
			statement,
			{ sitting },
			declaredOf(template, readOf(c.form), undefined, options)
		)
		/** The attributes' table as a plan names it, its bare relation name. */
		const quoted = namesOf(installed).table(Attribute)
		const attribute = regex('\\."([^"]+)"$').exec(quoted)?.[1]
		const descents = Effect.map(planAsRun(connection.queryValues, statement.sql, params), (plan) =>
			Iterator.from(planNodes(plan)).reduce(
				(sum, n) => sum + (Option.getOrUndefined(n.relation) === attribute ? descentsOf(n) : 0),
				0
			)
		)
		const bounded = (nodes: number) =>
			Effect.map(descents, (made) =>
				assert.ok(
					made <= c.documents,
					`${Formatter.format(c)}: the read of the sitting's content beside ${String(nodes)} nodes a document descends the attributes' indexes ${String(made)} times, past its bound ${String(c.documents)} (once a served document)\n${statement.sql}`
				)
			)
		yield* bounded(c.nodes)
		for (const sql of stored(installed, c, c.nodes + 1, c.nodes + c.more, false)) {
			yield* connection.query(sql, [])
		}
		yield* bounded(c.nodes + c.more)
		k.note(c.form)
		k.note(c.documents === 1 ? "one document" : "several documents")
		k.note(
			c.statistics === "counted"
				? "under counted statistics"
				: c.statistics === "unique"
					? "under statistics stating each value its own"
					: "under statistics stating every row one value"
		)
	})
