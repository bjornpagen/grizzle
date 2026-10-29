import { ByteReader, ByteWriter } from "#compiler/codec/cursor/bytes.ts"
import { cursorDigestBytes, DigestBytes } from "#compiler/codec/cursor/identity.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * The binary cursor layout; the table below is its record. A token carries no format version: one this library did not
 * issue, or issued for another generation, query or order, is refused by its digests, never by a version number.
 *
 * A token is the unpadded base64url text (base64url.ts) of these bytes, in order:
 *
 * | Field | Encoding |
 * | --- | --- |
 * | generation digest | varint length 16, then 16 bytes |
 * | query digest | varint length 16, then 16 bytes |
 * | comparator digest | varint length 16, then 16 bytes |
 * | tuple | varint count m, then m values, each a varint length and that many bytes |
 *
 * Nothing follows the last field. Every varint is unsigned LEB128 in its minimal form, at most four bytes (bytes.ts).
 * The digests are identity.ts's: SHA-256 over a domain-separated canonical text, truncated to 16 bytes, written in
 * the order validation checks them. Each tuple value is the UTF-8 of the canonical text form the parameter codec
 * writes for the comparator's carrier (codec/scalar.ts), the text that is bound as the seek predicate's parameter, so
 * a boundary is exact by construction: bigint and numeric digits, NaN and the infinities as words, one zero, float
 * shortest round-trip text, never a lossy JSON number.
 *
 * A token's fields: its three digests, 16 bytes each by their type, and its tuple's values.
 */
export interface CursorFields {
	readonly generation: DigestBytes
	readonly query: DigestBytes
	readonly comparators: DigestBytes
	readonly tuple: ReadonlyArray<Uint8Array>
}

/** The bytes of a token. */
export const writeCursor = (fields: CursorFields): Uint8Array => {
	const w = new ByteWriter()
	w.field(fields.generation).field(fields.query).field(fields.comparators)
	w.varint(fields.tuple.length)
	for (const value of fields.tuple) {
		w.field(value)
	}
	return w.finish()
}

const readDigest = (r: ByteReader): DigestBytes | undefined => {
	const bytes = r.field(cursorDigestBytes)
	return bytes?.length === cursorDigestBytes ? DigestBytes(bytes) : undefined
}

/**
 * The fields of token bytes; any departure from the layout is cursorMalformed. Each value takes at least its one-byte
 * length, so a count above the remaining bytes cannot be satisfied.
 */
export const readCursor = (bytes: Uint8Array): Result.Result<CursorFields, "cursorMalformed"> => {
	const r = new ByteReader(bytes)
	const generation = readDigest(r)
	const query = readDigest(r)
	const comparators = readDigest(r)
	if (generation === undefined || query === undefined || comparators === undefined) {
		return Result.err("cursorMalformed")
	}
	const count = r.varint()
	if (count === undefined || count > r.remaining) {
		return Result.err("cursorMalformed")
	}
	const tuple: Array<Uint8Array> = []
	for (let i = 0; i < count; i++) {
		const value = r.field(r.remaining)
		if (value === undefined) {
			return Result.err("cursorMalformed")
		}
		tuple.push(value)
	}
	if (!r.done) {
		return Result.err("cursorMalformed")
	}
	return Result.ok({ generation, query, comparators, tuple })
}

/** The fixed bytes of a token around its values: three length-prefixed digests. */
export const headerBytes = 3 * (1 + cursorDigestBytes)
