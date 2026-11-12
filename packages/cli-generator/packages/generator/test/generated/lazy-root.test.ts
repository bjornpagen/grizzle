/**
 * A generated CLI's root loads a top-level group's module only when the arguments select it (design 4.1 Lazy root),
 * and nothing an operator sees tells the lazy root from an eager one.
 *
 * - The built root imports each top-level group by `import()` of its built `.js` module, and no `.ts` specifier is
 *   left in it.
 * - Every invocation prints what an eager build of the same package prints, byte for byte, with the same exit code:
 *   the root's and each group's help, each command's help, an unknown group or command, `--describe` and
 *   `--completions bash`. The eager oracle is built inside the package by the same build: its root is the generated
 *   root over a groups module that loads every group's real module whatever the arguments select, never a stub.
 * - `--describe` from any command prints what the root's prints, and `--completions bash` names every command path.
 * - A global flag before the group name sends the same request as after the command's own arguments.
 *
 * One package from `test/fixtures/lazy-root` (nested tags, an author command), with the eager oracle beside it.
 *
 * Under the owner's swarm gate this suite has not been run yet, nor checked against plants.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { exhaust } from "@superstarter/testing/explore"
import { requiredInSpace } from "@superstarter/testing/features"
import { element, type Gen, int } from "@superstarter/testing/gen"
import { searched } from "@superstarter/testing/vitest"
import { regex } from "arkregex"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Order,
	Path,
	Schema,
	String as Str
} from "effect"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	harnessLayer,
	runBin
} from "#test/support/cli-package.ts"
import { valuesOf } from "#test/support/http.ts"

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
class OracleRewriteFailed extends Schema.TaggedError<
	OracleRewriteFailed,
	{ readonly brand: unique symbol }
>()("OracleRewriteFailed", { module: Schema.String, text: Schema.String }) {}

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
const KEY = "lazy-root-key"

/** An empty `200`. */
const listed: ScriptedResponse = {
	status: 200,
	headers: [],
	delay: Duration.zero,
	body: { kind: "complete", bytes: new Uint8Array(0) }
}

/** The suite's fixture: the capture server, the lazy package, its eager oracle, and every generated command path. */
class LazyFixture extends Context.Service<
	LazyFixture,
	Readonly<{
		server: CaptureServer
		lazy: BuiltPackage
		eager: BuiltPackage
		commands: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>
		petsList: ReadonlyArray<string>
	}>
>()("effect-openapi-cli-generator/test/generated/lazy-root.test/LazyFixture") {}

const fixture = Layer.effect(
	LazyFixture,
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
						return yield* OracleRewriteFailed.make({ module: rewrite.from, text: rewrite.text })
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
		return {
			server,
			lazy,
			eager: { dir: lazy.dir, bin: path.join(lazy.dir, "dist", "src", "eager-bin.js") },
			commands,
			petsList: petsList.path
		}
	})
).pipe(Layer.provideMerge(harnessLayer))

/** What a run printed, as the differential compares it. */
type Printed = Readonly<{ exitCode: number; stdout: string; stderr: string }>

const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8")

/** Runs a build's bin with these arguments and no environment, and what it printed. */
const printedBy = (built: BuiltPackage, args: ReadonlyArray<string>) =>
	Effect.map(runBin(built, { args, env: {}, stdin: new Uint8Array(0) }), (run): Printed => ({
		exitCode: run.exitCode,
		stdout: utf8(run.stdout),
		stderr: utf8(run.stderr)
	}))

/** A specifier the built root imports by `import()`. */
const DYNAMIC_IMPORT = regex('import\\("([^"]+)"\\)', "gu")

/** A specifier that still names a `.ts` module. */
const TS_SPECIFIER = regex("\\.ts[\"']", "u")

/** What the built roots show of their loading: each `import()` specifier, sorted, and any `.ts` specifier left. */
type Loading = Readonly<{
	lazyImports: ReadonlyArray<string>
	lazyNamesTs: boolean
	eagerImports: ReadonlyArray<string>
	eagerLoadsEveryGroup: boolean
}>

