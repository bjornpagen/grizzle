import { globSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { regex } from "arkregex"
import { Array as Arr, Order } from "effect"

/** The repository's root, from this module's place in it. */
const root = fileURLToPath(new URL("../..", import.meta.url))

/** An import of Vitest's, from it or its Effect adapter: a module that holds one is a Vitest suite. */
const vitestImport = regex('from "(?:vitest|@effect/vitest)"')

/** A binding a module exports: a test module's properties, each `export const` (test-module-shape). */
const exportedBinding = regex("^export const ", "m")

/**
 * The test modules toolchain-test runs (test.config.ts), from the repository root: every test module that exports its
 * properties and imports no Vitest, read off the modules themselves, so a converted module runs where it is and no list
 * beside the modules can leave one out. vitest.config.ts and vitest.network.config.ts leave out every module this
 * names, so the two runners together run each test once, until Vitest is gone. A module of neither is a Vitest suite
 * run through a helper of its own (laws/outcomes/witness.test.ts, page/generated-*.test.ts), which exports nothing.
 */
export const propertyModules: ReadonlyArray<string> = Arr.sort(
	Arr.filter(globSync("test/**/*.test.ts", { cwd: root }), (path) => {
		const text = readFileSync(join(root, path), "utf8")
		return exportedBinding.test(text) && !vitestImport.test(text)
	}),
	Order.String
)

/**
 * The modules that run on workers at about a sixth of Node's default stack (the runner's SMALL_STACK), on that stack
 * alone, in the runner and in the testing library's Vitest config alike. They are the engine's generative suites of the
 * SQL printer and audit, the lowerings, the migration drafter, the write compiler and the text refinements, and the
 * canonical serializer's and the shapes', which read values nested to any depth, so a per-element use of the stack fails
 * at the widths generators reach. The rewrite universe runs on the default stack: its plans are a few operators over
 * facts of two rows, which reach no width the stack bounds, and the generated rewrite modules run the same pipeline under
 * the small stack; the runner's globs take only * and **, so the rewrite modules are named one by one.
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
