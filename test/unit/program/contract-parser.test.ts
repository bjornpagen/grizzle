/**
 * A contract's checked mint over its checker file (runtime/contract.ts contractParserOver, the runtime entry's
 * contractParser), which loads no compiler: a value of its base is read as its base's type, then held to the file's
 * compiled type, the contract's predicate and its base's refinements, and minted under its key where both hold it, else
 * refused by the contract's refusal: ValueRefused by the codec's fault, DomainRefused outside its domain. Each case is a
 * value of one of two contracts, qti-pie's SittingKey over int8 under a predicate of its range, and a handle under a
 * pattern and a predicate of its own, drawn at every edge of each: int8's and the key's range's, the pattern's, the
 * predicate's and a text holding NUL; or a sitting key handed to SittingKey's parser over the checker file of another
 * description of SittingKey, under its name, which refuses every value as CheckerDrifted, never parsing it by another
 * contract's check. Each file is the one generate writes, as an import of it yields (contractCheck).
 *
 * The oracle is the contracts' own admission within a schema, a second compile: rowEvaluator's admission of a row
 * holding the value at a field of the contract (program/evaluate.ts admission), the schema's compile of the contract
 * against the file's. The parse mints exactly the value admission admits, the value itself, and refuses what it
 * refuses, by the same refusal at the contract; over a drifted file it refuses every value as drifted.
 *
 * Features: each contract's verdict, minted, refused by its type or refused by its domain, and the drifted file's.
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
	parseDrifted,
	parseHandle,
	parseSittingKey,
	Stages
} from "#test/unit/program/contract-parser.fixtures.ts"

type Situation =
	| `${"SittingKey" | "Handle"} ${"minted" | "refused by its type" | "refused by its domain"}`
	| "drifted refused as drifted"

/** A value's verdict, as the parse and the admission each state it: minted as the value, or refused at its contract. */
type Verdict =
	| { readonly verdict: "minted"; readonly value: bigint | string }
	| { readonly verdict: "ValueRefused"; readonly contract: string; readonly fault: CodecFault }
	| { readonly verdict: "DomainRefused"; readonly contract: string }
	| { readonly verdict: "CheckerDrifted"; readonly contract: string }

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
		case "CheckerDrifted":
			return { verdict: "CheckerDrifted", contract: refusal.contract }
	}
}

/** The parse's verdict on a case's value, by its contract's parser. */
const parsedVerdict = (k: ParseCase): Verdict => {
	switch (k.contract) {
		case "SittingKey":
			return verdictOf(parseSittingKey(k.value))
		case "Handle":
			return verdictOf(parseHandle(k.value))
		case "drifted":
			return verdictOf(parseDrifted(k.value))
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

/**
 * What a case's parse must answer: the admission's verdict on a row holding its value at its contract's field, or, over
 * the drifted file, the drifted refusal at SittingKey.
 */
const expectedVerdict = (k: ParseCase): Verdict => {
	switch (k.contract) {
		case "SittingKey":
			return admissionVerdict(k.contract, k.value, evaluator.admit(Stages, { stage: k.value }))
		case "Handle":
			return admissionVerdict(k.contract, k.value, evaluator.admit(Handles, { handle: k.value }))
		case "drifted":
			return { verdict: "CheckerDrifted", contract: "SittingKey" }
	}
}

/** The situation a case's verdict reaches. */
const situationOf = (k: ParseCase, verdict: Verdict): Situation => {
	if (k.contract === "drifted") {
		return "drifted refused as drifted"
	}
	switch (verdict.verdict) {
		case "minted":
			return `${k.contract} minted`
		case "ValueRefused":
			return `${k.contract} refused by its type`
		case "DomainRefused":
		case "CheckerDrifted":
			return `${k.contract} refused by its domain`
	}
}

/**
 * A contract's parser over its checker file mints exactly the values its contract's admission within a schema admits,
 * each as itself, and refuses every other by the admission's refusal, at the contract, by the codec's fault for one of
 * no value of its base; over the file of another description of the contract it refuses every value as drifted.
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
			"Handle refused by its domain",
			"drifted refused as drifted"
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
					"test/unit/program/contract-parser.test.ts#aContractsParserMintsExactlyWhatItsDomainAdmitsAndRefusesTheRestByTheContractsRefusal:7f.2:0.1.0.0"
				),
				reason:
					"a sitting key of -1n, an int8 outside qti-pie's SittingKey, which a step input of metis's essay binding decodes through the key's parser: refused by the contract's domain, never minted (the floor's first failure under the parse that skips the member check)",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/unit/program/contract-parser.test.ts#aContractsParserMintsExactlyWhatItsDomainAdmitsAndRefusesTheRestByTheContractsRefusal:7f.1:2.0.0.0"
				),
				reason:
					"a sitting key of 1n handed to SittingKey's parser over the checker file of another description of SittingKey: refused as drifted, never minted by the other description's check (the floor's first failure under the parser that skips the digest check)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/runtime/contract.ts",
				original:
					"\tconst held = file.contract === contract.name && described.ok && described.value === file.digest\n",
				replacement: "\tconst held = file.contract === contract.name\n",
				why: "The parser skips the digest check and parses by a file of another description of the contract under its name: a sitting key from 0 to 9 is minted and one above refused by the other description's check, where every value is refused as drifted."
			},
			{
				file: "packages/engine/src/runtime/contract.ts",
				original: "\t\treturn outsideDomain(judge, judged, () => read.value) === undefined\n",
				replacement: "\t\treturn true\n",
				why: "The parse skips the member check and mints every value of its base: a negative sitting key, a handle past four characters or outside its pattern, which the contract's domain refuses, is minted where admission refuses it."
			},
			{
				file: "packages/engine/src/runtime/contract.ts",
				original: "\t\tconst read = admitValue(spec, value)\n",
				replacement: "\t\tconst read = Result.ok(value)\n",
				why: "The parse reads no value as its base's type: a sitting key past int8's range is held to the predicate alone, refused by its domain where admission refuses it by its type, and a text holding NUL reaches the pattern."
			}
		]
	})
