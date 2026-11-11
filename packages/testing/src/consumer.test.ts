/**
 * The library as a consumer installs it: a package with this library copied into its node_modules runs its tests as
 * Vitest does by default, and grizzle-mutate's verdicts, the residual table and the watchdog's replay report are what
 * the library's contract says of the consumer's test files. Oracle: stated in the search.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/reporter-silent.patch (the reporter printing no table) turns the property
 * red.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { regex } from "arkregex"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Stream
} from "effect"
import { ChildProcess } from "effect/process"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { boolean, constant, element, type Gen, int, map, oneOf, subarray } from "#gen.ts"
import { replayOf } from "#replay.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { forcedChooser, generate, recorder } from "#source.ts"
import { searched } from "#vitest/searched.ts"

/** This library's checkout: the files a consumer's node_modules holds a copy of, and its installed dependencies. */
const library = `${import.meta.dirname}/..`

/**
 * A package that has this library in its node_modules, as a copy of the files its tarball ships, and runs its tests as
 * Vitest does by default, through Vite's module runner: its manifest, its tsconfig, its default config, which names the
 * library's global setup and its residual reporter, a config of its own for a search that loops, and the function the
 * mutation runs measure. Each case writes its own test files beside them.
 */
const CONSUMER: ReadonlyArray<readonly [path: string, text: string]> = [
	["package.json", `{ "name": "consumer", "private": true, "type": "module" }\n`],
	[
		"tsconfig.json",
		`{ "compilerOptions": { "target": "esnext", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true, "allowImportingTsExtensions": true, "skipLibCheck": true, "types": [] }, "include": ["src/**/*.ts"] }\n`
	],
	[
		"vitest.config.ts",
		`import { defineConfig } from "vitest/config"\nexport default defineConfig({ test: { include: ["src/**/*.test.ts"], globalSetup: ["@grizzle/testing/vitest/global-setup"], reporters: ["default", "@grizzle/testing/vitest/reporter"] } })\n`
	],
	[
		"vitest.loops.config.ts",
		`import { defineConfig } from "vitest/config"\nexport default defineConfig({ test: { include: ["src/loops.check.ts"], globalSetup: ["@grizzle/testing/vitest/global-setup"] } })\n`
	],
	["src/below.ts", `export const below = (a: number, b: number): boolean => a < b\n`]
]

/**
 * What a consumer's test file does with src/below.ts: pins its comparison, so its one comparison mutant fails it; loads
 * it and asserts nothing of what it answers, so that mutant survives; never loads it; or fails for a reason of its own.
 */
const ROLES = ["pins", "loads", "apart", "red"] as const

type Role = (typeof ROLES)[number]

/** A test file of each role, at its path in the consumer. */
const testFileOf = (role: Role): readonly [path: string, text: string] => {
	switch (role) {
		case "pins":
			return [
				"src/pins.test.ts",
				`import { expect, it } from "vitest"\nimport { below } from "./below.ts"\nit("orders two numbers", () => {\n\texpect(below(1, 2)).toBe(true)\n\texpect(below(2, 1)).toBe(false)\n\texpect(below(1, 1)).toBe(false)\n})\n`
			]
		case "loads":
			return [
				"src/loads.test.ts",
				`import { expect, it } from "vitest"\nimport { below } from "./below.ts"\nit("has the function", () => {\n\texpect(typeof below).toBe("function")\n})\n`
			]
		case "apart":
			return [
				"src/apart.test.ts",
				`import { expect, it } from "vitest"\nit("loads nothing of the package", () => {\n\texpect(1).toBe(1)\n})\n`
			]
		case "red":
			return [
				"src/red.test.ts",
				`import { expect, it } from "vitest"\nit("fails for a reason of its own", () => {\n\texpect(1).toBe(2)\n})\n`
			]
	}
}

