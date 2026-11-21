import { word } from "@bjornpagen/testing/dictionary"
import { constant, element, finite, type FiniteSpace, type Gen, int } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Data,
	Duration,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	String as Str
} from "effect"
import { type InvocationFeature, invocationFeatures } from "#test/generated/lazy-root.dictionary.ts"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	runBin,
	workerFixture
} from "#test/support/cli-package.ts"
import { printedText } from "#test/support/printed.ts"

/** What the lazy-root properties (lazy-root.test.ts) exhaust and their fixture: the package and its eager oracle. */

/** The eager oracle's groups module: every entry's real module loaded, the arguments ignored. */
const EAGER_GROUPS = `import { Effect } from "effect";
import type { Entry, Group } from "./groups.ts";

export const root = <E, R, C>(
  table: readonly Entry<E, R>[],
  header: (groups: readonly Group<E, R>[]) => C,
  _args: readonly string[],
): Effect.Effect<C> =>
  Effect.forEach(table, (entry) =>
    Effect.promise(() => entry.load()).pipe(Effect.map((module) => module.group)),
  ).pipe(Effect.map(header));
`

/** A generated module that does not hold exactly one occurrence of the text the oracle rewrites. */
class OracleRewriteFailed extends Data.TaggedError("OracleRewriteFailed")<{
	readonly module: string
	readonly text: string
}> {}

/** The rewrites that make the eager oracle: each copies a generated module with one import pointed elsewhere. */
const REWRITES: ReadonlyArray<Readonly<{ from: string; to: string; text: string; into: string }>> =
	[
		{
			from: "src/cli/root.ts",
			to: "src/cli/eager-root.ts",
			text: 'import * as Groups from "../runtime/groups.ts";',
			into: 'import * as Groups from "../runtime/eager-groups.ts";'
		},
		{
			from: "src/main.ts",
			to: "src/eager-main.ts",
			text: '"./cli/root.ts"',
			into: '"./cli/eager-root.ts"'
		},
		{ from: "src/bin.ts", to: "src/eager-bin.ts", text: '"./main.ts"', into: '"./eager-main.ts"' }
	]

/** The header key every request run carries. */
export const KEY = "lazy-root-key"

/** An empty `200`. */
export const listed: ScriptedResponse = {
	status: 200,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

/**
 * The suite's fixture, once per worker: the capture server, the lazy package, its eager oracle, and every generated
 * command path.
 */
export const lazyFixture = workerFixture(
	"test/generated/lazy-root.fixtures.ts lazyFixture",
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const source = path.join(import.meta.dirname, "..", "fixtures", "lazy-root")
		const server = yield* captureServer
		const generated = yield* generateFixture({
			spec: {
				path: "openapi.json",
				text: yield* fs.readFileString(path.join(source, "openapi.json"))
			},
			config: {
				path: "author-config.json",
				text: yield* fs.readFileString(path.join(source, "author-config.json"))
			},
			authorFiles: [
				{
					path: "custom/commands.ts",
					text: yield* fs.readFileString(path.join(source, "custom", "commands.ts"))
				}
			]
		})
		yield* fs.writeFileString(path.join(generated.dir, "src/runtime/eager-groups.ts"), EAGER_GROUPS)
		yield* Effect.forEach(
			REWRITES,
			(rewrite) =>
				Effect.gen(function* () {
					const text = yield* fs.readFileString(path.join(generated.dir, rewrite.from))
					const pieces = Str.split(rewrite.text)(text)
					if (pieces.length !== 2) {
						return yield* new OracleRewriteFailed({ module: rewrite.from, text: rewrite.text })
					}
					yield* fs.writeFileString(
						path.join(generated.dir, rewrite.to),
						Arr.join(pieces, rewrite.into)
					)
				}),
			{ discard: true }
		)
		const lazy = yield* buildPackage(generated)
		const commands = yield* Effect.fromOption(
			Arr.match(
				Arr.map(generated.result.report.commandNames, (name) => name.path),
				{
					onEmpty: () => Option.none(),
					onNonEmpty: (paths) => Option.some(paths)
				}
			)
		)
		const petsList = yield* Effect.fromOption(
			Arr.findFirst(
				generated.result.report.commandNames,
				(name) => name.pointer === "/paths/~1pets/get"
			)
		)
		const opened: Readonly<{
			server: CaptureServer
			lazy: BuiltPackage
			eager: BuiltPackage
			commands: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>
			petsList: ReadonlyArray<string>
		}> = {
			server,
			lazy,
			eager: { dir: lazy.dir, bin: path.join(lazy.dir, "dist", "src", "eager-bin.js") },
			commands,
			petsList: petsList.path
		}
		return opened
	})
)

