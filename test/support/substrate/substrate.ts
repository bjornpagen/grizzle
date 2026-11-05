import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Array as Arr, Context, Effect, Layer, Option, Redacted, Ref, type Scope } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { Client } from "pg"
import { trusted } from "#compiler/core/trusted.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { InitializedCluster, type InitializedClusterShape } from "#test/support/cluster.ts"
import { coverageAdminUrl, pgPin } from "#test/support/env.ts"
import {
	awaitRoleQuiet,
	type ClientBackend,
	endBackend,
	listedBackend
} from "#test/support/kernel/sanitize.ts"
import { testExitWait } from "#test/support/limits.ts"
import { freshDatabase, type PgConnection, type SqlError, sqlErrorOf } from "#test/support/pg.ts"
import { awaitBlockedBy, awaitLockWait, type LockWait } from "#test/support/substrate/barrier.ts"
import type { PsqlProcessError } from "#test/support/substrate/errors.ts"
import {
	defaultSchemaLabel,
	ownerLoginName,
	randomPassword,
	roleName,
	rolePrefix,
	uniqueSchemaName,
	uniqueSchemaNameOfLength
} from "#test/support/substrate/names.ts"
import {
	type BackendCancel,
	openPsql,
	type PsqlOptions,
	type PsqlWriter
} from "#test/support/substrate/psql.ts"
import {
	type Credentials,
	connect,
	openSession,
	ownerCredentials,
	type RawSession,
	type SubstrateWorld
} from "#test/support/substrate/session.ts"

import {
	claimSharedDatabase,
	leaseConnections,
	leftovers,
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
	 * The initialised cluster the substrate was built from: a substrate exists only once the cluster parsed, so code
	 * that holds one reads the cluster's CA certificates here and needs no InitializedCluster of its own.
	 */
	readonly cluster: InitializedClusterShape
	/** The database this file runs in, cloned from grizzle_template: a shared database, or a fresh one. */
	readonly database: string
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
	 * (held by `blockedBy`, when it names a backend).
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
 * Drops a role a test made: one the owner administers by terminating its sessions, dropping what it owns and every
 * privilege granted to it in this database, then the role; an owner login (ownerLogin), the one kind of test role that
 * is a member of the owner, which owns nothing, as the bootstrap superuser who made it. A no-op once the role is gone; a
 * backend that outlives its termination is a defect.
 */
export const dropRole = (admin: PgConnection, role: string): Effect.Effect<void, SqlError> =>
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
			return yield* dropOwnerLogin(String(database), role)
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
			[role, String(testExitWait.value)]
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
		yield* admin.query(`DROP OWNED BY ${quoteIdent(role)}`, [])
		yield* admin.query(`DROP ROLE ${quoteIdent(role)}`, [])
	})

/**
 * Drops a role a test allocated, once its backends are gone: the connection-leak check (kernel/sanitize.ts) waits on
 * pg_stat_activity, and a session the test never closed holds the release until Vitest's test timeout reports the test
 * hung. The sweep of crashed runs drops roles with dropRole itself, where leftover backends are expected.
 */
const releaseRole = (admin: PgConnection, role: string): Effect.Effect<void, SqlError> =>
	Effect.andThen(awaitRoleQuiet(admin, role), dropRole(admin, role))

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
 * superuser. It lives for the scope; a connection refused is a failure its caller makes a defect of the run.
 */
const superuserClient = (database: string, applicationName: string) =>
	Effect.acquireRelease(
		Effect.suspend(() => {
			const c = new Client({
				connectionString: coverageAdminUrl(database),
				application_name: applicationName,
				types: textTypes
			})
			return Effect.as(Effect.tryPromise({ try: () => c.connect(), catch: sqlErrorOf }), c)
		}),
		(c) => Effect.promise(() => c.end())
	)

