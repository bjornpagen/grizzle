/**
 * Structural identity (ir/identical.ts) against the equality of canonical text, the oracle it replaces: over a drawn
 * value and a one-leaf edit of it, both decoded, the two agree. An edit replaces one string, number, bigint or boolean
 * anywhere in the value, or drops one key, so a field the structural comparison misses is an edit it calls identical
 * while the canonical texts differ. A canonical value is edited inside too, rebuilt through its own constructor: a
 * roster's name or one of its handles, replaced or dropped, and one digit of a decimal, so a canonical form that misses
 * a part its structural comparison reads, or the reverse, is a disagreement as well.
 *
 * Oracle: a second implementation, canonical text equality (core/canonical.ts canonicalEquals).
 *
 * Features: types and tables identical and different, an edit the decoder refuses, a roster and a decimal edited
 * inside.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import { identicalExprTable, identicalScalarType } from "#compiler/ir/identical.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { assert } from "#test/support/assert.ts"
import {
	decodedPair,
	decodeTable,
	enteredAt,
	type Feature,
	tablePopulation,
	typePopulation
} from "#test/unit/ir/identical.fixtures.ts"

/** Structural identity agrees with canonical text equality over every one-leaf edit of a decoded type or expression table. */
export const structuralIdentityAgreesWithCanonicalTextEqualityOverEveryOneLeafEditOfADecodedTypeOrExpressionTable =
	property.explore(oneOf([typePopulation, tablePopulation]), {
		needs: {},
		situations: [
			"types identical",
			"types different",
			"tables identical",
			"tables different",
			"an edit refused",
			"a roster edited inside",
			"a decimal edited inside"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, n: Case<Feature>) => (c) =>
			Effect.sync(() => {
				const entered = c.edit === undefined ? undefined : enteredAt(c.value, c.edit.path)
				if (entered !== undefined) {
					n.note(entered)
				}
				if (c.kind === "type") {
					const pair = decodedPair(decodeScalarType, c)
					if (pair === undefined) {
						n.note("an edit refused")
						return
					}
					const canonical = canonicalEquals(pair[0], pair[1], everyProperty)
					n.note(canonical ? "types identical" : "types different")
					assert.equal(identicalScalarType(pair[0], pair[1]), canonical)
					return
				}
				const pair = decodedPair(decodeTable, c)
				if (pair === undefined) {
					n.note("an edit refused")
					return
				}
				const canonical = canonicalEquals(pair[0], pair[1], everyProperty)
				n.note(canonical ? "tables identical" : "tables different")
				assert.equal(identicalExprTable(pair[0], pair[1]), canonical)
			}),
		oracle: { kind: "second-implementation", name: "canonical text equality" },
		kept: [],
		kills: []
	})
