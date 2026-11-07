import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	codePoint,
	element,
	filter,
	type Gen,
	oneOf,
	string,
	uniqueArray
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import {
	type ConcurrentChangeTag,
	encodeRefusalDetail,
	readChangeDetail,
	readLawDetail
} from "#compiler/write/refusal.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { outputText } from "#test/support/wire.ts"

/** The write refusal channel, without a database.
 *
 * - A refusal's DETAIL reads back whatever its relation, field names and key texts hold (quotes, backslashes, commas,
 *   brackets, control characters, supplementary-plane characters, another encoding's tag), and however its JSON
 *   strings are spelled: each character as itself where JSON allows it, or escaped, short or as `\uXXXX` in either
 *   case, a supplementary-plane character as an escaped surrogate pair, the solidus as `\/`; PostgreSQL's escape_json
 *   writes one of these spellings, JSON.stringify another.
 * - The reader trusts its text, grizzle's own: a DETAIL under any other tag, a concurrent change's or a law function's
 *   DetailCodec text among them, is foreign, its text kept. */
const reasons: Arr.NonEmptyReadonlyArray<ConcurrentChangeTag> = [
	"PutTargetConflict",
	"SpanKeyChange"
]

/**
 * Text PostgreSQL stores: printable ASCII, or any other character but NUL and the lone surrogates, so a
 * supplementary-plane character is a pair.
 */
const storable: Gen<string> = string(
	oneOf([codePoint(0x20, 0x7e), codePoint(0x01, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff)]),
	{ min: 0, max: 12 }
)
/** The DETAIL grammar's delimiters, escapes and quotes, and other tags, drawn as key texts beside the storable ones. */
const nasty = element([
	'"',
	"\\",
	"/",
	",",
	"]",
	"[",
	"\n\t\u0001\b\f\r",
	"k[",
	"a[",
	"w[",
	"\u{1F600}",
	"'",
	"$$",
	""
])
/** A key: distinct field names, each with its text. */
const keyGen: Gen<ReadonlyArray<{ readonly field: string; readonly text: string }>> = (source) =>
	Arr.map(
		source.draw(uniqueArray(storable, (field) => field, { min: 1, max: 4 }, 10)),
		(field) => ({
			field,
			text: source.draw(oneOf([storable, nasty]))
		})
	)

/** How one character of a JSON string is spelled. */
type Spelling = "itself" | "short" | "lower hex" | "upper hex"

/** The two-character escape of a character that has one. */
const shortEscapes: ReadonlyMap<string, string> = new Map([
	['"', '\\"'],
	["\\", "\\\\"],
	["/", "\\/"],
	["\b", "\\b"],
	["\f", "\\f"],
	["\n", "\\n"],
	["\r", "\\r"],
	["\t", "\\t"]
])

/** `\uXXXX` for each UTF-16 unit of a character. */
const hexEscape = (ch: string, upper: boolean): string =>
	Arr.join(
		Arr.map(Arr.range(0, ch.length - 1), (i) => {
			const unit = defined(Option.getOrUndefined(Str.charCodeAt(i)(ch)), "a UTF-16 unit")
			const hex = Str.padStart(4, "0")(unit.toString(16))
			return `\\u${upper ? Str.toUpperCase(hex) : hex}`
		}),
		""
	)

/** Whether JSON lets a character stand for itself inside a string. */
const plain = (ch: string): boolean =>
	ch !== '"' &&
	ch !== "\\" &&
	defined(Option.getOrUndefined(Str.codePointAt(0)(ch)), "a character's code point") >= 0x20

/** A JSON string literal of `text`, each character spelled as drawn among the spellings JSON allows it. */
const spelledGen =
	(text: string, seen: (spelling: Spelling) => void): Gen<string> =>
	(source) =>
		`"${Arr.join(
			Arr.map(Arr.fromIterable(text), (ch) => {
				const escapes: ReadonlyArray<Spelling> = [
					...(plain(ch) ? (["itself"] as const) : []),
					...(shortEscapes.has(ch) ? (["short"] as const) : [])
				]
				const allowed: Arr.NonEmptyReadonlyArray<Spelling> = ["lower hex", "upper hex", ...escapes]
				const spelling = source.draw(element(allowed))
				seen(spelling)
				switch (spelling) {
					case "itself":
						return ch
					case "short":
						return defined(shortEscapes.get(ch), "a short escape")
					case "lower hex":
						return hexEscape(ch, false)
					case "upper hex":
						return hexEscape(ch, true)
				}
			}),
			""
		)}"`

