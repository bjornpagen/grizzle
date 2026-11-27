import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	concatNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { resultTextCasts } from "#compiler/codec/scalar.ts"
import type { Heading, NodeOf, RelNode } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import {
	columnIn,
	type ColumnMap,
	correlationEqualities,
	type Env,
	equalitiesOver,
	envOf,
	freshCtes,
	headingTargets,
	heldEnv,
	holdsInside,
	type LowerContext,
	restrictedEnv,
	withLeading
} from "#compiler/lower/conservative/context.ts"

import {
	type ParentRows,
	parentColumnsOf,
	parentKeysSource
} from "#compiler/lower/conservative/deliver.ts"
import {
	type OrderTotality,
	orderItemsOf,
	partialOrder
} from "#compiler/lower/conservative/take/order.ts"
import type { DeliveredBreach } from "#compiler/lower/conservative/types.ts"
import { resultCast } from "#compiler/lower/delivery.ts"
import { attachmentPrefix, attachmentRead } from "#compiler/lower/optimize/cte-policy/index.ts"
import { pushedInto } from "#compiler/lower/shapes/share/keyed.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { type DeliveryOrder, orderIsTotal } from "#compiler/lower/shapes/take/order.ts"
import { type FusedColumn, type FusedLayout, fusedElement } from "#compiler/runtime/lower/fused.ts"
import type {
	Cte,
	Expr,
	FromItem,
	OperandSelect,
	OrderItem,
	Select,
	Target
} from "#compiler/sql/ast.ts"
import {
	arrayOf,
	arrays,
	asc,
	call,
	col,
	cteRefAs,
	columnDefinition,
	conjunction,
	core,
	derived,
	countStar,
	distinctCore,
	gt,
	keyedSet,
	lit,
	ne,
	operandSelect,
	operandUnionAll,
	row,
	provedCore,
	select,
	simpleSelect,
	target,
	types
} from "#compiler/sql/build.ts"
import { namedQuery } from "#compiler/sql/naming.ts"

/**
 * What a fused array carries per child (decode.ts FusedLayout): each child column, from the element, or from the
 * parent row where the Attach correlates it to a parent column of the same type, which the parent row already
 * delivers (the first such). The correlation is native equality, and equal values decode to one host value (a
 * numeric's 1.0 and 1.00 are one Decimal, a float's -0 and 0 one zero), so the parent's cell delivers the child's
 * value whatever the type.
 */
export const fusedLayout = (
	attach: NodeOf<"Attach">,
	child: Heading,
	parent: Heading
): FusedLayout => ({
	columns: child.map((k): FusedColumn => {
		const carried = attach.correlation.find(
			(c) =>
				c.child === k.name &&
				parent.some((h) => h.name === c.parent && sameScalarType(h.type, k.type))
		)
		return {
			column: k,
			source:
				carried === undefined ? { from: "element" } : { from: "parent", parent: carried.parent }
		}
	})
})

/**
 * The child's rows for the parent bound in `parentMap`: SELECT [DISTINCT] <child heading> FROM (<child>) WHERE
 * <child column> = <parent column> ..., deduplicated unless the facts prove the child unique per parent binding.
 */
const childRows = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>,
	parentMap: ColumnMap,
	facts: ShapeFacts,
	lateral: boolean
): Select => {
	const child = attach.child
	const env: Env = envOf(spine.map((n) => [n.id, parentMap] as const))
	const source = cx.sourceAs(child, env, lateral)
	const where = correlationEqualities(cx, attach, child.heading, source.map, parentMap)
	const targets = headingTargets(child.heading, source.map)
	return select(
		facts.childUniquePerParent(attach).kind === "unproved"
			? distinctCore(targets, [source.item], conjunction(where))
			: provedCore("certified", targets, [source.item], conjunction(where))
	)
}

