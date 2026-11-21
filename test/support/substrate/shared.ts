import { waitingOn } from "@bjornpagen/testing/live"
import type { PgMember } from "@bjornpagen/testing/pg"
import { regex } from "arkregex"
import { Array as Arr, Effect, Exit, Option, Scope, String as Str } from "effect"
import { Client } from "pg"
import { installationRoleOf } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { InitializedCluster, lentVariable } from "#test/support/cluster.ts"
import { adminUrl } from "#test/support/env.ts"
import {
	devSession,
	type PgConnection,
	type SqlError,
	sqlErrorOf,
	type PgStatement,
	testDatabaseSettings
} from "#test/support/pg.ts"
import { type BudgetedCluster, budgeted, leaseBudget } from "#test/support/substrate/budget.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import {
	type LeaseTables,
	leaseGrant,
	leaseSlots,
	leaseTableNames,
	substrateLease,
	unleasedSessions
} from "#test/support/substrate/lease.ts"
import { allocatingPid } from "#test/support/substrate/names.ts"
import { upTo } from "#test/support/up-to.ts"

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

export const leftovers = (admin: PgConnection): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.map(
		admin.queryValues(leftoversCheck.statement.sql, leftoversCheck.statement.params),
		leftoversCheck.read
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

/** A column's text as pg hands it over, unparsed. */
const asText = (text: string): string => text

/** Every column as its text: pg's parsers bypassed. */
const textTypes = { getTypeParser: (): ((text: string) => string) => asText } as const

/**
 * A connection to `database` as the bootstrap superuser `postgres`, over the cluster's local socket, where peer
 * authentication maps this OS user to it (@bjornpagen/testing/pg's hba); the TLS sessions of test/support/pg.ts reach no
 * superuser. It lives for the scope, drawing one of its budget's permits; a connection refused is a failure its caller
 * makes a defect of the run.
 */
export const superuserClient = (
	cluster: BudgetedCluster,
	database: string,
	applicationName: string
) =>
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
	)

/** The three settings leaseSlots reads, from the server a lease is taken on. */
const slotSettingsQuery = `SELECT pg_catalog.current_setting('max_connections')::int4,
	pg_catalog.current_setting('superuser_reserved_connections')::int4,
	pg_catalog.current_setting('reserved_connections')::int4`

/** A lease table's name as a statement names it, in the owner's own database's public schema. */
const leaseTable = (name: string): string => `public.${quoteIdent(name)}`

/**
 * Whether grizzle's own setup of a member is whole, as the owner's session reads it, which the testing library's
 * making of the member leaves out: every name of its parameter names a table in the owner's own database's public
 * schema (the lease's tables). The owner's SET on the parameters grizzle's tests set is the spec's (pg.config.ts
 * ownerParameters), which the library's making grants.
 */
const setUpQuery = `SELECT NOT EXISTS (SELECT FROM pg_catalog.unnest($1::text[]) AS t
		WHERE pg_catalog.to_regclass(pg_catalog.format('public.%I', t)) IS NULL)`

/**
 * The member setup's lock: a transaction-level advisory lock in the owner's own database, which a lease that finds
 * grizzle's setup of its member missing holds while it makes it, so two first leases on a member never create one
 * table at once (CREATE TABLE IF NOT EXISTS of one name at once fails one of them on pg_type's unique index).
 */
const memberSetupKey = 1735289963

/**
 * grizzle's own setup of the member `initialized`, which the testing library's making of a cluster leaves out: the
 * lease's tables `names`, owned by the owner. The owner's session `session` reads whether it is whole (setUpQuery);
 * when it is not, the bootstrap superuser makes all of it in the owner's own database, in one transaction under the setup lock (memberSetupKey), the tables as the owner: what the first
 * lease on a member does. A lease that finds nothing missing takes no lock, so only the first leases on a member, or
 * those after a member grows past the slots its tables cover, wait on it; the wait is a declared one (waitingOn), behind
 * a holder that only creates tables.
 */
const ensureMemberSetUp = (
	initialized: PgMember,
	session: PgConnection,
	names: ReadonlyArray<string>
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const [[whole] = []] = yield* session.queryValues(setUpQuery, [names])
		if (whole === true) {
			return
		}
		yield* Effect.scoped(
			Effect.gen(function* () {
				const admin = yield* superuserClient(
					budgeted(initialized, leaseBudget(1)),
					initialized.owner,
					"grizzle-member setup"
				)
				const run = (sql: string, params: ReadonlyArray<unknown>) =>
					Effect.tryPromise({ try: () => admin.query(sql, [...params]), catch: sqlErrorOf })
				const owner = quoteIdent(initialized.owner)
				yield* run("BEGIN", [])
				yield* waitingOn(run("SELECT pg_catalog.pg_advisory_xact_lock($1::int8)", [memberSetupKey]))
				yield* run(`SET LOCAL ROLE ${owner}`, [])
				yield* Effect.forEach(
					names,
					(name) => run(`CREATE TABLE IF NOT EXISTS ${leaseTable(name)} ()`, []),
					{ discard: true }
				)
				yield* run("COMMIT", [])
			})
		)
	})

