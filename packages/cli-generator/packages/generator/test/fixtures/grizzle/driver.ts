/**
 * The grizzle side of the generator's end-to-end suite (test/grizzle/once.test.ts): a process that installs one login
 * twice and answers over JSON lines, so a CLI the generator built from the login's OpenAPI document calls one twin over
 * HTTP while this process answers the same calls in process on the other, the oracle. It imports grizzle's own modules,
 * so it is typechecked and run inside grizzle's pinned checkout, vendor/grizzle, never in this workspace:
 * test/support/grizzle.ts copies it to vendor/grizzle/.probe-eocg/driver.ts (a directory grizzle's .gitignore keeps
 * out of its tree) and checks it there under grizzle's own compiler options and Effect diagnostics, its one file
 * override saying it is an entry point that serves over node:http.
 *
 * The login is fixed (`world`): one relation of every carrier a CLI flag spells differently (an int4 key, an int8, a
 * numeric(12, 2), a money, a boolean, a float4, a refined text, a date, bytes and a uuid), a law that refuses an id
 * below 1, and one member of every shape its role serves: a set read by an int8 floor, a set read by a refined text, a
 * key, an ordered read paged from either end, a read at its call's instant bound to the database's clock, a put, and a
 * deletion of every item.
 *
 * A run is one install, any number of cases, and one uninstall, read from stdin one command per line:
 *
 * - `{"op":"install"}` installs the login twice as `grizzle generate` drafts and serves it
 *   (test/support/install-migrate.ts installGenerated), serves twin A over HTTP on 127.0.0.1 at a port the system
 *   chooses (http/index.ts httpHandler and nodeListener over A's DbLayer), its live source standing (`warm`), and opens
 *   twin B's role in process. It answers A's base URL, the login's document as `grizzle generate` writes it
 *   (live/openapi.ts openApiText), and how long grizzle lets one case of its own searches run (test/support/limits.ts
 *   caseHang), which a case through this process is bounded by too.
 * - `{"op":"store","stored":[...]}` begins a case: each twin's items are deleted (its `clear`), then the facts
 *   `stored` put (its `put`), in process, each of which must answer an outcome.
 * - `{"op":"once","program":"<name>","body":<JSON>}` calls the member `program` of twin B once in process
 *   (adapter/db/handles.ts memberCalls), with the body parsed as the HTTP door parses it (live/codec.ts parseInput): it
 *   answers a read's rows in its order, a write's outcome, or the CallError, each as the server's frames encode it
 *   (live/codec.ts slotEncoders). A body the door refuses is the CallError `input`, whose message names the fault.
 * - `{"op":"uninstall"}` ends the run: A's server stops, both twins' layers close and their schemas are dropped.
 *
 * Every answer is one line on stdout, `reply ` then its JSON; any other line there is a diagnostic. A command that does
 * not decode, a command out of its order, or a case's facts that do not store, fails the process, which exits 1 with
 * the cause on stderr. The end of stdin ends the process, closing an open installation.
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Console,
	Data,
	Duration,
	Effect,
	Option,
	Pull,
	Result,
	Schema,
	Stdio,
	Stream
} from "effect"
import { memberCalls, type ServedCalls } from "#adapter/db/handles.ts"
import { openServed } from "#adapter/db/served.ts"
import { toResult } from "#adapter/engine.ts"
import type { LoadedMember, LoadedRole } from "#adapter/served/load.ts"
import { openApiText } from "#compiler/live/openapi.ts"
import {
	type CallError,
	callError,
	parseInput,
	slotEncoders,
	type WireJson,
	type WireOptions,
	wireText
} from "#compiler/plan/runtime.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, date, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, mutable, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { clocked, paged } from "#compiler/public/workload.ts"
import { type HttpHandler, httpHandler, nodeListener } from "#http/index.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { servedFixtureOf } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** A name of lower-case letters, one to eight. */
const Name = str.regex("^[a-z]{1,8}$")

const Item = relation(
	"Item",
	{
		id: pg.integer,
		big: pg.bigint,
		amount: pg.numeric(12, 2),
		cash: pg.money,
		flag: pg.boolean,
		ratio: pg.real,
		name: Name,
		day: date,
		blob: bytes,
		tag: uuid
	},
	["id"]
)

