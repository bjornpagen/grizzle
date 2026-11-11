import net from "node:net"
import { inspect } from "node:util"
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
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
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { uuid as uuidValue } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Cause,
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
import {
	ClaimRefused,
	ConnectionEnvironmentRefused,
	DbConfigRefused,
	type SettingRule,
	TokenError
} from "#adapter/errors/failures.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer, served } from "#adapter/public/layer.ts"
import type { DbConfigShape } from "#adapter/types/layer.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, login, relation, role, schema } from "#compiler/public/schema.ts"
import { assert, lacksText, nonEmpty } from "#test/support/assert.ts"
import { compiledServedFile } from "#test/support/compiled-served.ts"
import { caseHang, nodeTimerMax, nodeTimerMin } from "#test/support/limits.ts"
import { memoryEndpoint, memoryTransport, tlsMaterial } from "#test/support/memory-tls.ts"
import {
	processEnvironment,
	processValue,
	valueMark,
	type VariableValue,
	variableGen
} from "#test/support/process-env.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * DbLayer.make parses its DbConfig once, where it is given (packages/grizzle/src/adapter/pool/served.ts, connection/config.ts), and a
 * config no connection can use fails the layer before any connection.
 *
 * Over drawn configs (tricky hosts, never a path, servernames, databases and passwords; a Redacted or an Effect
 * password; a CA as one PEM text or a list; a connect timeout and pool bounds across their ranges, their ends included;
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
 * Plants (~/.cache/grizzle-release/BR04/plants): layer-zero-timer-admitted.patch (a timer's delay of 0 is admitted),
 * layer-login-refuses-options.patch (a login's layer is refused under PGOPTIONS too), layer-transport-path-lost.patch
 * (a transport setting's refusal names it as the block's own).
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
const plainCharacters = Str.split("abcxyz019_-.", "")
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
const Item = relation("Item", { id: uuid, owner: uuid }, ["id"])
const Shelf = schema("Shelf", { Item }, [])
const Plain = login(Shelf, "plain", [role(Shelf, "shelver", { Item })])
const Session = context("Session", { sub: uuid })
const owned = query(Shelf).rule((r) => {
	const { id, owner } = v(Item, "item")
	return r.match(Item, { id, owner }).match(Session, { sub: owner }).find({ id })
})
const Claiming = login(Shelf, "claiming", [role(Shelf, "owner", { Owned: owned })])

/**
 * Each login served as its type, over its real served file, compiled with no database
 * (test/support/compiled-served.ts): what every config names, neither login owning a workload.
 */
const PlainServed = served<typeof Plain>(compiledServedFile(Plain), "plain")
const ClaimingServed = served<typeof Claiming>(compiledServedFile(Claiming), "claiming")

/** A valid config: every rule parseConnection states holds, the password a Redacted or an Effect yielding one. */
interface Drawn {
	readonly config: DbConfigShape<typeof Plain>
	readonly password: string
}

/** A timer's delay, from the least to the longest a Node timer keeps: its range's ends, or one between. */
const delayGen: Gen<number> = oneOf<number>([
	constant(nodeTimerMin.value),
	constant(nodeTimerMax.value),
	int(nodeTimerMin.value, nodeTimerMax.value)
])

const drawnGen: Gen<Drawn> = (source) => {
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
	const min = source.draw(int(0, max))
	/**
	 * A platform's pool hook, or none: building the layer never calls it, since no pool exists before a Db.open.
	 */
	const attachPool = source.draw(boolean)
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
			connectTimeoutMs: source.draw(delayGen),
			pool: { max, min, idleTimeoutMs: source.draw(delayGen) },
			login: PlainServed,
			password: lazy ? Effect.succeed(Redacted.make(password)) : Redacted.make(password),
			...(attachPool ? { attachPool: () => undefined } : {}),
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
	| "connectTimeoutMs"
	| "pool"
	| "pool.max"
	| "pool.min"
	| "pool.idleTimeoutMs"
	| "login"
	| "verify"
	| "attachPool"

/**
 * What a run reaches: its valid config built, and its fault refused at the setting it breaks, or as an unknown key; a
 * host that is a path refused at the host.
 */
type LayerFeature =
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
const nameText = (names: Named): string =>
	names.kind === "setting" ? `DbConfig.${names.setting}` : Formatter.format(names.key)

/** The setting a fault's refusal must name, its path from the DbConfig: a setting's, or an unknown key's at its place. */
const settingOf = (f: Fault): ReadonlyArray<string> =>
	f.names.kind === "setting"
		? ["DbConfig", ...Str.split(f.names.setting, ".")]
		: f.place === "top"
			? ["DbConfig", f.names.key]
			: ["DbConfig", f.place, f.names.key]

/** The rule a fault's refusal must name where the fault decides it: an unknown key's, and a host that is a path's. */
const ruleOf = (f: Fault): Option.Option<SettingRule["kind"]> =>
	f.names.kind === "unknown"
		? Option.some("known")
		: f.reaches === "refused a host that is a path"
			? Option.some("networkHost")
			: Option.none()

/** A timer's delay no timer keeps: none, one fired at once, one past the longest, or no integer. */
const badDelays: Arr.NonEmptyReadonlyArray<unknown> = [
	0,
	-1,
	nodeTimerMax.value + 1,
	1.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	"1000",
	undefined
]

/**
 * Each fault a JavaScript caller can pass. The last: a login one of whose roles reads a context, without a verify, so
 * no Db of it could turn a token into claims.
 */
const faultGen: Gen<Fault> = oneOf<Fault>([
	map(element(["role", "user", "ssl", "sslmode", "options", "host", "port", "tls"]), (key) =>
		fault(unknownKey(key), "top", { [key]: "x" })
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
	map(element(badDelays), (connectTimeoutMs) =>
		fault(setting("connectTimeoutMs"), "top", { connectTimeoutMs })
	),
	map(element<unknown>([undefined, null, 10, []]), (pool) =>
		fault(setting("pool"), "top", { pool })
	),
	map(element(["size", "connectionTimeoutMillis", "waitMs"]), (key) =>
		fault(unknownKey(key), "pool", { [key]: 1 })
	),
	map(element<unknown>([0, -1, 1.5, "10", Number.NaN, undefined]), (max) =>
		fault(setting("pool.max"), "pool", { max })
	),
	map(element<unknown>([-1, 1.5, 21, "1", undefined]), (min) =>
		fault(setting("pool.min"), "pool", { min })
	),
	map(element(badDelays), (idleTimeoutMs) =>
		fault(setting("pool.idleTimeoutMs"), "pool", { idleTimeoutMs })
	),
	map(element<unknown>(["", 1, undefined, null, {}, Shelf, "plain"]), (value) =>
		fault(setting("login"), "top", { login: value })
	),
	map(element<unknown>(["verify", 1, null, {}]), (value) =>
		fault(setting("verify"), "top", { verify: value })
	),
	constant(fault(setting("verify"), "top", { login: ClaimingServed, verify: undefined })),
	map(element<unknown>(["attachDatabasePool", 1, null, {}]), (attachPool) =>
		fault(setting("attachPool"), "top", { attachPool })
	)
])

/** A layer, whatever it provides, built in a scope of its own and closed: its exit. */
const built = (
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

const environmentGen: Gen<Environment> = (source) => ({
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
const processValues = (e: Environment): Readonly<Record<string, Option.Option<string>>> => ({
	...Rec.fromEntries(Arr.map(statedVariables, (name) => [name, Option.none<string>()] as const)),
	...Rec.fromEntries(Arr.map(e.stated, ([name, text]) => [name, Option.some(text)] as const)),
	...Rec.fromEntries(
		Arr.map(startupVariableNames, (name) => [name, processValue(e.variables[name])] as const)
	)
})

/** What a run of the environment property reaches. */
type EnvironmentFeature =
	| "refused PGREPLICATION set"
	| "refused PGREPLICATION beside PGOPTIONS set"
	| "built with PGOPTIONS set"
	| "built with a variable empty"
	| "built beside a variable grizzle sets"

/**
 * Db.open judges the token on the host and contacts nothing (adapter/db/served.ts): with a token, the layer's verify
 * runs on it once, and its refusal, or anything it throws instead of returning its Effect, is OpenError{stage:
 * "token"} whose reason is a TokenError, the throw its cause; the payload it returns is decoded through the contexts
 * the role reads, Session's one uuid claim `sub` read from the payload's top level, and a payload that is no object,
 * lacks the claim or holds a value its field refuses is ClaimRefused naming the fault. A token whose claims decode
 * opens a Db, though the layer's endpoint, a memory one, ends every connection once TLS is up: whatever the token, the
 * transport opens no socket.
 *
 * The oracle is the README's order of Db.open's stages (role, schema, token) and its table of their reasons, restated
 * over the drawn verify and payload.
 */
/** A memory endpoint that ends every connection as soon as its TLS is up, its sockets counted by the case. */
const closingMaterial = tlsMaterial("closing.grizzle.test")

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

const tokenCaseGen: Gen<TokenCase> = (source) => ({
	token: source.draw(textGen),
	verify: source.draw(
		weighted<VerifyBehaviour>([
			[1, constant({ kind: "refuses" })],
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
const thrownValue = (thrown: Thrown): Error => {
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
const payloadValue = (payload: Payload): unknown => {
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
	| { readonly kind: "TokenError" }
	| { readonly kind: "ClaimRefused"; readonly fault: ClaimRefused["fault"] }
	| { readonly kind: "opened" }

const tokenVerdict = (c: TokenCase): TokenVerdict => {
	const verify = c.verify
	switch (verify.kind) {
		case "refuses":
		case "throws":
			return { kind: "TokenError" }
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

type TokenFeature =
	| "verify refuses"
	| `verify throws ${Thrown}`
	| `refused ${ClaimRefused["fault"]["kind"]}`
	| "claims decoded"

describe("DbLayer.make", () => {
	it.live(
		"builds every valid config, and refuses every fault injected into one at stage config, naming it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "DbConfig's documented settings: a valid config builds, each injected fault is DbConfigRefused naming its setting"
						},
						suite: "unit/adapter/layer-config",
						draw: drawn((source) => [source.draw(drawnGen), source.draw(faultGen)] as const),
						literal: Formatter.format,
						coverage: required<LayerFeature>(
							[
								"valid built",
								"refused DbConfig.driver",
								"refused DbConfig.transport",
								"refused DbConfig.transport.kind",
								"refused DbConfig.transport.host",
								"refused DbConfig.transport.port",
								"refused DbConfig.transport.open",
								"refused DbConfig.transport.ca",
								"refused DbConfig.transport.servername",
								"refused DbConfig.database",
								"refused DbConfig.password",
								"refused DbConfig.connectTimeoutMs",
								"refused DbConfig.pool",
								"refused DbConfig.pool.max",
								"refused DbConfig.pool.min",
								"refused DbConfig.pool.idleTimeoutMs",
								"refused DbConfig.login",
								"refused DbConfig.verify",
								"refused DbConfig.attachPool",
								"refused an unknown setting",
								"refused a host that is a path"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([d, f], k) =>
						Effect.gen(function* () {
							const names = nameText(f.names)
							const valid = yield* built(DbLayer.make(d.config))
							assert.ok(
								Exit.isSuccess(valid),
								`a valid config is refused: ${Exit.isFailure(valid) ? Cause.pretty(valid.cause) : ""}`
							)
							k.note("valid built")
							/** The config with the fault injected at its place, the rest of the config as drawn. */
							const injected: DbConfigShape<typeof Plain> =
								f.place === "top"
									? Object.assign({ ...d.config }, f.override)
									: f.place === "transport"
										? Object.assign(
												{ ...d.config },
												{
													transport: Object.assign({ ...d.config.transport }, f.override)
												}
											)
										: Object.assign(
												{ ...d.config },
												{
													pool: Object.assign({ ...d.config.pool }, f.override)
												}
											)
							const exit = yield* built(DbLayer.make(injected))
							assert.ok(Exit.isFailure(exit), `the fault at ${names} builds a layer`)
							const error = Cause.squash(exit.cause)
							assert.ok(
								error instanceof OpenError,
								`the fault at ${names} fails with ${String(error)}`
							)
							assert.equal(error.stage, "config")
							assert.ok(
								error.reason instanceof DbConfigRefused,
								`the fault at ${names} has no DbConfigRefused reason`
							)
							const refused = error.reason
							assert.deepEqual<ReadonlyArray<string>>(
								refused.setting,
								settingOf(f),
								`the fault at ${names} names its setting`
							)
							Option.match(ruleOf(f), {
								onNone: () => undefined,
								onSome: (kind) => assert.equal(refused.rule.kind, kind, `the fault at ${names}`)
							})
							lacksText(
								`${error.message}\n${inspect(refused, { depth: 12 })}`,
								d.password,
								`the refusal of the fault at ${names} quotes the password`
							)
							k.note(f.reaches)
						})
				)
			)
	)
	it.live(
		"refuses at stage config exactly the process environments that set PGREPLICATION, and builds under PGOPTIONS",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a login's layer is refused exactly when PGREPLICATION holds a text"
						},
						suite: "unit/adapter/layer-environment",
						draw: drawn((source) => [source.draw(drawnGen), source.draw(environmentGen)] as const),
						literal: Formatter.format,
						coverage: required<EnvironmentFeature>(
							[
								"refused PGREPLICATION set",
								"refused PGREPLICATION beside PGOPTIONS set",
								"built with PGOPTIONS set",
								"built with a variable empty",
								"built beside a variable grizzle sets"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([d, e], k) =>
						Effect.gen(function* () {
							const exit = yield* Effect.scoped(
								Effect.andThen(processEnvironment(processValues(e)), built(DbLayer.make(d.config)))
							)
							const options = e.variables.PGOPTIONS
							if (e.variables.PGREPLICATION.kind !== "text") {
								assert.ok(
									Exit.isSuccess(exit),
									`an environment that sets no PGREPLICATION is refused: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`
								)
								if (options.kind === "text") {
									k.note("built with PGOPTIONS set")
								}
								if (Arr.some(startupVariableNames, (v) => e.variables[v].kind === "empty")) {
									k.note("built with a variable empty")
								}
								if (Arr.isReadonlyArrayNonEmpty(e.stated)) {
									k.note("built beside a variable grizzle sets")
								}
								return
							}
							assert.ok(Exit.isFailure(exit), "PGREPLICATION builds a layer")
							const error = Cause.squash(exit.cause)
							assert.ok(error instanceof OpenError, `the environment fails with ${String(error)}`)
							assert.equal(error.stage, "config")
							assert.ok(
								error.reason instanceof ConnectionEnvironmentRefused,
								`the environment's refusal is ${error.reason._tag}`
							)
							assert.equal(error.reason.variable, "PGREPLICATION")
							assert.ok(!Str.includes(valueMark)(error.message), `${error.message} quotes a value`)
							k.note("refused PGREPLICATION set")
							if (options.kind === "text") {
								k.note("refused PGREPLICATION beside PGOPTIONS set")
							}
						})
				)
			)
	)
	it.live(
		"judges a token at stage token before any connection: verify's refusal or throw a TokenError, a payload that does not decode a ClaimRefused",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/layer-token",
						draw: drawn((source) => [source.draw(drawnGen), source.draw(tokenCaseGen)] as const),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the README's order of Db.open's stages and their reasons, over the drawn verify and payload"
						},
						coverage: required<TokenFeature>(
							[
								"verify refuses",
								"verify throws an Error",
								"verify throws a TypeError",
								"verify throws a RangeError",
								"verify throws an Error with a cause",
								"refused notAnObject",
								"refused missing",
								"refused refused",
								"claims decoded"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 150,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([d, c], k) =>
						Effect.gen(function* () {
							let verified = 0
							let opened = 0
							const thrown: Array<Error> = []
							const refusal = new TokenError({ cause: "the verifier refused the token" })
							const verify = (): Effect.Effect<unknown, TokenError> => {
								verified++
								const behaviour = c.verify
								switch (behaviour.kind) {
									case "refuses":
										return Effect.fail(refusal)
									case "throws": {
										const error = thrownValue(behaviour.thrown)
										thrown.push(error)
										throw error
									}
									case "returns":
										return Effect.succeed(payloadValue(behaviour.payload))
								}
							}
							const open = memoryEndpoint(closingMaterial, (secure) => {
								secure.destroy()
							})
							const config: DbConfigShape<typeof Claiming> = {
								...d.config,
								login: ClaimingServed,
								verify,
								transport: memoryTransport(closingMaterial, () => {
									opened++
									return open()
								})
							}
							const exit = yield* Effect.exit(
								Db.open(ClaimingServed.roles.owner, { token: c.token }).pipe(
									withLayer(DbLayer.make(config)),
									Effect.scoped
								)
							)
							assert.equal(verified, 1, "verify runs once on the token")
							assert.equal(opened, 0, "Db.open opens no socket, whatever the token")
							const verdict = tokenVerdict(c)
							if (verdict.kind === "opened") {
								assert.ok(
									Exit.isSuccess(exit),
									`decoded claims open a Db, though the endpoint ends every connection: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`
								)
								k.note("claims decoded")
								return
							}
							assert.ok(Exit.isFailure(exit), "a refused token opens no Db")
							const error = Cause.squash(exit.cause)
							assert.ok(error instanceof OpenError, String(error))
							switch (verdict.kind) {
								case "TokenError":
									assert.equal(error.stage, "token")
									assert.ok(error.reason instanceof TokenError, String(error.reason))
									if (c.verify.kind === "throws") {
										assert.deepEqual([error.reason.cause], thrown, "the throw is its cause")
										k.note(`verify throws ${c.verify.thrown}`)
									} else {
										assert.ok(error.reason === refusal, "verify's own TokenError")
										k.note("verify refuses")
									}
									break
								case "ClaimRefused":
									assert.equal(error.stage, "token")
									assert.deepEqual(
										error.reason,
										new ClaimRefused({ context: "Session", fault: verdict.fault })
									)
									k.note(`refused ${verdict.fault.kind}`)
									break
							}
						})
				)
			)
	)
})
