/**
 * The readers of a text held as its chunks (grizzle-text chunks.ts) read what the whole text gives, whatever the cuts:
 * the JSON reader is JSON.parse, the byte comparison of a file with a text parts where the whole arrays part, and the
 * view the SQL lexer reads is the string, so the marker and statement scanners (deploy/render/markers.ts) find in a
 * file's chunks what they find in its text.
 *
 * Properties, per case. JSON: a drawn JSON text in every spelling RFC 8259 allows (whitespace, one-character and \u
 * escapes, lone surrogates by escape, astral characters, numbers with fractions and exponents, -0, repeated keys,
 * `__proto__` and integer-like keys), or one nested twenty thousand containers deep, or a near miss with one character
 * inserted or removed, cut anywhere into strings (between a pair's halves, inside an escape or a number among them),
 * and the same text cut as a ChunkWriter cuts it: readJson's verdict is JSON.parse's, and its value is JSON.parse's
 * value for value (keys in order, -0 kept). Bytes: a drawn text's UTF-8 as its chunks, held to the bytes of it or of a
 * near copy (one byte changed, cut short, run on), each cut into drawn blocks: ByteMatch parts where the whole arrays
 * first part, at the shorter's length where one is the other's start. View: a drawn SQL file cut anywhere: ChunkView's
 * length, units, searches and slices are the string's, and findMarkers, splitStatements, isNoTransaction and textLines
 * read the view as they read the string. Oracles: JSON.parse (differential); a comparison of whole byte arrays
 * (specification); the string's own methods and the scanners over the string (differential). Kills: a reader that drops
 * `\/` from JSON's escapes; a parting placed past the byte that differs; a search that misses a match across a seam.
 *
 * Features: a pair cut between chunks; an escape cut between chunks; a text JSON.parse refuses; nesting deeper than a
 * call stack; a text cut as a writer cuts it; a match across a seam; a parting inside a block.
 */

import {
	ByteMatch,
	ChunkView,
	chunkBytes,
	chunksOf,
	chunkUnits,
	readJson,
	type TextView
} from "@bjornpagen/grizzle-text/chunks"
import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { wellFormed } from "#compiler/core/text.ts"
import {
	findMarkers,
	isNoTransaction,
	splitStatements,
	textLines
} from "#compiler/deploy/render/markers.ts"
import {
	agreesWithParse,
	cutAt,
	type JsonCase,
	jsonCaseGen,
	type SqlCase,
	sqlCaseGen
} from "#test/support/unit/text/chunks.fixtures.ts"

type JsonSituation =
	| "a pair cut between chunks"
	| "an escape cut between chunks"
	| "a text JSON.parse refuses"
	| "nesting deeper than a call stack"
	| "a text cut as a writer cuts it"

/** Whether a cut at `at` of `text` falls between a pair's halves, or right after a backslash. */
const cutKinds = (text: string, cuts: ReadonlyArray<number>, note: (s: JsonSituation) => void) => {
	const whole: TextView = text
	for (const at of cuts) {
		const before = whole.charCodeAt(at - 1)
		if (before >= 0xd800 && before <= 0xdbff && at < text.length) {
			note("a pair cut between chunks")
		}
		if (whole.charAt(at - 1) === "\\") {
			note("an escape cut between chunks")
		}
	}
}

/** A JSON text read as its chunks is JSON.parse's value of the text. */
export const aJsonTextReadAsItsChunksIsJsonParsesValue = property.explore(jsonCaseGen, {
	needs: {},
	situations: [
		"a pair cut between chunks",
		"an escape cut between chunks",
		"a text JSON.parse refuses",
		"nesting deeper than a call stack",
		"a text cut as a writer cuts it"
	],
	check: (_, c: Case<JsonSituation>) => (j: JsonCase) =>
		Effect.sync(() => {
			cutKinds(j.text, j.cuts, c.note)
			if (j.form.kind === "deep" && j.form.depth > 10_000) {
				c.note("nesting deeper than a call stack")
			}
			const cut = readJson(cutAt(j.text, j.cuts))
			agreesWithParse(j.text, cut, "the text cut at the drawn cuts")
			if (!cut.ok) {
				c.note("a text JSON.parse refuses")
			}
			if (j.text.isWellFormed()) {
				const padded = `[ ${jsonText(Str.repeat(chunkUnits - 1)("😀"))},${j.text}]`
				const written = chunksOf(wellFormed(padded))
				if (written.length > 1) {
					c.note("a text cut as a writer cuts it")
				}
				agreesWithParse(padded, readJson(written), "the text cut as a writer cuts it")
			}
		}),
	oracle: { kind: "second-implementation", name: "JSON.parse of the whole text" },
	kept: [],
	kills: [
		{
			file: "packages/text/src/chunks.ts",
			original: '\t[0x2f, "/"],',
			replacement: '\t[0x2a, "/"],',
			why: "The reader refuses the escape \\/, which JSON.parse reads as a solidus, so a text JSON.parse reads is one it refuses."
		}
	]
})

