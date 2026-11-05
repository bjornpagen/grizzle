import type { LawIdentity, ResolvedSide } from "#compiler/analysis/theory/laws.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { everyFact, type SideDesc, type TermDesc } from "#compiler/ir/desc.ts"
import { fieldNames } from "#compiler/ir/law.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

/**
 * The public description of a law (types/changeset Law): what an `invariant-rejected` outcome names, built from the
 * law's identity, so two laws of one schema have the same description exactly when they are one law (theory.ts
 * lawStatement states the same parts as the naming door's identity). It is frozen, shared by every outcome that names
 * the law.
 *
 * A side names its terms and its selection's conjuncts, each as its Description states it.
 */
export const lawDescription = (law: LawIdentity): Law => {
	const side = sideOf
	const d = law.detail
	switch (d.kind) {
		case "key": {
			const fields = fieldNames(d.key.fields)
			return d.key.primary
				? Object.freeze({ kind: "primaryKey", relation: d.relation, fields: Object.freeze(fields) })
				: Object.freeze({
						kind: "key",
						side: Object.freeze({
							relation: d.relation,
							terms: Object.freeze(
								mapNonEmpty(d.key.fields, (f): TermDesc =>
									Object.freeze({ kind: "field", field: f.name })
								)
							),
							selection: everyFact
						})
					})
		}
		case "check":
			return Object.freeze({ kind: "check", relation: d.relation, name: d.name })
		case "contract":
			return contractLaw(d.contract)
		case "projectedKey":
			return Object.freeze({ kind: "key", side: side(d.side) })
		case "containment":
			return Object.freeze({
				kind: d.pairing.kind === "span" ? "coverage" : "contained",
				from: side(d.from),
				to: side(d.to)
			})
		case "alternatives":
			return Object.freeze({ kind: "alternatives", relation: d.parent, field: d.discriminator })
		case "alternativesArm":
			return Object.freeze({
				kind: "alternativesArm",
				relation: d.parent,
				field: d.discriminator,
				arm: d.arm,
				handles: Object.freeze(mapNonEmpty(d.handles, (h) => h))
			})
		case "capacity":
			return Object.freeze({
				kind: "capacity",
				target: side(d.target),
				from: side(d.from),
				weight: Object.freeze(
					d.weight.kind === "count"
						? { kind: "count" }
						: { kind: d.weight.kind, field: d.weight.field }
				),
				within: Object.freeze({
					low:
						typeof d.within.low === "bigint"
							? d.within.low
							: Object.freeze({ ref: d.within.low.ref }),
					high:
						typeof d.within.high === "bigint" || d.within.high === "*"
							? d.within.high
							: Object.freeze({ ref: d.within.high.ref })
				})
			})
	}
}

/** A contract's law, wherever its domain is installed (theory.ts contractLawIdentity): its name. */
export const contractLaw = (contract: string): Law => Object.freeze({ kind: "contract", contract })

/** A side of a law as its statement declares it: its relation, its terms and its selection's conjuncts. */
const sideOf = (side: ResolvedSide): SideDesc =>
	Object.freeze({
		relation: side.relation,
		terms: Object.freeze(
			mapNonEmpty(side.terms, (t): TermDesc => Object.freeze({ kind: t.kind, field: t.field }))
		),
		selection: Object.freeze({
			conjuncts: Object.freeze(side.selection.conjuncts.map((c) => c.predicate))
		})
	})
