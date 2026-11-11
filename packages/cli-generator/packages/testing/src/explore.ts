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
	type Coverage,
	keyOf,
	type Pending,
	type Phase,
	pendingAt,
	pendingOf,
	type Rate,
	ratesOf,
	type Reached,
	type Residual,
	residualOf,
	type SpaceCoverage,
	type SteeringPhase,
	situationsOf,
	type Tally,
	type TallyBuilder,
	tallyOf,
	unreachedOf
} from "#features.ts"
import type { Corpus, Fuzz, FuzzBudget } from "#fuzz.ts"
import type { Gen } from "#gen.ts"
import { abandon, liveMillis, liveSleep, liveSleepUntil, stopHung } from "#live.ts"
import { mutate } from "#mutate.ts"
import {
	between,
	caseSeed,
	floorSeed,
	fnv1a32,
	fuzzSeed,
	type LabelStream,
	rotatingSeed,
	type RunStream,
	steeredSeed,
	wordsOf
} from "#random.ts"
import { type Drawn, type Replay, ReplayCase, replayTokenOf } from "#replay.ts"
import { seedsOf } from "#seeds.ts"
import { notesOnly, type Sense } from "#sense.ts"
import { type Attempt, type ShrinkBudget, shrinkAttempt, type Shrunk } from "#shrink.ts"
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
 * The run every test process of one run shares. Global setup chooses it once, so every suite of a run shares one seed
 * and one failure names the whole run: rerunning with that seed reproduces it. A replay names the one suite whose
 * streams give way to one case, drawn under the steering its token records. A fuzz run names the one suite it fuzzes;
 * every other suite runs as under test.
 */
export type ProcessRun = Readonly<{
	seed: number
	source: SeedSource
	replay: Option.Option<Replay>
	fuzz: Option.Option<Fuzz>
}>

/**
 * When the test a search runs in fails on its own timeout: never, when its timeout is unbounded, or at `millis` on the
 * live clock, in milliseconds since the epoch. A search ends its work PRINT_MARGIN_MILLIS before its deadline, so it
 * reports what it found before its test fails as a bare timeout: a shrink the deadline cuts short reports the smallest
 * failing case it reached, and a search cut short before any case failed reports the case it had in flight.
 */
export type Deadline = Readonly<{ kind: "unbounded" }> | Readonly<{ kind: "at"; millis: number }>

/** The deadline of a search whose test's timeout is unbounded. */
export const noDeadline: Deadline = { kind: "unbounded" }

/**
 * How long before its test's deadline a search stops its work and reports: the time from the moment it is due to stop
 * to the moment its test's function has failed with the report, which then beats the test's own timeout.
 *
 * @limitKind measured
 * @owner the choice-stream testing library (explore)
 * @unit milliseconds
 * @scope every search under a bounded deadline (Run.deadline), in each test process alone
 * @evidence packages/testing/out/print-margin/ in superstarter's checkout of this library: busy-20261104T220121.jsonl,
 * loaded-20261104T220131.jsonl and suite-load-20261104T220131.jsonl, one row per cut search, its time from its cut to
 * its failure leaving @effect/vitest's logging; grizzle-write-literal-20261104T220220.json, four runs of
 * Formatter.format over 300 of grizzle's write-oracle sketches
 * @observed 2026-11-04 21:59 to 22:03 CST
 * @environment macOS (Darwin 27.0.0) on 10 cores, Node 26.13.0, Vitest 5.1.0, effect and @effect/vitest 4.1.2, the
 * library's pool of forks under its hardened flags; load average 27 to 44 from other sessions throughout
 * @workload 240 cut searches, four test files at once, two thirds of them while the library's whole suite ran at four
 * workers: a floor case fails, the shrink's next candidate never ends, and the deadline cuts it; reports of 1.6 KB (an
 * int) and 68 KB (300 records), each with a cause's stack and 50 drawn values; and grizzle's write-oracle literal, 30 KB,
 * the largest sketch the three repositories print
 * @result every search ended in its PropertyFalsified; print time 0 to 6 ms for 1.6 KB reports and 2 to 30 ms for 68 KB
 * ones, the slowest a process's first; grizzle's literal alone 0.3 to 0.4 ms median, 11 to 47 ms p99 and 29 to 87 ms
 * worst, each worst a run's first, cold; event-loop lag and garbage collection not measured apart from them
 * @decision the slowest report seen (30 ms) with the slowest literal seen (87 ms) is about 120 ms; 500 ms is four times
 * that, for timers late on a machine loaded four times over its cores
 * @revalidate a Node, Vitest or effect upgrade; a literal much slower than 87 ms; a property or finalizer that holds the
 * event loop near its deadline; any report lost to a bare timeout
 */
export const PRINT_MARGIN_MILLIS = 500

/** The run an exploration draws from, as the test it runs in sees it: the process's run, and its test's deadline. */
export class Run extends Context.Service<Run, ProcessRun & Readonly<{ deadline: Deadline }>>()(
	"@superstarter/testing/explore/Run"
) {}

/** The moment on the live clock a search must stop its work for its deadline: PRINT_MARGIN_MILLIS before it, and none
 * for an unbounded deadline. */
const cutOf = (deadline: Deadline): Option.Option<number> => {
	switch (deadline.kind) {
		case "unbounded":
			return Option.none()
		case "at":
			return Option.some(deadline.millis - PRINT_MARGIN_MILLIS)
	}
}

