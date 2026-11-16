import { defineRunner } from "@bjornpagen/testing/runner"
import { propertyModules, smallStackModules } from "#test/support/roster.ts"
import { grizzleCluster } from "#test/support/runner.ts"

/**
 * `pnpm test:properties`: grizzle's property modules (test/support/roster.ts), which toolchain-test runs
 * (`toolchain-test run [paths | ids]`), every property's cases on one queue over one worker a core, the small-stack
 * modules a second time on small-stack workers. The layer is grizzle's cluster (test/support/runner.ts): the local
 * family as the PgCluster every database need clones from, each worker on one member under one connection lease, built
 * the first time a need reaches it, so a run of unit modules alone never reads the family.
 */
export default defineRunner({
	include: propertyModules,
	smallStack: smallStackModules,
	conditions: [],
	layer: grizzleCluster,
	families: []
})
