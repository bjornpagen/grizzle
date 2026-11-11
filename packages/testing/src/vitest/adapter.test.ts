/**
 * The Vitest adapter (vitest/run.ts, vitest/config.ts): a search runs on the run global setup chose, under its test's
 * deadline; the test process runs under every hardened flag, the __proto__ accessor gone; and the config's every
 * project runs natively on forks under those flags, with the timeouts and lists it states. Oracles are stated per
 * search.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants), one a property in this order: run-deadline-dropped,
 * hardened-flag-dropped, config-pool-threads.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Config, Duration, Effect, Formatter, Option } from "effect"
import { drawn, exhaust, explore } from "#explore.ts"
import { noCoverage, required } from "#features.ts"
import { array, boolean, element, type Gen, int, option } from "#gen.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { defineTestConfig, HARDENED_FLAGS, type TestConfig, type Timeout } from "#vitest/config.ts"
import { searched } from "#vitest/searched.ts"

/** The file names a drawn config lists, from a small roster so the lists overlap. */
const FILES = ["a.test.ts", "b.test.ts", "c.test.ts"] as const

const files = (source: Parameters<Gen<unknown>>[0]) =>
	source.draw(array(element(FILES), { min: 0, max: 2 }))

const timeout: Gen<Timeout> = (source) =>
	source.draw(boolean)
		? { kind: "bounded", millis: source.draw(int(1, 120_000)) }
		: { kind: "unbounded" }

/** A package's test config, every field drawn. */
const testConfig: Gen<TestConfig> = (source) => ({
	include: files(source),
	exclusive: files(source),
	guided: files(source),
	setup: files(source),
	conditions: source.draw(
		array(element(["grizzle-source", "development"] as const), { min: 0, max: 2 })
	),
	timeouts: { test: source.draw(timeout), hook: source.draw(timeout) },
	maxWorkers: source.draw(option(int(1, 16))),
	smallStack: files(source)
})

/** Vitest's form of a timeout, from the config's contract: zero is none, and a fuzz run has none. */
const millisOf = (stated: Timeout, fuzzing: boolean): number =>
	fuzzing || stated.kind === "unbounded" ? 0 : stated.millis

/** What a built config states, each field as it is there or none. */
type ConfigFacts = Readonly<{
	pool: Option.Option<unknown>
	isolate: Option.Option<boolean>
	execArgv: Option.Option<ReadonlyArray<string>>
	viteModuleRunner: Option.Option<boolean>
	nodeLoader: Option.Option<boolean>
	maxWorkers: Option.Option<number | string>
	testTimeout: Option.Option<number>
	hookTimeout: Option.Option<number>
	projects: ReadonlyArray<Option.Option<string>>
}>

type ConfigFeature =
	| "a guided project"
	| "a small-stack project"
	| "an exclusive project"
	| "a worker limit"
	| "an unbounded timeout"
	| "an export condition"

