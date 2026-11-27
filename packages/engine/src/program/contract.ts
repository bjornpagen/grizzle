/**
 * A contract compiled for its checker file (runtime/contract.ts ContractFile), where a configuration names it
 * (`grizzle generate`): its type as a schema's compile types it, its predicate lowered over its base by the environment
 * every schema's fields are typed by (scalar/compute/total.ts schemaEnvOf), its patterns a compile's own table, with
 * the digest of its description (runtime/contract.ts contractDigest), the automata of every pattern its levels read and
 * the codes of the roster a closed id below it reads. A process that parses the contract's values reads the file and
 * loads no compiler (runtime/contract.ts contractParserOver).
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { CheckSession } from "#compiler/check/session.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { rosterOf } from "#compiler/ir/scalar.ts"
import { type ContractFile, contractDigest } from "#compiler/runtime/contract.ts"
import { schemaEnvOf } from "#compiler/scalar/compute/total.ts"
import { ProgramPatterns, typePatterns } from "#compiler/scalar/regex/patterns.ts"
import { scalarTypeOf } from "#compiler/scalar/registry.ts"
import { describeDeclared } from "#compiler/schema/relation.ts"

/**
 * The checker file of `contract`, a contract descriptor, compiled (see the header), or the CompileError of a contract
 * that does not compile, or of a value that is no contract, which a configuration's JavaScript may name.
 */
export const contractFileOf = (contract: unknown): Result.Result<ContractFile, CompileError> => {
	const loc = captureLoc("contracts", [])
	const described = describeDeclared(contract, loc)
	const { desc } = described
	if (desc.kind !== "contract") {
		return Result.err(
			malformedDescription(loc, "a contract, contract<typeof key>()(name, base, predicate)")
		)
	}
	const roster = rosterOf(described.scalar)
	const { patterns } = CheckSession.own()
	const env = schemaEnvOf(
		(name) => (roster?.closed === name ? roster : undefined),
		patterns,
		new Map()
	)
	return Result.flatMap(scalarTypeOf(desc, env, loc), (type) =>
		Result.map(contractDigest(desc), (digest): ContractFile => {
			const codes =
				roster === undefined ? undefined : firstCodebook([roster]).rosters.get(roster.closed)
			return {
				contract: desc.name,
				digest,
				type,
				matchers: ProgramPatterns.of(typePatterns(type)).served(),
				rosters: codes === undefined ? new Map() : new Map([[codes.roster, codes.codes]])
			}
		})
	)
}
