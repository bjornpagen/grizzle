/**
 * The role prefix, used verbatim (core/identity.ts parseRolePrefix, roleInSpace), with no database.
 *
 * A prefix names an installation's roles in the cluster: `<prefix>__<stem>`, exactly as its connection gives it, never
 * converted as a declared name, so `gr8des_qti_pin` stays `gr8des_qti_pin`.
 *
 * Properties, each against the specification spelled here apart from the code under test (arkregex over the text):
 * - Verbatim: for a drawn valid prefix, lowercase words and digit runs joined by single underscores, perhaps led or
 *   ended by one, and a drawn stem, two conversions joined by `__`, that fit 63 bytes together, the prefix parses to
 *   itself and the installed role is exactly `prefix + "__" + stem`.
 * - Refused: a drawn text over lowercase and uppercase letters, digits, `_`, `-` and a space, of zero to 70
 *   characters, perhaps led by `pg_`, or a run of `q` exactly at the budget or one byte past it, parses exactly when
 *   the specification admits it: `[a-z_][a-z0-9_]*`, no `__`, not led by `pg_`, and short enough that the longest
 *   hashed role name, `__aside_` and a ten-character digest, fits under it in 63 bytes (`<prefix>__<name>`), so at most
 *   63 - 2 - 18 = 43 bytes; every other text is refused.
 *
 * Features: a digit inside a word, a leading underscore, a trailing underscore; refused for a character, a leading
 * digit, a `__`, `pg_`, emptiness and length; a prefix at the budget, and one byte past it.
 *
 * Plants (~/.cache/grizzle-release/ROLESPACE/plants): role-prefix-converted.patch (the prefix converted as a declared
 * name, `gr8des` installing as `gr_8_des`).
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, codePoint, element, type Gen, int, string } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { maxIdentifierBytes, parseRolePrefix, roleInSpace } from "#compiler/core/identity.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** A lowercase PostgreSQL identifier segment: the characters a prefix is written in. */
const identifierSegment = regex("^[a-z_][a-z0-9_]*$")

/**
 * The most bytes a role prefix takes by the specification: the longest hashed role name the naming door mints,
 * `__aside_` and a ten-character digest, fits after it and `__` in PostgreSQL's 63.
 */
const prefixBudget = 63 - "__".length - "__aside_".length - 10

/** Whether `text` is a role prefix by the specification. */
const specified = (text: string): boolean =>
	identifierSegment.test(text) &&
	!Str.includes("__")(text) &&
	!Str.startsWith("pg_")(text) &&
	utf8Length(text) <= prefixBudget

interface Valid {
	readonly prefix: string
	readonly stem: string
}

type ValidFeature = "a digit inside a word" | "a leading underscore" | "a trailing underscore"

const wordGen: Gen<string> = string(codePoint(0x61, 0x7a), { min: 1, max: 5 })

/** A word, then a letter, then perhaps digits: a segment that starts with a letter and never spells `pg` alone. */
const segmentGen: Gen<string> = (source) =>
	`${source.draw(wordGen)}x${source.draw(string(codePoint(0x30, 0x39), { min: 0, max: 3 }))}`

const validGen: Gen<Valid> = (source) => {
	const segments = [
		source.draw(segmentGen),
		...source.draw(
			array(string(element(["a", "b", "z", "0", "8", "9"]), { min: 1, max: 4 }), { min: 0, max: 2 })
		)
	]
	const lead = source.draw(boolean) ? "_" : ""
	const trail = source.draw(boolean) ? "_" : ""
	const stem = `${source.draw(wordGen)}__${source.draw(wordGen)}`
	return { prefix: `${lead}${Arr.join(segments, "_")}${trail}`, stem }
}

const validNotes = (v: Valid): ReadonlyArray<ValidFeature> => [
	...(regex("[a-z][0-9]|[0-9][a-z]").test(v.prefix) ? (["a digit inside a word"] as const) : []),
	...(Str.startsWith("_")(v.prefix) ? (["a leading underscore"] as const) : []),
	...(Str.endsWith("_")(v.prefix) ? (["a trailing underscore"] as const) : [])
]

