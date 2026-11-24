/** What session-tables.test.ts reads: its space over a carrier's uses, and each case's run on one session. */

import { array, boolean, element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import {
	blockSize,
	heapTupleHeaderBytes,
	itemIdBytes,
	pageHeaderBytes
} from "#compiler/core/page.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import type { CreateCarrier } from "#compiler/sql/ast.ts"
import { cUtf8Collation, types } from "#compiler/sql/build.ts"
import { carrierName, carrierScope } from "#compiler/sql/naming.ts"
import { carrierEmptying, printStatement, sessionTableKeptBytes } from "#compiler/sql/print.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/**
 * How wide a use's values are: narrow, a short text each, stored in the carrier's heap; or wide, an incompressible text
 * past the size PostgreSQL moves a value out of a row at, stored in its TOAST table (each the hex digits of distinct
 * SHA-256 digests, which pglz finds no repeat in).
 */
type Width = "narrow" | "wide"

/**
 * How many rows a use writes: none, one, or more than the pages the carrier's emptying keeps hold (sql/print.ts
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

/** A case: the carrier keyed or not, and its uses in turn on one session, from its first, which makes it. */
export interface Uses {
	readonly keyed: boolean
	readonly uses: ReadonlyArray<Use>
}

export const usesGen: Gen<Uses> = (s) => ({
	keyed: s.draw(boolean),
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

/** The carrier every use empties: two columns, a key over the first where the case keys it. */
const carrierOf = (keyed: boolean): CreateCarrier => {
	const columns = [
		{ name: "c1", type: types.bigint, collation: undefined, generated: undefined },
		{ name: "c2", type: types.text, collation: cUtf8Collation, generated: undefined }
	]
	const primaryKey = keyed ? (["c1"] as const) : undefined
	return {
		kind: "createCarrier",
		name: carrierName(carrierScope(undefined), 1, { columns, primaryKey }),
		columns,
		primaryKey
	}
}

/** A use's rows: c1 its row's number, c2 a short text, or a wide value of distinct SHA-256 digests' hex digits. */
const fillSql = (table: string, width: Width, rows: number): string =>
	width === "narrow"
		? `INSERT INTO pg_temp.${quoteIdent(table)} (c1, c2) SELECT i, 'r' || i FROM pg_catalog.generate_series(1, ${String(rows)}) AS i`
		: `INSERT INTO pg_temp.${quoteIdent(table)} (c1, c2) SELECT i, (SELECT pg_catalog.string_agg(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(i || ':' || j, 'UTF8')), 'hex'), '') FROM pg_catalog.generate_series(1, ${String(wideDigests)}) AS j) FROM pg_catalog.generate_series(1, ${String(rows)}) AS i`

/** The carrier's file and the bytes its heap and its TOAST table's heap hold, as the session sees them now. */
interface Stood {
	readonly filenode: string
	readonly heap: number
	readonly toast: number
}

/** The carrier as the session sees it now, or none where no committed use made it. */
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
 * Runs the case's uses of one carrier on `session`, after its stand-up in a transaction of its own (the carrier's table
 * and its emptying, the session function of its name, sql/print.ts carrierEmptying), each use in a transaction of its
 * own: its emptying (sql/ast.ts EmptyCarrier), then its rows, then its COMMIT or ROLLBACK. At every emptying: the
 * carrier holds no row, whatever the use before it wrote and however that use ended; where the use before left its heap
 * and its TOAST table's heap each within the pages its emptying keeps (sql/print.ts sessionTableKeptBytes), it keeps its
 * file, so it sent no invalidation; where either held more, it has a new file, empty; and either way each holds what it
 * keeps at most.
 */
export const runUses = (session: RawSession, k: Uses, c: Case<SessionTableFeature>) =>
	Effect.gen(function* () {
		const carrier = carrierOf(k.keyed)
		yield* session.begin
		yield* session.query(printStatement(carrier), [])
		yield* session.query(printStatement(carrierEmptying(carrier.name)), [])
		yield* session.commit
		const emptying = printStatement({ kind: "emptyCarrier", name: carrier.name })
		for (const [at, use] of k.uses.entries()) {
			const where = `use ${String(at)} of ${Formatter.format(k)}`
			yield* session.begin
			const before = yield* stoodOf(session, carrier.name)
			yield* session.query(emptying, [])
			const stood = yield* stoodOf(session, carrier.name)
			if (Option.isNone(stood)) {
				return yield* new Emptied({ message: `the stand-up made no carrier, ${where}` })
			}
			const after = stood.value
			const held = Number(
				(yield* session.values(
					`SELECT count(*) FROM pg_temp.${quoteIdent(carrier.name)}`,
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
							message: `a carrier past what it keeps (${Formatter.format(was)}) kept its file or a page (${Formatter.format(after)}), ${where}`
						})
					}
				} else {
					c.note("kept its file")
					if (after.filenode !== was.filenode) {
						return yield* new Emptied({
							message: `a carrier within what it keeps (${Formatter.format(was)}) got a new file (${Formatter.format(after)}), ${where}`
						})
					}
				}
				if (k.uses[at - 1]?.end === "rollback") {
					c.note("after a rollback")
				}
			}
			if (after.heap > sessionTableKeptBytes || after.toast > sessionTableKeptBytes) {
				return yield* new Emptied({
					message: `the emptying left the carrier past what it keeps (${Formatter.format(after)}), ${where}`
				})
			}
			const rows = rowsOf(use.width, use.fill)
			if (rows > 0) {
				yield* session.query(fillSql(carrier.name, use.width, rows), [])
			}
			yield* use.end === "commit" ? session.commit : session.rollback
		}
	})
