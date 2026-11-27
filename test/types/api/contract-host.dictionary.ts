import { dictionary } from "@bjornpagen/testing/dictionary"
import {
	contractHostBoxItems,
	contractKeyBoxItems,
	contractMintBoxItems,
	contractValueBoxItems
} from "#test/types/api/contract-host.ts"

/** The host box: every kind of base a contract is over. */
export const contractHostBox = dictionary(contractHostBoxItems)

/** The value box: every position a value stands at opposite a contract's term, by every kind of value. */
export const contractValueBox = dictionary(contractValueBoxItems)

/** The key box: every kind of key at a contract and at mintOf. */
export const contractKeyBox = dictionary(contractKeyBoxItems)

/**
 * The mint box: every position the database makes a value at, by every target and key, every clock parameter, and every
 * declared function's result shape.
 */
export const contractMintBox = dictionary(contractMintBoxItems)
