/**
 * The grizzle tier's installations (once.test.ts): the login of world.ts installed twice on the generator's local
 * cluster (pg.config.ts, made by the testing library at grizzle's pinned build), as an
 * application installs it, and a CLI the generator built from the login's OpenAPI document, as a need of the runner's.
 *
 * Each worker that runs the tier drafts the login once with `grizzle generate` (grizzle.config.ts) into a scratch
 * directory of its own, and installs it twice, each twin with `grizzle migrate` into a database of its own (a clone of
 * the empty template, emptyDatabase) under a role prefix of its own, the clone's own name, so each twin's live source
 * claims a replication slot no other installation names. Each twin is served by grizzle's own HTTP handler
 * (`@bjornpagen/grizzle/http`) over its login's layers (`served`, `DbLayer.make`, `LiveSource.layer`): twin A on
 * a Node HTTP server at 127.0.0.1, a port the system chooses, for the CLI to call; twin B in process, through grizzle's
 * in-process client of a handler (`handlerClient`), the oracle; each with its live source standing (`warm`). The CLI is generated from the
 * document `grizzle generate` wrote, `openapi/<login>.json`, its author config binding A's origin, and built. When the
 * worker ends, A's server stops, each twin's layers close, `grizzle uninstall` drops its roles and its slot, and its
 * database is dropped.
 *
 * Every case the worker runs is given the same twins: each case first stores its own items in both (`store`, every item
 * deleted, then the case's put), so no case reads another's.
 */
import { jsonText, type Json } from "@bjornpagen/grizzle-text/utf8"
import { handlerClient } from "@bjornpagen/grizzle/client"
import { type HttpHandler, httpHandler } from "@bjornpagen/grizzle/http"
import {
	DbLayer,
	LiveSource,
	roleNameOf,
	type ServedLogin,
	served
} from "@bjornpagen/grizzle/runtime"
import { pgOwnerSession } from "@bjornpagen/testing/pg-session"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { type Database, Template } from "@bjornpagen/testing/resources"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import {
	Array as Arr,
	Context,
	Data,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Path,
	Record as Rec,
	Redacted,
	Result,
	type Scope,
	Stream,
	String as Str
} from "effect"
import { Digest } from "effect/crypto"
import { HttpBody, type HttpClient, HttpClientRequest, HttpEffect, HttpServer } from "effect/http"
import { ChildProcess } from "effect/process"
import { isJson } from "#model/json-tree.ts"
import { type InvalidJsonText, parseJson } from "#runtime/json.ts"
import {
	anything,
	member,
	property,
	type Reader,
	type ReadIssues,
	record,
	refine,
	string,
	struct
} from "#runtime/read.ts"
import { type Cluster, connectionTo, unboundedMillis } from "#test/grizzle/connection.ts"
import type { Server } from "#test/grizzle/world.ts"
import { cliNeedBudget } from "#test/support/budgets.ts"
import { buildPackage, type BuiltPackage, generateFixture } from "#test/support/cli-package.ts"
import { finished } from "#test/support/process.ts"
import { chunkText, streamText } from "#test/support/stdio.ts"

/** The login's name, as world.ts declares it and `grizzle generate` names its files. */
const loginName = "server"

/** The installed name of world.ts's schema, whose folder `grizzle generate` writes its files under. */
const schemaFolder = "items"

/** The configuration `grizzle generate`, `grizzle migrate` and `grizzle uninstall` read (grizzle.config.ts). */
const configFile = `${import.meta.dirname}/grizzle.config.ts`

/** One event of a call's answer, as grizzle's handler frames it and the CLI prints it: its name and its data. */
export type Event = Readonly<{ event: string; data: Json }>

/**
 * A value grizzle's handler or the CLI answered that the tier cannot read: what it was, and why, its text no JSON text
 * or the places it breaks the tier's reader of it.
 */
class Unreadable extends Data.TaggedError("Unreadable")<{
	readonly what: string
	readonly why: InvalidJsonText | ReadIssues
}> {
	override get message(): string {
		return `${this.what}: ${Formatter.format(this.why)}`
	}
}

/** `value` read by `reader`, or Unreadable naming `what` and every place it breaks the reader. */
export const readValue = <A>(what: string, reader: Reader<A>, value: unknown) =>
	Effect.mapError(Effect.fromResult(reader(value)), (why) => new Unreadable({ what, why }))

/** JSON text's value read by `reader`, or Unreadable naming `what`, where the text is no JSON text or breaks the reader. */
export const readText = <A>(what: string, reader: Reader<A>, text: string) =>
	Effect.mapError(
		Effect.fromResult(Result.flatMap(parseJson(text), reader)),
		(why) => new Unreadable({ what, why })
	)

