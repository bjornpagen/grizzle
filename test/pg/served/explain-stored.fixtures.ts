/** What the property of explain-stored.test.ts reads: its schema, its program, its template and its space. */

import { int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, unit } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import type { PgConnection } from "#test/support/pg.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A login reading a stored derived relation: the base holds Item(doc, at, n), keyed by the document then the place, in
 * the unit of its document, and Kept a level above it, each item's value of at least 0 at its place, a definition
 * local to Document that reads one row of Item at each of its keys, so the installation stores it in a table of its
 * own, which grizzle keeps equal to its definition at every COMMIT (analysis/derived/storage.ts), and a read of it reads
 * that table. Its selection makes it no copy of Item: a relation of one relation's own rows projected onto a key of it,
 * under no condition, is live, its reason `copy` (storage.ts copiedRelation, 4b89fcc399, lane STOREDERIVE4), read
 * through Item's own key index, and a read of it names no table of its own. The login's one program, `kept`, reads
 * Kept's places and values of document `doc`.
 */

const Item = relation("Item", { doc: pg.integer, at: pg.integer, n: pg.integer }, ["doc", "at"])

const Document = unit("Document", { doc: pg.integer })

/** The schema under `name`: Item under Document, and Kept over Item a level above it. */
const levelsOf = (name: string) => {
	const base = schema(name, [Item], [Document])
	const Kept = derived(
		"Kept",
		query(base).rule((r) => {
			const { doc, at, n } = v(Item, "item")
			return r.match(Item, { doc, at, n }).where(r.ge(n, 0)).find({ doc, at, v: n })
		})
	)
	return { top: schema.extend([base], `${name}_t`, [Kept], []), Kept }
}

/** The login's program over the schema under `name`: Kept's places and values of document `doc`. */
export const programsOf = (name: string) => {
	const { top, Kept } = levelsOf(name)
	return {
		kept: query(top).rule((r) => {
			const { at, v: value } = v(Kept, "kept")
			return r.match(Kept, { doc: r.param("doc", pg.integer), at, v: value }).find({ at, v: value })
		})
	}
}

/** The installation, a template each case clones. */
export const keptTemplate: SubstrateTemplate<Generated> = generatedTemplate({
	declaredIn: import.meta,
	name: "explain_stored",
	content: { programs: ["kept"] },
	build: (name) => {
		const { top } = levelsOf(name)
		return { schema: top, logins: [fullWorld(top, programsOf(name), []).server] }
	},
	ambient: ordinarySession
})

/** The served world over the installation's declared name. */
export const worldOf = (declared: string) =>
	fullWorld(levelsOf(declared).top, programsOf(declared), [])

/** How many places document 1 holds: none, one or two. */
export const places = int(0, 2)

/** The document a call reads. */
export const doc = 1

/** Document 1's `n` places and document 2's one, each place's value ten times it. */
export const factsOf = (n: number) => ({
	Item: [
		...Array.from({ length: n }, (_, i) => ({ doc, at: i + 1, n: (i + 1) * 10 })),
		{ doc: 2, at: 1, n: 10 }
	]
})

/** The names of the indexes PostgreSQL holds on the table `table` of the schema `schema`, in code-unit order. */
export const catalogIndexes = (admin: PgConnection, schema: string, table: string) =>
	Effect.map(
		admin.query(
			"SELECT i.relname AS name FROM pg_catalog.pg_index AS x JOIN pg_catalog.pg_class AS t ON t.oid = x.indrelid JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace JOIN pg_catalog.pg_class AS i ON i.oid = x.indexrelid WHERE n.nspname = $1 AND t.relname = $2",
			[schema, table]
		),
		(answered) =>
			Arr.sort(
				Arr.map(answered.rows, (row) => String(row["name"])),
				Order.String
			)
	)
