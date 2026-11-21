/** What the properties of fence.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec, type Scope } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { writeAnswerOf, type WriteAnswer } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { every, everyRelation } from "#test/support/schedules/interleave.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import {
	type Explained,
	type RaceTxn,
	runSerialRace,
	type SerialRaceFailed
} from "#test/support/schedules/serial.ts"
import { beginSerializableAction } from "#test/support/schedules/types.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Pub = relation("Pub", { v: pg.integer, s: pg.integer }, ["v"])

const Seen = relation("Seen", { k: pg.integer, v: pg.integer }, ["k"])

const Log = relation("Log", { n: pg.integer }, ["n"])

const relations = Object.freeze({ Pub, Seen, Log })

/**
 * The schema under its installed name with its worlds: in the login `server`, the `publisher`, whose `replace(v, s, n)`
 * deletes the stored Pub at v and inserts Pub(v, s), then inserts Log(n), and the `learner`, whose `see(k, v)` inserts
 * Seen(k, v), each with the empty ChangeSet a writer's first call applies, named for its role; and in the login `psql`, the role `direct`
 * the blocker takes on, which holds and writes Log alone. It has no ChangeSet, so generate bounds its direct
 * transactions by what its grants let them read (README, "READ COMMITTED writes"): a grant of Seen would let one read
 * the learner's rows for their absence and keep the learner SERIALIZABLE, and the blocker reads nothing.
 */
