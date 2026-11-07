import type { ValueFault } from "#compiler/core/errors.ts"
import { bytesMaxLength } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import type { OutputText } from "#compiler/core/wire.ts"

/**
 * A bytes host value: a Uint8Array over an ArrayBuffer of its own, PostgreSQL's bytea written and read back whole. Every
 * value grizzle hands back is a fresh array over its own buffer, never a view into memory another value shares, so a
 * caller may keep, transfer or change it freely.
 */
export type Bytes = Uint8Array<ArrayBuffer>

/** What PostgreSQL's hex output of a bytea leads with, before two hex digits a byte (byteaout). */
const hexPrefix = "\\x"

/**
 * The encode-time boundary of a bytes value, read once from the caller's Uint8Array as it is now into a copy grizzle
 * alone holds, over an ArrayBuffer of its own: so the fact's identity and the bytes sent are the same, whatever the
 * caller does to its array after admission. A value that is no Uint8Array, or one over a detached buffer, which reads
 * as no bytes at all, is bytesType; one longer than one string's hex text holds (core/limits.ts bytesMaxLength), which
 * could not be read back, is bytesLength.
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
 * The one text of a bytes value, byteain's hex input and byteaout's hex output alike: `\x` and its lowercase hex
 * digits, two a byte, equal exactly when the bytes are, as bytea's equality is. It is the fact identity's part, and the
 * element of a text array a family write carries; a member's array travels in binary (codec/bytea.ts).
 * Admission bounds a value so that the text is one string (core/limits.ts bytesMaxLength).
 */
export const bytesText = (value: Bytes): string => `${hexPrefix}${value.toHex()}`

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

/**
 * byteaout's text under bytea_output = hex, which every login pins (physical/ddl/roles.ts roleDefaultSettings): `\x`
 * and two hex digits a byte, read into a fresh array over its own buffer. Every stored value's text is one string by
 * its column's CHECK (physical/bytes/storage.ts), so the text arrived whole.
 */
export const convertBytes = (text: OutputText): Bytes =>
	Uint8Array.fromHex(text.slice(hexPrefix.length))
