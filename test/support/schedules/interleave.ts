import * as Interleave from "@grizzle/testing/interleave"
import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Option,
	Order,
	Record,
	type Scope,
	String as Str
} from "effect"
import { maxOf } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { defined } from "#test/support/assert.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import {
	type Actors,
	type DirectActor,
	failureOutcome,
	textOfValue
} from "#test/support/schedules/actors.ts"
import { describeStepOutcome } from "#test/support/schedules/match.ts"
import type { DirectAction, ScheduleOutcome, StepOutcome } from "#test/support/schedules/types.ts"
import { type LockWait, lockWaitOf } from "#test/support/substrate/barrier.ts"
import { connect } from "#test/support/substrate/session.ts"
import type { SubstrateShape, TextRows } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/**
 * What a step reads or writes: every relation, or the named ones (with the participants of every law it reaches).
 * Two footprints commute when neither is `every` and their relations are disjoint (and see `independent`).
 */
export type Footprint =
	| { readonly kind: "every" }
	| { readonly kind: "relations"; readonly relations: ReadonlySet<string> }

export const everyRelation: Footprint = { kind: "every" }

export const relationsFootprint = (relations: Iterable<string>): Footprint => ({
	kind: "relations",
	relations: new Set(relations)
})

const commute = (a: Footprint, b: Footprint): boolean =>
	a.kind === "relations" &&
	b.kind === "relations" &&
	!Arr.some([...a.relations], (r) => b.relations.has(r))

const union = (footprints: ReadonlyArray<Footprint>): Footprint =>
	Arr.some(footprints, (f) => f.kind === "every")
		? everyRelation
		: relationsFootprint(
				Arr.flatMap(footprints, (f) => (f.kind === "relations" ? [...f.relations] : []))
			)

/** A direct transaction's statement, with its footprint. */
interface SqlStep {
	readonly label: string
	readonly sql: string
	readonly footprint: Footprint
}

/** A grizzle session's operation, with its footprint: `outcome` runs it and states what it did, and never fails. */
export interface OpStep {
	readonly label: string
	readonly outcome: Effect.Effect<StepOutcome>
	readonly footprint: Footprint
}

/** A scripted direct session's action, as written. */
export interface ActionStep {
	readonly label: string
	readonly action: DirectAction
	readonly footprint: Footprint
}

/**
 * The backend a world move runs on:
 *
 * - `watched`: a pooled connection, which the driver watches in pg_locks while the move runs, its pid read at every
 *   poll, since a pooled connection's serving backend is known only once a step leases it;
 * - `opens`: a direct session's BEGIN, which opens the session's connection and takes no snapshot, so it cannot wait on
 *   a lock another session holds; once it has run, `pid` reads the backend it opened, none when it opened no session;
 * - `opened`: a later move of a direct session, on the backend its BEGIN opened, which the driver knows from the BEGIN
 *   on, until the session's last move ends it, whether or not it ever saw one of the session's moves in flight.
 */
export type Backend =
	| { readonly kind: "watched"; readonly pid: Effect.Effect<number> }
	| { readonly kind: "opens"; readonly pid: Effect.Effect<Option.Option<number>> }
	| { readonly kind: "opened" }

/** What a move ends: nothing, or its transaction, by a COMMIT (whose success commits it) or a ROLLBACK. */
export type TxnEnd = "nothing" | "commit" | "rollback"

/**
 * A world session's move: one action of the worlds vocabulary (or a probe of a pooled connection) on the real system.
 * `ends` says whether the move ends a transaction and whether its success commits it: a Db's operation is a
 * transaction of its own, a direct session's statements run inside the transaction its BEGIN opened. `blocked` says
 * what the driver does when it observes the move waiting on another session's lock: wait for it, or interrupt it there,
 * mid-flight with its statement sent and unanswered, as a caller's interruption does; an interrupted move's outcome is
 * `Interrupted`.
 */
export interface WorldStep {
	readonly label: string
	readonly outcome: Effect.Effect<StepOutcome>
	readonly footprint: Footprint
	readonly ends: TxnEnd
	readonly backend: Backend
	readonly blocked: "wait" | "interrupt"
}

/**
 * One session's work, by the kind of actor it runs on and what ends it. `after`: the session that must finish first,
 * or none; a session after none may move from the start.
 *
 * A world session runs on a named `connection`: sessions naming one connection (two Dbs of one login on a pool of
 * size one) never have steps in flight at once, so while one session's step is blocked no session sharing its
 * connection is runnable. It waits on the pool, a wait no lock shows, which only the blocked step's completion ends.
 * A world session's failure does not end it: its later steps run and meet what the failure left. Its `release` ends
 * whatever it still holds once it moves no more (Driver's `release`): a direct session's transaction, and nothing for
 * a Db's, whose operations are each a transaction of their own.
 */
