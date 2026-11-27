import { toResult } from "#adapter/engine.ts"
import type { Contract, Facts, FieldBase } from "#compiler/plan/common.ts"
import { type ContractParser, contractFile, contractParserOver } from "#compiler/plan/runtime.ts"

/**
 * Public barrel: a consumer's contract's checked mint for a running application, which loads no compiler (engine
 * runtime/contract.ts): @bjornpagen/grizzle/runtime re-exports it.
 */

/**
 * contractParser(file, contract, key): the contract's checked mint over its checker file, the one parse of a value of
 * its base into its host type at a boundary, where mintOf(key) is the unchecked one. `file` is the JSON value of
 * `<migrations>/contract-checks/<name>.json`, which `grizzle generate` compiles for a configuration whose `contracts`
 * names the contract and `grizzle check` holds current, as an import of it yields (`with { type: "json" }`), read once
 * (engine served/json.ts contractFile) and refused, thrown, where it is no file generate writes, as served(...) refuses
 * a served file. Its `contract` is the contract, which a consumer storing what it parses types its column by, and
 * `parse(value)` a Result of the value under the key, or the contract's refusal (ContractRefused): ValueRefused by the
 * codec's fault, DomainRefused outside its predicate or its base's refinements, as PostgreSQL refuses each, and
 * CheckerDrifted for every value where the file is another contract's, compiled from another description of it. Its key
 * is the contract's own, which mintOf takes, so only its holder builds one, beside its mint: `export const
 * sittingKeyParser = contractParser(sittingKeyFile, SittingKey, sittingKeyKey)`.
 */
export const contractParser = <
	Name extends string,
	B extends FieldBase,
	K extends symbol,
	Proved extends ReadonlyArray<keyof Facts>
>(
	file: unknown,
	contract: Contract<Name, B, K, Proved>,
	key: NoInfer<K>
): ContractParser<Name, B, K, Proved> => {
	const read = contractFile(file)
	if (!read.ok) {
		throw read.error
	}
	return contractParserOver(read.value, contract, key, toResult)
}

export type { ContractParser } from "#compiler/plan/runtime.ts"
export type { ContractRefused } from "#compiler/plan/common.ts"
