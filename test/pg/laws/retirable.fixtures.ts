/** What the properties of retirable.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Equivalence as Eq, Option, String as Str } from "effect"
import { pg, retirement } from "#compiler/public/fields.ts"
import { contained, on, relation, retirable, schema } from "#compiler/public/schema.ts"
import { seatTemplate } from "#test/pg/fin/installed.ts"

const Root = relation("Root", { id: pg.integer, retired: retirement }, ["id"])

const Step = relation("Step", { root: pg.integer, step: pg.integer }, ["root", "step"])

const Claim = relation("Claim", { root: pg.integer, step: pg.integer, attempt: pg.integer }, [
	"root",
	"step",
	"attempt"
])

const Pair = relation("Pair", { tenant: pg.integer, id: pg.integer, retired: retirement }, [
	"tenant",
	"id"
])

const PairStep = relation("PairStep", { tenant: pg.integer, root: pg.integer, step: pg.integer }, [
	"tenant",
	"root",
	"step"
])

const PairClaim = relation(
	"PairClaim",
	{ tenant: pg.integer, root: pg.integer, step: pg.integer, attempt: pg.integer },
	["tenant", "root", "step", "attempt"]
)

const Units = schema(
	"retire_life",
	[Root, Step, Claim, Pair, PairStep, PairClaim],
	[
		retirable(Root, [on(Step, "root"), on(Claim, "root")]),
		contained(on(Claim, "root", "step"), on(Step, "root", "step")),
		retirable(Pair, [on(PairStep, "tenant", "root"), on(PairClaim, "tenant", "root")]),
		contained(on(PairClaim, "tenant", "root", "step"), on(PairStep, "tenant", "root", "step"))
	]
)

export const RELATIONS = ["Root", "Step", "Claim", "Pair", "PairStep", "PairClaim"] as const

/** A group of a run, by its place: each unit's two groups. */
type Group = 0 | 1

const widths = ["a header keyed by one field", "a header keyed by two fields"] as const

/** A header's key width, the feature its case notes, each the width of one unit's header. */
type Width = (typeof widths)[number]

/**
 * A field of a header's key: its name in the header, the name of the field that carries it in each body, and each
 * group's value at it.
 */
interface KeyField {
	readonly header: string
	readonly body: string
	readonly values: { readonly [G in Group]: number }
}

/**
 * A unit as a case writes it: its header and its two bodies, of Step's and Claim's shape, and its header's key fields,
 * in order.
 */
interface Unit {
	readonly header: string
	readonly step: string
	readonly claim: string
	readonly key: Arr.NonEmptyReadonlyArray<KeyField>
}

/**
 * The two units by their headers' widths: Root, keyed by its id, and Pair, keyed by a tenant and an id, whose two
 * groups share their tenant, so a group read at its tenant alone is read as both.
 */
export const UNITS: { readonly [W in Width]: Unit } = {
	"a header keyed by one field": {
		header: "Root",
		step: "Step",
		claim: "Claim",
		key: [{ header: "id", body: "root", values: { 0: 0, 1: 1 } }]
	},
	"a header keyed by two fields": {
		header: "Pair",
		step: "PairStep",
		claim: "PairClaim",
		key: [
			{ header: "tenant", body: "tenant", values: { 0: 1, 1: 1 } },
			{ header: "id", body: "root", values: { 0: 0, 1: 1 } }
		]
	}
}

/** Group `g`'s values at `unit`'s key fields, in order. */
export const valuesAt = (unit: Unit, g: Group): Arr.NonEmptyReadonlyArray<number> =>
	Arr.map(unit.key, (k) => k.values[g])

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** One transaction of the run: one row inserted, or one function called with the groups it states. */
export type Op =
	| { readonly kind: "header"; readonly group: Group }
	| { readonly kind: "step"; readonly group: Group; readonly step: number }
	| {
			readonly kind: "claim"
			readonly group: Group
			readonly step: number
			readonly attempt: number
	  }
	| { readonly kind: "hold" | "retire"; readonly groups: Arr.NonEmptyReadonlyArray<Group> }

const bits = [0, 1] as const

const groupSets: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Group>> = [[0], [1], [0, 1]]

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

const runGen: Gen<ReadonlyArray<Op>> = array(opGen, { min: 1, max: 8 })