/**
 * The fused attachment column: ARRAY(SELECT <text> FROM (<child rows>) AS r(...) [ORDER BY ...]). The
 * child reads the delivered parent row through `parentMap`, the columns of the parent statement's derived table, so the
 * subquery is correlated to exactly the delivered parents. One field travels as text[], several as jsonb[] of
 * to_jsonb(ROW(...)) objects (decode.ts).
 */
const fusedAttachment = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>,
	parentMap: ColumnMap,
	facts: ShapeFacts
): Expr => {
	const child = attach.child
	const rows = childRows(cx, attach, spine, parentMap, facts, false)
	const wrapped = cx.wrap(rows, child.heading, { kind: "node", node: attach.id })
	/** The element's fields are columns of the child's heading. */
	const fields = fusedElement(fusedLayout(attach, child.heading, attach.parent.heading))
	const texts: NonEmptyReadonlyArray<Expr> = isNonEmpty(fields)
		? mapNonEmpty(fields, (c) => resultCast(columnIn(wrapped.map, c.name), resultTextCasts(c.type)))
		: [resultCast(lit.bool(true), ["text"])]
	const element: Expr = texts.length === 1 ? texts[0] : call("to_jsonb", [row(texts)])
	const orderBy: ReadonlyArray<OrderItem> =
		attach.order === undefined || child.heading.length === 0
			? []
			: orderItemsOf(attach.order, child.heading, wrapped.map, {
					leading: [],
					total: orderIsTotal(facts, attach.child, attach.order, child.heading),
					fixed: []
				})
	return {
		kind: "array",
		query: {
			...select(keyedSet([target(element)], [wrapped.item], undefined, "an attachment's array")),
			orderBy
		}
	}
}

/**
 * The breach of a fused attachment's delivered type, a bare child or an option, in a read-back
 * (conservative/types.ts ReadBackLowering): the parent's rows computed again by `recompute`, each with another count of
 * children than the type allows, counted over the rows its ARRAY reads.
 */
const fusedBreach = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	delivered: "one" | "option",
	spine: ReadonlyArray<RelNode>,
	recompute: () => OperandSelect,
	heading: Heading,
	origin: RelNode,
	facts: ShapeFacts
): DeliveredBreach => {
	const parent = cx.wrap(recompute(), heading, { kind: "node", node: origin.id })
	const rows = childRows(cx, attach, spine, parent.map, facts, false)
	const counted = cx.wrap(rows, attach.child.heading, { kind: "node", node: attach.id })
	const count: Expr = {
		kind: "subquery",
		query: simpleSelect([target(countStar())], [counted.item], undefined)
	}
	return {
		from: parent.item,
		when:
			delivered === "one"
				? ne(count, lit.int(1, types.integer))
				: gt(count, lit.int(1, types.integer)),
		delivered,
		key: parentColumnsOf(cx, attach, spine, heading).map((c) => ({
			field: c.name,
			expr: columnIn(parent.map, c.name),
			type: c.type
		}))
	}
}

/**
 * A parent statement with its fused attachments: the delivered parent rows read as a derived table, its
 * columns, then one array column per fused attachment, in order. The parent's own clauses stay inside its query, so a
 * page's seek, lookahead and order are those of the parent alone. PostgreSQL keeps no inner ORDER BY
 * through a derived table, so the outermost SELECT's ORDER BY is the delivery order: `order`, for an
 * ordered parent, is its compiler-completed order, re-applied with its keys' directions and completed by the heading
 * where the facts do not prove it total,
 * exactly as an unfused delivery orders it. An attachment never reorders its parents,
 * so the fused and pipelined forms deliver the same sequence (R36).
 *
 * In a read-back, the statement checks each fused child it delivers bare or as an option itself, over the parent's
 * rows `recompute` computes again (fusedBreach), and delivers its rows only when none breaks its type.
 */
