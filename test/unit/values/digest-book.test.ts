/**
 * The digest book of one write (scalar/values/bytes.ts DigestBook) against SHA-256 collisions, which no search can
 * find: values are forged with digests the case chooses, so two values of different bytes share one digest as often as
 * the case asks. The book holds a value exactly when no value of its digest came before it or the one that did holds
 * the same bytes, so within one write a digest is one value, and a collision is refused before any fact is taken as
 * another.
 *
 * Oracle: a model of the book, a map from each digest to the first bytes admitted under it.
 *
 * Features: a first value of its digest, the same bytes again, the same array again, and different bytes of one digest.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { DigestBook, sameBytes } from "#compiler/scalar/values/bytes.ts"
import { admission, type Feature, Forged } from "#test/unit/values/digest-book.fixtures.ts"

/** A write's digest book holds a value exactly when its digest names no other bytes before it. Its budget is its suite's before it was a property (test/unit/values/digest-book.test.ts at 4ca3036a): 200 runs and 24 steered cases. */
export const aWritesDigestBookHoldsAValueExactlyWhenItsDigestNamesNoOtherBytesBeforeIt =
	property.explore(array(admission, { min: 1, max: 12 }), {
		needs: {},
		budget: { runs: 200, steered: 24 },
		situations: [
			"a first value of its digest",
			"the same bytes again",
			"the same array again",
			"different bytes of one digest"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (admissions) =>
			Effect.sync(() => {
				const book = new DigestBook()
				const model = new Map<string, Uint8Array<ArrayBuffer>>()
				const arrays: Array<Uint8Array<ArrayBuffer>> = []
				for (const a of admissions) {
					const fresh = Uint8Array.from(a.bytes)
					const reused = a.reuse
						? Option.getOrUndefined(Arr.findFirst(arrays, (x) => sameBytes(x, fresh)))
						: undefined
					const bytes = reused ?? fresh
					arrays.push(bytes)
					const first = model.get(a.digest)
					if (first === undefined) {
						c.note("a first value of its digest")
						model.set(a.digest, bytes)
					} else if (first === bytes) {
						c.note("the same array again")
					} else {
						c.note(
							sameBytes(first, bytes) ? "the same bytes again" : "different bytes of one digest"
						)
					}
					assert.equal(
						book.holds(new Forged(bytes, a.digest)),
						first === undefined || sameBytes(first, bytes),
						`the book holds ${Formatter.format(a)} as the model does`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "a map from each digest to its first bytes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/bytes.ts",
				original: "\t\treturn held === value.bytes || sameBytes(held, value.bytes)",
				replacement: "\t\treturn true",
				why: "The book holds a value whenever its digest was seen, whatever its bytes, so a collision is taken as the value before it; the book's property fails."
			}
		]
	})
