import type { ValueFault } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { bytesMaxLength } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"

/**
 * A bytes host value: a Uint8Array over an ArrayBuffer of its own, PostgreSQL's bytea written and read back whole. Every
 * value grizzle hands back is a fresh array over its own buffer, never a view into memory another value shares, so a
 * caller may keep, transfer or change it freely.
 */
export type Bytes = Uint8Array<ArrayBuffer>

/**
 * A bytes value's identity: the SHA-256 digest of its bytes (core/sha256.ts sha256Hex), 64 lowercase hex digits, as
 * PostgreSQL's `encode(sha256(value), 'hex')` spells it. It is all a write statement returns of a bytes column
 * (write/insert/statement.ts returnedColumn), and an admitted value carries its own (`AdmittedBytes`).
 */
export class BytesDigest {
	readonly digest: string
	constructor(digest: string) {
		this.digest = digest
	}
}

/**
 * An admitted bytes value: its bytes and their digest, worked out once at admission, so a fact's identity reads it
 * without reading the bytes again (scalar/values/identity.ts canonicalText); within one write, one digest is one value
 * (`DigestBook`). A delivered bytes value read for the host is one too, its digest worked out as it is read
 * (codec/read.ts scalarReader).
 */
export class AdmittedBytes extends BytesDigest {
	readonly bytes: Bytes
	constructor(bytes: Bytes) {
		super(sha256Hex(bytes))
		this.bytes = bytes
	}
}

/**
 * The encode-time boundary of a bytes value, read once from the caller's Uint8Array as it is now into a copy grizzle
 * alone holds, over an ArrayBuffer of its own: so the fact's identity and the bytes sent are the same, whatever the
 * caller does to its array after admission. A value that is no Uint8Array, or one over a detached buffer, which reads
 * as no bytes at all, is bytesType; one longer than core/limits.ts bytesMaxLength, which no bytea holds, is
 * bytesLength. One admitted already is itself, as every carrier's admission takes its own host value as it is, which a
 * nested write's facts meet twice (write/family/nesting.ts).
 */
export const admitBytes = (value: unknown): Result.Result<AdmittedBytes, ValueFault> => {
	if (value instanceof AdmittedBytes) {
		return Result.ok(value)
	}
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
	return Result.ok(new AdmittedBytes(new Uint8Array(value)))
}

/** Whether a value has the bytes host type: a Uint8Array over an ArrayBuffer. */
export const isBytes = (value: unknown): value is Bytes =>
	value instanceof Uint8Array && value.buffer instanceof ArrayBuffer

/** Whether a value is an admitted bytes value (`AdmittedBytes`). */
export const isAdmittedBytes = (value: unknown): value is AdmittedBytes =>
	value instanceof AdmittedBytes

/**
 * The digest of a value a write statement returned for a bytes column (codec/row.ts tupleConverter), or of an admitted
 * one: a value of no digest there is the compiler's defect, since only a bytes column's reader yields one.
 */
export const digestOf = (value: unknown): string => {
	if (!(value instanceof BytesDigest)) {
		throw defect("a bytes column's value, its digest")
	}
	return value.digest
}

/** Whether two bytes values hold the same bytes, as bytea's equality says. */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) {
		return false
	}
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) {
			return false
		}
	}
	return true
}

/**
 * The bytes values one write admits, each the one value of its digest there: a value whose digest another value of
 * different bytes already holds is a SHA-256 collision, which its admission refuses (bytesCollision) before any fact is
 * taken as another. So within one write two facts of one identity are one fact, and every site that takes them as one
 * (codec/recordset.ts, write/normalize/normalize.ts, write/family/nesting.ts) compares no bytes. One book is made for
 * each write's normalization (write/normalize/normalize.ts normalizeChangeSet) and dropped with it.
 */
export class DigestBook {
	readonly #held = new Map<string, Uint8Array>()

	/** Whether `value` is the one value of its digest the book holds, which it holds from now on when it held none. */
	holds(value: AdmittedBytes): boolean {
		const held = this.#held.get(value.digest)
		if (held === undefined) {
			this.#held.set(value.digest, value.bytes)
			return true
		}
		return held === value.bytes || sameBytes(held, value.bytes)
	}
}

/**
 * bytea's B-tree order (byteacmp): the first byte that differs decides, unsigned, and a value before every longer value
 * it begins. Only the host reads it, since a bytes value has no ordering capability.
 */
export const compareBytes = (a: Uint8Array, b: Uint8Array): -1 | 0 | 1 => {
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
