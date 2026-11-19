import { type CatalogKey, theoryCatalog } from "#compiler/analysis/physical/evidence.ts"
import type { DerivedAnalysis } from "#compiler/analysis/schema.ts"
import type { EvidencedTheory } from "#compiler/analysis/theory/theory.ts"
import type { EvidenceCatalog, ExistenceConstraint } from "#compiler/ir/evidence.ts"
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
						law: c.law,
						context: c.context
					}
				]
	)

/** Every derived relation's inherited keys, the first its primary one, each with the unique index its view is installed
 * with: the keys an evidence catalog resolves a view's key to (evidenceCatalog), so every
 * compilation that reads a view relies on exactly the indexes the installation creates. A view's unique index compares
 * its spans as values. */
export const derivedKeyConstraints = (analysis: DerivedAnalysis): ReadonlyArray<CatalogKey> =>
	analysis.order.flatMap((a) =>
		a.keys.map((k): CatalogKey => ({
			relation: a.name,
			fields: k.fields,
			spans: [],
			kind: "uniqueIndex",
			constraint: k.index
		}))
	)

/** What a catalog is built from: the schema's law model, and its derived relations' inherited keys with their views'
 * unique indexes. */
export interface CatalogSchema {
	readonly laws: LawModel
	readonly views: ReadonlyArray<CatalogKey>
}

/** The catalog of a schema.
 *
 * The evidence catalog a schema's templates are compiled against: the one builder every compilation's catalog comes
 * from (a query, a write's placement and read-backs, a derived definition's installation), so each relies on exactly
 * the constraints and indexes the installation creates.
 *
 * Every key a rewrite may rely on resolves to the constraint ownership derived for it, a derived relation's inherited
 * key to the unique index its view is installed with (derivedKeyConstraints), and every containment to the native
 * object the law model specialized it into (LawModel.existence, existenceConstraints). The kind follows the object: an
 * immediate foreign key, a deferred one, a PERIOD foreign key, a roster's domain, or a table CHECK reading a closed
 * side's constant (ClosedCheck). The evidence admission (`admit`) then decides, per execution context, which of them
 * may prove anything. */
export const evidenceCatalog = (schema: CatalogSchema): EvidenceCatalog =>
	theoryCatalog(
		{ keys: [...schema.laws.theory.evidence.keys, ...schema.views] },
		{ containments: schema.laws.existence, relations: schema.laws.theory.relations }
	)
