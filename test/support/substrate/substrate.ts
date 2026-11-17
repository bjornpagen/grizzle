import { type Need, type NeedContext, NeedFailed, WorkerIndex } from "@bjornpagen/testing/property"
import {
	type Content,
	Database,
	type DatabaseNeed,
	type DatabaseTemplate,
	type Opened,
	PgCluster,
	Template
} from "@bjornpagen/testing/resources"
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import {
	Array as Arr,
	Cause,
	Context,
	Duration,
	Effect,
	Exit,
	Function,
	HashSet,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	Ref,
	Result,
	Scope,
	Semaphore,
	String as Str
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { Client } from "pg"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { advisoryKey } from "#compiler/sql/catalog.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { testPoolMax } from "#pg/lease.ts"
import { InitializedCluster, lentPlace, lentVariable } from "#test/support/cluster.ts"
import { adminUrl, pgPin } from "#test/support/env.ts"
import {
	type ClientBackend,
	endBackend,
	heldBackends,
	roleBackendsQuery,
	SessionsLeaked
} from "#test/support/kernel/sanitize.ts"
import { hangLimit, testExitWait } from "#test/support/limits.ts"
import {
	type Exchange,
	exchanging,
	freshDatabase,
	type PgConnection,
	type RawAnswer,
	SqlError,
	sqlErrorOf,
	type PgStatement
} from "#test/support/pg.ts"
import { sqlNeedFailed } from "#test/support/runner.ts"
import { awaitBlockedBy, awaitLockWait, type LockWait } from "#test/support/substrate/barrier.ts"
import {
	type BudgetedCluster,
	budgeted,
	LeaseBudgetExhausted,
	leaseBudget
} from "#test/support/substrate/budget.ts"
import type { PsqlProcessError } from "#test/support/substrate/errors.ts"
import {
	defaultSchemaLabel,
	ownerLoginName,
	randomPassword,
	roleName,
	rolePrefix,
	schemaNameOfLength,
	type TemplateNames,
	templateNames,
	templateSchemaName,
	uniqueSchemaName
} from "#test/support/substrate/names.ts"
import { type BackendCancel, openPsql, type PsqlWriter } from "#test/support/substrate/psql.ts"
import { clearRows, noTables, type ResetGroup } from "#test/support/substrate/replace.ts"
import {
	type Credentials,
	beginSerializable,
	connect,
	openSession,
	type CaseSession,
	ownerCredentials,
	type RawSession,
	type SubstrateWorld
} from "#test/support/substrate/session.ts"
import {
	baseTemplate,
	templateDigest,
	templatePassword
} from "#test/support/substrate/templates.ts"

import {
	type Check,
	claimSharedDatabase,
	type Lease,
	leaseConnections,
	leftovers,
	leftoversCheck,
	undoInstallEffects
} from "#test/support/substrate/shared.ts"

export interface SchemaOptions {
	/** Run CREATE SCHEMA as the owner. Off when the code under test creates the schema itself (a migration). */
	readonly create: boolean
	readonly label: string
}

/** A schema the owner creates under the default label: what a test allocates unless it says otherwise. */
export const freshSchema: SchemaOptions = { create: true, label: defaultSchemaLabel }

/**
 * A default of a role's sessions as ALTER ROLE ... SET writes it: the parameter, and its value as SQL, a quoted value
 * or a list of names.
 */
export interface RoleDefault {
	readonly parameter: string
	readonly value: string
}

/**
 * Who a raw session logs in as: the substrate's owner, the migration identity, whose password is the initialised
 * cluster's and so the substrate's to supply, or a login whose credentials the test holds.
 */
type SessionLogin =
	| { readonly _tag: "Owner" }
	| { readonly _tag: "Login"; readonly credentials: Credentials }

/**
 * A raw session's login and name. Every raw session verifies the cluster's CA certificate for the local host.
 */
export interface ConnectOptions {
	readonly as: SessionLogin
	/**
	 * The role the session takes on (SET ROLE) before its first statement, a world role of the login; none for the
	 * login's own privileges.
	 */
	readonly role: Option.Option<string>
	/** The session's name in reports and in the server's application_name. */
	readonly label: string
}

/** A raw session as `credentials`, labelled by its role: a test spreads it and overrides what it means. */
export const roleSession = (credentials: Credentials): ConnectOptions => ({
	as: { _tag: "Login", credentials },
	role: Option.none(),
	label: credentials.role
})

/** A raw session as the substrate's owner, labelled by its role. */
export const ownerSession = (): ConnectOptions => ({
	as: { _tag: "Owner" },
	role: Option.none(),
	label: pgPin.devRole
})

/**
 * A raw session in a world: logged in as the login that holds the role, which it takes on before the test's first
 * statement, labelled by the role.
 */
export const worldSession = (world: SubstrateWorld): ConnectOptions => ({
	...roleSession(world.login),
	role: Option.some(world.role),
	label: world.role
})

/** A psql writer's login, name and address. Every psql writer verifies the cluster's CA certificate. */
export interface PsqlConnectOptions {
	readonly as: Credentials
	/** The role the writer takes on (SET ROLE) before its first statement; none for the login's own privileges. */
	readonly role: Option.Option<string>
	readonly label: string
	/** The name libpq connects to and verifies the server certificate against. */
	readonly host: string
	/** The address to connect to, without a name lookup, or none; `host` is still the name the certificate must carry. */
	readonly hostaddr: Option.Option<string>
}

/**
 * A psql writer as `credentials`, labelled by its role, verifying the certificate for the local host, connecting by
 * name.
 */
export const rolePsql = (credentials: Credentials): PsqlConnectOptions => ({
	as: credentials,
	role: Option.none(),
	label: credentials.role,
	host: pgPin.host,
	hostaddr: Option.none()
})

/**
 * A psql writer in a world: logged in as the login that holds the role, which it takes on before its first statement.
 */
export const worldPsql = (world: SubstrateWorld): PsqlConnectOptions => ({
	...rolePsql(world.login),
	role: Option.some(world.role),
	label: world.role
})

export interface SubstrateShape {
	/**
	 * The initialised cluster the substrate was built from, with the budget its lease grants the file (shared.ts
	 * leaseConnections): a substrate exists only once the cluster parsed, so code that holds one reads the cluster's CA
	 * certificates here and needs no InitializedCluster of its own, and every connection it opens on the cluster through
	 * test support draws one of the budget's permits for its life, the substrate's own sessions, psql writers and
	 * superuser clients included. The file holds at most the budget's width of connections at once.
	 */
	readonly cluster: BudgetedCluster
	/** The database this file runs in, cloned from grizzle_template: a shared database, or a fresh one. */
	readonly database: string
	/**
	 * The backends that hold the substrate's place on the cluster for its life: its lease's (shared.ts leaseConnections)
	 * and, in a shared database, its claim's (claimSharedDatabase), which draws from the lease's budget. Neither holds a
	 * transaction id or a snapshot.
	 */
	readonly held: ReadonlyArray<number>
	/** The migration identity and database owner, with the cluster's password for it. */
	readonly owner: Credentials
	/** An owner connection to the database for setup and inspection. Its statements are not counted. */
	readonly admin: PgConnection
	/**
	 * One statement in the database as the cluster's bootstrap superuser: what only an operator with every right may do,
	 * such as granting SUPERUSER or BYPASSRLS. A statement it refuses is a defect of the run.
	 */
	readonly superuser: (sql: string) => Effect.Effect<void>
	/**
	 * A read in the database as the cluster's bootstrap superuser, on one connection in one SERIALIZABLE READ ONLY
	 * transaction: `read` runs its statements there, each answering its rows (TextRows). Row security binds no superuser,
	 * a table's forced row security included, so this reads the facts as stored (worlds/execute/index.ts readAll); a
	 * world under test never reads through it. A statement it refuses is a defect of the run.
	 */
	readonly superuserRead: <A, E>(
		read: (rows: (sql: string) => Effect.Effect<TextRows>) => Effect.Effect<A, E>
	) => Effect.Effect<A, E>
	/** A unique schema name. Its finalizer drops every role named `<schema>__*`, then the schema. */
	readonly schema: (options: SchemaOptions) => Effect.Effect<string, SqlError, Scope.Scope>
	/**
	 * A unique schema name of exactly `bytes` bytes (names.ts uniqueSchemaNameOfLength), which the code under test
	 * installs: its finalizer drops every role named `<schema>__*`, then the schema, as `schema`'s does.
	 */
	readonly schemaOfLength: (
		label: string,
		bytes: number
	) => Effect.Effect<string, SqlError, Scope.Scope>
	/** Creates the login role `<schema>__<name>` with a random SCRAM password; the finalizer drops it. */
	readonly role: (schema: string, name: string) => Effect.Effect<Credentials, SqlError, Scope.Scope>
	/**
	 * Gives an existing owner-created role (one a migration created) a random password, so a session or psql writer
	 * can log in as it; the finalizer drops it.
	 */
	readonly login: (role: string) => Effect.Effect<Credentials, SqlError, Scope.Scope>
	/**
	 * A login of the owner's own, for one installation's sessions (test/support/ambient.ts AmbientOwner): a role that
	 * takes on the owner as each of its sessions starts (its `role` default), so every statement they run acts as the
	 * owner and every object they create is the owner's, with `defaults` its defaults in this database alone, which no
	 * other session starts under. The bootstrap superuser creates, grants and drops it: a role the owner creates has the
	 * owner as a member, and so could never be a member of the owner. Its finalizer waits for its backends to end, then
	 * drops it.
	 */
	readonly ownerLogin: (
		defaults: ReadonlyArray<RoleDefault>
	) => Effect.Effect<Credentials, never, Scope.Scope>
	readonly session: (options: ConnectOptions) => Effect.Effect<RawSession, SqlError, Scope.Scope>
	readonly psql: (
		options: PsqlConnectOptions
	) => Effect.Effect<PsqlWriter, PsqlProcessError, Scope.Scope>
	/**
	 * The lock-wait barrier, polled from a dedicated observer connection: waits until backend `pid` waits on a lock
	 * (held by `blockedBy`, when it names a backend). The observer reads only the server's lock and activity state,
	 * which no snapshot governs, so its statements run READ COMMITTED: a SERIALIZABLE poll, the test database's
	 * default, would be a serializable transaction of its own, each one through SSI's shared lists at its commit.
	 */
	readonly awaitLockWait: (
		pid: number,
		blockedBy: Option.Option<number>
	) => Effect.Effect<LockWait, SqlError>
	/**
	 * The lock-wait barrier keyed by the holder: waits until the one backend of `role` that `holder` blocks waits on a
	 * lock, polled from the same observer connection.
	 */
	readonly awaitBlockedBy: (holder: number, role: string) => Effect.Effect<LockWait, SqlError>
	/** Whether a role exists anywhere in the cluster. */
	readonly roleExists: (role: string) => Effect.Effect<boolean, SqlError>
}

/**
 * `statement`, which writes the current database's ACL (a GRANT or REVOKE on it, or a DROP OWNED BY of a role holding a
 * privilege on it), run as one DO block under the database lock, as an installation's GRANT and
 * REVOKE on the database run (sql/catalog.ts databaseLock): two transactions that write the database's
 * pg_database row at once fail with XX000 (tuple concurrently updated), and every installation in a shared database
 * writes it.
 */
export const underDatabaseLock = (statement: string): string =>
	`DO $$BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(${advisoryKey({ kind: "database" })}::bigint); EXECUTE ${quoteString(statement)}; END$$`

/**
 * Drops a role a test made: one the owner administers by terminating its sessions, dropping what it owns and every
 * privilege granted to it in this database, the TEMPORARY on the database an installation grants it among them, under
 * the database lock (underDatabaseLock), then the role; an owner login (ownerLogin), the one kind
 * of test role that is a member of the owner, which owns nothing, as the bootstrap superuser who made it. A no-op once
 * the role is gone; a backend that outlives its termination is a defect.
 */
export const dropRole = (
	cluster: BudgetedCluster,
	admin: PgConnection,
	role: string
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const [found] = yield* admin.queryValues(
			"SELECT EXISTS (SELECT FROM pg_catalog.pg_auth_members AS m WHERE m.member = r.oid AND m.roleid = CURRENT_USER::regrole), pg_catalog.current_database()::text FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text",
			[role]
		)
		if (found === undefined) {
			return
		}
		const [ownerMember, database] = found
		if (ownerMember === true) {
			return yield* dropOwnerLogin(cluster, String(database), role)
		}
		yield* admin.query(`GRANT ${quoteIdent(role)} TO CURRENT_USER WITH INHERIT TRUE`, [])
		/**
		 * DROP ROLE succeeds while the role still has backends, so each one is terminated first, the server waiting up
		 * to testExitWait for it to exit. A backend still running is a defect of the cluster.
		 * The call stays in the select list: in WHERE the planner may evaluate it before the usename filter, on
		 * backends of roles the owner cannot signal.
		 */
		const terminated = yield* admin.queryValues(
			"SELECT pid, pg_catalog.pg_terminate_backend(pid, $2::int8) FROM pg_catalog.pg_stat_activity WHERE usename = $1::text",
			[role, String(testExitWait)]
		)
		/**
		 * pg_terminate_backend also returns false, with "PID n is not a PostgreSQL backend process", for a backend that
		 * exited on its own between the listing and the call, such as a pool session that had just sent Terminate. So
		 * a false result is a survivor only when the backend is still listed for the role.
		 */
		const survivors: Array<string> = []
		for (const [pid, exited] of terminated) {
			if (exited === true) {
				continue
			}
			const listed = yield* admin.queryValues(
				"SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1::int4 AND usename = $2::text",
				[Number(pid), role]
			)
			if (listed.length > 0) {
				survivors.push(String(pid))
			}
		}
		if (survivors.length > 0) {
			return yield* Effect.die(
				new Error(`role ${role}: backends ${Arr.join(survivors, ", ")} did not exit`)
			)
		}
		yield* admin.query(underDatabaseLock(`DROP OWNED BY ${quoteIdent(role)}`), [])
		yield* admin.query(`DROP ROLE ${quoteIdent(role)}`, [])
	})

