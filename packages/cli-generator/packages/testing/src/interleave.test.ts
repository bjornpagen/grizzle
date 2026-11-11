import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Deferred,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	String as Str,
	Struct
} from "effect"
import { type Case, drawn, explore } from "#explore.ts"
import { awaitFact } from "#fact.ts"
import { noCoverage, required } from "#features.ts"
import { array, element, type Gen, int } from "#gen.ts"
import {
	AfterCycle,
	type Driver,
	type Interleave,
	type Interleaving,
	interleave,
	type Reduction,
	type Sessions,
	type Strategy
} from "#interleave.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

const RESOURCES = ["x", "y", "z"] as const

type Resource = (typeof RESOURCES)[number]

type Move =
	| Readonly<{ kind: "write"; resource: Resource; value: number }>
	| Readonly<{ kind: "commit" }>

type Outcome = "ok" | "deadlock"

type Snapshot = ReadonlyArray<readonly [Resource, number]>

/**
 * A lock manager, the system under test: a write takes its resource's lock, waiting while another session holds it,
 * and a commit releases every lock the session holds. Its deadlock detector runs when the engine asks it to quiesce,
 * and aborts the cycle's member that began waiting first, as PostgreSQL's does. Releasing a session drops its locks
 * and its wait; a reset that meets a lock still held or a wait still open dies, as PostgreSQL's reset would wait on it
 * forever, so every run of every test here checks that the engine released each session its run started.
 */
const lockManager = <S extends string>(): Driver<
	S,
	Move,
	Outcome,
	"state",
	Snapshot,
	Resource,
	never,
	never
> => {
	const values = new Map<Resource, number>()
	const holders = new Map<Resource, S>()
	const waiting = new Map<
		S,
		Readonly<{ resource: Resource; since: number; wake: Deferred.Deferred<"granted" | "victim"> }>
	>()
	let waits = 0
	const releaseLocks = (session: S) => {
		for (const [resource, holder] of holders) {
			if (holder === session) {
				holders.delete(resource)
			}
		}
		for (const [, wait] of waiting) {
			if (!holders.has(wait.resource)) {
				Deferred.doneUnsafe(wait.wake, Effect.succeed("granted"))
			}
		}
	}
	const holderOf = (session: S) =>
		Option.flatMap(Option.fromNullishOr(waiting.get(session)), (wait) =>
			Option.fromNullishOr(holders.get(wait.resource))
		)
	const write = (session: S, resource: Resource, value: number): Effect.Effect<Outcome> =>
		Effect.gen(function* () {
			const holder = holders.get(resource)
			if (holder === undefined || holder === session) {
				holders.set(resource, session)
				values.set(resource, value)
				return "ok"
			}
			const wake = yield* Deferred.make<"granted" | "victim">()
			waits += 1
			waiting.set(session, { resource, since: waits, wake })
			const signal = yield* Deferred.await(wake)
			waiting.delete(session)
			if (signal === "victim") {
				releaseLocks(session)
				return "deadlock"
			}
			return yield* write(session, resource, value)
		})
	return {
		reset: Effect.suspend(() =>
			holders.size > 0 || waiting.size > 0
				? Effect.die(
						`a reset met ${Arr.join([...holders.values(), ...waiting.keys()], ", ")} still holding a lock or waiting`
					)
				: Effect.sync(() => {
						values.clear()
						waits = 0
					})
		),
		run: (session, move) =>
			move.kind === "write"
				? write(session, move.resource, move.value)
				: Effect.sync(() => {
						releaseLocks(session)
						return "ok"
					}),
		waitOf: (session) =>
			Effect.sync(() =>
				Option.flatMap(holderOf(session), (holder) =>
					Option.map(Option.fromNullishOr(waiting.get(session)), (wait) => ({
						on: [holder] as const,
						detail: wait.resource
					}))
				)
			),
		quiesce: (inFlight) =>
			Effect.gen(function* () {
				const waitsFor = new Map(
					Arr.flatMap(inFlight, (session) =>
						Option.toArray(Option.map(holderOf(session), (holder) => [session, holder] as const))
					)
				)
				for (const start of waitsFor.keys()) {
					const cycle: Array<S> = []
					let current: S | undefined = start
					while (current !== undefined && !Arr.contains(cycle, current)) {
						cycle.push(current)
						current = waitsFor.get(current)
					}
					if (current === start) {
						const victim = Arr.reduce(cycle, start, (first, session) =>
							(waiting.get(session)?.since ?? 0) < (waiting.get(first)?.since ?? 0)
								? session
								: first
						)
						const wait = waiting.get(victim)
						if (wait !== undefined) {
							Deferred.doneUnsafe(wait.wake, Effect.succeed("victim"))
							yield* awaitFact(
								Effect.sync(() => (waiting.has(victim) ? Option.none() : Option.some(victim)))
							)
						}
						return
					}
				}
			}),
		outcome: (_move, ended) =>
			ended.kind === "cancelled"
				? { key: "cancelled", session: "continues" }
				: { key: ended.outcome, session: ended.outcome === "deadlock" ? "ends" : "continues" },
		release: (session) =>
			Effect.sync(() => {
				waiting.delete(session)
				releaseLocks(session)
			}),
		commute: (first, second) =>
			first.kind === "write" && second.kind === "write" && first.resource !== second.resource,
		onWait: () => "wait",
		read: () =>
			Effect.sync(() =>
				Arr.sort(
					[...values],
					Order.mapInput(Order.String, ([resource]: readonly [Resource, number]) => resource)
				)
			)
	}
}