export type Txn =
	| {
			readonly kind: "direct"
			readonly session: string
			readonly steps: ReadonlyArray<SqlStep>
			readonly end: "commit" | "rollback"
			readonly after: string | undefined
	  }
	| {
			readonly kind: "scripted"
			readonly session: string
			readonly steps: ReadonlyArray<ActionStep>
			readonly after: string | undefined
	  }
	| {
			readonly kind: "grizzle"
			readonly session: string
			readonly steps: ReadonlyArray<OpStep>
			readonly after: string | undefined
	  }
	| {
			readonly kind: "world"
			readonly session: string
			readonly connection: string
			readonly steps: ReadonlyArray<WorldStep>
			readonly release: Effect.Effect<void>
			readonly after: string | undefined
	  }

/**
 * How a session's work ended; `outcomes` are its moves' outcomes in order, a direct transaction's COMMIT or ROLLBACK
 * included, up to and including its first failure. A grizzle operation that succeeded is an Ok move (an operation's
 * own refusal, such as invariant-rejected, is its value, which the model reads).
 */
export type TxnResult =
	| {
			readonly _tag: "Committed"
			readonly session: string
			readonly outcomes: ReadonlyArray<StepOutcome>
	  }
	| {
			readonly _tag: "RolledBack"
			readonly session: string
			readonly outcomes: ReadonlyArray<StepOutcome>
	  }
	| {
			readonly _tag: "Failed"
			readonly session: string
			readonly outcomes: ReadonlyArray<StepOutcome>
			readonly failure: StepOutcome
	  }

/** What a run reads on the observer after its last move for its model, and what it read. */
type StateRead = { readonly _tag: "Unread" } | { readonly _tag: "Read"; readonly sql: string }
type StateRows = { readonly _tag: "Unread" } | { readonly _tag: "Read"; readonly rows: TextRows }

/**
 * A step observed waiting on a lock other sessions hold: its session, and each holder with the steps it had finished
 * when the wait was observed (a direct transaction's statements, its BEGIN riding on the first; a grizzle session's
 * operations).
 */
interface BlockedStep {
	readonly session: string
	readonly holders: ReadonlyArray<{ readonly session: string; readonly finished: number }>
}

/**
 * A deadlock PostgreSQL broke: the blocked sessions of its cycle in the order they began to wait, the sessions that
 * could have moved meanwhile, and the victim, the session whose blocked step failed with 40P01, or none when
 * PostgreSQL granted a lock of the cycle instead.
 */
interface BrokenDeadlock {
	readonly cycle: Arr.NonEmptyReadonlyArray<string>
	readonly runnable: ReadonlyArray<string>
	readonly victim: string | undefined
}

/**
 * How a move was observed: it completed without waiting on another session's lock; it was seen waiting on one, held
 * by these sessions (the first wait seen); or it answered 40P01 before its wait was seen, which only a waiting backend
 * can, so it waited too.
 */
type Observed =
	| { readonly _tag: "Ran" }
	| { readonly _tag: "Waited"; readonly lock: LockWait; readonly on: ReadonlyArray<string> }
	| { readonly _tag: "Victim" }

/**
 * One move as the database ran it: the session, the step's index among the session's steps, its label, when it was
 * issued on the run's event clock, how it was observed, and its outcome with when it finished, or Unfinished when the
 * run ended first (a stopped script).
 */
export interface MoveRecord {
	readonly session: string
	readonly step: number
	readonly label: string
	readonly issued: number
	readonly observed: Observed
	readonly result:
		| { readonly _tag: "Finished"; readonly outcome: StepOutcome; readonly at: number }
		| { readonly _tag: "Unfinished" }
}

/**
 * A choice at a decision point: a move of a session; for a script, also a join of a session's blocked step, which must
 * have completed by then, and a read on the observer.
 */
export type Choice =
	| { readonly _tag: "Move"; readonly session: string }
	| { readonly _tag: "Join"; readonly session: string }
	| { readonly _tag: "Read"; readonly sql: string }

/**
 * One decision point on the tape: what the database showed there (`seen`: the runnable sessions, the blocked ones with
 * their holders, and how each finished session ended), and the choice taken.
 */
interface Decision {
	readonly seen: string
	readonly runnable: ReadonlyArray<string>
	readonly choice: Choice
}

/** A read a script made on the observer, with the decision point it was made at. */
interface ObserverRead {
	readonly at: number
	readonly sql: string
	readonly outcome: ScheduleOutcome
}

/**
 * How the run relates to the tape it replayed: as taped (or nothing to replay), or branched at a decision point where
 * the database showed something other than the tape, from where its choices are fresh.
 */
type Replay =
	| { readonly _tag: "AsTaped" }
	| { readonly _tag: "Branched"; readonly at: number }
	| { readonly _tag: "Diverged"; readonly at: number; readonly nature: "chose" | "had no choice" }

/** How the run ended: every session finished (or the script's choices ran out), or a script's choice was impossible. */
type Ending =
	| { readonly _tag: "Ran" }
	| { readonly _tag: "Stopped"; readonly at: number; readonly choice: Choice; readonly why: string }

