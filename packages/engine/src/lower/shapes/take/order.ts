import type { CompletedOrder, Heading, RelNode } from "#compiler/ir/rel.ts"
import { type ColumnMap, columnIn } from "#compiler/lower/conservative/context.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import type { OrderItem } from "#compiler/sql/ast.ts"
import { asc, desc } from "#compiler/sql/build.ts"

interface OrderOptions {
	/** Columns ordered first, ascending: a partition or a parent key; none for a plain order. */
	readonly leading: ReadonlyArray<string>
	/** Whether the order's own keys are total over the rows; otherwise the heading completes it. */
	readonly total: boolean
	/** Columns constant over the ordered rows, such as a window's partition: never sort keys; none for a plain order. */
	readonly fixed: ReadonlyArray<string>
}

/**
 * Whether `order` is physically total over the rows of `input`.
 *
 * Completed orders as ORDER BY items, trusting the physical proof of totality.
 *
 * The IR's completed order is total over its input by a key the order completion proved (logical/order.ts). The
 * optimized lowering emits exactly those keys when the physical facts prove that the order's columns determine a key
 * of the input as realized, so an index on the order supplies the pathkey and no extra sort column is added
 * (R20). Without that proof, in a context where the key the order rested on is not evidence, the
 * remaining heading columns are appended ascending, as the conservative baseline does, so the bound is never an
 * arbitrary choice among ties.
 */
export const orderIsTotal = (
	facts: ShapeFacts,
	input: RelNode,
	order: CompletedOrder,
	heading: Heading
): boolean =>
	heading.length === 0 ||
	facts.keyedBy(
		input,
		order.keys.map((k) => k.column)
	)

export const orderItemsOf = (
	order: CompletedOrder,
	heading: Heading,
	map: ColumnMap,
	options: OrderOptions
): ReadonlyArray<OrderItem> => {
	const used = new Set<string>(options.fixed)
	const items: Array<OrderItem> = []
	const push = (column: string, dir: "asc" | "desc"): void => {
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
	if (!options.total) {
		for (const c of heading) {
			push(c.name, "asc")
		}
	}
	return items
}
