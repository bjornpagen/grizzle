/**
 * The compile-target catalog against its compositions on PostgreSQL 19 (R26-R31, R41, R42).
 *
 * - Agreement: every composition the catalog documents, drawn by the choices its text makes (an ordinal's directions,
 *   a running aggregate's restriction, a neighbor's direction, source restriction and parents, an as-of's comparison,
 *   restriction, attachment and path, a share's total and restriction, a percentile's fractions and stage, a
 *   continuous percentile's fraction, the mode), checked and lowered twice, composed (the conservative lowering of the
 *   checked DAG) and native (the catalog's rewrite, its targets lowered by native.ts), agrees over drawn lab facts
 *   (support.ts factsGen: small domains, so ties, groups of one row and empty relations come up) as raw text sets, the
 *   native run repeating no row; the rewrite applies exactly the rules the catalog's specification admits for the
 *   shape (rulesOf), so a dropped condition shows as a wrong answer; and every native target is an overload PostgreSQL
 *   has. The compositions of the hand-written suites this search replaces replay first as its kept cases.
 * - Percentile fractions: R29 admits exactly the dyadic fractions in (0, 1] whose native form agrees with the
 *   composition, and the native form, forced at any fraction, disagrees exactly where a model of both forms' positions
 *   says (fractionCaseGen).
 *
 * Oracle: the composition's conservative lowering, and the catalog's specification of each shape's rules; the model of
 * both percentile forms for the fractions.
 *
 * Plants: catalog-mode-recognizer-dropped (the mode's recognizer runs on no node, so R31 is never applied),
 * catalog-percentile-cont-fraction-halved (R30's native form takes half its fraction).
 *
 * Features: each entry kind, each rule applied and none, a delivered row; each fraction class.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { indices } from "#compiler/core/array.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { Direction } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { canonicalZero } from "#compiler/ir/carriers.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { RelNode, ValidDag } from "#compiler/ir/rel.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { ConservativeDelivery } from "#compiler/lower/conservative/deliver.ts"
import type { CatalogOptions } from "#compiler/lower/shapes/catalog/context.ts"
import { CatalogEditor } from "#compiler/lower/shapes/catalog/edit.ts"
import { type CatalogResult, rewriteCatalog } from "#compiler/lower/shapes/catalog/rewrite.ts"
import * as Q from "#test/pg/catalog/queries.ts"
import {
	appliedRules,
	catalogLowering,
	type Facts,
	factsGen,
	labFacts,
	labOptions,
	oracleCase
} from "#test/pg/catalog/support.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { catalogDispatch } from "#test/support/compile.ts"
import type { QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	conservative,
	defaultRunOptions,
	type Lowering,
	printOutcome,
	runLabelledOracle,
	sentConservative
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import * as D from "#test/unit/check/dsl.ts"

/** The drawn lab facts each search explores: the rotating stream's cases, and a quarter as many in the floor's. */
const agreementRuns = 12

/** The facts with a price of the first sitting's student, below 105, on the sitting's day and on the day before. */
const withPricedSitting = (f: Facts, amount: number): Facts => {
	const [first] = f.sittings
	const sitting = first ?? ([1000, 1, 6, 1] as const)
	const [, student, day] = sitting
	return {
		...f,
		sittings: first === undefined ? [sitting] : f.sittings,
		prices: [...f.prices, [1001, student, day, amount], [1002, student, day - 1, amount]]
	}
}

/** A catalog entry's form over the as-of comparison: the native ordered pass, or the LATERAL probe the composition is. */
type Path = "ordered" | "lateral"

/** How a running aggregate's self-match is written: plainly, its first occurrence above 3, or one student fixed. */
type Running = "plain" | "first occurrence above 3" | "student 1 on both occurrences"

/** What a discrete percentile's selection reads: the ordinal joined on the group, an unjoined one, a running count. */
type Stage = "ordinal" | "unjoined ordinal" | "running count"

/**
 * A composition of the compile-target catalog (R26-R31, R41, R42), written as an author writes it (queries.ts), by the
 * shape its recognizer reads: each field a choice the composition's text makes, never its verdict.
 */
