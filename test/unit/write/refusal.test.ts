/** The write refusal channel, without a database.
 *
 * - A refusal's DETAIL reads back whatever its relation, field names and key texts hold (quotes, backslashes, commas,
 *   brackets, control characters, supplementary-plane characters, another encoding's tag), and however its JSON
 *   strings are spelled: each character as itself where JSON allows it, or escaped, short or as `\uXXXX` in either
 *   case, a supplementary-plane character as an escaped surrogate pair, the solidus as `\/`; PostgreSQL's escape_json
 *   writes one of these spellings, JSON.stringify another.
 * - The reader trusts its text, grizzle's own: a DETAIL under any other tag, a concurrent change's or a law function's
 *   DetailCodec text among them, is foreign, its text kept.
 *
 * Oracles: a round trip (read ∘ spell = id, every spelling JSON allows drawn) and the specification (a law's DETAIL is
 * the one under its tag). A foreign DETAIL is constructed so its tag never opens a law's: under a tag that begins the
 * law's own, the text stops inside the rest of it or turns away from it at a drawn character, so no draw is discarded.
 *
 * Features: each spelling of a character, an escaped surrogate pair; each foreign tag, a concurrent change's DETAIL.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { readChangeDetail, readLawDetail } from "#compiler/runtime/write/refusal.ts"
import { encodeRefusalDetail } from "#test/support/oracle/write/detail.ts"
import { outputText } from "#test/support/wire.ts"
import {
	type DetailFeature,
	foreignAfter,
	type ForeignFeature,
	foreignTags,
	keyGen,
	reasons,
	spelledGen,
	storable
} from "#test/unit/write/refusal.fixtures.ts"

/**
 * The write refusal channel its DETAIL reads back a law's refusal and a concurrent change, whatever the names and key
 * texts hold and however they are spelled.
 *
 * Budget: 1000 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/write/refusal.test.ts:191 at 8cad5bce, its runs and its coverage's cases).
 */
export const theWriteRefusalChannelItsDETAILReadsBackALawsRefusalAndAConcurrentChangeWhateverTheNamesAndKeyTextsHoldAndHoweverTheyAreSpelled =
	property.explore(
		(source) =>
			[source.draw(storable), source.draw(keyGen), source.draw(element(reasons))] as const,
		{
			needs: {},
			budget: { runs: 1000, steered: 200 },
			situations: [
				"spelled itself",
				"spelled short",
				"spelled lower hex",
				"spelled upper hex",
				"an escaped surrogate pair"
			] satisfies ReadonlyArray<Reached<DetailFeature>>,
			check:
				(_, c: Case<DetailFeature>) =>
				([relation, key, reason]) =>
					Effect.sync(() => {
						assert.deepEqual(readLawDetail(encodeRefusalDetail({ kind: "law", relation }, key)), {
							kind: "law",
							relation,
							key: Arr.map(key, (k) => ({ ...k, text: outputText(k.text) }))
						})
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
					}),
			oracle: { kind: "universal", name: "read ∘ spell = id" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/json-strings.ts",
					original: "\t\t\t\tvalue += escapeChar(code)",
					replacement: "\t\t\t\tvalue += String.fromCharCode(code)",
					why: "A short escape read as its letter (core/json-strings.ts), so `\\n` reads back as `n`; the round trip fails."
				}
			]
		}
	)

/**
 * The write refusal channel its DETAIL reads a DETAIL under any other tag as foreign, keeping its text.
 *
 * Budget: 300 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/write/refusal.test.ts:276 at 8cad5bce, its runs and its coverage's cases).
 */
export const theWriteRefusalChannelItsDETAILReadsADETAILUnderAnyOtherTagAsForeignKeepingItsText =
	property.explore(
		oneOf<readonly [ForeignFeature, string]>([
			(source) => {
				const tag = source.draw(element(foreignTags))
				return [`under ${tag}`, `${tag}${source.draw(foreignAfter(tag))}`] as const
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
		]),
		{
			needs: {},
			budget: { runs: 300, steered: 100 },
			situations: [
				...Arr.map(foreignTags, (tag): ForeignFeature => `under ${tag}`),
				"a concurrent change"
			] satisfies ReadonlyArray<Reached<ForeignFeature>>,
			check:
				(_, c: Case<ForeignFeature>) =>
				([feature, detail]) =>
					Effect.sync(() => {
						c.note(feature)
						assert.deepEqual(readLawDetail(detail), { kind: "foreign", detail })
					}),
			oracle: { kind: "specification", name: "a law's DETAIL is the one under its tag" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/runtime/write/refusal.ts",
					original: `\tif (!text.startsWith(\`\${keyTag}[\`)) {`,
					replacement: "\tif (!text.startsWith(keyTag)) {",
					why: "A DETAIL read as a law's under a bare `k`, not `k[` (runtime/write/refusal.ts readLawDetail); the foreign tags' specification fails."
				}
			]
		}
	)