/**
 * The release of `role`, which owns the role's sessions and waits on none of them: its backends as `read` reads them
 * (kernel/sanitize.ts roleBackendsQuery), then `drop`, which ends every one and drops the role, and then, where a
 * backend's session is one the test still holds (sanitize.ts heldBackends, against the cluster's budget's held
 * connections), the release fails with SessionsLeaked, naming each such backend's pid, state and last statement. Every
 * other backend listed has had its session ended and is on its way out, and `drop` ends it with the rest.
 */
const releasing = <E>(
	cluster: BudgetedCluster,
	role: string,
	read: Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	drop: Effect.Effect<void, E>
): Effect.Effect<void, E> =>
	Effect.gen(function* () {
		const listed = yield* read
		const held = heldBackends(listed, cluster.budget.held(), cluster.port)
		yield* drop
		if (Arr.isReadonlyArrayNonEmpty(held)) {
			return yield* Effect.die(new SessionsLeaked({ role, backends: held }))
		}
	})

/**
 * Drops a role a test allocated (releasing): its backends ended, a session the test never closed failing the release
 * at once, named, rather than holding it. The sweep of crashed runs drops roles with dropRole itself, where leftover
 * backends are expected.
 */
const releaseRole = (
	cluster: BudgetedCluster,
	admin: PgConnection,
	role: string
): Effect.Effect<void, SqlError> =>
	releasing(
		cluster,
		role,
		admin.queryValues(roleBackendsQuery(role), []),
		dropRole(cluster, admin, role)
	)

/**
 * Rows as text, positional: every column its text, or null for NULL; what a superuser read and both kinds of direct
 * session answer.
 */
export type TextRows = ReadonlyArray<ReadonlyArray<string | null>>

/** A column's text as pg hands it over, unparsed. */
const asText = (text: string): string => text

/** Every column as its text: pg's parsers bypassed. */
const textTypes = { getTypeParser: (): ((text: string) => string) => asText } as const

