import { Effect, type Result } from "effect"
import { ok } from "#test/support/schedules/match.ts"
import type {
	AnyOp,
	Expectation,
	Join,
	ScheduleOp,
	ScheduleOutcome,
	Schedule,
	Step,
	StepId,
	Wait
} from "#test/support/schedules/types.ts"
import type { BelowSerializable } from "#test/support/substrate/session.ts"

const unnamed: StepId = { _tag: "Unnamed" }

/** The step must complete without waiting on a lock another session of the schedule holds. */
export const complete: Join = { _tag: "Complete" }

/**
 * The step may wait on a lock before it completes, as a statement closing a deadlock cycle does; for an Await, the
 * joined step may still be waiting, as the victim of a deadlock is until PostgreSQL's deadlock check runs.
 */
export const mayWait: Join = { _tag: "May" }

/** The step must be observed waiting on a lock, held by any backend. */
export const blocksAny: Wait<never> = { _tag: "Blocks", by: { _tag: "Any" } }

/** The step must be observed waiting on a lock held by `session`. */
export const blocksOn = <S extends string>(session: S): Wait<S> => ({
	_tag: "Blocks",
	by: { _tag: "Session", session }
})

/**
 * Constructors for schedules and steps. Every argument is required: what a step expects and how it waits are stated
 * at each step.
 *
 *   schedule("an identical insert in flight waits, then is a repeat", [
 *   	begin("a"),
 *   	sql("a", insert, rows(["1", "t"]), complete),
 *   	sql("b", insert, rows(), blocksOn("a")),
 *   	commit("a", ok(), complete),
 *   	awaits("b", complete),
 *   	check(`SELECT count(*)::text FROM t`, rows(["1"]))
 *   ])
 */
export const schedule = <D extends string, G extends string, W extends string>(
	name: string,
	steps: ReadonlyArray<Step<D, G, W>>
): Schedule<D, G, W> => ({ name, steps })

export const sql = <D extends string, W extends string>(
	session: D,
	text: string,
	expect: Expectation<ScheduleOutcome>,
	wait: Wait<W>
): Step<D, never, W> => ({
	_tag: "Perform",
	id: unnamed,
	session,
	action: { _tag: "Sql", sql: text },
	expect,
	wait
})

/** BEGIN ISOLATION LEVEL SERIALIZABLE, as every transaction. */
export const begin = <D extends string>(session: D): Step<D, never, never> => ({
	_tag: "Perform",
	id: unnamed,
	session,
	action: { _tag: "Begin" },
	expect: ok(),
	wait: complete
})

/** A planted writer's BEGIN below SERIALIZABLE: its writes are to be refused. */
export const beginBelow = <D extends string>(
	session: D,
	level: BelowSerializable
): Step<D, never, never> => ({
	_tag: "Perform",
	id: unnamed,
	session,
	action: { _tag: "BeginBelow", level },
	expect: ok(),
	wait: complete
})

export const commit = <D extends string, W extends string>(
	session: D,
	expect: Expectation<ScheduleOutcome>,
	wait: Wait<W>
): Step<D, never, W> => ({
	_tag: "Perform",
	id: unnamed,
	session,
	action: { _tag: "Commit" },
	expect,
	wait
})

export const rollback = <D extends string>(session: D): Step<D, never, never> => ({
	_tag: "Perform",
	id: unnamed,
	session,
	action: { _tag: "Rollback" },
	expect: ok(),
	wait: complete
})

/** An Op whose result type the step list does not see. */
const anyOp = <A>(op: ScheduleOp<A>): AnyOp => ({ unpack: (use) => use(op) })

/**
 * A grizzle operation run on behalf of `session`, whose backend the barrier watches. Its result, success or failure,
 * is judged by `expect`.
 */
export const op = <G extends string, A, E, W extends string>(
	session: G,
	name: string,
	run: Effect.Effect<A, E>,
	expect: Expectation<Result.Result<NoInfer<A>, NoInfer<E>>>,
	wait: Wait<W>
): Step<never, G, W> => ({
	_tag: "Operate",
	id: unnamed,
	session,
	name,
	op: anyOp({ run: Effect.result(run), expect }),
	wait
})

/** Joins `session`'s blocked step and judges the result that step declared. */
export const awaits = <S extends string>(session: S, join: Join): Step<never, never, S> => ({
	_tag: "Await",
	id: unnamed,
	session,
	join
})

/** A statement on the runner's observer connection, as the owner. */
export const check = (
	text: string,
	expect: Expectation<ScheduleOutcome>
): Step<never, never, never> => ({
	_tag: "Check",
	id: unnamed,
	sql: text,
	expect
})
