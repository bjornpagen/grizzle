import { DevtoolFailure, failureFrom } from "@grizzle/devtools/devtool"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Record as Rec,
	Result,
	Schema
} from "effect"

/** A mutant some test killed, or killed by timing out: the stage that killed it and its killing files and tests. */
const Killed = Schema.Struct({
	status: Schema.Literals(["killed", "timeout"]),
	stage: Schema.Literals([1, 2]),
	killedBy: Schema.NonEmptyArray(Schema.String),
	/** The failing tests, "file > suite > test", leaves only. */
	killedByTests: Schema.Array(Schema.String)
})

/** A mutant no test killed: it survived, no test executes it, or the type checker rejects it. */
const Unkilled = Schema.Struct({ status: Schema.Literals(["survived", "no-coverage", "invalid"]) })

/** What the tests made of one mutant. A survivor names no stage and no killer. */
export const Verdict = Schema.Union([Killed, Unkilled])
export type Verdict = typeof Verdict.Type

/** Where a mutant is and what it does. */
const where = {
	id: Schema.String,
	area: Schema.String,
	file: Schema.String,
	line: Schema.Int,
	column: Schema.Int,
	function: Schema.String,
	operator: Schema.String,
	original: Schema.String,
	replacement: Schema.String
} as const
const Described = Schema.Struct(where)

/** One mutant in the report: where it is, what it does, and its verdict. */
const Entry = Schema.Union([
	Schema.Struct({ ...where, ...Killed.fields }),
	Schema.Struct({ ...where, ...Unkilled.fields })
])
export type Entry = typeof Entry.Type

/** One run that contributed entries: the commit it tested and how. */
const Run = Schema.Struct({
	commit: Schema.String,
	generated: Schema.String,
	settings: Schema.Unknown
})
type Run = typeof Run.Type

/** What a report keeps to be merged into or rebuilt: the rest is computed from it. */
const Stored = Schema.Struct({
	runs: Schema.Array(Run),
	population: Schema.Record(Schema.String, Schema.Int),
	covers: Schema.Record(Schema.String, Schema.Int),
	mutants: Schema.Array(Entry)
})
export type Stored = typeof Stored.Type

const decodeStored = Schema.decodeEffect(Schema.fromJsonString(Stored))

/**
 * The report at `path`, or none when there is none yet.
 *
 * @internal
 */
export const readStored = Effect.fn("readStored")(function* (path: string) {
	const fs = yield* FileSystem.FileSystem
	const present = yield* fs
		.exists(path)
		.pipe(Effect.mapError(failureFrom(`the report ${path} could not be read`)))
	if (!present) {
		return Option.none<Stored>()
	}
	const text = yield* fs
		.readFileString(path)
		.pipe(Effect.mapError(failureFrom(`the report ${path} could not be read`)))
	const stored = yield* decodeStored(text).pipe(
		Effect.mapError(failureFrom(`the report ${path} is not a report`))
	)
	return Option.some(stored)
})

const Triage = Schema.Struct({
	id: Schema.String,
	verdict: Schema.Literals(["equivalent", "gap-fixed"]),
	reason: Schema.String
})
type Triage = typeof Triage.Type

const TriageJson = Schema.fromJsonString(Schema.Array(Triage), { space: "\t" })

/** The triage verdicts file and the population of mutant ids it judges. */
export interface TriageInput {
	readonly path: string
	readonly population: ReadonlySet<string>
}

const readVerdicts = Effect.fn("readVerdicts")(function* (path: string) {
	const fs = yield* FileSystem.FileSystem
	const text = yield* fs
		.readFileString(path)
		.pipe(Effect.mapError(failureFrom(`${path} could not be read`)))
	return yield* Schema.decodeEffect(TriageJson)(text).pipe(
		Effect.mapError(failureFrom(`${path} is not a triage`))
	)
})

