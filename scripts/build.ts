import { stripTypeScriptTypes } from "node:module"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { regex } from "arkregex"
import {
	Array as Arr,
	Console,
	Data,
	Effect,
	FileSystem,
	Inspectable,
	Option,
	Path,
	Record as Rec,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { trustedJson } from "#compiler/core/trusted.ts"

/** Why the build stopped, in words. The build prints it and exits with status 1. */
class BuildFailure extends Data.TaggedError("BuildFailure")<{ readonly detail: string }> {}

/** A specifier of a package's own, `#<module>.ts`, quoted after `from`, a bare `import`, or `import(`. */
const ownSpecifier = regex(
	"(?<=(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)[\"'])#[^\"']+\\.ts(?=[\"'])",
	"g"
)

/** What an unrewritten own specifier looks like anywhere in a file. */
const leftover = regex("[\"']#[^\"']+\\.ts[\"']")

/** The fields of a package's package.json the build reads: its name, and where its own specifiers resolve. */
interface Manifest {
	readonly name: string
	readonly imports: Readonly<Record<string, string>>
}

/**
 * Where the own specifiers under one prefix of package.json's "imports" lead (`#adapter/` in `"#adapter/*"`): modules
 * of the package's own src under a directory (`"./src/adapter/*"`), or subpaths of another package
 * (`"@bjornpagen/grizzle-engine/internal/*"`).
 */
type Route =
	| { readonly kind: "own"; readonly prefix: string; readonly directory: string }
	| { readonly kind: "package"; readonly prefix: string; readonly subpath: string }

/**
 * One package the build emits: its directory, its src, the types/ its project's declarations are emitted into, the
 * dist it writes, and its routes.
 */
interface Package {
	readonly name: string
	readonly directory: string
	readonly src: string
	readonly types: string
	readonly dist: string
	readonly routes: ReadonlyArray<Route>
	readonly modules: ReadonlyArray<string>
}

/** The workspace packages under packages/, by directory, in build order: the shell imports the engine. */
const packageDirectories: ReadonlyArray<string> = ["engine", "grizzle"]

/** A path relative to its directory, with forward slashes, as a module specifier spells it. */
const posixPath = (path: Path.Path, file: string): string =>
	Arr.join(Str.split(file, path.sep), "/")

/** Every file under `dir`, recursively, relative to it, with forward slashes. */
const filesUnder = Effect.fnUntraced(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const entries = yield* fs.readDirectory(dir, { recursive: true })
	return Arr.map(entries, (entry) => posixPath(path, entry))
})

const write = Effect.fnUntraced(function* (target: string, text: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.makeDirectory(path.dirname(target), { recursive: true })
	yield* fs.writeFileString(target, text)
})

/** The route of one "imports" entry: a pattern whose target is a directory of src or another package's subpath. */
const routeOf = Effect.fnUntraced(function* (name: string, key: string, target: string) {
	if (!Str.startsWith("#")(key) || !Str.endsWith("/*")(key) || !Str.endsWith("/*")(target)) {
		return yield* new BuildFailure({
			detail: `${name}'s import ${key} is not a "#<prefix>/*" pattern to a "<prefix>/*" target`
		})
	}
	if (Str.startsWith(".")(target) && !Str.startsWith("./src/")(target)) {
		return yield* new BuildFailure({
			detail: `${name}'s import ${key} leads outside its src: ${target}`
		})
	}
	const prefix = Str.slice(0, -1)(key)
	const route: Route = Str.startsWith("./src/")(target)
		? { kind: "own", prefix, directory: Str.slice("./src/".length, -1)(target) }
		: { kind: "package", prefix, subpath: Str.slice(0, -1)(target) }
	return route
})

/** The module a file names, `core/errors` for `core/errors.ts` or `core/errors.d.ts`. */
const moduleOf = (file: string, extension: ".ts" | ".d.ts"): string =>
	Str.slice(0, -extension.length)(file)

/** The package at packages/<directory>: its manifest's routes, its modules, and the dist it writes. */
const packageAt = Effect.fnUntraced(function* (
	root: string,
	outDir: Option.Option<string>,
	directory: string
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const location = path.join(root, "packages", directory)
	const text = yield* fs.readFileString(path.join(location, "package.json"))
	const manifest = trustedJson<Manifest>(text)
	const routes = yield* Effect.forEach(Rec.toEntries(manifest.imports), ([key, target]) =>
		routeOf(manifest.name, key, target)
	)
	const src = path.join(location, "src")
	const files = yield* filesUnder(src)
	const modules = Arr.filter(
		files,
		(file) => Str.endsWith(".ts")(file) && !Str.endsWith(".d.ts")(file)
	)
	return {
		name: manifest.name,
		directory,
		src,
		types: path.join(location, "types"),
		dist: Option.match(outDir, {
			onNone: () => path.join(location, "dist"),
			onSome: (dir) => path.join(path.resolve(dir), manifest.name, "dist")
		}),
		routes,
		modules
	} satisfies Package
})

