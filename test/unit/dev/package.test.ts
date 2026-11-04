import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Path,
	Predicate,
	Record,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { assert } from "#test/support/assert.ts"

/**
 * A package manifest's publishing fields: its name, the files it publishes besides its package.json, its entry
 * points, the runtime dependencies a consumer's install brings beside it, and its peers.
 */
const Manifest = Schema.Struct({
	name: Schema.String,
	files: Schema.Array(Schema.String),
	exports: Schema.Record(
		Schema.String,
		Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])
	),
	dependencies: Schema.Record(Schema.String, Schema.String),
	peerDependencies: Schema.Record(Schema.String, Schema.String)
})

/** The shell's manifest: a package's fields and its bin. */
const ShellManifest = Schema.Struct({
	...Manifest.fields,
	bin: Schema.Record(Schema.String, Schema.String)
})

/** The exit status of a child that succeeded. */
const succeeded = ChildProcessSpawner.ExitCode(0)

/** Vercel's package, for the consumer program's attachPool; the consumer installs it, not the package. */
const consumerDependency = "@vercel/functions"

const consumer = `import { attachDatabasePool } from "@vercel/functions/db-connections"
import { Effect, Redacted } from "effect"
import { context, Db, DbLayer, key, login, query, relation, role, schema, str, TokenError, uuid, v } from "@bjornpagen/grizzle"

const Note = relation("Note", { id: uuid, author: uuid, text: str.regex("^.{1,200}$", "su") }, ["id"])
export const App = schema("App", { Note }, [key(Note, ["id"])])
const Session = context("Session", { sub: uuid })
export const mine = query(App).rule((r) => {
	const { id, author, text } = v(Note, "note")
	return r.match(Note, { id, author, text }).match(Session, { sub: author }).find({ id, text })
})
export const Reader = role(App, "reader", { Note })
export const Member = role(App, "member", { Mine: mine }, { write: ["Mine"] })
export const Web = login(App, "web", [Reader, Member])
export const texts = query(Reader).rule((r) => {
	const { text } = v(Note, "note")
	return r.match(Note, { text }).find({ text })
})
declare const snapshot: { readonly fingerprint: string }
export const layer = DbLayer.make({
	login: Web,
	snapshot,
	host: "localhost",
	port: 5432,
	database: "app",
	password: Redacted.make("secret"),
	tls: { ca: "-----BEGIN CERTIFICATE-----" },
	attachPool: attachDatabasePool,
	verify: (token) => Effect.fail(new TokenError({ cause: token }))
})
export const reader = Db.open(Web.roles.reader, {})
export const member = Db.open(Web.roles.member, { token: "a token" })
// @ts-expect-error -- Member reads a context, so opening it takes a token
Db.open(Web.roles.member, {})
const verify = (token: string) => Effect.fail(new TokenError({ cause: token }))
// @ts-expect-error -- a port is a number
DbLayer.make({ login: Web, snapshot, host: "h", port: "5432", database: "d", password: Redacted.make("p"), tls: { ca: "c" }, verify })
// @ts-expect-error -- a role of Web reads a context, so its layer takes a verify
DbLayer.make({ login: Web, snapshot, host: "h", port: 5432, database: "d", password: Redacted.make("p"), tls: { ca: "c" } })
`

const consumerTsconfig = `{
	"compilerOptions": {
		"target": "esnext",
		"module": "nodenext",
		"moduleResolution": "nodenext",
		"strict": true,
		"exactOptionalPropertyTypes": true,
		"noEmit": true,
		"skipLibCheck": true,
		"types": []
	},
	"include": ["consumer.ts"]
}
`

/**
 * Runs `command` in `cwd` to completion, reading nothing, and returns its exit status and its whole standard output
 * and error; interrupting the test kills it.
 */
