import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { regex } from "arkregex"
import { Context, Effect, Exit, FileSystem, Layer, Option, Stream } from "effect"
import { ChildProcess } from "effect/process"

/** This library's checkout: the files a consumer's node_modules holds a copy of, and its installed dependencies. */
const library = `${import.meta.dirname}/..`

/**
 * A package that has this library in its node_modules, as a copy of the files its tarball ships, and runs its tests as
 * Vitest does by default, through Vite's module runner: a function and the test that pins it, a passing test that never
 * loads it, a failing test of its own, so its whole suite is red, and a search, with the library's global setup and its
 * residual reporter named in its config; and, under a config of its own, a search whose property loops on half its
 * values.
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
	["src/below.ts", `export const below = (a: number, b: number): boolean => a < b\n`],
	[
		"src/below.test.ts",
		`import { expect, it } from "vitest"\nimport { below } from "./below.ts"\nit("orders two numbers", () => {\n\texpect(below(1, 2)).toBe(true)\n\texpect(below(2, 1)).toBe(false)\n\texpect(below(1, 1)).toBe(false)\n})\n`
	],
	[
		"src/apart.test.ts",
		`import { expect, it } from "vitest"\nit("loads nothing of the package", () => {\n\texpect(1).toBe(1)\n})\n`
	],
	[
		"src/red.test.ts",
		`import { expect, it } from "vitest"\nit("fails for a reason of its own", () => {\n\texpect(1).toBe(2)\n})\n`
	],
	[
		"src/searched.test.ts",
		`import { it } from "@effect/vitest"\nimport { Duration, Effect, Formatter } from "effect"\nimport { drawn, explore } from "@grizzle/testing/explore"\nimport { required } from "@grizzle/testing/features"\nimport { int } from "@grizzle/testing/gen"\nimport { notesOnly } from "@grizzle/testing/sense"\nimport { boundedShrink } from "@grizzle/testing/shrink"\nimport { searched } from "@grizzle/testing/vitest"\nit.effect("a consumer's search", (ctx) =>\n\tsearched(\n\t\tctx,\n\t\texplore(\n\t\t\t{\n\t\t\t\tsuite: "consumer search",\n\t\t\t\toracle: { kind: "universal", name: "a value is its own" },\n\t\t\t\tdraw: drawn(int(0, 9)),\n\t\t\t\tliteral: Formatter.format,\n\t\t\t\tcoverage: required<"small" | "large">(["small", "large"], { cases: 20, sense: notesOnly }),\n\t\t\t\tkept: [],\n\t\t\t\truns: 40,\n\t\t\t\tshrink: boundedShrink(10),\n\t\t\t\tconcurrency: 1,\n\t\t\t\tsteerEvery: 8,\n\t\t\t\tcaseHang: Duration.seconds(10)\n\t\t\t},\n\t\t\t(value, c) => Effect.sync(() => c.note(value < 5 ? "small" : "large"))\n\t\t)\n\t)\n)\n`
	],
	[
		"vitest.loops.config.ts",
		`import { defineConfig } from "vitest/config"\nexport default defineConfig({ test: { include: ["src/loops.check.ts"], globalSetup: ["@grizzle/testing/vitest/global-setup"] } })\n`
	],
	[
		"src/loops.check.ts",
		`import { it } from "@effect/vitest"\nimport { Duration, Effect, Formatter } from "effect"\nimport { drawn, explore } from "@grizzle/testing/explore"\nimport { noCoverage } from "@grizzle/testing/features"\nimport { int } from "@grizzle/testing/gen"\nimport { boundedShrink } from "@grizzle/testing/shrink"\nimport { searched } from "@grizzle/testing/vitest"\nconst loop = () => {\n\tconst cell = new Int32Array(new SharedArrayBuffer(4))\n\twhile (Atomics.load(cell, 0) === 0) {\n\t\tAtomics.add(cell, 0, 0)\n\t}\n}\nit.effect("a consumer's search that loops", (ctx) =>\n\tsearched(\n\t\tctx,\n\t\texplore(\n\t\t\t{\n\t\t\t\tsuite: "consumer loop",\n\t\t\t\toracle: { kind: "universal", name: "a value is its own" },\n\t\t\t\tdraw: drawn(int(0, 9)),\n\t\t\t\tliteral: Formatter.format,\n\t\t\t\tcoverage: noCoverage,\n\t\t\t\tkept: [],\n\t\t\t\truns: 40,\n\t\t\t\tshrink: boundedShrink(10),\n\t\t\t\tconcurrency: 1,\n\t\t\t\tsteerEvery: 8,\n\t\t\t\tcaseHang: Duration.millis(200)\n\t\t\t},\n\t\t\t(value) => Effect.sync(() => (value >= 5 ? loop() : undefined))\n\t\t)\n\t)\n)\n`
	]
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

/** The replay token of the consumer's looping search, as the watchdog's report prints it. */
const LOOP_REPLAY = regex("TEST_REPLAY='consumer loop:")