export const withFusedAttachments = (
	cx: LowerContext,
	parent: OperandSelect,
	recompute: () => OperandSelect,
	heading: Heading,
	origin: RelNode,
	spine: ReadonlyArray<RelNode>,
	attachments: ReadonlyArray<NodeOf<"Attach">>,
	facts: ShapeFacts,
	/** The delivered rows' order, or undefined for an unordered delivery. */
	ordered: DeliveryOrder | undefined
): { readonly query: Select; readonly columns: ReadonlyArray<string> } => {
	const source = cx.wrap(parent, heading, { kind: "node", node: origin.id })
	const targets: Array<Target> = [...headingTargets(heading, source.map)]
	for (const attach of attachments) {
		targets.push(target(fusedAttachment(cx, attach, spine, source.map, facts)))
	}
	const orderBy: ReadonlyArray<OrderItem> =
		ordered === undefined || heading.length === 0
			? []
			: orderItemsOf(ordered.order, heading, source.map, {
					leading: [],
					total: ordered.total,
					fixed: []
				})
	const subject = cx.options.subject
	const [first, ...rest] =
		subject.kind === "readBack"
			? attachments.flatMap((a) =>
					a.delivered === "array"
						? []
						: [fusedBreach(cx, a, a.delivered, spine, recompute, heading, origin, facts)]
				)
			: []
	const raised =
		first === undefined || subject.kind !== "readBack"
			? undefined
			: subject.breach(cx.supply, [first, ...rest])
	return {
		query: {
			...select(keyedSet(targets, [source.item], raised?.guard, "a fused attachment's rows")),
			with: raised === undefined ? undefined : { recursive: false, ctes: [raised.cte] },
			orderBy
		},
		columns: attachments.map((a) => a.name)
	}
}

/**
 * An attachment's rows as its part delivers them, the parent key columns then the child's (deliveredHeading): its
 * query in its order; the same rows unordered, which a part with attachments of its own holds once; and that order
 * over rows of those columns, the parent key's read through `parent` and the child's through `child`.
 */
export interface PipelinedAttachment {
	readonly query: Select
	readonly rows: Select
	readonly order: (parent: ColumnMap, child: ColumnMap) => ReadonlyArray<OrderItem>
}

/**
 * An attachment's delivery order over rows of its columns: each parent key column ascending, then the child's order,
 * completed by the child's heading unless `total` (take/order.ts); none for an unordered attachment.
 */
export const attachmentOrder =
	(attach: NodeOf<"Attach">, parentColumns: Heading, total: OrderTotality) =>
	(parent: ColumnMap, child: ColumnMap): ReadonlyArray<OrderItem> =>
		attach.order === undefined
			? []
			: [
					...parentColumns.map((c) => asc(columnIn(parent, c.name))),
					...orderItemsOf(attach.order, attach.child.heading, child, {
						leading: [],
						total,
						fixed: []
					})
				]

/**
 * The child's rows for one parent key, its values fixed inside: the child at the correlation, pair for pair
 * (context.ts correlatedColumns, the conservative lowering's equalities: a key the Attach pairs with two parent columns
 * is restricted to both), each value carried into the nodes under it that read it (share/keyed.ts restrictionWalk), a
 * fold's keys below its aggregate and a union's in each arm, read as a LATERAL derived table PostgreSQL never pulls up:
 * a fold grouped, any other child under DISTINCT. So it runs once per parent key, each relation it reads restricted by
 * the key's values, and never joins its child to the parents' keys, which PostgreSQL may plan as the child derived
 * whole again for each key, the key a filter above it, nor reads it from a CTE derived whole, which no index reads.
 */
