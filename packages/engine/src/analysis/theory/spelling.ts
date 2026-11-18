import type { ResolvedSelection, ResolvedSide } from "#compiler/analysis/theory/laws.ts"
import type { LawStatement, Part } from "#compiler/core/identity.ts"
import { termText } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { FamilyId, LawField, TheoryRelation } from "#compiler/ir/law.ts"

/** A conjunct of a side as a law's statement spells it: its canonical text, and the names of the fields of its relation
 * it reads, in the relation's field order. */
export interface SpelledConjunct {
	readonly text: string
	readonly reads: ReadonlyArray<string>
}

/**
 * How a statement spells what it names: each relation and roster by its name, each field by its own name on its
 * relation, each selection by its conjuncts in canonical order, and each literal by its value at the field it meets.
 * The schema's own spelling (ownSpelling) names each as the schema declares it, which is what every installed name is
 * minted from. A draft spells the target's statements as the previous snapshot names what they read
 * (laws/model/restate.ts), so a statement a declared rename only renames has the identity the previous snapshot
 * recorded for it.
 */
export interface Spelling {
	readonly relation: (relation: string) => string
	readonly field: (relation: string, field: string) => string
	readonly conjuncts: (
		relation: TheoryRelation,
		selection: ResolvedSelection
	) => ReadonlyArray<SpelledConjunct>
	readonly literal: (value: TypedLiteral, at: LawField) => TypedLiteral
}

/** The schema's own spelling: every name as the schema declares it. */
export const ownSpelling: Spelling = Object.freeze({
	relation: (relation: string) => relation,
	field: (_relation: string, field: string) => field,
	conjuncts: (_relation: TheoryRelation, selection: ResolvedSelection) =>
		selection.conjuncts.map((c) => ({ text: c.text, reads: c.reads.map((f) => f.name) })),
	literal: (value: TypedLiteral) => value
})

/** A term of a side as a statement's display and stem spell it: a field, or pred of one. */
const spelledTerm = (
	side: ResolvedSide,
	t: ResolvedSide["terms"][number],
	spell: Spelling
): string => termText({ ...t, field: spell.field(side.relation, t.field) })

/** A side as a law's identity states it: its relation, its terms, and its conjuncts by their canonical texts. */
export const sidePart = (side: ResolvedSide, spell: Spelling): Part => [
	spell.relation(side.relation),
	side.terms.map((t) => [t.kind, spell.field(side.relation, t.field)]),
	spell.conjuncts(side.rel, side.selection).map((c) => c.text)
]

/** A side as a law's stem spells it: its relation, then the fields each conjunct reads. */
export const sideStem = (side: ResolvedSide, spell: Spelling): ReadonlyArray<string> => [
	spell.relation(side.relation),
	...spell.conjuncts(side.rel, side.selection).flatMap((c) => c.reads)
]

/** A side's terms as a law's stem spells them. */
export const sideTerms = (side: ResolvedSide, spell: Spelling): ReadonlyArray<string> =>
	side.terms.map((t) => spelledTerm(side, t, spell))

/** A side as a law's display spells it: its relation and terms, then each conjunct by its canonical text. */
export const sideDisplay = (side: ResolvedSide, spell: Spelling): string => {
	const conjuncts = spell.conjuncts(side.rel, side.selection)
	return `${spell.relation(side.relation)}(${sideTerms(side, spell).join(", ")})${
		conjuncts.length === 0 ? "" : ` where ${conjuncts.map((c) => c.text).join(" and ")}`
	}`
}

/** fin(O, n), a family's slots as a statement spells them. */
export const spelledSlots = (id: FamilyId, spell: Spelling): string =>
	`fin(${spell.relation(id.owner)}, ${spell.field(id.owner, id.count)})`

/**
 * What kind of family a law states: a tree, whose terms are its root fields, its parent and its index, or an ordered or
 * counted family.
 */
export type FamilyKind =
	| { readonly kind: "tree" }
	| { readonly kind: "family"; readonly order: "ordered" | "counted" }

/** What a family's or a tree's law states: its slots, its member, the member's terms (its group fields in key order,
 * then its index field where the index is a field), and its kind. */
export interface FamilyStated {
	readonly id: FamilyId
	readonly member: string
	readonly terms: ReadonlyArray<LawField>
	readonly kind: FamilyKind
}

/**
 * A family's or a tree's law as the naming door states it: a family by its order, its slots and its member's terms, a
 * tree by its slots and its member's terms, its root fields first, each led by the law's shape. The one statement both
 * the law and the drawn law columns it names (analysis/theory/families.ts) are minted from.
 */
export const familyStatement = (f: FamilyStated, spell: Spelling): LawStatement => {
	const member = spell.relation(f.member)
	const owner = spell.relation(f.id.owner)
	const count = spell.field(f.id.owner, f.id.count)
	const terms = f.terms.map((x) => spell.field(f.member, x.name))
	const slots = spelledSlots(f.id, spell)
	switch (f.kind.kind) {
		case "tree":
			return {
				parts: ["tree", owner, count, terms],
				stem: [member, "tree", count],
				display: `tree ${member}(${terms.join(", ")}) in ${slots}`
			}
		case "family": {
			const order = f.kind.order
			return {
				parts: ["family", order, owner, count, member, terms],
				stem: [member, order, owner, count],
				display: `${order} ${member}(${terms.join(", ")}) in ${slots}`
			}
		}
	}
}
