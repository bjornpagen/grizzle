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
	judgedStep,
	type MoveRecord,
	type OpStep,
	type Txn
} from "#test/support/schedules/interleave.ts"

import {
	describeOutcome,
	describeStepOutcome,
	describeVerdict
} from "#test/support/schedules/match.ts"

import type {
	Blocker,
	DirectAction,
	Schedule,
	Step,
	StepOutcome,
	Trace,
	TraceEntry,
	Verdict,
	Wait
} from "#test/support/schedules/types.ts"

import { regex } from "arkregex"
/** The schedule did not go as written. `trace` is the printable trace up to and including the failing step. */
export class ScheduleFailed extends Data.TaggedError("ScheduleFailed")<{
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

type AnyStep = Step<string, string, string>

/**
 * The index of the Blocks step an Await at `index` joins: the latest earlier Blocks step on its session. The schedule
 * was validated first, so there is one.
 */
const blockedStepOf = (steps: ReadonlyArray<AnyStep>, index: number): number => {
	const step = steps[index]
	const session = step?._tag === "Await" ? Option.some(step.session) : Option.none()
	const at = Option.flatMap(session, (joined) =>
		Arr.findLastIndex(
			steps.slice(0, index),
			(earlier) =>
				(earlier._tag === "Perform" || earlier._tag === "Operate") &&
				earlier.session === joined &&
				earlier.wait._tag === "Blocks"
		)
	)
	return Option.getOrThrowWith(at, () => new Error(`step #${index + 1} joins no blocked step`))
}

const describeStep = (step: AnyStep, index: number, steps: ReadonlyArray<AnyStep>): string => {
	switch (step._tag) {
		case "Perform":
			return describeAction(step.action)
		case "Operate":
			return `op ${step.name}`
		case "Check":
			return `check: ${compact(step.sql)}`
		case "Await":
			return `await #${blockedStepOf(steps, index) + 1}`
	}
}

/**
 * Problems with a schedule's structure, found before any SQL runs: a step on a session whose blocked step is still
 * pending, an Await with nothing to join, a Blocks wait on the step's own session, a blocked step never joined.
 */
const scheduleProblems = (schedule: Schedule<string, string, string>): ReadonlyArray<string> => {
	const problems: Array<string> = []
	const pending = new Map<string, number>()
	const visit = (step: AnyStep, index: number): void => {
		const at = `step #${index + 1}`
		switch (step._tag) {
			case "Check":
				return
			case "Await":
				if (!pending.has(step.session)) {
					problems.push(`${at} awaits ${step.session}, which has no blocked step`)
				}
				pending.delete(step.session)
				return
			case "Perform":
			case "Operate": {
				const blocked = pending.get(step.session)
				if (blocked !== undefined) {
					problems.push(
						`${at} runs on ${step.session} while its step #${blocked + 1} is still blocked`
					)
				}
				if (
					step.wait._tag === "Blocks" &&
					step.wait.by._tag === "Session" &&
					step.wait.by.session === step.session
				) {
					problems.push(`${at} blocks on its own session`)
				}
				if (step.wait._tag === "Blocks") {
					pending.set(step.session, index)
				}
				return
			}
		}
	}
	for (const [index, step] of schedule.steps.entries()) {
		visit(step, index)
	}
	for (const [session, index] of pending) {
		problems.push(`step #${index + 1} on ${session} blocks and is never awaited`)
	}
	return problems
}

const formatEntry = (entry: TraceEntry): string => {
	const name = entry.id._tag === "Named" ? ` [${entry.id.id}]` : ""
	const head = `#${entry.index + 1}${name} ${entry.session}: ${entry.label}`
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

const formatTrace = (trace: Trace): string =>
	Arr.join(
		[
			`schedule: ${trace.schedule}`,
			...Arr.map(trace.entries, (entry) => `  ${formatEntry(entry)}`)
		],
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

const compile = (schedule: Schedule<string, string, string>): Compiled => {
	const direct = new Map<string, Array<ActionStep>>()
	const grizzle = new Map<string, Array<OpStep>>()
	const choices: Array<Choice> = []
	const moveOf = new Map<number, number>()
	const readOf = new Map<number, number>()
	let moves = 0
	let reads = 0
	for (const [index, step] of schedule.steps.entries()) {
		const label = describeStep(step, index, schedule.steps)
		switch (step._tag) {
			case "Perform": {
				const steps = direct.get(step.session) ?? []
				direct.set(step.session, steps)
				steps.push({ label, action: step.action, footprint: everyRelation })
				choices.push({ _tag: "Move", session: step.session })
				moveOf.set(index, moves++)
				break
			}
			case "Operate": {
				const steps = grizzle.get(step.session) ?? []
				grizzle.set(step.session, steps)
				steps.push(
					judgedStep(
						label,
						step.op.unpack((o) => Effect.map(o.run, o.expect)),
						everyRelation
					)
				)
				choices.push({ _tag: "Move", session: step.session })
				moveOf.set(index, moves++)
				break
			}
			case "Await":
				choices.push({ _tag: "Join", session: step.session })
				break
			case "Check":
				choices.push({ _tag: "Read", sql: step.sql })
				readOf.set(index, reads++)
				break
		}
	}
	const txns: Array<Txn> = [
		...Arr.map([...direct], ([session, steps]): Txn => ({
			kind: "scripted",
			session,
			steps,
			after: undefined
		})),
		...Arr.map([...grizzle], ([session, steps]): Txn => ({
			kind: "grizzle",
			session,
			steps,
			after: undefined
		}))
	]
	return { txns, choices, moveOf, readOf }
}

/**
 * Whether a step that was to block on `by` waited on it, as the run recorded it: observed waiting on a lock it holds
 * (any session of the schedule, with Any); a deadlock victim, whose cycle PostgreSQL broke by aborting it; or completed
 * while `by`'s step, observed waiting on this step's session, failed with 40P01 after this step was issued, PostgreSQL
 * having broken the cycle this step closed by aborting `by`'s step instead.
 */
const waitedOn = (
	record: MoveRecord,
	by: Blocker<string>,
	moves: ReadonlyArray<MoveRecord>
): boolean => {
	switch (record.observed._tag) {
		case "Waited":
			return by._tag === "Any" || record.observed.on.includes(by.session)
		case "Victim":
			return true
		case "Ran":
			return (
				by._tag === "Session" &&
				Arr.some(
					moves,
					(m) =>
						m.session === by.session &&
						m.issued < record.issued &&
						m.observed._tag === "Waited" &&
						m.observed.on.includes(record.session) &&
						m.result._tag === "Finished" &&
						m.result.at > record.issued &&
						m.result.outcome._tag === "PgError" &&
						m.result.outcome.fields.code === "40P01"
				)
			)
	}
}

/**
 * The verdict of a step's result: a direct step's outcome by its expectation, an operation's own verdict. A hand
 * schedule runs no world move, so no step of it is interrupted.
 */
const verdictOf = (step: AnyStep, outcome: StepOutcome): Verdict => {
	if (outcome._tag === "Interrupted") {
		return {
			_tag: "Misses",
			shown: describeStepOutcome(outcome),
			why: "a hand schedule's step was interrupted"
		}
	}
	switch (step._tag) {
		case "Perform":
			return outcome._tag === "Judged"
				? {
						_tag: "Misses",
						shown: describeVerdict(outcome.verdict),
						why: "a direct step was judged as an operation"
					}
				: step.expect(outcome)
		case "Operate":
			return outcome._tag === "Judged"
				? outcome.verdict
				: {
						_tag: "Misses",
						shown: describeOutcome(outcome),
						why: "an operation's result was not judged"
					}
		case "Await":
		case "Check":
			throw new Error(`step ${step._tag} has no move`)
	}
}

const describeWait = (wait: Wait<string>): string => {
	switch (wait._tag) {
		case "Complete":
			return "complete without waiting on a session of the schedule"
		case "May":
			return "complete"
		case "Blocks":
			return wait.by._tag === "Session"
				? `block on ${wait.by.session}`
				: "block on a session of the schedule"
	}
}

/** What a run is judged against: the schedule, its compilation for the driver, and the run the driver recorded. */
interface Judged {
	readonly schedule: Schedule<string, string, string>
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

/** The run's record of a session step; none when the run stopped before it. */
const moveAt = (x: Judged, index: number): MoveRecord | undefined => {
	const at = x.compiled.moveOf.get(index)
	return at === undefined ? undefined : x.run.moves[at]
}

/** The run's read of a Check; none when the run stopped before it. */
const readAt = (x: Judged, index: number) => {
	const at = x.compiled.readOf.get(index)
	return at === undefined ? undefined : x.run.reads[at]
}

const missed = (verdict: Verdict): string | undefined =>
	verdict._tag === "Misses" ? `${verdict.why}, got ${verdict.shown}` : undefined

const judgeCheck = (
	x: Judged,
	index: number,
	step: Extract<AnyStep, { readonly _tag: "Check" }>,
	label: string
): StepJudgment => {
	const read = readAt(x, index)
	if (read === undefined) {
		return { entries: [], failure: stoppedAt(x.run, index) }
	}
	return {
		entries: [
			{ index, id: step.id, session: "observer", label, _tag: "Finished", outcome: read.outcome }
		],
		failure: missed(step.expect(read.outcome))
	}
}

const judgeAwait = (
	x: Judged,
	index: number,
	step: Extract<AnyStep, { readonly _tag: "Await" }>,
	label: string
): StepJudgment => {
	const joinedAt = blockedStepOf(x.schedule.steps, index)
	const joined = x.schedule.steps[joinedAt]
	const record = moveAt(x, joinedAt)
	if (joined === undefined || record === undefined) {
		return { entries: [], failure: stoppedAt(x.run, index) }
	}
	const head = {
		index,
		id: step.id._tag === "Named" ? step.id : joined.id,
		session: step.session,
		label
	}
	if (record.result._tag === "Unfinished") {
		return { entries: [{ ...head, _tag: "Unfinished" }], failure: stoppedAt(x.run, index) }
	}
	return {
		entries: [{ ...head, _tag: "Finished", outcome: record.result.outcome }],
		failure: missed(verdictOf(joined, record.result.outcome))
	}
}

/** How a step's waiting meets its wait: as written, not, or blocked as written, its result judged at its Await. */
const waitJudgment = (
	step: Extract<AnyStep, { readonly _tag: "Perform" | "Operate" }>,
	record: MoveRecord,
	moves: ReadonlyArray<MoveRecord>
):
	| { readonly kind: "met" | "joined later" }
	| { readonly kind: "missed"; readonly why: string } => {
	const wait: Wait<string> = step.wait
	switch (wait._tag) {
		case "Complete":
			return record.observed._tag === "Ran"
				? { kind: "met" }
				: { kind: "missed", why: `${step.session} was to ${describeWait(wait)}, but waited` }
		case "May":
			return { kind: "met" }
		case "Blocks":
			return waitedOn(record, wait.by, moves)
				? { kind: "joined later" }
				: {
						kind: "missed",
						why: `${step.session} was to ${describeWait(wait)}, but ${record.result._tag === "Finished" ? `completed: ${describeStepOutcome(record.result.outcome)}` : "was not observed waiting on it"}`
					}
	}
}

const judgeMove = (
	x: Judged,
	index: number,
	step: Extract<AnyStep, { readonly _tag: "Perform" | "Operate" }>,
	label: string
): StepJudgment => {
	const head = { index, id: step.id, session: step.session, label }
	const record = moveAt(x, index)
	if (record === undefined) {
		return { entries: [], failure: stoppedAt(x.run, index) }
	}
	const observed: ReadonlyArray<TraceEntry> =
		record.observed._tag === "Waited"
			? [{ ...head, _tag: "Blocked", wait: record.observed.lock, blockedBy: record.observed.on }]
			: record.observed._tag === "Victim"
				? [{ ...head, _tag: "Victim" }]
				: []
	const waited = waitJudgment(step, record, x.run.moves)
	if (waited.kind !== "met") {
		return { entries: observed, failure: waited.kind === "missed" ? waited.why : undefined }
	}
	if (record.result._tag === "Unfinished") {
		return {
			entries: [...observed, { ...head, _tag: "Unfinished" }],
			failure: stoppedAt(x.run, index)
		}
	}
	return {
		entries: [...observed, { ...head, _tag: "Finished", outcome: record.result.outcome }],
		failure: missed(verdictOf(step, record.result.outcome))
	}
}

const judgeStep = (x: Judged, index: number, step: AnyStep): StepJudgment => {
	const label = describeStep(step, index, x.schedule.steps)
	switch (step._tag) {
		case "Check":
			return judgeCheck(x, index, step, label)
		case "Await":
			return judgeAwait(x, index, step, label)
		case "Perform":
		case "Operate":
			return judgeMove(x, index, step, label)
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
		const judged = judgeStep(x, index, step)
		appendAll(entries, judged.entries)
		if (judged.failure !== undefined) {
			return { entries, failure: { step: index, reason: judged.failure } }
		}
	}
	return { entries, failure: undefined }
}

/**
 * Hand schedules, run by the one concurrency driver.
 *
 * A schedule is data: steps in order, each with what it must produce and how it may wait. runSchedule
 * compiles it into a script for the driver: each direct session becomes a scripted session of its
 * actions, each grizzle session a session of its operations, which judge their own typed results, and the steps
 * become the script's choices in order: a step is a move of its session, an Await a join of its session's blocked
 * step, and a Check a read on the observer. The driver records what the database did at every step, and the run is
 * then judged step by step, in schedule order:
 * - a step's waiting against its wait: Complete never observed waiting on another session's lock, Blocks observed
 *   waiting on the named session (or any session of the schedule), May anything;
 * - a step's result against its expectation, at the step, or for a blocked step at the Await that joins it;
 * - a Check's rows against its expectation.
 * A step the database made impossible (a move of a session still blocked, a join of a step still waiting) stops the
 * run there, and the schedule fails at that step. There is no second loop and no clock: the driver's lock-wait
 * observation and deadlock rule are the only ones.
 *
 * Runs `schedule` on `actors` through the driver, returning its trace, or failing with ScheduleFailed at the first
 * step whose result or waiting differs from the schedule. Steps still in flight when the run stops are interrupted,
 * which cancels their statements, so the actors can run another schedule; their sessions' transactions stay open, and
 * end with a later step or when the actors' scope closes.
 */
export const runSchedule = <D extends string, G extends string>(
	env: ExploreEnv,
	schedule: Schedule<NoInfer<D>, NoInfer<G>, NoInfer<D | G>>,
	actors: Actors<D, G>
): Effect.Effect<Trace, ScheduleFailed | SqlError> =>
	Effect.gen(function* () {
		const failed = (step: number, reason: string, entries: ReadonlyArray<TraceEntry>) => {
			const trace = formatTrace({ schedule: schedule.name, entries })
			return new ScheduleFailed({
				schedule: schedule.name,
				step: step + 1,
				reason,
				trace,
				report: `schedule "${schedule.name}" failed at step #${step + 1}: ${reason}\n${trace}`
			})
		}
		const problems = scheduleProblems(schedule)
		if (problems.length > 0) {
			return yield* failed(0, `malformed schedule: ${Arr.join(problems, "; ")}`, [])
		}
		const compiled = compile(schedule)
		const recorded: { run: Interleaving | undefined } = { run: undefined }
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
						recorded.run = i
						return allowed
					}),
				maxInterleavings: 1
			},
			{ kind: "script", choices: compiled.choices }
		).pipe(
			Effect.catchTags({
				InterleavingFailed: (error) =>
					Effect.fail(failed(0, `the driver failed: ${error.message}`, [])),
				AfterCycle: (error) => Effect.fail(failed(0, `malformed schedule: ${error.message}`, []))
			})
		)
		const run = recorded.run
		if (run === undefined) {
			return yield* Effect.die(new Error(`the driver judged no run of ${schedule.name}`))
		}
		const judged = judgeRun({ schedule, compiled, run })
		if (judged.failure !== undefined) {
			return yield* failed(judged.failure.step, judged.failure.reason, judged.entries)
		}
		return { schedule: schedule.name, entries: judged.entries }
	})
