/**
 * The test modules toolchain-test runs (test.config.ts), as globs from the repository root: a test module moves here from
 * Vitest as its lane converts it, and vitest.config.ts and vitest.network.config.ts leave out every module this list
 * names, so the two runners together run each test once, until Vitest is gone. The list is data alone, so the Vitest
 * configs read it without loading the runner config's services.
 */
export const propertyModules: ReadonlyArray<string> = [
	"test/pg/substrate/forms.test.ts",
	"test/pg/substrate/budget.test.ts",
	"test/pg/substrate/exit.test.ts",
	"test/pg/substrate/fill.test.ts",
	"test/pg/substrate/lease.test.ts",
	"test/pg/substrate/orphan.test.ts",
	"test/pg/substrate/stopped.test.ts",
	"test/pg/substrate/substrate.test.ts",
	"test/unit/adapter/**/*.test.ts",
	"test/unit/allen/**/*.test.ts",
	"test/unit/bench/**/*.test.ts",
	"test/unit/cli/**/*.test.ts",
	"test/unit/client/**/*.test.ts",
	"test/unit/codec/**/*.test.ts",
	"test/unit/compute/**/*.test.ts",
	"test/unit/core/**/*.test.ts",
	"test/unit/deploy/**/*.test.ts",
	"test/unit/deps/**/*.test.ts",
	"test/unit/derived/**/*.test.ts",
	"test/unit/dev/toolchain-imports.test.ts",
	"test/unit/history/**/*.test.ts",
	"test/unit/http/**/*.test.ts",
	"test/unit/kernel/**/*.test.ts",
	"test/unit/live/**/*.test.ts",
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
	"test/unit/oracle-gen/**/*.test.ts",
	"test/unit/oracle-install/**/*.test.ts",
	"test/unit/oracle-runner/**/*.test.ts",
	"test/unit/oracle/**/*.test.ts",
	"test/unit/page/**/*.test.ts",
	"test/unit/query/**/*.test.ts",
	"test/unit/recursion/**/*.test.ts",
	"test/unit/scalar/**/*.test.ts",
	"test/unit/security/**/*.test.ts",
	"test/unit/served/**/*.test.ts",
	"test/unit/spans/**/*.test.ts",
	"test/unit/startup/**/*.test.ts",
	"test/unit/substrate/**/*.test.ts",
	"test/unit/support/**/*.test.ts",
	"test/unit/vector/**/*.test.ts",
	"test/unit/workload/**/*.test.ts",
	"test/unit/world-model/**/*.test.ts"
]

/**
 * The modules that run on workers at about a sixth of Node's default stack (the runner's SMALL_STACK): the runner runs
 * them a second time there, and Vitest runs them in its small-stack project alone (vitest.config.ts smallStackOnly). They
 * are the engine's generative suites of the SQL printer and audit, the lowerings, the migration drafter, the write
 * compiler and the text refinements, and the canonical serializer's and the shapes', which read values nested to any
 * depth, so a per-element use of the stack fails at the widths generators reach. The rewrite universe runs once: its plans are a few operators over facts of two rows, which reach no width the
 * stack bounds, and the generated rewrite modules run the same pipeline under the small stack; the runner's globs take
 * only * and **, so the rewrite modules are named one by one.
 */
export const smallStackModules: ReadonlyArray<string> = [
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
]
