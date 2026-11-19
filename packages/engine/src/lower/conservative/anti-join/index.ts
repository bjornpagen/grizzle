import { isNonEmpty } from "#compiler/core/nonempty.ts"
import { operatorSchemaOf } from "#compiler/ir/compare.ts"
import type { Heading, NodeOf } from "#compiler/ir/rel.ts"
import {
	columnIn,
	type Env,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	nodeLabel
} from "#compiler/lower/conservative/context.ts"
import { existenceTest } from "#compiler/lower/conservative/semi-join/exists.ts"
import { armCore, armTargets, setOperation } from "#compiler/lower/conservative/union/arms.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { core, sameTypeRef } from "#compiler/sql/build.ts"

/** One pair of an anti-join: a left column and the right column it is compared with. */
type ColumnPair = NodeOf<"AntiJoin">["on"][number]

/**
 * The pairs of an anti-join a violation probe reads as a set difference, in its heading's order: in a law's full check
 * (deploy/snapshot/violation.ts), an anti-join whose right side reads nothing of its left and whose pairs compare each
 * column of its heading, the left's, once, with a right column of its base type, at the builtin operators
 * (ir/compare.ts operatorSchemaOf); none otherwise. Its rows are then the left's less the right's projected onto the
 * pairs, which EXCEPT computes by hashing or sorting each side once, whatever PostgreSQL estimates of them, where
 * NOT EXISTS lets it read the right again for each left row by a nested loop, the plan it chooses for a left it
 * underestimates, and a law that holds then runs it over every pair. Every compared column is NOT NULL, so EXCEPT's
 * equality, which matches NULLs, is the correlation's.
 */
const differencePairs = (
	node: NodeOf<"AntiJoin">,
	cx: LowerContext
): ReadonlyArray<ColumnPair> | undefined => {
	if (
		cx.options.subject.kind !== "violationProbe" ||
		cx.readsFeedback(node.right) ||
		cx.freeRefs(node.right).has(node.left.id) ||
		node.on.length !== node.heading.length ||
		new Set(node.on.map((p) => p.right)).size !== node.on.length ||
		node.left.heading.length !== node.heading.length
	) {
		return undefined
	}
	const pairs: Array<ColumnPair> = []
	for (const c of node.heading) {
		const p = node.on.find((q) => q.left === c.name)
		if (
			p === undefined ||
			operatorSchemaOf(cx.names, c.type) !== undefined ||
			!sameTypeRef(cx.baseTypeRef(c.type), cx.baseTypeRef(columnType(node.right.heading, p.right)))
		) {
			return undefined
		}
		pairs.push(p)
	}
	return pairs
}

/**
 * A violation probe's anti-join as a set difference (differencePairs):
 *
 *   SELECT r2.c1, r2.c2 FROM (<left>) AS r2(c1, c2) EXCEPT SELECT r3.c3, r3.c4 FROM (<right>) AS r3(c3, c4, c5)
 *
 * the left whole, an arm of its heading, and the right projected onto the right columns of the pairs, renamed to their
 * left columns, an operand whose rows may repeat, which EXCEPT makes a set.
 */
const exceptOf = (
	node: NodeOf<"AntiJoin">,
	cx: LowerContext,
	env: Env,
	pairs: ReadonlyArray<ColumnPair>
): Select => {
	const right = cx.source(node.right, env)
	const heading: Heading = pairs.map((p) => ({
		name: p.left,
		type: columnType(node.right.heading, p.right)
	}))
	const map = new Map(pairs.map((p) => [p.left, columnIn(right.map, p.right)] as const))
	return setOperation("EXCEPT", [
		armCore(cx, node.left, node.heading, env),
		core(armTargets(cx, heading, map), [right.item], undefined)
	])
}

/**
 * AntiJoin: keep a left tuple when no right witness exists; `r.not`.
 *
 *   SELECT DISTINCT r2.c1, r2.c2 FROM (<left>) AS r2(c1, c2)
 *   WHERE NOT EXISTS (SELECT 1 FROM (<right>) AS r3(c3, c4) WHERE r3.c3 = r2.c1)
 *
 * Relational negation is NOT EXISTS, never an outer join with an IS NULL test. Every compared column is
 * NOT NULL, so the correlation is two-valued and NOT EXISTS is exactly the anti-join. A violation probe's anti-join
 * whose pairs are its whole heading is EXCEPT (exceptOf).
 */
const lowerAntiJoin: NodeLowerer<"AntiJoin"> = (node, cx, env) => {
	const pairs = differencePairs(node, cx)
	return pairs !== undefined && isNonEmpty(pairs)
		? exceptOf(node, cx, env, pairs)
		: existenceTest(cx, env, node, nodeLabel(node), true)
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const antiJoinLowering: Lowerers<"AntiJoin"> = { AntiJoin: lowerAntiJoin }
