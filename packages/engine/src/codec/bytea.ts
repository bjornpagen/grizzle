/**
 * The binary array of a bytes column, a hot path: a member's bytes values travel in PostgreSQL's binary format, never as
 * their hex text, so a value of n bytes sends n bytes and its length, and the server reads them with array_recv and
 * bytearecv, no hex to parse. The driver sends a Uint8Array parameter with format code 1 and every other parameter as
 * text, each by its own format code, so one statement mixes the two (pg-protocol's serializer, `writeValues`).
 */
import { nominal } from "#compiler/core/brand.ts"
import { messageMaxBytes } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import type { ParamBinary } from "#compiler/core/wire.ts"
import type { LiteralBound } from "#compiler/ir/products.ts"
import type { Bytes } from "#compiler/scalar/values/bytes.ts"

/** A binary parameter, minted by the encoders of this module alone. */
const binary = nominal<Uint8Array<ArrayBuffer>, ParamBinary>()

/**
 * bytea's type OID, which the array binary format names as its element type: pg_type.dat's `oid => '17'`, a built-in
 * OID, so array_recv refuses an array whose header names another built-in type (42804).
 *
 * @formatConstant bytea's pg_type OID
 */
const byteaOid = 17

/**
 * The width of each Int32 field of the array binary format (array_send): the dimension count, the flags, the element
 * type, each dimension's length and lower bound, and each element's length.
 *
 * @formatConstant an Int32 field of the array binary format
 */
const int32Bytes = 4

/**
 * The fields before a one-dimensional array's elements: its dimension count, its flags, its element type, and its one
 * dimension's length and lower bound. An empty array has no dimension, so neither of the last two.
 */
const arrayFields = { dimensioned: 5, empty: 3 } as const

/** The lower bound of every array grizzle sends, PostgreSQL's default. */
const lowerBound = 1

/**
 * One column's bytea[] in the array binary format (src/backend/utils/adt/arrayfuncs.c array_send and array_recv): one
 * dimension of `values.length` elements from 1, no NULL, element type bytea, then each value's length and bytes in
 * order; an empty input is the array of no dimension. Its length is counted before it is built, so an array longer than
 * any message PostgreSQL reads (core/limits.ts messageMaxBytes), which no placeholder could carry, is refused as
 * `column`'s bound of `input` before a byte of it is allocated.
 */
export const byteaArray = (
	input: string,
	column: string,
	values: ReadonlyArray<Bytes>
): Result.Result<ParamBinary, LiteralBound> => {
	const fields = values.length === 0 ? arrayFields.empty : arrayFields.dimensioned
	let length = fields * int32Bytes
	for (const value of values) {
		length += int32Bytes + value.length
	}
	if (length > messageMaxBytes.value) {
		return Result.err({
			_tag: "LiteralBound",
			form: "binary",
			input,
			column,
			limit: messageMaxBytes.value
		})
	}
	const out = new Uint8Array(length)
	const view = new DataView(out.buffer)
	let at = 0
	const field = (n: number): void => {
		view.setInt32(at, n)
		at += int32Bytes
	}
	field(values.length === 0 ? 0 : 1)
	field(0)
	field(byteaOid)
	if (values.length > 0) {
		field(values.length)
		field(lowerBound)
	}
	for (const value of values) {
		field(value.length)
		out.set(value, at)
		at += value.length
	}
	return Result.ok(binary(out))
}
