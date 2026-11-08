import { resultTextCasts } from "#compiler/codec/scalar.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import {
	concatNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import type { Cardinality } from "#compiler/ir/cardinality.ts"
import type { CompletedOrder, Heading, NodeOf, RelNode } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import {
	type ColumnMap,
	columnIn,
	correlationEqualities,
	type Env,
	headingTargets,
	type LowerContext
} from "#compiler/lower/conservative/context.ts"

import {
	type ParentRows,
	parentColumnsOf,
	parentColumnsRead,
	parentRowsSource
} from "#compiler/lower/conservative/deliver.ts"
import type { DeliveredBreach } from "#compiler/lower/conservative/types.ts"
import { keyedGroup } from "#compiler/lower/shapes/aggregate/index.ts"
import {
	type FusedColumn,
	type FusedLayout,
	fusedElement
} from "#compiler/lower/shapes/attach/decode.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import type { ChoiceInput } from "#compiler/lower/shapes/take/index.ts"
import { orderIsTotal, orderItemsOf } from "#compiler/lower/shapes/take/order.ts"
import type { Expr, OperandSelect, OrderItem, Select, Target } from "#compiler/sql/ast.ts"
import {
	asc,
	call,
	cast,
	conjunction,
	countStar,
	distinctCoreWhen,
	gt,
	keyedSet,
	lit,
	ne,
	row,
	select,
	simpleSelect,
	target,
	types
} from "#compiler/sql/build.ts"

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
	const env: Env = new Map<NodeId, ColumnMap>(spine.map((n) => [n.id, parentMap]))
	const source = cx.sourceAs(child, env, lateral)
	const where = correlationEqualities(cx, attach, child.heading, source.map, parentMap)
	return select(
		distinctCoreWhen(
			!facts.childUniquePerParent(attach),
			headingTargets(child.heading, source.map),
			[source.item],
			conjunction(where)
		)
	)
}

