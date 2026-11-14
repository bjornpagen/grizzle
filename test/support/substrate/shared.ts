import { Array as Arr, Config, Effect, Exit, Option, Scope, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import {
	blockSize,
	derived,
	type Limit,
	measured,
	postgresSource,
	published
} from "#compiler/core/limits.ts"
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
import { upTo } from "#test/support/up-to.ts"

import { regex } from "arkregex"
import { testPoolMax } from "#test/support/limits.ts"
const claimKey = 1735289960
const claimStatement = "SELECT pg_catalog.pg_try_advisory_lock($1::int4, $2::int4)"

/** The positive decimal integer an environment variable names, read through Config; none when unset or anything else. */
const positiveEnv = (name: string): Option.Option<number> =>
	Option.flatMap(Effect.runSync(Effect.orDie(Config.option(Config.String(name)))), (value) =>
		regex("^[1-9][0-9]*$").test(value) ? Option.some(Number(value)) : Option.none()
	)

const sharedDatabase = (index: number): string => `gz_shared_${index}`

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
 * The sessions a substrate holds for its life: its lease's, its shared database's claim's, that database's owner's, and
 * the observer's that reads other backends' lock waits (substrate.ts build). The claim has a session of its own: the
 * lease's runs only LOCK, inside the transaction that holds its slot, and a query there would keep its snapshot in the
 * open portal (the extended protocol drops a transaction's unnamed portal only at its next Bind or the transaction's
 * end), holding the backend's xmin for the file's life.
 */
const substrateSessions = ["lease", "claim", "owner", "observer"] as const
/** The connections one test file may hold at once, which one lease covers: a test's full pool (testPoolMax, one
 * session per core) and the sessions its substrate holds. */
export const connectionsPerLease = testPoolMax + substrateSessions.length
/** Connections no lease covers: the global setup, the doctor, the sweep, and an operator's psql. */
const unleasedConnections = 5

/**
 * The lease slots a cluster of `maxConnections` connections, `superuserReserved` and `reserved` of them reserved,
 * admits. Each slot costs its lease's connections (connectionsPerLease) and one more, the connection the gate's head
 * races it with while every slot is held (takeLease), except the slot the head wins, whose race connection is its
 * lease's own: s × connectionsPerLease + (s − 1) fits the connections no lease covers set aside. takeLease reads the
 * three settings from the server it leases on, so a cluster with more connections admits more processes.
 */
export const leaseSlots = (
	maxConnections: number,
	superuserReserved: number,
	reserved: number
): number =>
	Math.max(
		1,
		Math.floor(
			(maxConnections - superuserReserved - reserved - unleasedConnections + 1) /
				(connectionsPerLease + 1)
		)
	)

/**
 * The installations on the local cluster outside the substrate's databases that serve live reads, each its own live
 * source, slot and walsender: qti-pie's and the dev database's.
 */
const standingInstallations = ["gr8des_qti", "the dev database"] as const

/**
 * The most live sources the local cluster serves at once, which its max_replication_slots and max_wal_senders hold:
 * one leader's slot and walsender per substrate's watched installation, which each substrate holds one of at a time,
 * so one per lease slot a cluster of `maxConnections`, `superuserReserved` and `reserved` connections admits
 * (leaseSlots), and one per standing installation. scripts/pg/init.sh sets both settings to it where they fall short,
 * and scripts/pg/doctor.sh checks them against it.
 */
export const liveSlotBound = (
	maxConnections: number,
	superuserReserved: number,
	reserved: number
): number => leaseSlots(maxConnections, superuserReserved, reserved) + standingInstallations.length

/** The three settings leaseSlots reads, from the server a lease is taken on. */
const slotSettingsQuery = `SELECT pg_catalog.current_setting('max_connections')::int4,
	pg_catalog.current_setting('superuser_reserved_connections')::int4,
	pg_catalog.current_setting('reserved_connections')::int4`

/**
 * A lease's tables in the owner's own database, by their names: one per slot, and the gate a file queues at while every
 * slot is held. The lease only locks them; whoever sets the lease up creates them first, so no lease creates a table
 * while another does: scripts/pg/init.sh creates the substrate's (substrateLeaseNames), and a test of the lease creates
 * its own, so it never takes one of the cluster's slots.
 */
export interface LeaseTables {
	readonly slot: (index: number) => string
	readonly gate: string
}

/** The lease tables named after `stem`: `<stem>_<index>` for each slot, and `<stem>_gate`. */
export const leaseTables = (stem: string): LeaseTables => ({
	slot: (index) => `${stem}_${index}`,
	gate: `${stem}_gate`
})

const substrateLease = leaseTables("substrate_lease")

/**
 * The substrate lease's tables a cluster of `maxConnections` connections, `superuserReserved` and `reserved` of them
 * reserved, needs: the gate and one for each of its slots (leaseSlots). scripts/pg/lease-tables.ts prints them, init.sh
 * creates them and doctor.sh requires every one.
 */
export const substrateLeaseNames = (
	maxConnections: number,
	superuserReserved: number,
	reserved: number
): ReadonlyArray<string> => [
	substrateLease.gate,
	...upTo(leaseSlots(maxConnections, superuserReserved, reserved), substrateLease.slot)
]

/** A lease table's name as a statement names it, in the owner's own database's public schema. */
const leaseTable = (name: string): string => `public.${quoteIdent(name)}`

/**
 * Locks the lease table `table` IN EXCLUSIVE MODE in a transaction left open on `lock`: true when it is taken, false
 * when another process holds it (55P03, lock_not_available), the transaction then rolled back. A table that does not
 * exist fails the lease (42P01): its cluster was set up without it.
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
 * backend's caches: a read past them would take a catalog snapshot and hold the backend's xmin while it waits.
 */
const awaitLock = (lock: PgConnection, table: string): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		if (yield* tryLock(lock, table)) {
			return
		}
		yield* lock.query("BEGIN", [])
		yield* lock.query(`LOCK TABLE ${leaseTable(table)} IN EXCLUSIVE MODE`, [])
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
export const takeLease = (
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
 * A substrate's lease, held for the current scope: a slot of the cluster's (takeLease over substrateLease, the slots
 * leaseSlots gives the server's settings), whose connection it returns. The scope's close ends that connection, and so
 * frees the slot. A lease covers one substrate's connections (connectionsPerLease), so each substrate a process builds
 * holds one while it lives, and a process holds none once its substrates are released: nothing of the lease outlives
 * them, so a process whose work is done exits. A substrate waiting for a free slot behind other processes waits as long
 * as they hold the slots, inside its layer build, whose hook the network config leaves unbounded for that reason; a run
 * alone never waits on a cluster init.sh sized, which holds a slot for each of its workers (clusterConnections).
 */
export const leaseConnections: Effect.Effect<
	PgConnection,
	SqlError,
	InitializedCluster | Scope.Scope
> = Effect.gen(function* () {
	const cluster = yield* InitializedCluster
	const open = devSession(cluster, Option.some("grizzle-substrate lease"))
	const slots = yield* Effect.scoped(
		Effect.gen(function* () {
			const settings = yield* open
			const [row] = yield* settings.queryValues(slotSettingsQuery, [])
			const [maxConnections, superuserReserved, reserved] =
				trusted<readonly [maxConnections: number, superuserReserved: number, reserved: number]>(row)
			return leaseSlots(maxConnections, superuserReserved, reserved)
		})
	)
	return yield* takeLease(open, substrateLease, slots)
})

/** PostgreSQL's source of its settings' defaults. */
const settingDefaults = `${postgresSource}/src/backend/utils/misc/guc_parameters.dat`

/** The connections PostgreSQL keeps for superusers alone, at its default, which scripts/pg/init.sh leaves as it is. */
const superuserReservedConnections = published({
	value: 3,
	owner: "PostgreSQL 19rc2",
	unit: "connections",
	scope: "the local cluster's superuser_reserved_connections, out of its max_connections",
	constraint: "configurable default",
	source: `${settingDefaults}#L2941`,
	quote: "boot_val => '3',",
	verified: "2026-11-14"
})

/** The connections PostgreSQL keeps for pg_use_reserved_connections, at its default, which init.sh leaves as it is. */
const reservedConnections = published({
	value: 0,
	owner: "PostgreSQL 19rc2",
	unit: "connections",
	scope: "the local cluster's reserved_connections, out of its max_connections",
	constraint: "configurable default",
	source: `${settingDefaults}#L2552`,
	quote: "boot_val => '0',",
	verified: "2026-11-14"
})

/**
 * The local cluster's max_connections, which scripts/pg/init.sh sets and scripts/pg/doctor.sh requires at least: a
 * slot for each of the run's workers (networkWorkers, one per core), each its lease's connections (connectionsPerLease)
 * and the gate head's race connection but one (leaseSlots), the connections no lease covers (unleasedConnections), and
 * the slots PostgreSQL reserves, at their defaults. leaseSlots over exactly this many connections is networkWorkers,
 * so a run alone never waits for a lease. The machine's cores are read here, where the bound acts, and enter no Limit.
 */
const clusterConnections: number =
	networkWorkers * (connectionsPerLease + 1) -
	1 +
	unleasedConnections +
	superuserReservedConnections.value +
	reservedConnections.value

/**
 * The largest database a network worker's files work in, measured: each worker's shared database, which file after
 * file reuses, as autovacuum leaves its catalogs between their schemas.
 */
const workerDatabaseBytes: Limit = measured({
	value: 38_916_935,
	owner: "grizzle's network test tier",
	unit: "bytes",
	scope:
		"one network worker's database: its shared database (gz_shared_<n>), or a file's own clone of the template, as pg_database_size reports it",
	evidence:
		"pg_database_size of every gz_ database on the local cluster: `SELECT datname, pg_database_size(oid) FROM pg_catalog.pg_database WHERE datname LIKE 'gz\\_%'`, as the bootstrap superuser (scripts/pg/ctl.sh admin)",
	observed: "one reading on 2026-11-14 at 00:44 UTC",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, the local PostgreSQL 19rc2 cluster (scripts/pg/pin.env), grizzle 1623175d",
	workload:
		"every network run on the cluster since its 19rc2 init on 2026-11-13, each worker's files reusing its shared database, six workers then",
	result:
		"gz_shared_1 to gz_shared_6: 32,981,519, 21,525,319, 22,524,743, 28,169,031, 35,558,215 and 38,916,935 bytes; the template is 7.7 MB, so a file's own clone starts smaller than any",
	decision:
		"the largest, gz_shared_6: a worker runs one file at a time, and a file works in one database, so this bounds the pages one worker's file reads. No headroom added: a database past it is unmeasured",
	revalidate:
		"a shared database that grows past it; a PostgreSQL repin; a test tier whose files install larger schemas or keep more rows; another machine"
})

/**
 * The pages one network worker's database holds, in PostgreSQL's blocks: its largest database, rounded up to whole
 * blocks.
 */
const workerBufferBlocks: Limit = derived({
	owner: "grizzle's network test tier (scripts/pg/init.sh)",
	unit: "blocks",
	scope:
		"the shared buffers one network worker's database fills, out of the local cluster's shared_buffers",
	from: [workerDatabaseBytes, blockSize],
	derivation:
		"a worker runs one file at a time, and a file works in one database, so the largest such database, in blocks rounded up, holds every page one worker's file reads",
	compute: ([database, block]) => Math.ceil(database.value / block.value)
})

/**
 * The local cluster's shared_buffers in blocks, which scripts/pg/init.sh sets and scripts/pg/doctor.sh requires at
 * least: one worker's database (workerBufferBlocks) for each of the run's workers (networkWorkers, one per core), every
 * page a run reads held at once. Not more: outside recovery PostgreSQL scans every shared buffer at each commit that
 * drops or truncates a relation (REL_19_RC2 bufmgr.c DropRelationsAllBuffers, whose cached-size path
 * smgrnblocks_cached takes only in recovery, smgr.c#L854), and a test drops its schemas in every release. On a
 * throwaway cluster on cassowary on 2026-11-14, one client's CREATE SCHEMA, three tables and DROP SCHEMA CASCADE took
 * 5.3 ms at 128 MB of shared buffers, 9.4 ms at 4 GB, 19.1 ms at 16 GB and 74.9 ms at a quarter of the machine's
 * memory, the documentation's starting point for a dedicated server. The machine's cores are read here and enter no
 * Limit.
 */
const clusterSharedBuffers: number = networkWorkers * workerBufferBlocks.value

/**
 * The predicate locks one network worker's file holds at once, measured: the most any one test database held while
 * every worker ran a file.
 */
const workerPredicateLocks: Limit = measured({
	value: 2038,
	owner: "grizzle's network test tier",
	unit: "predicate locks",
	scope:
		"the SIRead locks one network worker's file holds at once, every transaction of its database's together, as pg_locks lists them",
	evidence:
		"`SELECT max(n), sum(n), count(*) FROM (SELECT database, count(*) AS n FROM pg_catalog.pg_locks WHERE mode = 'SIReadLock' GROUP BY 1) AS x` as the bootstrap superuser, every 3 s, during a full `pnpm -s test:network`",
	observed: "ten readings on 2026-11-14 between 01:28 and 01:29 UTC",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, the local PostgreSQL 19rc2 cluster sized by clusterSize with max_pred_locks_per_transaction 2048, grizzle 993326b3; a second full network run and other lanes' files on the cluster at once",
	workload:
		"a full network run at one file per core, every worker's file in its own database, beside another run's files",
	result:
		"at most 2,038 locks in one database, 7,812 in all over 57 databases at once; no 53200 (out of shared memory)",
	decision:
		"the largest one database held. No headroom added: the table holds this many for every worker at once (clusterPredicateLocks), and the measured total over every database is a seventeenth of that",
	revalidate:
		"a 53200 in a network run; a test tier whose transactions read more rows SERIALIZABLE; a change of max_pred_locks_per_relation or max_pred_locks_per_page; a PostgreSQL repin"
})

/**
 * The local cluster's max_pred_locks_per_transaction, which scripts/pg/init.sh sets and scripts/pg/doctor.sh requires
 * at least. PostgreSQL's predicate-lock table holds it for every connection the cluster admits, and every index drop
 * and table rewrite under a SERIALIZABLE transaction anywhere on the cluster scans that whole table holding every
 * predicate-lock partition (REL_19_RC2 predicate.c DropAllPredicateLocksFromTable), as every read of pg_locks does
 * (GetPredicateLockStatusData). So the table is sized to what the run holds, a worker's locks (workerPredicateLocks)
 * for each worker, spread over the connections, never to a number of locks for each connection. On a throwaway cluster
 * on cassowary on 2026-11-14, a CREATE INDEX and DROP INDEX beside an open SERIALIZABLE transaction took 1.6 ms at 100
 * connections and 2048 locks each, 12.0 ms at the machine's sized connections and 2048, and 2.1 ms there at 64; a read
 * of pg_locks 0.9, 22.9 and 2.1 ms. A transaction's locks promote to its page's and relation's as production's do,
 * whatever this is: init.sh pins max_pred_locks_per_relation.
 */
const clusterPredicateLocks: number = Math.ceil(
	(networkWorkers * workerPredicateLocks.value) / clusterConnections
)

/**
 * The settings that size the local cluster to the machine, by name, each in its own unit: scripts/pg/cluster-size.ts
 * prints them, scripts/pg/init.sh writes them, and scripts/pg/doctor.sh requires each at least.
 */
export const clusterSize: ReadonlyArray<readonly [setting: string, value: number]> = [
	["max_connections", clusterConnections],
	["shared_buffers", clusterSharedBuffers],
	["max_pred_locks_per_transaction", clusterPredicateLocks]
]

export interface SharedClaim {
	readonly database: string
	/** An owner connection to the database. */
	readonly admin: PgConnection
	/** The backend of the session that holds the claim, which runs every statement in a transaction of its own. */
	readonly claimant: number
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
 * database each. The cluster keeps a long-lived database per worker, `gz_shared_1`, `gz_shared_2`, ..., each cloned from
 * the template once and reused by file after file, across runs (Tests and gates).
 * Files stay apart through unique schema and role names (names.ts), whose finalizers drop them. A file that needs a
 * pristine database of its own builds Substrate.isolatedLayer instead.
 *
 * Vitest runs each file in a process of its own, at most W at once (vitest.network.config.ts maxWorkers, W the
 * machine's cores, networkWorkers, workers.ts), and numbers the workers running them 1 to W in VITEST_POOL_ID; the run's global setup
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
		Option.match(worker, {
			onNone: () => above + n,
			onSome: (w) => (n === 0 ? w : above + n - 1)
		})
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
			return { database, admin: connection.admin, claimant: lock.processId }
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

/**
 * The decoder login an installation at its stems would have whose root schema is the allocation a role of `role`'s
 * names lead: `<allocation>__<name>`'s allocation, its live source's stem (core/identity.ts identity.liveSource),
 * `__live_<digest>`, which carries no allocation, so the sweep derives it from the allocation rather than reading it
 * back. A role under a prefix starts with its own allocation, so its decoder is swept by that.
 */
const decoderOfAllocation = (role: string): string =>
	identifierOf(identity.liveSource(Arr.headNonEmpty(Str.split("__")(role))))

/**
 * The sweep's lock: a session-level advisory lock in the owner's own database, which each sweep holds on its session
 * from its first read to its end.
 */
const sweepKey = 1735289962

/**
 * Drops what ended test processes left on the cluster: their gz_t_ and gz_doctor_ databases, their `<schema>__<access>`
 * roles and each one's allocation's decoder login (decoderOfAllocation), and every unclaimed shared database that is not
 * clean. A run in progress is never touched: its processes are
 * running, and its shared databases are claimed. It is the one place a database is dropped, and its callers call it
 * only when no test file of their own runs: the network run's global setup, before any file starts, and its teardown,
 * once every file has ended (pg-global-setup.ts), both in Vitest's own process, whose test files each ran in a process
 * of their own; and a bench runner when its last gate has run, its own databases then ended too. Runs beside each other
 * sweep at once, and an ended process's leftovers are every sweep's to drop, so each sweep waits for the sweep lock
 * (sweepKey) before it reads: sweeps run one at a time, each leftover is dropped by exactly one of them, and the next
 * reads it gone. `dropRole` is the substrate's.
 */
export const sweep = (
	dropRole: (admin: PgConnection, role: string) => Effect.Effect<void, SqlError>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* InitializedCluster
			const admin = yield* devSession(cluster, Option.none())
			yield* admin.queryValues("SELECT pg_catalog.pg_advisory_lock($1::int8)", [sweepKey])
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
			const rows = yield* admin.queryValues(
				"SELECT rolname::text FROM pg_catalog.pg_roles WHERE strpos(rolname::text, '__') > 0 ORDER BY 1",
				[]
			)
			const roles = Arr.map(rows, ([value]) => String(value))
			const dead = Arr.filter(roles, (role) => Option.exists(allocatingPid(role), ended))
			const deadDecoders = new Set(Arr.map(dead, decoderOfAllocation))
			for (const role of roles) {
				if (deadDecoders.has(role) || Option.exists(allocatingPid(role), ended)) {
					yield* Effect.ignore(dropRole(admin, role))
				}
			}
		})
	)
