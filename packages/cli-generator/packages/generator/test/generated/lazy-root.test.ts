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
 * One package from `test/fixtures/lazy-root` (nested tags, an author command), with the eager oracle beside it, built
 * once a worker; the differential is an exhaustion of the kinds of invocation, each case every invocation of its kind.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import {
	importsOf,
	type InvocationFeature,
	invocationKinds,
	invocationsOf,
	KEY,
	lazyFixture,
	listed,
	type Loading,
	type Placement,
	type Printed,
	printedBy,
	requestCases,
	type Requested,
	type RequestFeature,
	requestFeature,
	theBuild,
	topLevelGroups,
	TS_SPECIFIER
} from "#test/generated/lazy-root.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"
import { valuesOf } from "#test/support/http.ts"

/** The built root imports each top-level group by `import()` of its built module, and the oracle loads every group. */
export const lazyLoading = property.exhaust(theBuild, {
	box: "the lazy package's built root and its eager oracle's",
	needs: { fixture: lazyFixture, checkout: Checkout.dir },
	situations: [],
	check:
		({ fixture }) =>
		() =>
			Effect.gen(function* () {
				const { lazy, commands } = yield* fixture
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const lazyRoot = yield* fs.readFileString(path.join(lazy.dir, "dist/src/cli/root.js"))
				const eagerRoot = yield* fs.readFileString(
					path.join(lazy.dir, "dist/src/cli/eager-root.js")
				)
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
			}),
	oracle: {
		kind: "specification",
		name: "design 4.1's lazy root: one import() of each top-level group's built .js module, and no .ts specifier"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/emit/printer.ts",
			original: `\t\tDynamicImport: (entry) => \`import(\${stringLiteral(entry.from)})\`,`,
			replacement: `\t\tDynamicImport: (entry) => \`import(\${stringLiteral(entry.from)} + "")\`,`,
			why: "A group's import() takes an expression, not a literal, which the build does not rewrite, so the built root imports ./<group>.ts, a module dist never holds; the property fails."
		}
	]
})

/** Every invocation prints what the eager build prints, byte for byte, with the same exit code. */
export const lazyDifferential = property.exhaust(invocationKinds, {
	box: "every kind of help, unknown name, --describe and --completions bash invocation, each case every invocation of its kind the package's groups and commands make",
	needs: { fixture: lazyFixture, checkout: Checkout.dir },
	situations: [
		"the root's help",
		"no arguments",
		"--describe",
		"--completions bash",
		"an unknown group",
		"a group alone",
		"a group's help",
		"an unknown command in a group",
		"a command's help"
	],
	check:
		({ fixture }, k: Case<InvocationFeature>) =>
		(kind) =>
			Effect.gen(function* () {
				const { lazy, eager, commands } = yield* fixture
				const invocations = Arr.filter(
					invocationsOf(commands),
					(invocation) => invocation.kind === kind
				)
				yield* Effect.forEach(
					invocations,
					(invocation) =>
						Effect.gen(function* () {
							k.note(invocation.kind)
							const fromLazy = yield* printedBy(lazy, invocation.args)
							const fromEager = yield* printedBy(eager, invocation.args)
							deepStrictEqual<Printed>(
								fromLazy,
								fromEager,
								`the lazy root prints what the eager one prints for ${Arr.join(invocation.args, " ")}`
							)
						}),
					{ discard: true }
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "an eager build of the same package: the same bytes and the same exit code"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/groups.ts",
			original: "\tloadsAll(args) ||\n\tArr.some(",
			replacement: "\tArr.some(",
			why: "--describe and --completions load no group a name selects, so the lazy root describes and completes header-only stubs where the eager one walks every command; the property fails."
		}
	]
})

/** `--describe` from any command prints the root's, and `--completions bash` names every command path. */
export const lazyWholeTree = property.exhaust(theBuild, {
	box: "the lazy package's --describe from the root and from each command, and its bash completions",
	needs: { fixture: lazyFixture, checkout: Checkout.dir },
	situations: [],
	check:
		({ fixture }) =>
		() =>
			Effect.gen(function* () {
				const { lazy, commands } = yield* fixture
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
			}),
	oracle: {
		kind: "specification",
		name: "design 4.1: the whole-tree flags load every group, so every command's --describe is the root's and completions name every command"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/groups.ts",
			original: "\t[describeTrigger, completionsTrigger],",
			replacement: "\t[describeTrigger],",
			why: "--completions loads no group, so bash completions name only the root's own commands and no command below a group; the property fails."
		}
	]
})

/** A global flag before the group name sends the same request as after the command's own arguments. */
export const lazyGlobalFlags = property.exhaust(requestCases, {
	box: "each global flag before the group or after the arguments, under a limit of 1 or 2",
	needs: { fixture: lazyFixture, checkout: Checkout.dir },
	situations: [
		"every global flag before the group",
		"every global flag after the arguments",
		"global flags on both sides"
	],
	check:
		({ fixture }, k: Case<RequestFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const { server, lazy, petsList } = yield* fixture
				const origin = server.origins["127.0.0.1"]
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
						requests: [{ method: "GET", target: `/pets?limit=${String(c.limit)}`, key: [KEY] }]
					},
					"the request is the same wherever the global flags go"
				)
			}),
	oracle: {
		kind: "specification",
		name: "one request, carrying the key, wherever the global flags go"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/groups.ts",
			original:
				"\tArr.some(\n\t\targs,\n\t\t(arg) => arg === header.name || (header.alias !== undefined && arg === header.alias)\n\t)",
			replacement:
				"\t(args[0] === header.name || (header.alias !== undefined && args[0] === header.alias))",
			why: "A group is selected only when it is argv's first element, so a global flag before the group name leaves the group a header-only stub and its command unknown; the property fails."
		}
	]
})
