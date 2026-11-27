import type { NodeOf, RelNode } from "#compiler/ir/rel.ts"
import {
	type ColumnEqualities,
	type ColumnMap,
	columnIn,
	type Env,
	extendEnv,
	headingTargets,
	type LowerContext,
	refuse,
	withLeading
} from "#compiler/lower/conservative/context.ts"
import { headingRead } from "#compiler/lower/conservative/step/index.ts"
import type { ConservativeOptions } from "#compiler/lower/conservative/types.ts"
import { rightPerLeftRow } from "#compiler/lower/optimize/cte-policy/index.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type { Cte, Expr, OperandSelect, Select } from "#compiler/sql/ast.ts"
import {
	conjunction,
	exists,
	lit,
	notExists,
	select,
	simpleSelect,
	target,
	types
} from "#compiler/sql/build.ts"

/**
 * The existence test shared by SemiJoin and AntiJoin: the left input filtered by EXISTS or NOT EXISTS
 * over the right input correlated on the join columns.
 *
 * Inside a recursive step, a right side that reads the feedback cannot sit in EXISTS: PostgreSQL refuses a recursive
 * reference inside a subquery expression (42P19). A semi-join is positive and monotone in its right
 * input, so it lowers there as a join whose SELECT DISTINCT over the left heading supplies the semi-join's set
 * semantics; the witness columns are never selected, so they do not contribute. An anti-join over the
 * feedback is negation of the current fixed point, refused by recursive/ before the step is lowered and
 * here again for any path that reaches this point.
 *
 * A right side read per left row (cte-policy rightPerLeftRow) is a step correlated inside it: its rows at the left row,
 * the join's equalities inside the step as outer references and the test's own condition empty, read apart by the one
 * printer of a step (lower/conservative/step fencedRead), `[NOT] EXISTS (SELECT 1 FROM (SELECT … FROM (<right>) AS r
 * WHERE r.k = l.k OFFSET 0) AS s)`, the right side lowered where `atLeftRow` places it at the left row's values (the
 * optimized lowering's restriction walk, lower/shapes/semi-join atRowWalk, each node it reaches lowered there at them,
 * never read from a set the statement derives once; the conservative lowering's, where it stands, a lowering that
 * derives nothing once). PostgreSQL never pulls a sublink whose FROM reads the outer query up into a join
 * (src/backend/optimizer/plan/subselect.c convert_EXISTS_sublink_to_join: past its WHERE, a sub-select that refers to a
 * Var of the parent query is refused, :1681 at REL_19_0), so the test is a subplan PostgreSQL plans once, its right
 * side planned apart with the join columns fixed as parameters, and runs per left row. In a bare EXISTS it pulls such a
 * right side up into the semi- or anti-join and plans the parameterizations of every subset of its relations by the
 * left side's: on edullm's ledger grade write (KDL-runtime, grizzle 3821324d3), an anti-join on six key columns over a
 * right side of 56 relations planned in 17 s, and the statement's 32 such reads past 8.5 minutes and 43.8 GB,
 * find_param_path_info its time. Navigation decides the same read of a rule statement's relational filters on the IR
 * (analysis/theory/navigate.ts `#filtered`, a Step node); this test decides it on the IR too, at lowering for every
 * other existence, because a semi-join's right side reads nothing of its left (ir/rel.ts SemiJoinRight, on which the
 * key kernel's semi-join facts rest), so no IR Step can carry the join's equalities into it; what the statement is for
 * (`readsWhole`) is the lowering's.
 */
export const existenceTest = (
	cx: LowerContext,
	env: Env,
	node: NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">,
	at: string,
	negated: boolean,
	atLeftRow: AtLeftRow
): Select => {
	const feedback = cx.readsFeedback(node.right)
	if (feedback && negated) {
		return refuse(
			"UnsupportedOperation",
			at,
			"positive linear feedback: an anti-join whose negated side reads the feedback"
		)
	}
	const left = cx.source(node.left, env)
	/** The right side sees the left's columns too: it may be correlated with them through outer references. */
	const rightEnv = extendEnv(env, [[node.left.id, left.map]])
	const targets = headingTargets(node.heading, left.map)
	/** The test's equalities over the right side's columns read through `right`. */
	const onOf = (right: ColumnMap): ReadonlyArray<Expr> =>
		node.on.map((p) =>
			cx.equal(
				columnType(node.heading, p.left),
				columnIn(right, p.right),
				columnIn(left.map, p.left)
			)
		)
	if (feedback) {
		/** Over the feedback the right side is joined. */
		const right = cx.sourceAs(node.right, rightEnv, cx.freeRefs(node.right).has(node.left.id))
		return select(cx.setOf(node, targets, [left.item, right.item], conjunction(onOf(right.map))))
	}
	const one = [target(lit.int(1, types.integer))]
	const perRow = readsWhole(cx.options.subject) ? undefined : rightPerLeftRow(node)
	const witness = ((): OperandSelect => {
		if (perRow === undefined) {
			const right = cx.inSublink().source(node.right, rightEnv)
			return simpleSelect(one, [right.item], conjunction(onOf(right.map)))
		}
		const placed = atLeftRow(
			node.right,
			rightEnv,
			perRow.map((p) => ({ column: p.right, value: columnIn(left.map, p.left) }))
		)
		const right = cx.inSublink().source(node.right, placed.env)
		return withLeading(
			simpleSelect(
				one,
				[
					cx.wrap(
						headingRead(node.right.heading, right.map, right.item, conjunction(onOf(right.map))),
						node.right.heading,
						{ kind: "node", node: node.id }
					).item
				],
				undefined
			),
			placed.ctes
		)
	})()
	return select(
		cx.setOf(node, targets, [left.item], negated ? notExists(witness) : exists(witness))
	)
}

/**
 * Where an existence test lowers its right side read per left row (cte-policy rightPerLeftRow): `env` with the right
 * side `node` at `restriction`, the left row's values of its join columns, and the CTEs the witness's query holds for
 * the nodes under it read twice at them, defined at their first read (context.ts restrictedRead).
 */
export type AtLeftRow = (
	node: RelNode,
	env: Env,
	restriction: ColumnEqualities
) => { readonly env: Env; readonly ctes: Iterable<Cte> }

/** A right side lowered where it stands: a lowering that derives no set once reads each node where it is read. */
export const asItStands: AtLeftRow = (_, env) => ({ env, ctes: [] })

/**
 * Whether a lowering's existence tests meet every row of their left sides: a law's full violation query, the migration's
 * probe of every stored fact (deploy/snapshot/violation.ts), whose tests a hash join of both sides reads once, where a
 * read per left row would probe the right side for each stored row. Every other lowering reads a unit's rows: a query's
 * or a write's by their parameters, a rule's probe by its delta, a read-back by its write's, a membership at one row.
 */
const readsWhole = (subject: ConservativeOptions["subject"]): boolean => {
	switch (subject.kind) {
		case "violationProbe":
			return true
		case "query":
		case "write":
		case "ruleRegion":
		case "readBack":
		case "membership":
			return false
	}
}
