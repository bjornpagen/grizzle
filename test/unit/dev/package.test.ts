import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import { assert } from "#test/support/assert.ts"
import { exitedCleanly, publishedProject, run } from "#test/unit/dev/published.ts"

const consumer = `import { attachDatabasePool } from "@vercel/functions/db-connections"
import { Effect, Redacted } from "effect"
import pgDriver from "pg"
import { context, Db, DbLayer, key, login, on, type PgSocket, query, relation, role, schema, str, TokenError, uuid, v } from "@bjornpagen/grizzle"

const Note = relation("Note", { id: uuid, author: uuid, text: str.regex("^.{1,200}$", "su") }, ["id"])
export const App = schema("App", { Note }, [key(on(Note, "id"))])
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
declare const openSocket: () => PgSocket
const connection = {
	driver: pgDriver,
	transport: { kind: "sslRequest", host: "localhost", port: 5432, open: openSocket, ca: "-----BEGIN CERTIFICATE-----", servername: "localhost" },
	database: "app",
	password: Redacted.make("secret"),
	connectTimeoutMs: 10_000,
	pool: { max: 10, min: 1, idleTimeoutMs: 5_000 }
} as const
export const layer = DbLayer.make({
	...connection,
	login: Web,
	snapshot,
	attachPool: attachDatabasePool,
	verify: (token) => Effect.fail(new TokenError({ cause: token }))
})
export const reader = Db.open(Web.roles.reader, {})
export const member = Db.open(Web.roles.member, { token: "a token" })
// @ts-expect-error -- Member reads a context, so opening it takes a token
Db.open(Web.roles.member, {})
const verify = (token: string) => Effect.fail(new TokenError({ cause: token }))
// @ts-expect-error -- a port is a number
DbLayer.make({ ...connection, transport: { ...connection.transport, port: "5432" }, login: Web, snapshot, verify })
// @ts-expect-error -- a role of Web reads a context, so its layer takes a verify
DbLayer.make({ ...connection, login: Web, snapshot })
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
 * The published packages, installed as a consumer installs them (published.ts), used as a consumer uses them:
 *
 * - Node loads the package from node_modules, where it strips no types, so every module resolves to dist without a
 *   `#…ts` specifier: its entry imports with only the declared dependencies installed, and exposes the API the README
 *   names.
 * - The `grizzle` bin runs from node_modules and prints its usage.
 * - A consumer's TypeScript program typechecks against the published declarations alone, with no access to src's `#`
 *   imports: a schema, a context, roles and their login, a query over a role, a layer over the pg the consumer installs
 *   beside it, whose attachPool is Vercel's own attachDatabasePool and whose verify fails with TokenError, Db.open of
 *   each role, and misuses the types refuse (so the declarations are not `any`).
 *
 * That the built package opens a role against the cluster and reads is test/pg/package/consumer.test.ts's.
 */
const usedAsPublished = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const { root, project, shell } = yield* publishedProject
	const loaded = yield* run(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			"const m = await import('@bjornpagen/grizzle'); console.log(Object.keys(m).sort().join(' '))"
		],
		project
	)
	assert.equal(loaded.exitCode, exitedCleanly, `the import: ${loaded.stderr}`)
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
		[path.join(shell, "dist", "cli", "main.js"), "--help"],
		project
	)
	assert.equal(help.exitCode, exitedCleanly, `grizzle --help: ${help.stderr}`)
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
		exitedCleanly,
		`the consumer typecheck:\n${checked.stdout}${checked.stderr}`
	)
})

layer(NodeServices.layer, { excludeTestServices: true })("the published package", (it) => {
	it.effect(
		"loads from node_modules, runs its bin, and typechecks a consumer against its declarations alone",
		() => usedAsPublished
	)
})
