import {
	type Case,
	drawn,
	type Explored,
	explore,
	type Kept,
	type Run,
	type SearchFailure
} from "@grizzle/testing/explore"
import type { Coverage } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { boundedShrink } from "@grizzle/testing/shrink"
import { Array as Arr, Cause, Effect, Formatter, Option, type Scope } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { type AmbientSession, ambientFeatures, ambientSessionGen } from "#test/support/ambient.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	CurrentRestorage,
	type Restorage,
	restorageGen
} from "#test/support/oracle/gen/restorage.ts"
import {
	CurrentPerturbation,
	isPerturbed,
	type Perturbation,
	perturbationGen,
	printPerturbation
} from "#test/support/oracle/perturb.ts"
import { plantedArms, type WChangeSet } from "#test/support/oracle/write/changeset.ts"
import {
	CaseFailed,
	drawnCase,
	type PlantedCases,
	plantedCase,
	plantedCasesGen,
	type ResolvedCase,
	runCase,
	type WriteCase,
	type WriteOracleFeature,
	writeCaseGen
} from "#test/support/oracle/write/harness.ts"
import { openTarget, privilegeProblems, type Statistics } from "#test/support/oracle/write/run.ts"
import {
	printSchema,
	relationIn,
	resolveSchema,
	type SchemaSketch,
	schemaSketchGen,
	type WGroup,
	type WSchema
} from "#test/support/oracle/write/schema.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

export interface WriteRun {
	readonly schema: SchemaSketch
	readonly statistics: Statistics
	/** The defaults the run's installation's owner sessions start under (test/support/ambient.ts). */
	readonly ambient: AmbientSession
	readonly cases: ReadonlyArray<WriteCase>
	readonly planted: PlantedCases
}

const maxCasesPerRun = 12

export const writeRunGen: Gen<WriteRun> = (source) => ({
	schema: source.draw(schemaSketchGen),
	statistics: source.draw(element<Statistics>(["analyzed", "none"])),
	ambient: source.draw(ambientSessionGen),
	cases: source.draw(array(writeCaseGen, { min: 1, max: maxCasesPerRun })),
	planted: source.draw(plantedCasesGen)
})

/**
 * A write run, the plan perturbation it runs under and how its second readings store their facts, drawn together so
 * they shrink together.
 */
const perturbedRunGen: Gen<readonly [WriteRun, Perturbation, Restorage]> = (source) =>
	[source.draw(writeRunGen), source.draw(perturbationGen), source.draw(restorageGen)] as const

/**
 * What a run's resolution draws: its schema and its drawn cases, each thinned by its swarm as the resolution meets each
 * place, so the property draws them once, from the case's own tape, and they replay and shrink with it.
 */
interface ResolvedRun {
	readonly schema: WSchema
	readonly drawn: ReadonlyArray<ResolvedCase>
}

const resolveRun =
	(run: WriteRun): Gen<ResolvedRun> =>
	(source) => {
		const schema = source.draw(resolveSchema(run.schema))
		return { schema, drawn: Arr.map(run.cases, (wc) => source.draw(drawnCase(schema, wc))) }
	}

/**
 * The features every write suite's population must reach: each member kind under every op, one to three strata, each
 * read-back source, every put target, refusals by every kind of law, each schema shape, the value spellings that test
 * identity after coercion, TOAST-sized payloads, numeric casts between typmods, generated additions that collide with
 * stored serial values, a run that reads back, on one Db, relations sharing field names with other types, references
 * into candidate keys, Stream members, bound parameters, db.compile, a described member reading a wider text
 * into a narrower field (a deletion among them) refused by the domain, a put on an immutable relation, a generated
 * addition drawing the key of a fact its stratum deletes, read back through both deltas, identical and differing, one
 * whose lagging draw repeats a fact the stratum keeps, refused at its key, draws of the realization's other than the
 * calculator's that change the counts, a put realized as UPDATE ... FROM advancing a lagging sequence past its keys,
 * and second readings over facts stored in another order and with a value respelled.
 */
