/** What contract-parser.test.ts reads: its contracts, their parsers, the schema its oracle admits rows of, its space. */

import { array, characterOf, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Result } from "effect"
import { domainParser } from "#adapter/public/domain.ts"
import { rowEvaluator } from "#adapter/public/host.ts"
import { Logic, Num, Text } from "#compiler/public/compute.ts"
import { relation } from "#compiler/public/dynamic.ts"
import { domain, int8 } from "#compiler/public/fields.ts"
import { schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

const sittingKeyKey = Symbol("SittingKey")
const handleKey = Symbol("Handle")

/**
 * A sitting's key as qti-pie declares it (its ledger's keys.ts SittingKey), the contract metis's essay binding reads a
 * sitting's stage by: any nonnegative bigint, its base int8.
 */
const SittingKey = domain<typeof sittingKeyKey>()("SittingKey", int8, (k) =>
	Num.within(k, 0n, 2n ** 63n - 1n)
)

/**
 * A handle: a text of one to eight lowercase letters, its base's pattern, and of at most four characters, its own
 * predicate, so a value is refused by either level of its domain.
 */
const Handle = domain<typeof handleKey>()("Handle", str.regex("^[a-z]{1,8}$"), (v) =>
	Logic.le(Text.charLength(v), 4)
)

/**
 * Each contract's checked mint, its checker derived from the contract where it is built, by its key's holder, as
 * qti-pie builds SittingKey's beside its mint.
 */
export const parseSittingKey = domainParser(SittingKey, sittingKeyKey).parse
export const parseHandle = domainParser(Handle, handleKey).parse

/**
 * The relations the oracle admits a row of each value in, by the dynamic door, whose rows are records of any value, so a
 * case states a value its contract refuses, which no row of a typed relation holds.
 */
export const Stages = relation("Stages", { stage: SittingKey }, ["stage"])
export const Handles = relation("Handles", { handle: Handle }, ["handle"])

/** The oracle: rowEvaluator's admission of a row, which holds each field to its type and its domain within a schema. */
export const evaluator = Result.getOrThrow(rowEvaluator(schema("Parsed", [Stages, Handles], [])))

/** A case: a value of one contract's base, as a caller hands it to the contract's parser. */
export type ParseCase =
	| { readonly contract: "SittingKey"; readonly value: bigint }
	| { readonly contract: "Handle"; readonly value: string }

/**
 * A bigint at a power of two, by sign, exponent and a step of at most two either side: zero and one, every edge of int8
 * (2^63 - 1, -2^63 and one past each) and of the key's own range (0 and -1), and values far past int8 either way.
 */
const bigintGen: Gen<bigint> = (source) => {
	const negative = source.draw(int(0, 1)) === 1
	const exponent = source.draw(int(0, 65))
	const step = source.draw(int(-2, 2))
	return (negative ? -1n : 1n) * 2n ** BigInt(exponent) + BigInt(step)
}

/**
 * A text of up to ten characters of lowercase letters, an uppercase one and NUL: inside the handle's pattern and
 * predicate, past its predicate's four characters, outside its pattern, empty, and holding NUL, which text's input
 * function refuses before any domain reads it.
 */
const textGen: Gen<string> = (source) =>
	Arr.join(source.draw(array(characterOf(["a", "b", "Z", "\u0000"]), { min: 0, max: 10 })), "")

/** A case of either contract. */
export const parseCaseGen: Gen<ParseCase> = (source) =>
	source.draw(int(0, 1)) === 0
		? { contract: "SittingKey", value: source.draw(bigintGen) }
		: { contract: "Handle", value: source.draw(textGen) }
