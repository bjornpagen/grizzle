import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { failureText } from "@bjornpagen/testing/failure"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Cause, Effect, Option, type Scope } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { type AmbientSession, ambientFeatures, ambientSessionGen } from "#test/support/ambient.ts"
import { type Restorage, restorageGen } from "#test/support/oracle/gen/restorage.ts"
import { type Perturbation, perturbationGen } from "#test/support/oracle/perturb.ts"
import { plantedArms, type WChangeSet } from "#test/support/oracle/write/changeset.ts"
import { unorderableStrata } from "#test/support/oracle/write/expect.ts"
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
import {
	installTarget,
	privilegeProblems,
	type Statistics,
	type WriteInstallation,
	type WriteTarget,
	withTarget
} from "#test/support/oracle/write/run.ts"
import {
	printSchema,
	relationIn,
	resolveSchema,
	type SchemaSketch,
	schemaSketchGen,
	type WGroup,
	type WSchema
} from "#test/support/oracle/write/schema.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
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

const writeRunGen: Gen<WriteRun> = (source) => ({
	schema: source.draw(schemaSketchGen),
	statistics: source.draw(element<Statistics>(["analyzed", "none"])),
	ambient: source.draw(ambientSessionGen),
	cases: source.draw(array(writeCaseGen, { min: 1, max: maxCasesPerRun })),
	planted: source.draw(plantedCasesGen)
})

/**
 * A write run, the plan perturbation it runs under and how its second readings store their facts, drawn together so
 * they shrink together: the sketch of one case of a write suite, as a kept case states it.
 */
export type WriteSketch = readonly [WriteRun, Perturbation, Restorage]

export const perturbedRunGen: Gen<WriteSketch> = (source) =>
	[source.draw(writeRunGen), source.draw(perturbationGen), source.draw(restorageGen)] as const

/**
 * What a run's resolution draws: its schema and its drawn cases, each thinned by its swarm as the resolution meets each
 * place, so the property draws them once, from the case's own tape, and they replay and shrink with it.
 */
export interface ResolvedRun {
	readonly schema: WSchema
	readonly drawn: ReadonlyArray<ResolvedCase>
}

export const resolveRun =
	(run: WriteRun): Gen<ResolvedRun> =>
	(source) => {
		const schema = source.draw(resolveSchema(run.schema))
		return { schema, drawn: Arr.map(run.cases, (wc) => source.draw(drawnCase(schema, wc))) }
	}

/**
 * The features every write suite's population must reach: each member kind under every op, one to three strata, each
 * read-back source, every put target, refusals by every kind of law, each schema shape, TOAST-sized payloads, numeric
 * casts between typmods, a run that reads back, on one Db, relations sharing field names with other types, references
 * into candidate keys, Stream members, bound parameters, db.compile, a described member reading a wider text
 * into a narrower field (a deletion among them) refused by the domain,
 * second readings over facts stored in another order and with a value respelled, a stratum whose writes the keys order
 * in a cycle refused as it compiles, a deletion where facts meet nowhere left unordered beside an addition, which
 * orders a stratum that would otherwise hold such a cycle, and an addition a later stratum removes, which the change's
 * counts net away, and a field-equality deletion (ChangeSet.deleteWhere), by a literal among them.
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
	"delete equal",
	"delete equal by a literal",
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
	"refused at COMMIT by a containment",
	"refused by an immediate foreign key",
	"refused by a projected key",
	"mutable relation",
	"deferred containment",
	"immediate containment",
	"projected key",
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
	"described member wider than its field",
	"a deletion described wider than its field",
	"outcome outside a domain",
	"outcome refused at bind",
	"a stated-one read-back with its parent present",
	"a stated-one read-back with its parent absent",
	"a stated-one read-back over a deferred containment that the write violates",
	"anchored deletion",
	"a member slot staged",
	"a staged slot an exact deletion excepts",
	"a staged slot beside another slot of its heading",
	"two staged slots of one heading",
	"a staged slot a put's halves read",
	"single-statement stratum",
	"a single statement refused by a law",
	"sequential stratum of several writes",
	"facts reordered on a second reading",
	"a fact respelled on a second reading",
	"an unorderable stratum refused",
	"an addition a later stratum removes",
	"a deletion meeting nowhere unordered beside an addition"
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

/** The delta read-backs a case ran, by group and relation. */
const deltaReads = (group: WGroup, reads: WChangeSet["reads"]) =>
	Arr.map(
		Arr.filter(reads, (r) => r.source !== "state"),
		(r) => ({ group, relation: r.relation })
	)

