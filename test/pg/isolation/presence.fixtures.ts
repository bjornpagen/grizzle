/** What the property of presence.test.ts reads: its shape, its races, and the run of a race against its model. */

import { defined } from "@bjornpagen/testing/assert"
import {
	array,
	constant,
	element,
	type Gen,
	oneOf,
	shuffled,
	type Steered,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Fiber, Option, Order, Record as Rec } from "effect"
import type { Isolation } from "#compiler/core/isolation.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic, Num, Range, Type } from "#compiler/public/compute.ts"
import { domain, natural, range, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, mutable, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { clocked, workload } from "#compiler/public/workload.ts"
import {
	callStandUps,
	callStatements,
	type InstalledShape,
	servedLevel,
	shapeTemplate,
	writeBegin
} from "#test/pg/isolation/support/race.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { type DirectActor, openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { exploreEnv } from "#test/support/schedules/interleave.ts"
import type { ScheduleOutcome } from "#test/support/schedules/types.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

const learnerIdKey = Symbol("LearnerId")
const LearnerId = domain<typeof learnerIdKey>()("LearnerId", int4)
const momentKey = Symbol("Moment")
/** Microseconds on the database's clock, a window's ends; a reading is one below the top, so it ends a window too. */
const Moment = domain<typeof momentKey>()("Moment", int8, (t) => Num.within(t, 0n, 2n ** 62n))
const readingKey = Symbol("Reading")
const Reading = domain<typeof readingKey>()("Reading", int8, (t) =>
	Num.within(t, 0n, 2n ** 62n - 1n)
)

/** A learner's presence in a stage: one window per stretch of readings no more than 3 s apart (docs/reads-and-writes.md "A window a put
 * extends"). */
const Presence = relation("Presence", { child: LearnerId, stage: natural, during: range(Moment) }, [
	"child",
	"stage",
	"during"
])

/** The most microseconds two readings of one stretch lie apart. */
const stretch = 3_000_000n

/**
 * The presence shape under the name `name`: the role `learner`, whose one member `beacon` records the call's reading
 * of the database's clock at the child and stage its parameters name, as README's beacon does: one put of the window
 * from the earliest start to the latest end of the reading, [now, now + 1 µs), and every window of the stage within
 * 3 s of it, served clocked in microseconds.
 */
const presenceShape = (name: string) => {
	const base = schema(name, [Presence], [unit("Learner", { child: LearnerId }), mutable(Presence)])
	const learner = role(base, "learner", { Presence }, { write: ["Presence"] })
	const near = query(learner)
		.rule((r) =>
			r.find({
				child: r.param("child", LearnerId),
				stage: r.param("stage", natural),
				start: Type.cast(Type.base(r.param("now", Reading)), Moment, momentKey),
				end: Type.cast(Num.add(Type.base(r.param("now", Reading)), 1n), Moment, momentKey)
			})
		)
		.rule((r) => {
			const { child, stage, during } = v(learner.relations.Presence, "window")
			const now = Type.base(r.param("now", Reading))
			return r
				.match(learner.relations.Presence, { child, stage, during })
				.where(
					r.eq(child, r.param("child", LearnerId)),
					r.eq(stage, r.param("stage", natural)),
					Logic.gt(Num.add(Type.base(Range.upper(during, Moment)), stretch), now),
					Logic.lt(Type.base(Range.lower(during, Moment)), Num.add(now, stretch + 1n))
				)
				.find({
					child,
					stage,
					start: Range.lower(during, Moment),
					end: Range.upper(during, Moment)
				})
		})
	const hull = query(learner).rule((r) => {
		const { child, stage, start, end } = v(near, "near")
		const bound = near.bind({
			child: r.param("child", LearnerId),
			stage: r.param("stage", natural),
			now: r.param("now", Reading)
		})
		return r
			.match(bound, { child, stage, start, end })
			.find({ child, stage, start: r.min(start), end: r.max(end) })
	})
	const beacon = ChangeSet.empty(learner).put(
		learner.relations.Presence,
		query(learner).rule((r) => {
			const { child, stage, start, end } = v(hull, "hull")
			const bound = hull.bind({
				child: r.param("child", LearnerId),
				stage: r.param("stage", natural),
				now: r.param("now", Reading)
			})
			return r
				.match(bound, { child, stage, start, end })
				.find({ child, stage, during: r.range(start, end) })
		})
	)
	return {
		schema: base,
		roles: { learner },
		login: login(base, "app", [learner], {
			workload: [
				workload(learner, { beacon: clocked(beacon, { now: "micros" }, { now: readingKey }) })
			]
		})
	}
}

/**
 * The presence shape installed once per member as `grizzle generate` drafts and serves it (race.ts shapeTemplate): the
 * learner at the level generate certifies it at, SERIALIZABLE, the level its put runs at (write/schedule/plan.ts
 * readCommittedLack).
 */
export const generatedShape = shapeTemplate(import.meta, "presence", presenceShape)

/**
 * A stored window, by its ends in milliseconds from the race's instant, the database's clock read as it begins: a
 * stage's windows lie more than 3 s apart, so each is its own stretch.
 */
interface Placed {
	readonly from: number
	readonly to: number
}

/**
 * The windows a race may store before its calls, by name: `long` ends 8 s before the race; `past` 3.5 s before, too far
 * for a reading to join; `recent` 1.5 s before, which a reading joins; `ahead` begins 2 s after, which a reading joins
 * too, and with `recent` bridges; `far` begins 4.5 s after. Each pair a stage holds together lies more than 3 s apart.
 */
const placements = {
	long: { from: -9000, to: -8000 },
	past: { from: -4000, to: -3500 },
	recent: { from: -2500, to: -1500 },
	ahead: { from: 2000, to: 2500 },
	far: { from: 4500, to: 5000 }
} as const satisfies Readonly<Record<string, Placed>>

type Placement = keyof typeof placements

/** A stage's stored windows: `long` or none, then one of `past` and `recent` or none, then one of `ahead` and `far`
 * or none. */
const storedGen: Gen<ReadonlyArray<Placement>> = (s) => [
	...s.draw(element([[], ["long"]] as const)),
	...s.draw(element([[], ["past"], ["recent"]] as const)),
	...s.draw(element([[], ["ahead"], ["far"]] as const))
]

/** One call of a race: the child it beacons at, stage 0, and how its session ends once its put is through. */
export interface PresenceCall {
	readonly child: number
	readonly ends: "commit" | "rollback"
}

/**
 * A race: each child's stored windows; then two to four calls, the i-th in session s_i, every session begun in index
 * order; then each call's statements sent in `starts`' order, each while every call before it holds its transaction
 * open; then the sessions ended in `ends`' order, each as soon as its put is through, a session waiting on another
 * taking its turn once that one ended.
 */
export interface PresenceRace {
	readonly stored: Readonly<Record<"0" | "1", ReadonlyArray<Placement>>>
	readonly calls: Arr.NonEmptyReadonlyArray<PresenceCall>
	readonly starts: ReadonlyArray<number>
	readonly ends: ReadonlyArray<number>
}

/** A call at one of two children, drawn toward the first, so calls meet at one child often. */
const callGen: Gen<PresenceCall> = (s) => ({
	child: s.draw(
		weighted([
			[3, constant(0)],
			[1, constant(1)]
		])
	),
	ends: s.draw(
		weighted([
			[4, constant<PresenceCall["ends"]>("commit")],
			[1, constant<PresenceCall["ends"]>("rollback")]
		])
	)
})

const presenceRaces: Gen<PresenceRace> = (s) => {
	const calls = nonEmptyList(s.draw(array(callGen, { min: 2, max: 4 })), "a race's calls")
	const order = upTo(calls.length, (i) => i)
	const all = { min: order.length, max: order.length }
	return {
		stored: { "0": s.draw(storedGen), "1": s.draw(storedGen) },
		calls,
		starts: s.draw(shuffled(order, all)),
		ends: s.draw(shuffled(order, all))
	}
}

/**
 * The races that reach what a drawn one seldom does: two calls at child 0 between its `recent` and `ahead` windows,
 * the second begun putting first, which bridges them, both committing, beside a call at child 1 with no window, which
 * opens one; and two calls at child 0 past its `past` window, the first rolling back. Each ends in a drawn order.
 */
const aimedRaces: ReadonlyArray<Gen<PresenceRace>> = [
	(s) => ({
		stored: { "0": ["long", "recent", "ahead"], "1": [] },
		calls: [
			{ child: 0, ends: "commit" },
			{ child: 0, ends: "commit" },
			{ child: 1, ends: "commit" }
		],
		starts: [1, 0, 2],
		ends: s.draw(shuffled([0, 1, 2], { min: 3, max: 3 }))
	}),
	(s) => ({
		stored: { "0": ["past"], "1": ["far"] },
		calls: [
			{ child: 0, ends: "rollback" },
			{ child: 0, ends: "commit" },
			{ child: 1, ends: "commit" }
		],
		starts: [0, 1, 2],
		ends: s.draw(shuffled([0, 1, 2], { min: 3, max: 3 }))
	})
]

/**
 * The race a case runs, drawn under its steering: while a situation is pending, an aimed race or a drawn one, each
 * alike; otherwise a drawn one, as a rotating case always is.
 */
export const aimedPresenceRaces: Steered<PresenceRace, PresenceFeature>["under"] = (steering) =>
	Option.isSome(steering) ? oneOf([presenceRaces, ...aimedRaces]) : presenceRaces

export type PresenceFeature =
	| "a reading that opened a window"
	| "a reading that extended a window"
	| "a reading that bridged two windows"
	| "calls at one child at once"
	| "children apart at once"
	| "a call rolled back"
	| "a SERIALIZABLE call refused"

/** Call `i` of a race. */
const callOf = (race: PresenceRace, i: number): PresenceCall => defined(race.calls[i], `call ${i}`)

/** The calls a race's call `i` puts after: those before it in `starts`. */
const holdersOf = (race: PresenceRace, i: number): ReadonlyArray<number> =>
	Arr.takeWhile(race.starts, (j) => j !== i)

/** What a call's statements showed: the SQLSTATE of the first that failed, none where all succeeded. */
const failureOf = (outcomes: ReadonlyArray<ScheduleOutcome>): string | undefined => {
	for (const o of outcomes) {
		if (o._tag === "PgError") {
			return o.fields.code
		}
		if (o._tag === "RolledBack" || o._tag === "Failed") {
			return o._tag
		}
	}
	return undefined
}

/** The database's clock in microseconds: a session's call reading, as a clocked statement reads it, or the instant. */
const clockSql = (fn: "transaction_timestamp" | "clock_timestamp"): string =>
	`SELECT (pg_catalog.extract('epoch'::pg_catalog.text, pg_catalog.${fn}()) * 1000000::pg_catalog.numeric)::pg_catalog.int8::pg_catalog.text`

/** The one text of an outcome's one row, none for any other outcome. */
const onlyText = (o: ScheduleOutcome): string | undefined =>
	o._tag === "Ok" ? (textOfValue(o.rows[0]?.[0]) ?? undefined) : undefined

/** A window, by its child and its ends in microseconds on the database's clock, its end excluded. */
interface Window {
	readonly child: number
	readonly from: bigint
	readonly to: bigint
}

/** What a race shows at one level: the race's instant, each call's reading and its outcomes, the order its sessions
 * committed in, the problems the run met on the way, and the windows it left. */
export interface RaceRun {
	readonly at: bigint
	readonly readings: ReadonlyArray<bigint>
	readonly outcomes: ReadonlyArray<ReadonlyArray<ScheduleOutcome>>
	readonly commits: ReadonlyArray<number>
	readonly problems: ReadonlyArray<string>
	readonly windows: ReadonlyArray<Window>
}

/** A stored window of `child` at its placement, its ends `at` plus its milliseconds. */
const windowAt = (child: number, at: bigint, placed: Placed): Window => ({
	child,
	from: at + BigInt(placed.from) * 1000n,
	to: at + BigInt(placed.to) * 1000n
})

/** The stored windows of a race at its instant. */
const storedWindows = (race: PresenceRace, at: bigint): ReadonlyArray<Window> =>
	Arr.flatMap([0, 1] as const, (child) =>
		Arr.map(race.stored[child === 0 ? "0" : "1"], (p) => windowAt(child, at, placements[p]))
	)

/**
 * Runs `race` over `s` (PresenceRace): the observer reads the database's clock, the race's instant, and stores each
 * child's windows at it; every session begins as the learner's served writes do, at the level generate certifies it at
 * (race.ts writeBegin), and reads its clock, its call's reading; each in
 * `starts`' order sends its call's statements on a fiber of its own, while every session before it holds its
 * transaction open, and a call at a child no open session before it beacons must finish without waiting on a lock (the
 * problem otherwise is that it waited on a call of another child), read by polling its backend's lock wait
 * (substrate/barrier.ts lockWaitOf) against its fiber's end. Then each session ends in `ends`' order, the first whose
 * put is through, committing where its call drew it and succeeded, a session still waiting taking its turn once the
 * one it waits on ended. The observer reads the windows last.
 */
export const runRace = (s: InstalledShape, race: PresenceRace) =>
	Effect.scoped(
		Effect.gen(function* () {
			const level = servedLevel(s, "learner")
			const substrate = yield* Substrate
			const env = yield* exploreEnv(substrate)
			const instant = yield* env.observer.queryValues(clockSql("clock_timestamp"), [])
			const at = BigInt(defined(textOfValue(instant[0]?.[0]) ?? undefined, "the race's instant"))
			yield* Effect.provideService(
				replaceMigrated(s.installed, {
					Presence: Arr.map(storedWindows(race, at), (w) => ({
						child: w.child,
						stage: 0n,
						during: { start: w.from, end: w.to }
					}))
				}),
				Substrate,
				substrate
			)
			const learner = defined(s.shape.roles["learner"], "the learner")
			const sessions = Arr.map(race.calls, (_, i) => `s${i}`)
			const actors = yield* openActors(
				substrate,
				Rec.fromEntries(
					Arr.map(
						sessions,
						(name) => [name, { kind: "raw" as const, as: s.installed.world(learner) }] as const
					)
				)
			)
			const actorOf = (i: number): DirectActor => defined(actors[`s${i}`], `session s${i}`)
			for (const [i] of sessions.entries()) {
				for (const sql of callStandUps(s, { role: "learner", member: "beacon" })) {
					yield* actorOf(i).perform({ _tag: "Sql", sql })
				}
			}
			const sent = yield* Effect.forEach(race.calls, (c, i) =>
				callStatements(s, {
					kind: "change",
					session: `s${i}`,
					role: "learner",
					member: "beacon",
					input: { kind: "params", params: { child: c.child, stage: 0n } }
				})
			)
			const readings: Array<bigint> = []
			for (const [i] of sessions.entries()) {
				yield* actorOf(i).perform(writeBegin(s, "learner"))
				const read = yield* actorOf(i).perform({
					_tag: "Sql",
					sql: clockSql("transaction_timestamp")
				})
				readings.push(BigInt(defined(onlyText(read), `session s${i}'s reading`)))
			}
			const problems: Array<string> = []
			const fibers = new Map<number, Fiber.Fiber<ReadonlyArray<ScheduleOutcome>>>()
			const put = (i: number) =>
				Effect.gen(function* () {
					const outcomes: Array<ScheduleOutcome> = []
					for (const sql of defined(sent[i], `session s${i}'s statements`)) {
						if (failureOf(outcomes) !== undefined) {
							break
						}
						const outcome = yield* actorOf(i).perform({ _tag: "Sql", sql })
						outcomes.push(outcome)
					}
					return outcomes
				})
			for (const i of race.starts) {
				const call = callOf(race, i)
				const shared = Arr.some(holdersOf(race, i), (j) => callOf(race, j).child === call.child)
				const fiber = yield* Effect.forkChild(put(i))
				fibers.set(i, fiber)
				for (;;) {
					if (fiber.pollUnsafe() !== undefined) {
						break
					}
					const wait = yield* lockWaitOf(env.observer, actorOf(i).pid)
					if (wait !== undefined) {
						if (!shared) {
							problems.push(
								`s${i} at child ${call.child} waited on ${wait.locktype} ${wait.mode}, held by a call of another child`
							)
						}
						break
					}
					yield* Effect.yieldNow
				}
				if (problems.length > 0) {
					return { at, readings, outcomes: [], commits: [], problems, windows: [] }
				}
			}
			const outcomes = new Map<number, ReadonlyArray<ScheduleOutcome>>()
			const commits: Array<number> = []
			while (outcomes.size < race.calls.length) {
				const ready = Arr.findFirst(
					race.ends,
					(i) =>
						!outcomes.has(i) && defined(fibers.get(i), `s${i}'s fiber`).pollUnsafe() !== undefined
				)
				if (Option.isNone(ready)) {
					yield* Effect.raceAll(
						Arr.flatMap(race.ends, (i) =>
							outcomes.has(i) ? [] : [Fiber.await(defined(fibers.get(i), `s${i}'s fiber`))]
						)
					)
					continue
				}
				const through = ready.value
				const own = yield* Fiber.join(defined(fibers.get(through), `s${through}'s fiber`))
				outcomes.set(through, own)
				const commit = failureOf(own) === undefined && callOf(race, through).ends === "commit"
				const ended = yield* actorOf(through).perform(
					commit ? { _tag: "Commit" } : { _tag: "Rollback" }
				)
				if (commit && ended._tag === "Ok") {
					commits.push(through)
				} else if (commit && !(level === "serializable" && failureOf([ended]) === "40001")) {
					problems.push(`s${through}'s COMMIT failed: ${failureOf([ended]) ?? ended._tag}`)
				}
			}
			const t = s.names
			const found = yield* env.observer.queryValues(
				`SELECT ${t.column(Presence, "child")}::text, pg_catalog.lower(${t.column(Presence, "during")})::text, pg_catalog.upper(${t.column(Presence, "during")})::text FROM ${t.table(Presence)} WHERE ${t.column(Presence, "stage")} = 0`,
				[]
			)
			return {
				at,
				readings,
				outcomes: Arr.map(race.calls, (_, i) => defined(outcomes.get(i), `s${i}'s outcomes`)),
				commits,
				problems,
				windows: Arr.map(found, (row): Window => ({
					child: Number(textOfValue(row[0])),
					from: BigInt(String(textOfValue(row[1]))),
					to: BigInt(String(textOfValue(row[2])))
				}))
			}
		})
	)

const byStart: Order.Order<Window> = Order.mapInput(Order.BigInt, (w: Window) => w.from)

/**
 * The 3 s stretches of a child's windows and readings, each reading the window [reading, reading + 1 µs): sorted by
 * start, each window joins the stretch before it where it starts within 3 s of that stretch's last microsecond, its end
 * less one, and each stretch is the window from its earliest start to its latest end.
 */
const stretchesOf = (windows: ReadonlyArray<Window>): ReadonlyArray<Window> => {
	const none: ReadonlyArray<Window> = []
	return Arr.reduce(Arr.sort(windows, byStart), none, (done, w) => {
		const last = done.at(-1)
		return last !== undefined && w.from - (last.to - 1n) <= stretch
			? [...done.slice(0, -1), { ...last, to: last.to > w.to ? last.to : w.to }]
			: [...done, w]
	})
}

/** A window's text, as the run's problems name it, its ends in milliseconds from the race's instant. */
const windowText =
	(at: bigint) =>
	(w: Window): string =>
		`${w.child}:[${Number(w.from - at) / 1000}, ${Number(w.to - at) / 1000})`

/**
 * What a race's run should have left, by the 3 s stretches of each child's stored windows and its committed calls'
 * readings, whatever order the calls committed in (`stretchesOf`); and each call's own fate at `level`: at SERIALIZABLE
 * a call succeeds or is refused with 40001, a serialization failure; at READ COMMITTED every call succeeds. The problems
 * are every difference: a call's failure outside its fate, and each child's windows against the model's.
 */
export const problemsOf = (
	race: PresenceRace,
	run: RaceRun,
	level: Isolation
): ReadonlyArray<string> => {
	const fates = Arr.flatMap(race.calls, (call, i) => {
		const outcomes = defined(run.outcomes[i], `s${i}'s outcomes`)
		const failure = failureOf(outcomes)
		const admitted = failure === undefined || (level === "serializable" && failure === "40001")
		const said = Arr.flatMap(outcomes, (o) => (o._tag === "PgError" ? [o.fields.message] : []))
		return admitted
			? []
			: [
					`s${i} at child ${call.child}: ${failure} (${Arr.join(said, "; ")}), where success was due`
				]
	})
	const text = windowText(run.at)
	const modelOf = (child: number): ReadonlyArray<string> =>
		Arr.map(
			stretchesOf([
				...Arr.filter(storedWindows(race, run.at), (w) => w.child === child),
				...Arr.flatMap(run.commits, (i) =>
					callOf(race, i).child === child
						? [
								{
									child,
									from: defined(run.readings[i], `s${i}'s reading`),
									to: defined(run.readings[i], `s${i}'s reading`) + 1n
								}
							]
						: []
				)
			]),
			text
		)
	const storedOf = (child: number): ReadonlyArray<string> =>
		Arr.map(
			Arr.sort(
				Arr.filter(run.windows, (w) => w.child === child),
				byStart
			),
			text
		)
	const windows = Arr.flatMap([0, 1], (child) => {
		const [stored, model] = [storedOf(child), modelOf(child)]
		return Arr.join(stored, "; ") === Arr.join(model, "; ")
			? []
			: [
					`child ${child}'s windows: ${Arr.join(stored, "; ") || "none"}, where the stretches of its windows and committed readings are ${Arr.join(model, "; ") || "none"}`
				]
	})
	return [...fates, ...windows]
}

/** The features a race reached at `level`, by its run there. */
export const featuresOf = (
	race: PresenceRace,
	run: RaceRun,
	level: Isolation
): ReadonlyArray<PresenceFeature> => {
	const stored = storedWindows(race, run.at)
	const within = (reading: bigint, w: Window): boolean =>
		w.to + stretch > reading && w.from < reading + 1n + stretch
	const near = (i: number): ReadonlyArray<Window> => {
		const reading = defined(run.readings[i], `s${i}'s reading`)
		return Arr.filter(stored, (w) => w.child === callOf(race, i).child && within(reading, w))
	}
	const committed = run.commits
	const pairs = Arr.flatMap(race.calls, (c, i) =>
		Arr.flatMap(race.calls, (d, j) => (i < j ? [[c, d] as const] : []))
	)
	return [
		...(Arr.some(committed, (i) => near(i).length === 0)
			? ["a reading that opened a window" as const]
			: []),
		...(Arr.some(committed, (i) => near(i).length === 1)
			? ["a reading that extended a window" as const]
			: []),
		...(Arr.some(committed, (i) => near(i).length >= 2)
			? ["a reading that bridged two windows" as const]
			: []),
		...(Arr.some(pairs, ([c, d]) => c.child === d.child)
			? ["calls at one child at once" as const]
			: []),
		...(Arr.some(pairs, ([c, d]) => c.child !== d.child)
			? ["children apart at once" as const]
			: []),
		...(Arr.some(race.calls, (c) => c.ends === "rollback") ? ["a call rolled back" as const] : []),
		...(level === "serializable" && Arr.some(run.outcomes, (o) => failureOf(o) === "40001")
			? ["a SERIALIZABLE call refused" as const]
			: [])
	]
}
