import type { Identification } from "#compiler/analysis/physical/fds.ts"
import type { Direction } from "#compiler/core/order.ts"
import type { CompletedOrder, GroupOrders, Heading, NodeOf } from "#compiler/ir/rel.ts"
import {
	type ColumnMap,
	columnIn,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import type { OrderItem } from "#compiler/sql/ast.ts"
import { asc, desc } from "#compiler/sql/build.ts"

/**
 * Whether a completed order's own keys are total over the rows it orders, and why: the rows have no column, or the
 * physical analysis keys them by the order's columns (ShapeFacts keyedBy); partial where nothing proves it.
 */
export type OrderTotality =
	| {
			readonly kind: "total"
			readonly by:
				| { readonly kind: "noColumn" }
				| { readonly kind: "keyed"; readonly key: Identification }
	  }
	| { readonly kind: "partial" }

/** An order nothing proves total: the heading completes it. */
export const partialOrder: OrderTotality = Object.freeze({ kind: "partial" })

/** How a completed order is written as ORDER BY items beyond its own keys. */
export interface OrderOptions {
	/** Columns ordered first, ascending: a partition or a parent key; none for a plain order. */
	readonly leading: ReadonlyArray<string>
	/** Whether the order's own keys are total over the rows; where partial, the heading completes it. */
	readonly total: OrderTotality
	/** Columns constant over the ordered rows, such as a window's partition: never sort keys; none for a plain order. */
	readonly fixed: ReadonlyArray<string>
}

/**
 * A completed order as ORDER BY items: the leading columns, then the order's keys, then, unless its keys are total, every
 * remaining heading column, ascending; each column once, and none `options` fixes.
 */
export const orderItemsOf = (
	order: CompletedOrder,
	heading: Heading,
	map: ColumnMap,
	options: OrderOptions
): ReadonlyArray<OrderItem> => {
	const used = new Set<string>(options.fixed)
	const items: Array<OrderItem> = []
	const push = (column: string, dir: Direction): void => {
		if (used.has(column)) {
			return
		}
		used.add(column)
		const e = columnIn(map, column)
		items.push(dir === "asc" ? asc(e) : desc(e))
	}
	for (const column of options.leading) {
		push(column, "asc")
	}
	for (const key of order.keys) {
		push(key.column, key.dir)
	}
	if (options.total.kind === "partial") {
		for (const c of heading) {
			push(c.name, "asc")
		}
	}
	return items
}

/** A plain order the reading context may not prove total: its keys, then every remaining heading column. */
const baseline: OrderOptions = { leading: [], total: partialOrder, fixed: [] }

/**
 * Completed orders as ORDER BY items.
 *
 * The IR's completed order is total over its input: its keys cover the heading or a key of it (valid DAG). The
 * baseline appends every remaining heading column, ascending, so the order is total over the complete heading whether
 * or not the key it rested on holds in the reading context; when the IR's order is already total the appended
 * columns never break a tie, and the order is unchanged.
 */
export const completedOrderItems = (
	order: CompletedOrder,
	heading: Heading,
	map: ColumnMap
): ReadonlyArray<OrderItem> => orderItemsOf(order, heading, map, baseline)

/**
 * The one order rows of `orders`' heading groups are read in as one relation, through `heading`, the fields every group
 * holds: their one group's order, or the union's own, which every group's is where a key of the union lies within
 * those fields (logical/order.ts completeGroups). Groups that complete it apart, a union with no such key, are refused
 * for `consumer`, which reads no group's own fields: only a delivery, a statement per group, orders each group by its
 * own (conservative/deliver.ts heterogeneousPlan).
 */
export const sharedOrder = (
	orders: GroupOrders,
	heading: Heading,
	at: string,
	consumer: string
): CompletedOrder => {
	const [first, ...rest] = orders
	const apart = rest.some(
		(o) =>
			o.keys.length !== first.keys.length ||
			o.keys.some((k, i) => k.column !== first.keys[i]?.column || k.dir !== first.keys[i].dir)
	)
	if (apart || first.keys.some((k) => !heading.some((c) => c.name === k.column))) {
		return refuse(
			"UnsupportedOperation",
			at,
			`ordering: ${consumer} needs a completed total order over the fields common to every arm; no key of the union lies within them, so retain a key in each arm's find`
		)
	}
	return first
}

/** The one order a take ranks its rows in where a statement reads them as one relation (sharedOrder). */
export const rankedOrder = (take: NodeOf<"Take">): CompletedOrder =>
	sharedOrder(
		take.orders,
		take.heading,
		nodeLabel(take),
		"a take over a union of several headings read as one relation"
	)
