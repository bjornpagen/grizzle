import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { LawIdentity, ResolvedSide } from "#compiler/analysis/theory/laws.ts"
import type { LawSide, QueryRule, RuleLaw } from "#compiler/analysis/theory/query.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { GeneratedLawId } from "#compiler/core/ids.ts"
import { everyFact, type ExprDesc, type SideDesc, type TermDesc } from "#compiler/ir/desc.ts"
import { type Family, orderOf } from "#compiler/ir/family.ts"
import {
	fieldNames,
	type GeneratedLaw,
	generatedLaw,
	generationOf,
	type LawField,
	type TableRelation
} from "#compiler/ir/law.ts"
import type { OwnLaw } from "#compiler/types/changeset/changeset.ts"

/**
 * The public description of a law (types/changeset Law): what an `invariant-rejected` outcome names, built from the
 * law's identity, so two laws of one schema have the same description exactly when they are one law (theory.ts
 * lawStatement states the same parts as the naming door's identity). It is frozen, shared by every outcome that names
 * the law.
 *
 * A side names its terms and its selection's conjuncts, each as its Description states it.
 */
export const lawDescription = (law: LawIdentity): OwnLaw => {
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
				order: orderOf(d.family),
				member: memberSide(d.family),
				slots: Object.freeze({ owner: d.family.id.owner, count: d.family.id.count })
			})
		case "tree": {
			const terms: SideDesc["terms"] = [
				Object.freeze({ kind: "field", field: d.family.shape.parent.name }),
				Object.freeze({ kind: "field", field: d.family.shape.index.field.name })
			]
			return Object.freeze({
				kind: "tree",
				member: Object.freeze({
					relation: d.family.member.name,
					terms: Object.freeze(terms),
					selection: everyFact
				}),
				slots: Object.freeze({ owner: d.family.id.owner, count: d.family.id.count }),
				root: Object.freeze(mapNonEmpty(d.family.shape.root, (r) => r.name))
			})
		}
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
const ruleDescription = (rule: QueryRule): OwnLaw => {
	switch (rule.kind) {
		case "contained":
		case "key":
		case "check":
			return ruleLawDescription(rule)
		case "whole":
			return ruleLawDescription(rule.law)
	}
}

/** A rule over a query's law as an outcome names it (`ruleDescription`). */
const ruleLawDescription = (law: RuleLaw<LawSide>): OwnLaw => {
	switch (law.kind) {
		case "contained":
			return Object.freeze({
				kind: "contained",
				from: ruleSideOf(law.from),
				to: ruleSideOf(law.to)
			})
		case "key":
			return Object.freeze({ kind: "key", side: ruleSideOf(law.side) })
		case "check":
			return Object.freeze({ kind: "check", relation: law.side.relation, name: law.name })
	}
}

/** A rule over a query's side as its statement declares it. */
const ruleSideOf = (side: LawSide): SideDesc => sideDesc(side, [...side.selection.conjuncts])

/** A contract's law, wherever its domain is installed (theory.ts contractLawIdentity): its name. */
export const contractLaw = (contract: string): OwnLaw =>
	Object.freeze({ kind: "contract", contract })

/**
 * A stored field generated from its row, by PostgreSQL or, a key generation, by grizzle (ir/law.ts generationOf): its
 * relation, the field, the field's law (generatedLaw) and the law's identifier
 * (core/identity.ts generatedLaw), which no fingerprinted part of a snapshot holds.
 */
export interface GeneratedFieldLaw {
	readonly relation: TableRelation
	readonly field: LawField
	readonly law: GeneratedLaw
	readonly id: GeneratedLawId
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
			generationOf(field) !== undefined
				? [
						Object.freeze({
							relation,
							field,
							law: generatedLaw(relation.name, field.name),
							id: identifierOf(identity.generatedLaw(relation.name, field.name))
						})
					]
				: []
		)
	)

/** A side of a law as its statement declares it: its relation, its terms and its selection's conjuncts. */
const sideOf = (side: ResolvedSide): SideDesc =>
	sideDesc(
		side,
		side.selection.conjuncts.map((c) => c.predicate)
	)

/** A side's Description: its relation, its terms, and `conjuncts`, its selection's, frozen in place. */
const sideDesc = (
	side: Pick<SideDesc, "relation" | "terms">,
	conjuncts: Array<ExprDesc>
): SideDesc =>
	Object.freeze({
		relation: side.relation,
		terms: Object.freeze(
			mapNonEmpty(side.terms, (t): TermDesc => Object.freeze({ kind: t.kind, field: t.field }))
		),
		selection: Object.freeze({ conjuncts: Object.freeze(conjuncts) })
	})

/** A family's member side as its statement declares it: every fact of its member, over its group then its index. */
const memberSide = (f: Pick<Family, "member" | "group" | "shape">): SideDesc => {
	const group = mapNonEmpty(f.group, (p): TermDesc =>
		Object.freeze({ kind: "field", field: p.member.name })
	)
	const terms: SideDesc["terms"] =
		f.shape.index.kind === "field"
			? [...group, Object.freeze({ kind: "field", field: f.shape.index.field.name })]
			: group
	return Object.freeze({
		relation: f.member.name,
		terms: Object.freeze(terms),
		selection: everyFact
	})
}
