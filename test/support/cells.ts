/**
 * A write's rows as its tests state and read them (runtime/write/cells.ts): a row given by its values at column keys,
 * laid out as cells of its relation's columns, and a filled row's value at a column, read at the column's position.
 */
import type { ColumnKey } from "#compiler/ir/law.ts"
import { type Cells, type ColumnIndex, emptyCells } from "#compiler/runtime/write/cells.ts"

/** The cells of a row of `relation` that holds each of `values`, a column's value at its key, under `columns`. */
export const cellsOf = (
	columns: ColumnIndex,
	relation: string,
	values: ReadonlyArray<readonly [ColumnKey, unknown]>
): Cells => {
	const of = columns(relation)
	const cells = emptyCells()
	for (const [key, value] of values) {
		cells[of.at(key)] = value
	}
	return cells
}

/** A row's value at the column `key` of its relation, under `columns`; none where the row holds none. */
export const cellAt = (
	columns: ColumnIndex,
	row: { readonly relation: string; readonly values: Cells },
	key: ColumnKey
): unknown => row.values[columns(row.relation).at(key)]