type Entry =
	| { readonly kind: "ordinal"; readonly dirs: readonly [Direction, Direction] }
	| { readonly kind: "running"; readonly running: Running }
	| {
			readonly kind: "bound neighbor"
			readonly direction: "next" | "previous"
			readonly restricted: boolean
	  }
	| {
			readonly kind: "attached neighbor"
			readonly direction: "next" | "previous"
			readonly parents: "sittings" | "pointed"
			readonly path: Path
	  }
	| {
			readonly kind: "as-of"
			readonly mode: "le" | "lt" | "ge"
			readonly attached: boolean
			readonly cheap: boolean
			readonly path: Path
	  }
	| {
			readonly kind: "grouped share"
			readonly over: "Sitting" | "Price" | "filtered"
			readonly restricted: boolean
	  }
	| { readonly kind: "keyed share"; readonly restricted: boolean }
	| {
			readonly kind: "discrete percentile"
			readonly fractions: Arr.NonEmptyReadonlyArray<number>
			readonly stage: Stage
	  }
	| { readonly kind: "continuous percentile"; readonly p: number }
	| { readonly kind: "mode" }

const directionGen: Gen<Direction> = element(["asc", "desc"] as const)
const neighborGen: Gen<"next" | "previous"> = element(["next", "previous"] as const)
const pathGen: Gen<Path> = element(["ordered", "lateral"] as const)

/** A dyadic fraction in (0, 1] whose denominator the discrete rewrite admits: m / 2^j, j up to its largest. */
const admittedFraction: Gen<number> = (source) => {
	const j = source.draw(int(0, Math.log2(admittedDenominator)))
	return source.draw(int(1, 2 ** j)) / 2 ** j
}

/** Every catalog entry's shape, each kind equally often. */
const entryGen: Gen<Entry> = weighted<Entry>([
	[
		1,
		(source) => ({ kind: "ordinal", dirs: [source.draw(directionGen), source.draw(directionGen)] })
	],
	[
		1,
		(source) => ({
			kind: "running",
			running: source.draw(
				element(["plain", "first occurrence above 3", "student 1 on both occurrences"] as const)
			)
		})
	],
	[
		1,
		(source) => ({
			kind: "bound neighbor",
			direction: source.draw(neighborGen),
			restricted: source.draw(boolean)
		})
	],
	[
		1,
		(source) => ({
			kind: "attached neighbor",
			direction: source.draw(neighborGen),
			parents: source.draw(element(["sittings", "pointed"] as const)),
			path: source.draw(pathGen)
		})
	],
	[
		1,
		(source) => ({
			kind: "as-of",
			mode: source.draw(element(["le", "lt", "ge"] as const)),
			attached: source.draw(boolean),
			cheap: source.draw(boolean),
			path: source.draw(pathGen)
		})
	],
	[
		1,
		(source) => ({
			kind: "grouped share",
			over: source.draw(element(["Sitting", "Price", "filtered"] as const)),
			restricted: source.draw(boolean)
		})
	],
	[1, (source) => ({ kind: "keyed share", restricted: source.draw(boolean) })],
	[
		1,
		(source) => ({
			kind: "discrete percentile",
			fractions: nonEmpty(
				source.draw(array(admittedFraction, { min: 1, max: 2 })),
				"a percentile's fractions"
			),
			stage: source.draw(element(["ordinal", "unjoined ordinal", "running count"] as const))
		})
	],
	[
		1,
		(source) => {
			const j = source.draw(int(0, 3))
			return { kind: "continuous percentile", p: source.draw(int(0, 2 ** j)) / 2 ** j }
		}
	],
	[1, () => ({ kind: "mode" })]
])

const f8 = (value: number) => D.typedLit(value, Q.double)

/** The lab's options with every attachment's parents whole, and with them a bound set. */
const whole: CatalogOptions = { ...labOptions, parents: "whole" }
const bound: CatalogOptions = { ...labOptions, parents: "bound" }

