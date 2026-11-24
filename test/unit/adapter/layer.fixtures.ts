/** What the properties of layer.test.ts read: its spaces, models and helpers. */

import net from "node:net"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { uuid as uuidValue } from "@bjornpagen/testing/values"
import {
	Array as Arr,
	Effect,
	Exit,
	Formatter,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	String as Str
} from "effect"
import pgDriver from "pg"
import { type StartupVariable, startupVariableNames } from "#adapter/connection/environment.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { ClaimRefused, type SettingRule } from "#adapter/errors/failures.ts"
import { served } from "#adapter/public/layer.ts"
import type { DbConfigShape } from "#adapter/types/layer.ts"

import { nonEmpty } from "@bjornpagen/testing/assert"
import { query, v } from "#compiler/public/query.ts"
import { context, login, relation, role, schema } from "#compiler/public/schema.ts"
import { compiledServedFile } from "#test/support/compiled-served.ts"
import { Id } from "#test/support/ids.ts"
import { tlsMaterial } from "#test/support/memory-tls.ts"
import { processValue, variableGen, type VariableValue } from "#test/support/process-env.ts"

/**
 * DbLayer.make parses its DbConfig once, where it is given (packages/grizzle/src/adapter/pool/served.ts, connection/config.ts), and a
 * config no connection can use fails the layer before any connection.
 *
 * Over drawn configs (tricky hosts, never a path, servernames, databases and passwords; a Redacted or an Effect
 * password; a CA as one PEM text or a list; pool bounds across their ranges, their ends included;
 * a pool hook and a verify or none) for a login whose roles read no context, a valid one builds its layer, which opens
 * no session until a Db is opened on it. The same config with one fault injected, each a refusal the typed DbConfig
 * already rules out but a JavaScript caller can pass (a setting of another type, missing, empty or null; a driver that
 * is no node-postgres; a host that is a path, which node-postgres would read as a Unix socket's, over which PostgreSQL
 * offers no TLS; a port outside 1 to 65535 or no integer; a timer's delay or a pool bound outside its range, or no
 * integer; an unknown
 * key at the top, in the transport or in the pool, the settings the connection no longer has among them; a transport
 * no verify-full connection can use; a login no served(...) built; a pool hook or a verify that is no function; no
 * verify for a login one of whose roles reads a context), fails the layer with OpenError{stage: "config"} whose
 * DbConfigRefused names the faulty setting by its path (SettingFault), the rule an unknown key and a host that is a path
 * break, and never quotes the password. The migration connection's role-specific
 * faults are test/unit/cli/connection.test.ts's: one parser reads both blocks.
 *
 * The same valid configs under a drawn process environment, the one pg reads (connection/environment.ts): each startup
 * variable, `PGOPTIONS` and `PGREPLICATION`, absent, empty or at a text, beside variables pg reads that grizzle's client
 * configuration sets, at any text. The layer is refused at stage config exactly when `PGREPLICATION` holds a text, the
 * one startup variable a login's sessions cannot override, with a ConnectionEnvironmentRefused naming it and quoting no
 * value, and is built otherwise: a login's sessions set their own options, so `PGOPTIONS` reaches none of them.
 *
 * Characters a text setting may hold that a parser could read specially, and characters outside ASCII.
 *
 * Oracles: DbConfig's documented settings and ranges, restated over the drawn config and the fault injected; the
 * startup variables a login's sessions cannot override; the README's order of Db.open's stages and their reasons.
 *
 * Features: each config shape and each fault's setting; each environment's verdict; each token outcome.
 */
const tricky: Arr.NonEmptyReadonlyArray<string> = [
	"@",
	":",
	"/",
	"?",
	"#",
	"%",
	" ",
	"&",
	"=",
	"+",
	"'",
	'"',
	"\\",
	"é",
	"語",
	"😀"
]

const plainCharacters = Object.freeze(Str.split("abcxyz019_-.", ""))

const textCharacter: Gen<string> = weighted([
	[3, element(plainCharacters)],
	[1, element(tricky)]
])

const textGen: Gen<string> = string(textCharacter, { min: 1, max: 6 })

/** The tricky characters a network host may start with: all but /, with which a host is a path. */
const hostHeads = nonEmpty(
	Arr.filter(tricky, (c) => c !== "/"),
	"tricky characters a host may start with"
)

