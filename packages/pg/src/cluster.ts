import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { clusterAt, localCluster } from "#pg/local-cluster.ts"

import { regex } from "arkregex"

/**
 * Prints the local cluster GRIZZLE_PG_CLUSTER selects (local-cluster.ts selectCluster), or the one its port argument
 * names, a member of that cluster's family (family.ts), one `<variable>=<value>` line each: its port and the paths of
 * its state directory, which scripts/pg/lib.sh declares for every script and for each member it acts on
 * (member_env), so the shell holds no second spelling of either. A name that is no cluster fails the load, and an
 * argument that is no port the run, with a failing exit.
 */
const main = Effect.gen(function* () {
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const [arg, ...rest] = args
	if (rest.length > 0 || (arg !== undefined && !regex("^[1-9][0-9]{0,4}$").test(arg))) {
		return yield* Effect.die(new Error("usage: cluster.ts [port]"))
	}
	const cluster = arg === undefined ? localCluster : clusterAt(Number(arg))
	yield* Effect.forEach(
		[
			["PG_PORT", `${cluster.port}`],
			["GRIZZLE_PG_STATE", cluster.state],
			["GRIZZLE_PG_DATA", cluster.data],
			["GRIZZLE_PG_TLS", cluster.tls],
			["GRIZZLE_PG_LOG", cluster.log],
			["GRIZZLE_PG_SOCKET", cluster.socket],
			["GRIZZLE_PG_DEV_PASSWORD_FILE", cluster.passwordFile]
		] as const,
		([variable, value]) => Console.log(`${variable}=${value}`),
		{ discard: true }
	)
})

NodeRuntime.runMain(main)
