import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { deepFreeze } from "#compiler/core/record.ts"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { type ExprTable, predicateProblems, predicateTable } from "#compiler/ir/expr.ts"
import type { Fact } from "#compiler/ir/proof.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { exprEmitter, type LowerEnv, lowerPredicate } from "#compiler/scalar/compute/lower.ts"
import {
	type LeafDesc,
	noClosedRelations,
	noParams,
	unprovedFact
} from "#compiler/scalar/compute/typing.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { type RosterLookup, type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"

interface TotalOptions {
	/** Where the declaration is: every diagnostic is located inside it. */
	readonly loc: SourceLoc
	/** The descriptor registry's reading of a Description, for a typed literal (Type.literal) in the predicate. */
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
	/**
	 * The admitted patterns the lowering reads, its compile's table (scalar/regex/patterns.ts), and the text analysis of
	 * a pattern the predicate computes (a translate's or collapse's image, a guard's match).
	 */
	readonly patterns: PatternAutomata
}

/** A predicate conjunct that proves each fact, as a refused declaration names it. */
const factPredicate: { readonly [F in Fact]: string } = {
	nonzero: "VALUE <> 0, VALUE > 0, or a bound that excludes zero",
	nonnegative: "VALUE >= 0, or a low bound at or above zero",
	finite: "VALUE BETWEEN two finite bounds, or VALUE above and below finite bounds"
}

const refuseLeaf = (what: string) => (desc: LeafDesc, loc: SourceLoc) =>
	Result.err(malformedDescription(loc, `${what}, not a ${desc.kind} reference`))

/**
 * Contract predicates.
 *
 * A contract predicate reads only the domain's VALUE, lowered in lower.ts's "check" mode, whose every operation is
 * total as every expression's is (registry.ts Totality), so it never raises and a refused value is always a constraint
 * violation.
 * contractPredicateTable lowers it to an ExprTable (ir/expr.ts) in the normal form a ScalarType carries, its only
 * input VALUE at the contract's base type, checked by predicateProblems and owned as the decoder writes it. This is
 * the ScalarEnv.contractPredicate a descriptor registry uses to build a contract's ScalarType, and the table the
 * ContractLiteral check evaluates (evaluate.ts admitLiteral: a scalar literal, and analysis/schema.ts literal, a closed
 * relation's payload among them). Each fact the contract declares it proves (`proves`, the facts its TypeScript type
 * states) is proved here from the predicate (typing.ts unprovedFact), else the declaration is refused, naming it.
 *
 * The ExprTable of a contract's predicate over a VALUE of type `base`, in normal form.
 */
export const contractPredicateTable = (
	predicate: ExprDesc,
	base: ScalarType,
	contract: string,
	facts: ReadonlyArray<Fact>,
	options: TotalOptions
): Result.Result<ExprTable, CompileError> => {
	const loc = childLoc(options.loc, "predicate")
	/**
	 * The checked table, which this package built, conformed in place: owned and frozen as the decoder writes
	 * it, what the contract's ScalarType holds.
	 */
	const env: LowerEnv = {
		mode: "check",
		loc,
		emit: exprEmitter("t"),
		leaf: (desc, at) =>
			desc.kind === "value"
				? Result.ok({ kind: "value", args: [], type: base, nonNull: "storage" })
				: refuseLeaf("a contract predicate reads only its VALUE")(desc, at),
		params: noParams,
		fieldType: options.fieldType,
		closed: noClosedRelations("a contract predicate reads no closed relation of the schema"),
		patterns: options.patterns
	}
	return Result.flatMap(lowerPredicate(predicate, env), (root) => {
		const table = predicateTable(root.expr)
		const [problem] = predicateProblems(table, base)
		if (problem !== undefined) {
			return Result.err(malformedDescription(loc, problem))
		}
		const owned = deepFreeze(table)
		const unproved = unprovedFact(base, owned, facts)
		return unproved === undefined
			? Result.ok(owned)
			: Result.err(
					malformedDescription(
						childLoc(options.loc, "proves"),
						`a predicate that proves the declared fact ${unproved} (${factPredicate[unproved]}): contract ${contract} declares it, and its predicate does not state it`
					)
				)
	})
}

/**
 * The descriptor registry's environment of a schema (scalar/registry.ts ScalarEnv), which types each contract's
 * predicate as the schema's compile does: rosters by `roster`, and a contract's predicate lowered over its base as a
 * field of the contract types it (contractPredicateTable), by `patterns`, its compile's table, each literal in it typed
 * by this environment; `declared` the tables its compile lowered once already, by contract name, read before any
 * contract's predicate is lowered again. The one environment a schema's fields (analysis/schema.ts) and a contract's
 * host parse (contract/parser.ts contractParserOf) are typed by.
 */
export const schemaEnvOf = (
	roster: RosterLookup,
	patterns: PatternAutomata,
	declared: ReadonlyMap<string, Result.Result<ExprTable, CompileError>>
): Extract<ScalarEnv, { readonly kind: "schema" }> => {
	const env: Extract<ScalarEnv, { readonly kind: "schema" }> = {
		kind: "schema",
		roster,
		contractPredicate: (predicate, base, contract, facts) =>
			declared.get(contract) ??
			contractPredicateTable(predicate, base, contract, facts, {
				loc: SourceLoc(`contract ${contract}`, []),
				fieldType: (d, at) => scalarTypeOf(d, env, at),
				patterns
			})
	}
	return env
}
