import { Refusal } from "#compiler/core/canonical.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { refuseLaw } from "#compiler/deploy/snapshot/objects.ts"
import { meaningDigestWithin, rooted } from "#compiler/ir/dag.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { type TheoryViolations, theoryViolations } from "#compiler/laws/model/violations.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { type ConservativeInput, conservativeInput } from "#compiler/lower/conservative/types.ts"
import { sourcePrunePass } from "#compiler/lower/optimize/prune/index.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { Select } from "#compiler/sql/ast.ts"

/**
 * The violation query of one law, its Forbid node `violation`, as it reads its relations: its own DAG pruned by the prune
 * that narrows the sources too (lower/optimize/prune sourcePrunePass), so it reads of each stored relation the columns
 * it binds and the relation's primary key, and a column it does not read, dropped or renamed, leaves its reads, and so
 * its check's identity, as they were. Each law's is pruned alone: one law's reads never widen another's.
 */
const readsOf = (installation: Installation, violation: RelNode): ConservativeInput => {
	const pruned = sourcePrunePass.run(
		{ dag: rooted([violation]), params: [] },
		makePassContext({
			evidenceContext: "transaction",
			catalog: evidenceCatalog({ laws: installation.laws, views: [] })
		})
	)
	if (!pruned.ok) {
		throw new Refusal(pruned.error)
	}
	return conservativeInput(pruned.value)
}

/**
 * The full violation query of `law`, its violation DAG as it reads its relations (`reads`), lowered by the oracle
 * baseline over every row: one parameterless statement whose rows are the law's violations. A violation probe reads
 * stored values, which already satisfy their refinements, so a text refinement no stored column carries, such as a
 * contract's base pattern, is typed as text (`ConservativeSubject`).
 */
const violationQuery = (
	installation: Installation,
	law: LawId,
	reads: ConservativeInput
): Select => {
	const lowered = lowerConservative(reads, {
		names: installation.names,
		params: [],
		subject: { kind: "violationProbe" }
	})
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
 * closed relation. `digest` is the check's identity, the law's own: the digest of what its violation DAG asks of the
 * rows it reads, as it reads them (ir/dag.ts meaningDigestWithin), the closed rows it reads and the definitions of the
 * derived relations it reads among them, never its SQL, so a change of the law, of the rows it reads or of a definition
 * it reads is a new check, and a change of how it lowers, rewrites or analyzes is none.
 */
export interface MigrationCheck {
	readonly law: LawId
	readonly query: Select
	readonly digest: string
}

/** The check of `law`: its violation DAG as it reads its relations, lowered, and the identity of what it asks. */
const checkOf = (
	installation: Installation,
	violations: TheoryViolations,
	law: LawId
): MigrationCheck => {
	const violation = violations.forbids.get(law)
	if (violation === undefined) {
		throw defect(`the violation queries hold the law ${law} of the theory`)
	}
	const reads = readsOf(installation, violation)
	const identity = meaningDigestWithin(reads.dag, [reads.root], "law-check")
	if (!identity.ok) {
		throw new Refusal(identity.error)
	}
	return { law, query: violationQuery(installation, law, reads), digest: identity.value }
}

/**
 * The check of a law the rule judge holds (laws/model/model.ts RuleTrigger), with what a previous installation that held
 * the law by native objects proves of its rows (`meaning`): `stated`, for a containment the law model discharges whole
 * (laws/model/plan.ts ContainmentDischarge), whose statement, two sides of stored relations, is the law whole, so the
 * natives that held it at every write held this very law; `defined`, for a rule over a query, whose identity names its
 * sides and not the definitions they read, so the natives that held it held the definitions of then.
 */
export interface RuleCheck extends MigrationCheck {
	readonly meaning: "stated" | "defined"
}

/** An installation's checks (lawChecks): its migration-discharged laws' and the rule judge's laws'. */
export interface LawChecks {
	readonly migrations: ReadonlyArray<MigrationCheck>
	readonly rules: ReadonlyArray<RuleCheck>
}

/**
 * An installation's checks, from its theory's violation queries written once (laws/model/violations.ts):
 * `migrations`, the laws that read closed relations alone, in the law model's order of its migration-discharged laws;
 * `rules`, each rule over a query in law order, its violation query over every row, which the migration that adds the
 * rule, or changes it or a definition it reads, runs once its rows are written, before its triggers hold it at every
 * COMMIT after (laws/model/model.ts RuleTrigger). `digest` is the law's identity (MigrationCheck), so a change of
 * the law, of the rows it reads or of a definition a rule reads is a new check, and a change of its lowering is none.
 */
export const lawChecks = (installation: Installation): LawChecks => {
	const violations = theoryViolations(installation.laws.checked, installation.laws.theory)
	if (!violations.ok) {
		throw new Refusal(violations.error)
	}
	return {
		migrations: installation.laws.migrationLaws.map((law) =>
			checkOf(installation, violations.value, law)
		),
		rules: installation.laws.rules.map((r): RuleCheck => ({
			...checkOf(installation, violations.value, r.law.id),
			meaning: r.law.detail.kind === "containment" ? "stated" : "defined"
		}))
	}
}
