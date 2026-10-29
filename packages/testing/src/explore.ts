import {
	Array as Arr,
	Cause,
	Console,
	Context,
	Duration,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Option,
	type Scope,
	Schema,
	String as Str
} from "effect"
import { type Branch, count, firstBranch, nextBranch } from "#enumerate.ts"
import {
	type Features,
	type GeneratedPhase,
	keyOf,
	keysAt,
	type Pending,
	pendingAt,
	pendingOf,
	type Reach,
	reachOf,
	type Residual,
	residualOf,
	shortOf,
	type Short,
	type Tally,
	type TallyBuilder,
	tallyOf
} from "#features.ts"
import type { Corpus, Fuzz, FuzzBudget } from "#fuzz.ts"
import type { Gen } from "#gen.ts"
import { liveMillis, liveSleep, stopHung } from "#live.ts"
import { mutate } from "#mutate.ts"
import { between, caseSeed, floorSeed, fnv1a32, mix, rotatingSeed, wordsOf } from "#random.ts"
import { type Drawn, type Replay, ReplayCase, replayTokenOf } from "#replay.ts"
import { seedsOf } from "#seeds.ts"
import { notesOnly, type Sense } from "#sense.ts"
import { type Attempt, type ShrinkBudget, shrinkAttempt } from "#shrink.ts"
import {
	type Chooser,
	forcedChooser,
	type Observed,
	prefixChooser,
	randomChooser,
	type Recorder,
	type Recording,
	recorder,
	recording,
	simplestChooser
} from "#source.ts"
import { type Tape, tokenOf, valuesFromToken } from "#tape.ts"

/** How a run came by its seed: given in the environment to replay a run, or freshly drawn. */
export type SeedSource = "environment" | "fresh"

/**
 * The run every exploration draws from. The runner provides it once per process, so every suite of a run shares one
 * seed and one failure names the whole run: rerunning with that seed reproduces it. A replay names the one suite whose
 * streams give way to one case, drawn under the steering its token records. A fuzz run names the one suite it fuzzes;
 * every other suite runs as under test.
 */
export class Run extends Context.Service<
	Run,
	Readonly<{
		seed: number
		source: SeedSource
		replay: Option.Option<Replay>
		fuzz: Option.Option<Fuzz>
	}>
>()("@grizzle/testing/explore/Run") {}

/** A case gave itself up: its precondition did not hold. It never counts as a pass or a failure. */
export class CaseDiscarded extends Schema.TaggedError<
	CaseDiscarded,
	{ readonly brand: unique symbol }
>()("CaseDiscarded", {}) {}

const isDiscarded = Schema.is(CaseDiscarded)

/**
 * What a property sees of the case it runs: it notes the situations it reached; steers, where steering is allowed, by
 * reading which of the suite's required situations no generated case had reached when the case's window began
 * (Pending); draws more from the case's own tape; records on the tape what the system under test decided (and learns
 * whether a replay decided the same); and gives the case up when a precondition fails. A note, a draw or an
 * observation made after the case ended is a misuse, reported as one. `steering` is none wherever a case must be a
 * plain draw of its generator: the rotating stream, whose cases alone estimate the residual, and a kept case, which
 * must run as it ran. A property cannot steer there, so the estimate never rests on steered cases. A replay steers
 * exactly as the case it replays did: its token records what the case was drawn under.
 */
export type Case<F extends string> = Readonly<{
	note: (feature: F) => void
	noteAll: (features: Iterable<F>) => void
	pair: (first: F, second: F) => void
	steering: Option.Option<Pending<F>>
	draw: <A>(generator: Gen<A>) => A
	observe: (decided: string) => Observed
	assume: (holds: boolean) => Effect.Effect<void, CaseDiscarded>
}>

/**
 * What a suite generates and what its property sees: the sketch is what is generated, printed and shrunk, and `resolve`
 * turns it into the value the property takes. A resolve that throws fails the case like the property would.
 */
export type Draw<S, T> = Readonly<{ generator: Gen<S>; resolve: (sketch: S) => T }>

/** The property takes the generated value itself. */
export const drawn = <T>(generator: Gen<T>): Draw<T, T> => ({
	generator,
	resolve: (value) => value
})

/** The property takes what `resolve` makes of the generated sketch. */
export const sketched = <S, T>(generator: Gen<S>, resolve: (sketch: S) => T): Draw<S, T> => ({
	generator,
	resolve
})

/**
 * A counterexample kept by value: it replays before any stream, unsteered, is never shrunk, and must still reach every
 * situation it names, so a kept case that drifted away from what it once caught fails loudly. Its sketch is a value;
 * what the property drew from the case's tape is `draws`, the tape token of exactly those decisions ("" when it drew
 * none), so a kept race replays the very schedule that failed. A kept case passes only when it ran exactly its draws:
 * draws that no longer fit what the property draws, running out, out of a decision's range or left over, fail as
 * `KeptStale`, as does a kept case that gives itself up, and a kept case never fills in what it lacks. A failure or a
 * hang it meets is reported as one, stale or not. What the system decided is observed, not drawn: an observation the
 * draws lack is recorded, never stale.
 */
export type Kept<S, F extends string> = Readonly<{
	note: string
	sketch: S
	draws: string
	reaches: Arr.NonEmptyReadonlyArray<F>
}>

/**
 * A property search over one draw. Every field is stated by the suite, so its budget is on the page:
 * - `literal` prints a sketch as source the suite can paste into its kept cases, and must read back as the same sketch;
 * - `runs` is the rotating stream's cases, and the floor stream runs a quarter as many: the suite's whole budget under
 *   test, where a longer search is a fuzz run with a budget of its own;
 * - `concurrency` is how many cases run at once; cases that share state the property does not isolate run one at a
 *   time;
 * - `steerEvery` is how many cases pass between the snapshots `Case.steering` reads, a constant of the suite, so the
 *   same seed draws the same cases however many run at once;
 * - `steering` is whether a steered phase mutates the cases that found something new before the rotating stream runs;
 * - `caseHang` is how long one case may run before it is stopped and reported.
 */
