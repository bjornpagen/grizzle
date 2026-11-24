import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { inputsOf, type NodeOf, type RelNode } from "#compiler/ir/rel.ts"
import {
	columnIn,
	type Env,
	extendEnv,
	headingTargets,
	type InputSource,
	type LowerContext,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { fencedRead } from "#compiler/lower/conservative/step/index.ts"
import type { ConservativeOptions } from "#compiler/lower/conservative/types.ts"
import { restrictedByKeys, restrictedWithin } from "#compiler/lower/optimize/cte-policy/index.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type { Expr, FromSource, Select } from "#compiler/sql/ast.ts"
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
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"

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
 * A right side read per left row (`readPerLeftRow`) is a step correlated inside it: its rows at the left row, the
 * join's equalities inside the step as outer references and the test's own condition empty, read apart by the one
 * printer of a step (lower/conservative/step fencedRead), `[NOT] EXISTS (SELECT 1 FROM (SELECT … FROM (<right>) AS r
 * WHERE r.k = l.k OFFSET 0) AS s)`. PostgreSQL never pulls a sublink whose FROM reads the outer query up into a join
 * (src/backend/optimizer/plan/subselect.c convert_EXISTS_sublink_to_join: past its WHERE, a sub-select that refers to a
 * Var of the parent query is refused, :1681 at REL_19_0), so the test is a subplan PostgreSQL plans once, its right
 * side planned apart with the join columns fixed as parameters, and runs per left row. In a bare EXISTS it pulls such a
 * right side up into the semi- or anti-join and plans the parameterizations of every subset of its relations by the
 * left side's: on edullm's ledger grade write (KDL-runtime, grizzle 3821324d3), an anti-join on six key columns over a
 * right side of 56 relations planned in 17 s, and the statement's 32 such reads past 8.5 minutes and 43.8 GB,
 * find_param_path_info its time. Navigation decides the same read of a rule statement's relational filters on the IR
 * (analysis/theory/navigate.ts `#filtered`, a Step node); this test decides it at lowering for every other existence,
 * because a semi-join's right side reads nothing of its left (ir/rel.ts SemiJoinRight, on which the key kernel's
 * semi-join facts rest), so no IR Step can carry the join's equalities into it, and because two of the facts it reads
 * are the lowering's: whether the statement derives the right side once, and what the statement is for.
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
		return select(cx.setOf(node, targets, [left.item, right.item], conjunction(on)))
	}
	const one = [target(lit.int(1, types.integer))]
	const witness = readPerLeftRow(cx, node, right)
		? simpleSelect(
				one,
				[
					cx.wrap(
						fencedRead(headingTargets(node.right.heading, right.map), right.item, conjunction(on)),
						node.right.heading,
						{ kind: "node", node: node.id }
					).item
				],
				undefined
			)
		: simpleSelect(one, [right.item], conjunction(on))
	return select(
		cx.setOf(node, targets, [left.item], negated ? notExists(witness) : exists(witness))
	)
}

/**
 * Whether an existence test reads its right side per left row, a step correlated inside it (existenceTest): a right side
 * that reads a stored relation (`readsStored`), whose join columns each restrict every relation it reads (cte-policy
 * restrictedByKeys), that the statement does not derive once (`derivedOnce`), in a statement that does not meet every
 * row of its left side (`readsWhole`), the right side one no value fixed where the test is evaluated restricts
 * (cte-policy restrictedWithin), the statement's or an outer row's, its own left row's aside. Each witness then reads
 * the right side's relations at the left row's values alone, its stored relations through the index the test's join
 * columns request (physical/access extract.ts), never the whole of it, whatever PostgreSQL estimates of either side: a
 * right side the write's restriction reaches only through its left side, which deriving it once would read all of
 * (cte-policy rule 5b). A scan of one stored relation is read so too: in a bare test PostgreSQL pulls it up into the
 * semi- or anti-join, whose method an estimate picks, and a hash join reads the relation at whatever the left side
 * fixes of it, the unit alone where the test's keys are a unit's and a row: rule-whole's Fanout tested each childless
 * node of a written document by a Hash Right Anti Join over a sequential scan of Node at the document, every stored
 * node read for the three it holds, once Node's document was declared at 1,024 rows on a table of 6,003. A right side
 * that reads no stored relation, only the statement's own sets (a delta, the call's input or context, a closed
 * relation's rows), stays in EXISTS, no index reading it per left row; so does a CTE's read, whose rows the statement
 * derives once whatever reads them; so does every test of a law's full violation query, whose tests a hash join of both
 * sides reads once; and so does a right side restricted where the test is evaluated, small derived once there, which a
 * probe of each left row would derive again for each: edullm's PERF-COMMIT submit at 100x read every processed attempt
 * against the call's previous attempts, a fold of its own 20 rows folded again for each of 1,650,480 rows (11.3 s),
 * where the 20 rows each probe the processed attempts' key once.
 */
const readPerLeftRow = (
	cx: LowerContext,
	node: NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">,
	right: InputSource
): boolean =>
	!readsWhole(cx.options.subject) &&
	!restrictedWithin(node.right, node) &&
	readsStored(node.right) &&
	restrictedByKeys(
		node.right,
		node.on.map((p) => p.right)
	) &&
	!derivedOnce(right)

/** Whether a right side reads a stored relation, a Base, which an index reads at the test's join columns. */
const readsStored = (right: RelNode): boolean =>
	postorder([right], (n) => inputsOf(n)).some((n) => n.kind === "Base")

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

/** Whether a lowered right side reads one relation, a CTE of the statement: a relation the statement derives once. */
const derivedOnce = (right: InputSource): boolean => {
	const read: Array<FromSource["kind"]> = []
	if (right.item.kind !== "derived") {
		return false
	}
	visitSelect(right.item.query, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind !== "derived" && item.kind !== "joins") {
				read.push(item.kind)
			}
		}
	})
	return read.length === 1 && (read[0] === "cte" || read[0] === "enclosing")
}