/** The consumer's search, which passes, as the default config's run finds it. */
const SEARCHED: readonly [path: string, text: string] = [
	"src/searched.test.ts",
	`import { it } from "@effect/vitest"\nimport { Duration, Effect, Formatter } from "effect"\nimport { drawn, explore } from "@grizzle/testing/explore"\nimport { required } from "@grizzle/testing/features"\nimport { int } from "@grizzle/testing/gen"\nimport { notesOnly } from "@grizzle/testing/sense"\nimport { boundedShrink } from "@grizzle/testing/shrink"\nimport { searched } from "@grizzle/testing/vitest"\nit.effect("a consumer's search", (ctx) =>\n\tsearched(\n\t\tctx,\n\t\texplore(\n\t\t\t{\n\t\t\t\tsuite: "consumer search",\n\t\t\t\toracle: { kind: "universal", name: "a value is its own" },\n\t\t\t\tdraw: drawn(int(0, 9)),\n\t\t\t\tliteral: Formatter.format,\n\t\t\t\tcoverage: required<"small" | "large">(["small", "large"], { cases: 20, sense: notesOnly }),\n\t\t\t\tkept: [],\n\t\t\t\truns: 40,\n\t\t\t\tshrink: boundedShrink(10),\n\t\t\t\tconcurrency: 1,\n\t\t\t\tsteerEvery: 8,\n\t\t\t\tcaseHang: Duration.seconds(10)\n\t\t\t},\n\t\t\t(value, c) => Effect.sync(() => c.note(value < 5 ? "small" : "large"))\n\t\t)\n\t)\n)\n`
]

/** The consumer's search that loops on its values from `from` up, its cases' hang limit `hangMillis`. */
const looping = (from: number, hangMillis: number): readonly [path: string, text: string] => [
	"src/loops.check.ts",
	`import { it } from "@effect/vitest"\nimport { Duration, Effect, Formatter } from "effect"\nimport { drawn, explore } from "@grizzle/testing/explore"\nimport { noCoverage } from "@grizzle/testing/features"\nimport { int } from "@grizzle/testing/gen"\nimport { boundedShrink } from "@grizzle/testing/shrink"\nimport { searched } from "@grizzle/testing/vitest"\nconst loop = () => {\n\tconst cell = new Int32Array(new SharedArrayBuffer(4))\n\twhile (Atomics.load(cell, 0) === 0) {\n\t\tAtomics.add(cell, 0, 0)\n\t}\n}\nit.effect("a consumer's search that loops", (ctx) =>\n\tsearched(\n\t\tctx,\n\t\texplore(\n\t\t\t{\n\t\t\t\tsuite: "consumer loop",\n\t\t\t\toracle: { kind: "universal", name: "a value is its own" },\n\t\t\t\tdraw: drawn(int(0, 9)),\n\t\t\t\tliteral: Formatter.format,\n\t\t\t\tcoverage: noCoverage,\n\t\t\t\tkept: [],\n\t\t\t\truns: 40,\n\t\t\t\tshrink: boundedShrink(10),\n\t\t\t\tconcurrency: 1,\n\t\t\t\tsteerEvery: 8,\n\t\t\t\tcaseHang: Duration.millis(${hangMillis})\n\t\t\t},\n\t\t\t(value) => Effect.sync(() => (value >= ${from} ? loop() : undefined))\n\t\t)\n\t)\n)\n`
]

/** The packages a consumer's own files import, each linked to the copy this library resolves. */
const CONSUMER_DEPENDENCIES = ["vitest", "effect", "@effect/vitest"] as const

/** The consumer package of a run of these tests: its directory, removed when the tests end. */
class Consumer extends Context.Service<Consumer, Readonly<{ directory: string }>>()(
	"@grizzle/testing/consumer.test/Consumer"
) {}

/**
 * The consumer, built in a temporary directory: its files; the library's package.json, src and scripts copied into its
 * node_modules, beside a link to the library's installed dependencies, so the copy resolves only what the library
 * declares; its own dependencies linked; and the library's bin linked into node_modules/.bin, as a package manager
 * links it.
 */
