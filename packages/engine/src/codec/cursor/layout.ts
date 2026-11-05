import { ByteReader, type ReadFault, written } from "#compiler/codec/cursor/bytes.ts"
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
 * A token's three digests, 16 bytes each by their type, in the order validation checks them.
 */
export interface CursorDigests {
	readonly generation: DigestBytes
	readonly query: DigestBytes
	readonly comparators: DigestBytes
}

/** A token's fields: its three digests and its tuple's values. */
export interface CursorFields extends CursorDigests {
	readonly tuple: ReadonlyArray<Uint8Array>
}

/** The bytes of a token. */
export const writeCursor = (fields: CursorFields): Uint8Array =>
	written((sink) => {
		sink.field(fields.generation).field(fields.query).field(fields.comparators)
		sink.varint(fields.tuple.length)
		for (const value of fields.tuple) {
			sink.field(value)
		}
	})

/**
 * Why token bytes are not a token's layout, every one cursorMalformed (fault.ts): the reader's refusal (bytes.ts
 * ReadFault: a malformed varint, or a length or count claiming more than follows it), a digest of another length than
 * cursorDigestBytes, or bytes after the last field.
 */
export type LayoutFault = ReadFault | { readonly kind: "digest" } | { readonly kind: "trailing" }

const digestFault: LayoutFault = Object.freeze({ kind: "digest" })
const trailingFault: LayoutFault = Object.freeze({ kind: "trailing" })

const readDigest = (r: ByteReader): DigestBytes | LayoutFault => {
	const bytes = r.field()
	if (!(bytes instanceof Uint8Array)) {
		return bytes
	}
	return bytes.length === cursorDigestBytes ? DigestBytes(bytes) : digestFault
}

/**
 * What readCursor reads of token bytes whose layout is whole, for a codec of `arity` comparators: the token's fields,
 * each a view of the bytes, when its tuple holds `arity` values; or its digests and its tuple's count when the count is
 * another, every value walked past and none viewed, so a count the codec does not expect keeps nothing in proportion
 * to it, and is refused once the digests are checked (codec.ts decode).
 */
export type CursorRead =
	| (CursorFields & { readonly kind: "fields" })
	| (CursorDigests & { readonly kind: "count"; readonly count: number })

/** A tuple's `count` values, each a view of the bytes, or the first whose length claims more than follows it. */
const readValues = (
	r: ByteReader,
	count: number
): Result.Result<ReadonlyArray<Uint8Array>, ReadFault> => {
	const values: Array<Uint8Array> = []
	for (let i = 0; i < count; i++) {
		const value = r.field()
		if (!(value instanceof Uint8Array)) {
			return Result.err(value)
		}
		values.push(value)
	}
	return Result.ok(values)
}

/**
 * Past a tuple's `count` values, none of them viewed, the count; or the first value whose length claims more than
 * follows it.
 */
const skipValues = (r: ByteReader, count: number): Result.Result<number, ReadFault> => {
	for (let i = 0; i < count; i++) {
		const skipped = r.skip()
		if (typeof skipped !== "number") {
			return Result.err(skipped)
		}
	}
	return Result.ok(count)
}

/**
 * The layout of token bytes read for a codec of `arity` comparators, or the first departure from it. The tuple's count
 * is a claim as a length is, since each value takes at least its one-byte length, so neither a count nor a length is
 * read further than the bytes that follow it, and only a tuple of `arity` values is kept.
 */
export const readCursor = (
	bytes: Uint8Array,
	arity: number
): Result.Result<CursorRead, LayoutFault> => {
	const r = new ByteReader(bytes)
	const generation = readDigest(r)
	if (!(generation instanceof Uint8Array)) {
		return Result.err(generation)
	}
	const query = readDigest(r)
	if (!(query instanceof Uint8Array)) {
		return Result.err(query)
	}
	const comparators = readDigest(r)
	if (!(comparators instanceof Uint8Array)) {
		return Result.err(comparators)
	}
	const count = r.claim()
	if (typeof count !== "number") {
		return Result.err(count)
	}
	const read: Result.Result<CursorRead, ReadFault> =
		count === arity
			? Result.map(readValues(r, count), (tuple): CursorRead => ({
					kind: "fields",
					generation,
					query,
					comparators,
					tuple
				}))
			: Result.map(skipValues(r, count), (skipped): CursorRead => ({
					kind: "count",
					generation,
					query,
					comparators,
					count: skipped
				}))
	if (!read.ok || r.done) {
		return read
	}
	return Result.err(trailingFault)
}

/** The fixed bytes of a token around its values: three length-prefixed digests. */
export const headerBytes = 3 * (1 + cursorDigestBytes)
