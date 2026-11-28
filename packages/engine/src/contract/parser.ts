/**
 * A consumer's contract parsed on the host (domainParserOf): its checked mint, the one parse of a value of its base
 * into its host type at a boundary, where mintOf(key) is the unchecked one. Its checker is a fact of the contract value
 * alone, derived where the parser is built: the contract's type as a schema's compile types it, every level's predicate
 * a host-evaluable table (scalar/compute/total.ts schemaEnvOf, over the roster a closed id below it reads and a pattern
 * table of its own), the codes of that roster, first drawn, and the automata its patterns are matched by; the parse runs
 * the one judgment of a value's domain on the host (runtime/write/witness.ts outsideDomain) over it. No file holds a
 * checker, so a module that builds a parser reads nothing `grizzle generate` writes: a configuration whose modules build
 * parsers loads whatever its migrations directory holds, and the generate that rewrites that directory always runs.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Result as Public } from "effect"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { hostMintOf, type Marked } from "#compiler/core/brand.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type { PublicResult } from "#compiler/core/public-result.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { rosterOf } from "#compiler/ir/scalar.ts"
import { outsideDomain, judgeOf } from "#compiler/runtime/write/witness.ts"
import { schemaEnvOf } from "#compiler/scalar/compute/total.ts"
import { describeFieldOrThrow, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { admitValue } from "#compiler/scalar/values/identity.ts"
import { AnalyzedPatterns } from "#compiler/text/refinement.ts"
import type { Facts } from "#compiler/types/core/phantom.ts"
import type { Domain, FieldBase, Infer } from "#compiler/types/fields/field.ts"
import type { DomainParseRefused } from "#compiler/types/schema/evaluation.ts"

/**
 * A contract's checked mint (domainParserOf): the contract itself, the descriptor a field of it is declared by, so
 * a consumer that stores what it parses (den's step inputs) types its column by the contract, whose domain PostgreSQL
 * holds every write to and whose column delivers the host type; and its parse, a value of its base B as its host value
 * under the key K where the contract holds it, else the contract Name's refusal (DomainParseRefused).
 */
export interface DomainParser<
	Name extends string,
	B extends FieldBase,
	K extends symbol,
	Proved extends ReadonlyArray<keyof Facts>
> {
	readonly domain: Domain<Name, B, K, Proved>
	readonly parse: (value: Infer<B>) => Public.Result<Marked<Infer<B>, K>, DomainParseRefused<Name>>
}

/**
 * domainParser(contract, key), the shell's runtime entry's, over `answer`, its spelling of a caller's Result: the
 * contract's checked mint, its checker derived once, here (see the header). `parse(value)` reads the value as its
 * base's type by the admission every caller's value of a field meets (scalar/values/identity.ts admitValue), under the
 * codes of the roster a closed id below it reads, holds it to the contract's type by the one judgment of a value's
 * domain on the host, over its patterns' automata (runtime/write/witness.ts outsideDomain), and mints it under `key`
 * (core/brand.ts hostMintOf), or refuses it by the contract's refusal: ValueRefused by the codec's fault, DomainRefused
 * outside its predicate or its base's refinements, each as PostgreSQL refuses it. The key is the one mintOf takes,
 * refused as mintOf refuses it, so only its holder builds a parser; a descriptor that is no contract, which a JavaScript
 * caller may pass, is refused as MalformedDescription, as a builder refuses one, and a contract whose predicate does not
 * type, as its schema's compile refuses it.
 */
export const domainParserOf = <
	Name extends string,
	B extends FieldBase,
	K extends symbol,
	Proved extends ReadonlyArray<keyof Facts>
>(
	contract: Domain<Name, B, K, Proved>,
	key: NoInfer<K>,
	answer: PublicResult
): DomainParser<Name, B, K, Proved> => {
	const loc = captureLoc("domainParser", [])
	const mint = hostMintOf(key)
	const described = describeFieldOrThrow(contract, loc)
	const { desc } = described
	if (desc.kind !== "domain") {
		throw malformedDescription(loc, "a domain, domain<typeof key>()(name, base, predicate)")
	}
	const roster = rosterOf(described.scalar)
	const patterns = new AnalyzedPatterns()
	const typed = scalarTypeOf(
		desc,
		schemaEnvOf((name) => (roster?.closed === name ? roster : undefined), patterns, new Map()),
		loc
	)
	if (!typed.ok) {
		throw typed.error
	}
	const type = typed.value
	const spec = carrierSpecOf(type, firstCodebook(roster === undefined ? [] : [roster]))
	const judge = judgeOf(new Map(), patterns)
	const judged = [{ name: contract.name, type, writing: { kind: "caller" } }] as const
	const parsed = (
		value: Infer<B>
	): Result.Result<Marked<Infer<B>, K>, DomainParseRefused<Name>> => {
		const read = admitValue(spec, value)
		if (!read.ok) {
			return Result.err({ _tag: "ValueRefused", domain: contract.name, fault: read.error })
		}
		return outsideDomain(judge, judged, () => read.value) === undefined
			? Result.ok(mint(value))
			: Result.err({ _tag: "DomainRefused", domain: contract.name })
	}
	return Object.freeze({ domain: contract, parse: (value: Infer<B>) => answer(parsed(value)) })
}
