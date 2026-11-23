/** What the property of rule-confined.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	derived,
	mutable,
	on,
	relation,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { wholeStatementsOf } from "#test/pg/laws/rule-whole.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { judgedPlans, standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"

/**
 * Nodes of documents of packages, keyed by (pkg, doc, at), a document's name long, so its key's index is the larger;
 * each node's kind is its place, `at`, so (pkg, kind, at) holds every document of a package at one place. Typed holds a
 * kind and a governor per node, and its rows of governor 0, every one here, are contained in Node at its key, kind and
 * governor: a selected side over relations mutable in one declared unit, their package's, so the rule is judged whole
 * (laws/model/plan.ts containmentDischarge, which probes one over immutable relations key by key), a unit a node, where
 * the plain containment would be Node's foreign key; its lookup of a node binds its key from the unit and two fields
 * from Typed's row, as edullm's element_type_in_node bound (package, path, start) and kind and governor while it was
 * judged whole. Placed, every node's (pkg, kind, at), is contained in Gap, mutable in a unit of its own, its package's
 * pack, so the rule reads the rows of two units, two borrows, and is probed, and its probe of Gap's deletes reads Node
 * by (pkg, kind, at), every document of the package at that place: the index the engine creates for it is the one a
 * whole rule's lookup competes with. That index holds kind, one of the lookup's two fields from Typed's row, so
 * governor stays a filter of its scan and PostgreSQL costs the anti join's inner scan once (costsize.c
 * has_indexed_join_quals), the smaller index's against the key's: it takes the smaller.
 */
/** A document's name: up to 256 bytes. */
const Name = str.bytes(256, str.regex("^.*$", "su"))

const Node = relation(
	"Node",
	{ pkg: pg.integer, doc: Name, at: pg.integer, kind: pg.integer, gov: pg.integer, w: pg.integer },
	["pkg", "doc", "at"]
)
const Typed = relation(
	"Typed",
	{ pkg: pg.integer, doc: Name, at: pg.integer, kind: pg.integer, gov: pg.integer },
	["pkg", "doc", "at"]
)
const Gap = relation("Gap", { pack: pg.integer, kind: pg.integer, at: pg.integer }, [
	"pack",
	"kind",
	"at"
])

const Base = schema(
	"rule_confined",
	[Node, Typed, Gap],
	[
		mutable(Gap),
		mutable(Node),
		mutable(Typed),
		contained(
			on(
				select(Typed, (t) => t.eq(t.gov, 0)),
				"pkg",
				"doc",
				"at",
				"kind",
				"gov"
			),
			on(Node, "pkg", "doc", "at", "kind", "gov")
		),
		unit("Package", { pkg: pg.integer }),
		unit("Pack", { pack: pg.integer })
	]
)
const Placed = derived(
	"Placed",
	query(Base).rule((r) => {
		const { pkg, kind, at } = v(Node, "n")
		return r.match(Node, { pkg, kind, at }).find({ pkg, kind, at })
	})
)
const confinedSchema = schema.extend(
	[Base],
	"rule_confined_1",
	[Placed],
	[contained(on(Placed, "pkg", "kind", "at"), on(Gap, "pack", "kind", "at"))]
)

