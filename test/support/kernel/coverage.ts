import { type Profiler, Session } from "node:inspector"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { defect } from "#compiler/plan/runtime.ts"

/**
 * V8's precise coverage of the process at function granularity, the counter every count of calls reads: its one session,
 * its restart and its take, each answered in the turn that asks it, and the readings of a take. What a count's window
 * holds is its caller's: one synchronous block in the process that runs a test (kernel/calls.ts), or a process of its own
 * for work that waits on I/O (kernel/count-child.ts); a test names the functions it counts by its CountedFunction.
 */

/**
 * A function whose calls a count reads: the module it is declared in, by its path from the repository's root, and its
 * name as V8 reports it, the name of the declaration or of the constant an arrow function is assigned to.
 */
export interface CountedFunction {
	readonly file: string
	readonly name: string
}

declare global {
	var grizzleCallCounts: Session | undefined
}

/** V8's precise coverage of the process, as one take of it holds it: each script's functions and their counts. */
export type Coverage = ReadonlyArray<Profiler.ScriptCoverage>

/**
 * What `post` hands its callback, read as the post returns: a session connected on the process's own thread answers
 * each post before it returns (node:inspector Session.connect), so every step of a count runs in the turn that asks
 * it. A reply that comes later is a defect of that premise, and the count would hold the turns between.
 */
const answered = <A>(
	method: string,
	post: (reply: (error: Error | null, value: A) => void) => void
): A => {
	const replies: Array<{ readonly error: Error | null; readonly value: A }> = []
	post((error, value) => {
		replies.push({ error, value })
	})
	const [reply] = replies
	if (reply === undefined) {
		return defect(`the inspector answered ${method} after its post returned`)
	}
	if (reply.error !== null) {
		return defect(`the inspector refused ${method}: ${reply.error.message}`)
	}
	return reply.value
}

/**
 * Counting from cold: precise coverage started again, which V8 does in full each time it is asked (Coverage::SelectMode):
 * it deoptimizes every function and clears every invocation count. A process may run the code under test hot before
 * its counting starts (a runner's worker is warm across properties, and an optimization of that code may still be in
 * flight when the session starts), and code optimized before counting began counts no call inlined into it, so each
 * count starts here, over code that runs or is optimized again under counting.
 */
export const restart = (session: Session): void =>
	answered<void>("Profiler.startPreciseCoverage", (reply) =>
		session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false }, (error) =>
			reply(error, undefined)
		)
	)

/** The counts since the last take, which taking resets. */
export const take = (session: Session): Coverage =>
	answered<Coverage>("Profiler.takePreciseCoverage", (reply) =>
		session.post("Profiler.takePreciseCoverage", (error, taken) => reply(error, taken.result))
	)

/**
 * The process's session counting every function's calls, V8's precise coverage at function granularity, started once
 * and never stopped: only that mode counts a call TurboFan inlined into its caller, which block coverage drops, and it
 * counts exactly only over code optimized after it started. Stopping it would end counting for the whole process, so
 * nothing does; the session lives as long as the process.
 */
export const counting = (): Session => {
	const running = globalThis.grizzleCallCounts
	if (running !== undefined) {
		return running
	}
	const session = new Session()
	session.connect()
	answered<void>("Profiler.enable", (reply) =>
		session.post("Profiler.enable", (error) => reply(error, undefined))
	)
	restart(session)
	globalThis.grizzleCallCounts = session
	return session
}

/** Each site's calls in a take of the counts (kernel/calls.ts callCounts). */
export const siteCounts = <K extends string>(
	scripts: Coverage,
	sites: Readonly<Record<K, CountedFunction>>
): Readonly<Record<K, number>> =>
	Rec.map(sites, (site) =>
		Arr.reduce(
			Arr.filter(scripts, (script) =>
				Str.endsWith(`/${site.file}`)(Arr.headNonEmpty(Str.split(script.url, "?")))
			),
			0,
			(n: number, script) =>
				Arr.reduce(
					Arr.filter(script.functions, (f) => f.functionName === site.name),
					n,
					(m: number, f) =>
						m + Arr.reduce(Arr.take(f.ranges, 1), 0, (c: number, range) => c + range.count)
				)
		)
	)

/** A function a count is kept under: its module, by its path from the packages' directory, its place in it and its name. */
const functionKey = (file: string, offset: number, name: string): string =>
	`${file}:${offset} ${name}`

/**
 * Every function's calls in a take of the counts, of the modules `kept` keeps, each under its module's path from the
 * packages' directory, its place in the module and its name, so two functions of one name stay apart.
 */
export const keptCounts = (
	scripts: Coverage,
	kept: (file: string) => boolean
): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>()
	for (const script of scripts) {
		const url = Arr.headNonEmpty(Str.split(script.url, "?"))
		const file = Option.match(Str.indexOf("/packages/")(url), {
			onNone: () => url,
			onSome: (at) => Str.slice(at + 1)(url)
		})
		if (!kept(file)) {
			continue
		}
		for (const f of script.functions) {
			for (const range of Arr.take(f.ranges, 1)) {
				const key = functionKey(file, range.startOffset, f.functionName)
				counts.set(key, (counts.get(key) ?? 0) + range.count)
			}
		}
	}
	return counts
}
