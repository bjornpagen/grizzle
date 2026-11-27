/** What the properties of upkeep.test.ts read: their shapes, their races, and the run of a race against the definitions. */

import { defined } from "@bjornpagen/testing/assert"
import {
	array,
	constant,
	element,
	type Gen,
	oneOf,
	shuffled,
	type Steered,
	subset,
	weighted
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Effect,
	Exit,
	Fiber,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { contract, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, mutable, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import {
	callStandUps,
	callStatements,
	type InstalledShape,
	servedLevel,
	shapeTemplate,
	writeBegin
} from "#test/pg/isolation/support/race.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { type DirectActor, openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { exploreEnv } from "#test/support/schedules/interleave.ts"
import type { ScheduleOutcome } from "#test/support/schedules/types.ts"
import { type LockWait, lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

const learnerIdKey = Symbol("LearnerId")
/** A learner's number, the key of the learner's unit. */
const LearnerId = contract<typeof learnerIdKey>()("LearnerId", pg.integer)

/** A learner's answer to item n of sitting s, in the learner's unit. */
const Answer = relation("Answer", { child: LearnerId, s: natural, n: natural }, ["child", "s", "n"])
/** The key a learner was shown for item n of sitting s, in the learner's unit. */
const Key = relation("Key", { child: LearnerId, s: natural, n: natural }, ["child", "s", "n"])

/**
 * Who calls each member of a shape (upkeepShape): `oneLearner`, the role `learner`, which inserts both relations, both
 * members; or `learnerBesideGrader`, the learner `answer`, inserting Answer alone, and the role `grader` `key`, which
 * states `write` on Key, open in its unit, so it runs SERIALIZABLE by `privileges` whatever it shares with the learner.
 */
export type Cast = "oneLearner" | "learnerBesideGrader"

/** The role that calls `member` under `cast`. */
export const roleOf = (cast: Cast, member: UpkeepCall["member"]): string =>
	cast === "learnerBesideGrader" && member === "key" ? "grader" : "learner"

/**
 * The upkeep shape under `name`, as `cast` calls it: Answer and Key in the unit Learner(child), and three relations
 * derived from them at a level above, each stored (analysis/derived/storage.ts), unit-local in the learner's unit at a
 * unit narrower than it, and none distributive over two writers' rows: `Matched`, the items answered and keyed, a join
 * of the two; `Tally`, each sitting's answers counted; and `Unkeyed`, the answers of no key, a negation. Each member
 * inserts one row, `answer` of Answer and `key` of Key, at the child, sitting and item its parameters name. The level is
 * `<name>_1`, the name an installation under `name` gives the level above its root, so the workload a template serves
 * is compiled against the schema it installs.
 */
const upkeepShape = (cast: Cast) => (name: string) => {
	const base = schema(
		name,
		[Answer, Key],
		[
			unit("Learner", { child: LearnerId }),
			...(cast === "learnerBesideGrader" ? [mutable(Key)] : [])
		]
	)
	const Matched = derived(
		"Matched",
		query(base).rule((r) => {
			const { child, s, n } = v(Answer, "a")
			return r.match(Answer, { child, s, n }).match(Key, { child, s, n }).find({ child, s, n })
		})
	)
	const Tally = derived(
		"Tally",
		query(base).rule((r) => {
			const { child, s, n } = v(Answer, "a")
			return r.match(Answer, { child, s, n }).find({ child, s, answers: r.count() })
		})
	)
	const Unkeyed = derived(
		"Unkeyed",
		query(base).rule((r) => {
			const { child, s, n } = v(Answer, "a")
			return r
				.match(Answer, { child, s, n })
				.where(r.not(Key, { child, s, n }))
				.find({ child, s, n })
		})
	)
	const kept = schema.extend([base], `${name}_1`, [Matched, Tally, Unkeyed], [])
	const stored = { Matched, Tally, Unkeyed }
	if (cast === "oneLearner") {
		const learner = role(kept, "learner", { Answer, Key }, { insert: ["Answer", "Key"] })
		const answer = ChangeSet.empty(learner).insert(
			learner.relations.Answer,
			query(learner).rule((r) =>
				r.find({
					child: r.param("child", LearnerId),
					s: r.param("s", natural),
					n: r.param("n", natural)
				})
			)
		)
		const key = ChangeSet.empty(learner).insert(
			learner.relations.Key,
			query(learner).rule((r) =>
				r.find({
					child: r.param("child", LearnerId),
					s: r.param("s", natural),
					n: r.param("n", natural)
				})
			)
		)
		return {
			schema: kept,
			roles: { learner },
			login: login(kept, "app", [learner], { workload: [workload(learner, { answer, key })] }),
			stored
		}
	}
	const learner = role(kept, "learner", { Answer }, { insert: ["Answer"] })
	const grader = role(kept, "grader", { Key }, { write: ["Key"] })
	const answer = ChangeSet.empty(learner).insert(
		learner.relations.Answer,
		query(learner).rule((r) =>
			r.find({
				child: r.param("child", LearnerId),
				s: r.param("s", natural),
				n: r.param("n", natural)
			})
		)
	)
	const key = ChangeSet.empty(grader).insert(
		grader.relations.Key,
		query(grader).rule((r) =>
			r.find({
				child: r.param("child", LearnerId),
				s: r.param("s", natural),
				n: r.param("n", natural)
			})
		)
	)
	return {
		schema: kept,
		roles: { learner, grader },
		login: login(kept, "app", [learner, grader], {
			workload: [workload(learner, { answer }), workload(grader, { key })]
		}),
		stored
	}
}

/** The stored relations as the race reads their tables. */
const { stored } = upkeepShape("oneLearner")("UpkeepNames")

/**
 * The shape the learner calls both members of, installed once per member as `grizzle generate` drafts and serves it
 * (race.ts shapeTemplate), each role at the level generate certifies it at: the learner READ COMMITTED is the race's
 * premise (`problemsOf`).
 */
export const generatedShape = shapeTemplate(import.meta, "upkeep", upkeepShape("oneLearner"))

/**
 * The shape the learner and the grader call, installed alike: the grader SERIALIZABLE, and the learner at the level
 * certification gives a READ COMMITTED writer whose upkeeps a SERIALIZABLE one shares.
 */
export const mixedShape = shapeTemplate(
	import.meta,
	"upkeep beside a serializable writer",
	upkeepShape("learnerBesideGrader")
)

/** The two children a race writes at, the first drawn more often, so calls meet at one child. */
type Child = 0 | 1

/** An item of sitting 0, the one sitting a race writes, so every answer of a child counts in one Tally row. */
type Item = 0 | 1 | 2

/** A fact of a base relation, at a child and an item of sitting 0. */
interface Fact {
	readonly relation: "Answer" | "Key"
	readonly child: Child
	readonly n: Item
}

/**
 * One call of a race: the member it calls, `answer` or `key`, at its child and item; when its judge runs (`atCommit`,
 * the served write's own, which runs it at COMMIT; or `atStatement`, a direct transaction of the role, admitted on a
 * table every writer of which runs READ COMMITTED, that sends SET CONSTRAINTS ALL IMMEDIATE first, so its judge runs at
 * the end of its statement, inside its transaction); and how its session ends once its statements are through.
 */
export interface UpkeepCall {
	readonly member: "answer" | "key"
	readonly child: Child
	readonly n: Item
	readonly judged: "atCommit" | "atStatement"
	readonly ends: "commit" | "rollback"
}

/**
 * A race: the facts stored before it; then two or three calls, the i-th in session s_i, every session begun in index
 * order; each call's statements sent in `starts`' order, each while every call before it holds its transaction open;
 * then the sessions ended in `ends`' order, each once its statements are through, a session waiting on another taking
 * its turn once that one ended: `inTurn`, one session's end sent once the one before it is through or waits on a lock;
 * or `together`, the ends of every session whose statements are through sent at once, so served calls' COMMITs, and
 * the judges each runs, overlap.
 */
export interface UpkeepRace {
	readonly facts: ReadonlyArray<Fact>
	readonly calls: Arr.NonEmptyReadonlyArray<UpkeepCall>
	readonly starts: ReadonlyArray<number>
	readonly ends: ReadonlyArray<number>
	readonly ending: "inTurn" | "together"
}

/** The facts a race may store first: any of each child's answers and keys at sitting 0. */
const factBox: ReadonlyArray<Fact> = Arr.flatMap([0, 1] as const, (child) =>
	Arr.flatMap([0, 1, 2] as const, (n) => [
		{ relation: "Answer" as const, child, n },
		{ relation: "Key" as const, child, n }
	])
)

const callGen: Gen<UpkeepCall> = (s) => ({
	member: s.draw(element(["answer", "key"] as const)),
	child: s.draw(
		weighted([
			[3, constant<Child>(0)],
			[1, constant<Child>(1)]
		])
	),
	n: s.draw(element([0, 1, 2] as const)),
	judged: s.draw(element(["atCommit", "atStatement"] as const)),
	ends: s.draw(
		weighted([
			[4, constant<UpkeepCall["ends"]>("commit")],
			[1, constant<UpkeepCall["ends"]>("rollback")]
		])
	)
})

/** The orders of `n` calls: a drawn order of their starts and one of their ends, and how their ends are sent. */
const ordersOf = (n: number): Gen<Pick<UpkeepRace, "starts" | "ends" | "ending">> => {
	const order = upTo(n, (i) => i)
	const all = { min: order.length, max: order.length }
	return (s) => ({
		starts: s.draw(shuffled(order, all)),
		ends: s.draw(shuffled(order, all)),
		ending: s.draw(element(["inTurn", "together"] as const))
	})
}

const upkeepRaces: Gen<UpkeepRace> = (s) => {
	const calls = nonEmptyList(s.draw(array(callGen, { min: 2, max: 3 })), "a race's calls")
	return {
		facts: s.draw(subset(factBox, { min: 0, max: 4 })),
		calls,
		...s.draw(ordersOf(calls.length))
	}
}

/**
 * The races that reach what a drawn one seldom does: an answer and its key at child 0, both judged at their statements
 * and committed, beside a call at child 1; two answers of child 0 at once, one judged at its statement, beside a stored
 * answer, and a key beside them rolled back; and an answer, its key and another answer at child 0, each a served
 * write's, ended together. Each orders its starts, and the first two their ends, as drawn.
 */
const aimedRaces: ReadonlyArray<Gen<UpkeepRace>> = [
	(s) => ({
		facts: [],
		calls: [
			{ member: "answer", child: 0, n: 1, judged: "atStatement", ends: "commit" },
			{ member: "key", child: 0, n: 1, judged: "atStatement", ends: "commit" },
			{ member: "answer", child: 1, n: 1, judged: "atCommit", ends: "commit" }
		],
		...s.draw(ordersOf(3))
	}),
	(s) => ({
		facts: [{ relation: "Answer", child: 0, n: 0 }],
		calls: [
			{ member: "answer", child: 0, n: 1, judged: "atStatement", ends: "commit" },
			{ member: "answer", child: 0, n: 2, judged: "atCommit", ends: "commit" },
			{ member: "key", child: 0, n: 1, judged: "atStatement", ends: "rollback" }
		],
		...s.draw(ordersOf(3))
	}),
	(s) => ({
		facts: [{ relation: "Answer", child: 0, n: 0 }],
		calls: [
			{ member: "answer", child: 0, n: 1, judged: "atCommit", ends: "commit" },
			{ member: "key", child: 0, n: 1, judged: "atCommit", ends: "commit" },
			{ member: "answer", child: 0, n: 2, judged: "atCommit", ends: "commit" }
		],
		...s.draw(ordersOf(3)),
		ending: "together"
	})
]

/**
 * The race the mixed shape seldom draws: an answer and its key at child 0, a served write's each, the answer ended
 * first, beside a call at child 1, its ends in turn; and the same ended together.
 */
const mixedRaces: ReadonlyArray<Gen<UpkeepRace>> = [
	(s) => ({
		facts: [],
		calls: [
			{ member: "answer", child: 0, n: 1, judged: "atCommit", ends: "commit" },
			{ member: "key", child: 0, n: 1, judged: "atCommit", ends: "commit" },
			{ member: "key", child: 1, n: 0, judged: "atStatement", ends: "commit" }
		],
		starts: s.draw(shuffled([0, 1, 2], { min: 3, max: 3 })),
		ends: [0, 1, 2],
		ending: s.draw(element(["inTurn", "together"] as const))
	})
]

/** The race a mixed case runs, drawn under its steering, as `aimedUpkeepRaces` draws. */
export const aimedMixedRaces: Steered<UpkeepRace, UpkeepFeature>["under"] = (steering) =>
	Option.isSome(steering) ? oneOf([upkeepRaces, ...mixedRaces]) : upkeepRaces

/**
 * The race a case runs, drawn under its steering: while a situation is pending, an aimed race or a drawn one, each
 * alike; otherwise a drawn one, as a rotating case always is.
 */
export const aimedUpkeepRaces: Steered<UpkeepRace, UpkeepFeature>["under"] = (steering) =>
	Option.isSome(steering) ? oneOf([upkeepRaces, ...aimedRaces]) : upkeepRaces

export type UpkeepFeature =
	| "an answer and its key committed by two calls at once"
	| "two answers of one sitting committed by two calls at once"
	| "a call judged at its statement"
	| "a call judged at its COMMIT"
	| "served calls of one child ended together"
	| "children apart at once"
	| "a call rolled back"
	| "a call's judge waited on another call at its child"
	| "an answer and its key called at once"
	| "a call refused with 40001"

/** Call `i` of a race. */
const callOf = (race: UpkeepRace, i: number): UpkeepCall => defined(race.calls[i], `call ${i}`)

/** What a session's actions showed: the SQLSTATE of the first that failed, none where all succeeded. */
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

/** A lock wait one of a race's sessions met: the session, and the sessions it waited on, by their calls. */
interface Waited {
	readonly session: number
	readonly wait: LockWait
	readonly on: ReadonlyArray<number>
}

/** What a race shows: each session's outcomes, its statements' then its end's, the waits its sessions met, and the
 * rows the observer read last. */
export interface RaceRun {
	readonly outcomes: ReadonlyArray<ReadonlyArray<ScheduleOutcome>>
	readonly commits: ReadonlyArray<number>
	readonly waits: ReadonlyArray<Waited>
	readonly rows: Readonly<Record<RowsOf, ReadonlyArray<string>>>
}

/** The relations whose rows the observer reads once the race ends: the base relations and the stored ones. */
type RowsOf = "Answer" | "Key" | "Matched" | "Tally" | "Unkeyed"

/**
 * Runs `race` over `s`, called as `cast` says (UpkeepRace): the race's facts stored first, as the owner; every session
 * logs in as its call's role, stands up its judge's tables and begins as the role's served write begins, at the level
 * generate certifies it at (race.ts writeBegin), a session judged at its statements sending
 * SET CONSTRAINTS ALL IMMEDIATE first; each in `starts`' order sends its call's statements on a fiber of its own while
 * every session before it holds its transaction open, and each session ends in `ends`' order, the first whose
 * statements are through, committing where its call drew it and its statements succeeded, on a fiber of its own too,
 * since a COMMIT runs the judge. Each statement and each end is watched until it is through or waits on a lock, by
 * polling its backend's lock wait (substrate/barrier.ts lockWaitOf) against its fiber's end, and every wait is recorded
 * with the sessions it waits on. The observer reads every relation's rows last.
 */
export const runRace = (s: InstalledShape, cast: Cast, race: UpkeepRace) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const env = yield* exploreEnv(substrate)
			const facts = (relation: Fact["relation"]) =>
				Arr.flatMap(race.facts, (f) =>
					f.relation === relation ? [{ child: f.child, s: 0n, n: BigInt(f.n) }] : []
				)
			yield* Effect.provideService(
				loadMigrated(s.installed, { Answer: facts("Answer"), Key: facts("Key") }),
				Substrate,
				substrate
			)
			const sessions = Arr.map(race.calls, (_, i) => `s${i}`)
			const actors = yield* openActors(
				substrate,
				Rec.fromEntries(
					Arr.map(race.calls, (call, i) => {
						const by = roleOf(cast, call.member)
						const world = s.installed.world(defined(s.shape.roles[by], `the role ${by}`))
						return [`s${i}`, { kind: "raw" as const, as: world }] as const
					})
				)
			)
			const actorOf = (i: number): DirectActor => defined(actors[`s${i}`], `session s${i}`)
			const sessionOf = new Map(Arr.map(sessions, (_, i) => [actorOf(i).pid, i] as const))
			for (const [i, call] of race.calls.entries()) {
				for (const sql of callStandUps(s, {
					role: roleOf(cast, call.member),
					member: call.member
				})) {
					yield* actorOf(i).perform({ _tag: "Sql", sql })
				}
			}
			const sent = yield* Effect.forEach(race.calls, (c, i) =>
				callStatements(s, {
					kind: "change",
					session: `s${i}`,
					role: roleOf(cast, c.member),
					member: c.member,
					input: { kind: "params", params: { child: c.child, s: 0n, n: BigInt(c.n) } }
				})
			)
			for (const [i, call] of race.calls.entries()) {
				yield* actorOf(i).perform(writeBegin(s, roleOf(cast, call.member)))
				if (call.judged === "atStatement") {
					yield* actorOf(i).perform({ _tag: "Sql", sql: "SET CONSTRAINTS ALL IMMEDIATE" })
				}
			}
			const waits: Array<Waited> = []
			/** Polls session `i`'s backend until `fiber` is through or the backend waits on a lock, which it records. */
			const watch = <A>(i: number, fiber: Fiber.Fiber<A>) =>
				Effect.gen(function* () {
					for (;;) {
						if (fiber.pollUnsafe() !== undefined) {
							return
						}
						const wait = yield* lockWaitOf(env.observer, actorOf(i).pid)
						if (wait !== undefined) {
							waits.push({
								session: i,
								wait,
								on: Arr.flatMap(wait.blockedBy, (pid) => {
									const at = sessionOf.get(pid)
									return at === undefined ? [-1] : [at]
								})
							})
							return
						}
						yield* Effect.yieldNow
					}
				})
			const send = (i: number) =>
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
			const statements = new Map<number, Fiber.Fiber<ReadonlyArray<ScheduleOutcome>>>()
			for (const i of race.starts) {
				const fiber = yield* Effect.forkChild(send(i))
				statements.set(i, fiber)
				yield* watch(i, fiber)
			}
			const through = (i: number): ReadonlyArray<ScheduleOutcome> | undefined => {
				const exit = defined(statements.get(i), `s${i}'s statements`).pollUnsafe()
				return exit === undefined ? undefined : Exit.isSuccess(exit) ? exit.value : []
			}
			const ending = new Map<number, Fiber.Fiber<ScheduleOutcome>>()
			const committing = new Set<number>()
			const end = (i: number) =>
				Effect.gen(function* () {
					const commit =
						failureOf(defined(through(i), `s${i}'s outcomes`)) === undefined &&
						callOf(race, i).ends === "commit"
					if (commit) {
						committing.add(i)
					}
					const fiber = yield* Effect.forkChild(
						actorOf(i).perform(commit ? { _tag: "Commit" } : { _tag: "Rollback" })
					)
					ending.set(i, fiber)
					return fiber
				})
			while (ending.size < race.calls.length) {
				const ready = Arr.filter(race.ends, (i) => !ending.has(i) && through(i) !== undefined)
				const [first] = ready
				if (first === undefined) {
					yield* Effect.raceAll([
						...Arr.flatMap(race.ends, (i) => {
							const fiber = defined(statements.get(i), `s${i}'s statements`)
							return ending.has(i) || fiber.pollUnsafe() !== undefined
								? []
								: [Effect.asVoid(Fiber.await(fiber))]
						}),
						...Arr.flatMap([...ending.values()], (f) =>
							f.pollUnsafe() === undefined ? [Effect.asVoid(Fiber.await(f))] : []
						)
					])
					continue
				}
				const batch = race.ending === "together" ? ready : [first]
				const fibers = yield* Effect.forEach(batch, end)
				for (const [at, fiber] of fibers.entries()) {
					yield* watch(defined(batch[at], "a session of the batch"), fiber)
				}
			}
			const outcomes = yield* Effect.forEach(race.calls, (_, i) =>
				Effect.gen(function* () {
					const own = defined(through(i), `s${i}'s outcomes`)
					const ended = yield* Fiber.join(defined(ending.get(i), `s${i}'s end`))
					return [...own, ended]
				})
			)
			const commits = Arr.filter([...committing], (i) => {
				const ended = defined(outcomes[i], `s${i}'s outcomes`).at(-1)
				return ended?._tag === "Ok"
			})
			const t = s.names
			/** Every row of `table`, each its columns' texts joined by colons, in text order. */
			const rowsOf = (table: string, columns: ReadonlyArray<string>) =>
				Effect.map(
					env.observer.queryValues(
						`SELECT ${Arr.join(
							Arr.map(columns, (c) => `${c}::text`),
							", "
						)} FROM ${table}`,
						[]
					),
					(found) =>
						Arr.sort(
							Arr.map(found, (row) =>
								Arr.join(
									Arr.map(row, (x) => String(textOfValue(x))),
									":"
								)
							),
							Order.String
						)
				)
			const items = (of: typeof Answer | typeof Key) =>
				rowsOf(t.table(of), [t.column(of, "child"), t.column(of, "s"), t.column(of, "n")])
			const { Matched, Tally, Unkeyed } = stored
			return {
				outcomes,
				commits,
				waits,
				rows: {
					Answer: yield* items(Answer),
					Key: yield* items(Key),
					Matched: yield* rowsOf(t.table(Matched), [
						t.column(Matched, "child"),
						t.column(Matched, "s"),
						t.column(Matched, "n")
					]),
					Unkeyed: yield* rowsOf(t.table(Unkeyed), [
						t.column(Unkeyed, "child"),
						t.column(Unkeyed, "s"),
						t.column(Unkeyed, "n")
					]),
					Tally: yield* rowsOf(t.table(Tally), [
						t.column(Tally, "child"),
						t.column(Tally, "s"),
						t.column(Tally, "answers")
					])
				}
			}
		})
	)