export interface Interleaving {
	/** The moves in the order they were issued, `session: label`, a blocked step marked. */
	readonly order: ReadonlyArray<string>
	readonly results: Readonly<Record<string, TxnResult>>
	/**
	 * Sessions in the order their transactions committed (a grizzle session at each operation that succeeded, a
	 * scripted session at each COMMIT that succeeded).
	 */
	readonly commits: ReadonlyArray<string>
	readonly state: StateRows
	/**
	 * Each session's span on the run's event clock, which counts every move issued and every step finished: from its
	 * first move to its last step's finish. A span that ends before another begins ran entirely before it.
	 */
	readonly spans: Readonly<Record<string, { readonly start: number; readonly end: number }>>
	/** Every step observed blocked on another session's lock, in the order observed. */
	readonly waits: ReadonlyArray<BlockedStep>
	/** Every deadlock PostgreSQL broke, in the order broken. */
	readonly deadlocks: ReadonlyArray<BrokenDeadlock>
	/** Every move issued, in order, as observed. */
	readonly moves: ReadonlyArray<MoveRecord>
	readonly reads: ReadonlyArray<ObserverRead>
	readonly tape: ReadonlyArray<Decision>
	readonly replay: Replay
	readonly ending: Ending
}

/** A model's judgment of one run: allowed, or refused with why. */
export type Judgment =
	| { readonly _tag: "Allowed" }
	| { readonly _tag: "Refused"; readonly why: string }

export const allowed: Judgment = { _tag: "Allowed" }

export const refusedJudgment = (why: string): Judgment => ({ _tag: "Refused", why })

export interface Exploration<E> {
	readonly name: string
	readonly txns: ReadonlyArray<Txn>
	/** Restores the initial state before each run. */
	readonly reset: Effect.Effect<void, E>
	/** Read on the observer after each run. */
	readonly state: StateRead
	/** Whether a run's outcomes are allowed, and why not when they are not. */
	readonly model: (i: Interleaving) => Effect.Effect<Judgment, E>
	/** A bound on the runs of `every`, to catch a runaway exploration. */
	readonly maxInterleavings: number
}

/**
 * The bound the suites pass as maxInterleavings: a protective cap, so an exploration whose sleep sets fail to prune
 * fails instead of running on.
 */
export const runawayInterleavings = 500

/**
 * How the decisions of an exploration are made, on the library's interleave: `every` runs every distinct order (sleep
 * sets prune orders of commuting moves; the exploration's `maxInterleavings` is its runaway guard); `pct` runs the
 * highest-priority session that can move, its priorities and change points drawn in the case (`pctSchedule`); `drawn`
 * draws each decision from the case's tape; `script` makes the decisions it lists. A drawn or PCT schedule records what
 * PostgreSQL showed at each decision on the case's tape, so a replay that sees otherwise says where.
 */
export type Strategy =
	| { readonly kind: "every" }
	| {
			readonly kind: "pct"
			readonly schedule: Interleave.PctSchedule<string>
			readonly nature: Interleave.Nature
	  }
	| { readonly kind: "drawn"; readonly nature: Interleave.Nature }
	| { readonly kind: "script"; readonly choices: ReadonlyArray<Choice> }

export const every: Strategy = { kind: "every" }

/** How many moves a set of transactions makes when every one runs to its end: PCT's k. */
export const movesOf = (txns: ReadonlyArray<Txn>): number =>
	Arr.reduce(txns, 0, (sum, t) => sum + t.steps.length + (t.kind === "direct" ? 1 : 0))

interface ExplorationReport {
	readonly interleavings: number
	readonly pruned: number
	/** How many runs committed each set of sessions, keyed by the committed sessions joined, or "none". */
	readonly committedSets: ReadonlyMap<string, number>
	readonly blocked: number
	readonly branched: number
}

/** A run the exploration's model refused, with the run's description: the library reports it with its own record of the
 * run and the script that replays it. */
class RunRefused extends Data.TaggedError("RunRefused")<{
	readonly exploration: string
	readonly reason: string
	readonly report: string
}> {
	override get message(): string {
		return this.report
	}
}

/** The driver's view of the database: an observer connection, as the owner, that is none of the sessions under test. */
export interface ExploreEnv {
	readonly observer: PgConnection
}

/**
 * Opens the observer connection in the current scope. Its reads run at READ COMMITTED, whatever the database's
 * default: the observer reads the catalog and a schedule's checks, and never takes part in the sessions' serializable
 * conflicts.
 */
export const exploreEnv = (
	substrate: SubstrateShape
): Effect.Effect<ExploreEnv, SqlError, Scope.Scope> =>
	Effect.gen(function* () {
		const observer = yield* connect(substrate.cluster, {
			database: substrate.database,
			credentials: substrate.owner,
			label: "observer"
		})
		yield* observer.query("SET default_transaction_isolation TO 'read committed'", [])
		return { observer }
	})

/**
 * Sleeps on the server until the deadlock check of every backend in $1 that waits on a lock is past: each wait began
 * at pg_locks.waitstart and its check runs deadlock_timeout later, so twice that has passed. A wait whose waitstart is
 * not yet set (PostgreSQL sets it a moment after the wait begins) is counted in the first column, and the caller polls
 * again.
 */