/**
 * A connection to `database` as the bootstrap superuser `postgres`, over the cluster's local socket, where peer
 * authentication maps this OS user to it (scripts/pg/init.sh); the TLS sessions of test/support/pg.ts reach no
 * superuser. It lives for the scope, drawing one of its budget's permits; a connection refused is a failure its caller
 * makes a defect of the run.
 */
const superuserClient = (cluster: BudgetedCluster, database: string, applicationName: string) =>
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

/** Statements in `database` as the bootstrap superuser, in order, on one connection of their own (superuserClient). */
const asSuperuser = (
	cluster: BudgetedCluster,
	database: string,
	statements: ReadonlyArray<string>
): Effect.Effect<void> =>
	Effect.orDie(
		Effect.scoped(
			Effect.gen(function* () {
				const client = yield* superuserClient(cluster, database, "grizzle-substrate superuser")
				for (const sql of statements) {
					yield* Effect.tryPromise({ try: () => client.query(sql), catch: sqlErrorOf })
				}
			})
		)
	)

/**
 * Drops the owner login `role` (SubstrateShape.ownerLogin) as the bootstrap superuser, from `database`: its backends
 * terminated first, the server waiting up to testExitWait for each to exit, then the role, with its defaults and its membership
 * in the owner. It owns nothing, as every statement of its sessions acted as the owner. A no-op once it is gone.
 */
const dropOwnerLogin = (
	cluster: BudgetedCluster,
	database: string,
	role: string
): Effect.Effect<void> =>
	asSuperuser(cluster, database, [
		`SELECT pg_catalog.pg_terminate_backend(a.pid, ${testExitWait}) FROM pg_catalog.pg_stat_activity AS a WHERE a.usename = ${quoteString(role)}::name`,
		`DROP ROLE IF EXISTS ${quoteIdent(role)}`
	])

/**
 * A read in `database` as the bootstrap superuser (SubstrateShape.superuserRead): one connection (superuserClient), one
 * SERIALIZABLE READ ONLY transaction around `read`, committed once it succeeds and rolled back with the connection
 * otherwise; each statement answers its rows as text.
 */
const asSuperuserRead = <A, E>(
	cluster: BudgetedCluster,
	database: string,
	read: (rows: (sql: string) => Effect.Effect<TextRows>) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* Effect.orDie(
				superuserClient(cluster, database, "grizzle-substrate stored read")
			)
			const rows = (sql: string): Effect.Effect<TextRows> =>
				Effect.orDie(
					Effect.map(
						Effect.tryPromise({
							try: () => client.query({ text: sql, rowMode: "array" }),
							catch: sqlErrorOf
						}),
						(result) => trusted<TextRows>(result.rows)
					)
				)
			yield* rows("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY")
			const value = yield* read(rows)
			yield* rows("COMMIT")
			return value
		})
	)

/**
 * A psql writer in `database` of `cluster` (SubstrateShape.psql), whose release ends once its backend has: psql's exit
 * closes its connection without waiting for the server, and the release then ends the backend on `admin` (endBackend),
 * which a statement psql left running, waiting on a lock another session's open transaction holds, would keep alive
 * until that session's own release, perhaps later in the same scope. So no writer's release waits on another session.
 * Registered before the writer, that finalizer runs after the writer's own. The writer draws one of the cluster's
 * budget's permits before psql is spawned, given back once its backend has ended or psql has failed to start
 * (budget.ts LeaseBudget opened), and dies with LeaseBudgetExhausted when none is free.
 */
export const psqlWriter = (
	cluster: BudgetedCluster,
	database: string,
	admin: PgConnection,
	options: PsqlConnectOptions
): Effect.Effect<
	PsqlWriter,
	PsqlProcessError,
	Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
	cluster.budget.opened(
		Effect.gen(function* () {
			const started: { backend: Option.Option<ClientBackend> } = { backend: Option.none() }
			yield* Effect.addFinalizer(() =>
				Option.match(started.backend, {
					onNone: () => Effect.void,
					onSome: (backend) => Effect.orDie(endBackend(admin, backend))
				})
			)
			const writer = yield* openPsql({
				port: cluster.port,
				database,
				credentials: options.as,
				label: options.label,
				caFile: cluster.caFile,
				host: options.host,
				hostaddr: options.hostaddr,
				/**
				 * The call stays in the select list, so it runs only for a backend the WHERE clause found running a query; it
				 * answers false for one that exited meanwhile, which runs nothing.
				 */
				cancelBackend: (pid) =>
					Effect.match(
						admin.queryValues(
							"SELECT pg_catalog.pg_cancel_backend(pid)::text FROM pg_catalog.pg_stat_activity WHERE pid = $1::int4 AND state = 'active'::text",
							[pid]
						),
						{
							onFailure: (): BackendCancel => "unreachable",
							onSuccess: (rows): BackendCancel =>
								Arr.some(rows, ([signalled]) => signalled === "true") ? "signalled" : "not running"
						}
					)
			})
			started.backend = Option.some(writer.backend)
			yield* cluster.budget.hold(writer.backend.pid)
			if (Option.isSome(options.role)) {
				yield* Effect.orDie(writer.run(`SET ROLE ${quoteIdent(options.role.value)}`))
			}
			return writer
		})
	)

/**
 * How a substrate names and releases what it allocates: its schemas, its owner logins and its roles' passwords. A
 * case's substrate allocates per process (processAllocations): unique names, random passwords, each dropped when its
 * scope closes. A template's build allocates per template (templateAllocations): names and passwords every worker
 * derives from the template alone, and whatever the install still holds when it ends kept as the template's.
 */
interface Allocations {
	/** The schema name of the substrate's allocation number `n`, under `label`. */
	readonly schema: (label: string, n: number) => string
	/** The owner login's role of the substrate's allocation number `n` (SubstrateShape.ownerLogin). */
	readonly ownerLogin: (n: number) => string
	/** The password `role` is given as it becomes a login. */
	readonly password: (role: string) => string
	/** `drop`, which removes what `name` names, as the release of the allocation when the current scope closes. */
	readonly released: (
		name: string,
		drop: Effect.Effect<void>
	) => Effect.Effect<void, never, Scope.Scope>
}

/** A process's allocations: unique names (names.ts), random passwords, every one dropped when its scope closes. */
const processAllocations: Allocations = {
	schema: uniqueSchemaName,
	ownerLogin: ownerLoginName,
	password: randomPassword,
	released: (_name, drop) => Effect.addFinalizer(() => drop)
}

/**
 * Builds the substrate over `database` of `cluster` in the current scope, with `admin` as its admin connection; its psql
 * writers are spawned by the scope's child-process spawner.
 */
