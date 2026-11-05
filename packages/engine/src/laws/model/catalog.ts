import { type CatalogKey, theoryCatalog } from "#compiler/analysis/physical/evidence.ts"
import type { DerivedAnalysis } from "#compiler/analysis/schema.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { Enforcement, EvidenceCatalog, ExistenceConstraint } from "#compiler/ir/evidence.ts"
import { lawUnits } from "#compiler/ir/law.ts"
import type { LawModel, NamedNative } from "#compiler/laws/model/model.ts"

type ExistenceKind = ExistenceConstraint["kind"]

/** The existence kind a native object enforces a containment as, if it is one that does. A native is either the object
 * that installs the containment, or no existence evidence at all. */
const existenceKind = (native: NamedNative["object"]): ExistenceKind | undefined => {
	switch (native.kind) {
		case "ForeignKey":
			return native.deferrable ? "deferredForeignKey" : "foreignKey"
		case "TaggedForeignKey":
		case "ArmForeignKey":
			return "deferredForeignKey"
		case "PeriodForeignKey":
		case "TaggedPeriodForeignKey":
			return "periodForeignKey"
		case "Enum":
		case "FiniteCheck":
			return "enum"
		case "PrimaryKey":
		case "Unique":
		case "PartialUnique":
		case "Domain":
		case "TableCheck":
		case "StoredTag":
		case "ArmTag":
		case "ArmUnique":
		case "WithoutOverlaps":
		case "TemporalUnique":
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
 * installed name is a constraint; an enum is installed by its closed relation's type, which no constraint names. */
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
			return n.object.kind === "Enum"
				? { enforcement: { kind: "type", enum: n.object.name }, kind: "enum" }
				: undefined
		case "index":
		case "column":
		case "domain":
			return undefined
	}
}

/** The enforcement of a containment law, with its kind: the first native object of an existence kind that discharges
 * the law, or its residual law's units, every unit function a premise. */
const enforcement = (laws: LawModel, law: LawId): Enforced | undefined => {
	for (const n of laws.natives) {
		const enforced = nativeEnforcement(n, law)
		if (enforced !== undefined) {
			return enforced
		}
	}
	const residual = laws.residuals.find((r) => r.lawId === law)
	return residual === undefined
		? undefined
		: {
				enforcement: {
					kind: "residualLaw",
					functions: mapNonEmpty(lawUnits(residual), (u) => identifierOf(u.unit.function))
				},
				kind: "residualLaw"
			}
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
 * object or residual law the law model specialized it into. The kind follows the object: an immediate foreign key, a
 * deferred one (tagged, arm and PERIOD foreign keys are always deferred), a residual law, or a finite closed
 * domain (an enum or a finite CHECK). A coverage law proves coverage of a span, not the existence of one matching fact,
 * and a containment with a selected side holds only for the facts its selector picks, which the catalog cannot say: neither
 * gives evidence here. The evidence context is the one the law model gave the
 * containment: immediate exactly when its enforcement holds at every statement (the law model's `immediate`),
 * committed-snapshot otherwise. The evidence admission (`admit`) then decides, per execution context, which of
 * them may prove anything. */
export const evidenceCatalog = (schema: CatalogSchema): EvidenceCatalog => {
	const laws = schema.laws
	const containments = laws.theory.evidence.containments.flatMap(
		(c): ReadonlyArray<ExistenceConstraint> => {
			if (c.coverage || c.from.selection.length > 0 || c.to.selection.length > 0) {
				return []
			}
			const enforced = enforcement(laws, c.law)
			return enforced === undefined
				? []
				: [
						{
							from: { relation: c.from.relation, fields: c.from.fields },
							to: { relation: c.to.relation, fields: c.to.fields },
							enforcement: enforced.enforcement,
							kind: enforced.kind,
							context: c.context
						}
					]
		}
	)
	return theoryCatalog({ keys: [...laws.theory.evidence.keys, ...schema.views] }, { containments })
}
