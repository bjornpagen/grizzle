import { defineRunner } from "@bjornpagen/testing/runner"
import { Layer } from "effect"
import { propertyModules, smallStackModules } from "#test/support/roster.ts"

/**
 * `pnpm test:properties`: grizzle's property modules (test/support/roster.ts), which toolchain-test runs
 * (`toolchain-test run [paths | ids]`), every property's cases on one queue over one worker a core, the small-stack
 * modules a second time on small-stack workers. No module needs a service yet, so the layer is empty; grizzle's cluster
 * service joins it with the network modules.
 */
export default defineRunner({
	include: propertyModules,
	smallStack: smallStackModules,
	conditions: [],
	layer: Layer.empty,
	families: []
})