const build = Effect.fnUntraced(function* (
	cluster: BudgetedCluster,
	database: string,
	admin: PgConnection,
	held: ReadonlyArray<number>,
	names: Allocations
): Effect.fn.Return<
	SubstrateShape,
	SqlError,
	Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const owner = ownerCredentials(cluster)
	const observer = yield* connect(cluster, { database, credentials: owner, label: "observer" })
	yield* observer.query("SET default_transaction_isolation TO 'read committed'", [])
	const allocations = yield* Ref.make(0)
	const nextAllocation = Ref.getAndUpdate(allocations, (n) => n + 1)

	/** A role finalizer that fails is a leaked cluster-wide role: surface it as a defect rather than hide it. */
	const registerRoleCleanup = (role: string) =>
		names.released(role, Effect.orDie(releaseRole(cluster, admin, role)))

	const enableLogin = (role: string): Effect.Effect<Credentials, SqlError> =>
		Effect.gen(function* () {
			const password = names.password(role)
			yield* admin.query(`ALTER ROLE ${quoteIdent(role)} PASSWORD ${quoteString(password)}`, [])
			yield* admin.query(`GRANT ${quoteIdent(role)} TO CURRENT_USER WITH INHERIT TRUE`, [])
			return { role, password: Redacted.make(password) }
		})

	/**
	 * Drops every schema whose name starts with `prefix`: each world role's own schema, `<schema>__<role>`, which the
	 * migration identity owns, so neither releasing its role nor dropping the base schema drops it. Dropped before the
	 * roles are released, since each grants USAGE to its role.
	 */
	const dropRoleSchemas = (prefix: string) =>
		Effect.gen(function* () {
			const schemas = yield* admin.queryValues(
				"SELECT nspname::text FROM pg_catalog.pg_namespace WHERE starts_with(nspname::text, $1::text) ORDER BY nspname",
				[prefix]
			)
			for (const [schema] of schemas) {
				yield* admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(String(schema))} CASCADE`, [])
			}
		})

	/** A schema name the run holds: its finalizer drops its installation's live source, the slot a leader created, its
	 * publication and its decoder login, then every role named `<schema>__*` and each role's schema, then the schema;
	 * created as the owner when `create` says so. */
	const allocated = (name: string, create: boolean) =>
		Effect.gen(function* () {
			yield* names.released(
				name,
				Effect.orDie(
					Effect.gen(function* () {
						yield* dropRoleSchemas(rolePrefix(name))
						const source = identifierOf(identity.liveSource(name))
						yield* admin.query(
							"SELECT pg_catalog.pg_terminate_backend(active_pid) FROM pg_catalog.pg_replication_slots WHERE slot_name = $1::name AND active_pid IS NOT NULL",
							[source]
						)
						yield* admin.query(
							"SELECT pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots WHERE slot_name = $1::name",
							[source]
						)
						yield* admin.query(`DROP PUBLICATION IF EXISTS ${quoteIdent(source)}`, [])
						const decoders = yield* admin.queryValues(
							"SELECT rolname::text FROM pg_catalog.pg_roles WHERE rolname = $1::name",
							[source]
						)
						for (const [decoder] of decoders) {
							yield* releaseRole(cluster, admin, String(decoder))
						}
						const roles = yield* admin.queryValues(
							"SELECT rolname::text FROM pg_catalog.pg_roles WHERE starts_with(rolname::text, $1::text) ORDER BY rolname",
							[rolePrefix(name)]
						)
						for (const [role] of roles) {
							yield* releaseRole(cluster, admin, String(role))
						}
						yield* admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(name)} CASCADE`, [])
					})
				)
			)
			if (create) {
				yield* admin.query(`CREATE SCHEMA ${quoteIdent(name)}`, [])
			}
			return name
		})

	const schema = (options: SchemaOptions) =>
		Effect.flatMap(nextAllocation, (n) => allocated(names.schema(options.label, n), options.create))

	const schemaOfLength = (label: string, bytes: number) =>
		Effect.flatMap(nextAllocation, (n) =>
			allocated(schemaNameOfLength(names.schema(label, n), bytes), false)
		)

	const role = (schemaName: string, roleOf: string) =>
		Effect.gen(function* () {
			const name = roleName(schemaName, roleOf)
			yield* registerRoleCleanup(name)
			yield* admin.query(`CREATE ROLE ${quoteIdent(name)} LOGIN`, [])
			return yield* enableLogin(name)
		})

	const login = (name: string) => Effect.andThen(registerRoleCleanup(name), enableLogin(name))

	/**
	 * An owner login, released (releasing) by its backends read as the bootstrap superuser, since they show only to a role
	 * with the login's privileges, which the owner lacks.
	 */
	const ownerLogin = (
		defaults: ReadonlyArray<RoleDefault>
	): Effect.Effect<Credentials, never, Scope.Scope> =>
		Effect.gen(function* () {
			const allocation = yield* nextAllocation
			const name = names.ownerLogin(allocation)
			const password = names.password(name)
			const quoted = quoteIdent(name)
			yield* names.released(
				name,
				releasing(
					cluster,
					name,
					asSuperuserRead(cluster, database, (rows) => rows(roleBackendsQuery(name))),
					dropOwnerLogin(cluster, database, name)
				)
			)
			yield* asSuperuser(cluster, database, [
				`CREATE ROLE ${quoted} LOGIN PASSWORD ${quoteString(password)}`,
				`GRANT ${quoteIdent(owner.role)} TO ${quoted} WITH INHERIT FALSE, SET TRUE`,
				`ALTER ROLE ${quoted} SET role = ${quoteString(owner.role)}`,
				...Arr.map(
					defaults,
					(d) =>
						`ALTER ROLE ${quoted} IN DATABASE ${quoteIdent(database)} SET ${d.parameter} = ${d.value}`
				)
			])
			return { role: name, password: Redacted.make(password) }
		})

	/**
	 * A session's SET ROLE is setup, not one of the test's statements: it runs first and leaves the statement log empty.
	 */
	const credentialsOf = (login: SessionLogin): Credentials => {
		switch (login._tag) {
			case "Owner":
				return owner
			case "Login":
				return login.credentials
		}
	}
	const session = (options: ConnectOptions) =>
		Effect.gen(function* () {
			const raw = yield* openSession(cluster, {
				database,
				credentials: credentialsOf(options.as),
				label: options.label
			})
			yield* cluster.budget.hold(raw.pid)
			if (Option.isSome(options.role)) {
				yield* raw.query(`SET ROLE ${quoteIdent(options.role.value)}`, [])
			}
			return raw
		})

	const psql = (options: PsqlConnectOptions) =>
		psqlWriter(cluster, database, admin, options).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
		)

	const roleExists = (name: string) =>
		Effect.map(
			admin.queryValues("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1::text", [name]),
			(rows) => rows.length > 0
		)

	return {
		cluster,
		database,
		held,
		owner,
		admin,
		schema,
		schemaOfLength,
		role,
		login,
		ownerLogin,
		session,
		psql,
		awaitLockWait: (pid, blockedBy) => awaitLockWait(observer, pid, blockedBy),
		awaitBlockedBy: (holder, role) => awaitBlockedBy(observer, holder, role),
		roleExists,
		superuser: (sql) => asSuperuser(cluster, database, [sql]),
		superuserRead: (read) => asSuperuserRead(cluster, database, read)
	}
})

/**
 * One step of a substrate's life that waits on nothing others hold by design, bounded by the hang limit (limits.ts
 * hangLimit), so a step that never ends dies naming what hung: a layer build's work once it holds its lease (a claim or
 * a clone, its connections and its sessions), and its release. The lease wait before a build is no hang: a file queued behind others' holds waits as long as they hold
 * (shared.ts leaseConnections). Tests and the network tier's hooks are unbounded, so this is what reports such a hang.
 */
const hangGuarded = <A, E, R>(what: string, step: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.timeoutOrElse(step, {
		duration: Duration.millis(hangLimit),
		orElse: () =>
			Effect.die(new Error(`${what} hung: it did not end within the hang limit of ${hangLimit} ms`))
	})

/**
 * The substrate in a shared database (shared.ts). When the scope closes the database stays: the release undoes the
 * database-wide effects installs have by design, and anything else the file left fails the release. The database
 * stays as the file left it: no later claim takes a dirty database, and the sweep drops it once no file runs.
 */
const makeSubstrate: Effect.Effect<
	SubstrateShape,
	SqlError,
	Scope.Scope | InitializedCluster | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
	const lease = yield* leaseConnections
	return yield* hangGuarded(
		"the substrate's build in a shared database",
		Effect.gen(function* () {
			const claim = yield* claimSharedDatabase(lease.cluster)
			yield* Effect.addFinalizer(() =>
				Effect.orDie(
					hangGuarded(
						`the release of the shared database ${claim.database}`,
						Effect.gen(function* () {
							yield* undoInstallEffects(claim.admin)
							const left = yield* leftovers(claim.admin)
							if (left.length === 0) {
								return
							}
							return yield* Effect.die(
								new Error(
									`the test file left ${Arr.join(left, ", ")} in the shared database ${claim.database}`
								)
							)
						})
					)
				)
			)
			return yield* build(
				lease.cluster,
				claim.database,
				claim.admin,
				[...lease.held, claim.claimant],
				processAllocations
			)
		})
	)
})

/**
 * The substrate in a fresh database of its own, cloned from the template (test/support/pg.ts freshDatabase) and left
 * for the sweep, which drops it once no file of this process runs.
 */
