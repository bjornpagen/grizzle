import type { LawIdentity, ResolvedSide } from "#compiler/analysis/theory/laws.ts"
import type { QueryRule, RuleSide } from "#compiler/analysis/theory/query.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { everyFact, type SideDesc, type TermDesc } from "#compiler/ir/desc.ts"
import type { Family } from "#compiler/ir/family.ts"
import { fieldNames, type LawField, type TableRelation } from "#compiler/ir/law.ts"
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
		case "rule":
			return ruleDescription(d.rule)
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

/**
 * A rule over a query as an outcome names it, as the same rule over stored relations is: a containment by its sides, a
 * key by its side, a check by its relation and name, a side's relation the derived relation it reads.
 */
const ruleDescription = (rule: QueryRule): Law => {
	switch (rule.kind) {
		case "contained":
			return Object.freeze({
				kind: "contained",
				from: ruleSideOf(rule.from),
				to: ruleSideOf(rule.to)
			})
		case "key":
			return Object.freeze({ kind: "key", side: ruleSideOf(rule.side) })
		case "check":
			return Object.freeze({ kind: "check", relation: rule.side.relation, name: rule.name })
	}
}

/** A rule over a query's side as its statement declares it. */
const ruleSideOf = (side: RuleSide): SideDesc =>
	Object.freeze({
		relation: side.relation,
		terms: Object.freeze(
			mapNonEmpty(side.terms, (t): TermDesc => Object.freeze({ kind: t.kind, field: t.field }))
		),
		selection: Object.freeze({ conjuncts: Object.freeze([...side.selection.conjuncts]) })
	})

/** A contract's law, wherever its domain is installed (theory.ts contractLawIdentity): its name. */
export const contractLaw = (contract: string): Law => Object.freeze({ kind: "contract", contract })

/** The law a generated field states, that its term has a value at every row: what refuses a row where it is NULL. */
export type GeneratedLaw = Extract<Law, { readonly kind: "generated" }>

/**
 * A generated field's law, by its relation and field: the one description every refusal of a generated field with no
 * value names, whether the host finds it filling a row or PostgreSQL's NOT NULL refuses the row (23502).
 */
export const generatedLaw = (relation: string, field: string): GeneratedLaw =>
	Object.freeze({ kind: "generated", relation, field })

/** A stored field PostgreSQL generates: its relation, the field, and the field's law (generatedLaw). */
export interface GeneratedFieldLaw {
	readonly relation: TableRelation
	readonly field: LawField
	readonly law: GeneratedLaw
}

/**
 * The generated fields of `relations`, in their order, each relation's fields in declared order, each with its law:
 * what a NOT NULL violation on a generated column reports (adapter/witness/keylaw.ts generatedOf) and what lawsOf
 * lists, read from these same fields, so the two can never disagree.
 */
export const generatedFieldLaws = (
	relations: ReadonlyArray<TableRelation>
): ReadonlyArray<GeneratedFieldLaw> =>
	relations.flatMap((relation) =>
		relation.fields.flatMap((field): ReadonlyArray<GeneratedFieldLaw> =>
			field.writing.kind === "generated"
				? [Object.freeze({ relation, field, law: generatedLaw(relation.name, field.name) })]
				: []
		)
	)

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
