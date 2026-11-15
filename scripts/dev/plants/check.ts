import { runDevtool } from "@bjornpagen/devtools/run"
import { Array as Arr, Console, Effect } from "effect"
import { findingsOf, findingText, readTree, repositoryRoot } from "#scripts/dev/plants/tree.ts"

/**
 * pnpm check's plant check: every plant a test cites is a file the repository holds, and every file under test/plants/
 * is a plant some test cites. A plant is a patch that breaks the code on purpose, and a test's header cites the plants
 * that must turn it red, one JSDoc tag each:
 *
 *   @plant test/plants/<suite>/<name>.patch <the bug it plants>
 *
 * It refuses a tag that names no such path or no bug, a citation outside a test (no test would run while its plant is
 * planted), a citation of a plant that is no file, a file under test/plants/ that no test cites, and two plants under
 * one name. It reads only the tree; `pnpm plants` runs the plants (scripts/dev/plants/run.ts).
 *
 *   node scripts/dev/plants/check.ts
 *
 * It exits 0 when it finds nothing and 1 when it finds something, each finding a line.
 */
const main = Effect.gen(function* () {
	const root = yield* repositoryRoot
	const tree = yield* readTree(root)
	const findings = findingsOf(tree)
	yield* Effect.forEach(findings, (finding) => Console.error(findingText(finding)), {
		discard: true
	})
	const cited = tree.plants.length
	yield* Console.log(
		Arr.isReadonlyArrayNonEmpty(findings)
			? `${findings.length} plant findings over ${cited} plants`
			: `${cited} plants, each a file some test cites, and every citation a plant the repository holds`
	)
	return Arr.isReadonlyArrayNonEmpty(findings) ? 1 : 0
})

runDevtool(main)
