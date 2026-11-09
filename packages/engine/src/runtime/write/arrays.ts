/**
 * A column of a write's rows as its placeholder carries it: an array of its cells' texts, or of its bytes values, as
 * the columnar transport writes it.
 */
import { byteaArray, textArray } from "#compiler/codec/bytea.ts"
import { columnLiteral } from "#compiler/codec/recordset.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import type * as Result from "#compiler/core/result.ts"
import type { Param, ParamText } from "#compiler/core/wire.ts"
import type { LiteralBound } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { MemberCell } from "#compiler/runtime/write/draw.ts"
import type { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"

/**
 * One column of a statement's rows as its placeholder carries it: a text array literal of its texts within the longest
 * string (codec/recordset.ts columnLiteral), or a bytes column's binary bytea[] of its values (codec/bytea.ts). The one
 * site of the fact that a column's cells are of one kind: every row of a statement is in its relation's row layout,
 * whose column is a bytes column in every row or in none, so a column of both is a defect.
 */
export const columnArray = (
	input: string,
	column: string,
	cells: ReadonlyArray<MemberCell>
): Result.Result<Param, LiteralBound | EncodingFailure> => {
	const texts: Array<ParamText> = []
	const values: Array<AdmittedBytes> = []
	for (const cell of cells) {
		if (typeof cell === "string") {
			texts.push(cell)
		} else {
			values.push(cell)
		}
	}
	if (values.length === 0) {
		return columnLiteral(input, column, texts, (text) => text, maxStringLength.value)
	}
	if (texts.length === 0) {
		return byteaArray(input, column, values)
	}
	throw defect(`a family statement's column ${column} carries one kind of cell`)
}

/**
 * A column's array of nested rows' cells (write/family/additions.ts RowSource), its encoding chosen by its type: a text
 * column's binary text[] (codec/bytea.ts textArray), any other's as `columnArray` writes it.
 */
export const typedColumnArray = (
	input: string,
	column: string,
	type: ScalarType,
	cells: ReadonlyArray<MemberCell>
): Result.Result<Param, LiteralBound | EncodingFailure> => {
	if (type.carrier !== "text") {
		return columnArray(input, column, cells)
	}
	const texts: Array<ParamText> = []
	for (const cell of cells) {
		if (typeof cell !== "string") {
			throw defect(`a text column ${column} of ${input} carrying bytes`)
		}
		texts.push(cell)
	}
	return textArray(input, column, texts)
}
