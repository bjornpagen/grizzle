import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Order,
	Path,
	type PlatformError,
	Predicate,
	Record as Rec,
	Result,
	Schema,
	Scope,
	String as Str
} from "effect"

import {
	type IdentityUnreadable,
	repoRoot,
	type RunIdentity,
	runIdentity,
	type ServerIdentity,
	type SourceIdentity,
	serverIdentity,
	sourceIdentity
} from "#bench/cold/identity.ts"

import {
	firstLine,
	type Gate,
	type GateOutcome,
	type GateRecord,
	type GateRun,
	isGate,
	type RanRecord,
	type Release,
	recordProblems,
	type VerdictRecord,
	verdictOf,
	verdictReason
} from "#bench/harness/gate.ts"

import {
	extraGateIds,
	type GateId,
	type GateOwner,
	gateCatalog,
	gateOwner,
	ownerDirectories,
	ruleIds
} from "#bench/harness/rules.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/**
 * The gate runner: `pnpm bench` writes JSON records with the git sha, the PostgreSQL pin and phase timings; every gate
 * of the catalog (R01-R42 and the rest) has a bench file and a recorded verdict, and the gate listing (listing.ts)
 * shows the gates not yet completed.
 *
 * - Discovery: every `*.bench.ts` under the gate directories (bench/query, bench/write, bench/queue), each
 *   default-exporting a gate (gate.ts). Names are unique, every gate a file covers is in the catalog (rules.ts), and a
 *   file lives in its gates' owner's directory, so the query and write owners never write into each other's paths.
 * - Running: one file at a time, never two at once, so no measurement shares the machine with another, each in a
 *   database of its own cloned from the template (Substrate.isolatedLayer), which the caller's sweep drops once no gate
 *   runs (bench/main.ts); bench/ alone runs ANALYZE, and a fresh clone keeps it from touching anything else. The run
 *   and the database's release are two outcomes: a run that fails is a FailedRecord, and a run
 *   that returns keeps its cases whatever the release did, with every verdict an `error` when the release leaked. The
 *   runner goes on with the next file either way.
 * - Records: bench/results/gates/<name>.<full|quick>.json for a run that returned, each with the full identity (git
 *   sha and dirty state, the PostgreSQL pin and the server the run reached, runtime, packages, the phases the file
 *   times and its scope) and checked complete (recordProblems); <name>.<full|quick>.failed.json for a
 *   run that failed. A returned run's record removes the same scale's failed one; a failed run leaves the returned
 *   one's measurements in place.
 * - Summary: bench/results/gates/summary.json, built from every record on disk whose file still exists, so a run of one
 *   gate leaves the other gates' records in place. A gate several records cover takes the worst of their outcomes, a
 *   failed run's gates being `error`; a gate no record covers is `missing`.
 */
export const defaultGateDirectories: ReadonlyArray<string> = Arr.map(
	[...ownerDirectories.query, ...ownerDirectories.write],
	(d) => `${repoRoot}/${d}`
)

const gatesDirectory = (outDir: string): string => `${outDir}/gates`

type Scale = "full" | "quick"

const scaleOf = (quick: boolean): Scale => (quick ? "quick" : "full")

/** The record of a run of `name` at `scale` that returned. */
const recordPath = (outDir: string, name: string, scale: Scale): string =>
	`${gatesDirectory(outDir)}/${name}.${scale}.json`

/** The record of a run of `name` at `scale` that failed. */
const failedRecordPath = (outDir: string, name: string, scale: Scale): string =>
	`${gatesDirectory(outDir)}/${name}.${scale}.failed.json`

export interface DiscoveredGate {
	readonly gate: Gate
	readonly path: string
	/** Repository-relative, as records name it. */
	readonly file: string
}

/** What discovery found wrong with the gate files: every problem, in path order. */
class GateDiscoveryError extends Schema.TaggedError<
	GateDiscoveryError,
	{ readonly brand: unique symbol }
>()("GateDiscoveryError", { problems: Schema.NonEmptyArray(Schema.String) }) {}

/**
 * Why a gate's bench file does not sit where its owner's files live, if it does not. Directories outside the
 * repository's own gate directories (a test's scratch directory) are not checked.
 */