/** A case: the unit it writes, by its header's width, and its run of transactions over that unit. */
interface Life {
	readonly width: Width
	readonly run: ReadonlyArray<Op>
}

export const lifeGen: Gen<Life> = (source) => ({
	width: source.draw(element(widths)),
	run: source.draw(runGen)
})

/** A body row: its group, then the rest of its key, a step and an attempt. */
type BodyRow = readonly [group: Group, ...rest: ReadonlyArray<number>]

/** The lifecycle's state: each group's header, and the rows of each body. */
interface Model {
	readonly headers: ReadonlyMap<Group, "open" | "retired">
	readonly steps: ReadonlyArray<BodyRow>
	readonly claims: ReadonlyArray<BodyRow>
}

export const empty: Model = { headers: new Map(), steps: [], claims: [] }

/** What the model says one transaction comes to: committed with the state it leaves, or refused with this SQLSTATE. */
type Predicted =
	| { readonly kind: "committed"; readonly next: Model; readonly feature: LifeFeature }
	| { readonly kind: "refused"; readonly code: string; readonly feature: LifeFeature }

export type LifeFeature =
	| Width
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

const sameRow = Arr.makeEquivalence(Eq.strictEqual<number>())

/** Whether `rows` hold `row`. */
const holds = (rows: ReadonlyArray<BodyRow>, row: BodyRow): boolean =>
	Arr.some(rows, (r) => sameRow(r, row))

/** A body row's verdict in the group `g`: refused by the fence unless the group is open. */
const fenced = (m: Model, g: Group): Predicted | undefined => {
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
			const row: BodyRow = [op.group, op.step]
			if (holds(m.steps, row)) {
				return { kind: "refused", code: "23505", feature: "a body row refused at its key" }
			}
			return (
				fenced(m, op.group) ?? {
					kind: "committed",
					next: { ...m, steps: [...m.steps, row] },
					feature: "a body row inserted"
				}
			)
		}
		case "claim": {
			const row: BodyRow = [op.group, op.step, op.attempt]
			if (holds(m.claims, row)) {
				return { kind: "refused", code: "23505", feature: "a body row refused at its key" }
			}
			const fence = fenced(m, op.group)
			if (fence !== undefined) {
				return fence
			}
			return holds(m.steps, [op.group, op.step])
				? {
						kind: "committed",
						next: { ...m, claims: [...m.claims, row] },
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
			const kept = (r: BodyRow): boolean => !Arr.contains(retiring, r[0])
			return {
				kind: "committed",
				next: {
					headers: new Map(
						Arr.map(
							[...m.headers],
							([g, h]) => [g, Arr.contains(retiring, g) ? "retired" : h] as const
						)
					),
					steps: Arr.filter(m.steps, kept),
					claims: Arr.filter(m.claims, kept)
				},
				feature:
					retiring.length > 0
						? "a retirement of an open group"
						: "a retirement that changes nothing"
			}
		}
	}
}

/** The rows a model holds in `unit`'s tables, as their readings spell them: each group at its values. */
export const modelRows = (unit: Unit, m: Model): ReadonlyArray<ReadonlyArray<string>> => {
	const spelt = (r: BodyRow): string =>
		Arr.join(Arr.map([...valuesAt(unit, r[0]), ...r.slice(1)], String), ",")
	return [
		Arr.sort(
			Arr.map([...m.headers], ([g, h]) =>
				Arr.join([...Arr.map(valuesAt(unit, g), String), h === "retired" ? "true" : "false"], ",")
			),
			Str.Order
		),
		Arr.sort(Arr.map(m.steps, spelt), Str.Order),
		Arr.sort(Arr.map(m.claims, spelt), Str.Order)
	]
}

/** A call's arguments over `groups`: one array per key field of `unit`'s header, its groups' values in lockstep. */
export const groupsArrays = (unit: Unit, groups: Arr.NonEmptyReadonlyArray<Group>): string =>
	Arr.join(
		Arr.map(
			unit.key,
			(k) =>
				`ARRAY[${Arr.join(
					Arr.map(groups, (g) => String(k.values[g])),
					", "
				)}]::int4[]`
		),
		", "
	)

/** Units installed once per member (fin/installed.ts seatTemplate), which each case's seat holds. */
export const unitsTemplate = seatTemplate(import.meta, Units, "retire_life")
