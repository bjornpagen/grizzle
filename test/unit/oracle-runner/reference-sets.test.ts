/**
 * The reference evaluator's sets hold values apart by their identities as values (test/support/oracle/reference/values.ts
 * distinctRows, memberIdentity): a float's -0 and +0 are two values of one class under native equality (c067533e8), so
 * a parameter relation's two facts that differ in a zero's sign alone are two rows wherever they are read whole, as
 * every lowering delivers them (lower/conservative/input-set factSetSelect), and a merge, which the IR reads through the
 * canonical zero (check/merge.ts), holds one row of each class.
 *
 * Oracle: the specification, scalar/values/identity.ts's: a read of a parameter relation delivers each of its facts,
 * and a merge takes +0, stated on the host over the drawn facts.
 *
 * Features: facts apart in a zero's sign alone read whole, and two zeros merged.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	evaluated,
	featuresOf,
	type SetFeature,
	setCases,
	specified
} from "#test/unit/oracle-runner/reference-sets.fixtures.ts"

/**
 * The reference evaluator delivers each fact of a parameter relation read whole, two facts apart in a zero's sign alone
 * among them, and one row of each class a merge through the canonical zero takes.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const theReferenceEvaluatorsSetsHoldTwoFactsApartInAZerosSignAloneAndAMergeThroughTheCanonicalZeroOneRow =
	property.explore(setCases, {
		needs: {},
		situations: [
			"facts apart in a zero's sign alone",
			"two zeros merged",
			"every column bound",
			"one column merged"
		] satisfies ReadonlyArray<SetFeature>,
		check: (_, c: Case<SetFeature>) => (drawn) =>
			Effect.sync(() => {
				c.noteAll(featuresOf(drawn))
				assert.deepEqual(evaluated(drawn), specified(drawn))
			}),
		oracle: {
			kind: "specification",
			name: "scalar/values/identity.ts: a read of a parameter relation delivers each of its facts, -0 and +0 at otherwise equal fields two rows, and a merge takes +0"
		},
		kept: [],
		kills: [
			{
				file: "test/support/oracle/reference/values.ts",
				original: "\tconst keys = decidedKeysBy(memberIdentity, rows, heading, at, identities)",
				replacement: "\tconst keys = decidedKeysBy(valueIdentity, rows, heading, at, identities)",
				why: "A set keys its rows under native equality, so a parameter relation's two facts that differ in a zero's sign alone are one row, the first, where every lowering delivers both."
			}
		]
	})
