import {
	Array as Arr,
	Brand,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	Redacted,
	Result,
	String as Str
} from "effect"
import { readHost } from "#adapter/engine.ts"
import type { PgDriver, PgSocket } from "#adapter/types/driver.ts"
import type { DbConnection, PoolBounds, Transport } from "#adapter/types/layer.ts"
import { published } from "#compiler/core/limits.ts"
import { hostArguments } from "#compiler/query/build/host.ts"

/**
 * A connection block, parsed once where it is given: the DbConfig DbLayer.make takes, and the migration connection
 * grizzle.config.ts types (cli/connection.ts). Its type says what a block holds, and a block written in JavaScript is
 * checked all the same; the rules no type states (a driver whose Client, Pool and DatabaseError are classes, the one
 * transport kind, a nonempty network host that is no path, a nonempty servername and database, a port from 1 to 65535,
 * a nonempty CA bundle of PEM texts, a connect timeout a timer keeps, a migration connection's nonempty role) hold for
 * every caller, and the parsed transport's type carries the host's and the bundle's (ParsedTransport). The parsed
 * block is required throughout: a session and a pool connect only with one (wire/session.ts). No refusal quotes a
 * password.
 *
 * What a block holds besides its connection: its own settings' keys (`settings`), and what the parse of the block
 * returns of them beside the connection, `E`, read off the block's plain data where its connection's settings are read
 * (`parse`), or the refusal's text, which names the setting it refuses.
 */
export interface BlockSettings<E> {
	readonly settings: ReadonlyArray<string>
	readonly parse: (
		plain: Readonly<Record<string, unknown>>,
		where: string
	) => Result.Result<E, string>
}

/** A migration connection's: its login role, a nonempty string, which the parse returns beside the connection. */
export const roleSettings: BlockSettings<{ readonly role: string }> = {
	settings: ["role"],
	parse: (plain, where) => {
		const { role } = plain
		return typeof role === "string" && role !== ""
			? Result.succeed({ role })
			: Result.fail(`${where}.role must be a nonempty string`)
	}
}

/**
 * A DbConfig's: its login value, snapshot, pool bounds, pool hook and verify. The parse returns the pool bounds, plain
 * data parsed with the connection's (parsePool); the login value, the snapshot, the hook and verify are read off the
 * typed config by the layer (pool/registry.ts).
 */
export const loginSettings: BlockSettings<{ readonly pool: PoolBounds }> = {
	settings: ["login", "snapshot", "pool", "attachPool", "verify"],
	parse: (plain, where) => {
		const { pool } = plain
		return Result.map(parsePool(pool, `${where}.pool`), (bounds) => ({ pool: bounds }))
	}
}

/**
 * The settings read off the typed block rather than as plain data: the driver, a module whose members may be getters,
 * the password, and a DbConfig's functions.
 */
const ownSettings: ReadonlySet<string> = new Set(["driver", "password", "attachPool", "verify"])

/** A transport's settings. */
const transportSettings: ReadonlyArray<string> = [
	"kind",
	"host",
	"port",
	"open",
	"ca",
	"servername"
]

/** A pool's settings. */
const poolSettings: ReadonlyArray<string> = ["max", "min", "idleTimeoutMs"]

/**
 * The longest delay a Node timer keeps: pg's connect timeout and pg-pool's idle timeout are Node timers, and one longer
 * is set to 1, so it fires at once.
 */
export const timerMaxMs = published({
	value: 2_147_483_647,
	owner: "Node.js 26.13.0 timers",
	unit: "milliseconds",
	scope:
		"a connection's connectTimeoutMs and a DbConfig's pool.idleTimeoutMs, each the delay of a Node timer",
	constraint: "protocol constant",
	source: "https://nodejs.org/docs/v26.13.0/api/timers.html#settimeoutcallback-delay-args",
	quote:
		"When `delay` is larger than `2147483647` or less than `1` or `NaN`, the `delay` will be set to `1`.",
	verified: "2026-11-05"
})

