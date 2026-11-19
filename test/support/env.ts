import type { LocalCluster, PgMember } from "@bjornpagen/testing/pg"
import grizzleCluster from "#pg.config.ts"
import { pin } from "#pg/pin.ts"

/**
 * The repository's PostgreSQL pin (scripts/pg/pin.env): configuration from a repository file, which any module reads,
 * with no cluster present. Which member of the local cluster a process reaches, its port and socket, and what exists
 * only once the cluster is made, its owner's password and its CA certificates, are the InitializedCluster service's
 * (test/support/cluster.ts): no module reads a port of its own.
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
 * database's origin.
 */
export const pgCluster: LocalCluster = grizzleCluster

/**
 * The bootstrap superuser's URL to `database` over the local socket of `cluster`, the member this process reaches, where
 * peer authentication maps this OS user to it (@bjornpagen/testing/pg's hba).
 */
export const adminUrl = (cluster: PgMember, database: string): string =>
	`postgresql://postgres@localhost:${cluster.port}/${encodeURIComponent(database)}?host=${encodeURIComponent(cluster.socket)}`
