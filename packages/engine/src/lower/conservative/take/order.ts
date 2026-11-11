import type { Identification } from "#compiler/analysis/physical/fds.ts"
import type { Direction } from "#compiler/core/order.ts"
import type { CompletedOrder, Heading } from "#compiler/ir/rel.ts"
import { type ColumnMap, columnIn } from "#compiler/lower/conservative/context.ts"
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
