import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import {
	accepting,
	type Machine,
	program,
	type Real,
	runProgram,
	took
} from "@grizzle/testing/commands"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant } from "@grizzle/testing/gen"
import { passed, WILD_KINDS, type Wild, wild } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { fullSwarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Cause, Effect, Exit, Formatter, Option, Scope, Struct } from "effect"
import { memberOps } from "#adapter/db/handles.ts"
import type { CompiledOps } from "#adapter/db/ops.ts"
import {
	type ReadError,
	ReadFailure,
	type ReadStage,
	TransientFailure
} from "#adapter/errors/execution.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { CursorError } from "#compiler/core/errors.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { query, v } from "#compiler/public/query.ts"
import { paged } from "#compiler/public/workload.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, contains } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap, type Tap } from "#test/support/wire-tap.ts"

/**
 * Live, Stale and Wild values at a served Db's workload handles, as a state machine (the library's commands and lsw):
 * every call answers by its contract or with a typed refusal, never a defect or a hang; a refusal before any SQL sends
 * no frontend message; and no session stays leased.
 *
 * Each case runs the members of the worked example's workload, served through its login's served file, on a tapped pool
 * of one session (test/support/wire-tap.ts), warmed, so a window holds one call's traffic alone, and runs drawn
 * commands:
 *
 * - execute of a read, get of a key and page of a paged member with live parameters: an answer, sent on the wire;
 * - the same with a wild parameter value: an answer where the codec admits the value, ReadError{stage: "encode"} naming
 *   the parameter otherwise; a wild page request: ReadError{stage: "request"} or a CursorError, or an answer for a value
 *   the request contract admits, whose exact verdict is the unit boundary suite's (test/unit/adapter/boundary.test.ts);
 * - a stale cursor, from a page of another paged member: a CursorError;
 * - dispose: the pool's scope closes, as a DbLayer's does when its layer is released, and every live call is made at
 *   once. Every call that needs a session is then ReadError{stage: "acquire"}, and every refusal before SQL is still the
 *   same refusal.
 *
 * The model is whether the pool is disposed. Every refusal before SQL (the stages encode and request, and a
 * CursorError) is checked to send zero frontend messages, and after every command the pool holds no leased session. A
 * refusal is read from the error's typed fields, never from its text.
 */
interface Model {
	readonly disposed: boolean
}

/** A typed refusal: a ReadError's stage, a transient failure, or a CursorError. */
type Refusal = ReadStage | "TransientFailure" | "CursorError"

const refusalOf = (error: unknown): Refusal | undefined =>
	error instanceof CursorError
		? "CursorError"
		: error instanceof TransientFailure
			? "TransientFailure"
			: error instanceof ReadFailure
				? error.stage
				: undefined

/** The refusals before any SQL. */
const beforeSql: ReadonlyArray<Refusal> = ["CursorError", "encode", "request"]

/** The calls a live and a wild value reach. */
type LiveCall = "execute" | "get" | "page"
type WildCall = "execute params" | "get values" | "page request"

type BoundaryFeature =
	| `refused before SQL: ${Refusal}`
	| `${LiveCall} live`
	| `${WildCall} wild`
	| "page stale cursor"
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
	/** A cursor of a page of another paged member. */
	readonly staleCursor: string
	readonly note: Case<BoundaryFeature>["note"]
}

/** The members a case's commands call, each over the tapped pool: a read by account, a key and a paged member. */
interface Reads {
	readonly live: CompiledOps<unknown>
	readonly task: CompiledOps<unknown>
	readonly ordered: CompiledOps<unknown>
}

/**
 * What a call ended with, checked: never a defect; a refusal before SQL sent nothing; then the pool holds no lease.
 * Returns the typed error, or undefined for an answer.
 */
