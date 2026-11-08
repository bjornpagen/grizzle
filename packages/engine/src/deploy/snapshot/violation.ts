import { everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { refuseLaw } from "#compiler/deploy/snapshot/objects.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { Select } from "#compiler/sql/ast.ts"

/**
 * The full violation query of a law of `installation`'s theory, rooted at `violation`, lowered by the oracle baseline
 * over every row: one parameterless statement whose rows are the law's violations. A violation probe reads stored
 * values, which already satisfy their refinements, so a text refinement no stored column carries, such as a contract's
 * base pattern, is typed as text (`ConservativeSubject`).
 */
const violationQuery = (installation: Installation, law: LawId, violation: RelNode): Select => {
	const lowered = lowerConservative(
		{ dag: installation.laws.theory.dag, root: violation },
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

/** The check of `law`, whose violation query is rooted at `violation`, digested. */
const checkOf = (installation: Installation, law: LawId, violation: RelNode): MigrationCheck => {
	const query = violationQuery(installation, law, violation)
	const d = digest("migration-check", query, everyProperty)
	if (!d.ok) {
		throw new Refusal(d.error)
	}
	return { law, query, digest: d.value }
}

/** The migration checks of an installation's theory, in the law model's order of its migration-discharged laws. */
export const migrationChecks = (installation: Installation): ReadonlyArray<MigrationCheck> => {
	const theory = installation.laws.theory
	return installation.laws.migrationLaws.map((law): MigrationCheck => {
		const declared = theory.laws.find((l) => l.id === law)
		if (declared === undefined) {
			throw defect(`the theory holds the migration-discharged law ${law}`)
		}
		return checkOf(installation, law, declared.violation)
	})
}

/**
 * The checks of an installation's rules over queries, in law order: each rule's violation query over every row, which
 * the migration that adds the rule, or changes it or a definition it reads, runs once its rows are written, before
 * its triggers hold it at every COMMIT after (laws/model/model.ts RuleTrigger). `digest` is the query's, so a change of
 * the rule or of a definition it reads is a new check.
 */
export const ruleChecks = (installation: Installation): ReadonlyArray<MigrationCheck> =>
	installation.laws.rules.map((r) => checkOf(installation, r.law.id, r.law.violation))