const renamed = (name: string) => {
	const base = schema(name, Rec.values(relations), [contained(on(Seen, "v"), on(Pub, "v"))])
	const publisher = role(base, "publisher", relations, { write: ["Pub", "Log"] })
	const learner = role(base, "learner", relations, { insert: ["Seen"] })
	const direct = role(base, "direct", { Log }, { write: ["Log"] })
	const p = publisher.relations
	const storedPub = query(publisher).rule((r) => {
		const row = v(p.Pub, "p")
		return r
			.match(p.Pub, row)
			.where(r.eq(row.v, r.param("v", pg.integer)))
			.find(row)
	})
	const replace = ChangeSet.sequence(
		ChangeSet.empty(publisher)
			.delete(p.Pub, storedPub)
			.insert(
				p.Pub,
				query(publisher).rule((r) =>
					r.find({ v: r.param("v", pg.integer), s: r.param("s", pg.integer) })
				)
			),
		ChangeSet.empty(publisher).insert(
			p.Log,
			query(publisher).rule((r) => r.find({ n: r.param("n", pg.integer) }))
		)
	)
	const l = learner.relations
	const see = ChangeSet.empty(learner).insert(
		l.Seen,
		query(learner).rule((r) => r.find({ k: r.param("k", pg.integer), v: r.param("v", pg.integer) }))
	)
	return {
		schema: base,
		publisher,
		learner,
		direct,
		server: login(base, "server", [publisher, learner], {
			workload: [
				workload(publisher, { publisherNoop: ChangeSet.empty(publisher), replace }),
				workload(learner, { learnerNoop: ChangeSet.empty(learner), see })
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/**
 * A race: the stored Pub(a, s), the publisher's replace of it by Pub(a, t), t never s, so it deletes the key a and
 * inserts it again, and its Log(n); the learner's Seen(k, a); and how the blocker, holding Log(n) uncommitted, ends.
 */
interface FenceRace {
	readonly a: number
	readonly s: number
	readonly t: number
	readonly k: number
	readonly n: number
	readonly blocker: "commit" | "rollback"
}

export const raceGen: Gen<FenceRace> = (source) => {
	const s = source.draw(int(0, 2))
	return {
		a: source.draw(int(1, 3)),
		s,
		t: (s + 1 + source.draw(int(0, 1))) % 3,
		k: source.draw(int(1, 3)),
		n: source.draw(int(1, 3)),
		blocker: source.draw(element(["commit", "rollback"]))
	}
}

export type FenceFeature =
	| "generate certifies the learner READ COMMITTED"
	| "the login holds MAINTAIN on Pub, as migrate granted it"
	| "the publisher's call waited on the blocker past its lock"
	| "the learner's deferred check waited on the publisher's fence"
	| "a learner that waited on the fence accepted after the replace"

/** The features one explained run reached (see FenceFeature). */
const featuresOf = (
	e: Explained<WriteAnswer<WriteOutcome<unknown>>>
): ReadonlyArray<FenceFeature> => {
	const publisherWaited = Arr.some(
		e.run.moves,
		(m) =>
			m.session === "publisher" && m.observed._tag === "Waited" && m.observed.on.includes("blocker")
	)
	const fenceMet = Arr.some(
		e.run.moves,
		(m) =>
			m.session === "learner" &&
			m.observed._tag === "Waited" &&
			m.observed.on.includes("publisher") &&
			m.observed.lock.locktype === "relation" &&
			m.observed.lock.mode === "RowShareLock"
	)
	const learned = e.ends.get("learner")
	const accepted = learned?.kind === "answered" && learned.retried.answered.kind === "accepted"
	const after = e.order.indexOf("publisher") < e.order.indexOf("learner")
	return [
		...(publisherWaited
			? ["the publisher's call waited on the blocker past its lock" as const]
			: []),
		...(fenceMet ? ["the learner's deferred check waited on the publisher's fence" as const] : []),
		...(fenceMet && accepted && after
			? ["a learner that waited on the fence accepted after the replace" as const]
			: [])
	]
}

/**
 * Installs the schema as generate drafts and migrate applies it, opens the publisher's and the learner's Dbs through
 * DbLayers of their own over the served login `server` and the blocker as `direct`, and runs the race in every order,
 * every run judged by its serial reference.
 */
export const runRace = (
	race: FenceRace,
	c: Case<FenceFeature>
): Effect.Effect<
	void,
	CompileError | SqlError | TransactionRolledBack | OpenError | PsqlProcessError | SerialRaceFailed,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rig = yield* openRig(renamed)
		const names = namesOf(rig.installed)
		const publisher = yield* rig.servedWriter(
			"publisher",
			(context) => openServed(rig.served.roles.publisher, {}).pipe(Effect.provideContext(context)),
			(db) => writeAnswerOf(db.workload.publisherNoop.once({ params: {}, facts: {} }))
		)
		const learner = yield* rig.servedWriter(
			"learner",
			(context) => openServed(rig.served.roles.learner, {}).pipe(Effect.provideContext(context)),
			(db) => writeAnswerOf(db.workload.learnerNoop.once({ params: {}, facts: {} }))
		)
		if (learner.ctx.isolation === "readCommitted") {
			c.note("generate certifies the learner READ COMMITTED")
		}
		const [maintains] = yield* rig.env.observer.queryValues(
			"SELECT pg_catalog.has_table_privilege($1::name, $2::text, 'MAINTAIN')::text",
			[rig.installed.as(rig.worlds.server).role, names.table(Pub)]
		)
		if (maintains?.[0] === "true") {
			c.note("the login holds MAINTAIN on Pub, as migrate granted it")
		}
		const direct = yield* openActors(s, { blocker: { kind: "raw", as: rig.direct } })
		const pub = names.table(Pub)
		const log = names.table(Log)
		const logColumn = names.column(Log, "n")
		const state = Arr.join(
			[
				`SELECT 'Pub', ${names.column(Pub, "v")}::text, ${names.column(Pub, "s")}::text FROM ${pub}`,
				`SELECT 'Seen', ${names.column(Seen, "k")}::text, ${names.column(Seen, "v")}::text FROM ${names.table(Seen)}`,
				`SELECT 'Log', ${logColumn}::text, NULL FROM ${log}`
			],
			" UNION ALL "
		)
		const replace: RaceTxn<WriteAnswer<WriteOutcome<unknown>>> = {
			kind: "grizzle",
			session: "publisher",
			label: `replace Pub(${race.a}, ${race.s}) by Pub(${race.a}, ${race.t}), then Log(${race.n})`,
			call: writeAnswerOf(
				publisher.db.workload.replace.once({
					params: { v: race.a, s: race.t, n: race.n },
					facts: {}
				})
			),
			footprint: everyRelation
		}
		const see: RaceTxn<WriteAnswer<WriteOutcome<unknown>>> = {
			kind: "grizzle",
			session: "learner",
			label: `see Seen(${race.k}, ${race.a})`,
			call: writeAnswerOf(
				learner.db.workload.see.once({ params: { k: race.k, v: race.a }, facts: {} })
			),
			footprint: everyRelation
		}
		const blocker: RaceTxn<WriteAnswer<WriteOutcome<unknown>>> = {
			kind: "direct",
			begin: beginSerializableAction,
			session: "blocker",
			statements: [
				{ sql: `INSERT INTO ${log} (${logColumn}) VALUES (${race.n})`, footprint: everyRelation }
			],
			end: race.blocker
		}
		yield* runSerialRace(
			rig.env,
			{ direct, grizzle: { publisher: publisher.actor, learner: learner.actor } },
			{
				name: "a fenced replace through the adapter beside a READ COMMITTED learner",
				txns: [replace, see, blocker],
				reset: rig.replace([
					`INSERT INTO ${pub} (${names.column(Pub, "v")}, ${names.column(Pub, "s")}) VALUES (${race.a}, ${race.s})`
				]),
				state: Effect.map(rig.env.observer.queryValues(state, []), (rows) =>
					Arr.map(rows, (row) => Arr.map(row, textOfValue))
				)
			},
			every,
			(e) => c.noteAll(featuresOf(e))
		)
	})

/** The cases of the rotating stream; its floor runs a quarter of them. */
export const runs = 8
