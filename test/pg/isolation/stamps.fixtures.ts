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
import { Array as Arr, Effect, Exit, Fiber, Option, Record as Rec } from "effect"
import type { RoleCertificate } from "#compiler/core/certificate.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { instant, natural, place } from "#compiler/public/fields.ts"
import { query } from "#compiler/public/query.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import {
	callStandUps,
	callStatements,
	certifiedShapeTemplate,
	type Certifier,
	type InstalledShape
} from "#test/pg/isolation/support/race.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { type DirectActor, openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { exploreEnv } from "#test/support/schedules/interleave.ts"
import type { ScheduleOutcome } from "#test/support/schedules/types.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** A child's fact at the database's instant: its clock's child is (child, part). */
const Event = relation("Event", { child: natural, part: natural, at: instant, kind: natural }, [
	"child",
	"part",
	"at"
])

/** A child's numbered fact: its place's group is (child, part). */
const Slot = relation("Slot", { child: natural, part: natural, n: place, v: natural }, [
	"child",
	"part",
	"n"
])

/**
 * The stamp shape under the name `name`: the role `writer`, whose one member `append` adds a child's Event and Slot,
 * the Event stamped by its clock and the Slot by its place, at the child its parameters name, each carrying the call's
 * `kind`.
 */
const stampShape = (name: string) => {
	const relations = { Event, Slot } as const
	const base = schema(name, Rec.values(relations), [])
	const writer = role(base, "writer", relations, { insert: ["Event", "Slot"] })
	const mine = writer.relations
	const append = ChangeSet.empty(writer)
		.insert(
			mine.Event,
			query(writer).rule((r) =>
				r.find({
					child: r.param("child", natural),
					part: r.param("part", natural),
					kind: r.param("kind", natural)
				})
			)
		)
		.insert(
			mine.Slot,
			query(writer).rule((r) =>
				r.find({
					child: r.param("child", natural),
					part: r.param("part", natural),
					v: r.param("kind", natural)
				})
			)
		)
	return {
		schema: base,
		roles: { writer },
		login: login(base, "app", [writer], { workload: [workload(writer, { append })] })
	}
}

/** The certificate a race at `level` states for the writer. */
const certificateAt = (level: Isolation): RoleCertificate =>
	level === "readCommitted"
		? { level }
		: {
				level,
				why: {
					kind: "own",
					reasons: [
						{
							condition: "facts",
							at: { kind: "role" },
							detail: "the race runs the writer SERIALIZABLE"
						}
					]
				}
			}

const atLevel = (level: Isolation): Extract<Certifier, { readonly kind: "stated" }> => ({
	kind: "stated",
	roles: [{ login: "app", role: "writer", certificate: certificateAt(level) }]
})

/** The stamp shape installed once per member with the writer READ COMMITTED (race.ts certifiedShapeTemplate). */
export const readCommittedShape = certifiedShapeTemplate(
	import.meta,
	"stamps read committed",
	stampShape,
	atLevel("readCommitted")
)

/** The stamp shape installed once per member with the writer SERIALIZABLE (race.ts certifiedShapeTemplate). */
export const serializableShape = certifiedShapeTemplate(
	import.meta,
	"stamps serializable",
	stampShape,
	atLevel("serializable")
)