export const writeSituations = [
	"strata:1",
	"strata:2",
	"strata:3",
	"insert array",
	"delete array",
	"put array",
	"insert project",
	"delete project",
	"put project",
	"insert param",
	"delete param",
	"put param",
	"delete scoped",
	"read added",
	"read removed",
	"read state",
	"put target deleteThenInsert",
	"put target onConflictDoUpdate",
	"put target updateFrom",
	"put target merge",
	"outcome accepted",
	"outcome no-change",
	"outcome invariant-rejected",
	"refused by a primary key",
	"refused by a candidate key",
	"refused by a deferred foreign key",
	"refused by an immediate foreign key",
	"refused by a projected key",
	"mutable relation",
	"identity column",
	"every field an identity column",
	"two identity columns",
	"insert generated",
	"a unit addition described and enumerated",
	"generated accepted",
	"generated after a collision",
	"deferred containment",
	"immediate containment",
	"projected key",
	"numeric coerced",
	"numeric coerced no-change",
	"numeric cast between typmods",
	"toast-sized input",
	"toast-sized no-change",
	"toast-sized accepted",
	"two members of one relation in one stratum",
	"a member reads a relation its stratum writes",
	"flight logged",
	"statistics analyzed",
	"statistics none",
	"delta read-backs of one heading's field names over other types",
	"reference into a candidate key",
	"stream member",
	"parameters bound",
	"parameters bound as streams",
	"through compile",
	"described member wider than its field",
	"a deletion described wider than its field",
	"outcome outside a domain",
	"outcome refused at bind",
	"put on an immutable relation",
	"a stated-one read-back with its parent present",
	"a stated-one read-back with its parent absent",
	"a stated-one read-back over a deferred containment that the write violates",
	"lagging identical netted",
	"lagging differing",
	"a generated repeat of a kept fact refused",
	"counts under the realization's draws",
	"an UPDATE ... FROM put advancing its sequence",
	"anchored deletion",
	"single-statement stratum",
	"a single statement refused by a law",
	"sequential stratum of several writes",
	"take sent in its LATERAL form",
	"facts reordered on a second reading",
	"a fact respelled on a second reading"
] as const satisfies ReadonlyArray<WriteOracleFeature>

/**
 * Whether two relations of a run, both read back through a delta, have the same field names in order and other types:
 * one read-back statement text over carriers of different column types, which a session's server statement must not
 * meet as a stale result type.
 */
const sharesHeadingNames = (
	reads: ReadonlyArray<{ readonly group: WGroup; readonly relation: string }>
): boolean =>
	Arr.some(reads, (a, i) =>
		Arr.some(reads.slice(i + 1), (b) => {
			const x = relationIn(a.group, a.relation).columns
			const y = relationIn(b.group, b.relation).columns
			return (
				x.length === y.length &&
				Arr.every(x, (c, j) => c.name === y[j]?.name) &&
				Arr.some(x, (c, j) => c.kind !== y[j]?.kind)
			)
		})
	)

/** The delta read-backs of a case, by group and relation. */
const deltaReads = (group: WGroup, c: WChangeSet) =>
	Arr.map(
		Arr.filter(c.reads, (r) => r.source !== "state"),
		(r) => ({ group, relation: r.relation })
	)

const failureReport = (cause: Cause.Cause<unknown>): string => {
	const error = Cause.squash(cause)
	return error instanceof CaseFailed ? error.report : Cause.pretty(cause)
}

/**
 * One run: its schema and drawn cases resolved from the case's own draws, the schema installed and opened, its
 * privileges checked, its cases in order (see the header).
 */
export const runWrite = (
	run: WriteRun,
	c: Case<WriteOracleFeature>
): Effect.Effect<void, CaseFailed, Substrate | Scope.Scope> =>
	Effect.suspend(() => {
		const resolved = c.draw(resolveRun(run))
		return runResolved(run, resolved, c.note).pipe(
			Effect.catchCause((cause) => {
				const error = Cause.squash(cause)
				return error instanceof CaseFailed
					? Effect.fail(error)
					: Effect.fail(
							new CaseFailed({
								report: `${printSchema(resolved.schema)}\n${failureReport(cause)}`
							})
						)
			})
		)
	})

