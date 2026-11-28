/** What the property of skew.test.ts reads: its shapes, its box of races, and a race's run through the serial reference. */

import { defined } from "@bjornpagen/testing/assert"
import { type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { natural, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type AnyRelation,
	contained,
	login,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import type { RelationFieldsOf } from "#compiler/types/schema/relation.ts"
import {
	callStatements,
	type InstalledShape,
	type Shape,
	shapeTemplate,
	writeBegin
} from "#test/pg/isolation/support/race.ts"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import type { Names } from "#test/support/kernel/naming.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import { openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { every, everyRelation, exploreEnv } from "#test/support/schedules/interleave.ts"
import { type Explained, type RaceTxn, runSerialRace } from "#test/support/schedules/serial.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Booked = relation("Booked", { room: int4, who: int4 }, ["room", "who"])
const Blocked = relation("Blocked", { room: int4, who: int4 }, ["room", "who"])

/**
 * The exclusion shape under the name `name`: a room is booked by whoever books it while no one blocked it, and blocked by
 * whoever blocks it while no one booked it, the role `desk`'s two members `book` and `block`, each an insert of its row
 * at the room and the caller its parameters name where a negation finds the other relation's rows at the room absent.
 * Generate certifies the desk SERIALIZABLE by `absence`, each member reading the absence of a relation the role writes,
 * and by `pivot`, that read binding no whole declared key.
 */
const exclusionShape = (name: string): Shape => {
	const base = schema(name, [Booked, Blocked], [])
	const desk = role(base, "desk", { Booked, Blocked }, { insert: ["Booked", "Blocked"] })
	const mine = desk.relations
	const book = ChangeSet.empty(desk).insert(
		mine.Booked,
		query(desk).rule((r) =>
			r
				.where(r.not(mine.Blocked, { room: r.param("room", int4) }))
				.find({ room: r.param("room", int4), who: r.param("who", int4) })
		)
	)
	const block = ChangeSet.empty(desk).insert(
		mine.Blocked,
		query(desk).rule((r) =>
			r
				.where(r.not(mine.Booked, { room: r.param("room", int4) }))
				.find({ room: r.param("room", int4), who: r.param("who", int4) })
		)
	)
	return {
		schema: base,
		roles: { desk },
		login: login(base, "app", [desk], { workload: [workload(desk, { book, block })] })
	}
}

const Doc = relation("Doc", { node: int4 }, ["node"])
const Pool = relation("Pool", { doc: int4, pool: int4 }, ["doc", "pool"])
const Sitting = relation("Sitting", { id: int4, doc: int4, pools: natural }, ["id"])
const Served = relation("Served", { sitting: int4, doc: int4, pool: int4 }, ["sitting", "pool"])

/**
 * The sitting shape under the name `name`, QTI's learner in small, its importer's extension and its learner's start one
 * role, `learner`: `extend` adds a Pool to a stored Doc, and `start` begins a Sitting of a Doc holding the count of its
 * Pools, then serves the Sitting each Pool of its Doc in a later statement. Generate certifies the learner SERIALIZABLE by
 * `snapshot`, the start reading Pool in two statements, by `absence`, its count of a relation the role writes, and by
 * `pivot`, those reads binding no whole declared key.
 */
const sittingShape = (name: string): Shape => {
	const relations = { Doc, Pool, Sitting, Served } as const
	const base = schema(name, Rec.values(relations), [
		contained(on(Pool, "doc"), on(Doc, "node")),
		contained(on(Sitting, "doc"), on(Doc, "node")),
		contained(on(Served, "sitting", "doc"), on(Sitting, "id", "doc")),
		contained(on(Served, "doc", "pool"), on(Pool, "doc", "pool"))
	])
	const learner = role(base, "learner", relations, { insert: ["Pool", "Sitting", "Served"] })
	const mine = learner.relations
	const extend = ChangeSet.empty(learner).insert(
		mine.Pool,
		query(learner).rule((r) =>
			r
				.match(mine.Doc, { node: r.param("doc", int4) })
				.find({ doc: r.param("doc", int4), pool: r.param("pool", int4) })
		)
	)
	const counted = query(learner).rule((r) => {
		const { pool } = v(mine.Pool, "pool")
		return r.match(mine.Pool, { doc: r.param("doc", int4), pool }).find({ pools: r.count() })
	})
	const start = ChangeSet.sequence(
		ChangeSet.empty(learner).insert(
			mine.Sitting,
			query(learner).rule((r) => {
				const count = counted.bind({ doc: r.param("doc", int4) })
				const { pools } = v(count, "count")
				return r
					.match(mine.Doc, { node: r.param("doc", int4) })
					.match(count, { pools })
					.find({ id: r.param("id", int4), doc: r.param("doc", int4), pools })
			})
		),
		ChangeSet.empty(learner).insert(
			mine.Served,
			query(learner).rule((r) => {
				const { id, doc } = v(mine.Sitting, "sitting")
				const { pool } = v(mine.Pool, "pool")
				return r
					.match(mine.Sitting, { id, doc })
					.match(mine.Pool, { doc, pool })
					.where(r.eq(id, r.param("id", int4)))
					.find({ sitting: id, doc, pool })
			})
		)
	)
	return {
		schema: base,
		roles: { learner },
		login: login(base, "app", [learner], { workload: [workload(learner, { extend, start })] })
	}
}

const Came = relation("Came", { who: int4 }, ["who"])
const Met = relation("Met", { who: int4, friend: int4 }, ["who", "friend"])

/**
 * The meeting shape under the name `name`: the role `visitor`'s one member `arrive` records that its caller came, and that
 * it met its friend where its friend came already, a point read of Came at its key beside the insert of the caller's own.
 * Generate certifies the visitor SERIALIZABLE by `pivot` alone: the row of Came it writes is not joined with its
 * statement's read of Came.
 */
const meetingShape = (name: string): Shape => {
	const base = schema(name, [Came, Met], [])
	const visitor = role(base, "visitor", { Came, Met }, { insert: ["Came", "Met"] })
	const mine = visitor.relations
	const arrive = ChangeSet.empty(visitor)
		.insert(
			mine.Came,
			query(visitor).rule((r) => r.find({ who: r.param("who", int4) }))
		)
		.insert(
			mine.Met,
			query(visitor).rule((r) =>
				r
					.match(mine.Came, { who: r.param("friend", int4) })
					.find({ who: r.param("who", int4), friend: r.param("friend", int4) })
			)
		)
	return {
		schema: base,
		roles: { visitor },
		login: login(base, "app", [visitor], { workload: [workload(visitor, { arrive })] })
	}
}

/** The exclusion shape installed once per member as `grizzle generate` drafts and serves it (race.ts shapeTemplate). */
export const exclusionTemplate = shapeTemplate(import.meta, "exclusion", exclusionShape)

/** The sitting shape installed once per member as `grizzle generate` drafts and serves it. */
export const sittingTemplate = shapeTemplate(import.meta, "sitting", sittingShape)

/** The meeting shape installed once per member as `grizzle generate` drafts and serves it. */
export const meetingTemplate = shapeTemplate(import.meta, "meeting", meetingShape)

/** A call of the exclusion shape: a booking or a block of a room, by the caller its session names. */
interface Claim {
	readonly member: "book" | "block"
	readonly room: number
}

/** A call of the sitting shape: a Pool added to a Doc, or a Sitting started on one, at the key its session names. */
interface Step {
	readonly member: "extend" | "start"
	readonly doc: number
}

/**
 * A race of two calls of one shape, each in a session of its own, from a stored state: the exclusion shape's two claims
 * from no row, the first at room 1; the sitting shape's two steps over Docs 1 and 2, each with a Pool 0, the first at
 * Doc 1; or the meeting shape's arrivals of callers 1 and 2, each awaiting the other or caller 3, who has come already
 * where `came` says so.
 */
type SkewRace =
	| { readonly kind: "exclusion"; readonly calls: readonly [Claim, Claim] }
	| { readonly kind: "sitting"; readonly calls: readonly [Step, Step] }
	| {
			readonly kind: "meeting"
			readonly came: boolean
			readonly friends: readonly [number, number]
	  }

/** Whether `n`, drawn as 0 or 1, is the first. */
const first = (n: number): boolean => n === 0

const claims: Gen<SkewRace> = (s) => {
	const claim = (room: number): Claim => ({
		member: first(s.draw(int(0, 1))) ? "book" : "block",
		room
	})
	const a = claim(1)
	return { kind: "exclusion", calls: [a, claim(s.draw(int(1, 2)))] }
}

const steps: Gen<SkewRace> = (s) => {
	const step = (doc: number): Step => ({
		member: first(s.draw(int(0, 1))) ? "extend" : "start",
		doc
	})
	const a = step(1)
	return { kind: "sitting", calls: [a, step(s.draw(int(1, 2)))] }
}

const arrivals: Gen<SkewRace> = (s) => ({
	kind: "meeting",
	came: first(s.draw(int(0, 1))),
	friends: [first(s.draw(int(0, 1))) ? 2 : 3, first(s.draw(int(0, 1))) ? 1 : 3]
})

/**
 * The box, exhausted: each shape's races, the exclusion shape's two members of each claim and the second claim's room,
 * the sitting shape's two members of each step and the second step's Doc, and the meeting shape's caller 3 come or not
 * and each arrival's friend.
 */
export const skewRaces: Gen<SkewRace> = oneOf([claims, steps, arrivals])

/** A call as the race sends it: its member and its parameters. */
interface Sent {
	readonly member: string
	readonly params: ParamMap
}

/**
 * The read of a relation's rows the serial reference compares, each row its relation's name and its fields' values in
 * text, so every row of a shape's relations is distinct.
 */
const rowsOf =
	<R extends AnyRelation>(
		relation: R,
		fields: Arr.NonEmptyReadonlyArray<keyof RelationFieldsOf<R> & string>
	) =>
	(names: Names): string =>
		`SELECT '${relation.name}'::text, ${Arr.join(
			Arr.map(fields, (f) => `${names.column(relation, f)}::text`),
			` || ',' || `
		)} FROM ${names.table(relation)}`

/**
 * A race as its shape runs it: the role whose calls race, the stored state, each session's call, and the read of each
 * relation's rows.
 */
interface Planned {
	readonly role: string
	readonly stored: FactSet
	readonly calls: readonly [Sent, Sent]
	readonly rows: Arr.NonEmptyReadonlyArray<(names: Names) => string>
}

/** The caller of session `i`, its `who`, a Sitting's id or a Pool's number: one past its place, so no two keys meet. */
const callerOf = (i: number): number => i + 1

const plannedOf = (race: SkewRace): Planned => {
	switch (race.kind) {
		case "exclusion":
			return {
				role: "desk",
				stored: {},
				calls: [
					{ member: race.calls[0].member, params: { room: race.calls[0].room, who: callerOf(0) } },
					{ member: race.calls[1].member, params: { room: race.calls[1].room, who: callerOf(1) } }
				],
				rows: [rowsOf(Booked, ["room", "who"]), rowsOf(Blocked, ["room", "who"])]
			}
		case "sitting": {
			const sent = (step: Step, i: number): Sent =>
				step.member === "extend"
					? { member: "extend", params: { doc: step.doc, pool: callerOf(i) } }
					: { member: "start", params: { id: callerOf(i), doc: step.doc } }
			return {
				role: "learner",
				stored: {
					Doc: [{ node: 1 }, { node: 2 }],
					Pool: [
						{ doc: 1, pool: 0 },
						{ doc: 2, pool: 0 }
					]
				},
				calls: [sent(race.calls[0], 0), sent(race.calls[1], 1)],
				rows: [
					rowsOf(Pool, ["doc", "pool"]),
					rowsOf(Sitting, ["id", "doc", "pools"]),
					rowsOf(Served, ["sitting", "doc", "pool"])
				]
			}
		}
		case "meeting":
			return {
				role: "visitor",
				stored: race.came ? { Came: [{ who: 3 }] } : {},
				calls: [
					{ member: "arrive", params: { who: callerOf(0), friend: race.friends[0] } },
					{ member: "arrive", params: { who: callerOf(1), friend: race.friends[1] } }
				],
				rows: [rowsOf(Came, ["who"]), rowsOf(Met, ["who", "friend"])]
			}
	}
}

export type SkewFeature =
	| "a booking and a block of one room at once"
	| "a Pool added to the Doc a Sitting starts on"
	| "two arrivals each awaiting the other"
	| "a call refused by a serialization failure"

/** What a race reaches by its calls alone: the overlap no serial order explains at READ COMMITTED. */
export const raceFeatures = (race: SkewRace): ReadonlyArray<SkewFeature> => {
	switch (race.kind) {
		case "exclusion":
			return race.calls[0].member !== race.calls[1].member &&
				race.calls[0].room === race.calls[1].room
				? ["a booking and a block of one room at once"]
				: []
		case "sitting":
			return race.calls[0].member !== race.calls[1].member &&
				race.calls[0].doc === race.calls[1].doc
				? ["a Pool added to the Doc a Sitting starts on"]
				: []
		case "meeting":
			return race.friends[0] === callerOf(1) && race.friends[1] === callerOf(0)
				? ["two arrivals each awaiting the other"]
				: []
	}
}

/** What a run the serial reference explained reached: a call PostgreSQL refused with 40001. */
const runFeatures = <A>(explained: Explained<A>): ReadonlyArray<SkewFeature> =>
	Arr.some([...explained.ends.values()], (end) => end.kind === "aborted" && end.code === "40001")
		? ["a call refused by a serialization failure"]
		: []

/**
 * Runs `race` over `s`, its shape's installation, through the one concurrency driver and its serial reference
 * (schedules/serial.ts runSerialRace): each of its two calls a direct transaction of a session of its own, logged in as
 * the role's world, its write's stand-ups run first, begun as the role's served writes begin, at the level generate
 * certifies it at (race.ts writeBegin), its statements as the served write's one flight sends them (race.ts
 * callStatements), then committed; every interleaving of the two, each from the stored state, judged by the calls run
 * alone in an order that respects real time, which must show each call's every statement's answer and leave every
 * relation's rows as the run did. `note` sees what each explained run reached.
 */
export const runSkew = (s: InstalledShape, race: SkewRace, note: (f: SkewFeature) => void) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const planned = plannedOf(race)
			const world = s.installed.world(defined(s.shape.roles[planned.role], planned.role))
			const actors = yield* openActors(substrate, {
				s0: { kind: "raw", as: world },
				s1: { kind: "raw", as: world }
			})
			const env = yield* exploreEnv(substrate)
			const txnOf = (call: Sent, session: "s0" | "s1") =>
				Effect.gen(function* () {
					const statements = yield* callStatements(s, {
						kind: "change",
						session,
						role: planned.role,
						member: call.member,
						input: { kind: "params", params: call.params }
					})
					const txn: RaceTxn<never> = {
						kind: "direct",
						session,
						begin: writeBegin(s, planned.role),
						statements: Arr.map(statements, (sql) => ({ sql, footprint: everyRelation })),
						end: "commit"
					}
					return txn
				})
			const txns = [
				yield* txnOf(planned.calls[0], "s0"),
				yield* txnOf(planned.calls[1], "s1")
			] as const
			const state = Arr.join(
				Arr.map(planned.rows, (rows) => rows(s.names)),
				" UNION ALL "
			)
			yield* runSerialRace(
				env,
				{ direct: actors, grizzle: {} },
				{
					name: `${race.kind}: ${planned.calls[0].member} beside ${planned.calls[1].member}`,
					txns,
					reset: Effect.provideService(
						replaceMigrated(s.installed, planned.stored),
						Substrate,
						substrate
					),
					state: Effect.map(env.observer.queryValues(state, []), (rows) =>
						Arr.map(rows, (row) => Arr.map(row, textOfValue))
					)
				},
				every,
				(explained) => {
					for (const f of runFeatures(explained)) {
						note(f)
					}
				}
			)
		})
	)