/** A value as its exact result text (codec resultTextCasts): money through numeric. */
const asText = (e: Expr, castTypes: ReadonlyArray<"numeric" | "text">): Expr =>
	castTypes.reduce<Expr>((acc, t) => cast(acc, t === "numeric" ? types.numeric : types.text), e)

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
		? mapNonEmpty(fields, (c) => asText(columnIn(wrapped.map, c.name), resultTextCasts(c.type)))
		: [asText(lit.bool(true), ["text"])]
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
	order: CompletedOrder | undefined
): { readonly query: Select; readonly columns: ReadonlyArray<string> } => {
	const source = cx.wrap(parent, heading, { kind: "node", node: origin.id })
	const targets: Array<Target> = [...headingTargets(heading, source.map)]
	for (const attach of attachments) {
		targets.push(target(fusedAttachment(cx, attach, spine, source.map, facts)))
	}
	const orderBy: ReadonlyArray<OrderItem> =
		order === undefined || heading.length === 0
			? []
			: orderItemsOf(order, heading, source.map, {
					leading: [],
					total: orderIsTotal(facts, origin, order, heading),
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
 * How many rows a statement delivers at most, which the parent set of a take in an attachment's child is: a count the
 * facts bound, a factor times the size of an input `I` (a page's requested size, the one input that bounds a delivered
 * statement's rows: none outside a page), or unbounded.
 */
export type RowsBound<I extends ChoiceInput> =
	| { readonly kind: "count"; readonly max: bigint }
	| { readonly kind: "input"; readonly source: I; readonly factor: bigint }
	| { readonly kind: "unbounded" }

/** The bound of a statement's rows times at most `max` children per row, unbounded when `max` is. */
export const boundTimes = <I extends ChoiceInput>(
	bound: RowsBound<I>,
	max: Cardinality
): RowsBound<I> => {
	if (max.kind === "unbounded" || bound.kind === "unbounded") {
		return { kind: "unbounded" }
	}
	return bound.kind === "count"
		? { kind: "count", max: bound.max * max.rows }
		: { kind: "input", source: bound.source, factor: bound.factor * max.rows }
}

/**
 * What identifies a delivered row, which decides whether an attachment's parent columns key the rows it reads:
 * - a row of `node`, for a statement delivering that node's rows;
 * - a child row of `attach`, for an attachment statement's rows, which pair each parent with each of its children (a
 *   set: the statement deduplicates them unless proved unique), where every parent column the child reads itself is
 *   one it correlates. The statement's parent columns are then all correlated, each equal to a child column, so a
 *   child row determines its whole row. The child is evaluated once per value of the parent columns it reads itself,
 *   `evaluation` (once in all where it reads none), and the facts key its rows within one evaluation only: the rows
 *   are keyed by columns that key the child and hold, for each column of `evaluation`, a child column correlated to it;
 * - nothing the facts know, for a heading group's rows, which are wider than their union's, and for an attachment
 *   statement's rows whose child reads a parent column it does not correlate, where one child row can pair with two
 *   parents.
 */
export type RowsIdentity =
	| { readonly kind: "node"; readonly node: RelNode }
	| {
			readonly kind: "child"
			readonly attach: NodeOf<"Attach">
			readonly evaluation: ReadonlyArray<string>
	  }
	| { readonly kind: "unkeyed" }

/** What identifies the rows of the statement of an attachment whose parent's rows are those of `spine` (RowsIdentity). */
export const attachmentRowsIdentity = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>
): RowsIdentity => {
	const evaluation = [...parentColumnsRead(cx, attach, spine)]
	return evaluation.every((p) => attach.correlation.some((c) => c.parent === p))
		? { kind: "child", attach, evaluation }
		: { kind: "unkeyed" }
}

/** Whether `columns` of delivered rows identified by `identity` key them. */
const rowsKeyedBy = (
	facts: ShapeFacts,
	identity: RowsIdentity,
	columns: ReadonlyArray<string>
): boolean => {
	switch (identity.kind) {
		case "node":
			return facts.keyedBy(identity.node, columns)
		case "child": {
			const { attach } = identity
			return (
				identity.evaluation.every((p) =>
					attach.correlation.some((c) => c.parent === p && columns.includes(c.child))
				) && facts.keyedBy(attach.child, columns)
			)
		}
		case "unkeyed":
			return false
	}
}

/**
 * Delivered rows of a statement: its index, each column's output position, how a later statement computes them
 * again, what identifies them, how many there are at most, and whether computing them reads an approximate search.
 */
export interface DeliveredRows<I extends ChoiceInput> extends ParentRows {
	readonly identity: RowsIdentity
	readonly bound: RowsBound<I>
	readonly searches: boolean
}

export interface PipelinedAttachment {
	/** The statement's rows, unordered, for a later statement that computes them again. */
	readonly rows: Select
	/** The statement as it delivers them, in its order: the parent key columns, then the child's (deliveredHeading). */
	readonly query: Select
}

/** The child as a fold by every column the Attach correlates, a Group whose keys hold them; none for any other. */
const foldedByCorrelation = (
	child: RelNode,
	attach: NodeOf<"Attach">
): NodeOf<"Group"> | undefined =>
	child.kind === "Group" &&
	child.keys.length > 0 &&
	attach.correlation.every((c) => child.keys.includes(c.child))
		? child
		: undefined

/**
 * The pipelined attachment statement:
 *
 *   SELECT [DISTINCT] r1.c2, r3.c5, r3.c6 FROM (<the parent's rows>) AS r1(c1, c2),
 *     LATERAL (<child>) AS r3(c4, c5, c6) WHERE r3.c4 = r1.c2 [ORDER BY r1.c2, <child order>]
 *
 * The parent key columns `parentColumns` first (deliver.ts parentColumnsOf), then the child's heading. DISTINCT is
 * elided when the facts prove the child unique per parent binding and the parent columns key the delivered rows, so the
 * parent's rows hold each parent key once.
 *
 * A child that folds by every column the Attach correlates (a Group whose keys hold them) is the fold of its parent's
 * keys alone, `LATERAL (SELECT k, sum(…) FROM (<input>) WHERE k = r1.c2 GROUP BY k)` (aggregate/index.ts keyedGroup),
 * the correlation inside the grouping, where it restricts the fold's input rows and an index on the key reads them per
 * parent row. A grouped derived table is never flattened, so a correlation beside it is a join condition PostgreSQL
 * keeps above the aggregate, which then reads every row of the child's relation: a grant's debited total folded every
 * debit of every grant. Wrapping the fold in a derived table that restricts it does not help: PostgreSQL flattens the
 * wrapper (prepjointree.c pull_up_subqueries) and its condition is a join condition again. Any other child is
 * correlated beside it, which PostgreSQL pushes into a child it flattens.
 */
export const pipelinedAttachment = (
	cx: LowerContext,
	attach: NodeOf<"Attach">,
	spine: ReadonlyArray<RelNode>,
	rows: DeliveredRows<ChoiceInput>,
	facts: ShapeFacts,
	parentColumns: Heading
): PipelinedAttachment => {
	const child = attach.child
	const parent = parentRowsSource(cx, rows, { kind: "node", node: attach.id })
	/** Each parent key column with its expression over the parent's rows. */
	const keys = parentColumns.map((c) => ({ name: c.name, expr: parent.column(c.name) }))
	const parentMap: ColumnMap = new Map(keys.map((k) => [k.name, k.expr]))
	const env: Env = new Map<NodeId, ColumnMap>(spine.map((n) => [n.id, parentMap]))
	const folded = foldedByCorrelation(child, attach)
	const source =
		folded === undefined
			? cx.sourceAs(child, env, true)
			: cx.wrapAs(
					keyedGroup(
						facts,
						folded,
						cx,
						env,
						new Map(attach.correlation.map((c) => [c.child, columnIn(parentMap, c.parent)]))
					),
					child.heading,
					{ kind: "node", node: child.id },
					true
				)
	const where =
		folded === undefined
			? correlationEqualities(cx, attach, child.heading, source.map, parentMap)
			: []
	const distinct =
		!facts.childUniquePerParent(attach) ||
		!rowsKeyedBy(
			facts,
			rows.identity,
			parentColumns.map((c) => c.name)
		)
	const orderBy: ReadonlyArray<OrderItem> =
		attach.order === undefined
			? []
			: [
					...keys.map((k) => asc(k.expr)),
					...orderItemsOf(attach.order, child.heading, source.map, {
						leading: [],
						total: !distinct && orderIsTotal(facts, attach.child, attach.order, child.heading),
						fixed: []
					})
				]
	const body = distinctCoreWhen(
		distinct,
		concatNonEmpty(
			keys.map((k) => target(k.expr)),
			headingTargets(child.heading, source.map)
		),
		[parent.item, source.item],
		conjunction(where)
	)
	return {
		rows: select(body),
		query: { ...select(body), orderBy }
	}
}
