import { pin } from "#pg/pin.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"

/**
 * The repository's PostgreSQL pin (scripts/pg/pin.env): configuration from a repository file, which any module reads,
 * with no cluster present. Which member of the local cluster family a process reaches, its port and socket, and what
 * exists only once `pnpm pg:init` has initialised it, its owner's password and its CA certificates, are the
 * InitializedCluster service's (test/support/cluster.ts): no module reads a port of its own.
 */
export const pgPin = {
	version: pin.PG_PIN_VERSION,
	vectorVersion: pin.PGVECTOR_PIN_VERSION,
	prefix: pin.GRIZZLE_PG_PREFIX,
	host: "localhost",
	devRole: pin.PG_DEV_ROLE,
	templateDatabase: pin.PG_TEMPLATE_DB
} as const

/**
 * The bootstrap superuser's URL to `database` over the local socket of `cluster`, the member this process reaches, where
 * peer authentication maps this OS user to it (scripts/pg/init.sh).
 */
export const adminUrl = (cluster: InitializedClusterShape, database: string): string =>
	`postgresql://postgres@localhost:${cluster.port}/${encodeURIComponent(database)}?host=${encodeURIComponent(cluster.socket)}`
