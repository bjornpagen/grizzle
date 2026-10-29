/**
 * Spans, vectors, contracts, refined and TOAST-sized text mixed into the general generated queries, on PostgreSQL 19.
 *
 * The schema generator's extended types (gen/domain.ts extendedTypeSpecs) join the palette: a contract over bigint
 * and one over regex-refined text, as column types and, bound at their base, as comparison parameters; unbounded text
 * whose values include incompressible TOAST-sized ones stored out of line, two of which differ only in their last code
 * point; spans over integer and bigint, which filters test with r.allen against a span column, literal or parameter, and
 * by endpoint predicates between span columns (lower() and upper() compared, an endpoint as a point of a span), which
 * the optimized artifact's Allen normal form rewrites into range operators and the conservative lowering keeps;
 * and three-dimensional vectors, compared and projected through pgvector's exact cosine distance. Every other part of
 * the population is the general one: joins, unions, groups, takes, closures, attachments and heterogeneous unions,
 * computed terms and the edge values.
 *
 * Two runners judge it:
 * - the frontier runner (support.ts): both lowerings against the reference evaluator as error or rows, with Allen
 *   atoms evaluated from the endpoints; where the reference cannot state the rows (pgvector's distances), every
 *   lowering's rows against the conservative lowering's;
 * - the optimized differential (../optimized/suite.ts), attachments included, so fused arrays carry spans, vectors,
 *   contracts and TOAST-sized text through the unfused comparison.
 *
 * The extended types are the six past the base ones.
 */
import { layer } from "@effect/vitest"
import { type Draw, sketched } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { boolean, constant, type Gen, int, map, option, weighted } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Formatter, Option, Record } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { RangeOpCode } from "#compiler/ir/expr.ts"
import { contractOf } from "#compiler/ir/scalar.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { keeping } from "#test/pg/oracle/frontier/finish.ts"
import { exploreFrontier, type FrontierFeature } from "#test/pg/oracle/frontier/support.ts"
import {
	differential,
	type OptimizedFeature,
	optimizedShrink
} from "#test/pg/oracle/optimized/suite.ts"
import {
	defaultGenConfig,
	type GenConfig,
	type QueryCase,
	type QueryCaseSketch,
	queryCaseSketchGen,
	resolveQueryCase
} from "#test/support/oracle/gen/case.ts"
import { cosineSketchGen, type TermSketch } from "#test/support/oracle/gen/compute.ts"
import {
	allTypeSpecs,
	baseTypeSpecs,
	textFlavor,
	type ValueSketch
} from "#test/support/oracle/gen/domain.ts"
import {
	type QuerySketch,
	queryExprs,
	type RootSketch,
	undrawn
} from "#test/support/oracle/gen/query.ts"
import { valueSketchGen } from "#test/support/oracle/gen/schema.ts"
import { cyclicAt, indices } from "#test/support/oracle/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const cases = 250

/**
 * What a mixed case reaches: a contract column (by the generator's contract name), span, vector and unbounded text
 * columns, a TOAST-sized fact, an Allen filter, an endpoint predicate, a cosine distance, and a term that can fail over
 * an empty closed relation.
 */
type MixedFeature =
	| `contract ${string}`
	| "span column"
	| "vector column"
	| "unbounded text column"
	| "TOAST-sized fact"
	| "Allen filter"
	| "endpoint predicate"
	| "cosine distance"
	| "failing term over an empty closed relation"

const frontierConfig: GenConfig = {
	...defaultGenConfig,
	schema: {
		...defaultGenConfig.schema,
		extended: true
	},
	query: {
		...defaultGenConfig.query,
		compute: 6,
		allen: 8,
		endpoints: 8,
		roots: {
			...defaultGenConfig.query.roots,
			attach: 0
		}
	},
	edge: true
}

/**
 * The optimized differential draws only total computed terms (an execution error ends its case; the frontier runner
 * judges failing terms), so its vectors meet comparisons, joins and the distances that cannot fail.
 */
const differentialConfig: GenConfig = {
	...defaultGenConfig,
	schema: {
		...defaultGenConfig.schema,
		extended: true
	},
	query: {
		...defaultGenConfig.query,
		allen: 8,
		endpoints: 8,
		compute: 3,
		failing: false
	}
}

/**
 * Every other palette pick names an extended type, so most schemas hold one or two of them, spans and vectors twice as
 * often as the others (a key field drawn as either takes another type, so they reach fewer columns).
 */
const extendedPicks: ReadonlyArray<number> = Arr.map(
	[3, 4, 5, 3, 4, 5, 0, 1, 2],
	(i) => baseTypeSpecs.length + i
)