/** The composition an entry is, as queries.ts writes it. */
const descOf = (entry: Entry): QueryDesc => {
	switch (entry.kind) {
		case "ordinal":
			return Q.ordinal(entry.dirs)
		case "running":
			switch (entry.running) {
				case "plain":
					return Q.running(Q.plainSelfMatch)
				case "first occurrence above 3":
					return Q.running({
						...Q.plainSelfMatch,
						extra: [D.gt(D.ref("Sitting", "score"), f8(3))]
					})
				case "student 1 on both occurrences":
					return Q.running({ ...Q.plainSelfMatch, student: D.lit(1), keys: ["id"] })
			}
		case "bound neighbor":
			return Q.boundNeighbor(
				entry.direction,
				entry.restricted ? [D.gt(D.varRef("n.score"), f8(3))] : []
			)
		case "attached neighbor":
			return Q.attachedNeighbor(entry.direction, entry.parents)
		case "as-of": {
			const cheap = entry.cheap ? [D.lt(D.varRef("p.amount"), D.lit(105n))] : []
			return entry.attached
				? Q.attachedAsOf(entry.mode, cheap)
				: Q.boundAsOf(entry.mode, cheap, "day")
		}
		case "grouped share":
			return Q.groupedShare(entry.over, entry.restricted)
		case "keyed share":
			return Q.keyedShare(entry.restricted)
		case "discrete percentile":
			switch (entry.stage) {
				case "ordinal":
					return Q.discretePercentile(entry.fractions, Q.ordinalStage)
				case "unjoined ordinal":
					return Q.discretePercentile(entry.fractions, { ...Q.ordinalStage, joined: false })
				case "running count":
					return Q.discretePercentile(entry.fractions, { ...Q.ordinalStage, fold: "runningCount" })
			}
		case "continuous percentile":
			return Q.continuousPercentile(entry.p, "score")
		case "mode":
			return Q.modeOfDays("asc", Q.plainMode)
	}
}

/**
 * The catalog options an entry's composition is rewritten under: the lab's, whose recognizers read an attachment's
 * parents as the planner places them, except where an entry's path fixes them. An attached composition's native ordered
 * pass reads whole parents, and its LATERAL probe the bound set the planner places; a bound as-of's LATERAL probe reads
 * a bound parent set, its ordered pass the lab's.
 */
const optionsOf = (entry: Entry): CatalogOptions => {
	switch (entry.kind) {
		case "attached neighbor":
			return entry.path === "ordered" ? whole : labOptions
		case "as-of":
			return entry.attached
				? entry.path === "ordered"
					? whole
					: labOptions
				: entry.path === "ordered"
					? labOptions
					: bound
		case "ordinal":
		case "running":
		case "bound neighbor":
		case "grouped share":
		case "keyed share":
		case "discrete percentile":
		case "continuous percentile":
		case "mode":
			return labOptions
	}
}

/**
 * The rules the catalog's specification has its rewrite apply to an entry (README's catalog, R26-R42), a shape a
 * recognizer must refuse applying none, so a dropped condition shows as a wrong answer:
 *
 * - R26 rewrites an ordinal's self-join count in every direction; R41 a running aggregate, R26 its ordinal beside it;
 * - R27 a successor or predecessor of the parent's own source, bound, or attached over whole parents; an attachment
 *   over the bound set the planner places keeps the LATERAL probe, which the window's columns cannot reach; a restricted
 *   source is no successor of the parent's, and R42's strict as-of mirror takes it;
 * - R42 an as-of in its ordered pass, bound or attached over whole parents, its Q's own restriction before the union;
 *   its LATERAL probe stays;
 * - R28 a share of the total grouped over the same relation, or keyed, unrestricted; a total bound to the count, or
 *   over another relation or a filtered one, is no share;
 * - R29 a discrete percentile of admitted fractions over a joined ordinal, R26 alone over an unjoined one, and R41 alone
 *   over a running conditional count, which is a fold and no position;
 * - R30 a continuous percentile; R31 the mode of days, ties to the smallest.
 */
