/** What session-tables.test.ts reads: its space over a session table's uses, and each case's run on one session. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import {
	blockSize,
	heapTupleHeaderBytes,
	itemIdBytes,
	pageHeaderBytes
} from "#compiler/core/page.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { objectName } from "#compiler/sql/build.ts"
import { printStatement, sessionTableEmptied, sessionTableKeptBytes } from "#compiler/sql/print.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/**
 * How wide a use's values are: narrow, a short text each, stored in the table's heap; or wide, an incompressible text
 * past the size PostgreSQL moves a value out of a row at, stored in its TOAST table (each the hex digits of distinct
 * SHA-256 digests, which pglz finds no repeat in).
 */
type Width = "narrow" | "wide"

/**
 * How many rows a use writes: none, one, or more than the pages the table's emptying keeps hold (sql/print.ts
 * sessionTableKeptBytes), in its heap or its TOAST table.
 */
type Fill = "none" | "one" | "past what it keeps"

/** How a use's transaction ends. */
type End = "commit" | "rollback"

interface Use {
	readonly width: Width
	readonly fill: Fill
	readonly end: End
}

/** A case: the session table's uses in turn on one session. */
export interface Uses {
	readonly uses: ReadonlyArray<Use>
}

export const usesGen: Gen<Uses> = (s) => ({
	uses: s.draw(
		array<Use>(
			(u) => ({
				width: u.draw(element<Width>(["narrow", "wide"])),
				fill: u.draw(element<Fill>(["none", "one", "past what it keeps"])),
				end: u.draw(element<End>(["commit", "rollback"]))
			}),
			{ min: 2, max: 6 }
		)
	)
})

export type SessionTableFeature =
	| "kept its file"
	| "gave its file back"
	| "outgrew its heap"
	| "outgrew its TOAST table"
	| "after a rollback"

/** The SHA-256 digests one wide value concatenates, each 64 hex digits, distinct, so the value has no repeat to compress. */
const wideDigests = 63

/** The bytes of one wide value: its digests' hex digits, more than PostgreSQL keeps in a row, so each is TOASTed. */
const wideValueBytes = wideDigests * 64

/**
 * The rows a use of `width` writes to fill it as `fill` says. Past what it keeps: of narrow rows, one more than the kept
 * pages hold of the least tuple, its header and its line pointer (MaxHeapTuplesPerPage's bound a page, the header
 * unaligned, so at least the bound); of wide rows, one more than the kept pages' bytes of their values, which its TOAST
 * table holds.
 */
const rowsOf = (width: Width, fill: Fill): number => {
	switch (fill) {
		case "none":
			return 0
		case "one":
			return 1
		case "past what it keeps":
			return width === "narrow"
				? (sessionTableKeptBytes / blockSize) *
						Math.floor((blockSize - pageHeaderBytes) / (heapTupleHeaderBytes + itemIdBytes)) +
						1
				: Math.floor(sessionTableKeptBytes / wideValueBytes) + 1
	}
}

/**
 * The session table every use empties, as a rule judge's delta is: a table of the session's own temporary schema, kept
 * by every COMMIT, of two columns, emptied by a session function of its own name whose body is the delta's emptying
 * (sql/print.ts sessionTableEmptied, physical/ddl/rules.ts emptied).
 */
const sessionTable = "__session_table"

/** The session table's CREATE, as a delta's stand-up makes one (physical/ddl/deltas.ts deltaTable). */
const createSql = `CREATE TEMPORARY TABLE pg_temp.${quoteIdent(sessionTable)} (c1 bigint, c2 text COLLATE pg_catalog.pg_c_utf8) ON COMMIT PRESERVE ROWS`

/** The session function that empties the table by its emptying (sql/print.ts sessionTableEmptied). */
const emptyingSql = printStatement({
	kind: "createFunction",
	advice: noAdvice,
	language: "plpgsql",
	name: objectName(temporarySchema, sessionTable),
	params: [],
	returns: "void",
	volatility: "VOLATILE",
	parallel: "UNSAFE",
	security: "DEFINER",
	body: { declare: [], body: [sessionTableEmptied(sessionTable)] }
})

/** A use's rows: c1 its row's number, c2 a short text, or a wide value of distinct SHA-256 digests' hex digits. */
const fillSql = (table: string, width: Width, rows: number): string =>
	width === "narrow"
		? `INSERT INTO pg_temp.${quoteIdent(table)} (c1, c2) SELECT i, 'r' || i FROM pg_catalog.generate_series(1, ${String(rows)}) AS i`
		: `INSERT INTO pg_temp.${quoteIdent(table)} (c1, c2) SELECT i, (SELECT pg_catalog.string_agg(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(i || ':' || j, 'UTF8')), 'hex'), '') FROM pg_catalog.generate_series(1, ${String(wideDigests)}) AS j) FROM pg_catalog.generate_series(1, ${String(rows)}) AS i`

