import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { localCluster } from "#pg/local-cluster.ts"

/**
 * Prints the local cluster GRIZZLE_PG_CLUSTER selects (local-cluster.ts selectCluster), one `<variable>=<value>` line
 * each: its port and the paths of its state directory, which scripts/pg/lib.sh declares for every script, so the shell
 * holds no second spelling of either. A name that is no cluster fails the load, with a failing exit.
 */
const main = Effect.forEach(
	[
		["PG_PORT", `${localCluster.port}`],
		["GRIZZLE_PG_STATE", localCluster.state],
		["GRIZZLE_PG_DATA", localCluster.data],
		["GRIZZLE_PG_TLS", localCluster.tls],
		["GRIZZLE_PG_LOG", localCluster.log],
		["GRIZZLE_PG_SOCKET", localCluster.socket],
		["GRIZZLE_PG_DEV_PASSWORD_FILE", localCluster.passwordFile]
	] as const,
	([variable, value]) => Console.log(`${variable}=${value}`),
	{ discard: true }
)

NodeRuntime.runMain(main)