const placementProblem = (file: string, gates: ReadonlyArray<GateId>): Option.Option<string> => {
	const under = (dirs: ReadonlyArray<string>): boolean =>
		Arr.some(dirs, (d) => Str.startsWith(`${d}/`)(file))
	if (!under(Arr.flatten(Rec.values(ownerDirectories)))) {
		return Option.none()
	}
	return Option.map(
		Arr.findFirst(gates, (id) => !under(ownerDirectories[gateOwner(id)])),
		(id) =>
			`${file} covers ${id}, whose bench file belongs to the ${gateOwner(id)} owner under ${Arr.join(ownerDirectories[gateOwner(id)], " or ")}`
	)
}

/** One bench file as discovery found it: its gate, or why it has none. */
type Loaded = Result.Result<DiscoveredGate, string>

const loadGate = Effect.fn("loadGate")(function* (path: string) {
	const paths = yield* Path.Path
	const file = Arr.join(Str.split(paths.relative(repoRoot, path), "\\"), "/")
	const url = yield* paths.toFileUrl(path)
	const module = yield* Effect.tryPromise({
		try: (): Promise<unknown> => import(url.href),
		catch: (cause) => `${file} does not load: ${String(cause)}`
	}).pipe(Effect.result)
	return Result.flatMap(module, (loaded): Loaded =>
		Predicate.hasProperty(loaded, "default") && isGate(loaded.default)
			? Result.succeed({ gate: loaded.default, path, file })
			: Result.fail(`${file} does not default-export a gate made by defineGate`)
	)
})

/**
 * The problems of the file at `index` of `loaded`: it has no gate, or its gate sits outside its owner's directory or
 * reuses an earlier file's name.
 */
const problemsOf = (
	loaded: ReadonlyArray<Loaded>,
	one: Loaded,
	index: number
): ReadonlyArray<string> =>
	Result.match(one, {
		onFailure: (problem) => [problem],
		onSuccess: (g) => [
			...Option.toArray(placementProblem(g.file, g.gate.gates)),
			...Option.toArray(
				Option.map(
					Arr.findFirst(
						Arr.getSuccesses(Arr.take(loaded, index)),
						(h) => h.gate.name === g.gate.name
					),
					(clash) => `${g.file} and ${clash.file} are both named ${g.gate.name}`
				)
			)
		]
	})

/**
 * Every gate file under `directories`, in path order; fails listing every problem found.
 *
 * @internal
 */
export const discoverGates = Effect.fn("discoverGates")(function* (
	directories: ReadonlyArray<string>
) {
	const fs = yield* FileSystem.FileSystem
	const paths = yield* Path.Path
	const present = yield* Effect.filter(directories, (d) => fs.exists(d))
	const listed = yield* Effect.forEach(present, (d) =>
		Effect.map(fs.readDirectory(d, { recursive: true }), (entries) =>
			Arr.filterMap(entries, (p) =>
				Str.endsWith(".bench.ts")(p) ? Result.succeed(paths.resolve(d, p)) : Result.failVoid
			)
		)
	)
	const loaded = yield* Effect.forEach(Arr.sort(Arr.flatten(listed), Order.String), loadGate)
	const problems = Arr.flatMap(loaded, (one, i) => problemsOf(loaded, one, i))
	if (Arr.isReadonlyArrayNonEmpty(problems)) {
		return yield* GateDiscoveryError.make({ problems })
	}
	return Arr.getSuccesses(loaded)
})

/** Whether `selectors` (gate ids or bench files' names) pick `g`; none picks every gate. */
const selects = (g: DiscoveredGate, selectors: ReadonlyArray<string>): boolean =>
	selectors.length === 0 ||
	Arr.some(selectors, (s) => s === g.gate.name || Arr.some(g.gate.gates, (id) => id === s))

const round = (x: number): number => Math.round(x * 1000) / 1000

export interface RunGateOptions {
	readonly quick: boolean
	/** Read once per run, so every record of the run names the same source. */
	readonly source: SourceIdentity
}

/**
 * What a record holds before the run's outcome is known: the identity without a server, the file, the scale and the
 * run's phase timings.
 */
export interface RecordBase {
	readonly identity: RunIdentity
	readonly file: string
	readonly quick: boolean
	readonly runPhases: { readonly setupMs: number; readonly runMs: number }
}

/**
 * The record of one gate's run, from the run's outcome and its release's, apart: a failed run is a FailedRecord; a run
 * that returned keeps its cases, with every verdict an `error` when the release leaked or the record is incomplete.
 */