/** One call of a race: the child it appends at, and how its session ends once its stamp is through. */
export interface StampCall {
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

/** A child of the race's two by two box, drawn toward a few children, so calls meet at one child often. */
const callGen: Gen<StampCall> = (s) => ({
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

/** The calls of an aimed race, each at its child, ending as it states. */
const aimedCalls = (
	calls: Arr.NonEmptyReadonlyArray<readonly [number, number, StampCall["ends"]]>
): Arr.NonEmptyReadonlyArray<StampCall> =>
	Arr.map(calls, ([child, part, ends]) => ({ child, part, ends }))

/**
 * A race that reaches every situation but a holder's rollback: three calls at (0, 0), the second begun stamping first
 * and the first waiting on it, both committing, and one at (0, 1) beside them; and one that reaches a holder's
 * rollback: two calls at (0, 0), the second begun stamping first and rolling back, beside one at (1, 0). Each ends in
 * a drawn order.
 */
const aimedRaces: ReadonlyArray<Gen<StampRace>> = [
	(s) => ({
		calls: aimedCalls([
			[0, 0, "commit"],
			[0, 0, "commit"],
			[0, 0, "commit"],
			[0, 1, "commit"]
		]),
		starts: [1, 0, 2, 3],
		ends: s.draw(shuffled([0, 1, 2, 3], { min: 4, max: 4 }))
	}),
	(s) => ({
		calls: aimedCalls([
			[0, 0, "commit"],
			[0, 0, "rollback"],
			[1, 0, "commit"]
		]),
		starts: [1, 0, 2],
		ends: s.draw(shuffled([0, 1, 2], { min: 3, max: 3 }))
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
	| "three calls at one child"
	| "children apart at once"
	| "children sharing a field"
	| "a later-begun call stamped first"
	| "a SERIALIZABLE call refused at an advanced head"

/** A child's text, as the race's rows and messages name it. */
const childText = (c: StampCall): string => `(${c.child}, ${c.part})`

/** Call `i` of a race. */
const callOf = (race: StampRace, i: number): StampCall => defined(race.calls[i], `call ${i}`)

/** The calls a race's call `i` stamps after: those before it in `starts`. */
const holdersOf = (race: StampRace, i: number): ReadonlyArray<number> =>
	Arr.takeWhile(race.starts, (j) => j !== i)

/** Whether two calls append at one child. */
const sameChild = (a: StampCall, b: StampCall): boolean => a.child === b.child && a.part === b.part

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

const levelSql = (level: Isolation): string =>
	`SET TRANSACTION ISOLATION LEVEL ${level === "readCommitted" ? "READ COMMITTED" : "SERIALIZABLE"}`

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

/** What a race shows at one level: each session's run, the order its sessions committed in, the problems the run met on
 * the way, and the rows it left. */
export interface RaceRun {
	readonly runs: ReadonlyArray<Run>
	readonly commits: ReadonlyArray<number>
	readonly problems: ReadonlyArray<string>
	readonly events: ReadonlyArray<Stamped>
	readonly slots: ReadonlyArray<Stamped>
}

/**
 * Runs `race` over `s` at `level` (StampRace): every session begins at `level` and reads its clock; each in `starts`'
 * order sends its call's statements on a fiber of its own, while every session before it holds its transaction open:
 * one whose child an open session before it stamped must wait on a lock (the problem otherwise is that it stamped
 * through), and any other must finish without waiting on one (the problem otherwise is that it waited on a call of
 * another child), each read by polling its backend's lock wait (substrate/barrier.ts lockWaitOf) against its fiber's
 * end. Then each session ends in `ends`' order, the first whose stamp is through, committing where its call drew it and
 * succeeded, a session still waiting taking its turn once the one it waits on ended. The observer reads the rows last.
 */
export const runRace = (s: InstalledShape, race: StampRace, level: Isolation) =>
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
			for (const [i] of sessions.entries()) {
				for (const sql of callStandUps(s, { role: "writer", member: "append" })) {
					yield* actorOf(i).perform({ _tag: "Sql", sql })
				}
			}
			const sent = yield* Effect.forEach(race.calls, (c, i) =>
				callStatements(s, {
					kind: "change",
					session: `s${i}`,
					role: "writer",
					member: "append",
					input: {
						kind: "params",
						params: { child: BigInt(c.child), part: BigInt(c.part), kind: BigInt(i) }
					}
				})
			)
			const clocks: Array<bigint> = []
			for (const [i] of sessions.entries()) {
				yield* actorOf(i).perform({ _tag: "Begin" })
				yield* actorOf(i).perform({ _tag: "Sql", sql: levelSql(level) })
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
				const held = Arr.some(holdersOf(race, i), (j) => sameChild(callOf(race, j), call))
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
								`s${i} stamped ${childText(call)} through (${shown}) while a session before it held the child's stamp`
							)
						}
						break
					}
					const wait = yield* lockWaitOf(env.observer, actorOf(i).pid)
					if (wait !== undefined) {
						if (!held) {
							problems.push(
								`s${i} at ${childText(call)} waited on ${wait.locktype} ${wait.mode}, held by a call of another child`
							)
						}
						break
					}
					yield* Effect.yieldNow
				}
				if (problems.length > 0) {
					return { runs: [], commits: [], problems, events: [], slots: [] }
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
				const exit = defined(
					defined(fibers.get(through), `s${through}'s fiber`).pollUnsafe(),
					"an ended fiber"
				)
				const own = Exit.isSuccess(exit) ? exit.value : []
				outcomes.set(through, own)
				const commit =
					Exit.isSuccess(exit) &&
					failureOf(own) === undefined &&
					callOf(race, through).ends === "commit"
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
				`SELECT ${t.column(Event, "child")}::text, ${t.column(Event, "part")}::text, ${t.column(Event, "at")}::text, ${t.column(Event, "kind")}::text FROM ${t.table(Event)}`
			)
			const slots = yield* rows(
				`SELECT ${t.column(Slot, "child")}::text, ${t.column(Slot, "part")}::text, ${t.column(Slot, "n")}::text, ${t.column(Slot, "v")}::text FROM ${t.table(Slot)}`
			)
			return {
				runs: Arr.map(race.calls, (_, i): Run => ({
					clock: defined(clocks[i], `s${i}'s clock`),
					outcomes: defined(outcomes.get(i), `s${i}'s outcomes`)
				})),
				commits,
				problems,
				events,
				slots
			}
		})
	)