/** A case gave itself up: its precondition did not hold. It never counts as a pass or a failure. */
export class CaseDiscarded extends Schema.TaggedError<
	CaseDiscarded,
	{ readonly brand: unique symbol }
>()("CaseDiscarded", {}) {}

/** Whether an error is a case's discard: a case that left the space, never a failure. */
export const isCaseDiscarded = Schema.is(CaseDiscarded)

/**
 * What a property sees of the case it runs: it notes the situations it reached; steers, where steering is allowed, by
 * reading which of the suite's required situations no witness had reached when the case's window began (Pending);
 * draws more from the case's own tape; records on the tape what the system under test decided (and learns whether a
 * replay decided the same); and gives the case up when a precondition fails. A note, a draw or an observation made
 * after the case ended is a misuse, reported as one. Steering is offered to the witnesses (the floor stream, the
 * steered phase, an exhaustion's cases) and to a fuzz run, so a property may aim their draws at what is pending.
 * `steering` is none wherever a case must be a plain draw of its generator: the rotating stream, whose cases alone
 * estimate the residual, and a kept case, which must run as it ran. A replay steers exactly as the case it replays
 * did: its token records what the case was drawn under.
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
 * - `coverage` is what the search must reach, and the steered phase that reaches what the floor stream misses: the
 *   floor's and the steered phase's cases alone decide it, so it passes on every run seed or on none;
 * - `runs` is the rotating stream's cases, the run's fresh sample, and the floor stream runs a quarter as many: the
 *   suite's budget for finding failures under test, never a dial for coverage, where a longer search is a fuzz run
 *   with a budget of its own;
 * - `concurrency` is how many cases run at once; cases that share state the property does not isolate run one at a
 *   time;
 * - `steerEvery` is how many cases pass between the snapshots `Case.steering` reads, a constant of the suite, so the
 *   same seed draws the same cases however many run at once;
 * - `caseHang` is how long one case may run before it is stopped and reported.
 */
export type Exploration<S, T, F extends string> = Readonly<{
	suite: string
	draw: Draw<S, T>
	literal: (sketch: S) => string
	coverage: Coverage<F>
	kept: ReadonlyArray<Kept<S, F>>
	runs: number
	shrink: ShrinkBudget
	concurrency: number
	steerEvery: number
	caseHang: Duration.Input
}>

/** Where a falsified case was drawn: a phase of its search, a kept case, or the one case a replay token names. */
export type CasePhase = Phase | "kept" | "replayed"

const CasePhase = Schema.Literals([
	"kept",
	"floor",
	"steered",
	"exhaustive",
	"independent",
	"fuzzed",
	"replayed"
])

/**
 * Whether a falsified case's phase is a witness, one the suite's label fixes: a failure found there is found on every
 * run seed, so a verdict that requires a failure (a mutant's kill) counts it, and no other.
 */
export const isWitness = (phase: CasePhase): boolean => {
	switch (phase) {
		case "floor":
		case "steered":
		case "exhaustive":
			return true
		case "kept":
		case "independent":
		case "fuzzed":
		case "replayed":
			return false
	}
}

/** How far a falsified case was shrunk, as its shrink ended (ShrinkEnd), or `unshrunk`: a kept case, a replayed case
 * and an exhaustion's first failure are reported as they ran. */
const Shrinking = Schema.Literals(["minimal", "budget", "deadline", "unshrunk"])

/**
 * A property failed on a case; the report names the run, the stream, the shrunk case and how to replay it. `phase` is
 * where the case was drawn and `shrink` how far it was shrunk, as data, so a caller judges a failure by where it came
 * from and whether it is the smallest its shrink could reach, never by its prose. `replay` is the case a replay token
 * names, none for a kept case, which replays by value.
 */
export class PropertyFalsified extends Schema.TaggedError<
	PropertyFalsified,
	{ readonly brand: unique symbol }
>()("PropertyFalsified", {
	suite: Schema.String,
	phase: CasePhase,
	shrink: Shrinking,
	replay: Schema.Option(ReplayCase),
	message: Schema.String
}) {}

/** A case ran past its hang limit; it is reported as drawn, unshrunk, and the suite stops. */
export class CaseHung extends Schema.TaggedError<CaseHung, { readonly brand: unique symbol }>()(
	"CaseHung",
	{ suite: Schema.String, replay: Schema.Option(ReplayCase), message: Schema.String }
) {}

/**
 * The deadline of the test a search runs in arrived before any case failed: the search stopped PRINT_MARGIN_MILLIS
 * before it, and reports where it stopped and the case it had in flight, so its test fails with this report rather than
 * as a bare timeout. `replay` is the case in flight, none for a kept case, which replays by value.
 */
export class DeadlineReached extends Schema.TaggedError<
	DeadlineReached,
	{ readonly brand: unique symbol }
>()("DeadlineReached", {
	suite: Schema.String,
	replay: Schema.Option(ReplayCase),
	message: Schema.String
}) {}

/** More of the floor stream's cases gave themselves up than ran: the generator rarely meets the property's
 * precondition, and should build values that meet it rather than filter for them. The floor is the label-fixed set of
 * plain draws, so a stall is the same on every run seed. */
