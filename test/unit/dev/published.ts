import {
	Array as Arr,
	Effect,
	FileSystem,
	Path,
	Predicate,
	Record,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { trustedJson } from "#compiler/core/trusted.ts"
import { assert } from "#test/support/assert.ts"

/**
 * A package manifest's publishing fields, from a package.json the repository holds: its name, the files it publishes
 * besides its package.json, its entry points, the runtime dependencies a consumer's install brings beside it, and its
 * peers.
 */
type Manifest = {
	readonly name: string
	readonly files: ReadonlyArray<string>
	readonly exports: Record.ReadonlyRecord<string, string | Record.ReadonlyRecord<string, string>>
	readonly dependencies: Record.ReadonlyRecord<string, string>
	readonly peerDependencies: Record.ReadonlyRecord<string, string>
}

/** The shell's manifest: a package's fields and its bin. */
type ShellManifest = Manifest & { readonly bin: Record.ReadonlyRecord<string, string> }

/** The exit status of a child that succeeded. */
export const exitedCleanly = ChildProcessSpawner.ExitCode(0)

/**
 * The packages a consumer program installs beside grizzle, not the package: Vercel's, for its attachPool, the AWS signer
 * and Clerk's backend the README's programs import, and Node's types.
 */
const consumerDependencies = [
	"@vercel/functions",
	"@aws-sdk/rds-signer",
	"@clerk/backend",
	"@types/node"
] as const

/**
 * Runs `command` in `cwd` to completion, reading nothing, and returns its exit status and its whole standard output
 * and error; interrupting the test kills it.
 */
export const runChild = Effect.fnUntraced(function* (
	command: string,
	args: ReadonlyArray<string>,
	cwd: string
) {
	const handle = yield* ChildProcess.make(command, args, { cwd, stdin: "ignore" })
	const [stdout, stderr, exitCode] = yield* Effect.all(
		[
			Stream.mkString(Stream.decodeText(handle.stdout)),
			Stream.mkString(Stream.decodeText(handle.stderr)),
			handle.exitCode
		],
		{ concurrency: "unbounded" }
	)
	return { exitCode, stdout, stderr }
}, Effect.scoped)

/**
 * Every relative path an `exports` entry or a bin names. The engine's "./internal/<module>.ts" exports name the
 * modules the shell imports, one path per condition.
 */
const entryPaths = (
	manifest: Manifest,
	bin: Record.ReadonlyRecord<string, string>
): ReadonlyArray<string> => [
	...Arr.flatMap(Record.values(manifest.exports), (entry) =>
		Predicate.isString(entry) ? [entry] : Record.values(entry)
	),
	...Record.values(bin)
]

/** The engine publishes no bin. */
const noBin: Record.ReadonlyRecord<string, string> = {}

/** A scratch project whose node_modules holds the published packages as a consumer installs them. */
export interface PublishedProject {
	/** The repository's root. */
	readonly root: string
	/** The consumer's project directory, with a package.json of `"type": "module"`. */
	readonly project: string
	/** The shell's installed package directory, under the project's node_modules. */
	readonly shell: string
}

/**
 * The published packages, the shell and the engine it depends on, as a consumer installs them: built into a scratch
 * node_modules by the build `npm publish` runs (scripts/build.ts), each laid out with exactly the files its
 * package.json's "files" names, and with exactly their runtime dependencies and peers beside them, each from the
 * node_modules of the package that declares it, and the packages a consumer program adds. Each package.json's entry points,
 * `exports` and `bin`, lie inside the files it publishes, and the build emitted them. The project lives as long as the
 * scope.
 */
export const publishedProject = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = path.join(import.meta.dirname, "..", "..", "..")
	const manifestOf = (directory: string) =>
		fs.readFileString(path.join(root, "packages", directory, "package.json"))
	const engineText = yield* manifestOf("engine")
	const shellText = yield* manifestOf("grizzle")
	const engine = trustedJson<Manifest>(engineText)
	const shell = trustedJson<ShellManifest>(shellText)
	const published = [
		{ directory: "engine", manifest: engine, bin: noBin },
		{ directory: "grizzle", manifest: shell, bin: shell.bin }
	]
	const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-package-" })
	const project = path.join(scratch, "project")
	const modules = path.join(project, "node_modules")
	const built = yield* runChild(
		process.execPath,
		[path.join(root, "scripts", "build.ts"), modules],
		root
	)
	assert.equal(built.exitCode, exitedCleanly, `the build: ${built.stderr}`)
	for (const { directory, manifest, bin } of published) {
		const installed = path.join(modules, manifest.name)
		yield* Effect.forEach(
			["package.json", ...Arr.filter(manifest.files, (file) => file !== "dist")],
			(file) => fs.copy(path.join(root, "packages", directory, file), path.join(installed, file)),
			{ discard: true }
		)
		for (const entry of entryPaths(manifest, bin)) {
			assert.ok(
				entry === "./package.json" ||
					Arr.some(manifest.files, (file) => Str.startsWith(`./${file}/`)(entry)),
				`${manifest.name}: ${entry} lies outside the published files`
			)
			const exists = yield* fs.exists(path.join(installed, entry))
			assert.ok(exists, `${manifest.name}: ${entry} was not emitted`)
		}
	}
	const workspace = new Set(Arr.map(published, ({ manifest }) => manifest.name))
	const declared: ReadonlyArray<Readonly<{ name: string; from: string }>> = [
		...Arr.flatMap(published, ({ directory, manifest }) =>
			Arr.map(
				Arr.filter(
					[...Record.keys(manifest.dependencies), ...Record.keys(manifest.peerDependencies)],
					(name) => !workspace.has(name)
				),
				(name) => ({ name, from: path.join(root, "packages", directory, "node_modules", name) })
			)
		),
		...Arr.map(consumerDependencies, (name) => ({
			name,
			from: path.join(root, "node_modules", name)
		}))
	]
	yield* Effect.forEach(
		Arr.dedupeWith(declared, (a, b) => a.name === b.name),
		Effect.fnUntraced(function* ({ name, from }) {
			const link = path.join(modules, name)
			yield* fs.makeDirectory(path.dirname(link), { recursive: true })
			yield* fs.symlink(from, link)
		}),
		{ discard: true }
	)
	yield* fs.writeFileString(path.join(project, "package.json"), `{ "type": "module" }\n`)
	const result: PublishedProject = { root, project, shell: path.join(modules, shell.name) }
	return result
})