/** What a run printed, as the differential compares it. */
export type Printed = Readonly<{ exitCode: number; stdout: string; stderr: string }>

/** Runs a build's bin with these arguments and no environment, and what it printed. */
export const printedBy = (built: BuiltPackage, args: ReadonlyArray<string>) =>
	Effect.map(runBin(built, { args, env: {}, stdin: new Uint8Array(0) }), (run): Printed => ({
		exitCode: run.exitCode,
		stdout: printedText(run.stdout),
		stderr: printedText(run.stderr)
	}))

/** A specifier the built root imports by `import()`. */
const DYNAMIC_IMPORT = regex('import\\("([^"]+)"\\)', "gu")

/** A specifier that still names a `.ts` module. */
export const TS_SPECIFIER = regex("\\.ts[\"']", "u")

/** What the built roots show of their loading: each `import()` specifier, sorted, and any `.ts` specifier left. */
export type Loading = Readonly<{
	lazyImports: ReadonlyArray<string>
	lazyNamesTs: boolean
	eagerImports: ReadonlyArray<string>
	eagerLoadsEveryGroup: boolean
}>

export const importsOf = (text: string): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(Arr.fromIterable(Str.matchAll(DYNAMIC_IMPORT)(text)), ([, specifier]) =>
			Option.toArray(Option.fromNullishOr(specifier))
		),
		Order.String
	)

/** The top-level groups: the first segment of every command path below a group, each once, sorted. */
export const topLevelGroups = (
	commands: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.dedupe(
			Arr.flatMap(commands, (command) =>
				command.length > 1 ? Option.toArray(Arr.head(command)) : []
			)
		),
		Order.String
	)

/** An invocation the differential runs, by what it names. */
type Invocation = Readonly<{ kind: InvocationFeature; args: ReadonlyArray<string> }>

/** The differential's cases: each kind of invocation, every invocation of that kind the package has. */
export const invocationKinds: FiniteSpace<InvocationFeature> = finite(word(invocationFeatures))

/** The invocations at the root. */
const ROOT_INVOCATIONS: Arr.NonEmptyReadonlyArray<Invocation> = [
	{ kind: "the root's help", args: ["--help"] },
	{ kind: "no arguments", args: [] },
	{ kind: "--describe", args: ["--describe"] },
	{ kind: "--completions bash", args: ["--completions", "bash"] },
	{ kind: "an unknown group", args: ["nosuch"] }
]

/** Every invocation the differential runs: the root's, each top-level group's, and each command's help. */
export const invocationsOf = (
	commands: ReadonlyArray<ReadonlyArray<string>>
): Arr.NonEmptyReadonlyArray<Invocation> =>
	Arr.appendAll(
		ROOT_INVOCATIONS,
		Arr.appendAll(
			Arr.flatMap(topLevelGroups(commands), (group): ReadonlyArray<Invocation> => [
				{ kind: "a group alone", args: [group] },
				{ kind: "a group's help", args: [group, "--help"] },
				{ kind: "an unknown command in a group", args: [group, "nosuch"] }
			]),
			Arr.map(commands, (command): Invocation => ({
				kind: "a command's help",
				args: Arr.append(command, "--help")
			}))
		)
	)

/** Where a global flag goes: before the group name, or after the command's own arguments. */
export type Placement = "before the group" | "after the arguments"

/** A request run: where each global flag goes, and the limit it lists. */
type RequestCase = Readonly<{ baseUrl: Placement; allow: Placement; limit: number }>

const PLACEMENT: Gen<Placement> = element<Placement>(["before the group", "after the arguments"])

/** Each global flag before the group or after the arguments, under a limit of 1 or 2. */
export const requestCases: FiniteSpace<RequestCase> = finite((source) => ({
	baseUrl: source.draw(PLACEMENT),
	allow: source.draw(PLACEMENT),
	limit: source.draw(int(1, 2))
}))

/** A situation a request run reaches. */
export type RequestFeature =
	| "every global flag before the group"
	| "every global flag after the arguments"
	| "global flags on both sides"

export const requestFeature = (c: RequestCase): RequestFeature => {
	if (c.baseUrl === c.allow) {
		return c.baseUrl === "before the group"
			? "every global flag before the group"
			: "every global flag after the arguments"
	}
	return "global flags on both sides"
}

/** A request as the oracle compares it: the run's exit code, and each request's method, target and key. */
export type Requested = Readonly<{
	exitCode: number
	requests: ReadonlyArray<Readonly<{ method: string; target: string; key: ReadonlyArray<string> }>>
}>

/** The one build the box holds: the lazy package and its eager oracle, built once. */
export const theBuild: FiniteSpace<"the lazy package"> = finite(constant("the lazy package"))