export type Exploration<S, T, F extends string> = Readonly<{
	suite: string
	draw: Draw<S, T>
	literal: (sketch: S) => string
	features: Features<F>
	kept: ReadonlyArray<Kept<S, F>>
	runs: number
	shrink: ShrinkBudget
	concurrency: number
	steerEvery: number
	steering: Steering
	caseHang: Duration.Input
}>

/**
 * Whether a search steers. A steered phase runs between the floor stream and the rotating one: it keeps every case
 * that noted a situation or pair no earlier case had, or that its sense perceived something new in, and mutates kept
 * cases, the rarest finders most, for up to `cases` cases or until every required situation is reached. Steered
 * cases satisfy required situations, since a generator produced them, but never the residual, which only the
 * rotating stream's independent cases estimate.
 */
export type Steering =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "mutate"; cases: number; sense: Sense }>

/**
 * A property failed on a case; the report names the run, the stream, the shrunk case and how to replay it. `replay` is
 * the case a replay token names, none for a kept case and an exhaustive one.
 */
export class PropertyFalsified extends Schema.TaggedError<
	PropertyFalsified,
	{ readonly brand: unique symbol }
>()("PropertyFalsified", {
	suite: Schema.String,
	replay: Schema.Option(ReplayCase),
	message: Schema.String
}) {}

/** A case ran past its hang limit; it is reported as drawn, unshrunk, and the suite stops. */
export class CaseHung extends Schema.TaggedError<CaseHung, { readonly brand: unique symbol }>()(
	"CaseHung",
	{ suite: Schema.String, replay: Schema.Option(ReplayCase), message: Schema.String }
) {}

/** More cases gave themselves up than ran: the generator rarely meets the property's precondition, and should build
 * values that meet it rather than filter for them. */
export class CasesStalled extends Schema.TaggedError<
	CasesStalled,
	{ readonly brand: unique symbol }
>()("CasesStalled", { suite: Schema.String, message: Schema.String }) {}

/**
 * No generated case reached a required situation within the search's budget: the generator draws it too rarely for the
 * cases it runs, or no longer draws it at all. A kept case never counts, so a situation only a kept case reaches needs a
 * generator arm or a steered phase that reaches it.
 */
export class FeaturesUnreached extends Schema.TaggedError<
	FeaturesUnreached,
	{ readonly brand: unique symbol }
>()("FeaturesUnreached", {
	suite: Schema.String,
	missing: Schema.Array(Schema.String),
	message: Schema.String
}) {}

/**
 * Some cases of a passing search's sample (an exploration's independent cases, an exhaustion's every case) reached a
 * requirement fewer times than the suite's reach margin asks. `short` names each such requirement and how many of
 * those cases reached it.
 */
export class ReachBelowMargin extends Schema.TaggedError<
	ReachBelowMargin,
	{ readonly brand: unique symbol }
>()("ReachBelowMargin", {
	suite: Schema.String,
	margin: Schema.Int,
	short: Schema.Array(Schema.Struct({ requirement: Schema.String, reached: Schema.Int })),
	message: Schema.String
}) {}

/** A kept case no longer runs as kept: its draws no longer fit what its property draws (they ran out, fell outside a
 * decision's range, or were left over), or it gave itself up. */
export class KeptStale extends Schema.TaggedError<KeptStale, { readonly brand: unique symbol }>()(
	"KeptStale",
	{ suite: Schema.String, note: Schema.String, message: Schema.String }
) {}

/** A replay token's case no longer runs as its token says: it steers by a requirement the suite no longer declares,
 * its draws no longer fit what its property draws, or it gave itself up. */
export class ReplayStale extends Schema.TaggedError<
	ReplayStale,
	{ readonly brand: unique symbol }
>()("ReplayStale", { suite: Schema.String, message: Schema.String }) {}

/** A kept case no longer reaches a situation it names. */
export class KeptUnreached extends Schema.TaggedError<
	KeptUnreached,
	{ readonly brand: unique symbol }
>()("KeptUnreached", {
	suite: Schema.String,
	note: Schema.String,
	missing: Schema.Array(Schema.String),
	message: Schema.String
}) {}

/** A property used its case after the case ended: it noted a situation, drew or observed. */
export class CaseMisused extends Schema.TaggedError<
	CaseMisused,
	{ readonly brand: unique symbol }
>()("CaseMisused", { suite: Schema.String, message: Schema.String }) {}

/** An exhaustive space holds more cases than its limit; it is refused before any case beyond the limit runs. */
export class SpaceBeyondLimit extends Schema.TaggedError<
	SpaceBeyondLimit,
	{ readonly brand: unique symbol }
>()("SpaceBeyondLimit", { suite: Schema.String, limit: Schema.Finite, message: Schema.String }) {}

/** Every way an exploration or an exhaustion can fail. */
export type SearchFailure =
	| PropertyFalsified
	| CaseHung
	| CasesStalled
	| FeaturesUnreached
	| ReachBelowMargin
	| KeptUnreached
	| KeptStale
	| ReplayStale
	| CaseMisused
	| SpaceBeyondLimit

/** What a case did. A failed or hung case carries its tape, the property's own draws included, to shrink or replay. */
type Outcome =
	| Readonly<{ kind: "passed" }>
	| Readonly<{ kind: "discarded" }>
	| Readonly<{ kind: "failed"; cause: Cause.Cause<unknown>; tape: Tape }>
	| Readonly<{ kind: "hung"; tape: Tape }>

/**
 * A case's outcome as its search judges it: what it did, or misused, when a case that passed or gave itself up was used
 * after it ended. A failure or a hang is judged as itself, whatever was done with the case after.
 */
type Judged = Outcome | Readonly<{ kind: "misused" }>

/**
 * What one path does with each judged outcome: a handler for every kind, so a kind added to Judged is a compile error
 * on every path that reads one.
 */
type Judgment<A> = {
	readonly [K in Judged["kind"]]: (judged: Extract<Judged, { readonly kind: K }>) => A
}

/** One case's run: its sketch, what the property drew, its notes, its sense's trace (empty unless it passed), whether it
 * was used after it ended (read when it is judged, so a use after the case ended counts), its outcome, and what its
 * caller kept of its recording. */