/** A network host: tricky text whose first character is never the / a path starts with. */
const hostGen: Gen<string> = (source) =>
	`${source.draw(
		weighted([
			[3, element(plainCharacters)],
			[1, element(hostHeads)]
		])
	)}${source.draw(string(textCharacter, { min: 0, max: 5 }))}`

const pem = (body: string): string =>
	`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`

/**
 * A login whose one role reads no context, which a valid config names; and one whose role reads a context, which needs
 * a verify.
 */
const Item = relation("Item", { id: Id, owner: Id }, ["id"])

const Shelf = schema("Shelf", [Item], [])

export const Plain = login(Shelf, "plain", [role(Shelf, "shelver", { Item })])

const Session = context("Session", { sub: Id })

const owned = query(Shelf).rule((r) => {
	const { id, owner } = v(Item, "item")
	return r.match(Item, { id, owner }).match(Session, { sub: owner }).find({ id })
})

export const Claiming = login(Shelf, "claiming", [
	role(Shelf, "owner", { Owned: owned }, { contexts: [Session] })
])

/**
 * Each login served as its type, over its real served file, compiled with no database
 * (test/support/compiled-served.ts): what every config names, neither login owning a workload.
 */
const PlainServed = served<typeof Plain>(compiledServedFile(Plain), "plain")

export const ClaimingServed = served<typeof Claiming>(compiledServedFile(Claiming), "claiming")

/** A valid config: every rule parseConnection states holds, the password a Redacted or an Effect yielding one. */
interface Drawn {
	readonly config: DbConfigShape<typeof Plain>
	readonly password: string
}

export const drawnGen: Gen<Drawn> = (source) => {
	const host = source.draw(hostGen)
	const port = source.draw(int(1, 65535))
	const database = source.draw(textGen)
	/** Marked, so a refusal quoting it cannot be mistaken for one that spells a setting's name alike. */
	const password = `pw-${source.draw(textGen)}`
	const lazy = source.draw(boolean)
	const ca = source.draw(
		oneOf<string | ReadonlyArray<string>>([
			map(textGen, pem),
			array(map(textGen, pem), { min: 1, max: 2 })
		])
	)
	const servername = source.draw(textGen)
	const max = source.draw(int(1, 20))
	/**
	 * A verify, or none: the login's roles read no context, so it needs none, and building the layer never calls it.
	 */
	const verify = source.draw(boolean)
	return {
		password,
		config: {
			driver: pgDriver,
			transport: {
				kind: "sslRequest",
				host,
				port,
				open: () => new net.Socket(),
				ca,
				servername
			},
			database,
			pool: { max },
			login: PlainServed,
			password: lazy ? Effect.succeed(Redacted.make(password)) : Redacted.make(password),
			...(verify ? { verify: () => Effect.succeed({}) } : {})
		}
	}
}

/** A setting of DbConfig a fault breaks. */
type Setting =
	| "driver"
	| "transport"
	| "transport.kind"
	| "transport.host"
	| "transport.port"
	| "transport.open"
	| "transport.ca"
	| "transport.servername"
	| "database"
	| "password"
	| "pool"
	| "pool.max"
	| "login"
	| "verify"

/**
 * What a run reaches: its valid config built, and its fault refused at the setting it breaks, or as an unknown key; a
 * host that is a path refused at the host.
 */
export type LayerFeature =
	| "valid built"
	| `refused DbConfig.${Setting}`
	| "refused an unknown setting"
	| "refused a host that is a path"

/** What a refusal must name: a setting of DbConfig, or an unknown key, quoted. */
type Named =
	| { readonly kind: "setting"; readonly setting: Setting }
	| { readonly kind: "unknown"; readonly key: string }

/** Where a fault overrides settings: at the top, in the transport, or in the pool. */
type Place = "top" | "transport" | "pool"

/** One fault: the settings it overrides at its place, what the refusal must name, and what its refusal reaches. */
interface Fault {
	readonly place: Place
	readonly override: Readonly<Record<string, unknown>>
	readonly names: Named
	readonly reaches: LayerFeature
}

const fault = (names: Named, place: Place, override: Readonly<Record<string, unknown>>): Fault => ({
	place,
	override,
	names,
	reaches:
		names.kind === "setting" ? `refused DbConfig.${names.setting}` : "refused an unknown setting"
})

/** A host that is a path, which the refusal names as the host. */
const pathHost = (host: string): Fault => ({
	place: "transport",
	override: { host },
	names: { kind: "setting", setting: "transport.host" },
	reaches: "refused a host that is a path"
})

const setting = (s: Setting): Named => ({ kind: "setting", setting: s })