export const confinedTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "rule confined",
	content: { schema: confinedSchema.name, logins: [] },
	versions: [{ schema: confinedSchema, logins: [], declarations: noDeclarations }],
	options: {
		label: "rule_confined",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The places of a document: as many as there are kinds, so a package's documents outnumber none of them. */
const places = 60

/** A case: the packages and the documents of each stored beside the written one, and the statistics. */
export interface Stored {
	readonly packages: number
	readonly documents: number
	readonly statistics: "none" | "analyzed"
}

/** Tens of packages of tens of documents, fewer documents a package than places, so PostgreSQL estimates one row at
 * (pkg, kind, at) where a package's every document stands. */
export const storedGen: Gen<Stored> = (s) => ({
	packages: s.draw(int(20, 40)),
	documents: s.draw(int(20, 40)),
	statistics: s.draw(element(["none", "analyzed"] as const))
})

export type ConfinedFeature = "measured with no statistics" | "measured analyzed"

/** A document's name, long: `document/`, its number in six digits, then 240 x. */
const docName = (d: string): string =>
	`'document/' || lpad((${d})::text, 6, '0') || repeat('x', 240)`

/**
 * One case in its one transaction, which the case's end rolls back: `packages` packages of `documents` lawful documents
 * loaded with the captures off, ANALYZE where the case draws it, then document 0 of package 1 written whole through
 * the captures. Each whole rule's statement is explained over the deltas that hold its rows (test/support/judge.ts
 * judgedPlans), and then the judge runs: every scan of a stored table reads, a loop, the
 * rows of one unit, one node, its output and what its filters removed together, never a node of another document,
 * which a read of Node through an index of (pkg, kind, at) reads, every document of the package at that place.
 */
export const runConfined = (
	installed: Installed,
	connection: PgConnection,
	stored: Stored,
	c: Case<ConfinedFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		const names = namesOf(installed)
		const node = names.table(Node)
		const typed = names.table(Typed)
		const nodeColumns = Arr.join(
			Arr.map(["pkg", "doc", "at", "kind", "gov", "w"] as const, (f) => names.column(Node, f)),
			", "
		)
		const gap = names.table(Gap)
		const gapColumns = Arr.join(
			Arr.map(["pack", "kind", "at"] as const, (f) => names.column(Gap, f)),
			", "
		)
		const typedColumns = Arr.join(
			Arr.map(["pkg", "doc", "at", "kind", "gov"] as const, (f) => names.column(Typed, f)),
			", "
		)
		const series = `generate_series(1, ${stored.packages}) AS p(p), generate_series(1, ${stored.documents}) AS d(d), generate_series(0, ${places - 1}) AS a(a)`
		const written = `generate_series(0, ${places - 1}) AS a(a)`
		const statistics =
			stored.statistics === "analyzed" ? [`ANALYZE ${node}`, `ANALYZE ${typed}`] : []
		for (const sql of [
			`INSERT INTO ${gap} (${gapColumns}) SELECT p, a, a FROM generate_series(1, ${stored.packages}) AS p(p), ${written}`,
			`ALTER TABLE ${node} DISABLE TRIGGER USER`,
			`ALTER TABLE ${typed} DISABLE TRIGGER USER`,
			`INSERT INTO ${node} (${nodeColumns}) SELECT p, ${docName("d")}, a, a, 0, 0 FROM ${series}`,
			`INSERT INTO ${typed} (${typedColumns}) SELECT p, ${docName("d")}, a, a, 0 FROM ${series}`,
			`ALTER TABLE ${node} ENABLE TRIGGER USER`,
			`ALTER TABLE ${typed} ENABLE TRIGGER USER`,
			...statistics,
			"SET CONSTRAINTS ALL DEFERRED",
			`INSERT INTO ${node} (${nodeColumns}) SELECT 1, ${docName("0")}, a, a, 0, 0 FROM ${written}`,
			`INSERT INTO ${typed} (${typedColumns}) SELECT 1, ${docName("0")}, a, a, 0 FROM ${written}`
		]) {
			yield* connection.query(sql, [])
		}
		const storedTables = new Set([node, typed])
		const judged = yield* judgedPlans(
			(sql) => connection.queryValues(sql, []),
			installed.installation,
			wholeStatementsOf(installed.installation)
		)
		for (const { plan } of judged) {
			const scans = Arr.filter(planNodes(plan), (n) =>
				Option.match(n.relation, {
					onNone: () => false,
					onSome: (r) => storedTables.has(`${quoteIdent(names.schema)}.${quoteIdent(r)}`)
				})
			)
			const read = Arr.map(scans, (n) => ({
				node: n.nodeType,
				index: Option.getOrUndefined(n.index),
				loops: n.actualLoops,
				rows: n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck
			}))
			assert.ok(scans.length > 0, "the whole rule's statement reads a stored table")
			assert.ok(
				Arr.every(read, (r) => r.rows <= 1),
				`${Formatter.format(stored)}: each scan of a stored table reads one node a loop, its unit's, beside ${stored.documents} documents of its package at each place: ${Formatter.format(read)}`
			)
		}
		yield* connection.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		c.note(stored.statistics === "none" ? "measured with no statistics" : "measured analyzed")
	})
