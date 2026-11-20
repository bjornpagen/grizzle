/**
 * A Db over a moved clock reads every instant of the database's clock moved by the offset its test states, on
 * PostgreSQL 19, through the statements its served file runs (adapter/db/moved.ts Db.openMoved, its file compiled by
 * compileServedMoved): each reading a clocked parameter binds and each instant an insert stamps is the instant its
 * call's transaction began plus the call's offset, one instant in every statement of the call, so a time-dependent law
 * judges at the instant the test states and no test sleeps.
 *
 * Moved holds Lease(id, until) and Mark(id, at), `at` an instant its insert stamps. Its login serves `take`, clocked in
 * microseconds: a lease inserted with `until` computed as the reading plus `budget`, a Span, and its mark stamped, the
 * reading read back in the call's transaction; and `live`, clocked in microseconds: each lease whose `until` is past the
 * call's reading, with that reading. A case's login is served from its file compiled for a moved clock, over a clone of
 * Moved installed as `grizzle generate` drafts it.
 *
 * Property, per case: a lease taken at an offset (0, an hour back, three years back or thirty years on) with a budget of
 * an hour to a day, then judged at the offset it was taken at or at its bound and past it. The take is accepted; its
 * read-back reads one reading R, and R less the offset lies between the database's own clock read just before the call
 * and just after it; the lease's `until` is R plus the budget and its mark's `at` is R. The lease is live, `live`
 * answering it with its reading, exactly when the judging offset is within the lease: then that reading less the
 * judging offset lies between the database's clock around that call too; at its bound or past it, `live` answers
 * nothing. Oracle: the rule, a moved Db's every reading of the call is the instant its transaction began plus the call's
 * offset, judged against the database's own clock read around each call, which every call's instant lies between.
 *
 * Kills: the moved instant printed as the transaction's, its offset dropped, so every reading is the database's own
 * and the lease judged past its bound is still live; and an insert's stamp reading the transaction's instant, so a mark
 * taken at a moved offset is stamped at the database's own instant, not its call's reading.
 *
 * Features: offset 0, an offset into the past, an offset into the future, judged within the lease, at its bound, past it.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Ref } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	judgedAt,
	Moved,
	type MovingFeature,
	movedInstall,
	movedTemplate,
	movingFeatures,
	movingGen,
	situations,
	Span
} from "#test/pg/served/moved-clock.fixtures.ts"
import { answered } from "#test/support/calls.ts"
import { movedServedFixture } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** The database's own clock as its admin session reads it, clock_timestamp() in microseconds since the Unix epoch. */
const serverClock = Effect.gen(function* () {
	const s = yield* Substrate
	const [row] = yield* s.admin.queryValues(
		"SELECT (floor(extract(epoch FROM clock_timestamp()) * 1000000))::bigint::text",
		[]
	)
	return BigInt(String(row?.[0]))
})

/**
 * `call` with the database's own clock read just before it and just after it: the instant its transaction began lies
 * between the two, since the admin session's statements run before the call is sent and after it answered.
 */
const bracketed = <A, E, R>(call: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const before = yield* serverClock
		const value = yield* call
		const after = yield* serverClock
		return { value, before, after }
	})

/** A reading moved by `offset` is its call's instant moved: less the offset, it lies within the call's bracket. */
const movedWithin = (
	reading: bigint,
	offset: bigint,
	bracket: { readonly before: bigint; readonly after: bigint },
	what: string
): void =>
	assert.ok(
		reading - offset >= bracket.before && reading - offset <= bracket.after,
		`${what} ${reading} is the call's instant moved by ${offset}: less it, within the database's clock around the call, ${bracket.before} to ${bracket.after}`
	)