if (allTypeSpecs.length - baseTypeSpecs.length !== 6) {
	throw new Error("the extended palette is six types")
}
/**
 * Half the cases end in a filter and a projection that keeps every column and adds a cosine distance from a vector
 * column where the scope holds one. Most finishes filter by r.allen and an endpoint predicate, so Allen filters,
 * endpoint predicates and distances meet every population; the others filter by the literal false, so the projected
 * term, which can fail, stands over a relation that holds no row.
 */
const value = { cls: 0, sp: 0 }

/**
 * A finish's filter: an r.allen over a span column and an endpoint predicate beside it, or a filter that holds no row,
 * the literal false, which the optimized artifact's simplification turns into an empty closed relation.
 */
type FinishFilter =
	| {
			readonly kind: "spans"
			readonly column: number
			readonly mask: number
			readonly window: ValueSketch
			/**
			 * The endpoint predicate beside the r.allen: the column's lower or upper endpoint compared by `op`
			 * (compareOps) with an endpoint of the span column `pick` of its carrier, or, at op 6, held as a point of the
			 * window, so the predicate is over the pair the r.allen relates and the optimizer's Allen normal form joins
			 * the two.
			 */
			readonly endpoint: {
				readonly upper: boolean
				readonly op: number
				readonly pick: number
				readonly pickUpper: boolean
			}
	  }
	| { readonly kind: "empty" }

interface Finish {
	readonly filter: FinishFilter
	/**
	 * The projected term: a cosine distance from the scope's vector column wherever it holds one, else the binary term
	 * it degrades to (gen/compute.ts cosineSketchGen), so "cosine distance" follows whenever a vector column is in scope.
	 */
	readonly term: TermSketch
}

const finishFilterGen: Gen<FinishFilter> = weighted<FinishFilter>([
	[
		3,
		(source) => ({
			kind: "spans",
			column: source.draw(int(0, 7)),
			mask: source.draw(int(0, 8191)),
			window: source.draw(valueSketchGen),
			endpoint: {
				upper: source.draw(boolean),
				op: source.draw(int(0, 6)),
				pick: source.draw(int(0, 7)),
				pickUpper: source.draw(boolean)
			}
		})
	],
	[1, constant({ kind: "empty" })]
])

const finishGen: Gen<Finish> = (source) => ({
	filter: source.draw(finishFilterGen),
	term: source.draw(cosineSketchGen)
})

const finishPred = (f: FinishFilter): Extract<QuerySketch, { readonly tag: "filter" }>["pred"] => {
	switch (f.kind) {
		case "spans":
			return {
				tag: "and",
				args: [
					{
						tag: "allen",
						column: f.column,
						mask: f.mask,
						rhs: { tag: "literal", value: f.window }
					},
					{
						tag: "endpoint",
						column: f.column,
						upper: f.endpoint.upper,
						op: f.endpoint.op,
						rhs:
							f.endpoint.op === 6
								? { tag: "literal", value: f.window }
								: { tag: "column", pick: f.endpoint.pick },
						rhsUpper: f.endpoint.pickUpper
					}
				]
			}
		case "empty":
			return { tag: "const", value: false }
	}
}

const finished = (body: QuerySketch, f: Finish): QuerySketch => ({
	tag: "project",
	input: { tag: "filter", input: body, pred: finishPred(f.filter) },
	out: [
		...Arr.map(indices(8), (pick) => ({ literal: false, pick, value, term: undrawn })),
		{ literal: false, pick: 0, value, term: { kind: "drawn", value: f.term } }
	]
})

/** What the mixed population draws: the generator's sketch, and the finish of its plain root, if any. */
interface MixedSketch {
	readonly sketch: QueryCaseSketch
	readonly finish: Finish | undefined
}

/**
 * The mixed population, drawn as sketches, so a failure prints a sketch a person can keep: the palette favours the
 * extended types and a finish, when drawn, ends the plain root, its filter, projection and computed term kept at full
 * weight by the swarm (finish.ts keeping), as the other frontier suites keep their finishes.
 */
const mixedDraw = (config: GenConfig): Draw<MixedSketch, Gen<QueryCase>> => {
	const sketchGen = queryCaseSketchGen(config)
	const finishes = map(option(finishGen), Option.getOrUndefined)
	return sketched(
		(source): MixedSketch => ({ sketch: source.draw(sketchGen), finish: source.draw(finishes) }),
		({ sketch: s, finish }) =>
			resolveQueryCase(
				{
					...s,
					...(finish === undefined || s.root.tag !== "plain"
						? {}
						: { swarm: keeping(s.swarm, ["filter", "project", "compute"]) }),
					schema: {
						...s.schema,
						palette: Arr.map(s.schema.palette, (p) =>
							p % 2 === 0
								? cyclicAt(extendedPicks, p >> 1, "the extended type picks")
								: (p >> 1) % baseTypeSpecs.length
						)
					},
					root:
						finish === undefined || s.root.tag !== "plain"
							? s.root
							: ({ ...s.root, body: finished(s.root.body, finish) } satisfies RootSketch)
				},
				config
			)
	)
}

