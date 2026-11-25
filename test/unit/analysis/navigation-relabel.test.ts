/**
 * An equality of a known term with `Type.base(x)` binds x as one with x does (analysis/theory/navigate.ts `relabeled`):
 * the base of a domain's value is the same datum under its base type, which PostgreSQL's index matching reads through,
 * so the read that binds x is sought by it. qti-pie's LinearPresentations equates the after member's prior with the
 * base of the place of the member before it; read as no binding, the member's place stood at (child, stage) beside the
 * member's presentation, the tie went to the order the rule wrote its matches in, and the judge of a presentation read
 * every presentation of its sitting before probing the one place its key holds (metis's FASTMATH, 2026-11-25), until
 * qti-pie rewrote the rule in another order (cdc54580). A judge's reads are now one key lookup each whatever the order.
 *
 * Oracle: a specification, read off the navigated query: each step's relation and the columns it is sought by, against
 * the keys the theory holds of the relation.
 *
 * Features: the member's presentation written before its place and after it; the written row's matches written last.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	orderGen,
	type Reached,
	readAtKeys
} from "#test/unit/analysis/navigation-relabel.fixtures.ts"

/** In every order of its matches, each read of LinearPresentations' rule is a lookup at a key of its relation. */
export const aRelabeledEqualityBindsItsVariableSoEveryOrderOfTheMatchesReadsEachAtAKey =
	property.exhaust(finite(orderGen), {
		needs: {},
		situations: [
			"the member's presentation written before its place",
			"the member's place written before its presentation",
			"the written row's matches written last"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (order) => Effect.sync(() => readAtKeys(order, c.note)),
		oracle: {
			kind: "specification",
			name: "the navigated query: each step's relation and the columns it is sought by, against the theory's keys"
		},
		box: "the four matches of LinearPresentations' rule over Presented and Place, in each of their 24 orders, the after member's prior the base of the member's place",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\t\t\t\tconst v = relabeled(side)\n",
				replacement: "\t\t\t\t\t\tconst v = side\n",
				why: "An equality with Type.base(place) binds nothing, as before: where the rule writes the member's presentation before its place, the two tie at (child, stage), the written order wins, and the presentation is read at no key of it; the property fails."
			}
		]
	})
