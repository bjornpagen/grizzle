import { scalarReader } from "#compiler/codec/read.ts"
import { rowCell } from "#compiler/core/decoder.ts"
import type { Cell } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/** One positional delivered row (codec/delivery.ts) to a host value, trusting its cells. */
type RowConverter<Head> = (row: ReadonlyArray<Cell>) => Head

/** One result column: its name and its type. */
interface DecodedColumn {
	readonly name: string
	readonly type: ScalarType
}

/**
 * Positional result row converters, for the rows grizzle reads for itself.
 *
 * A statement's result arrives as positional rows of column texts (the adapter's wire parses nothing, every column is
 * cast to text by the outermost SELECT, and the session admits a text cell only), which its delivery assembles into
 * cells, a bytes column's its value (codec/delivery.ts). A delivered row's public columns are
 * converted by the value's own decoder (core/decoder.ts); the rows grizzle reads for itself, a write's returned facts
 * (write/insert/rows.ts, write/put/rows.ts), are converted here. A converter is built once per heading: it resolves one
 * reader's conversion per column up front, and the returned closure is a straight loop over the row that calls those
 * closures in order. There is no eval, no Result and no per-row or per-field fiber: every text is PostgreSQL's own
 * output of a value of its column's type, so a conversion checks nothing (values/convert.ts), and a row of the wrong
 * width is a defect of grizzle's own SQL.
 *
 * The converter of rows with this heading into frozen positional arrays, whose column names need not be distinct, a
 * closed id's and a set's cells read by the installation's codes.
 */
export const tupleConverter = (
	columns: ReadonlyArray<DecodedColumn>,
	codes: Codebook
): RowConverter<ReadonlyArray<unknown>> => {
	const converters = columns.map((column) => scalarReader(column.type, codes).convert)
	return (row) => {
		const out: Array<unknown> = []
		let i = 0
		for (const convert of converters) {
			out.push(convert(rowCell(row, i)))
			i++
		}
		return Object.freeze(out)
	}
}
