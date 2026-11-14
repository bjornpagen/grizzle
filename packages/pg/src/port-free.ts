import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { localCluster } from "#pg/local-cluster.ts"
import { portFree } from "#pg/ports.ts"

import { regex } from "arkregex"

/**
 * Succeeds when the port its argument names, or with none the port of the local cluster GRIZZLE_PG_CLUSTER selects
 * (local-cluster.ts localCluster), is free on every address localhost names, each of which a cluster's
 * listen_addresses = 'localhost' binds (scripts/pg/init.sh), and otherwise fails with the first address it is taken at,
 * with a failing exit: init.sh creates no cluster, and no member of a family, on a taken port.
 */
const main = Effect.gen(function* () {
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const [arg, ...rest] = args
	if (rest.length > 0 || (arg !== undefined && !regex("^[1-9][0-9]{0,4}$").test(arg))) {
		return yield* Effect.die(new Error("usage: port-free.ts [port]"))
	}
	yield* portFree(arg === undefined ? localCluster.port : Number(arg))
})

NodeRuntime.runMain(main)
