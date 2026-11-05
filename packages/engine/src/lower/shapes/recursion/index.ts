import type { NodeOf } from "#compiler/ir/rel.ts"
import {
	type Env,
	headingTargets,
	type LowerContext,
	type NamedColumn,
	type NodeLowerer,
	namedMap,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { requireAdmittedFeedback } from "#compiler/lower/conservative/recursive/index.ts"
import { stateColumns, stateTerm } from "#compiler/lower/shapes/recursion/terms.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import type { Select, SelectCore } from "#compiler/sql/ast.ts"
import { core, cteRefAs, select } from "#compiler/sql/build.ts"

/** The recursive CTE of a recursion's state, its columns paired with the state columns. */
interface StateCte {
	readonly name: string
	readonly columns: ReadonlyArray<NamedColumn>
}

/** A read of the CTE's state columns under a fresh alias, in heading order. */
const readState = (cx: LowerContext, rec: NodeOf<"Recursive">, cte: StateCte): SelectCore => {
	const alias = cx.relationAlias({ kind: "node", node: rec.id })
	return core(
		headingTargets(rec.heading, namedMap(alias, cte.columns)),
		[cteRefAs(cte.name, alias)],
		undefined
	)
}

/**
 * Recursive relations in the optimized lowering.
 *
 * A recursion lowers to WITH RECURSIVE ... UNION, the native fixed point, a set of its complete declared state:
 *
 *      WITH RECURSIVE r1(c1, c2) AS (
 *        SELECT r2.id::uuid, 0::integer FROM network.person AS r2 WHERE r2.id = $1::uuid
 *        UNION
 *        SELECT r4.c5::uuid, r4.c6 + 1::integer FROM ... r1 AS r3 ... WHERE r3.c2 < 4::integer
 *      )
 *      SELECT r5.c1, r5.c2 FROM r1 AS r5
 *
 * UNION deduplicates the complete feedback state within and across iterations, so the seed and step SELECTs carry no
 * DISTINCT of their own when the placement realized them plain, and the complete final-state projection needs none
 * either; a later projection dropping state fields deduplicates where the placement puts it. UNION is never relaxed to
 * UNION ALL, whatever the edge keys, acyclicity or depth bound: dedup/policy.ts pins the Recursive realization
 * `distinct`, and a `plain` one is refused here. Each term is cast to the declared state representation (terms.ts).
 *
 * There is one form, whatever a counter proves of the recursion's depth: the recursive CTE is the fixed point at every
 * depth, and no threshold on a proved depth chooses another.
 *
 * Before it, the refusals of the conservative lowering apply (conservative/recursive requireAdmittedFeedback):
 * positive linear feedback and a hash operator class for every state column.
 */
export const recursionLowerer =
	(facts: ShapeFacts): NodeLowerer<"Recursive"> =>
	(node, cx, env) => {
		requireAdmittedFeedback(node)
		if (facts.realization(node) !== "distinct") {
			return refuse(
				"MalformedDescription",
				nodeLabel(node),
				"recursive feedback realized with its UNION: no UNION ALL elision applies to it"
			)
		}
		return recursiveForm(node, cx, env)
	}

const recursiveForm = (rec: NodeOf<"Recursive">, cx: LowerContext, env: Env): Select => {
	const origin = { kind: "node", node: rec.id } as const
	const cte: StateCte = { name: cx.relationAlias(origin), columns: stateColumns(cx, rec) }
	const base = stateTerm(cx, rec, rec.base, env)
	const step = stateTerm(cx.withFeedback(rec, cte.name, cte.columns), rec, rec.step, env)
	return {
		...select(readState(cx, rec, cte)),
		with: {
			recursive: true,
			ctes: [
				{
					name: cte.name,
					columns: cte.columns.map((c) => c.column),
					query: select({ kind: "setOp", op: "UNION", arms: [base, step] }),
					materialized: undefined
				}
			]
		}
	}
}
