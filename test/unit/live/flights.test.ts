/**
 * A live answer over the protocol's own results: a read sends `ready` only once its flight's COMMIT has answered, and
 * every failure ends its answer with one CallError whose retry the failure's meaning gives it. The session is the
 * flight fuzzer's scripted one (test/support/flight/scripted.ts), which answers as PostgreSQL answers a pipeline and
 * reports what committed, so every result the protocol documents is drawn without injecting it into a real server.
 *
 * The fixture (built here, compiled offline as generate compiles it, test/support/compiled-served.ts): a relation
 * Sitting, a materialized rollup of it, a closed relation Weights, and one role serving a set read of a student's
 * sittings, the same read ordered, the rollup's refresh, and a key read of Weights, a read of a closed relation alone,
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
 * - a write's answer is its outcome exactly when no fault came, and else its one error, then end;
 * - once's error is the answer's error;
 * - the error's class and retry are the fault's meaning: SERIALIZABLE's refusal (40001, 40P01) at a statement or at
 *   COMMIT is transient, safe; a read's lost connection, or a session the server ended at a write's statement, before
 *   its COMMIT ran, is transport, safe; no session to be had is unavailable, safe; a migration at the fence is stale,
 *   never; a write's connection lost at its statement or at COMMIT is commitUnknown, never, since its one flight sent
 *   COMMIT with its statement and the write may have committed; any other refusal is failed, never;
 * - and the classification's own retry for that class is that retry (live/events.ts callErrors);
 * - a read's watch registers on the layer's registry once, a closed-only read's under no routing key, since no change
 *   of a row changes it and only a migration's version notice ends it, and a write's never.
 *
 * The oracle is the specification of each fault's meaning, read off the drawn fault alone.
 *
 * Plants (~/.cache/grizzle-release/LIVE-TESTS/plants): ready-before-commit.patch (a read sends ready once its rows
 * decode, before COMMIT's answer: a COMMIT refused or lost finds a ready before the error); retry-safe-commit-unknown.patch
 * (commitUnknown classified safe: the refresh whose COMMIT went unanswered finds safe).
 *
 * Features: each member, each fault, a read of rows and of none, and a watch of a closed-only read.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Exit, Formatter, Option, Stream } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberCalls, type ServedCalls } from "#adapter/db/handles.ts"
import { LayerReleased } from "#adapter/errors/failures.ts"
import type { ChangeSource } from "#adapter/live/source.ts"
import { makeSubscriptions, type Subscriptions } from "#adapter/live/subscriptions.ts"
import { loadServed } from "#adapter/served/load.ts"
import { prologueOf } from "#adapter/wire/batch.ts"
import { type CallError, type CallErrorKind, callErrors } from "#compiler/live/index.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	derived,
	login,
	relation,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { refresh } from "#compiler/public/workload.ts"
import { servedFile } from "#compiler/served/json.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { compiledServedFile } from "#test/support/compiled-served.ts"
import { fatalStates, fenceRefusal } from "#test/support/flight/model.ts"
import {
	answeringScript,
	immediateDelivery,
	rows,
	scriptedPool,
	scriptedSession,
	sentSql,
	type StatementAnswer
} from "#test/support/flight/scripted.ts"
import { caseHang } from "#test/support/limits.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"
import { upTo } from "#test/support/up-to.ts"

const Sitting = relation("Sitting", { id: pg.integer, student: pg.integer, week: pg.integer }, [
	"id"
])
const Kind = closed("Kind", ["light", "heavy"])
const Weights = closed.relation(
	"Weights",
	{ kind: closedId(Kind), weight: pg.integer },
	["kind"],
	[
		{ kind: "light", weight: 1 },
		{ kind: "heavy", weight: 2 }
	]
)
const Edu = schema("Edu", [Sitting, Kind, Weights], [])
const Weekly = derived.materialized(
	"Weekly",
	query(Edu).rule((r) => {
		const { id, student, week } = v(Sitting, "sitting")
		return r.match(Sitting, { id, student, week }).find({ student, week, sittings: r.count() })
	})
)
const Reports = schema.extend(Edu, "Edu_1", [Weekly], [])
const app = role(Reports, "app", wholeEntriesOf(Reports), { refresh: ["Weekly"] })
const sittingsOf = query(Reports).rule((r) => {
	const { id, week } = v(Sitting, "sitting")
	return r.match(Sitting, { id, student: r.param("student", pg.integer), week }).find({ id, week })
})
const server = login(Reports, "server", [app], {
	workload: [
		workload(app, {
			sittings: sittingsOf,
			ordered: sittingsOf.orderBy(["week", "asc"], ["id", "asc"]),
			rebuild: refresh([Weekly]),
			weight: Weights
		})
	]
})

/** The fixture's login, loaded from its served file as a layer loads it. */
const loaded = succeeded(loadServed(servedFile(compiledServedFile(server)), "server"))
const loadedApp = defined(loaded.roles[0], "the role app")

