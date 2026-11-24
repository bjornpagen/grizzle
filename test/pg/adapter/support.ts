import { liveSleep } from "@bjornpagen/testing/live"
import { Array as Arr, Duration, Effect, Redacted, type Scope } from "effect"
import type { CredentialError } from "#adapter/errors/credential.ts"
import type { BatchRefused } from "#adapter/errors/failures.ts"
import type { PoolBounds, Transport } from "#adapter/types/layer.ts"
import { type ApartFailure, oneShotStatement } from "#adapter/wire/batch.ts"
import { makePool, type Session, type SessionPool } from "#adapter/wire/session.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { roleDefaultSettings } from "#compiler/physical/ddl/roles.ts"
import { servedSession } from "#compiler/program/served.ts"
import type { ServedSession } from "#compiler/served/forms.ts"
import type { RoleSetting } from "#compiler/sql/ast.ts"
import { printRoleSetting } from "#compiler/sql/print.ts"
import {
	clusterConnection,
	clusterPool,
	parsedConnection,
	runAlone,
	type SqlError
} from "#test/support/pg.ts"
import { testSql } from "#test/support/sql.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { paramText } from "#test/support/wire.ts"

/**
 * Shared helpers for the adapter tests (test/pg/adapter).
 *
 * A login here is what an installation's migration makes of a login: a role `<schema>__<name>` that logs in, whose role
 * defaults are the installation's own for every login (physical/ddl/roles.ts roleDefaultSettings): search_path =
 * pg_catalog, pg_temp, lc_monetary, lc_numeric and lc_time at C.UTF-8, bytea_output = hex and extra_float_digits = 1.
 *
 * The settings an installation stores as role defaults for every login, and their values.
 */
export const roleDefaults: Arr.NonEmptyReadonlyArray<RoleDefaultSetting> = roleDefaultSettings

/** A default every login stores. */
export type RoleDefaultSetting = (typeof roleDefaultSettings)[number]

/**
 * Creates the login `<schema>__<name>` with a random password and the given role defaults (an installed login's by
 * default).
 */
export const substrateLogin = (
	schema: string,
	name: string,
	defaults: ReadonlyArray<RoleSetting>
): Effect.Effect<Credentials, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const credentials = yield* s.role(schema, name)
		for (const setting of defaults) {
			yield* s.admin.query(
				`ALTER ROLE ${quoteIdent(credentials.role)} SET ${printRoleSetting(setting)}`,
				[]
			)
		}
		return credentials
	})
export interface PoolOptions {
	/**
	 * What the pool's sessions send as their password: the credentials' own, or another (a rotating Effect, a wrong one).
	 */
	readonly password:
		| { readonly kind: "credentials" }
		| {
				readonly kind: "given"
				readonly password: Redacted.Redacted | Effect.Effect<Redacted.Redacted, CredentialError>
		  }
	readonly pool: PoolBounds
	/**
	 * How the sessions reach the server: the cluster's own transport (test/support/pg.ts clusterConnection), or one a
	 * test supplies (a tap, a fake server, another CA, host or servername).
	 */
	readonly transport:
		| { readonly kind: "cluster" }
		| { readonly kind: "given"; readonly transport: Transport }
	/** The startup options and control texts every session sends: a served file's, or ones a test plants. */
	readonly session: ServedSession
}

/**
 * The adapter's own pool for the local cluster: the cluster's transport, the credentials' password, the test pool's
 * bounds and the served session texts. A test spreads it and overrides what it means.
 */
export const defaultPool: PoolOptions = {
	password: { kind: "credentials" },
	pool: clusterPool,
	transport: { kind: "cluster" },
	session: servedSession
}

/**
 * A session pool for `credentials` in this file's database, closed with the scope, its connection parsed as grizzle
 * parses one (test/support/pg.ts parsedConnection).
 */
export const poolFor = (
	credentials: Credentials,
	options: PoolOptions
): Effect.Effect<SessionPool, never, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const connection = clusterConnection(
			s.cluster,
			s.database,
			options.password.kind === "credentials" ? credentials.password : options.password.password
		)
		return yield* makePool({
			connection: parsedConnection(
				{
					...connection,
					transport:
						options.transport.kind === "given" ? options.transport.transport : connection.transport
				},
				credentials.role
			),
			session: options.session,
			bounds: options.pool
		})
	})

/** The rows of one statement sent alone on `session`, parameters as their texts. */
export const rowsOn = (
	session: Session,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, ApartFailure | BatchRefused> =>
	Effect.map(
		runAlone(session, oneShotStatement(testSql(sql), Arr.map(params, paramText))),
		(outcome) => outcome.rows
	)

/** The backend a session runs on, as pg_backend_pid() reports it. */
export const backendPidOf = (
	session: Session
): Effect.Effect<number, ApartFailure | BatchRefused> =>
	Effect.map(rowsOn(session, "SELECT pg_catalog.pg_backend_pid()::text", []), (rows) =>
		Number(rows[0]?.[0])
	)

/**
 * The pause between two looks of until: the shortest wait a timer takes, so a look that finds its fact not yet true
 * hands the main thread back to the event loop for one timer tick before the next, where until looked again at once. A
 * look is a query of the server's state (pg_stat_activity, pg_locks) or a read of a tap's counters, and the fact it
 * waits for comes within a server round trip of what causes it, so the pause delays a wait by a tick at most; without
 * it a wait spun its process at full speed, a look per round trip of the admin's session (test/pg/adapter/flight at
 * bafa0de1c, waiting for an answer the client had not asked for: about 121,000 looks in 100 s, 60 s of CPU).
 *
 * @limitKind published
 * @owner Node 26.13.1's timers
 * @unit milliseconds
 * @scope each pause between two looks of one wait of until, in each test process
 * @constraint hard quota
 * @source https://nodejs.org/docs/v26.13.1/api/timers.html#settimeoutcallback-delay-args
 * @quote When delay is larger than 2147483647 or less than 1 or NaN, the delay will be set to 1.
 * @verified 2026-11-20
 */
const lookPauseMillis = 1

/**
 * Looks at `check` until it holds, pausing a timer's tick between looks (lookPauseMillis) on the live clock, whatever
 * clock the test runs under: the verdict waits on the fact, never on the time, and a wait that never ends is the test
 * runner's hung test, never a verdict of the suite. A comment at each call names the fact.
 */
export const until = <E, R>(check: Effect.Effect<boolean, E, R>): Effect.Effect<void, E, R> =>
	Effect.gen(function* () {
		for (;;) {
			if (yield* check) {
				return
			}
			yield* liveSleep(Duration.millis(lookPauseMillis))
		}
	})

/** The state of backend `pid` in pg_stat_activity, or "gone". */
export const backendState = (pid: number) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rows = yield* s.admin.queryValues(
			"SELECT state::text, wait_event::text FROM pg_catalog.pg_stat_activity WHERE pid = $1::int4",
			[pid]
		)
		const row = rows[0]
		return row === undefined
			? { state: "gone", waitEvent: "" }
			: { state: String(row[0]), waitEvent: String(row[1]) }
	})