/** Statements in `database` as the bootstrap superuser, in order, on one connection of their own (superuserClient). */
const asSuperuser = (database: string, statements: ReadonlyArray<string>): Effect.Effect<void> =>
	Effect.orDie(
		Effect.scoped(
			Effect.gen(function* () {
				const client = yield* superuserClient(database, "grizzle-substrate superuser")
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
const dropOwnerLogin = (database: string, role: string): Effect.Effect<void> =>
	asSuperuser(database, [
		`SELECT pg_catalog.pg_terminate_backend(a.pid, ${testExitWait.value}) FROM pg_catalog.pg_stat_activity AS a WHERE a.usename = ${quoteString(role)}::name`,
		`DROP ROLE IF EXISTS ${quoteIdent(role)}`
	])

/**
 * A read in `database` as the bootstrap superuser (SubstrateShape.superuserRead): one connection (superuserClient), one
 * SERIALIZABLE READ ONLY transaction around `read`, committed once it succeeds and rolled back with the connection
 * otherwise; each statement answers its rows as text.
 */
const asSuperuserRead = <A, E>(
	database: string,
	read: (rows: (sql: string) => Effect.Effect<TextRows>) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* Effect.orDie(superuserClient(database, "grizzle-substrate stored read"))
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
 * Builds the substrate over `database` of `cluster` in the current scope, with `admin` as its admin connection; its psql
 * writers are spawned by the scope's child-process spawner.
 */
const build = Effect.fnUntraced(function* (
	cluster: InitializedClusterShape,
	database: string,
	admin: PgConnection
): Effect.fn.Return<
	SubstrateShape,
	SqlError,
	Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const owner = ownerCredentials(cluster)
	const observer = yield* connect(cluster, { database, credentials: owner, label: "observer" })
	const allocations = yield* Ref.make(0)
	const nextAllocation = Ref.getAndUpdate(allocations, (n) => n + 1)

	/** A role finalizer that fails is a leaked cluster-wide role: surface it as a defect rather than hide it. */
	const registerRoleCleanup = (role: string) =>
		Effect.addFinalizer(() => Effect.orDie(releaseRole(admin, role)))

	const enableLogin = (role: string): Effect.Effect<Credentials, SqlError> =>
		Effect.gen(function* () {
			const password = randomPassword()
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

	/** A schema name the run holds: its finalizer drops every role named `<schema>__*` and each role's schema, then the
	 * schema; created as the owner when `create` says so. */
	const allocated = (name: string, create: boolean) =>
		Effect.gen(function* () {
			yield* Effect.addFinalizer(() =>
				Effect.orDie(
					Effect.gen(function* () {
						yield* dropRoleSchemas(rolePrefix(name))
						const roles = yield* admin.queryValues(
							"SELECT rolname::text FROM pg_catalog.pg_roles WHERE starts_with(rolname::text, $1::text) ORDER BY rolname",
							[rolePrefix(name)]
						)
						for (const [role] of roles) {
							yield* releaseRole(admin, String(role))
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
		Effect.flatMap(nextAllocation, (n) =>
			allocated(uniqueSchemaName(options.label, n), options.create)
		)

	const schemaOfLength = (label: string, bytes: number) =>
		Effect.flatMap(nextAllocation, (n) =>
			allocated(uniqueSchemaNameOfLength(label, n, bytes), false)
		)

	const role = (schemaName: string, roleOf: string) =>
		Effect.gen(function* () {
			const name = roleName(schemaName, roleOf)
			yield* registerRoleCleanup(name)
			yield* admin.query(`CREATE ROLE ${quoteIdent(name)} LOGIN`, [])
			return yield* enableLogin(name)
		})

	const login = (name: string) => Effect.andThen(registerRoleCleanup(name), enableLogin(name))

	const ownerLogin = (
		defaults: ReadonlyArray<RoleDefault>
	): Effect.Effect<Credentials, never, Scope.Scope> =>
		Effect.gen(function* () {
			const allocation = yield* nextAllocation
			const name = ownerLoginName(allocation)
			const password = randomPassword()
			const quoted = quoteIdent(name)
			yield* Effect.addFinalizer(() =>
				Effect.andThen(Effect.orDie(awaitRoleQuiet(admin, name)), dropOwnerLogin(database, name))
			)
			yield* asSuperuser(database, [
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
			if (Option.isSome(options.role)) {
				yield* raw.query(`SET ROLE ${quoteIdent(options.role.value)}`, [])
				yield* raw.resetStatements
			}
			return raw
		})

	/**
	 * A psql writer whose release ends once its backend has: psql's exit closes its connection without waiting for the
	 * server, and the release then ends the backend (endBackend), which a statement psql left running, waiting on a lock
	 * another session's open transaction holds, would keep alive until that session's own release, perhaps later in the
	 * same scope. So no writer's release waits on another session. Registered before the writer, this finalizer runs
	 * after the writer's own.
	 */
	const psql = (options: PsqlConnectOptions) =>
		Effect.gen(function* () {
			const started: { backend: Option.Option<ClientBackend> } = { backend: Option.none() }
			yield* Effect.addFinalizer(() =>
				Option.match(started.backend, {
					onNone: () => Effect.void,
					onSome: (backend) => Effect.orDie(endBackend(admin, backend))
				})
			)
			const writer = yield* openPsql(psqlOptions(options)).pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
			)
			const listed = yield* Effect.orDie(
				Effect.flatMap(writer.pid, (pid) => listedBackend(admin, pid))
			)
			started.backend = Option.some(listed)
			if (Option.isSome(options.role)) {
				yield* Effect.orDie(writer.run(`SET ROLE ${quoteIdent(options.role.value)}`))
				yield* writer.resetStatements
			}
			return writer
		})
	const psqlOptions = (options: PsqlConnectOptions): PsqlOptions => ({
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

	const roleExists = (name: string) =>
		Effect.map(
			admin.queryValues("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1::text", [name]),
			(rows) => rows.length > 0
		)

	return {
		cluster,
		database,
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
		superuser: (sql) => asSuperuser(database, [sql]),
		superuserRead: (read) => asSuperuserRead(database, read)
	}
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
	const cluster = yield* InitializedCluster
	yield* leaseConnections
	const claim = yield* claimSharedDatabase
	yield* Effect.addFinalizer(() =>
		Effect.orDie(
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
	return yield* build(cluster, claim.database, claim.admin)
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
	const cluster = yield* InitializedCluster
	yield* leaseConnections
	const database = yield* freshDatabase(cluster)
	const admin = yield* connect(cluster, {
		database,
		credentials: ownerCredentials(cluster),
		label: "admin"
	})
	return yield* build(cluster, database, admin)
})

/**
 * Node's child processes, which spawn the substrate's psql writers: private to the substrate's layers, with only the
 * file system and paths the spawner needs (no terminal or stdio, which would attach to the process's stdin).
 */
const nodeSpawner = NodeChildProcessSpawner.layer.pipe(
	Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
)

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
 * Every connection reaches PostgreSQL itself, directly. A process first takes its cluster-wide connection lease
 * (shared.ts leaseConnections).
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
}
