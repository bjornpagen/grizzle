import {
	drawn,
	type Explored,
	explore,
	type Kept,
	type Run,
	type SearchFailure
} from "@grizzle/testing/explore"
import { rating, required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { Array as Arr, type Effect, Formatter } from "effect"
import { indices } from "#compiler/core/array.ts"
import { runCase } from "#test/pg/oracle/public/run.ts"
import { declineFeatures } from "#test/pg/oracle/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { caseHang } from "#test/support/limits.ts"
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
	resolveCase
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
 * The cases of the rotating stream; every case installs a schema through its migration, so the population is small and
 * its cases rich.
 */
export const cases = 80

/** The suite's required features, and every program form the generator draws: each must be reached on every run. */
const situations = [
	"attachment pipelined",
	"attachment nested",
	"stated option",
	"stated one",
	"stated arm",
	"arm some",
	"arm none",
	"two spellings among parent keys",
	"pipelined attachment over two spellings of one parent key",
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
	"refused anchor",
	"key get closed some",
	"an attached take of two children or more",
	"an attached take delivered descending",
	"a root take of two rows or more",
	"a root take descending",
	"a root take with tied order keys",
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
type RelationSketch = CaseSketch["relations"][number]

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
	relations: ReadonlyArray<RelationSketch>
): CaseSketch => ({
	population,
	swarm: {},
	perturbation: unperturbed,
	ambient: ordinarySession,
	restorage: { shift: 0, respell: 0 },
	roster: 0,
	span: 0,
	relations,
	reads: [],
	planted: {
		names: zeros(plantedNameCount),
		value: floorValue,
		handle: 0,
		padding: 0,
		side: { kind: 0, values: zeros(3) }
	}
})

/**
 * Issue #3's two acceptance cases (generate.ts acceptanceCollapse and acceptanceMean): its shrunk case under its stated
 * perturbation, and the mean over one value in two spellings under every planner setting, each read again over its
 * facts in the other order (its restorage), both judged by the one exact check. An acceptance case resolves drawing
 * nothing.
 */
const planted: ReadonlyArray<Kept<CaseSketch, PublicFeature>> = [
	{
		note: "issue #3's shrunk case: Task's 0 in two spellings, collapsed under its plan",
		sketch: {
			...caseSketch("acceptance collapse", [relation([0], [])]),
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
			...caseSketch("acceptance mean", [relation([0], [])]),
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
		reaches: ["facts by a direct writer"]
	}
]

/**
 * The public-boundary differential as an exploration: generated programs through grizzle's public builders and
 * runtime, each read compared with the reference evaluator's per-parent delivery (run.ts).
 *
 * The suite's features are what its population must keep reaching, because each is a way the public boundary can be
 * wrong that only it reaches:
 *
 * - an attachment pipelined as a statement of its own, and a nested one: over exact parents no attachment fuses
 *   (lower/shapes/index.ts rowsStatement), and the fused codec is the attachment shape's unit suite's
 *   (test/unit/lower/shapes/attach.test.ts);
 * - each stated delivery the decoder binds: an Option, the one child, and an arm read Some and None by its parent's
 *   handle, each licensed by the analysis and kept by the reference;
 * - facts stored by a direct SQL writer at SERIALIZABLE, each value in its drawn input spelling, since db.apply stores
 *   every value in its one form;
 * - two parents whose keys are equal but stored in different spellings (1.0 and 1.00), with children, under a
 *   pipelined attachment, and a vector key stored with -0 components: the stitch by key must use
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
 * - an attached take whose order decides what a parent receives, two children or more, two of them ordered apart by
 *   a descending first key: its children arrive in the take's order (answer.ts), never the child key's;
 * - a root take of two rows or more, two of them ordered apart by a descending first key and two its stated keys tie:
 *   its rows arrive in the take's order, the ties broken by the column its stated order leaves out (program.ts
 *   takeOrder), as an attachment's do;
 * - each refusal class a read can meet at the public boundary: a parameter of another host type (encode), a window
 *   size that is no safe integer of at least 1, and an anchor key of another length than its order's;
 * - every program form the generator draws (generate.ts programForms): imports bound to variables and to parameters,
 *   interiors, named stages, computed head and group keys, ranges, sets, relation parameters, closures, contract and
 *   typmod parameters, Allen relations and point memberships, each built through the public builders.
 *
 * The identifier kinds and every shape the program took are noted too, so the residual-risk line says how much of that
 * space the run likely missed.
 *
 * Explores the public-boundary differential: the adapter's delivery as delivered, its cell texts checked against the
 * library's conversion (cells.ts). A case draws its sketch, then resolves it on its own decisions. The Dbs connect to
 * the substrate's target, so cases run one at a time. Shrinking stops after 150 candidates: each candidate installs a
 * schema, and a shrunk sketch past that is already the size of one a person reads.
 */
export const explorePublic: Effect.Effect<Explored, SearchFailure, Substrate | Run> = explore(
	{
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's per-parent delivery, and the read itself under another storage"
		},
		suite: "public",
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
		caseHang
	},
	(sketch, c) => runCase(c.draw(resolveCase(sketch)), c.note)
)
