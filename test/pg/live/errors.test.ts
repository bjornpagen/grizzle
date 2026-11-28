/**
 * Every failure class grizzle produces on a live call arrives as its CallError event, with the retry its meaning
 * gives it: `never` where the same call meets the same answer, so sending it again changes nothing; `safe` where the
 * call changed nothing and the failure was not its own, so sending it again once the fault is gone succeeds.
 *
 * The fixture is a notebook (built here): a context `Session` of one claim `sub`, a mutable relation `Note` of an id,
 * an author and a body, and a role `writer` holding `MyNote`, the notes whose author is the session's `sub`, which it
 * reads (`notes`, and `tagged`, each note with a parameter `tag` of the pattern ^[a-z]{1,8}$), inserts into (`add`) and
 * puts (`edit`); beside it a direct SQL writer holding `Note` whole. It is
 * installed as generate drafts it, and each case sends one drawn failing call, over HTTP (the handler, a request the
 * case writes) or in process (a Db opened with the case's token):
 *
 * - a path no program serves, and a method other than POST: `route`;
 * - a body that is no JSON, and a fact whose field is of another type: `input`, the server's parse's refusal of the body
 *   and the client's of a value it cannot encode, before any request;
 * - a watch of `tagged` whose `tag` is outside its pattern: `paramRejected`, PostgreSQL's refusal as it binds the
 *   parameter, and the answer's one event before its end: an input refused never opens an answer, so no `reset` comes
 *   before it (adapter/reader/stream.ts);
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
 * Features: each class above, each surface, a watch refused by its parameter's pattern.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Fiber, Formatter } from "effect"
import { served } from "#adapter/public/layer.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type CallErrorKind, callErrors } from "#compiler/live/index.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import {
	classOf,
	emptyBody,
	type Feature,
	Misclassified,
	notebook,
	outcomeKind,
	provokedGen,
	rawError,
	watched
} from "#test/pg/live/errors.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { liveSurfaces, wireOf } from "#test/support/live/calls.ts"
import { commitDirectly, insertRow, updateRow } from "#test/support/live/direct.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import {
	baseSubstrate,
	claimsOfNoFact,
	Substrate,
	worldSession
} from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/**
 * A failing live call ends with its class's CallError, whose retry holds when the call is sent again, over drawn failures.
 */
export const aFailingLiveCallEndsWithItsClasssCallErrorWhoseRetryHoldsWhenTheCallIsSentAgainOverCasesDrawnFailures =
	property.explore(provokedGen, {
		needs: { substrate2: Substrate.fresh(baseSubstrate) },
		situations: [
			"route",
			"input",
			"paramRejected",
			"tokenRefused",
			"refused",
			"outsideWorld",
			"transient",
			"over HTTP",
			"in process",
			"a watch refused by its parameter's pattern"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate2 }, notes: Case<Feature>) =>
			(p) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const generated = yield* installGenerated(
							(name) => {
								const book = notebook(name)
								return { schema: book.schema, logins: [book.app, book.psql] }
							},
							{ label: "live_errors", ambient: ordinarySession }
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
							worldSession(installed.world(built.direct), claimsOfNoFact)
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
							/** The served layer's context the in-process watch opens its Db in, as the surfaces do. */
							const dbContext = yield* Effect.context<DbLayerOf<AnyLogin>>()
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
									case "a parameter outside its pattern": {
										notes.note("a watch refused by its parameter's pattern")
										const input = { params: { tag: p.tag }, facts: {} }
										if (p.overHttp) {
											return Effect.map(
												surfaces.raw({
													method: "POST",
													path: "/app/writer/tagged",
													headers: {
														authorization: `Bearer ${token}`,
														"grizzle-wire": wireOf(file, "writer", "tagged")
													},
													body: jsonText(input)
												}),
												(events) => rawError(events).kind
											)
										}
										return Effect.map(
											Effect.provideContext(watched(file, token, "tagged", input), dbContext),
											(events) => {
												const [only, ...more] = events
												assert.ok(
													only?._tag === "error" && more.length === 0,
													`a refused input's watch answers its one error, no reset before it: ${Formatter.format(Arr.map(events, (e) => e._tag))}`
												)
												return only.error._tag
											}
										)
									}
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
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate2, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "each failure's meaning (live/events.ts callErrors) and the database's own state"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/live/codec.ts",
				original:
					"\t\tResult.mapError(encodeGiven(field.scalar, value), (kind) => ({ kind, at })),\n",
				replacement: "\t\tResult.ok(encodeScalar(field.scalar, value)),\n",
				why: "The client encodes a caller's value of another type than its scalar's host type by the server's trusting encode, so a fact of another type sent over HTTP dies \"grizzle internal invariant: a int4 host value to encode\" where the call owes its `input` CallError: this property's red on main (replay pg/live/errors:-:3.1.0.0.0), which 5401c9c70 fixed."
			},
			{
				file: "packages/grizzle/src/adapter/reader/stream.ts",
				original: "\tconst pending = [reset]\n",
				replacement: "\toffer(reset)\n\tconst pending: Array<E> = []\n",
				why: "A read offers its reset at once, before it has answered, so a watch whose parameter PostgreSQL refuses by its pattern answers a reset and then its error, telling the client a fresh answer began: the defect qti-pie's peer run met, which 5401c9c70 fixed and this property's fault \"a watch refused by its parameter's pattern\" holds."
			}
		]
	})
