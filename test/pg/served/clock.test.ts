import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result, Stream } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { isRecord } from "#compiler/core/record.ts"
import { clockedMember } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A member that binds a parameter to the database's clock (workload clocked) reads the instant its call's transaction
 * began, transaction_timestamp(), once per call, in its unit, and answers at that instant alone. Generated: a fresh
 * installation per case, the reading's unit, and wanted rows due before the call's first reading or an hour or more
 * after it, then one call of each member.
 *
 * Properties, each against an oracle the host computes from the readings the calls deliver, never from a clock of its
 * own:
 *
 * - A call binding the reading in microseconds and in milliseconds reads ms = floor(us / 1000).
 * - A clocked read of what is due at or before the reading answers exactly the rows due before the first reading:
 *   every one committed before its call began, so due at or before its reading, and none of those due an hour on.
 *   Its answer is `reset`, its upserts, `ready`, then `end`, and the stream ends there: it is never live.
 * - One reading per call: a clocked ChangeSet stamping every wanted key into Stamp, then into Mark in a later stratum,
 *   stamps every row with the one instant its read-back reads.
 * - A clocked parameter of a contract is judged by its contract: a reading the contract admits answers, and one it
 *   refuses is `refused`.
 *
 * Plants (~/.cache/grizzle-release/DBCLOCK/plants): clock-round-not-floor.patch reads milliseconds rounded, caught by
 * ms = floor(us / 1000) wherever the reading's microseconds pass 500; clock-units-swapped.patch, caught by
 * ms = floor(us / 1000) at every reading; clock-statement-timestamp.patch reads statement_timestamp(), caught by Mark's stamps against Stamp's;
 * clock-clock-timestamp.patch reads clock_timestamp(), caught by stamps of one statement apart; instant-live.patch
 * registers a clocked read live, whose answer then never ends.
 */

/** An instant, and the instants on either side of 2100-01-01 in milliseconds since the epoch. */
const Instant = contract("Instant", pg.bigint)
const year2100 = 4_102_444_800_000n
const Before2100 = contract("Before2100", pg.bigint, (x) => x.le(year2100))
const After2100 = contract("After2100", pg.bigint, (x) => x.ge(year2100))

const Wanted = relation("Wanted", { key: pg.integer, due: Instant }, ["key"])
const Stamp = relation("Stamp", { key: pg.integer, at: Instant }, ["key"])
const Mark = relation("Mark", { key: pg.integer, at: Instant }, ["key"])
const Bounds = relation("Bounds", { key: pg.integer, before: Before2100, after: After2100 }, [
	"key"
])
const Clock = schema("Clock", [Wanted, Stamp, Mark, Bounds], [])

type Unit = "micros" | "millis"

/** How many of a unit one hour holds. */
const perHour: { readonly [U in Unit]: bigint } = { micros: 3_600_000_000n, millis: 3_600_000n }

/** A wanted row as offsets from the first reading: due that many units before it, or an hour and that many after it. */
interface Want {
	readonly past: boolean
	readonly offset: bigint
}

interface ClockCase {
	readonly unit: Unit
	readonly wants: ReadonlyArray<Want>
}

const wantGen: Gen<Want> = (source) => {
	const past = source.draw(element([true, false] as const))
	const offset = source.draw(element([0, 1, 999, 1_000, 59_999, 3_599_999] as const))
	return { past, offset: BigInt(offset) }
}

const caseGen: Gen<ClockCase> = (source) => ({
	unit: source.draw(element(["micros", "millis"] as const)),
	wants: Array.from({ length: source.draw(int(1, 40)) }, () => source.draw(wantGen))
})

type Feature =
	| "micros"
	| "millis"
	| "a row due exactly at the first reading"
	| "a row due an hour on"
	| "no row due"
	| "a contract that admits the reading"
	| "a contract that refuses the reading"

/** The one bigint member of a read's one row, `name`. */
const onlyReading = (rows: ReadonlyArray<unknown>, name: string): bigint => {
	const [row, ...rest] = rows
	const value = isRecord(row) ? row[name] : undefined
	assert.ok(rest.length === 0 && typeof value === "bigint", `one row holding a bigint ${name}`)
	return typeof value === "bigint" ? value : 0n
}

/** A row's bigint member `name`. */
const bigintOf = (row: unknown, name: string): bigint => {
	const value = isRecord(row) ? row[name] : undefined
	assert.ok(typeof value === "bigint", `a row holding a bigint ${name}`)
	return typeof value === "bigint" ? value : 0n
}