/** The items' schema under the name `name` an installation is allocated: an id below 1 is refused by its law. */
const itemsNamed = (name: string) =>
	schema(name, [Item], [mutable(Item), check("Counted", Item, (x) => x.ge(x.id, 1))])

const Items = itemsNamed("Items")

/**
 * The login's members: a set read by an int8 floor, a set read by a name, a key, an ordered read by its windows, a read
 * of the items whose int8 is at most the database's clock in milliseconds at the call's instant, a put, and a deletion
 * of every item.
 */
const programs = Object.freeze({
	atLeast: query(Items).rule((r) => {
		const item = v(Item, "item")
		return r
			.match(Item, item)
			.where(r.ge(item.big, r.param("floor", pg.bigint)))
			.find(item)
	}),
	named: query(Items).rule((r) => {
		const item = v(Item, "item")
		return r
			.match(Item, item)
			.where(r.eq(item.name, r.param("name", Name)))
			.find(item)
	}),
	ranked: paged(
		query(Items)
			.rule((r) => {
				const item = v(Item, "item")
				return r.match(Item, item).find(item)
			})
			.orderBy(["big", "desc"], ["id", "asc"])
	),
	item: Item,
	past: clocked(
		query(Items).rule((r) => {
			const item = v(Item, "item")
			return r
				.match(Item, item)
				.where(r.le(item.big, r.param("now", pg.bigint)))
				.find(item)
		}),
		{ now: "millis" }
	),
	put: ChangeSet.empty(Items).put(Item, []),
	clear: ChangeSet.empty(Items).delete(
		Item,
		query(Items).rule((r) => {
			const item = v(Item, "item")
			return r.match(Item, item).find(item)
		})
	)
})

/** The login over the schema named `name`. */
const world = (name: string) => fullWorld(itemsNamed(name), programs)

/** Effect's Option, as the HTTP door reads and writes a member's wire (http/handler.ts wireOptions). */
const wireOptions: WireOptions = {
	some: Option.some,
	none: Option.none(),
	is: Option.isOption,
	fold: Option.match
}

/** A command of the suite. */
const Command = Schema.Union([
	Schema.Struct({ op: Schema.Literal("install") }),
	Schema.Struct({ op: Schema.Literal("store"), stored: Schema.Array(Schema.Json) }),
	Schema.Struct({ op: Schema.Literal("once"), program: Schema.String, body: Schema.Json }),
	Schema.Struct({ op: Schema.Literal("uninstall") })
])
type Command = typeof Command.Type

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(Command))

/** A failure the suite did not ask for: a command that does not decode or comes out of order, or a case not set up. */
class DriverDefect extends Data.TaggedError("DriverDefect")<{ readonly text: string }> {}

/** What one call answers: a read's rows in its order, a write's outcome, or its CallError, as the frames encode each. */
type Answer =
	| { readonly kind: "rows"; readonly rows: ReadonlyArray<WireJson> }
	| { readonly kind: "outcome"; readonly outcome: WireJson }
	| { readonly kind: "error"; readonly error: WireJson }

/** One answer, written as its own line. */
const reply = (json: WireJson): Effect.Effect<void> => Console.log(`reply ${wireText(json)}`)

/** The member of a role named `name`. */
const memberNamed = (
	members: ReadonlyArray<LoadedMember>,
	name: string
): Effect.Effect<LoadedMember, DriverDefect> =>
	Effect.mapError(
		Effect.fromOption(Arr.findFirst(members, (m) => m.name === name)),
		() => new DriverDefect({ text: `the role serves no program ${name}` })
	)

/** A read's rows in its order, or its CallError. */
const rowsOf = (
	once: Effect.Effect<Iterable<object>, CallError>,
	row: (value: object) => WireJson
): Effect.Effect<Answer, CallError> =>
	Effect.map(once, (value) => ({ kind: "rows", rows: Arr.map(Arr.fromIterable(value), row) }))

/** What `calls` answers the parsed input `input`, or its CallError. */
const calledOnce = (
	calls: ServedCalls,
	input: unknown,
	slots: ReturnType<typeof slotEncoders>
): Effect.Effect<Answer, CallError> => {
	switch (calls.shape) {
		case "set":
		case "list":
		case "instantSet":
		case "instantList":
			return rowsOf(calls.once(input), slots.row)
		case "write":
			return Effect.map(calls.once(input), (outcome) => ({
				kind: "outcome",
				outcome: slots.outcome(outcome)
			}))
	}
}

