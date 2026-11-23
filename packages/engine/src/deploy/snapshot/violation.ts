import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { unwrap } from "#compiler/core/canonical.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { refuseLaw } from "#compiler/deploy/snapshot/objects.ts"
import { meaningDigestWithin, rooted, StatedFacts, topoOrder } from "#compiler/ir/dag.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { type TheoryViolations, theoryViolations } from "#compiler/laws/model/violations.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { type ConservativeInput, conservativeInput } from "#compiler/lower/conservative/types.ts"
import { sourcePrunePass } from "#compiler/lower/optimize/prune/index.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	nameKey,
	type OperandSelect,
	type Select,
	type StoredColumnKey,
	storedColumnKey
} from "#compiler/sql/ast.ts"

/**
 * The violation query of one law, its Forbid node `violation`, as it reads its relations: its own DAG pruned by the prune
 * that narrows the sources too (lower/optimize/prune sourcePrunePass), so it reads of each stored relation the columns
 * it binds and the relation's primary key, and a column it does not read, dropped or renamed, leaves its reads, and so
 * its check's identity, as they were. Each law's is pruned alone: one law's reads never widen another's.
 */
const readsOf = (installation: Installation, violation: RelNode): ConservativeInput => {
	const pruned = unwrap(
		sourcePrunePass.run(
			{ dag: rooted([violation]), params: [] },
			makePassContext({
				evidenceContext: "transaction",
				catalog: evidenceCatalog({ laws: installation.laws, views: [] })
			})
		)
	)
	return conservativeInput(pruned)
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
	const lowered = unwrap(
		lowerConservative(reads, {
			names: installation.names,
			params: [],
			subject: { kind: "violationProbe" }
		})
	)
	const [root, ...rest] = lowered.roots
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
	/** The stored columns its violation query reads, as installed (storedColumnsRead): the rows its proof was of. */
	readonly reads: ReadonlySet<StoredColumnKey>
}

/**
 * The stored columns a law's violation DAG `reads` reads, each as `installation` installs it: of each stored relation
 * a Base of it reads, the columns of its heading, which the source prune narrowed to those the law binds and the
 * relation's primary key (readsOf). A derived relation is read by its definition, never its view, and a closed relation
 * by its facts, so these are every stored value the law's verdict depends on.
 */
const storedColumnsRead = (
	installation: Installation,
	reads: ConservativeInput
): ReadonlySet<StoredColumnKey> =>
	new Set(
		topoOrder(reads.dag).flatMap((node) => {
			if (node.kind !== "Base" || node.relationKind !== "relation") {
				return []
			}
			const table = nameKey(installation.names.relation(node.relation))
			return node.heading.map((column) =>
				storedColumnKey(table, installation.names.column(node.relation, column.name))
			)
		})
	)

/**
 * The violation DAG of `law` as it reads its relations (`readsOf`), the stored columns it reads (storedColumnsRead) and
 * the identity of what it asks.
 */
const readsAndIdentity = (
	installation: Installation,
	violations: TheoryViolations,
	stated: StatedFacts,
	law: LawId
): {
	readonly reads: ConservativeInput
	readonly columns: ReadonlySet<StoredColumnKey>
	readonly digest: string
} => {
	const violation = violations.forbids.get(law)
	if (violation === undefined) {
		throw defect(`the violation queries hold the law ${law} of the theory`)
	}
	const reads = readsOf(installation, violation)
	const identity = unwrap(meaningDigestWithin(reads.dag, [reads.root], "law-check", stated))
	return { reads, columns: storedColumnsRead(installation, reads), digest: identity }
}

/** The check of a law over closed relations alone: its violation DAG as it reads them, lowered, and its identity. */
const checkOf = (
	installation: Installation,
	violations: TheoryViolations,
	stated: StatedFacts,
	law: LawId
): MigrationCheck => {
	const { reads, columns, digest } = readsAndIdentity(installation, violations, stated, law)
	return { law, query: violationQuery(installation, law, reads), digest, reads: columns }
}

/**
 * The check of a law the rule judge holds (laws/model/model.ts RuleTrigger), with what a previous installation that
 * held the law by native objects proves of its rows (`meaning`): `stated`, for a containment the law model discharges
 * to the rule judge (laws/model/plan.ts ContainmentDischarge), whose statement, two sides of stored relations, is the
 * law whole, so the natives that held it at every write held this very law; `defined`, for a rule over a query, whose
 * identity names its sides and not the definitions they read, so the natives that held it held the definitions of then.
 */
export interface RuleCheck {
	readonly law: LawId
	/** The judge's statements over the transaction that writes every row (Installation ruleChecks), rows that may repeat. */
	readonly query: OperandSelect
	readonly digest: string
	/** The stored columns its violation query reads, as installed (MigrationCheck `reads`): the rows its proof was of. */
	readonly reads: ReadonlySet<StoredColumnKey>
	readonly meaning: "stated" | "defined"
}

/** An installation's checks (lawChecks): its migration-discharged laws' and the rule judge's laws'. */
export interface LawChecks {
	readonly migrations: ReadonlyArray<MigrationCheck>
	readonly rules: ReadonlyArray<RuleCheck>
}

/** The violation queries of an installation's theory, written for its checks (laws/model/violations.ts). */
const violationsOf = (installation: Installation): TheoryViolations =>
	unwrap(theoryViolations(installation.laws.checked, installation.laws.theory))

/**
 * An installation's checks, from its theory's violation queries, written once for them (laws/model/violations.ts):
 * `migrations`, the laws that read closed relations alone, in the law model's order of its migration-discharged laws,
 * each its violation query lowered; `rules`, each rule over a query in law order, its check over every row
 * (Installation ruleChecks): the judge's own statements over the transaction that writes every row
 * (physical/ddl/rules.ts addRules), which the migration that adds the rule, or changes it or a definition it reads,
 * runs once its rows are written, before its triggers hold it at every COMMIT after (laws/model/model.ts
 * RuleTrigger). `digest` is the law's identity (MigrationCheck), its violation query's meaning, so a change of the law,
 * of the rows it reads or of a definition a rule reads is a new check, and a change of how the check reads is none.
 */
export const lawChecks = (installation: Installation): LawChecks => {
	const violations = violationsOf(installation)
	/** The closed facts every law's identity reads, each read once for all of them (ir/dag.ts StatedFacts). */
	const stated = new StatedFacts(installation.checked.closed)
	return {
		migrations: installation.laws.migrationLaws.map((law) =>
			checkOf(installation, violations, stated, law)
		),
		rules: installation.laws.rules.map((r): RuleCheck => {
			const { columns, digest } = readsAndIdentity(installation, violations, stated, r.law.id)
			return {
				law: r.law.id,
				query: defined(
					installation.ruleChecks.get(r.law.id),
					`the installation's check over every row of the rule ${r.law.id}`
				),
				digest,
				reads: columns,
				meaning: r.law.detail.kind === "containment" ? "stated" : "defined"
			}
		})
	}
}

/**
 * Each rule over a query's violation query over every row, as it reads its relations, lowered by the oracle baseline
 * (lower/conservative): the reading of each law apart from the judge, whose statements both the triggers and the
 * migration's check over every row run (lawChecks). The judge's suites hold its verdicts to these.
 */
export const baselineRuleChecks = (installation: Installation): ReadonlyArray<MigrationCheck> => {
	const violations = violationsOf(installation)
	const stated = new StatedFacts(installation.checked.closed)
	return installation.laws.rules.map((r) => checkOf(installation, violations, stated, r.law.id))
}
