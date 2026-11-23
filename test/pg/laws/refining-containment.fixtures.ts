/** What the property of refining-containment.test.ts reads: its schema and template, its space, its model and each case's run. */

import { array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { Logic } from "#compiler/public/compute.ts"
import { contract, natural, pg } from "#compiler/public/fields.ts"
import { contained, on, relation, schema, select } from "#compiler/public/schema.ts"
import { type Seat, seatTemplate } from "#test/pg/fin/installed.ts"
import { attempt } from "#test/support/substrate.ts"

/** A contract over pg.bigint of the values at most 1, a sibling of natural: neither refines the other. */
const Low = contract("Low", pg.bigint, (x) => Logic.le(x, 1n))

/** A contract over natural of the values at most 1: a refinement of natural, and through it of pg.bigint. */
const Unit = contract("Unit", natural, (x) => Logic.le(x, 1n))

/** The types the schema's fields are of, each of the base carrier int8: pg.bigint, natural, Low and Unit. */
const types = ["Big", "Natural", "Low", "Unit"] as const
type TypeName = (typeof types)[number]

/** The values a case writes, -1 to 2, as each type admits them. */
const admitted: { readonly [T in TypeName]: Arr.NonEmptyReadonlyArray<number> } = {
	Big: [-1, 0, 1, 2],
	Natural: [0, 1, 2],
	Low: [-1, 0, 1],
	Unit: [0, 1]
}

/** Whether a type refines another: its contracts reach it, natural and Low pg.bigint, Unit natural and pg.bigint. */
const refines = (x: TypeName, y: TypeName): boolean =>
	(x === "Natural" && y === "Big") ||
	(x === "Low" && y === "Big") ||
	(x === "Unit" && (y === "Natural" || y === "Big"))

/** How a containment is discharged: a foreign key between its two tables, or the judge over a selected side. */
type Discharge = "foreign key" | "judge"

/** A containment of the schema: its source's field of one type into a target's of another, discharged one way. */
interface Pair {
	readonly from: TypeName
	readonly into: TypeName
	readonly discharge: Discharge
	/** The source relation's name. */
	readonly source: string
}

/** Each type's target: its values at g, keyed by both. */
const BigTarget = relation("BigTarget", { g: pg.integer, v: pg.bigint }, ["g", "v"])
const NaturalTarget = relation("NaturalTarget", { g: pg.integer, v: natural }, ["g", "v"])
const LowTarget = relation("LowTarget", { g: pg.integer, v: Low }, ["g", "v"])
const UnitTarget = relation("UnitTarget", { g: pg.integer, v: Unit }, ["g", "v"])

/**
 * Each pair of two types' sources, a row's value at g of the first type with its kind: one a foreign key holds in the
 * second type's target, and one whose rows of kind 1 the judge holds there.
 */
const NaturalInBig = relation("NaturalInBig", { g: pg.integer, v: natural, kind: pg.integer }, [
	"g",
	"v"
])
const LowInBig = relation("LowInBig", { g: pg.integer, v: Low, kind: pg.integer }, ["g", "v"])
const UnitInBig = relation("UnitInBig", { g: pg.integer, v: Unit, kind: pg.integer }, ["g", "v"])
const BigInNatural = relation("BigInNatural", { g: pg.integer, v: pg.bigint, kind: pg.integer }, [
	"g",
	"v"
])
const LowInNatural = relation("LowInNatural", { g: pg.integer, v: Low, kind: pg.integer }, [
	"g",
	"v"
])
const UnitInNatural = relation("UnitInNatural", { g: pg.integer, v: Unit, kind: pg.integer }, [
	"g",
	"v"
])
const BigInLow = relation("BigInLow", { g: pg.integer, v: pg.bigint, kind: pg.integer }, ["g", "v"])
const NaturalInLow = relation("NaturalInLow", { g: pg.integer, v: natural, kind: pg.integer }, [
	"g",
	"v"
])
const UnitInLow = relation("UnitInLow", { g: pg.integer, v: Unit, kind: pg.integer }, ["g", "v"])
const BigInUnit = relation("BigInUnit", { g: pg.integer, v: pg.bigint, kind: pg.integer }, [
	"g",
	"v"
])
const NaturalInUnit = relation("NaturalInUnit", { g: pg.integer, v: natural, kind: pg.integer }, [
	"g",
	"v"
])
const LowInUnit = relation("LowInUnit", { g: pg.integer, v: Low, kind: pg.integer }, ["g", "v"])
const NaturalInBigJudged = relation(
	"NaturalInBigJudged",
	{ g: pg.integer, v: natural, kind: pg.integer },
	["g", "v"]
)
const LowInBigJudged = relation("LowInBigJudged", { g: pg.integer, v: Low, kind: pg.integer }, [
	"g",
	"v"
])
const UnitInBigJudged = relation("UnitInBigJudged", { g: pg.integer, v: Unit, kind: pg.integer }, [
	"g",
	"v"
])
const BigInNaturalJudged = relation(
	"BigInNaturalJudged",
	{ g: pg.integer, v: pg.bigint, kind: pg.integer },
	["g", "v"]
)
const LowInNaturalJudged = relation(
	"LowInNaturalJudged",
	{ g: pg.integer, v: Low, kind: pg.integer },
	["g", "v"]
)
const UnitInNaturalJudged = relation(
	"UnitInNaturalJudged",
	{ g: pg.integer, v: Unit, kind: pg.integer },
	["g", "v"]
)
const BigInLowJudged = relation(
	"BigInLowJudged",
	{ g: pg.integer, v: pg.bigint, kind: pg.integer },
	["g", "v"]
)
const NaturalInLowJudged = relation(
	"NaturalInLowJudged",
	{ g: pg.integer, v: natural, kind: pg.integer },
	["g", "v"]
)
const UnitInLowJudged = relation("UnitInLowJudged", { g: pg.integer, v: Unit, kind: pg.integer }, [
	"g",
	"v"
])
const BigInUnitJudged = relation(
	"BigInUnitJudged",
	{ g: pg.integer, v: pg.bigint, kind: pg.integer },
	["g", "v"]
)
const NaturalInUnitJudged = relation(
	"NaturalInUnitJudged",
	{ g: pg.integer, v: natural, kind: pg.integer },
	["g", "v"]
)
const LowInUnitJudged = relation("LowInUnitJudged", { g: pg.integer, v: Low, kind: pg.integer }, [
	"g",
	"v"
])

/**
 * The schema the property installs: every type's target, and each ordered pair of two types' containments, a plain one
 * into the target at its every field, which its foreign key holds, and one whose source is selected by a literal, every
 * relation immutable and keyed by its unit g first, so it joins within one unit and the judge holds it whole
 * (laws/model/plan.ts containmentDischarge). Each pairs fields of one base carrier, int8, of two types: a refinement
 * with its base either way, or two contracts neither of which refines the other.
 */
const Refining = schema(
	"RefiningContainment",
	[
		BigTarget,
		NaturalTarget,
		LowTarget,
		UnitTarget,
		NaturalInBig,
		LowInBig,
		UnitInBig,
		BigInNatural,
		LowInNatural,
		UnitInNatural,
		BigInLow,
		NaturalInLow,
		UnitInLow,
		BigInUnit,
		NaturalInUnit,
		LowInUnit,
		NaturalInBigJudged,
		LowInBigJudged,
		UnitInBigJudged,
		BigInNaturalJudged,
		LowInNaturalJudged,
		UnitInNaturalJudged,
		BigInLowJudged,
		NaturalInLowJudged,
		UnitInLowJudged,
		BigInUnitJudged,
		NaturalInUnitJudged,
		LowInUnitJudged
	],
	[
		contained(on(NaturalInBig, "g", "v"), on(BigTarget, "g", "v")),
		contained(on(LowInBig, "g", "v"), on(BigTarget, "g", "v")),
		contained(on(UnitInBig, "g", "v"), on(BigTarget, "g", "v")),
		contained(on(BigInNatural, "g", "v"), on(NaturalTarget, "g", "v")),
		contained(on(LowInNatural, "g", "v"), on(NaturalTarget, "g", "v")),
		contained(on(UnitInNatural, "g", "v"), on(NaturalTarget, "g", "v")),
		contained(on(BigInLow, "g", "v"), on(LowTarget, "g", "v")),
		contained(on(NaturalInLow, "g", "v"), on(LowTarget, "g", "v")),
		contained(on(UnitInLow, "g", "v"), on(LowTarget, "g", "v")),
		contained(on(BigInUnit, "g", "v"), on(UnitTarget, "g", "v")),
		contained(on(NaturalInUnit, "g", "v"), on(UnitTarget, "g", "v")),
		contained(on(LowInUnit, "g", "v"), on(UnitTarget, "g", "v")),
		contained(
			on(
				select(NaturalInBigJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(BigTarget, "g", "v")
		),
		contained(
			on(
				select(LowInBigJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(BigTarget, "g", "v")
		),
		contained(
			on(
				select(UnitInBigJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(BigTarget, "g", "v")
		),
		contained(
			on(
				select(BigInNaturalJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(NaturalTarget, "g", "v")
		),
		contained(
			on(
				select(LowInNaturalJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(NaturalTarget, "g", "v")
		),
		contained(
			on(
				select(UnitInNaturalJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(NaturalTarget, "g", "v")
		),
		contained(
			on(
				select(BigInLowJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(LowTarget, "g", "v")
		),
		contained(
			on(
				select(NaturalInLowJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(LowTarget, "g", "v")
		),
		contained(
			on(
				select(UnitInLowJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(LowTarget, "g", "v")
		),
		contained(
			on(
				select(BigInUnitJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(UnitTarget, "g", "v")
		),
		contained(
			on(
				select(NaturalInUnitJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(UnitTarget, "g", "v")
		),
		contained(
			on(
				select(LowInUnitJudged, (s) => s.eq(s.kind, 1)),
				"g",
				"v"
			),
			on(UnitTarget, "g", "v")
		)
	]
)

/** Each type's target relation's name. */
const targetOf = (t: TypeName): string => `${t}Target`

/** Each ordered pair of two types, a source's into a target's. */
const ordered: Arr.NonEmptyReadonlyArray<readonly [TypeName, TypeName]> = [
	["Natural", "Big"],
	["Low", "Big"],
	["Unit", "Big"],
	["Big", "Natural"],
	["Low", "Natural"],
	["Unit", "Natural"],
	["Big", "Low"],
	["Natural", "Low"],
	["Unit", "Low"],
	["Big", "Unit"],
	["Natural", "Unit"],
	["Low", "Unit"]
]

/** Every containment of the schema, each ordered pair of two types once for each discharge. */
const pairs: Arr.NonEmptyReadonlyArray<Pair> = Arr.flatMap(
	["foreign key", "judge"] as const,
	(discharge) =>
		Arr.map(ordered, ([from, into]) => ({
			from,
			into,
			discharge,
			source: `${from}In${into}${discharge === "judge" ? "Judged" : ""}`
		}))
)

/** Every relation of the schema, by name: the targets, then the sources. */
export const relations: Arr.NonEmptyReadonlyArray<string> = Arr.appendAll(
	Arr.map(types, targetOf),
	Arr.map(pairs, (p) => p.source)
)

/** Refining installed once per member (fin/installed.ts seatTemplate), a clone of which each case takes. */
export const refiningTemplate = seatTemplate(import.meta, Refining, "refining_containment")

/** A source's row: its value, of its type, and its kind, 1 where the judge holds it. */
interface SourceRow {
	readonly v: number
	readonly kind: 0 | 1
}

/** One state at one unit: each target's values, and each source's rows, by name; a relation absent holds none. */
interface State {
	readonly targets: { readonly [T in TypeName]: ReadonlyArray<number> }
	readonly sources: ReadonlyMap<string, ReadonlyArray<SourceRow>>
}

/** Whether a source row must find its value in its target: every row of a foreign key's, a judged source's of kind 1. */
const held = (p: Pair, row: SourceRow): boolean => p.discharge === "foreign key" || row.kind === 1

/** The containments a state breaks, as their laws say: a held row of its source whose value its target lacks. */
const brokenBy = (state: State): ReadonlyArray<Pair> =>
	Arr.filter(pairs, (p) =>
		Arr.some(
			state.sources.get(p.source) ?? [],
			(row) => held(p, row) && !state.targets[p.into].includes(row.v)
		)
	)

/** A subset of some values, each kept or not. */
const subsetOf =
	<A>(values: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	(s) =>
		Arr.filter(values, () => s.draw(boolean))

/** Each type's target values, a subset of the values it admits. */
const targetsGen: Gen<State["targets"]> = (s) => ({
	Big: s.draw(subsetOf(admitted.Big)),
	Natural: s.draw(subsetOf(admitted.Natural)),
	Low: s.draw(subsetOf(admitted.Low)),
	Unit: s.draw(subsetOf(admitted.Unit))
})

/**
 * A pair's rows over targets: a subset of the values its source's type admits, each of a drawn kind, drawn from those
 * its target holds where `lawful`, so none it holds breaks the containment.
 */
const rowsGen =
	(p: Pair, targets: State["targets"], lawful: boolean): Gen<ReadonlyArray<SourceRow>> =>
	(s) =>
		Arr.flatMap(s.draw(subsetOf(admitted[p.from])), (v): ReadonlyArray<SourceRow> => {
			const kind = s.draw(element([0, 1] as const))
			return lawful && held(p, { v, kind }) && !targets[p.into].includes(v) ? [] : [{ v, kind }]
		})

/** A state: its targets, and about one source in four holding rows, lawful ones mostly, so most states commit. */
const stateGen: Gen<State> = (s) => {
	const targets = s.draw(targetsGen)
	const lawful = s.draw(int(0, 3)) > 0
	return {
		targets,
		sources: new Map(
			Arr.flatMap(pairs, (p) =>
				s.draw(int(0, 3)) === 0 ? [[p.source, s.draw(rowsGen(p, targets, lawful))] as const] : []
			)
		)
	}
}

/** A state aimed at one containment: its target lacking a value its source's held row holds, or holding it. */
const aimedAt =
	(p: Pair, breaks: boolean): Gen<State> =>
	(s) => {
		const v = s.draw(element(admitted[p.from]))
		const holdable = admitted[p.into].includes(v)
		const targets = s.draw(targetsGen)
		const holds = holdable && !breaks
		return {
			targets: {
				...targets,
				[p.into]: holds
					? Arr.dedupe([...targets[p.into], v])
					: Arr.filter(targets[p.into], (t) => t !== v)
			},
			sources: new Map([[p.source, [{ v, kind: 1 }] as const]])
		}
	}

/** A case: one to four states, each at a unit of its own, written one after another. */
export const space: Gen<ReadonlyArray<State>> = weighted<ReadonlyArray<State>>([
	[4, array(stateGen, { min: 1, max: 4 })],
	[1, (s) => [s.draw(aimedAt(s.draw(element(pairs)), s.draw(boolean)))]]
])

export type RefiningFeature =
	| "committed"
	| "refused at a foreign key"
	| "refused by the judge"
	| "a refinement committed into its base"
	| "a base committed into its refinement"
	| "a contract committed into a sibling"
	| "a row its selection leaves out committed outside its target"

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** How a pair's two types stand: its source refining its target, its target refining its source, or neither. */
const standingOf = (p: Pair): RefiningFeature =>
	refines(p.from, p.into)
		? "a refinement committed into its base"
		: refines(p.into, p.from)
			? "a base committed into its refinement"
			: "a contract committed into a sibling"

/** The statements writing a state at unit g: its targets' rows, then its sources'. */
const statementsOf = (seat: Seat, state: State, g: number): ReadonlyArray<string> => {
	const insert = (name: string, columns: ReadonlyArray<string>, rows: ReadonlyArray<string>) =>
		rows.length === 0
			? []
			: [
					`INSERT INTO ${seat.table(name)} (${Arr.join(
						Arr.map(columns, (c) => seat.column(name, c)),
						", "
					)}) VALUES ${Arr.join(rows, ", ")}`
				]
	return [
		...Arr.flatMap(types, (t) =>
			insert(
				targetOf(t),
				["g", "v"],
				Arr.map(state.targets[t], (v) => `(${g}, ${v})`)
			)
		),
		...Arr.flatMap(pairs, (p) =>
			insert(
				p.source,
				["g", "v", "kind"],
				Arr.map(state.sources.get(p.source) ?? [], (r) => `(${g}, ${r.v}, ${r.kind})`)
			)
		)
	]
}

/**
 * One case: every foreign-key pair held by its foreign key alone and every judged pair by the judge alone, then each
 * state written at a unit of its own, g its place from 1, in a transaction of its own as the owner: it commits exactly
 * when it breaks no containment, as the laws' meaning reads it (`brokenBy`), and is refused otherwise with 23503 under
 * a containment it breaks, through the installation's constraint map.
 */
export const runRefining = (seat: Seat, states: ReadonlyArray<State>, c: Case<RefiningFeature>) =>
	Effect.gen(function* () {
		const installation = seat.installed.installation
		const pairOf = new Map<LawId, Pair>(
			Arr.flatMap(installation.laws.theory.laws, (law) => {
				const d = law.detail
				const pair =
					d.kind === "containment"
						? Arr.findFirst(pairs, (p) => p.source === d.from.relation)
						: Option.none()
				return Option.match(pair, {
					onNone: (): ReadonlyArray<readonly [LawId, Pair]> => [],
					onSome: (p) => [[law.id, p] as const]
				})
			})
		)
		for (const [id, p] of pairOf) {
			const native = Arr.some(
				installation.laws.natives,
				(n) => n.object.kind === "ForeignKey" && Arr.some(n.object.lawIds, (l) => l === id)
			)
			const judged = Arr.some(installation.laws.rules, (r) => r.law.id === id)
			if (native !== (p.discharge === "foreign key") || judged !== (p.discharge === "judge")) {
				return yield* new Disagreed({
					message: `the containment of ${p.source} is held by ${Formatter.format({ native, judged })}, where its ${p.discharge} holds it alone`
				})
			}
		}
		/** The relation PostgreSQL names a refusal's table by. */
		const relationOf = (table: string) =>
			Arr.findFirst(relations, (r) => installation.names.relation(r).name === table)
		for (const [at, state] of states.entries()) {
			const where = `state ${at} of ${Formatter.format(states)}`
			const broken = brokenBy(state)
			const outcome = yield* attempt(seat.session, statementsOf(seat, state, at + 1))
			if (outcome.kind === "committed") {
				if (broken.length > 0) {
					return yield* new Disagreed({
						message: `a state breaking ${Formatter.format(Arr.map(broken, (p) => p.source))} committed, ${where}`
					})
				}
				c.note("committed")
				for (const p of pairs) {
					const rows = state.sources.get(p.source) ?? []
					if (Arr.some(rows, (r) => held(p, r))) {
						c.note(standingOf(p))
					}
					if (Arr.some(rows, (r) => !held(p, r) && !state.targets[p.into].includes(r.v))) {
						c.note("a row its selection leaves out committed outside its target")
					}
				}
				continue
			}
			const fields = outcome.fields
			const table = Option.getOrUndefined(fields.table)
			const relation = table === undefined ? Option.none() : relationOf(table)
			const served =
				Option.isNone(relation) || fields.constraint === undefined
					? []
					: (lawsOfConstraint(
							installation.constraintToLaw,
							{ kind: "table", name: installation.names.relation(relation.value).name },
							fields.constraint
						) ?? [])
			const named = Arr.findFirst(
				Arr.flatMap(served, (law) => Option.toArray(Option.fromUndefinedOr(pairOf.get(law)))),
				(p) => broken.includes(p)
			).pipe(Option.getOrUndefined)
			if (named === undefined || fields.code !== "23503") {
				return yield* new Disagreed({
					message: `refused with ${fields.code} ${fields.constraint ?? "naming no constraint"} on ${table ?? "no table"}, where the state breaks ${Formatter.format(Arr.map(broken, (p) => p.source))}, ${where}`
				})
			}
			c.note(
				named.discharge === "foreign key" ? "refused at a foreign key" : "refused by the judge"
			)
		}
	})