type CaseRun<S, K> = Readonly<{
	sketch: S
	sketchDecisions: number
	decisions: number
	overrun: boolean
	drew: ReadonlyArray<unknown>
	notes: ReadonlySet<string>
	trace: Uint8Array
	misused: () => boolean
	outcome: Outcome
	kept: K
}>

/** The one place a case's outcome is read: every path that runs a case judges it here, by its own Judgment. */
const judge = <A>(caseRun: CaseRun<unknown, unknown>, judgment: Judgment<A>): A => {
	const judged = judgedOf(caseRun)
	switch (judged.kind) {
		case "passed":
			return judgment.passed(judged)
		case "discarded":
			return judgment.discarded(judged)
		case "failed":
			return judgment.failed(judged)
		case "hung":
			return judgment.hung(judged)
		case "misused":
			return judgment.misused(judged)
	}
}

const judgedOf = (caseRun: CaseRun<unknown, unknown>): Judged => {
	switch (caseRun.outcome.kind) {
		case "passed":
		case "discarded":
			return caseRun.misused() ? { kind: "misused" } : caseRun.outcome
		case "failed":
		case "hung":
			return caseRun.outcome
	}
}

/** A failing case's run and its cause, what a shrink carries from candidate to candidate. */
type Failure<S> = Readonly<{ run: CaseRun<S, unknown>; cause: Cause.Cause<unknown> }>

/** A shrink candidate's judgment: it is a smaller case of the failure only when its property failed; a pass, a discard,
 * a hang or a misuse is not the failure being shrunk. */
const candidateJudgment = <S>(candidate: CaseRun<S, Tape>): Judgment<Attempt<Failure<S>>> => {
	const holds = (): Attempt<Failure<S>> => ({ kind: "holds", tape: candidate.kept })
	return {
		passed: holds,
		discarded: holds,
		hung: holds,
		misused: holds,
		failed: (failed) => ({
			kind: "fails",
			tape: candidate.kept,
			failure: { run: candidate, cause: failed.cause }
		})
	}
}

/** What a case is drawn under, as its replay token records it, and the steering its property sees of that. */
type Under<F extends string> = Readonly<{ drawn: Drawn; steering: Option.Option<Pending<F>> }>

const underOf = <F extends string>(declared: Features<F>, how: Drawn): Under<F> => {
	switch (how.kind) {
		case "unsteered":
			return { drawn: how, steering: Option.none() }
		case "steered":
			return { drawn: how, steering: Option.some(pendingAt(declared, how.pending)) }
	}
}

/** Cases drawn under the requirements no case of these tallies reached. */
const steeredBy = <F extends string>(
	declared: Features<F>,
	generated: ReadonlyArray<Tally<GeneratedPhase>>
): Under<F> => underOf(declared, { kind: "steered", pending: pendingOf(declared, generated) })

/** How a case's property ended, before its recording is read. */
type Settled =
	| Readonly<{ kind: "passed"; trace: Uint8Array }>
	| Readonly<{ kind: "discarded" }>
	| Readonly<{ kind: "failed"; cause: Cause.Cause<unknown> }>
	| Readonly<{ kind: "hung" }>

/** A case's outcome: discarded whenever its recording gave up, however its property ended, otherwise as its property
 * settled, a failed or hung case with its tape. */
const outcomeOf = (recorded: Recording, settled: Settled): Outcome => {
	if (recorded.status() === "discarded") {
		return { kind: "discarded" }
	}
	switch (settled.kind) {
		case "passed":
			return { kind: "passed" }
		case "discarded":
			return { kind: "discarded" }
		case "failed":
			return { kind: "failed", cause: settled.cause, tape: recorded.tape() }
		case "hung":
			return { kind: "hung", tape: recorded.tape() }
	}
}

/** Keeps nothing of a case's recording: a search reads only a failing case's tape, which its outcome carries. */
const keepNothing = (): void => undefined

/** Keeps a case's whole tape: an enumeration steps from it, and a shrink compares it. */
const keepTape = (recorded: Recording): Tape => recorded.tape()

/**
 * Runs one case on a recorder from the pool: generates its sketch from the chooser, resolves it, and runs the property
 * in its own scope and fiber, raced against the hang guard, so a case's finalizers always run, a hung case's included,
 * for as long as HUNG_CLEANUP_GRACE allows (live.ts). The property's own draws continue the same tape, so they replay
 * and shrink with the case, and it steers as `under` says. The tape is copied out only for a failed or hung case and
 * for what `keep` asks; the recorder goes back to the pool when the case ends, so a use of the case after that is
 * marked a misuse and never reaches the recorder, which another case may be drawing on.
 */