/**
 * What a race's run should have left, by the serial run of its committed calls in the order they committed, each
 * call's stamp at its child the greater of its clock reading and one past the stamp before it there, its place one past
 * the place before it, the first at a child its clock and 0; and each call's own fate at `level`. At READ COMMITTED
 * every call succeeds. At SERIALIZABLE a call whose child a call stamped before it, which then committed, is refused
 * with 40001, a call that stamps after a head its snapshot did not see, and every other call succeeds. The problems are
 * every difference: a refused or a succeeded call against its fate, and each child's events and slots against the
 * model, as sets of (child, stamp, session).
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
			(j) => sameChild(callOf(race, j), call) && Arr.contains(run.commits, j)
		)
		const expected = level === "serializable" && advanced ? "40001" : undefined
		return failure === expected
			? []
			: [
					`s${i} at ${childText(call)}: ${failure ?? "succeeded"}, where ${expected ?? "success"} was due`
				]
	})
	const modelEvents: Array<Stamped> = []
	const modelSlots: Array<Stamped> = []
	const heads = new Map<string, { readonly at: bigint; readonly n: bigint }>()
	for (const i of run.commits) {
		const child = childText(callOf(race, i))
		const head = heads.get(child)
		const clock = defined(run.runs[i], `s${i}'s run`).clock
		const at = head === undefined || clock > head.at + 1n ? clock : head.at + 1n
		const n = head === undefined ? 0n : head.n + 1n
		heads.set(child, { at, n })
		modelEvents.push({ child, stamp: at, session: i })
		modelSlots.push({ child, stamp: n, session: i })
	}
	const text = (rows: ReadonlyArray<Stamped>): ReadonlyArray<string> =>
		Arr.sort(
			Arr.map(rows, (r) => `${r.child} ${r.stamp} s${r.session}`),
			(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
		)
	const compare = (what: string, actual: ReadonlyArray<Stamped>, model: ReadonlyArray<Stamped>) => {
		const [a, m] = [text(actual), text(model)]
		return Arr.join(a, "; ") === Arr.join(m, "; ")
			? []
			: [
					`${what}: ${Arr.join(a, "; ") || "none"}, where the serial run in commit order leaves ${Arr.join(m, "; ") || "none"}`
				]
	}
	return [
		...fates,
		...compare("events", run.events, modelEvents),
		...compare("slots", run.slots, modelSlots)
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
		Arr.filter(holdersOf(race, i), (j) => sameChild(callOf(race, j), callOf(race, i)))
	const waiters = Arr.filter(
		upTo(race.calls.length, (i) => i),
		(i) => holders(i).length > 0
	)
	const pairs = Arr.flatMap(race.calls, (c, i) =>
		Arr.flatMap(race.calls, (d, j) => (i === j ? [] : [[c, d] as const]))
	)
	return [
		...(Arr.some(waiters, (i) => Arr.some(holders(i), committed))
			? ["a waiter whose holder committed" as const]
			: []),
		...(Arr.some(waiters, (i) => Arr.some(holders(i), (j) => callOf(race, j).ends === "rollback"))
			? ["a waiter whose holder rolled back" as const]
			: []),
		...(Arr.some(race.calls, (c) => Arr.filter(race.calls, (d) => sameChild(c, d)).length >= 3)
			? ["three calls at one child" as const]
			: []),
		...(Arr.some(pairs, ([c, d]) => !sameChild(c, d)) ? ["children apart at once" as const] : []),
		...(Arr.some(pairs, ([c, d]) => c.child === d.child && c.part !== d.part)
			? ["children sharing a field" as const]
			: []),
		...(Arr.some(waiters, (i) => Arr.some(holders(i), (j) => j > i && committed(j) && committed(i)))
			? ["a later-begun call stamped first" as const]
			: []),
		...(level === "serializable" && Arr.some(run.runs, (r) => failureOf(r.outcomes) === "40001")
			? ["a SERIALIZABLE call refused at an advanced head" as const]
			: [])
	]
}
