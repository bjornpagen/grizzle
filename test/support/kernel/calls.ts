import { Session } from "node:inspector/promises"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"

/**
 * A function whose calls a count reads: the module it is declared in, by its path from the repository's root, and its
 * name as V8 reports it, the name of the declaration or of the constant an arrow function is assigned to.
 */
export interface CallSite {
	readonly file: string
	readonly name: string
}

declare global {
	var grizzleCallCounts: Session | undefined
}

/**
 * The process's session counting every function's calls, V8's precise coverage at function granularity, started once
 * and never stopped: only that mode counts a call TurboFan inlined into its caller, which block coverage drops, and it
 * counts exactly when it starts before the code under test runs hot, since no optimized code or optimization in flight
 * then predates it. Stopping it would end counting for the whole process, so nothing does; the session lives as long
 * as the process.
 */
const counting: Effect.Effect<Session> = Effect.suspend(() => {
	const running = globalThis.grizzleCallCounts
	return running === undefined
		? Effect.gen(function* () {
				const session = new Session()
				session.connect()
				yield* Effect.promise(() => session.post("Profiler.enable"))
				yield* Effect.promise(() =>
					session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false })
				)
				globalThis.grizzleCallCounts = session
				return session
			})
		: Effect.succeed(running)
})

await Effect.runPromise(counting)

const take = Effect.flatMap(counting, (session) =>
	Effect.promise(() => session.post("Profiler.takePreciseCoverage").then((taken) => taken.result))
)

/**
 * How many times each site's functions were called while `effect` ran, with its value: work counted, never time, so a
 * guard over it never depends on the machine. The counts are V8's, process-wide, so the effect runs alone; taking them
 * resets them, so the counts are the effect's own. A site matches every function of its name in its module.
 */
export const callCounts = <A, E, R, K extends string>(
	effect: Effect.Effect<A, E, R>,
	sites: Readonly<Record<K, CallSite>>
): Effect.Effect<readonly [A, Readonly<Record<K, number>>], E, R> =>
	Effect.gen(function* () {
		yield* take
		const value = yield* effect
		const scripts = yield* take
		const counts = Rec.map(sites, (site) =>
			Arr.reduce(
				Arr.filter(scripts, (script) =>
					Str.endsWith(`/${site.file}`)(Arr.headNonEmpty(Str.split(script.url, "?")))
				),
				0,
				(n, script) =>
					Arr.reduce(
						Arr.filter(script.functions, (f) => f.functionName === site.name),
						n,
						(m, f) => m + Arr.reduce(Arr.take(f.ranges, 1), 0, (c, range) => c + range.count)
					)
			)
		)
		return [value, counts] as const
	})

/** A function a count is kept under: its module, by its path from the packages' directory, its place in it and its name. */
const functionKey = (file: string, offset: number, name: string): string =>
	`${file}:${offset} ${name}`

/**
 * How many times every function of the modules `kept` keeps was called while `effect` ran, with its value: callCounts'
 * counts, of every function rather than of named sites, each under its module's path from the packages' directory, its
 * place in the module and its name, so two functions of one name stay apart. A module is kept by that path.
 */
export const everyCallCount = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	kept: (file: string) => boolean
): Effect.Effect<readonly [A, ReadonlyMap<string, number>], E, R> =>
	Effect.gen(function* () {
		yield* take
		const value = yield* effect
		const scripts = yield* take
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
		return [value, counts] as const
	})