export class CasesStalled extends Schema.TaggedError<
	CasesStalled,
	{ readonly brand: unique symbol }
>()("CasesStalled", { suite: Schema.String, message: Schema.String }) {}

/** The witnesses a coverage verdict was judged on: an exploration's floor and steered cases, or an exhaustion's every
 * case. */
const Witnessed = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("streams"), floor: Schema.Int, steered: Schema.Int }),
	Schema.Struct({ kind: Schema.Literal("space"), cases: Schema.Int })
])

export type Witnessed = typeof Witnessed.Type

/**
 * No witness reached a required situation: the generator draws it too rarely for the floor and the steered budget, or
 * no longer draws it at all. Every witness is fixed by the suite's label, so every run seed fails alike. A kept case
 * and a rotating case never count, so a situation only they reach needs a generator arm, a property that aims its
 * draws at what is pending, or a larger steered budget.
 */
export class FeaturesUnreached extends Schema.TaggedError<
	FeaturesUnreached,
	{ readonly brand: unique symbol }
>()("FeaturesUnreached", {
	suite: Schema.String,
	missing: Schema.Array(Schema.String),
	witnessed: Witnessed,
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
	| DeadlineReached
	| CasesStalled
	| FeaturesUnreached
	| KeptUnreached
	| KeptStale
	| ReplayStale
	| CaseMisused
	| SpaceBeyondLimit

/**
 * What a case did. A case is cut when its search's deadline arrived before it ended. A failed, hung or cut case carries
 * its tape, the property's own draws included, to shrink or replay.
 */
type Outcome =
	| Readonly<{ kind: "passed" }>
	| Readonly<{ kind: "discarded" }>
	| Readonly<{ kind: "failed"; cause: Cause.Cause<unknown>; tape: Tape }>
	| Readonly<{ kind: "hung"; tape: Tape }>
	| Readonly<{ kind: "cut"; tape: Tape }>

/**
 * A case's outcome as its search judges it: what it did, or misused, when a case that passed or gave itself up was used
 * after it ended. A failure, a hang or a cut is judged as itself, whatever was done with the case after.
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
		case "cut":
			return judgment.cut(judged)
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
		case "cut":
			return caseRun.outcome
	}
}

/** A failing case's run and its cause, what a shrink carries from candidate to candidate. */
type Failure<S> = Readonly<{ run: CaseRun<S, unknown>; cause: Cause.Cause<unknown> }>

/** A shrink candidate's judgment: it is a smaller case of the failure only when its property failed; a pass, a discard,
 * a hang or a misuse is not the failure being shrunk, and a cut candidate ends the shrink. */
const candidateJudgment = <S>(candidate: CaseRun<S, Tape>): Judgment<Attempt<Failure<S>>> => {
	const holds = (): Attempt<Failure<S>> => ({ kind: "holds", tape: candidate.kept })
	return {
		passed: holds,
		discarded: holds,
		hung: holds,
		misused: holds,
		cut: () => ({ kind: "cut" }),
		failed: (failed) => ({
			kind: "fails",
			tape: candidate.kept,
			failure: { run: candidate, cause: failed.cause }
		})
	}
}

/** What a case is drawn under, as its replay token records it, and the steering its property sees of that. */
type Under<F extends string> = Readonly<{ drawn: Drawn; steering: Option.Option<Pending<F>> }>

const underOf = <F extends string>(situations: ReadonlyArray<Reached<F>>, how: Drawn): Under<F> => {
	switch (how.kind) {
		case "unsteered":
			return { drawn: how, steering: Option.none() }
		case "steered":
			return { drawn: how, steering: Option.some(pendingAt(situations, how.pending)) }
	}
}

/** Cases drawn under the requirements no case of these steering tallies reached. */
const steeredBy = <F extends string>(
	situations: ReadonlyArray<Reached<F>>,
	steering: ReadonlyArray<Tally<SteeringPhase>>
): Under<F> => underOf(situations, { kind: "steered", pending: pendingOf(situations, steering) })

/** How a case's property ended, before its recording is read. */
type Settled =
	| Readonly<{ kind: "passed"; trace: Uint8Array }>
	| Readonly<{ kind: "discarded" }>
	| Readonly<{ kind: "failed"; cause: Cause.Cause<unknown> }>
	| Readonly<{ kind: "hung" }>
	| Readonly<{ kind: "cut" }>

/** A case's outcome: discarded whenever its recording gave up, however its property ended, otherwise as its property
 * settled, a failed, hung or cut case with its tape. */
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
		case "cut":
			return { kind: "cut", tape: recorded.tape() }
	}
}

/** Keeps nothing of a case's recording: a search reads only a failing case's tape, which its outcome carries. */
const keepNothing = (): void => undefined

/** Keeps a case's whole tape: an enumeration steps from it, and a shrink compares it. */
const keepTape = (recorded: Recording): Tape => recorded.tape()

/**
 * Runs one case on a recorder from the pool: generates its sketch from the chooser, resolves it, and runs the property
 * in its own scope and fiber, raced against the hang guard and the search's deadline, so a case's finalizers always
 * run, a hung case's included, for as long as HUNG_CLEANUP_GRACE allows (live.ts). A case the deadline cuts is stopped
 * without waiting on its cleanup, which runs on while the search reports, and a case begun once the search is due to
 * stop is cut before its property runs. The property's own draws continue the same tape, so they replay and shrink with
 * the case, and it steers as `under` says. The tape is copied out only for a failed, hung or cut case and for what
 * `keep` asks; the recorder goes back to the pool when the case ends, so a use of the case after that is marked a
 * misuse and never reaches the recorder, which another case may be drawing on.
 */
