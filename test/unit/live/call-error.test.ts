/**
 * readCallError and applyCallError (packages/grizzle/src/adapter/live/call-error.ts): a statement's refusal, on a read
 * or a write, read as the call error a live answer ends with, through the shell's own classification of the server's
 * report (serializationRefusal). Every SQLSTATE the runtime branches on is drawn, on a read and on a write.
 *
 * - The error is retry `safe` exactly where PostgreSQL rolled the whole transaction back for a concurrent
 *   transaction's work, 40001 or 40P01, so nothing committed and the same call may succeed; every other refusal of a
 *   statement is the statement's own, and retry `never`; its message carries the server's. Oracle: PostgreSQL's
 *   documentation of serialization_failure and deadlock_detected.
 *
 * Features: a serialization refusal and another refusal, each on a read and on a write.
 *
 * Plant (~/.cache/grizzle-release/LIVE-EVENTS/plants): transient-never (the classification table makes a transient
 * failure retry never).
 *
 * Every source's reading (call-error.ts readings), over every source a call's failure is met at (live/events.ts
 * failures), exhausted:
 *
 * - Exact: the kinds its table reads its failures as are exactly the kinds the event model gives the source, so each
 *   kind the document lists for a source is one some failure there reads as, and its type holds every producer of the
 *   source to them. Oracle: the classification's own tables, beside the model's.
 *
 * Features: every source.
 *
 * Plants (~/.cache/grizzle-release/OPENAPI/plants): read-reading-drops-transport (the read's table reads a broken
 * connection as unavailable, so no read failure reads as transport), failures-read-outside-world (the model gives a
 * read outsideWorld, which no read failure reads as).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec, String as Str } from "effect"
import { ExecutionFailure, ReadFailure, serializationRefusal } from "#adapter/errors/execution.ts"
import { ServerError } from "#adapter/errors/failures.ts"
import { applyCallError, readCallError, readings } from "#adapter/live/call-error.ts"
import { type Sqlstate, sqlstates } from "#compiler/core/sqlstate.ts"
import { type FailureSource, failures } from "#compiler/live/events.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** Where a refusal met the call: a features' pair of the search. */
type Met =
	| "a serialization refusal of a read"
	| "a serialization refusal of a write"
	| "another refusal of a read"
	| "another refusal of a write"

/** Every SQLSTATE the runtime branches on (core/sqlstate.ts sqlstates). */
const states: Arr.NonEmptyReadonlyArray<Sqlstate> = [
	sqlstates.serializationFailure,
	...Arr.filter(Rec.values(sqlstates), (state) => state !== sqlstates.serializationFailure)
]

/** The SQLSTATEs with which PostgreSQL rolls a transaction back for a concurrent transaction's work. */
const rolledBack: ReadonlySet<string> = new Set([
	sqlstates.serializationFailure,
	sqlstates.deadlockDetected
])

describe("readCallError and applyCallError", () => {
	it.effect(
		"a refusal is retry safe exactly where PostgreSQL rolled back for a concurrent transaction",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/live/call-error-sqlstate",
						generator: (source) => ({
							sqlstate: element(states)(source),
							program: element(["read", "write"] as const)(source)
						}),
						literal: Formatter.format,
						box: "every SQLSTATE the runtime branches on, on a read and on a write",
						oracle: {
							kind: "specification",
							name: "PostgreSQL's serialization_failure and deadlock_detected roll the transaction back"
						},
						coverage: requiredInSpace<Met>([
							"a serialization refusal of a read",
							"a serialization refusal of a write",
							"another refusal of a read",
							"another refusal of a write"
						]),
						caseHang,
						concurrency: 1
					},
					({ sqlstate, program }, c) =>
						Effect.sync(() => {
							const report = new ServerError({
								sqlstate,
								message: `refused with ${sqlstate}`,
								constraint: undefined,
								schema: undefined,
								table: undefined,
								column: undefined,
								dataType: undefined,
								detail: undefined,
								hint: undefined
							})
							const transient = serializationRefusal(report)
							const read = transient ?? new ReadFailure({ reason: report })
							const write = transient ?? new ExecutionFailure({ reason: report })
							const refused = program === "read" ? read : write
							const error = program === "read" ? readCallError(read) : applyCallError(write)
							const safe = rolledBack.has(sqlstate)
							assert.equal(error.retry, safe ? "safe" : "never")
							assert.ok(Str.includes(refused.message)(error.message), "the failure's own message")
							c.note(
								safe
									? program === "read"
										? "a serialization refusal of a read"
										: "a serialization refusal of a write"
									: program === "read"
										? "another refusal of a read"
										: "another refusal of a write"
							)
						})
				)
			)
	)
})

/** Every source a call's failure is met at, the event model's own roster (live/events.ts failures). */
const sources: ReadonlyArray<FailureSource> = Arr.map(Rec.toEntries(failures), ([source]) => source)

describe("every source's reading", () => {
	it.effect("reads its failures as exactly the kinds the event model gives its source", (ctx) =>
		Arr.isReadonlyArrayNonEmpty(sources)
			? searched(
					ctx,
					exhaust(
						{
							suite: "unit/live/call-error-readings",
							generator: element(sources),
							literal: Formatter.format,
							box: "every source a call's failure is met at",
							oracle: {
								kind: "specification",
								name: "the classification's own tables (call-error.ts readings) beside the event model's failures"
							},
							coverage: requiredInSpace<FailureSource>(sources),
							caseHang,
							concurrency: 1
						},
						(source, c) =>
							Effect.sync(() => {
								const reading: Readonly<Record<string, string>> = readings[source]
								const read = Arr.sort(Arr.dedupe(Rec.values(reading)), Order.String)
								const given = Arr.sort(Arr.dedupe(failures[source]), Order.String)
								assert.deepEqual(read, given, `the reading of ${source}`)
								c.note(source)
							})
					)
				)
			: Effect.die(new Error("the event model gives no source"))
	)
})
