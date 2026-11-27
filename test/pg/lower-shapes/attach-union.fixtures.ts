/** What attach-union.test.ts reads: the schema, its template, the space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { descentsOf, type PlanNode, planNodes, scannedRows } from "#bench/harness/explain.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { fullWorldRole, servedRead, servedRun } from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { beginSerializable } from "#test/support/substrate/session.ts"

/**
 * A package's documents, as edullm's qti.document: each by its package and path. A document references media files of
 * its package by path (Reference, edullm's ReferencePath) and names others as image candidates (Candidate, its
 * CandidatePath), each keyed by the document and the reference's place, and a package's media files are keyed by
 * their path (Media).
 */
const Document = relation("Document", { pkg: pg.integer, path: pg.integer }, ["pkg", "path"])

const Reference = relation(
	"Reference",
	{ pkg: pg.integer, path: pg.integer, at: pg.integer, target: pg.integer },
	["pkg", "path", "at"]
)

const Candidate = relation(
	"Candidate",
	{ pkg: pg.integer, path: pg.integer, at: pg.integer, target: pg.integer },
	["pkg", "path", "at"]
)

const Media = relation("Media", { pkg: pg.integer, path: pg.integer, digest: pg.integer }, [
	"pkg",
	"path"
])

const Files = schema("AttachUnion", [Document, Reference, Candidate, Media], [])

/**
 * A package's documents, each with its files, as edullm's `files` (qti-database app.ts filesOf), the attachment its
 * item reads carry: each media file a document references or names as a candidate, by its path and digest, a union of
 * two rules, each a range of one stored relation by the document's key joined to its package's media.
 */
const documents = query(Files)
	.rule((r) => {
		const { pkg, path } = v(Document, "document")
		return r
			.match(Document, { pkg, path })
			.where(r.eq(pkg, r.param("pkg", pg.integer)))
			.find({ pkg, path })
	})
	.attach(
		"files",
		(document) =>
			query(Files)
				.rule((r) => {
					const { target } = v(Reference, "reference")
					const { digest } = v(Media, "media")
					return r
						.match(Reference, { pkg: document.pkg, path: document.path, target })
						.match(Media, { pkg: document.pkg, path: target, digest })
						.find({ path: target, digest })
				})
				.rule((r) => {
					const { target } = v(Candidate, "candidate")
					const { digest } = v(Media, "media")
					return r
						.match(Candidate, { pkg: document.pkg, path: document.path, target })
						.match(Media, { pkg: document.pkg, path: target, digest })
						.find({ path: target, digest })
				}),
		"array"
	)

/** The schema installed through its first migration, with a reader login whose workload's indexes `documents` earns. */
export const attachUnionTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "attach union",
	fixture: Files,
	programs: { documents },
	contexts: [],
	label: "attach_union",
	ambient: ordinarySession
})

/**
 * A case: how many packages are stored, then how many more, each package's documents and media files, each document's
 * references and candidates, and the package read, among the first stored. A package's media files are at paths 100
 * on, apart from its documents'; reference `i` of document `d` names the file (d + i) mod (media + 2) and candidate `i`
 * the file (d + 2i) mod (media + 2), so some name no media file of the package and some both rules name. A document
 * names no more files by either rule than its package holds, so a document's arm reads at most the package's files of
 * Media, whether it probes one a reference or reads them whole. Hundreds of packages of tens of documents and files
 * spread each arm's relation over many pages, so a scan of it whole costs PostgreSQL more than a descent of its key's
 * index to a document's range, as edullm's 21,893 references and 7,743 media files do; a relation of a page or two it
 * scans whole for each document, at the cost of its range.
 */
export interface Corpus {
	readonly packages: number
	readonly more: number
	readonly documents: number
	readonly media: number
	readonly references: number
	readonly candidates: number
	readonly read: number
}

export const corpusGen: Gen<Corpus> = (s) => {
	const packages = s.draw(int(150, 250))
	return {
		packages,
		more: s.draw(int(300, 500)),
		documents: s.draw(int(20, 40)),
		media: s.draw(int(20, 40)),
		references: s.draw(int(1, 5)),
		candidates: s.draw(int(0, 4)),
		read: s.draw(int(0, packages - 1))
	}
}

export type AttachUnionFeature = "a file both rules name" | "no file both rules name"