/**
 * Locks the lease table `table` IN EXCLUSIVE MODE in a transaction left open on `lock`: true when it is taken, false
 * when another process holds it (55P03, lock_not_available), the transaction then rolled back. A table that does not
 * exist fails the lease (42P01): its lease made none (ensureMemberSetUp).
 */
const tryLock = (lock: PgConnection, table: string): Effect.Effect<boolean, SqlError> =>
	Effect.gen(function* () {
		yield* lock.query("BEGIN", [])
		return yield* lock.query(`LOCK TABLE ${leaseTable(table)} IN EXCLUSIVE MODE NOWAIT`, []).pipe(
			Effect.as(true),
			Effect.catchIf(
				(error) => pgErrorFields(error)?.code === "55P03",
				() => Effect.as(lock.query("ROLLBACK", []), false)
			)
		)
	})

/**
 * Locks `table` IN EXCLUSIVE MODE in a transaction left open on `lock`, waiting in the server behind every process
 * queued for it. It tries NOWAIT first, so the wait's one catalog read, the table by its name, is answered from the
 * backend's caches: a read past them would take a catalog snapshot and hold the backend's xmin while it waits. The wait
 * is a declared one (@bjornpagen/testing/live waitingOn), the one place a lease waits: a slot's holder is another
 * process's lease, a guarded runner worker or Vitest file of this run or another, or a backend PostgreSQL ends once its
 * client is gone, so the wait always ends, and no guard charges it to the case or the need's open that asked for the
 * lease (SELECTWHOLE: thirteen kill trials' first cases ended as stalled behind other runs' slots).
 */
const awaitLock = (lock: PgConnection, table: string): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		if (yield* tryLock(lock, table)) {
			return
		}
		yield* lock.query("BEGIN", [])
		yield* waitingOn(lock.query(`LOCK TABLE ${leaseTable(table)} IN EXCLUSIVE MODE`, []))
	})

/**
 * Takes one of `slots` slots of `tables` and returns the connection that holds it, open in the current scope, whose
 * close frees the slot. `open` opens a connection to the owner's own database in the scope it runs in.
 *
 * A slot is its table locked IN EXCLUSIVE MODE by a transaction left open. The file takes the first free slot NOWAIT.
 * With every slot held it queues at the gate, whose lock waiting files take in the order they asked; the gate's holder,
 * the head, races every slot at once, a connection queued on each, and takes the first to free, so no file waits behind
 * one long holder while other slots turn over, and a slot that frees while files wait is granted to the head within the
 * same release. The head closes its other race connections, cancelling their waits, and gives up the gate to the next
 * file. Nothing waits on a timer.
 *
 * Neither a lease nor a wait for one holds a transaction id, and none holds a snapshot unless its backend's catalog
 * caches were reset between its NOWAIT try and its wait (awaitLock): LOCK takes no snapshot (PostgreSQL's pquery.c
 * PlannedStmtRequiresSnapshot), and a lock below ACCESS EXCLUSIVE is logged for no standby, so it assigns no transaction
 * id. So no lease holds back the cluster's vacuum horizon, and none takes part in SSI.
 */
const takeLease = (
	open: Effect.Effect<PgConnection, SqlError, Scope.Scope>,
	tables: LeaseTables,
	slots: number
): Effect.Effect<PgConnection, SqlError, Scope.Scope> =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const queued = yield* Scope.fork(scope)
		const lease = yield* Scope.provide(open, queued)
		for (let slot = 0; slot < slots; slot++) {
			if (yield* tryLock(lease, tables.slot(slot))) {
				return lease
			}
		}
		yield* awaitLock(lease, tables.gate)
		const racers: Array<Scope.Closeable> = []
		const won = yield* Effect.raceAllFirst(
			upTo(slots, (slot) =>
				Effect.gen(function* () {
					const racer = yield* Scope.fork(scope)
					racers.push(racer)
					const lock = yield* Scope.provide(open, racer)
					yield* awaitLock(lock, tables.slot(slot))
					return { racer, lock }
				})
			)
		)
		yield* Effect.forEach(
			Arr.filter(racers, (racer) => racer !== won.racer),
			(racer) => Scope.close(racer, Exit.void),
			{ discard: true }
		)
		yield* Scope.close(queued, Exit.void)
		return won.lock
	})

/**
 * A lease a substrate holds: the connection that holds its slot, and the cluster with the budget the lease grants its
 * file, of leaseGrant permits, which every connection the file opens after it draws from.
 */