/** A resolved run's schema installed and opened, its privileges checked, its cases in order. */
const runResolved = (
	run: WriteRun,
	resolved: ResolvedRun,
	note: Case<WriteOracleFeature>["note"]
) =>
	Effect.gen(function* () {
		const schema = resolved.schema
		note(`statistics ${run.statistics}`)
		for (const feature of ambientFeatures(run.ambient)) {
			note(feature)
		}
		const t = yield* openTarget(schema, run.statistics, run.ambient)
		const privileges = yield* privilegeProblems(t)
		if (privileges.length > 0) {
			return yield* new CaseFailed({
				report: `${printSchema(schema)}\n${Arr.join(privileges, "\n")}`
			})
		}
		const reads: Array<{ readonly group: WGroup; readonly relation: string }> = []
		const planted = Arr.findFirst(schema.groups, (g) => g.role === "planted")
		const cases = [
			...resolved.drawn,
			...Option.match(planted, {
				onNone: () => [],
				onSome: (group) => Arr.map(plantedArms, (arm) => plantedCase(group, arm, run.planted.facts))
			})
		]
		for (const [i, rc] of cases.entries()) {
			const ran = yield* runCase(t, rc, note).pipe(
				Effect.mapError((e) =>
					e instanceof CaseFailed
						? new CaseFailed({ report: `case ${i + 1} of ${cases.length}:\n${e.report}` })
						: e
				)
			)
			appendAll(reads, deltaReads(ran.group, ran.changes))
		}
		if (sharesHeadingNames(reads)) {
			note("delta read-backs of one heading's field names over other types")
		}
	})

/** The most shrink candidates a failing write run tries (see exploreWrite). */
const shrinkCandidates = 300

export interface WriteSuite {
	/** The suite's label in reports and the residual line; the library derives its floor stream from it. */
	readonly suite: string
	/** The runs of the rotating stream. */
	readonly runs: number
	/**
	 * The features the suite's population must reach, judged on its floor stream and its steered phase, which grows the
	 * floor's finds toward what it missed.
	 */
	readonly coverage: Coverage<WriteOracleFeature>
}

/** The runs a search found failing, kept and replayed by value in every suite. */
const keptRuns: ReadonlyArray<
	Kept<readonly [WriteRun, Perturbation, Restorage], WriteOracleFeature>
