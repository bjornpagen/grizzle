import { conservativeAgreement } from "#test/pg/oracle/conservative.fixtures.ts"
/**
 * The conservative lowering against the brute-force reference evaluator on PostgreSQL 19.
 *
 * Generated cases of the generator's own population, and of the same population with denser facts so that fewer
 * results are empty, each population a property of its own, each case in its own database under a plan perturbation: one to four relations with composite and candidate keys, closed rosters, pure sets and
 * containments, small-domain facts including NaN, -0, numeric display scales and supplementary-plane text in their
 * stored spellings, and queries over match, filter, project, semi- and anti-join, union, intersection, difference,
 * group, take, attach and recursion, at the root as a plain set, with attachments, or as a heterogeneous union. For
 * every case, every statement the conservative lowering emits returns exactly the canonical cell set the
 * reference evaluator computes by definition: the same rows, each once, since every statement delivers a set. And the
 * runner judges the case against itself (runner.ts runOracle, its second reading): its facts stored otherwise, another
 * storage order and one value in another spelling, under another plan, must deliver exactly the same rows, with no
 * reference in the judgment. A failing case shrinks and is reported in printable form.
 *
 * Oracle: the brute-force reference evaluator, and the case against itself under another storage and spelling.
 *
 * Features: the situations below, every operator kind among them, and each decline of the reference, rated.
 */
import { denseQueryCaseGen } from "#test/pg/oracle/support.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"

/**
 * The conservative lowering agrees with the reference evaluator on generated cases, raw text sets, no repeated row. Its
 * budget is its pre-conversion one: runs 2000, coverage cases 2000 (conservative.test.ts:48 at 41df7b58^), as dense's.
 */
export const generated = conservativeAgreement(
	queryCaseGen(defaultGenConfig),
	[
		{
			file: "packages/engine/src/lower/conservative/anti-join/index.ts",
			original: "\texistenceTest(cx, env, node, nodeLabel(node), true)",
			replacement: "\texistenceTest(cx, env, node, nodeLabel(node), false)",
			why: "The conservative AntiJoin lowers as a semi-join (lower/conservative/anti-join/index.ts)."
		}
	],
	{ runs: 2000, steered: 2000 }
)

/** The same agreement on generated cases with dense facts, so fewer results are empty. */
export const dense = conservativeAgreement(denseQueryCaseGen(defaultGenConfig), [], {
	runs: 2000,
	steered: 2000
})
