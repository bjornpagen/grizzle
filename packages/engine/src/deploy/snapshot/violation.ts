import { everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { refuseLaw } from "#compiler/deploy/snapshot/objects.ts"
import { type TheoryViolations, theoryViolations } from "#compiler/laws/model/violations.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { Select } from "#compiler/sql/ast.ts"

/**
 * The full violation query of a law of `installation`'s theory, its Forbid node in `violations`, lowered by the oracle
 * baseline over every row: one parameterless statement whose rows are the law's violations. A violation probe reads
 * stored values, which already satisfy their refinements, so a text refinement no stored column carries, such as a
 * contract's base pattern, is typed as text (`ConservativeSubject`).
 */
const violationQuery = (
	installation: Installation,
	violations: TheoryViolations,
	law: LawId
): Select => {
	const violation = violations.forbids.get(law)
	if (violation === undefined) {
		throw defect(`the violation queries hold the law ${law} of the theory`)
	}
	const lowered = lowerConservative(
		{ dag: violations.dag, root: violation },
		{ names: installation.names, params: [], subject: { kind: "violationProbe" } }
	)
	if (!lowered.ok) {
		throw new Refusal(lowered.error)
	}
	const [root, ...rest] = lowered.value.roots
	const main = root.statement
	if (
		rest.length > 0 ||
		root.attachments.length > 0 ||
		main.role.kind !== "main" ||
		main.params.length > 0
	) {
		return refuseLaw(law, "a violation query of one parameterless statement")
	}
	return main.ast
}

/**
 * A law that reads closed relations only, as the migration that installs them discharges it: once, by its violation
 * query over the rows the migration states, which must return nothing, and never again, since no write changes a
 * closed relation. `digest` is the query's, so a change of the law or of the rows it reads is a new check.
 */
export interface MigrationCheck {
	readonly law: LawId
	readonly query: Select
	readonly digest: string
}

/** The check of `law`, its violation query lowered, digested. */
const checkOf = (
	installation: Installation,
	violations: TheoryViolations,
	law: LawId
): MigrationCheck => {
	const query = violationQuery(installation, violations, law)
	const d = digest("migration-check", query, everyProperty)
	if (!d.ok) {
		throw new Refusal(d.error)
	}
	return { law, query, digest: d.value }
}

/**
 * An installation's checks, from its theory's violation queries written once (laws/model/violations.ts):
 * `migrations`, the laws that read closed relations alone, in the law model's order of its migration-discharged laws;
 * `rules`, each rule over a query in law order, its violation query over every row, which the migration that adds the
 * rule, or changes it or a definition it reads, runs once its rows are written, before its triggers hold it at every
 * COMMIT after (laws/model/model.ts RuleTrigger). `digest` is the query's, so a change of the law, of the rows it
 * reads or of a definition a rule reads is a new check.
 */
export const lawChecks = (
	installation: Installation
): {
	readonly migrations: ReadonlyArray<MigrationCheck>
	readonly rules: ReadonlyArray<MigrationCheck>
} => {
	const violations = theoryViolations(installation.laws.checked, installation.laws.theory)
	if (!violations.ok) {
		throw new Refusal(violations.error)
	}
	return {
		migrations: installation.laws.migrationLaws.map((law) =>
			checkOf(installation, violations.value, law)
		),
		rules: installation.laws.rules.map((r) => checkOf(installation, violations.value, r.law.id))
	}
}