const rulesOf = (entry: Entry): ReadonlyArray<CertificateRule> => {
	switch (entry.kind) {
		case "ordinal":
			return ["R26"]
		case "running":
			return ["R26", "R41"]
		case "bound neighbor":
			return entry.restricted ? ["R42"] : ["R27"]
		case "attached neighbor":
			return entry.path === "ordered" ? ["R27"] : []
		case "as-of":
			return entry.path === "ordered" ? ["R42"] : []
		case "grouped share":
			return entry.over === "Sitting" && !entry.restricted ? ["R28"] : []
		case "keyed share":
			return entry.restricted ? [] : ["R28"]
		case "discrete percentile":
			switch (entry.stage) {
				case "ordinal":
					return ["R29"]
				case "unjoined ordinal":
					return ["R26"]
				case "running count":
					return ["R41"]
			}
		case "continuous percentile":
			return ["R30"]
		case "mode":
			return ["R31"]
	}
}

/**
 * Whether an entry's answer is empty on most facts, so its cases need not deliver a row: a count bound to another value,
 * parents restricted by a second occurrence, and a selection read through a stage that is no position.
 */
const mayDeliverNone = (entry: Entry): boolean => {
	switch (entry.kind) {
		case "attached neighbor":
			return entry.parents === "pointed"
		case "grouped share":
		case "keyed share":
			return entry.restricted
		case "discrete percentile":
			return entry.stage !== "ordinal"
		case "ordinal":
		case "running":
		case "bound neighbor":
		case "as-of":
		case "continuous percentile":
		case "mode":
			return false
	}
}

/** What a case of the catalog search reached: each entry kind, each rule the rewrite applied, none, and a delivered row. */
type AgreementFeature =
	| `entry ${Entry["kind"]}`
	| `applied ${CertificateRule}`
	| "applied none"
	| "delivers rows"

/** The entry kinds, each a feature the search must reach. */
const entryKinds: Arr.NonEmptyReadonlyArray<Entry["kind"]> = [
	"ordinal",
	"running",
	"bound neighbor",
	"attached neighbor",
	"as-of",
	"grouped share",
	"keyed share",
	"discrete percentile",
	"continuous percentile",
	"mode"
]

/** A case of the catalog search: an entry and the lab facts it runs over. */
type AgreementCase = Readonly<{ entry: Entry; facts: Facts }>

/**
 * The catalog's compositions as its hand-written suites ran them, over the lab's facts, kept: each replays before the
 * streams, judged by the same specification.
 */
const keptEntries: Arr.NonEmptyReadonlyArray<Entry> = [
	{ kind: "ordinal", dirs: ["asc", "asc"] },
	{ kind: "ordinal", dirs: ["desc", "desc"] },
	{ kind: "ordinal", dirs: ["desc", "asc"] },
	{ kind: "running", running: "plain" },
	{ kind: "running", running: "first occurrence above 3" },
	{ kind: "running", running: "student 1 on both occurrences" },
	{ kind: "bound neighbor", direction: "next", restricted: false },
	{ kind: "bound neighbor", direction: "previous", restricted: false },
	{ kind: "bound neighbor", direction: "next", restricted: true },
	{ kind: "attached neighbor", direction: "next", parents: "sittings", path: "ordered" },
	{ kind: "attached neighbor", direction: "previous", parents: "sittings", path: "ordered" },
	{ kind: "attached neighbor", direction: "next", parents: "pointed", path: "ordered" },
	{ kind: "attached neighbor", direction: "next", parents: "sittings", path: "lateral" },
	...Arr.flatMap(["le", "lt", "ge"] as const, (mode): ReadonlyArray<Entry> => [
		{ kind: "as-of", mode, attached: false, cheap: false, path: "ordered" },
		{ kind: "as-of", mode, attached: true, cheap: false, path: "ordered" },
		{ kind: "as-of", mode, attached: true, cheap: false, path: "lateral" },
		{ kind: "as-of", mode, attached: false, cheap: false, path: "lateral" },
		{ kind: "as-of", mode, attached: false, cheap: true, path: "ordered" }
	]),
	{ kind: "as-of", mode: "le", attached: true, cheap: true, path: "ordered" },
	{ kind: "grouped share", over: "Sitting", restricted: false },
	{ kind: "keyed share", restricted: false },
	{ kind: "keyed share", restricted: true },
	{ kind: "grouped share", over: "Sitting", restricted: true },
	{ kind: "grouped share", over: "Price", restricted: false },
	{ kind: "grouped share", over: "filtered", restricted: false },
	{ kind: "discrete percentile", fractions: [0.5], stage: "ordinal" },
	{ kind: "discrete percentile", fractions: [0.25, 0.75], stage: "ordinal" },
	{ kind: "discrete percentile", fractions: [1], stage: "ordinal" },
	{ kind: "continuous percentile", p: 0.5 },
	{ kind: "continuous percentile", p: 0.25 },
	{ kind: "continuous percentile", p: 0 },
	{ kind: "discrete percentile", fractions: [0.5], stage: "unjoined ordinal" },
	{ kind: "discrete percentile", fractions: [0.5], stage: "running count" },
	{ kind: "mode" }
]