/** A JSON value, as JSON text parses to one. */
export const json: Reader<Json> = refine(anything, isJson, "a JSON value")

/**
 * A CallError as an `error` event's data holds it: its kind and its retry, which the tier reads, beside every other
 * member it states, kept as the JSON it is.
 */
export type CallError = Readonly<{ kind: string; retry: string }> & {
	readonly [member: string]: Json
}

/** An `error` event's CallError (CallError). */
const callError: Reader<CallError> = (value) =>
	Result.flatMap(record(string, json)(value), (error) =>
		Result.map(
			struct(
				error,
				{ kind: member(error, "kind", string), retry: member(error, "retry", string) },
				anything
			),
			(read): CallError => ({ ...error, ...read })
		)
	)

/** An `error` event's data: the CallError it holds. */
export const errorData: Reader<CallError> = property("error", callError)

/**
 * Whether events end at a CallError safe to make again (live/events.ts callErrors `retry`): nothing committed, and the
 * failure is not the call's, which is no answer of the call's.
 */
export const endsSafeAgain = (events: ReadonlyArray<Event>): boolean =>
	Option.exists(
		Arr.last(events),
		(event) =>
			event.event === "error" &&
			Result.match(errorData(event.data), {
				onFailure: () => false,
				onSuccess: (error) => error.retry === "safe"
			})
	)

/** One installation of the login, served by grizzle's handler, called in process through `client`. */
export type Twin = Readonly<{ handler: HttpHandler; client: HttpClient.HttpClient }>

/** What every case of a worker is given (see the header). */
export type Twins = Readonly<{
	/** Twin A's base URL, which the CLI is bound to. */
	url: string
	a: Twin
	b: Twin
	/** Each program's `grizzle-wire` digest, which its OpenAPI operation's `x-grizzle-wire` states. */
	digests: ReadonlyMap<string, string>
	built: BuiltPackage
	/** Each program's command, by the program's name. */
	commands: ReadonlyMap<string, ReadonlyArray<string>>
}>

/** A step of the twins' setup that did not do what the tier needs: what was being done, and why. */
const setupFailed = (doing: string) => (cause: unknown) =>
	NeedFailed.make({ need: "grizzle twins", message: `${doing}: ${Formatter.format(cause)}` })

/** `effect`, a step of the twins' setup, failing as the need with what it was doing (setupFailed). */
const stepOf = <A, E, R>(doing: string, effect: Effect.Effect<A, E, R>) =>
	Effect.mapError(effect, setupFailed(doing))

/** A case's items that a twin did not store: its put or its deletion did not answer an outcome. */
class Unstored extends Data.TaggedError("Unstored")<{ readonly text: string }> {
	override get message(): string {
		return this.text
	}
}

/** The grizzle command line's entry, as its manifest's `bin` names it. */
const grizzleEntry: Reader<string> = property("bin", property("grizzle", string))

/** The grizzle command line, run from its source, as its manifest names it. */
const grizzleBin = stepOf(
	"finding grizzle's command line",
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const manifestPath = yield* path.fromFileUrl(
			new URL(import.meta.resolve("@bjornpagen/grizzle/package.json"))
		)
		const manifestText = yield* fs.readFileString(manifestPath)
		const entry = yield* readText("grizzle's manifest", grizzleEntry, manifestText)
		return path.join(path.dirname(manifestPath), entry)
	})
)

/**
 * Runs `grizzle <command>` over grizzle.config.ts with `env` beside the worker's own, failing with its output when it
 * exits non-zero.
 */
const grizzle = (bin: string, command: string, env: Readonly<Record<string, string>>) =>
	Effect.gen(function* () {
		const run = yield* stepOf(
			`running grizzle ${command}`,
			finished(
				ChildProcess.make(process.execPath, [bin, command, configFile], {
					cwd: import.meta.dirname,
					env,
					extendEnv: true,
					stdin: "ignore"
				})
			)
		)
		if (run.exitCode === 0) {
			return
		}
		const stdout = yield* chunkText(run.stdout)
		const stderr = yield* chunkText(run.stderr)
		return yield* setupFailed(`grizzle ${command} exited ${run.exitCode}`)(`${stdout}${stderr}`)
	})

/**
 * The password of a login of an installation: the owner's password, then the role's name, so only who holds the
 * owner's password knows it, and each login's differs from every other's.
 */
