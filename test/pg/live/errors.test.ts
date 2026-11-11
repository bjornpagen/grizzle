/**
 * Every failure class grizzle produces on a live call arrives as its CallError event, with the retry its meaning
 * gives it: `never` where the same call meets the same answer, so sending it again changes nothing; `safe` where the
 * call changed nothing and the failure was not its own, so sending it again once the fault is gone succeeds.
 *
 * The fixture is a notebook (built here): a context `Session` of one claim `sub`, a mutable relation `Note` of an id,
 * an author and a body, and a role `writer` holding `MyNote`, the notes whose author is the session's `sub`, which it
 * reads (`notes`), inserts into (`add`) and puts (`edit`); beside it a direct SQL writer holding `Note` whole. It is
 * installed as generate drafts it, and each case sends one drawn failing call, over HTTP (the handler, a request the
 * case writes) or in process (a Db opened with the case's token):
 *
 * - a path no program serves, and a method other than POST: `route`;
 * - a body that is no JSON, and a fact whose field is of another type: `input`;
 * - an Authorization header that is no bearer token, no token for a role that reads a context, and claims that do not
 *   decode: `tokenRefused`;
 * - a note whose id a stored note holds: `refused`, by the primary key;
 * - a note whose author is not the session's `sub`: `outsideWorld`;
 * - an edit of a note a direct writer holds, its UPDATE waiting on the writer's lock until the writer commits:
 *   `transient`, SERIALIZABLE's refusal of a concurrent update.
 *
 * Properties: the call's answer is exactly its one error event and its end (no item before it); the error's kind is
 * the class's; its retry is the classification's (live/events.ts callErrors); and the retry holds operationally: a
 * `never` call sent again meets the same kind, and a `safe` call changed nothing (the stored notes are as before it)
 * and, sent again once its fault is gone, succeeds.
 *
 * The oracle is the specification of each failure's meaning, which the drawn fault states, and the database's own
 * state; the scripted classes (transport, unavailable, stale, commitUnknown, failed) are test/unit/live/flights.test.ts's.
 *
 * Features: each class above, each surface.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Fiber, Formatter } from "effect"
import { served } from "#adapter/public/layer.ts"
import { type CallError, type CallErrorKind, callErrors } from "#compiler/live/index.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	context,
	login,
	mutable,
	relation,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { errorOf, liveSurfaces, wireOf } from "#test/support/live/calls.ts"
import { commitDirectly, insertRow, updateRow } from "#test/support/live/direct.ts"
import type { RawEvent } from "#test/support/live/system.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/** A call's body with no parameter and no fact, as a request writes it. */
const emptyBody = `{"params":{},"facts":{}}`

/** What a call ended as: its error's class, or a success. */
const outcomeKind = <A>(
	call: Effect.Effect<A, CallError>
): Effect.Effect<CallErrorKind | "succeeded"> =>
	Effect.match(call, {
		onFailure: (error): CallErrorKind | "succeeded" => error.kind,
		onSuccess: (): CallErrorKind | "succeeded" => "succeeded"
	})

class Misclassified extends Data.TaggedError("Misclassified")<{ readonly report: string }> {}

/** The notebook under `name`: its schema, its writer's login and the direct writer's. */
const notebook = (name: string) => {
	const Session = context("Session", { sub: pg.integer })
	const Note = relation("Note", { id: pg.integer, author: pg.integer, body: pg.integer }, ["id"])
	const base = schema(name, { Note }, [mutable(Note)])
	const mine = query(base).rule((r) => {
		const { id, author, body } = v(Note, "note")
		return r
			.match(Note, { id, author, body })
			.match(Session, { sub: author })
			.find({ id, author, body })
	})
	const writer = role(base, "writer", { MyNote: mine }, { write: ["MyNote"] })
	const { MyNote } = writer.relations
	const notes = query(writer).rule((r) => {
		const { id, author, body } = v(MyNote, "mine")
		return r.match(MyNote, { id, author, body }).find({ id, author, body })
	})
	const direct = role(base, "direct", wholeEntriesOf(base), { write: ["Note"] })
	return {
		schema: base,
		writer,
		direct,
		app: login(base, "app", [writer], {
			workload: [
				workload(writer, {
					notes,
					add: ChangeSet.empty(writer).insert(MyNote, []),
					edit: ChangeSet.empty(writer).put(MyNote, [])
				})
			]
		}),
		psql: login(base, "notes_psql", [direct])
	}
}