export const recordOf = (
	gate: Gate,
	base: RecordBase,
	run: Exit.Exit<{ readonly server: ServerIdentity; readonly result: GateRun }, unknown>,
	release: Exit.Exit<void, unknown>
): GateRecord => {
	const named = {
		name: gate.name,
		file: base.file,
		title: gate.title,
		gates: gate.gates,
		quick: base.quick
	}
	const released: Release = Exit.isSuccess(release)
		? { kind: "clean" }
		: { kind: "leaked", report: Cause.pretty(release.cause) }
	if (Exit.isFailure(run)) {
		return {
			kind: "failed",
			identity: base.identity,
			...named,
			runPhases: base.runPhases,
			release: released,
			cause: Cause.pretty(run.cause)
		}
	}
	const { server, result } = run.value
	const judged = Arr.map(result.verdicts, (v) => verdictOf(v.gate, v.input))
	const errored = (cause: string): ReadonlyArray<VerdictRecord> =>
		Arr.map(judged, (v) => ({ gate: v.gate, outcome: "error", cause, checks: v.checks }))
	const ran: RanRecord = Exit.isSuccess(release)
		? {
				kind: "ran",
				identity: { ...base.identity, server },
				...named,
				runPhases: base.runPhases,
				release: { kind: "clean" },
				verdicts: judged,
				cases: result.cases,
				problems: []
			}
		: {
				kind: "ran",
				identity: { ...base.identity, server },
				...named,
				runPhases: base.runPhases,
				release: { kind: "leaked", report: Cause.pretty(release.cause) },
				verdicts: errored(`the release leaked: ${firstLine(Cause.pretty(release.cause))}`),
				cases: result.cases,
				problems: []
			}
	const problems = recordProblems(ran)
	return problems.length === 0
		? ran
		: { ...ran, problems, verdicts: errored("the record is incomplete") }
}

/**
 * Runs one gate in a database of its own, on the gate's route, and returns its record. The database is built in a scope
 * of the runner's own and released once the run has ended, so the run's outcome and the release's are two Exits; a
 * failure to build the database is the run's. Only the run is interruptible: an interrupted run is a failed one, and
 * the release runs whatever ended it.
 *
 * @internal
 */
export const runGate = (
	discovered: DiscoveredGate,
	options: RunGateOptions
): Effect.Effect<GateRecord, IdentityUnreadable, FileSystem.FileSystem> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const { gate, file } = discovered
			const runOptions = gate.options(options.quick)
			const started = performance.now()
			let ranAt = started
			const scope = yield* Scope.make()
			const run = yield* Effect.exit(
				restore(
					Effect.gen(function* () {
						const context = yield* Layer.buildWithScope(Substrate.isolatedLayer, scope)
						return yield* Effect.gen(function* () {
							const substrate = yield* Substrate
							const server = yield* serverIdentity(substrate.admin)
							ranAt = performance.now()
							const result = yield* gate.run({
								quick: options.quick,
								options: runOptions,
								server,
								substrate
							})
							return { server, result }
						}).pipe(Effect.provide(context), Scope.provide(scope))
					})
				)
			)
			const finished = performance.now()
			const release = yield* Effect.exit(Scope.close(scope, Exit.void))
			const identity = yield* runIdentity({
				benchmark: `gate/${gate.name}`,
				phases: gate.phases,
				scope: gate.scope,
				options: runOptions,
				source: options.source
			})
			return recordOf(
				gate,
				{
					identity,
					file,
					quick: options.quick,
					runPhases: { setupMs: round(ranAt - started), runMs: round(finished - ranAt) }
				},
				run,
				release
			)
		})
	)

/**
 * Writes `record` where its kind and scale put it. A returned run's record removes the same scale's failed one; a
 * failed run's record leaves the returned one in place.
 *
 * @internal
 */
export const writeRecord = Effect.fn("writeRecord")(
	function* (
		outDir: string,
		record: GateRecord
	): Effect.fn.Return<
		string,
		PlatformError.PlatformError | Schema.SchemaError,
		FileSystem.FileSystem
	> {
		const fs = yield* FileSystem.FileSystem
		const scale = scaleOf(record.quick)
		const path =
			record.kind === "ran"
				? recordPath(outDir, record.name, scale)
				: failedRecordPath(outDir, record.name, scale)
		yield* fs.makeDirectory(gatesDirectory(outDir), { recursive: true })
		yield* fs.writeFileString(path, `${yield* encodeJson(record)}\n`)
		if (record.kind === "ran") {
			yield* fs.remove(failedRecordPath(outDir, record.name, scale), { force: true })
		}
		return path
	},
	(effect, outDir) =>
		Effect.mapError(effect, (cause) => RecordUnwritable.make({ outDir, detail: String(cause) }))
)