/** The table's file and the bytes its heap and its TOAST table's heap hold, as the session sees them now. */
interface Stood {
	readonly filenode: string
	readonly heap: number
	readonly toast: number
}

/** The table as the session sees it now, or none where no committed use made it. */
const stoodOf = (session: RawSession, table: string) =>
	Effect.map(
		session.values(
			`SELECT pg_catalog.pg_relation_filenode(c.oid)::text, pg_catalog.pg_relation_size(c.oid), COALESCE(pg_catalog.pg_relation_size(c.reltoastrelid), 0) FROM pg_catalog.pg_class AS c WHERE c.oid = pg_catalog.to_regclass(${quoteString(`pg_temp.${quoteIdent(table)}`)})`,
			[]
		),
		(rows): Option.Option<Stood> =>
			Option.map(Arr.head(rows), (row) => ({
				filenode: String(row[0]),
				heap: Number(row[1]),
				toast: Number(row[2])
			}))
	)

class Emptied extends Data.TaggedError("Emptied")<{ readonly message: string }> {}

/**
 * Runs the case's uses of one session table on `session`, after its stand-up in a transaction of its own (the table and
 * its emptying, the session function of its name), each use in a transaction of its own: its emptying, then its rows,
 * then its COMMIT or ROLLBACK. At every emptying: the table holds no row, whatever the use before it wrote and however that use ended; where the use before left its heap
 * and its TOAST table's heap each within the pages its emptying keeps (sql/print.ts sessionTableKeptBytes), it keeps its
 * file, so it sent no invalidation; where either held more, it has a new file, empty; and either way each holds what it
 * keeps at most.
 */
export const runUses = (session: RawSession, k: Uses, c: Case<SessionTableFeature>) =>
	Effect.gen(function* () {
		yield* session.begin
		yield* session.query(createSql, [])
		yield* session.query(emptyingSql, [])
		yield* session.commit
		const emptying = `SELECT pg_temp.${quoteIdent(sessionTable)}()`
		for (const [at, use] of k.uses.entries()) {
			const where = `use ${String(at)} of ${Formatter.format(k)}`
			yield* session.begin
			const before = yield* stoodOf(session, sessionTable)
			yield* session.query(emptying, [])
			const stood = yield* stoodOf(session, sessionTable)
			if (Option.isNone(stood)) {
				return yield* new Emptied({ message: `the stand-up made no session table, ${where}` })
			}
			const after = stood.value
			const held = Number(
				(yield* session.values(
					`SELECT count(*) FROM pg_temp.${quoteIdent(sessionTable)}`,
					[]
				))[0]?.[0]
			)
			if (held !== 0) {
				return yield* new Emptied({ message: `the emptying left ${String(held)} rows, ${where}` })
			}
			if (Option.isSome(before)) {
				const was = before.value
				if (was.heap > sessionTableKeptBytes || was.toast > sessionTableKeptBytes) {
					c.note("gave its file back")
					c.note(was.heap > sessionTableKeptBytes ? "outgrew its heap" : "outgrew its TOAST table")
					if (after.filenode === was.filenode || after.heap !== 0 || after.toast !== 0) {
						return yield* new Emptied({
							message: `a session table past what it keeps (${Formatter.format(was)}) kept its file or a page (${Formatter.format(after)}), ${where}`
						})
					}
				} else {
					c.note("kept its file")
					if (after.filenode !== was.filenode) {
						return yield* new Emptied({
							message: `a session table within what it keeps (${Formatter.format(was)}) got a new file (${Formatter.format(after)}), ${where}`
						})
					}
				}
				if (k.uses[at - 1]?.end === "rollback") {
					c.note("after a rollback")
				}
			}
			if (after.heap > sessionTableKeptBytes || after.toast > sessionTableKeptBytes) {
				return yield* new Emptied({
					message: `the emptying left the session table past what it keeps (${Formatter.format(after)}), ${where}`
				})
			}
			const rows = rowsOf(use.width, use.fill)
			if (rows > 0) {
				yield* session.query(fillSql(sessionTable, use.width, rows), [])
			}
			yield* use.end === "commit" ? session.commit : session.rollback
		}
	})
