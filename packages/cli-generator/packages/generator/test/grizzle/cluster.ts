/**
 * The grizzle tier's PostgreSQL (test.config.ts's layer): grizzle's local development cluster, which `grizzle-pg init`
 * makes at grizzle's pinned build, found as every consumer of grizzle finds it, through grizzle-pg's parse of the pin
 * (@bjornpagen/grizzle-pg/pin): its port, and its state directory, which holds its CA (tls/ca.crt) and its owner's
 * password (<owner>.password); the owner role, which owns every database the suite makes and runs its migrations; and
 * the template every database is made from. It is the one member of the PgCluster every database need of the tier
 * clones from, reached over verify-full TLS, as grizzle reaches every server.
 */
import { pin } from "@bjornpagen/grizzle-pg/pin"
import { NeedFailed } from "@bjornpagen/testing/property"
import {
	DatabasePrefix,
	PgCluster,
	type PgMember,
	type PgSession,
	Template
} from "@bjornpagen/testing/resources"
import { Effect, FileSystem, Layer, Path, Redacted, type Scope, String as Str } from "effect"
import pg from "pg"
import { type Cluster, serverName } from "#test/grizzle/connection.ts"

declare module "@bjornpagen/testing/property" {
	interface RunnerServices {
		readonly cluster: PgCluster
	}
}

declare module "@bjornpagen/testing/resources" {
	interface PgMember {
		/** What `grizzle-pg init` made of the member: its port, its CA and its owner's password. */
		readonly cluster: Cluster
	}
}

/** The cluster's owner role, which `grizzle-pg init` makes: every database the tier makes is its, and it migrates them. */
export const ownerRole = pin.PG_DEV_ROLE

/** A failure of the cluster as a need's: what was being done, and the driver's or the server's report. */
const clusterFailed = (doing: string) => (cause: unknown) =>
	NeedFailed.make({ need: "grizzle cluster", message: `${doing}: ${String(cause)}` })

/**
 * The cluster's facts, read from where `grizzle-pg init` wrote them: a cluster it never made fails every need that
 * reaches it, naming the command that makes it.
 */
const readCluster = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const state = pin.GRIZZLE_PG_DEFAULT_STATE
	const ca = yield* fs.readFileString(path.join(state, "tls", "ca.crt"))
	const written = yield* fs.readFileString(path.join(state, `${ownerRole}.password`))
	const cluster: Cluster = {
		port: pin.GRIZZLE_PG_DEFAULT_CLUSTER,
		ca,
		password: Redacted.make(Str.trim(written))
	}
	return cluster
}).pipe(
	Effect.mapError(
		clusterFailed(
			`reading grizzle's local cluster at ${pin.GRIZZLE_PG_DEFAULT_STATE} (make it with \`pnpm exec grizzle-pg init\` and start it with \`pnpm exec grizzle-pg start\`)`
		)
	)
)

/** A client of the owner in `database`, connected over verify-full TLS, ended with the scope. */
export const ownerClient = (
	cluster: Cluster,
	database: string,
	doing: string
): Effect.Effect<pg.Client, NeedFailed, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.tap(
			Effect.sync(
				() =>
					new pg.Client({
						host: serverName,
						port: cluster.port,
						user: ownerRole,
						password: Redacted.value(cluster.password),
						database,
						ssl: { ca: cluster.ca, servername: serverName },
						application_name: "eocg grizzle tier owner"
					})
			),
			(opened) => Effect.tryPromise({ try: () => opened.connect(), catch: clusterFailed(doing) })
		),
		(opened) => Effect.promise(() => opened.end())
	)

/**
 * A session as the owner in `database` on `member`, for the scope, every row's columns an array of the server's text:
 * its statements take turns on its one connection, as node-postgres's client queues each query behind the one it runs.
 */
const ownerSession = (
	member: PgMember,
	database: string
): Effect.Effect<PgSession, NeedFailed, Scope.Scope> =>
	Effect.map(
		ownerClient(member.cluster, database, `a session in ${database} on member ${member.name}`),
		(client): PgSession => ({
			query: (sql, params) =>
				Effect.map(
					Effect.tryPromise({
						try: () =>
							client.query<Array<unknown>>({ text: sql, values: [...params], rowMode: "array" }),
						catch: clusterFailed(`${sql} in ${database}`)
					}),
					(result) => result.rows
				)
		})
	)

/**
 * The prefix of every database the toolchain names for the tier on grizzle's cluster, apart from grizzle's own suites'
 * (`gz_`), so neither's collection drops the other's.
 */
export const databasePrefix = DatabasePrefix("eocg_")

/** An empty database, a clone of grizzle's template, as a template: what each twin installs the login into itself. */
export const emptyDatabase = Template.database({
	declaredIn: import.meta,
	name: "eocg grizzle empty",
	content: {},
	from: Template.cluster,
	build: () => Effect.void
})

/**
 * The runner layer test.config.ts provides: PgCluster over grizzle's cluster, read the first time a need asks
 * (PgCluster.layer reads nothing as it builds), every database made from grizzle's template and named after the tier's
 * prefix, the toolchain's owner sessions and advisory locks in the owner's own database.
 */
export const grizzleCluster: Layer.Layer<PgCluster, never, FileSystem.FileSystem | Path.Path> =
	Layer.unwrap(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			return PgCluster.layer({
				prefix: databasePrefix,
				members: readCluster.pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
					Effect.map((cluster): readonly [PgMember] => [{ name: String(cluster.port), cluster }])
				),
				base: pin.PG_TEMPLATE_DB,
				maintenance: ownerRole,
				connect: ownerSession
			})
		})
	)
