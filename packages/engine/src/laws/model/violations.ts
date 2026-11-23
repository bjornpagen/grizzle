import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { ViolationBuilder } from "#compiler/analysis/theory/build.ts"
import { lawViolation } from "#compiler/analysis/theory/laws.ts"
import { lawSides, ruleViolation, type Theory } from "#compiler/analysis/theory/theory.ts"
import { catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { LabelSupply } from "#compiler/ir/dag.ts"
import type { RelNode, ValidDag } from "#compiler/ir/rel.ts"

/**
 * Every law's violation query, a query that must be empty, under a Forbid node of its identity, in one DAG: what the
 * migration that installs a law over closed relations alone, or a rule over a query, runs once (deploy/snapshot
 * violation.ts), and what the reference evaluator reads a law's meaning by. The theory (theory.ts buildTheory) writes
 * none of them: a law's natives discharge it at every write, and no compilation of a program reads its query.
 */
export interface TheoryViolations {
	readonly dag: ValidDag
	/** Each law's Forbid node, by its id, a node of `dag`. */
	readonly forbids: ReadonlyMap<LawId, RelNode>
}

/** A law with its violation written in the builder, or a rule over a query's checked violation query. */
type Written =
	| { readonly kind: "built"; readonly id: LawId; readonly forbid: RelNode }
	| {
			readonly kind: "query"
			readonly id: LawId
			readonly query: ValidDag
			readonly root: RelNode
	  }

/**
 * The violation queries of `theory`'s laws, the theory of `checked`, or the first refusal: each law's written in law
 * order, each primary key's law first, then every other law, from what its theory law carries (laws.ts lawViolation),
 * its sides resolved as the theory resolves them (lawSides); a rule over a query's the one its theory law carries,
 * checked here (theory.ts ruleViolation), labelled past them under its Forbid node (LabelSupply). The laws and their
 * identities are a pure function of the owned schema, and the builder allocates its identifiers in the same order for
 * the same laws, so every write of a schema's violation queries builds one DAG.
 *
 * Written at each call and held by none: its readers are a law model's artifact objects, once a model
 * (physical/install/plan.ts artifactObjects), and an installation's law checks, once a draft (deploy/snapshot
 * violation.ts lawChecks), each of which reads what it needs of them and drops them, where a memo keyed by schema and
 * theory held every level's for as long as its artifacts lived, though a level below the configured schema's is read
 * once and drafts nothing (metis's full installation as its change compile ran: eleven schemas' violation queries
 * alive, 28 to 44 MB each, 380 MB). An installation's are written twice, at its basis and at its draft (edullm's qti App 4.3 s
 * of CPU, metis's full installation 4.9 s).
 */
export const theoryViolations = (
	checked: CheckedSchema,
	theory: Theory
): Result.Result<TheoryViolations, CompileError> =>
	catchRefusal(() => {
		const sides = lawSides(checked)
		const vb = new ViolationBuilder(SourceLoc(`schema ${checked.owned.name}`, []))
		const statements = checked.owned.statements
		const written = theory.laws.map((law): Written => {
			const d = law.detail
			if (d.kind !== "rule") {
				return {
					kind: "built",
					id: law.id,
					forbid: vb.forbid(law.id, lawViolation(vb, sides, theory.families, statements, law, d))
				}
			}
			const admitted = unwrap(ruleViolation(checked, law, d.violation))
			return { kind: "query", id: law.id, query: admitted.dag, root: admitted.root }
		})
		const supply = new LabelSupply(
			vb.b.build(written.flatMap((w) => (w.kind === "built" ? [w.forbid] : [])))
		)
		const forbids = new Map<LawId, RelNode>(
			written.map((w) => [
				w.id,
				w.kind === "built" ? w.forbid : supply.forbid(w.query, w.root, w.id)
			])
		)
		return { dag: supply.dag([...forbids.values()]), forbids }
	})
