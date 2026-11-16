import { defineRunner } from "@bjornpagen/testing/runner"
import { Layer } from "effect"

/**
 * `pnpm test:properties`: grizzle's property modules, which toolchain-test runs (`toolchain-test run [paths | ids]`), every
 * property's cases on one queue over one worker a core. A test module moves here from Vitest as its lane converts it:
 * vitest.config.ts and vitest.network.config.ts leave out every module this config includes, so the two runners
 * together run each test once, until Vitest is gone.
 *
 * The small-stack modules are vitest.config.ts's small-stack project's, which that config reads from here: the engine's
 * generative suites of the SQL printer and audit, the lowerings, the migration drafter, the write compiler and the text
 * refinements, and the canonical serializer's and the shapes', which read values nested to any depth, run a second
 * time on workers at about a sixth of Node's default stack (SMALL_STACK). The rewrite universe runs once: its plans are a
 * few operators over facts of two rows, which reach no width the stack bounds, and the generated rewrite modules run the
 * same pipeline under the small stack; the runner's globs have no negation, so the rewrite modules are named one by one.
 *
 * No module needs a service yet, so the layer is empty; grizzle's cluster service joins it with the network modules.
 */
export default defineRunner({
	include: [
		"test/unit/allen/**/*.test.ts",
		"test/unit/derived/**/*.test.ts",
		"test/unit/lower/catalog/**/*.test.ts",
		"test/unit/lower/codes.test.ts",
		"test/unit/lower/conservative/**/*.test.ts",
		"test/unit/lower/dedup/**/*.test.ts",
		"test/unit/lower/feedback.test.ts",
		"test/unit/lower/public-programs.test.ts",
		"test/unit/lower/recursion.test.ts",
		"test/unit/lower/refined-order.test.ts",
		"test/unit/lower/registry-types.test.ts",
		"test/unit/lower/selection-key.test.ts",
		"test/unit/lower/shapes/**/*.test.ts",
		"test/unit/lower/vector.test.ts",
		"test/unit/query/**/*.test.ts",
		"test/unit/recursion/**/*.test.ts",
		"test/unit/spans/**/*.test.ts"
	],
	smallStack: [
		"test/unit/sql/**/*.test.ts",
		"test/unit/lower/*.test.ts",
		"test/unit/lower/catalog/**/*.test.ts",
		"test/unit/lower/conservative/**/*.test.ts",
		"test/unit/lower/dedup/**/*.test.ts",
		"test/unit/lower/shapes/**/*.test.ts",
		"test/unit/lower/rewrite/closed.test.ts",
		"test/unit/lower/rewrite/eliminate.test.ts",
		"test/unit/lower/rewrite/existence.test.ts",
		"test/unit/lower/rewrite/frame.test.ts",
		"test/unit/lower/rewrite/fuse.test.ts",
		"test/unit/lower/rewrite/generated.test.ts",
		"test/unit/lower/rewrite/late-fetch.test.ts",
		"test/unit/lower/rewrite/prune.test.ts",
		"test/unit/lower/rewrite/pushdown.test.ts",
		"test/unit/lower/rewrite/simplify.test.ts",
		"test/unit/deploy/**/*.test.ts",
		"test/unit/write/**/*.test.ts",
		"test/unit/text/**/*.test.ts",
		"test/unit/core/lines.test.ts",
		"test/unit/core/canonical.test.ts",
		"test/unit/ir/shape.test.ts"
	],
	conditions: [],
	layer: Layer.empty,
	families: []
})
