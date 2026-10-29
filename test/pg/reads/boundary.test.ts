import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import { type Machine, program, type Real, runProgram } from "@grizzle/testing/commands"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { constant, int } from "@grizzle/testing/gen"
import { passed, WILD_KINDS, type Wild, wild } from "@grizzle/testing/lsw"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Exit,
	Formatter,
	Option,
	Schema,
	Scope
} from "effect"
import { dbContext } from "#adapter/db/context.ts"
import { makeDb } from "#adapter/db/db.ts"
import {
	type ReadError,
	ReadFailure,
	type ReadStage,
	TransientFailure
} from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { CompiledReadValue, ReaderValue } from "#adapter/reader/reader.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { CursorError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, contains, defined } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { dbReader } from "#test/support/runtime-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap, type Tap } from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Live, Stale and Wild values at the public reader of an opened Db, as a state machine (the library's commands and lsw):
 * every call answers by its contract or with a typed refusal, never a defect or a hang; a refusal before any SQL sends
 * no frontend message; and no session stays leased.
 *
 * Each case opens the worked example's installation as its reader on a tapped pool of one session
 * (test/support/wire-tap.ts), warmed, so a window holds one call's traffic alone, and runs drawn commands:
 *
 * - execute, get and page of live queries with live parameters: an answer, sent on the wire;
 * - the same with a wild parameter value: an answer where the codec admits the value, ReadError{stage: "encode"} naming
 *   the parameter otherwise;
 * - a wild query, get target or page request: ReadError{stage: "compile"}, ReadError{stage: "request"} or a
 *   CursorError; a wild query's compile refusal carries the CompileError compile refuses the same value with;
 * - a stale query, built over a schema whose content is no level of the installed one the Db admitted (the worked
 *   example with one relation more): ReadError{stage: "compile"}; and a stale cursor, from a page of another query: a
 *   CursorError;
 * - compile a live query and execute the handle at once, and execute a compiled handle later;
 * - dispose: the pool's scope closes, as a DbLayer's does when its layer is released, and every handle compiled before
 *   it is executed at once. The handle is stale: every call that needs a session is then ReadError{stage: "acquire"},
 *   a compiled handle's execute included, and every refusal before SQL is still the same refusal.
 *
 * The model is whether the pool is disposed and how many handles are compiled. Every refusal before SQL (the stages
 * encode, compile, request and capability, and a CursorError) is checked to send zero frontend messages, and after every
 * command the pool holds no leased session. A refusal is read from the error's typed fields, never from its text.
 */
interface Model {
	readonly disposed: boolean
	readonly compiled: number
}

/** A typed refusal: a ReadError's stage, a transient failure, or a CursorError. */
type Refusal = ReadStage | "TransientFailure" | "CursorError"

const refusalOf = (error: unknown): Refusal | undefined =>
	error instanceof CursorError
		? "CursorError"
		: Schema.is(TransientFailure)(error)
			? "TransientFailure"
			: Schema.is(ReadFailure)(error)
				? error.stage
				: undefined

/** The refusals before any SQL. */
const beforeSql: ReadonlyArray<Refusal> = [
	"CursorError",
	"encode",
	"compile",
	"request",
	"capability"
]

/** The calls a live and a wild value reach. */
type LiveCall = "execute" | "get" | "page"
type WildCall = "execute params" | "execute query" | "get values" | "get target" | "page request"

type BoundaryFeature =
	| `refused before SQL: ${Refusal}`
	| `${LiveCall} live`
	| `${WildCall} wild`
	| "execute stale"
	| "page stale cursor"
	| "compile"
	| "compiled execute"
	| "compiled execute, disposed"
	| "disposed"

/**
 * What a case's commands run against: the tapped Db's reader, its tap and pool, the dispose of the pool, the compiled
 * handles in order, the reads the commands take, and where a command's features go.
 */
interface Subject {
	readonly reader: ReaderValue
	readonly tap: Tap
	readonly pool: SessionPool
	readonly dispose: Effect.Effect<void>
	readonly handles: Array<CompiledReadValue>
	/** The scope every compiled handle of the case lives in, closed when the case ends. */
	readonly handleScope: Scope.Closeable
	readonly reads: Reads
	readonly note: Case<BoundaryFeature>["note"]
}

/** The live, stale and paging values of an installation's schema. */
interface Reads {
	readonly live: unknown
	readonly stale: unknown
	readonly ordered: unknown
	/** A cursor of a page of another ordered query. */
	readonly staleCursor: string
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
		assert.equal(yield* real.pool.leased, 0, `${what} left a session leased`)
		return error
	})

