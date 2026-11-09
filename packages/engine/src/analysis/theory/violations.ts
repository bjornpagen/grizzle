import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { ViolationBuilder } from "#compiler/analysis/theory/build.ts"
import type { KeptLaw } from "#compiler/analysis/theory/laws.ts"
import { normalizedLaws } from "#compiler/analysis/theory/theory.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
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
 * The violation queries of an owned schema's laws, or the first refusal: its laws normalized as the theory normalizes
 * them (normalizedLaws), so each is the theory law of its id, the families resolved into the builder first, since a
 * family's, a tree's and a fold's arms read them, then each law's violation query in law order, each primary key's
 * law first, then every other law, a rule over a query's checked and labelled past them under its Forbid node
 * (LabelSupply). The laws and their identities are a pure function of the owned schema, and the builder allocates its
 * identifiers in the same order for the same laws, so every write of a schema's violation queries builds one DAG.
 */
export const theoryViolations = (
	checked: CheckedSchema
): Result.Result<TheoryViolations, CompileError> =>
	catchRefusal(() => {
		const normalizer = normalizedLaws(checked)
		const vb = new ViolationBuilder(SourceLoc(`schema ${checked.owned.name}`, []))
		normalizer.resolve(vb)
		const write = (k: KeptLaw): Written => {
			const id = identifierOf(k.named)
			const writing = k.draft.write
			switch (writing.kind) {
				case "built":
					return { kind: "built", id, forbid: vb.forbid(id, writing.violation(vb)) }
				case "query": {
					const query = checkQuery(checked, writing.violation, {
						read: "rows",
						label: `rule ${k.named.display}`
					})
					if (!query.ok) {
						throw new Refusal(query.error)
					}
					return { kind: "query", id, query: query.value.dag, root: query.value.dag.roots[0] }
				}
			}
		}
		const written = [
			...normalizer.primaryKeys.map((p) => write(p.kept)),
			...normalizer.laws.map(write)
		]
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
