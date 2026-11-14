import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import type { Identifier, LawId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { AxisKind } from "#compiler/ir/family.ts"
import type { LawField } from "#compiler/ir/law.ts"

/**
 * The part a field grizzle draws or accumulates plays in what fills it (analysis/theory/families.ts Namings): its
 * family's or tree's index or count, a tree's parent, start or end, a fold's before, after or end of plane `plane`, or
 * the copy a containment riding a family's axis carries.
 */
export type FillRole =
	| { readonly kind: "index" | "count" | "parent" | "start" | "end" }
	| { readonly kind: "before" | "after" | "foldEnd"; readonly plane: 0 | 1 }
	| { readonly kind: "copy"; readonly axis: AxisKind }

/**
 * What fills a field grizzle draws or accumulates: its role, and every law that says what the field holds, its family's
 * first, then its fold's, or the laws its axis pair states. A field's values are its filler's over the stored rows, so
 * two fillers that differ in a role or a law fill it differently, and one a declaration only renames fills it alike.
 */
export interface Filler {
	readonly role: FillRole
	readonly laws: NonEmptyReadonlyArray<TheoryLaw>
}

/** How a writing record spells what fills a field (deploy/snapshot/build.ts fieldWriting): each law by its identifier
 * and a start by its literal, the schema's own (ownFill), or as the previous snapshot names them (restate.ts
 * PreviousSpelling). */
export interface FillSpelling {
	readonly law: (law: TheoryLaw) => Identifier<"law">
	readonly literal: (value: TypedLiteral, at: LawField) => TypedLiteral
}

/** The schema's own spelling of what fills a field. */
export const ownFill: FillSpelling = { law: (law) => law.id, literal: (value) => value }

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
			throw defect(`the law ${id} a family names is a law of the theory`)
		}
		return found
	}
	const out = new Map<string, Map<string, Filler>>()
	const put = (relation: string, field: string, filler: Filler): void => {
		const of = out.get(relation) ?? new Map<string, Filler>()
		of.set(field, filler)
		out.set(relation, of)
	}
	const filled = (relation: string, field: string): boolean =>
		out.get(relation)?.has(field) === true
	for (const f of theory.families) {
		const family = law(f.law)
		const member = f.member.name
		const owner = f.owner.name
		put(owner, f.count.name, { role: { kind: "count" }, laws: [family] })
		if (f.index.kind === "field") {
			put(member, f.index.field.name, { role: { kind: "index" }, laws: [family] })
		}
		if (f.members.kind === "tree") {
			put(member, f.members.parent.name, { role: { kind: "parent" }, laws: [family] })
			put(member, f.members.start.name, { role: { kind: "start" }, laws: [family] })
			put(member, f.members.end.name, { role: { kind: "end" }, laws: [family] })
		}
		for (const fold of f.folds) {
			const laws: NonEmptyReadonlyArray<TheoryLaw> = [family, law(fold.law)]
			for (const [p, plane] of fold.planes.entries()) {
				const at: 0 | 1 = p === 0 ? 0 : 1
				for (const kind of ["before", "after"] as const) {
					const c = plane[kind]
					if (c.kind === "field") {
						put(member, c.field.name, { role: { kind, plane: at }, laws })
					}
				}
				put(owner, plane.end.name, { role: { kind: "foldEnd", plane: at }, laws })
			}
		}
		for (const axis of ["owner", "predecessor", "last"] as const) {
			const source = axis === "last" ? owner : member
			for (const pair of f.axes[axis]) {
				const from = pair.from
				if (
					from.kind === "field" &&
					from.field.writing.kind === "accumulated" &&
					!filled(source, from.field.name)
				) {
					put(source, from.field.name, {
						role: { kind: "copy", axis },
						laws: [family, ...pair.laws.map(law)]
					})
				}
			}
		}
	}
	return out
}
