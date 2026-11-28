/** What row-sites.test.ts reads: its schema, its two reads of one fold, its facts and the plans' counts. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { ExecutedPlan, ExecutedStatement } from "#adapter/types/db.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/** An owner's one document, by its id. */
export const Owner = relation("Owner", { id: int4, doc: int4 }, ["id"])
/** An item's pins, each at a place, each naming a document: several places of one item may name one document. */
export const Pin = relation("Pin", { item: int4, at: int4, doc: int4 }, ["item", "at"])
/** A document's notes. */
export const Note = relation("Note", { doc: int4, k: int4 }, ["doc", "k"])
/** The notes flagged: none the store holds, so every note is unflagged. */
export const Flag = relation("Flag", { doc: int4, k: int4 }, ["doc", "k"])
export const Sites = schema("RowSites", [Owner, Pin, Note, Flag], [])

/** Each document's count of notes: a fold of Note by its document, which a read derives where it reads it. */
const perDoc = query(Sites).rule((r) => {
	const { doc, k } = v(Note, "note")
	return r.match(Note, { doc, k }).find({ doc, n: r.count() })
})

/** The notes no flag holds: a live derivation of two sources, a note's existence test against Flag. */
const unflagged = query(Sites).rule((r) => {
	const { doc, k } = v(Note, "note")
	return r.match(Note, { doc, k }).where(r.not(Flag, { doc, k })).find({ doc, k })
})

/** The fold at the document of the owner a parameter keys: one row before the fold, its key. */
const byOwner = query(Sites).rule((r) => {
	const { doc } = v(Owner, "owner")
	const { n } = v(perDoc, "fold")
	return r
		.match(Owner, { id: r.param("id", int4), doc })
		.match(perDoc, { doc, n })
		.find({ doc, n })
})

/** The fold at the document of each pin of the item a parameter names: rows before the fold that repeat a document. */
const byPins = query(Sites).rule((r) => {
	const { at, doc } = v(Pin, "pin")
	const { n } = v(perDoc, "fold")
	return r
		.match(Pin, { item: r.param("item", int4), at, doc })
		.match(perDoc, { doc, n })
		.find({ at, doc, n })
})

/** The unflagged notes of the documents of an item's pins, each pin naming a document of its own. */
const unflaggedByPins = query(Sites).rule((r) => {
	const { at, doc } = v(Pin, "pin")
	const { k } = v(unflagged, "note")
	return r
		.match(Pin, { item: r.param("item", int4), at, doc })
		.match(unflagged, { doc, k })
		.find({ at, doc, k })
})

const programs = { byOwner, byPins, unflaggedByPins } as const

export const sitesInstall = { label: "rowsites", programs } as const

/** Sites installed once per member (reads/support.ts fixtureTemplate), which each case's own clone holds. */
export const sitesTemplate = fixtureTemplate(import.meta, Sites, sitesInstall)

/**
 * How a read reaches a derivation: the fold at the document of the one owner its id keys, a row in hand; the fold at
 * the documents of an item's pins, each of `documents` named by `pins / documents` of its places; or the unflagged
 * notes at the documents of an item's `pins` pins, each a document of its own.
 */
export type RowSitesCase =
	| { readonly kind: "a row in hand" }
	| {
			readonly kind: "rows that repeat a document"
			readonly pins: number
			readonly documents: number
	  }
	| { readonly kind: "rows of distinct documents"; readonly pins: number }

export const rowSitesGen: Gen<RowSitesCase> = element<RowSitesCase>([
	{ kind: "a row in hand" },
	{ kind: "rows that repeat a document", pins: 12, documents: 3 },
	{ kind: "rows of distinct documents", pins: 3 }
])

/** The documents the store holds, the read's few among them. */
const documents = 40

/** The notes each document holds. */
export const notesPerDoc = 4

/**
 * The store: two owners, item 1's pins over the case's documents, item 2's over others and item 3's each a document of
 * its own, each document's notes, and no flag.
 */
export const rowSitesFacts = (c: RowSitesCase): FactSet => {
	const pins = c.kind === "rows that repeat a document" ? c.pins : 1
	const named = c.kind === "rows that repeat a document" ? c.documents : 1
	const distinct = c.kind === "rows of distinct documents" ? c.pins : 1
	return {
		Owner: [
			{ id: 1, doc: 1 },
			{ id: 2, doc: 5 }
		],
		Pin: [
			...Array.from({ length: pins }, (_, i) => ({
				item: 1,
				at: i + 1,
				doc: ((i + 1) % named) + 1
			})),
			...Array.from({ length: 8 }, (_, i) => ({ item: 2, at: i + 1, doc: 21 + i })),
			...Array.from({ length: distinct }, (_, i) => ({ item: 3, at: i + 1, doc: i + 1 }))
		],
		Note: Array.from({ length: documents * notesPerDoc }, (_, i) => ({
			doc: Math.floor(i / notesPerDoc) + 1,
			k: (i % notesPerDoc) + 1
		})),
		Flag: []
	}
}

/** Every node of an executed plan, the root first. */
const nodesOf = (plan: ExecutedPlan): ReadonlyArray<ExecutedPlan> => [
	plan,
	...Arr.flatMap(plan.children, nodesOf)
]

/** The scans of `relation` a statement's plan holds, its table's or one of its indexes', a bitmap's index scan none. */
const scansOf = (statement: ExecutedStatement, relation: string): ReadonlyArray<ExecutedPlan> =>
	Arr.filter(
		nodesOf(statement.plan),
		(n) => n.on.kind !== "none" && n.on.relation === relation && n.node !== "Bitmap Index Scan"
	)

/**
 * What the read's plans did with a relation: how many scans of it they hold, how many times those scans ran, and the
 * rows they returned over every run.
 */
export const relationWork = (
	statements: ReadonlyArray<ExecutedStatement>,
	relation: string
): { readonly scans: number; readonly runs: number; readonly rows: number } => {
	const scans = Arr.flatMap(statements, (s) => scansOf(s, relation))
	return {
		scans: scans.length,
		runs: Arr.reduce(scans, 0, (sum, n) => sum + n.actual.loops),
		rows: Arr.reduce(scans, 0, (sum, n) => sum + n.actual.rows * n.actual.loops)
	}
}