/**
 * Whether some projection holds a term that can fail over an empty closed relation: a closed relation with no rows, or
 * a filter by the literal false.
 */
const failingOverEmptyClosed = (c: QueryCase): boolean =>
	Arr.some(topoOrder(c.query.dag), (n) => {
		if (n.kind !== "ProjectSet" || !Arr.some(n.out, (o) => o.expr.failure === "canFail")) {
			return false
		}
		const input = n.input
		if (input.kind === "Closed") {
			return input.rows.length === 0
		}
		if (input.kind !== "Filter") {
			return false
		}
		const pred = input.pred
		return pred.kind === "literal" && pred.value.kind === "bool" && !pred.value.value
	})

/**
 * The features a case reaches, from its schema, facts and query.
 * The Allen atoms' range operators but equality.
 */
const allenCodes: ReadonlySet<RangeOpCode> = new Set([
	"range_overlaps",
	"range_contains",
	"range_contained_by",
	"range_before",
	"range_after",
	"range_overleft",
	"range_overright",
	"range_adjacent"
])
/** The span endpoints an endpoint predicate compares. */
const endpointCodes: ReadonlySet<RangeOpCode> = new Set(["lower(anyrange)", "upper(anyrange)"])

const featuresOf = (c: QueryCase): ReadonlyArray<MixedFeature> => {
	const out = new Set<MixedFeature>()
	for (const col of Arr.flatMap(c.schema.relations, (r) => r.columns)) {
		const contract = contractOf(col.type)
		if (contract !== undefined) {
			out.add(`contract ${contract.name}`)
		}
		if (col.type.carrier === "range4" || col.type.carrier === "range8") {
			out.add("span column")
		}
		if (col.type.carrier === "vector") {
			out.add("vector column")
		}
		if (col.type.carrier === "text" && textFlavor(col.type) === "long") {
			out.add("unbounded text column")
		}
	}
	const values = Record.values(c.facts).flat().flat()
	if (Arr.some(values, (v) => v.kind === "text" && v.value.length >= 2_000)) {
		out.add("TOAST-sized fact")
	}
	for (const e of queryExprs(c.query.dag)) {
		if (e.kind !== "op") {
			continue
		}
		if (typeof e.op !== "string" && allenCodes.has(e.op.code)) {
			out.add("Allen filter")
		}
		if (typeof e.op !== "string" && endpointCodes.has(e.op.code)) {
			out.add("endpoint predicate")
		}
		if (nativeOp(e.op)?.fn === "cosineDistance") {
			out.add("cosine distance")
		}
	}
	if (failingOverEmptyClosed(c)) {
		out.add("failing term over an empty closed relation")
	}
	return [...out]
}

const required = [
	"contract Tick",
	"contract Code",
	"span column",
	"vector column",
	"unbounded text column",
	"TOAST-sized fact",
	"Allen filter",
	"endpoint predicate",
	"cosine distance",
	"failing term over an empty closed relation"
] as const satisfies ReadonlyArray<MixedFeature>

const frontier = exploreFrontier<MixedSketch, MixedFeature>(
	mixedDraw(frontierConfig),
	"mixed",
	{
		suite: "frontier/mixed-types",
		literal: Formatter.format,
		features: features<FrontierFeature | MixedFeature>([
			...required,
			"reference rows",
			"reference unstated"
		]),
		kept: [],
		runs: cases,
		/** Every candidate runs on PostgreSQL. */
		shrink: { kind: "bounded", candidates: 150 },
		steering: { kind: "none" },
		caseHang: Duration.minutes(2),
		perturb: "all"
	},
	(c) => featuresOf(c)
)

const optimized = differential(mixedDraw(differentialConfig), "mixedopt", {
	suite: "optimized/mixed-types",
	literal: Formatter.format,
	/**
	 * simplify.allen: an endpoint predicate between two span columns rewritten into the formula of its Allen mask, so
	 * the differential judges the rewrite against the conservative lowering, which keeps the endpoint form.
	 */
	features: features<OptimizedFeature>(["nonempty", "computed term", "simplify.allen"]),
	kept: [],
	runs: cases,
	shrink: optimizedShrink,
	steering: { kind: "none" },
	caseHang: Duration.minutes(2),
	perturb: "all"
})

layer(Substrate.layer)(
	"spans, vectors, contracts and TOAST-sized text in generated queries",
	(it) => {
		it.effect(
			`agree with the reference on ${cases} generated cases`,
			(ctx) => searched(ctx, frontier),
			1_800_000
		)

		it.effect(
			`the optimized artifact agrees with the conservative lowering on ${cases} generated cases`,
			(ctx) => searched(ctx, optimized),
			1_800_000
		)
	}
)
