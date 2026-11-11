import { Session } from "node:inspector/promises"
import { Array as Arr, Effect, Option, type Scope, String as Str } from "effect"

/** How many classes a trace distinguishes: its entries lie between zero, nothing reported, and this. */
export const TRACE_CLASSES = 9

/**
 * What a steered search perceives of the code under test while a case runs, beyond the situations the property
 * notes: the case's trace. A sense numbers each range of code it meets densely, in the order it first meets them, and a
 * trace holds at each range's number the class of the case's count there, between 1 and `TRACE_CLASSES`. Zero is the
 * default, a range the case reported nothing of, never something perceived. A trace is as long as its sense's table
 * of ranges was when the case ended. Each class of a range a case perceives first in its search keeps the case as a
 * seed for further mutation. A sense only steers; it never decides a verdict and never counts toward a required
 * situation. `concurrent` says whether cases may be perceived at once: a sense that reads process-wide counters runs
 * its cases one at a time.
 */
export type Sense = Readonly<{
	perceive: <A, E, R>(
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<readonly [value: A, trace: Uint8Array], E, R>
	concurrent: boolean
}>

/** Steering by the property's notes alone: every trace is empty. */
export const notesOnly: Sense = {
	perceive: (effect) => Effect.map(effect, (value) => [value, new Uint8Array(0)] as const),
	concurrent: true
}

/**
 * The class of a block's execution count: its bucket, as AFL buckets edge counts, plus one. A loop that runs once more
 * is not new, and a block counted zero, a branch never taken, is a class of its own.
 */
const classOf = (count: number): number =>
	count <= 3
		? count + 1
		: count <= 7
			? 5
			: count <= 15
				? 6
				: count <= 31
					? 7
					: count <= 127
						? 8
						: TRACE_CLASSES

type Range = Readonly<{ startOffset: number; endOffset: number; count: number }>

type ScriptCoverage = Readonly<{
	url: string
	functions: ReadonlyArray<Readonly<{ ranges: ReadonlyArray<Range> }>>
}>

declare global {
	var superstarterTestingCoverage: Session | undefined
}

/** A session counting V8's precise block coverage for the whole process. */
const countingSession = Effect.promise(() => {
	const session = new Session()
	session.connect()
	return session
		.post("Profiler.enable")
		.then(() => session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true }))
		.then(() => session)
})

/**
 * Starts V8's precise block coverage for the rest of this process, as a guided file's setup does before the file loads
 * the code under test: V8 counts the blocks only of code it compiles after coverage starts. Every `v8Coverage` sense
 * in the process then reads this session's counters and never stops them, since stopping them ends coverage for the
 * whole process; the session lives as long as the process. Starting it again does nothing.
 */
export const startProcessCoverage: Effect.Effect<void> = Effect.suspend(() =>
	globalThis.superstarterTestingCoverage === undefined
		? Effect.map(countingSession, (session) => {
				globalThis.superstarterTestingCoverage = session
			})
		: Effect.void
)

/**
 * The session a sense reads coverage through: the process's, when its setup started one, which the sense leaves
 * running, since stopping or ending any session that enabled the profiler stops precise coverage for the whole process;
 * otherwise its own, started with the scope and stopped when it closes.
 */
const coverageSession: Effect.Effect<Session, never, Scope.Scope> = Effect.suspend(() =>
	Option.match(Option.fromNullishOr(globalThis.superstarterTestingCoverage), {
		onSome: (session) => Effect.succeed(session),
		onNone: () =>
			Effect.acquireRelease(countingSession, (session) =>
				Effect.promise(() =>
					session.post("Profiler.stopPreciseCoverage").then(() => session.disconnect())
				)
			)
	})
)

/**
 * Steering by V8's block coverage of the files `covers` accepts, by their URL without its query: a case's trace holds
 * the class of each range V8 reports there. V8 reports a block only where its count differs from the block around it,
 * a branch never taken as a range counted zero, so the ranges and their counts are which blocks ran. The sense numbers
 * the ranges by file, start and end for as long as it lives. Its precise coverage counts for the whole process, so its
 * cases run one at a time, and a guided suite runs in its own Vitest project with coverage reporting off, which reads
 * the same counters. V8 counts the blocks only of code it compiles after coverage starts, so a guided suite's setup
 * starts the process's coverage (`startProcessCoverage`) before the code under test first runs, and the sense reads it
 * without ever stopping it; anywhere else the sense starts coverage with its scope and stops it when the scope closes.
 * Taking the counts resets them, so each case reads only its own. A range two copies of one file both report holds
 * the larger of their classes.
 */
export const v8Coverage = (
	covers: (url: string) => boolean
): Effect.Effect<Sense, never, Scope.Scope> =>
	Effect.gen(function* () {
		const session = yield* coverageSession
		const table = new Map<string, Map<number, Map<number, number>>>()
		let ranges = 0
		const idOf = (byStart: Map<number, Map<number, number>>, range: Range): number => {
			const byEnd = byStart.get(range.startOffset) ?? new Map<number, number>()
			byStart.set(range.startOffset, byEnd)
			const known = byEnd.get(range.endOffset)
			if (known !== undefined) {
				return known
			}
			byEnd.set(range.endOffset, ranges)
			ranges += 1
			return ranges - 1
		}
		const take = Effect.promise((): Promise<ReadonlyArray<ScriptCoverage>> =>
			session.post("Profiler.takePreciseCoverage").then((taken) => taken.result)
		)
		const traceOf = (scripts: ReadonlyArray<ScriptCoverage>): Uint8Array => {
			const ids: Array<number> = []
			const classes: Array<number> = []
			for (const script of scripts) {
				const file = Arr.headNonEmpty(Str.split(script.url, "?"))
				if (!covers(file)) {
					continue
				}
				const byStart = table.get(file) ?? new Map<number, Map<number, number>>()
				table.set(file, byStart)
				for (const covered of script.functions) {
					for (const range of covered.ranges) {
						ids.push(idOf(byStart, range))
						classes.push(classOf(range.count))
					}
				}
			}
			const trace = new Uint8Array(ranges)
			Arr.forEach(ids, (id, at) => {
				trace[id] = Math.max(trace[id] ?? 0, classes[at] ?? 0)
			})
			return trace
		}
		const sense: Sense = {
			perceive: (effect) =>
				Effect.gen(function* () {
					yield* take
					const value = yield* effect
					const taken = yield* take
					return [value, traceOf(taken)] as const
				}),
			concurrent: false
		}
		return sense
	})
