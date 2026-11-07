import { describe, it } from "@effect/vitest"
import { searched } from "@grizzle/testing/vitest"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import { pushdownPass } from "#compiler/lower/optimize/pushdown/index.ts"
import { guardSearch, rowsAgreeAt } from "#test/unit/lower/rewrite/guarded.ts"
import { nodesOf } from "#test/unit/lower/rewrite/support.ts"

/**
 * Legal predicate movement, over generated queries (rewrite/guarded.ts): a filter moves through a projection, a union and
 * a group's key, below a semi-join's left side and onto a region's source, since no predicate raises on the rows it
 * meets there (scalar/compute/registry.ts Totality); a restriction on an aggregate's result and one over a correlated
 * source stay where they are, and below a take nothing moves at all. The query a move leaves delivers what the query it
 * was given delivers, by the reference evaluator, and every take the pass leaves in place delivers the rows it did, the
 * feature this notes: a filter moved below a take would rank other rows.
 */
const pushdownSites = guardSearch<"a take kept its rows">({
	suite: "unit/lower/rewrite/pushdown-sites",
	passes: [pushdownPass],
	evidence: "snapshot",
	runs: 200,
	situations: [
		"pushdown.project",
		"pushdown.group",
		"pushdown.union",
		"pushdown.left",
		"pushdown.source",
		"a filter over a take",
		"a filter over a group",
		"an occurrence over a correlated source",
		"a take kept its rows"
	],
	holds: (q, input, ran, c) => {
		const after = nodesByLabel(ran.query.dag)
		for (const take of nodesOf(input.dag, "Take")) {
			const kept = after.get(take.id)
			if (kept !== undefined && rowsAgreeAt(q, take, kept) === "agree") {
				c.note("a take kept its rows")
			}
		}
	}
})

describe("legal predicate movement", () => {
	it.effect(
		"moves a filter exactly where the move keeps its set, and nothing below a take",
		(ctx) => searched(ctx, pushdownSites)
	)
})