const runCase = <S, T, F extends string, E, R, K>(
	generator: Gen<S>,
	resolve: (sketch: S) => T,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>,
	chooser: Chooser,
	pool: Array<Recorder>,
	under: Under<F>,
	caseHang: Duration.Input,
	deadline: Deadline,
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
					return Option.exists(Exit.findErrorOption(exit), isCaseDiscarded)
						? { kind: "discarded" }
						: { kind: "failed", cause: exit.cause }
				})
			)
		return Effect.gen(function* () {
			const cut = cutOf(deadline)
			const now = yield* liveMillis
			if (Option.exists(cut, (moment) => now >= moment)) {
				return finish({ kind: "cut" })
			}
			const running = yield* Effect.forkDetach(settled)
			const guards: ReadonlyArray<Effect.Effect<Settled>> = [
				Effect.map(Fiber.await(running), (exit): Settled =>
					Exit.isSuccess(exit) ? exit.value : { kind: "failed", cause: exit.cause }
				),
				Effect.as(liveSleep(caseHang), { kind: "hung" } as const),
				...Option.match(cut, {
					onNone: () => [],
					onSome: (moment) => [Effect.as(liveSleepUntil(moment), { kind: "cut" } as const)]
				})
			]
			const ended = yield* Effect.raceAllFirst(guards).pipe(
				Effect.onInterrupt(() => stopHung(running))
			)
			switch (ended.kind) {
				case "hung":
					yield* stopHung(running)
					break
				case "cut":
					yield* abandon(running)
					break
				case "passed":
				case "discarded":
				case "failed":
					break
			}
			return finish(ended)
		})
	})

const hex = (seed: number) => `0x${Str.padStart(8, "0")((seed >>> 0).toString(16))}`

/** The line a search's failure report opens with: the run's seed, which reproduces it, and where it was drawn. */
const seedLine = (run: Context.Service.Shape<typeof Run>, suite: string, where: string) =>
	`TEST_SEED=${run.seed}${run.source === "fresh" ? " (drawn by this run)" : ""}: ${suite}, ${where}`

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
			seedLine(run, suite, where),
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

/** How a shrink went, as a failure report prints it. */
const shrinkingOf = (shrunk: Shrunk<unknown>): string => {
	switch (shrunk.ended) {
		case "minimal":
			return `shrunk in ${shrunk.candidates} candidates`
		case "budget":
			return `shrunk in ${shrunk.candidates} candidates, cut short by its budget`
		case "deadline":
			return `shrunk in ${shrunk.candidates} candidates, cut short by its test's deadline: the smallest failing case it reached, ${PRINT_MARGIN_MILLIS} ms before the deadline; give the test a longer timeout to shrink it further`
	}
}

/**
 * The failure of a search its test's deadline cut short before any case failed: where it stopped, the case in flight,
 * and how to replay that case alone, when it has a token.
 */
const deadlineReachedIn = (
	run: Context.Service.Shape<typeof Run>,
	suite: string,
	where: string,
	inFlight: string,
	replay: Option.Option<ReplayCase>
) =>
	Effect.fail(
		DeadlineReached.make({
			suite,
			replay,
			message: Arr.join(
				[
					seedLine(run, suite, where),
					`its test's deadline cut the search short here, before any case failed: it stopped ${PRINT_MARGIN_MILLIS} ms before the deadline to report`,
					`the case in flight: ${inFlight}`,
					...Option.match(replay, {
						onNone: () => [],
						onSome: (replayed) => [
							`replay it alone: TEST_REPLAY='${replayTokenOf(suite, replayed)}'`
						]
					}),
					"give the test a longer timeout, or its search fewer cases"
				],
				"\n"
			)
		})
	)

/** How long a case may run, as a failure report prints it. */
const hangOf = (caseHang: Duration.Input): string =>
	Duration.format(Duration.fromInputUnsafe(caseHang))

/** The failure of a case its property used after the case ended. */
const misusedIn = (suite: string, where: string) =>
	Effect.fail(
		CaseMisused.make({
			suite,
			message: `${suite}: ${where} used its case after the case ended`
		})
	)

/** What a failure report says of a case's run, its cause and its draws. */
const reportedOf = <S>(
	literal: (sketch: S) => string,
	caseRun: CaseRun<S, unknown>,
	cause: Cause.Cause<unknown>,
	draws: string
): Reported => ({
	literal: literal(caseRun.sketch),
	draws,
	drew: caseRun.drew,
	notes: caseRun.notes,
	cause
})

/** What the replay of one case needs of its search: how its cases are drawn and printed, and what it requires. */
type Replaying<S, T, F extends string> = Readonly<{
	suite: string
	generator: Gen<S>
	resolve: (sketch: S) => T
	literal: (sketch: S) => string
	situations: ReadonlyArray<Reached<F>>
	caseHang: Duration.Input
}>

/**
 * Runs the one case a replay token names, under the steering the token records, in place of every stream: a failure
 * is reported as given, unshrunk, with its token again; a pass that ran exactly its draws is `passed`; a case that no
 * longer runs as its token says, or steers by a requirement the suite no longer declares, is ReplayStale.
 */