const runCase = <S, T, F extends string, E, R, K>(
	generator: Gen<S>,
	resolve: (sketch: S) => T,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>,
	chooser: Chooser,
	pool: Array<Recorder>,
	under: Under<F>,
	caseHang: Duration.Input,
	keep: (recorded: Recording) => K,
	sense: Sense
): Effect.Effect<CaseRun<S, K>, never, Exclude<R, Scope.Scope>> =>
	Effect.suspend(() => {
		const recorded = pool.pop() ?? recorder()
		recorded.reset(chooser)
		const sketch = generator(recorded.source)
		const sketchDecisions = recorded.decided()
		const notes = new Set<string>()
		const drew: Array<unknown> = []
		let open = true
		let misused = false
		const record = (key: string) => {
			if (open) {
				notes.add(key)
			} else {
				misused = true
			}
		}
		const c: Case<F> = {
			note: record,
			noteAll: (features) => {
				for (const feature of features) {
					record(feature)
				}
			},
			pair: (first, second) => record(keyOf<F>([first, second])),
			steering: under.steering,
			draw: (inner) => {
				if (!open) {
					misused = true
					return inner(recording(simplestChooser).source)
				}
				const value = inner(recorded.source)
				drew.push(value)
				return value
			},
			observe: (decided) => {
				if (!open) {
					misused = true
					return "as-recorded"
				}
				return recorded.source.observe(fnv1a32(decided))
			},
			assume: (holds) => (holds ? Effect.void : Effect.fail(CaseDiscarded.make({})))
		}
		const finish = (settled: Settled): CaseRun<S, K> => {
			open = false
			const run = {
				sketch,
				sketchDecisions,
				decisions: recorded.decided(),
				overrun: recorded.status() === "overrun",
				drew,
				notes,
				trace: settled.kind === "passed" ? settled.trace : new Uint8Array(0),
				misused: () => misused,
				outcome: outcomeOf(recorded, settled),
				kept: keep(recorded)
			}
			pool.push(recorded)
			return run
		}
		if (recorded.status() === "discarded") {
			return Effect.succeed(finish({ kind: "discarded" }))
		}
		const settled = sense
			.perceive(Effect.scoped(Effect.suspend(() => property(resolve(sketch), c))))
			.pipe(
				Effect.exit,
				Effect.map((exit): Settled => {
					if (Exit.isSuccess(exit)) {
						return { kind: "passed", trace: exit.value[1] }
					}
					return Option.exists(Exit.findErrorOption(exit), isDiscarded)
						? { kind: "discarded" }
						: { kind: "failed", cause: exit.cause }
				})
			)
		return Effect.gen(function* () {
			const running = yield* Effect.forkDetach(settled)
			const ended = yield* Effect.raceFirst(
				Effect.map(Fiber.await(running), (exit): Settled =>
					Exit.isSuccess(exit) ? exit.value : { kind: "failed", cause: exit.cause }
				),
				Effect.as(liveSleep(caseHang), { kind: "hung" } as const)
			).pipe(Effect.onInterrupt(() => stopHung(running)))
			if (ended.kind === "hung") {
				yield* stopHung(running)
			}
			return finish(ended)
		})
	})

const hex = (seed: number) => `0x${Str.padStart(8, "0")((seed >>> 0).toString(16))}`

/** The token of what a case's property drew: its tape's decisions after its sketch's, which a kept case replays. */
const drawsOf = (caseRun: CaseRun<unknown, unknown>, tape: Tape) =>
	tokenOf(
		tape.values.subarray(caseRun.sketchDecisions),
		Math.max(0, tape.length - caseRun.sketchDecisions)
	)

/** The case a replay token names: what it was drawn under, and its tape's values. */
const replayCaseOf = (how: Drawn, tape: Tape): ReplayCase => ({
	drawn: how,
	values: Arr.fromIterable(tape.values.subarray(0, tape.length))
})

/** Whether a case replayed from given draws ran exactly them: none ran out or fell outside its decision's range, and
 * none was left over. What the system decided is observed, so a case may record more decisions than it was given. */
const ranExactly = (caseRun: CaseRun<unknown, unknown>, given: number): boolean =>
	!caseRun.overrun && caseRun.decisions >= given

/** How a stale case's draws differ from what its property now draws. */
const drewInstead = (caseRun: CaseRun<unknown, unknown>, given: number): string =>
	`it gives ${given} decisions, and its property now draws ${caseRun.overrun ? "others than those" : `${caseRun.decisions}`}`

/** The first requirement a token's steering names that a suite of `declared` requirements does not have. */
const undeclaredIn = (how: Drawn, declared: number): Option.Option<number> => {
	switch (how.kind) {
		case "unsteered":
			return Option.none()
		case "steered":
			return Arr.findFirst(how.pending, (place) => place >= declared)
	}
}

/** What a failure report says about one case. */
type Reported = Readonly<{
	literal: string
	draws: string
	drew: ReadonlyArray<unknown>
	notes: ReadonlySet<string>
	cause: Cause.Cause<unknown>
}>

/** The report of a falsified case: the run, where the case came from, the case and its cause, how shrinking went, how
 * to replay it alone, and a kept-case literal ready to paste. */
const falsifiedReport = (
	run: Context.Service.Shape<typeof Run>,
	suite: string,
	where: string,
	reported: Reported,
	shrinking: string,
	replay: Option.Option<ReplayCase>
) =>
	Arr.join(
		[
			`TEST_SEED=${run.seed}${run.source === "fresh" ? " (drawn by this run)" : ""}: ${suite}, ${where}`,
			`counterexample: ${reported.literal}`,
			...(Arr.isReadonlyArrayNonEmpty(reported.drew)
				? [`the property drew: ${Formatter.format(reported.drew)}`]
				: []),
			Cause.pretty(reported.cause),
			shrinking,
			...Option.match(replay, {
				onNone: () => [],
				onSome: (replayed) => [`replay it alone: TEST_REPLAY='${replayTokenOf(suite, replayed)}'`]
			}),
			`keep it: { note: "…", sketch: ${reported.literal}, draws: ${Formatter.format(reported.draws)}, reaches: ${Formatter.format(Arr.fromIterable(reported.notes))} }`
		],
		"\n"
	)

/** The requirements under a margin, each with how many sampled cases reached it. */
const describeShort = (short: ReadonlyArray<Short>): string =>
	Arr.join(
		Arr.map(short, (requirement) => `${requirement.requirement} (${requirement.reached})`),
		", "
	)

/**
 * What a passing exploration found: its cases, its discards, the residual estimate of its independent cases, and how
 * its cases reached each requirement (Reach), in the order the suite declares them. A replay's has its one case and
 * no reach: it runs no stream.
 */
export type Explored = Readonly<{
	kind: "explored"
	suite: string
	cases: number
	discards: number
	residual: Residual
	reach: ReadonlyArray<Reach>
}>

/** A line on the process's own console, whatever console the case runs under: a fuzz run reports to the person
 * running it, as `go test -fuzz` does, past a test's captured console. */
const liveLog = (line: string) =>
	Console.log(line).pipe(Effect.provideService(Console.Console, Console.Console.defaultValue()))

/** How often a fuzz run reports its progress, in milliseconds of wall time. */
const STATUS_EVERY = 3000

