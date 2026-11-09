/**
 * The binary arrays of bytes and text columns, a hot path: a member's bytes values travel in PostgreSQL's binary format,
 * never as their hex text, so a value of n bytes sends n bytes and its length, and the server reads them with
 * array_recv and bytearecv, no hex to parse; a text column's values travel as their UTF-8 bytes, read by textrecv, so
 * no literal of the whole array, with its quoting, is ever built as one string. The driver sends a Uint8Array parameter
 * with format code 1 and every other parameter as text, each by its own format code, so one statement mixes the two
 * (pg-protocol's serializer, `writeValues`).
 */
import { utf8Bytes } from "#compiler/codec/cursor/bytes.ts"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import { messageMaxBytes } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { sha256Hex, utf8Length } from "#compiler/core/sha256.ts"
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
 * text's type OID, which a text[]'s header names as its element type: pg_type.dat's `oid => '25'`.
 *
 * @formatConstant text's pg_type OID
 */
const textOid = 25

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
 * One column's array in the array binary format (src/backend/utils/adt/arrayfuncs.c array_send and array_recv): one
 * dimension of `lengths.length` elements from 1, no NULL, element type `oid`, then each element's length and bytes in
 * order, which `write` puts at its offset; an empty input is the array of no dimension. Its length is counted from the
 * elements' lengths before it is built, so an array longer than any message PostgreSQL reads (core/limits.ts
 * messageMaxBytes), which no placeholder could carry, is refused as `column`'s bound of `input` before a byte of it is
 * allocated.
 */
const binaryArray = <E>(
	oid: number,
	input: string,
	column: string,
	lengths: ReadonlyArray<number>,
	write: (out: Uint8Array, at: number, i: number) => Result.Result<void, E>
): Result.Result<ParamBinary, LiteralBound | E> => {
	let length = byteaHeaderBytes(lengths.length)
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
	field(lengths.length === 0 ? 0 : 1)
	field(0)
	field(oid)
	if (lengths.length > 0) {
		field(lengths.length)
		field(lowerBound)
	}
	for (const [i, n] of lengths.entries()) {
		field(n)
		const written = write(out, at, i)
		if (!written.ok) {
			return written
		}
		at += n
	}
	return Result.ok(binary(out))
}

/**
 * One bytes column's bytea[] in the array binary format (`binaryArray`). Each value is copied into it once, from its
 * caller's array (scalar/values/bytes.ts AdmittedBytes), the one copy grizzle makes of it, and the copy is checked
 * against the value's digest: a value its caller changed since admission, its bytes, its length or its buffer, detached
 * since, is refused as bytesChanged at `input`, so the bytes sent are the bytes every identity of the write was worked
 * out from.
 */
export const byteaArray = (
	input: string,
	column: string,
	values: ReadonlyArray<AdmittedBytes>
): Result.Result<ParamBinary, LiteralBound | EncodingFailure> => {
	const lengths = values.map((value) => value.bytes.length)
	return binaryArray(byteaOid, input, column, lengths, (out, at, i) => {
		const value = defined(values[i], "each value counted")
		const n = defined(lengths[i], "the length of each value counted")
		if (value.bytes.length !== n || detached(value.bytes)) {
			return Result.err(encodeFailure("bytesChanged", slotPlace(input)))
		}
		out.set(value.bytes, at)
		if (sha256Hex(out.subarray(at, at + n)) !== value.digest) {
			return Result.err(encodeFailure("bytesChanged", slotPlace(input)))
		}
		return Result.ok(undefined)
	})
}

/**
 * One text column's text[] in the array binary format (`binaryArray`), each element its parameter text's UTF-8 bytes,
 * which text's receive function reads as the literal's element would be read: no quoting or escaping, and no string
 * of the whole array, so a column of any total length within a message travels.
 *
 * Each element's bytes are the platform encoder's whole encoding of its text (codec/cursor/bytes.ts utf8Bytes), copied
 * into place. TextEncoder.encodeInto is not used: on Node 26.13 it writes one character short into a destination of
 * exactly the text's length when the text ends in a scalar of U+0400 to U+07FF and is long enough to take its
 * vectorized path (from 53 UTF-16 units), which left the last character's two bytes 0x00 and PostgreSQL refused the
 * array as invalid UTF-8.
 */
export const textArray = (
	input: string,
	column: string,
	texts: ReadonlyArray<string>
): Result.Result<ParamBinary, LiteralBound> => {
	const lengths = texts.map(utf8Length)
	return binaryArray<never>(textOid, input, column, lengths, (out, at, i) => {
		out.set(utf8Bytes(defined(texts[i], "each text counted")), at)
		return Result.ok(undefined)
	})
}