/** A failing call's class, as the case provokes it (see the header). */
type Fault =
	| "a path no program serves"
	| "a method other than POST"
	| "a body that is no JSON"
	| "a fact of another type"
	| "a header that is no bearer token"
	| "no token"
	| "claims that do not decode"
	| "a stored note's id"
	| "a note of another author"
	| "an edit of a held note"

/**
 * The faults only an HTTP request carries: its path, method, body and header are the request's own, and a Db of a role
 * that reads a context opens with a token by its type.
 */
const httpOnly: ReadonlySet<Fault> = new Set<Fault>([
	"a path no program serves",
	"a method other than POST",
	"a body that is no JSON",
	"a header that is no bearer token",
	"no token"
])

/** The class each fault's meaning gives it (see the header). */
const classOf = (fault: Fault): CallErrorKind => {
	switch (fault) {
		case "a path no program serves":
		case "a method other than POST":
			return "route"
		case "a body that is no JSON":
		case "a fact of another type":
			return "input"
		case "a header that is no bearer token":
		case "no token":
		case "claims that do not decode":
			return "tokenRefused"
		case "a stored note's id":
			return "refused"
		case "a note of another author":
			return "outsideWorld"
		case "an edit of a held note":
			return "transient"
	}
}

interface Provoked {
	readonly fault: Fault
	readonly overHttp: boolean
	readonly sub: number
	readonly id: number
	readonly body: number
}

const faultGen: Gen<Fault> = weighted<Fault>([
	[1, () => "a path no program serves"],
	[1, () => "a method other than POST"],
	[1, () => "a body that is no JSON"],
	[1, () => "a fact of another type"],
	[1, () => "a header that is no bearer token"],
	[1, () => "no token"],
	[1, () => "claims that do not decode"],
	[2, () => "a stored note's id"],
	[2, () => "a note of another author"],
	[2, () => "an edit of a held note"]
])

const provokedGen: Gen<Provoked> = (source) => {
	const fault = source.draw(faultGen)
	return {
		fault,
		overHttp: httpOnly.has(fault) || source.draw(boolean),
		sub: source.draw(int(1, 3)),
		id: source.draw(int(1, 4)),
		body: source.draw(int(0, 9))
	}
}

type Feature = CallErrorKind | "over HTTP" | "in process"

const cases = 40

/** The error a call's raw answer ends with, its events being exactly that error and its end. */
const rawError = (events: ReadonlyArray<RawEvent>) => {
	assert.deepEqual(
		Arr.map(events, (e) => e.type),
		["error", "end"],
		"a failing call's answer is its one error event and its end"
	)
	return errorOf(defined(events[0], "the error event"))
}