/** Whether a fuzz run has spent its budget, after `cases` cases and `elapsed` milliseconds. */
const spent = (budget: FuzzBudget, cases: number, elapsed: number): boolean => {
	switch (budget.kind) {
		case "until-failure":
			return false
		case "cases":
			return cases >= budget.cases
		case "time":
			return elapsed >= Duration.toMillis(budget.duration)
	}
}

const describeBudget = (budget: FuzzBudget): string => {
	switch (budget.kind) {
		case "until-failure":
			return "until a case fails"
		case "cases":
			return `for ${budget.cases} cases`
		case "time":
			return `for ${Duration.format(budget.duration)}`
	}
}

/** Separates the steered phase's stream from the rotating stream it is derived from. */
const STEER_SALT = 0x5bd1_e995

/** One steered case in this many is a fresh draw rather than a mutant of a seed. */
const FRESH_EVERY = 4

/** How a fuzz run's corpus replay went: the cases it replayed, and how many of them it dropped. */
type CorpusReplay = Readonly<{ replayed: number; dropped: number }>

/**
 * Replays a fuzz run's corpus, shortest first, and minimizes it as it goes: `contributes` replays one case and says
 * whether it added a situation or a class of a range nothing before it had, and every case that did not is dropped
 * from the corpus. The loaded tapes are let go once they are replayed; what a fuzz run keeps of them is its seeds.
 */
const replayCorpus = <X, R>(
	corpus: Corpus,
	contributes: (values: Float64Array, index: number) => Effect.Effect<boolean, X, R>
): Effect.Effect<CorpusReplay, X, R> =>
	Effect.gen(function* () {
		const loaded = yield* corpus.load
		let dropped = 0
		for (const [index, values] of loaded.entries()) {
			if (!(yield* contributes(values, index))) {
				dropped += 1
				yield* corpus.drop(values, values.length)
			}
		}
		return { replayed: loaded.length, dropped }
	})

/**
 * Searches a property: kept cases first, then the floor stream (fixed by the suite's label) and the rotating stream
 * (fresh each run). Cases run in windows of `steerEvery`, up to `concurrency` at once; each window's results are taken
 * in case order, so concurrency changes how fast a search runs and never what it finds. A failing case, the lowest of
 * its window, is shrunk by editing its tape, property draws included, under the steering it was drawn under. Every
 * required situation must be reached by a generated case, and as many independent cases as the suite's reach margin
 * asks. The residual comes from the independent cases alone. A replay runs its one case instead.
 */
