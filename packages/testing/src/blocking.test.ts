/**
 * The watchdog (live.ts), over planted properties each run in a program of its own: a runaway ends its process with
 * the hang report and its replay token once its moment and the watchdog's grace have passed, and only then; a body
 * that returns, pauses or sleeps ends its search in the program by the guard's typed verdict. Oracle: stated in the
 * search.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/watchdog-grace-doubled.patch (a grace twice the one stated) turns the
 * property red.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { regex } from "arkregex"
import { Array as Arr, Duration, Effect, Exit, Formatter, Option, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { BODIES, type Body, type Planted, runsAway, suiteOf, values } from "#blocking.fixtures.ts"
import { drawn, explore, PRINT_MARGIN_MILLIS } from "#explore.ts"
import { required } from "#features.ts"
import { boolean, element, type Gen, int } from "#gen.ts"
import { liveMillis, WATCHDOG_GRACE_MILLIS } from "#live.ts"
import { replayOf } from "#replay.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { forcedChooser, generate, recorder } from "#source.ts"
import { HARDENED_FLAGS } from "#vitest/config.ts"
import { runOfProcess } from "#vitest/run.ts"
import { searched } from "#vitest/searched.ts"

/**
 * The watchdog, searched over planted properties, each run in a program of its own, since a runaway ends its process:
 * a body that loops or backtracks forever from a drawn threshold must end its process with the hang report, naming the
 * first case at the threshold in a replay token, once its moment (its hang limit, or its search's cut when that comes
 * first) and the watchdog's grace have passed and before a slack more; a body that returns, pauses past its hang limit
 * short of the grace, or sleeps past it, yielding, must end its search in the program, by the guard's typed verdict.
 */

/** The program that searches a planted property. */
const program = `${import.meta.dirname}/blocking.fixtures.ts`

/**
 * The replay token of the watchdog's report, past the line that opens it. A search's own report, which it prints as it
 * waits on a stopped case's cleanup, carries a token too, under a line of its own.
 */
const REPLAY_LINE = regex(
	"a case that blocked its process\n(?:.*\n)*?replay it alone: TEST_REPLAY='(?<token>[^']*)'"
)

/** The line the program prints when its search ends: how it ended. */
const ENDED_LINE = regex("^ended: (?<ending>\\S+)$", "m")

/** The line the program prints as its search begins: the moment, in milliseconds since the epoch. */
const BEGAN_LINE = regex("^began: (?<moment>\\d+)$", "m")

/**
 * How late past its moment and the grace a runaway's process may end and still have ended on time: the watchdog's
 * thread waking, the inspector's report, the kill, and this process noticing, on a loaded machine.
 */
const ENDING_SLACK_MILLIS = 3000

/** The bodies a search with a deadline before its hang limit draws: a pause there would outlast the hang limit. */
const DEADLINE_BODIES = ["loop", "backtrack", "returns", "sleeps"] as const

/**
 * A planted search of `body` in one of two regimes: a short hang limit and no deadline, or, when `deadlineFirst`, a
 * hang limit of a minute and a deadline whose cut comes one to two and a half seconds after the search begins, which
 * the case reaches first. A pause is drawn in the first regime alone: under the second it would outlast the cut.
 */
const plantedOf =
	(body: Body, deadlineFirst: boolean): Gen<Planted> =>
	(source) => {
		const threshold = source.draw(int(0, 9))
		if (!deadlineFirst || body === "pauses") {
			const hangMillis = source.draw(int(200, 600))
			return {
				body,
				threshold,
				hangMillis,
				pauseMillis: hangMillis + source.draw(int(50, 1000)),
				deadlineMillis: Option.none()
			}
		}
		return {
			body,
			threshold,
			hangMillis: 60_000,
			pauseMillis: 0,
			deadlineMillis: Option.some(PRINT_MARGIN_MILLIS + source.draw(int(1000, 2500)))
		}
	}

const planted: Gen<Planted> = (source) =>
	source.draw(plantedOf(source.draw(element(BODIES)), source.draw(boolean)))

/** When the planted search's guard would stop its first case at the threshold, in milliseconds after it began. */
const momentOf = (plantedSearch: Planted): number =>
	Option.match(plantedSearch.deadlineMillis, {
		onNone: () => plantedSearch.hangMillis,
		onSome: (deadline) => Math.min(plantedSearch.hangMillis, deadline - PRINT_MARGIN_MILLIS)
	})

/** How a well-behaved planted search ends in its program: its guard's verdict, typed. */
const endingOf = (plantedSearch: Planted): string => {
	switch (plantedSearch.body) {
		case "returns":
		case "pauses":
			return "exhausted"
		case "sleeps":
			return Option.isSome(plantedSearch.deadlineMillis) ? "DeadlineReached" : "CaseHung"
		case "loop":
		case "backtrack":
			return "no ending: its process is ended"
	}
}

type Feature =
	| "a body that loop"
	| "a body that backtrack"
	| "a body that returns"
	| "a body that pauses"
	| "a body that sleeps"
	| "a deadline before the hang limit"