/**
 * The largest port number: TCP's, the transport a connection's socket runs over, whose port numbers are 16 bits, the
 * Dynamic Ports ending the range.
 */
const portMax = published({
	value: 65_535,
	owner: "the IETF's transport port number registries (RFC 6335)",
	unit: "port numbers",
	scope: "the port of one connection's host",
	constraint: "protocol constant",
	source: "https://www.rfc-editor.org/rfc/rfc6335.html#section-6",
	quote:
		"the Dynamic Ports, also known as the Private or Ephemeral Ports, from 49152-65535 (never assigned)",
	verified: "2026-11-05"
})

/**
 * A host a socket reaches over the network, as the parse admits it (parseTransport): a name or an IP address, nonempty,
 * and never a path. node-postgres reads a host that starts with / as the directory of a Unix socket, which it connects
 * by path alone, and PostgreSQL offers TLS over no Unix socket, so an SSLRequest transport never has one.
 */
type NetworkHost = string & Brand.Brand<"NetworkHost">
const networkHost = Brand.nominal<NetworkHost>()

/** PEM certificate text, as the parse admits it (caBundle): more than whitespace, which no certificate is. */
type PemText = string & Brand.Brand<"PemText">
const pemText = Brand.nominal<PemText>()

/**
 * A transport as the parse admits it (parseTransport), the one a connection reaches its server through: its host a
 * network host, its port from 1 to 65535, the caller's `open`, its CA bundle a nonempty list of PEM texts, so a
 * certificate always has an authority to chain to, and its servername nonempty. Only the parse makes one.
 */
export interface ParsedTransport {
	readonly kind: "sslRequest"
	readonly host: NetworkHost
	readonly port: number
	readonly open: () => PgSocket
	readonly ca: Arr.NonEmptyReadonlyArray<PemText>
	readonly servername: string
}

