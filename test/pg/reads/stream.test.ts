/**
 * A read's rows stream: a read whose program delivers its rows by one statement (reader/run.ts Emission) hands each row
 * to its stream the moment the row is whole, so its first upsert reaches the stream's consumer while the rows after it
 * are still arriving (reader/stream.ts readStream), and its events are its reset, an upsert of each of its rows, and one
 * ready.
 *
 * Each case replaces the rows of one table, n rows each holding a text of a drawn width, an answer of several times
 * the 64 KiB a Node socket reads at once, so the driver parses the first rows in one socket read and the last in a
 * later one. The read's own decoder (reader/stream.ts ReadCall.decode) counts the rows it decoded, and the consumer
 * records that count at the first upsert it receives.
 *
 * - Property: the first event is the reset naming the read's key fields; the first upsert reaches the consumer before
 *   the read's last row is decoded; the upserts are exactly the table's rows, each once; and the last event is one
 *   ready.
 * - Oracle: the rows the case inserted, and the count on the read's own decoder.
 * - Features: a read of tens of rows across several socket reads, by construction.
 * - Plants (~/.cache/grizzle-release/LIVE-WATCH/plants): stream-buffer-whole-result.patch (readStream hands its rows
 *   to the stream only once the flight answered) and stream-drop-reset.patch (readStream sends no reset) each turn the
 *   property red.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Stream, String as Str } from "effect"
import { readCallOf } from "#adapter/db/handles.ts"
import { type DecodedRow, type ReadCall, readStream, setEvents } from "#adapter/reader/stream.ts"
import type { SetEvent } from "#compiler/live/index.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Note = relation("Note", { id: pg.integer, body: str.regex("^[a-z]*$") }, ["id"])
const Notes = schema("Notes", { Note }, [])

/**
 * The bytes a Node socket reads at once: libuv's read buffer, 64 KiB, which a stream answer longer than it arrives in
 * several reads of.
 *
 * @formatConstant libuv's per-read buffer for a TCP stream, 65536 bytes
 */
const socketRead = 65_536

/** A case: n rows, each a text of `width` characters. */
interface Case {
	readonly n: number
	readonly width: number
}

/** Tens of rows, each wide enough that the answer spans at least three socket reads. */
const caseGen: Gen<Case> = (source) => ({
	n: source.draw(int(24, 48)),
	width: source.draw(int(socketRead / 8, socketRead / 4))
})

/** The row of id `id` in a case of `width`: its text a letter of its own, `width` times. */
const rowOf = (id: number, width: number): { readonly id: number; readonly body: string } => ({
	id,
	body: Str.repeat(width)(String.fromCharCode(97 + (id % 26)))
})

/** What a consumer of a read's events saw: their kinds in order, its upserts' rows, and the decode count at the first. */
interface Seen {
	readonly kinds: Array<SetEvent<DecodedRow>["kind"]>
	readonly rows: Array<DecodedRow>
	readonly resetKey: Array<ReadonlyArray<string>>
	firstAt: number
}

layer(Substrate.layer, { excludeTestServices: true })("a read's rows", (it) => {
	it.effect(
		"stream: its first upsert reaches the consumer before its last row is decoded, and its events are its reset, its rows and one ready",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const opened = yield* installed(
						Notes,
						{},
						{ label: "stream", extensions: [], programs: {} }
					)
					const names = namesOf(opened.installed)
					const insert = `INSERT INTO ${names.table(Note)} (${names.column(Note, "id")}, ${names.column(Note, "body")}) VALUES ($1::int4, $2::text)`
					const all = query(opened.schema).rule((r) => {
						const { id, body } = v(Note, "note")
						return r.match(Note, { id, body }).find({ id, body })
					})
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "the rows the case inserted, and the count on the read's own decoder"
							},
							suite: "pg/reads/stream",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<"a read of tens of rows across several socket reads">(
								["a read of tens of rows across several socket reads"],
								{
									cases: 12,
									sense: notesOnly
								}
							),
							kept: [],
							runs: 12,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						({ n, width }, c) =>
							Effect.gen(function* () {
								const rows = Arr.map(Arr.range(1, n), (id) => rowOf(id, width))
								yield* replaceRows(
									s.admin,
									installationGroup(names),
									Arr.map(rows, (row) => ({ sql: insert, params: [String(row.id), row.body] }))
								)
								yield* withServedDb(
									opened.installed,
									opened.server.roles.app,
									{},
									({ ctx, load }) =>
										Effect.gen(function* () {
											const loaded = yield* load({ all })
											const parse = readCallOf(member(loaded, "all"))
											if (Option.isNone(parse)) {
												return assert.fail("the read member loads as no read")
											}
											const parsed = yield* parse.value({ params: {}, facts: {} })
											const decoded = { count: 0 }
											const counted: ReadCall = {
												...parsed.call,
												decode: (row) => {
													decoded.count += 1
													return parsed.call.decode(row)
												}
											}
											const seen: Seen = { kinds: [], rows: [], resetKey: [], firstAt: -1 }
											yield* Stream.runForEach(readStream(ctx, counted, setEvents), (event) =>
												Effect.sync(() => {
													seen.kinds.push(event.kind)
													if (event.kind === "reset") {
														seen.resetKey.push(event.key)
													}
													if (event.kind === "upsert") {
														if (seen.firstAt < 0) {
															seen.firstAt = decoded.count
														}
														seen.rows.push(event.row)
													}
												})
											)
											assert.equal(seen.kinds[0], "reset", "the first event")
											assert.deepEqual(seen.resetKey, [["id"]], "the reset's key fields")
											assert.equal(seen.kinds[seen.kinds.length - 1], "ready", "the last event")
											assert.equal(
												Arr.filter(seen.kinds, (k) => k === "ready").length,
												1,
												"one ready"
											)
											assert.ok(
												seen.firstAt >= 1 && seen.firstAt < n,
												`the first upsert reached the consumer after ${seen.firstAt} of ${n} rows decoded`
											)
											unorderedEqual(seen.rows, rows, "the upserts are the table's rows")
											c.note("a read of tens of rows across several socket reads")
										})
								)
							}).pipe(Effect.scoped)
					)
				}).pipe(Effect.scoped)
			)
	)
})