const keyedRows = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	env: Env,
	parentMap: ColumnMap,
	pairs: NodeOf<"Attach">["correlation"]
): OperandSelect => {
	const child = attach.child
	const correlation = pairs.map((c) => ({ column: c.child, value: columnIn(parentMap, c.parent) }))
	/**
	 * A child that holds the restriction itself (context.ts restrictsInside): a union in each arm, a region at the
	 * occurrence its chain leads with, a fold by every column the Attach correlates below its aggregate.
	 */
	const inside = holdsInside(child, correlation)
	const held = freshCtes<RelNode>()
	const placed = pushedInto(child, correlation, "held", held)
	const within = heldEnv(
		restrictedEnv(env, new Map([[child, inside ? correlation : []], ...placed.restricted])),
		placed.held
	)
	if (inside && child.kind === "Group") {
		return withLeading(cx.lower(child, within), held.ctes)
	}
	const source = cx.source(child, within)
	const where = inside ? [] : equalitiesOver(cx, child.heading, source.map, correlation)
	return withLeading(
		select(
			distinctCore(headingTargets(child.heading, source.map), [source.item], conjunction(where))
		),
		held.ctes
	)
}

/**
 * The child's rows for every parent key at once, where no declared-key prefix binds its correlation (attachmentRead
 * `coGroup`): the child derived once, whole, each of its columns an array of its rows at one correlation key, and the
 * parent keys co-grouped with those arrays by one GROUP BY over their tagged union, a parent key's group holding its
 * child's arrays, a child key no parent holds dropped by the HAVING, each array then unnested in lockstep:
 *
 *   SELECT g.k, u.c1, ... FROM (SELECT t.k, max(t.a1), ... FROM (SELECT p.k, true, false, '{}'::T1[], ... FROM
 *     <parent keys> UNION ALL SELECT c.k, false, true, c.a1, ... FROM (SELECT <child's correlated columns>,
 *     array_agg(c1), ... FROM <child> GROUP BY <them>) AS c) AS t GROUP BY t.k HAVING bool_or(t.parent) AND
 *     bool_or(t.child)) AS g, LATERAL (SELECT ... FROM unnest(g.a1, ...) AS u(c1, ...)) AS u
 *
 * A group holds at most one child row, whose arrays are never empty, beside the parent's empty ones, so max keeps the
 * child's; a child of no column is its keys' existence, the co-group's keys alone, each a parent's with a child row
 * (edullm's option attachments, an item session's openness). A GROUP BY is a hash or a sort of the rows it groups, never a nested loop, so the join of the parent keys to
 * the child is O(N + P) whatever PostgreSQL estimates, and the child, whose correlation no index reads at a key, is
 * derived once for every parent where read per key it read every key's rows of an unkeyed range again for each
 * (read-once's terms: each term's items read through its purpose's value, every package's), and where joined beside
 * its parents' keys its join's method was the estimate's.
 *
 * The co-group's key is the correlation itself, one column for each of its pairs: the parent's arm writes each pair's
 * parent column there, the child's arm each pair's child column, so a group joins a parent key to the child rows that
 * equal it at every pair, as the conservative lowering's equalities do, one a pair (context.ts correlationEqualities).
 * A child column paired with two parent columns stands in two keys, so its rows reach the parents whose two columns
 * hold its value; a parent column paired with two child columns writes its value into both, so only a child row whose
 * two columns hold it reaches its parent, where a key of each parent column took one of its pairs and dropped the
 * other's equality (the optimizer population's steered case 411 at seed 0x97ccc399, on[b=b, b=b_2]).
 */
