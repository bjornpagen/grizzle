import { toolchain } from "@bjornpagen/devtools/config"
import { standard } from "@bjornpagen/devtools/preset"
import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
	Array as Arr,
	Console,
	Data,
	Effect,
	FileSystem,
	Option,
	Path,
	Predicate,
	Result,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { isJson } from "#model/json-tree.ts"
import type { Json } from "#model/pointer.ts"
import { parseJson } from "#runtime/json.ts"
import type { InvalidJsonText } from "#runtime/json.ts"
import { anything, array, member, members, string, struct } from "#runtime/read.ts"
import type { Reader, ReadIssues } from "#runtime/read.ts"

/**
 * The runtime gate: generates the runtime-gate fixture, whose operations reach every module of the generated runtime,
 * into a fresh directory, runs the generated package's own typecheck against the workspace's installed
 * dependencies, and lints its sources with the shared lint's import and property bans, which every process of every
 * repository holds (the platform's index, Effect's metrics). The emitter writes an import's module as a string, so
 * the repository's own lint never sees what a generated CLI imports. It fails when generation fails, when the
 * generator refuses anything other than token acquisition (which it refuses for every OAuth 2 flow and OpenID
 * Connect, schemes the fixture holds on purpose), when the package does not typecheck, or when it imports or reaches
 * what a shared ban names. It stands until the property that every emitted package typechecks covers it.
 */

/** The generator package. */
const PACKAGE = `${import.meta.dirname}/..`

/** The repository root, whose installed dependencies the generated package resolves. */
const ROOT = `${PACKAGE}/../..`

const FIXTURE = `${PACKAGE}/test/fixtures/runtime-gate`

/** The suffix of every refusal code for a token the generated CLI does not acquire itself. */
const TOKEN_ACQUISITION = "/token-acquisition"

/** A failure of the gate: a step did not run or did not pass, or the generator's report could not be read. */
class RuntimeGateFailure extends Data.TaggedError("RuntimeGateFailure")<{
	readonly detail: string
}> {}

/** A refusal of the generation report, as the gate reads it: its code and the pointer it names. */
interface Refusal {
	readonly code: string
	readonly pointer: string
}

const refusal: Reader<Refusal> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{ code: member(object, "code", string), pointer: member(object, "pointer", string) },
			anything
		)
	)

/** The generation report's refusals, read from its text. */
const refusalsOf = (
	text: string
): Result.Result<readonly Refusal[], InvalidJsonText | ReadIssues> =>
	Result.flatMap(parseJson(text), (value) =>
		Result.flatMap(members(value), (object) => member(object, "refusals", array(refusal)))
	)

/**
 * The shared lint's no-restricted-imports, read by value from the preset over no list of the generator's own: its
 * banned modules, as JSON. Its patterns, the relative-import ban, are hand-written code's rule and stay out: an emitted
 * package's own modules reach each other by relative paths.
 */
const importBans = (rule: unknown): Option.Option<Json> => {
	if (!Arr.isArray(rule)) {
		return Option.none()
	}

	const [level, options] = rule

	return level === "error" && Predicate.isObject(options) && isJson(options["paths"])
		? Option.some([level, { paths: options["paths"] }])
		: Option.none()
}

/** The shared lint's no-restricted-properties, read by value from the preset over no list of the generator's own. */
const propertyBans = (rule: unknown): Option.Option<Json> =>
	Arr.isArray(rule) && rule[0] === "error" && isJson(rule) ? Option.some(rule) : Option.none()

/**
 * The preset's top-level rules over a repository of the core alone that states no list, no library and no name of its
 * own, which hold every file to the shared bans alone: the preset builds them into every block of every configuration
 * and exports them no other way.
 */
const bareRules = standard(
	toolchain({
		rejected: { rules: {}, diagnostics: {} },
		exceptions: [],
		effectFree: [],
		packs: {},
		bannedPackages: [],
		land: { lock: "~/.cache/grizzle-release/pushlock/lock", branch: "main" }
	})
).lintConfig({
	ignorePatterns: [],
	restrictedImports: { paths: [], patterns: [] },
	restrictedGlobals: [],
	restrictedProperties: [],
	restrictions: [],
	unassignedImports: [],
	environment: { library: [], readers: [] },
	ceremony: [],
	plugin: {
		"bearer-owners": { owners: [] },
		"brands-sole-mint": { mints: [] },
		"import-doors": { doors: [] },
		"no-case-list": { searches: [], generators: [], mints: [], cases: [], dictionaries: [] },
		"no-dynamic-imports": { allowed: [] },
		"no-raw-sql": { sources: [], writers: [] },
		"no-spread-argument": { tuples: [] },
		"single-permit-owners": { owners: [] }
	},
	ownPlugins: [],
	tests: { library: "none" },
	overrides: []
}).rules

