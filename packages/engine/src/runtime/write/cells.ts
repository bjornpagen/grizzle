/**
 * A write's rows as cells by position: each relation's columns interned once, at one position each, and a row its
 * host values at its relation's positions, so every stage of a bind, the nesting's walk, its rows, the fresh fills and
 * the rows the write inserts, reads and writes a row at a position resolved once per layout, never at a key looked up
 * in a map built and copied per row.
 */
import { type ColumnKey, columnKeyOf } from "#compiler/ir/law.ts"

/**
 * A row's host values at its relation's column positions (`Columns`): at each column the row holds, the value its
 * codec admitted (scalar/values/identity.ts CarrierHost), and nothing at one it does not hold. No type is nullable
 * (ir/scalar.ts), so no column's value is undefined, and a position past the row's end is a column it does not hold.
 */
export type Cells = ReadonlyArray<unknown>

/**
 * The columns of one relation a write's rows hold, each at its position, interned the first time a layout of the
 * prepared write names it: `at` is a column's position.
 */
export interface Columns {
	readonly at: (column: ColumnKey) => number
}

/** The columns of every relation a prepared write's rows are of (`Columns`), by relation, each relation's interned
 * once for the write, which its filler, its bind and its preview share. */
export type ColumnIndex = (relation: string) => Columns

/** A prepared write's column index (`ColumnIndex`), holding no column yet. */
export const columnIndex = (): ColumnIndex => {
	const relations = new Map<string, Columns>()
	return (relation) => {
		const known = relations.get(relation)
		if (known !== undefined) {
			return known
		}
		const positions = new Map<ColumnKey, number>()
		const made: Columns = {
			at: (column) => {
				const held = positions.get(column)
				if (held !== undefined) {
					return held
				}
				const at = positions.size
				positions.set(column, at)
				return at
			}
		}
		relations.set(relation, made)
		return made
	}
}

/** A row holding no column yet: its cells are written at their positions, and every position past its end is a column
 * it does not hold (`Cells`). */
export const emptyCells = (): Array<unknown> => []

/** A fact of a relation, its fields' host values by name, as cells (`Cells`) of the relation's `columns`. */
export const factCells = (columns: Columns, fact: Readonly<Record<string, unknown>>): Cells => {
	const cells = emptyCells()
	for (const name of Object.keys(fact)) {
		cells[columns.at(columnKeyOf(name))] = fact[name]
	}
	return cells
}