const kept: ReadonlyArray<Kept<AgreementCase, AgreementFeature>> = Arr.map(
	keptEntries,
	(entry) => ({
		note: "a composition of the hand-written catalog suites, over the lab's facts",
		sketch: { entry, facts: labFacts },
		draws: "",
		reaches: [`entry ${entry.kind}`]
	})
)

/**
 * The facts a witness runs over, aimed at a delivered row while no witness has delivered one (Case.steering): half its
 * cases, by a draw of their own, priced for their first sitting (withPricedSitting); a rotating or kept case runs as
 * drawn.
 */
const aimedFacts = (f: Facts, c: Case<AgreementFeature>): Facts =>
	Option.exists(c.steering, (pending) => pending.has("delivers rows")) && c.draw(boolean)
		? withPricedSitting(f, c.draw(int(0, 104)))
		: f

/**
 * A discrete percentile's case: its fraction, drawn as a dyadic m / 2^j, j up to one past the largest the rewrite
 * admits, or as a decimal k / 100; and up to three students' groups of sittings, each of a drawn size whose scores
 * rise by one every `tie` sittings, so ties come up.
 */
interface FractionCase {
	readonly p: number
	readonly groups: ReadonlyArray<{ readonly size: number; readonly tie: number }>
}

/** The largest denominator 2^j of a dyadic fraction the discrete rewrite admits (percentile.ts maxDyadicExponent). */
const admittedDenominator = 2 ** 7

const groupGen: Gen<FractionCase["groups"][number]> = (source) => ({
	size: source.draw(int(1, 100)),
	tie: source.draw(int(1, 3))
})

const fractionCaseGen: Gen<FractionCase> = (source) => ({
	p: source.draw(
		weighted<number>([
			[
				1,
				(fraction) => {
					const j = fraction.draw(int(0, Math.log2(admittedDenominator) + 1))
					return fraction.draw(int(0, 2 ** j)) / 2 ** j
				}
			],
			[1, map(int(0, 100), (k) => k / 100)]
		])
	),
	groups: source.draw(array(groupGen, { min: 1, max: 3 }))
})

/** The facts of a case: student g + 1's sittings, ids apart, on days 1 to its size, its scores rising per tie. */
const fractionFacts = (c: FractionCase): Facts => ({
	sittings: Arr.flatMap(c.groups, (group, g) =>
		Arr.map(
			indices(group.size),
			(k) => [g * 1000 + k + 1, g + 1, k + 1, Math.floor(k / group.tie) + 1] as const
		)
	),
	prices: [],
	points: []
})

/**
 * Whether the native form selects what the composition selects in a group of `size` sittings: PostgreSQL computes
 * x = p · n in double precision, the native percentile_disc takes the value at ceil(x), and at least the first, while the
 * composition casts x to numeric, keeping 15 significant digits, and takes the value at its ceil, none at 0. The two
 * agree where those positions hold the same score.
 */
const groupAgrees = (p: number, group: FractionCase["groups"][number]): boolean => {
	const x = p * group.size
	const composed = Math.ceil(Number(x.toPrecision(15)))
	const native = Math.max(1, Math.ceil(x))
	const score = (position: number) => Math.floor((position - 1) / group.tie) + 1
	return composed >= 1 && score(composed) === score(native)
}

