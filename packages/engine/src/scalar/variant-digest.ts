/**
 * A variant's identity image (Variant.digest, ir/expr.ts VariantOp `digest`): the SHA-256 of its arm's handle's digest,
 * then each of its arm's fields' images in declared order, each of one width:
 *
 * | field | image |
 * | --- | --- |
 * | boolean | one byte, 1 or 0, boolsend's |
 * | smallint, integer, bigint | its 2, 4 or 8 bytes, most significant first, int2send's, int4send's and int8send's |
 * | real, double precision | its identity image (registry.ts floatBitsOf) as int8send's 8 bytes: -0 and 0 apart, every NaN one |
 * | text | the SHA-256 of its UTF-8, the library's textDigest |
 * | exact integer: numeric(p, 0), its contracts, an exact integer | the SHA-256 of its decimal text, its sign and digits |
 * | digest | its 32 bytes |
 * | closed id | the SHA-256 of its handle's UTF-8 |
 *
 * An exact integer's decimal text is canonical: a minus sign exactly where it is negative, its digits with no leading
 * zero, 0 alone for zero, whatever precision declares it, so two integers are one image exactly where they are equal
 * and numeric(825, 0) and numeric(30, 0) image one value alike. PostgreSQL writes it as `x::text`, numeric_out at scale
 * 0, IMMUTABLE; the host writes the bigint it holds; and its digest is of one width, whatever its digits.
 *
 * The handle's digest names the arm, and every image after it is of the one width its field's type fixes, so the bytes
 * part into the arm and its fields one way: two values have one image exactly where they are of one arm and each field
 * of it is one value under its image, the equality of a bag's members (a QTI multiple's): two texts one where their
 * UTF-8 is, two floats where their bits are, -0 apart from 0 and every NaN one, where the variant's own equality, a
 * record's, holds -0 equal to 0. The image reads handles, never codes, so the host computes it with no installation's
 * codes, and a generated field of it (README "Keys and indexes") is a key whatever text an arm holds: a value's image is
 * 32 bytes, which no text's length bounds.
 *
 * PostgreSQL computes it as `sha256(CASE (x)."tag" WHEN <code> THEN '\x<the handle's digest>'::bytea || <each field's
 * image> … END)` (lower/conservative/expr/variant.ts), every function IMMUTABLE, so the image stands in a generated
 * column, a check and a query; the host computes the same bytes (hostVariantDigest).
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { baseOf, type ScalarType, type VariantInfo } from "#compiler/ir/scalar.ts"
import { floatBits } from "#compiler/scalar/compute/float.ts"
import type { VariantValue } from "#compiler/scalar/values/identity.ts"
import { Sha256 } from "#compiler/scalar/values/sha256.ts"

/** How a field of an arm is imaged (the module's table), by its base carrier; none for a carrier the image holds no image of. */
export type DigestPart =
	| "bool"
	| "int2"
	| "int4"
	| "int8"
	| "float"
	| "integer"
	| "text"
	| "sha256"
	| "code"

/** The image of a field of type `t`; none where the image holds no image of its carrier. */
export const digestPartOf = (t: ScalarType): DigestPart | undefined => {
	const base = baseOf(t)
	const carrier = base.carrier
	switch (carrier) {
		case "numeric":
			return base.typmod?.scale === 0 ? "integer" : undefined
		case "exactInteger":
			return "integer"
		case "bool":
		case "int2":
		case "int4":
		case "int8":
		case "text":
		case "sha256":
		case "code":
			return carrier
		case "float4":
		case "float8":
			return "float"
		case "bits":
		case "bytes":
		case "cidr":
		case "date":
		case "exactMoney":
		case "inet":
		case "money":
		case "range4":
		case "range8":
		case "rangeDate":
		case "tsvector":
		case "uuid":
		case "variant":
		case "vector":
			return undefined
	}
}

/** Whether every field of every arm of `variant` has an image: what a digest of it is typed over. */
export const digestible = (variant: VariantInfo): boolean =>
	variant.arms.every((arm) => arm.fields.every((f) => digestPartOf(f.type) !== undefined))

/** The SHA-256 of a handle's UTF-8: an arm's image, and a closed id's. A handle is well formed, as a declared name is. */
export const handleDigest = (handle: string): Sha256 => {
	const digest = Sha256.ofText(handle)
	if (!digest.ok) {
		defect(`handle ${JSON.stringify(handle)} is well-formed text`)
	}
	return digest.value
}

/** `value`'s `width` bytes, most significant first, two's complement: intNsend's. */
const bigEndian = (value: bigint, width: number): Uint8Array => {
	const out = new Uint8Array(width)
	let rest = BigInt.asUintN(width * 8, value)
	for (let i = width - 1; i >= 0; i--) {
		out[i] = Number(rest & 0xffn)
		rest >>= 8n
	}
	return out
}

/** The image of one field's host value, of image `part`. */
const fieldImage = (part: DigestPart, value: unknown): Uint8Array => {
	switch (part) {
		case "bool":
			return Uint8Array.of(value === true ? 1 : 0)
		case "int2":
			return bigEndian(BigInt(Number(value)), 2)
		case "int4":
			return bigEndian(BigInt(Number(value)), 4)
		case "int8":
			return bigEndian(typeof value === "bigint" ? value : BigInt(Number(value)), 8)
		case "float":
			return bigEndian(floatBits(Number(value)), 8)
		case "integer":
			return textImage(
				typeof value === "bigint" ? value.toString() : defectOf("an exact integer's bigint")
			)
		case "text": {
			const digest = Sha256.ofText(String(value))
			if (!digest.ok) {
				defect("an admitted text is well formed")
			}
			return digest.value
		}
		case "sha256":
			return value instanceof Uint8Array ? value : defectOf("a digest's bytes")
		case "code":
			return handleDigest(String(value))
	}
}

/** The SHA-256 of a text's UTF-8, a field's image of it. */
const textImage = (text: string): Uint8Array => {
	const digest = Sha256.ofText(text)
	if (!digest.ok) {
		defect("an image's text is well formed")
	}
	return digest.value
}

const defectOf = (what: string): never => {
	defect(`a variant field's host value is ${what}`)
}

/** The identity image of `value`, a value of `variant` (the module's definition), as PostgreSQL computes it. */
export const hostVariantDigest = (variant: VariantInfo, value: VariantValue): Sha256 => {
	const arm = variant.arms.find((a) => a.handle === value.tag)
	if (arm === undefined) {
		defect(`an admitted value's arm ${value.tag} is an arm of variant ${variant.name}`)
	}
	const parts: Array<Uint8Array> = [handleDigest(arm.handle)]
	for (const f of arm.fields) {
		const part = digestPartOf(f.type)
		if (part === undefined) {
			defect(`a digested variant's field ${f.name} has an image`)
		}
		parts.push(fieldImage(part, value[f.name]))
	}
	const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const p of parts) {
		bytes.set(p, at)
		at += p.length
	}
	return Sha256.ofBytes(bytes)
}