const called = <A, E>(
	real: Subject,
	what: string,
	call: Effect.Effect<A, E>
): Effect.Effect<unknown> =>
	Effect.gen(function* () {
		const mark = real.tap.mark()
		const exit = yield* Effect.exit(call)
		const window = real.tap.since(mark)
		if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
			return assert.fail(`${what} died: ${Cause.pretty(exit.cause)}`)
		}
		const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
		const refusal = refusalOf(error)
		if (refusal !== undefined && beforeSql.includes(refusal)) {
			assert.equal(window.frontend.length, 0, `${what} was refused (${refusal}) after sending SQL`)
			real.note(`refused before SQL: ${refusal}`)
		}
		const leased = yield* real.pool.leased
		assert.equal(leased, 0, `${what} left a session leased`)
		return error
	})

/** After dispose, a call that needs a session is ReadError{stage: "acquire"}; before, a live call answers. */
const expectLive = (model: Model, what: string, error: unknown): void => {
	if (model.disposed) {
		assert.equal(
			refusalOf(error),
			"acquire",
			`${what} on a disposed pool is ${error === undefined ? "an answer" : Formatter.format(error)}`
		)
	} else {
		assert.equal(error, undefined, `${what} is refused: ${Formatter.format(error)}`)
	}
}

/** A wild value's call: an answer, where the boundary admits the value, or a typed refusal (checked by `called`). */
const expectTyped = (what: string, error: unknown, refusals: ReadonlyArray<Refusal>): void => {
	if (error === undefined) {
		return
	}
	contains<Refusal | undefined>(
		refusals,
		refusalOf(error),
		`${what} is refused with ${Formatter.format(error)}, none of ${Arr.join(refusals, ", ")}`
	)
}

/** The parameters each command draws: a wild value, or none. */
type BoundaryParameters = Readonly<{
	"execute(live)": undefined
	"get(live)": undefined
	"page(live)": undefined
	"page(stale cursor)": undefined
	"execute params(wild)": Wild
	"get values(wild)": Wild
	"page request(wild)": Wild
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
		"execute(live)": { applies: always, parameters: none, weight: 1, judge: accepting(unchanged) },
		"get(live)": { applies: always, parameters: none, weight: 1, judge: accepting(unchanged) },
		"page(live)": { applies: always, parameters: none, weight: 1, judge: accepting(unchanged) },
		"page(stale cursor)": {
			applies: always,
			parameters: none,
			weight: 1,
			judge: accepting(unchanged)
		},
		"execute params(wild)": {
			applies: always,
			parameters: anyWild,
			weight: 1,
			judge: accepting(unchanged)
		},
		"get values(wild)": {
			applies: always,
			parameters: anyWild,
			weight: 1,
			judge: accepting(unchanged)
		},
		"page request(wild)": {
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

/** A live call: an answer, or ReadError{stage: "acquire"} once disposed. */
const live = (
	real: Subject,
	what: LiveCall,
	call: Effect.Effect<unknown, ReadError | CursorError>,
	model: Model
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const outcome = yield* called(real, what, call)
		expectLive(model, `a live ${what}`, outcome)
		real.note(`${what} live`)
	})

/**
 * A call with a wild value, passed whole to the boundary (`passed` is the only reader of a wild value): an answer, or
 * one of `refusals`, or ReadError{stage: "acquire"} once disposed. Returns the value passed and the typed error.
 */
const wildCall = (
	real: Subject,
	what: WildCall,
	wildValue: Wild,
	refusals: ReadonlyArray<Refusal>,
	call: (value: unknown) => Effect.Effect<unknown, ReadError | CursorError>
): Effect.Effect<{ readonly value: unknown; readonly error: unknown }> =>
	Effect.gen(function* () {
		const value = passed({ kind: "wild", wild: wildValue })
		const error = yield* called(real, what, call(value))
		expectTyped(what, error, [...refusals, "acquire"])
		real.note(`${what} wild`)
		return { value, error }
	})

/**
 * A wild value of the parameter `param`: an answer, or a refusal at encode by its codec whose EncodingFailure names the
 * parameter, as a write's names it (README "Errors and outcomes").
 */
const wildParam = (
	real: Subject,
	what: WildCall,
	param: string,
	wildValue: Wild,
	call: (value: unknown) => Effect.Effect<unknown, ReadError | CursorError>
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { error } = yield* wildCall(real, what, wildValue, ["encode"], call)
		if (!(error instanceof ReadFailure) || error.stage !== "encode") {
			return
		}
		const reason = error.reason
		if (reason._tag !== "EncodingFailure") {
			return assert.fail(`${what}: refused at encode by the codec, not ${reason._tag}`)
		}
		assert.deepEqual(
			reason.place,
			{ _tag: "Slot", name: param },
			`${what}: the refusal names the parameter`
		)
	})

