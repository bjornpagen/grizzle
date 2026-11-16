/**
 * A write's two flights in one transaction (packages/grizzle/src/adapter/wire/batch.ts runFramedTwice), on a session
 * that answers as PostgreSQL answers a pipeline (test/support/flight/scripted.ts): a plan that reads before it writes
 * sends its reads behind BEGIN and the prologue, makes its writes from their rows, and sends them with COMMIT.
 *
 * The oracle is the contract stated as a model of each case's verdict (`expected`):
 * - the first flight is BEGIN, the prologue and the reads, with no end, and the second is the writes and COMMIT, with
 *   no BEGIN;
 * - a call that succeeds answers the reads' outcomes then the writes', and commits every statement of both;
 * - a refused read is BatchRefused at its index, and the writes are never made; a refused write is BatchRefused at its
 *   index past every read, one index space over both flights; a COMMIT refused 40001 is CommitRefused;
 * - when making the writes fails, the call fails with that failure, after a flight of ROLLBACK alone;
 * - whatever fails, nothing commits and the server holds no transaction open after the call.
 *
 * The box, exhausted: one or two reads, zero to two writes, and every fault: none, each read refused, each write
 * refused, the writes' making failing, and COMMIT refused 40001.
 *
 * Features: each fault of the box, with one or two reads and none to two writes.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { excludesNothing, runFramedTwice, writeFrame } from "#adapter/wire/batch.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { assert, assertVariant } from "#test/support/assert.ts"
import { flightPrologue } from "#test/support/flight/model.ts"
import {
	answeringScript,
	firstCells,
	immediateDelivery,
	refusedAnswer,
	scriptedSession,
	sentSql,
	texts
} from "#test/support/flight/scripted.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	expected,
	read,
	readSql,
	refusedSql,
	serialization,
	type Situation,
	twoFlights,
	write,
	writeSql,
	WritesUnmade
} from "#test/unit/adapter/two-flights.fixtures.ts"

/** A write that reads before it writes runs two flights in one transaction, all of it committed or none of it. */
export const aWriteThatReadsBeforeItWritesRunsTwoFlightsInOneTransactionAllOfItCommittedOrNoneOfIt =
	property.exhaust(finite(twoFlights), {
		needs: {},
		situations: [
			"none",
			"read",
			"write",
			"making",
			"commit",
			"no write",
			"two reads"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_2, note: Case<Situation>) => (c) =>
			Effect.gen(function* () {
				note.note(c.fault.kind)
				if (c.writes === 0) {
					note.note("no write")
				}
				if (c.reads === 2) {
					note.note("two reads")
				}
				const refused = refusedSql(c.fault)
				const session = scriptedSession(
					{
						...answeringScript,
						statement: (query) =>
							sentSql(query) === refused
								? refusedAnswer("23514")
								: answeringScript.statement(query),
						commit: () => (c.fault.kind === "commit" ? serialization : undefined)
					},
					immediateDelivery
				)
				const reads = upTo(c.reads, (at) => read(readSql(at)))
				const writes = Array.from({ length: c.writes }, (_, at) => write(writeSql(at)))
				let made = false
				const ran = yield* Effect.result(
					runFramedTwice(
						session,
						writeFrame(flightPrologue, "serializable", excludesNothing),
						reads,
						(outcomes) => {
							made = true
							assert.deepEqual(
								firstCells(outcomes),
								Arr.map(reads, (r) => r.text.sql),
								"the writes are made from the reads' rows"
							)
							return c.fault.kind === "making"
								? Effect.fail(new WritesUnmade({ writes: c.writes }))
								: Effect.succeed(writes)
						}
					)
				)
				const [first, second] = session.flights()
				const firstTexts = texts(first)
				assert.deepEqual(
					Arr.drop(firstTexts, 3),
					Arr.map(reads, (r) => r.text.sql),
					"the first flight is BEGIN, the prologue and the reads"
				)
				assert.ok(
					Str.startsWith("BEGIN")(firstTexts[0] ?? ""),
					"the first flight begins the transaction"
				)
				const allTexts: ReadonlyArray<string> = [
					...Arr.map(reads, (r) => r.text.sql),
					...Arr.map(writes, (w) => w.text.sql)
				]
				const committed: ReadonlyArray<string> = Arr.filter(session.committed(), (sql) =>
					allTexts.includes(sql)
				)
				assert.equal(session.open(), false, "no transaction is left open")
				const verdict = expected(c)
				switch (verdict.kind) {
					case "committed": {
						assertVariant(ran, "_tag", "Success", "the call succeeds")
						assert.deepEqual(
							firstCells(ran.success),
							allTexts,
							"the reads' outcomes, then the writes'"
						)
						assert.deepEqual(
							texts(second),
							[...Arr.map(writes, (w) => w.text.sql), "COMMIT"],
							"the second flight is the writes and COMMIT"
						)
						assert.deepEqual(committed, allTexts, "every statement of both flights commits")
						return
					}
					case "refused": {
						assertVariant(ran, "_tag", "Failure", "the call fails")
						const failure = ran.failure
						assertVariant(failure, "_tag", "BatchRefused")
						assert.equal(failure.index, verdict.index, "one index space over both flights")
						assert.equal(made, c.fault.kind === "write", "a refused read makes no write")
						assert.deepEqual(committed, [], "nothing commits")
						return
					}
					case "unmade": {
						assertVariant(ran, "_tag", "Failure", "the call fails")
						assertVariant(ran.failure, "_tag", "WritesUnmade")
						assert.deepEqual(texts(second), ["ROLLBACK"], "a flight of ROLLBACK alone ends it")
						assert.deepEqual(committed, [], "nothing commits")
						return
					}
					case "commitRefused": {
						assertVariant(ran, "_tag", "Failure", "the call fails")
						const failure = ran.failure
						assertVariant(failure, "_tag", "CommitRefused")
						assert.equal(failure.failure.sqlstate, sqlstates.serializationFailure)
						assert.deepEqual(committed, [], "nothing commits")
						return
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "one transaction over two flights, as a model of each verdict"
		},
		box: "one or two reads, zero to two writes, and every fault: none, each read or write refused, the writes unmade, COMMIT refused",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original:
					"\t\t\treturn new BatchRefused({ index: failure.index + by, failure: failure.failure })",
				replacement:
					"\t\t\treturn new BatchRefused({ index: failure.index, failure: failure.failure })",
				why: "A refused write is indexed within its own flight, not past every read."
			}
		]
	})