const validCase = (v: Valid, c: Case<ValidFeature>) =>
	Effect.sync(() => {
		c.noteAll(validNotes(v))
		const parsed = parseRolePrefix(v.prefix)
		assert.ok(parsed.ok, `${v.prefix} is a prefix`)
		const verbatim: string = parsed.value
		assert.equal(verbatim, v.prefix, "the prefix parses to itself, never converted")
		const installed = roleInSpace({ kind: "prefixed", prefix: parsed.value }, v.stem)
		const expected = `${v.prefix}__${v.stem}`
		if (utf8Length(expected) > maxIdentifierBytes.value) {
			assert.ok(!installed.ok, `${expected} is past the identifier`)
			return
		}
		assert.ok(installed.ok, `${expected} fits the identifier`)
		assert.equal(installed.value, expected, "the installed role is the prefix, __ and the stem")
	})

type RefusedFeature =
	| "a prefix"
	| "a character"
	| "a leading digit"
	| "a double underscore"
	| "pg_ first"
	| "empty"
	| "too long"
	| "a prefix at the budget"
	| "a prefix one byte past the budget"

/**
 * A text a connection might give as a prefix: drawn characters, perhaps led by `pg_`, perhaps past 63 bytes; or a run
 * of `q` at the budget or one byte past it, which a draw of characters all but never spells.
 */
const textGen: Gen<string> = (source) => {
	if (source.draw(int(0, 4)) === 0) {
		return Str.repeat(prefixBudget + source.draw(int(0, 1)))("q")
	}
	const body = source.draw(
		string(element(["a", "q", "z", "B", "Q", "0", "9", "_", "-", " "]), {
			min: 0,
			max: source.draw(boolean) ? 70 : 8
		})
	)
	return source.draw(int(0, 3)) === 0 ? `pg_${body}` : body
}

const refusedNotes = (text: string): ReadonlyArray<RefusedFeature> => {
	const atBudget = regex("^q+$").test(text) && utf8Length(text) === prefixBudget
	const pastBudget = regex("^q+$").test(text) && utf8Length(text) === prefixBudget + 1
	if (specified(text)) {
		return ["a prefix", ...(atBudget ? (["a prefix at the budget"] as const) : [])]
	}
	if (pastBudget) {
		return ["too long", "a prefix one byte past the budget"]
	}
	return [
		...(text === "" ? (["empty"] as const) : []),
		...(regex("[^a-z0-9_]").test(text) ? (["a character"] as const) : []),
		...(regex("^[0-9]").test(text) ? (["a leading digit"] as const) : []),
		...(Str.includes("__")(text) ? (["a double underscore"] as const) : []),
		...(Str.startsWith("pg_")(text) ? (["pg_ first"] as const) : []),
		...(utf8Length(text) > prefixBudget ? (["too long"] as const) : [])
	]
}

const refusedCase = (text: string, c: Case<RefusedFeature>) =>
	Effect.sync(() => {
		c.noteAll(refusedNotes(text))
		const parsed = parseRolePrefix(text)
		assert.equal(
			parsed.ok,
			specified(text),
			`${Formatter.format(text)} parses exactly when it is a prefix`
		)
		if (parsed.ok) {
			const verbatim: string = parsed.value
			assert.equal(verbatim, text, "a prefix parses to itself")
		}
	})

describe("the role prefix, used verbatim", () => {
	it.effect(
		"installs every drawn valid prefix, digits and single underscores and all, as exactly prefix, __ and the stem",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/core/role-prefix/verbatim",
						draw: drawn(validGen),
						literal: Formatter.format,
						oracle: { kind: "specification", name: "`<prefix>__<stem>`, the prefix as given" },
						coverage: required<ValidFeature>(
							["a digit inside a word", "a leading underscore", "a trailing underscore"],
							{ cases: 32, sense: notesOnly }
						),
						kept: [],
						runs: 256,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					validCase
				)
			)
	)
	it.effect(
		"parses a drawn text as a prefix exactly when it is a lowercase identifier segment with no __, not led by pg_, within the 43 bytes the longest hashed role name leaves, and refuses every other",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/core/role-prefix/refused",
						draw: drawn(textGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "[a-z_][a-z0-9_]*, no __, not led by pg_, at most 63 - 2 - |__aside_<digest>| bytes"
						},
						coverage: required<RefusedFeature>(
							[
								"a prefix",
								"a character",
								"a leading digit",
								"a double underscore",
								"pg_ first",
								"empty",
								"too long",
								"a prefix at the budget",
								"a prefix one byte past the budget"
							],
							{ cases: 32, sense: notesOnly }
						),
						kept: [],
						runs: 256,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					refusedCase
				)
			)
	)
})
