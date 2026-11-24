/** What second-call.test.ts reads: its schema, its space and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { pgCluster } from "#test/support/env.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { openSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A fact whose `w` is a candidate key, so a put of it deletes the facts it displaces and inserts its own (write/put/
 * choose.ts candidateKey): both statements read the call's facts, which the program stages in a carrier of its own
 * (write/program/slot-carriers.ts), emptied by its session function at each call.
 */
const Fixed = relation("Fixed", { id: pg.integer, w: pg.integer }, ["id"])

/** The bound the rule over a query holds every w under: no case's write reaches it. */
const bound = 1_000_000

/**
 * Fixed, mutable, and a rule over a query of its rows, Bounded, so a write of Fixed is captured into the judge's
 * session deltas and judged at its COMMIT (physical/ddl/rules.ts addRules).
 */
const build = (name: string) => {
	const Base = schema(
		name,
		[Fixed],
		[key(on(Fixed, "w")), mutable(Fixed), unit("Row", { id: pg.integer })]
	)
	const Seen = derived(
		"Seen",
		query(Base).rule((r) => {
			const { id, w } = v(Fixed, "f")
			return r.match(Fixed, { id, w }).find({ id, w })
		})
	)
	return schema.extend(
		[Base],
		`${name}_1`,
		[Seen],
		[check("Bounded", Seen, (s) => s.lt(s.w, bound))]
	)
}

/** The keys each call puts: one, and sixteen, every carrier within its one page. */
const sizes = [1, 16] as const

export type SecondCallFeature = "one key" | "sixteen keys"

/** A case: the keys each of the two calls puts. */
export interface Calls {
	readonly keys: (typeof sizes)[number]
}

export const callsGen: Gen<Calls> = (source) => ({ keys: source.draw(element(sizes)) })

/**
 * The facts the `k`-th call puts, from 1, each key's w moved past the one before, under the bound: the facts stored
 * before the first call are its 0th, so every call displaces a stored fact at each key and runs every statement of the
 * put, its capture's of the rows it deletes among them, as the one before did.
 */
const factsOf = (calls: Calls, k: number) =>
	Array.from({ length: calls.keys }, (_, i) => ({ id: i + 1, w: k * 100 + i + 1 }))

/**
 * The settings that turn pg_stat_statements on in the case's database alone (@bjornpagen/testing/pg settings.ts
 * preloadSettings, where every member holds it preloaded and inert), each the owner's to set (pg.config.ts
 * ownerParameters): a backend that connects after them counts every statement's plans and calls, in functions too.
 */
const tracked = [
	"compute_query_id = 'on'",
	"pg_stat_statements.track = 'all'",
	"pg_stat_statements.track_planning = 'on'"
] as const

/**
 * What the cluster's statement statistics count of the case's database: every statement's plans and calls, and each
 * statement's plans by its query id, whether it ran in a function and its text, which a failure names.
 */
interface Counted {
	readonly plans: number
	readonly calls: number
	readonly byStatement: ReadonlyMap<string, { readonly plans: number; readonly text: string }>
}

/** A cell's text: an aggregate over no row answers NULL, which reads as no text. */
const textOf = (cell: unknown): string => (typeof cell === "string" ? cell : "")

/**
 * One case on a fresh clone: Fixed installed through its first migration with each key's fact stored (the 0th call's),
 * the clone's backends counting every
 * statement's plans (pg_stat_statements: compute_query_id on, track all, track_planning on, for the database alone,
 * as its template turns them on), then one served Db of the full world's login, opened on a pool whose first session is
 * a brand-new backend, and its put called twice. The first call stands the write up (adapter/apply/stand-up.ts) and
 * plans its statements; the second, on the same backend, plans none, in functions or out, and changes no catalog row of
 * the session's own relations: none made, no file given anew, no row of pg_class or pg_proc of its temporary schema
 * rewritten, so it sent no invalidation any backend of the database reads.
 */
