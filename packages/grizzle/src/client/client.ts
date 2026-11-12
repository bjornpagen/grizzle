import type * as Arr from "effect/Array"
import type * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Option from "effect/Option"
import * as Rec from "effect/Record"
import type * as Stream from "effect/Stream"
import * as Str from "effect/String"
import { type ClientMember, memberCalls, type ShapedCalls, type Token } from "#client/call.ts"
import {
	type CallError,
	defect,
	type EventOf,
	type InputOf,
	type InstantShape,
	type MemberWire,
	type ShapeOf,
	trusted,
	type ValueOf
} from "#compiler/plan/client.ts"
import type { AnyLogin, AnyRole, LoginReadsContext, LoginRole } from "#compiler/plan/common.ts"

/** clientOf's options with a token: where the login's programs are served, and the token every call sends. */
export interface TokenClientOptions<E> {
	/**
	 * The URL the login's handler is served under: each call posts to it with `/<login>/<role>/<program>` appended to
	 * its path.
	 */
	readonly url: URL
	readonly token: Token<E>
}

/** clientOf's options without a token: a login none of whose roles reads a context sends none. */
export interface UrlClientOptions {
	readonly url: URL
}

/** clientOf's options for login L: with a token, or, exactly when no role of L reads a context, without one. */
export type ClientOptions<L, E> =
	LoginReadsContext<L> extends true
		? TokenClientOptions<E>
		: TokenClientOptions<E> | UrlClientOptions

/** An event of a program X's answer that its value is made of: every event but the error and the end. */
export type ItemOf<X> = Exclude<EventOf<X>, { readonly kind: "error" | "end" }>

/**
 * What a program X's watch yields: its value whole at one committed snapshot, a read's at each `ready` and a write's
 * at its outcome, with the events that made it since the value before, the one that made it whole last.
 */
export interface Watched<X> {
	readonly value: ValueOf<X>
	readonly events: Arr.NonEmptyReadonlyArray<ItemOf<X>>
}

/**
 * A served program X's operations over HTTP, each call one POST of its input (`{ params, facts }`, and a paged
 * program's window) answered by one event stream. Each fails with the server's CallError; with a cut of the exchange,
 * `transport` for a read, which changed nothing, and `commitUnknown` for a write before its outcome; or with the
 * token's own error E. Neither retries: a CallError's `retry` says whether the same call is safe to run again, and the
 * caller decides.
 *
 * - `watch`: every value, whole at a committed snapshot, with the events that made it. A read's stays open, a value
 *   per batch of changes, until the caller interrupts it, which aborts the request; a write's ends after its outcome.
 *   A clocked read (workload Clocked) has none: its answer is its value at its call's instant, then its end.
 * - `once`: the first value, a read's at `ready` and a write's outcome; the request is aborted once it came.
 */
export type ProgramClient<X, E> = [ShapeOf<X>] extends [InstantShape]
	? OnceClient<X, E>
	: OnceClient<X, E> & WatchClient<X, E>

/** A served program X's once over HTTP (ProgramClient). */
interface OnceClient<X, E> {
	readonly once: (
		input: InputOf<X>
	) => Effect.Effect<ValueOf<X>, CallError | E, HttpClient.HttpClient>
}

/** A served program X's watch over HTTP (ProgramClient). */
interface WatchClient<X, E> {
	readonly watch: (
		input: InputOf<X>
	) => Stream.Stream<Watched<X>, CallError | E, HttpClient.HttpClient>
}

/** The programs a role reached through its login runs: P of its LoginRole. */
type ProgramsOfRole<R> = R extends LoginRole<infer _R extends AnyRole, infer P> ? P : never

/** A role's programs by name, each a ProgramClient; a role whose login's workloads serve it none holds none. */
export type RoleClient<P, E> = { readonly [K in keyof P]: ProgramClient<P[K], E> }

/**
 * A login's client: each of its roles by name, each holding its programs by name, `client.<role>.<program>`, as the
 * route `/<login>/<role>/<program>` names them.
 */
export type Client<L, E> = L extends { readonly roles: infer Rs }
	? { readonly [K in keyof Rs]: RoleClient<ProgramsOfRole<Rs[K]>, E> }
	: never

/** A login's operations untyped by the login: each role's by name, each program's calls by name with its shape. */
export type ClientCalls<E> = {
	readonly [role: string]: { readonly [program: string]: ShapedCalls<E> }
}

