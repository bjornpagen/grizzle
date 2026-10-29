import type { CompletedOrder, Heading } from "#compiler/ir/rel.ts"
import { type ColumnMap, columnIn } from "#compiler/lower/conservative/context.ts"
import type { OrderItem } from "#compiler/sql/ast.ts"
import { asc, desc } from "#compiler/sql/build.ts"

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
): ReadonlyArray<OrderItem> => {
	const used = new Set<string>()
	const items: Array<OrderItem> = []
	const push = (column: string, dir: "asc" | "desc") => {
		if (used.has(column)) {
			return
		}
		used.add(column)
		const e = columnIn(map, column)
		items.push(dir === "asc" ? asc(e) : desc(e))
	}
	for (const key of order.keys) {
		push(key.column, key.dir)
	}
	for (const c of heading) {
		push(c.name, "asc")
	}
	return items
}
