import { type CatalogKey, theoryCatalog } from "#compiler/analysis/physical/evidence.ts"
import type { DerivedAnalysis } from "#compiler/analysis/schema.ts"
import type { EvidencedTheory } from "#compiler/analysis/theory/theory.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import type { Enforcement, EvidenceCatalog, ExistenceConstraint } from "#compiler/ir/evidence.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"

type ExistenceKind = ExistenceConstraint["kind"]

/** The existence kind a native object enforces a containment as, if it is one that does. A native is either the object
 * that installs the containment, or no existence evidence at all. */
const existenceKind = (native: NamedNative["object"]): ExistenceKind | undefined => {
	switch (native.kind) {
		case "ForeignKey":
			return native.deferrable ? "deferredForeignKey" : "foreignKey"
		case "PeriodForeignKey":
			return "periodForeignKey"
		case "ClosedCheck":
			return "check"
		case "PrimaryKey":
		case "Unique":
		case "Domain":
		case "RosterDomain":
		case "TableCheck":
		case "LawColumn":
		case "WithoutOverlaps":
		case "ReverseIndex":
			return undefined
	}
}

/** The enforcement by an installed constraint, keyed by its installed name. */
const constraintEnforcement = (name: ConstraintName): Enforcement => ({ kind: "constraint", name })

/** The enforcement of a containment law, with its kind. */
interface Enforced {
	readonly enforcement: Enforcement
	readonly kind: ExistenceKind
}

/** A native object's enforcement of `law`, when it discharges the law and is of an existence kind. A native with an
 * installed name is a constraint; a roster's domain types the field, which no constraint of the law names. */
const nativeEnforcement = (n: NamedNative, law: LawId): Enforced | undefined => {
	if (!n.object.lawIds.some((raised) => raised === law)) {
		return undefined
	}
	switch (n.namespace) {
		case "constraint": {
			const kind = existenceKind(n.object)
			return kind === undefined
				? undefined
				: { enforcement: constraintEnforcement(identifierOf(n.named)), kind }
		}
		case "unnamed":
			return n.object.kind === "RosterDomain"
				? { enforcement: { kind: "type", roster: n.object.name }, kind: "rosterDomain" }
				: undefined
		case "column":
		case "domain":
			return undefined
	}
}

/**
 * Each containment's existence evidence a query may rely on, from the law model's evidence and natives: its two sides,
 * the native object that enforces it with its kind, and its evidence context, the one the law model gave the
 * containment, immediate exactly when its enforcement holds at every statement (the law model's `immediate`),
 * committed-snapshot otherwise. A containment's enforcement is the first native object of an existence kind that
 * discharges its law, a containment that rides a family axis enforced by the axis's foreign key, which discharges its
 * law. A coverage law proves coverage of a span, not the existence of one matching fact, and a containment with a
 * selected side holds only for the facts its selector picks, which no catalog can say: neither gives evidence, and nor
 * does a containment no native enforces. The law model states them once (LawModel.existence).
 */
export const existenceConstraints = (
	containments: EvidencedTheory["evidence"]["containments"],
	natives: ReadonlyArray<NamedNative>
): ReadonlyArray<ExistenceConstraint> => {
	const enforced = new Map<LawId, Enforced>()
	for (const n of natives) {
		for (const law of n.object.lawIds) {
			const e = enforced.has(law) ? undefined : nativeEnforcement(n, law)
			if (e !== undefined) {
				enforced.set(law, e)
			}
		}
	}
	return containments.flatMap((c): ReadonlyArray<ExistenceConstraint> => {
		const e = enforced.get(c.law)
		return c.coverage || c.from.selection.length > 0 || c.to.selection.length > 0 || e === undefined
			? []
			: [
					{
						from: { relation: c.from.relation, fields: c.from.fields },
						to: { relation: c.to.relation, fields: c.to.fields },
						enforcement: e.enforcement,
						kind: e.kind,
						context: c.context
					}
				]
	})
}

/** Every derived relation's inherited keys, the first its primary one, each with the unique index its view is installed
 * with: the keys an evidence catalog resolves a view's key to (evidenceCatalog), so every
 * compilation that reads a view relies on exactly the indexes the installation creates. A view's unique index compares
 * its spans as values. */
export const derivedKeyConstraints = (analysis: DerivedAnalysis): ReadonlyArray<CatalogKey> =>
	analysis.order.flatMap((a) =>
		a.keys.map((k, i): CatalogKey => ({
			relation: a.name,
			fields: k.fields,
			spans: [],
			primary: i === 0,
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