> = [
	{
		note: "a ChangeSet whose first stratum holds no member, so its second runs at position 0, and a key refuses one of its statements: the refusal is judged against the slot groups at that position, which once sat at the stratum's index among the ChangeSet's strata, where the witness found none",
		sketch: [
			{
				schema: {
					groups: [
						{
							relations: [
								{
									width: 688,
									kinds: [47705, 52406, 12817, 2122],
									key: [4560, 62465, 21308, 1401],
									candidate: [65535, 49443, 14510, 5075],
									serial: { at: 65117, kind: 48138, count: 25332, second: 14933 },
									target: 60137
								},
								{
									width: 47405,
									kinds: [17588, 23366, 39894, 35085],
									key: [51581, 1430, 31492, 56396],
									candidate: [29627, 52051, 22863, 4876],
									serial: { at: 39513, kind: 64019, count: 9886, second: 9978 },
									target: 23399
								}
							]
						},
						{
							relations: [
								{
									width: 5321,
									kinds: [24701, 33028, 29646, 7220],
									key: [17042, 625, 1, 61629],
									candidate: [52712, 59911, 57120, 54597],
									serial: { at: 59354, kind: 39, count: 29804, second: 62005 },
									target: 62476
								},
								{
									width: 14946,
									kinds: [65521, 29586, 3271, 65535],
									key: [60401, 53222, 18345, 8457],
									candidate: [36242, 18017, 2433, 19851],
									serial: { at: 8845, kind: 21571, count: 38139, second: 49880 },
									target: 26198
								},
								{
									width: 65526,
									kinds: [19231, 42147, 16920, 60373],
									key: [6113, 10036, 52642, 17174],
									candidate: [29083, 26186, 45662, 53952],
									serial: { at: 28309, kind: 64312, count: 60402, second: 64587 },
									target: 64384
								}
							]
						},
						{
							relations: [
								{
									width: 36757,
									kinds: [941, 8258, 24793, 11952],
									key: [1839, 62285, 57680, 44682],
									candidate: [6384, 7627, 17592, 6782],
									serial: { at: 55895, kind: 27411, count: 13, second: 49720 },
									target: 13783
								},
								{
									width: 40404,
									kinds: [19031, 1, 23713, 43254],
									key: [14232, 19061, 62676, 25568],
									candidate: [43445, 400, 51718, 60591],
									serial: { at: 38547, kind: 64184, count: 13405, second: 51747 },
									target: 40048
								},
								{
									width: 35200,
									kinds: [62608, 63176, 50019, 14653],
									key: [64268, 16841, 56396, 63711],
									candidate: [11748, 37363, 14407, 24576],
									serial: { at: 65516, kind: 37772, count: 29278, second: 56048 },
									target: 63339
								}
							]
						}
					],
					planted: true,
					swarm: { references: 2, immediateReferences: 3 }
				},
				statistics: "none",
				ambient: {
					path: { kind: "default" },
					settings: [
						{ parameter: "DateStyle", value: "Postgres, YMD" },
						{ parameter: "bytea_output", value: "escape" }
					]
				},
				cases: [
					{
						group: 64655,
						facts: [
							[{ values: [9994, 21517, 51668, 11452], target: 45207 }],
							[
								{ values: [65532, 14865, 26512, 47680], target: 5936 },
								{ values: [53587, 14810, 24035, 11771], target: 62816 },
								{ values: [49348, 46428, 58574, 38306], target: 0 }
							],
							[{ values: [4357, 10108, 65534, 44194], target: 1896 }]
						],
						behind: false,
						changes: {
							strata: [
								[
									{
										op: 2,
										relation: 45765,
										source: 3,
										facts: [
											{
												mode: 3,
												pick: 39570,
												row: { values: [13911, 11656, 58597, 18838], target: 17928 },
												spell: [5286, 44355, 54202, 39142]
											}
										],
										from: { other: true, relation: 2626 },
										filter: { on: true, column: 61603, value: 35440 },
										head: [
											{ term: 3, value: 39217, spell: 54396 },
											{ term: 4, value: 53961, spell: 15575 },
											{ term: 2, value: 20576, spell: 0 },
											{ term: 3, value: 5, spell: 22726 }
										]
									}
								]
							],
							reads: [
								{
									relation: 27536,
									source: 2,
									parent: { on: false, containment: 24760, clear: false }
								}
							],
							swarm: {
								paramMembers: 2,
								reread: 1,
								nearMisses: 1,
								strata: 2,
								coercion: 3,
								outsideDomain: 3,
								streams: 3,
								bind: 1,
								compiled: 3,
								unitAdditions: 2
							}
						}
					},
					{
						group: 65486,
						facts: [
							[
								{ values: [11397, 65535, 53781, 58152], target: 11150 },
								{ values: [23711, 65490, 25866, 44151], target: 15394 },
								{ values: [2, 65531, 34019, 55449], target: 4517 }
							],
							[
								{ values: [6758, 65507, 16447, 56872], target: 38162 },
								{ values: [41844, 5265, 454, 65034], target: 15429 },
								{ values: [60527, 1678, 16067, 61333], target: 12818 }
							],
							[
								{ values: [60301, 3325, 13759, 12164], target: 27732 },
								{ values: [52336, 47665, 6068, 38445], target: 3301 },
								{ values: [28388, 41446, 49000, 16918], target: 4104 },
								{ values: [12894, 6776, 31118, 56230], target: 63292 },
								{ values: [20407, 49127, 2411, 37053], target: 56348 }
							]
						],
						behind: true,
						changes: {
							strata: [
								[
									{
										op: 1,
										relation: 30005,
										source: 3,
										facts: [
											{
												mode: 6,
												pick: 53884,
												row: { values: [0, 37606, 19099, 27114], target: 9671 },
												spell: [138, 20296, 1589, 21367]
											},
											{
												mode: 6,
												pick: 23364,
												row: { values: [58690, 55476, 39924, 41460], target: 7527 },
												spell: [64994, 25616, 27985, 21403]
											}
										],
										from: { other: true, relation: 57208 },
										filter: { on: true, column: 43407, value: 42652 },
										head: [
											{ term: 1, value: 58136, spell: 20919 },
											{ term: 0, value: 4628, spell: 59716 },
											{ term: 0, value: 9827, spell: 28000 },
											{ term: 0, value: 18367, spell: 21656 }
										]
									}
								]
							],
							reads: [
								{
									relation: 43417,
									source: 1,
									parent: { on: true, containment: 57340, clear: false }
								}
							],
							swarm: {
								paramMembers: 3,
								nearMisses: 3,
								strata: 3,
								streams: 1,
								bind: 1,
								unitAdditions: 3
							}
						}
					},
					{
						group: 38393,
						facts: [
							[
								{ values: [11, 19766, 49372, 6774], target: 54481 },
								{ values: [9020, 59245, 37164, 5887], target: 36407 },
								{ values: [54793, 36751, 34688, 8206], target: 7 },
								{ values: [36392, 2972, 59568, 65533], target: 64569 }
							],
							[
								{ values: [7268, 47234, 45448, 4275], target: 36562 },
								{ values: [50918, 42387, 58786, 65428], target: 6270 }
							],
							[
								{ values: [1442, 2536, 6163, 42927], target: 2039 },
								{ values: [62851, 61381, 1377, 19448], target: 62556 },
								{ values: [52617, 65416, 18249, 27], target: 2208 }
							]
						],
						behind: true,
						changes: {
							strata: [
								[
									{
										op: 2,
										relation: 41797,
										source: 3,
										facts: [
											{
												mode: 2,
												pick: 36596,
												row: { values: [3889, 48992, 36063, 4017], target: 2536 },
												spell: [51521, 826, 8975, 32736]
											}
										],
										from: { other: false, relation: 47566 },
										filter: { on: true, column: 65457, value: 62898 },
										head: [
											{ term: 4, value: 28433, spell: 11 },
											{ term: 1, value: 33666, spell: 17519 },
											{ term: 1, value: 61542, spell: 65525 },
											{ term: 1, value: 24602, spell: 26185 }
										]
									},
									{
										op: 0,
										relation: 38403,
										source: 0,
										facts: [
											{
												mode: 2,
												pick: 59018,
												row: { values: [36795, 36296, 10017, 59928], target: 23375 },
												spell: [11533, 55266, 65535, 65485]
											},
											{
												mode: 6,
												pick: 44257,
												row: { values: [31311, 13574, 40690, 4080], target: 43525 },
												spell: [51329, 42769, 33615, 42585]
											},
											{
												mode: 1,
												pick: 50733,
												row: { values: [51471, 11619, 40620, 18849], target: 28973 },
												spell: [27068, 18180, 1152, 51856]
											}
										],
										from: { other: true, relation: 53402 },
										filter: { on: false, column: 48739, value: 4 },
										head: [
											{ term: 4, value: 10399, spell: 48230 },
											{ term: 3, value: 6400, spell: 37242 },
											{ term: 0, value: 9267, spell: 51635 },
											{ term: 0, value: 42845, spell: 18451 }
										]
									}
								]
							],
							reads: [],
							swarm: { projections: 1, outsideDomain: 1, streams: 1, compiled: 2 }
						}
					},
					{
						group: 20180,
						facts: [
							[
								{ values: [24874, 30024, 62093, 6615], target: 52322 },
								{ values: [37785, 24150, 22295, 33317], target: 21697 },
								{ values: [60647, 17003, 7795, 11669], target: 55351 },
								{ values: [4826, 64240, 65399, 44769], target: 63601 },
								{ values: [2183, 2961, 30, 45754], target: 39229 }
							],
							[{ values: [57100, 29928, 30321, 54319], target: 37423 }],
							[{ values: [60566, 36180, 1, 5316], target: 65386 }]
						],
						behind: true,
						changes: {
							strata: [[]],
							reads: [],
							swarm: { paramMembers: 3, reads: 3, coercion: 1, compiled: 3 }
						}
					},
					{
						group: 64250,
						facts: [
							[
								{ values: [14060, 3174, 59845, 14206], target: 16270 },
								{ values: [65527, 9479, 304, 13688], target: 63178 }
							],
							[
								{ values: [65359, 64768, 43748, 62496], target: 17500 },
								{ values: [42310, 65487, 48994, 50588], target: 4535 },
								{ values: [46095, 30140, 46279, 61066], target: 41312 },
								{ values: [14365, 17837, 56883, 62948], target: 54130 },
								{ values: [21531, 4794, 49884, 9796], target: 38312 }
							],
							[
								{ values: [13658, 34455, 58649, 22974], target: 62449 },
								{ values: [65525, 7201, 42478, 17188], target: 26792 },
								{ values: [340, 10307, 7635, 51176], target: 40025 },
								{ values: [31326, 6414, 48785, 22126], target: 6492 },
								{ values: [54443, 41142, 12546, 58943], target: 24641 }
							]
						],
						behind: false,
						changes: {
							strata: [
								[
									{
										op: 2,
										relation: 49967,
										source: 1,
										facts: [],
										from: { other: true, relation: 55775 },
										filter: { on: true, column: 65532, value: 1809 },
										head: [
											{ term: 3, value: 33121, spell: 60034 },
											{ term: 4, value: 51185, spell: 35602 },
											{ term: 3, value: 5230, spell: 53291 },
											{ term: 0, value: 11816, spell: 57682 }
										]
									},
									{
										op: 0,
										relation: 39706,
										source: 6,
										facts: [
											{
												mode: 0,
												pick: 18818,
												row: { values: [3863, 101, 41335, 15689], target: 7428 },
												spell: [36459, 2406, 35877, 25796]
											},
											{
												mode: 0,
												pick: 46321,
												row: { values: [17318, 35601, 28816, 14990], target: 24234 },
												spell: [46176, 18846, 5358, 42]
											}
										],
										from: { other: false, relation: 29204 },
										filter: { on: false, column: 147, value: 32729 },
										head: [
											{ term: 0, value: 49778, spell: 33865 },
											{ term: 1, value: 36776, spell: 57942 },
											{ term: 2, value: 64322, spell: 6216 },
											{ term: 0, value: 13141, spell: 12762 }
										]
									},
									{
										op: 0,
										relation: 38485,
										source: 9,
										facts: [
											{
												mode: 6,
												pick: 62347,
												row: { values: [802, 6614, 11859, 14518], target: 23412 },
												spell: [50375, 20905, 25218, 34244]
											},
											{
												mode: 6,
												pick: 38373,
												row: { values: [64157, 61115, 63053, 13622], target: 12512 },
												spell: [39845, 25653, 63344, 53545]
											}
										],
										from: { other: true, relation: 14650 },
										filter: { on: true, column: 45393, value: 0 },
										head: [
											{ term: 3, value: 4032, spell: 52271 },
											{ term: 1, value: 29149, spell: 10281 },
											{ term: 3, value: 26650, spell: 41188 },
											{ term: 1, value: 62549, spell: 22693 }
										]
									}
								]
							],
							reads: [
								{
									relation: 38445,
									source: 1,
									parent: { on: false, containment: 53015, clear: false }
								},
								{
									relation: 7970,
									source: 1,
									parent: { on: true, containment: 35136, clear: false }
								}
							],
							swarm: {
								projections: 2,
								paramMembers: 2,
								reread: 1,
								nearMisses: 2,
								strata: 3,
								reads: 1,
								coercion: 1,
								streams: 2,
								compiled: 1,
								unitAdditions: 1
							}
						}
					},
					{
						group: 3917,
						facts: [
							[],
							[
								{ values: [226, 52959, 32705, 7503], target: 49614 },
								{ values: [59518, 45354, 27400, 42912], target: 38764 },
								{ values: [18430, 1611, 6612, 1034], target: 27822 },
								{ values: [5249, 29470, 19298, 708], target: 14888 }
							],
							[
								{ values: [65440, 47064, 28306, 62026], target: 915 },
								{ values: [29597, 37742, 78, 17793], target: 8726 },
								{ values: [34983, 52395, 7025, 21641], target: 65515 },
								{ values: [65535, 51584, 20366, 43278], target: 0 }
							]
						],
						behind: false,
						changes: {
							strata: [
								[],
								[
									{
										op: 0,
										relation: 42408,
										source: 3,
										facts: [
											{
												mode: 0,
												pick: 9050,
												row: { values: [50593, 8934, 49947, 65535], target: 28535 },
												spell: [11975, 57346, 14595, 36470]
											},
											{
												mode: 2,
												pick: 8161,
												row: { values: [26791, 18575, 65534, 27309], target: 35007 },
												spell: [2434, 5099, 50789, 5489]
											}
										],
										from: { other: true, relation: 44420 },
										filter: { on: true, column: 19071, value: 15 },
										head: [
											{ term: 1, value: 6350, spell: 29689 },
											{ term: 1, value: 49152, spell: 37729 },
											{ term: 1, value: 65366, spell: 12941 },
											{ term: 1, value: 0, spell: 42044 }
										]
									}
								]
							],
							reads: [
								{
									relation: 65460,
									source: 0,
									parent: { on: false, containment: 19024, clear: true }
								}
							],
							swarm: {
								projections: 1,
								paramMembers: 2,
								strata: 1,
								coercion: 1,
								streams: 3,
								bind: 2
							}
						}
					},
					{
						group: 44995,
						facts: [
							[
								{ values: [31610, 44000, 63442, 10294], target: 37807 },
								{ values: [11445, 16069, 39165, 577], target: 22046 },
								{ values: [31438, 20036, 64567, 61063], target: 60683 },
								{ values: [36822, 15, 16240, 46609], target: 60889 },
								{ values: [58212, 18564, 3, 6371], target: 4951 }
							],
							[
								{ values: [4057, 30708, 46322, 39363], target: 32540 },
								{ values: [38149, 60372, 0, 56019], target: 54431 },
								{ values: [58794, 42480, 30650, 1960], target: 17421 },
								{ values: [65532, 58318, 4706, 21527], target: 39993 }
							],
							[
								{ values: [25054, 7017, 17236, 24284], target: 41399 },
								{ values: [36857, 54412, 24704, 65527], target: 50240 },
								{ values: [61175, 35609, 12556, 64689], target: 65414 },
								{ values: [20886, 33613, 18190, 18950], target: 57633 }
							]
						],
						behind: true,
						changes: {
							strata: [[]],
							reads: [
								{
									relation: 16246,
									source: 0,
									parent: { on: true, containment: 64743, clear: true }
								},
								{
									relation: 10510,
									source: 2,
									parent: { on: false, containment: 61811, clear: false }
								},
								{
									relation: 15081,
									source: 0,
									parent: { on: true, containment: 41226, clear: true }
								}
							],
							swarm: {
								projections: 2,
								paramMembers: 3,
								reread: 1,
								nearMisses: 2,
								reads: 1,
								coercion: 3,
								outsideDomain: 1,
								streams: 2,
								bind: 3,
								compiled: 3
							}
						}
					},
					{
						group: 1492,
						facts: [
							[
								{ values: [45887, 52837, 16076, 16457], target: 47289 },
								{ values: [43732, 62502, 34507, 30582], target: 137 },
								{ values: [61674, 59454, 55584, 40466], target: 52910 }
							],
							[
								{ values: [15933, 60856, 50663, 13237], target: 35537 },
								{ values: [16115, 35396, 14129, 40101], target: 64917 },
								{ values: [64074, 43127, 12454, 63834], target: 28356 },
								{ values: [63242, 65530, 49840, 52021], target: 65530 },
								{ values: [123, 15555, 17007, 58707], target: 58547 }
							],
							[
								{ values: [36972, 63329, 1, 57026], target: 12569 },
								{ values: [60226, 631, 2531, 44613], target: 32738 }
							]
						],
						behind: false,
						changes: {
							strata: [
								[
									{
										op: 0,
										relation: 23894,
										source: 8,
										facts: [],
										from: { other: true, relation: 39146 },
										filter: { on: false, column: 25370, value: 1176 },
										head: [
											{ term: 2, value: 15401, spell: 8609 },
											{ term: 1, value: 2414, spell: 2282 },
											{ term: 4, value: 38783, spell: 3451 },
											{ term: 2, value: 61407, spell: 62567 }
										]
									},
									{
										op: 1,
										relation: 49242,
										source: 4,
										facts: [
											{
												mode: 3,
												pick: 6278,
												row: { values: [16164, 53326, 13116, 32362], target: 64286 },
												spell: [25772, 32927, 11913, 24260]
											},
											{
												mode: 2,
												pick: 65528,
												row: { values: [40438, 2430, 53257, 28752], target: 65505 },
												spell: [32271, 53603, 39186, 13262]
											},
											{
												mode: 3,
												pick: 45447,
												row: { values: [15377, 434, 62647, 29092], target: 5900 },
												spell: [65532, 24605, 52288, 50983]
											}
										],
										from: { other: true, relation: 59740 },
										filter: { on: false, column: 47378, value: 60171 },
										head: [
											{ term: 4, value: 6917, spell: 60041 },
											{ term: 3, value: 11544, spell: 56493 },
											{ term: 2, value: 5286, spell: 26232 },
											{ term: 0, value: 6008, spell: 4524 }
										]
									},
									{
										op: 2,
										relation: 22390,
										source: 6,
										facts: [
											{
												mode: 2,
												pick: 25462,
												row: { values: [63132, 11694, 63215, 60112], target: 5827 },
												spell: [24678, 42718, 20698, 31795]
											}
										],
										from: { other: true, relation: 18232 },
										filter: { on: true, column: 55908, value: 8225 },
										head: [
											{ term: 3, value: 34254, spell: 35276 },
											{ term: 3, value: 6331, spell: 65525 },
											{ term: 2, value: 28610, spell: 25990 },
											{ term: 4, value: 8042, spell: 32641 }
										]
									}
								]
							],
							reads: [
								{ relation: 33361, source: 1, parent: { on: true, containment: 8038, clear: true } }
							],
							swarm: { projections: 2, nearMisses: 1, bind: 1, compiled: 1 }
						}
					},
					{
						group: 8273,
						facts: [
							[
								{ values: [58873, 21553, 0, 57028], target: 799 },
								{ values: [34148, 60945, 5325, 11889], target: 22651 }
							],
							[],
							[]
						],
						behind: false,
						changes: {
							strata: [[]],
							reads: [],
							swarm: {
								projections: 3,
								paramMembers: 3,
								reread: 1,
								nearMisses: 2,
								strata: 3,
								reads: 3,
								coercion: 3,
								outsideDomain: 2,
								streams: 3,
								bind: 2,
								compiled: 3,
								unitAdditions: 1
							}
						}
					}
				],
				planted: { facts: [[], [], []] }
			},
			{
				settings: [
					"enable_hashjoin = off",
					"enable_mergejoin = off",
					"plan_cache_mode = force_generic_plan",
					"parallel_tuple_cost = 0"
				],
				multiplier: 2
			},
			{ shift: 0, respell: 1022 }
		],
		draws: "2.1.1.1.2.2.0.0.2.0.1.2.1.1.2.1.1.2.2.0.2.2.0.2.1.0",
		reaches: [
			"statistics none",
			"ambient setting",
			"strata:1",
			"put array",
			"put on an immutable relation",
			"deferred containment",
			"stream member",
			"parameters bound as streams",
			"through compile",
			"sequential stratum of several writes",
			"flight logged",
			"facts reordered on a second reading",
			"a fact respelled on a second reading",
			"put target deleteThenInsert",
			"outcome no-change",
			"numeric coerced",
			"numeric coerced no-change",
			"delete array",
			"parameters passed",
			"through apply",
			"insert array",
			"two members of one relation in one stratum",
			"immediate containment",
			"insert project",
			"a member reads a relation its stratum writes",
			"read removed",
			"outcome invariant-rejected",
			"refused by a primary key",
			"strata:2"
		]
	}
]