const importsOf = (text: string): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(Arr.fromIterable(Str.matchAll(DYNAMIC_IMPORT)(text)), ([, specifier]) =>
			Option.toArray(Option.fromNullishOr(specifier))
		),
		Order.String
	)

/** The top-level groups: the first segment of every command path below a group, each once, sorted. */
const topLevelGroups = (commands: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> =>
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

/** What an invocation names. */
type InvocationFeature =
	| "the root's help"
	| "no arguments"
	| "--describe"
	| "--completions bash"
	| "an unknown group"
	| "a group alone"
	| "a group's help"
	| "an unknown command in a group"
	| "a command's help"

/** The invocations at the root. */
const ROOT_INVOCATIONS: Arr.NonEmptyReadonlyArray<Invocation> = [
	{ kind: "the root's help", args: ["--help"] },
	{ kind: "no arguments", args: [] },
	{ kind: "--describe", args: ["--describe"] },
	{ kind: "--completions bash", args: ["--completions", "bash"] },
	{ kind: "an unknown group", args: ["nosuch"] }
]

/** Every invocation the differential runs: the root's, each top-level group's, and each command's help. */
const invocationsOf = (
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
type Placement = "before the group" | "after the arguments"

/** A request run: where each global flag goes, and the limit it lists. */
type RequestCase = Readonly<{ baseUrl: Placement; allow: Placement; limit: number }>

const PLACEMENT: Gen<Placement> = element<Placement>(["before the group", "after the arguments"])

const requestCaseOf: Gen<RequestCase> = (source) => ({
	baseUrl: PLACEMENT(source),
	allow: PLACEMENT(source),
	limit: int(1, 2)(source)
})

/** A situation a request run reaches. */
type RequestFeature =
	| "every global flag before the group"
	| "every global flag after the arguments"
	| "global flags on both sides"

const requestFeature = (c: RequestCase): RequestFeature => {
	if (c.baseUrl === c.allow) {
		return c.baseUrl === "before the group"
			? "every global flag before the group"
			: "every global flag after the arguments"
	}
	return "global flags on both sides"
}

/** A request as the oracle compares it: the run's exit code, and each request's method, target and key. */
type Requested = Readonly<{
	exitCode: number
	requests: ReadonlyArray<Readonly<{ method: string; target: string; key: ReadonlyArray<string> }>>
}>

layer(fixture, { excludeTestServices: true })("a generated CLI's lazy root", (it) => {
	it.effect("loads each top-level group by import() of its built module", () =>
		Effect.gen(function* () {
			const { lazy, commands } = yield* LazyFixture
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const lazyRoot = yield* fs.readFileString(path.join(lazy.dir, "dist/src/cli/root.js"))
			const eagerRoot = yield* fs.readFileString(path.join(lazy.dir, "dist/src/cli/eager-root.js"))
			const eagerGroups = yield* fs.readFileString(
				path.join(lazy.dir, "dist/src/runtime/eager-groups.js")
			)
			const groupModules = Arr.map(topLevelGroups(commands), (group) => `./${group}.js`)
			deepStrictEqual<Loading>(
				{
					lazyImports: importsOf(lazyRoot),
					lazyNamesTs: TS_SPECIFIER.test(lazyRoot),
					eagerImports: importsOf(eagerRoot),
					eagerLoadsEveryGroup:
						Str.includes('from "../runtime/eager-groups.js"')(eagerRoot) &&
						!Str.includes("stub")(eagerGroups) &&
						!Str.includes("selected")(eagerGroups)
				},
				{
					lazyImports: groupModules,
					lazyNamesTs: false,
					eagerImports: groupModules,
					eagerLoadsEveryGroup: true
				},
				"the root imports each group's built module, and the oracle loads every group"
			)
		})
	)

	it.effect("prints what the eager build prints, for every invocation", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { lazy, eager, commands } = yield* LazyFixture
				const invocations = invocationsOf(commands)
				return yield* exhaust(
					{
						suite: "lazy root against the eager oracle",
						generator: element(invocations),
						literal: Formatter.format,
						limit: invocations.length,
						coverage: requiredInSpace<InvocationFeature>([
							"the root's help",
							"no arguments",
							"--describe",
							"--completions bash",
							"an unknown group",
							"a group alone",
							"a group's help",
							"an unknown command in a group",
							"a command's help"
						]),
						caseHang: Duration.seconds(60)
					},
					(invocation, k) =>
						Effect.gen(function* () {
							k.note(invocation.kind)
							const fromLazy = yield* printedBy(lazy, invocation.args)
							const fromEager = yield* printedBy(eager, invocation.args)
							deepStrictEqual<Printed>(
								fromLazy,
								fromEager,
								"the lazy root prints what the eager one prints"
							)
						})
				)
			})
		)
	)

	it.effect("describes the whole tree from any command, and completes every command path", () =>
		Effect.gen(function* () {
			const { lazy, commands } = yield* LazyFixture
			const fromRoot = yield* printedBy(lazy, ["--describe"])
			const fromCommands = yield* Effect.forEach(commands, (command) =>
				printedBy(lazy, Arr.append(command, "--describe"))
			)
			const completions = yield* printedBy(lazy, ["--completions", "bash"])
			deepStrictEqual<
				Readonly<{
					describedExit: number
					fromCommands: ReadonlyArray<Printed>
					completionsExit: number
					uncompleted: ReadonlyArray<ReadonlyArray<string>>
				}>
			>(
				{
					describedExit: fromRoot.exitCode,
					fromCommands,
					completionsExit: completions.exitCode,
					uncompleted: Arr.filter(
						commands,
						(command) => !Str.includes(`_lazy_${Arr.join(command, "_")}()`)(completions.stdout)
					)
				},
				{
					describedExit: 0,
					fromCommands: Arr.map(commands, () => fromRoot),
					completionsExit: 0,
					uncompleted: []
				},
				"every command's --describe is the root's, and completions name every command"
			)
		})
	)

	it.effect("sends the same request wherever the global flags go", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { server, lazy, petsList } = yield* LazyFixture
				const origin = server.origins["127.0.0.1"]
				return yield* exhaust(
					{
						suite: "lazy root global flag placement",
						generator: requestCaseOf,
						literal: Formatter.format,
						limit: 8,
						coverage: requiredInSpace<RequestFeature>([
							"every global flag before the group",
							"every global flag after the arguments",
							"global flags on both sides"
						]),
						caseHang: Duration.seconds(60)
					},
					(c, k) =>
						Effect.gen(function* () {
							k.note(requestFeature(c))
							const flagsAt = (placement: Placement): ReadonlyArray<string> =>
								Arr.flatten([
									c.baseUrl === placement ? ["--base-url", origin] : [],
									c.allow === placement ? ["--allow-credentials-for-base-url"] : []
								])
							const observed = yield* server.observe(
								() => listed,
								runBin(lazy, {
									args: Arr.flatten([
										flagsAt("before the group"),
										petsList,
										["--limit", String(c.limit)],
										flagsAt("after the arguments")
									]),
									env: { LAZY_API_KEY: KEY },
									stdin: new Uint8Array(0)
								})
							)
							deepStrictEqual<Requested>(
								{
									exitCode: observed.result.exitCode,
									requests: Arr.map(observed.requests, (request) => ({
										method: request.method,
										target: request.target,
										key: valuesOf(request.headers, "x-api-key")
									}))
								},
								{
									exitCode: 0,
									requests: [
										{ method: "GET", target: `/pets?limit=${String(c.limit)}`, key: [KEY] }
									]
								},
								"the request is the same wherever the global flags go"
							)
						})
				)
			})
		)
	)
})
