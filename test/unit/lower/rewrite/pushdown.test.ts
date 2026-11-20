/**
 * Legal predicate movement, over generated queries (rewrite/guarded.ts): a filter moves through a projection, a union and
 * a group's key, below a semi-join's left side and onto a region's source, since no predicate raises on the rows it
 * meets there (scalar/compute/registry.ts Totality); a restriction on an aggregate's result and one over a correlated
 * source stay where they are, and below a take nothing moves at all. The query a move leaves delivers what the query it
 * was given delivers, by the reference evaluator, and every take the pass leaves in place delivers the rows it did, the
 * feature this notes: a filter moved below a take would rank other rows.
 *
 * Oracle: the reference evaluator's delivery of the query before the pass (the guard population's, rewrite/guarded.ts),
 * and the pass's own guard over a take: every filter the query holds over a take stands over that take after the pass,
 * since a generated take seldom holds a row past its bound that a filter would pass, where a moved filter's delivery
 * shows.
 * Features: each pushdown rule, each guard shape, a take that kept its rows.
 */
import { assert } from "@bjornpagen/testing/assert"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import { pushdownPass } from "#compiler/lower/optimize/pushdown/index.ts"
import { guardSearch, rowsAgreeAt } from "#test/unit/lower/rewrite/guarded.ts"
import { nodesOf } from "#test/unit/lower/rewrite/support.ts"

/**
 * Legal predicate movement moves a filter exactly where the move keeps its set, and nothing below a take.
 *
 * Budget: 200 runs and 600 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/pushdown.test.ts:27 at 8cad5bce, its runs and its coverage's cases).
 */
export const legalPredicateMovementMovesAFilterExactlyWhereTheMoveKeepsItsSetAndNothingBelowATake =
	guardSearch<"a take kept its rows">({
		runs: 200,
		passes: [pushdownPass],
		evidence: "snapshot",
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
		aims: [
			["pushdown.project", ["filterOver"]],
			["pushdown.group", ["filterOver"]],
			["pushdown.union", ["filterOver"]],
			["pushdown.left", ["filterOver"]],
			["pushdown.source", ["filterOver"]]
		],
		holds: (q, input, ran, c) => {
			const after = nodesByLabel(ran.query.dag)
			for (const filter of nodesOf(input.dag, "Filter")) {
				if (filter.input.kind === "Take") {
					const stays = after.get(filter.id)
					assert.equal(stays?.kind === "Filter" ? stays.input.id : undefined, filter.input.id)
				}
			}
			for (const take of nodesOf(input.dag, "Take")) {
				const kept = after.get(take.id)
				if (kept !== undefined && rowsAgreeAt(q, take, kept) === "agree") {
					c.note("a take kept its rows")
				}
			}
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/pushdown/index.ts",
				original:
					'\t\t\tcase "Base":\n\t\t\tcase "Closed":\n\t\t\tcase "Context":\n\t\t\tcase "InputSet":\n\t\t\tcase "Delta":\n\t\t\tcase "Filter":\n\t\t\tcase "Take":',
				replacement:
					'\t\t\tcase "Take":\n\t\t\t\treturn overDemand(({ demand }) => {\n\t\t\t\t\tif (!exclusive(cx, demand, xCell) || x.correlation.length > 0) {\n\t\t\t\t\t\treturn false\n\t\t\t\t\t}\n\t\t\t\t\tconst moved = filterOver(cx.editor, x.input, cx.editor.copyExpr(m.filter.pred, cx.editor.retarget(xCell, x.input)))\n\t\t\t\t\ttakeOver(cx.editor, m, { ...x, input: moved })\n\t\t\t\t\tcertify(cx, pushdownRules.left, m, xCell.id, [m.cell.id, moved.id])\n\t\t\t\t\treturn true\n\t\t\t\t})\n\t\t\tcase "Base":\n\t\t\tcase "Closed":\n\t\t\tcase "Context":\n\t\t\tcase "InputSet":\n\t\t\tcase "Delta":\n\t\t\tcase "Filter":',
				why: "A filter moved below an uncorrelated take, so the take ranks other rows; the pushdown-sites search fails."
			}
		]
	})
