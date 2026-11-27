/** What the properties of services.test.ts read: the services a piece of work sees, and a login whose role writes. */

import { Buffer } from "node:buffer"
import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Context, Effect, Option, Tracer } from "effect"
import pgDriver from "pg"
import { CredentialError } from "#adapter/errors/credential.ts"
import { served } from "#adapter/public/layer.ts"
import type { DbConfigShape } from "#adapter/types/layer.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { compiledServedFile } from "#test/support/compiled-served.ts"
import { Id, toId } from "#test/support/ids.ts"
import { memoryEndpoint, memoryTransport, tlsMaterial } from "#test/support/memory-tls.ts"
import { clusterPool } from "#test/support/pg.ts"

/**
 * The caller a piece of work runs for, as a service of the caller's own: a request's name where a request provides it,
 * the build's where a layer is built under it, and `none` where no caller set it.
 */
const Caller = Context.Reference<string>("@bjornpagen/grizzle/test/Caller", {
	defaultValue: () => "none"
})

/** The name the layer is built under, as its span and as its Caller. */
export const built = "the layer's build"

/**
 * What a piece of work sees as it runs: the Caller its services hold, and the spans it runs under, innermost first,
 * each by its name, none where no span is its parent.
 */
export interface Seen {
	readonly caller: string
	readonly spans: ReadonlyArray<string>
}

/** The names of `span` and every span above it, innermost first. */
const chainOf = (span: Option.Option<Tracer.AnySpan>): ReadonlyArray<string> =>
	Option.match(span, {
		onNone: () => [],
		onSome: (s) => (s._tag === "Span" ? [s.name, ...chainOf(s.parent)] : [])
	})

/** What the work running it sees (Seen). */
export const seen: Effect.Effect<Seen> = Effect.gen(function* () {
	const caller = yield* Caller
	const parent = yield* Effect.serviceOption(Tracer.ParentSpan)
	return { caller, spans: chainOf(parent) }
})

/** `effect` run for the caller `name`: its Caller `name`, under a span of that name. */
export const asCaller =
	(name: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		effect.pipe(Effect.withSpan(name), Effect.provideService(Caller, name))

/** Whether `spans` hold no span of a caller among `callers`, the build's among them. */
export const underNone = (spans: ReadonlyArray<string>, callers: ReadonlyArray<string>): boolean =>
	!Arr.some(spans, (span) => callers.includes(span))

/** A login whose one role writes a relation through a member, so an HTTP handler serves it a route. */
const Item = relation("Item", { id: Id, owner: Id }, ["id"])

const Shelf = schema("Shelf", [Item], [])

const shelver = role(Shelf, "shelver", { Item }, { insert: ["Item"] })

/** A write, whose call leases a session for its transaction and registers no live read. */
const shelve = ChangeSet.empty(Shelf).insert(Item, [])

const Shelving = login(Shelf, "shelving", [shelver], {
	workload: [workload(shelver, { shelve })]
})

/** The login served as its type, over its real served file compiled with no database. */
export const ShelvingServed = served<typeof Shelving>(compiledServedFile(Shelving), "shelving")

/** PostgreSQL's AuthenticationCleartextPassword: `R`, its length, and the request's code, 3. */
const passwordRequest = (() => {
	const out = Buffer.alloc(9)
	out.write("R", 0, "latin1")
	out.writeInt32BE(8, 1)
	out.writeInt32BE(3, 5)
	return out
})()

const material = tlsMaterial("services.grizzle.test")

/**
 * A server that asks every connection for its password, past the SSLRequest and verify-full TLS, once its startup
 * packet arrives, and answers nothing more: what makes pg call a connection's password, which the property's refuses.
 */
const asking = memoryEndpoint(material, (secure) => {
	secure.once("data", () => {
		secure.write(passwordRequest)
	})
	secure.on("error", () => undefined)
})

/**
 * The login's connection, whose every attempt reaches a server that asks for its password: the password records what
 * it sees into `into` and refuses, so no call runs past its lease.
 */
export const shelvingConfig = (into: Array<Seen>): DbConfigShape<typeof Shelving> => ({
	driver: pgDriver,
	transport: memoryTransport(material, asking),
	database: "services",
	password: Effect.flatMap(seen, (s) => {
		into.push(s)
		return Effect.fail(
			new CredentialError({ cause: "the property's password refuses every attempt" })
		)
	}),
	pool: clusterPool,
	login: ShelvingServed
})

/** The input of every call of the write: its one row. */
export const shelveInput = {
	params: {},
	facts: {
		insert: {
			Item: [
				{
					id: toId("00000000-0000-4000-8000-000000000001"),
					owner: toId("00000000-0000-4000-8000-000000000002")
				}
			]
		}
	}
} as const

/** The input as an HTTP request's body carries it. */
export const shelveBody = jsonText(shelveInput)

/** The door a call opens its Db through: Db.open in the caller's fiber, or an HTTP request to the handler's route. */
export type Door = "Db.open" | "HTTP"

export type ServicesFeature =
	| "a source opened by its first watch"
	| "a watch joining an open source"
	| "a source opened again after one was lost"
	| "a Db opened by Db.open"
	| "a Db opened by an HTTP request"
