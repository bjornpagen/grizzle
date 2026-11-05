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
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, String as Str } from "effect"
import { type BatchStatement, runFramedTwice, writeFrame } from "#adapter/wire/batch.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { assert, assertVariant } from "#test/support/assert.ts"
import { flightPrologue } from "#test/support/flight/model.ts"
import {
	answeringScript,
	firstCells,
	immediateDelivery,
	refusedAnswer,
	scriptedSession,
	texts
} from "#test/support/flight/scripted.ts"
import { caseHang } from "#test/support/limits.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"
import { testSql } from "#test/support/sql.ts"

/** The failure a case's making of its writes fails with. */
class WritesUnmade extends Data.TaggedError("WritesUnmade")<{ readonly writes: number }> {}

type Fault =
	| { readonly kind: "none" }
	| { readonly kind: "read"; readonly at: number }
	| { readonly kind: "write"; readonly at: number }
	| { readonly kind: "making" }
	| { readonly kind: "commit" }

interface TwoFlights {
	readonly reads: number
	readonly writes: number
	readonly fault: Fault
}

const readSql = (at: number): string => `select ${at} as read`
const writeSql = (at: number): string => `select ${at} as write`

const statement = (sql: string): BatchStatement => ({ sql: testSql(sql), params: [] })

/** Every case of the box: each count of reads and writes with every fault it can carry. */
const cases: Readonly<{ 0: TwoFlights }> & ReadonlyArray<TwoFlights> = [
	{ reads: 1, writes: 0, fault: { kind: "none" } },
	...Arr.flatMap([1, 2], (reads) =>
		Arr.flatMap([0, 1, 2], (writes): ReadonlyArray<TwoFlights> => [
			{ reads, writes, fault: { kind: "none" } },
			...Arr.map(Arr.range(0, reads - 1), (at): TwoFlights => ({
				reads,
				writes,
				fault: { kind: "read", at }
			})),
			...Arr.map(
				Arr.makeBy(writes, (at) => at),
				(at): TwoFlights => ({
					reads,
					writes,
					fault: { kind: "write", at }
				})
			),
			{ reads, writes, fault: { kind: "making" } },
			{ reads, writes, fault: { kind: "commit" } }
		])
	)
]

type Situation = Fault["kind"] | "no write" | "two reads"

/** What the contract says a case ends as (see the header). */
type Verdict =
	| { readonly kind: "committed" }
	| { readonly kind: "refused"; readonly index: number }
	| { readonly kind: "unmade" }
	| { readonly kind: "commitRefused" }

const expected = (c: TwoFlights): Verdict => {
	switch (c.fault.kind) {
		case "none":
			return { kind: "committed" }
		case "read":
			return { kind: "refused", index: c.fault.at }
		case "write":
			return { kind: "refused", index: c.reads + c.fault.at }
		case "making":
			return { kind: "unmade" }
		case "commit":
			return { kind: "commitRefused" }
	}
}

const serialization = serverError({ ...nothingReported, sqlstate: "40001" })

/** The statement a case's server refuses, none for a fault no statement's. */
const refusedSql = (fault: Fault): string | undefined => {
	switch (fault.kind) {
		case "read":
			return readSql(fault.at)
		case "write":
			return writeSql(fault.at)
		case "none":
		case "making":
		case "commit":
			return undefined
	}
}

describe("a write that reads before it writes", () => {
	it.effect("runs two flights in one transaction, all of it committed or none of it", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/adapter/two-flights",
					generator: element(cases),
					literal: Formatter.format,
					limit: cases.length,
					coverage: requiredInSpace<Situation>([
						"none",
						"read",
						"write",
						"making",
						"commit",
						"no write",
						"two reads"
					]),
					caseHang,
					box: "one or two reads, zero to two writes, and every fault: none, each read or write refused, the writes unmade, COMMIT refused",
					oracle: {
						kind: "specification",
						name: "one transaction over two flights, as a model of each verdict"
					}
				},
				(c, note) =>
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
									query.sql === refused ? refusedAnswer("23514") : answeringScript.statement(query),
								commit: () => (c.fault.kind === "commit" ? serialization : undefined)
							},
							immediateDelivery
						)
						const reads = Arr.map(Arr.range(0, c.reads - 1), (at) => statement(readSql(at)))
						const writes = Arr.map(
							Arr.makeBy(c.writes, (at) => at),
							(at) => statement(writeSql(at))
						)
						let made = false
						const ran = yield* Effect.result(
							runFramedTwice(session, writeFrame(flightPrologue), reads, (outcomes) => {
								made = true
								assert.deepEqual(
									firstCells(outcomes),
									Arr.map(reads, (r) => r.sql),
									"the writes are made from the reads' rows"
								)
								return c.fault.kind === "making"
									? Effect.fail(new WritesUnmade({ writes: c.writes }))
									: Effect.succeed(writes)
							})
						)
						const [first, second] = session.flights()
						const firstTexts = texts(first)
						assert.deepEqual(
							Arr.drop(firstTexts, 3),
							Arr.map(reads, (r) => r.sql),
							"the first flight is BEGIN, the prologue and the reads"
						)
						assert.ok(
							Str.startsWith("BEGIN")(firstTexts[0] ?? ""),
							"the first flight begins the transaction"
						)
						const allTexts: ReadonlyArray<string> = [
							...Arr.map(reads, (r) => r.sql),
							...Arr.map(writes, (w) => w.sql)
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
									[...Arr.map(writes, (w) => w.sql), "COMMIT"],
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
					})
			)
		)
	)
})