const unknownKey = (key: string): Named => ({ kind: "unknown", key })

/** The text a refusal names `names` by, for a failure's report. */
export const nameText = (names: Named): string =>
	names.kind === "setting" ? `DbConfig.${names.setting}` : Formatter.format(names.key)

/** The setting a fault's refusal must name, its path from the DbConfig: a setting's, or an unknown key's at its place. */
export const settingOf = (f: Fault): ReadonlyArray<string> =>
	f.names.kind === "setting"
		? ["DbConfig", ...Str.split(f.names.setting, ".")]
		: f.place === "top"
			? ["DbConfig", f.names.key]
			: ["DbConfig", f.place, f.names.key]

/** The rule a fault's refusal must name where the fault decides it: an unknown key's, and a host that is a path's. */
export const ruleOf = (f: Fault): Option.Option<SettingRule["kind"]> =>
	f.names.kind === "unknown"
		? Option.some("known")
		: f.reaches === "refused a host that is a path"
			? Option.some("networkHost")
			: Option.none()

/**
 * Each fault a JavaScript caller can pass. The last: a login one of whose roles reads a context, without a verify, so
 * no Db of it could turn a token into claims.
 */
export const faultGen: Gen<Fault> = oneOf<Fault>([
	map(
		element([
			"role",
			"user",
			"ssl",
			"sslmode",
			"options",
			"host",
			"port",
			"tls",
			"connectTimeoutMs",
			"attachPool"
		]),
		(key) => fault(unknownKey(key), "top", { [key]: "x" })
	),
	map(
		element<unknown>([undefined, null, 42, {}, { Client: 1, Pool: 1, DatabaseError: 1 }]),
		(driver) => fault(setting("driver"), "top", { driver })
	),
	map(element<unknown>([undefined, null, "sslRequest", []]), (transport) =>
		fault(setting("transport"), "top", { transport })
	),
	map(element(["mode", "sslmode", "rejectUnauthorized", "tls"]), (key) =>
		fault(unknownKey(key), "transport", { [key]: "x" })
	),
	map(element<unknown>(["tls", "", undefined]), (kind) =>
		fault(setting("transport.kind"), "transport", { kind })
	),
	map(element<unknown>(["", 7, undefined, null]), (host) =>
		fault(setting("transport.host"), "transport", { host })
	),
	map(element(["/", "/tmp", "/var/run/postgresql", "/tmp/.s.PGSQL.5432"]), pathHost),
	map(
		element<unknown>([
			0,
			-1,
			65536,
			54.32,
			"5432",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			undefined
		]),
		(port) => fault(setting("transport.port"), "transport", { port })
	),
	map(element<unknown>(["socket", 1, null, undefined]), (open) =>
		fault(setting("transport.open"), "transport", { open })
	),
	map(element<unknown>(["", [], [""], 42, undefined]), (ca) =>
		fault(setting("transport.ca"), "transport", { ca })
	),
	map(element<unknown>(["", 7, null, undefined]), (servername) =>
		fault(setting("transport.servername"), "transport", { servername })
	),
	(source) => {
		const value = source.draw(element<unknown>(["", 1, undefined, null]))
		return fault(setting("database"), "top", { database: value })
	},
	map(element<unknown>(["plain text", undefined, 42, { value: "x" }, null]), (password) =>
		fault(setting("password"), "top", { password })
	),
	map(element<unknown>([undefined, null, 10, []]), (pool) =>
		fault(setting("pool"), "top", { pool })
	),
	map(element(["min", "idleTimeoutMs", "size", "connectionTimeoutMillis"]), (key) =>
		fault(unknownKey(key), "pool", { [key]: 1 })
	),
	map(element<unknown>([0, -1, 1.5, "10", Number.NaN, undefined]), (max) =>
		fault(setting("pool.max"), "pool", { max })
	),
	map(element<unknown>(["", 1, undefined, null, {}, Shelf, "plain"]), (value) =>
		fault(setting("login"), "top", { login: value })
	),
	map(element<unknown>(["verify", 1, null, {}]), (value) =>
		fault(setting("verify"), "top", { verify: value })
	),
	constant(fault(setting("verify"), "top", { login: ClaimingServed, verify: undefined }))
])

/** A layer, whatever it provides, built in a scope of its own and closed: its exit. */
export const built = (
	layer: Layer.Layer<never, OpenError>
): Effect.Effect<Exit.Exit<unknown, OpenError>> => Effect.exit(Effect.scoped(Layer.build(layer)))

