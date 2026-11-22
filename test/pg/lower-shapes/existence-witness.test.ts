/**
 * An existence test reads its right side per left row where that side is more than a scan of one source and its join
 * columns restrict every relation it reads (lower/conservative/semi-join/exists.ts): a step correlated inside it, the
 * side's rows at the left row with the join's equalities inside the step, read apart by the one printer of a step
 * (lower/conservative/step fencedRead, OFFSET 0), a subplan PostgreSQL never pulls up, so a test reads the right side's
 * relations at the left side's keys alone, never the whole of them. In a bare NOT EXISTS, a fold stays a grouped derived
 * table PostgreSQL never restricts by the test's keys, so it folds every group the store holds for each read
 * (rule-aggregate's probe of a GROUP BY of Attempt, 980 rows read where 2 were expected); and a right side of several
 * sources is pulled up into the anti-join, whose parameterizations of every subset of its relations PostgreSQL plans
 * (edullm's ledger grade write: 17 s for one test, past 8.5 minutes for the statement).
 *
 * On PostgreSQL 19, over a store of 2,000 to 4,000 keys of one to four facts each, two to six asked keys: the asked keys
 * no fact of the right side matches, the right side a join of two stores by the key, a fold by the key, or a fold whose
 * count the test binds, with statistics or none.
 *
 * Oracle: the host's keys, and a bound: the read's scans of the store read at most the facts at the asked keys, and one
 * more for each witness's probe of a key it does not hold, where the right side is read per left row; and the whole fold
 * once, never once per asked key, where the test binds the fold's count, which restricts no relation it reads.
 *
 * Features: each shape; statistics read.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	existenceWitnessTemplate,
	runWitness,
	type WitnessFeature,
	witnessGen
} from "#test/pg/lower-shapes/existence-witness.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A read that tests a join or a fold by the test's keys reads the store at the asked keys alone, whatever the store
 * holds beside them.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aReadThatTestsAJoinOrAFoldByTheTestsKeysReadsTheStoreAtTheAskedKeysAloneWhateverTheStoreHoldsBesideThem =
	property.explore(witnessGen, {
		needs: { stored: Substrate.rolledBack(existenceWitnessTemplate) },
		situations: [
			"the join by the key",
			"the fold by the key",
			"the fold by its count",
			"statistics read"
		] satisfies ReadonlyArray<WitnessFeature>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.flatMap(stored, ({ connection, value }) => runWitness(value, connection, drawn, c)),
		oracle: {
			kind: "universal",
			name: "the host's asked keys the right side does not match, and bound: the read's scans of the store read at most the facts at the asked keys where the right side is read per left row, and the whole fold once where its count is bound"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/semi-join/exists.ts",
				original: '\tcostClass(node.right) !== "scan" &&\n',
				replacement: "\tfalse &&\n",
				why: "Every right side stays in a bare NOT EXISTS, as before: the fold by the key is a grouped derived table PostgreSQL never restricts by the test's keys, so the read folds every key the store holds, past the bound."
			}
		]
	})
