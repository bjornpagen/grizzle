import type { ValueFault } from "#compiler/core/errors.ts"
import { bytesMaxLength } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * A bytes host value: a Uint8Array over an ArrayBuffer of its own, PostgreSQL's bytea written and read back whole. Every
 * value grizzle hands back is a fresh array over its own buffer, never a view into memory another value shares, so a
 * caller may keep, transfer or change it freely.
 */
export type Bytes = Uint8Array<ArrayBuffer>

/**
 * The encode-time boundary of a bytes value, read once from the caller's Uint8Array as it is now into a copy grizzle
 * alone holds, over an ArrayBuffer of its own: so the fact's identity and the bytes sent are the same, whatever the
 * caller does to its array after admission. A value that is no Uint8Array, or one over a detached buffer, which reads
 * as no bytes at all, is bytesType; one longer than core/limits.ts bytesMaxLength, whose identity (`bytesText`) no
 * string holds or which no bytea holds, is bytesLength.
 */
export const admitBytes = (value: unknown): Result.Result<Bytes, ValueFault> => {
	if (!(value instanceof Uint8Array)) {
		return Result.err("bytesType")
	}
	const buffer: ArrayBufferLike = value.buffer
	if (buffer instanceof ArrayBuffer && buffer.detached) {
		return Result.err("bytesType")
	}
	if (value.length > bytesMaxLength.value) {
		return Result.err("bytesLength")
	}
	return Result.ok(new Uint8Array(value))
}

/** Whether a value has the bytes host type: a Uint8Array over an ArrayBuffer. */
export const isBytes = (value: unknown): value is Bytes =>
	value instanceof Uint8Array && value.buffer instanceof ArrayBuffer

/**
 * windows-1252 as the Encoding Standard decodes it: one UTF-16 code unit for each byte, a different one for each of the
 * 256 byte values, so it is injective.
 */
const oneUnitPerByte = new TextDecoder("windows-1252")

/**
 * The one text of a bytes value: its windows-1252 decode, one UTF-16 code unit a byte, a different unit for each byte
 * value, so two texts are equal exactly when the bytes are, as bytea's equality is. It is the fact identity's part and a
 * delivered row's identity (codec/read.ts), never a parameter: every bytes value travels in binary (codec/bytea.ts).
 * Admission bounds a value so that the text is one string (core/limits.ts bytesMaxLength).
 */
export const bytesText = (value: Bytes): string => oneUnitPerByte.decode(value)

/**
 * bytea's B-tree order (byteacmp): the first byte that differs decides, unsigned, and a value before every longer value
 * it begins. Only the host reads it, since a bytes value has no ordering capability.
 */
export const compareBytes = (a: Bytes, b: Bytes): -1 | 0 | 1 => {
	for (const [i, byte] of a.entries()) {
		const other = b[i]
		if (other === undefined) {
			return 1
		}
		if (byte !== other) {
			return byte < other ? -1 : 1
		}
	}
	return a.length < b.length ? -1 : 0
}
