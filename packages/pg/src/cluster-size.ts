import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { clusterSize } from "#pg/size.ts"

/**
 * Prints the settings that size the local cluster to this machine (size.ts clusterSize), one
 * `<setting> <value>` line each, the value in the setting's own unit: what scripts/pg/lib.sh cluster_size reads for
 * init.sh and doctor.sh, so the shell holds no second spelling of either formula.
 */
const main = Effect.forEach(clusterSize, ([setting, value]) => Console.log(`${setting} ${value}`), {
	discard: true
})

NodeRuntime.runMain(main)