/** What one call of `member` of `role` answers the body `body` (see the header). */
const answerOf = (
	role: LoadedRole,
	member: LoadedMember,
	calls: ServedCalls,
	body: WireJson
): Effect.Effect<Answer> => {
	const slots = slotEncoders(member.wire.member, role.wire.witness, wireOptions)
	return Result.match(toResult(parseInput(member.wire.member.input, body)), {
		onFailure: (fault) =>
			Effect.succeed({
				kind: "error",
				error: slots.error(
					callError("input", {
						message: `${fault.kind} at ${Arr.join(
							Arr.map(fault.at, (step) => `${step}`),
							"."
						)}`
					})
				)
			}),
		onSuccess: (input) =>
			Effect.catch(calledOnce(calls, input, slots), (error) =>
				Effect.succeed<Answer>({ kind: "error", error: slots.error(error) })
			)
	})
}

/** A server on 127.0.0.1 at a port the system chooses, answering `handler`, closed with its connections at scope end. */
const listening = (handler: HttpHandler) =>
	Effect.acquireRelease(
		Effect.callback<Server>((resume) => {
			const server = createServer(nodeListener(handler))
			server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
		}),
		(server) =>
			Effect.callback<void>((resume) => {
				server.closeAllConnections()
				server.close(() => resume(Effect.void))
			})
	)

/** The port a listening server holds. */
const portOf = (server: Server): Effect.Effect<number, DriverDefect> => {
	const address: AddressInfo | string | null = server.address()
	return typeof address === "object" && address !== null
		? Effect.succeed(address.port)
		: Effect.fail(new DriverDefect({ text: "the server holds no TCP address" }))
}

/**
 * The role's live reads made ready to register: the installation's replication slot, which its live leader makes at the
 * first watch, stands. A set read is watched to its first `ready`, again while it ends `unavailable` (the slot does not
 * stand yet, or its making invalidated the source the watch listened on), so the first call the CLI makes over HTTP
 * meets a live source that stands, as a deployed server's does once it has served one live read.
 */
const warm = (
	members: ReadonlyArray<LoadedMember>,
	ctx: Parameters<typeof memberCalls>[0]
): Effect.Effect<void, DriverDefect> =>
	Effect.gen(function* () {
		const member = yield* memberNamed(members, "atLeast")
		const calls = memberCalls(ctx, member)
		const parsed = toResult(
			parseInput(member.wire.member.input, { params: { floor: "0" }, facts: {} })
		)
		if (calls.shape !== "set" || Result.isFailure(parsed)) {
			return yield* new DriverDefect({ text: "atLeast is a set read of a floor" })
		}
		const watched = calls.watch(parsed.success).pipe(
			Stream.takeUntil((event) => event.kind === "ready" || event.kind === "error"),
			Stream.runLast
		)
		yield* Effect.flatMap(watched, (last) =>
			Option.isSome(last) && last.value.kind === "error"
				? Effect.fail(last.value.error)
				: Effect.void
		).pipe(
			Effect.retry({ while: (error) => error.kind === "unavailable" }),
			Effect.mapError(
				(error) =>
					new DriverDefect({
						text: `the live source does not stand: ${error.kind} ${error.message}`
					})
			)
		)
	})

/** The outcome `program` of the role answers `body` in process, which must be one. */
const written = (
	role: LoadedRole,
	ctx: Parameters<typeof memberCalls>[0],
	program: string,
	body: WireJson
): Effect.Effect<void, DriverDefect> =>
	Effect.gen(function* () {
		const member = yield* memberNamed(role.members, program)
		const answer = yield* answerOf(role, member, memberCalls(ctx, member), body)
		if (answer.kind !== "outcome") {
			return yield* new DriverDefect({ text: `${program} answers ${wireText(answer)}` })
		}
	})

/** The role's items replaced by `stored`: every item deleted, then `stored` put. */
const store = (
	role: LoadedRole,
	ctx: Parameters<typeof memberCalls>[0],
	stored: ReadonlyArray<WireJson>
): Effect.Effect<void, DriverDefect> =>
	Effect.andThen(
		written(role, ctx, "clear", { params: {}, facts: {} }),
		written(role, ctx, "put", { params: {}, facts: { put: { Item: stored } } })
	)

