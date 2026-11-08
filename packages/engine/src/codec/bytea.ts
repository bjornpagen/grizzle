/**
 * The binary array of a bytes column, a hot path: a member's bytes values travel in PostgreSQL's binary format, never as
 * their hex text, so a value of n bytes sends n bytes and its length, and the server reads them with array_recv and
 * bytearecv, no hex to parse. The driver sends a Uint8Array parameter with format code 1 and every other parameter as
 * text, each by its own format code, so one statement mixes the two (pg-protocol's serializer, `writeValues`).
 */
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import { messageMaxBytes } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import type { ParamBinary } from "#compiler/core/wire.ts"
import type { LiteralBound } from "#compiler/ir/products.ts"
import type { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"

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
 * The Int32 fields before a one-dimensional array's elements: its dimension count, its flags, its element type, and its
 * one dimension's length and lower bound.
 *
 * @formatConstant the header fields of a one-dimensional array in the array binary format
 */
const dimensionedFields = 5

/**
 * The Int32 fields of an empty array: its dimension count, its flags and its element type, as it has no dimension.
 *
 * @formatConstant the header fields of an empty array in the array binary format
 */
const emptyFields = 3

/**
 * The lower bound of every array grizzle sends, PostgreSQL's default.
 *
 * @formatConstant the array binary format's default lower bound
 */
const lowerBound = 1

/** The bytes of a bytea[]'s header in the array binary format: an empty array's, or a dimensioned one's of `count`. */
export const byteaHeaderBytes = (count: number): number =>
	(count === 0 ? emptyFields : dimensionedFields) * int32Bytes

/** The bytes one element of `length` bytes adds to a bytea[] in the array binary format: its length, then itself. */
export const byteaElementBytes = (length: number): number => int32Bytes + length

/**
 * Whether a value's buffer is detached, which admission refuses (scalar/values/bytes.ts checkBytes), so its caller
 * detached it since.
 */
const detached = (value: Uint8Array): boolean => {
	const buffer: ArrayBufferLike = value.buffer
	return buffer instanceof ArrayBuffer && buffer.detached
}

/**
 * One column's bytea[] in the array binary format (src/backend/utils/adt/arrayfuncs.c array_send and array_recv): one
 * dimension of `values.length` elements from 1, no NULL, element type bytea, then each value's length and bytes in
 * order; an empty input is the array of no dimension. Its length is counted from its values' lengths before it is
 * built, so an array longer than any message PostgreSQL reads (core/limits.ts messageMaxBytes), which no placeholder
 * could carry, is refused as `column`'s bound of `input` before a byte of it is allocated. Each value is copied into it
 * once, from its caller's array (scalar/values/bytes.ts AdmittedBytes), the one copy grizzle makes of it, and the copy
 * is checked against the value's digest: a value its caller changed since admission, its bytes, its length or its
 * buffer, detached since, is refused as bytesChanged at `input`, so the bytes sent are the bytes every identity of the
 * write was worked out from.
 */
export const byteaArray = (
	input: string,
	column: string,
	values: ReadonlyArray<AdmittedBytes>
): Result.Result<ParamBinary, LiteralBound | EncodingFailure> => {
	const lengths = values.map((value) => value.bytes.length)
	let length = byteaHeaderBytes(values.length)
	for (const n of lengths) {
		length += byteaElementBytes(n)
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
	for (const [i, value] of values.entries()) {
		const n = defined(lengths[i], "the length of each value counted")
		if (value.bytes.length !== n || detached(value.bytes)) {
			return Result.err(encodeFailure("bytesChanged", slotPlace(input)))
		}
		field(n)
		out.set(value.bytes, at)
		if (sha256Hex(out.subarray(at, at + n)) !== value.digest) {
			return Result.err(encodeFailure("bytesChanged", slotPlace(input)))
		}
		at += n
	}
	return Result.ok(binary(out))
}
