/**
 * callErrorOf (packages/grizzle/src/adapter/live/call-error.ts): a statement's refusal, on a read or a write, read as
 * the call error a live answer ends with, through the shell's own classification of the server's report
 * (serializationRefusal). Every SQLSTATE the runtime branches on is drawn, on a read and on a write.
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
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import { ExecutionFailure, ReadFailure, serializationRefusal } from "#adapter/errors/execution.ts"
import { ServerError } from "#adapter/errors/failures.ts"
import { callErrorOf } from "#adapter/live/call-error.ts"
import { type Sqlstate, sqlstates } from "#compiler/core/sqlstate.ts"
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

describe("callErrorOf", () => {
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
						caseHang
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
							const refused =
								serializationRefusal(report) ??
								(program === "read"
									? new ReadFailure({ reason: report })
									: new ExecutionFailure({ reason: report }))
							const error = callErrorOf(refused)
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