const coGroupedRows = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	env: Env,
	parent: ReturnType<typeof parentKeysSource>
): {
	readonly from: ReadonlyArray<FromItem>
	readonly keys: ColumnMap
	readonly child: ColumnMap
} => {
	const child = attach.child
	const origin = { kind: "node", node: attach.id } as const
	const rows = cx.source(child, env)
	const pairs = attach.correlation
	const empty = (c: Heading[number]): Expr =>
		lit.text("{}", defined(arrayOf(cx.baseTypeRef(c.type)), "a base type's array"))
	/** The child's rows at each correlation key, each of its columns an array of them (`c`). */
	const groupedAlias = cx.relationAlias(origin)
	const groupedKeys = pairs.map(() => cx.supply.column(origin))
	const groupedArrays = child.heading.map(() => cx.supply.column(origin))
	const correlated = pairs.map((p) => columnIn(rows.map, p.child))
	const grouped = derived(
		namedQuery(
			select({
				...core(
					[
						...correlated.map((e) => target(e)),
						...child.heading.map((c) => target(call("array_agg", [columnIn(rows.map, c.name)])))
					],
					[rows.item],
					undefined
				),
				rows: "grouped",
				groupBy: correlated
			}),
			[...groupedKeys, ...groupedArrays]
		),
		groupedAlias,
		false
	)
	const parentArm = core(
		[
			...pairs.map((p) => target(parent.column(p.parent))),
			target(lit.bool(true)),
			target(lit.bool(false)),
			...child.heading.map((c) => target(empty(c)))
		],
		[parent.item],
		undefined
	)
	const childArm = core(
		[
			...groupedKeys.map((k) => target(col(groupedAlias, k))),
			target(lit.bool(false)),
			target(lit.bool(true)),
			...groupedArrays.map((a) => target(col(groupedAlias, a)))
		],
		[grouped],
		undefined
	)
	const taggedAlias = cx.relationAlias(origin)
	const taggedKeys = pairs.map(() => cx.supply.column(origin))
	const taggedParent = cx.supply.column(origin)
	const taggedChild = cx.supply.column(origin)
	const taggedArrays = child.heading.map(() => cx.supply.column(origin))
	const tagged = derived(
		namedQuery(operandSelect(operandUnionAll([parentArm, childArm])), [
			...taggedKeys,
			taggedParent,
			taggedChild,
			...taggedArrays
		]),
		taggedAlias,
		false
	)
	const keyExprs = taggedKeys.map((k) => col(taggedAlias, k))
	const coGroupAlias = cx.relationAlias(origin)
	const coGroupKeys = pairs.map(() => cx.supply.column(origin))
	const coGroupArrays = child.heading.map(() => cx.supply.column(origin))
	const coGroup = derived(
		namedQuery(
			select({
				...core(
					[
						...keyExprs.map((e) => target(e)),
						...taggedArrays.map((a) => target(call("max", [col(taggedAlias, a)])))
					],
					[tagged],
					undefined
				),
				rows: "grouped",
				groupBy: keyExprs,
				having: conjunction([
					call("bool_or", [col(taggedAlias, taggedParent)]),
					call("bool_or", [col(taggedAlias, taggedChild)])
				])
			}),
			[...coGroupKeys, ...coGroupArrays]
		),
		coGroupAlias,
		false
	)
	const childOrigin = { kind: "node", node: child.id } as const
	const unnestAlias = cx.relationAlias(childOrigin)
	const columns = child.heading.map((c, j) => ({
		definition: columnDefinition(cx.supply.column(childOrigin), cx.baseTypeRef(c.type)),
		array: col(coGroupAlias, defined(coGroupArrays[j], "a co-grouped array of each child column"))
	}))
	const [head, ...tail] = columns
	/**
	 * Each parent column read off a key of its pairs: in every group the HAVING keeps, the parent's arm wrote its value
	 * into the key of each pair it stands in, which the group's every row equals there, so any of them reads it.
	 */
	const keys = new Map(
		pairs.map(
			(p, i) => [p.parent, col(coGroupAlias, defined(coGroupKeys[i], "a co-grouped key"))] as const
		)
	)
	/** Whether the child holds no column: its keys' existence, the co-group's keys alone, each a parent's with a child row. */
	const existence = head === undefined
	if (existence) {
		return { from: [coGroup], keys, child: new Map() }
	}
	/** The child's rows of each co-grouped key, its arrays unnested in lockstep, LATERAL to the key's row. */
	const rowsAlias = cx.relationAlias(childOrigin)
	const rowColumns = columns.map(() => cx.supply.column(childOrigin))
	const unnested = derived(
		namedQuery(
			select(
				keyedSet(
					columns.map((c) => target(col(unnestAlias, c.definition.name))),
					[arrays({ kind: "carried", columns: [head, ...tail] }, unnestAlias)],
					undefined,
					"a co-grouped key's child rows its arrays carry"
				)
			),
			rowColumns
		),
		rowsAlias,
		true
	)
	return {
		from: [coGroup, unnested],
		keys,
		child: new Map(
			child.heading.map(
				(c, j) =>
					[c.name, col(rowsAlias, defined(rowColumns[j], "a co-grouped child column"))] as const
			)
		)
	}
}