/** One twin: the login installed as `grizzle generate` drafts it, and served over its installation. */
const twin = Effect.gen(function* () {
	const generated = yield* installGenerated(
		(name) => ({ schema: itemsNamed(name), logins: [world(name).server] }),
		{ label: "eocg", ambient: ordinarySession }
	)
	const login = world(generated.installed.declared).server
	const file = yield* Effect.mapError(
		Effect.fromOption(Option.fromNullishOr(generated.served.get(login.name))),
		() => new DriverDefect({ text: "generate served no file for the login" })
	)
	return servedFixtureOf(generated.installed, login, file)
})

/** The next command, or none once stdin has ended. */
type Next = Effect.Effect<Option.Option<Command>, DriverDefect>

/** The run: the twins installed and served, then each command `next` reads answered until the uninstall. */
const run = (next: Next) =>
	Effect.gen(function* () {
		const [a, b] = yield* Effect.all([twin, twin], { concurrency: "unbounded" })
		const document = openApiText(a.login.file)
		if (!document.ok) {
			return yield* new DriverDefect({ text: "the login's document is not written" })
		}
		yield* Effect.gen(function* () {
			const handler = yield* httpHandler({ logins: [a.login], heartbeatMs: 1_000 })
			const openedA = yield* openServed(a.login.roles.app, {})
			yield* warm(openedA.role.members, openedA.ctx)
			const server = yield* listening(handler)
			const port = yield* portOf(server)
			yield* Effect.gen(function* () {
				const openedB = yield* openServed(b.login.roles.app, {})
				yield* reply({
					url: `http://127.0.0.1:${port}`,
					document: document.value,
					caseHangMillis: Duration.toMillis(caseHang)
				})
				for (;;) {
					const command = yield* next
					if (Option.isNone(command) || command.value.op === "uninstall") {
						return
					}
					switch (command.value.op) {
						case "install":
							return yield* new DriverDefect({ text: "install inside an installation" })
						case "store":
							yield* store(openedA.role, openedA.ctx, command.value.stored)
							yield* store(openedB.role, openedB.ctx, command.value.stored)
							yield* reply({ stored: true })
							break
						case "once": {
							const member = yield* memberNamed(openedB.role.members, command.value.program)
							const answer = yield* answerOf(
								openedB.role,
								member,
								memberCalls(openedB.ctx, member),
								command.value.body
							)
							yield* reply(answer)
							break
						}
					}
				}
			}).pipe(withLayer(b.layer))
		}).pipe(withLayer(a.layer))
		yield* reply({ uninstalled: true })
	}).pipe(Effect.scoped)

/** Reads each command from `pull`, in order, and none once stdin has ended. */
const nextOf = (pull: Effect.Effect<Option.Option<string>, DriverDefect>): Next =>
	Effect.flatMap(pull, (line) =>
		Option.match(line, {
			onNone: () => Effect.succeedNone,
			onSome: (text) =>
				Effect.mapBoth(decodeCommand(text), {
					onFailure: (error) => new DriverDefect({ text: error.message }),
					onSuccess: Option.some
				})
		})
	)

const main = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	const pull = yield* Stream.toPull(Stream.splitLines(Stream.decodeText(stdio.stdin)))
	const lines: Array<string> = []
	const nextLine = Effect.suspend(() => {
		const buffered = lines.shift()
		return buffered !== undefined
			? Effect.succeedSome(buffered)
			: pull.pipe(
					Effect.map((chunk) => {
						lines.push(...chunk)
						return Option.fromNullishOr(lines.shift())
					}),
					Pull.catchDone(() => Effect.succeedNone),
					Effect.mapError((error) => new DriverDefect({ text: `stdin: ${error.message}` }))
				)
	})
	const next = nextOf(nextLine)
	for (;;) {
		const command = yield* next
		if (Option.isNone(command)) {
			return
		}
		if (command.value.op !== "install") {
			return yield* new DriverDefect({ text: `${command.value.op} outside an installation` })
		}
		yield* run(next)
	}
}).pipe(Effect.scoped, Effect.provide([Substrate.layer, NodeServices.layer]))

NodeRuntime.runMain(main)