/**
 * The triage verdicts at `path`, each keyed by the mutant id it judges. A verdict is a claim about one mutant of the
 * current population (operators.ts: the id digests the file, operator, enclosing function, original and replacement
 * text and ordinal), so a verdict whose id no current mutant has is refused: its code moved or changed, and the fault
 * it judged now has another id, which a run lists as untriaged.
 *
 * @internal
 */
export const readTriage = Effect.fn("readTriage")(function* (input: TriageInput) {
	const all = yield* readVerdicts(input.path)
	const orphans = Arr.filter(all, (t) => !input.population.has(t.id))
	if (Arr.isReadonlyArrayNonEmpty(orphans)) {
		return yield* DevtoolFailure.make({
			detail: Arr.join(
				[
					`triage.json holds ${orphans.length} orphan verdicts, whose mutants are in no current population; re-triage or delete each:`,
					...Arr.map(orphans, (t) => `${t.id} ${t.verdict}: ${t.reason}`)
				],
				"\n"
			)
		})
	}
	return new Map(Arr.map(all, (t) => [t.id, t] as const))
})

/** What pruning the triage left: the verdicts kept and the verdicts dropped. */
interface Pruned {
	readonly kept: number
	readonly dropped: ReadonlyArray<string>
}

/**
 * Rewrites the triage at `path` without the verdicts whose mutant is in no current population, the orphans
 * `readTriage` refuses, and reports how many it kept and the ids it dropped.
 *
 * @internal
 */
export const pruneTriage = Effect.fn("pruneTriage")(function* (input: TriageInput) {
	const fs = yield* FileSystem.FileSystem
	const [kept, dropped] = Arr.partition(yield* readVerdicts(input.path), (t) =>
		input.population.has(t.id) ? Result.succeed(t) : Result.fail(t.id)
	)
	const text = yield* Schema.encodeEffect(TriageJson)(kept).pipe(
		Effect.mapError(failureFrom("the triage could not be encoded"))
	)
	yield* fs
		.writeFileString(input.path, `${text}\n`)
		.pipe(Effect.mapError(failureFrom(`${input.path} could not be written`)))
	const pruned: Pruned = { kept: kept.length, dropped }
	return pruned
})

/**
 * `next` merged over `prior`: the runs one after the other, the newer population, the coverage counts summed (each
 * run's mutants are its own, so the sum counts each mutant once unless a later run planned it again), and the newer
 * entry of a mutant both hold.
 */
export const merged = (prior: Stored, next: Stored): Stored => {
	const fresh = new Set(Arr.map(next.mutants, (m) => m.id))
	return {
		runs: [...prior.runs, ...next.runs],
		population: { ...prior.population, ...next.population },
		covers: Rec.union(prior.covers, next.covers, (a, b) => a + b),
		mutants: [...Arr.filter(prior.mutants, (m) => !fresh.has(m.id)), ...next.mutants]
	}
}

/**
 * The run's score counts what the tests killed; equivalent mutants and those the type checker rejects are left out. The
 * score after triage also counts a survivor whose gap a new test closed as killed.
 */
const Score = Schema.Struct({
	mutants: Schema.Int,
	killed: Schema.Int,
	timeout: Schema.Int,
	survived: Schema.Int,
	noCoverage: Schema.Int,
	invalid: Schema.Int,
	equivalent: Schema.Int,
	gapFixed: Schema.Int,
	score: Schema.Finite,
	scoreAfterTriage: Schema.Finite
})
type Score = typeof Score.Type

const scoreJson = Schema.fromJsonString(Score)

/** A score as one line of JSON. */
export const encodeScore = (score: Score): Effect.Effect<string, Schema.SchemaError> =>
	Schema.encodeEffect(scoreJson)(score)

/** The share `n` of `d` to four places; an empty denominator scores 1, since nothing escaped. */
const ratio = (n: number, d: number): number =>
	d === 0 ? 1 : Math.round((10_000 * n) / d) / 10_000

/** What a mutant counts as in a score: its status, or `equivalent` for a survivor triage judged equivalent. */
type ScoreClass = Entry["status"] | "equivalent"