/**
 * The stored relations' rows their definitions give over the committed base rows `answers` and `keys`, each a row's
 * `child:s:n` text: Matched, the items in both; Unkeyed, the answers no key holds; Tally, each sitting's answers
 * counted, `child:s:count`.
 */
const definitionsOver = (
	answers: ReadonlyArray<string>,
	keys: ReadonlyArray<string>
): Readonly<Record<"Matched" | "Tally" | "Unkeyed", ReadonlyArray<string>>> => {
	const keyed = new Set(keys)
	const tallies = new Map<string, number>()
	for (const a of answers) {
		const sitting = Arr.join(Arr.take(Str.split(a, ":"), 2), ":")
		tallies.set(sitting, (tallies.get(sitting) ?? 0) + 1)
	}
	return {
		Matched: Arr.filter(answers, (a) => keyed.has(a)),
		Unkeyed: Arr.filter(answers, (a) => !keyed.has(a)),
		Tally: Arr.sort(
			Arr.map([...tallies], ([sitting, count]) => `${sitting}:${count}`),
			Order.String
		)
	}
}

/**
 * Every difference between what a race's run left and what it should have, called as `cast` says: under `oneLearner`,
 * the learner's premise, that generate certifies it READ COMMITTED; each call's fate, its statements and its end, every
 * call succeeding at READ COMMITTED, and at SERIALIZABLE succeeding or refused with 40001, a serialization failure;
 * each stored relation's rows against its definition's over the base rows the race left, whatever order its calls
 * committed in; and each wait, which only a call of the same child may cause.
 */