/**
 * The pipelined attachment's part:
 *
 *   SELECT [DISTINCT] r1.c1, r3.c5, r3.c6 FROM (<the parent key's values>) AS r1(c1),
 *     LATERAL (<child, for r1's values>) AS r3(c4, c5, c6) [ORDER BY r1.c1, <child order>]
 *
 * The parent key columns `parentColumns` first (deliver.ts parentColumnsOf), then the child's heading. The parent's
 * rows are read as the set of their parent key values (ParentRows keys), each once, so DISTINCT is elided when the
 * facts prove the child unique per parent binding.
 *
 * The child is read as the CTE policy's attachmentRead decides, so no form derives it again for each parent row:
 *
 * - `perKey`: for each parent key, the child at its values (keyedRows), fixed inside a LATERAL derived table PostgreSQL
 *   never pulls up, each value carried into the nodes under it that read it (share/keyed.ts restrictionWalk): a child
 *   that folds by every column the Attach correlates (a Group whose keys hold them) is the fold of its parent's keys
 *   alone, `LATERAL (SELECT k, sum(…) FROM (<input>) WHERE k = r1.c2 GROUP BY k)` (aggregate/index.ts keyedGroup),
 *   where an index on the key reads its input per parent row; a grouped derived table is never flattened, so a
 *   correlation beside it is a join condition PostgreSQL keeps above the aggregate, which then reads every row of the
 *   child's relation (a grant's debited total folded every debit of every grant). A fold, a union or a join the child
 *   reads is read at the key too, the fold's keys below its aggregate, never a CTE of it derived whole for every
 *   parent at once and joined to each key beside (edullm's latest decision: the latest attempt of each session of its
 *   stage, a fold every attempt of the database fed). Any other child is its rows for the key under DISTINCT, which
 *   PostgreSQL never flattens either: flattened beside its parents' keys, the child was a join PostgreSQL planned as
 *   the child derived whole for each key, with every scan of a many-row table it estimates at one row (edullm's
 *   `versions`, every package's classifications derived for each of 183 heads).
 * - `take`: the take's one form, its probe per parent (R20, take/index.ts takeShape), beside.
 */
