/**
 * The direct-writer model as an exploration: generated runs, each a generated write schema installed once with a
 * psql child in its world (logged in as its login, the role `writer` taken on), whose cases run direct transactions the
 * model predicts (model.ts).
 *
 * The population must reach every statement kind, each native error at the time PostgreSQL raises it (a unique
 * violation, an immediate foreign key, a privilege refusal, an identity column's refusal, a refined text's domain's
 * and a closed id's roster domain's, each by its CHECK, a precision's and a missing field's at the statement; a
 * deferred foreign key at COMMIT and at SET CONSTRAINTS), and commits; and every level below SERIALIZABLE a writer may
 * begin at, each refused by grizzle's guard (25000 naming the table, nothing committed).
 *
 * Six of those errors need a column kind or a foreign key a third of the generated schemas hold, and a case that meets
 * them first: a code outside the roster's live codes (23514), a numeric past its precision (22003), a refined text past
 * its bound (23514), an immediate foreign key at its statement and a deferred one at COMMIT and at SET CONSTRAINTS
 * (23503). Each run plants them: its schema holds one more group of its own (plantedGroup, a parent with a closed id, a
 * numeric(3, 0) and a refined text column, a pure set, and a child of each, the one into the parent deferred, the one
 * into the pure set immediate), and among its drawn cases, at drawn positions, one planted case of each, its stored
 * facts, row, level and sequences drawn: the wild value inserted alone, or the breaking statement alone. So every
 * required feature is reached in every run that holds the planted cases, and the drawn cases still reach them
 * organically.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/direct-writers-rule-keys-deferred.patch, every foreign key the
 * schema-wide rule decides installed deferred, moves the immediate reference's refusal to COMMIT and must turn the
 * property red.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type DirectCase,
	type DirectFeature,
	directCaseGen,
	type Level,
	levelGen,
	levels,
	runDirectCase
} from "#test/pg/direct-writers/model.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import {
	type FactsSketch,
	factsSketchGen,
	type RowSketch,
	rowSketchGen
} from "#test/support/oracle/write/facts.ts"
import { CaseFailed } from "#test/support/oracle/write/harness.ts"
import { openTarget } from "#test/support/oracle/write/run.ts"
import {
	printSchema,
	resolveSchema,
	type SchemaSketch,
	schemaSketchGen,
	type WGroup,
	type WRelation,
	type WSchema
} from "#test/support/oracle/write/schema.ts"
import { pickGen, pickIndex, pickSpan } from "#test/support/pick.ts"
import { Substrate, worldPsql } from "#test/support/substrate/substrate.ts"

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

const directRunGen: Gen<DirectRun> = (source) => ({
	schema: source.draw(schemaSketchGen),
	/** Up to ten cases on one installed schema, which a run installs once. */
	cases: source.draw(array(directCaseGen, { min: 1, max: 10 })),
	plants: Arr.map(plantKinds, (kind) => source.draw(plantGen(kind)))
})

/**
 * The group a run adds to its drawn schema, last, at `index` (see the header): its relations named as the generated
 * ones are, so they share no name.
 */
const plantedGroup = (index: number): WGroup => {
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
const casesOf = (run: DirectRun): ReadonlyArray<DirectCase> =>
	Arr.reduce(run.plants, run.cases, (cases: ReadonlyArray<DirectCase>, p) => {
		const at = pickIndex(p.at, cases.length + 1)
		return [...cases.slice(0, at), plantedCase(p), ...cases.slice(at)]
	})

const situations: Arr.NonEmptyReadonlyArray<DirectFeature> = [
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

const runs = 40

layer(Substrate.layer, { excludeTestServices: true })("the direct-writer model", (it) => {
	it.effect(
		`${runs} generated direct transactions meet the native errors the model predicts`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the direct-writer model (model.ts): each statement's native error at the time PostgreSQL raises it, or the state the transaction commits"
						},
						suite: "direct-writers",
						draw: drawn(directRunGen),
						literal: Formatter.format,
						coverage: required<DirectFeature>(situations, { cases: runs, sense: notesOnly }),
						kept: [],
						runs,
						/**
						 * Each shrink candidate installs a schema of its own: shrinking stops after 300 of them.
						 */
						shrink: { kind: "bounded", candidates: 300 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(run, cx) =>
						Effect.scoped(
							Effect.gen(function* () {
								const s = yield* Substrate
								const drawnSchema = cx.draw(resolveSchema(run.schema))
								const schema: WSchema = {
									groups: [...drawnSchema.groups, plantedGroup(drawnSchema.groups.length)]
								}
								const cases = casesOf(run)
								const target = yield* Effect.mapError(
									openTarget(schema, "analyzed", ordinarySession),
									(e) =>
										new CaseFailed({
											report: `${printSchema(schema)}\ndid not install: ${messageOf(e)}`
										})
								)
								const writer = yield* Effect.orDie(
									s.psql({
										...worldPsql(target.installed.world(target.built.worldOf(target.value).writer)),
										label: "direct writer"
									})
								)
								for (const [i, c] of cases.entries()) {
									yield* runDirectCase(target, writer, c, cx.note).pipe(
										Effect.mapError(
											(e) =>
												new CaseFailed({
													report: `${printSchema(schema)}\ncase ${i + 1} of ${cases.length}:\n${e.report}`
												})
										)
									)
								}
							})
						)
				)
			)
	)
})