const passwordOf = (cluster: Cluster, role: string): Redacted.Redacted =>
	Redacted.make(`${Redacted.value(cluster.password)}:${role}`)

/** Runs `statement` as the cluster's owner in its own database on `member`. */
const asOwner = (member: Database["member"], statement: string) =>
	Effect.scoped(
		Effect.flatMap(pgOwnerSession("eocg grizzle tier owner")(member, member.owner), (session) =>
			session.query(statement, [])
		)
	)

/** An empty database, a clone of the cluster's template, as a template: what each twin installs the login into itself. */
const emptyDatabase = Template.database({
	declaredIn: import.meta,
	name: "eocg grizzle empty",
	content: {},
	from: Template.cluster,
	budget: cliNeedBudget,
	build: () => Effect.void
})

/** What `grizzle generate` wrote for the login: its served file's value and its OpenAPI document's text. */
type Drafted = Readonly<{ migrations: string; file: unknown; document: string }>

/** The login drafted by `grizzle generate` into a scratch directory of the worker's. */
const drafted = (bin: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const scratch = yield* stepOf(
			"making the draft's scratch directory",
			fs.makeTempDirectoryScoped({ prefix: "eocg-grizzle-" })
		)
		const migrations = path.join(scratch, "migrations")
		yield* grizzle(bin, "generate", { EOCG_GRIZZLE_MIGRATIONS: migrations })
		const folder = path.join(migrations, schemaFolder)
		return yield* stepOf(
			"reading what grizzle generate wrote",
			Effect.gen(function* () {
				const fileText = yield* fs.readFileString(path.join(folder, "served", `${loginName}.json`))
				const file = yield* Effect.fromResult(parseJson(fileText))
				const document = yield* fs.readFileString(path.join(folder, "openapi", `${loginName}.json`))
				const result: Drafted = { migrations, file, document }
				return result
			})
		)
	})

/**
 * A login's pool: two sessions, the most calls a case has open on one twin at once, a followed read and the put it
 * sees; none opened ahead; each kept as long as the pool lives.
 *
 * @limitKind derived
 * @owner the grizzle tier (test/grizzle/twins.ts)
 * @unit sessions
 * @scope one twin's session pool, for its worker's life
 * @derivation once.test.ts calls each twin one call at a time, but for a followed read, beside which it makes one put
 */
const pool = Object.freeze({ max: 2 })

/**
 * One twin, for the worker's scope: a database of its own, the login installed in it by `grizzle migrate` from `draft`
 * under the clone's name as its role prefix, each login given its password, the login's layers built over it and its
 * handler; uninstalled before its database is dropped.
 */
const twinOf = (
	bin: string,
	draft: Drafted,
	clone: Effect.Effect<Database, NeedFailed, Scope.Scope>
) =>
	Effect.gen(function* () {
		const database = yield* clone
		const { member } = database
		const cluster: Cluster = yield* member.tls.kind === "tls"
			? Effect.succeed({ port: member.port, ca: member.tls.ca, password: member.password })
			: Effect.fail(
					setupFailed("reaching the member over TLS")(
						`member ${member.name} is reached over its socket alone, and grizzle connects over TLS only`
					)
				)
		const rolePrefix = database.name
		const login = yield* Effect.try({
			try: (): ServedLogin<typeof Server> => served<typeof Server>(draft.file, loginName),
			catch: setupFailed("reading the login's served file")
		})
		const env = {
			EOCG_GRIZZLE_MIGRATIONS: draft.migrations,
			EOCG_GRIZZLE_PORT: String(cluster.port),
			EOCG_GRIZZLE_CA: cluster.ca,
			EOCG_GRIZZLE_ROLE: database.member.owner,
			EOCG_GRIZZLE_PASSWORD: Redacted.value(cluster.password),
			EOCG_GRIZZLE_DATABASE: database.name,
			EOCG_GRIZZLE_ROLE_PREFIX: rolePrefix
		}
		const server = roleNameOf(login, { rolePrefix })
		const decoder = roleNameOf(login.decoder, { rolePrefix })
		yield* Effect.acquireRelease(
			Effect.gen(function* () {
				yield* grizzle(bin, "migrate", env)
				yield* asOwner(
					database.member,
					`ALTER ROLE "${server}" PASSWORD '${Redacted.value(passwordOf(cluster, server))}'`
				)
				yield* asOwner(
					database.member,
					`ALTER ROLE "${decoder}" PASSWORD '${Redacted.value(passwordOf(cluster, decoder))}'`
				)
			}),
			() => Effect.orDie(grizzle(bin, "uninstall", env))
		)
		const connection = (role: string) => ({
			...connectionTo(cluster, database.name, passwordOf(cluster, role)),
			rolePrefix
		})
		const layers = yield* stepOf(
			"building the login's layers",
			Layer.build(
				DbLayer.make({ ...connection(server), login, pool }).pipe(
					Layer.provide(LiveSource.layer({ ...connection(decoder), login }))
				)
			)
		)
		const handler = yield* stepOf(
			"building the login's handler",
			Effect.provideContext(httpHandler({ logins: [login], heartbeatMs: unboundedMillis }), layers)
		)
		const twin: Twin = { handler, client: handlerClient(handler) }
		return twin
	})

