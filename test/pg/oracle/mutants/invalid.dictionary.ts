import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr, Record as Rec, Result } from "effect"
import { invalidId, type KillSearch } from "#test/pg/oracle/mutants/invalid.fixtures.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { mutants } from "#test/support/oracle/mutants/mutants.ts"

/**
 * The kill searches the oracle runner must win, by the mutant roster (mutants.ts): every invalid mutant's population
 * against the conservative lowering, in the roster's order, then the I1 mutant's against the reference evaluator. The
 * roster is the domain, never cases a person chose.
 */
export const killSearches = dictionary(
	nonEmpty<KillSearch>(
		[
			...Arr.filterMap(Rec.values(mutants), (m) =>
				Result.map(invalidId(m.id), (id): KillSearch => ({ judge: "conservative", id }))
			),
			{ judge: "reference", id: "I1" }
		],
		"the kill searches of the mutant roster"
	)
)
