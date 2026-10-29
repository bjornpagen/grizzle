import { type Draw, sketched } from "@grizzle/testing/explore"
import { constant, type Gen, int, weighted } from "@grizzle/testing/gen"
import { fullSwarm, type Swarm } from "@grizzle/testing/swarm"
import { Array as Arr, Option } from "effect"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import {
	type GenConfig,
	type QueryCaseSketch,
	queryCaseSketchGen,
	resolveQueryCase
} from "#test/support/oracle/gen/case.ts"
import {
	byZeroSketchGen,
	type CompareSketch,
	powerSketchGen,
	type TermSketch,
	termSketchGen
} from "#test/support/oracle/gen/compute.ts"
import { allTypeSpecs } from "#test/support/oracle/gen/domain.ts"
import { type RowSketch, rowSketchGen } from "#test/support/oracle/gen/facts.ts"
import { type QueryFeature, type QuerySketch, undrawn } from "#test/support/oracle/gen/query.ts"
import { indices } from "#test/support/oracle/pick.ts"

/**
 * The finishes of the frontier populations: a query body ends, as drawn, or in a division by zero that a projection
 * keeping every column of the body delivers, or that a filter compares (gen/compute.ts byZeroSketchGen). Wherever such a
 * body delivers a row whose dividend is not NaN, the expression the answer needs fails, so failures every lowering must
 * raise meet every run, over every operator the body draws below them.
 *
 * The power finish replaces the body: a projection of a float power (powerSketchGen) over every fact of the schema's
 * first relation, which no containment empties and no filter thins, the population giving that relation float8 columns
 * and facts (powered). The oracle declines a float power (oracle/evaluate/catalog.ts declinedOps), so every delivered row
 * holds a value the reference leaves unstated, and the comparison holds its column by type alone.
 */
export type Finish =
	| PlainFinish
	| { readonly form: "power"; readonly term: TermSketch; readonly row: RowSketch }

/** The finishes that end a body rather than replace it. */
export type PlainFinish =
	| { readonly form: "none" }
	| { readonly form: "project"; readonly term: TermSketch }
	| { readonly form: "filter"; readonly compare: CompareSketch }

export const finishGen: Gen<PlainFinish> = weighted<PlainFinish>([
	[2, constant({ form: "none" })],
	[1, (source) => ({ form: "project", term: source.draw(byZeroSketchGen(1)) })],
	[
		1,
		(source) => ({
			form: "filter",
			compare: {
				op: source.draw(int(0, 5)),
				left: source.draw(byZeroSketchGen(1)),
				right: source.draw(termSketchGen(0))
			}
		})
	]
])

/**
 * The finishes of a population whose plain roots may also end in the power finish, which replaces the body: a root's
 * own finish only, never an attachment child's, which must read its parent. One finish in ten is a power, so the frontier
 * populations' bodies stay as drawn: measured on the host over eight seeds, a 375-case run of the computed or the dense
 * population delivers a declined column in 24 to 37 cases at this weight.
 */
export const poweredFinishGen: Gen<Finish> = weighted<Finish>([
	[9, finishGen],
	[
		1,
		(source) => ({
			form: "power",
			term: source.draw(powerSketchGen),
			row: source.draw(rowSketchGen)
		})
	]
])

const value = { cls: 0, sp: 0 } as const

/**
 * The column picks a finish projects or binds, 0 through 7: a pick reduces modulo the heading (oracle/pick.ts at), so
 * they reach every column of a heading of at most eight, as every generated relation's is (gen/schema.ts SchemaLimits
 * maxColumns, at most 5 in every population here).
 */
const columnPicks = 8

export const finished = (body: QuerySketch, finish: Finish): QuerySketch => {
	switch (finish.form) {
		case "none":
			return body
		case "filter":
			return { tag: "filter", input: body, pred: { tag: "term", compare: finish.compare } }
		case "project":
			return {
				tag: "project",
				input: body,
				out: [
					...Arr.map(indices(columnPicks), (pick) => ({
						literal: false,
						pick,
						value,
						term: undrawn
					})),
					{ literal: false, pick: 0, value, term: { kind: "drawn", value: finish.term } }
				]
			}
		case "power":
			return {
				tag: "project",
				input: {
					tag: "match",
					/** Every column of the first relation bound to a fresh variable (bind mode 0): its every fact. */
					occurrences: [
						{
							source: { tag: "relation", pick: 0 },
							columns: Arr.map(indices(columnPicks), (pick) => ({ mode: 0, pick, value }))
						}
					],
					equalities: [],
					lateral: undrawn
				},
				out: [
					...Arr.map(indices(columnPicks), (pick) => ({
						literal: false,
						pick,
						value,
						term: undrawn
					})),
					{ literal: false, pick: 0, value, term: { kind: "drawn", value: finish.term } }
				]
			}
	}
}

/** The palette pick of plain double precision (gen/domain.ts allTypeSpecs). */
const float8Pick = Option.getOrThrowWith(
	Arr.findFirstIndex(allTypeSpecs, (t) => t.carrier === "float8"),
	() => new Error("the palette holds double precision")
)

/**
 * A case sketch the power finish ends: every column of the schema's relations double precision, so the power's base is
 * one, no closed roster (whose enum would join the palette), and the first relation holding at least the finish's fact.
 * The first relation is filled first, so no containment drops it (gen/facts.ts resolveFacts).
 */
export const powered = (sketch: QueryCaseSketch, finish: Finish): QueryCaseSketch => {
	if (finish.form !== "power") {
		return sketch
	}
	return {
		...sketch,
		schema: { ...sketch.schema, palette: [float8Pick], closed: [] },
		facts:
			sketch.facts.length === 0
				? [[finish.row]]
				: Arr.map(sketch.facts, (rows, i) => (i === 0 ? [finish.row, ...rows] : rows))
	}
}

/**
 * A finished case's swarm keeps the given features at full weight: its finishing forms, computed terms, and whatever
 * root form carries the finish.
 */
export const keeping = (
	swarm: Swarm<QueryFeature>,
	features: ReadonlyArray<QueryFeature>
): Swarm<QueryFeature> => ({ ...swarm, ...fullSwarm(features) })

/** What a finished population draws: the generator's sketch and how its plain root is finished. */
export interface FinishedSketch {
	readonly sketch: QueryCaseSketch
	readonly finish: PlainFinish
}

/**
 * A population with its plain roots finished: each ends as drawn or, half of them, in a division by zero the answer
 * needs (finishGen), the finishing form and computed terms kept at full weight by the swarm. A population that draws its
 * failing terms for the shapes they meet, and so seldom forces a failure (the optimizer's with failing terms,
 * gen/case.ts optimizerFailingGenConfig), then meets failures every lowering must raise in every run, over every
 * operator and rewrite it draws below them. Drawn as sketches, so a failure prints a sketch a person can keep; the
 * property draws the case its sketch resolves to, the swarm's thinning decisions with it.
 */
export const finishedDraw = (config: GenConfig): Draw<FinishedSketch, Gen<QueryCase>> =>
	sketched(
		(source): FinishedSketch => ({
			sketch: source.draw(queryCaseSketchGen(config)),
			finish: source.draw(finishGen)
		}),
		({ sketch, finish }) =>
			resolveQueryCase(
				finish.form === "none" || sketch.root.tag !== "plain"
					? sketch
					: {
							...sketch,
							root: { ...sketch.root, body: finished(sketch.root.body, finish) },
							swarm: keeping(sketch.swarm, [finish.form, "compute"])
						},
				config
			)
	)