/** A frame being read: the event its `event:` line named, and the data its `data:` line held, until its blank line. */
type Framing = Readonly<{ event: Option.Option<string>; data: Option.Option<string> }>

const noFrame: Framing = { event: Option.none(), data: Option.none() }

/**
 * The events of a text/event-stream body, as grizzle frames them (http/sse.ts): an `event:` line, a `data:` line and
 * the blank line that dispatches them, beside heartbeat comment lines, which are skipped.
 */
const eventsOf = <E, R>(body: Stream.Stream<Uint8Array, E, R>) =>
	streamText(body).pipe(
		Stream.splitLines,
		Stream.mapAccum(
			() => noFrame,
			(frame, line): readonly [Framing, ReadonlyArray<readonly [string, string]>] =>
				Str.startsWith("event: ")(line)
					? [{ ...frame, event: Option.some(Str.slice(7)(line)) }, []]
					: Str.startsWith("data: ")(line)
						? [{ ...frame, data: Option.some(Str.slice(6)(line)) }, []]
						: line === ""
							? [
									noFrame,
									Option.match(Option.all([frame.event, frame.data]), {
										onNone: () => [],
										onSome: (pair) => [pair]
									})
								]
							: [frame, []]
		),
		Stream.mapEffect(([event, data]) =>
			Effect.map(readText(`the data of a ${event} event`, json, data), (value): Event => ({
				event,
				data: value
			}))
		)
	)

/**
 * What `program` of `twin` answers `body`, called in process as an HTTP client calls it, with the `grizzle-wire`
 * digest its operation states: its events through the first that `last` takes as the answer's last, a live read's
 * `ready` among them, after which the call is cut.
 */
export const called = (
	twins: Twins,
	twin: Twin,
	program: string,
	body: Json,
	last: (event: Event) => boolean
) =>
	Effect.gen(function* () {
		const digest = yield* Effect.fromOption(Option.fromUndefinedOr(twins.digests.get(program)))
		const response = yield* twin.client.execute(
			HttpClientRequest.post(`http://127.0.0.1/${loginName}/app/${program}`, {
				accept: "text/event-stream",
				headers: { "grizzle-wire": digest },
				body: HttpBody.text(jsonText(body), "application/json")
			})
		)
		const events = yield* Stream.runCollect(Stream.takeUntil(eventsOf(response.stream), last))
		return Arr.fromIterable(events)
	})

/** The answer's last event of a write or an instant read: `end`, or an `error`. */
const ended = (event: Event): boolean => event.event === "end" || event.event === "error"

/** The answer's last event of a live read: `ready`, or an `error`. */
const readied = (event: Event): boolean => event.event === "ready" || event.event === "error"

/** The answer's last event of a call of `program`: a live read's `ready`, else `end`, or an `error`. */
export const lastOf =
	(program: string) =>
	(event: Event): boolean =>
		program === "past" || program === "put" || program === "clear" ? ended(event) : readied(event)

/**
 * The outcome `program` of `twin` answers `body`, which must be one, the call made again while it answers a CallError
 * safe to make again.
 */
const written = (twins: Twins, twin: Twin, program: string, body: Json) =>
	Effect.flatMap(
		Effect.repeat(called(twins, twin, program, body, ended), { while: endsSafeAgain }),
		(events) =>
			Arr.some(events, (event) => event.event === "outcome")
				? Effect.void
				: Effect.fail(new Unstored({ text: `${program} answers ${Formatter.format(events)}` }))
	)

/** Each twin's items replaced by `stored`: every item deleted, then `stored` put. */
export const store = (twins: Twins, stored: ReadonlyArray<Json>) =>
	Effect.forEach([twins.a, twins.b], (twin) =>
		Effect.andThen(
			written(twins, twin, "clear", { params: {}, facts: {} }),
			written(twins, twin, "put", { params: {}, facts: { put: { Item: stored } } })
		)
	)

