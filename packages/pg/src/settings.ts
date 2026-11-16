import { clientCheckInterval } from "@grizzle/limits"
import type { Array as Arr } from "effect"

/**
 * The settings every member of a family holds exactly, whatever the machine, by name, each in its own unit:
 * cluster-settings.ts prints them, scripts/pg/init.sh writes them into every member and gives them to each it adopts, and
 * scripts/pg/doctor.sh requires each of every member exactly; never none, since the shell reads them a line each. The
 * settings sized to the machine are size.ts clusterSize.
 */
export const clusterSettings: Arr.NonEmptyReadonlyArray<readonly [setting: string, value: number]> =
	[["client_connection_check_interval", clientCheckInterval.value]]
