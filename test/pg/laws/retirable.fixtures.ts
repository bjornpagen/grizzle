/** What the properties of retirable.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Option, String as Str } from "effect"
import { pg, retirement } from "#compiler/public/fields.ts"
import { contained, on, relation, retirable, schema } from "#compiler/public/schema.ts"

const Root = relation("Root", { id: pg.integer, retired: retirement }, ["id"])

const Step = relation("Step", { root: pg.integer, step: pg.integer }, ["root", "step"])

const Claim = relation("Claim", { root: pg.integer, step: pg.integer, attempt: pg.integer }, [
	"root",
	"step",
	"attempt"
])

export const Units = schema(
	"retire_life",
	[Root, Step, Claim],
	[
		retirable(Root, [on(Step, "root"), on(Claim, "root")]),
		contained(on(Claim, "root", "step"), on(Step, "root", "step"))
	]
)

export const RELATIONS = ["Root", "Step", "Claim"] as const

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** One transaction of the run: one row inserted, or one function called with the groups it states. */
export type Op =
	| { readonly kind: "header"; readonly group: number }
	| { readonly kind: "step"; readonly group: number; readonly step: number }
	| {
			readonly kind: "claim"
			readonly group: number
			readonly step: number
			readonly attempt: number
	  }
	| { readonly kind: "hold" | "retire"; readonly groups: Arr.NonEmptyReadonlyArray<number> }

const bits = [0, 1] as const

const groupSets: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<number>> = [[0], [1], [0, 1]]

const opGen: Gen<Op> = (source) => {
	const kind = source.draw(element<Op["kind"]>(["header", "step", "claim", "hold", "retire"]))
	switch (kind) {
		case "header":
			return { kind, group: source.draw(element(bits)) }
		case "step":
			return { kind, group: source.draw(element(bits)), step: source.draw(element(bits)) }
		case "claim":
			return {
				kind,
				group: source.draw(element(bits)),
				step: source.draw(element(bits)),
				attempt: source.draw(element(bits))
			}
		case "hold":
		case "retire":
			return { kind, groups: source.draw(element(groupSets)) }
	}
}

export const runGen: Gen<ReadonlyArray<Op>> = array(opGen, { min: 1, max: 8 })

/** The lifecycle's state: each group's header, and the rows of each body. */
interface Model {
	readonly headers: ReadonlyMap<number, "open" | "retired">
	readonly steps: ReadonlySet<string>
	readonly claims: ReadonlySet<string>
}

export const empty: Model = { headers: new Map(), steps: new Set(), claims: new Set() }

/** What the model says one transaction comes to: committed with the state it leaves, or refused with this SQLSTATE. */
type Predicted =
	| { readonly kind: "committed"; readonly next: Model; readonly feature: LifeFeature }
	| { readonly kind: "refused"; readonly code: string; readonly feature: LifeFeature }

export type LifeFeature =
	| "a header inserted"
	| "a header refused at its key"
	| "a body row inserted"
	| "a body row refused at its key"
	| "a body row refused in a retired group"
	| "a body row refused in an absent group"
	| "a claim refused with no step"
	| "a hold of open groups"
	| "a hold refused for a retired group"
	| "a hold refused for an absent group"
	| "a retirement of an open group"
	| "a retirement that changes nothing"

const stepKey = (g: number, s: number): string => `${g},${s}`

const claimKey = (g: number, s: number, a: number): string => `${g},${s},${a}`

/** A body row's verdict in the group `g`: refused by the fence unless the group is open. */
const fenced = (m: Model, g: number): Predicted | undefined => {
	const header = m.headers.get(g)
	return header === "open"
		? undefined
		: {
				kind: "refused",
				code: "23503",
				feature:
					header === "retired"
						? "a body row refused in a retired group"
						: "a body row refused in an absent group"
			}
}

export const predict = (m: Model, op: Op): Predicted => {
	switch (op.kind) {
		case "header":
			return m.headers.has(op.group)
				? { kind: "refused", code: "23505", feature: "a header refused at its key" }
				: {
						kind: "committed",
						next: { ...m, headers: new Map([...m.headers, [op.group, "open"]]) },
						feature: "a header inserted"
					}
		case "step": {
			const key = stepKey(op.group, op.step)
			if (m.steps.has(key)) {
				return { kind: "refused", code: "23505", feature: "a body row refused at its key" }
			}
			return (
				fenced(m, op.group) ?? {
					kind: "committed",
					next: { ...m, steps: new Set([...m.steps, key]) },
					feature: "a body row inserted"
				}
			)
		}
		case "claim": {
			const key = claimKey(op.group, op.step, op.attempt)
			if (m.claims.has(key)) {
				return { kind: "refused", code: "23505", feature: "a body row refused at its key" }
			}
			const fence = fenced(m, op.group)
			if (fence !== undefined) {
				return fence
			}
			return m.steps.has(stepKey(op.group, op.step))
				? {
						kind: "committed",
						next: { ...m, claims: new Set([...m.claims, key]) },
						feature: "a body row inserted"
					}
				: { kind: "refused", code: "23503", feature: "a claim refused with no step" }
		}
		case "hold": {
			const closed = Arr.findFirst(op.groups, (g) => m.headers.get(g) !== "open")
			if (Option.isSome(closed)) {
				return {
					kind: "refused",
					code: "23000",
					feature:
						m.headers.get(closed.value) === "retired"
							? "a hold refused for a retired group"
							: "a hold refused for an absent group"
				}
			}
			return { kind: "committed", next: m, feature: "a hold of open groups" }
		}
		case "retire": {
			const retiring = Arr.filter(op.groups, (g) => m.headers.get(g) === "open")
			const inRetired = (key: string): boolean =>
				Arr.some(retiring, (g) => Str.startsWith(`${g},`)(key))
			return {
				kind: "committed",
				next: {
					headers: new Map(
						Arr.map(
							[...m.headers],
							([g, h]) => [g, Arr.contains(retiring, g) ? "retired" : h] as const
						)
					),
					steps: new Set(Arr.filter([...m.steps], (k) => !inRetired(k))),
					claims: new Set(Arr.filter([...m.claims], (k) => !inRetired(k)))
				},
				feature:
					retiring.length > 0
						? "a retirement of an open group"
						: "a retirement that changes nothing"
			}
		}
	}
}

/** The rows a model holds, as the three tables' readings spell them. */
export const modelRows = (m: Model): ReadonlyArray<ReadonlyArray<string>> => [
	Arr.sort(
		Arr.map([...m.headers], ([g, h]) => `${g},${h === "retired" ? "true" : "false"}`),
		Str.Order
	),
	Arr.sort([...m.steps], Str.Order),
	Arr.sort([...m.claims], Str.Order)
]

export const groupsArray = (groups: ReadonlyArray<number>) =>
	`ARRAY[${Arr.join(Arr.map(groups, String), ", ")}]::int4[]`