/**
 * The write oracle: generated write schemas, facts and ChangeSets, the brute-force expectation, the database side, and
 * the three-way harness, explored by write runs.
 *
 * A write run is one case of the exploration: a generated schema (schema.ts), whether its tables carry planner
 * statistics, a plan perturbation (../perturb.ts), how each case's second reading stores its facts
 * (../gen/restorage.ts), one to twelve write cases and, where the schema holds the planted group, the planted cases
 * after them (harness.ts). The run's sketch is the case's generated value, and the swarm
 * decisions its schema and ChangeSets thin by are the property's own draws, so they replay and shrink with it. The run
 * installs its schema once, opens it as one Db, checks the installation's privileges, and runs its cases in order on
 * that Db, so the Db's server statements outlive each program: two programs that read back relations sharing field
 * names with other types meet their statement text again on one session. A failing run shrinks its schema and drops
 * its cases down to the one that fails. A suite is a label, its runs and the coverage its population must reach; the
 * library derives its floor and steered streams from the label, and nothing is written into the tree.
 *
 * Explores a write suite (see the header), every run under its perturbation, each case noting its features through its
 * own Case; the suite must reach its required features, and a failure fails. Runs go one at a time, since every run
 * installs a schema on the file's database. Shrinking stops after shrinkCandidates candidates, about twenty minutes at
 * four seconds a candidate alone: each candidate is a whole write run on PostgreSQL, a schema installed and up to
 * twelve cases applied two ways.
 */
export const exploreWrite = (
	s: WriteSuite
): Effect.Effect<Explored, SearchFailure, Run | Substrate> =>
	explore(
		{
			oracle: { kind: "unstated" },
			suite: s.suite,
			draw: drawn(perturbedRunGen),
			literal: Formatter.format,
			coverage: s.coverage,
			kept: keptRuns,
			runs: s.runs,
			shrink: boundedShrink(shrinkCandidates),
			concurrency: 1,
			steerEvery: 16,
			caseHang
		},
		([w, perturbation, restorage], c) =>
			Effect.scoped(
				runWrite(w, c).pipe(
					Effect.provideService(CurrentPerturbation, perturbation),
					Effect.provideService(CurrentRestorage, restorage)
				)
			).pipe(
				Effect.mapError((e) =>
					isPerturbed(perturbation)
						? new CaseFailed({ report: `${e.report}\n${printPerturbation(perturbation)}` })
						: e
				)
			)
	)