/** What a run decided, as the oracle compares runs: the final state and how each session ended. */
const decidedBy = <S extends string>(
	run: Interleaving<S, Move, Outcome, "state", Snapshot, Resource>
) => Formatter.format({ state: run.state, sessions: [...run.sessions] })

/** Every distinct result `every` reaches over `sessions`, with or without sleep sets. */
const resultsOf = <S extends string>(sessions: Sessions<S, Move>, reduction: Reduction) =>
	Effect.gen(function* () {
		const results = new Set<string>()
		const report = yield* interleave(
			lockManager<S>(),
			{ name: "locks", sessions, exclusive: [], state: Option.some("state") },
			{ kind: "every", limit: 20_000, reduction },
			(run) => Effect.sync(() => results.add(decidedBy(run)))
		)
		return { results, report }
	})

type Named = "a" | "b" | "c"

/** A write of a resource, or a commit. */
const writeOf: Gen<Move> = (source) => ({
	kind: "write",
	resource: source.draw(element(RESOURCES)),
	value: source.draw(int(1, 2))
})

/** Two or three sessions, each one or two writes and a commit. */
const sessionSets: Gen<Sessions<Named, Move>> = (source) => {
	const movesOf = () => {
		const writes = source.draw(array(writeOf, { min: 1, max: 2 }))
		const [first = { kind: "commit" }, ...rest] = writes
		return [first, ...rest, { kind: "commit" }] as const
	}
	const third = source.draw(int(0, 1)) === 1
	return {
		a: { moves: movesOf(), after: Option.none() },
		b: { moves: movesOf(), after: Option.none() },
		c: { moves: third ? movesOf() : [{ kind: "commit" }], after: Option.none() }
	}
}

const crossing: Sessions<"a" | "b", Move> = {
	a: {
		moves: [
			{ kind: "write", resource: "x", value: 1 },
			{ kind: "write", resource: "y", value: 1 },
			{ kind: "commit" }
		],
		after: Option.none()
	},
	b: {
		moves: [
			{ kind: "write", resource: "y", value: 2 },
			{ kind: "write", resource: "x", value: 2 },
			{ kind: "commit" }
		],
		after: Option.none()
	}
}