const consumerLayer = Layer.effect(
	Consumer,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-testing-consumer-" })
		const installed = `${directory}/node_modules/@grizzle/testing`
		yield* fs.makeDirectory(`${directory}/src`, { recursive: true })
		yield* fs.makeDirectory(installed, { recursive: true })
		yield* fs.makeDirectory(`${directory}/node_modules/@effect`, { recursive: true })
		yield* fs.makeDirectory(`${directory}/node_modules/.bin`, { recursive: true })
		yield* Effect.forEach(
			CONSUMER,
			([path, text]) => fs.writeFileString(`${directory}/${path}`, text),
			{
				discard: true
			}
		)
		yield* Effect.forEach(
			["package.json", "src", "scripts"],
			(entry) => fs.copy(`${library}/${entry}`, `${installed}/${entry}`),
			{ discard: true }
		)
		const dependencies = yield* fs.realPath(`${library}/node_modules`)
		yield* fs.symlink(dependencies, `${installed}/node_modules`)
		yield* Effect.forEach(
			CONSUMER_DEPENDENCIES,
			(name) =>
				Effect.flatMap(fs.realPath(`${library}/node_modules/${name}`), (real) =>
					fs.symlink(real, `${directory}/node_modules/${name}`)
				),
			{ discard: true }
		)
		yield* fs.symlink(
			"../@grizzle/testing/scripts/mutate.sh",
			`${directory}/node_modules/.bin/grizzle-mutate`
		)
		return { directory }
	})
)

/** A command run to its end in the consumer's directory: what it printed, and its exit code, none when a signal ended it. */
const ranInConsumer = (command: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const { directory } = yield* Consumer
			const handle = yield* ChildProcess.make(command, args, {
				cwd: directory,
				extendEnv: true,
				stdin: "ignore"
			})
			const [stdout, stderr, exit] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					Effect.exit(handle.exitCode)
				],
				{ concurrency: "unbounded" }
			)
			return {
				stdout,
				stderr,
				exitCode: Exit.isSuccess(exit) ? Option.some(Number(exit.value)) : Option.none()
			}
		})
	)

/** `grizzle-mutate` in the consumer, as its bin: comparison mutants of src/below.ts, with `args` after. */
const mutated = (args: ReadonlyArray<string>) =>
	Effect.flatMap(Consumer, ({ directory }) =>
		ranInConsumer(`${directory}/node_modules/.bin/grizzle-mutate`, [
			"--package",
			directory,
			"--file",
			"src/below.ts",
			"--operator",
			"comparison",
			...args
		])
	)

/** The summary line of a mutation run. */
const SUMMARY = regex(
	"mutate: (?<killed>[0-9]+) killed, (?<survived>[0-9]+) survived, (?<timeout>[0-9]+) timed out, (?<invalid>[0-9]+) invalid"
)

/** A refused run's last line: the refusal's tag, before its reason. */
const REFUSAL = regex("(?<tag>[A-Za-z]+): [^\n]*\n?$")

/** A run's verdict counts, from its summary line. */
const countsOf = (stdout: string) =>
	Option.map(Option.fromNullishOr(SUMMARY.exec(stdout)?.groups), (counts) => ({
		killed: Number(counts.killed),
		survived: Number(counts.survived),
		timeout: Number(counts.timeout),
		invalid: Number(counts.invalid)
	}))

/** How a refused run says it was refused: the tag of its last line. */
const refusalOf = (stderr: string) => Option.fromNullishOr(REFUSAL.exec(stderr)?.groups.tag)

/** A replay token as the watchdog's report prints it. */
const REPLAY_LINE = regex("TEST_REPLAY='(?<token>[^']*)'")

/** The residual table's line for the consumer's search, indented under the table's heading. */
const CONSUMER_RESIDUAL = regex("^  consumer search: [0-9]+ independent cases", "m")

/**
 * What a case runs in the consumer: grizzle-mutate over the test files of some roles, scoped to one of them or the
 * whole suite (none); or Vitest over the consumer's search, which passes, or loops on its values from a threshold up.
 */
type Run =
	| Readonly<{ kind: "mutate"; roles: Arr.NonEmptyReadonlyArray<Role>; scope: Option.Option<Role> }>
	| Readonly<{ kind: "search" }>
	| Readonly<{ kind: "looping search"; from: number; hangMillis: number }>