export const problemsOf = (
	s: InstalledShape,
	cast: Cast,
	race: UpkeepRace,
	run: RaceRun
): ReadonlyArray<string> => {
	const premise =
		cast === "learnerBesideGrader" || servedLevel(s, "learner") === "readCommitted"
			? []
			: [`generate certifies the learner ${servedLevel(s, "learner")}, not READ COMMITTED`]
	const fates = Arr.flatMap(race.calls, (call, i) => {
		const outcomes = defined(run.outcomes[i], `s${i}'s outcomes`)
		const failure = failureOf(outcomes)
		const said = Arr.flatMap(outcomes, (o) => (o._tag === "PgError" ? [o.fields.message] : []))
		const level = servedLevel(s, roleOf(cast, call.member))
		return failure === undefined || (level === "serializable" && failure === "40001")
			? []
			: [
					`s${i}, ${call.member} at child ${call.child} item ${call.n} judged ${call.judged} at ${level}: ${failure} (${Arr.join(said, "; ")}), where success was due`
				]
	})
	const model = definitionsOver(run.rows.Answer, run.rows.Key)
	const stores = Arr.flatMap(["Matched", "Tally", "Unkeyed"] as const, (relation) => {
		const [kept, due] = [Arr.join(run.rows[relation], " "), Arr.join(model[relation], " ")]
		return kept === due
			? []
			: [
					`${relation} holds ${kept || "nothing"}, where its definition over the committed answers (${Arr.join(run.rows.Answer, " ") || "none"}) and keys (${Arr.join(run.rows.Key, " ") || "none"}) gives ${due || "nothing"}`
				]
	})
	const waits = Arr.flatMap(run.waits, (w) => {
		const child = callOf(race, w.session).child
		return Arr.every(w.on, (j) => j >= 0 && callOf(race, j).child === child)
			? []
			: [
					`s${w.session} at child ${child} waited on ${w.wait.locktype} ${w.wait.mode}, held by ${Arr.join(
						Arr.map(w.on, (j) =>
							j < 0 ? "a session outside the race" : `s${j} at child ${callOf(race, j).child}`
						),
						", "
					)}`
				]
	})
	return [...premise, ...fates, ...stores, ...waits]
}