const deadlockChecksQuery = `WITH w AS (
	SELECT count(*) FILTER (WHERE l.waitstart IS NULL)::int4 AS unset, max(l.waitstart) AS latest
	FROM pg_catalog.pg_locks AS l WHERE l.pid = ANY ($1::int4[]) AND NOT l.granted
)
SELECT w.unset, pg_catalog.pg_sleep(CASE WHEN w.unset > 0 OR w.latest IS NULL THEN 0::float8 ELSE
	GREATEST(0::float8, EXTRACT(epoch FROM w.latest + 2 * pg_catalog.current_setting('deadlock_timeout')::interval - pg_catalog.clock_timestamp())::float8) END)::text
FROM w`

/** A row of deadlockChecksQuery: how many waits have no waitstart yet, and the sleep's text. */
type DeadlockChecksRow = readonly [unset: number, slept: string]

/** Returns once every waiting backend among `pids` is past its deadlock check. */
const awaitDeadlockChecks = (
	observer: PgConnection,
	pids: ReadonlyArray<number>
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		for (;;) {
			const [row] = yield* observer.queryValues(deadlockChecksQuery, [pids])
			const [unset] = trusted<DeadlockChecksRow>(defined(row, "the deadlock-check query's one row"))
			if (unset === 0) {
				return
			}
			yield* Effect.yieldNow
		}
	})

const compact = (text: string): string => {
	const flat = Str.trim(Str.replace(regex("\\s+", "g"), " ")(text))
	return flat.length > 120 ? `${Str.slice(0, 119)(flat)}…` : flat
}

/**
 * The backend a move runs on, as the driver knows it: its session's own, the one backend a direct or grizzle actor
 * opened before the exploration, which holds the session's transaction between its moves and is known from the start;
 * or a world move's (Backend).
 */
type MoveBackend = { readonly kind: "own"; readonly pid: number } | Backend

/**
 * One move as the library runs it: the step's label, the Effect that runs it (never failing: a failure is its
 * outcome), the backend it may wait on, whether it is left to wait or interrupted when seen waiting, its footprint and
 * what it ends, and the session's kind, which decides what a failure does to the session.
 */
interface Move {
	readonly label: string
	readonly run: Effect.Effect<StepOutcome>
	readonly backend: MoveBackend
	readonly blocked: "wait" | "interrupt"
	readonly footprint: Footprint
	readonly ends: TxnEnd
	readonly kind: Txn["kind"]
}

/** Whether two moves of different sessions commute: their footprints do, and not both end a transaction. */
const independent = (a: Move, b: Move): boolean =>
	!(a.ends !== "nothing" && b.ends !== "nothing") && commute(a.footprint, b.footprint)

const succeeded: ScheduleOutcome = { _tag: "Ok", rows: [], rowCount: 0 }

/** A direct move's actions in order, stopping at the first that does not succeed. */
const performAll = (
	actor: DirectActor,
	actions: ReadonlyArray<DirectAction>
): Effect.Effect<StepOutcome> =>
	Effect.gen(function* () {
		let last: ScheduleOutcome = succeeded
		for (const action of actions) {
			last = yield* actor.perform(action)
			if (last._tag !== "Ok") {
				return last
			}
		}
		return last
	})

/** Whether an outcome is a success: an Ok step. */
const isSuccess = (outcome: StepOutcome): boolean => outcome._tag === "Ok"

const isDeadlockVictim = (outcome: StepOutcome): boolean =>
	outcome._tag === "PgError" && outcome.fields.code === "40P01"

/**
 * Each direct, scripted and grizzle session's own backend, read once from its actor, which opened it before the
 * exploration. A session with no actor of its kind is a defect of the exploration.
 */
const ownBackends = (
	actors: Actors<string, string>,
	txns: ReadonlyArray<Txn>
): Effect.Effect<ReadonlyMap<string, number>> =>
	Effect.map(
		Effect.forEach(txns, (t): Effect.Effect<ReadonlyArray<readonly [string, number]>> => {
			switch (t.kind) {
				case "world":
					return Effect.succeed([])
				case "grizzle":
					return Effect.succeed([
						[
							t.session,
							defined(actors.grizzle[t.session], `the grizzle actor of ${t.session}`).pid
						] as const
					])
				case "scripted":
				case "direct":
					return Effect.map(
						Effect.orDie(defined(actors.direct[t.session], `the direct actor of ${t.session}`).pid),
						(pid) => [[t.session, pid] as const]
					)
			}
		}),
		(entries) => new Map(Arr.flatten(entries))
	)

/** A direct, scripted or grizzle session's own backend, which ownBackends read for every such session. */
const ownBackend = (owned: ReadonlyMap<string, number>, session: string): MoveBackend => ({
	kind: "own",
	pid: defined(owned.get(session), `the backend of ${session}`)
})

/**
 * A session's moves, as data the library schedules: a direct transaction's statements, its BEGIN riding on the first
 * and its COMMIT or ROLLBACK the last move, the first and last moves reaching what the whole transaction reaches (the
 * first takes the snapshot, COMMIT fires the deferred triggers); a scripted session's actions as written; a grizzle
 * session's operations, each its own transaction; a world session's steps. A session with no actor of its kind is a
 * defect of the exploration.
 */
