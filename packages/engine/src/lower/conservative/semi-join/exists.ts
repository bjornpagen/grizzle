import type { NodeOf } from "#compiler/ir/rel.ts"
import {
	columnIn,
	columnType,
	distinctSelect,
	type Env,
	extendEnv,
	headingTargets,
	type LowerContext,
	refuse
} from "#compiler/lower/conservative/context.ts"
import type { Expr, Select } from "#compiler/sql/ast.ts"
import {
	conjunction,
	exists,
	lit,
	notExists,
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
 */
export const existenceTest = (
	cx: LowerContext,
	env: Env,
	node: NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">,
	at: string,
	negated: boolean
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
	const correlated = cx.freeRefs(node.right).has(node.left.id)
	/** Over the feedback the right side is joined; otherwise it is lowered inside its EXISTS. */
	const right = feedback
		? cx.sourceAs(node.right, rightEnv, correlated)
		: cx.inSublink().source(node.right, rightEnv)
	const on: Array<Expr> = node.on.map((p) =>
		cx.equal(
			columnType(node.heading, p.left),
			columnIn(right.map, p.right),
			columnIn(left.map, p.left)
		)
	)
	const targets = headingTargets(node.heading, left.map)
	if (feedback) {
		return distinctSelect(targets, [left.item, right.item], on)
	}
	const witness = simpleSelect([target(lit.int(1, types.integer))], [right.item], conjunction(on))
	return distinctSelect(targets, [left.item], [negated ? notExists(witness) : exists(witness)])
}
