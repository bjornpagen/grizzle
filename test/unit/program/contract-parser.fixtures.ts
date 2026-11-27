/** What contract-parser.test.ts reads: its contracts, their parsers, the schema its oracle admits rows of, its space. */

import { array, characterOf, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Result } from "effect"
import { contractParser } from "#adapter/public/contract.ts"
import { contractCheck, rowEvaluator } from "#adapter/public/host.ts"
import { Logic, Num, Text } from "#compiler/public/compute.ts"
import { relation } from "#compiler/public/dynamic.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

const sittingKeyKey = Symbol("SittingKey")
const handleKey = Symbol("Handle")

/**
 * A sitting's key as qti-pie declares it (its ledger's keys.ts SittingKey), the contract metis's essay binding reads a
 * sitting's stage by: any nonnegative bigint, its base int8.
 */
const SittingKey = contract<typeof sittingKeyKey>()("SittingKey", pg.bigint, (k) =>
	Num.within(k, 0n, 2n ** 63n - 1n)
)

/**
 * A handle: a text of one to eight lowercase letters, its base's pattern, and of at most four characters, its own
 * predicate, so a value is refused by either level of its domain.
 */
const Handle = contract<typeof handleKey>()("Handle", str.regex("^[a-z]{1,8}$"), (v) =>
	Logic.le(Text.charLength(v), 4)
)

const otherSittingKeyKey = Symbol("SittingKey")

/** Another description of a sitting key, under the same name: any int8 from 0 to 9, whose checker file is its own. */
const OtherSittingKey = contract<typeof otherSittingKeyKey>()("SittingKey", pg.bigint, (k) =>
	Num.within(k, 0n, 9n)
)

/**
 * Each contract's checked mint over its checker file, as generate writes it and an import of it yields
 * (contractCheck), built by its key's holder with no compiler, as qti-pie builds SittingKey's beside its mint.
 */
export const parseSittingKey = contractParser(
	Result.getOrThrow(contractCheck(SittingKey)),
	SittingKey,
	sittingKeyKey
).parse
export const parseHandle = contractParser(
	Result.getOrThrow(contractCheck(Handle)),
	Handle,
	handleKey
).parse

/** SittingKey's mint over the checker file of the other description of it, a file that drifted from the contract. */
export const parseDrifted = contractParser(
	Result.getOrThrow(contractCheck(OtherSittingKey)),
	SittingKey,
	sittingKeyKey
).parse

/**
 * The relations the oracle admits a row of each value in, by the dynamic door, whose rows are records of any value, so a
 * case states a value its contract refuses, which no row of a typed relation holds.
 */
export const Stages = relation("Stages", { stage: SittingKey }, ["stage"])
export const Handles = relation("Handles", { handle: Handle }, ["handle"])

/** The oracle: rowEvaluator's admission of a row, which holds each field to its type and its domain within a schema. */
export const evaluator = Result.getOrThrow(rowEvaluator(schema("Parsed", [Stages, Handles], [])))

/**
 * A case: a value of one contract's base, as a caller hands it to the contract's parser; or a sitting key handed to
 * SittingKey's parser over the checker file of another description of it (`drifted`).
 */
export type ParseCase =
	| { readonly contract: "SittingKey"; readonly value: bigint }
	| { readonly contract: "Handle"; readonly value: string }
	| { readonly contract: "drifted"; readonly value: bigint }

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

/** A case of either contract, or of SittingKey's parser over a drifted file. */
export const parseCaseGen: Gen<ParseCase> = (source) => {
	switch (source.draw(int(0, 2))) {
		case 0:
			return { contract: "SittingKey", value: source.draw(bigintGen) }
		case 1:
			return { contract: "Handle", value: source.draw(textGen) }
		default:
			return { contract: "drifted", value: source.draw(bigintGen) }
	}
}