/** The files document `d`'s references name, then its candidates', by their place among the package's. */
const referenced = (c: Corpus, d: number): ReadonlyArray<number> =>
	Array.from({ length: c.references }, (_, i) => (d + i) % (c.media + 2))

const candidates = (c: Corpus, d: number): ReadonlyArray<number> =>
	Array.from({ length: c.candidates }, (_, i) => (d + 2 * i) % (c.media + 2))

/** A media file's path, and its digest. */
const mediaPath = (m: number): number => 100 + m

const digestOf = (p: number, m: number): number => 1000 * p + m

/**
 * The statements loading packages `from` to `to`, ordinary writes in a SERIALIZABLE transaction of their own, as a
 * publish writes them whole, then each table vacuumed and analyzed, every page all-visible as autovacuum leaves a stored corpus at rest, so the planner meets
 * one visibility state at both sizes where autovacuum's progress by the read chose it. Reference and Candidate are read
 * by their covering index (path, pkg, target) index-only where their pages are all-visible, two buffers a descent, and
 * by their key with a heap page a row where they are not: the release check at 8d95ede9d read Reference index-only at
 * 226 packages, autovacuum having reached it, 81 buffers, and by its key at 536, 180, 2.2 times as many over a corpus
 * 2.37 times as large, where analyzed alone the case's read touches 142 and 180, and vacuumed 81 and 81.
 */
const loaded = (
	installed: Installed,
	c: Corpus,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const tables = [
		names.table(Document),
		names.table(Reference),
		names.table(Candidate),
		names.table(Media)
	]
	const series = `generate_series(${from}, ${to}) AS g(p), generate_series(0, ${c.documents - 1}) AS h(d)`
	return [
		beginSerializable,
		`INSERT INTO ${names.table(Document)} SELECT p, d FROM ${series}`,
		`INSERT INTO ${names.table(Reference)} SELECT p, d, i, 100 + (d + i) % ${c.media + 2} FROM ${series}, generate_series(0, ${c.references - 1}) AS k(i)`,
		`INSERT INTO ${names.table(Candidate)} SELECT p, d, i, 100 + (d + 2 * i) % ${c.media + 2} FROM ${series}, generate_series(0, ${c.candidates - 1}) AS k(i)`,
		`INSERT INTO ${names.table(Media)} SELECT p, 100 + m, 1000 * p + m FROM generate_series(${from}, ${to}) AS g(p), generate_series(0, ${c.media - 1}) AS k(m)`,
		"COMMIT",
		...Arr.map(tables, (t) => `VACUUM (ANALYZE) ${t}`)
	]
}

/** The package read's files on the host, `<document> <path> <digest>`, each once. */
const expected = (c: Corpus, p: number): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(
			Array.from({ length: c.documents }, (_, d) => d),
			(d) =>
				Arr.map(
					Arr.filter(Arr.dedupe([...referenced(c, d), ...candidates(c, d)]), (m) => m < c.media),
					(m) => `${d} ${mediaPath(m)} ${digestOf(p, m)}`
				)
		),
		Order.String
	)

/** Whether a document of the package names one file by both rules. */
const shared = (c: Corpus): boolean =>
	Arr.some(
		Array.from({ length: c.documents }, (_, d) => d),
		(d) => Arr.some(referenced(c, d), (m) => m < c.media && candidates(c, d).includes(m))
	)

/**
 * The read's one statement for package `p` run under its carried advice once the plan laws hold over it
 * (test/support/advice.ts servedRun), and its answer: each part's rows as the delivery sends them.
 */
const measured = (installed: Installed, connection: PgConnection, p: number) =>
	Effect.gen(function* () {
		const read = yield* servedRead(
			installed,
			fullWorldRole(installed, Files, []),
			documents,
			`the read of package ${p}'s files`
		)
		const plan = yield* servedRun({ values: connection.queryValues }, read, { pkg: p })
		const rows = yield* connection.queryValues(read.statement.sql, read.params({ pkg: p }))
		return { plan, rows }
	})

/**
 * The files of the read's rows, `<document> <path> <digest>`, from the attachment's part as the delivery lays it out
 * (lower/shapes/index.ts): the part's ordinal, the parent key's fields (the document's path and package), then the
 * child's (the parent key again, the file's digest and path), then the row's place.
 */
const answerOf = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<string> => {
	const text = (x: unknown): string => (typeof x === "string" ? x : String(x))
	return Arr.sort(
		Arr.map(
			Arr.filter(rows, (r) => text(r[0]) === "1"),
			(r) => `${text(r[1])} ${text(r[6])} ${text(r[5])}`
		),
		Order.String
	)
}

