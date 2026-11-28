/** What the property of stamps.test.ts reads: its shape, its races, and the run of a race against its model. */

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
import { Array as Arr, Effect, Exit, Fiber, Option, Record as Rec, String as Str } from "effect"
import type { Isolation } from "#compiler/core/isolation.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { contract, instant, natural, place, int4 } from "#compiler/public/fields.ts"
import { query } from "#compiler/public/query.ts"
import { login, mutable, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import {
	callStandUps,
	callStatements,
	type InstalledShape,
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

const kidNoKey = Symbol("KidNo")
/** A kid's number, the unit Kid's key: a contract of its own, so Tick's natural child sits in no unit. */
const KidNo = contract<typeof kidNoKey>()("KidNo", int4)

/** A kid's fact at the database's instant: its clock's child is (kid, part), its scope the unit Kid's. */
const Event = relation("Event", { kid: KidNo, part: natural, at: instant, kind: natural }, [
	"kid",
	"part",
	"at"
])

/** A kid's other fact at the database's instant: a second clock of the unit Kid, its child (kid, part), mutable, so a
 * writer that holds UPDATE may move its clock (clock guard, physical/ddl/clocked.ts). */
const Mark = relation("Mark", { kid: KidNo, part: natural, at: instant, kind: natural }, [
	"kid",
	"part",
	"at"
])

/** A kid's numbered fact: its place's group is (kid, part). */
const Slot = relation("Slot", { kid: KidNo, part: natural, n: place, v: natural }, [
	"kid",
	"part",
	"n"
])

/** A child's fact at the database's instant, under no unit: its clock's child (child, part) is its own scope. */
const Tick = relation("Tick", { child: natural, part: natural, at: instant, kind: natural }, [
	"child",
	"part",
	"at"
])

/** What a call appends, by its member: an Event with its Slot; a Mark with an Event, two clocks of Kid in one call; or a
 * Tick. */
export type StampClock = "event" | "mark" | "tick"

/**
 * The stamp shape under the name `name`: the unit Kid over Event, Mark and Slot, and Tick under none; the role
 * `writer`, whose members each append at the kid or child their parameters name, each row carrying the call's `kind`:
 * `event` an Event, stamped by Kid's head, and its Slot, stamped by its place; `mark` a Mark and an Event, both stamped
 * by Kid's head in the one call, at its one instant; and
 * `tick` a Tick, stamped by its own child's head.
 */
const stampShape = (name: string) => {
	const relations = { Event, Mark, Slot, Tick } as const
	const base = schema(name, Rec.values(relations), [unit("Kid", { kid: KidNo }), mutable(Mark)])
	const writer = role(base, "writer", relations, { insert: ["Event", "Mark", "Slot", "Tick"] })
	const mine = writer.relations
	const at = query(writer).rule((r) =>
		r.find({
			kid: r.param("kid", KidNo),
			part: r.param("part", natural),
			kind: r.param("kind", natural)
		})
	)
	const event = ChangeSet.empty(writer)
		.insert(mine.Event, at)
		.insert(
			mine.Slot,
			query(writer).rule((r) =>
				r.find({
					kid: r.param("kid", KidNo),
					part: r.param("part", natural),
					v: r.param("kind", natural)
				})
			)
		)
	const mark = ChangeSet.empty(writer).insert(mine.Mark, at).insert(mine.Event, at)
	const tick = ChangeSet.empty(writer).insert(
		mine.Tick,
		query(writer).rule((r) =>
			r.find({
				child: r.param("child", natural),
				part: r.param("part", natural),
				kind: r.param("kind", natural)
			})
		)
	)
	return {
		schema: base,
		roles: { writer },
		login: login(base, "app", [writer], { workload: [workload(writer, { event, mark, tick })] })
	}
}

/**
 * The stamp shape installed once per member as `grizzle generate` drafts and serves it (race.ts shapeTemplate): the
 * writer at the level generate certifies it at, READ COMMITTED.
 */
export const generatedShape = shapeTemplate(import.meta, "stamps", stampShape)

/** One call of a race: the clock it stamps, the kid or child and part it appends at, and how its session ends once its
 * stamp is through. */
export interface StampCall {
	readonly clock: StampClock
	readonly child: number
	readonly part: number
	readonly ends: "commit" | "rollback"
}

/**
 * A race: two to four calls, the i-th in session s_i, every session begun in index order; then each call's stamping
 * statements sent in `starts`' order, each while every call before it holds its transaction open; then the sessions
 * ended in `ends`' order, each as soon as its stamp is through, a session waiting on another taking its turn once that
 * one ended.
 */
export interface StampRace {
	readonly calls: Arr.NonEmptyReadonlyArray<StampCall>
	readonly starts: ReadonlyArray<number>
	readonly ends: ReadonlyArray<number>
}

/** A call of the race's box, its clock drawn toward the unit's two and its kid or child toward a few, so calls meet at
 * one key often, across the unit's clocks and children. */
const callGen: Gen<StampCall> = (s) => ({
	clock: s.draw(
		weighted([
			[2, constant<StampClock>("event")],
			[2, constant<StampClock>("mark")],
			[1, constant<StampClock>("tick")]
		])
	),
	child: s.draw(element([0, 1])),
	part: s.draw(
		weighted([
			[3, constant(0)],
			[1, constant(1)]
		])
	),
	ends: s.draw(
		weighted([
			[4, constant<StampCall["ends"]>("commit")],
			[1, constant<StampCall["ends"]>("rollback")]
		])
	)
})

const stampRaces: Gen<StampRace> = (s) => {
	const calls = nonEmptyList(s.draw(array(callGen, { min: 2, max: 4 })), "a race's calls")
	const order = upTo(calls.length, (i) => i)
	const all = { min: order.length, max: order.length }
	return { calls, starts: s.draw(shuffled(order, all)), ends: s.draw(shuffled(order, all)) }
}

/** The calls of an aimed race, each at its clock, kid or child and part, ending as it states. */
const aimedCalls = (
	calls: Arr.NonEmptyReadonlyArray<readonly [StampClock, number, number, StampCall["ends"]]>
): Arr.NonEmptyReadonlyArray<StampCall> =>
	Arr.map(calls, ([clock, child, part, ends]) => ({ clock, child, part, ends }))

/**
 * A race that reaches every situation but a holder's rollback and a unitless clock's children sharing a field: an
 * Event at kid 0, a Mark at kid 0 begun after it and stamping first, an Event at kid 0 again, and a Tick beside them,
 * all committing; and one that reaches those two: an Event at kid 0, one at kid 0's other part begun after it,
 * stamping first and rolling back, and two Ticks at one child's two parts. Each ends in a drawn order. The first is
 * qti-pie's sitting (edullm QP-SITTING-READ P8): a save of a learner's item session, on its session's clock, begun
 * before the end of the learner's sitting, on the sitting's clock, which takes the learner's borrow first, so per-child
 * heads stamped the save below the end it commits after.
 */
const aimedRaces: ReadonlyArray<Gen<StampRace>> = [
	(s) => ({
		calls: aimedCalls([
			["event", 0, 0, "commit"],
			["mark", 0, 1, "commit"],
			["event", 0, 0, "commit"],
			["tick", 0, 1, "commit"]
		]),
		starts: [1, 0, 2, 3],
		ends: s.draw(shuffled([0, 1, 2, 3], { min: 4, max: 4 }))
	}),
	(s) => ({
		calls: aimedCalls([
			["event", 0, 0, "commit"],
			["event", 0, 1, "rollback"],
			["tick", 1, 0, "commit"],
			["tick", 1, 1, "commit"]
		]),
		starts: [1, 0, 2, 3],
		ends: s.draw(shuffled([0, 1, 2, 3], { min: 4, max: 4 }))
	})
]

/**
 * The race a case runs, drawn under its steering: while a situation is pending, an aimed race or a drawn one, each
 * alike; otherwise a drawn one, as a rotating case always is. The generator draws it, so it is the race the search runs,
 * prints and keeps.
 */
export const aimedStampRaces: Steered<StampRace, StampFeature>["under"] = (steering) =>
	Option.isSome(steering) ? oneOf([stampRaces, ...aimedRaces]) : stampRaces

export type StampFeature =
	| "a waiter whose holder committed"
	| "a waiter whose holder rolled back"
	| "three calls at one key"
	| "keys apart at once"
	| "two clocks of one unit at one key"
	| "two clocks of one unit in one call"
	| "two children of one unit's clock at one key"
	| "children of a clock no unit holds sharing a field"
	| "a later-begun call stamped first"
	| "a later-begun call stamped first at another clock or child of its unit"
	| "a SERIALIZABLE call refused at an advanced head"

/**
 * The key of the head a call stamps: its kid's, Kid's scope, for an Event or a Mark, every clock and child of the unit
 * alike; its child's, Tick's own scope, for a Tick.
 */
const keyOf = (c: StampCall): string =>
	c.clock === "tick" ? `tick (${c.child}, ${c.part})` : `kid ${c.child}`

/** A call's text, as the race's messages name it. */
const callText = (c: StampCall): string => `${c.clock} (${c.child}, ${c.part})`

/** A row's child, as the race's rows name it. */
const childText = (c: StampCall): string => `(${c.child}, ${c.part})`

/** Call `i` of a race. */
const callOf = (race: StampRace, i: number): StampCall => defined(race.calls[i], `call ${i}`)

/** The calls a race's call `i` stamps after: those before it in `starts`. */
const holdersOf = (race: StampRace, i: number): ReadonlyArray<number> =>
	Arr.takeWhile(race.starts, (j) => j !== i)

/** Whether two calls stamp one head at one key, so the later waits on the earlier. */
const sameKey = (a: StampCall, b: StampCall): boolean => keyOf(a) === keyOf(b)

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

/** The call's reading of the database's clock in microseconds, as a stamping statement reads it (write/insert/stamp.ts). */
const clockSql = `SELECT (pg_catalog.extract('epoch'::pg_catalog.text, pg_catalog.transaction_timestamp()) * 1000000::pg_catalog.numeric)::pg_catalog.int8::pg_catalog.text`

/** The one text of an outcome's one row, none for any other outcome. */
const onlyText = (o: ScheduleOutcome): string | undefined =>
	o._tag === "Ok" ? (textOfValue(o.rows[0]?.[0]) ?? undefined) : undefined

/** One session's run: its clock reading, and its stamp's outcomes once through. */
interface Run {
	readonly clock: bigint
	readonly outcomes: ReadonlyArray<ScheduleOutcome>
}

/** A row of a race's relations as the observer reads it: its child, its stamp and the session that wrote it. */
interface Stamped {
	readonly child: string
	readonly stamp: bigint
	readonly session: number
}

/** The rows a race leaves, by relation: Event's, Mark's and Tick's, each stamped by its clock, and Slot's, by its
 * place. */
interface RaceRows {
	readonly events: ReadonlyArray<Stamped>
	readonly marks: ReadonlyArray<Stamped>
	readonly ticks: ReadonlyArray<Stamped>
	readonly slots: ReadonlyArray<Stamped>
}

/** What a race shows at one level: each session's run, the order its sessions committed in, the problems the run met on
 * the way, and the rows it left. */
export interface RaceRun extends RaceRows {
	readonly runs: ReadonlyArray<Run>
	readonly commits: ReadonlyArray<number>
	readonly problems: ReadonlyArray<string>
}

/** No rows: a race stopped by a problem before its sessions ended. */
const noRows: RaceRows = { events: [], marks: [], ticks: [], slots: [] }

/**
 * Runs `race` over `s` (StampRace): every session begins as the writer's served writes do, at the level generate
 * certifies it at (race.ts writeBegin), and reads its clock; each in `starts`' order sends its call's statements on a fiber of its own, while every session before it holds its transaction open:
 * one whose head's key an open session before it stamped (keyOf) must wait on a lock (the problem otherwise is that it
 * stamped through), and any other must finish without waiting on one (the problem otherwise is that it waited on a call
 * of another key), each read by polling its backend's lock wait (substrate/barrier.ts lockWaitOf) against its fiber's
 * end. Then each session ends in `ends`' order, the first whose stamp is through, committing where its call drew it and
 * succeeded, a session still waiting taking its turn once the one it waits on ended. The observer reads the rows last.
 */
export const runRace = (s: InstalledShape, race: StampRace) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			yield* Effect.provideService(replaceMigrated(s.installed, {}), Substrate, substrate)
			const env = yield* exploreEnv(substrate)
			const writer = defined(s.shape.roles["writer"], "the writer")
			const sessions = Arr.map(race.calls, (_, i) => `s${i}`)
			const actors = yield* openActors(
				substrate,
				Rec.fromEntries(
					Arr.map(
						sessions,
						(name) => [name, { kind: "raw" as const, as: s.installed.world(writer) }] as const
					)
				)
			)
			const actorOf = (i: number): DirectActor => defined(actors[`s${i}`], `session s${i}`)
			for (const [i, c] of race.calls.entries()) {
				for (const sql of callStandUps(s, { role: "writer", member: c.clock })) {
					yield* actorOf(i).perform({ _tag: "Sql", sql })
				}
			}
			const sent = yield* Effect.forEach(race.calls, (c, i) =>
				callStatements(s, {
					kind: "change",
					session: `s${i}`,
					role: "writer",
					member: c.clock,
					input: {
						kind: "params",
						params:
							c.clock === "tick"
								? { child: BigInt(c.child), part: BigInt(c.part), kind: BigInt(i) }
								: { kid: c.child, part: BigInt(c.part), kind: BigInt(i) }
					}
				})
			)
			const clocks: Array<bigint> = []
			for (const [i] of sessions.entries()) {
				yield* actorOf(i).perform(writeBegin(s, "writer"))
				const read = yield* actorOf(i).perform({ _tag: "Sql", sql: clockSql })
				clocks.push(BigInt(defined(onlyText(read), `session s${i}'s clock`)))
			}
			const problems: Array<string> = []
			const fibers = new Map<number, Fiber.Fiber<ReadonlyArray<ScheduleOutcome>>>()
			const stamp = (i: number) =>
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
				const call = defined(race.calls[i], `call ${i}`)
				const held = Arr.some(holdersOf(race, i), (j) => sameKey(callOf(race, j), call))
				const fiber = yield* Effect.forkChild(stamp(i))
				fibers.set(i, fiber)
				for (;;) {
					const through = fiber.pollUnsafe()
					if (through !== undefined) {
						if (held) {
							const shown = Exit.isSuccess(through)
								? (failureOf(through.value) ?? "succeeded")
								: "died"
							problems.push(
								`s${i} stamped ${callText(call)} through (${shown}) while a session before it held the stamp of ${keyOf(call)}`
							)
						}
						break
					}
					const wait = yield* lockWaitOf(env.observer, actorOf(i).pid)
					if (wait !== undefined) {
						if (!held) {
							problems.push(
								`s${i} at ${callText(call)} waited on ${wait.locktype} ${wait.mode}, held by a call of another key`
							)
						}
						break
					}
					yield* Effect.yieldNow
				}
				if (problems.length > 0) {
					return { runs: [], commits: [], problems, ...noRows }
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
				} else if (commit) {
					problems.push(`s${through}'s COMMIT failed: ${failureOf([ended]) ?? ended._tag}`)
				}
			}
			const rows = (sql: string) =>
				Effect.map(env.observer.queryValues(sql, []), (found) =>
					Arr.map(found, (row): Stamped => ({
						child: `(${textOfValue(row[0])}, ${textOfValue(row[1])})`,
						stamp: BigInt(String(textOfValue(row[2]))),
						session: Number(textOfValue(row[3]))
					}))
				)
			const t = s.names
			const events = yield* rows(
				`SELECT ${t.column(Event, "kid")}::text, ${t.column(Event, "part")}::text, ${t.column(Event, "at")}::text, ${t.column(Event, "kind")}::text FROM ${t.table(Event)}`
			)
			const marks = yield* rows(
				`SELECT ${t.column(Mark, "kid")}::text, ${t.column(Mark, "part")}::text, ${t.column(Mark, "at")}::text, ${t.column(Mark, "kind")}::text FROM ${t.table(Mark)}`
			)
			const ticks = yield* rows(
				`SELECT ${t.column(Tick, "child")}::text, ${t.column(Tick, "part")}::text, ${t.column(Tick, "at")}::text, ${t.column(Tick, "kind")}::text FROM ${t.table(Tick)}`
			)
			const slots = yield* rows(
				`SELECT ${t.column(Slot, "kid")}::text, ${t.column(Slot, "part")}::text, ${t.column(Slot, "n")}::text, ${t.column(Slot, "v")}::text FROM ${t.table(Slot)}`
			)
			return {
				runs: Arr.map(race.calls, (_, i): Run => ({
					clock: defined(clocks[i], `s${i}'s clock`),
					outcomes: defined(outcomes.get(i), `s${i}'s outcomes`)
				})),
				commits,
				problems,
				events,
				marks,
				ticks,
				slots
			}
		})
	)

