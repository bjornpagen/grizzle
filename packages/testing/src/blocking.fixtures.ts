import { regex } from "arkregex"
import {
	Array as Arr,
	Console,
	Duration,
	Effect,
	Exit,
	Formatter,
	Option,
	String as Str
} from "effect"
import { exhaust, noDeadline, Run } from "#explore.ts"
import { noCoverage } from "#features.ts"
import { int } from "#gen.ts"
import { liveMillis } from "#live.ts"

/**
 * What a planted property does on its cases from its threshold up, below which it returns at once: hold the main thread
 * forever, in a loop or in a regular expression that backtracks without end; return at once; hold the thread for a
 * pause, past its hang limit and short of the watchdog's grace; or sleep, yielding, past its hang limit.
 */
export const BODIES = ["loop", "backtrack", "returns", "pauses", "sleeps"] as const

export type Body = (typeof BODIES)[number]

/** Whether a body holds the main thread without ever yielding: a runaway, which only the watchdog ends. */
export const runsAway = (body: Body): boolean => {
	switch (body) {
		case "loop":
		case "backtrack":
			return true
		case "returns":
		case "pauses":
		case "sleeps":
			return false
	}
}

/**
 * A planted search, as its program takes it: the body, the least value it acts on, the case's hang limit, how long a
 * pause holds the thread, and the search's deadline, in milliseconds after the search began, or none.
 */
export type Planted = Readonly<{
	body: Body
	threshold: number
	hangMillis: number
	pauseMillis: number
	deadlineMillis: Option.Option<number>
}>

/** The values a planted search enumerates: 0 to 9, in that order, so its first case at its threshold is the threshold. */
export const values = int(0, 9)

/** The suite of a planted search. */
export const suiteOf = (planted: Planted): string =>
	`a planted ${planted.body} from ${planted.threshold}`

/** A regular expression that backtracks without end on a run of a's that ends in another letter. */
const BACKTRACKS = regex("^(a+)+$")

/** The subject BACKTRACKS backtracks on: 2^40 ways to split its a's, none of which matches. */
const BACKTRACKED = `${Str.repeat(40)("a")}!`

/**
 * Holds the main thread as `body` says: a loop that never ends, a match that never ends, or a wait that blocks the
 * thread for `pauseMillis`.
 */
const hold = (body: "loop" | "backtrack" | "pauses", pauseMillis: number): void => {
	const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
	switch (body) {
		case "loop":
			while (Atomics.load(cell, 0) === 0) {
				Atomics.add(cell, 0, 0)
			}
			return
		case "backtrack":
			Atomics.store(cell, 0, BACKTRACKS.test(BACKTRACKED) ? 1 : 0)
			return
		case "pauses":
			Atomics.wait(cell, 0, 0, pauseMillis)
	}
}

/** What the planted property does on a case of `value`. */
const property =
	(planted: Planted) =>
	(value: number): Effect.Effect<void> => {
		if (value < planted.threshold) {
			return Effect.void
		}
		switch (planted.body) {
			case "returns":
				return Effect.void
			case "sleeps":
				return Effect.sleep(Duration.millis(planted.hangMillis * 4))
			case "loop":
			case "backtrack":
			case "pauses": {
				const body = planted.body
				return Effect.sync(() => hold(body, planted.pauseMillis))
			}
		}
	}

/**
 * The program this module is when run: it prints the moment its search begins, exhausts the planted search under the
 * given run seed, and prints how the search ended. A runaway ends the process instead, by its watchdog, which prints its
 * report.
 */
const searchedAsProgram = (planted: Planted, seed: number) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const began = yield* liveMillis
			yield* Console.log(`began: ${began}`)
			const exit = yield* Effect.exit(
				exhaust(
					{
						suite: suiteOf(planted),
						oracle: {
							kind: "specification",
							name: "a property planted to hold its process's main thread"
						},
						box: "every value from 0 to 9",
						generator: values,
						literal: Formatter.format,
						coverage: noCoverage,
						caseHang: Duration.millis(planted.hangMillis)
					},
					property(planted)
				).pipe(
					Effect.provideService(
						Run,
						Run.of({
							seed,
							source: "environment",
							replay: Option.none(),
							fuzz: Option.none(),
							deadline: Option.match(planted.deadlineMillis, {
								onNone: () => noDeadline,
								onSome: (millis) => ({ kind: "at", millis: began + millis })
							})
						})
					)
				)
			)
			yield* Console.log(
				`ended: ${
					Exit.isSuccess(exit)
						? exit.value.kind
						: Option.getOrElse(
								Option.map(Exit.findErrorOption(exit), (failure) => failure._tag),
								() => "died"
							)
				}`
			)
		})
	)

/** A whole number written in decimal, or none. */
const wholeOf = (text: string | undefined): Option.Option<number> =>
	Option.filter(
		Option.fromUndefinedOr(text),
		(written) => written !== "" && Number.isSafeInteger(Number(written))
	).pipe(Option.map(Number))

/** The planted search and the seed a command line names, read strictly: `<body> <threshold> <hang> <pause> <deadline|none> <seed>`. */
const plantedOf = (args: ReadonlyArray<string>): Option.Option<readonly [Planted, number]> => {
	const [bodyText, threshold, hang, pause, deadline, seed] = args
	const body = Arr.findFirst(BODIES, (known) => known === bodyText)
	const deadlineMillis =
		deadline === "none"
			? Option.some(Option.none<number>())
			: Option.map(wholeOf(deadline), Option.some)
	return Option.all([
		body,
		wholeOf(threshold),
		wholeOf(hang),
		wholeOf(pause),
		deadlineMillis,
		wholeOf(seed)
	]).pipe(
		Option.map(([drawnBody, drawnThreshold, hangMillis, pauseMillis, drawnDeadline, drawnSeed]) => [
			{
				body: drawnBody,
				threshold: drawnThreshold,
				hangMillis,
				pauseMillis,
				deadlineMillis: drawnDeadline
			},
			drawnSeed
		])
	)
}

if (import.meta.main) {
	await Option.match(plantedOf(process.argv.slice(2)), {
		onNone: () =>
			Effect.runPromise(
				Effect.andThen(
					Console.error(
						"usage: node blocking.fixtures.ts <loop|backtrack|returns|pauses|sleeps> <threshold> <hang ms> <pause ms> <deadline ms|none> <seed>"
					),
					Effect.sync(() => {
						process.exitCode = 2
					})
				)
			),
		onSome: ([planted, seed]) => searchedAsProgram(planted, seed)
	})
}