/** The residual table's line for the consumer's search, indented under the table's heading. */
const CONSUMER_RESIDUAL = regex("^  consumer search: [0-9]+ independent cases", "m")

layer(Layer.provideMerge(consumerLayer, NodeServices.layer))(
	"a package that has the library in its node_modules, its tests on Vite's module runner",
	(it) => {
		it.effect(
			"measures a file by its own tests with grizzle-mutate, a red suite elsewhere refusing only the run that runs it",
			() =>
				Effect.gen(function* () {
					const scoped = yield* mutated(["--test", "src/below.test.ts"])
					const whole = yield* mutated([])
					deepStrictEqual(
						{
							scoped: { counts: countsOf(scoped.stdout), exitCode: scoped.exitCode },
							whole: { refusal: refusalOf(whole.stderr), exitCode: whole.exitCode }
						},
						{
							scoped: {
								counts: Option.some({ killed: 1, survived: 0, timeout: 0, invalid: 0 }),
								exitCode: Option.some(0)
							},
							whole: { refusal: Option.some("MutationRunRefused"), exitCode: Option.some(1) }
						}
					)
				}),
			{ timeout: 300_000 }
		)

		it.effect(
			"refuses, before any mutant, a run whose tests never load the file the mutants change",
			() =>
				Effect.gen(function* () {
					const apart = yield* mutated(["--test", "src/apart.test.ts"])
					deepStrictEqual(
						{
							refusal: refusalOf(apart.stderr),
							counts: countsOf(apart.stdout),
							exitCode: apart.exitCode
						},
						{
							refusal: Option.some("MutationProbeSurvived"),
							counts: Option.none(),
							exitCode: Option.some(1)
						}
					)
				}),
			{ timeout: 300_000 }
		)

		it.effect(
			"tables the residual of its searches with the reporter it names in its config",
			() =>
				Effect.gen(function* () {
					const { directory } = yield* Consumer
					const ran = yield* ranInConsumer(process.execPath, [
						`${directory}/node_modules/vitest/vitest.mjs`,
						"run",
						"src/searched.test.ts"
					])
					deepStrictEqual(
						{
							tabled: Option.isSome(Option.fromNullishOr(CONSUMER_RESIDUAL.exec(ran.stdout))),
							exitCode: ran.exitCode
						},
						{ tabled: true, exitCode: Option.some(0) }
					)
				}),
			{ timeout: 300_000 }
		)

		it.effect(
			"reports a search that loops as a hang, its process ended by the watchdog with the looping case's replay token",
			() =>
				Effect.gen(function* () {
					const { directory } = yield* Consumer
					const ran = yield* ranInConsumer(process.execPath, [
						`${directory}/node_modules/vitest/vitest.mjs`,
						"run",
						"--config",
						"vitest.loops.config.ts"
					])
					deepStrictEqual(
						{
							replay: Option.isSome(Option.fromNullishOr(LOOP_REPLAY.exec(ran.stderr))),
							exitCode: ran.exitCode
						},
						{ replay: true, exitCode: Option.some(1) }
					)
				}),
			{ timeout: 300_000 }
		)
	}
)
