/**
 * What the property of decoded-path.test.ts reads: its fixture, its reads of a text's decoded path, its box and the
 * model it judges by.
 */

import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { regexField } from "#compiler/text/field.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { decodedPathOf } from "#test/support/oracle/reference/evaluate.ts"

/** A text within 256 bytes: what every written path is, and what its decoded path is cast into. */
const Written = str.bytes(256, regexField<string>("^.*$", ["su"]))

/** Each written path, by its id. */
const Encoded = relation("Encoded", { id: pg.integer, text: Written }, ["id"])

export const Paths = schema("Paths", [Encoded], [])

/**
 * The reads a case holds to the model: each written path's decoded path, cast into the written paths' own type, which
 * compiles only where a decoded path is typed within its text's byte bound; and the paths that spell none, a negation
 * of it.
 */
const programs = Object.freeze({
	load: ChangeSet.empty(Paths).insert(Encoded, []),
	decoded: query(Paths).rule((r) => {
		const { id, text } = v(Encoded, "e")
		const decoded = r.decodedPath(text)
		const { path } = v(decoded, "d")
		return r
			.match(Encoded, { id, text })
			.match(decoded, { path })
			.find({ id, path: Type.cast(path, Written) })
	}),
	undecodable: query(Paths).rule((r) => {
		const { id, text } = v(Encoded, "e")
		return r
			.match(Encoded, { id, text })
			.where(r.not(r.decodedPath(text), {}))
			.find({ id })
	})
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const pathsInstall = Object.freeze({ label: "decoded_path", programs })

/** Paths installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const pathsTemplate = fixtureTemplate(import.meta, Paths, pathsInstall)

/** What a token of a written path is, which the situations a case reaches read. */
type TokenKind =
	| "literal"
	| "escape"
	| "wide escape"
	| "ill-formed"
	| "broken run"
	| "escaped slash"
	| "escaped NUL"
	| "written dots"
	| "stray percent"

interface Token {
	readonly kind: TokenKind
	readonly text: string
}

/** Characters written as themselves: a letter, a slash, a dot, a space, é, a character beyond the BMP and a `?`. */
const literals = ["a", "/", ".", " ", "é", "😀", "?"] as const

/** Code points written as escapes of their UTF-8: one to four octets, the ends of each width among them. */
const escaped = [
	0x20, 0x41, 0x2e, 0x7f, 0x80, 0xe9, 0x7ff, 0x800, 0x20ac, 0xfffd, 0x10000, 0x1f600, 0x10ffff
] as const

/**
 * Octets that spell no UTF-8: a lone continuation, truncated leads of each width, overlong forms of each width, a
 * surrogate, past U+10FFFF and octets no UTF-8 holds.
 */
const illFormed = [
	"%80",
	"%BF",
	"%C3",
	"%E2%82",
	"%F0%9F%98",
	"%C0%80",
	"%C1%BF",
	"%E0%80%80",
	"%E0%9F%BF",
	"%ED%A0%80",
	"%F0%80%80%80",
	"%F0%8F%BF%BF",
	"%F4%90%80%80",
	"%F5%80%80%80",
	"%FF"
] as const

/** A lead escape and the continuation escapes it needs, a literal between them, which ends the lead's run. */
const brokenRuns = ["%C3a%A9", "%E2%82a%AC", "%F0%9F/%98%80"] as const

/** A `%` that begins no `%HH`: at the end, before one digit, or before no hex digit. */
const strays = ["%", "%4", "%zz", "%G1"] as const

/** Segments of dots alone with one written `%2E`, each between slashes. */
const dotted = ["/%2E/", "/%2e/", "/.%2E/", "/%2E%2E/"] as const

/** An octet as `%HH`, its hex digits upper or lower case. */
const escapeOf = (octet: number, lower: boolean): string => {
	const hex = Str.padStart(2, "0")(octet.toString(16))
	return `%${lower ? hex : Str.toUpperCase(hex)}`
}

/** A code point's UTF-8 octets, as `TextEncoder` writes them. */
const octetsOf = (point: number): ReadonlyArray<number> =>
	Arr.fromIterable(new TextEncoder().encode(String.fromCodePoint(point)))

/** A token that spells its own characters: a literal, or an escape of a code point's UTF-8. */
const plainGen: Gen<Token> = weighted<Token>([
	[1, (s) => ({ kind: "literal", text: s.draw(element(literals)) })],
	[
		1,
		(s) => {
			const point = s.draw(element(escaped))
			const lower = s.draw(element([false, true]))
			return {
				kind: point > 0xffff ? "wide escape" : "escape",
				text: Arr.join(
					Arr.map(octetsOf(point), (o) => escapeOf(o, lower)),
					""
				)
			}
		}
	]
])

/** A token RFC 3986 gives the path no decoding for, most often octets that are no UTF-8. */
const refusedGen: Gen<Token> = weighted<Token>([
	[4, (s) => ({ kind: "ill-formed", text: s.draw(element(illFormed)) })],
	[2, (s) => ({ kind: "broken run", text: s.draw(element(brokenRuns)) })],
	[1, (s) => ({ kind: "escaped slash", text: s.draw(element(["%2F", "%2f"])) })],
	[1, () => ({ kind: "escaped NUL", text: "%00" })],
	[1, (s) => ({ kind: "written dots", text: s.draw(element(dotted)) })],
	[1, (s) => ({ kind: "stray percent", text: s.draw(element(strays)) })]
])

/** A written path: its tokens, up to five plain ones and, half the time, one refused token among them. */
export interface DrawnPath {
	readonly tokens: ReadonlyArray<Token>
}

/** A path's text, its tokens in order. */
const textOf = (path: DrawnPath): string =>
	Arr.join(
		Arr.map(path.tokens, (t) => t.text),
		""
	)

/** A case: the paths one transaction writes, one to six. */
export interface PathsCase {
	readonly paths: Arr.NonEmptyReadonlyArray<DrawnPath>
}

const pathGen: Gen<DrawnPath> = (s) => {
	const plain = s.draw(array(plainGen, { min: 0, max: 5 }))
	if (!s.draw(element([false, true]))) {
		return { tokens: plain }
	}
	const at = s.draw(int(0, plain.length))
	return { tokens: [...plain.slice(0, at), s.draw(refusedGen), ...plain.slice(at)] }
}

export const casesGen: Gen<PathsCase> = (s) => ({
	paths: [s.draw(pathGen), ...s.draw(array(pathGen, { min: 0, max: 5 }))]
})

/** A case's facts: its paths' texts by their ids from 1. */
export const factsOf = (c: PathsCase) => ({
	Encoded: Arr.map(c.paths, (path, i) => ({ id: i + 1, text: textOf(path) }))
})

/** Rows of decoded paths, each written as its identity. */
export const decodedText = (
	rows: Iterable<{ readonly id: number; readonly path: string }>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => `${r.id} ${jsonText(r.path)}`),
		Order.String
	)

/** The model's decoded paths of a case: each path's (decodedPathOf), by its id. */
export const decodedModel = (c: PathsCase): ReadonlyArray<string> =>
	decodedText(
		Arr.flatMap(c.paths, (path, i) =>
			Option.match(decodedPathOf(textOf(path)), {
				onNone: () => [],
				onSome: (decoded) => [{ id: i + 1, path: decoded }]
			})
		)
	)

/** The ids of rows, in order. */
export const idsOf = (rows: Iterable<{ readonly id: number }>): ReadonlyArray<number> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => r.id),
		Order.Number
	)