/** The features a race reached, by its run. */
export const featuresOf = (race: UpkeepRace, run: RaceRun): ReadonlyArray<UpkeepFeature> => {
	const committed = Arr.map(run.commits, (i) => callOf(race, i))
	const pairs = Arr.flatMap(committed, (c, i) =>
		Arr.flatMap(committed, (d, j) => (i < j ? [[c, d] as const] : []))
	)
	return [
		...(Arr.some(pairs, ([c, d]) => c.child === d.child && c.n === d.n && c.member !== d.member)
			? ["an answer and its key committed by two calls at once" as const]
			: []),
		...(Arr.some(
			pairs,
			([c, d]) =>
				c.child === d.child && c.n !== d.n && c.member === "answer" && d.member === "answer"
		)
			? ["two answers of one sitting committed by two calls at once" as const]
			: []),
		...(Arr.some(race.calls, (c) => c.judged === "atStatement")
			? ["a call judged at its statement" as const]
			: []),
		...(Arr.some(race.calls, (c) => c.judged === "atCommit")
			? ["a call judged at its COMMIT" as const]
			: []),
		...(race.ending === "together" &&
		Arr.some(
			pairs,
			([c, d]) => c.child === d.child && c.judged === "atCommit" && d.judged === "atCommit"
		)
			? ["served calls of one child ended together" as const]
			: []),
		...(Arr.some(race.calls, (c) => c.child !== race.calls[0].child)
			? ["children apart at once" as const]
			: []),
		...(Arr.some(race.calls, (c) => c.ends === "rollback") ? ["a call rolled back" as const] : []),
		...(Arr.some(run.waits, (w) => w.wait.locktype === "advisory")
			? ["a call's judge waited on another call at its child" as const]
			: []),
		...(Arr.some(race.calls, (c, i) =>
			Arr.some(
				race.calls,
				(d, j) => i < j && c.child === d.child && c.n === d.n && c.member !== d.member
			)
		)
			? ["an answer and its key called at once" as const]
			: []),
		...(Arr.some(run.outcomes, (o) => failureOf(o) === "40001")
			? ["a call refused with 40001" as const]
			: [])
	]
}
