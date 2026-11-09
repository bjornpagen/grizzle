import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { ViolationBuilder } from "#compiler/analysis/theory/build.ts"
import { lawViolation } from "#compiler/analysis/theory/laws.ts"
import { lawSides, type Theory } from "#compiler/analysis/theory/theory.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type * as Result from "#compiler/core/result.ts"
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
 * its sides resolved as the theory resolves them (lawSides); a rule over a query's the one its theory law carries
 * checked, labelled past them under its Forbid node (LabelSupply). The laws and their identities are a pure function of
 * the owned schema, and the builder allocates its identifiers in the same order for the same laws, so every write of a
 * schema's violation queries builds one DAG.
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
			return d.kind === "rule"
				? { kind: "query", id: law.id, query: d.violation.dag, root: d.violation.root }
				: {
						kind: "built",
						id: law.id,
						forbid: vb.forbid(law.id, lawViolation(vb, sides, theory.families, statements, law, d))
					}
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
