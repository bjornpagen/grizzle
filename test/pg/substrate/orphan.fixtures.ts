/** What the property of orphan.test.ts reads: its forms and their space, the throwaway postmaster, and one case's run. */
import { assert } from "@bjornpagen/testing/assert"
import { boolean, type Space } from "@bjornpagen/testing/gen"
import { liveMillis, liveSleep } from "@bjornpagen/testing/live"
import { clientCheckInterval, type Platform } from "@bjornpagen/testing/pg"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Record as Rec,
	type Scope,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { Client } from "pg"
import { trusted } from "#compiler/core/trusted.ts"
import { pgPin } from "#test/support/env.ts"
import { backendWaitStep, orphanExitBound, testExitWait } from "#test/support/limits.ts"
import { type SqlError, sqlErrorOf } from "#test/support/pg.ts"
import { privateCluster } from "#test/support/private-cluster.ts"
import type { TextRows } from "#test/support/substrate/substrate.ts"

/**
 * Each way the statement of a killed client runs on, never reading from or writing to its client, by name: the
 * statement, sent as one message and so one transaction, which takes a transaction id first and then never ends by
 * itself; and what pg_stat_activity shows of its backend once it runs, the transaction id held and the wait it runs on.
 * - computing: a recursive CTE whose every step yields the next, as the incident's long SELECT computed; it shows no
 *   wait, and its second statement follows its first in the same message;
 * - sleeping: pg_sleep without end, a wait on the backend's latch with a timeout;
 * - waiting on a lock: a wait for an advisory lock the case's observer holds (heldLock), a heavyweight lock's sleep.
 */
const forms = {
	computing: {
		statement:
			"SELECT pg_catalog.pg_current_xact_id(); WITH RECURSIVE r(i) AS (SELECT 1::int8 UNION ALL SELECT i + 1 FROM r) SELECT count(*) FROM r",
		running: "a.backend_xid IS NOT NULL"
	},
	sleeping: {
		statement: "SELECT pg_catalog.pg_current_xact_id(); SELECT pg_catalog.pg_sleep('infinity')",
		running: "a.backend_xid IS NOT NULL AND a.wait_event = 'PgSleep'"
	},
	"waiting on a lock": {
		statement: "SELECT pg_catalog.pg_current_xact_id(); SELECT pg_catalog.pg_advisory_xact_lock(0)",
		running: "a.backend_xid IS NOT NULL AND a.wait_event_type = 'Lock'"
	}
} as const

export type Form = keyof typeof forms

/** Every form, each a situation the box must reach: a form the space does not build is unreached, and fails it. */
export const formNames: ReadonlyArray<Form> = Rec.keys(forms)

/**
 * Every form, as what its backend waits on while the statement runs builds it: nothing, as it computes, or a wait, on
 * the backend's own latch (sleeping) or on a lock another session holds.
 */
export const formSpace: Space<Form> = (source) => {
	if (!source.draw(boolean)) {
		return "computing"
	}
	return source.draw(boolean) ? "waiting on a lock" : "sleeping"
}

/** The advisory lock the observer holds for a lock-waiting statement (forms["waiting on a lock"]). */
const heldLock = "pg_catalog.pg_advisory_lock(0)"

/** The application_name of every killed client's session, one case at a time. */
const orphanName = "grizzle-orphan"

/** The temporary slot each case creates, dropped with the session that creates it. */
const slotName = "grizzle_orphan"

/**
 * This process's environment without a libpq or server variable (PG*), which every child runs under, so each reaches
 * the case's cluster by its arguments alone and no PGOPTIONS sets a session's client check.
 */
const childEnvironment: Readonly<Record<string, string | undefined>> = Rec.filter(
	process.env,
	(_, key) => !Str.startsWith("PG")(key)
)

/** The case's cluster's one member, as the bootstrap superuser reaches it: its port, and its socket's directory. */
export interface Throwaway {
	readonly port: number
	readonly socket: string
}

/** psql's arguments to reach `server` as the bootstrap superuser over its socket, under `name`, with `extra` added. */
const conninfo = (server: Throwaway, name: string, extra: string): string =>
	`host=${server.socket} port=${server.port} user=postgres dbname=postgres application_name='${name}'${extra}`

/** Every column as its text: pg's parsers bypassed. */
const textTypes = {
	getTypeParser: (): ((text: string) => string) => (text: string) => text
} as const

/**
 * A connection to `server` as the bootstrap superuser over its socket, by peer authentication, under `name`, ended when
 * the scope closes.
 */
const connected = (server: Throwaway, name: string): Effect.Effect<Client, SqlError, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.suspend(() => {
			const client = new Client({
				host: server.socket,
				port: server.port,
				user: "postgres",
				database: "postgres",
				application_name: name,
				types: textTypes
			})
			return Effect.as(
				Effect.tryPromise({ try: () => client.connect(), catch: sqlErrorOf }),
				client
			)
		}),
		(client) => Effect.promise(() => client.end())
	)