/**
 * A twin's live reads made ready to register: the installation's replication slot, which its live leader makes at the
 * first watch, stands. A set read is called to its first `ready`, again while it ends at an error safe to make again
 * (the slot does not stand yet, or its making invalidated the source the watch listened on), the refusal pacing it and
 * never a timer, as grizzle's own suites stand a live source, so the first call the CLI
 * makes over HTTP, and the first the oracle makes, meets a live source that stands, as a deployed server's does once
 * it has served one live read.
 */
const warm = (twins: Twins, twin: Twin) =>
	Effect.repeat(called(twins, twin, "atLeast", { params: { floor: "0" }, facts: {} }, readied), {
		while: endsSafeAgain
	})

/**
 * Twin A served over HTTP for the scope: grizzle's handler mounted on a Node HTTP server at a port the system chooses
 * (NodeHttpServer.layerTest), each request handed to it as the web Request it takes (HttpEffect.fromWebHandler), and
 * its base URL on the loopback address.
 */
const servedOverHttp = (handler: HttpHandler) =>
	Effect.gen(function* () {
		const services = yield* stepOf(
			"starting twin A's server",
			Layer.build(NodeHttpServer.layerTest)
		)
		yield* Effect.provideContext(
			HttpServer.serveEffect()(HttpEffect.fromWebHandler(handler)),
			services
		)
		const address = Context.get(services, HttpServer.HttpServer).address
		return "port" in address
			? `http://127.0.0.1:${address.port}`
			: yield* setupFailed("serving twin A")("its server holds no TCP address")
	})

/** An operation of the login's document: the digest of its `x-grizzle-wire`. */
const operationDigest: Reader<string> = property("x-grizzle-wire", property("digest", string))

/** The login's OpenAPI document, as far as the tier reads it: each path's POST operation's digest, by the path. */
const loginDocument: Reader<Readonly<Record<string, string>>> = property(
	"paths",
	record(string, property("post", operationDigest))
)

/** Each program's digest, by the program's name: the last segment of its operation's path. */
const digestsOf = (document: string) =>
	Effect.map(readText("the login's OpenAPI document", loginDocument, document), (paths) => {
		const digests: ReadonlyMap<string, string> = new Map(
			Arr.map(Rec.toEntries(paths), ([route, digest]) => [
				Option.getOrElse(Arr.last(Str.split("/")(route)), () => route),
				digest
			])
		)
		return digests
	})

/** The author config: the login's names, A's origin bound, plain HTTP allowed for the loopback server. */
const configOf = (url: string): string =>
	jsonText({
		package: { name: "gz-eocg", version: "1.0.0" },
		binName: "gz-eocg",
		envPrefix: "GZ_EOCG",
		acceptedOrigins: [url],
		allowInsecure: true
	})

/** The twins and the CLI, set up once on each worker that runs the tier (see the header). */
export const twinsNeed: Need<Twins> = {
	key: "test/grizzle/twins.ts twinsNeed",
	budget: cliNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const bin = yield* grizzleBin
		const draft = yield* drafted(bin)
		const opened = yield* emptyDatabase.open
		const a = yield* twinOf(bin, draft, opened.clone)
		const b = yield* twinOf(bin, draft, opened.clone)
		const url = yield* servedOverHttp(a.handler)
		const digests = yield* stepOf("reading the login's document", digestsOf(draft.document))
		const digest = yield* stepOf("building SHA-256", Layer.build(NodeCrypto.layerDigest))
		const generated = yield* stepOf(
			"generating the CLI",
			Effect.provideService(
				generateFixture({
					spec: { path: "openapi.json", text: draft.document },
					config: { path: "author-config.json", text: configOf(url) },
					authorFiles: []
				}),
				Digest.Digest,
				Context.get(digest, Digest.Digest)
			)
		)
		const built = yield* stepOf("building the CLI", buildPackage(generated))
		const commands: ReadonlyMap<string, ReadonlyArray<string>> = new Map(
			Arr.flatMap(generated.result.report.commandNames, (name) =>
				Arr.map(
					Arr.filter(Arr.fromIterable(digests.keys()), (program) =>
						Str.endsWith(`~1${program}/post`)(name.pointer)
					),
					(program) => [program, name.path] as const
				)
			)
		)
		const twins: Twins = { url, a, b, digests, built, commands }
		yield* stepOf("standing twin A's live source", warm(twins, a))
		yield* stepOf("standing twin B's live source", warm(twins, b))
		return twins
	}).pipe(Effect.map(Effect.succeed))
}