/** The model's ids of a case's paths that spell none. */
export const undecodableModel = (c: PathsCase): ReadonlyArray<number> =>
	Arr.flatMap(c.paths, (path, i) => (Option.isNone(decodedPathOf(textOf(path))) ? [i + 1] : []))

export type PathFeature =
	| "the empty path"
	| "a path decoded"
	| "an escape beyond the BMP decoded"
	| "an escape run broken by a literal"
	| "ill-formed UTF-8 refused"
	| "an escaped slash refused"
	| "an escaped NUL refused"
	| "a written dot segment refused"
	| "a stray percent refused"

/** The situations a case reaches. */
export const pathFeatures = (c: PathsCase): ReadonlyArray<PathFeature> =>
	Arr.flatMap(c.paths, (path): ReadonlyArray<PathFeature> => {
		const kinds = new Set(Arr.map(path.tokens, (t) => t.kind))
		const decoded = Option.isSome(decodedPathOf(textOf(path)))
		return [
			...(path.tokens.length === 0 ? ["the empty path" as const] : []),
			...(decoded ? ["a path decoded" as const] : []),
			...(decoded && kinds.has("wide escape") ? ["an escape beyond the BMP decoded" as const] : []),
			...(kinds.has("broken run") ? ["an escape run broken by a literal" as const] : []),
			...(kinds.has("ill-formed") && !decoded ? ["ill-formed UTF-8 refused" as const] : []),
			...(kinds.has("escaped slash") ? ["an escaped slash refused" as const] : []),
			...(kinds.has("escaped NUL") ? ["an escaped NUL refused" as const] : []),
			...(kinds.has("written dots") ? ["a written dot segment refused" as const] : []),
			...(kinds.has("stray percent") && !decoded ? ["a stray percent refused" as const] : [])
		]
	})