const movesOfTxn = (
	actors: Actors<string, string>,
	owned: ReadonlyMap<string, number>,
	t: Txn
): Arr.NonEmptyReadonlyArray<Move> => {
	const withMoves = (moves: ReadonlyArray<Move>): Arr.NonEmptyReadonlyArray<Move> => {
		const [first, ...rest] = moves
		return [defined(first, `${t.session}'s first move`), ...rest]
	}
	switch (t.kind) {
		case "grizzle":
			return withMoves(
				Arr.map(t.steps, (s): Move => ({
					label: s.label,
					run: s.outcome,
					backend: ownBackend(owned, t.session),
					blocked: "wait",
					footprint: s.footprint,
					ends: "commit",
					kind: "grizzle"
				}))
			)
		case "world":
			return withMoves(
				Arr.map(t.steps, (s): Move => ({
					label: s.label,
					run: s.outcome,
					backend: s.backend,
					blocked: s.blocked,
					footprint: s.footprint,
					ends: s.ends,
					kind: "world"
				}))
			)
		case "scripted": {
			const actor = defined(actors.direct[t.session], `the direct actor of ${t.session}`)
			return withMoves(
				Arr.map(t.steps, (s): Move => ({
					label: s.label,
					run: performAll(actor, [s.action]),
					backend: ownBackend(owned, t.session),
					blocked: "wait",
					footprint: s.footprint,
					ends:
						s.action._tag === "Commit"
							? "commit"
							: s.action._tag === "Rollback"
								? "rollback"
								: "nothing",
					kind: "scripted"
				}))
			)
		}
		case "direct": {
			const actor = defined(actors.direct[t.session], `the direct actor of ${t.session}`)
			const whole = union(Arr.map(t.steps, (x) => x.footprint))
			const statements = Arr.map(t.steps, (s, i): Move => ({
				label: s.label,
				run: performAll(actor, [
					...(i === 0 ? [{ _tag: "Begin" } as const] : []),
					{ _tag: "Sql", sql: s.sql }
				]),
				backend: ownBackend(owned, t.session),
				blocked: "wait",
				footprint: i === 0 ? whole : s.footprint,
				ends: "nothing",
				kind: "direct"
			}))
			const end: Move = {
				label: Str.toUpperCase(t.end),
				run: performAll(actor, [
					...(t.steps.length === 0 ? [{ _tag: "Begin" } as const] : []),
					t.end === "commit" ? { _tag: "Commit" } : { _tag: "Rollback" }
				]),
				backend: ownBackend(owned, t.session),
				blocked: "wait",
				footprint: whole,
				ends: t.end,
				kind: "direct"
			}
			return withMoves([...statements, end])
		}
	}
}

type LibraryRun = Interleave.Interleaving<
	string,
	Move,
	StepOutcome,
	string,
	ScheduleOutcome,
	LockWait
>

type LibraryMove = Interleave.MoveRecord<string, Move, StepOutcome, LockWait>

/**
 * How a session is released once it moves no more (Driver's `release`): a direct or scripted session's transaction
 * rolled back on its actor, a ROLLBACK with no transaction open doing nothing, and one that fails a defect; a grizzle
 * session holds nothing between its operations; a world session by its own release. The library releases every session
 * a run started however the run ends, so a run the search prunes, stops or fails, or the case's hang guard interrupts,
 * leaves no transaction open for the next reset's writes to wait on. A session with no actor of its kind is a defect of
 * the exploration.
 */
const releaseOf = (actors: Actors<string, string>, t: Txn): Effect.Effect<void> => {
	switch (t.kind) {
		case "grizzle":
			return Effect.void
		case "world":
			return t.release
		case "direct":
		case "scripted": {
			const actor = defined(actors.direct[t.session], `the direct actor of ${t.session}`)
			return Effect.flatMap(actor.perform({ _tag: "Rollback" }), (outcome) =>
				outcome._tag === "Ok"
					? Effect.void
					: Effect.die(
							new Error(
								`${actor.name} could not end its transaction: ${describeStepOutcome(outcome)}`
							)
						)
			)
		}
	}
}

/**
 * PostgreSQL behind the library's driver. A move runs as its step runs; a move in flight waits when its backend waits
 * on a heavyweight lock another session's backend holds, read from pg_locks on the observer (never one of the
 * sessions). A wait is on the sessions whose backends hold the lock: every direct, scripted and grizzle session's own
 * backend is known from the start (`owned`), and a world direct session's from its BEGIN until its last move ends it,
 * so a session that took its locks in a move the driver never saw in flight is still known for holding them; a pooled
 * world move's backend is re-read at every poll, since a pooled connection is known only once a step leases it. The
 * system has decided every wait once each waiting backend's deadlock check is past; a direct transaction's failure ends
 * it, and the library releases it at once (`releases`, releaseOf), while any other session's failure leaves it running
 * to meet what the failure left; a move interrupted where it waited is `Interrupted`; and each reset forgets the
 * backends world sessions opened or were seen on.
 */
const driverOf = <E>(
	env: ExploreEnv,
	releases: ReadonlyMap<string, Effect.Effect<void>>,
	owned: ReadonlyMap<string, number>,
	reset: Effect.Effect<void, E>
): Interleave.Driver<
	string,
	Move,
	StepOutcome,
	string,
	ScheduleOutcome,
	LockWait,
	E | SqlError,
	never
