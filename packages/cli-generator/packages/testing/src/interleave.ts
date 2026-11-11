import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Option,
	Order,
	Schema,
	Struct
} from "effect"
import { array, type Gen, int, shuffled } from "#gen.ts"
import type { Observed } from "#source.ts"

/**
 * The sessions of an interleaving, keyed by name: each runs its moves in order, and starts only once the session it
 * names `after` is done. The names are the record's keys, so a session that names one that does not exist is a type
 * error.
 */
export type Sessions<S extends string, M> = {
	readonly [K in S]: Readonly<{ moves: Arr.NonEmptyReadonlyArray<M>; after: Option.Option<S> }>
}

/**
 * What an interleaving explores: its sessions; groups of sessions that share one lane and so never have moves in
 * flight at once (a pooled connection, a wait no lock shows); and the query that reads the system's final state, if
 * the judgment needs one.
 */
export type Interleave<S extends string, M, Q> = Readonly<{
	name: string
	sessions: Sessions<S, M>
	exclusive: ReadonlyArray<Arr.NonEmptyReadonlyArray<S>>
	state: Option.Option<Q>
}>

/** How the engine reads an ended move: its outcome's key, which `seen` shows, and whether it ends its session. */
export type Classified = Readonly<{ key: string; session: "continues" | "ends" }>

/**
 * What the engine asks of the system under test. Everything particular to it lives here: how a move runs, how a
 * waiting move is seen and who it waits on, when the system has decided every wait it will decide, what an outcome
 * means, and which moves commute.
 * - `reset` puts the system in its initial state before each run;
 * - `run` runs one move to its end; it never fails, a failure being an outcome, and interrupting it cancels the move;
 * - `waitOf` says whether a move in flight waits, on which of the schedule's sessions, and what the driver saw of the
 *   wait (PostgreSQL's lock and mode); the engine polls it back to back with the other fibers yielded to, never on a
 *   timer;
 * - `quiesce` returns only once the system has decided every wait it will decide on its own (PostgreSQL's deadlock
 *   check, which runs `deadlock_timeout` after a wait begins), so its choices repeat; the engine never infers that from
 *   time;
 * - `outcome` reads how a move ended, with its outcome or cancelled where it waited, as `seen` shows it and as ending
 *   its session or not;
 * - `release` ends whatever a session still holds once it will run no more moves (its open transaction, by a
 *   ROLLBACK), and does nothing for a session that holds nothing. The engine releases every session a run started,
 *   exactly once: at once when a failed move ends it before its last move, so the sessions waiting on it go on, and
 *   otherwise when the run ends, however it ends (finished, pruned, stopped, refused by the judgment, failed or
 *   interrupted), every such session at once, after the run's moves in flight are interrupted and its judgment ran.
 *   So no run leaves a session open for the next reset to wait on, whatever a driver forgets, and one session's
 *   release queued behind its own cancelled statement ends once another's frees the lock it waits on. It never fails:
 *   a session that cannot be released is a defect;
 * - `commute` says whether two moves issued in either order are the same execution;
 * - `onWait` says whether a move seen waiting is left to wait or cancelled;
 * - `read` answers a query from outside every session, for a script's reads and the final state.
 */
export type Driver<S extends string, M, O, Q, A, W, E, R> = Readonly<{
	reset: Effect.Effect<void, E, R>
	run: (session: S, move: M) => Effect.Effect<O, never, R>
	waitOf: (session: S, move: M) => Effect.Effect<Option.Option<Wait<S, W>>, E, R>
	quiesce: (waiting: ReadonlyArray<S>) => Effect.Effect<void, E, R>
	outcome: (move: M, ended: Ended<O>) => Classified
	release: (session: S) => Effect.Effect<void, never, R>
	commute: (first: M, second: M) => boolean
	onWait: (move: M) => "wait" | "interrupt"
	read: (query: Q) => Effect.Effect<A, E, R>
}>

/** One decision of a schedule: issue a session's next move, require its last move to have ended, or read. */
export type Choice<S extends string, Q> =
	| Readonly<{ kind: "move"; session: S }>
	| Readonly<{ kind: "join"; session: S }>
	| Readonly<{ kind: "read"; query: Q }>

/** Where a schedule's decisions come from when they are drawn: the case's own tape, and its record of what the system
 * decided. A property's `Case` is one. */
export type Nature = Readonly<{
	draw: <X>(generator: Gen<X>) => X
	observe: (decided: string) => Observed
}>

/**
 * A PCT schedule: the sessions from the highest priority down, and the moves (counted from one) after which the moving
 * session drops below every other.
 */
