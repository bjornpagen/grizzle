#!/usr/bin/env -S node

import { DevtoolFailure, failureFrom } from "@bjornpagen/devtools/devtool"
import { runDevtool } from "@bjornpagen/devtools/run"
import { regex } from "arkregex"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Option,
	Path,
	Record,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"

/**
 * The codemod of grizzle's hard cutover to one-list connectives: r.and, r.or, Logic.and, Logic.or and a row check's and
 * and or take one readonly list of predicates (`and([p, q])`), the variadic form gone. A repository that takes a grizzle
 * past the cutover runs its typecheck once, which refuses each call of the old form, and hands its output to this
 * script, which rewrites exactly the calls the typecheck refused, each at the position its diagnostic names, by the
 * plugin beside it (connective-list-plugin.ts, run by the repository's own oxlint with --fix): `and(p, q)` is
 * `and([p, q])`, `and(...ps)` is `and(ps)`, `and(...ps, q)` is `and([...ps, q])`, `and()` is `and([])` and `and(p)` is
 * `and([p])`. No other call changes: which `and` is grizzle's is the typecheck's to know, never a name's, and a call the
 * typecheck accepts is left as it is. The printed SQL and the stored laws are the same, the same flat connective over
 * the same predicates. From the repository's root, on a tree whose typecheck was clean before the bump:
 *
 *   pnpm types > typecheck.log 2>&1
 *   pnpm exec node vendor/grizzle/scripts/dev/connective-list.ts typecheck.log
 *
 * then the typecheck again, which names no connective, and the formatter on the files it changed. The log is the
 * typecheck's output as turbo prints it (each line under its package's name, `<package>:typecheck: <file>(line,col):
 * error TS...`, a file relative to that package), as `pnpm -r` prints it (each line under its package's directory,
 * `<directory> typecheck: <file>(line,col): error TS...`, a file relative to that directory), or as one tsgo run prints
 * it from the root. Only turbo's names a package by a name, which `turbo ls` maps to its directory.
 */

/** turbo's prefix of a line: the package's name and the task, `<package>:typecheck: `. */
const TURBO_PREFIX = regex("^(\\S+):[\\w:-]+: (.*)$", "u")

/** pnpm's prefix of a line: the package's directory and the script, `<directory> typecheck: `. */
const PNPM_PREFIX = regex("^(\\S+) [\\w:-]+: (.*)$", "u")

/** A diagnostic, its prefix read off: tsgo's file, line, column, code and message. */
const DIAGNOSTIC = regex("^(.+?)\\((\\d+),(\\d+)\\): error (TS\\d+): (.*)$", "u")

/** A refusal of an argument that is not the list a one-list parameter takes. */
const LIST_PARAMETER = regex("parameter of type 'readonly [^']*\\[\\]", "u")

/** A refusal of a call's arity, where the callee takes one argument, and how many the call passed. */
const ARITY = regex("^Expected 1 arguments, but got (\\d+)\\.", "u")

/** What the typecheck said of a call (connective-list-plugin.ts Said), by its code and message, or nothing for any other
 * diagnostic. */
const saidOf = (
	code: string,
	message: string
): Option.Option<"excess" | "none" | "spread" | "single"> => {
	if (code === "TS2556") {
		return Option.some("spread")
	}
	if (code === "TS2345" && LIST_PARAMETER.test(message)) {
		return Option.some("single")
	}
	const got = ARITY.exec(message)
	if (code !== "TS2554" || got === null) {
		return Option.none()
	}
	return Option.some(got[1] === "0" ? "none" : "excess")
}

/** Where a diagnostic's file is relative to: the root, a package turbo names, or a directory pnpm names. */
type Base =
	| { readonly kind: "root" }
	| { readonly kind: "package"; readonly name: string }
	| { readonly kind: "directory"; readonly path: string }

/** A refused call: what its file is relative to, the file, and where. */
type Refused = Readonly<{
	base: Base
	file: string
	line: number
	column: number
	said: "excess" | "none" | "spread" | "single"
}>

/** A line's base and the diagnostic after its prefix: turbo's, pnpm's, or the root's where it carries none. Neither
 * prefix reads a root-relative diagnostic, whose first space follows its position's colon. */
const prefixOf = (line: string): { readonly base: Base; readonly rest: string } => {
	const turbo = TURBO_PREFIX.exec(line)
	if (turbo !== null) {
		return { base: { kind: "package", name: turbo[1] }, rest: turbo[2] }
	}
	const pnpm = PNPM_PREFIX.exec(line)
	return pnpm === null
		? { base: { kind: "root" }, rest: line }
		: { base: { kind: "directory", path: pnpm[1] }, rest: pnpm[2] }
}