/** The roles of a mutation run's test files, in roster order, `first` among them. */
const rolesWith = (first: Role): Gen<Arr.NonEmptyReadonlyArray<Role>> =>
	map(subarray(ROLES), (others) =>
		Arr.prepend(
			Arr.filter(others, (role) => role !== first),
			first
		)
	)

const mutateRun =
	(first: Role, scoped: boolean): Gen<Run> =>
	(source) => {
		const roles = source.draw(rolesWith(first))
		return {
			kind: "mutate",
			roles,
			scope: scoped ? Option.some(source.draw(element(roles))) : Option.none()
		}
	}

const loopingRun: Gen<Run> = (source) => ({
	kind: "looping search",
	from: source.draw(int(0, 9)),
	hangMillis: source.draw(int(100, 400))
})

const anyRun: Gen<Run> = oneOf<Run>([
	(source) => source.draw(mutateRun(source.draw(element(ROLES)), source.draw(boolean))),
	constant<Run>({ kind: "search" }),
	loopingRun
])

/** What a case reaches: a mutation run's verdict, or how a search ended. */
const FEATURES = [
	"a mutant killed",
	"a mutant survived",
	"refused for a red test",
	"refused by the probe",
	"a search tabled",
	"a search that loops"
] as const

type Feature = (typeof FEATURES)[number]

/** A run aimed at a feature, its other choices drawn, for a steered case to reach what is still pending. */
const aimedAt = (feature: Feature): Gen<Run> => {
	switch (feature) {
		case "a mutant killed":
			return mutateRun("pins", true)
		case "a mutant survived":
			return mutateRun("loads", true)
		case "refused for a red test":
			return mutateRun("red", false)
		case "refused by the probe":
			return mutateRun("apart", true)
		case "a search tabled":
			return constant<Run>({ kind: "search" })
		case "a search that loops":
			return loopingRun
	}
}

/** The test files a mutation run sees: its scope, or all of its roles. */
const seenBy = (
	run: Readonly<{ roles: Arr.NonEmptyReadonlyArray<Role>; scope: Option.Option<Role> }>
) =>
	Option.match(run.scope, {
		onNone: () => run.roles,
		onSome: (role): ReadonlyArray<Role> => [role]
	})

/**
 * How a mutation run ends, from grizzle-mutate's contract: refused when a test it runs fails unmutated, refused by
 * its probe when none of them loads the file, and otherwise the one comparison mutant killed when one of them pins
 * it, survived when none does.
 */
const mutateVerdictOf = (seen: ReadonlyArray<Role>): Feature => {
	if (Arr.contains(seen, "red")) {
		return "refused for a red test"
	}
	if (!Arr.contains(seen, "pins") && !Arr.contains(seen, "loads")) {
		return "refused by the probe"
	}
	return Arr.contains(seen, "pins") ? "a mutant killed" : "a mutant survived"
}

/** Writes a case's files into the consumer's src, after removing every test file an earlier case left. */
const written = (files: ReadonlyArray<readonly [path: string, text: string]>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const { directory } = yield* Consumer
		const left = yield* fs.readDirectory(`${directory}/src`)
		yield* Effect.forEach(
			Arr.filter(left, (file) => file !== "below.ts"),
			(file) => fs.remove(`${directory}/src/${file}`),
			{ discard: true }
		)
		yield* Effect.forEach(
			files,
			([path, text]) => fs.writeFileString(`${directory}/${path}`, text),
			{
				discard: true
			}
		)
	})