> => {
	const inFlight = new Map<string, Move>()
	/**
	 * Each session's backend: its own, the one a world direct session's BEGIN opened while the session lasts, or the one
	 * a pooled world move was last seen on in this run.
	 */
	const pids = new Map<string, number>(owned)
	const pidOf = (session: string, move: Move): Effect.Effect<Option.Option<number>> => {
		switch (move.backend.kind) {
			case "own":
				return Effect.succeedSome(move.backend.pid)
			case "watched":
				return Effect.map(move.backend.pid, (pid) => {
					pids.set(session, pid)
					return Option.some(pid)
				})
			case "opens":
				return Effect.succeedNone
			case "opened":
				return Effect.succeed(Option.fromNullishOr(pids.get(session)))
		}
	}
	/**
	 * What a finished move tells of its session's backend: a BEGIN, the backend it opened, read while the session it just
	 * opened is surely open; a direct session's last move, that its backend is gone.
	 */
	const settled = (session: string, move: Move): Effect.Effect<void> => {
		switch (move.backend.kind) {
			case "opens":
				return Effect.map(move.backend.pid, (opened) => {
					if (Option.isSome(opened)) {
						pids.set(session, opened.value)
					}
				})
			case "opened":
				return move.ends === "nothing"
					? Effect.void
					: Effect.sync(() => {
							pids.delete(session)
						})
			case "own":
			case "watched":
				return Effect.void
		}
	}
	return {
		reset: Effect.andThen(
			Effect.sync(() => {
				inFlight.clear()
				pids.clear()
				for (const [session, pid] of owned) {
					pids.set(session, pid)
				}
			}),
			reset
		),
		run: (session, move) =>
			Effect.suspend(() => {
				inFlight.set(session, move)
				return Effect.ensuring(
					Effect.tap(move.run, () => settled(session, move)),
					Effect.sync(() => inFlight.delete(session))
				)
			}),
		waitOf: (session, move) =>
			Effect.gen(function* () {
				const own = yield* pidOf(session, move)
				if (Option.isNone(own)) {
					return Option.none()
				}
				for (const [other, otherMove] of inFlight) {
					if (other !== session) {
						yield* pidOf(other, otherMove)
					}
				}
				const wait = yield* lockWaitOf(env.observer, own.value)
				if (wait === undefined) {
					return Option.none()
				}
				const holderOf = (pid: number): ReadonlyArray<string> => {
					const stepping = Arr.filter(
						[...inFlight.keys()],
						(s) => s !== session && pids.get(s) === pid
					)
					return stepping.length > 0
						? stepping
						: Arr.filter(
								[...pids.keys()],
								(s) => s !== session && pids.get(s) === pid && pid !== own.value
							)
				}
				const holders = Arr.dedupe(Arr.flatMap(wait.blockedBy, holderOf))
				return Arr.isReadonlyArrayNonEmpty(holders)
					? Option.some({ on: holders, detail: wait })
					: Option.none()
			}),
		quiesce: (waiting) =>
			awaitDeadlockChecks(
				env.observer,
				Arr.flatMap(waiting, (session) => Option.toArray(Option.fromNullishOr(pids.get(session))))
			),
		outcome: (move, ended) => {
			const outcome: StepOutcome =
				ended.kind === "cancelled" ? { _tag: "Interrupted" } : ended.outcome
			return {
				key: outcome._tag === "PgError" ? `${outcome._tag} ${outcome.fields.code}` : outcome._tag,
				session: !isSuccess(outcome) && move.kind === "direct" ? "ends" : "continues"
			}
		},
		release: (session) =>
			Effect.suspend(() => defined(releases.get(session), `the release of ${session}`)),
		commute: independent,
		onWait: (move) => move.blocked,
		read: (sql) =>
			Effect.match(env.observer.queryValues(sql, []), {
				onSuccess: (found): ScheduleOutcome => ({
					_tag: "Ok",
					rows: Arr.map(found, (row) => Arr.map(row, textOfValue)),
					rowCount: found.length
				}),
				onFailure: failureOutcome
			})
	}
}

/** grizzle's choice as the library's, and back. */
const libraryChoice = (choice: Choice): Interleave.Choice<string, string> =>
	choice._tag === "Move"
		? { kind: "move", session: choice.session }
		: choice._tag === "Join"
			? { kind: "join", session: choice.session }
			: { kind: "read", query: choice.sql }

const grizzleChoice = (choice: Interleave.Choice<string, string>): Choice =>
	choice.kind === "move"
		? { _tag: "Move", session: choice.session }
		: choice.kind === "join"
			? { _tag: "Join", session: choice.session }
			: { _tag: "Read", sql: choice.query }

const outcomeOf = (result: Interleave.MoveResult<StepOutcome>): StepOutcome =>
	result.ended.kind === "cancelled" ? { _tag: "Interrupted" } : result.ended.outcome