/** Why a record or the summary could not be written or read back under the output directory. */
class RecordUnwritable extends Schema.TaggedError<
	RecordUnwritable,
	{ readonly brand: unique symbol }
>()("RecordUnwritable", { outDir: Schema.String, detail: Schema.String }) {}

/** A record or summary as its file holds it: JSON indented by tabs. */
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: "\t" }))

/**
 * What a summary reads of a record on disk: the members summarizeRecords and the listing use. A record is a file a run
 * wrote, read back as JSON and admitted by this form; its other members are not read.
 */
interface RecordedCommon {
	readonly file: string
	readonly gates: ReadonlyArray<GateId>
	readonly quick: boolean
	readonly identity: {
		readonly recordedAt: string
		readonly source: { readonly gitSha: string; readonly gitDirty: boolean }
	}
}

export type RecordedGate =
	| (RecordedCommon & { readonly kind: "ran"; readonly verdicts: ReadonlyArray<VerdictRecord> })
	| (RecordedCommon & { readonly kind: "failed"; readonly cause: string })

const GateIdSchema = Schema.Literals([...ruleIds, ...extraGateIds])
const CheckSchema = Schema.Struct({
	kind: Schema.Literals(["mechanism", "equivalence"]),
	name: Schema.String,
	holds: Schema.Boolean,
	detail: Schema.String
})
const checks = Schema.Array(CheckSchema)
const VerdictSchema = Schema.Union([
	Schema.Struct({ gate: GateIdSchema, outcome: Schema.Literal("pass"), checks }),
	Schema.Struct({
		gate: GateIdSchema,
		outcome: Schema.Literal("fail"),
		failing: Schema.NonEmptyArray(Schema.String),
		checks
	}),
	Schema.Struct({
		gate: GateIdSchema,
		outcome: Schema.Literal("error"),
		cause: Schema.String,
		checks
	})
])

const common = {
	file: Schema.String,
	gates: Schema.Array(GateIdSchema),
	quick: Schema.Boolean,
	identity: Schema.Struct({
		recordedAt: Schema.String,
		source: Schema.Struct({ gitSha: Schema.String, gitDirty: Schema.Boolean })
	})
} as const

const RecordedGateSchema: Schema.Codec<RecordedGate> = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("ran"), ...common, verdicts: Schema.Array(VerdictSchema) }),
	Schema.Struct({ kind: Schema.Literal("failed"), ...common, cause: Schema.String })
])
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(RecordedGateSchema))

/** The record files a run writes: <name>.<scale>.json and <name>.<scale>.failed.json. */
const isRecordFile = (f: string): boolean =>
	regex("\\.(?:full|quick)(?:\\.failed)?\\.json$").test(f)

/**
 * Every record on disk under `outDir` whose bench file still exists, in file name order.
 *
 * @internal
 */
export const readRecords = Effect.fn("readRecords")(
	function* (outDir: string) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const dir = gatesDirectory(outDir)
		if (!(yield* fs.exists(dir))) {
			return []
		}
		const entries = yield* fs.readDirectory(dir)
		const files = Arr.sort(Arr.filter(entries, isRecordFile), Order.String)
		const records = yield* Effect.forEach(files, (f) =>
			Effect.flatMap(fs.readFileString(path.join(dir, f)), decodeRecord)
		)
		return yield* Effect.filter(records, (r) => fs.exists(path.join(repoRoot, r.file)))
	},
	(effect, outDir) =>
		Effect.mapError(effect, (cause) => RecordUnwritable.make({ outDir, detail: String(cause) }))
)

const summaryFile = "summary.json"

/** Worst first: what a gate several records cover reports. */
const severity: Readonly<Record<GateOutcome, number>> = {
	error: 0,
	fail: 1,
	missing: 2,
	pass: 3
}

const worst = ([first, ...rest]: Arr.NonEmptyReadonlyArray<GateOutcome>): GateOutcome =>
	Arr.reduce(rest, first, (a, b) => (severity[b] < severity[a] ? b : a))

/** The worst of some records' outcomes for one gate, or `missing` when none covers it. */
export const outcomeOver = (outcomes: ReadonlyArray<GateOutcome>): GateOutcome =>
	Arr.isReadonlyArrayNonEmpty(outcomes) ? worst(outcomes) : "missing"