/** A compiled handle's execute: an answer before dispose, ReadError{stage: "acquire"} after. */
const executeCompiled = (
	model: Model,
	real: Subject,
	handle: CompiledReadValue
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const error = yield* called(real, "a compiled execute", handle.execute({ account: a1 }))
		expectLive(model, "a compiled execute", error)
		real.note(model.disposed ? "compiled execute, disposed" : "compiled execute")
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

/** The parameters each command draws: a wild value, a pick of a compiled handle, or none. */
type BoundaryParameters = Readonly<{
	"execute(live)": undefined
	"get(live)": undefined
	"page(live)": undefined
	"execute(stale query)": undefined
	"page(stale cursor)": undefined
	"execute params(wild)": Wild
	"execute query(wild)": Wild
	"get values(wild)": Wild
	"get target(wild)": Wild
	"page request(wild)": Wild
	compile: undefined
	"execute compiled": number
	dispose: undefined
}>

const none = () => constant(undefined)

/** Every wild kind, simplest first. */
const anyWild = () => wild(WILD_KINDS)

const always = (): boolean => true

const unchanged = (model: Model): Model => model

/**
 * The reader's state machine: every call applies in every state, a compiled handle's execute once one is compiled, and
 * dispose once.
 */
const boundaryMachine: Machine<Model, BoundaryParameters> = {
	initial: { disposed: false, compiled: 0 },
	commands: {
		"execute(live)": { applies: always, parameters: none, next: unchanged },
		"get(live)": { applies: always, parameters: none, next: unchanged },
		"page(live)": { applies: always, parameters: none, next: unchanged },
		"execute(stale query)": { applies: always, parameters: none, next: unchanged },
		"page(stale cursor)": { applies: always, parameters: none, next: unchanged },
		"execute params(wild)": { applies: always, parameters: anyWild, next: unchanged },
		"execute query(wild)": { applies: always, parameters: anyWild, next: unchanged },
		"get values(wild)": { applies: always, parameters: anyWild, next: unchanged },
		"get target(wild)": { applies: always, parameters: anyWild, next: unchanged },
		"page request(wild)": { applies: always, parameters: anyWild, next: unchanged },
		compile: {
			applies: always,
			parameters: none,
			next: (model) => ({ ...model, compiled: model.compiled + 1 })
		},
		"execute compiled": {
			applies: (model) => model.compiled > 0,
			parameters: () => int(0, 7),
			next: unchanged
		},
		dispose: {
			applies: (model) => !model.disposed,
			parameters: none,
			next: (model) => ({ ...model, disposed: true })
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
		expectLive(model, `a live ${what}`, yield* called(real, what, call))
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
		if (!Schema.is(ReadFailure)(error) || error.stage !== "encode") {
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
 * A wild query: an answer, or a compile refusal. db.compile refuses the same value too: no wild value is a value the
 * builders made, so it refuses it at its own boundary, by identity, before it reads the value, a MalformedDescription.
 */
const wildQuery = (real: Subject, wildValue: Wild): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { value, error } = yield* wildCall(real, "execute query", wildValue, ["compile"], (q) =>
			real.reader.execute(q, {})
		)
		if (!(Schema.is(ReadFailure)(error) && error.reason._tag === "CompileError")) {
			return
		}
		const compiled = yield* Effect.exit(
			real.reader.compile(value).pipe(Scope.provide(real.handleScope))
		)
		if (Exit.isSuccess(compiled)) {
			return assert.fail("db.compile admits a wild query")
		}
		const refused = defined(
			Option.getOrUndefined(Exit.findErrorOption(compiled)),
			"db.compile fails, not dies"
		)
		const reason = refused.reason
		if (reason._tag !== "MalformedDescription") {
			return assert.fail(`db.compile: a malformed description, not ${reason._tag}`)
		}
		assert.deepEqual(reason.at, SourceLoc("db.compile", []), "db.compile: at its own boundary")
	})

/** Each command run on the case's reader and held to the model's state before it, or after it for dispose. */
const stepsOf = (real: Subject): Real<Model, BoundaryParameters, never, never> => ({
	"execute(live)": (_parameters, model) =>
		live(real, "execute", real.reader.execute(real.reads.live, { account: a1 }), model),
	"get(live)": (_parameters, model) =>
		live(real, "get", real.reader.get(W.Task, { id: t1 }), model),
	"page(live)": (_parameters, model) =>
		live(real, "page", real.reader.page(real.reads.ordered, { account: a1 }, { first: 2 }), model),
	"execute(stale query)": () =>
		Effect.gen(function* () {
			const error = yield* called(
				real,
				"a stale execute",
				real.reader.execute(real.reads.stale, { account: a1 })
			)
			assert.equal(refusalOf(error), "compile", Formatter.format(error))
			real.note("execute stale")
		}),
	"page(stale cursor)": () =>
		Effect.gen(function* () {
			const request = { first: 2, after: real.reads.staleCursor }
			const error = yield* called(
				real,
				"a page",
				real.reader.page(real.reads.ordered, { account: a1 }, request)
			)
			assertInstanceOf(error, CursorError, "a stale cursor's page")
			real.note("page stale cursor")
		}),
	"execute params(wild)": (w) =>
		wildParam(real, "execute params", "account", w, (value) =>
			real.reader.execute(real.reads.live, { account: value })
		),
	"execute query(wild)": (w) => wildQuery(real, w),
	"get values(wild)": (w) =>
		wildParam(real, "get values", "id", w, (value) => real.reader.get(W.Task, { id: value })),
	"get target(wild)": (w) =>
		Effect.asVoid(
			wildCall(real, "get target", w, ["compile"], (value) => real.reader.get(value, { id: t1 }))
		),
	"page request(wild)": (w) =>
		Effect.asVoid(
			wildCall(real, "page request", w, ["request", "CursorError"], (value) =>
				real.reader.page(real.reads.ordered, { account: a1 }, value)
			)
		),
	compile: (_parameters, _before, after) =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				real.reader.compile(real.reads.live).pipe(Scope.provide(real.handleScope))
			)
			if (Exit.isFailure(exit)) {
				return assert.fail(`compile of a live query fails: ${Cause.pretty(exit.cause)}`)
			}
			real.handles.push(exit.value)
			real.note("compile")
			yield* executeCompiled(after, real, exit.value)
		}),
	"execute compiled": (pick, model) =>
		Effect.suspend(() =>
			executeCompiled(
				model,
				real,
				defined(real.handles[pick % real.handles.length], "a compiled handle")
			)
		),
	dispose: (_parameters, _before, after) =>
		Effect.gen(function* () {
			yield* real.dispose
			real.note("disposed")
			for (const handle of real.handles) {
				yield* executeCompiled(after, real, handle)
			}
		})
})

