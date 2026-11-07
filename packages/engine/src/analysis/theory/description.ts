import type {
	LawIdentity,
	ResolvedSide,
	ResolvedSourceSide
} from "#compiler/analysis/theory/laws.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import {
	everyFact,
	type SideDesc,
	type SourceSideDesc,
	type SourceTermDesc,
	type TermDesc
} from "#compiler/ir/desc.ts"
import type { Family } from "#compiler/ir/family.ts"
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
				from: sourceSideOf(d.from),
				to: side(d.to)
			})
		case "family":
			return Object.freeze({
				kind: "family",
				order: d.family.index.kind === "field" ? "ordered" : "counted",
				member: memberSide(d.family),
				slots: Object.freeze({ owner: d.family.id.owner, count: d.family.id.count })
			})
		case "tree":
			return Object.freeze({
				kind: "tree",
				member: memberSide(d.family),
				slots: Object.freeze({ owner: d.family.id.owner, count: d.family.id.count }),
				root: d.family.members.root.name
			})
		case "fold":
			return Object.freeze({
				kind: "fold",
				family: Object.freeze({ owner: d.family.owner, count: d.family.count }),
				monoid: d.monoid,
				step: side(d.step),
				end: side(d.end)
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

/**
 * A containment's source side as its statement declares it: its relation, its terms, each constant its literal as the
 * statement states it, and its selection's conjuncts.
 */
const sourceSideOf = (side: ResolvedSourceSide): SourceSideDesc =>
	Object.freeze({
		relation: side.relation,
		terms: Object.freeze(
			mapNonEmpty(side.terms, (t): SourceTermDesc =>
				t.kind === "constant"
					? Object.freeze({ kind: t.kind, value: t.value })
					: Object.freeze({ kind: t.kind, field: t.field })
			)
		),
		selection: Object.freeze({
			conjuncts: Object.freeze(side.selection.conjuncts.map((c) => c.predicate))
		})
	})

/** A family's member side as its statement declares it: every fact of its member, over its group then its index. */
const memberSide = (f: Pick<Family, "member" | "group" | "index">): SideDesc => {
	const group = mapNonEmpty(f.group, (p): TermDesc =>
		Object.freeze({ kind: "field", field: p.member.name })
	)
	const terms: SideDesc["terms"] =
		f.index.kind === "field"
			? [...group, Object.freeze({ kind: "field", field: f.index.field.name })]
			: group
	return Object.freeze({
		relation: f.member.name,
		terms: Object.freeze(terms),
		selection: everyFact
	})
}