const failureReport = (cause: Cause.Cause<unknown>): string => {
	const error = Cause.squash(cause)
	return error instanceof CaseFailed ? error.report : failureText(cause)
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

/** A resolved run's cases in order: its drawn cases, then, where its schema holds the planted group, the planted arms. */
const casesOf = (run: WriteRun, resolved: ResolvedRun): ReadonlyArray<ResolvedCase> => {
	const planted = Arr.findFirst(resolved.schema.groups, (g) => g.role === "planted")
	return [
		...resolved.drawn,
		...Option.match(planted, {
			onNone: () => [],
			onSome: (group) => Arr.map(plantedArms, (arm) => plantedCase(group, arm, run.planted.facts))
		})
	]
}

/**
 * A resolved run's schema installed, in the scope, its privileges checked. The installation installs the parameter
 * types of every ChangeSet the run applies (run.ts installTarget): a ChangeSet whose stratum the keys order in a cycle
 * is refused as it compiles (expect.ts unorderableStrata), so its case applies nothing and the installation leaves it
 * out.
 */
export const installRun = (
	run: WriteRun,
	resolved: ResolvedRun
): Effect.Effect<
	WriteInstallation,
	CaseFailed | CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const installation = yield* installTarget(
			resolved.schema,
			run.statistics,
			run.ambient,
			Arr.filter(
				casesOf(run, resolved),
				(rc) => unorderableStrata(rc.group, rc.changes).length === 0
			)
		)
		const privileges = yield* privilegeProblems(installation)
		if (privileges.length > 0) {
			return yield* new CaseFailed({
				report: `${printSchema(resolved.schema)}\n${Arr.join(privileges, "\n")}`
			})
		}
		return installation
	})

/** A resolved run's cases in order on its writer's Db (`t`, run.ts withTarget). */
export const runCases = (
	run: WriteRun,
	resolved: ResolvedRun,
	t: WriteTarget,
	note: Case<WriteOracleFeature>["note"]
): Effect.Effect<void, CaseFailed | CompileError | SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const cases = casesOf(run, resolved)
		const reads: Array<{ readonly group: WGroup; readonly relation: string }> = []
		for (const [i, rc] of cases.entries()) {
			const ran = yield* runCase(t, rc, note).pipe(
				Effect.mapError((e) =>
					e instanceof CaseFailed
						? new CaseFailed({ report: `case ${i + 1} of ${cases.length}:\n${e.report}` })
						: e
				)
			)
			appendAll(reads, deltaReads(ran.group, ran.reads))
		}
		if (sharesHeadingNames(reads)) {
			note("delta read-backs of one heading's field names over other types")
		}
	})

/**
 * A resolved run: its schema installed (installRun), then its cases on the writer's Db, which withTarget opens in a
 * scope nested inside the installation's, so the Db's sessions end before any of its roles is released.
 */
const runResolved = (
	run: WriteRun,
	resolved: ResolvedRun,
	note: Case<WriteOracleFeature>["note"]
) =>
	Effect.gen(function* () {
		note(`statistics ${run.statistics}`)
		for (const feature of ambientFeatures(run.ambient)) {
			note(feature)
		}
		const installation = yield* installRun(run, resolved)
		yield* withTarget(installation, (t) => runCases(run, resolved, t, note))
	})
