import { toResult } from "#adapter/engine.ts"
import {
	type Contract,
	type ContractParser,
	contractParserOf,
	type Facts,
	type FieldBase
} from "#compiler/plan/contract.ts"

/**
 * Public barrel: a consumer's contract's checked mint (engine contract/parser.ts), which the contract entry
 * @bjornpagen/grizzle/contract re-exports, apart from the runtime entry, so a process that serves a login and parses no
 * contract's values loads none of the text analysis and the predicate lowering a checker is derived by.
 */

/**
 * contractParser(contract, key): the contract's checked mint, the one parse of a value of its base into its host type at
 * a boundary, where mintOf(key) is the unchecked one. Its checker is derived from the contract itself where the parser
 * is built (engine contract/parser.ts contractParserOf): no file holds it, so a module that builds a parser, and a
 * configuration whose modules import that module, read nothing `grizzle generate` writes. A contract whose predicate
 * does not type is refused, thrown, as its schema's compile refuses it. Its `contract` is the contract, which a consumer
 * storing what it parses types its column by, and `parse(value)` a Result of the value under the key, or the contract's
 * refusal (ContractRefused): ValueRefused by the codec's fault, DomainRefused outside its predicate or its base's
 * refinements, as PostgreSQL refuses each. Its key is the contract's own, which mintOf takes, so only its holder builds
 * one, beside its mint: `export const sittingKeyParser = contractParser(SittingKey, sittingKeyKey)`.
 */
export const contractParser = <
	Name extends string,
	B extends FieldBase,
	K extends symbol,
	Proved extends ReadonlyArray<keyof Facts>
>(
	contract: Contract<Name, B, K, Proved>,
	key: NoInfer<K>
): ContractParser<Name, B, K, Proved> => contractParserOf(contract, key, toResult)

export type { ContractParser, ContractRefused } from "#compiler/plan/contract.ts"
