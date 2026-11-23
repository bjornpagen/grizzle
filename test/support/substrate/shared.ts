import { regex } from "arkregex"
import { Array as Arr, Effect, Option, type Scope, String as Str } from "effect"
import { Client } from "pg"
import { installationRoleOf } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { InitializedCluster, lentVariable } from "#test/support/cluster.ts"
import { adminUrl } from "#test/support/env.ts"
import {
	awaitingBackend,
	awaitingUnchecked,
	backendOf,
	devSession,
	type PgConnection,
	type SqlError,
	sqlErrorOf,
	type PgStatement,
	testDatabaseSettings
} from "#test/support/pg.ts"
import { type BudgetedCluster, budgeted, connectionBudget } from "#test/support/substrate/budget.ts"
import { allocatingPid } from "#test/support/substrate/names.ts"

/**
 * What a clean test database does not contain, one line per object. The template holds the system schemas, `public`
 * (empty, with its default privileges), and the `vector` extension in `vector_ext` (The cluster); plpgsql is
 * built in; and the database holds exactly the test database settings (test/support/pg.ts testDatabaseSettings).
 * Anything else in the database, or another database-level setting, privilege or option, was left by a test.
 */
const leftoversQuery = `
SELECT l.what FROM (
	SELECT 'schema ' || n.nspname::text AS what FROM pg_catalog.pg_namespace AS n
	WHERE n.nspname::text NOT IN ('pg_catalog', 'pg_toast', 'information_schema', 'public', 'vector_ext')
		AND n.nspname::text !~ '^pg_(toast_)?temp_[0-9]+$'
	UNION ALL SELECT 'missing schema ' || s.name FROM unnest(ARRAY['public', 'vector_ext']) AS s(name)
	WHERE pg_catalog.to_regnamespace(s.name) IS NULL
	UNION ALL SELECT 'extension ' || e.extname::text FROM pg_catalog.pg_extension AS e
	WHERE e.extname::text NOT IN ('plpgsql', 'vector')
	UNION ALL SELECT 'missing extension vector' WHERE NOT EXISTS (
		SELECT FROM pg_catalog.pg_extension AS e WHERE e.extname = 'vector'::name
			AND e.extnamespace = pg_catalog.to_regnamespace('vector_ext'))
	UNION ALL SELECT 'relation public.' || c.relname::text FROM pg_catalog.pg_class AS c
	WHERE c.relnamespace = pg_catalog.to_regnamespace('public')
	UNION ALL SELECT 'routine public.' || p.proname::text FROM pg_catalog.pg_proc AS p
	WHERE p.pronamespace = pg_catalog.to_regnamespace('public')
	UNION ALL SELECT 'type public.' || t.typname::text FROM pg_catalog.pg_type AS t
	WHERE t.typnamespace = pg_catalog.to_regnamespace('public') AND t.typrelid = 0::oid AND t.typcategory <> 'A'
	UNION ALL SELECT 'privileges on schema public' FROM pg_catalog.pg_namespace AS n
	WHERE n.nspname = 'public'::name
		AND n.nspacl::text IS DISTINCT FROM '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}'
	UNION ALL SELECT 'database setting ' || pg_catalog.array_to_string(s.setconfig, ', ')
	FROM pg_catalog.pg_db_role_setting AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.setdatabase
	WHERE d.datname = pg_catalog.current_database()
		AND (s.setrole <> 0::oid OR NOT (s.setconfig @> $1::text[] AND s.setconfig <@ $1::text[]))
	UNION ALL SELECT 'missing test database settings' WHERE NOT EXISTS (
		SELECT FROM pg_catalog.pg_db_role_setting AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.setdatabase
		WHERE d.datname = pg_catalog.current_database() AND s.setrole = 0::oid)
	UNION ALL SELECT 'database privileges or options' FROM pg_catalog.pg_database AS d
	WHERE d.datname = pg_catalog.current_database() AND (
		d.datistemplate OR NOT d.datallowconn OR d.datconnlimit <> -1
		OR (d.datacl IS NOT NULL AND NOT (
			d.datacl @> pg_catalog.acldefault('d', d.datdba) AND d.datacl <@ pg_catalog.acldefault('d', d.datdba))))
	UNION ALL SELECT 'default privileges of ' || a.defaclrole::regrole::text FROM pg_catalog.pg_default_acl AS a
	WHERE a.defaclnamespace = 0::oid
) AS l ORDER BY 1`

/**
 * A check of a database: the statement that reads what is wrong with it, and the reading of its rows, one line for each
 * thing wrong, none when the database is as it should be.
 */
export interface Check {
	readonly statement: PgStatement
	readonly read: (rows: ReadonlyArray<ReadonlyArray<unknown>>) => ReadonlyArray<string>
}

/** What a test left in a database: everything a clean test database does not contain (leftoversQuery). */
export const leftoversCheck: Check = {
	statement: {
		sql: leftoversQuery,
		params: [Arr.map(testDatabaseSettings, ([setting, value]) => `${setting}=${value}`)]
	},
	read: (rows) => Arr.map(rows, ([what]) => String(what))
}

