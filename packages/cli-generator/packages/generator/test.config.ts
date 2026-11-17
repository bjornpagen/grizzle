import { defineRunner, noMutation } from "@bjornpagen/testing/runner"
import { Layer } from "effect"
import { propertyModules } from "#test/support/roster.ts"

/**
 * `pnpm test:properties`: the generator's property modules (test/support/roster.ts), which toolchain-test runs
 * (`toolchain-test run [paths | ids]`), every property's cases on one queue over one worker a core. No module runs on a
 * small stack, none resolves with export conditions, and the layer provides no service beyond the runner's own: a check
 * provides what it runs itself (the platform is every check's), and the operators of a mutation run are the library's.
 */
export default defineRunner({
	include: propertyModules,
	smallStack: [],
	conditions: [],
	layer: Layer.empty,
	mutation: noMutation
})
