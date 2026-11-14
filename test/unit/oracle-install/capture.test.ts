/**
 * Raw text capture, the host side of format('%L') (test/support/oracle/install/capture.ts unquoteLiteral): it reads a
 * quoted literal PostgreSQL's quote_literal writes back as the text it quoted, and refuses what quote_literal never
 * writes.
 *
 * - Round trip: unquoteLiteral(quote_literal(t)) = t for every text t, quote_literal restated from PostgreSQL's
 *   src/backend/utils/adt/quote.c (quotes and backslashes doubled, an E prefix when the text holds a backslash).
 * - Refusal: a literal quote_literal wrote with one fault planted is read as no literal: the bare word NULL, the
 *   opening or the closing quote dropped, one doubled quote halved, or, in an E literal, one doubled backslash halved.
 *
 * Texts are drawn from an alphabet with explicit weights, quote and backslash beside ordinary letters and any Unicode
 * scalar value, so the characters quote_literal doubles are no rarity. Features: a text holding a quote, one holding a
 * backslash (an E literal), one holding both, the empty text, and every planted fault.
 *
 * Plants: ~/.cache/grizzle-release/BR07/plants/capture-lone-quote.patch (a lone quote read as itself) turns the refusal
 * red; capture-backslash-kept.patch (an E literal's backslashes left doubled) turns the round trip red.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import {
	constant,
	element,
	type Gen,
	string,
	unicodeScalar,
	weighted
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Effect, Formatter, Option, pipe, String as Str } from "effect"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { unquoteLiteral } from "#test/support/oracle/install/capture.ts"

/**
 * What PostgreSQL's quote_literal writes for a non-NULL text (src/backend/utils/adt/quote.c): quotes and backslashes
 * doubled, and an E prefix when the text has a backslash.
 */
const quoteLiteral = (text: string): string => {
	const body = pipe(Str.replaceAll("'", "''")(text), Str.replaceAll("\\", "\\\\"))
	return Str.includes("\\")(text) ? `E'${body}'` : `'${body}'`
}

/** One character of a text: the two quote_literal doubles, an ASCII letter, or any Unicode scalar value. */
const characterGen: Gen<string> = weighted([
	[2, constant("'")],
	[2, constant("\\")],
	[3, element(["a", "b", "E", "N"])],
	[3, unicodeScalar]
])

const textGen: Gen<string> = string(characterGen, { min: 0, max: 10 })

/** A fault planted in a literal quote_literal wrote, each one quote_literal never writes. */
type Fault =
	| "the bare word NULL"
	| "the opening quote dropped"
	| "the closing quote dropped"
	| "a doubled quote halved"
	| "a doubled backslash halved"

/** Where a doubled character sits in a literal's body: the index of its first half, past the body's opening quote. */
const doubledAt = (quoted: string, ch: string): Option.Option<number> => {
	const start = Str.startsWith("E'")(quoted) ? 2 : 1
	for (let i = start; i < quoted.length - 2; i += 1) {
		const here = quoted[i]
		if (here === ch && quoted[i + 1] === ch) {
			return Option.some(i)
		}
		if (here === "'" || here === "\\") {
			i += 1
		}
	}
	return Option.none()
}

/** The literal without its character at `at`. */
const without = (quoted: string, at: number): string =>
	`${Str.slice(0, at)(quoted)}${Str.slice(at + 1)(quoted)}`

/** The literal with `fault` planted, or none where the literal holds nothing the fault edits. */
const planted = (quoted: string, fault: Fault): Option.Option<string> => {
	switch (fault) {
		case "the bare word NULL":
			return Option.some("NULL")
		case "the opening quote dropped":
			return Option.some(without(quoted, Str.startsWith("E'")(quoted) ? 1 : 0))
		case "the closing quote dropped":
			return Option.some(without(quoted, quoted.length - 1))
		case "a doubled quote halved":
			return Option.map(doubledAt(quoted, "'"), (at) => without(quoted, at))
		case "a doubled backslash halved":
			return Option.map(doubledAt(quoted, "\\"), (at) => without(quoted, at))
	}
}

type Feature =
	| "a quote"
	| "a backslash"
	| "a quote and a backslash"
	| "the empty text"
	| `refused: ${Fault}`

const faults: ReadonlyArray<Fault> = [
	"the bare word NULL",
	"the opening quote dropped",
	"the closing quote dropped",
	"a doubled quote halved",
	"a doubled backslash halved"
]

describe("unquoteLiteral", () => {
	it.effect(
		"reads every literal quote_literal writes as its text, and refuses every literal with a fault planted",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "unquoteLiteral ∘ quote_literal = id, and no planted fault reads back"
						},
						suite: "unit/oracle-install/capture",
						draw: drawn(textGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a quote",
								"a backslash",
								"a quote and a backslash",
								"the empty text",
								"refused: the bare word NULL",
								"refused: the opening quote dropped",
								"refused: the closing quote dropped",
								"refused: a doubled quote halved",
								"refused: a doubled backslash halved"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(text, c) =>
						Effect.sync(() => {
							const quoted = quoteLiteral(text)
							assert.equal(unquoteLiteral(quoted), text, quoted)
							const quote = Str.includes("'")(text)
							const backslash = Str.includes("\\")(text)
							if (quote) {
								c.note("a quote")
							}
							if (backslash) {
								c.note("a backslash")
							}
							if (quote && backslash) {
								c.note("a quote and a backslash")
							}
							if (text.length === 0) {
								c.note("the empty text")
							}
							for (const fault of faults) {
								const broken = planted(quoted, fault)
								if (Option.isSome(broken)) {
									assert.equal(unquoteLiteral(broken.value), undefined, `${fault}: ${broken.value}`)
									c.note(`refused: ${fault}`)
								}
							}
						})
				)
			)
	)
})
