/** What warm-pool.test.ts reads: its schema, its template, its box and each case's requests. */

import { createServer, connect, type Server, type Socket } from "node:net"
import { timerMinMs } from "@bjornpagen/grizzle/runtime"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { liveSleep } from "@bjornpagen/testing/live"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Duration, Effect, Formatter, Layer, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { Transport } from "#adapter/types/layer.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { pgCluster } from "#test/support/env.ts"
import type { Generated } from "#test/support/install-migrate.ts"
import { testExitWait } from "#test/support/limits.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection } from "#test/support/pg.ts"
import { fixtureTemplate, openedIn } from "#test/support/pg/reads/support.ts"
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

/**
 * The reap window the case's database gives each session of the login, pg_settings' tcp_keepalives_idle 1 s,
 * tcp_keepalives_interval 1 s and tcp_keepalives_count 1 (wire/reap.ts reapWindowOf): 2,000 ms of silence, which a case
 * waits out once.
 */
const keepalives = [
	"tcp_keepalives_idle = 1",
	"tcp_keepalives_interval = 1",
	"tcp_keepalives_count = 1"
] as const

/** The window `keepalives` gives: their idle time and one probe's interval, in milliseconds. */
const reapWindowMs = (1 + 1 * 1) * 1000

/** One connection through the proxy, its client's side and its server's, and what the proxy does with it. */
interface Link {
	readonly client: Socket
	readonly upstream: Socket
	mode: "forward" | "frozen" | "dead"
}

/**
 * A TCP proxy between a pool and the cluster that plays a client frozen while its server ends its session. Each link
 * forwards both ways until it is frozen; frozen, it passes nothing the server sends, its end among them, to the client,
 * which hears nothing, as a frozen client's machine reads nothing; dead, it answers the client's next bytes by resetting
 * the client's connection, as the server's host answers a segment of a connection it no longer holds.
 */
class FreezingProxy {
	readonly links = new Set<Link>()
	opened = 0
	resets = 0
	readonly server: Server

	constructor(host: string, port: number) {
		this.server = createServer((client) => {
			const upstream = connect(port, host)
			const link: Link = { client, upstream, mode: "forward" }
			this.opened += 1
			this.links.add(link)
			client.on("data", (chunk) => {
				if (link.mode === "dead") {
					this.resets += 1
					client.resetAndDestroy()
					upstream.destroy()
					return
				}
				upstream.write(chunk)
			})
			upstream.on("data", (chunk) => {
				if (link.mode === "forward") {
					client.write(chunk)
				}
			})
			upstream.on("end", () => {
				if (link.mode === "forward") {
					client.end()
				}
			})
			client.on("close", () => {
				upstream.destroy()
				this.links.delete(link)
			})
			client.on("error", () => undefined)
			upstream.on("error", () => undefined)
		})
	}

	/** Every link passes nothing more from its server to its client. */
	freeze(): void {
		for (const link of this.links) {
			link.mode = "frozen"
		}
	}

	/** Every frozen link resets its client at the client's next bytes. */
	kill(): void {
		for (const link of this.links) {
			if (link.mode === "frozen") {
				link.mode = "dead"
			}
		}
	}
}

/** A proxy to `host` and `port` listening on the loopback for the scope: its port, and the proxy. */
const proxyFor = (host: string, port: number) =>
	Effect.acquireRelease(
		Effect.callback<{ readonly proxy: FreezingProxy; readonly port: number }>((resume) => {
			const proxy = new FreezingProxy(host, port)
			proxy.server.listen(0, "127.0.0.1", () => {
				const address = proxy.server.address()
				resume(
					typeof address === "object" && address !== null
						? Effect.succeed({ proxy, port: address.port })
						: Effect.die(new Error("the proxy listens on no port"))
				)
			})
		}),
		({ proxy }) =>
			Effect.callback<void>((resume) => {
				for (const link of proxy.links) {
					link.client.destroy()
					link.upstream.destroy()
				}
				proxy.server.close(() => resume(Effect.void))
			})
	)

export type ReapFeature = `${Program} after its session's server ended it unheard`

export const reapGen: Gen<Program> = element<Program>(["put", "read"])

