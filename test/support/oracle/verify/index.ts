import { Array as Arr } from "effect"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import type { ConservativeProgram } from "#compiler/lower/conservative/types.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { conservativeStatement } from "#compiler/lower/shapes/index.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { artifactProblems, channelProblems } from "#test/support/oracle/verify/channels.ts"
import { verifyMultiplicity } from "#test/support/oracle/verify/multiplicity.ts"
import { problemText, type VerificationProblem } from "#test/support/oracle/verify/problems.ts"
import {
	auditCarrierProgramViolations,
	auditStatementViolations,
	auditTextViolations
} from "#test/support/oracle/verify/sql.ts"

/** What a lowering is checked against: the conservative artifact of the same template, or none for a read-back. */
export type Alignment =
	| { readonly kind: "aligned"; readonly conservative: ConservativeProgram }
	| { readonly kind: "readBack" }

/**
 * A lowering under check: the optimized program, what it aligns with, and the execution context and catalog it was
 * compiled for (lowerOptimized's options).
 */
export interface LoweringUnderCheck {
	readonly optimized: OptimizedProgram
	readonly alignment: Alignment
	readonly context: TemplateContext
	readonly catalog: EvidenceCatalog
}

/**
 * Every problem of a lowering, in a fixed order: the plan's, then the optimized statement's, then its large form's,
 * then the conservative program's as one statement of parts (shapes/index.ts conservativeStatement), then the
 * artifacts' alignment. A failure is the physical analysis refusing the DAG the plan realizes, or the conservative
 * program's statement refused.
 */
const loweringProblems = (
	lowering: LoweringUnderCheck
): Result.Result<ReadonlyArray<VerificationProblem>, CompileError> => {
	const { optimized, alignment } = lowering
	const multiplicity = verifyMultiplicity(optimized.query.dag, optimized.plan, {
		context: lowering.context,
		catalog: lowering.catalog,
		roots: "result"
	})
	if (!multiplicity.ok) {
		return multiplicity
	}
	const forms = optimized.statement.forms
	const own = [
		...multiplicity.value.problems,
		...channelProblems(optimized, "statement"),
		...(forms.kind === "chosen"
			? channelProblems({ ...optimized, statement: forms.large }, "large variant statement")
			: [])
	]
	if (alignment.kind === "readBack") {
		return Result.ok(own)
	}
	return Result.map(
		catchRefusal(() => conservativeStatement(alignment.conservative)),
		(conservative) => [
			...own,
			...channelProblems(conservative, "conservative statement"),
			...artifactProblems(optimized, conservative)
		]
	)
}

/**
 * Each broken promise of a lowering, as one line (loweringProblems), the physical analysis refusing the DAG among them:
 * none when the lowering keeps every promise its construction makes. A property suite fails its case with them.
 */
export const loweringViolations = (lowering: LoweringUnderCheck): ReadonlyArray<string> => {
	const problems = loweringProblems(lowering)
	return problems.ok
		? Arr.map(problems.value, problemText)
		: [`the physical analysis refuses the lowered DAG: ${problems.error.message}`]
}

/**
 * The test kernel's verification of a lowering: a property every lowering of the suites is checked against.
 *
 * The optimized lowering trusts its own construction (lower/optimize/pipeline.ts); the promises that construction makes
 * are checked here, over the lowered program, by an implementation that recomputes rather than reads:
 *
 * - the plan's obligations, recomputed from the DAG under the execution context and the catalog the template is
 *   compiled for, every certificate rebuilt and compared whole (multiplicity.ts);
 * - the sent statement's channels and structural audit, in the optimized artifact, in its per-execution large form,
 *   and in the conservative artifact as one statement of parts (channels.ts, sql.ts);
 * - the two artifacts decode to the same public result (channels.ts artifactProblems), unless the optimized one is a
 *   read-back, whose conservative artifact is realized with its write and compared by the write oracle.
 *
 * Asserts a lowering keeps every promise its construction makes (loweringViolations).
 */
export const checkedLowering = (lowering: LoweringUnderCheck): void => {
	assert.deepEqual(
		loweringViolations(lowering),
		[],
		"the lowering keeps every promise its construction makes"
	)
}

/**
 * A compiled query template as a lowering under check: its optimized program aligned with its conservative program,
 * for the context and catalog it was compiled for.
 */
export const templateLowering = (
	template: OracleTemplate,
	context: TemplateContext,
	catalog: EvidenceCatalog
): LoweringUnderCheck => ({
	optimized: template.programs.optimized,
	alignment: { kind: "aligned", conservative: template.programs.conservative },
	context,
	catalog
})

/**
 * Asserts every statement passes the structural audit, the statement audit on its AST and the text audit on its
 * printed text, and that a write program's ANALYZE statements name only carriers an earlier statement created
 * (sql.ts). `label` names the statements in a failure.
 */
export const checkedStatements = (statements: ReadonlyArray<SqlStatement>, label: string): void => {
	const violations = [
		...Arr.flatMap(statements, (s, i) =>
			Arr.map(
				[...auditStatementViolations(s), ...auditTextViolations(printStatement(s))],
				(v) => `${label} ${i}: ${v.rule} at ${v.where}: ${v.detail}`
			)
		),
		...Arr.map(
			auditCarrierProgramViolations(statements),
			(v) => `${label}: ${v.rule} at ${v.where}: ${v.detail}`
		)
	]
	assert.deepEqual(violations, [], `every ${label} passes the structural audit`)
}