/**
 * What a race's run should have left, by the serial run of its committed calls in the order they committed, each
 * call's stamp at its head's key (keyOf) the greater of its clock reading and one past the stamp before it there,
 * whichever clock and child of the key's scope stamped it, the first at a key its clock; its place one past the place
 * before it in its group, from 0; and each call's own fate at `level`. So a scope's instants rise in commit order across
 * every clock and child it holds. At READ COMMITTED every call succeeds. At SERIALIZABLE a call whose key a call stamped
 * before it, which then committed, is refused with 40001, a call that stamps after a head its snapshot did not see, and
 * every other call succeeds. The problems are every difference: a refused or a succeeded call against its fate, and each
 * relation's rows against the model, as sets of (child, stamp, session).
 */
export const problemsOf = (
	race: StampRace,
	run: RaceRun,
	level: Isolation
): ReadonlyArray<string> => {
	const fates = Arr.flatMap(race.calls, (call, i) => {
		const own = defined(run.runs[i], `s${i}'s run`)
		const failure = failureOf(own.outcomes)
		const advanced = Arr.some(
			holdersOf(race, i),
			(j) => sameKey(callOf(race, j), call) && Arr.contains(run.commits, j)
		)
		const expected = level === "serializable" && advanced ? "40001" : undefined
		return failure === expected
			? []
			: [
					`s${i} at ${callText(call)}: ${failure ?? "succeeded"}, where ${expected ?? "success"} was due`
				]
	})
	const model: Record<keyof RaceRows, Array<Stamped>> = {
		events: [],
		marks: [],
		ticks: [],
		slots: []
	}
	const instants = new Map<string, bigint>()
	const places = new Map<string, bigint>()
	for (const i of run.commits) {
		const call = callOf(race, i)
		const child = childText(call)
		const key = keyOf(call)
		const head = instants.get(key)
		const clock = defined(run.runs[i], `s${i}'s run`).clock
		const at = head === undefined || clock > head + 1n ? clock : head + 1n
		instants.set(key, at)
		const stamped = { child, stamp: at, session: i }
		switch (call.clock) {
			case "event": {
				const before = places.get(child)
				const n = before === undefined ? 0n : before + 1n
				places.set(child, n)
				model.events.push(stamped)
				model.slots.push({ child, stamp: n, session: i })
				break
			}
			case "mark":
				model.marks.push(stamped)
				model.events.push(stamped)
				break
			case "tick":
				model.ticks.push(stamped)
				break
		}
	}
	const text = (rows: ReadonlyArray<Stamped>): ReadonlyArray<string> =>
		Arr.sort(
			Arr.map(rows, (r) => `${r.child} ${r.stamp} s${r.session}`),
			(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
		)
	const compare = (what: keyof RaceRows) => {
		const [a, m] = [text(run[what]), text(model[what])]
		return Arr.join(a, "; ") === Arr.join(m, "; ")
			? []
			: [
					`${what}: ${Arr.join(a, "; ") || "none"}, where the serial run in commit order leaves ${Arr.join(m, "; ") || "none"}`
				]
	}
	return [
		...fates,
		...compare("events"),
		...compare("marks"),
		...compare("ticks"),
		...compare("slots")
	]
}

/** The features a race reached at `level`, by its run there. */
export const featuresOf = (
	race: StampRace,
	run: RaceRun,
	level: Isolation
): ReadonlyArray<StampFeature> => {
	const committed = (i: number) => Arr.contains(run.commits, i)
	const holders = (i: number) =>
		Arr.filter(holdersOf(race, i), (j) => sameKey(callOf(race, j), callOf(race, i)))
	const waiters = Arr.filter(
		upTo(race.calls.length, (i) => i),
		(i) => holders(i).length > 0
	)
	const pairs = Arr.flatMap(race.calls, (c, i) =>
		Arr.flatMap(race.calls, (d, j) => (i === j ? [] : [[c, d] as const]))
	)
	/** Whether a waiter `i` began before its holder `j`, which stamped first, both committing. */
	const laterFirst = (i: number, j: number): boolean => j > i && committed(j) && committed(i)
	/** Whether two calls of one key stamp another clock or child of it: an Event and a Mark, or two parts. */
	const elsewhere = (i: number, j: number): boolean => {
		const [c, d] = [callOf(race, i), callOf(race, j)]
		return c.clock !== d.clock || c.part !== d.part
	}
	return [
		...(Arr.some(waiters, (i) => Arr.some(holders(i), committed))
			? ["a waiter whose holder committed" as const]
			: []),
		...(Arr.some(waiters, (i) => Arr.some(holders(i), (j) => callOf(race, j).ends === "rollback"))
			? ["a waiter whose holder rolled back" as const]
			: []),
		...(Arr.some(race.calls, (c) => Arr.filter(race.calls, (d) => sameKey(c, d)).length >= 3)
			? ["three calls at one key" as const]
			: []),
		...(Arr.some(pairs, ([c, d]) => !sameKey(c, d)) ? ["keys apart at once" as const] : []),
		...(Arr.some(pairs, ([c, d]) => sameKey(c, d) && c.clock !== d.clock)
			? ["two clocks of one unit at one key" as const]
			: []),
		...(Arr.some(run.commits, (i) => callOf(race, i).clock === "mark")
			? ["two clocks of one unit in one call" as const]
			: []),
		...(Arr.some(
			pairs,
			([c, d]) => c.clock !== "tick" && c.clock === d.clock && sameKey(c, d) && c.part !== d.part
		)
			? ["two children of one unit's clock at one key" as const]
			: []),
		...(Arr.some(
			pairs,
			([c, d]) =>
				c.clock === "tick" && d.clock === "tick" && c.child === d.child && c.part !== d.part
		)
			? ["children of a clock no unit holds sharing a field" as const]
			: []),
		...(Arr.some(waiters, (i) => Arr.some(holders(i), (j) => laterFirst(i, j)))
			? ["a later-begun call stamped first" as const]
			: []),
		...(Arr.some(waiters, (i) => Arr.some(holders(i), (j) => laterFirst(i, j) && elsewhere(i, j)))
			? ["a later-begun call stamped first at another clock or child of its unit" as const]
			: []),
		...(level === "serializable" && Arr.some(run.runs, (r) => failureOf(r.outcomes) === "40001")
			? ["a SERIALIZABLE call refused at an advanced head" as const]
			: [])
	]
}

/**
 * What a direct writer states of a Mark's clock at kid 0, after a served Mark of kid 0 committed and left the head at
 * its instant h: an insert below h, at h, which the served call stamped, or above it, none of them stamped by the
 * writer's own transaction; an insert at the instant its own call of the scope's stamp function returned, or at that
 * instant at kid 1, which it did not stamp there; an UPDATE that moves the stored Mark off its instant, or to the instant
 * its own stamp returned.
 */
export type DirectStatement =
	| "below the head"
	| "at the head another call stamped"
	| "above the head, unstamped"
	| "at its own stamp"
	| "at its own stamp, at another key"
	| "a move off its stamp"
	| "a move to its own stamp"

/** Who states it: a session of the writer's role, which holds INSERT on Mark and no UPDATE, or the owner's. */
export type DirectWriter = "role" | "owner"

/** One direct write of the box: its writer and what it states. */
export interface DirectCase {
	readonly writer: DirectWriter
	readonly states: DirectStatement
}

/** The box: each writer, each statement, the role's two moves among them, which its privileges refuse. */
export const directGen: Gen<DirectCase> = (source) => ({
	writer: source.draw(element(["role", "owner"] as const)),
	states: source.draw(
		element([
			"below the head",
			"at the head another call stamped",
			"above the head, unstamped",
			"at its own stamp",
			"at its own stamp, at another key",
			"a move off its stamp",
			"a move to its own stamp"
		] as const)
	)
})

/** Whether a statement moves the stored Mark, an UPDATE, which the role holds no privilege for. */
const moves = (states: DirectStatement): boolean =>
	states === "a move off its stamp" || states === "a move to its own stamp"

/** How the installation answers a direct write: admitted, or refused with a SQLSTATE under a constraint. */
export type DirectFate =
	| { readonly kind: "admitted" }
	| { readonly kind: "refused"; readonly code: string; readonly constraint: string | undefined }

/**
 * The fate of `c`: a role's move refused by its privileges (42501, no constraint); a write at its transaction's own
 * stamp at its key admitted; every other refused by its clock's guard, 23514 under `__clocked` for an insert and
 * `__clock_moved` for a move.
 */
export const fateOf = (c: DirectCase): DirectFate =>
	c.writer === "role" && moves(c.states)
		? { kind: "refused", code: "42501", constraint: undefined }
		: c.states === "at its own stamp" || c.states === "a move to its own stamp"
			? { kind: "admitted" }
			: {
					kind: "refused",
					code: "23514",
					constraint: c.states === "a move off its stamp" ? "__clock_moved" : "__clocked"
				}

/**
 * What a direct write showed: the served Mark's instant h; the unit head's scans in the served call's transaction,
 * its sequential and its index scans (pg_stat_xact_user_tables); the direct write's failure, its SQLSTATE and
 * constraint, none where it committed; and the Marks stored after it, each `kid part at`.
 */
interface DirectRun {
	readonly head: bigint
	readonly served: { readonly seqScans: bigint; readonly indexScans: bigint }
	readonly failure: { readonly code: string; readonly constraint: string | undefined } | undefined
	readonly marks: ReadonlyArray<string>
}

/** The failure of a direct transaction's outcomes: the first PostgreSQL error, its code and its constraint. */
const pgFailureOf = (outcomes: ReadonlyArray<ScheduleOutcome>): DirectRun["failure"] => {
	for (const o of outcomes) {
		if (o._tag === "PgError") {
			return { code: o.fields.code, constraint: o.fields.constraint }
		}
	}
	return undefined
}

/**
 * Runs `c` over `s` (DirectCase): a served Mark of kid 0, part 0, in a session of the writer's role, committed, its
 * transaction's scans of Kid's head read before its COMMIT; then the direct writer's one transaction, what it states,
 * and its COMMIT, which judges a move's guard, a deferred one; then the Marks as they stand.
 */
export const runDirect = (s: InstalledShape, c: DirectCase) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			yield* Effect.provideService(replaceMigrated(s.installed, {}), Substrate, substrate)
			const env = yield* exploreEnv(substrate)
			const writer = defined(s.shape.roles["writer"], "the writer")
			const actors = yield* openActors(substrate, {
				served: { kind: "raw", as: s.installed.world(writer) },
				role: { kind: "raw", as: s.installed.world(writer) },
				owner: { kind: "raw", as: substrate.owner }
			})
			const n = s.names
			const head = s.installed.installation.names.head({ kind: "unit", unit: "Kid" })
			const headTable = `${quoteIdent(head.schema)}.${quoteIdent(head.name)}`
			for (const sql of callStandUps(s, { role: "writer", member: "mark" })) {
				yield* actors.served.perform({ _tag: "Sql", sql })
			}
			const sent = yield* callStatements(s, {
				kind: "change",
				session: "served",
				role: "writer",
				member: "mark",
				input: { kind: "params", params: { kid: 0, part: 0n, kind: 1n } }
			})
			yield* actors.served.perform({ _tag: "Begin" })
			for (const sql of sent) {
				yield* actors.served.perform({ _tag: "Sql", sql })
			}
			const scans = yield* actors.served.perform({
				_tag: "Sql",
				sql: `SELECT coalesce(sum(seq_scan), 0)::text || ' ' || coalesce(sum(idx_scan), 0)::text FROM pg_catalog.pg_stat_xact_user_tables WHERE relid = '${headTable}'::pg_catalog.regclass`
			})
			const [seqScans, indexScans] = Str.split(String(onlyText(scans)), " ")
			yield* actors.served.perform({ _tag: "Commit" })
			const [headRow] = yield* env.observer.queryValues(
				`SELECT __instant::text FROM ${headTable} WHERE ${quoteIdent("kid")} = 0`,
				[]
			)
			const h = BigInt(String(textOfValue(headRow?.[0])))
			const mark = n.table(Mark)
			const cols = `(${n.column(Mark, "kid")}, ${n.column(Mark, "part")}, ${n.column(Mark, "at")}, ${n.column(Mark, "kind")})`
			const stamp = (kid: number) => `${n.stampCall(Mark, "at", [`${kid}`], `${h}`)} AS s`
			const statement = ((): string => {
				switch (c.states) {
					case "below the head":
						return `INSERT INTO ${mark} ${cols} VALUES (0, 1, ${h - 1n}, 9)`
					case "at the head another call stamped":
						return `INSERT INTO ${mark} ${cols} VALUES (0, 1, ${h}, 9)`
					case "above the head, unstamped":
						return `INSERT INTO ${mark} ${cols} VALUES (0, 1, ${h + 1000n}, 9)`
					case "at its own stamp":
						return `INSERT INTO ${mark} ${cols} SELECT 0, 1, s.__instant, 9 FROM ${stamp(0)}`
					case "at its own stamp, at another key":
						return `INSERT INTO ${mark} ${cols} SELECT 1, 1, s.__instant, 9 FROM ${stamp(0)}`
					case "a move off its stamp":
						return `UPDATE ${mark} SET ${n.column(Mark, "at")} = ${n.column(Mark, "at")} + 1 WHERE ${n.column(Mark, "kid")} = 0`
					case "a move to its own stamp":
						return `UPDATE ${mark} SET ${n.column(Mark, "at")} = s.__instant FROM ${stamp(0)} WHERE ${mark}.${n.column(Mark, "kid")} = 0`
				}
			})()
			const direct = actors[c.writer]
			const begun = yield* direct.perform({ _tag: "Begin" })
			const stated = yield* direct.perform({ _tag: "Sql", sql: statement })
			const ended = yield* direct.perform(
				pgFailureOf([begun, stated]) === undefined ? { _tag: "Commit" } : { _tag: "Rollback" }
			)
			const outcomes: ReadonlyArray<ScheduleOutcome> = [begun, stated, ended]
			const marks = yield* env.observer.queryValues(
				`SELECT ${n.column(Mark, "kid")}::text || ' ' || ${n.column(Mark, "part")}::text || ' ' || ${n.column(Mark, "at")}::text FROM ${mark}`,
				[]
			)
			return {
				head: h,
				served: {
					seqScans: BigInt(defined(seqScans, "the head's sequential scans")),
					indexScans: BigInt(defined(indexScans, "the head's index scans"))
				},
				failure: pgFailureOf(outcomes),
				marks: Arr.sort(
					Arr.map(marks, (row) => String(textOfValue(row[0]))),
					(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
				)
			} satisfies DirectRun
		})
	)