/**
 * What a plan's scans of `table` did over all their loops: the rows they read (their output and what their filters
 * removed), the buffers they touched, each scan's counters inclusive of its Bitmap Index Scan's, and how many times they
 * descended an index, one a loop.
 */
interface Read {
	readonly rows: number
	readonly buffers: number
	readonly descents: number
}

const readOf = (plan: PlanNode, table: string): Read =>
	Arr.reduce(
		Arr.filter(
			[...planNodes(plan)],
			(n) => Option.contains(n.relation, table) && n.nodeType !== "Bitmap Index Scan"
		),
		{ rows: 0, buffers: 0, descents: 0 },
		(sum, n) => ({
			rows: sum.rows + scannedRows(n),
			buffers: sum.buffers + n.buffers.sharedHit + n.buffers.sharedRead,
			descents: sum.descents + descentsOf(n)
		})
	)

/**
 * Whether the buffers a read's scans touch, `before` at one corpus and `after` at one `growth` times as large, grew by
 * less than half of what a read of the whole corpus's would: under the mean of constant and linear growth, with one
 * buffer more a descent of an index at the larger size besides.
 */
const scaledLess = (before: Read, after: Read, growth: number): boolean =>
	after.buffers <= (before.buffers * (1 + growth)) / 2 + after.descents

/**
 * One case on a fresh clone of the template, which no other case's rows, live or dead, share pages with: `packages`
 * packages loaded by ordinary writes, vacuumed and analyzed (loaded), the read of package `read` explained and run;
 * then `more` packages loaded and the read again. Each time
 * it answers the host's files of every document of the package, and each arm reads only what the package's documents'
 * keys match, whatever else is stored: of Reference and Candidate the documents' own rows, and of Media at most the
 * package's files for each document in each of the two arms. The buffers each arm's relations' scans touch do not grow
 * with what else is stored (scaledLess): never by half as much as the corpus grows, as a scan reading every package's
 * rows would. They are no exact count: an Index Scan touches a heap page once for each row it holds and a Bitmap Heap
 * Scan once, the scan the read's advice names at each size; the leaf pages a scan walks are where the load's page
 * splits fell; and a larger relation's B-tree may add a level above the same leaves, one more buffer a descent.
 */
export const runAttachUnion = (
	installed: Installed,
	connection: PgConnection,
	c: Corpus,
	k: Case<AttachUnionFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const p = 10 + c.read
		const bound: ReadonlyArray<readonly [string, number]> = [
			[names.tableIdent(Reference), c.documents * c.references],
			[names.tableIdent(Candidate), c.documents * c.candidates],
			[names.tableIdent(Media), 2 * c.documents * c.media]
		]
		/** Packages `from` to `to` stored, the read's answer and each arm relation's read at that size. */
		const atSize = (from: number, to: number) =>
			Effect.gen(function* () {
				for (const sql of loaded(installed, c, from, to)) {
					yield* connection.query(sql, [])
				}
				const read = yield* measured(installed, connection, p)
				assert.deepEqual(
					answerOf(read.rows),
					expected(c, p),
					`${Formatter.format(c)}: package ${p}'s files at ${to - 9} packages`
				)
				return Arr.map(bound, ([table, most]) => {
					const done = readOf(read.plan, table)
					assert.ok(
						done.rows <= most,
						`${Formatter.format(c)}: the read of package ${p}'s files reads ${done.rows} rows of ${table} at ${to - 9} packages, of the ${most} its documents' keys match (${done.buffers} buffers)`
					)
					return { table, done }
				})
			})
		const first = yield* atSize(10, 9 + c.packages)
		const second = yield* atSize(10 + c.packages, 9 + c.packages + c.more)
		const growth = (c.packages + c.more) / c.packages
		for (const [before, after] of Arr.zip(first, second)) {
			assert.ok(
				scaledLess(before.done, after.done, growth),
				`${Formatter.format(c)}: the read of package ${p}'s files touches ${after.done.buffers} buffers of ${after.table} at ${c.packages + c.more} packages, ${before.done.buffers} at ${c.packages}, over ${after.done.descents} descents of its indexes: as many as a corpus ${growth.toFixed(2)} times as large would give half its growth`
			)
		}
		k.note(shared(c) ? "a file both rules name" : "no file both rules name")
	})
