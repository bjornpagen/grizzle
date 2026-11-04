import { Array as Arr, Config, Effect, Exit, Fiber, Option, Scope } from "effect"
import { trusted } from "#compiler/core/trusted.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { InitializedCluster, type InitializedClusterShape } from "#test/support/cluster.ts"
import {
	devSession,
	ensureDatabase,
	type PgConnection,
	type SqlError,
	testDatabaseSettings
} from "#test/support/pg.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { allocatingPid } from "#test/support/substrate/names.ts"
import { connect, ownerCredentials } from "#test/support/substrate/session.ts"
import { networkWorkers } from "#test/support/substrate/workers.ts"

import { regex } from "arkregex"
const claimKey = 1735289960
const claimStatement = "SELECT pg_catalog.pg_try_advisory_lock($1::int4, $2::int4)"

/** The positive decimal integer an environment variable names, read through Config; none when unset or anything else. */
const positiveEnv = (name: string): Option.Option<number> =>
	Option.flatMap(Effect.runSync(Effect.orDie(Config.option(Config.String(name)))), (value) =>
		regex("^[1-9][0-9]*$").test(value) ? Option.some(Number(value)) : Option.none()
	)

export const sharedDatabase = (index: number): string => `gz_shared_${index}`

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

export const leftovers = (admin: PgConnection): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.map(
		admin.queryValues(leftoversQuery, [
			Arr.map(testDatabaseSettings, ([setting, value]) => `${setting}=${value}`)
		]),
		(rows) => Arr.map(rows, ([what]) => String(what))
	)

/**
 * Two effects of installing a schema reach past it, by design, and outlive the file's schemas:
 * - btree_gist is created outside the installed schema, because it must outlive every installed schema
 *   (packages/engine/src/physical/ddl/context.ts), and probes create it in a schema of their own;
 * - the installer revokes PUBLIC's global default privileges on the owner's future functions and types, which a
 *   per-schema default cannot.
 * Once the file's schemas are gone the release undoes both: it drops every extension the template does not carry,
 * with the extension's schema when that is not the template's and is left empty, and grants the owner's global
 * defaults back to PUBLIC. `leftovers` then judges what remains.
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

/**
 * The cluster-wide connection lease. max_connections is the cluster's, not a run's: two runs, a run and an agent's
 * copy of the tree, or a bench beside a run all share it. So every process that opens test connections first takes a
 * lease, one of `leaseSlots` session-level advisory locks (leaseKey, i) in the owner's own database, held on a
 * connection of its own until the process exits, and a lease covers `connectionsPerLease` connections: the busiest test
 * file's peak plus its lease connection. The slots are max_connections less the reserved connections
 * and `unleasedConnections`, divided by the lease's width, read from the server each time, so a cluster with more
 * connections admits more processes. A process with every slot taken waits on a slot's lock in the server, never on a
 * timer; runs beside each other may start more files than there are leases, and they wait their turn.
 */
const leaseKey = 1735289961
export const connectionsPerLease = 12
/** Connections no lease covers: the global setup, the doctor, the sweep, and an operator's psql. */
const unleasedConnections = 5

const leaseSlotsQuery = `SELECT GREATEST(1, (pg_catalog.current_setting('max_connections')::int4
	- pg_catalog.current_setting('superuser_reserved_connections')::int4
	- pg_catalog.current_setting('reserved_connections')::int4 - $1::int4) / $2::int4)`

/** Takes a slot on `lock`: the first free one, else waits in the server for the slot this process's id names. */
const takeLease = (lock: PgConnection): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const [row] = yield* lock.queryValues(leaseSlotsQuery, [
			unleasedConnections,
			connectionsPerLease
		])
		const [slots] = trusted<readonly [slots: number]>(row)
		for (let slot = 0; slot < slots; slot++) {
			const [[taken] = []] = yield* lock.queryValues(claimStatement, [leaseKey, slot])
			if (taken === true) {
				return
			}
		}
		yield* lock.queryValues("SELECT pg_catalog.pg_advisory_lock($1::int4, $2::int4)", [
			leaseKey,
			process.pid % slots
		])
	})

/**
 * This process's lease, taken by the first substrate it builds and held until it exits: its connection lives in a
 * scope nothing closes, and the process's exit closes it. The taking is a root fiber of its own, under none of its
 * first caller's services (a suite's TestClock never governs it) and interrupted by no caller; every caller joins it.
 * A file waiting for a free slot behind other processes waits as long as they hold the slots, inside its suite's layer
 * build, whose hook the network config leaves unbounded for that reason; a run alone never waits, since it runs fewer
 * files at once than there are slots (workers.ts).
 */
let lease = Option.none<Fiber.Fiber<void, SqlError>>()

