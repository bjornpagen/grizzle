/**
 * A ChangeSet's bound values are keyed by their canonical tokens (core/canonical.ts canonicalTokens), never by one
 * canonical text (write/changeset/value.ts boundKey): two ChangeSets that bind one name to equal values combine into
 * one private parameter, and to different values into two, named in the order of the values' canonical texts, whatever
 * order the union takes them in. A bound relation input whose texts sum past the longest string V8 holds
 * (maxStringLength) is keyed as any other, where its text was once refused and the value left unkeyed, so two equal
 * ones stayed two parameters.
 *
 * The box: a relation input of seven notes, each a body of a's, the last ending in a or b, at a length of 4 and at
 * the least length whose seven bodies sum past the longest string (maxStringLength); bound in two ChangeSets to equal
 * values or to the a- and the b-ending ones, combined by union in either order. The oracle is the specification: equal
 * values are one binding; different ones are two, and the Description's bindings, read in their order, hold the
 * a-ending value first, its canonical text the lesser. The private names themselves are the ChangeSet's own, never
 * spelled here.
 *
 * Features: past the longest string, equal values, different values, either order.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { maxStringLength } from "#compiler/core/canonical.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	type BoundCase,
	type BoundFeature,
	count,
	inserted,
	lastLetter,
	lengths,
	notesOf
} from "#test/unit/write/changeset/bound-identity.fixtures.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"

/** A ChangeSet's bound values are one parameter when equal and two named in their canonical texts' order otherwise, past the longest string too. */
export const aChangeSetsBoundValuesAreOneParameterWhenEqualAndTwoNamedInTheirCanonicalTextsOrderOtherwisePastTheLongestStringToo =
	property.exhaust(
		finite((source): BoundCase => ({
			length: source.draw(element(lengths)),
			values: source.draw(element(["equal", "different"] as const)),
			order: source.draw(element(["a-ending first", "b-ending first"] as const))
		})),
		{
			needs: {},
			situations: [
				"past the longest string",
				"equal values",
				"different values",
				"either order"
			] satisfies ReadonlyArray<Reached<BoundFeature>>,
			check: (_, c: Case<BoundFeature>) => (box) =>
				Effect.sync(() => {
					const shared = Str.repeat(box.length)("a")
					if (count * box.length > maxStringLength) {
						c.note("past the longest string")
					}
					const lesser = notesOf(shared, "a")
					const greater = box.values === "equal" ? notesOf(shared, "a") : notesOf(shared, "b")
					const [first, second] =
						box.order === "a-ending first" ? [lesser, greater] : [greater, lesser]
					if (box.order === "b-ending first") {
						c.note("either order")
					}
					const combined = ChangeSet.union(
						inserted().bind({ notes: first }),
						inserted().bind({ notes: second })
					)
					const values = parsedOf(combined).values
					const bound = Arr.map(descOf(combined).bindings, (name) => lastLetter(values.get(name)))
					if (box.values === "equal") {
						c.note("equal values")
						assert.deepEqual(bound, ["a"], "equal values are one parameter")
						return
					}
					c.note("different values")
					assert.deepEqual(
						bound,
						["a", "b"],
						"different values are two parameters, the lesser text's first"
					)
				}),
			oracle: {
				kind: "specification",
				name: "bound values are one parameter when equal, and otherwise named in their canonical texts' order"
			},
			box: "seven notes at a body length of 4 and at the least whose seven bodies pass the longest string, bound to equal or different values, combined in either order",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/changeset/value.ts",
					original: "\t\t\t? compareCanonicalTokens(a.key.tokens, b.key.tokens)",
					replacement: "\t\t\t? compareCanonicalTokens(b.key.tokens, a.key.tokens)",
					why: "Private parameters named against their canonical texts' order (write/changeset/value.ts boundOrder)."
				}
			]
		}
	)
