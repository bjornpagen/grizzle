import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { regex } from "arkregex"
import { Effect, Exit, Option, Stream, String as Str } from "effect"
import { ChildProcess } from "effect/process"
import { type Blocking, blockingSearch, LOOPS_FROM, values } from "#blocking.fixtures.ts"
import { replayOf } from "#replay.ts"
import { forcedChooser, generate } from "#source.ts"
import { HARDENED_FLAGS } from "#vitest/config.ts"
import { runOfProcess } from "#vitest/run.ts"

/** The program that searches a blocking property, run in a process of its own, since a hang there ends its process. */
const program = `${import.meta.dirname}/blocking.fixtures.ts`

/** A replay token as a report prints it. */
const REPLAY_LINE = regex("TEST_REPLAY='(?<token>[^']*)'")

/** The line the program prints when its search ends: how it ended. */
const ENDED_LINE = regex("^ended: (?<ending>.*)$", "m")

/**
 * The blocking program's run under this run's seed, to its end: what it printed, and its exit code, none when a signal
 * ended it.
 */
const programRun = (blocking: Blocking) =>
	Effect.scoped(
		Effect.gen(function* () {
			const run = yield* runOfProcess
			const handle = yield* ChildProcess.make(
				process.execPath,
				[...HARDENED_FLAGS, program, blocking, String(run.seed)],
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
			return {
				ending: Option.map(Option.fromNullishOr(ENDED_LINE.exec(stdout)?.groups.ending), Str.trim),
				replay: Option.fromNullishOr(REPLAY_LINE.exec(stderr)?.groups.token),
				exitCode: Exit.isSuccess(exit) ? Option.some(Number(exit.value)) : Option.none()
			}
		})
	)

layer(NodeServices.layer)("a case that holds its process's main thread", (it) => {
	it.effect(
		"ends the process when it loops without yielding, its report naming the looping case and how to replay it",
		() =>
			Effect.gen(function* () {
				const ran = yield* programRun("loops")
				const token = yield* Option.match(ran.replay, {
					onNone: () => Effect.die("the watchdog's report names no case to replay"),
					onSome: (found) => replayOf(found)
				})
				deepStrictEqual(
					{
						ended: ran.ending,
						exitCode: ran.exitCode,
						suite: token.suite,
						loops:
							generate(
								values,
								forcedChooser(
									Float64Array.from(token.replayed.values),
									token.replayed.values.length
								)
							).value >= LOOPS_FROM
					},
					{
						ended: Option.none(),
						exitCode: Option.none(),
						suite: blockingSearch("loops").suite,
						loops: true
					}
				)
			})
	)

	it.effect(
		"never ends the process when its thread answers in time, a case that held it past its hang limit and returned",
		() =>
			Effect.gen(function* () {
				const ran = yield* programRun("pauses")
				deepStrictEqual(
					{
						ended: Option.isSome(ran.ending),
						reported: Option.isSome(ran.replay),
						exitCode: ran.exitCode
					},
					{ ended: true, reported: false, exitCode: Option.some(0) }
				)
			})
	)
})
