/**
 * A read's rows stream: a read whose program delivers its rows by one statement (reader/run.ts Emission) hands each row
 * to its stream the moment the row is whole (reader/stream.ts readStream), so its first upsert reaches the stream's
 * consumer while the rows after it have not reached the driver, and its events are its reset, an upsert of each of its
 * rows, and one ready.
 *
 * The suite constructs the condition the claim needs: the Db reads over the protocol tap's transport
 * (test/support/wire-tap.ts), whose gate lets exactly one of the read's DataRows reach the driver and holds every later
 * byte of the server's answer until the test releases it. The read runs once ungated first, on the same session, so the
 * DataRows its transaction's frame answers before the read's own statement (its prologue's) are counted from the tap's
 * record of that flight, and the gate lets those and one more through. The read's own decoder (reader/stream.ts ReadCall.decode) counts the rows
 * it decoded. A stream that streams hands the consumer its first upsert while the gate holds, with one row decoded; the
 * consumer then releases the gate, and the read runs to its end. A stream that held its rows until its flight answered
 * would hand it none while the gate holds, and the case would hang, which its bound reports (caseHang).
 *
 * - Property: the first event is the reset naming the read's key fields; the consumer's first upsert arrives while the
 *   gate holds, exactly one of the read's rows decoded; the upserts are exactly the table's rows, each once; and the
 *   last event is one ready.
 * - Oracle: the rows the case inserted, and the count on the read's own decoder.
 * - Features: a read of two rows or more, by construction.
 * - Plants (~/.cache/grizzle-release/LIVE-WATCH/plants): stream-buffer-whole-result.patch (readStream hands its rows
 *   to the stream only once the flight answered) hangs the case; stream-drop-reset.patch (readStream sends no reset)
 *   turns it red.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Stream, String as Str } from "effect"
import { readCallOf } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import { type DecodedRow, type ReadCall, readStream, setEvents } from "#adapter/reader/stream.ts"
import type { SetEvent } from "#compiler/live/index.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { backendCount, makeTap } from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

const Note = relation("Note", { id: pg.integer, body: str.regex("^[a-z]*$") }, ["id"])
const Notes = schema("Notes", [Note], [])

/** Every note: the one read of the login's workload, a member of its full world's role. */
const all = query(Notes).rule((r) => {
	const { id, body } = v(Note, "note")
	return r.match(Note, { id, body }).find({ id, body })
})

/** A case: the table's rows, n of them, each a text of `width` characters. */
interface Case {
	readonly n: number
	readonly width: number
}

const caseGen: Gen<Case> = (source) => ({
	n: source.draw(int(2, 12)),
	width: source.draw(int(0, 64))
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
	firstAt: number | undefined
}

layer(Substrate.layer, { excludeTestServices: true })("a read's rows", (it) => {
	it.effect(
		"stream: its first upsert reaches the consumer while one row has reached the driver, and its events are its reset, its rows and one ready",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const opened = yield* installed(Notes, {}, { label: "stream", programs: { all } })
					const names = namesOf(opened.installed)
					const insert = `INSERT INTO ${names.table(Note)} (${names.column(Note, "id")}, ${names.column(Note, "body")}) VALUES ($1::int4, $2::text)`
					const role = opened.server.roles.app
					const file = opened.served.login
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "the rows the case inserted, and the count on the read's own decoder"
							},
							suite: "pg/reads/stream",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<"a read of two rows or more">(["a read of two rows or more"], {
								cases: 8,
								sense: notesOnly
							}),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						({ n, width }, c) =>
							Effect.gen(function* () {
								const rows = Array.from({ length: n }, (_, at) => rowOf(at + 1, width))
								yield* replaceRows(
									s.admin,
									installationGroup(names),
									Arr.map(rows, (row) => ({ sql: insert, params: [String(row.id), row.body] }))
								)
								const tap = makeTap(opened.installed.cluster)
								const dbLayer = sourcedDbLayer(opened.installed, {
									...clusterConnection(
										opened.installed.cluster,
										opened.installed.database,
										opened.installed.as(opened.server).password
									),
									transport: tap.transport,
									pool: { ...clusterPool, min: 0, max: 1 },
									login: file,
									verify: testVerify
								})
								yield* Effect.gen(function* () {
									const db = yield* openServed(
										defined(file.roles[role.role.name], "the role's served handle"),
										{ token: tokenOf({}) }
									)
									const member = defined(
										Option.getOrUndefined(Arr.findFirst(db.role.members, (m) => m.name === "all")),
										"the read member"
									)
									const parse = readCallOf(member)
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
									const mark = tap.mark()
									yield* Stream.runDrain(readStream(db.ctx, parsed.call, setEvents))
									const framed = backendCount(tap.since(mark), "D") - n
									const seen: Seen = { kinds: [], rows: [], resetKey: [], firstAt: undefined }
									tap.gate.hold(framed + 1, { kind: "type", type: "D" })
									yield* Stream.runForEach(readStream(db.ctx, counted, setEvents), (event) =>
										Effect.sync(() => {
											seen.kinds.push(event.kind)
											if (event.kind === "reset") {
												seen.resetKey.push(event.key)
											}
											if (event.kind === "upsert") {
												if (seen.firstAt === undefined) {
													seen.firstAt = decoded.count
													tap.gate.release()
												}
												seen.rows.push(event.row)
											}
										})
									)
									assert.equal(seen.kinds[0], "reset", "the first event")
									assert.deepEqual(seen.resetKey, [["id"]], "the reset's key fields")
									assert.equal(seen.kinds[seen.kinds.length - 1], "ready", "the last event")
									assert.equal(Arr.filter(seen.kinds, (k) => k === "ready").length, 1, "one ready")
									assert.equal(
										seen.firstAt,
										1,
										`the rows decoded when the first upsert reached the consumer, of ${n}`
									)
									unorderedEqual(
										Arr.map(seen.rows, (row) => ({ ...row })),
										rows,
										"the upserts are the table's rows"
									)
									c.note("a read of two rows or more")
								}).pipe(withLayer(dbLayer))
							}).pipe(Effect.scoped)
					)
				}).pipe(Effect.scoped)
			)
	)
})
