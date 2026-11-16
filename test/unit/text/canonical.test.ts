/**
 * The IR's canonical text and order (scalar/regex/ir.ts canonicalText, compareCanonical). The canonical text is
 * JSON.stringify's text of the node's shape, its profiles left out, which a pattern's "ir:" key is and a snapshot's
 * domain digest is taken over, so it is written byte for byte as JSON.stringify writes the shape; the builder orders an
 * alternation's arms by that text while comparing it piece by piece, never writing it.
 *
 * - Text: each parsed pattern's canonical text is JSON.stringify's text of its shape.
 * - Order: every alternation's arms are in strictly ascending order of their canonical texts, none repeated.
 *
 * Oracle: a second implementation, JSON.stringify of the shape, and its texts sorted and deduplicated.
 *
 * Features: an alternation, and nested alternations.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { canonicalText } from "#compiler/scalar/regex/ir.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { assert } from "#test/support/assert.ts"
import {
	alternations,
	anyPattern,
	type Ordered,
	shapeOf
} from "#test/unit/text/canonical.fixtures.ts"
import { flagsGen } from "#test/unit/text/generators.ts"

/** The canonical text and order writes each parsed pattern's IR as JSON.stringify writes its shape, and orders every alternation's arms strictly by that text. */
export const theCanonicalTextAndOrderWritesEachParsedPatternsIRAsJSONStringifyWritesItsShapeAndOrdersEveryAlternationsArmsStrictlyByThatText =
	property.explore((source) => [source.draw(anyPattern), source.draw(flagsGen)] as const, {
		needs: {},
		situations: ["an alternation", "nested alternations"] satisfies ReadonlyArray<Reached<Ordered>>,
		check:
			(_, c: Case<Ordered>) =>
			([source, flags]) =>
				Effect.sync(() => {
					const parsed = parsePattern(source, flags)
					if (!parsed.ok) {
						return
					}
					assert.equal(
						canonicalText(parsed.value),
						jsonText(shapeOf(parsed.value)),
						`/${source}/${flags}`
					)
					const alts = alternations(parsed.value)
					if (alts.length > 0) {
						c.note("an alternation")
					}
					if (alts.length > 1) {
						c.note("nested alternations")
					}
					for (const alt of alts) {
						const texts = Arr.map(alt.arms, canonicalText)
						assert.deepEqual(
							texts,
							Arr.dedupe(Arr.sort(texts, Order.String)),
							`/${source}/${flags}`
						)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "JSON.stringify of the node's shape, its arms' texts sorted"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/regex/ir.ts",
				original:
					"\t\tconst compare = (a: LiveNode, b: LiveNode): number => compareCanonical(a, b, this.#pieces)",
				replacement:
					"\t\tconst compare = (a: LiveNode, b: LiveNode): number => compareCanonical(b, a, this.#pieces)",
				why: "The builder compares an alternation's arms in descending order; the order property fails."
			}
		]
	})
