import { dictionary } from "@bjornpagen/testing/dictionary"
import { plantings } from "#test/pg/substrate/transaction.fixtures.ts"
import { nonEmpty } from "#test/support/assert.ts"

/**
 * What a case may do that would outlive it on a committing session, and the commit that would end its transaction
 * (transaction.fixtures.ts plantings, by its record's keys): the form's own vocabulary, never cases a person chose.
 */
export const plantingWords = dictionary(
	nonEmpty(plantings, "what a case may leave past its transaction")
)