/** The rewrite admits a fraction in (0, 1] whose denominator is at most admittedDenominator. */
const admitted = (p: number): boolean =>
	p > 0 && p <= 1 && Number.isInteger(p * admittedDenominator)

type FractionFeature =
	| "admitted"
	| "kept at p = 0"
	| "kept, the native form rounding apart"
	| "kept, the native form agreeing"

/** The decimal fractions and group sizes whose product the composition's numeric cast rounds below the native ceil. */
const roundingApart: ReadonlyArray<readonly [k: number, size: number]> = Arr.flatMap(
	Arr.range(1, 100),
	(k) =>
		Arr.flatMap(Arr.range(1, 100), (size): ReadonlyArray<readonly [number, number]> =>
			groupAgrees(k / 100, { size, tie: 1 }) ? [] : [[k, size]]
		)
)

/** The native targets a rewrite names: its windows' and ordered-set aggregates' overloads. */
const nativeTargets = (rewritten: CatalogResult): ReadonlyArray<string> =>
	Arr.flatMap(topoOrder(rewritten.dag), (n): ReadonlyArray<string> =>
		n.kind === "Window" || n.kind === "OrderedSetAggregate" ? [n.op] : []
	)

layer(Substrate.layer)("the compile-target catalog against its compositions", (it) => {
	it.effect(
		"every composition of the catalog agrees with its native rewrite, which applies exactly the rules its shape admits",
		(t) =>
			searched(
				t,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ create: false, label: "catalog" })
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the composition's conservative lowering, as raw text sets, and the catalog's specification of the rules each shape admits"
							},
							suite: "catalog/agreement",
							draw: drawn((source): AgreementCase => ({
								entry: source.draw(entryGen),
								facts: source.draw(factsGen)
							})),
							literal: Formatter.format,
							coverage: required<AgreementFeature>(
								[
									...Arr.map(entryKinds, (kind): AgreementFeature => `entry ${kind}`),
									"applied R26",
									"applied R27",
									"applied R28",
									"applied R29",
									"applied R30",
									"applied R31",
									"applied R41",
									"applied R42",
									"applied none",
									"delivers rows"
								],
								{ cases: 10 * agreementRuns, sense: notesOnly }
							),
							kept,
							runs: 10 * agreementRuns,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ entry, facts }, c) =>
							Effect.gen(function* () {
								const f = mayDeliverNone(entry) ? facts : aimedFacts(facts, c)
								const label = Formatter.format(entry)
								const side = catalogLowering(optionsOf(entry))
								const outcome = yield* runLabelledOracle(
									oracleCase(label, descOf(entry), f),
									conservative,
									side,
									{ ...defaultRunOptions, schema: { kind: "named", name: schema } }
								)
								assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
								const applied = appliedRules(side.last())
								assert.deepEqual(applied, Arr.sort([...rulesOf(entry)], Order.String), label)
								for (const op of nativeTargets(side.last())) {
									const resolved = yield* s.admin.queryValues("SELECT to_regprocedure($1)::text", [
										op
									])
									assert.equal(
										resolved[0]?.[0],
										op,
										`the native target ${op} is an overload PostgreSQL has`
									)
								}
								c.note(`entry ${entry.kind}`)
								c.noteAll(
									Arr.isReadonlyArrayNonEmpty(applied)
										? Arr.map(applied, (rule): AgreementFeature => `applied ${rule}`)
										: ["applied none"]
								)
								if (Arr.some(outcome.right.run.statements, (st) => st.rows.length > 0)) {
									c.note("delivers rows")
								}
							})
					)
				})
			)
	)

	it.effect(
		"R29 admits exactly the fractions whose native form agrees with the composition, and the native form disagrees where the model of both says",
		(t) =>
			searched(
				t,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema({ create: false, label: "catalog" })
					const options = { ...defaultRunOptions, schema: { kind: "named", name: schema } } as const
					/**
					 * The native form at fraction p, forced: the same query at p = 0.5, rewritten, its fraction replaced by p.
					 */
					const forced = (p: number): Lowering => ({
						name: `native at p = ${p}`,
						lower: ({ names }) => {
							const half = oracleCase(
								"p = 0.5",
								Q.discretePercentile([0.5], Q.ordinalStage),
								labFacts
							)
							const rewritten = rewriteCatalog(half.query.dag, labOptions)
							if (!rewritten.ok) {
								return rewritten
							}
							const ed = new CatalogEditor(rewritten.value.dag)
							const cell = Option.getOrThrowWith(
								Arr.findFirst(ed.cells(), (c) => c.current.kind === "OrderedSetAggregate"),
								() => new Error("an OrderedSetAggregate node")
							)
							const osa = cell.current
							if (osa.kind !== "OrderedSetAggregate") {
								throw new Error("an OrderedSetAggregate node")
							}
							const spec = defined(osa.fractions[0], "a fraction")
							if (spec.kind !== "literal") {
								throw new Error("a literal fraction")
							}
							const literal = ed.expr({
								...spec,
								value: { kind: "float", value: canonicalZero(p) }
							})
							ed.redefine(cell, { ...osa, fractions: [literal] })
							const built = ed.build()
							return Result.flatMap(lowerNative(built, built.roots[0], names), sentConservative)
						}
					})
					return yield* explore(
						{
							suite: "catalog/percentile fractions",
							draw: drawn(fractionCaseGen),
							literal: Formatter.format,
							coverage: required<FractionFeature>(
								[
									"admitted",
									"kept at p = 0",
									"kept, the native form rounding apart",
									"kept, the native form agreeing"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: agreementRuns,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang,
							oracle: {
								kind: "second-implementation",
								name: "a model of both forms' positions: the native ceil in double precision, the composition's through a 15-digit numeric"
							}
						},
						(drawnCase, c) =>
							Effect.gen(function* () {
								/**
								 * While no witness has met a rounding apart, half the witnesses take a decimal fraction and a group
								 * size whose product the model rounds apart, by a draw of their own.
								 */
								const aimed =
									Option.exists(c.steering, (pending) =>
										pending.has("kept, the native form rounding apart")
									) && c.draw(boolean)
								const [k, size] = aimed
									? c.draw(element(nonEmpty(roundingApart, "a fraction the forms round apart")))
									: [0, 0]
								const fc: FractionCase = aimed
									? { p: k / 100, groups: [{ size, tie: 1 }, ...Arr.drop(drawnCase.groups, 1)] }
									: drawnCase
								const label = `p = ${fc.p}`
								const desc = Q.discretePercentile([fc.p], Q.ordinalStage)
								const facts = fractionFacts(fc)
								const side = catalogLowering(labOptions)
								const catalog = yield* runLabelledOracle(
									oracleCase(label, desc, facts),
									conservative,
									side,
									options
								)
								assert.equal(catalog.comparison.equal, true, printOutcome(catalog))
								assert.deepEqual(
									appliedRules(side.last()),
									admitted(fc.p) ? ["R29"] : ["R26"],
									"the rewrite admits exactly the dyadic fractions in (0, 1]"
								)
								const agrees = Arr.every(fc.groups, (group) => groupAgrees(fc.p, group))
								const native = yield* runLabelledOracle(
									oracleCase(label, desc, facts),
									conservative,
									forced(fc.p),
									options
								)
								assert.equal(native.comparison.equal, agrees, printOutcome(native))
								if (admitted(fc.p)) {
									assert.ok(agrees, "an admitted fraction's native form agrees in every group")
									c.note("admitted")
								} else if (fc.p === 0) {
									c.note("kept at p = 0")
								} else {
									c.note(
										agrees
											? "kept, the native form agreeing"
											: "kept, the native form rounding apart"
									)
								}
							})
					)
				})
			)
	)
})

const lowerNative = (dag: ValidDag, root: RelNode, names: PhysicalNames) =>
	catchRefusal(() =>
		new ConservativeDelivery(
			new LowerContext(
				dag,
				{
					names,
					params: [],
					subject: { kind: "query" }
				},
				catalogDispatch
			)
		).program(root)
	)
