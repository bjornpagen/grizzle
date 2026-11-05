import { Console, Duration, Effect, Exit, Formatter, Option } from "effect"
import { drawn, type Exploration, explore, noDeadline, Run } from "#explore.ts"
import { noCoverage } from "#features.ts"
import { int } from "#gen.ts"
import { boundedShrink } from "#shrink.ts"

/** How a blocking search's property holds the main thread on a case it blocks on. */
export type Blocking = "loops" | "pauses"

/** The values a blocking search draws: a looping property loops on LOOPS_FROM and up, and returns at once below. */
export const values = int(0, 9)

/** The least value a looping property loops on. */
export const LOOPS_FROM = 5

/** How long a case of a blocking search may run before its guard stops it. */
const CASE_HANG = Duration.millis(400)

/** How long a pausing case holds the main thread: past its hang limit, and far short of the watchdog's grace past it. */
const PAUSE_MILLIS = 500

/**
 * A search whose property blocks the main thread: a looping one on its cases of LOOPS_FROM and up, which its floor
 * stream reaches, and a pausing one on its every case, of which it runs five.
 */
export const blockingSearch = (blocking: Blocking): Exploration<number, number, never> => ({
	suite: `a property that ${blocking}`,
	oracle: { kind: "specification", name: "a property planted to hold its process's main thread" },
	draw: drawn(values),
	literal: Formatter.format,
	coverage: noCoverage,
	kept: [],
	runs: blocking === "loops" ? 40 : 4,
	shrink: boundedShrink(10),
	concurrency: 1,
	steerEvery: 8,
	caseHang: CASE_HANG
})

/**
 * Holds the main thread without yielding, so no timer on it can fire: forever, in a loop that never ends, or for
 * PAUSE_MILLIS, in a wait that blocks the thread.
 */
const hold = (blocking: Blocking): void => {
	const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
	switch (blocking) {
		case "loops":
			while (Atomics.load(cell, 0) === 0) {
				Atomics.add(cell, 0, 0)
			}
			return
		case "pauses":
			Atomics.wait(cell, 0, 0, PAUSE_MILLIS)
	}
}

/**
 * The program this module is when run (`node blocking.fixtures.ts <loops|pauses> <seed>`): it searches `blockingSearch`
 * under the given run seed and prints how the search ended. A loop ends the process instead, by its watchdog, which
 * prints its report.
 */
const searchedAsProgram = (held: Blocking, seed: number) =>
	Effect.runPromise(
		explore(blockingSearch(held), (value) =>
			Effect.sync(() => {
				if (held === "pauses" || value >= LOOPS_FROM) {
					hold(held)
				}
			})
		).pipe(
			Effect.exit,
			Effect.flatMap((exit) =>
				Console.log(
					`ended: ${
						Exit.isSuccess(exit)
							? "passed"
							: Option.getOrElse(
									Option.map(Exit.findErrorOption(exit), (failure) => failure._tag),
									() => "died"
								)
					}`
				)
			),
			Effect.provideService(
				Run,
				Run.of({
					seed,
					source: "environment",
					replay: Option.none(),
					fuzz: Option.none(),
					deadline: noDeadline
				})
			)
		)
	)

if (import.meta.main) {
	const [blocking = "loops", seed = "0"] = process.argv.slice(2)
	await searchedAsProgram(blocking === "pauses" ? "pauses" : "loops", Number(seed))
}