/** A run as grizzle's models read it, from the library's record of it and the state read after it. */
const interleavingOf = (
	txns: ReadonlyArray<Txn>,
	run: LibraryRun,
	state: StateRows
): Interleaving => {
	const finishedBy = (session: string, at: number) =>
		Arr.filter(
			run.order,
			(m) => m.session === session && Option.exists(m.ended, (ended) => ended < at)
		).length
	const moves = Arr.map(run.order, (m): MoveRecord => {
		const outcome = Option.map(m.result, outcomeOf)
		return {
			session: m.session,
			step: m.index,
			label: m.move.label,
			issued: m.issued,
			observed: Option.match(m.waited, {
				onNone: () =>
					Option.exists(outcome, isDeadlockVictim) ? { _tag: "Victim" } : { _tag: "Ran" },
				onSome: (waited) => ({ _tag: "Waited", lock: waited.wait.detail, on: waited.wait.on })
			}),
			result:
				Option.isSome(outcome) && Option.isSome(m.ended)
					? { _tag: "Finished", outcome: outcome.value, at: m.ended.value }
					: { _tag: "Unfinished" }
		}
	})
	const order = Arr.map(run.order, (m) =>
		Option.match(Option.map(m.result, outcomeOf), {
			onNone: () => `${m.session}: ${compact(m.move.label)} (blocked)`,
			onSome: (outcome) =>
				Option.isSome(m.waited) && outcome._tag === "Interrupted"
					? `${m.session}: ${compact(m.move.label)} (blocked, interrupted)`
					: `${m.session}: ${compact(m.move.label)} -> ${describeStepOutcome(outcome)}`
		})
	)
	const ended = Arr.filter(run.order, (m) => Option.isSome(m.ended))
	const commits = Arr.flatMap(
		Arr.sort(
			ended,
			Order.mapInput(Order.Number, (m: LibraryMove) => Option.getOrElse(m.ended, () => 0))
		),
		(m: LibraryMove) =>
			Option.exists(m.result, (result) => isSuccess(outcomeOf(result))) && m.move.ends === "commit"
				? [m.session]
				: []
	)
	const results = Record.fromEntries(
		Arr.map(txns, (t): readonly [string, TxnResult] => {
			const ran = Arr.flatMap(
				Arr.filter(run.order, (m) => m.session === t.session),
				(m: LibraryMove) => Option.toArray(Option.map(m.result, outcomeOf))
			)
			const failure = Arr.findFirst(ran, (o) => !isSuccess(o))
			const rolledBack =
				(t.kind === "direct" && t.end === "rollback") ||
				(t.kind === "scripted" && t.steps[t.steps.length - 1]?.action._tag === "Rollback")
			return [
				t.session,
				Option.match(failure, {
					onSome: (failed): TxnResult => ({
						_tag: "Failed",
						session: t.session,
						outcomes: ran,
						failure: failed
					}),
					onNone: (): TxnResult =>
						rolledBack
							? { _tag: "RolledBack", session: t.session, outcomes: ran }
							: { _tag: "Committed", session: t.session, outcomes: ran }
				})
			]
		})
	)
	const spans = Record.fromEntries(
		Arr.flatMap(txns, (t) => {
			const own = Arr.filter(run.order, (m) => m.session === t.session)
			const [first] = own
			const ends = Arr.flatMap(own, (m) => Option.toArray(m.ended))
			return first === undefined
				? []
				: [[t.session, { start: first.issued, end: maxOf(ends, first.issued) }] as const]
		})
	)
	return {
		order,
		results,
		commits,
		state,
		spans,
		waits: Arr.flatMap(run.order, (m) =>
			Option.toArray(
				Option.map(m.waited, (waited) => ({
					session: m.session,
					holders: Arr.map(waited.wait.on, (holder) => ({
						session: holder,
						finished: finishedBy(holder, waited.at)
					}))
				}))
			)
		),
		deadlocks: Arr.map(run.deadlocks, (d) => ({
			cycle: d.cycle,
			runnable: d.runnable,
			victim: Option.getOrUndefined(d.victim)
		})),
		moves,
		reads: Arr.map(run.reads, (read) => ({ at: read.at, sql: read.query, outcome: read.value })),
		tape: Arr.map(run.tape, (decision) => ({
			seen: decision.seen,
			runnable: decision.runnable,
			choice: grizzleChoice(decision.choice)
		})),
		replay:
			run.replay.kind === "as-taped"
				? { _tag: "AsTaped" }
				: run.replay.kind === "branched"
					? { _tag: "Branched", at: run.replay.at }
					: { _tag: "Diverged", at: run.replay.at, nature: run.replay.nature },
		ending:
			run.ending.kind === "stopped"
				? {
						_tag: "Stopped",
						at: run.ending.at,
						choice: grizzleChoice(run.ending.choice),
						why: run.ending.why
					}
				: { _tag: "Ran" }
	}
}

/**
 * The one concurrency driver: several sessions' steps, run in orders a strategy chooses, every run judged by a model of
 * the outcomes it allows. The scheduling is the library's interleave (every with sound sleep sets, PCT, drawn
 * decisions, scripts); everything PostgreSQL is here: how a move runs on its actor, how a wait is seen in pg_locks and
 * on whom, the deadlock check every wait passes before the next decision, what a failure does to a session, and which
 * moves commute. Each run is reset, scheduled, read back on the observer and judged; a refusal fails with the run's
 * description and the script that replays it. Sessions on one pooled connection share a lane. However a run ends, the
 * library releases every session it started (releaseOf), so no run leaves a transaction open.
 */
