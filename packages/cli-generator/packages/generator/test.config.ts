import { defineRunner, noMutation } from "@bjornpagen/testing/runner"
import { grizzleCluster } from "#test/grizzle/cluster.ts"
import { propertyModules } from "#test/support/roster.ts"

/**
 * `pnpm test:properties`: the generator's property modules (test/support/roster.ts), which toolchain-test runs
 * (`toolchain-test run [paths | ids]`), every property's cases on one queue over one worker a core. No module runs on a
 * small stack and none resolves with export conditions. The layer provides grizzle's local cluster as the PgCluster the
 * grizzle tier's databases are cloned on (test/grizzle/cluster.ts), read the first time a need reaches it, so a run of
 * no grizzle property touches no cluster; a check provides what else it runs itself (the platform is every check's),
 * and the operators of a mutation run are the library's.
 */
export default defineRunner({
	include: propertyModules,
	smallStack: [],
	conditions: [],
	layer: grizzleCluster,
	mutation: noMutation
})