type Member = "sittings" | "ordered" | "rebuild" | "weight"

/** A case's one fault (see the header). */
type Fault =
	| { readonly kind: "none" }
	| { readonly kind: "statement refused"; readonly sqlstate: "40001" | "40P01" | "23505" }
	| { readonly kind: "statement fatal" }
	| { readonly kind: "statement lost" }
	| { readonly kind: "COMMIT refused" }
	| { readonly kind: "COMMIT lost" }
	| { readonly kind: "fence refused by a migration" }
	| { readonly kind: "no session" }

interface Case {
	readonly member: Member
	readonly rows: number
	readonly fault: Fault
}

const caseGen = drawn<Case>((source) => ({
	member: source.draw(
		weighted<Member>([
			[1, () => "sittings"],
			[1, () => "ordered"],
			[1, () => "rebuild"],
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
}))

/**
 * The class a fault's meaning gives a failed call (see the header): a read commits nothing, so its lost connection is
 * transport wherever it came; a write's one flight sends COMMIT with its statement, so a connection lost at either may
 * have committed it, while a FATAL at its statement ended the session before COMMIT ran.
 */
const meaningOf = (
	member: Member,
	fault: Exclude<Fault, { readonly kind: "none" }>
): CallErrorKind => {
	switch (fault.kind) {
		case "statement refused":
			return fault.sqlstate === "23505" ? "failed" : "transient"
		case "statement fatal":
			return "transport"
		case "COMMIT refused":
			return "transient"
		case "statement lost":
		case "COMMIT lost":
			return member === "rebuild" ? "commitUnknown" : "transport"
		case "fence refused by a migration":
			return "stale"
		case "no session":
			return "unavailable"
	}
}

/** The retry the meaning of a class gives it: safe where nothing committed and the failure was not the call's own. */
const retryOf = (kind: CallErrorKind): "safe" | "never" => {
	switch (kind) {
		case "transient":
		case "transport":
		case "unavailable":
		case "tokenExpired":
			return "safe"
		case "route":
		case "input":
		case "tokenRefused":
		case "refused":
		case "outsideWorld":
		case "stale":
		case "commitUnknown":
		case "failed":
			return "never"
	}
}

/**
 * A scripted session of a case, one a lease opens: its member's statement answers its rows or its fault; the prologue
 * answers. Each lease opens its own, as a pool's next session is another after a lost one is retired, so once meets the
 * fault its watch met.
 */
const sessionOf = (c: Case, ctx: Pick<ServedDbContext, "prologue">) => {
	const fault = c.fault
	const prologue = new Set<string>([ctx.prologue.fence.text.sql, ctx.prologue.enter.text.sql])
	const answer = (sql: string): StatementAnswer => {
		if (prologue.has(sql)) {
			return fault.kind === "fence refused by a migration" && sql === ctx.prologue.fence.text.sql
				? {
						_tag: "refused",
						error: serverError({ ...nothingReported, sqlstate: fenceRefusal("lock", "migrating") })
					}
				: rows([])
		}
		switch (fault.kind) {
			case "statement refused":
				return {
					_tag: "refused",
					error: serverError({ ...nothingReported, sqlstate: fault.sqlstate })
				}
			case "statement fatal":
				return {
					_tag: "fatal",
					error: serverError({ ...nothingReported, sqlstate: fatalStates[0] })
				}
			case "statement lost":
				return { _tag: "lose" }
			case "none":
			case "COMMIT refused":
			case "COMMIT lost":
			case "fence refused by a migration":
			case "no session":
				return c.member === "rebuild" || c.member === "weight"
					? rows([])
					: rows(upTo(c.rows, (k) => [`${k + 1}`, `${k + 1}`]))
		}
	}
	return scriptedSession(
		{
			...answeringScript,
			statement: (query) => answer(sentSql(query)),
			commit: () =>
				fault.kind === "COMMIT refused"
					? serverError({ ...nothingReported, sqlstate: "40001" })
					: fault.kind === "COMMIT lost"
						? "lose"
						: undefined
		},
		immediateDelivery
	)
}

/** A change source that opens and reports no change, so a registered read is never marked. */
const silent: ChangeSource = { open: () => Effect.void }

/** One event of an answer as the properties read it: its kind, and an error event's CallError. */
interface Answered {
	readonly kind: string
	readonly error: CallError | undefined
}

/**
 * A member's watch, run to its first `ready` or its `end`, each event read as Answered, whatever the answer's shape: a
 * write's answer ends at its outcome's `end`, and a read's, live, waits after its `ready` for a change none reports.
 */
const answerOf = (calls: ServedCalls, input: unknown): Effect.Effect<ReadonlyArray<Answered>> => {
	const read = <E extends { readonly kind: string }>(
		events: Stream.Stream<E>,
		errorOf: (event: E) => CallError | undefined
	) =>
		Effect.map(
			Stream.runCollect(Stream.takeUntil(events, (e) => e.kind === "ready" || e.kind === "end")),
			(all) => Arr.map(all, (e): Answered => ({ kind: e.kind, error: errorOf(e) }))
		)
	switch (calls.shape) {
		case "set":
			return read(calls.watch(input), (e) => (e.kind === "error" ? e.error : undefined))
		case "list":
			return read(calls.watch(input), (e) => (e.kind === "error" ? e.error : undefined))
		case "instantSet":
			return read(calls.answer(input), (e) => (e.kind === "error" ? e.error : undefined))
		case "instantList":
			return read(calls.answer(input), (e) => (e.kind === "error" ? e.error : undefined))
		case "write":
			return read(calls.watch(input), (e) => (e.kind === "error" ? e.error : undefined))
	}
}

/** A member's once, its value dropped: how it ended. */
const onceOf = (calls: ServedCalls, input: unknown): Effect.Effect<Exit.Exit<void, CallError>> => {
	switch (calls.shape) {
		case "set":
			return Effect.exit(Effect.asVoid(calls.once(input)))
		case "list":
			return Effect.exit(Effect.asVoid(calls.once(input)))
		case "instantSet":
			return Effect.exit(Effect.asVoid(calls.once(input)))
		case "instantList":
			return Effect.exit(Effect.asVoid(calls.once(input)))
		case "write":
			return Effect.exit(Effect.asVoid(calls.once(input)))
	}
}

type Feature =
	| Member
	| Fault["kind"]
	| "a read of rows"
	| "a read of none"
	| "a watch of a closed-only read"

describe("a live answer over the protocol's results", () => {
	it.effect(
		"sends ready only after its COMMIT answered, and ends every failure with its meaning's CallError and retry",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "each fault's meaning: whether anything may have committed, and whether the failure is the call's own"
						},
						suite: "unit/live/flights",
						draw: caseGen,
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"sittings",
								"ordered",
								"rebuild",
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
							],
							{ cases: 120, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, notes) =>
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
									Option.getOrUndefined(
										Arr.findFirst(loadedApp.members, (m) => m.name === c.member)
									),
									`the member ${c.member}`
								)
								const calls = memberCalls(context, member)
								const input =
									c.member === "rebuild"
										? { params: {}, facts: {} }
										: c.member === "weight"
											? { params: { kind: "light" }, facts: {} }
											: { params: { student: 1 }, facts: {} }
								const events = yield* answerOf(calls, input)
								const kinds = Arr.map(events, (e) => e.kind)
								const fault = c.fault
								if (fault.kind === "none") {
									const routed = c.member === "sittings" || c.member === "ordered"
									assert.equal(
										registrations.length,
										calls.shape === "write" ? 0 : 1,
										"a read's watch registers once, a write's never"
									)
									assert.ok(
										Arr.every(registrations, (keys) => (keys === 0) === (c.member === "weight")),
										"a closed-only read registers under no routing key, a routed one under its keys"
									)
									if (calls.shape === "write") {
										assert.deepEqual(
											kinds,
											["outcome", "end"],
											"a write's answer is its outcome, then end"
										)
									} else if (routed) {
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
								const expected = meaningOf(c.member, fault)
								assert.ok(
									!kinds.includes("ready"),
									`no ready before its COMMIT answered: ${Formatter.format(kinds)}`
								)
								assert.ok(
									!kinds.includes("outcome"),
									`no outcome of a write that failed: ${Formatter.format(kinds)}`
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
								assert.equal(
									error.kind,
									expected,
									`${fault.kind} at ${c.member} ends as ${expected}`
								)
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
						)
				)
			)
	)
})
