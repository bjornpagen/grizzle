import { nominal } from "#compiler/core/brand.ts"
import type { Path } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription, unsupported } from "#compiler/core/errors.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"

declare const cursorDigestBrand: unique symbol
declare const digestBytesBrand: unique symbol

/**
 * The length of every identity digest in the token, a format constant of the token's layout (layout.ts), whose change
 * makes every issued token unreadable.
 *
 * Collision arithmetic: a token binds its query, its comparators and its generation by a digest each, checked by
 * equality, never by the identity itself, so a collision is not detected but made negligible. Over n distinct
 * identities of one kind, any two share a digest with probability at most n(n - 1) / 2 / 2^128: below 2^-65 for
 * n = 2^32. A token presented to another query of the same digest is read through that query's own comparator codecs,
 * each value admitted again (value.ts), so the most it can do is what a tampered token already can: move the page
 * boundary of a query the caller can run.
 *
 * @formatConstant the cursor token's digests: 16 bytes, a SHA-256's leading 32 hex digits
 */
export const cursorDigestBytes = 16

/**
 * One position of the completed order: a field of the final result heading, its direction, and its type.
 * A contract field orders and encodes as its base; its descriptor keeps the
 * contract so the comparator identity records the contract.
 */
export interface CursorComparator<T extends ScalarType = ScalarType> {
	readonly field: string
	readonly direction: "asc" | "desc"
	readonly type: T
}

/**
 * What the comparator digest admits: a comparator whose field and direction it checks itself, so a
 * malformed field or direction from any caller is refused as MalformedDescription. Every CursorComparator is one.
 */
interface ComparatorInput {
	readonly field: unknown
	readonly direction: unknown
	readonly type: ScalarType
}

/**
 * The semantic generation a token is valid for: the installed schema's fingerprint and each admitted
 * extension's semantic generation by extension name.
 */
export interface CursorGeneration {
	readonly schema: string
	readonly extensions: Readonly<Record<string, string>>
}

/**
 * The identity a cursor is bound to: three 16-byte digests, each SHA-256 over a
 * domain-separated canonical text (core/fingerprint.ts digest) truncated to its first 16 bytes.
 *
 * - generation: the schema fingerprint and the extension semantic generations. A token for an old generation fails
 *   explicitly; it is never reinterpreted.
 * - query: the canonical ordered-query fingerprint. It is the semantic identity of the ordered query, independent of
 *   SQL aliases, the requested page size and the request variant, so one edge's cursor serves
 *   after and before alike. It is authoritative over the TypeScript brand.
 * - comparators: the completed comparator sequence, each comparator's field, direction and scalar
 *   type, with the type's contract identity (name and base; never its predicate, as type identity is,
 *   ir/scalar.ts sameScalarType), roster, regex refinement and typmod.
 *
 * A truncated digest, 32 lowercase hex characters.
 */
export type CursorDigest = string & { readonly [cursorDigestBrand]: true }

/**
 * The brand of the digests this module computes. Only truncatedHex output is branded, so each is 32 lowercase hex
 * characters by construction.
 */
const CursorDigest = nominal<string, CursorDigest>()

const truncatedHex = (domain: string, value: unknown): Result.Result<string, CompileError> =>
	Result.map(digest(domain, value, { omit: omitPredicate }), (hex) =>
		hex.slice(0, cursorDigestBytes * 2)
	)

/** A contract's predicate is outside type identity (ir/scalar.ts sameScalarType). */
const omitPredicate = (key: string, ...[, path]: readonly [unknown, Path]): boolean =>
	key === "predicate" && path[path.length - 1] === "contract"

/**
 * A digest's 16 bytes, as a token carries them: branded where they are made, from a digest or by the layout's reader
 * after its length check (layout.ts readCursor).
 */
export type DigestBytes = Uint8Array & { readonly [digestBytesBrand]: true }
export const DigestBytes = nominal<Uint8Array, DigestBytes>()

/** The 16 bytes of a digest: by its mint, 32 lowercase hex digits, so each pair of digits is one byte. */
export const digestBytes = (d: CursorDigest): DigestBytes => {
	const bytes = new Uint8Array(cursorDigestBytes)
	for (let i = 0; i < cursorDigestBytes; i++) {
		bytes[i] = Number.parseInt(d.slice(2 * i, 2 * i + 2), 16)
	}
	return DigestBytes(bytes)
}

const nonEmptyText = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.isWellFormed()

export const queryDigest = (query: string): Result.Result<CursorDigest, CompileError> =>
	nonEmptyText(query)
		? Result.map(truncatedHex("cursor-query", { query }), CursorDigest)
		: Result.err(
				malformedDescription(
					SourceLoc("cursor query", []),
					"the ordered query's canonical fingerprint, a nonempty string"
				)
			)

export const generationDigest = (
	generation: CursorGeneration
): Result.Result<CursorDigest, CompileError> => {
	if (!nonEmptyText(generation.schema)) {
		return Result.err(
			malformedDescription(
				SourceLoc("cursor generation", []),
				"the schema fingerprint, a nonempty string"
			)
		)
	}
	const extensions = generation.extensions
	for (const [name, version] of Object.entries(extensions)) {
		if (!nonEmptyText(name) || !nonEmptyText(version)) {
			return Result.err(
				malformedDescription(
					SourceLoc("cursor generation", []),
					"each extension generation a nonempty string under its extension name"
				)
			)
		}
	}
	return Result.map(
		truncatedHex("cursor-generation", { extensions: { ...extensions }, schema: generation.schema }),
		CursorDigest
	)
}

/**
 * Checks one comparator and returns its identity record. The order domain must be admitted: equality-compatible
 * native ordering and a cursor representation, which every scalar codec provides.
 */
const comparatorRecord = (
	c: ComparatorInput,
	position: number
): Result.Result<
	{ readonly field: string; readonly record: { readonly [key: string]: unknown } },
	CompileError
> => {
	const loc = SourceLoc(`cursor comparator ${position + 1}`, [])
	if (!nonEmptyText(c.field)) {
		return Result.err(malformedDescription(loc, "a result heading field name"))
	}
	if (c.direction !== "asc" && c.direction !== "desc") {
		return Result.err(malformedDescription(loc, 'a direction, "asc" or "desc"'))
	}
	if (!c.type.caps.includes("ordering") || !c.type.caps.includes("equality")) {
		return Result.err(
			unsupported(loc, `an equality-compatible native total order for ${typeLabel(c.type)}`)
		)
	}
	return Result.ok({
		field: c.field,
		record: {
			direction: c.direction,
			field: c.field,
			type: c.type
		}
	})
}

export const comparatorDigest = (
	comparators: ReadonlyArray<ComparatorInput>
): Result.Result<CursorDigest, CompileError> => {
	/** A JavaScript caller can pass anything: the sequence is checked as the unknown value it may be. */
	const passed: unknown = comparators
	if (!Array.isArray(passed)) {
		return Result.err(
			malformedDescription(SourceLoc("cursor comparators", []), "the completed comparator sequence")
		)
	}
	const records: Array<unknown> = []
	const seen = new Set<string>()
	for (const [i, c] of comparators.entries()) {
		const record = comparatorRecord(c, i)
		if (!record.ok) {
			return Result.err(record.error)
		}
		const { field } = record.value
		if (seen.has(field)) {
			return Result.err(
				malformedDescription(
					SourceLoc(`cursor comparator ${i + 1}`, []),
					"each field once: completion skips fields already ordered"
				)
			)
		}
		seen.add(field)
		records.push(record.value.record)
	}
	return Result.map(truncatedHex("cursor-comparators", records), CursorDigest)
}