const makeIsolatedSubstrate: Effect.Effect<
	SubstrateShape,
	SqlError,
	Scope.Scope | InitializedCluster | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
	const lease = yield* leaseConnections
	return yield* hangGuarded(
		"the substrate's build in a database of its own",
		Effect.gen(function* () {
			const database = yield* freshDatabase(lease.cluster)
			const admin = yield* connect(lease.cluster, {
				database,
				credentials: ownerCredentials(lease.cluster),
				label: "admin"
			})
			return yield* build(lease.cluster, database, admin, lease.held, processAllocations)
		})
	)
})

/**
 * The substrate of a child process in the place its parent case lent it (cluster.ts lentPlace, shared.ts lend): the
 * case's database on the case's member, the permits the case set aside, no lease and no database of its own. Its
 * allocations are its own, released as its scope closes; the database is the case's, which the case's need drops.
 */
const makeLentSubstrate: Effect.Effect<
	SubstrateShape,
	SqlError,
	Scope.Scope | InitializedCluster | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
	const initialized = yield* InitializedCluster
	const lent = yield* lentPlace
	const place = yield* Option.match(lent, {
		onNone: () =>
			Effect.die(
				new Error(`a lent substrate in a process no parent lent a place to (${lentVariable})`)
			),
		onSome: Effect.succeed
	})
	const cluster = budgeted(initialized, leaseBudget(place.width))
	const admin = yield* connect(cluster, {
		database: place.database,
		credentials: ownerCredentials(cluster),
		label: "admin"
	})
	return yield* build(cluster, place.database, admin, [], processAllocations)
})

/**
 * Node's child processes, which spawn the substrate's psql writers: private to the substrate's layers, with only the
 * file system and paths the spawner needs (no terminal or stdio, which would attach to the process's stdin).
 */
const nodeSpawner = NodeChildProcessSpawner.layer.pipe(
	Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
)

/**
 * What a template's value is bound to in a case: the case's database and the cluster with the worker's budget, which
 * every form gives (a case's substrate holds both).
 */
export interface TemplateBinding {
	readonly cluster: BudgetedCluster
	readonly database: string
}

/**
 * A need of a database a template clones: the toolchain's need over it carries the template (DatabaseNeed), which the
 * runner's collection reads off a property's needs (templatesOf), so the templates a run declares are kept and every
 * other is collected; grizzle's needs over one carry it on in turn.
 */
export type TemplateNeed<A> = Need<A> & Readonly<{ template: DatabaseTemplate }>

/**
 * A database template a grizzle case clones, with its value: the toolchain's template (its database), and the value
 * every case over a clone of it reads, computed once per worker (`bound`) and bound to each case's database.
 */
export interface SubstrateTemplate<T> {
	readonly database: DatabaseTemplate
	readonly bound: Effect.Effect<(binding: TemplateBinding) => T, NeedFailed, NeedContext>
	/**
	 * The tables a case over the worker's own clone (Substrate.seat) writes, by its value: emptied after every case
	 * (replace.ts clearRows), before the clone is checked against its template.
	 */
	readonly reset: (value: T) => ResetGroup
}

/**
 * The base template (templates.ts baseTemplate) as a substrate template, whose cases read no value and write no table
 * of its: what a case makes in it, it makes under its own allocations, which its scope drops.
 */
const base: SubstrateTemplate<void> = {
	database: baseTemplate,
	bound: Effect.succeed(Function.constVoid),
	reset: () => noTables
}

/** A case over a clone of a template: its own substrate over the clone, and the template's value bound to it. */
export interface SubstrateCase<T> {
	readonly substrate: SubstrateShape
	readonly value: T
}

/**
 * What an installed template states: its declaring module, name and content (as Template.database takes them), and its
 * install in three parts. `plan` is the pure part, what the install makes under the template's names (names.ts
 * templateNames: its schema and its owner login), which the build and every worker compute alike; `install` makes it
 * once per member, on a substrate over the template database whose allocations are the template's
 * (templateAllocations); `bind` reads it as a case over a clone sees it, by the case's database and budget; `reset`
 * names the tables a seat's case writes (SubstrateTemplate reset).
 */
interface InstallSpec<P, T, E1, E2> {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly content: Content
	readonly plan: (names: TemplateNames) => Effect.Effect<P, E1>
	readonly install: (plan: P) => Effect.Effect<void, E2, Substrate | Scope.Scope>
	readonly bind: (plan: P, binding: TemplateBinding) => T
	readonly reset: (value: T) => ResetGroup
}

/** `effect`'s failure as NeedFailed of `need`, with the failure's printed cause. */
const needFailedBy = <A, E, R>(need: string, effect: Effect.Effect<A, E, R>) =>
	Effect.mapError(effect, (error) =>
		NeedFailed.make({ need, message: Cause.pretty(Cause.fail(error)) })
	)

/**
 * A template build's allocations (Allocations): every name the template's digest and a label (names.ts
 * templateSchemaName), the owner login's under the label `owner`, each login's password derived from the member's
 * owner password (templates.ts templatePassword), so a worker that never built the template derives them all. An
 * allocation is released when its scope closes, as a process's is, unless `keep` kept it: `keep`, run as the install
 * ends, keeps every allocation the install still holds, which is the template's installation, and what the install
 * released on its way (a fresh install it compared with) is gone from the template.
 */
const templateAllocations = (
	digest: string,
	cluster: BudgetedCluster
): Effect.Effect<{ readonly allocations: Allocations; readonly keep: Effect.Effect<void> }> =>
	Effect.map(
		Effect.all([Ref.make(HashSet.empty<string>()), Ref.make(HashSet.empty<string>())]),
		([live, kept]) => ({
			allocations: {
				schema: (label) => templateSchemaName(digest, label),
				ownerLogin: () => templateNames(digest).ownerLogin,
				password: (role) => templatePassword(cluster, role),
				released: (name, drop) =>
					Effect.asVoid(
						Effect.acquireRelease(Ref.update(live, HashSet.add(name)), () =>
							Effect.andThen(
								Ref.update(live, HashSet.remove(name)),
								Effect.flatMap(Ref.get(kept), (k) => (HashSet.has(k, name) ? Effect.void : drop))
							)
						)
					)
			},
			keep: Effect.flatMap(Ref.get(live), (held) => Ref.update(kept, HashSet.union(held)))
		})
	)

/**
 * What a former build of the template of digest `digest` left on the member, dropped as its bootstrap superuser before
 * the build installs: every role under its allocations (`gzt_<digest>_…`, names.ts templateSchemaName), and the live
 * source of each allocation, its installation's own among them (core/identity.ts identity.liveSource, `__live_<digest>`,
 * a decoder login and a replication slot of that name, which carry no allocation, so they are derived from it as the
 * sweep derives them, shared.ts). A role and a slot are the cluster's, not the template database's, so the toolchain's
 * collection, which drops a template no run declares any more (resources collect.ts), leaves them, and a later build of
 * the same digest (a tree or toolchain run again after another's) would meet them. A role that still owns an object
 * somewhere is a defect of the run, as the superuser's refusal is.
 */
const formerBuildDropped = (
	substrate: SubstrateShape,
	digest: string
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const rows = yield* substrate.admin.queryValues(
			"SELECT r.rolname::text FROM pg_catalog.pg_roles AS r WHERE pg_catalog.starts_with(r.rolname::text, $1) ORDER BY 1",
			[`gzt_${digest}_`]
		)
		const roles = Arr.map(rows, ([role]) => String(role))
		const allocations = Arr.dedupe([
			templateNames(digest).schema,
			...Arr.map(roles, (role) => Arr.headNonEmpty(Str.split("__")(role)))
		])
		for (const allocation of allocations) {
			const source = quoteString(identifierOf(identity.liveSource(allocation)))
			yield* substrate.superuser(
				`SELECT pg_catalog.pg_terminate_backend(active_pid) FROM pg_catalog.pg_replication_slots WHERE slot_name = ${source}::name AND active_pid IS NOT NULL`
			)
			yield* substrate.superuser(
				`SELECT pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots WHERE slot_name = ${source}::name`
			)
			yield* substrate.superuser(
				`DROP ROLE IF EXISTS ${quoteIdent(identifierOf(identity.liveSource(allocation)))}`
			)
		}
		for (const role of roles) {
			yield* substrate.superuser(`DROP ROLE ${quoteIdent(role)}`)
		}
	})

