import { fileURLToPath } from "node:url"
import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { type Json, jsonText } from "@bjornpagen/grizzle-text/utf8"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	type PlatformError,
	String as Str
} from "effect"
import type { DraftRequest } from "#cli/args.ts"
import { type CliError, cliError, DraftInputUnread } from "#cli/errors.ts"
import { visibleEntries } from "#cli/files.ts"
import { sha256Hex } from "#compiler/plan/common.ts"
import { namedSpelling } from "#compiler/plan/migration.ts"

/**
 * What a draft is a function of: every input `grizzle generate` reads that can reach what it writes, named once, as
 * data (draftInputs), and read and digested by one code (draftKey, the key `grizzle draft-key` prints), so the inputs
 * the README names (its generate section, which the README's mirror holds to each member's `readme`), the inputs the
 * key digests and the inputs a traced generate reads are one roster (test/unit/cli/draft-key.test.ts).
 *
 * A draft is grizzle's compile of its configuration over its committed migrations directory, under its command line's
 * flags: what it reads is those, grizzle's own code, the packages both load, and the Node that runs it. Nothing else
 * reaches it: no clock, no environment variable but those Node reads of its own, no path but the ones these name, and
 * no order of a directory's listing (cli/files.ts visibleEntries sorts each).
 */

/**
 * What one run observed of its inputs, from which each member reads its own: the request, the configuration file and
 * every module its import loaded, the migrations directory the configuration names, the grizzle checkout whose
 * packages run the command, and the Node that runs it.
 */
export interface DraftContext {
	readonly request: DraftRequest
	/** The configuration file, absolute. */
	readonly config: string
	/** Every file module the configuration's import loaded, absolute: the configuration file's own, and what it loads. */
	readonly closure: ReadonlyArray<string>
	/** The configuration's migrations directory, absolute (cli/config.ts ResolvedConfig migrations). */
	readonly migrations: string
	/** The grizzle checkout: the directory holding its packages (grizzleCheckout). */
	readonly grizzle: string
	/** The Node that runs the command: its version (process.version). */
	readonly node: string
}

/** One input a member reads: what names it within its member, and its bytes. */
interface DraftItem {
	readonly label: string
	readonly bytes: Uint8Array
}

type Gathered = Effect.Effect<
	ReadonlyArray<DraftItem>,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
>

/** A member of the roster: the README's text of it, word for word, and how it reads what it names. */
interface DraftInputMember {
	readonly readme: string
	readonly gather: (context: DraftContext) => Gathered
}

/** The directory holding grizzle's packages, absolute: three directories up from packages/grizzle/src/cli/. */
const packagesDirectory = fileURLToPath(new URL("../../../../packages", import.meta.url))

/** The checkout this module lies in, absolute: the directory holding packages/ (packagesDirectory). */
export const grizzleCheckout: string = Str.slice(0, -"/packages".length)(packagesDirectory)

/** The packages of grizzle a command loads, each under the checkout's packages/: the text, the engine, the OpenAPI
 * document's writer, and the shell. */
export const grizzlePackages = ["text", "engine", "openapi", "grizzle"] as const

/** The file that pins a pnpm workspace's packages: every package a module loads through node_modules is its entry. */
export const lockfileName = "pnpm-lock.yaml"

/** Whether a path is a package's file, reached through a node_modules directory: the lockfile names it. */
export const isPackageFile = (path: string): boolean =>
	Arr.contains(Str.split(path, "/"), "node_modules")

/** Whether a path is a file of grizzle's packages in the checkout at `grizzle`: a package's package.json, or under its src/. */
export const isGrizzleFile = (grizzle: string, path: string): boolean =>
	Arr.some(
		grizzlePackages,
		(p) =>
			path === `${grizzle}/packages/${p}/package.json` ||
			Str.startsWith(`${grizzle}/packages/${p}/src/`)(path)
	)

/** Whether `path` is `directory` or lies under it with no hidden entry between (files.ts visibleEntries). */
export const isVisibleUnder = (directory: string, path: string): boolean =>
	path === directory ||
	(Str.startsWith(`${directory}/`)(path) &&
		Arr.every(
			Str.split(Str.slice(directory.length + 1)(path), "/"),
			(part) => part !== "" && !Str.startsWith(".")(part)
		))

const encoder = new TextEncoder()

const text = (value: string): Uint8Array => encoder.encode(value)

/**
 * A request as the key reads it: what generate makes and its folder's name (none for one named after its change), the
 * schema `--schema` chooses (none for every one), and each declared rename and drop, spelled as the flags spell it.
 */
const requestJson = (request: DraftRequest): Json => {
	const mode = request.mode
	return {
		mode: mode.kind,
		name:
			mode.kind === "custom" ? mode.name : mode.naming.kind === "named" ? mode.naming.name : null,
		schema: Option.getOrNull(request.schema),
		renames: Arr.map(request.declared.renames, (r) => [namedSpelling(r.from), namedSpelling(r.to)]),
		drops: Arr.map(request.declared.drops, namedSpelling)
	}
}

/** Every file under `directory`, by its path from `root`, with its bytes; directories walked in code-unit order. */
const filesUnder = (
	root: string,
	directory: string,
	visible: boolean
): Effect.Effect<
	ReadonlyArray<DraftItem>,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const listed = yield* fs.readDirectory(directory)
		const names = visible ? yield* visibleEntries(fs, directory) : Arr.sort(listed, Order.String)
		const items: Array<DraftItem> = []
		for (const name of names) {
			const at = path.join(directory, name)
			const label = path.relative(root, at)
			const info = yield* fs.stat(at)
			if (info.type === "Directory") {
				items.push({ label: `${label}/`, bytes: new Uint8Array() })
				const under = yield* filesUnder(root, at, visible)
				appendAll(items, under)
			} else {
				items.push({ label, bytes: yield* fs.readFile(at) })
			}
		}
		return items
	})