export const explore = <S, T, F extends string, E, R>(
	spec: Exploration<S, T, F>,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>
): Effect.Effect<Explored, SearchFailure, Run | Exclude<R, Scope.Scope>> =>
	Effect.gen(function* () {
		const run = yield* Run
		const floorTally = tallyOf("floor")
		const steered = tallyOf("steered")
		const independent = tallyOf("independent")
		const pool: Array<Recorder> = []
		const hang = Duration.format(Duration.fromInputUnsafe(spec.caseHang))
		const unsteered = underOf(spec.features, { kind: "unsteered" })
		let cases = 0
		let discards = 0
		const caseOf = (chooser: Chooser, under: Under<F>) =>
			runCase(
				spec.draw.generator,
				spec.draw.resolve,
				property,
				chooser,
				pool,
				under,
				spec.caseHang,
				keepNothing,
				notesOnly
			)
		const seedOf = (chooser: Chooser, under: Under<F>, sense: Sense) =>
			runCase(
				spec.draw.generator,
				spec.draw.resolve,
				property,
				chooser,
				pool,
				under,
				spec.caseHang,
				keepTape,
				sense
			)
		const candidateOf = (values: Float64Array, under: Under<F>) =>
			runCase(
				spec.draw.generator,
				spec.draw.resolve,
				property,
				forcedChooser(values, values.length),
				pool,
				under,
				spec.caseHang,
				keepTape,
				notesOnly
			)
		const reportOf = (
			caseRun: CaseRun<S, unknown>,
			cause: Cause.Cause<unknown>,
			draws: string
		): Reported => ({
			literal: spec.literal(caseRun.sketch),
			draws,
			drew: caseRun.drew,
			notes: caseRun.notes,
			cause
		})
		const misusedIn = (where: string) =>
			Effect.fail(
				CaseMisused.make({
					suite: spec.suite,
					message: `${spec.suite}: ${where} used its case after the case ended`
				})
			)
		const explored = (reach: ReadonlyArray<Reach>): Explored => ({
			kind: "explored",
			suite: spec.suite,
			cases,
			discards,
			residual: residualOf(independent.tally()),
			reach
		})

		const replayOne = (replayed: ReplayCase) =>
			Effect.gen(function* () {
				const undeclared = undeclaredIn(replayed.drawn, spec.features.required.length)
				if (Option.isSome(undeclared)) {
					return yield* ReplayStale.make({
						suite: spec.suite,
						message: `${spec.suite}: the token steers by requirement ${undeclared.value}, and the suite declares ${spec.features.required.length}; replay it from a fresh failure`
					})
				}
				const values = Float64Array.from(replayed.values)
				const caseRun = yield* caseOf(
					forcedChooser(values, values.length),
					underOf(spec.features, replayed.drawn)
				)
				const where = "the replayed case"
				return yield* judge<Effect.Effect<Explored, SearchFailure>>(caseRun, {
					passed: () =>
						ranExactly(caseRun, values.length)
							? Effect.sync(() => {
									cases += 1
									return explored([])
								})
							: Effect.fail(
									ReplayStale.make({
										suite: spec.suite,
										message: `${spec.suite}: ${where} passed, but not as its token says: ${drewInstead(caseRun, values.length)}; replay it from a fresh failure`
									})
								),
					discarded: () =>
						Effect.fail(
							ReplayStale.make({
								suite: spec.suite,
								message: `${spec.suite}: ${where} gave itself up, so it no longer runs; replay it from a fresh failure`
							})
						),
					misused: () => misusedIn(where),
					hung: (hung) =>
						Effect.fail(
							CaseHung.make({
								suite: spec.suite,
								replay: Option.some(replayCaseOf(replayed.drawn, hung.tape)),
								message: `${spec.suite}: ${where} ran past ${hang}: ${spec.literal(caseRun.sketch)}`
							})
						),
					failed: (failed) => {
						const again = Option.some(replayCaseOf(replayed.drawn, failed.tape))
						return Effect.fail(
							PropertyFalsified.make({
								suite: spec.suite,
								replay: again,
								message: falsifiedReport(
									run,
									spec.suite,
									where,
									reportOf(caseRun, failed.cause, drawsOf(caseRun, failed.tape)),
									"replayed as given, not shrunk",
									again
								)
							})
						)
					}
				})
			})

		const replay = Option.filter(run.replay, (requested) => requested.suite === spec.suite)
		if (Option.isSome(replay)) {
			return yield* replayOne(replay.value.replayed)
		}

		for (const kept of spec.kept) {
			const draws = valuesFromToken(kept.draws)
			const keptRun = yield* runCase(
				() => kept.sketch,
				spec.draw.resolve,
				property,
				forcedChooser(draws, draws.length),
				pool,
				unsteered,
				spec.caseHang,
				keepNothing,
				notesOnly
			)
			const where = `the kept case "${kept.note}"`
			yield* judge<Effect.Effect<void, SearchFailure>>(keptRun, {
				passed: () => {
					if (!ranExactly(keptRun, draws.length)) {
						return Effect.fail(
							KeptStale.make({
								suite: spec.suite,
								note: kept.note,
								message: `${spec.suite}: ${where} no longer runs as kept: ${drewInstead(keptRun, draws.length)}; replay it from a fresh failure and keep that`
							})
						)
					}
					const missing = Arr.filter(kept.reaches, (feature) => !keptRun.notes.has(feature))
					return Arr.isReadonlyArrayNonEmpty(missing)
						? Effect.fail(
								KeptUnreached.make({
									suite: spec.suite,
									note: kept.note,
									missing,
									message: `${spec.suite}: ${where} no longer reaches ${Arr.join(missing, ", ")}`
								})
							)
						: Effect.void
				},
				discarded: () =>
					Effect.fail(
						KeptStale.make({
							suite: spec.suite,
							note: kept.note,
							message: `${spec.suite}: ${where} gave itself up, so its property's precondition no longer holds for it; replay it from a fresh failure and keep that`
						})
					),
				misused: () => misusedIn(where),
				hung: () =>
					Effect.fail(
						CaseHung.make({
							suite: spec.suite,
							replay: Option.none(),
							message: `${spec.suite}: ${where} ran past ${hang}`
						})
					),
				failed: (failed) =>
					Effect.fail(
						PropertyFalsified.make({
							suite: spec.suite,
							replay: Option.none(),
							message: falsifiedReport(
								run,
								spec.suite,
								where,
								reportOf(keptRun, failed.cause, kept.draws),
								"kept cases are never shrunk",
								Option.none()
							)
						})
					)
			})
		}

		const floor = floorSeed(spec.suite)
		const rotating = rotatingSeed(run.seed, floor)
		const generated = () => [floorTally.tally(), steered.tally(), independent.tally()]
		const seeds = seedsOf()

		/** Judges one case of a stream: a pass counts in its phase's tally, a failure is shrunk under the steering the
		 * case was drawn under and reported with its replay token, and a hang is reported as drawn. */
		const settle = <K>(
			caseRun: CaseRun<S, K>,
			where: string,
			under: Under<F>,
			tally: TallyBuilder<GeneratedPhase>
		) =>
			judge<Effect.Effect<boolean, SearchFailure, Exclude<R, Scope.Scope>>>(caseRun, {
				passed: () =>
					Effect.sync(() => {
						cases += 1
						tally.add(caseRun.notes)
						return true
					}),
				discarded: () =>
					Effect.sync(() => {
						discards += 1
						return false
					}),
				misused: () => misusedIn(where),
				hung: (hung) => {
					const replayed = replayCaseOf(under.drawn, hung.tape)
					return Effect.fail(
						CaseHung.make({
							suite: spec.suite,
							replay: Option.some(replayed),
							message: `${spec.suite}: ${where} ran past ${hang}: counterexample ${spec.literal(caseRun.sketch)}, replay it alone: TEST_REPLAY='${replayTokenOf(spec.suite, replayed)}'`
						})
					)
				},
				failed: (failed) =>
					Effect.flatMap(
						shrinkAttempt(
							{ tape: failed.tape, failure: { run: caseRun, cause: failed.cause } },
							(values) =>
								Effect.map(candidateOf(values, under), (candidate) =>
									judge(candidate, candidateJudgment(candidate))
								),
							spec.shrink
						),
						(shrunk) => {
							const best = shrunk.best.failure.run
							const replayed = Option.some(replayCaseOf(under.drawn, shrunk.best.tape))
							return Effect.fail(
								PropertyFalsified.make({
									suite: spec.suite,
									replay: replayed,
									message: falsifiedReport(
										run,
										spec.suite,
										where,
										reportOf(best, shrunk.best.failure.cause, drawsOf(best, shrunk.best.tape)),
										`shrunk in ${shrunk.candidates} candidates${shrunk.cut ? ", cut short by its budget" : ""}`,
										replayed
									)
								})
							)
						}
					)
			})

		/** Keeps a passing case as a seed when it noted or perceived something no earlier case had. */
		const keepIfNew = (caseRun: CaseRun<S, Tape>) =>
			seeds.keep(caseRun.kept, caseRun.notes, caseRun.trace)

		/**
		 * One window of cases from the seeds kept so far, each a mutant of a seed, but one in `FRESH_EVERY` a fresh draw, so a
		 * steered phase whose seeds sit far from what is missing still finds it as often as plain draws would; `found` sees
		 * each case that found something new.
		 */
		const mutatedWindow = <X>(
			phase: string,
			stream: number,
			indices: ReadonlyArray<number>,
			sense: Sense,
			found: (caseRun: CaseRun<S, Tape>) => Effect.Effect<void, X>
		) =>
			Effect.gen(function* () {
				const under = steeredBy(spec.features, generated())
				const pick = seeds.picker(generated())
				const window = yield* Effect.forEach(
					indices,
					(index) => {
						const words = wordsOf(caseSeed(stream, index))
						const chooser = Option.match(
							between(words, 0, FRESH_EVERY - 1) === 0 ? Option.none() : pick(words),
							{
								onNone: () => randomChooser(words),
								onSome: ([seed, donor]) => {
									const mutant = mutate(seed, Option.some(donor), words)
									return prefixChooser(mutant.values, mutant.length, randomChooser(words))
								}
							}
						)
						return seedOf(chooser, under, sense)
					},
					{ concurrency: sense.concurrent ? spec.concurrency : 1 }
				)
				for (const [offset, caseRun] of window.entries()) {
					const where = `${phase} (seed ${hex(stream)}), case ${Arr.getUnsafe(indices, offset)}`
					if ((yield* settle(caseRun, where, under, steered)) && keepIfNew(caseRun)) {
						yield* found(caseRun)
					}
				}
			})

		const steering = spec.steering
		const fuzzing = Option.filter(run.fuzz, (fuzz) => fuzz.suite === spec.suite)
		const floorCases = Math.max(1, Math.ceil(spec.runs / 4))

		/** The floor stream, its cases run by `runOne` and each passing case handed to `passed`. */
		const floorStream = <K>(
			runOne: (
				chooser: Chooser,
				under: Under<F>
			) => Effect.Effect<CaseRun<S, K>, never, Exclude<R, Scope.Scope>>,
			passed: (caseRun: CaseRun<S, K>) => void
		) =>
			Effect.gen(function* () {
				for (let windowStart = 0; windowStart < floorCases; windowStart += spec.steerEvery) {
					const under = steeredBy(spec.features, generated())
					const indices = Arr.range(
						windowStart,
						Math.min(windowStart + spec.steerEvery, floorCases) - 1
					)
					const window = yield* Effect.forEach(
						indices,
						(index) => runOne(randomChooser(wordsOf(caseSeed(floor, index))), under),
						{ concurrency: spec.concurrency }
					)
					for (const [offset, caseRun] of window.entries()) {
						const where = `the floor stream (seed ${hex(floor)}), case ${windowStart + offset}`
						if (yield* settle(caseRun, where, under, floorTally)) {
							passed(caseRun)
						}
					}
				}
			})

		if (steering.kind === "mutate" || Option.isSome(fuzzing)) {
			yield* floorStream((chooser, under) => seedOf(chooser, under, notesOnly), keepIfNew)
		} else {
			yield* floorStream(caseOf, () => undefined)
		}

		const steerSeed = mix(rotating ^ STEER_SALT)
		if (Option.isSome(fuzzing)) {
			const fuzz = fuzzing.value
			const sense = steering.kind === "mutate" ? steering.sense : notesOnly
			const replayed = yield* replayCorpus(fuzz.corpus, (values, index) =>
				Effect.gen(function* () {
					const under = steeredBy(spec.features, generated())
					const caseRun = yield* seedOf(
						prefixChooser(
							values,
							values.length,
							randomChooser(wordsOf(caseSeed(steerSeed, -1 - index)))
						),
						under,
						sense
					)
					const passed = yield* settle(caseRun, `the corpus's case ${index}`, under, steered)
					return passed && keepIfNew(caseRun)
				})
			)
			const started = yield* liveMillis
			let reported = started
			let found = 0
			let fuzzed = 0
			const status = (now: number) =>
				liveLog(
					`fuzz: ${spec.suite}: elapsed: ${Math.round((now - started) / 1000)}s, execs: ${fuzzed} (${Math.round((fuzzed * 1000) / Math.max(1, now - started))}/sec), new interesting: ${found} (total: ${seeds.size()})`
				)
			yield* liveLog(
				`fuzz: ${spec.suite}: ${replayed.replayed} cases of the corpus replayed, ${replayed.dropped} of them dropped as adding nothing, ${seeds.size()} seeds, fuzzing ${describeBudget(fuzz.budget)}`
			)
			const save = (values: Float64Array) => fuzz.corpus.save(values, values.length)
			yield* Effect.gen(function* () {
				for (;;) {
					const now = yield* liveMillis
					if (spent(fuzz.budget, fuzzed, now - started)) {
						return yield* status(now)
					}
					if (now - reported >= STATUS_EVERY) {
						reported = now
						yield* status(now)
					}
					const indices = Arr.range(fuzzed, fuzzed + spec.steerEvery - 1)
					fuzzed += indices.length
					yield* mutatedWindow("the fuzz run", steerSeed, indices, sense, (caseRun) => {
						found += 1
						return Effect.andThen(
							save(caseRun.kept.values),
							liveLog(`fuzz: ${spec.suite}: new interesting case ${fuzzed}, ${seeds.size()} seeds`)
						)
					})
				}
			}).pipe(
				Effect.tapError((failure) =>
					failure._tag === "PropertyFalsified" || failure._tag === "CaseHung"
						? Option.match(failure.replay, {
								onNone: () => Effect.void,
								onSome: (failing) => save(Float64Array.from(failing.values))
							})
						: Effect.void
				)
			)
			return explored(
				reachOf(spec.features, floorTally.tally(), steered.tally(), independent.tally())
			)
		}

		if (steering.kind === "mutate") {
			for (
				let windowStart = 0;
				windowStart < steering.cases &&
				Arr.isReadonlyArrayNonEmpty(pendingOf(spec.features, generated()));
				windowStart += spec.steerEvery
			) {
				yield* mutatedWindow(
					"the steered phase",
					steerSeed,
					Arr.range(windowStart, Math.min(windowStart + spec.steerEvery, steering.cases) - 1),
					steering.sense,
					() => Effect.void
				)
			}
		}

		for (let windowStart = 0; windowStart < spec.runs; windowStart += spec.steerEvery) {
			const indices = Arr.range(windowStart, Math.min(windowStart + spec.steerEvery, spec.runs) - 1)
			const window = yield* Effect.forEach(
				indices,
				(index) => caseOf(randomChooser(wordsOf(caseSeed(rotating, index))), unsteered),
				{ concurrency: spec.concurrency }
			)
			for (const [offset, caseRun] of window.entries()) {
				yield* settle(
					caseRun,
					`the rotating stream (seed ${hex(rotating)}), case ${windowStart + offset}`,
					unsteered,
					independent
				)
			}
		}

		if (discards > cases) {
			return yield* CasesStalled.make({
				suite: spec.suite,
				message: `${spec.suite}: ${discards} cases gave themselves up and ${cases} ran; build values that meet the precondition instead of filtering for them`
			})
		}
		const missing = pendingOf(spec.features, generated())
		if (Arr.isReadonlyArrayNonEmpty(missing)) {
			const keys = keysAt(spec.features, missing)
			return yield* FeaturesUnreached.make({
				suite: spec.suite,
				missing: keys,
				message: `${spec.suite}: no generated case reached ${Arr.join(keys, ", ")} in ${floorTally.tally().cases} floor, ${steered.tally().cases} steered and ${independent.tally().cases} rotating cases; a kept case never counts toward a requirement, so draw it more often, steer toward it, or give the generator an arm that reaches it`
			})
		}
		const short = shortOf(spec.features, independent.tally())
		if (Arr.isReadonlyArrayNonEmpty(short)) {
			return yield* ReachBelowMargin.make({
				suite: spec.suite,
				margin: spec.features.reachMargin,
				short,
				message: `${spec.suite}: of ${independent.tally().cases} independent cases, fewer than the margin of ${spec.features.reachMargin} reached ${describeShort(short)}; a fresh seed misses a requirement so rarely reached, so draw it more often or give the generator an arm that reaches it`
			})
		}
		return explored(
			reachOf(spec.features, floorTally.tally(), steered.tally(), independent.tally())
		)
	})