export const runCalls = (calls: Calls, c: Case<SecondCallFeature>) =>
	Effect.gen(function* () {
		c.note(calls.keys === 1 ? "one key" : "sixteen keys")
		const declared = build("second_call")
		const done = yield* installMigrated(declared, {
			ambient: ordinarySession,
			extensions: [],
			label: "second_call",
			logins: [fullWorld(declared, {}).server]
		})
		const built = build(done.schema)
		const world = fullWorld(built, {})
		const substrate = yield* Substrate
		const names = namesOf(done)
		yield* standUpJudge(substrate.admin, done.installation)
		yield* substrate.admin.query("BEGIN", [])
		yield* substrate.admin.query(
			`INSERT INTO ${names.table(Fixed)} (${names.column(Fixed, "id")}, ${names.column(Fixed, "w")}) SELECT g, g FROM pg_catalog.generate_series(1, $1::int4) AS g`,
			[calls.keys]
		)
		yield* substrate.admin.query("COMMIT", [])
		for (const setting of tracked) {
			yield* substrate.admin.query(
				`ALTER DATABASE ${quoteIdent(substrate.database)} SET ${setting}`,
				[]
			)
		}
		const statistics = yield* openSession(substrate.cluster, {
			database: pgCluster.owner,
			credentials: substrate.owner,
			label: "statement statistics"
		})
		const counted = Effect.map(
			statistics.values(
				"SELECT s.queryid::text || ' ' || s.toplevel::text, s.plans::int8, s.calls::int8, pg_catalog.left(s.query, 200) FROM public.pg_stat_statements AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.dbid WHERE d.datname = $1::text",
				[substrate.database]
			),
			(rows): Counted => ({
				plans: Arr.reduce(rows, 0, (sum, row) => sum + Number(row[1])),
				calls: Arr.reduce(rows, 0, (sum, row) => sum + Number(row[2])),
				byStatement: new Map(
					Arr.map(
						rows,
						(row) => [textOf(row[0]), { plans: Number(row[1]), text: textOf(row[3]) }] as const
					)
				)
			})
		)
		/** The catalog rows of every session's own relations and functions in the database, as text, in one order. */
		const catalog = Effect.map(
			substrate.admin.queryValues(
				"SELECT pg_catalog.string_agg(r.row, ';' ORDER BY r.row) FROM (SELECT c.oid::text || ':' || c.relname || ':' || c.relfilenode::text || ':' || c.relpages::text || ':' || c.reltuples::text || ':' || c.xmin::text AS row FROM pg_catalog.pg_class AS c WHERE c.relpersistence = 't' UNION ALL SELECT p.oid::text || ':' || p.proname || ':' || p.xmin::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname LIKE 'pg\\_temp\\_%') AS r",
				[]
			),
			(rows) => textOf(rows[0]?.[0])
		)
		/** The backends of the database the login's sessions run on. */
		const backends = Effect.map(
			substrate.admin.queryValues(
				"SELECT pg_catalog.array_agg(a.pid ORDER BY a.pid)::text FROM pg_catalog.pg_stat_activity AS a WHERE a.datname = $1::text AND a.usename = $2::text",
				[substrate.database, done.as(world.server).role]
			),
			(rows) => textOf(rows[0]?.[0])
		)
		const where = `${calls.keys} keys in ${substrate.database}`
		yield* withServedDb(done, world.server.roles.app, {}, ({ serve }) =>
			Effect.gen(function* () {
				const served = yield* serve({ put: ChangeSet.empty(built).put(Fixed, []) })
				const put = writeOnce(member(served, "put"))
				const call = (k: number) =>
					Effect.gen(function* () {
						const outcome = yield* writeAnswerOf(
							put({ params: {}, facts: { put: { Fixed: factsOf(calls, k) } } })
						)
						assert.equal(outcome.kind, "accepted", `call ${k} of ${where} is accepted`)
					})
				yield* call(1)
				const first = yield* backends
				const before = yield* counted
				const catalogBefore = yield* catalog
				yield* call(2)
				const after = yield* counted
				const catalogAfter = yield* catalog
				const second = yield* backends
				assert.equal(second, first, `the second call of ${where} ran on the first call's backend`)
				assert.ok(
					after.calls > before.calls,
					`the second call of ${where} ran statements the statistics counted`
				)
				const planned = Arr.flatMap([...after.byStatement], ([id, now]) => {
					const then = before.byStatement.get(id)?.plans ?? 0
					return now.plans > then ? [`${now.plans - then}x ${now.text}`] : []
				})
				assert.equal(
					after.plans - before.plans,
					0,
					`the second call of ${where} planned ${after.plans - before.plans} statements on a backend whose first call planned them: ${Arr.join(planned, "; ")}`
				)
				assert.equal(
					catalogAfter,
					catalogBefore,
					`the second call of ${where} changed a catalog row of the session's own relations or functions`
				)
			})
		)
	})