/** What a case observes of its run, in the model's terms: a mutation verdict, or how a search's Vitest run ended. */
const observed = (run: Run) =>
	Effect.gen(function* () {
		const { directory } = yield* Consumer
		switch (run.kind) {
			case "mutate": {
				yield* written(Arr.map(run.roles, testFileOf))
				const ran = yield* mutated(
					Option.match(run.scope, {
						onNone: () => [],
						onSome: (role) => ["--test", testFileOf(role)[0]]
					})
				)
				return {
					refusal: refusalOf(ran.stderr),
					counts: countsOf(ran.stdout),
					exitCode: ran.exitCode,
					tabled: false,
					replay: Option.none<string>()
				}
			}
			case "search":
			case "looping search": {
				yield* written(run.kind === "search" ? [SEARCHED] : [looping(run.from, run.hangMillis)])
				const ran = yield* ranInConsumer(process.execPath, [
					`${directory}/node_modules/vitest/vitest.mjs`,
					"run",
					...(run.kind === "search"
						? ["src/searched.test.ts"]
						: ["--config", "vitest.loops.config.ts"])
				])
				return {
					refusal: Option.none<string>(),
					counts: Option.none<Counts>(),
					exitCode: ran.exitCode,
					tabled: Option.isSome(Option.fromNullishOr(CONSUMER_RESIDUAL.exec(ran.stdout))),
					replay: Option.fromNullishOr(REPLAY_LINE.exec(ran.stderr)?.groups.token)
				}
			}
		}
	})

/** A mutation run's counts, as its summary line prints them. */
type Counts = Readonly<{ killed: number; survived: number; timeout: number; invalid: number }>

layer(Layer.provideMerge(consumerLayer, NodeServices.layer))(
	"a package that has the library in its node_modules, its tests on Vite's module runner",
	(it) => {
		it.effect(
			"measures its files with grizzle-mutate as its scope's tests decide, tables its searches' residual, and has a looping search's process ended with its replay token",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "consumer",
							oracle: {
								kind: "specification",
								name: "grizzle-mutate's contract over the scope's test files, the reporter's table, and the watchdog's report"
							},
							draw: drawn(anyRun),
							literal: Formatter.format,
							coverage: required<Feature>(FEATURES, { cases: 12, sense: notesOnly }),
							kept: [],
							runs: 2,
							shrink: boundedShrink(2),
							concurrency: 1,
							steerEvery: 1,
							caseHang: Duration.minutes(5)
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const run = Option.match(
									Option.flatMap(c.steering, (pending) =>
										Arr.findFirst(FEATURES, (feature) => pending.has(feature))
									),
									{ onNone: () => sketch, onSome: (feature) => c.draw(aimedAt(feature)) }
								)
								const seen = yield* observed(run)
								switch (run.kind) {
									case "mutate": {
										const verdict = mutateVerdictOf(seenBy(run))
										c.note(verdict)
										const refused =
											verdict === "refused for a red test"
												? Option.some("MutationRunRefused")
												: verdict === "refused by the probe"
													? Option.some("MutationProbeSurvived")
													: Option.none()
										deepStrictEqual(
											{ refusal: seen.refusal, counts: seen.counts, exitCode: seen.exitCode },
											{
												refusal: refused,
												counts: Option.isSome(refused)
													? Option.none()
													: Option.some({
															killed: verdict === "a mutant killed" ? 1 : 0,
															survived: verdict === "a mutant survived" ? 1 : 0,
															timeout: 0,
															invalid: 0
														}),
												exitCode: Option.some(Option.isSome(refused) ? 1 : 0)
											}
										)
										return
									}
									case "search":
										c.note("a search tabled")
										deepStrictEqual(
											{ tabled: seen.tabled, exitCode: seen.exitCode },
											{ tabled: true, exitCode: Option.some(0) }
										)
										return
									case "looping search": {
										c.note("a search that loops")
										const token = yield* Option.match(seen.replay, {
											onNone: () => Effect.die("the watchdog's report names no case to replay"),
											onSome: (found) => replayOf(found)
										})
										deepStrictEqual(
											{
												suite: token.suite,
												loops:
													generate(
														recorder(),
														int(0, 9),
														forcedChooser(
															Float64Array.from(token.replayed.values),
															token.replayed.values.length
														)
													).value >= run.from,
												exitCode: seen.exitCode
											},
											{ suite: "consumer loop", loops: true, exitCode: Option.some(1) }
										)
									}
								}
							})
					)
				),
			{ timeout: 1_800_000 }
		)
	}
)
