/**
 * The witnesses of a rule over a query (analysis/theory/query.ts witnesses) are the shapes its violation takes, by the
 * occurrences of the relations it reads, and they name exactly the writes its triggers fire on (query.ts touches,
 * physical/ddl/rules.ts eventsOf), which the isolation certifier reads them for (analysis/isolation/certify.ts laws).
 *
 * The box: rules of each kind, a check, a containment and a key, drawn as their arms over three relations, R0 to R2,
 * one or two breaking arms and, for a containment, one or two target arms, each arm one to three matches, so one
 * relation may stand twice in an arm (a self-join), and none to two negated arms of one or two matches each.
 *
 * Oracle: the drawn plan itself, read apart from query.ts:
 *
 * - Witnesses: a check has one per breaking arm, its rows the arm's matches, every occurrence, its absences its negated
 *   arms' matches; a containment one per source arm, its rows the arm's matches, its absences the arm's negated
 *   matches then every target arm's matches, its presences every target arm's negated matches; a key one per pair of
 *   breaking arms, an arm with itself and with every later arm, its rows both arms' matches, its absences both arms'
 *   negated matches. Each list is a multiset in the plan's order, so an occurrence counted once for two fails.
 * - Touches agreement: for each relation, an INSERT of it can break the rule (Touches `news` or `both`) exactly when it
 *   stands among some witness's rows or presences, and a DELETE (`olds` or `both`) exactly when it stands among some
 *   witness's absences; neither when no witness reads it, where touches gives none.
 *
 * Features: each rule kind; a match, a negated match, a target match and a target negation; a self-join; a relation
 * both inserted and deleted into breaking (`both`); and a relation the rule never reads.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type NegatedArm,
	type QueryRule,
	type RuleSide,
	type SideArm,
	touches,
	type Witness,
	witnesses
} from "#compiler/analysis/theory/query.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { everyFact } from "#compiler/ir/desc.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const RELATIONS = 3

/** An arm as drawn: the relations its matches read, in order, and each negated arm's. */
interface ArmPlan {
	readonly matches: Arr.NonEmptyReadonlyArray<number>
	readonly negated: ReadonlyArray<Arr.NonEmptyReadonlyArray<number>>
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

const armGen: Gen<ArmPlan> = (s) => ({
	matches: s.draw(relationsGen(3)),
	negated: s.draw(array(relationsGen(2), { min: 0, max: 2 }))
})

const armsGen: Gen<Arr.NonEmptyReadonlyArray<ArmPlan>> = (s) => [
	s.draw(armGen),
	...s.draw(array(armGen, { min: 0, max: 1 }))
]

const planGen: Gen<RulePlan> = (s) => {
	const kind = s.draw(element<RulePlan["kind"]>(["check", "contained", "key"]))
	const arms = s.draw(armsGen)
	return kind === "contained" ? { kind, arms, target: s.draw(armsGen) } : { kind, arms }
}

const loc = SourceLoc("witnesses", [])

const nameOf = (relation: number): string => `R${relation}`

/** A conjunctive arm reading `relations`, each match binding its field f to a variable of its own. */
const conjunctiveOf = (relations: Arr.NonEmptyReadonlyArray<number>, prefix: string) => {
	const vars = Arr.map(relations, (_, i) => ({ id: `${prefix}${i}`, origin: undefined, loc }))
	return {
		vars,
		matches: Arr.map(relations, (relation, i) => ({
			relation: nameOf(relation),
			bindings: { f: { kind: "var" as const, var: `${prefix}${i}` } },
			loc
		})),
		where: [],
		head: { f: { kind: "var" as const, var: `${prefix}0` } }
	}
}

const sideArmOf = (arm: ArmPlan, prefix: string): SideArm => ({
	...conjunctiveOf(arm.matches, `${prefix}m`),
	negated: Arr.map(arm.negated, (n, j): NegatedArm => ({
		arm: conjunctiveOf(n, `${prefix}n${j}.`),
		bindings: { f: { kind: "var", var: `${prefix}m0` } }
	})),
	terms: [{ kind: "var", var: `${prefix}m0` }]
})

const sideOf = (arms: Arr.NonEmptyReadonlyArray<ArmPlan>, prefix: string): RuleSide => ({
	relation: "Live",
	terms: [{ kind: "field", field: "f" }],
	selection: everyFact,
	texts: [],
	arms: Arr.map(arms, (arm, i) => sideArmOf(arm, `${prefix}${i}.`))
})

/** The rule a plan draws, as the theory reads a rule over a query. */
const ruleOf = (plan: RulePlan): QueryRule => {
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
const expectedWitnesses = (
	plan: RulePlan
): ReadonlyArray<{
	readonly rows: ReadonlyArray<number>
	readonly present: ReadonlyArray<number>
	readonly absent: ReadonlyArray<number>
}> => {
	const negatedOf = (arm: ArmPlan) => Arr.flatten(arm.negated)
	switch (plan.kind) {
		case "check":
			return Arr.map(plan.arms, (arm) => ({
				rows: arm.matches,
				present: [],
				absent: negatedOf(arm)
			}))
		case "contained":
			return Arr.map(plan.arms, (arm) => ({
				rows: arm.matches,
				present: Arr.flatMap(plan.target, negatedOf),
				absent: [...negatedOf(arm), ...Arr.flatMap(plan.target, (t) => t.matches)]
			}))
		case "key":
			return Arr.flatMap(plan.arms, (arm, i) =>
				Arr.map(plan.arms.slice(i), (other) => ({
					rows: [...arm.matches, ...other.matches],
					present: [],
					absent: [...negatedOf(arm), ...negatedOf(other)]
				}))
			)
	}
}

/** A witness's three lists, as plain lists of relation names. */
interface Named {
	readonly rows: ReadonlyArray<string>
	readonly present: ReadonlyArray<string>
	readonly absent: ReadonlyArray<string>
}

const byName = (w: Witness): Named => ({ rows: w.rows, present: w.present, absent: w.absent })

type Feature =
	| `a ${RulePlan["kind"]}`
	| "a match"
	| "a negated match"
	| "a target match"
	| "a target negation"
	| "a self-join"
	| "a relation an insert and a delete can both break"
	| "a relation the rule never reads"

describe("a rule over a query's witnesses", () => {
	it.effect(
		"are the shapes its arms give its violation, every occurrence counted, and name exactly the writes its triggers fire on",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/theory/witnesses",
						draw: drawn(planGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the drawn plan's arms read as a rule's violation shapes, and Touches"
						},
						coverage: required<Feature>(
							[
								"a check",
								"a contained",
								"a key",
								"a match",
								"a negated match",
								"a target match",
								"a target negation",
								"a self-join",
								"a relation an insert and a delete can both break",
								"a relation the rule never reads"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						steerEvery: 16,
						caseHang
					},
					(plan, k) =>
						Effect.sync(() => {
							k.note(`a ${plan.kind}`)
							k.note("a match")
							if (Arr.some(plan.arms, (a) => a.negated.length > 0)) {
								k.note("a negated match")
							}
							if (plan.kind === "contained") {
								k.note("a target match")
								if (Arr.some(plan.target, (a) => a.negated.length > 0)) {
									k.note("a target negation")
								}
							}
							if (Arr.some(plan.arms, (a) => new Set(a.matches).size < a.matches.length)) {
								k.note("a self-join")
							}
							const rule = ruleOf(plan)
							const ws = witnesses(rule)
							const actual: ReadonlyArray<Named> = Arr.map(ws, byName)
							const expected: ReadonlyArray<Named> = Arr.map(expectedWitnesses(plan), (w) => ({
								rows: Arr.map(w.rows, nameOf),
								present: Arr.map(w.present, nameOf),
								absent: Arr.map(w.absent, nameOf)
							}))
							assert.deepEqual(actual, expected, "the witnesses, every occurrence")
							for (let r = 0; r < RELATIONS; r += 1) {
								const name = nameOf(r)
								const added = Arr.some(ws, (w) => w.rows.includes(name) || w.present.includes(name))
								const withdrawn = Arr.some(ws, (w) => w.absent.includes(name))
								const t = touches(rule, name)
								assert.equal(
									t !== undefined && (t.kind === "news" || t.kind === "both"),
									added,
									`an INSERT of ${name} can break the rule exactly where a witness reads it as a row or a presence`
								)
								assert.equal(
									t !== undefined && (t.kind === "olds" || t.kind === "both"),
									withdrawn,
									`a DELETE of ${name} can break the rule exactly where a witness reads it as an absence`
								)
								if (t === undefined) {
									k.note("a relation the rule never reads")
								} else if (t.kind === "both") {
									k.note("a relation an insert and a delete can both break")
								}
							}
						})
				)
			)
	)
})
