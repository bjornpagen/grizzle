/**
 * The borrow rules (analysis/isolation/borrows.ts memberBorrows) over drawn members: one member of one or two
 * statements, each reading up to two of L, M and F, positively, negated, counted or as an arbitration, its fields k and
 * n bound to the call's parameters :k or :n, to a column no binding names, or to nothing, and writing one of them by an
 * insert, an update or a delete, its rows joined with its statement's first read or not; L and M sit in the unit
 * Learner at k or in no unit, F in none; and each relation's grants are none, SELECT and INSERT, or every privilege.
 *
 * Oracle: the rules restated over the drawn shape (borrows.fixtures.ts expectedOf), apart from the code: exactly its
 * faults, by statement, relation and kind, and exactly its borrows, Learner's at the strongest mode its sites need,
 * locking each key its sites bind once. memberBorrows is total: every site is a borrow, needs none, or is a fault.
 *
 * Features: a unit written under its exclusive borrow and at no key, a held positive and a held absence read, a unit
 * read at no key, a change outside every unit, an insert into a relation a role changes, a read of a relation no role
 * writes, a read of a relation a role changes, an arbitration a unique check decides, an absence outside every unit, an
 * immutable fact, an unborrowed read, and each of the gate's three faults.
 */

import { assert } from "@bjornpagen/testing/assert"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { memberBorrows } from "#compiler/analysis/isolation/borrows.ts"
import {
	type BorrowFeature,
	borrowKey,
	type Drawn,
	drawnGen,
	expectedOf,
	faultKey,
	gateGen,
	installationOf,
	memberOf,
	sourceOf
} from "#test/unit/analysis/isolation/borrows.fixtures.ts"

/** A member's borrows and faults are exactly the borrow rules' over its facts and the installation's. */
export const aMembersBorrowsAndFaultsAreExactlyTheBorrowRulesOverItsFactsAndTheInstallations =
	property.explore(
		aimed(drawnGen, [["a write not joined with a fact its statement reads", gateGen]]),
		{
			needs: {},
			situations: [
				"a unit written under its exclusive borrow",
				"a unit written at no key",
				"a held positive read",
				"a held absence read",
				"a unit read at no key",
				"a change outside every unit",
				"an insert into a relation a role changes",
				"a read of a relation no role writes",
				"a read of a relation a role changes",
				"an arbitration a unique check decides",
				"an absence outside every unit",
				"an immutable fact",
				"an unborrowed read",
				"a write not joined with a fact its statement reads",
				"a write after a fact, joined with no held row",
				"a write before a fact read only later"
			] satisfies ReadonlyArray<BorrowFeature>,
			check: (_, c: Case<BorrowFeature>) => (drawn: Drawn) =>
				Effect.sync(() => {
					const expected = expectedOf(drawn)
					for (const f of expected.features) {
						c.note(f)
					}
					const proof = memberBorrows(memberOf(drawn), installationOf(drawn), sourceOf)
					assert.deepEqual(
						Arr.sort(Arr.dedupe(Arr.map(proof.faults, faultKey)), Order.String),
						Arr.sort([...expected.faults], Order.String),
						"the member's faults"
					)
					assert.deepEqual(
						Arr.map(proof.borrows, borrowKey),
						[...expected.borrows],
						"the member's borrows"
					)
				}),
			oracle: {
				kind: "specification",
				name: "the borrow rules restated over the drawn member: its faults by statement, relation and kind, and its borrows"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/isolation/borrows.ts",
					original: '\t\t\t\ttake(place.unit, "exclusive", key)\n',
					replacement: '\t\t\t\ttake(place.unit, "shared", key)\n',
					why: "A unit a member writes borrowed shared, as a read alone needs: two writers of one learner run at once."
				},
				{
					file: "packages/engine/src/analysis/isolation/borrows.ts",
					original:
						'\t\t} else if (p.mode === "negated" || p.mode === "counted" || p.mode === "arbiter") {\n',
					replacement: "\t\t} else if (false) {\n",
					why: "An absence outside every unit read as unborrowed and so the same fault, never the absence the help names; and a negated read of a whole key of an inserted relation read as an immutable fact."
				}
			]
		}
	)