describe("interleaving", () => {
	it.effect("reaches every result with sleep sets that it reaches without them", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "sleep sets are sound",
					draw: drawn(sessionSets),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 24,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				(sessions) =>
					Effect.gen(function* () {
						const reduced = yield* resultsOf(sessions, "sleep-sets")
						const full = yield* resultsOf(sessions, "none")
						deepStrictEqual(
							Arr.sort(reduced.results, Order.String),
							Arr.sort(full.results, Order.String)
						)
						assertTrue(
							reduced.report.interleavings <= full.report.interleavings,
							`sleep sets ran ${reduced.report.interleavings} orders, no more than the ${full.report.interleavings} without them`
						)
					})
			)
		)
	)

	it.effect("prunes the orders of moves that commute", () =>
		Effect.gen(function* () {
			const independent: Sessions<"a" | "b", Move> = {
				a: { moves: [{ kind: "write", resource: "x", value: 1 }], after: Option.none() },
				b: { moves: [{ kind: "write", resource: "y", value: 2 }], after: Option.none() }
			}
			const reduced = yield* resultsOf(independent, "sleep-sets")
			const full = yield* resultsOf(independent, "none")
			deepStrictEqual(
				[
					[reduced.report.interleavings, reduced.report.pruned],
					[full.report.interleavings, full.report.pruned],
					reduced.results.size
				],
				[[1, 1], [2, 0], 1]
			)
		})
	)

	it.effect(
		"reaches the deadlock of two sessions that lock in opposite orders, and its victim",
		() =>
			Effect.gen(function* () {
				const { results, report } = yield* resultsOf(crossing, "sleep-sets")
				assertTrue(report.blocked > 0, "some order made a session wait")
				assertTrue(
					Arr.some([...results], Str.includes("deadlock")),
					`some order ended a session as the deadlock's victim, among ${Arr.join(results, " | ")}`
				)
			})
	)

	it.effect("refuses sessions whose afters form a cycle before running any", () =>
		Effect.gen(function* () {
			const refused = yield* Effect.flip(
				interleave(
					lockManager<"a" | "b">(),
					{
						name: "cyclic",
						sessions: {
							a: { moves: [{ kind: "commit" }], after: Option.some("b") },
							b: { moves: [{ kind: "commit" }], after: Option.some("a") }
						},
						exclusive: [],
						state: Option.none()
					},
					{ kind: "every", limit: 10, reduction: "sleep-sets" },
					() => Effect.void
				)
			)
			deepStrictEqual(
				refused,
				AfterCycle.make({
					interleaving: "cyclic",
					cycle: ["a", "b"],
					message: "cyclic: a, b each start after another of them, so none can start"
				})
			)
		})
	)

	it.effect("follows a script, and stops at a decision it cannot make", () =>
		Effect.gen(function* () {
			const runs: Array<Interleaving<"a" | "b", Move, Outcome, "state", Snapshot, Resource>> = []
			yield* interleave(
				lockManager<"a" | "b">(),
				{ name: "scripted", sessions: crossing, exclusive: [], state: Option.some("state") },
				{
					kind: "script",
					choices: [
						{ kind: "move", session: "a" },
						{ kind: "move", session: "b" },
						{ kind: "read", query: "state" },
						{ kind: "move", session: "a" },
						{ kind: "move", session: "a" }
					]
				},
				(run) => Effect.sync(() => runs.push(run))
			)
			const [run] = runs
			deepStrictEqual(
				[run?.reads, run?.ending],
				[
					[
						{
							query: "state",
							value: [
								["x", 1],
								["y", 2]
							],
							at: 4
						}
					],
					{
						kind: "stopped",
						at: 4,
						choice: { kind: "move", session: "a" },
						why: "a has a move in flight"
					}
				]
			)
		})
	)

	it.effect("draws a schedule from the case's tape, and replays it exactly", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "drawn schedules",
					draw: drawn(sessionSets),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 40,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				(sessions, c: Case<never>) =>
					Effect.gen(function* () {
						const once = yield* oneDrawnRun(sessions, c)
						strictEqual(once.replay.kind, "as-taped")
						strictEqual(
							Struct.keys(sessions).length,
							Arr.filter([...once.sessions.values()], (end) => end.kind !== "unfinished").length
						)
					})
			)
		)
	)
})

