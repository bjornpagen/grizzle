import { Array as Arr, Data, Effect, Option, String as Str } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { Actors } from "#test/support/schedules/actors.ts"
import {
	type ActionStep,
	allowed,
	type Choice,
	everyRelation,
	type ExploreEnv,
	exploreInterleavings,
	type Interleaving,
	type MoveRecord,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { describeStepOutcome } from "#test/support/schedules/match.ts"
import type {
	DirectAction,
	Schedule,
	Step,
	StepOutcome,
	Verdict
} from "#test/support/schedules/types.ts"
import type { LockWait } from "#test/support/substrate/barrier.ts"

import { regex } from "arkregex"

/** The schedule did not go as written. `trace` is the printable trace up to and including the failing step. */
class ScheduleFailed extends Data.TaggedError("ScheduleFailed")<{
	readonly schedule: string
	readonly step: number
	readonly reason: string
	readonly trace: string
	readonly report: string
}> {
	override get message(): string {
		return this.report
	}
}

const compact = (text: string): string => {
	const flat = Str.trim(Str.replace(regex("\\s+", "g"), " ")(text))
	return flat.length > 200 ? `${Str.slice(0, 199)(flat)}…` : flat
}

const describeAction = (action: DirectAction): string => {
	switch (action._tag) {
		case "Sql":
			return compact(action.sql)
		case "Begin":
			return "BEGIN ISOLATION LEVEL SERIALIZABLE"
		case "BeginBelow":
			return `BEGIN ISOLATION LEVEL ${Str.toUpperCase(action.level)} (planted, to be refused)`
		case "Commit":
			return "COMMIT"
		case "Rollback":
			return "ROLLBACK"
	}
}

type AnyStep = Step<string>

const describeStep = (step: AnyStep): string =>
	step._tag === "Perform" ? describeAction(step.action) : `check: ${compact(step.sql)}`

/**
 * One executed step, in order: finished with its outcome, observed waiting on a lock other sessions hold, a deadlock
 * victim before its wait was observed, or never finished because the run stopped.
 */
type TraceEntry = { readonly index: number; readonly session: string; readonly label: string } & (
	| { readonly _tag: "Finished"; readonly outcome: StepOutcome }
	| { readonly _tag: "Blocked"; readonly wait: LockWait; readonly blockedBy: ReadonlyArray<string> }
	| { readonly _tag: "Victim" }
	| { readonly _tag: "Unfinished" }
)

const formatEntry = (entry: TraceEntry): string => {
	const head = `#${entry.index + 1} ${entry.session}: ${entry.label}`
	switch (entry._tag) {
		case "Finished":
			return `${head} -> ${describeStepOutcome(entry.outcome)}`
		case "Blocked":
			return `${head} -> blocked on ${entry.wait.locktype} ${entry.wait.mode} by [${Arr.join(entry.blockedBy, ", ")}]`
		case "Victim":
			return `${head} -> a deadlock victim (40P01) before its wait was observed`
		case "Unfinished":
			return `${head} -> unfinished`
	}
}

const formatTrace = (schedule: string, entries: ReadonlyArray<TraceEntry>): string =>
	Arr.join(
		[`schedule: ${schedule}`, ...Arr.map(entries, (entry) => `  ${formatEntry(entry)}`)],
		"\n"
	)

/**
 * A schedule compiled for the driver: its sessions, its script, and for each step the run's move it is (a session
 * step's index among the moves) or the read it is (a Check's index among the reads).
 */
interface Compiled {
	readonly txns: ReadonlyArray<Txn>
	readonly choices: ReadonlyArray<Choice>
	readonly moveOf: ReadonlyMap<number, number>
	readonly readOf: ReadonlyMap<number, number>
}

const compile = (schedule: Schedule<string>): Compiled => {
	const direct = new Map<string, Array<ActionStep>>()
	const choices: Array<Choice> = []
	const moveOf = new Map<number, number>()
	const readOf = new Map<number, number>()
	let moves = 0
	let reads = 0
	for (const [index, step] of schedule.steps.entries()) {
		switch (step._tag) {
			case "Perform": {
				const steps = direct.get(step.session) ?? []
				direct.set(step.session, steps)
				steps.push({ label: describeStep(step), action: step.action, footprint: everyRelation })
				choices.push({ _tag: "Move", session: step.session })
				moveOf.set(index, moves++)
				break
			}
			case "Check":
				choices.push({ _tag: "Read", sql: step.sql })
				readOf.set(index, reads++)
				break
		}
	}
	return {
		txns: Arr.map([...direct], ([session, steps]): Txn => ({
			kind: "scripted",
			session,
			steps,
			after: undefined
		})),
		choices,
		moveOf,
		readOf
	}
}

/** What a run is judged against: the schedule, its compilation for the driver, and the run the driver recorded. */
interface Judged {
	readonly schedule: Schedule<string>
	readonly compiled: Compiled
	readonly run: Interleaving
}

/** What judging one step adds to the trace, and why the step did not go as written, or none. */
interface StepJudgment {
	readonly entries: ReadonlyArray<TraceEntry>
	readonly failure: string | undefined
}

/** Why the run never reached step `index`. */
const stoppedAt = (run: Interleaving, index: number): string =>
	run.ending._tag === "Stopped"
		? `the run stopped here: ${run.ending.why}`
		: `step #${index + 1} never ran`

const missed = (verdict: Verdict): string | undefined =>
	verdict._tag === "Misses" ? `${verdict.why}, got ${verdict.shown}` : undefined

const judgeCheck = (
	x: Judged,
	index: number,
	step: Extract<AnyStep, { readonly _tag: "Check" }>
): StepJudgment => {
	const at = x.compiled.readOf.get(index)
	const read = at === undefined ? undefined : x.run.reads[at]
	if (read === undefined) {
		return { entries: [], failure: stoppedAt(x.run, index) }
	}
	return {
		entries: [
			{
				index,
				session: "observer",
				label: describeStep(step),
				_tag: "Finished",
				outcome: read.outcome
			}
		],
		failure: missed(step.expect(read.outcome))
	}
}

/** What the run observed of a move before it finished: a wait on other sessions' lock, or a deadlock victim's. */
const observedEntries = (
	head: { readonly index: number; readonly session: string; readonly label: string },
	record: MoveRecord
): ReadonlyArray<TraceEntry> => {
	switch (record.observed._tag) {
		case "Waited":
			return [
				{ ...head, _tag: "Blocked", wait: record.observed.lock, blockedBy: record.observed.on }
			]
		case "Victim":
			return [{ ...head, _tag: "Victim" }]
		case "Ran":
			return []
	}
}

/**
 * A session step must complete without being observed waiting on a lock another session of the schedule holds, and its
 * outcome must meet its expectation.
 */
const judgeMove = (
	x: Judged,
	index: number,
	step: Extract<AnyStep, { readonly _tag: "Perform" }>
): StepJudgment => {
	const head = { index, session: step.session, label: describeStep(step) }
	const at = x.compiled.moveOf.get(index)
	const record = at === undefined ? undefined : x.run.moves[at]
	if (record === undefined) {
		return { entries: [], failure: stoppedAt(x.run, index) }
	}
	const observed = observedEntries(head, record)
	if (record.observed._tag !== "Ran") {
		return {
			entries: observed,
			failure: `${step.session} was to complete without waiting on a session of the schedule, but waited`
		}
	}
	if (record.result._tag === "Unfinished") {
		return { entries: [{ ...head, _tag: "Unfinished" }], failure: stoppedAt(x.run, index) }
	}
	const outcome = record.result.outcome
	return {
		entries: [{ ...head, _tag: "Finished", outcome }],
		failure:
			outcome._tag === "Interrupted"
				? "a schedule's step was interrupted"
				: missed(step.expect(outcome))
	}
}

/**
 * Judges the run against the schedule, step by step: the trace up to the first step that did not go as written, and
 * why it did not, or the whole trace.
 */
const judgeRun = (
	x: Judged
): {
	readonly entries: ReadonlyArray<TraceEntry>
	readonly failure: { step: number; reason: string } | undefined
} => {
	const entries: Array<TraceEntry> = []
	for (const [index, step] of x.schedule.steps.entries()) {
		const judged = step._tag === "Check" ? judgeCheck(x, index, step) : judgeMove(x, index, step)
		appendAll(entries, judged.entries)
		if (judged.failure !== undefined) {
			return { entries, failure: { step: index, reason: judged.failure } }
		}
	}
	return { entries, failure: undefined }
}

/**
 * Schedules of direct sessions, run by the one concurrency driver.
 *
 * A schedule is data: steps in order, each with what it must produce. runSchedule compiles it into a script for the
 * driver: each direct session becomes a scripted session of its actions, and the steps become the script's choices in
 * order, a step a move of its session and a Check a read on the observer. The driver records what the database did at
 * every step, and the run is then judged step by step, in schedule order: a session step must complete without being
 * observed waiting on another session's lock, and its result must meet its expectation; a Check's rows must meet
 * its. A step the database made impossible stops the run there, and the schedule fails at that step. There is no
 * second loop and no clock: the driver's lock-wait observation and deadlock rule are the only ones.
 *
 * Runs `schedule` on `actors` through the driver, or fails with ScheduleFailed at the first step whose result or
 * waiting differs from the schedule. The sessions' transactions stay open where the schedule leaves them, and end with
 * a later step or when the actors' scope closes.
 */
export const runSchedule = <D extends string>(
	env: ExploreEnv,
	schedule: Schedule<NoInfer<D>>,
	actors: Actors<D, never>
): Effect.Effect<void, ScheduleFailed | SqlError> =>
	Effect.gen(function* () {
		const failed = (step: number, reason: string, entries: ReadonlyArray<TraceEntry>) => {
			const trace = formatTrace(schedule.name, entries)
			return new ScheduleFailed({
				schedule: schedule.name,
				step: step + 1,
				reason,
				trace,
				report: `schedule "${schedule.name}" failed at step #${step + 1}: ${reason}\n${trace}`
			})
		}
		const compiled = compile(schedule)
		const recorded: { run: Option.Option<Interleaving> } = { run: Option.none() }
		yield* exploreInterleavings(
			env,
			actors,
			{
				name: schedule.name,
				txns: compiled.txns,
				reset: Effect.void,
				state: { _tag: "Unread" },
				model: (i) =>
					Effect.sync(() => {
						recorded.run = Option.some(i)
						return allowed
					}),
				maxInterleavings: 1
			},
			{ kind: "script", choices: compiled.choices }
		).pipe(
			Effect.catchTags({
				InterleavingFailed: (error) =>
					Effect.fail(failed(0, `the driver failed: ${error.message}`, [])),
				RunRefused: (error) => Effect.fail(failed(0, `the run was refused: ${error.message}`, [])),
				NoSerialOrder: (error) =>
					Effect.fail(failed(0, `the run was refused: ${error.message}`, [])),
				AfterCycle: (error) => Effect.fail(failed(0, `malformed schedule: ${error.message}`, []))
			})
		)
		if (Option.isNone(recorded.run)) {
			return yield* Effect.die(new Error(`the driver judged no run of ${schedule.name}`))
		}
		const judged = judgeRun({ schedule, compiled, run: recorded.run.value })
		if (judged.failure !== undefined) {
			return yield* failed(judged.failure.step, judged.failure.reason, judged.entries)
		}
	})