/**
 * A template of an installation over the base template (InstallSpec): its database is built by planning under the
 * template's schema name and installing the plan on a substrate over the template database, each worker plans it once
 * to bind its cases, and its cases clone it by any form (Substrate.freshOf, seat, rolledBack). Its identity is the
 * toolchain's: the declaring module's import closure, the name and the content, so an install that changes is a new
 * template, under new names.
 */
export const installTemplate = <P, T, E1, E2>(
	spec: InstallSpec<P, T, E1, E2>
): SubstrateTemplate<T> => {
	const planned = (template: DatabaseTemplate) =>
		Effect.flatMap(templateDigest(template), (digest) =>
			Effect.map(needFailedBy(spec.name, spec.plan(templateNames(digest))), (plan) => ({
				digest,
				plan
			}))
		)
	const database: DatabaseTemplate = Template.database({
		declaredIn: spec.declaredIn,
		name: spec.name,
		content: spec.content,
		from: baseTemplate,
		build: (target) =>
			Effect.scoped(
				Effect.gen(function* () {
					const { digest, plan } = yield* planned(database)
					const { cluster } = yield* target.member.leased
					const failed = sqlNeedFailed(spec.name, `the install in ${target.name}`)
					const admin = yield* Effect.mapError(
						connect(cluster, {
							database: target.name,
							credentials: ownerCredentials(cluster),
							label: "template admin"
						}),
						failed
					)
					const { allocations, keep } = yield* templateAllocations(digest, cluster)
					const spawning = yield* Layer.build(nodeSpawner)
					const substrate = yield* Effect.mapError(
						Effect.provideContext(build(cluster, target.name, admin, [], allocations), spawning),
						failed
					)
					yield* Effect.mapError(formerBuildDropped(substrate, digest), failed)
					yield* needFailedBy(
						spec.name,
						Effect.scoped(
							Effect.andThen(Effect.provideService(spec.install(plan), Substrate, substrate), keep)
						)
					)
				})
			)
	})
	return {
		database,
		reset: spec.reset,
		bound: Effect.map(
			planned(database),
			({ plan }) =>
				(binding) =>
					spec.bind(plan, binding)
		)
	}
}

/**
 * The substrate of a case over the database `take` gives it (from a need of the toolchain's resources, which a
 * runner's worker opens once and each case takes from): an admin connection to it as the owner, and the substrate built
 * over both (build), every connection drawing from the worker's lease on the database's member (test/support/runner.ts),
 * its schemas, roles, sessions and psql writers released as the case's scope closes, before the database goes back to
 * its need.
 */
const substrateOver = (
	form: string,
	taken: Database,
	spawning: Context.Context<ChildProcessSpawner.ChildProcessSpawner>
): Effect.Effect<SubstrateShape, NeedFailed, Scope.Scope> =>
	Effect.gen(function* () {
		const { cluster, held } = yield* taken.member.leased
		const failed = sqlNeedFailed(form, `the substrate in ${taken.name}`)
		const admin = yield* Effect.mapError(
			connect(cluster, {
				database: taken.name,
				credentials: ownerCredentials(cluster),
				label: "admin"
			}),
			failed
		)
		return yield* Effect.mapError(
			Effect.provideContext(build(cluster, taken.name, admin, held, processAllocations), spawning),
			failed
		)
	})

/**
 * A need of cases over `template`'s clones, each by `database` (a form of it), its substrate and its bound value, and
 * `settled`, what the form does once the case's own allocations are released, before its substrate's connections
 * close and the clone goes back to `database`.
 */
const substrateCases = <T>(
	form: string,
	template: SubstrateTemplate<T>,
	database: DatabaseNeed<Database>,
	settled: (substrate: SubstrateShape, value: T) => Effect.Effect<void>
): TemplateNeed<SubstrateCase<T>> => ({
	key: `grizzle ${form} ${database.key}`,
	template: database.template,
	open: Effect.map(
		Effect.all([database.open, Layer.build(nodeSpawner), template.bound]),
		([take, spawning, bind]) =>
			Effect.gen(function* () {
				const taken = yield* take
				const substrate = yield* substrateOver(form, taken, spawning)
				const value = bind(substrate)
				yield* Effect.addFinalizer(() => settled(substrate, value))
				return { substrate, value }
			})
	)
})

/** What a case over a clone of its own leaves behind: nothing to settle, as its clone is dropped. */
const dropped = (): Effect.Effect<void> => Effect.void

/**
 * One case's transaction on the worker's own clone of a template (Substrate.rolledBack): an owner connection inside the
 * case's one transaction, each statement its own savepoint within it (a statement PostgreSQL refuses is undone alone, as
 * it would be outside a transaction, and leaves the transaction open), the database and the budget it lives in, the
 * template's value, and a schema name the case may create its objects under. It has no end of the transaction and no
 * second session: whatever the case makes, it makes inside the transaction, which is rolled back when the case ends.
 */
export interface RolledBack<T> {
	readonly connection: PgConnection
	/**
	 * The connection itself, its statements not savepointed: for a harness that sets a savepoint of its own inside the
	 * case's transaction and rolls back to it (oracle/seat.ts), whose savepoint a statement's own release would end.
	 */
	readonly bare: PgConnection
	/** The same connection as a case's session: its statements, each its own savepoint, and no end of the transaction. */
	readonly session: CaseSession
	readonly cluster: BudgetedCluster
	readonly database: string
	readonly value: T
	/** A unique schema name under `label` (names.ts uniqueSchemaName), which no case of any worker takes again. */
	readonly schema: (label: string) => Effect.Effect<string>
}

/**
 * The worker's own clone of a template with one owner connection to it, held across the worker's cases
 * (Substrate.rolledBack): the scope both live in, the connection, the budget it draws from, the clone's name, and the
 * statement that puts every sequence of the clone back as it was cloned, none when it has no sequence.
 */
interface HeldTransactions {
	readonly scope: Scope.Closeable
	readonly connection: PgConnection
	readonly cluster: BudgetedCluster
	readonly database: string
	readonly sequences: Option.Option<string>
}

/**
 * The statement that puts every sequence of a database back as it stands now: a setval for each, to its last value
 * handed out, or to its start with is_called false when none has been; none when the database has no sequence. A
 * sequence is the one thing a transaction changes that its ROLLBACK keeps.
 */
const sequencesRestoreQuery = `SELECT pg_catalog.format('SELECT %s', pg_catalog.string_agg(pg_catalog.format('pg_catalog.setval(%L::regclass, %s, %s)',
		c.oid::regclass::text, COALESCE(pg_catalog.pg_sequence_last_value(c.oid), s.seqstart)::text,
		(pg_catalog.pg_sequence_last_value(c.oid) IS NOT NULL)::text), ', '))
FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_sequence AS s ON s.seqrelid = c.oid
WHERE c.relkind = 'S' AND c.relnamespace IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema')`

/** Clones the template into a scope of its own under `parent` and opens the owner connection to the clone there. */
const heldTransactions = (
	opened: Opened<Database>,
	parent: Scope.Scope
): Effect.Effect<HeldTransactions, NeedFailed> =>
	Effect.gen(function* () {
		const scope = yield* Scope.fork(parent)
		return yield* Effect.onError(
			Scope.provide(
				Effect.gen(function* () {
					const database = yield* opened.clone
					const { cluster } = yield* database.member.leased
					const failed = sqlNeedFailed("Substrate.rolledBack", `the connection to ${database.name}`)
					const connection = yield* Effect.mapError(
						connect(cluster, {
							database: database.name,
							credentials: ownerCredentials(cluster),
							label: "rolled back"
						}),
						failed
					)
					const restore = yield* Effect.mapError(
						connection.queryValues(sequencesRestoreQuery, []),
						failed
					)
					return {
						scope,
						connection,
						cluster,
						database: database.name,
						sequences: Option.filter(
							Option.flatMap(Arr.head(restore), Arr.head),
							(text): text is string => typeof text === "string"
						)
					}
				}),
				scope
			),
			() => Scope.close(scope, Exit.void)
		)
	})

