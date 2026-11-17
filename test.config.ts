import { defineRunner } from "@bjornpagen/testing/runner"
import { setSemantics, sqlWorld } from "#test/support/mutation/families.ts"
import { propertyModules, smallStackModules } from "#test/support/roster.ts"
import { grizzleCluster } from "#test/support/runner.ts"

/**
 * `pnpm test:properties`: grizzle's property modules (test/support/roster.ts), which toolchain-test runs
 * (`toolchain-test run [paths | ids]`), every property's cases on one queue over one worker a core, the small-stack
 * modules a second time on small-stack workers. The layer is grizzle's cluster (test/support/runner.ts): the local
 * family as the PgCluster every database need clones from, each worker on one member under one connection lease, built
 * the first time a need reaches it, so a run of unit modules alone never reads the family. `pnpm mutate`
 * (`toolchain-test mutate`) mutates with the library's operators and grizzle's two families
 * (test/support/mutation/families.ts): set-semantics, a bag and set slip in any file, and sql-world, a compiler bug in
 * the SQL that installs and enters a world.
 */
export default defineRunner({
	include: propertyModules,
	smallStack: smallStackModules,
	conditions: [],
	layer: grizzleCluster,
	families: [setSemantics, sqlWorld]
})
