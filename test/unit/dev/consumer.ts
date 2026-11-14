import { createServer } from "node:net"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	type PlatformError,
	Path,
	Record,
	Stream
} from "effect"
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
 * Runs `command` in `cwd` to completion, its environment this process's with `env` over it, reading nothing, and
 * returns its exit status and its whole standard output and error; interrupting the test kills it.
 */
export const runChild = Effect.fnUntraced(function* (
	command: string,
	args: ReadonlyArray<string>,
	cwd: string,
	env: Readonly<Record.ReadonlyRecord<string, string>>
) {
	const handle = yield* ChildProcess.make(command, args, {
		cwd,
		env: { ...env },
		extendEnv: true,
		stdin: "ignore"
	})
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

/**
 * How a consumer's pnpm lays out what its workspace's members import: `isolated`, pnpm's default, each member's own
 * node_modules linking its dependencies, or `hoisted` (nodeLinker: hoisted, edullm's), every dependency in the
 * workspace root's node_modules and none under a member. Each is the directory whose node_modules a member's
 * dependencies go into, for the workspace's root and the member's directory.
 */
const dependencyHome = {
	isolated: (_workspace: string, member: string): string => member,
	hoisted: (workspace: string, _member: string): string => workspace
} as const

/** A layout of a consumer's install (dependencyHome). */
export type Layout = keyof typeof dependencyHome

/** Every layout of a consumer's install. */
export const layouts: ReadonlyArray<Layout> = Arr.map(
	Record.toEntries(dependencyHome),
	([layout]) => layout
)

/** A consumer's pnpm workspace that takes grizzle as a git submodule, installed in one layout. */
export interface SubmoduleConsumer {
	/** The submodule's checkout, vendor/grizzle: the repository's files, and never a node_modules of its own. */
	readonly checkout: string
	/** The consumer's own package, which depends on grizzle and its local cluster's package, effect and pg. */
	readonly project: string
	/** The directory whose node_modules hold the project's dependencies, as its layout puts them. */
	readonly modules: string
}

/** The repository's files a submodule checkout holds that the local cluster's commands and a migrate reach. */
const checkoutFiles = [
	"package.json",
	"scripts/pg",
	"packages/engine/package.json",
	"packages/engine/src",
	"packages/grizzle/package.json",
	"packages/grizzle/src",
	"packages/pg/package.json",
	"packages/pg/bin",
	"packages/pg/src"
] as const

/** The checkout's workspace members, by their directory under packages/. */
const members = ["engine", "grizzle", "pg"] as const

/** What a workspace member depends on, from its package.json. */
type MemberManifest = {
	readonly name: string
	readonly dependencies?: Record.ReadonlyRecord<string, string>
	readonly devDependencies?: Record.ReadonlyRecord<string, string>
	readonly peerDependencies?: Record.ReadonlyRecord<string, string>
}

/** The packages the consumer's project depends on itself: grizzle's peers it passes in. */
const projectDependencies = ["effect", "pg"] as const

/**
 * A consumer's pnpm workspace that takes this repository as a git submodule, installed in `layout`: a copy of the files
 * a checkout holds (checkoutFiles) at vendor/grizzle, with no node_modules at its root, and every member's
 * dependencies linked where `layout` puts them, each to the package the repository's own install holds by its real
 * path, so every copy of a package is the one copy a consumer's install would hold: the engine, grizzle and the local
 * cluster's package as workspace members, the testing library the toolchain's, and every other dependency as installed.
 * The consumer's project depends on grizzle, the local cluster's package, effect and pg. It lives as long as the scope.
 */
export const submoduleConsumer = Effect.fnUntraced(function* (layout: Layout) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = path.join(import.meta.dirname, "..", "..", "..")
	const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-submodule-" })
	const checkout = path.join(workspace, "vendor", "grizzle")
	const project = path.join(workspace, "app")
	yield* Effect.forEach(
		checkoutFiles,
		Effect.fnUntraced(function* (file) {
			const target = path.join(checkout, file)
			yield* fs.makeDirectory(path.dirname(target), { recursive: true })
			yield* fs.copy(path.join(root, file), target)
		}),
		{ discard: true }
	)
	const manifests = yield* Effect.forEach(members, (member) =>
		Effect.map(fs.readFileString(path.join(root, "packages", member, "package.json")), (text) => ({
			member,
			manifest: trustedJson<MemberManifest>(text)
		}))
	)
	const workspaceMembers = new Map<string, string>([
		...Arr.map(manifests, ({ member, manifest }): readonly [string, string] => [
			manifest.name,
			path.join(checkout, "packages", member)
		]),
		["@bjornpagen/testing", path.join(root, "vendor", "toolchain", "packages", "testing")]
	])
	const installed = Effect.fnUntraced(function* (member: string, name: string) {
		const own = workspaceMembers.get(name)
		if (own !== undefined) {
			return own
		}
		return yield* fs.realPath(path.join(root, "packages", member, "node_modules", name))
	})
	const link = Effect.fnUntraced(function* (home: string, name: string, target: string) {
		const at = path.join(home, "node_modules", name)
		if (yield* fs.exists(at)) {
			return
		}
		yield* fs.makeDirectory(path.dirname(at), { recursive: true })
		yield* fs.symlink(target, at)
	})
	for (const { member, manifest } of manifests) {
		const names = Arr.dedupe([
			...Record.keys(manifest.dependencies ?? {}),
			...Record.keys(manifest.devDependencies ?? {}),
			...Record.keys(manifest.peerDependencies ?? {})
		])
		const home = dependencyHome[layout](workspace, path.join(checkout, "packages", member))
		for (const name of names) {
			const target = yield* installed(member, name)
			yield* link(home, name, target)
		}
	}
	const modules = dependencyHome[layout](workspace, project)
	for (const [name, target] of workspaceMembers) {
		yield* link(modules, name, target)
	}
	for (const name of projectDependencies) {
		const target = yield* installed("grizzle", name)
		yield* link(modules, name, target)
	}
	yield* fs.makeDirectory(project, { recursive: true })
	yield* fs.writeFileString(path.join(project, "package.json"), `{ "type": "module" }\n`)
	const result: SubmoduleConsumer = { checkout, project, modules }
	return result
})

/**
 * The real path of the package `name` as Node finds it from `directory`: the first node_modules/`name` of the
 * directory or one above it, none when no directory up to the root holds one.
 */
export const packageFrom = (
	directory: string,
	name: string
): Effect.Effect<
	Option.Option<string>,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const candidate = path.join(directory, "node_modules", name)
		if (yield* fs.exists(candidate)) {
			const real = yield* fs.realPath(candidate)
			return Option.some(real)
		}
		const parent = path.dirname(directory)
		return parent === directory ? Option.none<string>() : yield* packageFrom(parent, name)
	})

/** A port on localhost no listener holds, which the operating system picks for a listen on port 0 and frees again. */
export const freePort: Effect.Effect<number> = Effect.callback<number>((resume) => {
	const server = createServer()
	server.listen({ port: 0, host: "localhost", exclusive: true }, () => {
		const address = server.address()
		server.close(() => {
			resume(
				typeof address === "object" && address !== null
					? Effect.succeed(address.port)
					: Effect.die(new Error("a listener on port 0 has no port"))
			)
		})
	})
})
