/** What warm-pool.test.ts reads: its schema, its template, its box and each case's requests. */

import { timerMinMs } from "@bjornpagen/grizzle/runtime"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { liveSleep } from "@bjornpagen/testing/live"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Duration, Effect, Formatter, Layer } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { Transport } from "#adapter/types/layer.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { fixtureTemplate, openedIn } from "#test/pg/reads/support.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { pgCluster } from "#test/support/env.ts"
import type { Generated } from "#test/support/install-migrate.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection } from "#test/support/pg.ts"
import { openSession } from "#test/support/substrate/session.ts"
import type { SubstrateCase } from "#test/support/substrate/substrate.ts"
import { testVerify } from "#test/support/worlds.ts"

const Note = relation("Note", { id: pg.integer, n: pg.integer }, ["id"])

/** One mutable relation, put and read by its key. */
const Notes = schema("warm_pool", [Note], [mutable(Note), unit("Noted", { id: pg.integer })])

/**
 * The login's two programs, a write and a read, as an application's requests call them: a put of the notes it is given,
 * which stands its write up on each session's first call (adapter/apply/stand-up.ts), and a read of one note by its key.
 */
const programs = Object.freeze({
	put: ChangeSet.empty(Notes).put(Note, []),
	read: query(Notes).rule((r) => {
		const { n } = v(Note, "note")
		return r.match(Note, { id: r.param("id", pg.integer), n }).find({ n })
	})
})

const warmInstall = Object.freeze({ label: "warm", programs })

/** Notes installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const warmTemplate = fixtureTemplate(import.meta, Notes, warmInstall)

/** The program every request of a case calls. */
type Program = keyof typeof programs

/** A burst of requests: a pause, then `width` requests at once, each opening its own Db. */
interface Burst {
	readonly pauseMs: number
	readonly width: number
}

/**
 * The bursts a case sends through a pool of two sessions, each after a pause: requests one at a time, two at once, two
 * after one, one after two. The pauses are the least delay a Node timer waits and a few times it, each longer than any
 * idle timeout of that delay a pool could set at the release before it.
 */
const scenarios = {
	"one at a time": [
		{ pauseMs: 0, width: 1 },
		{ pauseMs: timerMinMs, width: 1 },
		{ pauseMs: 20, width: 1 }
	],
	"two at once": [
		{ pauseMs: 0, width: 2 },
		{ pauseMs: timerMinMs, width: 2 },
		{ pauseMs: 20, width: 2 }
	],
	"two after one": [
		{ pauseMs: 0, width: 1 },
		{ pauseMs: timerMinMs, width: 2 },
		{ pauseMs: 20, width: 2 }
	],
	"one after two": [
		{ pauseMs: 0, width: 2 },
		{ pauseMs: timerMinMs, width: 1 },
		{ pauseMs: 20, width: 1 }
	]
} as const satisfies Readonly<Record<string, Arr.NonEmptyReadonlyArray<Burst>>>

/** The most sessions a case's pool holds: the widest burst of any scenario. */
const poolMax = 2

type Scenario = keyof typeof scenarios

export type WarmFeature =
	| `${Program} ${Scenario}`
	| "a burst after a pause opened no session"
	| "a burst past the open sessions opened only the ones it lacked"

/** A case: the program its requests call, and its scenario's bursts. */
export interface Visits {
	readonly program: Program
	readonly scenario: Scenario
}

export const visitsGen: Gen<Visits> = (source) => ({
	program: source.draw(element<Program>(["put", "read"])),
	scenario: source.draw(
		element<Scenario>(["one at a time", "two at once", "two after one", "one after two"])
	)
})

/**
 * The settings that turn pg_stat_statements on in the case's database alone (@bjornpagen/testing/pg settings.ts
 * preloadSettings, where every member holds it preloaded and inert), each the owner's to set: a backend that connects
 * after them counts every statement's plans, in functions too.
 */
const tracked = [
	"compute_query_id = 'on'",
	"pg_stat_statements.track = 'all'",
	"pg_stat_statements.track_planning = 'on'"
] as const

/**
 * The connections a transport opened and the ones that closed, counted at the socket: every connection of a pool is
 * one `open`, and none of a case sends a CancelRequest, which would be another.
 */
interface Sockets {
	readonly opened: number
	readonly closed: number
}

/** `transport` counting each socket it opens, and each one's close, into `sockets`. */
const countedTransport = (
	transport: Transport,
	sockets: { opened: number; closed: number }
): Transport => ({
	...transport,
	open: () => {
		const socket = transport.open()
		sockets.opened += 1
		socket.once("close", () => {
			sockets.closed += 1
		})
		return socket
	}
})