const scoreOf = (ms: ReadonlyArray<Entry>, triage: ReadonlyMap<string, Triage>): Score => {
	const verdictOf = (m: Entry): Option.Option<Triage["verdict"]> =>
		Option.map(Option.fromUndefinedOr(triage.get(m.id)), (t) => t.verdict)
	const classOf = (m: Entry): ScoreClass => {
		switch (m.status) {
			case "killed":
			case "timeout":
			case "invalid":
				return m.status
			case "survived":
			case "no-coverage":
				return Option.contains(verdictOf(m), "equivalent") ? "equivalent" : m.status
		}
	}
	const classes = Arr.map(ms, classOf)
	const count = (c: ScoreClass): number => Arr.filter(classes, (x) => x === c).length
	const killed = count("killed")
	const timeout = count("timeout")
	const invalid = count("invalid")
	const equivalent = count("equivalent")
	const gapFixed = Arr.filter(
		ms,
		(m) =>
			(m.status === "survived" || m.status === "no-coverage") &&
			Option.contains(verdictOf(m), "gap-fixed")
	).length
	const counted = ms.length - invalid - equivalent
	return {
		mutants: ms.length,
		killed,
		timeout,
		survived: count("survived"),
		noCoverage: count("no-coverage"),
		invalid,
		equivalent,
		gapFixed,
		score: ratio(killed + timeout, counted),
		scoreAfterTriage: ratio(killed + timeout + gapFixed, counted)
	}
}

const byKey: Order.Order<readonly [string, unknown]> = Order.mapInput(
	Order.String,
	([key]: readonly [string, unknown]) => key
)

/** The record with its keys in UTF-16 order. */
const keySorted = <A>(record: Readonly<Record<string, A>>): Record<string, A> =>
	Rec.fromEntries(Arr.sort(Rec.toEntries(record), byKey))

const KillSet = Schema.Record(Schema.String, Schema.Array(Schema.String))
type KillSet = typeof KillSet.Type

/** Per killer, the ids of the mutants it names, in order. */
const killSet = (pairs: ReadonlyArray<readonly [string, string]>): KillSet =>
	keySorted(
		Rec.map(
			Arr.groupBy(pairs, ([killer]) => killer),
			(group) =>
				Arr.sort(
					Arr.map(group, ([, id]) => id),
					Order.String
				)
		)
	)

/** Per killer, the mutants it kills, and the mutants it alone kills. */
const killSets = (
	entries: ReadonlyArray<Entry>,
	killers: (e: Entry) => ReadonlyArray<string>
): { readonly all: KillSet; readonly unique: KillSet } => {
	const killed = Arr.map(entries, (e) => ({ id: e.id, by: killers(e) }))
	return {
		all: killSet(Arr.flatMap(killed, ({ id, by }) => Arr.map(by, (k) => [k, id] as const))),
		unique: killSet(
			Arr.flatMap(killed, ({ id, by }) =>
				by.length === 1 ? Arr.map(by, (k) => [k, id] as const) : []
			)
		)
	}
}

const killingFiles = (e: Entry): ReadonlyArray<string> =>
	e.status === "killed" || e.status === "timeout" ? e.killedBy : []

const killingTests = (e: Entry): ReadonlyArray<string> =>
	e.status === "killed" || e.status === "timeout" ? e.killedByTests : []

const survivorStatus = Schema.Literals(["survived", "no-coverage"])

/** A mutant no test killed, as triage judged it: untriaged, or with its verdict and the reason for it. */
const Survivor = Schema.Union([
	Schema.Struct({ ...where, status: survivorStatus, triage: Schema.Literal("untriaged") }),
	Schema.Struct({
		...where,
		status: survivorStatus,
		triage: Triage.fields.verdict,
		reason: Schema.String
	})
])
type Survivor = typeof Survivor.Type

/**
 * The report a run writes: every mutant with its verdict, the scores per area, operator and module, before and after
 * triage, the survivors with their triage, per test file how many of the mutants it executes, by the coverage passes,
 * and the kill sets per test file and per test.
 */
