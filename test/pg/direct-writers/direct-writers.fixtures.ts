/** What the properties of direct-writers.test.ts read: its spaces, models and helpers. */

import { array, boolean, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	type DirectCase,
	directCaseGen,
	type DirectFeature,
	type Level,
	levelGen,
	levels
} from "#test/pg/direct-writers/model.ts"
import {
	type FactsSketch,
	factsSketchGen,
	type RowSketch,
	rowSketchGen
} from "#test/support/oracle/write/facts.ts"
import {
	type SchemaSketch,
	schemaSketchGen,
	type WGroup,
	type WRelation
} from "#test/support/oracle/write/schema.ts"
import { pickGen, pickIndex, pickSpan } from "#test/support/pick.ts"

/** The errors a run plants, one case each. */
const plantKinds = [
	"code outside the roster",
	"numeric past its precision",
	"text past its bound",
	"immediate reference broken",
	"deferred reference broken at COMMIT",
	"deferred reference broken at SET CONSTRAINTS"
] as const

type PlantKind = (typeof plantKinds)[number]

/**
 * A planted case as drawn: its kind, the stored facts, the row it writes, its level and sequences, and its position
 * among the run's drawn cases.
 */
interface Plant {
	readonly kind: PlantKind
	readonly facts: FactsSketch
	readonly row: RowSketch
	readonly level: Level
	readonly behind: boolean
	readonly at: number
}

const plantGen =
	(kind: PlantKind): Gen<Plant> =>
	(source) => ({
		kind,
		facts: source.draw(factsSketchGen(5)),
		row: source.draw(rowSketchGen),
		level: source.draw(levelGen),
		behind: source.draw(boolean),
		at: source.draw(pickGen)
	})

interface DirectRun {
	readonly schema: SchemaSketch
	readonly cases: ReadonlyArray<DirectCase>
	readonly plants: ReadonlyArray<Plant>
}

export const directRunGen: Gen<DirectRun> = (source) => ({
	schema: source.draw(schemaSketchGen),
	/** Up to ten cases on one installed schema, which a run installs once. */
	cases: source.draw(array(directCaseGen, { min: 1, max: 10 })),
	plants: Arr.map(plantKinds, (kind) => source.draw(plantGen(kind)))
})

/**
 * The group a run adds to its drawn schema, last, at `index` (see the header): its relations named as the generated
 * ones are, so they share no name.
 */
export const plantedGroup = (index: number): WGroup => {
	const name = (i: number): string => `G${index}R${i}`
	const parent: WRelation = {
		name: name(0),
		columns: [
			{ name: "a", kind: "int4" },
			{ name: "b", kind: "code" },
			{ name: "c", kind: "numeric(3, 0)" },
			{ name: "d", kind: "text" }
		],
		primaryKey: ["a"],
		keys: [],
		mutable: true
	}
	const pure: WRelation = {
		name: name(1),
		columns: [{ name: "a", kind: "int4" }],
		primaryKey: ["a"],
		keys: [],
		mutable: false
	}
	const child = (i: number): WRelation => ({
		name: name(i),
		columns: [
			{ name: "a", kind: "int4" },
			{ name: "b", kind: "int4" }
		],
		primaryKey: ["a"],
		keys: [],
		mutable: false
	})
	const intoParent = child(2)
	const intoPure = child(3)
	return {
		index,
		role: "drawn",
		relations: [parent, pure, intoParent, intoPure],
		/** The deferred containment first, so a pick of 0 names it and the last pick the immediate one. */
		containments: [
			{
				from: { relation: intoParent.name, fields: ["b"] },
				to: { relation: parent.name, fields: ["a"] }
			},
			{
				from: { relation: intoPure.name, fields: ["b"] },
				to: { relation: pure.name, fields: ["a"] }
			}
		],
		projectedKeys: []
	}
}

/** The pick that selects the last of any number of options. */
const lastPick = pickSpan - 1

/** The case a plant is: on the planted group, its wild value inserted alone or its breaking statement alone. */
const plantedCase = (p: Plant): DirectCase => {
	const wild = (kind: 1 | 2 | 3): DirectCase["statements"] => [
		{ kind: 0, relation: 0, mode: 0, pick: 0, row: p.row, wild: kind }
	]
	const base = {
		group: lastPick,
		facts: p.facts,
		behind: p.behind,
		level: p.level,
		immediate: false,
		breaks: { kind: "none" },
		statements: []
	} as const
	switch (p.kind) {
		case "code outside the roster":
			return { ...base, statements: wild(3) }
		case "numeric past its precision":
			return { ...base, statements: wild(2) }
		case "text past its bound":
			return { ...base, statements: wild(1) }
		case "immediate reference broken":
			return { ...base, breaks: { kind: "alone", pick: lastPick, row: p.row } }
		case "deferred reference broken at COMMIT":
			return { ...base, breaks: { kind: "alone", pick: 0, row: p.row } }
		case "deferred reference broken at SET CONSTRAINTS":
			return { ...base, immediate: true, breaks: { kind: "alone", pick: 0, row: p.row } }
	}
}

/** The run's cases: the drawn ones with each plant at its drawn position. */
export const casesOf = (run: DirectRun): ReadonlyArray<DirectCase> =>
	Arr.reduce(run.plants, run.cases, (cases: ReadonlyArray<DirectCase>, p) => {
		const at = pickIndex(p.at, cases.length + 1)
		return [...cases.slice(0, at), plantedCase(p), ...cases.slice(at)]
	})

export const situations: Arr.NonEmptyReadonlyArray<DirectFeature> = [
	"statement insert",
	"statement insert without overriding",
	"statement insert generated",
	"statement insert missing a field",
	"statement delete",
	"statement update",
	"statement truncate",
	"23505 at a statement",
	"23503 at a statement",
	"23503 at COMMIT",
	"23503 at SET CONSTRAINTS",
	"42501 at a statement",
	"428C9 at a statement",
	"23514 at a statement",
	"23514 by a refined text domain at a statement",
	"23514 by a roster domain at a statement",
	"22003 at a statement",
	"23502 at a statement",
	"25000 at a statement",
	...Arr.map(levels, (l): DirectFeature => `level ${l}`),
	"committed"
]

export const runs = 40