export type PctSchedule<S extends string> = Readonly<{
	priorities: Arr.NonEmptyReadonlyArray<S>
	changes: ReadonlyArray<number>
}>

/** Whether `every` prunes orders that differ only in commuting moves, or runs them all. */
export type Reduction = "sleep-sets" | "none"

/**
 * How decisions are made:
 * - `every` runs every distinct order, as a stateless depth-first search whose tree branches on what the system showed
 *   after each decision, so nature's choices are explored rather than replayed; sleep sets prune orders that differ
 *   only in commuting moves; `limit` is a runaway guard, past which the search is refused;
 * - `pct` runs the highest-priority session that can move, with priorities and change points drawn on the case's tape;
 * - `drawn` draws each decision from the case's tape, so a schedule replays from its token, shrinks like any value and
 *   is mutated by a fuzz run;
 * - `script` makes the decisions it lists.
 */
export type Strategy<S extends string, Q> =
	| Readonly<{ kind: "every"; limit: number; reduction: Reduction }>
	| Readonly<{ kind: "pct"; schedule: PctSchedule<S>; nature: Nature }>
	| Readonly<{ kind: "drawn"; nature: Nature }>
	| Readonly<{ kind: "script"; choices: ReadonlyArray<Choice<S, Q>> }>

/** A move seen waiting: the schedule's sessions it waits on, and what the driver saw of the wait. */
export type Wait<S extends string, W> = Readonly<{ on: Arr.NonEmptyReadonlyArray<S>; detail: W }>

/** How an issued move ended: with its outcome, or cancelled where it was seen waiting. */
export type Ended<O> = Readonly<{ kind: "ended"; outcome: O }> | Readonly<{ kind: "cancelled" }>

/** How an issued move ended, and the key its driver gave that ending. */
export type MoveResult<O> = Readonly<{ ended: Ended<O>; key: string }>

/**
 * One issued move: its session and place there, when it was issued and ended on the run's event clock (which counts
 * issues and endings, never time), the first wait it was seen in and when, and how it ended, if it did.
 */
export type MoveRecord<S extends string, M, O, W> = Readonly<{
	session: S
	index: number
	move: M
	issued: number
	ended: Option.Option<number>
	waited: Option.Option<Readonly<{ wait: Wait<S, W>; at: number }>>
	result: Option.Option<MoveResult<O>>
}>

/** A deadlock the engine broke before its next decision: the cycle, in the order its sessions began to wait, who could
 * move, and whom the system aborted, if it aborted anyone rather than granting a lock. */
export type Deadlock<S extends string> = Readonly<{
	cycle: Arr.NonEmptyReadonlyArray<S>
	runnable: ReadonlyArray<S>
	victim: Option.Option<S>
}>

/** A read a script made, and when. */
export type Read<Q, A> = Readonly<{ query: Q; value: A; at: number }>

/** One decision as made: what the system showed, who could move, and the choice. */
export type Decision<S extends string, Q> = Readonly<{
	seen: string
	runnable: ReadonlyArray<S>
	choice: Choice<S, Q>
}>

/**
 * Whether a run followed the tape it replayed: as taped; branched, when `every`'s planned order met a state nature had
 * not shown before; or diverged, when a replayed tape recorded another observation at a decision. A divergence where
 * one move was in flight is the system's own nondeterminism, a finding; one where several were is nature choosing.
 */
export type Replay =
	| Readonly<{ kind: "as-taped" }>
	| Readonly<{ kind: "branched"; at: number }>
	| Readonly<{ kind: "diverged"; at: number; nature: "chose" | "had no choice" }>

/**
 * How a run ended: every session done; a script's decision that could not be made; or pruned, when every session
 * that could move was asleep, so the rest of the run is equivalent to one already judged and it stops unjudged.
 */
export type Ending<S extends string, Q> =
	| Readonly<{ kind: "finished" }>
	| Readonly<{ kind: "stopped"; at: number; choice: Choice<S, Q>; why: string }>
	| Readonly<{ kind: "pruned"; at: number }>

/** How a session ended: done, ended early by a failed move's outcome, or left unfinished by a stopped script. */
export type SessionEnd =
	| Readonly<{ kind: "done" }>
	| Readonly<{ kind: "ended"; key: string }>
	| Readonly<{ kind: "unfinished" }>