export const leaseConnections: Effect.Effect<void, SqlError, InitializedCluster> = Effect.flatMap(
	Effect.service(InitializedCluster),
	(cluster) =>
		Effect.suspend(() => {
			if (Option.isSome(lease)) {
				return Fiber.join(lease.value)
			}
			const taking = Effect.runFork(
				Effect.flatMap(Scope.make(), (scope) =>
					Scope.provide(
						Effect.flatMap(devSession(cluster, Option.some("grizzle-substrate lease")), takeLease),
						scope
					)
				)
			)
			lease = Option.some(taking)
			return Fiber.join(taking)
		})
)

export interface SharedClaim {
	readonly database: string
	/** An owner connection to the database. */
	readonly admin: PgConnection
}

/**
 * An owner connection to a shared database in a child scope, which `disconnect` closes, and whether the database was
 * already there or the connection cloned it from the template first (3D000).
 */
interface SharedConnection {
	readonly admin: PgConnection
	readonly disconnect: Effect.Effect<void>
	readonly origin: "existing" | "cloned"
}

const connectShared = (
	cluster: InitializedClusterShape,
	scope: Scope.Scope,
	database: string
): Effect.Effect<SharedConnection, SqlError> =>
	Effect.gen(function* () {
		const child = yield* Scope.fork(scope)
		const open = connect(cluster, {
			database,
			credentials: ownerCredentials(cluster),
			label: "admin"
		})
		const opened = yield* Scope.provide(
			open.pipe(
				Effect.map((admin) => ({ admin, origin: "existing" as const })),
				Effect.catchIf(
					(error) => pgErrorFields(error)?.code === "3D000",
					() =>
						Effect.andThen(
							ensureDatabase(cluster, database),
							Effect.map(open, (admin) => ({ admin, origin: "cloned" as const }))
						)
				)
			),
			child
		)
		return { ...opened, disconnect: Scope.close(child, Exit.void) }
	})

/**
 * Clones shared database `index` from the template when it is missing and gives it the test database settings, under
 * its claim, which the global setup takes for each worker's database. The sweep drops a shared database only under its
 * claim too, so another run's sweep never drops one this setup is configuring; one another file or run holds exists
 * and is left as it is.
 */
export const ensureSharedDatabase = (
	index: number
): Effect.Effect<void, SqlError, InitializedCluster> =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* InitializedCluster
			const lock = yield* devSession(cluster, Option.some("grizzle-substrate claim"))
			const [[claimed] = []] = yield* lock.queryValues(claimStatement, [claimKey, index])
			if (claimed === true) {
				yield* ensureDatabase(cluster, sharedDatabase(index))
			}
		})
	)

/**
 * The shared test databases, and the sweep that removes what crashed runs left on the cluster.
 *
 * Cloning the template copies about 300 files and dropping the clone unlinks them, so test files do not clone a
 * database each. The cluster keeps a few long-lived databases, `gz_shared_1`, `gz_shared_2`, ..., each cloned from the
 * template once and reused by file after file, across runs (Tests and gates).
 * Files stay apart through unique schema and role names (names.ts), whose finalizers drop them. A file that needs a
 * pristine database of its own builds Substrate.isolatedLayer instead.
 *
 * Vitest runs each file in a process of its own, at most W at once (vitest.network.config.ts maxWorkers, W the constant
 * networkWorkers, workers.ts), and numbers the workers running them 1 to W in VITEST_POOL_ID; the run's global setup
 * clones `gz_shared_1` to `gz_shared_W` once. So a file uses the database of its worker, `gz_shared_<VITEST_POOL_ID>`.
 * A claim still takes the session-level advisory lock (claimKey, n) on a connection to the owner's own database, held
 * for the file's life, as a safety net: when another claim holds the worker's database (a second substrate in the same
 * file, or another run on the cluster) it takes the smallest n above W no other claim holds, cloning the database when
 * it does not exist yet. Two runs on one cluster never share a database at once, and a process outside a Vitest worker
 * (a bench) has no worker and claims above W. The claimed database must be clean, as `leftovers` defines it: a dirty
 * one is passed over for the next index and left for the sweep, the one place a database is dropped, and a file that
 * leaves anything behind fails when its substrate is released.
 *
 * Claims a clean shared database for the current scope: the worker's, else the smallest index above W, the worker's
 * excepted, whose claim is free and whose database is clean, cloned when it does not exist. A dirty database, which a
 * file that crashed or failed its release left something in, is never handed out and never dropped here: the claim
 * lets it go and tries the next index, and the sweep drops it once no file runs. A fresh clone that is not clean means
 * the template differs from what `leftovers` expects, a defect of this file, not of a test.
 */
export const claimSharedDatabase: Effect.Effect<
	SharedClaim,
	SqlError,
	Scope.Scope | InitializedCluster
