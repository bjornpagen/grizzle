import { databaseDropped } from "@bjornpagen/testing/resources"
import { regex } from "arkregex"
import { Array as Arr, Effect, Option, type Scope, String as Str } from "effect"
import { Client } from "pg"
import { installationRoleOf } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { InitializedCluster, lentVariable } from "#test/support/cluster.ts"
import { adminUrl } from "#test/support/env.ts"
import { devSession, type PgConnection, type SqlError, sqlErrorOf } from "#test/support/pg.ts"
import { type BudgetedCluster, budgeted, connectionBudget } from "#test/support/substrate/budget.ts"
import { allocatingPid } from "#test/support/substrate/names.ts"

/** A column's text as pg hands it over, unparsed. */
const asText = (text: string): string => text

/** Every column as its text: pg's parsers bypassed. */
const textTypes = { getTypeParser: (): ((text: string) => string) => asText } as const

/** A bootstrap superuser's connection (superuserClient): its statements, each answering its rows, every column its text. */
export interface SuperuserClient {
	/** One statement and its parameters, and its answer. */
	readonly query: (
		sql: string,
		params: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<string | null>>, SqlError>
}

/**
 * A connection to `database` as the bootstrap superuser, the account's own user, over the member's socket, which trusts
 * it (env.ts adminUrl); the TLS sessions of test/support/pg.ts reach no superuser. It lives for the scope, drawing one
 * of its budget's permits; a connection refused is a failure its caller makes a defect of the run. What the
 * substrate's superuser statements and reads (substrate.ts asSuperuser, asSuperuserRead) and the toolchain's resources
 * (runner.ts superuserSession) send.
 */
export const superuserClient = (
	cluster: BudgetedCluster,
	database: string,
	applicationName: string
): Effect.Effect<SuperuserClient, SqlError, Scope.Scope> =>
	Effect.map(
		cluster.budget.opened(
			Effect.acquireRelease(
				Effect.suspend(() => {
					const c = new Client({
						connectionString: adminUrl(cluster, database),
						application_name: applicationName,
						types: textTypes
					})
					return Effect.as(Effect.tryPromise({ try: () => c.connect(), catch: sqlErrorOf }), c)
				}),
				(c) => Effect.promise(() => c.end())
			)
		),
		(c): SuperuserClient => ({
			query: (sql, params) =>
				Effect.map(
					Effect.tryPromise({
						try: () => c.query({ text: sql, values: [...params], rowMode: "array" }),
						catch: sqlErrorOf
					}),
					(result) => trusted<ReadonlyArray<ReadonlyArray<string | null>>>(result.rows)
				)
		})
	)

/**
 * A child process's place, lent by a case (substrate.ts Substrate.lentLayer): `width` of the permits of the case's
 * budget set aside for the current scope (ConnectionBudget within), and the environment that names them, the case's
 * member and its database to the child (cluster.ts lentVariable), whose connections draw from them, so the worker and
 * its children hold no more than the worker's budget. ConnectionBudgetExhausted, a defect, when fewer are free.
 */
export const lend = (
	place: Readonly<{ cluster: BudgetedCluster; database: string }>,
	width: number
): Effect.Effect<Readonly<Record<string, string>>, never, Scope.Scope> =>
	Effect.as(place.cluster.budget.within(width), {
		[lentVariable]: `${place.cluster.port}:${width}:${place.database}`
	})

/**
 * The sessions the sweep holds at once, outside every worker's budget: its admin, and the bootstrap superuser's session
 * it drops an owner login on (substrate.ts dropRole).
 */
const sweepSessions = ["admin", "superuser"] as const

/** The initialised cluster with a budget of the sweep's sessions (sweepSessions). */
const swept: Effect.Effect<BudgetedCluster, never, InitializedCluster> = Effect.map(
	InitializedCluster,
	(cluster) => budgeted(cluster, connectionBudget(sweepSessions.length))
)

/** Whether process `pid` is running on this machine; a process of another user counts as running. */
const running = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return Error.isError(error) && "code" in error && error.code === "EPERM"
	}
}

/**
 * Drops `name` on `admin` by the testing library's one drop of a database (resources databaseDropped): the replication
 * slots of its installations' live sources first, which PostgreSQL refuses to drop a database under (55006), each
 * leader streaming from one terminated and waited for, then the database, its sessions ended. The sweep's alone: DROP
 * DATABASE holds its transaction id while it waits for the checkpoint it forces, which pins every SERIALIZABLE
 * snapshot's xmin meanwhile and makes PostgreSQL summarize the other files' committed transactions (test/support/pg.ts
 * freshDatabase), so nothing drops a database while a test file runs.
 */
const dropDatabase = (admin: PgConnection, name: string): Effect.Effect<void, SqlError> =>
	Effect.forEach(databaseDropped(name, "ended"), (sql) => admin.query(sql, []), { discard: true })

/**
 * Whether every test file process `pid` ran has ended: it is this process, which calls the sweep only when no test file
 * of its own runs, or a process no longer running.
 */
const ended = (pid: number): boolean => pid === process.pid || !running(pid)

/** The allocation a role `<allocation>__<name>` is named under: its name's lead. */
const allocationOf = (role: string): string => Arr.headNonEmpty(Str.split("__")(role))

/**
 * Drops what ended processes left on the cluster: their gz_t_ databases, their `<schema>__<access>` roles and every
 * role an installation at its stems on one of their allocations creates (core/identity.ts installationRoleOf: its live
 * source's decoder login and its function owner, which carry no allocation, so they are read off the allocation). A run in progress is never touched: its processes are
 * running. Its callers call it only when no database of their own is in use: a bench runner when its last gate has
 * run, its own databases then ended too. The gz_shared_ databases a test file shared before every test ran on the
 * toolchain's runner are no gz_t_ name and are left as they are. Runs beside each other
 * sweep at once, with no lock: an ended process's leftovers are every sweep's to drop, each drop is of what exists
 * (DROP DATABASE IF EXISTS) and its failure ignored, so a leftover two sweeps meet at once is dropped by one of them and
 * the other's drop finds it gone. `dropRole` is the substrate's.
 */
export const sweep = (
	dropRole: (
		cluster: BudgetedCluster,
		admin: PgConnection,
		role: string
	) => Effect.Effect<void, SqlError>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* swept
			const admin = yield* devSession(cluster, Option.none())
			const databases = yield* admin.queryValues(
				"SELECT datname::text FROM pg_catalog.pg_database WHERE datname::text ~ '^gz_t_' ORDER BY 1",
				[]
			)
			for (const [value] of databases) {
				const database = String(value)
				const pid = regex("^gz_t_([0-9]+)").exec(database)?.[1]
				if (pid === undefined || ended(Number(pid))) {
					yield* Effect.ignore(dropDatabase(admin, database))
				}
			}
			const rows = yield* admin.queryValues(
				"SELECT rolname::text FROM pg_catalog.pg_roles WHERE strpos(rolname::text, '__') > 0 ORDER BY 1",
				[]
			)
			const roles = Arr.map(rows, ([value]) => String(value))
			const dead = Arr.filter(roles, (role) => Option.exists(allocatingPid(role), ended))
			const installedByDead = installationRoleOf(
				{ kind: "stems" },
				new Set(Arr.map(dead, allocationOf))
			)
			for (const role of roles) {
				if (installedByDead(role) !== undefined || Option.exists(allocatingPid(role), ended)) {
					yield* Effect.ignore(dropRole(cluster, admin, role))
				}
			}
		})
	)
