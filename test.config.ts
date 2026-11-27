import { defineRunner } from "@bjornpagen/testing/runner"
import { grizzleCluster } from "#test/support/runner.ts"

/**
 * The CPU a whole run of grizzle's properties may spend, metered: its processes' (the runner, its workers and their
 * reaped children) and its sessions' PostgreSQL backends' (the runner's report.metered). A run past it fails, naming
 * what it spent: a regression to find, never a number to raise. Set from PIN 3's final gate, replaced before landing.
 *
 * @limitKind provisional
 * @owner grizzle's runner config (test.config.ts)
 * @unit milliseconds of metered CPU
 * @scope one whole run of the repository's properties (`toolchain-test run`), at its gate's width
 * @guards without a bound, a suite that grows, or a toolchain change that makes every clone dearer, passes every gate
 *   while it spends hours more (the toolchain's run budget, METIS-DBOPT's da451061)
 * @measure twice report.metered of PIN 3's final gate, a whole run with a fresh verdict cache, its run report the
 *   @evidence, with the run's interval, machine, load and width
 * @origin twice the largest whole run on record, 33,234,066 ms of its processes' CPU with no backend counted
 *   (STAMPRC-chk8, 1,994 properties, ~/.cache/toolchain-test/runs/2219874524-4083661.json): set from PIN 3's final
 *   gate, replaced before landing
 * @recorded 2026-11-27
 */
const runBudgetMillis = 66_468_133

/**
 * The modules that run on workers at about a sixth of Node's default stack (the runner's SMALL_STACK), on that stack
 * alone. They are the engine's generative suites of the SQL printer and audit, the lowerings, the migration drafter, the
 * write compiler and the text refinements, and the canonical serializer's and the shapes', which read values nested to
 * any depth, so a per-element use of the stack fails at the widths generators reach. The rewrite universe runs on the
 * default stack: its plans are a few operators over facts of two rows, which reach no width the stack bounds, and the
 * generated rewrite modules run the same pipeline under the small stack; the runner's globs take only * and **, so the
 * rewrite modules are named one by one.
 */
const smallStackModules: ReadonlyArray<string> = [
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

/**
 * grizzle's tests, every test module under test/, which toolchain-test runs (`toolchain-test run [paths | ids]`): `pnpm
 * test` the tiers that need no network, test/unit and test/types, and `pnpm test:network` the tiers that talk to the
 * local cluster, test/pg and test/schedules; every property's cases on one queue over one worker a core, the
 * small-stack modules a second time on small-stack workers. The layer is grizzle's cluster (test/support/runner.ts): the
 * local family as the PgCluster every database need clones from, each worker on one member under one connection budget,
 * built the first time a need reaches it, so a run of unit modules alone never reads the family. `pnpm mutate`
 * (`toolchain-test mutate`) alone loads its mutation (test/support/mutation/mutation.ts): grizzle's two operator
 * families beside the library's operators, set-semantics, a bag and set slip in any file, and sql-world, a compiler bug
 * in the SQL that installs and enters a world (families.ts), and the mutants judged equivalent. The CLI generator's
 * test modules, every one under packages/cli-generator/test/, run here too, and `pnpm test:cli-generator` runs them
 * alone, its grizzle tier on the same cluster.
 */
export default defineRunner({
	budget: { kind: "cpu", millis: runBudgetMillis },
	include: ["test/**/*.test.ts", "packages/cli-generator/test/**/*.test.ts"],
	smallStack: smallStackModules,
	conditions: [],
	environment: [],
	layer: grizzleCluster,
	mutation: () => import("#test/support/mutation/mutation.ts")
})