/**
 * The worked example with one relation more: a schema whose content differs from the installed Work, so a query built
 * over it is no level of the Db's schema, whatever either is named.
 */
const Newer = schema.extend(W.Work, { Label: relation("Label", { task: uuid }, ["task"]) }, [])

/** A read of Work's tasks by account built over Newer: stale for a Db over Work. */
const staleRead = query(Newer).rule((r) => {
	const { id, account } = v(W.Task)
	return r
		.match(W.Task, { id, account })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id })
})

/** The cursor of the first page of an ordered query other than `ordered`, read live. */
const cursorOf = (reader: ReaderValue, other: unknown) =>
	Effect.flatMap(reader.page(other, {}, { first: 1 }), (page) =>
		Option.match(page.pageInfo.endCursor, {
			onNone: () => Effect.die(new Error("the other ordered query delivers no row")),
			onSome: (cursor) =>
				typeof cursor === "string" ? Effect.succeed(cursor) : Effect.die(new Error("no cursor"))
		})
	)

layer(Substrate.layer, { excludeTestServices: true })("the public reader at its boundary", (it) => {
	it.effect(
		"answers live, stale and wild values by its contract, refuses before SQL without sending, and leaks no session",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* installed(W.Work, workFacts, { label: "real", extensions: [] })
					const s = o.schema
					const ordered = query(s)
						.rule((r) => {
							const { id } = v(W.Task)
							const { budget } = v(W.AutomaticTask)
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
							const { id } = v(W.Task)
							return r.match(W.Task, { id }).find({ id })
						})
						.orderBy(["id", "asc"])
					return yield* explore(
						{
							suite: "pg/reads/boundary",
							/** Up to twelve commands, so a case can compile, dispose and execute a stale handle among its other calls. */
							draw: drawn(program(boundaryMachine, { min: 0, max: 12 })),
							literal: Formatter.format,
							features: features<BoundaryFeature>([
								"refused before SQL: encode",
								"refused before SQL: compile",
								"refused before SQL: CursorError",
								"compiled execute",
								"compiled execute, disposed",
								"disposed"
							]),
							kept: [],
							runs: 40,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						(commands, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const substrate = yield* Substrate
									const opened = yield* Db.open(o.server.roles.app, {}).pipe(withLayer(o.layer))
									const context = defined(dbContext(opened), "the opened Db's context")
									const tap = makeTap(substrate.cluster)
									const poolScope = yield* Scope.make()
									yield* Effect.addFinalizer(() => Scope.close(poolScope, Exit.void))
									const pool = yield* poolFor(o.installed.as(o.server), {
										...defaultPool,
										transport: { kind: "given", transport: { _tag: "stream", open: tap.open } },
										pool: { idleTimeoutMs: 60_000, min: 1, max: 1 }
									}).pipe(Scope.provide(poolScope))
									yield* Effect.scoped(
										Effect.flatMap(pool.lease, (session) =>
											rowsOn(session, "SELECT 'warm'::text", [])
										)
									)
									const reader = dbReader(makeDb({ ...context, pool }, {}))
									const handleScope = yield* Scope.make()
									yield* Effect.addFinalizer(() => Scope.close(handleScope, Exit.void))
									const real: Subject = {
										reader,
										tap,
										pool,
										dispose: Scope.close(poolScope, Exit.void),
										handles: [],
										handleScope,
										reads: {
											live: W.workReads(s).automaticTasksFor,
											stale: staleRead,
											ordered,
											staleCursor: yield* cursorOf(reader, other)
										},
										note: c.note
									}
									yield* runProgram(boundaryMachine, stepsOf(real), commands)
								})
							)
					)
				}).pipe(Effect.scoped)
			),
		600_000
	)
})