/**
 * Variables pg reads into a session that grizzle's client configuration sets itself, that pg's client never uses, or
 * that grizzle leaves to the environment (PGAPPNAME, the label of a session in pg_stat_activity): none changes what a
 * session does, so none refuses a layer.
 */
const statedVariables: Arr.NonEmptyReadonlyArray<string> = [
	"PGAPPNAME",
	"PGCLIENT_ENCODING",
	"PGSSLNEGOTIATION",
	"PGSSLMODE",
	"PGHOST",
	"PGPORT",
	"PGUSER",
	"PGDATABASE",
	"PGPASSWORD",
	"PGPASSFILE",
	"PGCONNECT_TIMEOUT",
	"PGBINARY"
]

/** A drawn environment: each startup variable's value, and variables grizzle sets itself, each at a text. */
interface Environment {
	readonly variables: { readonly [V in StartupVariable]: VariableValue }
	readonly stated: ReadonlyArray<readonly [string, string]>
}

export const environmentGen: Gen<Environment> = (source) => ({
	variables: { PGOPTIONS: source.draw(variableGen), PGREPLICATION: source.draw(variableGen) },
	stated: source.draw(
		array(
			(inner) =>
				[
					inner.draw(element(statedVariables)),
					inner.draw(element(["direct", "latin1", "1", "x"]))
				] as const,
			{ min: 0, max: 3 }
		)
	)
})

/** A drawn environment as the process holds it, every variable it does not set unset. */
export const processValues = (e: Environment): Readonly<Record<string, Option.Option<string>>> => ({
	...Rec.fromEntries(Arr.map(statedVariables, (name) => [name, Option.none<string>()] as const)),
	...Rec.fromEntries(Arr.map(e.stated, ([name, text]) => [name, Option.some(text)] as const)),
	...Rec.fromEntries(
		Arr.map(startupVariableNames, (name) => [name, processValue(e.variables[name])] as const)
	)
})

/** What a run of the environment property reaches. */
export type EnvironmentFeature =
	| "refused PGREPLICATION set"
	| "refused PGREPLICATION beside PGOPTIONS set"
	| "built with PGOPTIONS set"
	| "built with a variable empty"
	| "built beside a variable grizzle sets"

/**
 * Db.open judges the token on the host and contacts nothing (adapter/db/served.ts): a token that is no token68 (RFC
 * 7235 section 2.1) is OpenError{stage: "token"} whose reason is TokenMalformed, and verify never runs on it; with any
 * other token, the layer's verify runs on it once, and its refusal, or anything it throws instead of returning its Effect, is OpenError{stage:
 * "token"} whose reason is a TokenRefused, the throw its cause; the payload it returns is decoded through the contexts
 * the role reads, Session's one uuid claim `sub` read from the payload's top level, and a payload that is no object,
 * lacks the claim or holds a value its field refuses is ClaimRefused naming the fault. A token whose claims decode
 * opens a Db, though the layer's endpoint, a memory one, ends every connection once TLS is up: whatever the token, the
 * transport opens no socket.
 *
 * The oracle is the README's order of Db.open's stages (role, schema, token) and its table of their reasons, restated
 * over the drawn verify and payload.
 */
/** A memory endpoint that ends every connection as soon as its TLS is up, its sockets counted by the case. */
export const closingMaterial = tlsMaterial("closing.grizzle.test")

type Thrown = "an Error" | "a TypeError" | "a RangeError" | "an Error with a cause"

type Payload =
	| { readonly kind: "a claim of sub"; readonly sub: string; readonly more: boolean }
	| { readonly kind: "no sub" }
	| {
			readonly kind: "a sub its field refuses"
			readonly value: "a text" | "a number" | "null" | "a boolean"
	  }
	| {
			readonly kind: "no object"
			readonly value: "a text" | "a number" | "a list" | "null" | "undefined"
	  }

type VerifyBehaviour =
	| { readonly kind: "refuses" }
	| { readonly kind: "unavailable" }
	| { readonly kind: "throws"; readonly thrown: Thrown }
	| { readonly kind: "returns"; readonly payload: Payload }

interface TokenCase {
	readonly token: string
	readonly verify: VerifyBehaviour
}