/** One statement on `client`, its rows as text. */
const rowsOf = (
	client: Client,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<TextRows, SqlError> =>
	Effect.map(
		Effect.tryPromise({
			try: () => client.query({ text: sql, values: [...params], rowMode: "array" }),
			catch: sqlErrorOf
		}),
		(result) => trusted<TextRows>(result.rows)
	)

/** A child run to its end under childEnvironment, failing the run with its output unless it exits 0: its stdout. */
const completed = (
	command: string,
	args: ReadonlyArray<string>
): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.orDie(
		Effect.scoped(
			Effect.gen(function* () {
				const child = yield* ChildProcess.make(command, args, {
					env: childEnvironment,
					stdin: "ignore"
				})
				const [stdout, stderr] = yield* Effect.all(
					[
						Stream.mkString(Stream.decodeText(child.stdout)),
						Stream.mkString(Stream.decodeText(child.stderr))
					],
					{ concurrency: "unbounded" }
				)
				const code = yield* child.exitCode
				if (code !== 0) {
					return yield* Effect.die(
						new Error(`${command} ${Arr.join(args, " ")} exited ${code}: ${stdout}${stderr}`)
					)
				}
				return stdout
			})
		)
	)

/**
 * The case's cluster (test/support/private-cluster.ts privateCluster), for the scope: one member of grizzle's spec made
 * by the testing library as every member is, the settings every member holds among what it made (its
 * client_connection_check_interval, the logical WAL a slot needs), on a free port, its socket in its own state, stopped
 * and removed when the scope closes.
 */
export const throwaway: Effect.Effect<Throwaway, never, Scope.Scope | Platform> = Effect.map(
	privateCluster,
	(member) => ({ port: member.port, socket: member.socket })
)

/** The pid of the one backend named orphanName whose statement runs as `form` shows it (forms), polled for. */
const runningBackend = (observer: Client, form: Form): Effect.Effect<number, SqlError> =>
	Effect.gen(function* () {
		for (;;) {
			const [row] = yield* rowsOf(
				observer,
				`SELECT a.pid FROM pg_catalog.pg_stat_activity AS a WHERE a.application_name = $1 AND ${forms[form].running}`,
				[orphanName]
			)
			if (row !== undefined) {
				return Number(row[0])
			}
			yield* liveSleep(Duration.millis(backendWaitStep))
		}
	})

/**
 * Polls pg_stat_activity for backend `pid` at backendWaitStep until it is gone, then answers how long after `killed`
 * it was seen gone; once it is still there at `killed` plus orphanExitBound of every member's client check interval
 * (@bjornpagen/testing/pg clientCheckInterval), the
 * case fails with what it shows.
 */
const goneAfter = (
	observer: Client,
	pid: number,
	killed: number
): Effect.Effect<number, SqlError> =>
	Effect.gen(function* () {
		const bound = orphanExitBound(clientCheckInterval)
		for (;;) {
			const listed = yield* rowsOf(
				observer,
				"SELECT a.state, a.wait_event_type, a.wait_event, a.backend_xid::text FROM pg_catalog.pg_stat_activity AS a WHERE a.pid = $1::int4",
				[String(pid)]
			)
			const now = yield* liveMillis
			if (listed.length === 0) {
				return now - killed
			}
			if (now - killed >= bound) {
				return assert.fail(
					`the backend ${pid} of a client killed ${now - killed} ms ago still runs, past ${bound} ms: ${Formatter.format(listed)}`
				)
			}
			yield* liveSleep(Duration.millis(backendWaitStep))
		}
	})

/**
 * Ends every backend named orphanName on `observer`, the server waiting up to testExitWait for each to exit: what a
 * case leaves when its backend outlived its client, so its postmaster stops with none.
 */
const endOrphans = (observer: Client): Effect.Effect<void> =>
	Effect.ignore(
		rowsOf(
			observer,
			"SELECT pg_catalog.pg_terminate_backend(a.pid, $2::int8) FROM pg_catalog.pg_stat_activity AS a WHERE a.application_name = $1",
			[orphanName, String(testExitWait)]
		)
	)

/**
 * One case: a client of `server` runs `form`'s statement and is SIGKILLed once it runs; its backend must be seen gone
 * within orphanExitBound, and a logical slot's creation must then return the slot.
 */
export const orphanCase = (server: Throwaway, form: Form) =>
	Effect.scoped(
		Effect.gen(function* () {
			const observer = yield* connected(server, "grizzle-orphan observer")
			if (form === "waiting on a lock") {
				yield* rowsOf(observer, `SELECT ${heldLock}`, [])
			}
			yield* Effect.addFinalizer(() => endOrphans(observer))
			const client = yield* Effect.orDie(
				ChildProcess.make(
					`${pgPin.prefix}/bin/psql`,
					["-X", "-q", "-At", "-c", forms[form].statement, conninfo(server, orphanName, "")],
					{ env: childEnvironment, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
				)
			)
			const pid = yield* runningBackend(observer, form)
			yield* Effect.orDie(client.kill({ killSignal: "SIGKILL" }))
			const killed = yield* liveMillis
			yield* goneAfter(observer, pid, killed)
			const slot = yield* completed(`${pgPin.prefix}/bin/psql`, [
				"-X",
				"-At",
				"-c",
				`CREATE_REPLICATION_SLOT ${slotName} TEMPORARY LOGICAL pgoutput (SNAPSHOT 'nothing')`,
				conninfo(server, "grizzle-orphan slot", " replication=database")
			])
			assert.equal(
				Str.split(slot, "|")[0],
				slotName,
				`the slot's creation returns the slot: ${slot}`
			)
		})
	)