export const exploreInterleavings = <E>(
	env: ExploreEnv,
	actors: Actors<string, string>,
	spec: Exploration<E>,
	strategy: Strategy
): Effect.Effect<
	ExplorationReport,
	E | SqlError | Interleave.AfterCycle | Interleave.InterleavingFailed
> =>
	Effect.gen(function* () {
		const owned = yield* ownBackends(actors, spec.txns)
		const releases = new Map(Arr.map(spec.txns, (t) => [t.session, releaseOf(actors, t)] as const))
		const sessions: Interleave.Sessions<string, Move> = Record.fromEntries(
			Arr.map(
				spec.txns,
				(t) =>
					[
						t.session,
						{ moves: movesOfTxn(actors, owned, t), after: Option.fromNullishOr(t.after) }
					] as const
			)
		)
		const lanes = Arr.groupBy(
			Arr.flatMap(spec.txns, (t) => (t.kind === "world" ? [t] : [])),
			(t) => t.connection
		)
		const exclusive = Arr.flatMap(Record.values(lanes), (lane) => {
			const [first, second, ...rest] = Arr.map(lane, (t) => t.session)
			return second === undefined ? [] : [[first, second, ...rest] as const]
		})
		const committedSets = new Map<string, number>()
		const libraryStrategy: Interleave.Strategy<string, string> =
			strategy.kind === "every"
				? { kind: "every", limit: spec.maxInterleavings, reduction: "sleep-sets" }
				: strategy.kind === "script"
					? { kind: "script", choices: Arr.map(strategy.choices, libraryChoice) }
					: strategy
		const report = yield* Interleave.interleave(
			driverOf(env, releases, owned, spec.reset),
			{ name: spec.name, sessions, exclusive, state: Option.none() },
			libraryStrategy,
			(run) =>
				Effect.gen(function* () {
					const state = yield* readState(env, spec.state)
					const i = interleavingOf(spec.txns, run, state)
					const judged = yield* spec.model(i)
					if (judged._tag === "Refused") {
						return yield* new RunRefused({
							exploration: spec.name,
							reason: judged.why,
							report: `exploration "${spec.name}": ${judged.why}\n${describeRun(spec.txns, i)}`
						})
					}
					const committed = Arr.filter(spec.txns, (x) => i.results[x.session]?._tag === "Committed")
					const key =
						committed.length === 0
							? "none"
							: Arr.join(
									Arr.map(committed, (x) => x.session),
									","
								)
					committedSets.set(key, (committedSets.get(key) ?? 0) + 1)
				})
		)
		return {
			interleavings: report.interleavings,
			pruned: report.pruned,
			committedSets,
			blocked: report.blocked,
			branched: report.branched
		}
	})

const describeChoice = (choice: Choice): string => {
	switch (choice._tag) {
		case "Move":
			return `move ${choice.session}`
		case "Join":
			return `join ${choice.session}`
		case "Read":
			return `read ${compact(choice.sql)}`
	}
}

/** A refused run for its report: each session's outcomes, the state read, where it branched, and its tape. */
const describeRun = (txns: ReadonlyArray<Txn>, i: Interleaving): string =>
	Arr.join(
		[
			`  outcomes: ${Arr.join(
				Arr.map(
					txns,
					(x) =>
						`${x.session} [${Arr.join(Arr.map(defined(i.results[x.session], `${x.session}'s result`).outcomes, describeStepOutcome), "; ")}]`
				),
				", "
			)}`,
			...(i.state._tag === "Read" ? [`  state: ${Formatter.format(i.state.rows)}`] : []),
			...(i.replay._tag === "AsTaped"
				? []
				: [
						`  ${i.replay._tag === "Branched" ? "branched" : "nature decided otherwise"} at decision ${i.replay.at + 1}`
					]),
			`  tape: ${Arr.join(
				Arr.map(i.tape, (d) => describeChoice(d.choice)),
				" | "
			)}`
		],
		"\n"
	)

/** The state an exploration reads after a run, as text rows. */
const readState = (env: ExploreEnv, state: StateRead): Effect.Effect<StateRows, SqlError> => {
	switch (state._tag) {
		case "Unread":
			return Effect.succeed({ _tag: "Unread" })
		case "Read":
			return Effect.map(env.observer.queryValues(state.sql, []), (rows) => ({
				_tag: "Read",
				rows: Arr.map(rows, (row) => Arr.map(row, textOfValue))
			}))
	}
}

/** A direct transaction's statement, labelled by its text, with its footprint. */
export const interleaveStep = (sql: string, footprint: Footprint): SqlStep => ({
	label: sql,
	sql,
	footprint
})

/** A grizzle operation step: its success is an Ok move, its failure the failure's outcome. */
export const opStep = (
	label: string,
	run: Effect.Effect<unknown, Error>,
	footprint: Footprint
): OpStep => ({
	label,
	outcome: Effect.match(run, {
		onSuccess: (): StepOutcome => succeeded,
		onFailure: failureOutcome
	}),
	footprint
})