/** A block's destination, credentials, verify-full TLS and connect timeout, as its driver connects them. */
export interface ParsedConnection {
	readonly driver: PgDriver
	readonly transport: ParsedTransport
	readonly database: string
	readonly password: DbConnection["password"]
	readonly connectTimeoutMs: number
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Arr.isArray(v)

/** Whether `v` is a safe integer from `least` to `most`. */
const integerIn = (v: number, least: number, most: number): boolean =>
	Number.isSafeInteger(v) && v >= least && v <= most

/** Whether `v` is a timer's delay: an integer number of milliseconds from 1 to the longest a timer keeps. */
const timerDelay = (v: number): boolean => integerIn(v, 1, timerMaxMs.value)

/** The refusal of the first of `keys` that is no setting of `where`, or none. */
const unknownKey = (
	keys: ReadonlyArray<string>,
	allowed: ReadonlyArray<string>,
	where: string
): Option.Option<string> =>
	Option.map(
		Arr.findFirst(keys, (k) => !allowed.includes(k)),
		(unknown) =>
			`${where} has no setting ${Formatter.format(unknown)}; its settings are ${Arr.join(allowed, ", ")}`
	)

/**
 * The password a block gives, read off its typed value so an Effect keeps the channels its type states: a Redacted
 * whose value is text, or an Effect; none for anything else a JavaScript caller passes.
 */
const givenPassword = (
	given: DbConnection["password"]
): Option.Option<DbConnection["password"]> => {
	if (Redacted.isRedacted(given)) {
		const text: unknown = Redacted.value(given)
		return typeof text === "string" ? Option.some(given) : Option.none()
	}
	return Effect.isEffect(given) ? Option.some(given) : Option.none()
}

/** `text` as PEM certificate text: a text of more than whitespace; none for anything else. */
const pemTextOf = (text: unknown): Option.Option<PemText> =>
	typeof text === "string" && Str.trim(text) !== "" ? Option.some(pemText(text)) : Option.none()

/**
 * A block's transport.ca, read as the bundle TLS is handed: one PEM text, the bundle of it alone, or a nonempty list of
 * PEM texts, copied out of the caller's list so a later change to it reaches no connection; none for anything else.
 */
const caBundle = (setting: unknown): Option.Option<Arr.NonEmptyReadonlyArray<PemText>> => {
	if (!Arr.isArray(setting)) {
		return Option.map(pemTextOf(setting), (text) => Arr.of(text))
	}
	const texts: Array<PemText> = []
	for (const text of setting) {
		const pem = pemTextOf(text)
		if (Option.isNone(pem)) {
			return Option.none()
		}
		texts.push(pem.value)
	}
	return Arr.isArrayNonEmpty(texts) ? Option.some(texts) : Option.none()
}

/**
 * The driver a block names, its three members each read once: the classes grizzle builds sessions, pools and its
 * reading of an ErrorResponse from. A module, `import pg from "pg"` or `import * as pg from "pg"`, is read only for
 * these, so a getter of another member (pg's `native`) never runs.
 */
const driverOf = (given: PgDriver): Option.Option<PgDriver> => {
	const passed: unknown = given
	if (typeof passed !== "object" || passed === null) {
		return Option.none()
	}
	const { Client, Pool, DatabaseError } = given
	const members: ReadonlyArray<unknown> = [Client, Pool, DatabaseError]
	return Arr.every(members, (member) => typeof member === "function")
		? Option.some({ Client, Pool, DatabaseError })
		: Option.none()
}

/**
 * A block's transport, `setting` as plain data read (parseConnection) and `typed` the same value as the block's type
 * states it, whose `open` is the caller's function: parsed, its host minted a network host and its CA a bundle of PEM
 * texts, or the refusal's text.
 */
const parseTransport = (
	setting: unknown,
	typed: Transport,
	where: string
): Result.Result<ParsedTransport, string> => {
	if (!isObject(setting)) {
		return Result.fail(
			`${where} must be an object: { kind: "sslRequest", host, port, open, ca, servername }`
		)
	}
	const extra = unknownKey(Rec.keys(setting), transportSettings, where)
	if (Option.isSome(extra)) {
		return Result.fail(extra.value)
	}
	const { kind, host, port, open, ca: caSetting, servername } = setting
	if (kind !== "sslRequest") {
		return Result.fail(
			`${where}.kind must be "sslRequest": an SSLRequest, then verify-full TLS over the socket`
		)
	}
	if (typeof host !== "string" || host === "") {
		return Result.fail(`${where}.host must be a nonempty string`)
	}
	if (Str.startsWith("/")(host)) {
		return Result.fail(
			`${where}.host must be a network host, a name or an IP address: node-postgres reads a host starting with / as a Unix socket's directory, and PostgreSQL offers no TLS over a Unix socket`
		)
	}
	if (typeof port !== "number" || !integerIn(port, 1, portMax.value)) {
		return Result.fail(`${where}.port must be an integer port number from 1 to ${portMax.value}`)
	}
	if (typeof open !== "function") {
		return Result.fail(`${where}.open must be a function returning a new, unconnected socket`)
	}
	const ca = caBundle(caSetting)
	if (Option.isNone(ca)) {
		return Result.fail(
			`${where}.ca must be PEM certificate text, or a nonempty list of them: TLS is always verify-full`
		)
	}
	if (typeof servername !== "string" || servername === "") {
		return Result.fail(
			`${where}.servername must be a nonempty string: the name the server certificate must carry`
		)
	}
	return Result.succeed({
		kind: "sslRequest",
		host: networkHost(host),
		port,
		open: typed.open,
		ca: ca.value,
		servername
	})
}

/**
 * The block named `where`, which holds `extras` besides its connection: parsed, with what `extras` parses of it, or the
 * refusal's text, which names the setting it refuses.
 *
 * A DbConfig's pool hook and verify are functions the layer reads itself (pool/registry.ts), never plain data.
 */
export const parseConnection = <E>(
	block: DbConnection,
	where: string,
	extras: BlockSettings<E>
): Result.Result<ParsedConnection & E, string> => {
	const value: unknown = block
	if (!isObject(value)) {
		return Result.fail(`${where} must be an object`)
	}
	/**
	 * The caller's block, read once at the boundary (core/host.ts hostRead): each own setting once. The password, read
	 * off the typed block so an Effect keeps the channels its type states, is recognized by its library's own guard, a
	 * Redacted of text or an Effect, and kept opaque: the credential stage reveals or runs it. The driver's three
	 * classes are read off the typed block, once each. Every other setting is plain data, read once as data
	 * (query/build/host.ts hostArguments), so no read below runs caller code; the transport's `open` is a function of
	 * it, which the transport's typed value names.
	 */
	const read = readHost(
		`${where} must be an object whose settings read as data: no getter, setter or refusing proxy`,
		() => {
			const keys = Rec.keys(value)
			const password = givenPassword(block.password)
			const driver = driverOf(block.driver)
			const plain: Record<string, unknown> = {}
			for (const key of keys) {
				if (!ownSettings.has(key)) {
					plain[key] = value[key]
				}
			}
			hostArguments(where, [plain])
			return Result.succeed({ keys, plain, password, driver, transport: block.transport })
		}
	)
	if (Result.isFailure(read)) {
		return Result.fail(read.failure)
	}
	const { keys, plain, password, driver, transport: typedTransport } = read.success
	const settings = [
		"driver",
		"transport",
		"database",
		"password",
		"connectTimeoutMs",
		...extras.settings
	]
	const extra = unknownKey(keys, settings, where)
	if (Option.isSome(extra)) {
		return Result.fail(extra.value)
	}
	if (Option.isNone(driver)) {
		return Result.fail(
			`${where}.driver must be node-postgres as imported (import pg from "pg"): its Client, Pool and DatabaseError classes`
		)
	}
	const { database, transport: transportSetting, connectTimeoutMs } = plain
	const transport = parseTransport(transportSetting, typedTransport, `${where}.transport`)
	if (Result.isFailure(transport)) {
		return Result.fail(transport.failure)
	}
	if (typeof database !== "string" || database === "") {
		return Result.fail(`${where}.database must be a nonempty string`)
	}
	const parsedExtras = extras.parse(plain, where)
	if (Result.isFailure(parsedExtras)) {
		return Result.fail(parsedExtras.failure)
	}
	if (Option.isNone(password)) {
		return Result.fail(
			`${where}.password must be a Redacted or an Effect yielding one, evaluated for each connection attempt`
		)
	}
	if (typeof connectTimeoutMs !== "number" || !timerDelay(connectTimeoutMs)) {
		return Result.fail(
			`${where}.connectTimeoutMs must be an integer number of milliseconds from 1 to ${timerMaxMs.value}`
		)
	}
	return Result.succeed({
		driver: driver.value,
		transport: transport.success,
		database,
		password: password.value,
		connectTimeoutMs,
		...parsedExtras.success
	})
}

/**
 * A DbConfig's pool bounds, `setting` as its block's plain data holds them (parseConnection read it as data): parsed,
 * or the refusal's text, which names the bound it refuses.
 */
const parsePool = (setting: unknown, where: string): Result.Result<PoolBounds, string> => {
	if (!isObject(setting)) {
		return Result.fail(`${where} must be an object: { max, min, idleTimeoutMs }`)
	}
	const extra = unknownKey(Rec.keys(setting), poolSettings, where)
	if (Option.isSome(extra)) {
		return Result.fail(extra.value)
	}
	const { max, min, idleTimeoutMs } = setting
	if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) {
		return Result.fail(`${where}.max must be an integer from 1: the most sessions open at once`)
	}
	if (typeof min !== "number" || !integerIn(min, 0, max)) {
		return Result.fail(`${where}.min must be an integer from 0 to max: the sessions kept open`)
	}
	if (typeof idleTimeoutMs !== "number" || !timerDelay(idleTimeoutMs)) {
		return Result.fail(
			`${where}.idleTimeoutMs must be an integer number of milliseconds from 1 to ${timerMaxMs.value}`
		)
	}
	return Result.succeed({ max, min, idleTimeoutMs })
}