/** A statement of no parameters. */
const bare = (sql: string): PgStatement => ({ sql, params: [] })

/** The savepoint every statement of a case's transaction runs under: set, released, and rolled back to. */
const savepointSet = bare("SAVEPOINT grizzle_case_statement")
const savepointReleased = bare("RELEASE SAVEPOINT grizzle_case_statement")
const savepointUndone = "ROLLBACK TO SAVEPOINT grizzle_case_statement"

/** The answer of a statement an exchange did not answer: a connection that answered fewer than it was sent. */
const unanswered = Result.fail(
	new SqlError({
		reason: {
			_tag: "ConnectionError",
			message: "the exchange answered fewer statements than it sent"
		},
		cause: undefined
	})
)

/**
 * `statements` under their own savepoint of the case's transaction, the savepoint, they and its release in one
 * exchange: their answers. When PostgreSQL refuses one, the transaction is rolled back to the savepoint, which leaves
 * it open for the next statement as autocommit would. A savepoint that cannot be set, released or rolled back to is a
 * transaction the case broke, a defect its release then reports.
 */
const undoneAlone =
	(connection: PgConnection): Exchange =>
	(statements) =>
		Effect.gen(function* () {
			const answers = yield* connection.exchange([savepointSet, ...statements, savepointReleased])
			yield* Effect.orDie(Effect.fromResult(Arr.headNonEmpty(answers)))
			const ran = Arr.map(statements, (_, index) =>
				Option.getOrElse(Arr.get(answers, index + 1), () => unanswered)
			)
			yield* Arr.every(ran, Result.isSuccess)
				? Effect.orDie(Effect.fromResult(Arr.lastNonEmpty(answers)))
				: Effect.orDie(connection.query(savepointUndone, []))
			return ran
		})

/** The statements that end a case's transaction and put the session back as it was opened. */
const caseEnd = Object.freeze({
	xid: bare("SELECT pg_catalog.pg_current_xact_id_if_assigned()::text"),
	rolledBack: bare("ROLLBACK"),
	discarded: bare("DISCARD ALL")
})

/** The first column of an answer's first row as text, none when it has no such text. */
const firstText = (answer: RawAnswer): Option.Option<string> =>
	Option.filter(
		Option.flatMap(Arr.head(answer.rows), Arr.head),
		(text): text is string => typeof text === "string"
	)

/**
 * After a case on a held connection, in one exchange: whether the case ended its transaction (its transaction id is no
 * longer the connection's), the transaction rolled back, every sequence put back, the session discarded (DISCARD ALL:
 * settings, prepared statements, advisory locks, temporary tables, listens), and `clean`'s report of the clone. A case
 * that ended its transaction, or after which the clone is not clean or could not be reset, fails, and its clone is
 * replaced.
 */
const endedTransaction = (
	held: HeldTransactions,
	xid: string,
	holding: Ref.Ref<Option.Option<HeldTransactions>>,
	clean: Option.Option<Check>
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const settled = yield* Effect.result(
			Effect.gen(function* () {
				const answers = yield* held.connection.exchange([
					caseEnd.xid,
					caseEnd.rolledBack,
					...Option.toArray(Option.map(held.sequences, bare)),
					caseEnd.discarded,
					...Option.toArray(Option.map(clean, (check) => check.statement))
				])
				const answered = yield* Effect.forEach(answers, Effect.fromResult)
				const still = Option.getOrUndefined(firstText(Arr.headNonEmpty(answered)))
				const left = Option.match(clean, {
					onNone: () => [],
					onSome: (check) => check.read(Arr.lastNonEmpty(answered).rows)
				})
				return still === xid ? left : [`the case ended its transaction ${xid}`, ...left]
			})
		)
		if (Result.isSuccess(settled) && settled.success.length === 0) {
			return
		}
		yield* Scope.close(held.scope, Exit.void)
		yield* Ref.set(holding, Option.none())
		return yield* Effect.die(
			NeedFailed.make({
				need: "Substrate.rolledBack",
				message: Result.match(settled, {
					onFailure: (error) =>
						`${held.database} could not be reset after the case: ${error.message}`,
					onSuccess: (what) =>
						`${Arr.join(what, ", ")}: ${held.database} is dropped, and the next case gets a new clone`
				})
			})
		)
	})

/**
 * The statements that begin a case's transaction, SERIALIZABLE as every grizzle write requires whatever its clone's
 * database defaults hold (a derived template's clone has none of the base's), and read the transaction id it is given.
 */
const caseStart: Arr.NonEmptyReadonlyArray<PgStatement> = [
	bare(beginSerializable),
	bare("SELECT pg_catalog.pg_current_xact_id()::text")
]

/**
 * The need of cases each in one owner transaction on the worker's own clone of `template`, held with its connection
 * across the worker's cases (HeldTransactions), `clean` reporting after every case what of the clone is not as cloned.
 */
const rolledBackCases = <T>(
	form: string,
	template: SubstrateTemplate<T>,
	clean: Option.Option<Check>
): TemplateNeed<RolledBack<T>> => ({
	key: `grizzle ${form} ${template.database.key}`,
	template: template.database,
	open: Effect.map(
		Effect.all([
			template.database.open,
			template.bound,
			Effect.scope,
			Ref.make(Option.none<HeldTransactions>())
		]),
		([opened, bind, parent, holding]) =>
			Effect.gen(function* () {
				const current = yield* Ref.get(holding)
				const held = Option.isSome(current)
					? current.value
					: yield* Effect.tap(heldTransactions(opened, parent), (made) =>
							Ref.set(holding, Option.some(made))
						)
				const failed = sqlNeedFailed(form, `the case's transaction on ${held.database}`)
				const begun = yield* Effect.mapError(
					Effect.flatMap(held.connection.exchange(caseStart), (answers) =>
						Effect.forEach(answers, Effect.fromResult)
					),
					failed
				)
				const xid = Option.getOrElse(firstText(Arr.lastNonEmpty(begun)), () => "")
				yield* Effect.addFinalizer(() => endedTransaction(held, xid, holding, clean))
				const allocations = yield* Ref.make(0)
				const binding = { cluster: held.cluster, database: held.database }
				const connection = exchanging(held.connection.processId, undoneAlone(held.connection))
				return {
					...binding,
					connection,
					bare: held.connection,
					session: {
						label: form,
						role: pgPin.devRole,
						database: held.database,
						pid: connection.processId,
						query: connection.query,
						values: connection.queryValues,
						pipeline: connection.pipeline
					},
					value: bind(binding),
					schema: (label: string) =>
						Effect.map(
							Ref.getAndUpdate(allocations, (n) => n + 1),
							(n) => uniqueSchemaName(label, n)
						)
				}
			})
	)
})

/**
 * The per-file PostgreSQL substrate: a database, unique schemas and roles, sessions, psql writers, a barrier.
 *
 * A test file runs in a shared database, cloned from the template once and reused (shared.ts), and because logins and
 * world roles are cluster-wide, each test uses a unique schema name. A test file builds Substrate.layer once
 * (`layer(Substrate.layer)(...)` from @effect/vitest);
 * schemas, roles, sessions and psql writers are allocated in each test's own scope and released when it closes, and
 * the file must return the database as it found it. A file that needs a whole database of its own, because it checks
 * the entire catalog or changes the database itself, builds Substrate.isolatedLayer and says why in a comment.
 *
 * Every connection reaches PostgreSQL itself, directly. A substrate first takes a cluster-wide connection lease for its
 * own life (shared.ts leaseConnections), so a process holds none once its substrates are released.
 *
 * Every role a test allocates is `<schema>__<name>`, the form of a login or world role (The cluster). The owner
 * creates it with CREATEROLE, which leaves the owner ADMIN OPTION only. The allocator also grants the role to the
 * owner WITH INHERIT TRUE, which the owner may do as the role's admin, for two reasons:
 * - pg_stat_activity shows a backend's wait event only to a viewer with the privileges of its role, and the
 *   lock-wait barrier reads it;
 * - DROP OWNED BY requires the privileges of the role, and the finalizer runs it before DROP ROLE.
 * The grant gives the owner more privileges, never the role: the role's own privileges are exactly what tests grant.
 * An owner login (ownerLogin) is the one role the other way round, a member of the owner that the owner is no member of,
 * so the bootstrap superuser makes and drops it.
 */