const FEATURES = [
	"a body that loop",
	"a body that backtrack",
	"a body that returns",
	"a body that pauses",
	"a body that sleeps",
	"a deadline before the hang limit"
] as const satisfies ReadonlyArray<Feature>

/** A planted search aimed at a feature still pending, its other choices drawn, for a steered case to reach it. */
const aimedAt =
	(feature: Feature): Gen<Planted> =>
	(source) => {
		switch (feature) {
			case "a deadline before the hang limit":
				return source.draw(plantedOf(source.draw(element(DEADLINE_BODIES)), true))
			case "a body that loop":
				return source.draw(plantedOf("loop", source.draw(boolean)))
			case "a body that backtrack":
				return source.draw(plantedOf("backtrack", source.draw(boolean)))
			case "a body that returns":
				return source.draw(plantedOf("returns", source.draw(boolean)))
			case "a body that pauses":
				return source.draw(plantedOf("pauses", false))
			case "a body that sleeps":
				return source.draw(plantedOf("sleeps", source.draw(boolean)))
		}
	}

/** The planted program's run under this run's seed, to its end: what it printed, its exit code, and when it ended. */
const programRun = (plantedSearch: Planted) =>
	Effect.scoped(
		Effect.gen(function* () {
			const run = yield* runOfProcess
			const handle = yield* ChildProcess.make(
				process.execPath,
				[
					...HARDENED_FLAGS,
					program,
					plantedSearch.body,
					String(plantedSearch.threshold),
					String(plantedSearch.hangMillis),
					String(plantedSearch.pauseMillis),
					Option.match(plantedSearch.deadlineMillis, { onNone: () => "none", onSome: String }),
					String(run.seed)
				],
				{ stdin: "ignore" }
			)
			const [stdout, stderr, exit] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					Effect.exit(handle.exitCode)
				],
				{ concurrency: "unbounded" }
			)
			const ended = yield* liveMillis
			return {
				began: Option.map(Option.fromNullishOr(BEGAN_LINE.exec(stdout)?.groups.moment), Number),
				ended,
				ending: Option.fromNullishOr(ENDED_LINE.exec(stdout)?.groups.ending),
				replay: Option.fromNullishOr(REPLAY_LINE.exec(stderr)?.groups.token),
				exitCode: Exit.isSuccess(exit) ? Option.some(Number(exit.value)) : Option.none()
			}
		})
	)

layer(NodeServices.layer, { excludeTestServices: true })(
	"a case that holds its process's main thread",
	(it) => {
		it.effect(
			"ends its process with the hang report and its replay token once it runs away past its moment and the grace, and only then",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "watchdog",
							oracle: {
								kind: "specification",
								name: "a runaway ends its process past its moment and the watchdog's grace, naming its case; any other body ends its search by the guard's verdict"
							},
							draw: drawn(planted),
							literal: Formatter.format,
							coverage: required<Feature>(FEATURES, { cases: 16, sense: notesOnly }),
							kept: [],
							runs: 4,
							shrink: boundedShrink(4),
							concurrency: 2,
							steerEvery: 4,
							caseHang: Duration.minutes(2)
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const plantedSearch = Option.match(
									Option.flatMap(c.steering, (pending) =>
										Arr.findFirst(FEATURES, (feature) => pending.aimed(feature))
									),
									{ onNone: () => sketch, onSome: (feature) => c.draw(aimedAt(feature)) }
								)
								c.note(`a body that ${plantedSearch.body}`)
								if (Option.isSome(plantedSearch.deadlineMillis)) {
									c.note("a deadline before the hang limit")
								}
								const ran = yield* programRun(plantedSearch)
								if (!runsAway(plantedSearch.body)) {
									deepStrictEqual(
										{ ending: ran.ending, replay: ran.replay, exitCode: ran.exitCode },
										{
											ending: Option.some(endingOf(plantedSearch)),
											replay: Option.none(),
											exitCode: Option.some(0)
										}
									)
									return
								}
								const token = yield* Option.match(ran.replay, {
									onNone: () => Effect.die("the watchdog's report names no case to replay"),
									onSome: (found) => replayOf(found)
								})
								const elapsed = Option.map(ran.began, (began) => ran.ended - began)
								const moment = momentOf(plantedSearch) + WATCHDOG_GRACE_MILLIS
								deepStrictEqual(
									{
										ending: ran.ending,
										exitCode: ran.exitCode,
										suite: token.suite,
										replayed: generate(
											recorder(),
											values,
											forcedChooser(
												Float64Array.from(token.replayed.values),
												token.replayed.values.length
											)
										).value,
										onTime: Option.map(
											elapsed,
											(millis) => millis >= moment && millis <= moment + ENDING_SLACK_MILLIS
										)
									},
									{
										ending: Option.none<string>(),
										exitCode: Option.none<number>(),
										suite: suiteOf(plantedSearch),
										replayed: plantedSearch.threshold,
										onTime: Option.some(true)
									}
								)
							})
					)
				),
			{ timeout: 900_000 }
		)
	}
)