layer(Substrate.layer)("a failing live call", (it) => {
	it.effect(
		`ends with its class's CallError, whose retry holds when the call is sent again, over ${cases} drawn failures`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "each failure's meaning (live/events.ts callErrors) and the database's own state"
						},
						suite: "pg/live/errors",
						draw: drawn(provokedGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"route",
								"input",
								"tokenRefused",
								"refused",
								"outsideWorld",
								"transient",
								"over HTTP",
								"in process"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: cases,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(p, notes) =>
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const generated = yield* installGenerated(
								(name) => {
									const book = notebook(name)
									return { schema: book.schema, logins: [book.app, book.psql] }
								},
								{ label: "live errors", ambient: ordinarySession }
							)
							const installed = generated.installed
							const built = notebook(installed.declared)
							const file = served(defined(generated.served.get("app"), "app's served file"), "app")
							const layerOf = sourcedDbLayer(installed, {
								...clusterConnection(
									installed.cluster,
									installed.database,
									installed.as(built.app).password
								),
								pool: clusterPool,
								login: file,
								verify: testVerify
							})
							const directWriter = yield* substrate.session(
								worldSession(installed.world(built.direct))
							)
							yield* commitDirectly(directWriter, [
								insertRow(installed.plan, "Note", { id: p.id, author: p.sub, body: p.body })
							])
							const expected = classOf(p.fault)
							notes.note(expected)
							notes.note(p.overHttp ? "over HTTP" : "in process")
							yield* Effect.gen(function* () {
								const token =
									p.fault === "claims that do not decode"
										? tokenOf({ sub: "not a number" })
										: tokenOf({ sub: p.sub })
								const surfaces = yield* liveSurfaces(file, "writer", token)
								/** The notes member's wire digest, which a call to it names to be read at all. */
								const wire = wireOf(file, "writer", "notes")
								const note = (author: number) => ({ id: p.id, author, body: p.body + 1 })
								const call = (): Effect.Effect<CallErrorKind | "succeeded"> => {
									switch (p.fault) {
										case "a path no program serves":
											return Effect.map(
												surfaces.raw({
													method: "POST",
													path: "/app/writer/nothing",
													headers: {},
													body: "{}"
												}),
												(events) => rawError(events).kind
											)
										case "a method other than POST":
											return Effect.map(
												surfaces.raw({
													method: "GET",
													path: "/app/writer/notes",
													headers: {},
													body: "{}"
												}),
												(events) => rawError(events).kind
											)
										case "a body that is no JSON":
											return Effect.map(
												surfaces.raw({
													method: "POST",
													path: "/app/writer/notes",
													headers: {
														authorization: `Bearer ${tokenOf({ sub: p.sub })}`,
														"grizzle-wire": wire
													},
													body: "{ not json"
												}),
												(events) => rawError(events).kind
											)
										case "a header that is no bearer token":
											return Effect.map(
												surfaces.raw({
													method: "POST",
													path: "/app/writer/notes",
													headers: { authorization: "Basic dXNlcjpwYXNz", "grizzle-wire": wire },
													body: emptyBody
												}),
												(events) => rawError(events).kind
											)
										case "no token":
											return Effect.map(
												surfaces.raw({
													method: "POST",
													path: "/app/writer/notes",
													headers: { "grizzle-wire": wire },
													body: emptyBody
												}),
												(events) => rawError(events).kind
											)
										case "claims that do not decode":
											return outcomeKind(
												(p.overHttp ? surfaces.http : surfaces.inProcess).once("notes", {
													params: {},
													facts: {}
												})
											)
										case "a fact of another type":
											return outcomeKind(
												(p.overHttp ? surfaces.http : surfaces.inProcess).write("add", {
													params: {},
													facts: {
														insert: { MyNote: [{ id: p.id + 10, author: p.sub, body: "a text" }] }
													}
												})
											)
										case "a stored note's id":
											return outcomeKind(
												(p.overHttp ? surfaces.http : surfaces.inProcess).write("add", {
													params: {},
													facts: { insert: { MyNote: [note(p.sub)] } }
												})
											)
										case "a note of another author":
											return outcomeKind(
												(p.overHttp ? surfaces.http : surfaces.inProcess).write("add", {
													params: {},
													facts: { insert: { MyNote: [{ ...note(p.sub + 1), id: p.id + 10 }] } }
												})
											)
										case "an edit of a held note":
											return outcomeKind(
												(p.overHttp ? surfaces.http : surfaces.inProcess).write("edit", {
													params: {},
													facts: { put: { MyNote: [note(p.sub)] } }
												})
											)
									}
								}
								/** The class `kind` the call ended with, held to the expected class. */
								const judge = (kind: CallErrorKind | "succeeded") =>
									kind === expected
										? Effect.void
										: Effect.fail(
												new Misclassified({
													report: `${p.fault} ended as ${kind}, its meaning is ${expected} (retry ${callErrors[expected].retry})`
												})
											)
								if (p.fault === "an edit of a held note") {
									yield* directWriter.begin
									yield* directWriter.query(
										updateRow(installed.plan, "Note", { id: p.id, body: p.body + 100 }),
										[]
									)
									const edit = yield* Effect.forkChild(call())
									yield* substrate.awaitBlockedBy(directWriter.pid, installed.as(built.app).role)
									yield* directWriter.commit
									const kind = yield* Fiber.join(edit)
									yield* judge(kind)
									const again = yield* call()
									if (again !== "succeeded") {
										return yield* new Misclassified({
											report: `a safe ${kind} sent again once its fault was gone met ${again}`
										})
									}
									return
								}
								const kind = yield* call()
								yield* judge(kind)
								const again = yield* call()
								if (again !== kind) {
									return yield* new Misclassified({
										report: `a ${kind}, retried never, sent again met ${again}`
									})
								}
							}).pipe(withLayer(layerOf))
						}).pipe(Effect.scoped)
				)
			)
	)
})
