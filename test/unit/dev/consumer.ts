import { Array as Arr, Effect, FileSystem, Path, Record, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { trustedJson } from "#compiler/core/trusted.ts"

/** What a consumer installs beside grizzle, from its package.json: its peers. */
type Manifest = {
	readonly name: string
	readonly peerDependencies: Record.ReadonlyRecord<string, string>
}

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

/** A scratch project that takes grizzle as a submodule consumer does. */
export interface ConsumerProject {
	/** The repository's root. */
	readonly root: string
	/** The consumer's project directory, with a package.json of `"type": "module"`. */
	readonly project: string
}

/**
 * A scratch project that takes grizzle as a git submodule consumer does, through its pnpm workspace: its node_modules
 * links `@bjornpagen/grizzle` to packages/grizzle, as pnpm links a workspace member, so Node and TypeScript reach the
 * package's source through its exports, under no condition, and every module of it lies outside node_modules by its
 * real path, where Node strips types. Beside it are the shell's peers, each from the shell's own node_modules, and the
 * packages a consumer program adds. The project lives as long as the scope.
 */
export const consumerProject = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = path.join(import.meta.dirname, "..", "..", "..")
	const shellDirectory = path.join(root, "packages", "grizzle")
	const shellText = yield* fs.readFileString(path.join(shellDirectory, "package.json"))
	const shell = trustedJson<Manifest>(shellText)
	const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-consumer-" })
	const project = path.join(scratch, "project")
	const modules = path.join(project, "node_modules")
	const linked: ReadonlyArray<Readonly<{ name: string; from: string }>> = [
		{ name: shell.name, from: shellDirectory },
		...Arr.map(Record.keys(shell.peerDependencies), (name) => ({
			name,
			from: path.join(shellDirectory, "node_modules", name)
		})),
		...Arr.map(consumerDependencies, (name) => ({
			name,
			from: path.join(root, "node_modules", name)
		}))
	]
	yield* Effect.forEach(
		linked,
		Effect.fnUntraced(function* ({ name, from }) {
			const link = path.join(modules, name)
			yield* fs.makeDirectory(path.dirname(link), { recursive: true })
			yield* fs.symlink(from, link)
		}),
		{ discard: true }
	)
	yield* fs.writeFileString(path.join(project, "package.json"), `{ "type": "module" }\n`)
	const result: ConsumerProject = { root, project }
	return result
})