/** The nearest lockfile at or above `directory`, or none. */
const lockfileAbove = (
	directory: string
): Effect.Effect<
	Option.Option<string>,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const here = path.join(directory, lockfileName)
		if (yield* fs.exists(here)) {
			return Option.some(here)
		}
		const up = path.dirname(directory)
		return up === directory ? Option.none() : yield* lockfileAbove(up)
	})

/**
 * The variables Node's own code reads as it runs a command, its module loader's and its compile cache's: the only
 * variables a draft's process reads (draftInputs.node), none of which reaches what it writes.
 */
export const nodeVariables: ReadonlyArray<string> = [
	"NODE_COMPILE_CACHE",
	"NODE_COMPILE_CACHE_PORTABLE",
	"NODE_COMPILE_CACHE_READONLY",
	"NODE_V8_COVERAGE",
	"WATCH_REPORT_DEPENDENCIES"
]

/**
 * The roster of a draft's inputs, in the order the key digests them. Each member's `readme` is the README's text of it,
 * word for word (its generate section), and its `gather` reads exactly what that text names, by what names it there:
 * never an absolute path, so one input at two paths is one input.
 */
export const draftInputs = {
	flags: {
		readme:
			"the command line's flags: `--name`, `--custom`, `--schema`, and each `--rename` and `--drop` in order, as generate reads them, never the configuration file's path or `--phases`, which writes to stderr alone",
		gather: (context) =>
			Effect.succeed([
				{
					label: "request",
					bytes: text(jsonText(requestJson(context.request)))
				}
			])
	},
	configuration: {
		readme:
			"the configuration: the configuration file's bytes, and every module its import loads but grizzle's and a package's, each by its path from the configuration file's directory and its bytes",
		gather: (context) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const directory = path.dirname(context.config)
				const own = Arr.filter(
					context.closure,
					(m) => m !== context.config && !isGrizzleFile(context.grizzle, m) && !isPackageFile(m)
				)
				const modules = yield* Effect.forEach(own, (m) =>
					Effect.map(fs.readFile(m), (bytes) => ({ label: path.relative(directory, m), bytes }))
				)
				return [
					{ label: "configuration file", bytes: yield* fs.readFile(context.config) },
					...modules
				]
			})
	},
	lockfile: {
		readme:
			"the lockfile: the `pnpm-lock.yaml` nearest above the configuration file, by its bytes, which names every package a module loads through `node_modules`, grizzle's dependencies among them",
		gather: (context) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const found = yield* lockfileAbove(path.dirname(context.config))
				return Option.isNone(found)
					? [{ label: "none", bytes: new Uint8Array() }]
					: [{ label: lockfileName, bytes: yield* fs.readFile(found.value) }]
			})
	},
	migrations: {
		readme:
			"the committed migrations directory: every visible entry of the directory the configuration's `migrations` names, by its path there and a file's bytes; an entry whose name starts with `.`, an editor's or the scratch a write passes through, is none",
		gather: (context) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				return (yield* fs.exists(context.migrations))
					? yield* filesUnder(context.migrations, context.migrations, true)
					: [{ label: ".", bytes: text("absent") }]
			})
	},
	grizzle: {
		readme:
			"grizzle: each of its packages' `package.json` and every file under its `src/` (text, engine, openapi and grizzle), by its path in the checkout and its bytes, which a commit of grizzle names",
		gather: (context) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const items = yield* Effect.forEach(grizzlePackages, (p) =>
					Effect.gen(function* () {
						const root = `${context.grizzle}/packages/${p}`
						const manifest = yield* fs.readFile(`${root}/package.json`)
						const sources = yield* filesUnder(context.grizzle, `${root}/src`, false)
						return [{ label: `packages/${p}/package.json`, bytes: manifest }, ...sources]
					})
				)
				return Arr.flatten(items)
			})
	},
	node: {
		readme: `Node: the version of the Node that runs it; the variables its own code reads (${Arr.join(
			Arr.map(nodeVariables, (v) => `\`${v}\``),
			", "
		)}) configure the runtime, never what a draft holds`,
		gather: (context) => Effect.succeed([{ label: "version", bytes: text(context.node) }])
	}
} as const satisfies Readonly<Record<string, DraftInputMember>>

/** A member of the roster, by its name. */
export type DraftInput = keyof typeof draftInputs

/** The roster's members, in the order the key digests them and the README lists them. */
export const draftInputOrder: Arr.NonEmptyReadonlyArray<DraftInput> = [
	"flags",
	"configuration",
	"lockfile",
	"migrations",
	"grizzle",
	"node"
]

/**
 * The key of a draft: the SHA-256, in hex, of every member's inputs in roster order, each input by its member, what
 * names it there and its bytes' SHA-256, as one JSON text: equal for equal inputs, wherever and whenever they are read,
 * and other wherever one input differs; an input that cannot be read is the refusal naming its member.
 */
export const draftKey = (
	context: DraftContext
): Effect.Effect<string, CliError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const digested: Array<readonly [DraftInput, string, string]> = []
		for (const input of draftInputOrder) {
			const items = yield* Effect.mapError(draftInputs[input].gather(context), (cause) =>
				cliError(new DraftInputUnread({ input, cause }))
			)
			for (const item of Arr.sort(
				items,
				Order.mapInput(Order.String, (i: DraftItem) => i.label)
			)) {
				digested.push([input, item.label, sha256Hex(item.bytes)])
			}
		}
		return sha256Hex(text(jsonText(digested)))
	})