/** One run of an interleaving, everything a judgment reads. */
export type Interleaving<S extends string, M, O, Q, A, W> = Readonly<{
	name: string
	order: ReadonlyArray<MoveRecord<S, M, O, W>>
	sessions: ReadonlyMap<S, SessionEnd>
	state: Option.Option<A>
	deadlocks: ReadonlyArray<Deadlock<S>>
	reads: ReadonlyArray<Read<Q, A>>
	tape: ReadonlyArray<Decision<S, Q>>
	replay: Replay
	ending: Ending<S, Q>
}>

/**
 * What an exploration ran: the runs it judged, those it pruned as equivalent to one judged, and how many judged runs
 * saw a wait, a branch of nature's, a divergence and a deadlock.
 */
export type InterleavingReport = Readonly<{
	interleavings: number
	pruned: number
	blocked: number
	branched: number
	diverged: number
	deadlocked: number
}>

/** Sessions whose `after`s form a cycle, so none of them could ever start. */
export class AfterCycle extends Schema.TaggedError<AfterCycle, { readonly brand: unique symbol }>()(
	"AfterCycle",
	{ interleaving: Schema.String, cycle: Schema.Array(Schema.String), message: Schema.String }
) {}

/** A run its judgment refused, one that stalled with every session waiting on no cycle, or a search past its limit;
 * the message describes the run and the script that replays it. */
export class InterleavingFailed extends Schema.TaggedError<
	InterleavingFailed,
	{ readonly brand: unique symbol }
>()("InterleavingFailed", { interleaving: Schema.String, message: Schema.String }) {}

/**
 * A PCT schedule over `sessions`: a priority order and up to `depth - 1` change points among `moves` moves, each drawn
 * with equal chance, as PCT's bound requires. It shrinks toward the sessions' own order with no change points.
 */
export const pctSchedule = <S extends string>(
	sessions: Arr.NonEmptyReadonlyArray<S>,
	depth: number,
	moves: number
): Gen<PctSchedule<S>> => {
	const order = shuffled(sessions, { min: sessions.length, max: sessions.length })
	const changes = array(int(1, moves), { min: 0, max: Math.max(0, depth - 1) })
	return (source) => {
		const [first = Arr.headNonEmpty(sessions), ...rest] = source.draw(order)
		return { priorities: [first, ...rest], changes: source.draw(changes) }
	}
}

/** How many moves an interleaving's sessions make when every move runs: PCT's k. */
export const movesOf = <S extends string, M>(sessions: Sessions<S, M>): number =>
	Arr.reduce(Struct.keys(sessions), 0, (total, name) => total + sessions[name].moves.length)

/**
 * A node of `every`'s tree: the sessions it has tried, those whose move it issued was seen waiting, the sessions asleep
 * there, and its children by the choice taken and what the system showed next, as the number its search gave that
 * sight when it first saw it.
 */
type Node<S extends string> = {
	readonly explored: Set<S>
	readonly waited: Set<S>
	readonly sleep: ReadonlySet<S>
	readonly children: Map<S, Map<number, Node<S>>>
}

const nodeOf = <S extends string>(sleep: ReadonlySet<S>): Node<S> => ({
	explored: new Set(),
	waited: new Set(),
	sleep,
	children: new Map()
})

/** A decision `every` made on one run's path: its node, who could move, who was asleep then, and the choice. */
type Point<S extends string> = Readonly<{
	node: Node<S>
	runnable: ReadonlyArray<S>
	asleep: ReadonlySet<S>
	taken: S
}>

/** The order `every` replays next: the choices up to a decision point, then an alternative at its node. */
type Plan<S extends string> = Readonly<{
	prefix: ReadonlyArray<S>
	target: Option.Option<Readonly<{ node: Node<S>; alternative: S }>>
}>

type Pending<S extends string, M, O, W> = {
	readonly session: S
	readonly index: number
	readonly move: M
	readonly fiber: Fiber.Fiber<O>
	readonly record: Recorded<S, M, O, W>
	readonly issuedAt: Option.Option<Node<S>>
	waiting: Option.Option<Wait<S, W>>
}

type Recorded<S extends string, M, O, W> = {
	-readonly [K in keyof MoveRecord<S, M, O, W>]: MoveRecord<S, M, O, W>[K]
}

/** The first cycle in a wait-for graph, in the order its sessions wait on each other. */
const cycleOf = <S extends string>(
	waits: ReadonlyMap<S, ReadonlyArray<S>>
): Option.Option<Arr.NonEmptyReadonlyArray<S>> => {
	for (const start of waits.keys()) {
		const path: Array<S> = []
		let current: Option.Option<S> = Option.some(start)
		while (Option.isSome(current) && !Arr.contains(path, current.value)) {
			path.push(current.value)
			current = Arr.findFirst(waits.get(current.value) ?? [], (holder) => waits.has(holder))
		}
		if (Option.isSome(current)) {
			const cycle = Arr.dropWhile(path, (session) => session !== current.value)
			if (Arr.isReadonlyArrayNonEmpty(cycle)) {
				return Option.some(cycle)
			}
		}
	}
	return Option.none()
}