export interface Lease {
	readonly cluster: BudgetedCluster
	/** The backends that hold the place: the lease's own connection, none for a place a parent lent. */
	readonly held: ReadonlyArray<number>
}

/**
 * A lease on `initialized`, held for the current scope: a slot of the cluster's (takeLease over substrateLease, the
 * slots leaseSlots gives the server's settings, their tables made first when absent: ensureMemberSetUp), whose
 * connection it returns with the budget it grants. The scope's
 * close ends that connection, and so frees the slot. A lease covers one holder's connections (connectionsPerLease): a
 * Vitest file's substrate (leaseConnections), or a runner worker for its life (test/support/runner.ts), so a process
 * holds none once its holders are released: nothing of the lease outlives them, so a process whose work is done exits.
 * A holder waiting for a free slot behind other processes waits as long as they hold the slots; a run alone never waits
 * on a member pg.config.ts sized, which holds a slot for each worker it serves (connectionsPerWorker).
 *
 * The lease's own connections draw from budgets of their own: the read of the settings, one connection; then the
 * lease's, its queued connection and one racer for each slot at most (takeLease), the one it wins held for the scope.
 */
export const leaseOn = (initialized: PgMember): Effect.Effect<Lease, SqlError, Scope.Scope> =>
	Effect.gen(function* () {
		const name = Option.some("grizzle-substrate lease")
		const slots = yield* Effect.scoped(
			Effect.gen(function* () {
				const settings = yield* devSession(budgeted(initialized, leaseBudget(1)), name)
				const [row] = yield* settings.queryValues(slotSettingsQuery, [])
				const [maxConnections, superuserReserved, reserved] =
					trusted<readonly [maxConnections: number, superuserReserved: number, reserved: number]>(
						row
					)
				const admitted = leaseSlots(maxConnections, superuserReserved, reserved)
				yield* ensureMemberSetUp(initialized, settings, leaseTableNames(substrateLease, admitted))
				return admitted
			})
		)
		const connection = yield* takeLease(
			devSession(budgeted(initialized, leaseBudget(slots + 1)), name),
			substrateLease,
			slots
		)
		return {
			cluster: budgeted(initialized, leaseBudget(leaseGrant)),
			held: [connection.processId]
		}
	})

/**
 * A Vitest file's substrate's lease (leaseOn), on the member InitializedCluster names. A substrate waiting for a free
 * slot waits inside its layer build, whose hook the network config leaves unbounded for that reason.
 */
export const leaseConnections: Effect.Effect<Lease, SqlError, InitializedCluster | Scope.Scope> =
	Effect.flatMap(InitializedCluster, leaseOn)

/**
 * A child process's place, lent by a case (substrate.ts Substrate.lentLayer): `width` of the permits of the case's
 * budget set aside for the current scope (LeaseBudget within), and the environment that names them, the case's member
 * and its database to the child (cluster.ts lentVariable), whose connections draw from them without a lease of their
 * own. LeaseBudgetExhausted, a defect, when fewer are free.
 */
export const lend = (
	place: Readonly<{ cluster: BudgetedCluster; database: string }>,
	width: number
): Effect.Effect<Readonly<Record<string, string>>, never, Scope.Scope> =>
	Effect.as(place.cluster.budget.within(width), {
		[lentVariable]: `${place.cluster.port}:${width}:${place.database}`
	})

/** The initialised cluster with a budget of the sweep's sessions outside every lease, each it holds at once (unleasedSessions). */
const swept: Effect.Effect<BudgetedCluster, never, InitializedCluster> = Effect.map(
	InitializedCluster,
	(cluster) => budgeted(cluster, leaseBudget(unleasedSessions.sweep.length))
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
 * The sweep's lock: a session-level advisory lock in the owner's own database, which each sweep holds on its session
 * from its first read to its end.
 */
const sweepKey = 1735289962

/**
 * Drops what ended processes left on the cluster: their gz_t_ databases, their `<schema>__<access>` roles and every
 * role an installation at its stems on one of their allocations creates (core/identity.ts installationRoleOf: its live
 * source's decoder login and its function owner, which carry no allocation, so they are read off the allocation). A run in progress is never touched: its processes are
 * running. Its callers call it only when no database of their own is in use: a bench runner when its last gate has
 * run, its own databases then ended too. The gz_shared_ databases a test file shared before every test ran on the
 * toolchain's runner are no gz_t_ name and are left as they are. Runs beside each other
 * sweep at once, and an ended process's leftovers are every sweep's to drop, so each sweep waits for the sweep lock
 * (sweepKey) before it reads: sweeps run one at a time, each leftover is dropped by exactly one of them, and the next
 * reads it gone. `dropRole` is the substrate's.
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
			yield* admin.queryValues("SELECT pg_catalog.pg_advisory_lock($1::int8)", [sweepKey])
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