/** A Db over a moved clock reads every reading and stamp of a call at the call's instant moved by its offset, so a lease is judged at the instant its test states. */
export const aDbOverAMovedClockReadsEveryReadingAndStampOfACallAtItsInstantMovedByTheCallsOffset =
	property.explore(movingGen, {
		needs: { fixture: Substrate.seat(movedTemplate) },
		situations,
		check:
			({ fixture }, k: Case<MovingFeature>) =>
			(c) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							k.noteAll(movingFeatures(c))
							const s = yield* Substrate
							const o = yield* openedIn(Moved, {}, movedInstall, taken)
							const names = o.installed.installation.names
							const moved = yield* movedServedFixture(o.installed, o.server)
							return yield* Effect.gen(function* () {
								const offset = yield* Ref.make(c.taken)
								const db = yield* Db.openMoved(moved.login.roles.app, {}, Ref.get(offset))
								const take = yield* db.workload.take
									.once({
										params: { budget: Span(c.budget) },
										facts: { insert: { Lease: [{ id: 1 }], Mark: [{ id: 1 }] } }
									})
									.pipe(answered, bracketed)
								const answer = take.value
								if (answer.kind !== "accepted") {
									return assert.fail(`the take is accepted, not ${answer.kind}`)
								}
								const read = answer.reads.reading
								assert.equal(read.length, 1, "the take reads its reading back once")
								const reading = Arr.getUnsafe(read, 0).now
								movedWithin(reading, c.taken, take, "the take's reading")
								const until = yield* s.admin.queryValues(
									`SELECT ${quoteIdent(names.column("Lease", "until"))}::text FROM ${printObjectName(names.relation("Lease"))}`,
									[]
								)
								assert.deepEqual(
									Arr.map(until, (row) => BigInt(String(row[0]))),
									[reading + c.budget],
									"the lease's until is the take's reading plus its budget"
								)
								const marks = yield* s.admin.queryValues(
									`SELECT ${quoteIdent(names.column("Mark", "at"))}::text FROM ${printObjectName(names.relation("Mark"))}`,
									[]
								)
								assert.deepEqual(
									Arr.map(marks, (row) => BigInt(String(row[0]))),
									[reading],
									"the mark is stamped at the take's reading"
								)
								const judged = judgedAt(c)
								yield* Ref.set(offset, judged)
								const live = yield* bracketed(db.workload.live.once({ params: {}, facts: {} }))
								const rows = Arr.fromIterable(live.value)
								switch (c.judged.kind) {
									case "within": {
										assert.ok(
											live.after - take.before < c.budget,
											"the calls ran within the lease's budget"
										)
										assert.deepEqual(
											Arr.map(rows, (row) => row.id),
											[1],
											"the lease judged at the offset it was taken at is live"
										)
										movedWithin(Arr.getUnsafe(rows, 0).now, judged, live, "the judging reading")
										return
									}
									case "past":
										assert.deepEqual(
											rows,
											[],
											`the lease judged ${c.judged.by} microseconds past its bound is no longer live`
										)
										return
								}
							}).pipe(Effect.scoped, withLayer(moved.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "a moved Db's every reading of a call is the instant its transaction began plus the call's offset"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\tcase "moved":\n\t\t\treturn \`(\${began} + \${inCatalog("format")}(\${printLiteral({ kind: "text", value: "%s microseconds" }, types.text).text}, \${printExpr(instant.offset)})::\${inCatalog("interval")})\``,
				replacement: '\t\tcase "moved":\n\t\t\treturn began',
				why: "The moved instant drops its offset: every reading is the database's own instant, so the take's reading less its offset leaves the call's bracket and the lease judged past its bound reads as live."
			},
			{
				file: "packages/engine/src/write/insert/stamp.ts",
				original: 'w.cx.clockReading({ kind: "stamp" }, "micros", types.bigint)',
				replacement:
					'{ kind: "clock", of: { kind: "stamp" }, instant: { kind: "transaction" }, unit: "micros", type: types.bigint }',
				why: "An insert's stamp reads the transaction's instant: a mark taken at a moved offset is stamped at the database's own instant, not at the take's reading, which its lease's until and read-back read."
			}
		]
	})
