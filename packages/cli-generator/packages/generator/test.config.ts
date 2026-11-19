import { pgOwnerSession } from "@bjornpagen/testing/pg-session"
import { DatabasePrefix, PgCluster } from "@bjornpagen/testing/resources"
import { defineRunner, noMutation } from "@bjornpagen/testing/runner"
import generatorCluster from "#pg.config.ts"
import { propertyModules } from "#test/support/roster.ts"

declare module "@bjornpagen/testing/property" {
	interface RunnerServices {
		readonly cluster: PgCluster
	}
}

/**
 * `pnpm test:properties`: the generator's property modules (test/support/roster.ts), which toolchain-test runs
 * (`toolchain-test run [paths | ids]`), every property's cases on one queue over one worker a core. No module runs on a
 * small stack and none resolves with export conditions. The layer provides the generator's local cluster (pg.config.ts)
 * as the PgCluster the grizzle tier's databases are cloned on, every database named after the tier's prefix `eocg_`,
 * every session the owner's over node-postgres; the testing library makes and starts the cluster the first time a need
 * reaches it, so a run of no grizzle property touches no cluster. A check provides what else it runs itself (the
 * platform is every check's), and the operators of a mutation run are the library's.
 */
export default defineRunner({
	include: propertyModules,
	smallStack: [],
	conditions: [],
	layer: PgCluster.layer({
		prefix: DatabasePrefix("eocg_"),
		cluster: generatorCluster,
		connect: pgOwnerSession("eocg grizzle tier owner")
	}),
	mutation: noMutation
})
