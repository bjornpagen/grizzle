/**
 * A Db over a moved clock reads every instant of the database's clock as exactly the instant its test states, on
 * PostgreSQL 19, through the statements its served file runs (adapter/db/moved.ts Db.openMoved, its file compiled by
 * compileServedMoved): each reading a clocked parameter binds and each instant an insert stamps is the instant the call
 * states, one instant in every statement of the call, whatever the database's own clock reads, so a time-dependent law
 * judges, and a row is stamped, at the instant the test states, and no test sleeps.
 *
 * Moved holds Lease(id, until) and Mark(id, at), `at` an instant its insert stamps. Its login serves `take`, clocked in
 * microseconds: a lease inserted with `until` computed as the reading plus `budget`, a Span, and its mark stamped, the
 * reading read back in the call's transaction; and `live`, clocked in microseconds: each lease whose `until` is past the
 * call's reading, with that reading. A case's login is served from its file compiled for a moved clock, over a clone of
 * Moved installed as `grizzle generate` drafts it.
 *
 * Property, per case: a lease taken at an instant (the epoch, one of 2026 to the microsecond, one of 2056, the last
 * microsecond of 9999) with a budget of a microsecond to a day, then judged at the instant it was taken at, at
 * its last microsecond within, at its bound or past it. The take is accepted; its read-back reads the stated instant
 * exactly, the lease's `until` is that instant plus the budget, and its mark's `at` is that instant exactly. The lease
 * is live, `live` answering it with the judging instant exactly, exactly when the judging instant is before its bound;
 * at its bound or past it, `live` answers nothing. Oracle: the rule, a moved Db's every reading and stamp of a call is
 * the instant the call states.
 *
 * Kills: the moved instant printed as the transaction's, so every reading is the database's own and the take's reading
 * is not the stated instant; and an insert's stamp reading the transaction's instant, so a mark taken at a stated
 * instant is stamped at the database's own instant, not its call's reading.
 *
 * Features: each taking instant; judged at the taking, at its last instant within, at its bound, past it.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Ref } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	judgedAt,
	liveWhenJudged,
	Moved,
	movedInstall,
	movedTemplate,
	type MovingFeature,
	movingFeatures,
	movingGen,
	situations,
	takenAt,
	toSpan
} from "#test/pg/served/moved-clock.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { movedServedFixture } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A Db over a moved clock reads every reading and stamp of a call as exactly the instant the call states, so a lease is judged and a mark stamped at the instant its test states. */
export const aDbOverAMovedClockReadsEveryReadingAndStampOfACallAsExactlyTheInstantTheCallStates =
	property.explore(movingGen, {
		needs: { fixture: Substrate.fresh(movedTemplate) },
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
								const at = takenAt(c)
								const instant = yield* Ref.make(at)
								const db = yield* Db.openMoved(moved.login.roles.app, {}, Ref.get(instant))
								const answer = yield* db.workload.take
									.once({
										params: { budget: toSpan(c.budget) },
										facts: { insert: { Lease: [{ id: 1 }], Mark: [{ id: 1 }] } }
									})
									.pipe(writeAnswerOf)
								if (answer._tag !== "accepted") {
									return assert.fail(`the take at ${at} is accepted, not ${answer._tag}`)
								}
								assert.deepEqual(
									Arr.map(answer.reads.reading, (row) => row.now),
									[at],
									"the take reads the stated instant back, exactly"
								)
								const until = yield* s.admin.queryValues(
									`SELECT ${quoteIdent(names.column("Lease", "until"))}::text FROM ${printObjectName(names.relation("Lease"))}`,
									[]
								)
								assert.deepEqual(
									Arr.map(until, (row) => BigInt(String(row[0]))),
									[at + c.budget],
									"the lease's until is the stated instant plus its budget"
								)
								const marks = yield* s.admin.queryValues(
									`SELECT ${quoteIdent(names.column("Mark", "at"))}::text FROM ${printObjectName(names.relation("Mark"))}`,
									[]
								)
								assert.deepEqual(
									Arr.map(marks, (row) => BigInt(String(row[0]))),
									[at],
									"the mark is stamped at the stated instant, exactly"
								)
								const judged = judgedAt(c)
								yield* Ref.set(instant, judged)
								const answered = yield* db.workload.live.once({ params: {}, facts: {} })
								const live = Arr.map(Arr.fromIterable(answered), (row) => ({
									id: row.id,
									now: row.now
								}))
								assert.deepEqual(
									live,
									liveWhenJudged(c) ? [{ id: 1, now: judged }] : [],
									liveWhenJudged(c)
										? "the lease judged before its bound is live, read at the judging instant exactly"
										: `the lease judged at or past its bound, ${judged - at - c.budget} microseconds past, is no longer live`
								)
							}).pipe(Effect.scoped, withLayer(moved.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "a moved Db's every reading and stamp of a call is the instant the call states"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\tcase "moved":\n\t\t\treturn \`(\${printLiteral({ kind: "text", value: "epoch" }, types.text).text}::\${inCatalog("timestamptz")} + \${inCatalog("format")}(\${printLiteral({ kind: "text", value: "%s microseconds" }, types.text).text}, \${printExpr(instant.at)})::\${inCatalog("interval")})\``,
				replacement: `\t\tcase "moved":\n\t\t\treturn \`\${inCatalog("transaction_timestamp")}()\``,
				why: "The moved instant reads the transaction's: every reading is the database's own instant, so the take reads back an instant it never stated."
			},
			{
				file: "packages/engine/src/write/insert/stamp.ts",
				original: 'w.cx.clockReading({ kind: "stamp" }, "micros", types.bigint)',
				replacement:
					'{ kind: "clock", of: { kind: "stamp" }, instant: { kind: "transaction" }, unit: "micros", type: types.bigint }',
				why: "An insert's stamp reads the transaction's instant: a mark taken at a stated instant is stamped at the database's own instant, not at the instant its call states, which its lease's until and read-back read."
			}
		]
	})
