import { searchedOccurrence } from "#compiler/check/search/fence.ts"
import { extendEnv, type NodeLowerer, nodeLabel } from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { fencedScan } from "#compiler/lower/shapes/share/fence.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"
import { col, conjunction, lit, types } from "#compiler/sql/build.ts"

/**
 * A text search in the optimized lowering: a filter whose conjunction matches a stored search document its region binds
 * (check/search/fence.ts searchedOccurrence) reads that occurrence's relation through its fence, the match its own
 * condition, which the GIN index the search requested serves (physical/access/extract.ts textSearch):
 *
 *   SELECT ... FROM (SELECT r1.c1, ... FROM <table> AS r1
 *                    WHERE r1.<document> @@ websearch_to_tsquery(<configuration>, $1) OFFSET 0) AS r2(...), ...
 *   WHERE <the filter's conjunction>
 *
 * A subquery with an OFFSET is neither pulled up nor given a filter from outside (PostgreSQL 19 allpaths.c
 * subquery_is_pushdown_safe), so the filter's other conjuncts, the region's other matches and the rule's negations read
 * the matched rows above it, and no statistic of theirs prices the search: the shape is the program's, and no B-tree is
 * asked of the relation for them (extract.ts). The fence takes no bound: a match's rows are what the GIN index finds.
 * The filter keeps the match among its conjuncts, PostgreSQL's recheck of the rows the fence delivers. Any other filter
 * lowers as `lower` lowers it.
 */
export const searchFenced =
	(lower: NodeLowerer<"Filter">): NodeLowerer<"Filter"> =>
	(node, cx, env) => {
		const searched = searchedOccurrence(node)
		if (searched === undefined) {
			return lower(node, cx, env)
		}
		const at = nodeLabel(node)
		const { scan, body, alias } = fencedScan(
			cx,
			searched.base,
			env,
			at,
			`a text search over ${searched.base.relation} read by one plain scan its fence can match`
		)
		const match = lowerExpr(
			cx,
			searched.conjunct,
			extendEnv(env, [
				[
					node.input.id,
					new Map([
						[searched.variable, col(alias, cx.names.column(searched.base.relation, searched.field))]
					])
				]
			])
		)
		const fence: OperandSelect = {
			...scan,
			body: {
				...body,
				where: conjunction([...(body.where === undefined ? [] : [body.where]), match])
			},
			offset: lit.int(0, types.bigint)
		}
		return lower(
			node,
			cx.withLowering(searched.base, () => fence),
			env
		)
	}