/** The sessions whose `after`s form a cycle, if any do. */
const afterCycleOf = <S extends string, M>(sessions: Sessions<S, M>) =>
	cycleOf(
		new Map(
			Arr.map(
				Struct.keys(sessions),
				(name) => [name, Option.toArray(sessions[name].after)] as const
			)
		)
	)

const describeChoice = <S extends string, Q>(choice: Choice<S, Q>): string =>
	choice.kind === "read"
		? `read ${Formatter.format(choice.query)}`
		: `${choice.kind} ${choice.session}`

const describeEnding = <S extends string, Q>(ending: Ending<S, Q>): string => {
	switch (ending.kind) {
		case "finished":
			return "finished"
		case "stopped":
			return `stopped at decision ${ending.at}, ${describeChoice(ending.choice)}: ${ending.why}`
		case "pruned":
			return `pruned at decision ${ending.at}`
	}
}

const describeEnd = (end: SessionEnd): string =>
	end.kind === "ended" ? `ended ${end.key}` : end.kind

/** A run as a reader needs it: how it ended, each session's end, the state, the replay and the decisions in order. */
export const describeRun = <S extends string, M, O, Q, A, W>(
	run: Interleaving<S, M, O, Q, A, W>
): string =>
	Arr.join(
		[
			`${run.name}: ${describeEnding(run.ending)}`,
			`sessions: ${Arr.join(
				Arr.map([...run.sessions], ([session, end]) => `${session} ${describeEnd(end)}`),
				", "
			)}`,
			...Option.match(run.state, {
				onNone: () => [],
				onSome: (state) => [`state: ${Formatter.format(state)}`]
			}),
			...(run.replay.kind === "as-taped"
				? []
				: run.replay.kind === "branched"
					? [`branched from its tape at decision ${run.replay.at}`]
					: [
							`nature decided otherwise at decision ${run.replay.at}${run.replay.nature === "had no choice" ? ", where one move was in flight: the system is not deterministic" : ""}`
						]),
			`schedule: ${Arr.join(
				Arr.map(run.tape, (decision) => describeChoice(decision.choice)),
				" | "
			)}`,
			`replay: ${Formatter.format(Arr.map(run.tape, (decision) => decision.choice))}`
		],
		"\n"
	)

/**
 * What one run holds while it runs, which its end reads however the run ends: its moves in flight, the sessions it
 * started, and those already released.
 */
type Live<S extends string, M, O, W> = Readonly<{
	pending: Map<S, Pending<S, M, O, W>>
	started: Set<S>
	released: Set<S>
}>

/**
 * Explores the interleavings of a set of sessions on the system a driver runs, judging every run, and fails with the
 * first run its judgment refuses.
 *
 * Every run resets the system, then loops: it settles every move in flight (each ends, or is seen waiting), lets the
 * system decide every wait it will decide, breaks any deadlock the waits form, and makes the next decision among the
 * sessions that can move. A session can move when it is not done, has no move in flight, the session it waits `after`
 * is done, and no session of its lane has a move in flight. Nothing sleeps and nothing is judged by time: the driver's
 * observations of waits and its quiescence are the only clocks, and a run is bounded by the case's hang guard. A
 * session seen waiting is not moved again until its move ends, so orders that differ only in where its later moves go
 * are one execution and run once. A defect or an interruption of a move ends the run as a defect, never as an outcome.
 * However a run ends, every session it started is released before the next run's reset (Driver's `release`).
 */
