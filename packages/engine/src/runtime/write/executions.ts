/**
 * A statement's execution in the call's one flight: its text and its placeholders' values, the columns of a stratum's
 * nested rows among them, each written once for every statement that sends it (`NestedSource`).
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import type { Prepared } from "#compiler/core/prepared.ts"
import type { Param } from "#compiler/core/wire.ts"
import type { LiteralBound } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { typedColumnArray } from "#compiler/runtime/write/arrays.ts"
import type { MemberCell } from "#compiler/runtime/write/draw.ts"
import type { WriteText } from "#compiler/runtime/write/parted.ts"

/**
 * What one execution of an artifact statement does: `fill`, a carrier's fill (write/carriers/carriers.ts carrierStash);
 * or `statement`, any other.
 */
export type ExecutionPart = "statement" | "fill"

/** One execution of an artifact statement: its prepared text, its placeholders' values and what it is. */
export interface Execution {
	readonly text: Prepared<WriteText>
	readonly params: ReadonlyArray<Param>
	readonly part: ExecutionPart
}

/**
 * A stratum's nested rows of one relation as their placeholders carry them: their sent layout's column types, and each
 * row's cells in the same order, its key's first (runtime/write/nesting.ts cellsReader).
 */
export interface NestedCells {
	readonly relation: StoredRelationName
	readonly types: ReadonlyArray<ScalarType>
	readonly rows: ReadonlyArray<ReadonlyArray<MemberCell>>
}

/** The type of column `part` of nested rows. */
const typeAt = (cells: NestedCells, part: number): ScalarType =>
	defined(cells.types[part], `column ${part + 1} of ${cells.relation}'s sent layout`)

/** The cell of column `part` of a nested row. */
const cellAt = (row: ReadonlyArray<MemberCell>, part: number): MemberCell =>
	defined(row[part], "a nested row holds each column of its sent layout")

/**
 * The array of column `part` of `rows` as a nested rows placeholder carries it (runtime/write/arrays.ts
 * typedColumnArray): a text column's binary text[], a bytes column's binary bytea[], any other's text array literal.
 */
export const nestedColumn = (
	cells: NestedCells,
	part: number,
	rows: ReadonlyArray<ReadonlyArray<MemberCell>>
): Result.Result<Param, LiteralBound | EncodingFailure> =>
	typedColumnArray(
		cells.relation,
		`column ${part + 1}`,
		typeAt(cells, part),
		rows.map((row) => cellAt(row, part))
	)

/**
 * A stratum's nested rows of one relation as every statement that sends them reads them: their cells, and each column
 * of their sent layout, by its part, written whole once, so no statement writes a column of a source another statement
 * sends. A write builds each of its sources once (runtime/write/bind.ts).
 */
export interface NestedSource {
	readonly cells: NestedCells
	readonly columns: ReadonlyArray<Result.Result<Param, LiteralBound | EncodingFailure>>
}

/** The source of `cells` (`NestedSource`): each column of their sent layout written over every row. */
export const nestedSource = (cells: NestedCells): NestedSource => ({
	cells,
	columns: cells.types.map((_, part) => nestedColumn(cells, part, cells.rows))
})

/** A placeholder of nested rows as one execution binds it: its column's part, and its source. */
export interface NestedPlaceholder {
	readonly part: number
	readonly source: NestedSource
}

/**
 * A statement's one execution: its text, and each placeholder's value, the array its nested rows' source holds of a
 * placeholder of nested rows (`nested`, by position, none for a placeholder of any other value), written once for every
 * statement that sends it, and `encode`'s of any other. `part` is what the statement does.
 */
export const executionOf = (
	text: Prepared<WriteText>,
	nested: ReadonlyArray<NestedPlaceholder | undefined>,
	part: ExecutionPart,
	encode: (position: number) => Result.Result<Param, LiteralBound | EncodingFailure>
): Result.Result<Execution, LiteralBound | EncodingFailure> => {
	const params: Array<Param> = []
	for (const [position, slot] of nested.entries()) {
		const value =
			slot === undefined
				? encode(position)
				: defined(slot.source.columns[slot.part], `column ${slot.part + 1} of a nested source`)
		if (!value.ok) {
			return value
		}
		params.push(value.value)
	}
	return Result.ok({ text, params, part })
}