/**
 * A JavaScript caller's parameter argument, holding a value of any type, which the types refuse and the handle's
 * boundary judges: the test's own data.
 */
const callersParams = (params: Readonly<Record<string, unknown>>): ParamMap =>
	trusted<ParamMap>(params)

/** The live calls, each made once more after dispose: an answer before it, ReadError{stage: "acquire"} after. */
const liveCalls = (
	real: Subject
): ReadonlyArray<readonly [LiveCall, Effect.Effect<unknown, ReadError | CursorError>]> => [
	["execute", Effect.flatMap(real.reads.live.execute({ account: a1 }), (r) => r.collect)],
	["get", real.reads.task.get({ id: t1 })],
	["page", real.reads.ordered.page({ account: a1 }, { first: 2 })]
]

/** Each command run on the case's members and held to the model's state before it, or after it for dispose. */
const stepsOf = (real: Subject): Real<Model, BoundaryParameters, never, never, never> => ({
	"execute(live)": (_parameters, model) =>
		Effect.as(
			live(
				real,
				"execute",
				Effect.flatMap(real.reads.live.execute({ account: a1 }), (r) => r.collect),
				model
			),
			took
		),
	"get(live)": (_parameters, model) =>
		Effect.as(live(real, "get", real.reads.task.get({ id: t1 }), model), took),
	"page(live)": (_parameters, model) =>
		Effect.as(
			live(real, "page", real.reads.ordered.page({ account: a1 }, { first: 2 }), model),
			took
		),
	"page(stale cursor)": () =>
		Effect.as(
			Effect.gen(function* () {
				const request = { first: 2, after: real.staleCursor }
				const error = yield* called(
					real,
					"a page",
					real.reads.ordered.page({ account: a1 }, request)
				)
				assertInstanceOf(error, CursorError, "a stale cursor's page")
				real.note("page stale cursor")
			}),
			took
		),
	"execute params(wild)": (w) =>
		Effect.as(
			wildParam(real, "execute params", "account", w, (value) =>
				real.reads.live.execute(callersParams({ account: value }))
			),
			took
		),
	"get values(wild)": (w) =>
		Effect.as(
			wildParam(real, "get values", "id", w, (value) =>
				real.reads.task.get(callersParams({ id: value }))
			),
			took
		),
	"page request(wild)": (w) =>
		Effect.as(
			Effect.asVoid(
				wildCall(real, "page request", w, ["request", "CursorError"], (value) =>
					real.reads.ordered.page({ account: a1 }, value)
				)
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

/** The cursor of the first page of the paged member `other`, read live. */
const cursorOf = (other: CompiledOps<unknown>) =>
	Effect.flatMap(other.page({}, { first: 1 }), (page) =>
		Option.match(page.pageInfo.endCursor, {
			onNone: () => Effect.die(new Error("the other ordered query delivers no row")),
			onSome: (cursor) =>
				typeof cursor === "string" ? Effect.succeed(cursor) : Effect.die(new Error("no cursor"))
		})
	)

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
							extensions: [],
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
											oracle: { kind: "unstated" },
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
													"refused before SQL: encode",
													"refused before SQL: CursorError",
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
													const opsOf = (name: string) => memberOps(tapped, member(loaded, name))
													const real: Subject = {
														reads: {
															live: opsOf("live"),
															task: opsOf("task"),
															ordered: opsOf("ordered")
														},
														tap,
														pool,
														dispose: Scope.close(poolScope, Exit.void),
														staleCursor: yield* cursorOf(opsOf("other")),
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
