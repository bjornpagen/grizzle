import {
	bootstrapSuperuser,
	type LocalCluster,
	type PgMember,
	type WorkerSizing
} from "@bjornpagen/testing/pg"
import grizzleCluster, { clusterNetwork } from "#pg.config.ts"
import { pin } from "#pg/pin.ts"

/**
 * The repository's PostgreSQL pin (scripts/pg/pin.env): configuration from a repository file, which any module reads,
 * with no cluster present. Which member of the local cluster a process reaches, its port and socket, and what exists
 * only once the cluster is settled, its owner's password and the CA its server's certificate chains to, are the
 * InitializedCluster service's (test/support/cluster.ts): no module reads a port of its own.
 */
export const pgPin = {
	version: pin.PG_PIN_VERSION,
	vectorVersion: pin.PGVECTOR_PIN_VERSION,
	prefix: pin.GRIZZLE_PG_PREFIX,
	host: "localhost"
} as const

/**
 * grizzle's local cluster as pg.config.ts states it, which any module reads with no cluster present: its owner role,
 * grizzle_dev, the migration identity every installation is made by, and its template, grizzle_template, every test
 * database's origin; a cluster a run's workers reach (WorkerSizing), which the runner's layer takes.
 */
export const pgCluster: LocalCluster<WorkerSizing> = grizzleCluster

/**
 * The first port grizzle's families claim their members' from (pg.config.ts clusterNetwork): what a module that names
 * the cluster with no member at hand states, for a connection no test opens. A member's own port is its family's claim,
 * read through its member (test/support/cluster.ts clusterMembers).
 */
export const clusterPort: number = clusterNetwork.from

/**
 * The bootstrap superuser's URL to `database` over the local socket of `cluster`, the member this process reaches: the
 * account's own user (@bjornpagen/testing/pg bootstrapSuperuser), whom the member's socket trusts, at the port its
 * socket file is named by.
 */
export const adminUrl = (cluster: PgMember, database: string): string =>
	`postgresql://${encodeURIComponent(bootstrapSuperuser())}@localhost/${encodeURIComponent(database)}?host=${encodeURIComponent(cluster.socket)}&port=${cluster.port}`
