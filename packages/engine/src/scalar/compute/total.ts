import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { type ExprTable, predicateProblems, predicateTable } from "#compiler/ir/expr.ts"
import { exprTableShape } from "#compiler/ir/scalar-shape.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import * as S from "#compiler/ir/shape.ts"
import type { RegexMember } from "#compiler/scalar/compute/evaluate.ts"
import {
	exprEmitter,
	type LeafDesc,
	type LowerEnv,
	lowerPredicate,
	noParams
} from "#compiler/scalar/compute/lower.ts"

interface TotalOptions {
	/** Where the declaration is: every diagnostic is located inside it. */
	readonly loc: SourceLoc
	/** The descriptor registry's reading of a Description, for a typed literal (Compute.literal) in the predicate. */
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
	/** A literal's membership in a regex refinement: the text package's NFA. */
	readonly regexMember: RegexMember
}

const refuseLeaf = (what: string) => (desc: LeafDesc, loc: SourceLoc) =>
	Result.err(malformedDescription(loc, `${what}, not a ${desc.kind} reference`))

/**
 * The total fragment: contract predicates.
 *
 * A contract predicate reads only the domain's VALUE and uses the total subset of the scalar language, lowered in
 * lower.ts's "total" mode, so it never raises and a refused value is always a constraint violation.
 * contractPredicateTable lowers it to an ExprTable (ir/expr.ts) in the normal form a ScalarType carries, its only
 * input VALUE at the contract's base type, checked by predicateProblems and owned as the decoder writes it. This is
 * the ScalarEnv.contractPredicate a descriptor registry uses to build a contract's ScalarType, and the table the
 * ContractLiteral check evaluates (evaluate.ts admitLiteral: a Compute literal, and analysis/schema.ts literal, a closed
 * relation's payload among them).
 *
 * The ExprTable of a contract's predicate over a VALUE of type `base`, in normal form.
 */
export const contractPredicateTable = (
	predicate: ExprDesc,
	base: ScalarType,
	contract: string,
	options: TotalOptions
): Result.Result<ExprTable, CompileError> => {
	const loc = childLoc(options.loc, "predicate")
	/**
	 * The checked table, which this package built, conformed in place: owned and frozen as the decoder writes
	 * it, what the contract's ScalarType holds.
	 */
	const env: LowerEnv = {
		mode: "total",
		loc,
		emit: exprEmitter("t"),
		leaf: (desc, at) =>
			desc.kind === "value"
				? Result.ok({ kind: "value", args: [], type: base, nonNull: "storage" })
				: refuseLeaf("a contract predicate reads only its VALUE")(desc, at),
		params: noParams,
		fieldType: options.fieldType,
		regexMember: options.regexMember
	}
	return Result.flatMap(lowerPredicate(predicate, env), (root) => {
		const table = predicateTable(root.expr)
		const [problem] = predicateProblems(table, base)
		return problem === undefined
			? Result.ok(S.conformWith(exprTableShape, table, `contract ${contract} predicate`))
			: Result.err(malformedDescription(loc, problem))
	})
}