const payloadGen: Gen<Payload> = oneOf<Payload>([
	(source) => ({
		kind: "a claim of sub",
		sub: source.draw(uuidValue(4)),
		more: source.draw(boolean)
	}),
	constant({ kind: "no sub" }),
	(source) => ({
		kind: "a sub its field refuses",
		value: source.draw(element(["a text", "a number", "null", "a boolean"] as const))
	}),
	(source) => ({
		kind: "no object",
		value: source.draw(element(["a text", "a number", "a list", "null", "undefined"] as const))
	})
])

export const tokenCaseGen: Gen<TokenCase> = (source) => ({
	token: source.draw(textGen),
	verify: source.draw(
		weighted<VerifyBehaviour>([
			[1, constant({ kind: "refuses" })],
			[1, constant({ kind: "unavailable" })],
			[
				1,
				(inner) => ({
					kind: "throws",
					thrown: inner.draw(
						element<Thrown>(["an Error", "a TypeError", "a RangeError", "an Error with a cause"])
					)
				})
			],
			[4, (inner) => ({ kind: "returns", payload: inner.draw(payloadGen) })]
		])
	)
})

/** The error a verify that throws throws. */
export const thrownValue = (thrown: Thrown): Error => {
	switch (thrown) {
		case "an Error":
			return new Error("the verifier's own failure")
		case "a TypeError":
			return new TypeError("the verifier read the token as something it is not")
		case "a RangeError":
			return new RangeError("the verifier's clock is out of range")
		case "an Error with a cause":
			return new Error("the verifier's key could not be fetched", { cause: { status: 503 } })
	}
}

/** The payload a verify returns. */
export const payloadValue = (payload: Payload): unknown => {
	switch (payload.kind) {
		case "a claim of sub":
			return payload.more ? { sub: payload.sub, exp: 1, other: "claim" } : { sub: payload.sub }
		case "no sub":
			return { subject: "user_1" }
		case "a sub its field refuses":
			switch (payload.value) {
				case "a text":
					return { sub: "user_1" }
				case "a number":
					return { sub: 7 }
				case "null":
					return { sub: null }
				case "a boolean":
					return { sub: true }
			}
		case "no object":
			switch (payload.value) {
				case "a text":
					return "sub"
				case "a number":
					return 7
				case "a list":
					return [{ sub: "00000000-0000-4000-8000-000000000001" }]
				case "null":
					return null
				case "undefined":
					return undefined
			}
	}
}

/** What the README's stages say a case's Db.open meets. */
type TokenVerdict =
	| { readonly kind: "TokenMalformed" }
	| { readonly kind: "TokenRefused" }
	| { readonly kind: "VerifierUnavailable" }
	| { readonly kind: "ClaimRefused"; readonly fault: ClaimRefused["fault"] }
	| { readonly kind: "opened" }

/** The characters RFC 7235's token68 holds before its `=` padding, as the RFC's ABNF lists them. */
const token68Characters: ReadonlySet<string> = new Set([
	...Str.split("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", ""),
	"-",
	".",
	"_",
	"~",
	"+",
	"/"
])

/** Whether `text` is RFC 7235's token68: 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"=". */
const isToken68 = (text: string): boolean => {
	const characters = Str.split(text, "")
	const padded = Arr.findFirstIndex(characters, (c) => c === "=")
	const body = Option.getOrElse(padded, () => characters.length)
	return (
		body > 0 &&
		Arr.every(Arr.take(characters, body), (c) => token68Characters.has(c)) &&
		Arr.every(Arr.drop(characters, body), (c) => c === "=")
	)
}

export const tokenVerdict = (c: TokenCase): TokenVerdict => {
	if (!isToken68(c.token)) {
		return { kind: "TokenMalformed" }
	}
	const verify = c.verify
	switch (verify.kind) {
		case "refuses":
		case "throws":
			return { kind: "TokenRefused" }
		case "unavailable":
			return { kind: "VerifierUnavailable" }
		case "returns": {
			const payload = verify.payload
			switch (payload.kind) {
				case "a claim of sub":
					return { kind: "opened" }
				case "no sub":
					return { kind: "ClaimRefused", fault: { kind: "missing", field: "sub" } }
				case "a sub its field refuses":
					return { kind: "ClaimRefused", fault: { kind: "refused", field: "sub" } }
				case "no object":
					return { kind: "ClaimRefused", fault: { kind: "notAnObject" } }
			}
		}
	}
}

export type TokenFeature =
	| "a token that is no token68"
	| "verify refuses"
	| "verify's verifier unavailable"
	| `verify throws ${Thrown}`
	| `refused ${ClaimRefused["fault"]["kind"]}`
	| "claims decoded"
