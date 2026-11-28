/**
 * A contract's checked mint (contract/parser.ts contractParserOf, the contract entry's contractParser), its checker
 * derived from the contract where the parser is built: a value of its base is read as its base's type, then held to the
 * contract's type as a schema's compile types it, its predicate and its base's refinements, and minted under its key
 * where both hold it, else refused by the contract's refusal: ValueRefused by the codec's fault, DomainRefused outside
 * its domain. Each case is a value of one of two contracts, qti-pie's SittingKey over int8 under a predicate of its
 * range, and a handle under a pattern and a predicate of its own, drawn at every edge of each: int8's and the key's
 * range's, the pattern's, the predicate's and a text holding NUL.
 *
 * The oracle is the contracts' own admission within a schema, a second compile: rowEvaluator's admission of a row
 * holding the value at a field of the contract (program/evaluate.ts admission). The parse mints exactly the value
 * admission admits, the value itself, and refuses what it refuses, by the same refusal at the contract.
 *
 * Features: each contract's verdict, minted, refused by its type or refused by its domain.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import type { CodecFault } from "#compiler/core/errors.ts"
import type { ContractRefused } from "#compiler/types/schema/evaluation.ts"
import {
	evaluator,
	Handles,
	parseCaseGen,
	type ParseCase,
	parseHandle,
	parseSittingKey,
	Stages
} from "#test/unit/program/contract-parser.fixtures.ts"

type Situation =
	`${"SittingKey" | "Handle"} ${"minted" | "refused by its type" | "refused by its domain"}`

/** A value's verdict, as the parse and the admission each state it: minted as the value, or refused at its contract. */
type Verdict =
	| { readonly verdict: "minted"; readonly value: bigint | string }
	| { readonly verdict: "ValueRefused"; readonly contract: string; readonly fault: CodecFault }
	| { readonly verdict: "DomainRefused"; readonly contract: string }

/** A parse's verdict: the value it minted, or its refusal at its contract. */
const verdictOf = <N extends string>(
	parsed: Result.Result<bigint | string, ContractRefused<N>>
): Verdict => {
	if (Result.isSuccess(parsed)) {
		return { verdict: "minted", value: parsed.success }
	}
	const refusal = parsed.failure
	switch (refusal._tag) {
		case "ValueRefused":
			return { verdict: "ValueRefused", contract: refusal.contract, fault: refusal.fault }
		case "DomainRefused":
			return { verdict: "DomainRefused", contract: refusal.contract }
	}
}

/** The parse's verdict on a case's value, by its contract's parser. */
const parsedVerdict = (k: ParseCase): Verdict => {
	switch (k.contract) {
		case "SittingKey":
			return verdictOf(parseSittingKey(k.value))
		case "Handle":
			return verdictOf(parseHandle(k.value))
	}
}

/** An admission's verdict on a row holding a value at its contract's field, the value itself where admitted. */
const admissionVerdict = (
	contract: string,
	value: bigint | string,
	admitted: ReturnType<typeof evaluator.admit>
): Verdict => {
	if (Result.isSuccess(admitted)) {
		return { verdict: "minted", value }
	}
	const refusal = admitted.failure
	return refusal._tag === "ValueRefused"
		? { verdict: "ValueRefused", contract, fault: refusal.fault }
		: { verdict: "DomainRefused", contract }
}

/** What a case's parse must answer: the admission's verdict on a row holding its value at its contract's field. */
const expectedVerdict = (k: ParseCase): Verdict => {
	switch (k.contract) {
		case "SittingKey":
			return admissionVerdict(k.contract, k.value, evaluator.admit(Stages, { stage: k.value }))
		case "Handle":
			return admissionVerdict(k.contract, k.value, evaluator.admit(Handles, { handle: k.value }))
	}
}

/** The situation a case's verdict reaches. */
const situationOf = (k: ParseCase, verdict: Verdict): Situation => {
	switch (verdict.verdict) {
		case "minted":
			return `${k.contract} minted`
		case "ValueRefused":
			return `${k.contract} refused by its type`
		case "DomainRefused":
			return `${k.contract} refused by its domain`
	}
}

/**
 * A contract's parser mints exactly the values its contract's admission within a schema admits, each as itself, and
 * refuses every other by the admission's refusal, at the contract, by the codec's fault for one of no value of its base.
 */
export const aContractsParserMintsExactlyWhatItsDomainAdmitsAndRefusesTheRestByTheContractsRefusal =
	property.explore(parseCaseGen, {
		needs: {},
		situations: [
			"SittingKey minted",
			"SittingKey refused by its type",
			"SittingKey refused by its domain",
			"Handle minted",
			"Handle refused by its type",
			"Handle refused by its domain"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (k: ParseCase) =>
			Effect.sync(() => {
				const expected = expectedVerdict(k)
				assert.deepEqual(parsedVerdict(k), expected, `${k.contract} ${String(k.value)}`)
				c.note(situationOf(k, expected))
			}),
		oracle: {
			kind: "second-implementation",
			name: "rowEvaluator's admission of a row holding the value at a field of the contract, the schema's compile of it"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/program/contract-parser.test.ts#aContractsParserMintsExactlyWhatItsDomainAdmitsAndRefusesTheRestByTheContractsRefusal:-:0.1.0.0"
				),
				reason:
					"a sitting key of -1n, an int8 outside qti-pie's SittingKey, which a step input of metis's essay binding decodes through the key's parser: refused by the contract's domain, never minted (the floor's first failure under the parse that skips the member check)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/contract/parser.ts",
				original: "\tconst type = typed.value\n",
				replacement: "\tconst type = described.scalar\n",
				why: "The checker is the type the builder read the contract as, outside any schema, which holds no predicate table: a negative sitting key and a handle past four characters, which the contract's predicate refuses, are minted where admission refuses them."
			},
			{
				file: "packages/engine/src/contract/parser.ts",
				original: "\t\treturn outsideDomain(judge, judged, () => read.value) === undefined\n",
				replacement: "\t\treturn true\n",
				why: "The parse skips the member check and mints every value of its base: a negative sitting key, a handle past four characters or outside its pattern, which the contract's domain refuses, is minted where admission refuses it."
			},
			{
				file: "packages/engine/src/contract/parser.ts",
				original: "\t\tconst read = admitValue(spec, value)\n",
				replacement: "\t\tconst read = Result.ok(value)\n",
				why: "The parse reads no value as its base's type: a sitting key past int8's range is held to the predicate alone, refused by its domain where admission refuses it by its type, and a text holding NUL reaches the pattern."
			}
		]
	})
