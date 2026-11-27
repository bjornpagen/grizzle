import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { type DrawnRole, drawnNamed } from "#compiler/analysis/theory/families.ts"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import type { Identifier, LawId } from "#compiler/core/ids.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { AxisKind, Family } from "#compiler/ir/family.ts"
import type { LawField } from "#compiler/ir/law.ts"

/**
 * The part a field grizzle draws or accumulates plays in what fills it (analysis/theory/families.ts Namings): its
 * family's or tree's index or count, a tree's parent, start or end, a fold's before, after or end of plane `plane`, or
 * the copy a containment riding a family's axis carries: along a tree's owner axis, the rule its root holds by
 * (`root`), its start, the axis's base, since the root has no parent to copy, so a draft that meets another rule there
 * draws the copy again.
 */
export type FillRole =
	| { readonly kind: DrawnRole }
	| { readonly kind: "before" | "after" | "foldEnd"; readonly plane: 0 | 1 }
	| { readonly kind: "copy"; readonly axis: AxisKind }
	| { readonly kind: "copy"; readonly axis: "owner"; readonly root: "base" }

/**
 * What fills a field grizzle draws or accumulates, and every law that says what the field holds. A field's values are
 * its filler's over the stored rows, so two fillers that differ in a role, a law or a carried pair fill it differently,
 * and one a declaration only renames fills it alike.
 *
 * - `stated`: a family's or tree's own field, or a fold's: its role and its laws, its family's first, then its fold's.
 * - `carried`: a copy a riding containment carries along an axis of `family`, whose law is `law`: the pair `from` ← `to`,
 *   its field `from` of the axis's `source` relation and the target row's field `to` of its `target`, and `carriers`, the containments that state the pair,
 *   in the theory's order. A copy holds its target's value along the axis whatever else those containments state, so
 *   it is its pair's, never its carriers': a draft reads the pair's carriers off the previous snapshot (FillSpelling
 *   `carriers`), and a sibling pair added to or taken from a carrier leaves every other copy it carries as it is.
 */
export type Filler =
	| {
			readonly kind: "stated"
			readonly role: Exclude<FillRole, { readonly kind: "copy" }>
			readonly laws: NonEmptyReadonlyArray<TheoryLaw>
	  }
	| CarriedFiller

/** A copy's filler (Filler `carried`). */
export interface CarriedFiller {
	readonly kind: "carried"
	readonly role: Extract<FillRole, { readonly kind: "copy" }>
	readonly family: Family
	readonly law: TheoryLaw
	readonly source: string
	readonly from: LawField
	readonly target: string
	readonly to: LawField
	readonly carriers: NonEmptyReadonlyArray<TheoryLaw>
}

/** How a writing record spells what fills a field (deploy/snapshot/build.ts fieldWriting): each law by its identifier,
 * a copy's carriers by the identifiers of the laws that state its pair, and a start by its literal, the schema's own
 * (ownFill), or as the previous snapshot names them (deploy/diff/declared.ts PreviousFill), none where it states no
 * such law. */
export interface FillSpelling {
	readonly law: (law: TheoryLaw) => Identifier<"law">
	readonly carriers: (copy: CarriedFiller) => NonEmptyReadonlyArray<LawId>
	readonly literal: (value: TypedLiteral, at: LawField) => TypedLiteral
}

/** The schema's own spelling of what fills a field. */
export const ownFill: FillSpelling = {
	law: (law) => law.id,
	carriers: (copy) => mapNonEmpty(copy.carriers, (law) => law.id),
	literal: (value) => value
}

/** The laws a filler's record digests, as `spell` spells them: a stated filler's laws, a copy's family's law then its
 * carriers. */
export const fillerLaws = (filler: Filler, spell: FillSpelling): NonEmptyReadonlyArray<LawId> =>
	filler.kind === "stated"
		? mapNonEmpty(filler.laws, spell.law)
		: [spell.law(filler.law), ...spell.carriers(filler)]

/**
 * The filler of every field the theory's families draw or accumulate, by relation and field name: each family's count,
 * a sequence's index and a tree's parent, start and end; each fold's named accumulators and ends; and each accumulated field an
 * axis carries beside those, its copy. The theory names each such field by exactly one statement (Namings), so each has
 * exactly one filler.
 */
export const fillersOf = (theory: Theory): ReadonlyMap<string, ReadonlyMap<string, Filler>> => {
	const byId = new Map<LawId, TheoryLaw>(theory.laws.map((l) => [l.id, l] as const))
	const law = (id: LawId): TheoryLaw => {
		const found = byId.get(id)
		if (found === undefined) {
			defect(`the law ${id} a family names is a law of the theory`)
		}
		return found
	}
	const out = new Map<string, Map<string, Filler>>()
	const put = (relation: string, field: string, filler: Filler): void => {
		const of = out.getOrInsertComputed(relation, () => new Map<string, Filler>())
		of.set(field, filler)
	}
	const filled = (relation: string, field: string): boolean =>
		out.get(relation)?.has(field) === true
	for (const f of theory.families) {
		const family = law(f.law)
		const member = f.member.name
		const owner = f.owner.name
		for (const d of drawnNamed(f)) {
			put(d.relation.name, d.field.name, { kind: "stated", role: { kind: d.role }, laws: [family] })
		}
		for (const fold of f.folds) {
			const laws: NonEmptyReadonlyArray<TheoryLaw> = [family, law(fold.law)]
			for (const [p, plane] of fold.planes.entries()) {
				const at: 0 | 1 = p === 0 ? 0 : 1
				for (const kind of ["before", "after"] as const) {
					const c = plane[kind]
					if (c.kind === "field") {
						put(member, c.field.name, { kind: "stated", role: { kind, plane: at }, laws })
					}
				}
				put(owner, plane.end.name, { kind: "stated", role: { kind: "foldEnd", plane: at }, laws })
			}
		}
		for (const axis of ["owner", "predecessor", "last"] as const) {
			const source = axis === "last" ? owner : member
			const target = axis === "owner" ? owner : member
			for (const pair of f.axes[axis]) {
				const from = pair.from
				if (
					from.kind === "field" &&
					from.field.writing.kind === "accumulated" &&
					!filled(source, from.field.name)
				) {
					if (pair.to.kind !== "field") {
						defect(
							`the axis pair that carries the accumulated field ${source}.${from.field.name} copies a field`
						)
					}
					put(source, from.field.name, {
						kind: "carried",
						role:
							axis === "owner" && f.shape.kind === "tree"
								? { kind: "copy", axis, root: "base" }
								: { kind: "copy", axis },
						family: f,
						law: family,
						source,
						from: from.field,
						target,
						to: pair.to.field,
						carriers: mapNonEmpty(pair.laws, law)
					})
				}
			}
		}
	}
	return out
}