layer(Substrate.layer, { excludeTestServices: true })(
	"a member bound to the database's clock",
	(it) => {
		it.effect(
			"reads the instant its call's transaction began once per call, in its unit, and answers at that instant alone",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "specification",
								name: "the readings each call delivers, and the rows due before the first reading"
							},
							suite: "pg/served/clock",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<Feature>(
								[
									"micros",
									"millis",
									"a row due exactly at the first reading",
									"a row due an hour on",
									"no row due",
									"a contract that admits the reading",
									"a contract that refuses the reading"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							/** Each case installs a schema and makes one call of each member. */
							runs: 16,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(c, notes) =>
							Effect.gen(function* () {
								notes.note(c.unit)
								const opened = yield* installed(
									Clock,
									{ Wanted: [], Stamp: [], Mark: [], Bounds: [] },
									{ label: "clock", extensions: [], programs: {} }
								)
								const s = opened.schema
								const instant = () => query(s).rule((r) => r.find({ now: r.param("now", Instant) }))
								const stampsOf = (target: typeof Stamp | typeof Mark) =>
									ChangeSet.empty(s).insert(
										target,
										query(s).rule((r) => {
											const { key, due } = v(Wanted, "wanted")
											return r
												.match(Wanted, { key, due })
												.find({ key, at: r.param("now", Instant) })
										})
									)
								const programs = {
									reading: clockedMember(instant(), { now: c.unit }),
									both: clockedMember(
										query(s).rule((r) =>
											r.find({ us: r.param("us", pg.bigint), ms: r.param("ms", pg.bigint) })
										),
										{ us: "micros", ms: "millis" }
									),
									want: ChangeSet.empty(s).insert(Wanted, []),
									due: clockedMember(
										query(s).rule((r) => {
											const { key, due } = v(Wanted, "wanted")
											return r
												.match(Wanted, { key, due })
												.where(r.le(due, r.param("now", Instant)))
												.find({ key, due })
										}),
										{ now: c.unit }
									),
									stamp: clockedMember(
										ChangeSet.sequence(stampsOf(Stamp), stampsOf(Mark)).read("now", () =>
											instant()
										),
										{ now: c.unit }
									),
									stamps: query(s).rule((r) => {
										const { key, at: stamped } = v(Stamp, "stamp")
										return r.match(Stamp, { key, at: stamped }).find({ key, at: stamped })
									}),
									marks: query(s).rule((r) => {
										const { key, at: marked } = v(Mark, "mark")
										return r.match(Mark, { key, at: marked }).find({ key, at: marked })
									}),
									before: clockedMember(
										query(s).rule((r) => r.find({ now: r.param("now", Before2100) })),
										{ now: "millis" }
									),
									after: clockedMember(
										query(s).rule((r) => r.find({ now: r.param("now", After2100) })),
										{ now: "millis" }
									)
								}
								yield* withServedDb(
									opened.installed,
									opened.server.roles.app,
									{},
									({ ctx: db, load }) =>
										Effect.gen(function* () {
											const loaded = yield* load(programs)
											const calls = (name: string) => memberCalls(db, member(loaded, name))
											const call = { params: {}, facts: {} }

											const firstRows = yield* readOnce(calls("reading"))(call)
											const first = onlyReading(firstRows, "now")

											const both = yield* readOnce(calls("both"))(call)
											const us = onlyReading(both, "us")
											const ms = onlyReading(both, "ms")
											assert.equal(
												ms,
												us / 1_000n,
												"one call's milliseconds are its microseconds floored"
											)

											const wanted = Arr.map(c.wants, (w, i) => ({
												key: i + 1,
												due: w.past ? first - w.offset : first + perHour[c.unit] + w.offset
											}))
											if (Arr.some(c.wants, (w) => w.past && w.offset === 0n)) {
												notes.note("a row due exactly at the first reading")
											}
											if (Arr.some(c.wants, (w) => !w.past)) {
												notes.note("a row due an hour on")
											}
											if (Arr.every(c.wants, (w) => !w.past)) {
												notes.note("no row due")
											}
											yield* writeOnce(calls("want"))({
												params: {},
												facts: { insert: { Wanted: wanted } }
											})

											const dueCalls = calls("due")
											if (dueCalls.shape !== "instantSet") {
												return assert.fail("a clocked set read is served at its call's instant")
											}
											const answer = yield* Stream.runCollect(dueCalls.answer(call))
											const kinds: ReadonlyArray<string> = Arr.map(answer, (e) => e.kind)
											const expectedKinds: ReadonlyArray<string> = [
												"reset",
												...Arr.map(
													Arr.filter(c.wants, (w) => w.past),
													() => "upsert"
												),
												"ready",
												"end"
											]
											assert.deepEqual(
												kinds,
												expectedKinds,
												"a clocked read's answer is reset, an upsert per due row, ready, then end"
											)
											const dueKeys = Arr.flatMap(c.wants, (w, i) => (w.past ? [i + 1] : []))
											const dueRows = yield* readOnce(dueCalls)(call)
											unorderedEqual(
												Arr.map(dueRows, (row) => (isRecord(row) ? row["key"] : undefined)),
												dueKeys,
												"a clocked read answers exactly the rows due before the first reading"
											)

											const stamped = yield* writeOnce(calls("stamp"))(call)
											const reads =
												stamped.kind === "accepted" || stamped.kind === "unchanged"
													? stamped.reads
													: undefined
											const nowRows = isRecord(reads) ? reads["now"] : undefined
											const reading = onlyReading(Arr.isArray(nowRows) ? nowRows : [], "now")
											const stampRows = yield* readOnce(calls("stamps"))(call)
											const markRows = yield* readOnce(calls("marks"))(call)
											const stampedAt = [...stampRows, ...markRows]
											assert.equal(
												stampedAt.length,
												2 * wanted.length,
												"every wanted key stamped twice"
											)
											assert.ok(
												Arr.every(stampedAt, (row) => bigintOf(row, "at") === reading),
												`every stamp of the call, in either stratum, is its one reading ${reading}`
											)

											const admitted = yield* Effect.result(readOnce(calls("before"))(call))
											notes.note("a contract that admits the reading")
											assert.ok(
												Result.isSuccess(admitted),
												`a reading before 2100 answers: ${Formatter.format(admitted)}`
											)
											const refused = yield* Effect.result(readOnce(calls("after"))(call))
											notes.note("a contract that refuses the reading")
											assert.ok(
												Result.isFailure(refused) && refused.failure.kind === "refused",
												`a reading before 2100 is refused by a contract of instants after it: ${Formatter.format(refused)}`
											)
										})
								)
							}).pipe(Effect.scoped)
					)
				)
		)
	}
)
