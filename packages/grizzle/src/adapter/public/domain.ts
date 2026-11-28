import { toResult } from "#adapter/engine.ts"
import {
	type Domain,
	type DomainParser,
	domainParserOf,
	type Facts,
	type FieldBase
} from "#compiler/plan/contract.ts"

/**
 * Public barrel: a consumer's domain's checked mint (engine contract/parser.ts), which the domain entry
 * @bjornpagen/grizzle/domain re-exports, apart from the runtime entry, so a process that serves a login and parses no
 * domain's values loads none of the text analysis and the predicate lowering a checker is derived by.
 */

/**
 * domainParser(domain, key): the domain's checked mint, the one parse of a value of its base into its host type at a
 * boundary, where mintOf(key) is the unchecked one. Its checker is derived from the domain itself where the parser is
 * built (engine contract/parser.ts domainParserOf): no file holds it, so a module that builds a parser, and a
 * configuration whose modules import that module, read nothing `grizzle generate` writes. A domain whose predicate
 * does not type is refused, thrown, as its schema's compile refuses it. Its `domain` is the domain, which a consumer
 * storing what it parses types its column by, and `parse(value)` a Result of the value under the key, or the domain's
 * refusal (DomainParseRefused): ValueRefused by the codec's fault, DomainRefused outside its predicate or its base's
 * refinements, as PostgreSQL refuses each. Its key is the domain's own, which mintOf takes, so only its holder builds
 * one, beside its mint: `export const sittingKeyParser = gDomain.domainParser(SittingKey, sittingKeyKey)`.
 */
export const domainParser = <
	Name extends string,
	B extends FieldBase,
	K extends symbol,
	Proved extends ReadonlyArray<keyof Facts>
>(
	contract: Domain<Name, B, K, Proved>,
	key: NoInfer<K>
): DomainParser<Name, B, K, Proved> => domainParserOf(contract, key, toResult)

export type { DomainParser, DomainParseRefused } from "#compiler/plan/contract.ts"
