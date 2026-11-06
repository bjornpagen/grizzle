import {
	appendNonEmpty,
	concatNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import type { ProducerNode } from "#compiler/ir/rel.ts"
import {
	type Env,
	extendEnv,
	type LowerContext,
	nodeLabel
} from "#compiler/lower/conservative/context.ts"

import {
	carriedTargets,
	type Contributions,
	type ProducerForm,
	producedQuery,
	spanArgument
} from "#compiler/lower/conservative/producers/shared.ts"
import type { FromItem, OperandSelect, Select, Target } from "#compiler/sql/ast.ts"
import {
	call,
	col,
	core,
	derived,
	distinctCore,
	keyedSet,
	lit,
	select,
	target
} from "#compiler/sql/build.ts"

/**
 * r.pack(s): the maximal covered segments of the spans of each group, one fact per component.
 *
 *   SELECT DISTINCT r4.c5, r5.c7
 *   FROM (SELECT r3.c3, range_agg(r3.c4)
 *         FROM (SELECT DISTINCT r2.c1, r2.c2 FROM (<input>) AS r2(c1, c2)) AS r3(c3, c4)
 *         GROUP BY r3.c3) AS r4(c5, c6),
 *        LATERAL unnest(r4.c6) AS r5(c7)
 *
 * Pack groups by the head's other terms, the carried columns, as an aggregate does: range_agg over the
 * explicit set input of a group is the group's coverage as a multirange, which normalizes overlapping and adjacent
 * spans into maximal components and keeps real gaps, and unnest yields one span per component.
 * range_merge would return a bounding range that fills gaps, so it is never the lowering. Normalization happens only
 * here, at the coverage operation, never on stored facts or ordinary projections.
 *
 * The grouped query runs over actual groups only, so no group has an empty aggregate and no NULL coverage arises;
 * a pack with no carried column groups by a constant private column `true` its input rows carry, as an
 * aggregate-only fold does (lower/conservative/group), so an empty input yields no group and no row. The
 * output is unique by construction: the GROUP BY makes the carried columns a key of the grouped rows, and the
 * components of one multirange are disjoint. range_agg folds the contributions as a set, keyed rows and never a
 * projection's repeats: SELECT DISTINCT makes them one, unless the input is a set the carried columns and the span key
 * (contributionsQuery). The conservative baseline closes both set boundaries, the contributions and the result; the
 * optimized lowering drops the result's, and the contributions' where they are keyed (lower/shapes/spans).
 */
export const packQuery = (
	node: ProducerNode<"spanPack">,
	cx: LowerContext,
	env: Env,
	form: ProducerForm
): OperandSelect => {
	const at = nodeLabel(node)
	const origin = { kind: "node", node: node.id } as const
	const input = cx.source(node.input, env)
	const scope = extendEnv(env, [[node.input.id, input.map]])
	const { arg: span } = spanArgument(cx, node, scope, at)
	const ungrouped = node.carried.length === 0
	/** The grouped input: the carried columns and the span, with the constant group column of an ungrouped pack. */
	const grouping: NonEmptyReadonlyArray<Target> = ungrouped
		? [target(span), target(lit.bool(true))]
		: [target(span)]
	const members = contributionsQuery(
		form.contributions,
		concatNonEmpty(carriedTargets(node, input.map), grouping),
		[input.item]
	)
	/** The member columns: one per carried column, the span, and the unit marker of an ungrouped pack. */
	const memberCarriedColumns = node.carried.map(() => cx.supply.column(origin))
	const memberSpanColumn = cx.supply.column(origin)
	const memberPresentColumns = ungrouped ? [cx.supply.column(origin)] : []
	const memberColumns = [...memberCarriedColumns, memberSpanColumn, ...memberPresentColumns]
	const memberAlias = cx.relationAlias(origin)
	const carried = memberCarriedColumns.map((c) => col(memberAlias, c))
	const grouped = select({
		...core(
			[
				...carried.map((e) => target(e)),
				target(call("range_agg", [col(memberAlias, memberSpanColumn)]))
			],
			[derived(members, memberAlias, memberColumns, false)],
			undefined
		),
		rows: ungrouped ? "oneRow" : "grouped",
		groupBy: ungrouped ? memberPresentColumns.map((c) => col(memberAlias, c)) : carried
	})
	/** The group columns: one per carried column, and the coverage multirange. */
	const groupCarriedColumns = node.carried.map(() => cx.supply.column(origin))
	const groupCoverageColumn = cx.supply.column(origin)
	const groupColumns = [...groupCarriedColumns, groupCoverageColumn]
	const groupAlias = cx.relationAlias(origin)
	const componentAlias = cx.relationAlias(origin)
	const component = cx.supply.column(origin)
	const components: FromItem = {
		kind: "function",
		call: call("unnest", [col(groupAlias, groupCoverageColumn)]),
		alias: componentAlias,
		columns: [component],
		lateral: true
	}
	return producedQuery(
		form.produced,
		appendNonEmpty(
			groupCarriedColumns.map((c) => target(col(groupAlias, c))),
			target(col(componentAlias, component))
		),
		[derived(grouped, groupAlias, groupColumns, false), components],
		undefined
	)
}

/**
 * The contributions a pack folds, the carried columns and the span of each input row, a set: SELECT DISTINCT, or a
 * plain read keyed by its targets, whose input the physical analysis proved a set they key (sql/build.ts keyedSet,
 * which refuses an input whose rows may repeat as a defect).
 */
const contributionsQuery = (
	contributions: Contributions,
	targets: NonEmptyReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>
): Select => {
	switch (contributions) {
		case "distinct":
			return select(distinctCore(targets, from, undefined))
		case "keyed":
			return select(keyedSet(targets, from, undefined, "a pack's contributions keyed by its input"))
	}
}