const replayOne = <S, T, F extends string, E, R, A>(
	search: Replaying<S, T, F>,
	run: Context.Service.Shape<typeof Run>,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>,
	replayed: ReplayCase,
	passed: () => A
): Effect.Effect<A, SearchFailure, Exclude<R, Scope.Scope>> =>
	Effect.gen(function* () {
		const undeclared = undeclaredIn(replayed.drawn, search.situations.length)
		if (Option.isSome(undeclared)) {
			return yield* ReplayStale.make({
				suite: search.suite,
				message: `${search.suite}: the token steers by requirement ${undeclared.value}, and the suite declares ${search.situations.length}; replay it from a fresh failure`
			})
		}
		const values = Float64Array.from(replayed.values)
		const caseRun = yield* runCase(
			search.generator,
			search.resolve,
			property,
			forcedChooser(values, values.length),
			[],
			underOf(search.situations, replayed.drawn),
			search.caseHang,
			run.deadline,
			keepNothing,
			notesOnly
		)
		const where = "the replayed case"
		return yield* judge<Effect.Effect<A, SearchFailure>>(caseRun, {
			passed: () =>
				ranExactly(caseRun, values.length)
					? Effect.sync(passed)
					: Effect.fail(
							ReplayStale.make({
								suite: search.suite,
								message: `${search.suite}: ${where} passed, but not as its token says: ${drewInstead(caseRun, values.length)}; replay it from a fresh failure`
							})
						),
			discarded: () =>
				Effect.fail(
					ReplayStale.make({
						suite: search.suite,
						message: `${search.suite}: ${where} gave itself up, so it no longer runs; replay it from a fresh failure`
					})
				),
			misused: () => misusedIn(search.suite, where),
			hung: (hung) =>
				Effect.fail(
					CaseHung.make({
						suite: search.suite,
						replay: Option.some(replayCaseOf(replayed.drawn, hung.tape)),
						message: `${search.suite}: ${where} ran past ${hangOf(search.caseHang)}: ${search.literal(caseRun.sketch)}`
					})
				),
			cut: (cut) =>
				deadlineReachedIn(
					run,
					search.suite,
					where,
					search.literal(caseRun.sketch),
					Option.some(replayCaseOf(replayed.drawn, cut.tape))
				),
			failed: (failed) => {
				const again = Option.some(replayCaseOf(replayed.drawn, failed.tape))
				return Effect.fail(
					PropertyFalsified.make({
						suite: search.suite,
						phase: "replayed",
						shrink: "unshrunk",
						replay: again,
						message: falsifiedReport(
							run,
							search.suite,
							where,
							reportedOf(search.literal, caseRun, failed.cause, drawsOf(caseRun, failed.tape)),
							"replayed as given, not shrunk",
							again
						)
					})
				)
			}
		})
	})

/**
 * What a passing exploration found: its cases, its discards, how many cases its steered phase ran, the residual
 * estimate of its independent cases, and how many of them reached each feature its coverage rates (features.ts
 * rating). A replay's has its one case: it runs no stream.
 */