/**
 * One case on a fresh clone, as an application on one instance serves it: the clone's backends counting every
 * statement's calls (pg_stat_statements) and giving each session a reap window of 2,000 ms (`keepalives`), and the
 * login's layer built once, a pool of one session over a proxy that plays a frozen client (FreezingProxy). Two calls of
 * the program, each a Db.open of its own, the first on a new session, which reads its window, the second at once,
 * warm, which plans nothing, so it sent no probe: the window's read is an unnamed statement, planned at each run. Then the proxy freezes the session's link, the case
 * waits out the window, the session's backend is terminated, which the client never hears, and the link answers the
 * client's next bytes with a reset. The third call is answered as a call on a live session is: the pool probed the
 * silent session, which failed before anything of the call was sent, closed it and opened another, so no call answers
 * commitUnknown or transport; the proxy reset one connection and the pool opened two.
 */
export const runReap = (taken: SubstrateCase<Generated>, program: Program, c: Case<ReapFeature>) =>
	Effect.gen(function* () {
		const o = yield* openedIn(Notes, {}, warmInstall, taken)
		const substrate = taken.substrate
		for (const setting of [...tracked, ...keepalives]) {
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
		const role = o.installed.as(o.server).role
		const plans = Effect.map(
			statistics.values(
				"SELECT coalesce(sum(s.plans), 0)::int8 FROM public.pg_stat_statements AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.dbid WHERE d.datname = $1::text",
				[substrate.database]
			),
			(rows) => Number(rows[0]?.[0])
		)
		const backends = Effect.map(
			substrate.admin.queryValues(
				"SELECT a.pid::text FROM pg_catalog.pg_stat_activity AS a WHERE a.datname = $1::text AND a.usename = $2::text",
				[substrate.database, role]
			),
			(rows) => Arr.map(rows, (row) => String(row[0]))
		)
		const connection = clusterConnection(
			o.installed.cluster,
			o.installed.database,
			o.installed.as(o.server).password
		)
		const { proxy, port } = yield* proxyFor(connection.transport.host, connection.transport.port)
		const context = yield* Layer.build(
			sourcedDbLayer(o.installed, {
				...connection,
				transport: { ...connection.transport, host: "127.0.0.1", port },
				pool: { max: 1 },
				login: o.served.login,
				verify: testVerify
			})
		)
		const call = (round: number) =>
			Effect.provideContext(
				Effect.gen(function* () {
					const db = yield* Db.open(o.served.login.roles.app, {})
					switch (program) {
						case "put":
							return yield* Effect.map(
								db.workload.put.once({
									params: {},
									facts: { put: { Note: [{ id: 1, n: round }] } }
								}),
								(outcome) => outcome.kind
							)
						case "read":
							return yield* Effect.map(
								db.workload.read.once({ params: { id: 1 }, facts: {} }),
								(rows) => String([...rows].length)
							)
					}
				}),
				context
			)
		yield* call(1)
		const planned = yield* plans
		yield* call(2)
		assert.equal(
			(yield* plans) - planned,
			0,
			"the warm call planned nothing, so it sent no probe, the window's read an unnamed statement planned at each run"
		)
		const [first, ...others] = yield* backends
		assert.ok(first !== undefined && others.length === 0, "one session of the login stands")
		proxy.freeze()
		yield* liveSleep(Duration.millis(reapWindowMs))
		yield* substrate.admin.query(`GRANT ${quoteIdent(role)} TO CURRENT_USER WITH INHERIT TRUE`, [])
		const [ended] = yield* substrate.admin.queryValues(
			"SELECT pg_catalog.pg_terminate_backend($1::int4, $2::int8)",
			[Number(first), String(testExitWait)]
		)
		assert.equal(ended?.[0], true, "the session's backend exited, unheard by its client")
		proxy.kill()
		const third = yield* Effect.result(call(3))
		assert.ok(
			Result.isSuccess(third),
			`the call after its session's server ended it is answered as on a live session, not ${Result.isFailure(third) ? Formatter.format(third.failure) : ""}`
		)
		assert.equal(proxy.resets, 1, "the probe met the dead connection's reset")
		assert.equal(proxy.opened, 2, "the pool opened one session in the dead one's place")
		const now = yield* backends
		assert.ok(now.length === 1 && now[0] !== first, "the call ran on a new backend")
		c.note(`${program} after its session's server ended it unheard`)
	})
