/**
 * A write's rows as cells by position: each relation's columns interned once, at one position each, and a row its
 * host values at its relation's positions, so every stage of a bind, the nesting's walk, its rows, the fresh fills and
 * the rows the write inserts, reads and writes a row at a position resolved once per layout, never at a key looked up
 * in a map built and copied per row.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { type ColumnKey, columnKeyOf } from "#compiler/ir/law.ts"
import { admittedText, type CarrierSpec } from "#compiler/scalar/values/identity.ts"

/**
 * A row's host values at its relation's column positions (`Columns`): at each column the row holds, the value its
 * codec admitted (scalar/values/identity.ts CarrierHost), and nothing at one it does not hold. No type is nullable
 * (ir/scalar.ts), so no column's value is undefined, and a position past the row's end is a column it does not hold.
 */
export type Cells = ReadonlyArray<unknown>

/**
 * The canonical texts a write holds of a row's cells, at the same positions (`Cells`): each value's one text
 * (scalar/values/identity.ts canonicalText), a bytes value's its digest, held where the write first works it out, by
 * the admission that admits the value (codec/recordset.ts RelationNormalizer admitOne) or by the first reader of a value
 * the write drew or holds no text of (`textAt`), so no value's text is worked out twice. A position holding no text
 * holds a value no reader has needed the text of yet, or none.
 */
export type Texts = Array<string | undefined>

/** A row of a write's relation: its cells and the texts the write holds of them (`Cells`, `Texts`). */
export interface CellRow {
	readonly values: Cells
	readonly texts: Texts
}

/**
 * The canonical text of a row's value at `at`, its carrier `spec`'s: the one its texts hold, or the value's worked out
 * and held there (`Texts`). A row the write holds no value of there is a defect: every reader reads a column its row
 * holds.
 */
export const textAt = (values: Cells, texts: Texts, at: number, spec: CarrierSpec): string => {
	const held = texts[at]
	if (held !== undefined) {
		return held
	}
	const value = values[at]
	if (value === undefined) {
		defect(`a value at position ${at} of a row a reader reads`)
	}
	const text = admittedText(spec, value)
	texts[at] = text
	return text
}

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
