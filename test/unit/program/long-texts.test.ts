/**
 * A write's decode and its binding key no native Map or Set by a text V8 hashes by its length alone (kernel/long-keys.ts
 * longestHashedText): every set a write keeps by a fact's texts is a TextsMap (core/text.ts), which hashes a list by
 * its digest, so a family of distinct texts of one length past it, which a native Map would hold in one chain, each
 * lookup comparing its key with every text of the chain, costs a write its texts' units once.
 *
 * The schema: Doc(id, title, lines drawn) with the ordered family of Line(doc, at, body), each title and body a text of
 * letters and digits. A case draws a family of one to four texts of one length past the hashed length, and one to three
 * docs, each titled by one of them and nesting up to three lines of them. The oracle is the rule: no native keying by
 * such a text, counted (kernel/long-keys.ts lengthHashedKeyings), and the preview's rows the case's facts.
 *
 * Features: a family of one text, of several; a doc holding lines.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { factsDecoder, insertPreview } from "#adapter/public/host.ts"
import { lengthHashedKeyings } from "#test/support/kernel/long-keys.ts"
import {
	factsOf,
	LongTexts,
	type LongTextsCase,
	longTextsCase
} from "#test/unit/program/long-texts.fixtures.ts"

type Situation = "a family of one text" | "a family of several texts" | "a doc holding lines"

const decoder = Result.getOrThrow(factsDecoder(LongTexts))
const preview = Result.getOrThrow(insertPreview(LongTexts))

/**
 * A write of texts past V8's hashed length is decoded and bound keying no native Map or Set by one: over the cases'
 * docs and lines, decoding their facts (factsDecoder) then previewing their insert (insertPreview), the write's own
 * decode and binding with no SQL, keys a native Map or Set by a text past 16,383 units no time
 * (kernel/long-keys.ts lengthHashedKeyings), and the preview's rows are the case's docs and lines, each once.
 */
export const aWritesDecodeAndBindingKeyNoNativeMapByATextV8HashesByItsLength = property.explore(
	longTextsCase,
	{
		needs: {},
		budget: { runs: 40, steered: 40 },
		situations: [
			"a family of one text",
			"a family of several texts",
			"a doc holding lines"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (k: LongTextsCase) =>
			Effect.gen(function* () {
				c.note(k.family.length === 1 ? "a family of one text" : "a family of several texts")
				if (Arr.some(k.docs, (doc) => doc.lines.length > 0)) {
					c.note("a doc holding lines")
				}
				const facts = factsOf(k)
				const [bound, keyings] = yield* lengthHashedKeyings(
					Effect.sync(() =>
						Result.flatMap(decoder.decode("Doc", facts.Doc), (docs) => preview({ Doc: docs }))
					)
				)
				assert.equal(keyings, 0, "no native Map or Set keyed by a text past the hashed length")
				const rows = Result.getOrThrow(bound)
				assert.equal(rows.Doc.length, k.docs.length, "each doc once")
				assert.equal(
					rows.Line.length,
					Arr.reduce(k.docs, 0, (n, doc) => n + doc.lines.length),
					"each line once"
				)
			}),
		oracle: {
			kind: "specification",
			name: "no native keying by a text V8 hashes by its length, and the write's rows its facts"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original: "\treturn mintTextsId({ texts, digest: digest >> 1, belowSurrogates })",
				replacement:
					'\treturn mintTextsId({ texts, digest: texts.join("\\u0000"), belowSurrogates })',
				why: "A TextsMap keys its buckets by the identity's texts joined, a native Map of strings, as TextsKey keyed every set of facts before IDKEY: a fact's texts past the hashed length key it, so a family of them is one chain."
			}
		]
	}
)
