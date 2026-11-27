/**
 * A consumer's contract parsed on the host by a process that loads no compiler (contractParserOver): its checked mint,
 * the one parse of a value of its base into its host type at a boundary, where mintOf(key) is the unchecked one. The
 * contract is compiled where its configuration names it (`grizzle generate`, program/contract.ts contractFileOf), its
 * type as a schema's compile types it, every level's predicate a host-evaluable table, carried in its checker file
 * (ContractFile) with the automata its patterns are matched by; the runtime only reads the file and runs
 * the one judgment of a value's domain on the host (runtime/write/witness.ts outsideDomain) over it.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Result as Public } from "effect"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { hostMintOf, type Marked } from "#compiler/core/brand.ts"
import { withoutSourceLocs } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import type { DeclaredName } from "#compiler/core/identity.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import type { PublicResult } from "#compiler/core/public-result.ts"
import type { RosterCodes } from "#compiler/ir/cells.ts"
import { rosterCodebook } from "#compiler/ir/codes.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { outsideDomain, judgeOf } from "#compiler/runtime/write/witness.ts"
import { type ServedMatchers, ServedPatterns } from "#compiler/scalar/regex/matcher.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import { admitValue } from "#compiler/scalar/values/identity.ts"
import type { Facts } from "#compiler/types/core/phantom.ts"
import type { Contract, FieldBase, Infer } from "#compiler/types/fields/field.ts"
import type { ContractRefused } from "#compiler/types/schema/evaluation.ts"

/**
 * A consumer's contract compiled for a process that parses its values and loads no compiler (contractParserOver): what
 * `grizzle generate` compiles for each contract a configuration names (its `contracts`, program/contract.ts
 * contractFileOf), once, and commits as `<migrations>/contract-checks/<name>.json` (served/forms.ts contractPath), the
 * served files' artifact kind, written and read by their writer and reader (served/json.ts contractText, contractFile)
 * under its own format. It holds the contract's declared name; the digest of its description, its base, predicate and
 * declared facts as its builder recorded them (contractDigest), which a parser holds the contract it is given to; its
 * type as a schema's compile types it, every level's predicate a host-evaluable table; every pattern its levels read,
 * each with its automaton (ServedMatchers); and the codes of the roster a closed id below it reads, none for any other.
 */
export interface ContractFile {
	readonly contract: string
	readonly digest: string
	readonly type: ScalarType
	readonly matchers: ServedMatchers
	readonly rosters: ReadonlyMap<DeclaredName, RosterCodes>
}

/**
 * The digest of a contract's description, its base, predicate and declared facts as its builder recorded them, source
 * locations aside (core/fingerprint.ts digest under the domain `contract`): what its checker file records and a parser
 * holds the contract it is given to, so a file compiled from another description of the contract is told apart.
 */
export const contractDigest = (desc: FieldDesc): Result.Result<string, CompileError> =>
	digest("contract", desc, withoutSourceLocs)

/**
 * A contract's checked mint (contractParserOver): the contract itself, the descriptor a field of it is declared by, so
 * a consumer that stores what it parses (den's step inputs) types its column by the contract, whose domain PostgreSQL
 * holds every write to and whose column delivers the host type; and its parse, a value of its base B as its host value
 * under the key K where the contract holds it, else the contract Name's refusal (ContractRefused).
 */
export interface ContractParser<
	Name extends string,
	B extends FieldBase,
	K extends symbol,
	Proved extends ReadonlyArray<keyof Facts>
> {
	readonly contract: Contract<Name, B, K, Proved>
	readonly parse: (value: Infer<B>) => Public.Result<Marked<Infer<B>, K>, ContractRefused<Name>>
}

/**
 * contractParser(file, contract, key), the shell's runtime entry's, over `answer`, its spelling of a caller's Result:
 * the contract's checked mint over its checker file `file`, read once. The file holds the contract exactly where it is
 * of the contract's name and its digest is the contract's description's (contractDigest); otherwise every parse is
 * CheckerDrifted, the file another contract's, which generate writes again, so a module that builds a parser from a file
 * the configuration's next generate rewrites loads while it does. `parse(value)` reads the value as its base's type by
 * the admission every caller's value of a field meets (scalar/values/identity.ts admitValue), under the codes of the
 * file's rosters, holds it to the file's type by the one judgment of a value's domain on the host, over the file's
 * automata (runtime/write/witness.ts outsideDomain), and mints it under `key` (core/brand.ts hostMintOf), or refuses it
 * by the contract's refusal: ValueRefused by the codec's fault, DomainRefused outside its predicate or its base's
 * refinements, each as PostgreSQL refuses it. The key is the one mintOf takes, refused as mintOf refuses it, so only its
 * holder builds a parser; a descriptor that is no contract, which a JavaScript caller may pass, is refused as
 * MalformedDescription, as a builder refuses one.
 */
export const contractParserOver = <
	Name extends string,
	B extends FieldBase,
	K extends symbol,
	Proved extends ReadonlyArray<keyof Facts>
>(
	file: ContractFile,
	contract: Contract<Name, B, K, Proved>,
	key: NoInfer<K>,
	answer: PublicResult
): ContractParser<Name, B, K, Proved> => {
	const loc = captureLoc("contractParser", [])
	const mint = hostMintOf(key)
	const { desc } = describeFieldOrThrow(contract, loc)
	if (desc.kind !== "contract") {
		throw malformedDescription(loc, "a contract, contract<typeof key>()(name, base, predicate)")
	}
	const described = contractDigest(desc)
	const held = file.contract === contract.name && described.ok && described.value === file.digest
	const spec = carrierSpecOf(file.type, rosterCodebook(file.rosters))
	const judge = judgeOf(new Map(), ServedPatterns.of(file.matchers))
	const judged = [{ name: contract.name, type: file.type, writing: { kind: "caller" } }] as const
	const parsed = (value: Infer<B>): Result.Result<Marked<Infer<B>, K>, ContractRefused<Name>> => {
		if (!held) {
			return Result.err({ _tag: "CheckerDrifted", contract: contract.name, checker: file.contract })
		}
		const read = admitValue(spec, value)
		if (!read.ok) {
			return Result.err({ _tag: "ValueRefused", contract: contract.name, fault: read.error })
		}
		return outsideDomain(judge, judged, () => read.value) === undefined
			? Result.ok(mint(value))
			: Result.err({ _tag: "DomainRefused", contract: contract.name })
	}
	return Object.freeze({ contract, parse: (value: Infer<B>) => answer(parsed(value)) })
}