/**
 * One case on a fresh clone, as an application on one instance serves it: the clone's backends counting every
 * statement's plans (pg_stat_statements, for the database alone), then the login's layer built once, a pool of two
 * sessions over a transport that counts its sockets, and each burst of the scenario sent after its pause, every request
 * of it a Db.open of its own on that layer and one call of the case's program, the burst's requests at once.
 *
 * After each pause and each burst: no session closed, so a pause between requests keeps every session the layer
 * opened; a burst opened sessions only past the ones open, at most its width and never past the pool's two; and its
 * statements planned exactly as often as its new sessions times a session's first call of the program, the first
 * burst's plans over its sessions: a call on a session that ran the program before plans nothing, its prepared
 * statements and their plans kept on the session across requests. At the end, no statement was planned more often
 * than the sessions the layer opened: each, its generic plan under the session's force_generic_plan, is planned once a
 * session and reused by every call after.
 */
export const runVisits = (taken: SubstrateCase<Generated>, visits: Visits, c: Case<WarmFeature>) =>
	Effect.gen(function* () {
		c.note(`${visits.program} ${visits.scenario}`)
		const o = yield* openedIn(Notes, {}, warmInstall, taken)
		const substrate = taken.substrate
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
		const plans = Effect.map(
			statistics.values(
				"SELECT coalesce(sum(s.plans), 0)::int8 FROM public.pg_stat_statements AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.dbid WHERE d.datname = $1::text",
				[substrate.database]
			),
			(rows) => Number(rows[0]?.[0])
		)
		const sockets = { opened: 0, closed: 0 }
		const connection = clusterConnection(
			o.installed.cluster,
			o.installed.database,
			o.installed.as(o.server).password
		)
		const context = yield* Layer.build(
			sourcedDbLayer(o.installed, {
				...connection,
				transport: countedTransport(connection.transport, sockets),
				pool: { max: poolMax },
				login: o.served.login,
				verify: testVerify
			})
		)
		const request = (i: number, round: number) =>
			Effect.provideContext(
				Effect.gen(function* () {
					const db = yield* Db.open(o.served.login.roles.app, {})
					switch (visits.program) {
						case "put": {
							const outcome = yield* writeAnswerOf(
								db.workload.put.once({
									params: {},
									facts: { put: { Note: [{ id: i + 1, n: round }] } }
								})
							)
							assert.equal(outcome.kind, "accepted", `request ${i} of burst ${round}'s put`)
							return
						}
						case "read":
							yield* db.workload.read.once({ params: { id: i + 1 }, facts: {} })
							return
					}
				}),
				context
			)
		const counted = (): Sockets => ({ ...sockets })
		let before = counted()
		let firstCall = 0
		for (const [round, burst] of scenarios[visits.scenario].entries()) {
			const where = `burst ${round} of ${visits.program} ${visits.scenario}`
			yield* liveSleep(Duration.millis(burst.pauseMs))
			assert.equal(sockets.closed, 0, `no session closed in the pause before ${where}`)
			const planned = yield* plans
			yield* Effect.all(
				Array.from({ length: burst.width }, (_, i) => request(i, round)),
				{ concurrency: "unbounded" }
			)
			const after = counted()
			const opened = after.opened - before.opened
			const plannedNow = (yield* plans) - planned
			assert.equal(after.closed, 0, `no session closed in ${where}: ${Formatter.format(after)}`)
			assert.ok(
				opened <= Math.max(0, burst.width - before.opened),
				`${where} opened ${opened} sessions beside the ${before.opened} open, for ${burst.width} requests`
			)
			assert.ok(after.opened <= poolMax, `${where} holds at most the pool's ${poolMax} sessions`)
			if (round === 0) {
				assert.ok(opened > 0, `${where} opened the pool's first session`)
				firstCall = plannedNow / opened
				assert.ok(
					Number.isSafeInteger(firstCall) && firstCall > 0,
					`each of ${where}'s ${opened} new sessions planned its first call alike, ${plannedNow} statements in all`
				)
			} else {
				assert.equal(
					plannedNow,
					opened * firstCall,
					`${where} planned ${plannedNow} statements for ${opened} new sessions, each planning ${firstCall} at its first call`
				)
				c.note(
					opened === 0
						? "a burst after a pause opened no session"
						: "a burst past the open sessions opened only the ones it lacked"
				)
			}
			before = after
		}
		const replanned = yield* statistics.values(
			"SELECT s.plans::text || 'x ' || pg_catalog.left(s.query, 200) FROM public.pg_stat_statements AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.dbid WHERE d.datname = $1::text AND s.plans > $2::int8",
			[substrate.database, sockets.opened]
		)
		assert.deepEqual(
			replanned,
			[],
			`no statement of ${visits.program} ${visits.scenario} planned more often than its ${sockets.opened} sessions`
		)
	})
