import {
	drawn,
	type Explored,
	explore,
	type Kept,
	type PropertyFalsified,
	type Run,
	type SearchFailure
} from "@grizzle/testing/explore"
import { rating, required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import type { Swarm } from "@grizzle/testing/swarm"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { Conversion, Stitch } from "#test/pg/oracle/public/planted.ts"
import { type Disagreement, runCase } from "#test/pg/oracle/public/run.ts"
import { declineFeatures } from "#test/pg/oracle/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import type { CompareOp } from "#test/support/oracle/gen/ops.ts"
import { type PlannerSetting, unperturbed } from "#test/support/oracle/perturb.ts"
import {
	type CaseSketch,
	caseSketchGen,
	mixedForms,
	plantedNameCount,
	type Population,
	type ProgramFeature,
	programForms,
	resolveCase,
	type SwarmFeature
} from "#test/support/oracle/public/generate.ts"
import type {
	AggregateFn,
	FieldKind,
	NameKind,
	Operand,
	ParentColumn,
	StatedDelivery
} from "#test/support/oracle/public/program.ts"
import type { DeclineReason } from "#test/support/oracle/reference/values.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The explorations of the public differential, each its own suite (its own floor seed): the real one, and the two
 * planted defects (planted.test.ts).
 */
export type PublicSuite = "public" | "public/planted-stitch" | "public/planted-conversion"

/**
 * The cases of the rotating stream; every case installs a schema through its migration, so the population is small and
 * its cases rich.
 */
export const cases = 80

/** The suite's required features, and every program form the generator draws: each must be reached on every run. */
const situations = [
	"attachment fused",
	"attachment pipelined",
	"attachment nested",
	"stated option",
	"stated one",
	"stated arm",
	"arm some",
	"arm none",
	"two spellings among parent keys",
	"pipelined attachment over two spellings of one parent key",
	"fused attachment over two spellings of one parent key",
	"a vector parent key stored with a -0 component",
	"a collapse over two stored spellings of one value",
	"a display-scale reading over a collapsed or padded value",
	"a padded term at a collapse",
	"padded mean",
	"facts by a direct writer",
	"facts reordered on a second reading",
	"a fact respelled on a second reading",
	"key of float8",
	"get some",
	"get none",
	"get refused: not proved at most one row",
	"key get some",
	"key get none",
	"page",
	"refused encode",
	"refused page size",
	"refused cursor",
	"key get closed some",
	...programForms,
	...mixedForms
] as const

/**
 * Every feature a case notes (run.ts): the required ones, the program's shapes and names, the planner settings, the
 * deliveries the runtime chose, and every program feature of its query reads.
 */
export type PublicFeature =
	| (typeof situations)[number]
	| `name ${NameKind}`
	| `planner ${PlannerSetting}`
	| `bind ${Operand<ParentColumn>["kind"]}`
	| `compare ${CompareOp} ${Operand<never>["kind"]}`
	| `aggregate ${AggregateFn}`
	| `declined ${DeclineReason}`
	| `key of ${FieldKind}`
	| `stated ${StatedDelivery["kind"]}`
	| `attachment ${"fused" | "pipelined"}`
	| "candidate key"
	| "key get closed"
	| "key get candidate"
	| "key get primary"
	| "union"
	| "take"
	| "ordered"
	| "zero-column head"
	| "parameter"
	| "roster match"
	| "existential"
	| "negation"
	| "attachments, several"
	| "attachment"
	| "attachment nested"
	| "pages, several"
	| ProgramFeature

/** The kept sketches, each the floor of every pick, zero, but for the picks that select what it plants. */
const zeros = (length: number): ReadonlyArray<number> => Array.from({ length }, () => 0)
const floorValue = { cls: 0, sp: 0 } as const
type ReadSketch = CaseSketch["reads"][number]
type MatchSketch = ReadSketch["rule"]["matches"][number]
type RelationSketch = CaseSketch["relations"][number]

/**
 * A match of the sources `source` and `derived` pick, every bind at the floor: the mode a drawn binding takes is the
 * case's own decision, which its draws carry.
 */
const match = (source: number, derived: number): MatchSketch => ({
	source,
	derived,
	attached: 0,
	binds: Arr.map(indices(7), () => ({ how: 0, pick: 0, value: floorValue }))
})
const head = { vars: [], names: zeros(6), folds: [{ fn: 0, arg: 0, padded: 0, scale: 0 }] } as const
const negation = { source: 0, picks: zeros(2) } as const
const read = (
	matches: ReadonlyArray<MatchSketch>,
	pointIn: ReadSketch["rule"]["pointIn"],
	links: { readonly importable: number; readonly bindImport: number; readonly closurePair: number }
): ReadSketch => ({
	rule: {
		matches,
		where: [],
		between: [],
		inSet: [],
		allen: [],
		pointIn,
		connective: [],
		computed: [],
		negation,
		head,
		interior: { matches: [match(0, 0)], where: [], negation, head }
	},
	take: { rotate: 0, dirs: zeros(3), size: 0 },
	literalHead: { name: 0, kind: 0, arms: 0, values: zeros(3) },
	importable: links.importable,
	bindImport: links.bindImport,
	named: 0,
	relationParam: { relation: 0, facts: [] },
	closure: { relation: 0, pair: links.closurePair, name: 0 },
	attachments: [],
	order: { rotate: 0, dirs: zeros(3), size: 0 },
	probe: { kind: 0, pick: 0 },
	key: { relation: 0, which: 0, fact: 0, absent: 0, roster: 0 }
})
const unlinked = { importable: 0, bindImport: 0, closurePair: 0 } as const
/** A relation of fields of the `kinds` picks, each fact the value classes its picks select, field by field. */
const relation = (
	kinds: ReadonlyArray<number>,
	facts: ReadonlyArray<ReadonlyArray<number>>
): RelationSketch => ({
	name: 0,
	fields: Arr.map(kinds, (kind) => ({ name: 0, kind, key: 0 })),
	candidate: 0,
	facts: Arr.map(facts, (classes) => ({
		values: Arr.map(indices(7), (i) => ({ cls: classes[i] ?? 0, sp: 0 }))
	}))
})

const caseSketch = (
	population: Population,
	swarm: Swarm<SwarmFeature>,
	relations: ReadonlyArray<RelationSketch>,
	reads: ReadonlyArray<ReadSketch>
): CaseSketch => ({
	population,
	swarm,
	perturbation: unperturbed,
	ambient: ordinarySession,
	restorage: { shift: 0, respell: 0 },
	roster: 0,
	span: 0,
	relations,
	reads,
	planted: {
		names: zeros(plantedNameCount),
		value: floorValue,
		handle: 0,
		padding: 0,
		side: { kind: 0, values: zeros(3) }
	}
})

/**
 * The form-directed population's swarm (generate.ts formsOn and formsOff): every program form and what each needs at
 * full weight, key reads, unit heads and ungrouped aggregates off. A kept case of the population adds the features its
 * population left free, each at its weight.
 */
const forms = {
	import: 3,
	"import bound": 3,
	"bind param": 3,
	interior: 3,
	named: 3,
	"computed head": 3,
	"computed group key": 3,
	between: 3,
	"in set": 3,
	connective: 3,
	"relation param": 3,
	recursive: 3,
	where: 3,
	"compare param": 3,
	"contract param": 3,
	"typmod param": 3,
	allen: 3,
	"point in": 3,
	union: 3,
	"literal head": 3
} as const satisfies Swarm<SwarmFeature>

/**
 * The planted population's case (generate.ts plantedCase), whose key reads get a stored fact, a key no fact holds and a
 * roster handle. And cases of the form-directed population that read an earlier read's import bound to a parameter and
 * to an outer variable, a recursive closure and a point in a span, each in a read that delivers rows: each the sketch an
 * offline search over that population shrank, given two facts per relation and a read of the form the reference
 * delivers rows for. And issue #3's two acceptance cases (generate.ts acceptanceCollapse and acceptanceMean): its shrunk
 * case under its stated perturbation, and the mean over one value in two spellings under every planner setting, each
 * read again over its facts in the other order (its restorage), both judged by the one exact check.
 *
 * A planted or acceptance case resolves drawing nothing. A form-directed case draws, in the order its resolution asks: a decision
 * keeping or leaving each place a feature of weight 1 or 2 could appear (0 leaves it), and one choosing each binding's
 * mode among the modes the swarm turns on, in proportion to their weights (0 the first that is on).
 */
const planted: ReadonlyArray<Kept<CaseSketch, PublicFeature>> = [
	{
		note: "the planted case and its key reads",
		sketch: caseSketch("planted", {}, [relation([0], [])], []),
		draws: "",
		reaches: ["key get some", "key get none", "key get closed some"]
	},
	{
		note: "issue #3's shrunk case: Task's 0 in two spellings, collapsed under its plan",
		sketch: {
			...caseSketch("acceptance collapse", {}, [relation([0], [])], []),
			perturbation: {
				settings: [
					"enable_hashjoin = off",
					"enable_sort = off",
					"plan_cache_mode = force_generic_plan"
				],
				multiplier: 1
			}
		},
		draws: "",
		reaches: ["facts by a direct writer", "attachment nested", "stated option"]
	},
	{
		note: "issue #3's mean over 0 at display scale 24, 0, 1 and 3, under every setting",
		sketch: {
			...caseSketch("acceptance mean", {}, [relation([0], [])], []),
			perturbation: {
				settings: [
					"enable_hashjoin = off",
					"enable_mergejoin = off",
					"enable_sort = off",
					"debug_parallel_query = regress",
					"plan_cache_mode = force_generic_plan",
					"parallel_setup_cost = 0",
					"parallel_tuple_cost = 0",
					"min_parallel_table_scan_size = 0"
				],
				multiplier: 1
			}
		},
		draws: "",
		reaches: [
			"facts by a direct writer",
			"a collapse over two stored spellings of one value",
			"a display-scale reading over a collapsed or padded value"
		]
	},
	{
		note: "an earlier read imported, bound to a parameter and to an outer variable",
		sketch: caseSketch(
			"forms",
			{ ...forms, "bind fresh": 2, "bind existential": 1, "bind parent": 1, dense: 2 },
			[relation([0, 0], [[0], [32768]])],
			[
				read([match(0, 0), match(0, 0)], [], { ...unlinked, importable: 32768 }),
				read([match(0, 0)], [], { ...unlinked, bindImport: 32768 }),
				read([match(0, 0)], [], unlinked)
			]
		),
		draws: "0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0",
		reaches: ["an import bound to a parameter", "an import bound to an outer variable"]
	},
	{
		note: "a recursive closure over two fields of a relation",
		sketch: caseSketch(
			"forms",
			{ ...forms, "bind parent": 1, roster: 2, spelled: 1, "handle field": 1 },
			[relation([9363, 5958, 0], [[0, 0, 36409], [7282]])],
			[
				read([match(32768, 0), match(32768, 32768), match(32768, 0)], [], {
					...unlinked,
					closurePair: 32768
				}),
				read([match(0, 0)], [], unlinked)
			]
		),
		draws: "0.0.0.0.0.0.0.0.0.1.0.0.3.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0",
		reaches: ["a recursive closure"]
	},
	{
		note: "a point in a span",
		sketch: caseSketch(
			"forms",
			{ ...forms, "bind fresh": 2, "bind join": 2, "bind existential": 3, "bind parent": 2 },
			[relation([0], [[0, 0, 0, 24576], [9363]])],
			[read([match(0, 0)], [{ span: 0, point: 0 }], unlinked)]
		),
		draws: "0.0.0.0.0.0.0.0",
		reaches: ["a point in a span"]
	}
]

/**
 * The public-boundary differential as an exploration: generated programs through grizzle's public builders and
 * runtime, each read compared with the reference evaluator's per-parent delivery (run.ts).
 *
 * The suite's features are what its population must keep reaching, because each is a way the public boundary can be
 * wrong that only it reaches:
 *
 * - an attachment fused into its parent's statement, one pipelined as a statement of its own, and a nested one;
 * - each stated delivery the decoder binds: an Option, the one child, and an arm read Some and None by its parent's
 *   handle, each licensed by the analysis and kept by the reference;
 * - facts stored by a direct SQL writer at SERIALIZABLE, each value in its drawn input spelling, since db.apply stores
 *   every value in its one form;
 * - two parents whose keys are equal but stored in different spellings (1.0 and 1.00), with children, under a
 *   pipelined and under a fused attachment, and a vector key stored with -0 components: the stitch by key must use
 *   the type's equality, not the text;
 * - one value in two stored spellings collapsed into one row, a padding (a cast to numeric(1000, s) and back) at a
 *   collapse, a display-scale reading (a quotient, a root, a power or a mean) over either, and a mean of a padding:
 *   a value is only its value, whatever its display scale, so every one is delivered exactly as the reference states
 *   it;
 * - every read read again over its facts stored otherwise, another order through a fresh load and one value
 *   respelled, exactly as it first answered;
 * - a key over double precision, whose 0 and -0 are one value and NaN equal to itself;
 * - db.get answering some and none over a query proved at most one row, and refusing one it cannot prove so; db.get
 *   over a primary or candidate key, some and none;
 * - an ordered root paged forward and backward;
 * - each refusal class a read can meet at the public boundary: a parameter of another host type (encode), a page size
 *   outside 1..pageMaxSize (request), and a cursor its codec cannot read;
 * - every program form the generator draws (generate.ts programForms): imports bound to variables and to parameters,
 *   interiors, named stages, computed head and group keys, ranges, sets, relation parameters, closures, contract and
 *   typmod parameters, Allen relations and point memberships, each built through the public builders.
 *
 * The identifier kinds and every shape the program took are noted too, so the residual-risk line says how much of that
 * space the run likely missed.
 *
 * Explores `suite`, the adapter's delivery read through `stitch` and its cell texts checked against `conversion`
 * (planted.ts): as delivered and converted, or through a planted defect the suite must catch, each disagreement a case
 * fails with handed to `failed`. A case draws its sketch, then resolves it on its own decisions. The Dbs connect to the
 * substrate's target, so cases run one at a time. Shrinking stops after 150 candidates: each candidate installs a
 * schema, and a shrunk sketch past that is already the size of one a person reads.
 */
const exploration = (
	suite: PublicSuite,
	stitch: Stitch,
	conversion: Conversion,
	failed: (disagreement: Disagreement) => void
): Effect.Effect<Explored, SearchFailure, Substrate | Run> =>
	explore(
		{
			suite,
			draw: drawn(caseSketchGen),
			literal: Formatter.format,
			coverage: rating(
				required<PublicFeature>(situations, { cases: cases, sense: notesOnly }),
				declineFeatures
			),
			kept: planted,
			runs: cases,
			shrink: { kind: "bounded", candidates: 150 },
			concurrency: 1,
			steerEvery: 16,
			caseHang: Duration.minutes(2)
		},
		(sketch, c) =>
			runCase(c.draw(resolveCase(sketch)), c.note, stitch, conversion).pipe(
				Effect.tapError((disagreement) => Effect.sync(() => failed(disagreement)))
			)
	)

/** The public-boundary differential, the adapter's delivery read through `stitch` and its cells through `conversion`. */
export const explorePublic = (
	stitch: Stitch,
	conversion: Conversion
): Effect.Effect<Explored, SearchFailure, Substrate | Run> =>
	exploration("public", stitch, conversion, () => undefined)

/**
 * What a planted defect's exploration ends with: every case passed, or a case failed, with the exploration's report
 * and the disagreement of the last case that failed. Shrinking runs failing cases until the shrunk one, so the last is
 * the shrunk case's unless a later candidate failed without drawing fewer decisions.
 */
export type Caught =
	| { readonly kind: "passed" }
	| {
			readonly kind: "falsified"
			readonly report: string
			readonly last: Option.Option<Disagreement>
	  }

/**
 * The public-boundary differential through a planted defect, which must fail: a failing case is the result rather
 * than the exploration's failure, so the suite can judge which check caught it. Every other way the exploration fails
 * (a hang, a stall, an unreached feature, a stale kept case) fails it still.
 */
export const catchPlanted = (
	suite: Exclude<PublicSuite, "public">,
	stitch: Stitch,
	conversion: Conversion
): Effect.Effect<Caught, Exclude<SearchFailure, PropertyFalsified>, Substrate | Run> =>
	Effect.suspend(() => {
		let last: Option.Option<Disagreement> = Option.none()
		return exploration(suite, stitch, conversion, (disagreement) => {
			last = Option.some(disagreement)
		}).pipe(
			Effect.map((): Caught => ({ kind: "passed" })),
			Effect.catchTag("PropertyFalsified", (falsified) =>
				Effect.succeed<Caught>({ kind: "falsified", report: falsified.message, last })
			)
		)
	})
