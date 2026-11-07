import {
	type Case,
	drawn,
	type Explored,
	explore,
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
			kept: [],
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
