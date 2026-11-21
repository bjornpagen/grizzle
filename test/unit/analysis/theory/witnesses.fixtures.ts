/** What the properties of witnesses.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	type NegatedArm,
	type QueryRule,
	type RuleSide,
	type SideArm,
	type Witness
} from "#compiler/analysis/theory/query.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { everyFact } from "#compiler/ir/desc.ts"

export const RELATIONS = 3

/** A negated arm as drawn: the relations its matches read, in order, and each arm it negates in turn. */
interface NegatedPlan {
	readonly matches: Arr.NonEmptyReadonlyArray<number>
	readonly negated: ReadonlyArray<Arr.NonEmptyReadonlyArray<number>>
}

/** An arm as drawn: the relations its matches read, in order, and each negated arm's. */
interface ArmPlan {
	readonly matches: Arr.NonEmptyReadonlyArray<number>
	readonly negated: ReadonlyArray<NegatedPlan>
}

/** A rule as drawn: its kind, its breaking arms, and a containment's target arms. */
type RulePlan =
	| { readonly kind: "check" | "key"; readonly arms: Arr.NonEmptyReadonlyArray<ArmPlan> }
	| {
			readonly kind: "contained"
			readonly arms: Arr.NonEmptyReadonlyArray<ArmPlan>
			readonly target: Arr.NonEmptyReadonlyArray<ArmPlan>
	  }

const relationGen: Gen<number> = int(0, RELATIONS - 1)

const relationsGen =
	(max: number): Gen<Arr.NonEmptyReadonlyArray<number>> =>
	(s) => [s.draw(relationGen), ...s.draw(array(relationGen, { min: 0, max: max - 1 }))]

const negatedGen: Gen<NegatedPlan> = (s) => ({
	matches: s.draw(relationsGen(2)),
	negated: s.draw(array(relationsGen(2), { min: 0, max: 1 }))
})

const armGen: Gen<ArmPlan> = (s) => ({
	matches: s.draw(relationsGen(3)),
	negated: s.draw(array(negatedGen, { min: 0, max: 2 }))
})

const armsGen: Gen<Arr.NonEmptyReadonlyArray<ArmPlan>> = (s) => [
	s.draw(armGen),
	...s.draw(array(armGen, { min: 0, max: 1 }))
]

export const planGen: Gen<RulePlan> = (s) => {
	const kind = s.draw(element<RulePlan["kind"]>(["check", "contained", "key"]))
	const arms = s.draw(armsGen)
	return kind === "contained" ? { kind, arms, target: s.draw(armsGen) } : { kind, arms }
}

const loc = SourceLoc("witnesses", [])

export const nameOf = (relation: number): string => `R${relation}`

/** A conjunctive arm reading `relations`, each match binding its field f to a variable of its own. */
const conjunctiveOf = (relations: Arr.NonEmptyReadonlyArray<number>, prefix: string) => {
	const vars = Arr.map(relations, (_, i) => ({ id: `${prefix}${i}`, origin: undefined, loc }))
	return {
		vars,
		matches: Arr.map(relations, (relation, i) => ({
			kind: "stored" as const,
			relation: nameOf(relation),
			bindings: { f: { kind: "var" as const, var: `${prefix}${i}` } },
			loc
		})),
		where: [],
		head: { f: { kind: "var" as const, var: `${prefix}0` } },
		negated: []
	}
}

const sideArmOf = (arm: ArmPlan, prefix: string): SideArm => ({
	...conjunctiveOf(arm.matches, `${prefix}m`),
	negated: Arr.map(arm.negated, (n, j): NegatedArm => ({
		arm: {
			...conjunctiveOf(n.matches, `${prefix}n${j}.`),
			negated: Arr.map(n.negated, (inner, i): NegatedArm => ({
				arm: conjunctiveOf(inner, `${prefix}n${j}.n${i}.`),
				bindings: { f: { kind: "var", var: `${prefix}n${j}.0` } }
			}))
		},
		bindings: { f: { kind: "var", var: `${prefix}m0` } }
	})),
	terms: [{ kind: "var", var: `${prefix}m0` }]
})

const sideOf = (arms: Arr.NonEmptyReadonlyArray<ArmPlan>, prefix: string): RuleSide => ({
	relation: "Live",
	terms: [{ kind: "field", field: "f" }],
	selection: everyFact,
	texts: [],
	heading: ["f"],
	arms: Arr.map(arms, (arm, i) => sideArmOf(arm, `${prefix}${i}.`))
})

/** The rule a plan draws, as the theory reads a rule over a query. */
export const ruleOf = (plan: RulePlan): QueryRule => {
	switch (plan.kind) {
		case "check":
			return {
				kind: "check",
				name: "Below",
				predicate: { kind: "literal", value: true },
				side: sideOf(plan.arms, "a")
			}
		case "key":
			return { kind: "key", side: sideOf(plan.arms, "a") }
		case "contained":
			return { kind: "contained", from: sideOf(plan.arms, "a"), to: sideOf(plan.target, "b") }
	}
}

/** The witnesses the plan states, by relation index, apart from query.ts. */
export const expectedWitnesses = (
	plan: RulePlan
): ReadonlyArray<{
	readonly rows: ReadonlyArray<number>
	readonly present: ReadonlyArray<number>
	readonly absent: ReadonlyArray<number>
}> => {
	/** What an arm's negated arms match, under one negation. */
	const negatedOf = (arm: ArmPlan) => Arr.flatMap(arm.negated, (n) => n.matches)
	/** What the arms its negated arms negate in turn match, under two negations. */
	const twiceOf = (arm: ArmPlan) => Arr.flatMap(arm.negated, (n) => Arr.flatten(n.negated))
	switch (plan.kind) {
		case "check":
			return Arr.map(plan.arms, (arm) => ({
				rows: arm.matches,
				present: twiceOf(arm),
				absent: negatedOf(arm)
			}))
		case "contained":
			return Arr.map(plan.arms, (arm) => ({
				rows: arm.matches,
				present: [...Arr.flatMap(plan.target, negatedOf), ...twiceOf(arm)],
				absent: [
					...negatedOf(arm),
					...Arr.flatMap(plan.target, (t) => [...t.matches, ...twiceOf(t)])
				]
			}))
		case "key":
			return Arr.flatMap(plan.arms, (arm, i) =>
				Arr.map(plan.arms.slice(i), (other) => ({
					rows: [...arm.matches, ...other.matches],
					present: [...twiceOf(arm), ...twiceOf(other)],
					absent: [...negatedOf(arm), ...negatedOf(other)]
				}))
			)
	}
}

/** A witness's three lists, as plain lists of relation names. */
export interface Named {
	readonly rows: ReadonlyArray<string>
	readonly present: ReadonlyArray<string>
	readonly absent: ReadonlyArray<string>
}

export const byName = (w: Witness): Named => ({
	rows: w.rows,
	present: w.present,
	absent: w.absent
})

export type Feature =
	| `a ${RulePlan["kind"]}`
	| "a match"
	| "a negated match"
	| "a match under two negations"
	| "a target match"
	| "a target negation"
	| "a target's match under two negations"
	| "a self-join"
	| "a relation an insert and a delete can both break"
	| "a relation the rule never reads"
