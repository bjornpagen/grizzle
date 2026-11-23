/**
 * A live answer over the protocol's own results: a read sends `ready` only once its flight's COMMIT has answered, and
 * every failure ends its answer with one CallError whose retry the failure's meaning gives it. The session is the
 * flight fuzzer's scripted one (test/support/flight/scripted.ts), which answers as PostgreSQL answers a pipeline and
 * reports what committed, so every result the protocol documents is drawn without injecting it into a real server.
 *
 * The fixture (built here, compiled offline as generate compiles it, test/support/compiled-served.ts): a relation
 * Sitting, a closed relation Weights, and one role serving a set read of a student's sittings, the same read ordered,
 * and a key read of Weights, a read of a closed relation alone,
 * whose rows only a migration changes (served/forms.ts ServedReadLive `constant`). Each case draws a member, the rows its statement answers, and one fault: none; its
 * statement refused with 40001, 40P01 or another SQLSTATE; the server ending the session (FATAL) or the connection lost
 * at its statement; COMMIT refused with 40001 or its answer lost; the fence refused by a migration running; or no
 * session to be had. It runs the member's watch and its once on a Db context over the scripted pool, whose registry is
 * the layer's own (live/subscriptions.ts makeSubscriptions) over a change source that reports no change, so a read's
 * watch is its first run's answer and then waits: it is read to its first `ready`, or to its `end`.
 *
 * Properties:
 *
 * - a read's watch answers reset, its rows' upserts, then `ready` exactly when no fault came, and else its one error
 *   event in place of `ready`, then end; never a `ready` its COMMIT did not answer;
 * - once's error is the answer's error;
 * - the error's class and retry are the fault's meaning: SERIALIZABLE's refusal (40001, 40P01) at a statement or at
 *   COMMIT is transient, safe; a read's lost connection, or a session the server ended at its statement, is transport,
 *   safe; no session to be had is unavailable, safe; a migration at the fence is stale, never; any other refusal is
 *   failed, never;
 * - and the classification's own retry for that class is that retry (live/events.ts callErrors);
 * - a read's watch registers on the layer's registry once, a closed-only read's under no routing key, since no change
 *   of a row changes it and only a migration's version notice ends it.
 *
 * The oracle is the specification of each fault's meaning, read off the drawn fault alone.
 *
 * Features: each member, each fault, a read of rows and of none, and a watch of a closed-only read.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { int, weighted } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Formatter, Option } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberCalls } from "#adapter/db/handles.ts"
import { LayerReleased } from "#adapter/errors/failures.ts"
import { makeSubscriptions, type Subscriptions } from "#adapter/live/subscriptions.ts"
import { prologueOf } from "#adapter/wire/batch.ts"
import { callErrors } from "#compiler/live/index.ts"
import { scriptedPool } from "#test/support/flight/scripted.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	answerOf,
	type Fault,
	type Feature,
	loaded,
	loadedApp,
	meaningOf,
	type Member,
	onceOf,
	retryOf,
	sessionOf,
	silent
} from "#test/unit/live/flights.fixtures.ts"

/**
 * A live answer over the protocol's results sends ready only after its COMMIT answered, and ends every failure with
 * its meaning's CallError and retry.
 *
 * Budget: its suite's count before the conversion (unit/live/flights: 200 independent cases and 64 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const aLiveAnswerOverTheProtocolsResultsSendsReadyOnlyAfterItsCOMMITAnsweredAndEndsEveryFailureWithItsMeaningsCallErrorAndRetry =
	property.explore(
		(source) => ({
			member: source.draw(
				weighted<Member>([
					[1, () => "sittings"],
					[1, () => "ordered"],
					[1, () => "weight"]
				])
			),
			rows: source.draw(int(0, 3)),
			fault: source.draw(
				weighted<Fault>([
					[2, () => ({ kind: "none" })],
					[1, () => ({ kind: "statement refused", sqlstate: "40001" })],
					[1, () => ({ kind: "statement refused", sqlstate: "40P01" })],
					[1, () => ({ kind: "statement refused", sqlstate: "23505" })],
					[1, () => ({ kind: "statement fatal" })],
					[1, () => ({ kind: "statement lost" })],
					[1, () => ({ kind: "COMMIT refused" })],
					[1, () => ({ kind: "COMMIT lost" })],
					[1, () => ({ kind: "fence refused by a migration" })],
					[1, () => ({ kind: "no session" })]
				])
			)
		}),
		{
			needs: {},
			situations: [
				"sittings",
				"ordered",
				"weight",
				"none",
				"statement refused",
				"statement fatal",
				"statement lost",
				"COMMIT refused",
				"COMMIT lost",
				"fence refused by a migration",
				"no session",
				"a read of rows",
				"a read of none",
				"a watch of a closed-only read"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check: (_, notes: CaseOf<Feature>) => (c) =>
				Effect.scoped(
					Effect.gen(function* () {
						notes.note(c.member)
						notes.note(c.fault.kind)
						const prologue = prologueOf(
							loaded.prologue,
							loadedApp.installed,
							"",
							loaded.fingerprint
						)
						const registry = yield* makeSubscriptions(silent)
						const registrations: Array<number> = []
						const subscriptions: Subscriptions = {
							register: (request) =>
								Effect.suspend(() => {
									registrations.push(request.keys.length)
									return registry.register(request)
								})
						}
						const context: ServedDbContext = {
							prologue,
							claims: new Set(),
							isolation: loadedApp.isolation,
							expiry: { kind: "never" },
							subscriptions,
							domain: loadedApp.domain,
							pool: scriptedPool({
								lease:
									c.fault.kind === "no session"
										? Effect.fail(new LayerReleased())
										: Effect.sync(() => sessionOf(c, { prologue }))
							})
						}
						const member = defined(
							Option.getOrUndefined(Arr.findFirst(loadedApp.members, (m) => m.name === c.member)),
							`the member ${c.member}`
						)
						const calls = memberCalls(context, member)
						const input =
							c.member === "weight"
								? { params: { kind: "light" }, facts: {} }
								: { params: { student: 1 }, facts: {} }
						const events = yield* answerOf(calls, input)
						const kinds = Arr.map(events, (e) => e.kind)
						const fault = c.fault
						if (fault.kind === "none") {
							const routed = c.member === "sittings" || c.member === "ordered"
							assert.equal(registrations.length, 1, "a read's watch registers once")
							assert.ok(
								Arr.every(registrations, (keys) => (keys === 0) === (c.member === "weight")),
								"a closed-only read registers under no routing key, a routed one under its keys"
							)
							if (routed) {
								notes.note(c.rows > 0 ? "a read of rows" : "a read of none")
								assert.deepEqual(
									kinds,
									["reset", ...upTo(c.rows, () => "upsert" as const), "ready"],
									"a read's watch answers reset, its rows, then ready"
								)
							} else {
								notes.note("a watch of a closed-only read")
								assert.deepEqual(
									kinds,
									["reset", "ready"],
									"a closed-only read's watch answers reset, its rows, then ready"
								)
							}
							return
						}
						const expected = meaningOf(fault)
						assert.ok(
							!kinds.includes("ready"),
							`no ready before its COMMIT answered: ${Formatter.format(kinds)}`
						)
						assert.deepEqual(
							Arr.filter(kinds, (k) => k === "error" || k === "end"),
							["error", "end"],
							"a failed answer ends with its one error, then end"
						)
						const error = defined(
							Option.getOrUndefined(
								Arr.findFirst(events, (e) =>
									e.error === undefined ? Option.none() : Option.some(e.error)
								)
							),
							"the answer's error"
						)
						assert.equal(error.kind, expected, `${fault.kind} at ${c.member} ends as ${expected}`)
						assert.equal(
							error.retry,
							retryOf(expected),
							`${expected} is retried ${retryOf(expected)}`
						)
						assert.equal(
							callErrors[expected].retry,
							retryOf(expected),
							`the classification retries ${expected} ${retryOf(expected)}`
						)
						const once = yield* onceOf(calls, input)
						assert.ok(Exit.isFailure(once), "once fails as its answer did")
						const onceError = Exit.isFailure(once)
							? Option.getOrUndefined(Exit.findErrorOption(once))
							: undefined
						assert.equal(onceError?.kind, expected, "once's error is the answer's")
					})
				),
			oracle: {
				kind: "specification",
				name: "each fault's meaning: whether anything may have committed, and whether the failure is the call's own"
			},
			budget: { runs: 200, steered: 64 },
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/reader/stream.ts",
					original:
						"\t\t\t\tconst last = yield* runRead(ctx, call, (row) => {\n\t\t\t\t\topening()\n\t\t\t\t\toffer(upsert(call.decode(row)))\n\t\t\t\t}).pipe(\n\t\t\t\t\tEffect.map(() => {\n\t\t\t\t\t\topening()\n\t\t\t\t\t\treturn events.ready\n\t\t\t\t\t}),\n\t\t\t\t\tEffect.catch((failure) => Effect.succeed(events.error(readCallError(failure))))",
					replacement:
						"\t\t\t\tlet decoded = false\n\t\t\t\tconst last = yield* runRead(ctx, call, (row) => {\n\t\t\t\t\topening()\n\t\t\t\t\tdecoded = true\n\t\t\t\t\toffer(upsert(call.decode(row)))\n\t\t\t\t}).pipe(\n\t\t\t\t\tEffect.map(() => {\n\t\t\t\t\t\topening()\n\t\t\t\t\t\treturn events.ready\n\t\t\t\t\t}),\n\t\t\t\t\tEffect.catch((failure) => {\n\t\t\t\t\t\tif (decoded) offer(events.ready)\n\t\t\t\t\t\treturn Effect.succeed(events.error(readCallError(failure)))\n\t\t\t\t\t})",
					why: "A read sends ready once its rows decode, before COMMIT's answer: a COMMIT refused or lost finds a ready before the error."
				}
			]
		}
	)
