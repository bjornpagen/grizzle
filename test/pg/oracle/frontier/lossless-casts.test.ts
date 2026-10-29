import { layer } from "@effect/vitest"
import { sketched } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, constant, type Gen, int, weighted } from "@grizzle/testing/gen"
import type { Swarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Formatter, Record, String as Str } from "effect"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import {
	exploreFrontier,
	type FrontierFeature,
	type FrontierOutcome
} from "#test/pg/oracle/frontier/support.ts"
/**
 * The dedup proof's injective casts, conservative and optimized against the reference evaluator on PostgreSQL 19.
 *
 * The optimized lowering drops a DISTINCT when a projection keeps a key, and a cast of a key column keeps it only when
 * the cast maps distinct values to distinct values under native equality (packages/engine/src/analysis/physical
 * injective.ts): a widening integer cast, an integer into numeric at a scale that does not round, smallint into a
 * float, integer into double precision, real into double precision, a numeric cast to a scale that does not round, a
 * contract or refinement dropped or added. Every other cast, a numeric typmod that rounds, double precision into real,
 * bigint into double precision, a float or numeric into an integer, merges values, and the DISTINCT must stay.
 *
 * This population is made of projections whose computed columns are chains of one or two casts over one column
 * (gen/compute.ts castChainSketchGen), delivered by projections that drop other columns, over schemas whose column
 * types are the numeric carriers: integers, bare numeric and numeric(5, 2) and numeric(3, 1) keys, real, double
 * precision and money, with the edge values (NaN, -0, the infinities, subnormals, ±MAX, wide numerics and the smallest
 * scale steps). The cast targets add numeric(1, 0), numeric(38, 10) and bare numeric. Each answer is judged as "error
 * or rows" against the reference (support.ts): a duplicate that leaks past a dropped DISTINCT is a row the reference
 * does not have, and a rounding cast whose DISTINCT went is a disagreement.
 */
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import {
	defaultGenConfig,
	type GenConfig,
	type QueryCaseSketch,
	queryCaseSketchGen,
	resolveQueryCase
} from "#test/support/oracle/gen/case.ts"
import { castChainSketchGen } from "#test/support/oracle/gen/compute.ts"
import {
	drawnGen,
	type QueryFeature,
	type QuerySketch,
	queryExprs,
	type RootSketch,
	undrawn
} from "#test/support/oracle/gen/query.ts"
import { valueSketchGen } from "#test/support/oracle/gen/schema.ts"
import { cyclicAt } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const cases = 250

/**
 * What a cast-projection case reaches: a cast in its query, a DISTINCT the optimized artifact dropped through an
 * injective cast, and the values an injective cast must keep apart.
 */
type CastFeature = "cast" | "a DISTINCT dropped through an injective cast" | "NaN" | "-0"

const config: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultGenConfig.query,
		compute: 8,
		castChains: true,
		roots: {
			...defaultGenConfig.query.roots,
			attach: 0,
			hetero: 0
		},
		/** Mostly stored relations under filters, whose keys the root projection can keep through a cast. */
		weights: {
			...defaultGenConfig.query.weights,
			match: 8,
			filter: 3,
			project: 2,
			semi: 1,
			anti: 1,
			group: 1,
			union: 1,
			intersect: 0,
			difference: 0,
			closure: 0,
			take: 1
		}
	},
	edge: true
}

/**
 * The positions of the numeric carriers among the schema generator's base types (gen/domain.ts baseTypeSpecs): bare
 * numeric, double precision, real, numeric(5, 2), numeric(3, 1), integer, bigint, smallint and money.
 */
const numericPalette: ReadonlyArray<number> = [2, 4, 8, 10, 11, 0, 3, 7, 9]

/**
 * Every case delivers a projection of cast chains over its query's columns at its root, with projection and
 * computation on in its swarm.
 * A projected column: a cast chain over a column, or the column itself, so a projection keeps a composite key with one
 * part cast.
 */
type OutSketch = Extract<QuerySketch, { readonly tag: "project" }>["out"][number]

const castOut: Gen<OutSketch> = weighted<OutSketch>([
	[
		2,
		(source) => ({
			literal: false,
			pick: source.draw(int(0, 7)),
			value: source.draw(valueSketchGen),
			term: source.draw(drawnGen(castChainSketchGen))
		})
	],
	[
		1,
		(source) => ({
			literal: false,
			pick: source.draw(int(0, 7)),
			value: source.draw(valueSketchGen),
			term: source.draw(constant(undrawn))
		})
	]
])

const forced = (swarm: Swarm<QueryFeature>): Swarm<QueryFeature> => ({
	...swarm,
	project: 3,
	compute: 3
})

/** The case sketch a cast projection ends, over the numeric palette, projection and computation forced on. */
const castSketchGen: Gen<QueryCaseSketch> = (source) => {
	const sketch = source.draw(queryCaseSketchGen(config))
	const out = source.draw(array(castOut, { min: 1, max: 4 }))
	/** The roots are plain sets (attachments and heterogeneous unions are weighted out). */
	const root: RootSketch =
		sketch.root.tag === "plain"
			? {
					...sketch.root,
					body: { tag: "project", input: sketch.root.body, out } satisfies QuerySketch
				}
			: sketch.root
	return {
		...sketch,
		schema: {
			...sketch.schema,
			palette: Arr.map(sketch.schema.palette, (p) =>
				cyclicAt(numericPalette, p, "the numeric palette")
			)
		},
		root,
		swarm: forced(sketch.swarm)
	}
}

/**
 * The features of a cast-projection case: casts in its query, a DISTINCT the optimized artifact dropped through an
 * injective cast, and the values whose spelling an injective cast must keep apart: NaN and -0.
 */
const castFeatures = (c: QueryCase, o: FrontierOutcome): ReadonlyArray<CastFeature> => {
	const values = Record.values(c.facts).flat().flat()
	return [
		...(Arr.some(queryExprs(c.query.dag), (e) => e.kind === "cast") ? ["cast" as const] : []),
		...(Arr.some(o.certificates, (cert) =>
			Arr.some(cert.coercion, (k) => Str.startsWith("cast:")(k))
		)
			? ["a DISTINCT dropped through an injective cast" as const]
			: []),
		...(Arr.some(
			values,
			(v) =>
				(v.kind === "floatSpecial" && v.value === "NaN") ||
				(v.kind === "numeric" && decimalPayload(v.value) === "NaN")
		)
			? ["NaN" as const]
			: []),
		...(Arr.some(values, (v) => v.kind === "float" && Object.is(v.value, -0))
			? ["-0" as const]
			: [])
	]
}

const required = [
	"reference rows",
	"cast",
	"a DISTINCT dropped through an injective cast",
	"NaN",
	"-0"
] as const satisfies ReadonlyArray<FrontierFeature | CastFeature>

const run = exploreFrontier<QueryCaseSketch, CastFeature>(
	sketched(castSketchGen, (sketch) => resolveQueryCase(sketch, config)),
	"lossless",
	{
		suite: "frontier/lossless-casts",
		literal: Formatter.format,
		features: features<FrontierFeature | CastFeature>(required),
		kept: [],
		runs: cases,
		/** Every candidate runs on PostgreSQL. */
		shrink: { kind: "bounded", candidates: 150 },
		steering: { kind: "none" },
		caseHang: Duration.minutes(2),
		perturb: "all"
	},
	castFeatures
)

layer(Substrate.layer)(
	"the dedup proof's injective casts against the reference, error or rows",
	(it) => {
		it.effect(
			`agrees on ${cases} generated cast projections`,
			(ctx) => searched(ctx, run),
			1_800_000
		)
	}
)
