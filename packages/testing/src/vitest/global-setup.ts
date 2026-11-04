import { regex } from "arkregex"
import { Config, ConfigProvider, Console, Effect, Option, Random, Schema } from "effect"
import type { TestProject } from "vitest/node"
import { FuzzTime } from "#fuzz.ts"
import { replayOf } from "#replay.ts"
import { RUN_KEY, type RunWire } from "#vitest/run.ts"

/** A 32-bit run seed as a person writes it: decimal, or hexadecimal after `0x`. */
const SeedText = Schema.String.check(Schema.isPattern(regex("^(0x[0-9a-fA-F]{1,8}|[0-9]{1,10})$")))

/**
 * The environment a run is chosen from: the project's `env` (Vitest's `test.env`, which the tests see as their own),
 * over the process's, so a run started in process, as the mutation runner starts one, names its seed as a value.
 */
const runEnvironmentOf = (project: TestProject) =>
	ConfigProvider.orElse(
		ConfigProvider.fromEnvRecord({ ...project.config.env }),
		ConfigProvider.fromEnv()
	)

/**
 * Chooses the run every test process shares, before any test starts: `TEST_SEED` replays a run, otherwise the seed
 * is drawn fresh; `TEST_REPLAY=<suite>:<steering>:<tape>`, the token a failure prints, replays one case of one suite
 * under the steering it was drawn under, read here once (replayOf); `TEST_FUZZ=suite` fuzzes one suite, for
 * `TEST_FUZZTIME` (Go's `-fuzztime`: `30s`, `5m`, `1000x`) or until a case fails. The seed is printed first, so any
 * failure of this run can be reproduced.
 */
export const setup = (project: TestProject) =>
	Effect.runSync(
		Effect.gen(function* () {
			const given = yield* Config.option(Config.String("TEST_SEED"))
			const seed = Option.isSome(given)
				? yield* Effect.map(Schema.decodeEffect(SeedText)(given.value), Number)
				: yield* Random.nextIntBetween(0, 0xffff_ffff)
			const replayText = yield* Config.option(Config.String("TEST_REPLAY"))
			const replay: RunWire["replay"] = Option.isSome(replayText)
				? yield* Effect.map(
						replayOf(replayText.value),
						({ suite, replayed }): RunWire["replay"] => ({ kind: "replay", suite, replayed })
					)
				: { kind: "none" }
			const fuzzed = yield* Config.option(Config.String("TEST_FUZZ"))
			const fuzzTime = yield* Config.option(Config.String("TEST_FUZZTIME"))
			const fuzz: RunWire["fuzz"] = Option.isSome(fuzzed)
				? {
						kind: "fuzz",
						suite: fuzzed.value,
						fuzzTime: Option.isSome(fuzzTime)
							? { kind: "given", text: yield* Schema.decodeEffect(FuzzTime)(fuzzTime.value) }
							: { kind: "until-failure" }
					}
				: { kind: "none" }
			const wire: RunWire = {
				seed,
				source: Option.isSome(given) ? "environment" : "fresh",
				replay,
				fuzz
			}
			yield* Console.log(
				`TEST_SEED=${seed}${Option.isSome(given) ? "" : " (drawn by this run; set it to reproduce)"}`
			)
			project.provide(RUN_KEY, wire)
		}).pipe(Effect.orDie, Effect.provide(ConfigProvider.layer(runEnvironmentOf(project))))
	)