/** How a run of the release test ends, as a case draws it: what each way aims at, when it is pending. */
const ENDINGS = [
	{ how: "every order", aims: "a run pruned" },
	{ how: "every order, the second refused", aims: "a run refused" },
	{ how: "a script", aims: "a judged run left a session part-way" },
	{ how: "drawn decisions", aims: "nothing" }
] as const

type Ending = (typeof ENDINGS)[number]

type Released = Exclude<Ending["aims"], "nothing">

/** The ways a case may end its runs: those aimed at a pending requirement where it steers and one is, else every way. */
const endingsFor = (steering: Case<Released>["steering"]): Arr.NonEmptyReadonlyArray<Ending> =>
	Option.match(steering, {
		onNone: () => ENDINGS,
		onSome: (pending) =>
			Arr.match(
				Arr.filter(ENDINGS, (ending) => ending.aims !== "nothing" && pending.has(ending.aims)),
				{ onEmpty: () => ENDINGS, onNonEmpty: (aimed) => aimed }
			)
	})

/** A session set, and the script a scripted run follows: moves of any session, so it stops or runs out part-way. */
const releaseCases: Gen<readonly [Sessions<Named, Move>, ReadonlyArray<Named>]> = (source) => [
	source.draw(sessionSets),
	source.draw(array(element(["a", "b", "c"] as const), { min: 0, max: 6 }))
]

describe("releasing sessions", () => {
	it.effect(
		"releases every session a run started, however the run ends, so no reset meets one left open",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "every started session released",
						draw: drawn(releaseCases),
						literal: Formatter.format,
						coverage: required<Released>(
							["a run pruned", "a run refused", "a judged run left a session part-way"],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 1,
						caseHang: Duration.minutes(1)
					},
					([sessions, script], c: Case<Released>) =>
						Effect.gen(function* () {
							const endings = endingsFor(c.steering)
							const ending = c.draw(element(endings))
							const driver = lockManager<Named>()
							let judged = 0
							const judge = (
								run: Interleaving<Named, Move, Outcome, "state", Snapshot, Resource>
							) =>
								Effect.suspend(() => {
									judged += 1
									if (
										Arr.some(
											run.order,
											(move) => run.sessions.get(move.session)?.kind === "unfinished"
										)
									) {
										c.note("a judged run left a session part-way")
									}
									if (ending.how === "every order, the second refused" && judged === 2) {
										c.note("a run refused")
										return Effect.fail("refused" as const)
									}
									return Effect.void
								})
							const spec: Interleave<Named, Move, "state"> = {
								name: "released",
								sessions,
								exclusive: [],
								state: Option.some("state")
							}
							const strategy: Strategy<Named, "state"> =
								ending.how === "a script"
									? {
											kind: "script",
											choices: Arr.map(script, (session) => ({ kind: "move", session }))
										}
									: ending.how === "drawn decisions"
										? { kind: "drawn", nature: c }
										: { kind: "every", limit: 20_000, reduction: "sleep-sets" }
							const report = yield* interleave(driver, spec, strategy, judge).pipe(
								Effect.asSome,
								Effect.catchTag("InterleavingFailed", () => Effect.succeedNone)
							)
							if (Option.exists(report, (ran) => ran.pruned > 0)) {
								c.note("a run pruned")
							}
							yield* driver.reset
						})
				)
			)
	)
})

/** One run of `sessions` whose decisions are drawn from the case's tape. */
const oneDrawnRun = <S extends string>(sessions: Sessions<S, Move>, c: Case<never>) =>
	Effect.gen(function* () {
		const runs: Array<Interleaving<S, Move, Outcome, "state", Snapshot, Resource>> = []
		const spec: Interleave<S, Move, "state"> = {
			name: "drawn",
			sessions,
			exclusive: [],
			state: Option.some("state")
		}
		yield* interleave(lockManager<S>(), spec, { kind: "drawn", nature: c }, (run) =>
			Effect.sync(() => runs.push(run))
		)
		return Option.getOrThrow(Arr.head(runs))
	})
