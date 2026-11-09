/** A merged row and the heading group it came from. */
interface MergedRow<Row> {
	readonly group: number
	readonly row: Row
}

/** How two rows of one common order compare. */
type RowComparator<Row> = (a: Row, b: Row) => number

/**
 * Merges each group's rows, each already in the common order, and keeps the first `limit` overall, or all of them when
 * `limit` is undefined. A k-way merge: at each step the least head among the groups, ties broken by group index, which
 * a total order never leaves.
 */
export const mergeHeadingGroups = <Row>(
	groups: ReadonlyArray<ReadonlyArray<Row>>,
	compare: RowComparator<Row>,
	limit: number | undefined
): ReadonlyArray<MergedRow<Row>> => {
	/** Each group's rows read in order, with its head row: the next row to merge, or done. */
	interface Cursor {
		readonly rows: Iterator<Row, undefined>
		head: IteratorResult<Row, undefined>
	}
	const cursors = groups.map((rows): Cursor => {
		const it = rows[Symbol.iterator]()
		return { rows: it, head: it.next() }
	})
	const out: Array<MergedRow<Row>> = []
	const total = groups.reduce((n, g) => n + g.length, 0)
	const wanted = limit === undefined ? total : Math.min(limit, total)
	while (out.length < wanted) {
		const best = cursors.reduce<
			{ readonly group: number; readonly cursor: Cursor; readonly row: Row } | undefined
		>((least, cursor, g) => {
			const head = cursor.head
			if (head.done === true || (least !== undefined && compare(head.value, least.row) >= 0)) {
				return least
			}
			return { group: g, cursor, row: head.value }
		}, undefined)
		if (best === undefined) {
			break
		}
		out.push({ group: best.group, row: best.row })
		best.cursor.head = best.cursor.rows.next()
	}
	return out
}