export class Substrate extends Context.Service<Substrate, SubstrateShape>()(
	"grizzle-workspace/test/support/substrate/substrate"
) {
	/**
	 * A case's own substrate, in a database of its own cloned from the base template (substrate/templates.ts
	 * baseTemplate) for the case and dropped after it: what a property's needs name, its check providing it as the
	 * Substrate service to what it runs (`Effect.provideServiceEffect(effect, Substrate, substrate)`).
	 */
	static readonly fresh: TemplateNeed<SubstrateShape> = {
		key: "grizzle Substrate.fresh",
		template: baseTemplate,
		open: Effect.map(
			substrateCases("Substrate.fresh", base, Database.fresh(baseTemplate), dropped).open,
			(take) => Effect.map(take, (taken) => taken.substrate)
		)
	}
	/** A case's own substrate over a clone of `template`, made for the case and dropped after it, and its value. */
	static readonly freshOf = <T>(template: SubstrateTemplate<T>): TemplateNeed<SubstrateCase<T>> =>
		substrateCases("Substrate.freshOf", template, Database.fresh(template.database), dropped)
	/**
	 * A case's own substrate over the worker's own clone of `template`, held across the worker's cases: after each, the
	 * case's allocations are released, the template's reset group emptied (SubstrateTemplate reset), every sequence put
	 * back, and the clone must hold its template's catalog and rows again, or it is replaced and the case fails.
	 */
	static readonly seat = <T>(template: SubstrateTemplate<T>): TemplateNeed<SubstrateCase<T>> =>
		substrateCases(
			"Substrate.seat",
			template,
			Database.seat(template.database, []),
			(substrate, value) => Effect.orDie(clearRows(substrate.admin, template.reset(value)))
		)
	/**
	 * One case's owner transaction on the worker's own clone of `template` (RolledBack), held with its connection across
	 * the worker's cases and rolled back when the case ends, its sequences put back and its session discarded: nothing the
	 * case does outlives it. A case that ends its transaction anyway fails, and the clone is replaced.
	 */
	static readonly rolledBack = <T>(template: SubstrateTemplate<T>): TemplateNeed<RolledBack<T>> =>
		rolledBackCases("Substrate.rolledBack", template, Option.none())
	/**
	 * One case's owner transaction on the worker's own clone of the base template, as Substrate.rolledBack, and after
	 * every case the clone judged clean by the substrate's own definition (shared.ts leftovers), a cheap assertion of
	 * what the rollback already guarantees: for the cases that read and evaluate on one owner session and commit nothing.
	 */
	static readonly transaction: TemplateNeed<RolledBack<void>> = rolledBackCases(
		"Substrate.transaction",
		base,
		Option.some(leftoversCheck)
	)
	/**
	 * The worker's place on its member (runner.ts PgMember leased): its lease's budget and the backend that holds the
	 * lease, and no database, for a case that opens connections of its own in the owner's database (a lease's own
	 * tables).
	 */
	static readonly member: Need<Lease> = {
		key: "grizzle Substrate.member",
		open: Effect.map(
			Effect.gen(function* () {
				const cluster = yield* PgCluster
				const worker = yield* WorkerIndex
				const member = yield* cluster.memberOf(worker)
				return yield* member.leased
			}),
			Effect.succeed
		)
	}
	/**
	 * A case's choice among a closed set of templates, each under `form`: one need per key, to spread into a property's
	 * needs, of which a case takes only the one it draws (`yield* resources[key]`).
	 */
	static readonly oneOf = <K extends string, T, A>(
		templates: Readonly<Record<K, SubstrateTemplate<T>>>,
		form: (template: SubstrateTemplate<T>) => TemplateNeed<A>
	): Readonly<Record<K, TemplateNeed<A>>> => Rec.map(templates, form)
	/** A shared database: build this layer once per file. It reads the initialised cluster once, as it builds. */
	static readonly layer = Layer.effect(Substrate, makeSubstrate).pipe(
		Layer.provide(Layer.mergeAll(nodeSpawner, InitializedCluster.layer))
	)
	/**
	 * A fresh database of the file's own, for a file that checks the whole catalog or changes the database itself, and
	 * for a bench. It reads the initialised cluster once, as it builds.
	 */
	static readonly isolatedLayer = Layer.effect(Substrate, makeIsolatedSubstrate).pipe(
		Layer.provide(Layer.mergeAll(nodeSpawner, InitializedCluster.layer))
	)
	/**
	 * A child process's substrate in the place the case that runs it lent it (makeLentSubstrate, shared.ts lend): a case
	 * holds its member's lease, so its child takes none and works in the case's own database.
	 */
	static readonly lentLayer = Layer.effect(Substrate, makeLentSubstrate).pipe(
		Layer.provide(Layer.mergeAll(nodeSpawner, InitializedCluster.layer))
	)
}

/** The sessions a case's substrate holds for its life (caseSubstrates): its admin's and its observer's (build). */
const caseSessions = ["admin", "observer"] as const

/** How many sessions a case's substrate holds for its life, which its width counts. */
export const caseSubstrateSessions: number = caseSessions.length

/**
 * A case's substrate of `width` connections (caseSubstrates): what the case realizes runs in it, in its database and
 * within its budget, for the case's scope.
 */
export type CaseSubstrate = (width: number) => Effect.Effect<SubstrateShape, SqlError, Scope.Scope>

/**
 * Substrates for the cases of a search to run at once, each case realizing state a case beside it must not meet: a
 * database's own settings and privileges among it, which a schema of its own does not keep apart. A case's substrate
 * holds, for the case's scope:
 * - `width` of the file's budget's permits, as a budget of its own (LeaseBudget within), which every connection its
 *   substrate and what it realizes open draws from, its admin's and observer's among them, so `width` counts both;
 * - a database no case beside it uses: one an earlier case ran in, whose scope has closed, or else a fresh clone of the
 *   template (pg.ts freshDatabase), which the case's own budget creates. The file clones as many as its cases ran at
 *   once at most, each handed from case to case, as the file's one database is between cases run one at a time.
 * A case first waits for its width among the test pool's permits (testPoolMax), which the file's lease grants beyond
 * its substrate's own sessions (packages/pg/src/lease.ts leaseGrant), so the cases at once never ask the file's budget
 * past what it holds free. A width past the whole test pool could never be admitted, and dies with
 * LeaseBudgetExhausted, the suite's defect.
 */
export const caseSubstrates: Effect.Effect<CaseSubstrate, never, Substrate | Scope.Scope> =
	Effect.gen(function* () {
		const file = yield* Substrate
		const spawning = yield* Layer.build(nodeSpawner)
		const admission = yield* Semaphore.make(testPoolMax)
		const free = yield* Ref.make<ReadonlyArray<string>>([])
		const database = (cluster: BudgetedCluster) =>
			Effect.acquireRelease(
				Effect.flatMap(
					Ref.modify(free, (names) => [Arr.head(names), Arr.drop(names, 1)] as const),
					Option.match({ onNone: () => freshDatabase(cluster), onSome: Effect.succeed })
				),
				(name) => Ref.update(free, (names) => [name, ...names])
			)
		return (width) =>
			Effect.gen(function* () {
				if (width > testPoolMax) {
					return yield* Effect.die(new LeaseBudgetExhausted({ width: testPoolMax }))
				}
				yield* Effect.acquireRelease(admission.take(width), () => admission.release(width))
				const budget = yield* file.cluster.budget.within(width)
				const cluster = budgeted(file.cluster, budget)
				const name = yield* database(cluster)
				const admin = yield* connect(cluster, {
					database: name,
					credentials: ownerCredentials(cluster),
					label: "admin"
				})
				return yield* Effect.provideContext(
					build(cluster, name, admin, file.held, processAllocations),
					spawning
				)
			})
	})
