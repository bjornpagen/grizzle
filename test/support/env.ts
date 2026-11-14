import { localCluster, pin } from "#pg/local-cluster.ts"

/**
 * The repository's PostgreSQL pin and the local cluster this process reaches (scripts/pg/pin.env, localCluster):
 * configuration from a repository file and the environment, which any module reads, with no cluster present. What
 * exists only once `pnpm pg:init` has initialised the cluster, its owner's password and its CA certificates, is the
 * InitializedCluster service's (test/support/cluster.ts).
 */
export const pgPin = {
	version: pin.PG_PIN_VERSION,
	vectorVersion: pin.PGVECTOR_PIN_VERSION,
	prefix: pin.GRIZZLE_PG_PREFIX,
	host: "localhost",
	state: localCluster.state,
	port: localCluster.port,
	devRole: pin.PG_DEV_ROLE,
	templateDatabase: pin.PG_TEMPLATE_DB
} as const

/**
 * The bootstrap superuser's URL to `database` over the cluster's local socket, where peer authentication maps this OS
 * user to it (scripts/pg/init.sh).
 */
export const adminUrl = (database: string): string =>
	`postgresql://postgres@localhost:${localCluster.port}/${encodeURIComponent(database)}?host=${encodeURIComponent(localCluster.socket)}`
