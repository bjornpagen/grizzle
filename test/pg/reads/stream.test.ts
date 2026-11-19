/**
 * A read's rows stream: a read whose program delivers its rows by one statement (reader/run.ts Emission) hands each row
 * to its stream the moment the row is whole (reader/stream.ts readStream), so it has offered its first upsert while the
 * rows after it have not reached the driver, and its events are its reset, an upsert of each of its rows, and one ready.
 *
 * The suite constructs the condition the claim needs: the Db reads over the protocol tap's transport
 * (test/support/wire-tap.ts), whose gate lets exactly one of the read's DataRows reach the driver and holds every later
 * byte of the server's answer until the test releases it. The read runs once ungated first, on the same session, so the
 * DataRows its transaction's frame answers before the read's own statement (its prologue's) are counted from the tap's
 * record of that flight, and the gate lets those and one more through. The read's own decoder (reader/stream.ts
 * ReadCall.decode) counts the rows it decoded, and its run counts the events it has put on its queue (ReadRun.offered).
 * Once the gate holds, every byte it let through has reached the driver, which read it in the call that handed it over
 * (Gate.holding): a stream that streams has then decoded that one row and offered its reset and its upsert, whatever its
 * consumer has taken. The test reads both counts then, and only then releases the gate, so a stream that held its rows
 * until its flight answered fails at once with nothing offered, and no case waits on an event that never comes.
 *
 * - Property: once one of the read's rows has reached the driver, exactly that row is decoded and the run has offered
 *   two events, its reset and that row's upsert; the first event is the reset naming the read's key fields; the
 *   upserts are exactly the table's rows, each once; and the last event is one ready.
 * - Oracle: the rows the case inserted, the count on the read's own decoder, and the run's count of its offers.
 * - Features: a read of two rows or more, by construction.
 */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Fiber, Option, Stream } from "effect"
import { readCallOf } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import { type ReadCall, readStream, setEvents } from "#adapter/reader/stream.ts"
import {
	caseGen,
	Note,
	Notes,
	notesInstall,
	notesTemplate,
	rowOf,
	type Seen
} from "#test/pg/reads/stream.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { backendCount, makeTap } from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/**
 * A read's rows stream: it has offered its first upsert once one row has reached the driver, and its events are its reset, its rows and one ready.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/reads/stream.test.ts at d8eed1786).
 */
export const aReadsRowsStreamItHasOfferedItsFirstUpsertOnceOneRowHasReachedTheDriverAndItsEventsAreItsResetItsRowsAndOneReady =
	property.explore(caseGen, {
		needs: { notes: Substrate.seat(notesTemplate) },
		situations: ["a read of two rows or more"] satisfies ReadonlyArray<
			Reached<"a read of two rows or more">
		>,
		check:
			({ notes }, c: CaseOf<"a read of two rows or more">) =>
			({ n, width }) =>
				Effect.gen(function* () {
					const seat = yield* notes
					const s = seat.substrate
					const opened = yield* openedIn(Notes, {}, notesInstall, seat)
					const names = namesOf(opened.installed)
					const insert = `INSERT INTO ${names.table(Note)} (${names.column(Note, "id")}, ${names.column(Note, "body")}) VALUES ($1::int4, $2::text)`
					const role = opened.server.roles.app
					const file = opened.served.login
					return yield* Effect.gen(function* () {
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
							yield* Stream.runDrain(readStream(db.ctx, parsed.call, setEvents).events)
							const framed = backendCount(tap.since(mark), "D") - n
							const seen: Seen = { kinds: [], rows: [], resetKey: [] }
							const run = readStream(db.ctx, counted, setEvents)
							tap.gate.hold(framed + 1, { kind: "type", type: "D" })
							const consumer = yield* Effect.forkChild(
								Stream.runForEach(run.events, (event) =>
									Effect.sync(() => {
										seen.kinds.push(event.kind)
										if (event.kind === "reset") {
											seen.resetKey.push(event.key)
										}
										if (event.kind === "upsert") {
											seen.rows.push(event.row)
										}
									})
								)
							)
							yield* tap.gate.holding
							const atHold = { decoded: decoded.count, offered: yield* run.offered }
							tap.gate.release()
							yield* Fiber.join(consumer)
							assert.deepEqual(
								atHold,
								{ decoded: 1, offered: 2 },
								`once one row of ${n} has reached the driver, the read has decoded it and offered its reset and its upsert`
							)
							assert.equal(seen.kinds[0], "reset", "the first event")
							assert.deepEqual(seen.resetKey, [["id"]], "the reset's key fields")
							assert.equal(seen.kinds[seen.kinds.length - 1], "ready", "the last event")
							assert.equal(Arr.filter(seen.kinds, (k) => k === "ready").length, 1, "one ready")
							unorderedEqual(
								Arr.map(seen.rows, (row) => ({ ...row })),
								rows,
								"the upserts are the table's rows"
							)
							c.note("a read of two rows or more")
						}).pipe(withLayer(dbLayer))
					}).pipe(Effect.scoped)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "the rows the case inserted, and the count on the read's own decoder"
		},
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	})
