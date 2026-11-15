import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { clusterSettings } from "#pg/settings.ts"

/**
 * Prints the settings every member holds exactly (settings.ts clusterSettings), one `<setting> <value>` line each, the
 * value in the setting's own unit: what scripts/pg/lib.sh cluster_settings reads for init.sh and doctor.sh, so the shell
 * holds no second spelling of any.
 */
const main = Effect.forEach(
	clusterSettings,
	([setting, value]) => Console.log(`${setting} ${value}`),
	{
		discard: true
	}
)

NodeRuntime.runMain(main)
