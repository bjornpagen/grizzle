import {
	clusterUp,
	destroyCluster,
	freePort,
	localCluster,
	type PgMember,
	type Platform
} from "@bjornpagen/testing/pg"
import { ConfigProvider, Effect, FileSystem, type Scope } from "effect"
import { pgCluster } from "#test/support/env.ts"

/**
 * A cluster of grizzle's spec (pg.config.ts: its build, owner, template and extensions) that is one case's own: one
 * member on a port free when it is made, its connections sized per worker as the shared cluster's are and its other
 * sizes PostgreSQL's defaults, its state under a home of its own in the
 * temporary directory (whose path is short enough for the member's socket), made by the testing library as every member
 * is (@bjornpagen/testing/pg clusterUp: its TLS, hba and the settings every member holds), and destroyed, its postmaster
 * stopped, when the scope closes. For a case that changes a cluster's own state or needs its settings fresh from their
 * declaration, which the shared cluster's members fixed when they were made.
 */
export const privateCluster: Effect.Effect<PgMember, never, Scope.Scope | Platform> = Effect.gen(
	function* () {
		const fs = yield* FileSystem.FileSystem
		const home = yield* Effect.orDie(fs.makeTempDirectoryScoped({ prefix: "gz-pg-" }))
		const port = yield* Effect.orDie(freePort([]))
		const spec = localCluster({
			port,
			bin: pgCluster.bin,
			owner: pgCluster.owner,
			template: pgCluster.template,
			extensions: pgCluster.extensions,
			ownerParameters: pgCluster.ownerParameters,
			peerLogins: [],
			durability: "throwaway",
			sizing: {
				kind: "leased",
				family: { kind: "one" },
				connections: pgCluster.sizing.connections,
				replication: { kind: "default" },
				sharedBuffers: { kind: "default" },
				locks: { kind: "default" }
			}
		})
		const inHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.provideService(
				effect,
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromEnvRecord({ HOME: home })
			)
		yield* Effect.addFinalizer(() => Effect.ignore(inHome(destroyCluster(spec))))
		const [member] = yield* Effect.orDie(inHome(clusterUp(spec)))
		return member
	}
)