export type Explored = Readonly<{
	kind: "explored"
	suite: string
	cases: number
	discards: number
	steered: number
	residual: Residual
	rates: ReadonlyArray<Rate>
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
 * A search of mutants grown from kept seeds: the steered phase, a witness on the stream the floor's seed fixes, or a
 * fuzz run, on a stream the run's seed draws. The variant ties the stream's kind to the tally its cases fill, so a
 * witness phase is never drawn from the run's seed.
 */
type Mutated =
	| Readonly<{ phase: "steered"; stream: LabelStream; tally: TallyBuilder<"steered"> }>
	| Readonly<{ phase: "fuzzed"; stream: RunStream; tally: TallyBuilder<"fuzzed"> }>

/** Where a mutated case came from, as a failure report names it. */
const mutatedLabel = (mutated: Mutated): string => {
	switch (mutated.phase) {
		case "steered":
			return "the steered phase"
		case "fuzzed":
			return "the fuzz run"
	}
}

/** What a fuzz run perceives: the steered phase's sense, or the notes alone for a search that requires nothing. */
const fuzzSenseOf = <F extends string>(coverage: Coverage<F>): Sense => {
	switch (coverage.kind) {
		case "none":
			return notesOnly
		case "required":
			return coverage.steered.sense
	}
}

/**
 * A window's cases in the order its search settles them: case order, but every case its deadline cut after the rest,
 * so a case that failed before the deadline arrived is reported, shrunk as far as the deadline allows, rather than lost
 * behind a lower case still in flight.
 */
const settlingOrder = <S, K>(
	window: ReadonlyArray<CaseRun<S, K>>
): ReadonlyArray<readonly [number, CaseRun<S, K>]> => {
	const entries = Arr.fromIterable(window.entries())
	const wasCut = ([, caseRun]: readonly [number, CaseRun<S, K>]) => caseRun.outcome.kind === "cut"
	return [...Arr.filter(entries, (entry) => !wasCut(entry)), ...Arr.filter(entries, wasCut)]
}

/**
 * Searches a property: kept cases first; then the witnesses, the floor stream and, for a search that requires
 * situations, the steered phase grown from it, both fixed by the suite's label; then the rotating stream, fresh each
 * run. Cases run in windows of `steerEvery`, up to `concurrency` at once; each window's results are taken in case
 * order, so concurrency changes how fast a search runs and never what it finds. A failing case, the lowest of its
 * window, is shrunk by editing its tape, property draws included, under the steering it was drawn under. The run's
 * deadline bounds every phase and the shrink (Deadline), and a case it cuts is settled after the rest of its window
 * (settlingOrder). The stall
 * verdict is judged on the floor stream, and the coverage verdict on the witnesses alone, before the rotating stream
 * runs: neither moves with the run's seed, and a coverage failure spends no sample. The residual comes from the
 * rotating stream's independent cases alone. A replay runs its one case instead; a fuzz run searches its run-seeded
 * stream after the floor, in place of the rest.
 */
export const explore = <S, T, F extends string, E, R>(
	spec: Exploration<S, T, F>,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>
): Effect.Effect<Explored, SearchFailure, Run | Exclude<R, Scope.Scope>> =>
	Effect.gen(function* () {
		const run = yield* Run
		const situations = situationsOf(spec.coverage)
		const replay = Option.filter(run.replay, (requested) => requested.suite === spec.suite)
		if (Option.isSome(replay)) {
			return yield* replayOne(
				{
					suite: spec.suite,
					generator: spec.draw.generator,
					resolve: spec.draw.resolve,
					literal: spec.literal,
					situations,
					caseHang: spec.caseHang
				},
				run,
				property,
				replay.value.replayed,
				(): Explored => ({
					kind: "explored",
					suite: spec.suite,
					cases: 1,
					discards: 0,
					steered: 0,
					residual: residualOf(tallyOf("independent").tally()),
					rates: ratesOf(spec.coverage, tallyOf("independent").tally())
				})
			)
		}

		const floorTally = tallyOf("floor")
		const steeredTally = tallyOf("steered")
		const independentTally = tallyOf("independent")
		const fuzzedTally = tallyOf("fuzzed")
		const pool: Array<Recorder> = []
		const hang = hangOf(spec.caseHang)
		const unsteered = underOf(situations, { kind: "unsteered" })
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
				run.deadline,
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
				run.deadline,
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
				run.deadline,
				keepTape,
				notesOnly
			)
		const explored = (): Explored => ({
			kind: "explored",
			suite: spec.suite,
			cases,
			discards,
			steered: steeredTally.tally().cases,
			residual: residualOf(independentTally.tally()),
			rates: ratesOf(spec.coverage, independentTally.tally())
		})

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
				run.deadline,
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
				misused: () => misusedIn(spec.suite, where),
				hung: () =>
					Effect.fail(
						CaseHung.make({
							suite: spec.suite,
							replay: Option.none(),
							message: `${spec.suite}: ${where} ran past ${hang}`
						})
					),
				cut: () =>
					deadlineReachedIn(run, spec.suite, where, spec.literal(kept.sketch), Option.none()),
				failed: (failed) =>
					Effect.fail(
						PropertyFalsified.make({
							suite: spec.suite,
							phase: "kept",
							shrink: "unshrunk",
							replay: Option.none(),
							message: falsifiedReport(
								run,
								spec.suite,
								where,
								reportedOf(spec.literal, keptRun, failed.cause, kept.draws),
								"kept cases are never shrunk",
								Option.none()
							)
						})
					)
			})
		}

		const floor = floorSeed(spec.suite)
		const seeds = seedsOf()

		/** Judges one case of a phase: a pass counts in its phase's tally and a discard is its phase's, a failure is
		 * shrunk under the steering the case was drawn under, as far as the deadline allows, and reported with its phase
		 * and its replay token, and a hang or a cut is reported as drawn. */
		const settle = <K>(
			caseRun: CaseRun<S, K>,
			where: string,
			under: Under<F>,
			tally: TallyBuilder<Phase>
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
						tally.discard()
						return false
					}),
				misused: () => misusedIn(spec.suite, where),
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
				cut: (cut) =>
					deadlineReachedIn(
						run,
						spec.suite,
						where,
						spec.literal(caseRun.sketch),
						Option.some(replayCaseOf(under.drawn, cut.tape))
					),
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
									phase: tally.phase,
									shrink: shrunk.ended,
									replay: replayed,
									message: falsifiedReport(
										run,
										spec.suite,
										where,
										reportedOf(
											spec.literal,
											best,
											shrunk.best.failure.cause,
											drawsOf(best, shrunk.best.tape)
										),
										shrinkingOf(shrunk),
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
		 * One window of mutated cases from the seeds kept so far, each a mutant of a seed, but one in `FRESH_EVERY` a fresh
		 * draw, so a phase whose seeds sit far from what is missing still finds it as often as plain draws would; each
		 * steers by, and picks its seed by, the floor's tally and its own phase's; `found` sees each case that found
		 * something new.
		 */
		const mutatedWindow = <X>(
			mutated: Mutated,
			indices: ReadonlyArray<number>,
			sense: Sense,
			found: (caseRun: CaseRun<S, Tape>) => Effect.Effect<void, X>
		) =>
			Effect.gen(function* () {
				const steering = [floorTally.tally(), mutated.tally.tally()]
				const under = steeredBy(situations, steering)
				const pick = seeds.picker(steering)
				const window = yield* Effect.forEach(
					indices,
					(index) => {
						const words = wordsOf(caseSeed(mutated.stream, index))
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
				for (const [offset, caseRun] of settlingOrder(window)) {
					const where = `${mutatedLabel(mutated)} (seed ${hex(mutated.stream)}), case ${Arr.getUnsafe(indices, offset)}`
					if ((yield* settle(caseRun, where, under, mutated.tally)) && keepIfNew(caseRun)) {
						yield* found(caseRun)
					}
				}
			})

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
					const under = steeredBy(situations, [floorTally.tally()])
					const indices = Arr.range(
						windowStart,
						Math.min(windowStart + spec.steerEvery, floorCases) - 1
					)
					const window = yield* Effect.forEach(
						indices,
						(index) => runOne(randomChooser(wordsOf(caseSeed(floor, index))), under),
						{ concurrency: spec.concurrency }
					)
					for (const [offset, caseRun] of settlingOrder(window)) {
						const where = `the floor stream (seed ${hex(floor)}), case ${windowStart + offset}`
						if (yield* settle(caseRun, where, under, floorTally)) {
							passed(caseRun)
						}
					}
				}
			})

		if (spec.coverage.kind === "required" || Option.isSome(fuzzing)) {
			yield* floorStream((chooser, under) => seedOf(chooser, under, notesOnly), keepIfNew)
		} else {
			yield* floorStream(caseOf, () => undefined)
		}

		const floored = floorTally.tally()
		if (floored.discards > floored.cases) {
			return yield* CasesStalled.make({
				suite: spec.suite,
				message: `${spec.suite}: ${floored.discards} of the floor stream's cases gave themselves up and ${floored.cases} ran; build values that meet the precondition instead of filtering for them`
			})
		}

		if (Option.isSome(fuzzing)) {
			const fuzz = fuzzing.value
			const fuzzed: Mutated = {
				phase: "fuzzed",
				stream: fuzzSeed(rotatingSeed(run.seed, floor)),
				tally: fuzzedTally
			}
			const sense = fuzzSenseOf(spec.coverage)
			const replayed = yield* replayCorpus(fuzz.corpus, (values, index) =>
				Effect.gen(function* () {
					const under = steeredBy(situations, [floorTally.tally(), fuzzedTally.tally()])
					const caseRun = yield* seedOf(
						prefixChooser(
							values,
							values.length,
							randomChooser(wordsOf(caseSeed(fuzzed.stream, -1 - index)))
						),
						under,
						sense
					)
					const passed = yield* settle(caseRun, `the corpus's case ${index}`, under, fuzzedTally)
					return passed && keepIfNew(caseRun)
				})
			)
			const started = yield* liveMillis
			let reported = started
			let found = 0
			let fuzzedCases = 0
			const status = (now: number) =>
				liveLog(
					`fuzz: ${spec.suite}: elapsed: ${Math.round((now - started) / 1000)}s, execs: ${fuzzedCases} (${Math.round((fuzzedCases * 1000) / Math.max(1, now - started))}/sec), new interesting: ${found} (total: ${seeds.size()})`
				)
			yield* liveLog(
				`fuzz: ${spec.suite}: ${replayed.replayed} cases of the corpus replayed, ${replayed.dropped} of them dropped as adding nothing, ${seeds.size()} seeds, fuzzing ${describeBudget(fuzz.budget)}`
			)
			const save = (values: Float64Array) => fuzz.corpus.save(values, values.length)
			yield* Effect.gen(function* () {
				for (;;) {
					const now = yield* liveMillis
					if (spent(fuzz.budget, fuzzedCases, now - started)) {
						return yield* status(now)
					}
					if (now - reported >= STATUS_EVERY) {
						reported = now
						yield* status(now)
					}
					const indices = Arr.range(fuzzedCases, fuzzedCases + spec.steerEvery - 1)
					fuzzedCases += indices.length
					yield* mutatedWindow(fuzzed, indices, sense, (caseRun) => {
						found += 1
						return Effect.andThen(
							save(caseRun.kept.values),
							liveLog(
								`fuzz: ${spec.suite}: new interesting case ${fuzzedCases}, ${seeds.size()} seeds`
							)
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
			return explored()
		}

		switch (spec.coverage.kind) {
			case "none":
				break
			case "required": {
				const { situations: requiredSituations, steered } = spec.coverage
				const steering: Mutated = {
					phase: "steered",
					stream: steeredSeed(floor),
					tally: steeredTally
				}
				const witnessed = () => [floorTally.tally(), steeredTally.tally()]
				for (
					let windowStart = 0;
					windowStart < steered.cases &&
					Arr.isReadonlyArrayNonEmpty(unreachedOf(requiredSituations, witnessed()));
					windowStart += spec.steerEvery
				) {
					yield* mutatedWindow(
						steering,
						Arr.range(windowStart, Math.min(windowStart + spec.steerEvery, steered.cases) - 1),
						steered.sense,
						() => Effect.void
					)
				}
				const missing = unreachedOf(requiredSituations, witnessed())
				if (Arr.isReadonlyArrayNonEmpty(missing)) {
					const floorCount = floorTally.tally().cases
					const steeredCount = steeredTally.tally().cases
					return yield* FeaturesUnreached.make({
						suite: spec.suite,
						missing,
						witnessed: { kind: "streams", floor: floorCount, steered: steeredCount },
						message: `${spec.suite}: no case of its ${floorCount} floor cases or ${steeredCount} steered cases reached ${Arr.join(missing, ", ")}; both streams are fixed by the suite's label, so every run seed fails alike. A kept case and a rotating case never count: give the generator an arm that reaches it, aim the property's draws at what is pending (Case.steering), or give the steered phase more cases`
					})
				}
				break
			}
		}

		const rotating = rotatingSeed(run.seed, floor)
		for (let windowStart = 0; windowStart < spec.runs; windowStart += spec.steerEvery) {
			const indices = Arr.range(windowStart, Math.min(windowStart + spec.steerEvery, spec.runs) - 1)
			const window = yield* Effect.forEach(
				indices,
				(index) => caseOf(randomChooser(wordsOf(caseSeed(rotating, index))), unsteered),
				{ concurrency: spec.concurrency }
			)
			for (const [offset, caseRun] of settlingOrder(window)) {
				yield* settle(
					caseRun,
					`the rotating stream (seed ${hex(rotating)}), case ${windowStart + offset}`,
					unsteered,
					independentTally
				)
			}
		}
		return explored()
	})

/**
 * An exhaustive check: every case of a bounded generator, smallest first, under a hard limit. `literal` prints a case
 * as source, as an exploration's does; `coverage` is what the space must reach, judged on every case of it.
 */
export type Exhaustion<A, F extends string> = Readonly<{
	suite: string
	generator: Gen<A>
	literal: (value: A) => string
	limit: number
	coverage: SpaceCoverage<F>
	caseHang: Duration.Input
}>

/** What a passing exhaustion checked: every case of its space. A replay's has its one case. */
export type Exhausted = Readonly<{ kind: "exhausted"; suite: string; cases: number }>

/**
 * Checks a property on every case of a bounded generator, smallest first, so a failure needs no shrinking: the first
 * failing case is the smallest, and its replay token runs it alone. The space is counted before any property runs and
 * refused beyond its limit; draws the property makes are enumerated too, so each case's successor depends on it and
 * cases run one at a time, and a run that would pass the limit stops before it. Each case steers by the requirements
 * no earlier case reached. Every case of the space is a witness, fixed by the generator alone, so every requirement
 * must be reached by one of them, and the verdict is the same on every run seed. Passing is a proof inside the box the
 * generator draws.
 */
export const exhaust = <A, F extends string, E, R>(
	spec: Exhaustion<A, F>,
	property: (value: A, c: Case<F>) => Effect.Effect<void, E, R>
): Effect.Effect<Exhausted, SearchFailure, Run | Exclude<R, Scope.Scope>> =>
	Effect.gen(function* () {
		const run = yield* Run
		const situations = situationsOf(spec.coverage)
		const replay = Option.filter(run.replay, (requested) => requested.suite === spec.suite)
		if (Option.isSome(replay)) {
			return yield* replayOne(
				{
					suite: spec.suite,
					generator: spec.generator,
					resolve: (value: A) => value,
					literal: spec.literal,
					situations,
					caseHang: spec.caseHang
				},
				run,
				property,
				replay.value.replayed,
				(): Exhausted => ({ kind: "exhausted", suite: spec.suite, cases: 1 })
			)
		}
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
		const hang = hangOf(spec.caseHang)
		let branch: Option.Option<Branch> = Option.some(firstBranch)
		let cases = 0
		while (Option.isSome(branch)) {
			const under = steeredBy(situations, [exhaustive.tally()])
			const caseRun = yield* runCase(
				spec.generator,
				(value: A) => value,
				property,
				prefixChooser(branch.value.values, branch.value.length, simplestChooser),
				pool,
				under,
				spec.caseHang,
				run.deadline,
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
				discarded: () => Effect.sync(() => exhaustive.discard()),
				misused: () => misusedIn(spec.suite, where),
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
				cut: (cut) =>
					deadlineReachedIn(
						run,
						spec.suite,
						where,
						spec.literal(caseRun.sketch),
						Option.some(replayCaseOf(under.drawn, cut.tape))
					),
				failed: (failed) => {
					const replayed = Option.some(replayCaseOf(under.drawn, failed.tape))
					return Effect.fail(
						PropertyFalsified.make({
							suite: spec.suite,
							phase: "exhaustive",
							shrink: "unshrunk",
							replay: replayed,
							message: falsifiedReport(
								run,
								spec.suite,
								where,
								reportedOf(spec.literal, caseRun, failed.cause, drawsOf(caseRun, failed.tape)),
								"the smallest failing case: enumeration runs smallest first",
								replayed
							)
						})
					)
				}
			})
			branch = nextBranch(caseRun.kept)
		}
		switch (spec.coverage.kind) {
			case "none":
				return { kind: "exhausted", suite: spec.suite, cases }
			case "required": {
				const missing = unreachedOf(spec.coverage.situations, [exhaustive.tally()])
				if (Arr.isReadonlyArrayNonEmpty(missing)) {
					return yield* FeaturesUnreached.make({
						suite: spec.suite,
						missing,
						witnessed: { kind: "space", cases },
						message: `${spec.suite}: no case of the space's ${cases} cases reached ${Arr.join(missing, ", ")}`
					})
				}
				return { kind: "exhausted", suite: spec.suite, cases }
			}
		}
	})