const Report = Schema.Struct({
	tool: Schema.Literal("scripts/dev/mutate"),
	runs: Schema.Array(Run),
	population: Schema.Record(Schema.String, Schema.Int),
	total: Score,
	areas: Schema.Record(Schema.String, Score),
	operators: Schema.Record(Schema.String, Score),
	modules: Schema.Record(Schema.String, Score),
	survivors: Schema.Array(Survivor),
	invalid: Schema.Array(Described),
	mutants: Schema.Array(Entry),
	covers: Schema.Record(Schema.String, Schema.Int),
	kills: KillSet,
	uniqueKills: KillSet,
	testKills: KillSet,
	uniqueTestKills: KillSet
})
export type Report = typeof Report.Type

const reportJson = Schema.fromJsonString(Report, { space: "\t" })

/** The report as the file holds it: JSON indented by tabs. */
export const encodeReport = (report: Report): Effect.Effect<string, Schema.SchemaError> =>
	Schema.encodeEffect(reportJson)(report)

const describe = (e: Entry): typeof Described.Type => ({
	id: e.id,
	area: e.area,
	file: e.file,
	line: e.line,
	column: e.column,
	function: e.function,
	operator: e.operator,
	original: e.original,
	replacement: e.replacement
})

const entryOrder: Order.Order<Entry> = Order.combineAll([
	Order.mapInput(Order.String, (e: Entry) => e.area),
	Order.mapInput(Order.String, (e: Entry) => e.file),
	Order.mapInput(Order.Number, (e: Entry) => e.line),
	Order.mapInput(Order.Number, (e: Entry) => e.column),
	Order.mapInput(Order.String, (e: Entry) => e.id)
])

/** A run's stored entries and the triage to judge its survivors by. */
export interface ReportInput {
	readonly stored: Stored
	readonly triage: ReadonlyMap<string, Triage>
}

/**
 * The report of `stored` with `triage` merged: every mutant with its verdict, the scores per area, operator and module,
 * before and after triage, and the kill sets. A report is built from its entries, so a run can merge into an earlier
 * report (--merge): the earlier entries of mutants this run did not plan are kept, and every score, list and kill set
 * is computed again over the union. A report can also be rebuilt from its own entries with the current triage
 * (--retriage).
 */
export const reportOf = ({ stored, triage }: ReportInput): Report => {
	const entries = Arr.sort(stored.mutants, entryOrder)
	const scores = (key: (e: Entry) => string): Record<string, Score> =>
		keySorted(Rec.map(Arr.groupBy(entries, key), (es) => scoreOf(es, triage)))
	const survivorOf = (e: Entry): Option.Option<Survivor> => {
		if (e.status !== "survived" && e.status !== "no-coverage") {
			return Option.none()
		}
		const described = { ...describe(e), status: e.status }
		return Option.some(
			Option.match(Option.fromUndefinedOr(triage.get(e.id)), {
				onNone: (): Survivor => ({ ...described, triage: "untriaged" }),
				onSome: (t): Survivor => ({ ...described, triage: t.verdict, reason: t.reason })
			})
		)
	}
	const fileKills = killSets(entries, killingFiles)
	const testKills = killSets(entries, killingTests)
	return {
		tool: "scripts/dev/mutate",
		runs: stored.runs,
		population: stored.population,
		total: scoreOf(entries, triage),
		areas: scores((e) => e.area),
		operators: scores((e) => e.operator),
		modules: scores((e) => e.file),
		survivors: Arr.getSomes(Arr.map(entries, survivorOf)),
		invalid: Arr.map(
			Arr.filter(entries, (e) => e.status === "invalid"),
			describe
		),
		mutants: entries,
		covers: keySorted(stored.covers),
		kills: fileKills.all,
		uniqueKills: fileKills.unique,
		testKills: testKills.all,
		uniqueTestKills: testKills.unique
	}
}