/** A drawn text, a near copy of its bytes, and the blocks each is read in. */
interface BytesCase {
	readonly text: string
	readonly edit:
		| { readonly kind: "same" }
		| { readonly kind: "changed"; readonly at: number }
		| { readonly kind: "short"; readonly at: number }
		| { readonly kind: "longer"; readonly by: number }
	readonly oursCuts: ReadonlyArray<number>
	readonly theirsCuts: ReadonlyArray<number>
}

const bytesCaseGen: Gen<BytesCase> = (source) => {
	const text = Arr.join(
		source.draw(array(element(["a", "é", "€", "😀", "\n", '"']), { min: 0, max: 40 })),
		""
	)
	const bytes = new TextEncoder().encode(text).length
	const kind = source.draw(element(["same", "changed", "short", "longer"]))
	const edit: BytesCase["edit"] =
		kind === "same"
			? { kind }
			: kind === "changed"
				? { kind, at: source.draw(int(0, Math.max(bytes - 1, 0))) }
				: kind === "short"
					? { kind, at: source.draw(int(0, bytes)) }
					: { kind, by: source.draw(int(1, 5)) }
	return {
		text,
		edit,
		oursCuts: source.draw(array(int(0, bytes), { min: 0, max: 6 })),
		theirsCuts: source.draw(array(int(0, bytes + 6), { min: 0, max: 6 }))
	}
}

/** `bytes` cut at `cuts` into blocks, empty ones among them. */
const blocks = (bytes: Uint8Array, cuts: ReadonlyArray<number>): ReadonlyArray<Uint8Array> => {
	const sorted = Arr.sort(
		Arr.map(cuts, (c) => Math.min(c, bytes.length)),
		(a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0)
	)
	const out: Array<Uint8Array> = []
	let from = 0
	for (const cut of sorted) {
		out.push(bytes.subarray(from, cut))
		from = cut
	}
	out.push(bytes.subarray(from))
	return out
}

/** Where two whole byte arrays first part, or none. */
const whereParted = (a: Uint8Array, b: Uint8Array): number | undefined => {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) {
			return i
		}
	}
	return a.length === b.length ? undefined : n
}

type BytesSituation =
	| "a parting inside a block"
	| "ours longer"
	| "theirs longer"
	| "the same bytes"

