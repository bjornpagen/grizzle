import { viewContainments } from "#compiler/analysis/derived/drawn.ts"
import { type CatalogKey, theoryCatalog } from "#compiler/analysis/physical/evidence.ts"
import type { DerivedAnalysis } from "#compiler/analysis/schema.ts"
import type { EvidencedTheory } from "#compiler/analysis/theory/theory.ts"
import { type EvidenceCatalog, type ExistenceConstraint, strongest } from "#compiler/ir/evidence.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"

/**
 * Each containment's existence evidence a query may rely on, read off the theory's containment laws alone, whatever
 * discharges each (laws/model/plan.ts ContainmentDischarge): its two sides, the law, and the context the law model's
 * discharge of it holds in, immediate exactly where an immediate native holds it at every statement (the law model's
 * `immediate`), committed-snapshot where a deferred foreign key or the rule judge holds it at COMMIT. A coverage law
 * proves coverage of a span, not the existence of one matching fact, and a containment with a selected side holds only
 * for the facts its selector picks, which no catalog can say: neither gives evidence. The law model states them once
 * (LawModel.existence).
 */
export const existenceConstraints = (
	containments: EvidencedTheory["evidence"]["containments"]
): ReadonlyArray<ExistenceConstraint> =>
	containments.flatMap((c): ReadonlyArray<ExistenceConstraint> =>
		c.coverage || c.from.selection.length > 0 || c.to.selection.length > 0
			? []
			: [
					{
						from: { relation: c.from.relation, fields: c.from.fields },
						to: { relation: c.to.relation, fields: c.to.fields },
						laws: [c.law],
						context: c.context
					}
				]
	)

/**
 * What the derived relations of a schema prove: each one's inherited keys, the first its primary one, each with the
 * unique index its view is installed with, and the containments its definition draws (analysis/derived/drawn.ts
 * viewContainments). An evidence catalog resolves a view's key to its index and reads its containments beside the
 * declared ones (evidenceCatalog).
 */
export interface ViewEvidence {
	readonly keys: ReadonlyArray<CatalogKey>
	readonly containments: ReadonlyArray<ExistenceConstraint>
}

/** No derived relation's evidence: a catalog over the base relations alone. */
export const noViewEvidence: ViewEvidence = { keys: [], containments: [] }

/**
 * The evidence of a schema's derived relations (ViewEvidence), their containments grounded on `existence`, the
 * declared containments' (LawModel.existence):
 *
 * - each inherited key with its unique index, so every compilation that reads a view relies on exactly the indexes the
 *   installation creates; a view's unique index compares its spans as values;
 * - each containment a definition draws, the view's columns in the target's fields, resting on the laws of the declared
 *   containments its draw rides on, in the strongest of their contexts and committed snapshot, where the view's table
 *   holds its definition's rows: every committed state's. A draw riding on a containment no existence evidence states
 *   (a coverage or a selected side) proves nothing and is dropped.
 */
export const derivedEvidence = (
	analysis: DerivedAnalysis,
	existence: ReadonlyArray<ExistenceConstraint>
): ViewEvidence => ({
	keys: analysis.order.flatMap((a) =>
		a.keys.map((k): CatalogKey => ({
			relation: a.name,
			fields: k.fields,
			spans: [],
			kind: "uniqueIndex",
			constraint: k.index
		}))
	),
	containments: analysis.order.flatMap((a) =>
		viewContainments(analysis.schema.owned, a.query.dag.roots[0]).flatMap(
			(c): ReadonlyArray<ExistenceConstraint> => {
				const hops = c.through.map((h) =>
					existence.filter((e) => e.from.relation === h.relation && e.to.relation === h.target)
				)
				if (hops.some((h) => h.length === 0)) {
					return []
				}
				const rides = hops.flat()
				return [
					{
						from: { relation: a.name, fields: c.pairs.map((p) => p.left) },
						to: { relation: c.target, fields: c.pairs.map((p) => p.right) },
						laws: rides.flatMap((e) => e.laws),
						context: strongest(["committedSnapshot", ...rides.map((e) => e.context)])
					}
				]
			}
		)
	)
})

/** What a catalog is built from: the schema's law model, and its derived relations' evidence (derivedEvidence). */
export interface CatalogSchema {
	readonly laws: LawModel
	readonly views: ViewEvidence
}

/** The catalog of a schema.
 *
 * The evidence catalog a schema's templates are compiled against: the one builder every compilation's catalog comes
 * from (a query, a write's placement and read-backs, a derived definition's installation), so each relies on exactly
 * the constraints and indexes the installation creates.
 *
 * Every key a rewrite may rely on resolves to the constraint ownership derived for it, a derived relation's inherited
 * key to the unique index its view is installed with (derivedEvidence), and every containment to the native
 * object the law model specialized it into (LawModel.existence, existenceConstraints). The kind follows the object: an
 * immediate foreign key, a deferred one, a PERIOD foreign key, a roster's domain, or a table CHECK reading a closed
 * side's constant (ClosedCheck). The evidence admission (`admit`) then decides, per execution context, which of them
 * may prove anything. */
export const evidenceCatalog = (schema: CatalogSchema): EvidenceCatalog =>
	theoryCatalog(
		{ keys: [...schema.laws.theory.evidence.keys, ...schema.views.keys] },
		{
			containments: [...schema.laws.existence, ...schema.views.containments],
			relations: schema.laws.theory.relations
		}
	)
