import {
	accepting,
	type Machine,
	program,
	type Real,
	runProgram,
	took
} from "@bjornpagen/testing/commands"
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { constant } from "@bjornpagen/testing/gen"
import { passed, WILD_KINDS, type Wild, wild } from "@bjornpagen/testing/lsw"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { fullSwarm } from "@bjornpagen/testing/swarm"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Cause, Effect, Exit, Formatter, Option, Scope, Struct } from "effect"
import { onceCalls, type OnceCalls } from "#adapter/db/handles.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import type { CallError, CallErrorKind, RowKey } from "#compiler/live/index.ts"
import { query, v } from "#compiler/public/query.ts"
import { paged } from "#compiler/public/workload.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, assertVariant, contains } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap, type Tap } from "#test/support/wire-tap.ts"

/**
 * Live, foreign and wild values at a served Db's workload handles, as a state machine (the library's commands and lsw):
 * every call answers by its contract or with its CallError, never a defect or a hang; a refusal before any SQL sends no
 * frontend message; and no session stays leased.
 *
 * Each case runs the members of the worked example's workload, served through its login's served file, on a tapped pool
 * of one session (test/support/wire-tap.ts), warmed, so a window holds one call's traffic alone, and runs drawn
 * commands, each a member's once:
 *
 * - a read, a key member and a window of a paged member with live parameters: an answer, sent on the wire;
 * - the same with a wild parameter value: an answer where the codec admits the value, an `input` CallError otherwise; a
 *   wild window: an `input` CallError, or an answer for a value the window contract admits (adapter/page/window.ts);
 * - a foreign anchor, the key of a row of another paged member, whose completed order has another length: an `input`
 *   CallError;
 * - dispose: the pool's scope closes, as a DbLayer's does when its layer is released, and every live call is made at
 *   once. Every call that needs a session is then `unavailable`, and every refusal before SQL is still the same
 *   refusal.
 *
 * The model is whether the pool is disposed. Every refusal before SQL (an `input` CallError) is checked to send zero
 * frontend messages, and after every command the pool holds no leased session. A refusal is read from the error's
 * kind, never from its text.
 *
 * - Oracle: the specification turned into a checker, each call's contract as its answer or typed refusal.
 * - Plant: ~/.cache/grizzle-release/BR08/plants/boundary-lease-never-released.patch, a lease whose end never gives its
 *   session back, must turn the property red.
 */
interface Model {
	readonly disposed: boolean
}

/** A refusal's CallError's kind, none for an answer. */
const refusalOf = (error: CallError | undefined): CallErrorKind | undefined => error?.kind

/** The refusals before any SQL. */
const beforeSql: ReadonlyArray<CallErrorKind> = ["input"]

/** The calls a live and a wild value reach. */
type LiveCall = "read" | "key" | "window"
type WildCall = "read params" | "key values" | "window"

type BoundaryFeature =
	| `refused before SQL: ${CallErrorKind}`
	| `${LiveCall} live`
	| `${WildCall} wild`
	| "window foreign anchor"
	| "live after dispose"
	| "disposed"

/**
 * What a case's commands run against: the tapped Db's members, its tap and pool, the dispose of the pool, and where a
 * command's features go.
 */
interface Subject {
	readonly reads: Reads
	readonly tap: Tap
	readonly pool: SessionPool
	readonly dispose: Effect.Effect<void>
	/** The key of a row of another paged member, whose completed order has another length. */
	readonly foreignKey: RowKey
	readonly note: Case<BoundaryFeature>["note"]
}

/** The members a case's commands call, each over the tapped pool: a read by account, a key and a paged member. */
interface Reads {
	readonly live: OnceCalls
	readonly task: OnceCalls
	readonly ordered: OnceCalls
}

/**
 * What a call ended with, checked: never a defect; a refusal before SQL sent nothing; then the pool holds no lease.
 * Returns the CallError, or undefined for an answer.
 */
const called = (
	real: Subject,
	what: string,
	call: Effect.Effect<unknown, CallError>
): Effect.Effect<CallError | undefined> =>
	Effect.gen(function* () {
		const mark = real.tap.mark()
		const exit = yield* Effect.exit(call)
		const window = real.tap.since(mark)
		if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
			return assert.fail(`${what} died: ${Cause.pretty(exit.cause)}`)
		}
		const error = Option.getOrUndefined(Exit.findErrorOption(exit))
		const refusal = refusalOf(error)
		if (refusal !== undefined && beforeSql.includes(refusal)) {
			assert.equal(window.frontend.length, 0, `${what} was refused (${refusal}) after sending SQL`)
			real.note(`refused before SQL: ${refusal}`)
		}
		const leased = yield* real.pool.leased
		assert.equal(leased, 0, `${what} left a session leased`)
		return error
	})

/** After dispose, a call that needs a session is `unavailable`; before, a live call answers. */
const expectLive = (model: Model, what: string, error: CallError | undefined): void => {
	if (model.disposed) {
		assert.equal(
			refusalOf(error),
			"unavailable",
			`${what} on a disposed pool is ${error === undefined ? "an answer" : Formatter.format(error)}`
		)
	} else {
		assert.equal(error, undefined, `${what} is refused: ${Formatter.format(error)}`)
	}
}