/**
 * The parts of a login's OpenAPI document (`grizzle generate`'s migrations/<schema>/openapi/<login>.json) the client
 * reads: the login's declared name, and each operation's wire form and its digest, under its path,
 * `/<login>/<role>/<program>`.
 */
interface ClientDocument {
	readonly info: { readonly "x-grizzle-login": string }
	readonly paths: {
		readonly [path: string]: {
			readonly post: {
				readonly "x-grizzle-wire": { readonly digest: string; readonly member: MemberWire }
			}
		}
	}
}

/** The login, the role and the program a path names: `/<login>/<role>/<program>`. */
const routeOf = (
	path: string
): { readonly login: string; readonly role: string; readonly program: string } => {
	const [empty, login, role, program, ...rest] = Str.split(path, "/")
	if (
		empty !== "" ||
		login === undefined ||
		role === undefined ||
		program === undefined ||
		rest.length > 0
	) {
		throw defect(`a document path of the form /<login>/<role>/<program>, ${path}`)
	}
	return { login, role, program }
}

/** The URL a route is posted to: the route's path appended to the base URL's own. */
const urlOf = (base: URL, path: string): URL => {
	const url = new URL(base.href)
	const prefix = Str.endsWith("/")(url.pathname) ? Str.slice(0, -1)(url.pathname) : url.pathname
	url.pathname = `${prefix}${path}`
	return url
}

/** The token clientOf's options carry: none for a login that sends none. */
const tokenOf = <E>(options: TokenClientOptions<E> | UrlClientOptions): Option.Option<Token<E>> =>
	"token" in options ? Option.some(options.token) : Option.none()

/**
 * clientCalls(document, name, options): the client's untyped door, each operation of a login's document by role and
 * by program, with the shape its wire form reads it by, for a caller whose login has no type: one generated at run
 * time. clientOf types the same calls by the login's type.
 *
 * `document` is the login's OpenAPI document as `grizzle generate` wrote it, read once and trusted: grizzle's own
 * file. `name` must be the document's login: a document of another login is a defect of the caller's wiring, refused
 * here, before any call.
 */
export const clientCalls = <E = never>(
	document: unknown,
	name: string,
	options: TokenClientOptions<E> | UrlClientOptions
): ClientCalls<E> => {
	const read = trusted<ClientDocument>(document)
	if (read.info["x-grizzle-login"] !== name) {
		throw defect(
			`a client of login ${name} over the document of login ${read.info["x-grizzle-login"]}`
		)
	}
	const token = tokenOf(options)
	const roles: Record<string, Record<string, ShapedCalls<E>>> = {}
	for (const [path, operation] of Rec.toEntries(read.paths)) {
		const route = routeOf(path)
		if (route.login !== name) {
			throw defect(`a document of login ${name} holding the path ${path}`)
		}
		const wire = operation.post["x-grizzle-wire"]
		const member: ClientMember = {
			route: urlOf(options.url, path),
			digest: wire.digest,
			wire: wire.member
		}
		const programs = roles[route.role] ?? {}
		programs[route.program] = memberCalls(member, token)
		roles[route.role] = programs
	}
	for (const programs of Rec.values(roles)) {
		Object.freeze(programs)
	}
	return Object.freeze(roles)
}

/**
 * clientOf<typeof Login>(document, name, options): the client of a login's served programs over HTTP, typed from the
 * login's type alone, as served<typeof Login>(file, name) types a served login, so no schema module is evaluated:
 * `client.<role>.<program>.watch(input)` and `.once(input)`. Its calls are clientCalls' over the same document, each
 * typed as the login's type states its program: the document is L's, the one site of that trust.
 */
export const clientOf = <L extends AnyLogin, E = never>(
	document: unknown,
	name: NoInfer<L["name"]>,
	options: ClientOptions<L, E>
): Client<L, E> => {
	const roles: Record<string, Record<string, ShapedCalls<E>["calls"]>> = {}
	for (const [role, programs] of Rec.toEntries(clientCalls(document, name, options))) {
		const typed: Record<string, ShapedCalls<E>["calls"]> = {}
		for (const [program, shaped] of Rec.toEntries(programs)) {
			typed[program] = shaped.calls
		}
		roles[role] = Object.freeze(typed)
	}
	return trusted<Client<L, E>>(Object.freeze(roles))
}
