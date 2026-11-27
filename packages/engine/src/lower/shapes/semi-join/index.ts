import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { NodeOf, RelNode } from "#compiler/ir/rel.ts"
import {
	type ColumnEqualities,
	columnIn,
	type Env,
	equalitiesOver,
	freshCtes,
	headingTargets,
	heldEnv,
	type InputSource,
	type LowerContext,
	noRestriction,
	holdsInside,
	restrictedEnv,
	withLeading
} from "#compiler/lower/conservative/context.ts"
import type { AtLeftRow } from "#compiler/lower/conservative/semi-join/exists.ts"
import { headingRead } from "#compiler/lower/conservative/step/index.ts"
import { pushedInto } from "#compiler/lower/shapes/share/keyed.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { col, conjunction, derived, distinctCore, select, targetAs } from "#compiler/sql/build.ts"
import type { NameOrigin } from "#compiler/sql/naming.ts"

/**
 * A semi-join its right side drives at `on` (cte-policy semiJoinDriven): the right side's DISTINCT keys at those pairs, and
 * for each key the left side at its values, read apart (step fencedRead, a LATERAL subquery with an OFFSET PostgreSQL
 * neither pulls up nor reorders), each value carried into the nodes under the left side that read it
 * (share/keyed.ts pushedInto), its region's chain led by the longest declared-key prefix the key binds:
 *
 *   SELECT l.* FROM (SELECT DISTINCT r.k1, ... FROM <right> AS r) AS k,
 *     LATERAL (SELECT ... FROM <left at k> AS l WHERE l.k1 = k.k1 ... OFFSET 0) AS l
 *
 * Each left row matches the one key of its own values, so the keys' DISTINCT keeps the semi-join's rows, each once
 * where the left side holds it once: a stage's latest attempts beside the sitting's existence test read the sitting's
 * stage's item sessions by (child, stage), then their attempts by their key, where the test's EXISTS left PostgreSQL to
 * read the child's every attempt first.
 */
export const drivenSemiJoin = (
	cx: LowerContext,
	env: Env,
	node: NodeOf<"SemiJoin">,
	on: NonEmptyReadonlyArray<NodeOf<"SemiJoin">["on"][number]>
): Select => {
	const origin = { kind: "node", node: node.id } as const
	const right = cx.source(node.right, env)
	const keysAlias = cx.relationAlias(origin)
	const pairs = mapNonEmpty(on, (p) => ({ ...p, column: cx.supply.column(origin) }))
	const keys = derived(
		select(
			distinctCore(
				mapNonEmpty(pairs, (p) => targetAs(columnIn(right.map, p.right), p.column)),
				[right.item],
				undefined
			)
		),
		keysAlias,
		false
	)
	const read = readPerDrivingRow(
		cx,
		env,
		node.left,
		pairs.map((p) => ({ column: p.left, value: col(keysAlias, p.column) })),
		origin
	)
	return select(
		cx.setOf(node, headingTargets(node.heading, read.map), [keys, read.item], undefined)
	)
}

/**
 * `node` read once per row of a driving set, each column of `restriction` equal to the driving row's value, apart (step
 * fencedRead, a LATERAL subquery with an OFFSET PostgreSQL neither pulls up nor reorders), each value carried into the
 * nodes under it that read it (atRowWalk), its region's chain led by the longest declared-key prefix the values bind: a
 * driven semi-join's left side at its right side's keys (drivenSemiJoin), and a page's rows at its window's driver rows
 * (lower/shapes/page/rows.ts drivenRows).
 */
export const readPerDrivingRow = (
	cx: LowerContext,
	env: Env,
	node: RelNode,
	restriction: ColumnEqualities,
	origin: NameOrigin
): InputSource => {
	const inside = holdsInside(node, restriction)
	const placed = atRowWalk(node, env, restriction)
	const source = cx.source(node, placed.env)
	return cx.wrapAs(
		withLeading(
			headingRead(
				node.heading,
				source.map,
				source.item,
				conjunction(inside ? [] : equalitiesOver(cx, node.heading, source.map, restriction))
			),
			placed.ctes
		),
		node.heading,
		origin,
		true
	)
}

/**
 * A node read once per row of a driver at `restriction`, the row's values of its columns, as a row site reads it: `env`
 * with the node at them, held inside it where its lowering places a restriction there (context.ts holdsInside), and
 * every node under it the restriction reaches (share/keyed.ts pushedInto) lowered there at them, never read from a set
 * the statement derives once; and the CTEs the site's query holds for the nodes under it read twice at them, defined at
 * their first read (context.ts restrictedRead). A driven semi-join's left side per right-side key, and an existence
 * test's right side per left row (semi-join/exists.ts AtLeftRow), are read so.
 */
export const atRowWalk: AtLeftRow = (node, env, restriction) => {
	const held = freshCtes<RelNode>()
	const placed = pushedInto(node, restriction, "held", held)
	return {
		env: heldEnv(
			restrictedEnv(
				env,
				new Map([
					[node, holdsInside(node, restriction) ? restriction : noRestriction],
					...placed.restricted
				])
			),
			placed.held
		),
		ctes: held.ctes
	}
}