/**
 * An exhaustive check: every case of a bounded generator, smallest first, under a hard limit. `literal` prints a case
 * as source, as an exploration's does.
 */
export type Exhaustion<A, F extends string> = Readonly<{
	suite: string
	generator: Gen<A>
	literal: (value: A) => string
	limit: number
	features: Features<F>
	caseHang: Duration.Input
}>

/** What a passing exhaustion checked: every case of its space. */
export type Exhausted = Readonly<{ kind: "exhausted"; suite: string; cases: number }>

/**
 * Checks a property on every case of a bounded generator, smallest first, so a failure needs no shrinking: the first
 * failing case is the smallest. The space is counted before any property runs and refused beyond its limit; draws the
 * property makes are enumerated too, so each case's successor depends on it and cases run one at a time, and a run
 * that would pass the limit stops before it. Each case steers by the requirements no earlier case reached, and every
 * requirement must be reached by as many cases of the space as the suite's reach margin asks. Passing is a proof
 * inside the box the generator draws.
 */
export const exhaust = <A, F extends string, E, R>(
	spec: Exhaustion<A, F>,
	property: (value: A, c: Case<F>) => Effect.Effect<void, E, R>
): Effect.Effect<Exhausted, SearchFailure, Run | Exclude<R, Scope.Scope>> =>
	Effect.gen(function* () {
		const run = yield* Run
		const refused = SpaceBeyondLimit.make({
			suite: spec.suite,
			limit: spec.limit,
			message: `${spec.suite}: the space holds more than ${spec.limit} cases; an exhaustive check refuses rather than samples`
		})
		if (count(spec.generator, spec.limit).kind === "beyond") {
			return yield* refused
		}
		const exhaustive = tallyOf("exhaustive")
		const pool: Array<Recorder> = []
		let branch: Option.Option<Branch> = Option.some(firstBranch)
		let cases = 0
		while (Option.isSome(branch)) {
			const caseRun = yield* runCase(
				spec.generator,
				(value: A) => value,
				property,
				prefixChooser(branch.value.values, branch.value.length, simplestChooser),
				pool,
				steeredBy(spec.features, [exhaustive.tally()]),
				spec.caseHang,
				keepTape,
				notesOnly
			)
			const where = `case ${cases} of the exhaustive space`
			yield* judge<Effect.Effect<void, SearchFailure>>(caseRun, {
				passed: () =>
					cases >= spec.limit
						? Effect.fail(refused)
						: Effect.sync(() => {
								cases += 1
								exhaustive.add(caseRun.notes)
							}),
				discarded: () => Effect.void,
				misused: () =>
					Effect.fail(
						CaseMisused.make({
							suite: spec.suite,
							message: `${spec.suite}: ${where} used its case after the case ended`
						})
					),
				hung: () =>
					Effect.fail(
						CaseHung.make({
							suite: spec.suite,
							replay: Option.none(),
							message: `${spec.suite}: ${where} ran past its hang limit: ${spec.literal(caseRun.sketch)}`
						})
					),
				failed: (failed) =>
					Effect.fail(
						PropertyFalsified.make({
							suite: spec.suite,
							replay: Option.none(),
							message: falsifiedReport(
								run,
								spec.suite,
								where,
								{
									literal: spec.literal(caseRun.sketch),
									draws: drawsOf(caseRun, failed.tape),
									drew: caseRun.drew,
									notes: caseRun.notes,
									cause: failed.cause
								},
								"the smallest failing case: enumeration runs smallest first",
								Option.none()
							)
						})
					)
			})
			branch = nextBranch(caseRun.kept)
		}
		const missing = pendingOf(spec.features, [exhaustive.tally()])
		if (Arr.isReadonlyArrayNonEmpty(missing)) {
			const keys = keysAt(spec.features, missing)
			return yield* FeaturesUnreached.make({
				suite: spec.suite,
				missing: keys,
				message: `${spec.suite}: no case of the space reached ${Arr.join(keys, ", ")}`
			})
		}
		const short = shortOf(spec.features, exhaustive.tally())
		if (Arr.isReadonlyArrayNonEmpty(short)) {
			return yield* ReachBelowMargin.make({
				suite: spec.suite,
				margin: spec.features.reachMargin,
				short,
				message: `${spec.suite}: of the space's ${cases} cases, fewer than the margin of ${spec.features.reachMargin} reached ${describeShort(short)}`
			})
		}
		return { kind: "exhausted", suite: spec.suite, cases }
	})
