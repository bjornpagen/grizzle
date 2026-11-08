import { scalarReader } from "#compiler/codec/read.ts"
import { rowText } from "#compiler/core/decoder.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { BytesDigest } from "#compiler/scalar/values/bytes.ts"

/** One positional row of PostgreSQL's output texts to a host value, trusting the texts. */
type RowConverter<Head> = (row: ReadonlyArray<OutputText>) => Head

/** One result column: its name and its type. */
interface DecodedColumn {
	readonly name: string
	readonly type: ScalarType
}

/**
 * The value a write statement returned for a column of `type`: its output text converted by its reader, but a bytes
 * column's digest (write/insert/statement.ts returnedColumn), all a write returns of a bytes value.
 */
const returnedValue = (type: ScalarType, codes: Codebook): ((text: OutputText) => unknown) => {
	if (type.carrier === "bytes") {
		return (text) => new BytesDigest(text)
	}
	const reader = scalarReader(type, codes)
	return (text) => reader.convert(text)
}

/**
 * Positional result row converters, for the rows grizzle reads for itself.
 *
 * A statement's result arrives as positional rows of column texts (the adapter's wire parses nothing, every column is
 * cast to text by the outermost SELECT, and the session admits a text cell only). A delivered row's public columns are
 * converted by the value's own decoder (core/decoder.ts); the rows grizzle reads for itself, a write's returned facts
 * (write/insert/rows.ts, write/put/rows.ts), are converted here, a bytes column's cell its digest (`returnedValue`).
 * A converter is built once per heading: it resolves one conversion per column up front, and the returned closure is a
 * straight loop over the row that calls those closures in order. There is no eval, no Result and no per-row or
 * per-field fiber: every text is PostgreSQL's own output of a value of its column's type, so a conversion checks nothing
 * (values/convert.ts), and a row of the wrong width is a defect of grizzle's own SQL.
 *
 * The converter of rows with this heading into frozen positional arrays, whose column names need not be distinct, a
 * closed id's and a set's cells read by the installation's codes.
 */
export const tupleConverter = (
	columns: ReadonlyArray<DecodedColumn>,
	codes: Codebook
): RowConverter<ReadonlyArray<unknown>> => {
	const converters = columns.map((column) => returnedValue(column.type, codes))
	return (row) => {
		const out: Array<unknown> = []
		let i = 0
		for (const convert of converters) {
			out.push(convert(rowText(row, i)))
			i++
		}
		return Object.freeze(out)
	}
}