/**
 * Two effects of installing a schema reach past it, by design, and outlive the file's schemas:
 * - btree_gist is created outside the installed schema, because it must outlive every installed schema
 *   (packages/engine/src/physical/ddl/context.ts), and probes create it in a schema of their own;
 * - the installer revokes PUBLIC's global default privileges on the owner's future functions and types, which a
 *   per-schema default cannot.
 * Once the file's schemas are gone the release undoes both: it drops every extension the template does not carry,
 * with the extension's schema when that is not the template's and is left empty, and grants the owner's global
 * defaults back to PUBLIC. `leftoversCheck` then judges what remains.
 */
export const undoInstallEffects = (admin: PgConnection): Effect.Effect<void> =>
	Effect.gen(function* () {
		const extensions = yield* admin.queryValues(
			"SELECT e.extname::text, n.nspname::text FROM pg_catalog.pg_extension AS e JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace WHERE e.extname::text NOT IN ('plpgsql', 'vector') ORDER BY 1",
			[]
		)
		for (const [extension, schema] of extensions) {
			yield* admin.query(`DROP EXTENSION ${quoteIdent(String(extension))}`, [])
			if (schema !== "public" && schema !== "vector_ext") {
				yield* Effect.ignore(admin.query(`DROP SCHEMA ${quoteIdent(String(schema))}`, []))
			}
		}
		const defaults = yield* admin.queryValues(
			"SELECT 1 FROM pg_catalog.pg_default_acl WHERE defaclrole = CURRENT_USER::regrole AND defaclnamespace = 0::oid",
			[]
		)
		if (defaults.length === 0) {
			return
		}
		yield* admin.query("ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC", [])
		yield* admin.query("ALTER DEFAULT PRIVILEGES GRANT USAGE ON TYPES TO PUBLIC", [])
	}).pipe(Effect.ignore)

/** A column's text as pg hands it over, unparsed. */
const asText = (text: string): string => text

/** Every column as its text: pg's parsers bypassed. */
const textTypes = { getTypeParser: (): ((text: string) => string) => asText } as const

/** A bootstrap superuser's connection (superuserClient): its statements, each answering its rows, every column its text. */
export interface SuperuserClient {
	/** One statement and its parameters, its answer awaited as a checked wait on the client's backend (pg.ts awaitingBackend). */
	readonly query: (
		sql: string,
		params: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<string | null>>, SqlError>
}

/**
 * A connection to `database` as the bootstrap superuser, the account's own user, over the member's socket, which trusts
 * it (env.ts adminUrl); the TLS sessions of test/support/pg.ts reach no superuser. It lives for the scope, drawing one
 * of its budget's permits; a connection refused is a failure its caller makes a defect of the run. Its connect awaits
 * PostgreSQL as a trusted declared wait (pg.ts awaitingUnchecked), and every statement as a checked one on its backend
 * (pg.ts awaitingBackend): what the substrate's superuser statements and reads (substrate.ts asSuperuser,
 * asSuperuserRead) and the toolchain's resources (runner.ts superuserSession) send.
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
					return Effect.as(
						awaitingUnchecked(`connect as the superuser to ${database}`)(
							Effect.tryPromise({ try: () => c.connect(), catch: sqlErrorOf })
						),
						c
					)
				}),
				(c) => Effect.promise(() => c.end())
			)
		),
		(c): SuperuserClient => {
			const answer = (sql: string, params: ReadonlyArray<string>) =>
				Effect.map(
					Effect.tryPromise({
						try: () => c.query({ text: sql, values: [...params], rowMode: "array" }),
						catch: sqlErrorOf
					}),
					(result) => trusted<ReadonlyArray<ReadonlyArray<string | null>>>(result.rows)
				)
			const pid = backendOf(c)
			return { query: (sql, params) => awaitingBackend(cluster, pid, sql)(answer(sql, params)) }
		}
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
 * Drops `name` on `admin`, terminating its sessions, after the logical replication slots of its installations' live
 * sources, which PostgreSQL refuses to drop a database under (55006), each leader streaming from one terminated first. The sweep's alone: DROP DATABASE holds its transaction id while it
 * waits for the checkpoint it forces, which pins every SERIALIZABLE snapshot's xmin meanwhile and makes PostgreSQL
 * summarize the other files' committed transactions (test/support/pg.ts freshDatabase), so nothing drops a database
 * while a test file runs.
 */
const dropDatabase = (admin: PgConnection, name: string): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		yield* admin.query(
			"SELECT pg_catalog.pg_terminate_backend(active_pid) FROM pg_catalog.pg_replication_slots WHERE database = $1::name AND active_pid IS NOT NULL",
			[name]
		)
		yield* admin.query(
			"SELECT pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots WHERE database = $1::name",
			[name]
		)
		yield* admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`, [])
	})

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