/** The emitted package's lint: oxlint's own categories off, and the shared bans alone, as oxlint's JSON configuration. */
const emittedLint = Effect.fromOption(
	Option.all([
		importBans(restrictedImports({ paths: [], patterns: [] })),
		propertyBans(restrictedProperties([]))
	])
).pipe(
	Effect.mapBoth({
		onSuccess: ([imports, properties]) =>
			jsonText({
				categories: {
					correctness: "off",
					nursery: "off",
					pedantic: "off",
					perf: "off",
					restriction: "off",
					style: "off",
					suspicious: "off"
				},
				rules: {
					"no-restricted-imports": imports,
					"no-restricted-properties": properties
				}
			}),
		onFailure: () =>
			new RuntimeGateFailure({
				detail: "the shared lint's import and property bans are unreadable"
			})
	})
)

/** Runs one step of the gate to its end and answers its standard output; any exit but zero fails the gate. */
const run = Effect.fn("runtimeGate.run")(function* (
	step: string,
	command: string,
	args: ReadonlyArray<string>,
	directory: string
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [stdout, stderr, exitCode] = yield* Effect.scoped(
		Effect.flatMap(
			spawner.spawn(ChildProcess.make(command, [...args], { cwd: directory, extendEnv: true })),
			(handle) =>
				Effect.all(
					[
						Stream.mkString(Stream.decodeText(handle.stdout)),
						Stream.mkString(Stream.decodeText(handle.stderr)),
						handle.exitCode
					],
					{ concurrency: "unbounded" }
				)
		)
	).pipe(Effect.mapError(() => new RuntimeGateFailure({ detail: `${step} could not run` })))
	if (exitCode !== 0) {
		return yield* new RuntimeGateFailure({
			detail: `${step} exited with ${String(exitCode)}:\n${stdout}${stderr}`
		})
	}
	return stdout
})

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const node = yield* Effect.sync(() => process.execPath)
	const scratch = yield* fs
		.makeTempDirectoryScoped()
		.pipe(
			Effect.mapError(
				() => new RuntimeGateFailure({ detail: "no scratch directory could be made" })
			)
		)
	const out = path.join(scratch, "cli")
	const refusals = yield* run(
		"generation",
		node,
		[
			"src/bin.ts",
			"generate",
			`${FIXTURE}/openapi.json`,
			"--config",
			`${FIXTURE}/author-config.json`,
			"--out",
			out,
			"--report",
			"json"
		],
		PACKAGE
	).pipe(
		Effect.flatMap((stdout) =>
			Effect.fromResult(refusalsOf(stdout)).pipe(
				Effect.mapError(
					() => new RuntimeGateFailure({ detail: "the generation report is unreadable" })
				)
			)
		)
	)
	const unexpected = Arr.filter(
		refusals,
		(refusal) => !Str.endsWith(TOKEN_ACQUISITION)(refusal.code)
	)
	if (Arr.isReadonlyArrayNonEmpty(unexpected)) {
		return yield* new RuntimeGateFailure({
			detail: Arr.join(
				[
					"the generator refused part of the runtime-gate fixture, so it no longer reaches the whole runtime:",
					...Arr.map(unexpected, (refusal) => `  ${refusal.code} at ${refusal.pointer}`)
				],
				"\n"
			)
		})
	}
	yield* fs
		.symlink(path.resolve(ROOT, "node_modules"), path.join(out, "node_modules"))
		.pipe(
			Effect.mapError(
				() => new RuntimeGateFailure({ detail: "the workspace's dependencies could not be linked" })
			)
		)
	yield* run("the generated package's typecheck", node, ["--run", "typecheck"], out)
	const lint = path.join(scratch, "emitted.oxlintrc.json")
	yield* emittedLint.pipe(
		Effect.flatMap((text) => fs.writeFileString(lint, text)),
		Effect.mapError(
			() =>
				new RuntimeGateFailure({
					detail: "the emitted package's lint configuration could not be written"
				})
		)
	)
	yield* run(
		"the shared lint bans over the generated package",
		node,
		[path.resolve(ROOT, "node_modules/oxlint/bin/oxlint"), "-c", lint, "src"],
		out
	)
	yield* Console.log(
		"runtime gate: the runtime-gate fixture's generated package typechecks and holds the shared lint bans."
	)
})

NodeRuntime.runMain(
	main.pipe(
		Effect.scoped,
		Effect.catchTag("RuntimeGateFailure", (failure) =>
			Effect.flatMap(Console.error(`runtime gate: ${failure.detail}`), () =>
				Effect.sync(() => {
					process.exitCode = 1
				})
			)
		),
		Effect.provide(NodeServices.layer)
	)
)