export const pipelinedAttachment = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>,
	rows: ParentRows,
	facts: ShapeFacts,
	parentColumns: Heading
): PipelinedAttachment => {
	const child = attach.child
	const parent = parentKeysSource(cx, rows, parentColumns, { kind: "node", node: attach.id })
	/** Each parent key column with its expression over the parent's rows. */
	const keys = parentColumns.map((c) => ({ name: c.name, expr: parent.column(c.name) }))
	const parentMap: ColumnMap = new Map(keys.map((k) => [k.name, k.expr]))
	const env: Env = envOf(spine.map((n) => [n.id, parentMap] as const))
	const origin = { kind: "node", node: child.id } as const
	const read = attachmentRead(attach)
	/** The CTEs the part's query holds: the child's rows at each prefix value, where it is read so. */
	const ctes: Array<Cte> = []
	/**
	 * The part's rows: the parent keys beside the child at each (`perKey`) or beside the take's form (`take`), or the
	 * co-group of both (`coGroup`), its parent keys and child columns each read through its own map.
	 */
	const part = ((): {
		readonly from: ReadonlyArray<FromItem>
		readonly keys: ColumnMap
		readonly child: ColumnMap
		readonly where: ReadonlyArray<Expr>
	} => {
		switch (read.kind) {
			case "perKey": {
				const prefix = attachmentPrefix(attach, (n) => cx.computedAt(n)) ?? []
				if (!isNonEmpty(prefix)) {
					const source = cx.wrapAs(
						keyedRows(cx, attach, env, parentMap, attach.correlation),
						child.heading,
						origin,
						true
					)
					return { from: [parent.item, source.item], keys: parentMap, child: source.map, where: [] }
				}
				/**
				 * The child at each distinct value of the prefix its parent keys hold whole (cte-policy attachmentPrefix), a
				 * range of its key read once a value, a MATERIALIZED CTE of the part's query, so its rows are derived once
				 * whatever join PostgreSQL places them in, where a derived table beside the parent keys was read again for
				 * each key on a nested loop's inner side; then joined to the parent keys on every column the attachment
				 * correlates.
				 */
				const keysAgain = parentKeysSource(cx, rows, parentColumns, {
					kind: "node",
					node: attach.id
				})
				const alias = cx.relationAlias(origin)
				const columns = mapNonEmpty(prefix, () => cx.supply.column(origin))
				const prefixRows = derived(
					namedQuery(
						select(
							distinctCore(
								mapNonEmpty(prefix, (c) => target(keysAgain.column(c.parent))),
								[keysAgain.item],
								undefined
							)
						),
						columns
					),
					alias,
					false
				)
				const prefixMap: ColumnMap = new Map(
					prefix.map(
						(c, i) => [c.parent, col(alias, defined(columns[i], "a prefix column"))] as const
					)
				)
				const source = cx.wrapAs(
					keyedRows(
						cx,
						attach,
						envOf(spine.map((n) => [n.id, prefixMap] as const)),
						prefixMap,
						prefix
					),
					child.heading,
					origin,
					true
				)
				const name = cx.relationAlias(origin)
				const cteColumns = cx.supply.columns(child.heading.map(() => origin))
				ctes.push({
					name,
					materialized: "MATERIALIZED",
					query: namedQuery(
						select(
							distinctCore(
								headingTargets(child.heading, source.map),
								[prefixRows, source.item],
								undefined
							)
						),
						cteColumns
					)
				})
				const childAlias = cx.relationAlias(origin)
				const childMap: ColumnMap = new Map(
					child.heading.map(
						(h, i) =>
							[
								h.name,
								col(childAlias, defined(cteColumns[i], "a child column's CTE column"))
							] as const
					)
				)
				return {
					from: [cteRefAs(name, childAlias), parent.item],
					keys: parentMap,
					child: childMap,
					where: correlationEqualities(cx, attach, child.heading, childMap, parentMap)
				}
			}
			case "take": {
				const source = cx.sourceAs(child, env, true)
				return {
					from: [parent.item, source.item],
					keys: parentMap,
					child: source.map,
					where: correlationEqualities(cx, attach, child.heading, source.map, parentMap)
				}
			}
			case "coGroup":
				return { ...coGroupedRows(cx, attach, env, parent), where: [] }
		}
	})()
	const childUnique = facts.childUniquePerParent(attach)
	const order = attachmentOrder(
		attach,
		parentColumns,
		childUnique.kind === "unproved" || attach.order === undefined
			? partialOrder
			: orderIsTotal(facts, attach.child, attach.order, child.heading)
	)
	const targets = concatNonEmpty(
		keys.map((k) => target(columnIn(part.keys, k.name))),
		headingTargets(child.heading, part.child)
	)
	const body =
		childUnique.kind === "unproved"
			? distinctCore(targets, part.from, conjunction(part.where))
			: provedCore("certified", targets, part.from, conjunction(part.where))
	return {
		query: withLeading({ ...select(body), orderBy: order(part.keys, part.child) }, ctes),
		rows: withLeading(select(body), ctes),
		order
	}
}