const refusedOf = (line: string): ReadonlyArray<Refused> => {
	const { base, rest } = prefixOf(line)
	const match = DIAGNOSTIC.exec(rest)
	if (match === null) {
		return []
	}
	const [, file, at, column, code, message] = match
	return Option.match(saidOf(code, message), {
		onNone: () => [],
		onSome: (said) => [{ base, file, line: Number(at), column: Number(column), said }]
	})
}

/** A command's standard output, failing where it fails. */
const outputOf = Effect.fn("outputOf")(function* (command: string, args: ReadonlyArray<string>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [output, status] = yield* Effect.scoped(
		Effect.flatMap(spawner.spawn(ChildProcess.make(command, args, { stdin: "ignore" })), (handle) =>
			Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
				concurrency: "unbounded"
			})
		)
	).pipe(Effect.mapError(failureFrom(`${command} could not be run`)))
	return { output, status: Number(status) }
})

/** The diagnosed calls of each file, as the plugin reads its option. */
type Targets = Readonly<
	Record<string, ReadonlyArray<Readonly<{ line: number; column: number; said: Refused["said"] }>>>
>

/** A property of a value read as JSON, if the value is an object that holds it. */
const field = (value: unknown, name: string): unknown =>
	typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined

/** turbo ls --output=json's packages, each its name and directory: the items that read as one. */
const packagesListed = (listed: unknown): ReadonlyArray<readonly [string, string]> => {
	const items = field(field(listed, "packages"), "items")
	return Arr.isArray(items)
		? Arr.flatMap(items, (item) => {
				const name = field(item, "name")
				const directory = field(item, "path")
				return typeof name === "string" && typeof directory === "string"
					? [[name, directory] as const]
					: []
			})
		: []
}

/** Each workspace package's directory by the name turbo prints, "//" the root's ("."). */
const packageDirectories = Effect.gen(function* () {
	const listed = yield* outputOf("turbo", ["ls", "--output=json"])
	const parsed = yield* Effect.try({
		try: () => trustedJson<unknown>(listed.output),
		catch: failureFrom("turbo ls --output=json printed no JSON")
	})
	return new Map<string, string>([["//", "."], ...packagesListed(parsed)])
})

/** Whether a refusal names its file by a package turbo must map to a directory. */
const named = (call: Refused): boolean => call.base.kind === "package"

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const given = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const [log] = given
	if (log === undefined || given.length !== 1) {
		return yield* DevtoolFailure.make({
			detail:
				"Name the typecheck's output: node vendor/grizzle/scripts/dev/connective-list.ts typecheck.log"
		})
	}
	const text = yield* fs
		.readFileString(log)
		.pipe(Effect.mapError(failureFrom(`${log} could not be read`)))
	const refused = Arr.flatMap(Str.split("\n")(text), refusedOf)
	if (!Arr.isReadonlyArrayNonEmpty(refused)) {
		yield* Console.log("connective-list: the typecheck refused no call of the old connective form")
		return 0
	}
	const directories = Arr.some(refused, named)
		? yield* packageDirectories
		: new Map<string, string>()
	const located = yield* Effect.forEach(refused, (call) => {
		const base = call.base
		switch (base.kind) {
			case "root":
				return Effect.succeed({ ...call, file: path.resolve(".", call.file) })
			case "directory":
				return Effect.succeed({ ...call, file: path.resolve(base.path, call.file) })
			case "package": {
				const directory = directories.get(base.name)
				return directory === undefined
					? DevtoolFailure.make({
							detail: `turbo names no package ${base.name}, whose ${call.file} the log names`
						})
					: Effect.succeed({ ...call, file: path.resolve(directory, call.file) })
			}
		}
	})
	const files = Arr.dedupe(Arr.map(located, (call) => call.file))
	const targets: Targets = Record.fromEntries(
		Arr.map(files, (file) => [
			file,
			Arr.map(
				Arr.filter(located, (call) => call.file === file),
				({ line, column, said }) => ({ line, column, said })
			)
		])
	)
	const scratch = yield* fs
		.makeTempDirectoryScoped({ prefix: "connective-list-" })
		.pipe(Effect.mapError(failureFrom("a scratch directory could not be made")))
	const config = path.join(scratch, ".oxlintrc.json")
	const configText = jsonText({
		plugins: [],
		categories: { correctness: "off" },
		jsPlugins: [path.join(import.meta.dirname, "connective-list-plugin.ts")],
		rules: { "grizzle-connective/rewrite": ["error", { targets }] }
	})
	yield* fs
		.writeFileString(config, configText)
		.pipe(Effect.mapError(failureFrom(`${config} could not be written`)))
	const fixed = yield* outputOf("oxlint", ["-c", config, "--fix", ...files])
	yield* Console.log(fixed.output)
	yield* Console.log(
		`connective-list: ${located.length} refusal(s) in ${files.length} file(s) handed to the rewrite; run the typecheck again, then the formatter on those files`
	)
	return 0
})

runDevtool(Effect.scoped(main))
