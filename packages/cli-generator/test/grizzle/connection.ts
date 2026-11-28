/**
 * How the grizzle tier connects to its cluster (pg.config.ts): what it reaches a member by, and a connection as grizzle
 * takes one, for a twin's layers and for grizzle's command line (grizzle.config.ts), which imports nothing more.
 */
import net from "node:net"
import type * as gRuntime from "@bjornpagen/grizzle/runtime"
import type { Redacted } from "effect"
import pg from "pg"

/**
 * What the tier reaches a member of the cluster by: its port, the CA its server certificate chains to, its owner's
 * password, which the testing library's member of the cluster (PgMember) carries.
 */
export interface Cluster {
	readonly port: number
	readonly ca: string
	readonly password: Redacted.Redacted
}

/** The name the cluster's server certificate carries, which a connection verifies. */
export const serverName = "localhost"

/**
 * The bound of every wait grizzle makes its caller state for the tier's calls (a heartbeat), in milliseconds: the
 * largest grizzle admits, so none of the tier's own fires, and the runner's hang guard on each case and each need's open
 * is the one bound on a wait that never ends.
 *
 * @limitKind derived
 * @owner the grizzle tier (test/grizzle)
 * @unit milliseconds
 * @scope an answer's heartbeat, each of the tier's twins
 * @derivation grizzle reads it as "an integer from 1 to 2,147,483,647" (HttpConfig.heartbeatMs), the largest delay
 *   Node's timers take; the loopback server and the CLI have no proxy or idle timeout between them for a heartbeat to
 *   keep open
 */
export const unboundedMillis = 2_147_483_647

/** A connection to `database` on the cluster as grizzle takes one, signing in with `password`. */
export const connectionTo = (
	cluster: Cluster,
	database: string,
	password: Redacted.Redacted
): gRuntime.DbConnection => ({
	driver: pg,
	transport: {
		kind: "sslRequest",
		host: serverName,
		port: cluster.port,
		open: () => new net.Socket(),
		ca: cluster.ca,
		servername: serverName
	},
	database,
	password
})