describe("the Vitest adapter", () => {
	it.effect("runs a search on the run global setup chose", (ctx) =>
		Effect.gen(function* () {
			const explored = yield* searched(
				ctx,
				explore(
					{
						suite: "adapter",
						oracle: {
							kind: "specification",
							name: "a property that holds, run through the adapter"
						},
						draw: drawn(int(0, 9)),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 100,
						shrink: boundedShrink(500),
						concurrency: 8,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					() => Effect.void
				)
			)
			strictEqual(explored.kind, "explored")
		})
	)

	it.effect(
		"runs this test process under every hardened flag, the __proto__ accessor gone with its own",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "hardened flags",
						oracle: {
							kind: "specification",
							name: "every flag the config passes is in the process's execArgv"
						},
						box: "every hardened flag the config passes",
						generator: (source) =>
							Arr.getUnsafe(HARDENED_FLAGS, source.draw(int(0, HARDENED_FLAGS.length - 1))),
						literal: Formatter.format,
						limit: 32,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					(flag) =>
						Effect.sync(() =>
							deepStrictEqual(
								{
									passed: Arr.contains(process.execArgv, flag),
									accessor: Option.filter(
										Option.fromUndefinedOr(
											Object.getOwnPropertyDescriptor(Object.prototype, "__proto__")
										),
										() => flag === "--disable-proto=delete"
									)
								},
								{ passed: true, accessor: Option.none<PropertyDescriptor>() }
							)
						)
				)
			)
	)

	it.effect(
		"builds a config whose every project runs natively on forks under the hardened flags, with the timeouts and lists it states",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "test config",
						oracle: {
							kind: "specification",
							name: "defineTestConfig's contract: native forks, the hardened flags and conditions, one project per non-empty list, the timeouts as stated"
						},
						draw: drawn(testConfig),
						literal: Formatter.format,
						coverage: required<ConfigFeature>(
							[
								"a guided project",
								"a small-stack project",
								"an exclusive project",
								"a worker limit",
								"an unbounded timeout",
								"an export condition"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: boundedShrink(100),
						concurrency: 1,
						steerEvery: 25,
						caseHang: Duration.minutes(1)
					},
					(config, c) =>
						Effect.gen(function* () {
							const fuzz = yield* Config.option(Config.String("TEST_FUZZ"))
							const fuzzing = Option.isSome(fuzz)
							const built = defineTestConfig(config).test
							const projects = Arr.map(built?.projects ?? [], (project) =>
								typeof project === "object" && "test" in project
									? Option.map(Option.fromUndefinedOr(project.test.name), (name) =>
											typeof name === "string" ? name : name.label
										)
									: Option.none<string>()
							)
							if (Arr.isReadonlyArrayNonEmpty(config.guided)) {
								c.note("a guided project")
							}
							if (Arr.isReadonlyArrayNonEmpty(config.smallStack)) {
								c.note("a small-stack project")
							}
							if (Arr.isReadonlyArrayNonEmpty(config.exclusive)) {
								c.note("an exclusive project")
							}
							if (Option.isSome(config.maxWorkers)) {
								c.note("a worker limit")
							}
							if (
								config.timeouts.test.kind === "unbounded" ||
								config.timeouts.hook.kind === "unbounded"
							) {
								c.note("an unbounded timeout")
							}
							if (Arr.isReadonlyArrayNonEmpty(config.conditions)) {
								c.note("an export condition")
							}
							const execArgv = [
								...HARDENED_FLAGS,
								...Arr.map(config.conditions, (condition) => `--conditions=${condition}`)
							]
							const stated: ConfigFacts = {
								pool: Option.fromUndefinedOr(built?.pool),
								isolate: Option.fromUndefinedOr(built?.isolate),
								execArgv: Option.fromUndefinedOr(built?.execArgv),
								viteModuleRunner: Option.fromUndefinedOr(built?.experimental?.viteModuleRunner),
								nodeLoader: Option.fromUndefinedOr(built?.experimental?.nodeLoader),
								maxWorkers: Option.fromUndefinedOr(built?.maxWorkers),
								testTimeout: Option.fromUndefinedOr(built?.testTimeout),
								hookTimeout: Option.fromUndefinedOr(built?.hookTimeout),
								projects
							}
							const expected: ConfigFacts = {
								pool: Option.some("forks"),
								isolate: Option.some(true),
								execArgv: Option.some(execArgv),
								viteModuleRunner: Option.some(false),
								nodeLoader: Option.some(false),
								maxWorkers: config.maxWorkers,
								testTimeout: Option.some(millisOf(config.timeouts.test, fuzzing)),
								hookTimeout: Option.some(millisOf(config.timeouts.hook, fuzzing)),
								projects: Arr.map(
									[
										"parallel",
										...(Arr.isReadonlyArrayNonEmpty(config.guided) ? ["guided"] : []),
										...(Arr.isReadonlyArrayNonEmpty(config.smallStack) ? ["small-stack"] : []),
										...(Arr.isReadonlyArrayNonEmpty(config.exclusive) ? ["exclusive"] : [])
									],
									Option.some
								)
							}
							deepStrictEqual(stated, expected)
						})
				)
			)
	)
})
