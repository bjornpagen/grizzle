import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/testing/assert"
import { aimed, element, type Gen, recorded } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Option } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { runCase } from "#test/pg/oracle/public/run.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import type { CompareOp } from "#test/support/oracle/gen/ops.ts"
import { type PlannerSetting, unperturbed } from "#test/support/oracle/perturb.ts"
import {
	type CaseSketch,
	caseSketchGen,
	mixedForms,
	negatedImportCaseSketchGen,
	plantedNameCount,
	type Population,
	type ProgramFeature,
	programForms,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import {
	type AggregateFn,
	boundRead,
	type FieldKind,
	type NameKind,
	type Operand,
	type ParentColumn,
	plainKinds,
	type ProgramCase,
	type StatedDelivery,
	type Stored,
	type StoredFact
} from "#test/support/oracle/public/program.ts"
import type { DeclineReason } from "#test/support/oracle/reference/values.ts"

/** The suite's required features, and every program form the generator draws: each must be reached on every run. */
export const publicSituations = [
	"attachment pipelined",
	"attachment nested",
	"stated option",
	"stated one",
	"option some",
	"option none",
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
	| (typeof publicSituations)[number]
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

/**
 * The reads a case runs: its sketch's, or in their place one get bound to the key of a fact the case then leaves out
 * (missingKeyCaseGen), which answers none.
 */
type ReadsRun = "sketched" | "a key left out"

/** A case of the suite as it is drawn: its sketch, resolved on the case's own decisions, and the reads it runs. */
interface PublicSketch extends CaseSketch {
	readonly readsRun: ReadsRun
}

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
): PublicSketch => ({
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
	},
	readsRun: "sketched"
})

/**
 * Issue #3's two acceptance cases (generate.ts acceptanceCollapse and acceptanceMean), a real bug each: its shrunk case
 * under its stated perturbation, and the mean over one value in two spellings under every planner setting, each read
 * again over its facts in the other order (its restorage), both judged by the one exact check. An acceptance case
 * resolves drawing nothing; no drawn sketch is one, so they are recorded beside the suite's sketches (gen.ts recorded)
 * and kept by their tokens.
 */
const acceptanceSketches: Arr.NonEmptyReadonlyArray<PublicSketch> = [
	{
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
	{
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
	}
]

/** A relation of a case holding facts, every field of its primary key of plainKinds. */
interface Keyed {
	readonly stored: Stored
	readonly facts: Arr.NonEmptyReadonlyArray<StoredFact>
}

/**
 * The case's schema and facts read by one read constructed to reach a get of no row (program.ts boundRead): over a
 * relation holding facts, drawn, its facts at its whole primary key, every field of it of plainKinds, bound to the key
 * of one of its facts, drawn, which the case then leaves out of its facts. No other fact holds that key, so the read,
 * proved at most one row by its key, answers none. None where no relation holding facts has such a key. The streams
 * the suite's label fixes held no drawn get that answered none.
 */
const missingKeyCaseGen =
	(c: ProgramCase): Gen<Option.Option<ProgramCase>> =>
	(source) => {
		const [first, ...rest] = Arr.flatMap(c.schema.relations, (stored): ReadonlyArray<Keyed> => {
			const [fact, ...facts] = c.facts.get(stored.name) ?? []
			return fact !== undefined && Arr.every(stored.primaryKey, (f) => plainKinds.has(f.kind))
				? [{ stored, facts: [fact, ...facts] }]
				: []
		})
		if (first === undefined) {
			return Option.none()
		}
		const { stored, facts } = source.draw(element([first, ...rest]))
		const missing = source.draw(element(facts))
		const keyed = new Set(Arr.map(stored.primaryKey, (f) => f.name))
		const key = new Map(
			Arr.flatMap(stored.fields, (field, at): ReadonlyArray<readonly [string, TypedLiteral]> =>
				keyed.has(field.name)
					? [[field.name, defined(missing[at], "the fact's value at a key field").literal]]
					: []
			)
		)
		return Option.some({
			...c,
			facts: new Map(
				Arr.map([...c.facts], ([name, held]) => [
					name,
					name === stored.name ? Arr.filter(held, (f) => f !== missing) : held
				])
			),
			reads: [boundRead(stored, key)]
		})
	}

/** The suite's sketches, each running the reads `readsRun` names. */
const publicSketchGen =
	(readsRun: ReadsRun): Gen<PublicSketch> =>
	(source) => ({ ...source.draw(caseSketchGen), readsRun })

/**
 * The situations a drawn case seldom reaches, each with the case aimed at it, which a witness whose turn aims at it
 * draws (aimed), runs, prints and keeps: a get of no row, a case reading a key its facts leave out; and a negated
 * import bound to an outer variable beside a filter, a form-directed case whose swarm holds a negation too and whose
 * reads take every gate that form is drawn through (negatedImportCaseSketchGen), where a drawn case reaches it about
 * once in a hundred and fifty, so the suite's fixed witnesses met none.
 */
const aims: ReadonlyArray<readonly [PublicFeature, Gen<PublicSketch>]> = [
	["get none", publicSketchGen("a key left out")],
	[
		"a negated import bound to an outer variable beside a filter",
		(source) => ({ ...source.draw(negatedImportCaseSketchGen), readsRun: "sketched" })
	]
]

/**
 * The case a sketch runs, resolved on the case's own decisions: the sketch's, or, where it runs a key left out,
 * missingKeyCaseGen's of it, the sketch's own where no relation holding facts has such a key.
 */
const caseOf = (sketch: PublicSketch, c: Case<PublicFeature>): ProgramCase => {
	const sketched = c.draw(resolveCase(sketch))
	switch (sketch.readsRun) {
		case "sketched":
			return sketched
		case "a key left out":
			return Option.getOrElse(c.draw(missingKeyCaseGen(sketched)), () => sketched)
	}
}

/**
 * The public-boundary differential's cases: generated programs through grizzle's public builders and
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
 * library's conversion (cells.ts). A case draws its sketch, one reading a key left out where its turn aims at a get of
 * no row (aims), then resolves it on its own decisions (caseOf), beside issue #3's acceptance cases
 * (acceptanceSketches).
 */
export const publicCases = aimed(recorded(publicSketchGen("sketched"), acceptanceSketches), aims)

/** The case a sketch runs, resolved on the case's own decisions (caseOf), run through the public boundary (run.ts). */
export const publicCase = (sketch: PublicSketch, c: Case<PublicFeature>) =>
	runCase(caseOf(sketch, c), c.note)