> = Effect.gen(function* () {
	const scope = yield* Effect.scope
	const cluster = yield* InitializedCluster
	const lock = yield* devSession(cluster, Option.some("grizzle-substrate claim"))
	const worker = positiveEnv("VITEST_POOL_ID")
	const above = networkWorkers + 1
	/** The n-th index a claim tries: the worker's, then every index above W. */
	const tried = (n: number): number =>
		Option.match(worker, { onNone: () => above + n, onSome: (w) => (n === 0 ? w : above + n - 1) })
	for (let n = 0; ; n++) {
		const index = tried(n)
		if (n > 0 && Option.contains(worker, index)) {
			continue
		}
		const [[claimed] = []] = yield* lock.queryValues(claimStatement, [claimKey, index])
		if (claimed !== true) {
			continue
		}
		const database = sharedDatabase(index)
		const connection = yield* connectShared(cluster, scope, database)
		const dirty = yield* leftovers(connection.admin)
		if (dirty.length === 0) {
			return { database, admin: connection.admin }
		}
		if (connection.origin === "cloned") {
			return yield* Effect.die(
				new Error(`a fresh clone of the template is not clean: ${Arr.join(dirty, "; ")}`)
			)
		}
		yield* connection.disconnect
		yield* lock.queryValues("SELECT pg_catalog.pg_advisory_unlock($1::int4, $2::int4)", [
			claimKey,
			index
		])
	}
})

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
 * Drops `name` on `admin`, terminating its sessions. The sweep's alone: DROP DATABASE holds its transaction id while it
 * waits for the checkpoint it forces, which pins every SERIALIZABLE snapshot's xmin meanwhile and makes PostgreSQL
 * summarize the other files' committed transactions (test/support/pg.ts freshDatabase), so nothing drops a database
 * while a test file runs.
 */
const dropDatabase = (admin: PgConnection, name: string): Effect.Effect<void, SqlError> =>
	Effect.asVoid(admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`, []))

/**
 * Whether every test file process `pid` ran has ended: it is this process, which calls the sweep only when no test file
 * of its own runs, or a process no longer running.
 */
const ended = (pid: number): boolean => pid === process.pid || !running(pid)

/**
 * Drops what ended test processes left on the cluster: their gz_t_ and gz_doctor_ databases, their `<schema>__<access>`
 * roles, and every unclaimed shared database that is not clean. A run in progress is never touched: its processes are
 * running, and its shared databases are claimed. It is the one place a database is dropped, and its callers call it
 * only when no test file of their own runs: the network run's global setup, before any file starts, and its teardown,
 * once every file has ended (pg-global-setup.ts), both in Vitest's own process, whose test files each ran in a process
 * of their own; and a bench runner when its last gate has run, its own databases then ended too. `dropRole` is the
 * substrate's.
 */
export const sweep = (
	dropRole: (admin: PgConnection, role: string) => Effect.Effect<void, SqlError>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* InitializedCluster
			const admin = yield* devSession(cluster, Option.none())
			const databases = yield* admin.queryValues(
				"SELECT datname::text FROM pg_catalog.pg_database WHERE datname::text ~ '^gz_(t|doctor|shared)_' ORDER BY 1",
				[]
			)
			for (const [value] of databases) {
				const database = String(value)
				const pid = regex("^gz_(?:t|doctor)_([0-9]+)").exec(database)?.[1]
				if (pid !== undefined) {
					if (ended(Number(pid))) {
						yield* Effect.ignore(dropDatabase(admin, database))
					}
					continue
				}
				/** A shared database no file claims and that is not clean, or a name claimSharedDatabase never uses. */
				const index = regex("^gz_shared_([1-9][0-9]*)$").exec(database)?.[1]
				if (index === undefined) {
					yield* Effect.ignore(dropDatabase(admin, database))
					continue
				}
				const [[claimed] = []] = yield* admin.queryValues(claimStatement, [claimKey, Number(index)])
				if (claimed !== true) {
					continue
				}
				const dirty = yield* Effect.scoped(
					Effect.flatMap(
						connect(cluster, { database, credentials: ownerCredentials(cluster), label: "sweep" }),
						leftovers
					)
				).pipe(
					Effect.map((left) => left.length > 0),
					Effect.orElseSucceed(() => true)
				)
				if (dirty) {
					yield* Effect.ignore(dropDatabase(admin, database))
				}
				yield* admin.queryValues("SELECT pg_catalog.pg_advisory_unlock($1::int4, $2::int4)", [
					claimKey,
					Number(index)
				])
			}
			const roles = yield* admin.queryValues(
				"SELECT rolname::text FROM pg_catalog.pg_roles WHERE strpos(rolname::text, '__') > 0 ORDER BY 1",
				[]
			)
			for (const [value] of roles) {
				const role = String(value)
				if (Option.exists(allocatingPid(role), ended)) {
					yield* Effect.ignore(dropRole(admin, role))
				}
			}
		})
	)
