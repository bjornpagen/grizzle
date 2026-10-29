import { pipelinedOnly } from "#compiler/check/approximate/attach.ts"
import { printsAlike, resultTextCasts } from "#compiler/codec/scalar.ts"
import type { NodeId } from "#compiler/core/ids.ts"
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
import {
	type FusedColumn,
	type FusedLayout,
	fusedElement
} from "#compiler/lower/shapes/attach/decode.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import type { ChoiceInput } from "#compiler/lower/shapes/take/index.ts"
import { orderIsTotal, orderItemsOf } from "#compiler/lower/shapes/take/order.ts"
import type { Expr, OrderItem, Select, Target } from "#compiler/sql/ast.ts"
import {
	asc,
	call,
	cast,
	conjunction,
	core,
	countStar,
	gt,
	lit,
	ne,
	row,
	select,
	simpleSelect,
	target,
	types
} from "#compiler/sql/build.ts"

type AttachmentForm = "fused" | "pipelined"

/**
 * What a fused array carries per child (decode.ts FusedLayout): each child column, from the element, or from the
 * parent row where the Attach correlates it to a parent column of the same type whose equal values always print alike,
 * which the parent row already delivers (the first such). A numeric or float column can hold equal values with different
 * spellings (1.0 and 1.00, -0 and 0), so it travels in the array.
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
				printsAlike(k.type) &&
				parent.some((h) => h.name === c.parent && sameScalarType(h.type, k.type))
		)
		return {
			column: k,
			source:
				carried === undefined ? { from: "element" } : { from: "parent", parent: carried.parent }
		}
	})
})

interface AttachmentChoice {
	readonly form: AttachmentForm
	/** A constant phrase naming why, for diagnostics. */
	readonly why: string
}

/**
 * The fixed R36 rule. `parents` says whether the parent's rows read an approximate search, under which a width-only
 * pipelining fuses instead (see the header); a child of more than `maxFields` fields (core/policy.ts
 * attachFuseMaxFields in production) is pipelined.
 *
 * Attachments: pipelined per attached query, or fused into the parent statement.
 *
 * An attachment is the nest operator: for each delivered parent fact, the set of its correlated child facts; the parent
 * set is unchanged, never filtered, multiplied or reordered. Two lowerings deliver identical nested
 * results, chosen by the fixed rule and never by the caller:
 *
 * - pipelined: one statement per attached query, in the parent statement's flight and snapshot, which computes the
 *   parent's rows again as a derived table of its own (conservative/deliver.ts parentRowsSource); the library stitches
 *   children onto parents by key;
 * - fused: the child inside the parent statement as `ARRAY(SELECT ...)`, an empty array rather than NULL, directly for
 *   a single field and as `ARRAY(SELECT to_jsonb(...))` for several, decoded by the attachment's codec (decode.ts).
 *
 * A LEFT JOIN with padded columns is never emitted. Parent predicates stay on the parent and are never
 * pushed into a child, which correlates to delivered parents only: the fused column is computed over the parent's
 * delivered rows, read as a derived table, so the parent's plan is the plan it would have alone and an attachment on a
 * page is evaluated over the delivered page only.
 *
 * The fixed fusion rule: fuse when the child delivers at most
 * attachFuseMaxFields fields and fusing changes no evaluation count the language promises. A child that reads a
 * recursive relation is seeded once from the parent keys instead (R37, attach-recursive); a child over an approximate
 * source evaluates that source once per execution, not once per parent; a child with attachments of its
 * own, or a heterogeneous union, delivers more than one array can carry. Those stay pipelined
 * (check/approximate/attach.ts pipelinedOnly).
 *
 * A parent whose rows read an approximate search fuses every child the width alone would pipeline: a pipelined
 * statement computes its parent's rows again, which would run the search a second time, and two HNSW searches in one
 * snapshot need not retrieve the same set. A child that must pipeline under such rows the checker refuses
 * (check/approximate/attach.ts pipelinedOverSearch).
 */
export const chooseAttachment = (
	attach: NodeOf<"Attach">,
	parents: "exact" | "approximate",
	maxFields: number
): AttachmentChoice => {
	const blocked = pipelinedOnly(attach.child)
	if (blocked !== undefined) {
		return { form: "pipelined", why: blocked }
	}
	const width = Math.max(
		1,
		fusedElement(fusedLayout(attach, attach.child.heading, attach.parent.heading)).length
	)
	if (parents === "approximate") {
		return {
			form: "fused",
			why: "a child over approximate candidates fuses, so the search runs once"
		}
	}
	if (width > maxFields) {
		return { form: "pipelined", why: "the child delivers more than attachFuseMaxFields fields" }
	}
	return {
		form: "fused",
		why: width === 1 ? "a single-field child fuses directly" : "a narrow child fuses as JSON"
	}
}

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
	return select({
		...core(headingTargets(child.heading, source.map), [source.item], conjunction(where)),
		distinct: !facts.childUniquePerParent(attach)
	})
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
	const texts: ReadonlyArray<Expr> =
		fields.length === 0
			? [asText(lit.bool(true), ["text"])]
			: fields.map((c) => asText(columnIn(wrapped.map, c.name), resultTextCasts(c.type)))
	const [single] = texts
	const element: Expr =
		texts.length === 1 && single !== undefined ? single : call("to_jsonb", [row(...texts)])
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
		query: { ...select(core([target(element)], [wrapped.item], undefined)), orderBy }
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
	recompute: () => Select,
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
	parent: Select,
	recompute: () => Select,
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
			...select(core(targets, [source.item], raised?.guard)),
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

/**
 * The pipelined attachment statement:
 *
 *   SELECT [DISTINCT] r1.c2, r3.c5, r3.c6 FROM (<the parent's rows>) AS r1(c1, c2),
 *     LATERAL (<child>) AS r3(c4, c5, c6) WHERE r3.c4 = r1.c2 [ORDER BY r1.c2, <child order>]
 *
 * The parent key columns `parentColumns` first (deliver.ts parentColumnsOf), then the child's heading. DISTINCT is
 * elided when the facts prove the child unique per parent binding and the parent columns key the delivered rows, so the
 * parent's rows hold each parent key once.
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
	const source = cx.sourceAs(child, env, true)
	const where = correlationEqualities(cx, attach, child.heading, source.map, parentMap)
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
	const body = {
		...core(
			[...keys.map((k) => target(k.expr)), ...headingTargets(child.heading, source.map)],
			[parent.item, source.item],
			conjunction(where)
		),
		distinct
	}
	return {
		rows: select(body),
		query: { ...select(body), orderBy }
	}
}