/** What a case reaches: each spelling of a character, an escaped supplementary-plane character. */
type DetailFeature = `spelled ${Spelling}` | "an escaped surrogate pair"

/** What a foreign DETAIL starts with: another tag of grizzle's, the law's tag without its bracket, or none. */
const foreignTags = ["a[", "o[", "w[", "c[", "K[", "k", ""] as const

/** A foreign DETAIL's kind: under one of the tags, or a concurrent change's own. */
type ForeignFeature = `under ${(typeof foreignTags)[number]}` | "a concurrent change"

describe("the write refusal channel", () => {
	describe("its DETAIL", () => {
		it.effect(
			"reads back a law's refusal and a concurrent change, whatever the names and key texts hold and however they are spelled",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "unit/write/refusal-1",
							draw: drawn(
								(source) =>
									[
										source.draw(storable),
										source.draw(keyGen),
										source.draw(element(reasons))
									] as const
							),
							literal: Formatter.format,
							coverage: required<DetailFeature>(
								[
									"spelled itself",
									"spelled short",
									"spelled lower hex",
									"spelled upper hex",
									"an escaped surrogate pair"
								],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 1000,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang,
							oracle: { kind: "universal", name: "read ∘ spell = id" }
						},
						([relation, key, reason], c) =>
							Effect.sync(() => {
								assert.deepEqual(
									readLawDetail(encodeRefusalDetail({ kind: "law", relation }, key)),
									{
										kind: "law",
										relation,
										key: Arr.map(key, (k) => ({ ...k, text: outputText(k.text) }))
									}
								)
								assert.deepEqual(
									readChangeDetail(encodeRefusalDetail({ kind: "change", reason, relation }, key)),
									{ reason, relation }
								)
								const spell = (text: string): string =>
									c.draw(
										spelledGen(text, (spelling) => {
											c.note(`spelled ${spelling}`)
										})
									)
								const respelled = (leading: ReadonlyArray<string>): string =>
									`[${Arr.join(
										[
											...Arr.map(leading, spell),
											`[${Arr.join(
												Arr.map(key, (k) => spell(k.field)),
												","
											)}]`,
											`[${Arr.join(
												Arr.map(key, (k) => spell(k.text)),
												","
											)}]`
										],
										","
									)}]`
								const law = `k${respelled([relation])}`
								const change = `a${respelled([reason, relation])}`
								if (Str.includes("\\ud8")(Str.toLowerCase(law))) {
									c.note("an escaped surrogate pair")
								}
								assert.deepEqual(readLawDetail(law), {
									kind: "law",
									relation,
									key: Arr.map(key, (k) => ({ ...k, text: outputText(k.text) }))
								})
								assert.deepEqual(readChangeDetail(change), { reason, relation })
							})
					)
				)
		)

		it.effect("reads a DETAIL under any other tag as foreign, keeping its text", (ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/refusal-foreign",
						draw: drawn(
							oneOf<readonly [ForeignFeature, string]>([
								(source) => {
									const tag = source.draw(element(foreignTags))
									const text = source.draw(
										filter(
											oneOf([storable, nasty]),
											(rest) => !Str.startsWith("k[")(`${tag}${rest}`),
											100
										)
									)
									return [`under ${tag}`, `${tag}${text}`] as const
								},
								(source) =>
									[
										"a concurrent change",
										encodeRefusalDetail(
											{
												kind: "change",
												reason: source.draw(element(reasons)),
												relation: source.draw(storable)
											},
											source.draw(keyGen)
										)
									] as const
							])
						),
						literal: Formatter.format,
						coverage: required<ForeignFeature>(
							[
								...Arr.map(foreignTags, (tag): ForeignFeature => `under ${tag}`),
								"a concurrent change"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "specification", name: "a law's DETAIL is the one under its tag" }
					},
					([feature, detail], c) =>
						Effect.sync(() => {
							c.note(feature)
							assert.deepEqual(readLawDetail(detail), { kind: "foreign", detail })
						})
				)
			)
		)
	})
})