/** A wild value's call: an answer, where the boundary admits the value, or one of `refusals` (checked by `called`). */
const expectTyped = (
	what: string,
	error: CallError | undefined,
	refusals: ReadonlyArray<CallErrorKind>
): void => {
	if (error === undefined) {
		return
	}
	contains<CallErrorKind | undefined>(
		refusals,
		refusalOf(error),
		`${what} is refused with ${Formatter.format(error)}, none of ${Arr.join(refusals, ", ")}`
	)
}

/** The parameters each command draws: a wild value, or none. */
type BoundaryParameters = Readonly<{
	"read(live)": undefined
	"key(live)": undefined
	"window(live)": undefined
	"window(foreign anchor)": undefined
	"read params(wild)": Wild
	"key values(wild)": Wild
	"window(wild)": Wild
	dispose: undefined
}>

const none = () => constant(undefined)

/** Every wild kind, simplest first. */
const anyWild = () => wild(WILD_KINDS)

const always = (): boolean => true

const unchanged = (model: Model): Model => model

/** The members' state machine: every call applies in every state, and dispose once. */
const boundaryMachine: Machine<Model, BoundaryParameters, never> = {
	initial: { disposed: false },
	commands: {
		"read(live)": { applies: always, parameters: none, weight: 1, judge: accepting(unchanged) },
		"key(live)": { applies: always, parameters: none, weight: 1, judge: accepting(unchanged) },
		"window(live)": { applies: always, parameters: none, weight: 1, judge: accepting(unchanged) },
		"window(foreign anchor)": {
			applies: always,
			parameters: none,
			weight: 1,
			judge: accepting(unchanged)
		},
		"read params(wild)": {
			applies: always,
			parameters: anyWild,
			weight: 1,
			judge: accepting(unchanged)
		},
		"key values(wild)": {
			applies: always,
			parameters: anyWild,
			weight: 1,
			judge: accepting(unchanged)
		},
		"window(wild)": {
			applies: always,
			parameters: anyWild,
			weight: 1,
			judge: accepting(unchanged)
		},
		dispose: {
			applies: (model) => !model.disposed,
			parameters: none,
			weight: 1,
			judge: accepting((model) => ({ ...model, disposed: true }))
		}
	}
}

/** A live call: an answer, or `unavailable` once disposed. */
const live = (
	real: Subject,
	what: LiveCall,
	call: Effect.Effect<unknown, CallError>,
	model: Model
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const outcome = yield* called(real, what, call)
		expectLive(model, `a live ${what}`, outcome)
		real.note(`${what} live`)
	})

/**
 * A call with a wild value, a parameter's or a window, passed whole to the boundary (`passed` is the only reader of a
 * wild value): an answer, or an `input` refusal (README "Errors and outcomes"), or `unavailable` once disposed.
 */
const wildCall = (
	real: Subject,
	what: WildCall,
	wildValue: Wild,
	call: (value: unknown) => Effect.Effect<unknown, CallError>
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const error = yield* called(real, what, call(passed({ kind: "wild", wild: wildValue })))
		expectTyped(what, error, ["input", "unavailable"])
		real.note(`${what} wild`)
	})

/** The window of the first `size` rows of an ordered member. */
const first = (size: number) => ({ anchor: { kind: "start" }, size })

/** The live calls, each made once more after dispose: an answer before it, `unavailable` after. */
const liveCalls = (
	real: Subject
): ReadonlyArray<readonly [LiveCall, Effect.Effect<unknown, CallError>]> => [
	["read", readOnce(real.reads.live)({ params: { account: a1 }, facts: {} })],
	["key", readOnce(real.reads.task)({ params: { id: t1 }, facts: {} })],
	["window", readOnce(real.reads.ordered)({ params: { account: a1 }, facts: {}, window: first(2) })]
]