/** One record's outcome for `gate`, and why: a failed run's gates are `error`, with its cause. */
export const recordedVerdicts = (
	record: RecordedGate,
	gate: GateId
): ReadonlyArray<{ readonly outcome: VerdictRecord["outcome"]; readonly reason: string }> => {
	switch (record.kind) {
		case "ran":
			return Arr.map(
				Arr.filter(record.verdicts, (v) => v.gate === gate),
				(v) => ({ outcome: v.outcome, reason: verdictReason(v) })
			)
		case "failed":
			return record.gates.includes(gate)
				? [{ outcome: "error", reason: firstLine(record.cause) }]
				: []
	}
}

export interface GateStatus {
	readonly gate: GateId
	readonly title: string
	readonly owner: GateOwner
	readonly outcome: GateOutcome
	readonly files: ReadonlyArray<string>
	/** Why each covering record's verdict is not a pass. */
	readonly reasons: ReadonlyArray<string>
	/** The source each record was taken at, and when. */
	readonly recorded: ReadonlyArray<{
		readonly file: string
		readonly gitSha: string
		readonly gitDirty: boolean
		readonly recordedAt: string
		readonly quick: boolean
	}>
}

export interface GateSummary {
	readonly outcomes: Readonly<Record<GateOutcome, number>>
	readonly gates: ReadonlyArray<GateStatus>
}

export const summarizeRecords = (records: ReadonlyArray<RecordedGate>): GateSummary => {
	const gates = Arr.map(gateCatalog, (entry): GateStatus => {
		const covering = Arr.filter(records, (r) => r.gates.includes(entry.id))
		const verdicts = Arr.flatMap(covering, (r) => recordedVerdicts(r, entry.id))
		return {
			gate: entry.id,
			title: entry.title,
			owner: entry.owner,
			outcome: outcomeOver(Arr.map(verdicts, (v) => v.outcome)),
			files: [...new Set(Arr.map(covering, (r) => r.file))],
			reasons: Arr.flatMap(verdicts, (v) => (v.outcome === "pass" ? [] : [v.reason])),
			recorded: Arr.map(covering, (r) => ({
				file: r.file,
				gitSha: r.identity.source.gitSha,
				gitDirty: r.identity.source.gitDirty,
				recordedAt: r.identity.recordedAt,
				quick: r.quick
			}))
		}
	})
	const count = (o: GateOutcome): number => Arr.filter(gates, (g) => g.outcome === o).length
	return {
		outcomes: {
			pass: count("pass"),
			fail: count("fail"),
			error: count("error"),
			missing: count("missing")
		},
		gates
	}
}

/** @internal */
export const writeSummary = Effect.fn("writeSummary")(
	function* (
		outDir: string,
		summary: GateSummary
	): Effect.fn.Return<
		string,
		PlatformError.PlatformError | Schema.SchemaError,
		FileSystem.FileSystem
	> {
		const fs = yield* FileSystem.FileSystem
		const path = `${gatesDirectory(outDir)}/${summaryFile}`
		yield* fs.makeDirectory(gatesDirectory(outDir), { recursive: true })
		yield* fs.writeFileString(path, `${yield* encodeJson(summary)}\n`)
		return path
	},
	(effect, outDir) =>
		Effect.mapError(effect, (cause) => RecordUnwritable.make({ outDir, detail: String(cause) }))
)

export interface RunGatesOptions {
	readonly quick: boolean
	readonly outDir: string
	readonly directories: ReadonlyArray<string>
	/** Gate ids or bench files' names; none runs every gate. */
	readonly only: ReadonlyArray<string>
	/** Runs with each record as it is written. */
	readonly onRecord: (record: GateRecord, path: string) => Effect.Effect<void>
}

interface GatesRun {
	readonly records: ReadonlyArray<GateRecord>
	readonly summary: GateSummary
}

/**
 * Discovers the gates, runs the selected ones one at a time, writes each record, then the summary over every record on
 * disk. An interrupt stops it between and inside runs; the run it interrupts is released and records nothing.
 */
export const runGates = Effect.fn("runGates")(function* (options: RunGatesOptions) {
	const discovered = yield* discoverGates(options.directories)
	const selected = Arr.filter(discovered, (g) => selects(g, options.only))
	const source = yield* sourceIdentity
	const records = yield* Effect.forEach(selected, (g) =>
		Effect.gen(function* () {
			const record = yield* runGate(g, { quick: options.quick, source })
			const path = yield* writeRecord(options.outDir, record)
			yield* options.onRecord(record, path)
			return record
		})
	)
	const outRecords = yield* readRecords(options.outDir)
	const summary = summarizeRecords(outRecords)
	yield* writeSummary(options.outDir, summary)
	const run: GatesRun = { records, summary }
	return run
})