const run = Effect.fnUntraced(function* (
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
	manifest: typeof Manifest.Type,
	bin: Record.ReadonlyRecord<string, string>
): ReadonlyArray<string> => [
	...Arr.flatMap(Record.values(manifest.exports), (entry) =>
		Predicate.isString(entry) ? [entry] : Record.values(entry)
	),
	...Record.values(bin)
]

/** The engine publishes no bin. */
const noBin: Record.ReadonlyRecord<string, string> = {}

/**
 * The published packages, the shell and the engine it depends on, as a consumer installs them: built into a scratch
 * node_modules by the build `npm publish` runs (scripts/build.ts), each laid out with exactly the files its
 * package.json's "files" names, and with exactly their runtime dependencies and peers beside them, each from the
 * node_modules of the package that declares it.
 *
 * - Each package.json's entry points, `exports` and `bin`, lie inside the files it publishes, and the build emitted
 *   them.
 * - Node loads the package from node_modules, where it strips no types, so every module resolves to dist without a
 *   `#…ts` specifier: its entry imports with only the declared dependencies installed, and exposes the API the README
 *   names.
 * - The `grizzle` bin runs from node_modules and prints its usage.
 * - A consumer's TypeScript program typechecks against the published declarations alone, with no access to src's `#`
 *   imports: a schema, a context, roles and their login, a query over a role, a layer whose attachPool is Vercel's own
 *   attachDatabasePool and whose verify fails with TokenError, Db.open of each role, and misuses the types refuse (so
 *   the declarations are not `any`).
 */
const publishedPackage = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = path.join(import.meta.dirname, "..", "..", "..")
	const manifestOf = (directory: string) =>
		fs.readFileString(path.join(root, "packages", directory, "package.json"))
	const engine = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
		yield* manifestOf("engine")
	)
	const shell = yield* Schema.decodeEffect(Schema.fromJsonString(ShellManifest))(
		yield* manifestOf("grizzle")
	)
	const published = [
		{ directory: "engine", manifest: engine, bin: noBin },
		{ directory: "grizzle", manifest: shell, bin: shell.bin }
	]
	const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-package-" })
	const project = path.join(scratch, "project")
	const modules = path.join(project, "node_modules")
	const pkg = path.join(modules, shell.name)

	const built = yield* run(
		process.execPath,
		[path.join(root, "scripts", "build.ts"), modules],
		root
	)
	assert.equal(built.exitCode, succeeded, `the build: ${built.stderr}`)
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
			assert.ok(
				yield* fs.exists(path.join(installed, entry)),
				`${manifest.name}: ${entry} was not emitted`
			)
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
		{ name: consumerDependency, from: path.join(root, "node_modules", consumerDependency) }
	]
	const beside = Arr.dedupeWith(declared, (a, b) => a.name === b.name)
	yield* Effect.forEach(
		beside,
		Effect.fnUntraced(function* ({ name, from }) {
			const link = path.join(project, "node_modules", name)
			yield* fs.makeDirectory(path.dirname(link), { recursive: true })
			yield* fs.symlink(from, link)
		}),
		{ discard: true }
	)
	yield* fs.writeFileString(path.join(project, "package.json"), `{ "type": "module" }\n`)

	const loaded = yield* run(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			"const m = await import('@bjornpagen/grizzle'); console.log(Object.keys(m).sort().join(' '))"
		],
		project
	)
	assert.equal(loaded.exitCode, succeeded, `the import: ${loaded.stderr}`)
	const names = new Set(Str.split(Str.trim(loaded.stdout), " "))
	assert.deepEqual(
		Arr.filter(
			["ChangeSet", "Db", "DbLayer", "defineConfig", "key", "query", "relation", "schema"],
			(name) => !names.has(name)
		),
		[],
		"the package exports these names"
	)

	const help = yield* run(
		process.execPath,
		[path.join(pkg, "dist", "cli", "main.js"), "--help"],
		project
	)
	assert.equal(help.exitCode, succeeded, `grizzle --help: ${help.stderr}`)
	assert.ok(Str.startsWith("Usage:")(help.stdout), help.stdout)

	yield* fs.writeFileString(path.join(project, "consumer.ts"), consumer)
	yield* fs.writeFileString(path.join(project, "tsconfig.json"), consumerTsconfig)
	const checked = yield* run(
		process.execPath,
		[
			path.join(root, "node_modules", "typescript", "bin", "tsc"),
			"-p",
			path.join(project, "tsconfig.json")
		],
		project
	)
	assert.equal(
		checked.exitCode,
		succeeded,
		`the consumer typecheck:\n${checked.stdout}${checked.stderr}`
	)
})

layer(NodeServices.layer, { excludeTestServices: true })("the published package", (it) => {
	it.effect(
		"loads from node_modules, runs its bin, and typechecks a consumer against its declarations alone",
		() => publishedPackage
	)
})