/** Where one own specifier of the package's dist/`file` leads, by the route of package.json's "imports" it starts with. */
const targetOf = Effect.fnUntraced(function* (
	pkg: Package,
	file: string,
	specifier: string,
	emitted: ReadonlySet<string>
) {
	const path = yield* Path.Path
	const route = Arr.findFirst(pkg.routes, (candidate) =>
		Str.startsWith(candidate.prefix)(specifier)
	)
	if (Option.isNone(route)) {
		return yield* new BuildFailure({
			detail: `${pkg.name} dist/${file} imports ${specifier}, which no import of package.json takes`
		})
	}
	const rest = Str.slice(route.value.prefix.length)(specifier)
	if (route.value.kind === "package") {
		return `${route.value.subpath}${rest}`
	}
	const module = `${route.value.directory}${Str.slice(0, -".ts".length)(rest)}`
	if (!emitted.has(module)) {
		return yield* new BuildFailure({
			detail: `${pkg.name} dist/${file} imports ${specifier}, a module with no emitted file`
		})
	}
	const target = posixPath(
		path,
		path.relative(path.dirname(path.join(pkg.dist, file)), path.join(pkg.dist, `${module}.js`))
	)
	return Str.startsWith(".")(target) ? target : `./${target}`
})

/**
 * `text`, the content of `file` in the package's dist, with every own specifier rewritten by its route: a module of
 * the package's own becomes the relative path of its emitted JavaScript (`#compiler/core/errors.ts` becomes
 * `../core/errors.js`), and another package's subpath its package specifier (`#compiler/core/errors.ts` in the shell
 * becomes `@bjornpagen/grizzle-engine/internal/core/errors.ts`). It fails on a specifier no route takes, on one whose
 * module is not in `emitted`, and on one it leaves unrewritten, so a published module never resolves through "imports"
 * into src.
 */
const rewrite = Effect.fnUntraced(function* (
	pkg: Package,
	file: string,
	text: string,
	emitted: ReadonlySet<string>
) {
	const targets = yield* Effect.forEach(
		Arr.fromIterable(Str.matchAll(ownSpecifier)(text)),
		(match) => targetOf(pkg, file, match[0], emitted)
	)
	const pieces = Str.split(text, ownSpecifier)
	const rewritten = Arr.join(
		[Arr.headNonEmpty(pieces), ...Arr.flatten(Arr.zip(targets, Arr.drop(pieces, 1)))],
		""
	)
	if (leftover.test(rewritten)) {
		return yield* new BuildFailure({
			detail: `${pkg.name} dist/${file} keeps a specifier of its own the build did not rewrite`
		})
	}
	return rewritten
})

/** The JavaScript of every module of a package, through Node's type stripping, with its own specifiers rewritten. */
const emitModules = Effect.fnUntraced(function* (pkg: Package) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const emitted = new Set(Arr.map(pkg.modules, (file) => moduleOf(file, ".ts")))
	yield* Effect.forEach(
		pkg.modules,
		Effect.fnUntraced(function* (file) {
			const source = yield* fs.readFileString(path.join(pkg.src, file))
			const stripped = yield* Effect.try({
				try: () => stripTypeScriptTypes(source, { mode: "strip" }),
				catch: (cause) =>
					new BuildFailure({
						detail: `packages/${pkg.directory}/src/${file} is not erasable TypeScript: ${Inspectable.toStringUnknown(cause)}`
					})
			})
			const js = `${moduleOf(file, ".ts")}.js`
			const rewritten = yield* rewrite(pkg, js, stripped, emitted)
			yield* write(path.join(pkg.dist, js), rewritten)
		}),
		{ discard: true }
	)
})

/**
 * A declaration map of `staged` (tsc's output for the package's `module`) with its one source pointed at the module's
 * .ts from `target`, where the map is published: tsc wrote it relative to where it emitted it.
 */
const relocateMap = Effect.fnUntraced(function* (
	pkg: Package,
	module: string,
	staged: string,
	target: string,
	text: string
) {
	const path = yield* Path.Path
	const source = path.join(pkg.src, `${module}.ts`)
	const sources = (from: string): string =>
		`"sources":["${posixPath(path, path.relative(path.dirname(from), source))}"]`
	const before = sources(staged)
	if (!Str.includes(before)(text)) {
		return yield* new BuildFailure({
			detail: `${pkg.name} dist/${module}.d.ts.map names no source ${before}`
		})
	}
	return Arr.join(Str.split(text, before), sources(target))
})