export const interleave = <S extends string, M, O, Q, A, W, E, R, F, RJ>(
	driver: Driver<S, M, O, Q, A, W, E, R>,
	spec: Interleave<S, M, Q>,
	strategy: Strategy<S, Q>,
	judge: (run: Interleaving<S, M, O, Q, A, W>) => Effect.Effect<void, F, RJ>
): Effect.Effect<InterleavingReport, E | AfterCycle | InterleavingFailed, R | RJ> =>
	Effect.gen(function* () {
		const names = Struct.keys(spec.sessions)
		const cyclic = afterCycleOf(spec.sessions)
		if (Option.isSome(cyclic)) {
			return yield* AfterCycle.make({
				interleaving: spec.name,
				cycle: cyclic.value,
				message: `${spec.name}: ${Arr.join(cyclic.value, ", ")} each start after another of them, so none can start`
			})
		}
		const movesAt = (session: S, index: number): M =>
			Arr.getUnsafe(spec.sessions[session].moves, index)
		const lastIndexOf = (session: S): number => spec.sessions[session].moves.length - 1
		const failed = (message: string) =>
			InterleavingFailed.make({ interleaving: spec.name, message })

		const root = nodeOf<S>(new Set())
		const sights = new Map<string, number>()
		const sightOf = (seen: string): number => {
			const known = sights.get(seen)
			if (known !== undefined) {
				return known
			}
			sights.set(seen, sights.size)
			return sights.size - 1
		}

		const runOnce = (plan: Plan<S>, live: Live<S, M, O, W>) => {
			const pending = live.pending
			const release = (session: S) =>
				Effect.suspend(() => {
					live.released.add(session)
					return driver.release(session)
				})
			return Effect.gen(function* () {
				yield* driver.reset
				const next = new Map<S, number>()
				const done = new Set<S>()
				const ends = new Map<S, SessionEnd>()
				const woken = new Set<S>()
				const order: Array<Recorded<S, M, O, W>> = []
				const deadlocks: Array<Deadlock<S>> = []
				const reads: Array<Read<Q, A>> = []
				const tape: Array<Decision<S, Q>> = []
				const path: Array<Point<S>> = []
				const priorities = new Map<S, number>()
				let clock = 0
				let moves = 0
				let inFlight = 0
				let replay: Replay = { kind: "as-taped" }
				let ending: Ending<S, Q> = { kind: "finished" }
				let childSleep: ReadonlySet<S> = new Set()

				if (strategy.kind === "pct") {
					const top = strategy.schedule.priorities.length + strategy.schedule.changes.length
					Arr.forEach(strategy.schedule.priorities, (session, rank) =>
						priorities.set(session, top - rank)
					)
				}

				const finish = (pendingMove: Pending<S, M, O, W>, how: Ended<O>) =>
					Effect.gen(function* () {
						clock += 1
						const classified = driver.outcome(pendingMove.move, how)
						pendingMove.record.ended = Option.some(clock)
						pendingMove.record.result = Option.some({ ended: how, key: classified.key })
						pending.delete(pendingMove.session)
						if (Option.isSome(pendingMove.waiting)) {
							woken.add(pendingMove.session)
						}
						if (classified.session === "ends") {
							ends.set(pendingMove.session, { kind: "ended", key: classified.key })
							done.add(pendingMove.session)
							if (pendingMove.index < lastIndexOf(pendingMove.session)) {
								yield* release(pendingMove.session)
							}
							return
						}
						next.set(pendingMove.session, pendingMove.index + 1)
						if (pendingMove.index === lastIndexOf(pendingMove.session)) {
							ends.set(pendingMove.session, { kind: "done" })
							done.add(pendingMove.session)
						}
					})

				const ended = (pendingMove: Pending<S, M, O, W>, exit: Exit.Exit<O>) =>
					Exit.isSuccess(exit)
						? finish(pendingMove, { kind: "ended", outcome: exit.value })
						: Effect.failCause(exit.cause)

				const watch = (pendingMove: Pending<S, M, O, W>) =>
					Effect.gen(function* () {
						for (;;) {
							const exit = pendingMove.fiber.pollUnsafe()
							if (exit !== undefined) {
								return yield* Effect.as(ended(pendingMove, exit), true)
							}
							const seen = yield* driver.waitOf(pendingMove.session, pendingMove.move)
							if (Option.isSome(seen)) {
								const settledExit = pendingMove.fiber.pollUnsafe()
								if (settledExit !== undefined) {
									return yield* Effect.as(ended(pendingMove, settledExit), true)
								}
								pendingMove.waiting = seen
								Option.map(pendingMove.issuedAt, (node) => node.waited.add(pendingMove.session))
								if (Option.isNone(pendingMove.record.waited)) {
									pendingMove.record.waited = Option.some({ wait: seen.value, at: clock })
								}
								if (driver.onWait(pendingMove.move) === "interrupt") {
									yield* Fiber.interrupt(pendingMove.fiber)
									yield* finish(pendingMove, { kind: "cancelled" })
									return true
								}
								return false
							}
							yield* Effect.yieldNow
						}
					})

				const settleAll = Effect.gen(function* () {
					let progressed = true
					while (progressed) {
						progressed = false
						for (const name of names) {
							const pendingMove = pending.get(name)
							if (pendingMove !== undefined && (yield* watch(pendingMove))) {
								progressed = true
							}
						}
						if (pending.size > 0) {
							yield* driver.quiesce(Arr.filter(names, (name) => pending.has(name)))
							for (const name of names) {
								const pendingMove = pending.get(name)
								const exit = pendingMove?.fiber.pollUnsafe()
								if (pendingMove !== undefined && exit !== undefined) {
									yield* ended(pendingMove, exit)
									progressed = true
								}
							}
						}
					}
				})

				const startable = (session: S) =>
					Option.match(spec.sessions[session].after, {
						onNone: () => true,
						onSome: (after) => done.has(after)
					})
				const laneFree = (session: S) =>
					!Arr.some(
						spec.exclusive,
						(lane) =>
							Arr.contains(lane, session) &&
							Arr.some(lane, (other) => other !== session && pending.has(other))
					)
				const runnableNow = () =>
					Arr.filter(
						names,
						(session) =>
							!done.has(session) && !pending.has(session) && startable(session) && laneFree(session)
					)

				const waitingOf = (session: S) =>
					Option.flatMap(Option.fromNullishOr(pending.get(session)), (move) => move.waiting)

				const seenNow = (runnable: ReadonlyArray<S>) =>
					Arr.join(
						[
							`runnable ${Arr.join(runnable, ",")}`,
							`waiting ${Arr.join(
								Arr.flatMap(names, (name) =>
									Option.toArray(
										Option.map(waitingOf(name), (wait) => `${name}<${Arr.join(wait.on, "+")}`)
									)
								),
								","
							)}`,
							`ended ${Arr.join(
								Arr.flatMap(names, (name) =>
									Option.toArray(
										Option.map(
											Option.fromNullishOr(ends.get(name)),
											(end) => `${name}:${describeEnd(end)}`
										)
									)
								),
								","
							)}`
						],
						"; "
					)

				const issue = (session: S) =>
					Effect.gen(function* () {
						const index = next.get(session) ?? 0
						const move = movesAt(session, index)
						clock += 1
						const record: Recorded<S, M, O, W> = {
							session,
							index,
							move,
							issued: clock,
							ended: Option.none(),
							waited: Option.none(),
							result: Option.none()
						}
						order.push(record)
						live.started.add(session)
						const fiber = yield* Effect.forkChild(driver.run(session, move))
						pending.set(session, {
							session,
							index,
							move,
							fiber,
							record,
							issuedAt: Option.map(Arr.last(path), (point) => point.node),
							waiting: Option.none()
						})
						inFlight = pending.size
						moves += 1
						if (strategy.kind === "pct") {
							const change = strategy.schedule.changes.indexOf(moves)
							if (change >= 0) {
								priorities.set(session, change - strategy.schedule.changes.length)
							}
						}
					})

				const nextMoveOf = (session: S) => movesAt(session, next.get(session) ?? 0)

				const breakDeadlock = (cycle: Arr.NonEmptyReadonlyArray<S>, runnable: ReadonlyArray<S>) =>
					Effect.gen(function* () {
						const waitStart = (session: S) =>
							Option.match(
								Option.flatMap(
									Option.fromNullishOr(pending.get(session)),
									(move) => move.record.waited
								),
								{ onNone: () => Number.POSITIVE_INFINITY, onSome: (waited) => waited.at }
							)
						const ordered = Arr.sort(cycle, Order.mapInput(Order.Number, waitStart))
						const waiting = Arr.flatMap(cycle, (session) =>
							Option.toArray(Option.fromNullishOr(pending.get(session)))
						)
						const first = yield* Effect.raceAll(
							Arr.map(waiting, (pendingMove) =>
								Effect.map(Fiber.await(pendingMove.fiber), (exit) => [pendingMove, exit] as const)
							)
						)
						const [pendingMove, exit] = first
						yield* ended(pendingMove, exit)
						const end = ends.get(pendingMove.session)
						deadlocks.push({
							cycle: ordered,
							runnable,
							victim: end?.kind === "ended" ? Option.some(pendingMove.session) : Option.none()
						})
					})

				const everyChoice = (
					depth: number,
					runnable: Arr.NonEmptyReadonlyArray<S>,
					seen: string
				): Option.Option<S> => {
					const resolved = Option.match(Arr.get(path, depth - 1), {
						onNone: () => root,
						onSome: (point) => {
							const byChoice = point.node.children.get(point.taken) ?? new Map<number, Node<S>>()
							point.node.children.set(point.taken, byChoice)
							const sight = sightOf(seen)
							const existing = byChoice.get(sight)
							if (existing !== undefined) {
								return existing
							}
							const replaying = depth < plan.prefix.length
							const created = nodeOf<S>(replaying ? new Set() : childSleep)
							byChoice.set(sight, created)
							if (replaying && replay.kind === "as-taped") {
								replay = { kind: "branched", at: depth }
								Option.map(plan.target, (target) => target.node.explored.add(target.alternative))
							}
							return created
						}
					})
					const asleep = new Set(Arr.filter([...resolved.sleep], (session) => !woken.has(session)))
					const planned = replay.kind === "as-taped" ? Arr.get(plan.prefix, depth) : Option.none()
					if (Option.isNone(planned) && Arr.every(runnable, (session) => asleep.has(session))) {
						return Option.none()
					}
					const choice = Option.match(
						Option.filter(planned, (session) => Arr.contains(runnable, session)),
						{
							onSome: (session) => session,
							onNone: () => {
								if (Option.isSome(planned) && replay.kind === "as-taped") {
									replay = { kind: "branched", at: depth }
									Option.map(plan.target, (target) => target.node.explored.add(target.alternative))
								}
								return Option.getOrElse(
									Arr.findFirst(
										runnable,
										(session) => !asleep.has(session) && !resolved.explored.has(session)
									),
									() =>
										Option.getOrElse(
											Arr.findFirst(runnable, (session) => !resolved.explored.has(session)),
											() => Arr.headNonEmpty(runnable)
										)
								)
							}
						}
					)
					resolved.explored.add(choice)
					path.push({ node: resolved, runnable, asleep, taken: choice })
					childSleep =
						strategy.kind === "every" && strategy.reduction === "sleep-sets"
							? new Set(
									Arr.filter(
										[...new Set([...asleep, ...resolved.explored])],
										(session) =>
											session !== choice &&
											!resolved.waited.has(session) &&
											!woken.has(session) &&
											!done.has(session) &&
											!pending.has(session) &&
											startable(session) &&
											driver.commute(nextMoveOf(session), nextMoveOf(choice))
									)
								)
							: new Set()
					return Option.some(choice)
				}

				const observed = (nature: Nature, seen: string) => {
					if (nature.observe(seen) === "diverged" && replay.kind === "as-taped") {
						replay = {
							kind: "diverged",
							at: tape.length,
							nature: inFlight > 1 ? "chose" : "had no choice"
						}
					}
				}

				const decide = (
					searching: Exclude<Strategy<S, Q>, Readonly<{ kind: "script" }>>,
					runnable: Arr.NonEmptyReadonlyArray<S>,
					seen: string
				): Option.Option<S> => {
					switch (searching.kind) {
						case "every":
							return everyChoice(tape.length, runnable, seen)
						case "drawn":
							observed(searching.nature, seen)
							return Option.some(
								Arr.getUnsafe(runnable, searching.nature.draw(int(0, runnable.length - 1)))
							)
						case "pct":
							observed(searching.nature, seen)
							return Option.some(
								Arr.reduce(runnable, Arr.headNonEmpty(runnable), (best, session) =>
									(priorities.get(session) ?? 0) > (priorities.get(best) ?? 0) ? session : best
								)
							)
					}
				}

				const impossible = (choice: Choice<S, Q>): Option.Option<string> => {
					switch (choice.kind) {
						case "move":
							return done.has(choice.session)
								? Option.some(`${choice.session} is done`)
								: pending.has(choice.session)
									? Option.some(`${choice.session} has a move in flight`)
									: !startable(choice.session) || !laneFree(choice.session)
										? Option.some(`${choice.session} cannot start yet`)
										: Option.none()
						case "join":
							return pending.has(choice.session)
								? Option.some(`${choice.session}'s move has not ended`)
								: Option.none()
						case "read":
							return Option.none()
					}
				}

				for (;;) {
					yield* settleAll
					const waits = new Map(
						Arr.flatMap(names, (name) =>
							Option.toArray(Option.map(waitingOf(name), (wait) => [name, wait.on] as const))
						)
					)
					const runnable = runnableNow()
					const cycle = cycleOf(waits)
					if (Option.isSome(cycle)) {
						yield* breakDeadlock(cycle.value, runnable)
						continue
					}
					const seen = seenNow(runnable)
					let choice: Choice<S, Q>
					if (strategy.kind === "script") {
						const scripted = Arr.get(strategy.choices, tape.length)
						if (Option.isNone(scripted)) {
							break
						}
						choice = scripted.value
					} else if (Arr.isReadonlyArrayNonEmpty(runnable)) {
						const decided = decide(strategy, runnable, seen)
						if (Option.isNone(decided)) {
							ending = { kind: "pruned", at: tape.length }
							break
						}
						choice = { kind: "move", session: decided.value }
					} else if (pending.size > 0) {
						return yield* failed(
							`${spec.name}: every unfinished session waits, on no cycle (${seen})`
						)
					} else {
						break
					}
					const why = impossible(choice)
					if (Option.isSome(why)) {
						ending = { kind: "stopped", at: tape.length, choice, why: why.value }
						break
					}
					tape.push({ seen, runnable, choice })
					switch (choice.kind) {
						case "move":
							yield* issue(choice.session)
							break
						case "join":
							break
						case "read":
							reads.push({
								query: choice.query,
								value: yield* driver.read(choice.query),
								at: clock
							})
							break
					}
				}
				for (const pendingMove of pending.values()) {
					yield* Fiber.interrupt(pendingMove.fiber)
				}
				const state = yield* Option.match(spec.state, {
					onNone: () => Effect.succeed(Option.none<A>()),
					onSome: (query) => Effect.asSome(driver.read(query))
				})
				const run: Interleaving<S, M, O, Q, A, W> = {
					name: spec.name,
					order,
					sessions: new Map(
						Arr.map(names, (name) => [name, ends.get(name) ?? { kind: "unfinished" }] as const)
					),
					state,
					deadlocks,
					reads,
					tape,
					replay,
					ending
				}
				return { run, path }
			})
		}

		/**
		 * The end of every run, however it ended: its moves still in flight are interrupted, then every session it started
		 * and has not released is released, all at once.
		 */
		const endOf = (live: Live<S, M, O, W>) =>
			Effect.suspend(() =>
				Effect.andThen(
					Fiber.interruptAll(
						Arr.map([...live.pending.values()], (pendingMove) => pendingMove.fiber)
					),
					Effect.forEach(
						Arr.filter([...live.started], (session) => !live.released.has(session)),
						(session) => driver.release(session),
						{ concurrency: "unbounded", discard: true }
					)
				)
			)

		const judged = (run: Interleaving<S, M, O, Q, A, W>) =>
			Effect.mapError(judge(run), (refusal) =>
				failed(`${describeRun(run)}\nrefused: ${Cause.pretty(Cause.fail(refusal))}`)
			)

		const report = {
			interleavings: 0,
			pruned: 0,
			blocked: 0,
			branched: 0,
			diverged: 0,
			deadlocked: 0
		}
		const tally = (run: Interleaving<S, M, O, Q, A, W>) => {
			report.interleavings += 1
			report.blocked += Arr.some(run.order, (move) => Option.isSome(move.waited)) ? 1 : 0
			report.branched += run.replay.kind === "branched" ? 1 : 0
			report.diverged += run.replay.kind === "diverged" ? 1 : 0
			report.deadlocked += run.deadlocks.length > 0 ? 1 : 0
		}

		/** One run, judged unless it was pruned, and ended (endOf) however it ends; the decisions `every` made on its path. */
		const runJudged = (plan: Plan<S>) => {
			const live: Live<S, M, O, W> = { pending: new Map(), started: new Set(), released: new Set() }
			return Effect.gen(function* () {
				const { run, path } = yield* runOnce(plan, live)
				if (run.ending.kind === "pruned") {
					report.pruned += 1
				} else {
					tally(run)
					yield* judged(run)
				}
				return path
			}).pipe(Effect.ensuring(endOf(live)))
		}

		if (strategy.kind !== "every") {
			yield* runJudged({ prefix: [], target: Option.none() })
			return report
		}

		let plan: Option.Option<Plan<S>> = Option.some({ prefix: [], target: Option.none() })
		while (Option.isSome(plan)) {
			if (report.interleavings + report.pruned >= strategy.limit) {
				return yield* failed(
					`${spec.name}: more than ${strategy.limit} interleavings; the search is refused rather than cut short`
				)
			}
			const path = yield* runJudged(plan.value)
			plan = Option.none()
			for (let at = path.length - 1; at >= 0 && Option.isNone(plan); at -= 1) {
				const point = Arr.getUnsafe(path, at)
				const alternative = Arr.findFirst(
					point.runnable,
					(session) => !point.node.explored.has(session) && !point.asleep.has(session)
				)
				if (Option.isSome(alternative)) {
					plan = Option.some({
						prefix: [...Arr.map(Arr.take(path, at), (taken) => taken.taken), alternative.value],
						target: Option.some({ node: point.node, alternative: alternative.value })
					})
				}
			}
		}
		return report
	})