/** A text's chunks held to a file's bytes part where the whole byte arrays first part. */
export const aTextsChunksHeldToAFilesBytesPartWhereTheWholeArraysFirstPart = property.explore(
	bytesCaseGen,
	{
		needs: {},
		situations: ["a parting inside a block", "ours longer", "theirs longer", "the same bytes"],
		check: (_, c: Case<BytesSituation>) => (b: BytesCase) =>
			Effect.sync(() => {
				const ours = new TextEncoder().encode(b.text)
				const theirs = ((): Uint8Array => {
					switch (b.edit.kind) {
						case "same":
							return ours.slice()
						case "changed": {
							const copy = ours.slice()
							if (copy.length > 0) {
								copy[b.edit.at] = (copy[b.edit.at] ?? 0) ^ 0x01
							}
							return copy
						}
						case "short":
							return ours.slice(0, b.edit.at)
						case "longer": {
							const copy = new Uint8Array(ours.length + b.edit.by)
							copy.set(ours)
							return copy
						}
					}
				})()
				const expected = whereParted(ours, theirs)
				const match = new ByteMatch(blocks(ours, b.oursCuts))
				for (const block of blocks(theirs, b.theirsCuts)) {
					match.next(block)
				}
				const verdict = match.end()
				assert.deepEqual(
					verdict,
					expected === undefined ? { kind: "same" } : { kind: "differ", at: expected },
					"the parting is where the whole arrays part"
				)
				if (expected === undefined) {
					c.note("the same bytes")
				} else if (expected === theirs.length && expected < ours.length) {
					c.note("ours longer")
				} else if (expected === ours.length && expected < theirs.length) {
					c.note("theirs longer")
				} else {
					c.note("a parting inside a block")
				}
				if (b.text.isWellFormed()) {
					const chunked = new ByteMatch(chunkBytes(chunksOf(wellFormed(b.text))))
					chunked.next(theirs)
					assert.deepEqual(chunked.end(), verdict, "a text's chunks part as its whole bytes do")
				}
			}),
		oracle: { kind: "specification", name: "a comparison of the whole byte arrays" },
		kept: [],
		kills: [
			{
				file: "packages/text/src/chunks.ts",
				original: "\t\t\t\tthis.#matched += same",
				replacement: "\t\t\t\t\tthis.#matched += run",
				why: "A parting inside a block is placed at the block's end, past the byte that differs."
			}
		]
	}
)

type ViewSituation = "a match across a seam" | "a placeholder in SQL" | "an unclosed quote"

/** A SQL file's chunks read through a view are its text, to every reader of it. */
export const aSqlFilesChunksReadThroughAViewAreItsTextToEveryReader = property.explore(sqlCaseGen, {
	needs: {},
	situations: ["a match across a seam", "a placeholder in SQL", "an unclosed quote"],
	check: (_, c: Case<ViewSituation>) => (s: SqlCase) =>
		Effect.sync(() => {
			const pieces = cutAt(s.text, s.cuts)
			const view = new ChunkView(pieces)
			/** The whole text, read by the string's own methods. */
			const whole: TextView = s.text
			assert.equal(view.length, s.text.length, "the view's length is the text's")
			for (let at = -1; at <= s.text.length; at++) {
				assert.ok(Object.is(view.charCodeAt(at), whole.charCodeAt(at)), `unit ${at}`)
				assert.equal(view.charAt(at), whole.charAt(at), `character ${at}`)
			}
			for (const [search, from] of s.searches) {
				const found = view.indexOf(search, from)
				assert.equal(found, whole.indexOf(search, from), `${jsonText(search)} from ${from}`)
				let seam = 0
				for (const piece of pieces) {
					seam += piece.length
					if (found !== -1 && found < seam && seam < found + search.length) {
						c.note("a match across a seam")
					}
				}
			}
			for (const [start, end] of s.slices) {
				assert.equal(view.slice(start, end), whole.slice(start, end), `slice ${start}..${end}`)
			}
			assert.equal(view.slice(3, view.length), whole.slice(3, whole.length), "a slice to the end")
			const markers = findMarkers(s.text)
			assert.deepEqual(findMarkers(view), markers, "findMarkers reads the view as the text")
			if (Arr.some(markers, (m) => m.kind === "placeholder")) {
				c.note("a placeholder in SQL")
			}
			if (Str.includes("'unclosed")(s.text)) {
				c.note("an unclosed quote")
			}
			assert.deepEqual(
				splitStatements(view),
				splitStatements(s.text),
				"splitStatements reads the view as the text"
			)
			assert.equal(
				isNoTransaction(view),
				isNoTransaction(s.text),
				"isNoTransaction reads the view as the text"
			)
			assert.deepEqual(
				[...textLines(view)],
				[...textLines(s.text)],
				"textLines reads the view as the text"
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "the string's own methods and the scanners over the whole string"
	},
	kept: [],
	kills: [
		{
			file: "packages/text/src/chunks.ts",
			original: "\t\t\tif (seam < this.length) {",
			replacement: "\t\t\tif (seam < 0) {",
			why: "A search misses a match that straddles two chunks, so a marker or a line feed across a seam goes unread and the scanners see another text."
		}
	]
})