/** Each command run on the case's members and held to the model's state before it, or after it for dispose. */
const stepsOf = (real: Subject): Real<Model, BoundaryParameters, never, never, never> => ({
	"read(live)": (_parameters, model) =>
		Effect.as(
			live(real, "read", readOnce(real.reads.live)({ params: { account: a1 }, facts: {} }), model),
			took
		),
	"key(live)": (_parameters, model) =>
		Effect.as(
			live(real, "key", readOnce(real.reads.task)({ params: { id: t1 }, facts: {} }), model),
			took
		),
	"window(live)": (_parameters, model) =>
		Effect.as(
			live(
				real,
				"window",
				readOnce(real.reads.ordered)({ params: { account: a1 }, facts: {}, window: first(2) }),
				model
			),
			took
		),
	"window(foreign anchor)": () =>
		Effect.as(
			Effect.gen(function* () {
				const window = { anchor: { kind: "after", key: real.foreignKey }, size: 2 }
				const error = yield* called(
					real,
					"a window",
					readOnce(real.reads.ordered)({ params: { account: a1 }, facts: {}, window })
				)
				assert.equal(refusalOf(error), "input", "a foreign anchor's window")
				real.note("window foreign anchor")
			}),
			took
		),
	"read params(wild)": (w) =>
		Effect.as(
			wildCall(real, "read params", w, (value) =>
				readOnce(real.reads.live)({ params: { account: value }, facts: {} })
			),
			took
		),
	"key values(wild)": (w) =>
		Effect.as(
			wildCall(real, "key values", w, (value) =>
				readOnce(real.reads.task)({ params: { id: value }, facts: {} })
			),
			took
		),
	"window(wild)": (w) =>
		Effect.as(
			wildCall(real, "window", w, (value) =>
				readOnce(real.reads.ordered)({ params: { account: a1 }, facts: {}, window: value })
			),
			took
		),
	dispose: (_parameters, _before, after) =>
		Effect.as(
			Effect.gen(function* () {
				yield* real.dispose
				real.note("disposed")
				for (const [what, call] of liveCalls(real)) {
					const error = yield* called(real, `a live ${what} after dispose`, call)
					expectLive(after, `a live ${what} after dispose`, error)
					real.note("live after dispose")
				}
			}),
			took
		)
})

/** The key of the first row of the paged member `other`, read live. */
const foreignKeyOf = (other: OnceCalls): Effect.Effect<RowKey, CallError> => {
	assertVariant(other, "shape", "list", "the other paged member reads a list")
	return Effect.flatMap(other.once({ params: {}, facts: {}, window: first(1) }), (value) =>
		Option.match(Arr.head(Arr.fromIterable(value.entries())), {
			onNone: () => Effect.die(new Error("the other ordered query delivers no row")),
			onSome: (entry) => Effect.succeed(entry.key)
		})
	)
}

layer(Substrate.layer, { excludeTestServices: true })(
	"a served Db's handles at their boundary",
	(it) => {
		it.effect(
			"answer live, stale and wild values by their contract, refuse before SQL without sending, and leak no session",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(W.Work, workFacts, {
							label: "real",
							programs: {}
						})
						const s = o.schema
						const ordered = query(s)
							.rule((r) => {
								const { id } = v(W.Task, "task")
								const { budget } = v(W.AutomaticTask, "automaticTask")
								return r
									.match(W.Task, {
										id,
										account: r.param("account", W.Task.fields.account),
										kind: "Automatic"
									})
									.match(W.AutomaticTask, { task: id, budget })
									.find({ id, budget })
							})
							.orderBy(["budget", "desc"])
						const other = query(s)
							.rule((r) => {
								const { id } = v(W.Task, "task")
								return r.match(W.Task, { id }).find({ id })
							})
							.orderBy(["id", "asc"])
						return yield* withServedDb(
							o.installed,
							o.server.roles.app,
							{},
							({ ctx: context, load }) =>
								Effect.gen(function* () {
									const loaded = yield* load({
										live: W.workReads(s).automaticTasksFor,
										task: W.Task,
										ordered: paged(ordered),
										other: paged(other)
									})
									return yield* explore(
										{
											oracle: {
												kind: "specification",
												name: "each call's contract: an answer or a typed refusal, nothing sent before SQL, no lease left"
											},
											suite: "pg/reads/boundary",
											/** Up to twelve commands, so a case can dispose and call again among its other calls. */
											draw: drawn(
												program(
													boundaryMachine,
													{ min: 0, max: 12 },
													fullSwarm(Struct.keys(boundaryMachine.commands))
												)
											),
											literal: Formatter.format,
											coverage: required<BoundaryFeature>(
												[
													"refused before SQL: input",
													"window foreign anchor",
													"live after dispose",
													"disposed"
												],
												{ cases: 40, sense: notesOnly }
											),
											kept: [],
											runs: 40,
											shrink: completeShrink,
											concurrency: 1,
											steerEvery: 16,
											caseHang
										},
										(commands, c) =>
											Effect.scoped(
												Effect.gen(function* () {
													const substrate = yield* Substrate
													const tap = makeTap(substrate.cluster)
													const poolScope = yield* Scope.make()
													yield* Effect.addFinalizer(() => Scope.close(poolScope, Exit.void))
													const pool = yield* poolFor(o.installed.as(o.server), {
														...defaultPool,
														transport: { kind: "given", transport: tap.transport },
														pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: 1 }
													}).pipe(Scope.provide(poolScope))
													yield* Effect.scoped(
														Effect.flatMap(pool.lease, (session) =>
															rowsOn(session, "SELECT 'warm'::text", [])
														)
													)
													const tapped = { ...context, pool }
													const callsOf = (name: string) => onceCalls(tapped, member(loaded, name))
													const real: Subject = {
														reads: {
															live: callsOf("live"),
															task: callsOf("task"),
															ordered: callsOf("ordered")
														},
														tap,
														pool,
														dispose: Scope.close(poolScope, Exit.void),
														foreignKey: yield* foreignKeyOf(callsOf("other")),
														note: c.note
													}
													yield* runProgram(boundaryMachine, stepsOf(real), commands)
												})
											)
									)
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