/**
 * The declarations of every module of every package, with their declaration maps: `tsc -b` of the shell's project
 * builds the engine's project, then the shell's, each emitting into its package's types/, the composite projects
 * `pnpm typecheck` builds. Each module's declaration and map are then written into its package's dist, with its own
 * specifiers rewritten and its map pointed at its src. Only the modules of src are read, so a declaration types/ keeps
 * for a module src no longer has is never published.
 *
 * tsc is handed the project's absolute path under `root`, the real path Node resolved this script at. Its module
 * resolution follows the workspace's symlinks to real paths, while a relative project would resolve against `$PWD`,
 * which may name the same directory through a symlink (`/tmp` for `/private/tmp`); the engine's files would then lie
 * outside the engine's project, inside the shell's.
 */
const emitDeclarations = Effect.fnUntraced(function* (
	root: string,
	packages: ReadonlyArray<Package>
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const project = path.join(root, "packages", "grizzle", "tsconfig.json")
	const exitCode = yield* spawner.exitCode(
		ChildProcess.make(path.join(root, "node_modules", ".bin", "tsc"), ["-b", project], {
			cwd: root,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit"
		})
	)
	if (exitCode !== 0) {
		return yield* new BuildFailure({ detail: `tsc -b ${project} exited with status ${exitCode}` })
	}
	yield* Effect.forEach(
		packages,
		Effect.fnUntraced(function* (pkg) {
			const modules = Arr.map(pkg.modules, (file) => moduleOf(file, ".ts"))
			const absent = yield* Effect.filter(modules, (module) =>
				Effect.map(fs.exists(path.join(pkg.types, `${module}.d.ts`)), (exists) => !exists)
			)
			if (Arr.isReadonlyArrayNonEmpty(absent)) {
				return yield* new BuildFailure({
					detail: `tsc emitted no declarations for ${Arr.join(
						Arr.map(absent, (module) => `packages/${pkg.directory}/src/${module}.ts`),
						", "
					)}`
				})
			}
			const emitted = new Set(modules)
			yield* Effect.forEach(
				modules,
				Effect.fnUntraced(function* (module) {
					const file = `${module}.d.ts`
					const text = yield* fs.readFileString(path.join(pkg.types, file))
					const rewritten = yield* rewrite(pkg, file, text, emitted)
					yield* write(path.join(pkg.dist, file), rewritten)
					const map = `${file}.map`
					const mapText = yield* fs.readFileString(path.join(pkg.types, map))
					const relocated = yield* relocateMap(
						pkg,
						module,
						path.join(pkg.types, map),
						path.join(pkg.dist, map),
						mapText
					)
					yield* write(path.join(pkg.dist, map), relocated)
				}),
				{ discard: true }
			)
		}),
		{ discard: true }
	)
})

/**
 * The published packages' JavaScript and declarations, each package's `dist/`, built from its `src/` by
 * `node scripts/build.ts`, which each package's prepack runs before every `npm publish` and `npm pack`;
 * `node scripts/build.ts <dir>` builds each into <dir>/<name>/dist instead (a consumer's node_modules), as the packed
 * package test does. Development never builds: Node runs each package's src/*.ts directly. A consumer cannot, because
 * Node strips no types from files under node_modules.
 *
 * - Each .ts module of a package's src becomes the .js file at the same path in its dist through Node's own type
 *   stripping (node:module stripTypeScriptTypes, mode "strip"), which replaces every type annotation with
 *   whitespace. dist keeps src's lines and columns, so the shipped src is its source map, and src is erasable syntax
 *   only (tsconfig erasableSyntaxOnly), exactly what Node runs.
 * - `tsc -b` emits each package's declarations, with declaration maps, into its types/ (the composite projects
 *   packages/engine/tsconfig.json and packages/grizzle/tsconfig.json, the shell's referencing the engine's, which it
 *   imports), so the shell's declarations name the engine's by its package.
 * - A package imports its own modules through its package.json's "imports" by their .ts files (`#compiler/core/errors.ts`).
 *   Every such specifier in dist, in code and in declarations, becomes the relative path of the module's own emitted
 *   JavaScript (`../core/errors.js`), or, where "imports" leads into another package, that package's subpath.
 *
 * It reports on stderr, so `npm pack --json`, which runs the build first, keeps its standard output JSON.
 */
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = path.join(import.meta.dirname, "..")
	const outDir = yield* Effect.sync(() => Arr.get(process.argv, 2))
	const packages = yield* Effect.forEach(packageDirectories, (directory) =>
		packageAt(root, outDir, directory)
	)
	yield* Effect.forEach(packages, (pkg) => fs.remove(pkg.dist, { recursive: true, force: true }), {
		discard: true
	})
	yield* Effect.forEach(packages, emitModules, { discard: true })
	yield* emitDeclarations(root, packages)
	yield* Console.error(
		Arr.join(
			Arr.map(packages, (pkg) => `${pkg.name} dist: ${pkg.modules.length} modules`),
			"\n"
		)
	)
}).pipe(
	Effect.catchTag("BuildFailure", (failure) =>
		Console.error(`build: ${failure.detail}`).pipe(
			Effect.andThen(
				Effect.sync(() => {
					process.exitCode = 1
				})
			)
		)
	)
)

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)))
