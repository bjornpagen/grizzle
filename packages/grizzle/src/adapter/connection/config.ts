import { createSecureContext, type SecureContext } from "node:tls"
import * as Arr from "effect/Array"
import * as Brand from "effect/Brand"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Rec from "effect/Record"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Str from "effect/String"
import { readHost } from "#adapter/engine.ts"
import type { SettingFault, SettingRule } from "#adapter/errors/failures.ts"
import type { PgDriver, PgSocket } from "#adapter/types/driver.ts"
import type { DbConnection, PoolBounds, Transport } from "#adapter/types/layer.ts"
import type { Limit } from "#compiler/plan/common.ts"
import {
	type CallerObject,
	type CallerRecord,
	roleInSpace,
	published,
	type RoleSpace,
	readCaller,
	roleSpaceOf
} from "#compiler/plan/runtime.ts"

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
 * (`parse`), or the setting it refuses and the rule it breaks (SettingFault).
 */
export interface BlockSettings<E> {
	readonly settings: ReadonlyArray<string>
	readonly parse: (plain: CallerRecord, where: SettingPath) => Result.Result<E, SettingFault>
}

/** Where a setting sits, its path from its block: `["DbConfig", "transport", "port"]`. */
export type SettingPath = SettingFault["setting"]

/** The fault of the setting `key` of `where`, which breaks `rule`. */
export const faultAt = (where: SettingPath, key: string, rule: SettingRule): SettingFault => ({
	setting: [...where, key],
	rule
})

/** A migration connection's: its login role, a nonempty string, which the parse returns beside the connection. */
export const roleSettings: BlockSettings<{ readonly role: string }> = {
	settings: ["role"],
	parse: (plain, where) => {
		const { role } = plain
		return typeof role === "string" && role !== ""
			? Result.succeed({ role })
			: Result.fail(faultAt(where, "role", { kind: "nonemptyText" }))
	}
}

/**
 * A served DbConfig's: its served login, pool bounds, pool hook and verify. The parse returns the pool bounds, plain
 * data parsed with the connection's (parsePool); the served login, the hook and verify are read off the typed config by
 * the layer (pool/served.ts).
 */
export const servedLoginSettings: BlockSettings<{ readonly pool: PoolBounds }> = {
	settings: ["login", "pool", "attachPool", "verify"],
	parse: (plain, where) => {
		const { pool } = plain
		return Result.map(parsePool(pool, [...where, "pool"]), (bounds) => ({ pool: bounds }))
	}
}

/** LiveSource.layer's: the served login whose file carries its installation's live source, which the layer reads. */
export const liveSourceSettings: BlockSettings<Readonly<Record<string, never>>> = {
	settings: ["login"],
	parse: () => Result.succeed({})
}

/**
 * The settings the block's read leaves unread, each read once off the typed block instead: the driver, a module whose
 * members may be getters; the password; the transport, read by its own read (readTransport), whose `open` is the
 * caller's function; and a DbConfig's login value, its functions and its snapshot, which the layer reads (pool/served.ts,
 * pool/served.ts), the snapshot by its own parser (boundary/snapshot.ts parseSnapshot).
 */
const typedSettings: ReadonlySet<string> = new Set([
	"driver",
	"password",
	"transport",
	"login",
	"attachPool",
	"verify",
	"snapshot"
])

/** The transport setting its read leaves unread, read once off the typed transport: `open`, the caller's function. */
const typedTransportSettings: ReadonlySet<string> = new Set(["open"])

/** A connection block's own settings, every block's beside its extras' (BlockSettings). */
export const connectionSettings = [
	"driver",
	"transport",
	"database",
	"rolePrefix",
	"password",
	"connectTimeoutMs"
] as const

/** A transport's settings. */
export const transportSettings = ["kind", "host", "port", "open", "ca", "servername"] as const

/** A pool's settings. */
export const poolSettings = ["max", "min", "idleTimeoutMs"] as const

/**
 * The longest delay a Node timer keeps: pg's connect timeout and pg-pool's idle timeout are Node timers, and one longer
 * is set to 1, so it fires at once.
 */
export const timerMaxMs: Limit = published({
	value: 2_147_483_647,
	owner: "Node.js 26.13.0 timers",
	unit: "milliseconds",
	scope:
		"a connection's connectTimeoutMs, a DbConfig's pool.idleTimeoutMs and an HttpConfig's heartbeatMs, each the delay of a Node timer",
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
 * certificate always has an authority to chain to, the bundle parsed once into the trust store every connection's TLS
 * verifies against (`authority`), and its servername nonempty. Only the parse makes one.
 */
export interface ParsedTransport {
	readonly kind: "sslRequest"
	readonly host: NetworkHost
	readonly port: number
	readonly open: () => PgSocket
	readonly ca: Arr.NonEmptyReadonlyArray<PemText>
	/**
	 * The CA bundle as TLS reads it, `ca` parsed once, where the transport is: each session's and each CancelRequest's
	 * connection verifies against it, so no connection parses the bundle again. It holds the bundle's certificates and
	 * none of Node's own roots.
	 */
	readonly authority: SecureContext
	readonly servername: string
}

/** A block's destination, credentials, verify-full TLS and connect timeout, as its driver connects them, and the role
 * space of the installation in its database, its `rolePrefix` read (core/identity.ts roleSpaceOf). */
export interface ParsedConnection {
	readonly driver: PgDriver
	readonly transport: ParsedTransport
	readonly database: string
	readonly roles: RoleSpace
	readonly password: DbConnection["password"]
	readonly connectTimeoutMs: number
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Arr.isArray(v)

/** Whether `v` is a safe integer from `least` to `most`. */
const integerIn = (v: number, least: number, most: number): boolean =>
	Number.isSafeInteger(v) && v >= least && v <= most

/** Whether `v` is a timer's delay: an integer number of milliseconds from 1 to the longest a timer keeps. */
export const timerDelay = (v: number): boolean => integerIn(v, 1, timerMaxMs.value)

/** The rule a timer's delay keeps. */
export const timerRule: SettingRule = {
	kind: "integer",
	least: 1,
	most: timerMaxMs.value,
	unit: "milliseconds"
}

/** The fault of the first of `keys` that is no setting of `where`, or none. */
const unknownKey = (
	keys: ReadonlyArray<string>,
	allowed: ReadonlyArray<string>,
	where: SettingPath
): Option.Option<SettingFault> =>
	Option.map(
		Arr.findFirst(keys, (k) => !allowed.includes(k)),
		(unknown) => faultAt(where, unknown, { kind: "known", settings: allowed })
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
 * The driver a block names, its four members each read once: the classes grizzle builds sessions, pools, the queries of
 * its flights and its reading of an ErrorResponse from. A module, `import pg from "pg"` or `import * as pg from "pg"`,
 * is read only for these, so a getter of another member (pg's `native`) never runs.
 */
const driverOf = (given: PgDriver): Option.Option<PgDriver> => {
	const passed: unknown = given
	if (typeof passed !== "object" || passed === null) {
		return Option.none()
	}
	const { Client, Pool, Query, DatabaseError } = given
	const members: ReadonlyArray<unknown> = [Client, Pool, Query, DatabaseError]
	return Arr.every(members, (member) => typeof member === "function")
		? Option.some({ Client, Pool, Query, DatabaseError })
		: Option.none()
}

/**
 * A block's transport as its one read leaves it (readTransport): the copy of its settings, every own key among them,
 * and the caller's `open`, read once off the typed transport.
 */
interface TransportRead {
	readonly setting: CallerObject
	readonly open: Transport["open"]
}

/**
 * A block's transport, read once off the typed block: its settings copied but `open`, which is read once off the typed
 * transport; none for a value that is no object, and refused when its reading throws or meets a getter or a setter.
 */
const readTransport = (
	typed: Transport
): Result.Result<Option.Option<TransportRead>, undefined> => {
	const passed: unknown = typed
	if (!isObject(passed)) {
		return Result.succeed(Option.none())
	}
	const read = readCaller(passed, typedTransportSettings)
	return read.ok
		? Result.succeed(Option.some({ setting: read.value, open: typed.open }))
		: Result.fail(undefined)
}

/**
 * A block's transport as its read left it (readTransport): parsed, its host minted a network host and its CA a bundle of
 * PEM texts, or the setting it refuses.
 */
const parseTransport = (
	read: TransportRead,
	where: SettingPath
): Result.Result<ParsedTransport, SettingFault> => {
	const extra = unknownKey(read.setting.keys, transportSettings, where)
	if (Option.isSome(extra)) {
		return Result.fail(extra.value)
	}
	const { kind, host, port, ca: caSetting, servername } = read.setting.data
	const open = read.open
	const passedOpen: unknown = open
	if (kind !== "sslRequest") {
		return Result.fail(faultAt(where, "kind", { kind: "sslRequest" }))
	}
	if (typeof host !== "string" || host === "") {
		return Result.fail(faultAt(where, "host", { kind: "nonemptyText" }))
	}
	if (Str.startsWith("/")(host)) {
		return Result.fail(faultAt(where, "host", { kind: "networkHost" }))
	}
	if (typeof port !== "number" || !integerIn(port, 1, portMax.value)) {
		return Result.fail(
			faultAt(where, "port", { kind: "integer", least: 1, most: portMax.value, unit: "port" })
		)
	}
	if (typeof passedOpen !== "function") {
		return Result.fail(faultAt(where, "open", { kind: "socketOpener" }))
	}
	const ca = caBundle(caSetting)
	if (Option.isNone(ca)) {
		return Result.fail(faultAt(where, "ca", { kind: "certificates" }))
	}
	if (typeof servername !== "string" || servername === "") {
		return Result.fail(faultAt(where, "servername", { kind: "nonemptyText" }))
	}
	const bundle = ca.value
	return Result.map(
		readHost(faultAt(where, "ca", { kind: "readableCertificates" }), () =>
			Result.succeed(createSecureContext({ ca: [...bundle] }))
		),
		(authority): ParsedTransport => ({
			kind: "sslRequest",
			host: networkHost(host),
			port,
			open,
			ca: bundle,
			authority,
			servername
		})
	)
}

/**
 * The block at `where`, which holds `extras` besides its connection: parsed, with what `extras` parses of it, or the
 * setting it refuses and the rule it breaks.
 *
 * A DbConfig's login value, pool hook and verify are the layer's to read (pool/served.ts), never plain
 * data.
 */
export const parseConnection = <E>(
	block: DbConnection,
	where: SettingPath,
	extras: BlockSettings<E>
): Result.Result<ParsedConnection & E, SettingFault> => {
	const value: unknown = block
	const settings = [...connectionSettings, ...extras.settings]
	if (!isObject(value)) {
		return Result.fail({ setting: where, rule: { kind: "object", settings } })
	}
	/**
	 * The caller's block, read once at the boundary (core/host.ts readCaller): each own setting once. The password, read
	 * off the typed block so an Effect keeps the channels its type states, is recognized by its library's own guard, a
	 * Redacted of text or an Effect, and kept opaque: the credential stage reveals or runs it. The driver's three
	 * classes are read off the typed block, once each, and so is the transport, whose own read copies its settings but
	 * the caller's `open` (readTransport). Every other setting is plain data, copied as the read finds it, and every
	 * later read is of the copy, never of the caller's block.
	 */
	const unreadable: SettingFault = { setting: where, rule: { kind: "data" } }
	const read = readHost(unreadable, () => {
		const own = readCaller(value, typedSettings)
		if (!own.ok) {
			return Result.fail(unreadable)
		}
		const password = givenPassword(block.password)
		const driver = driverOf(block.driver)
		const transport = readTransport(block.transport)
		if (Result.isFailure(transport)) {
			return Result.fail(unreadable)
		}
		return Result.succeed({
			keys: own.value.keys,
			plain: own.value.data,
			password,
			driver,
			transport: transport.success
		})
	})
	if (Result.isFailure(read)) {
		return Result.fail(read.failure)
	}
	const { keys, plain, password, driver, transport: transportRead } = read.success
	const extra = unknownKey(keys, settings, where)
	if (Option.isSome(extra)) {
		return Result.fail(extra.value)
	}
	if (Option.isNone(driver)) {
		return Result.fail(faultAt(where, "driver", { kind: "driver" }))
	}
	const { database, rolePrefix, connectTimeoutMs } = plain
	if (Option.isNone(transportRead)) {
		return Result.fail(faultAt(where, "transport", { kind: "object", settings: transportSettings }))
	}
	const transport = parseTransport(transportRead.value, [...where, "transport"])
	if (Result.isFailure(transport)) {
		return Result.fail(transport.failure)
	}
	if (typeof database !== "string" || database === "") {
		return Result.fail(faultAt(where, "database", { kind: "nonemptyText" }))
	}
	const roles = parseRoleSpace(rolePrefix, where)
	if (Result.isFailure(roles)) {
		return Result.fail(roles.failure)
	}
	const parsedExtras = extras.parse(plain, where)
	if (Result.isFailure(parsedExtras)) {
		return Result.fail(parsedExtras.failure)
	}
	if (Option.isNone(password)) {
		return Result.fail(faultAt(where, "password", { kind: "password" }))
	}
	if (typeof connectTimeoutMs !== "number" || !timerDelay(connectTimeoutMs)) {
		return Result.fail(faultAt(where, "connectTimeoutMs", timerRule))
	}
	return Result.succeed({
		driver: driver.value,
		transport: transport.success,
		database,
		roles: roles.success,
		password: password.value,
		connectTimeoutMs,
		...parsedExtras.success
	})
}

/** The role space of a block's `rolePrefix`, as its plain data holds it (core/identity.ts roleSpaceOf), or the
 * prefix refused. */
const parseRoleSpace = (
	rolePrefix: unknown,
	where: SettingPath
): Result.Result<RoleSpace, SettingFault> => {
	if (rolePrefix !== undefined && typeof rolePrefix !== "string") {
		return Result.fail(faultAt(where, "rolePrefix", { kind: "rolePrefix", reason: "a string" }))
	}
	const space = roleSpaceOf(rolePrefix)
	return space.ok
		? Result.succeed(space.value)
		: Result.fail(faultAt(where, "rolePrefix", { kind: "rolePrefix", reason: space.error }))
}

/**
 * The PostgreSQL role a block's role space installs for the role stem `stem` (core/identity.ts roleInSpace), or the
 * block's rolePrefix refused when the role is past PostgreSQL's longest identifier.
 */
const spaceRole = (
	space: RoleSpace,
	where: SettingPath,
	stem: string
): Result.Result<string, SettingFault> => {
	const role = roleInSpace(space, stem)
	return role.ok
		? Result.succeed(role.value)
		: Result.fail(
				faultAt(where, "rolePrefix", {
					kind: "rolePrefix",
					reason: `one under which the role ${role.error.role} fits ${role.error.limit} bytes`
				})
			)
}

/**
 * The PostgreSQL role a block's installation installs for the role stem `stem`, a role a served file or a compile names,
 * under the block's role space (spaceRole): the one place a layer makes the role its pool logs in as and its Dbs take
 * on.
 */
export const connectionRole = (
	connection: ParsedConnection,
	where: SettingPath,
	stem: string
): Result.Result<string, SettingFault> => spaceRole(connection.roles, where, stem)

/**
 * A DbConfig's pool bounds, `setting` as its block's plain data holds them (parseConnection read it as data): parsed,
 * or the bound it refuses and the rule it breaks.
 */
const parsePool = (
	setting: unknown,
	where: SettingPath
): Result.Result<PoolBounds, SettingFault> => {
	if (!isObject(setting)) {
		return Result.fail({ setting: where, rule: { kind: "object", settings: poolSettings } })
	}
	const extra = unknownKey(Rec.keys(setting), poolSettings, where)
	if (Option.isSome(extra)) {
		return Result.fail(extra.value)
	}
	const { max, min, idleTimeoutMs } = setting
	if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) {
		return Result.fail(faultAt(where, "max", { kind: "integerFrom", least: 1 }))
	}
	if (typeof min !== "number" || !integerIn(min, 0, max)) {
		return Result.fail(
			faultAt(where, "min", { kind: "integer", least: 0, most: max, unit: "sessions" })
		)
	}
	if (typeof idleTimeoutMs !== "number" || !timerDelay(idleTimeoutMs)) {
		return Result.fail(faultAt(where, "idleTimeoutMs", timerRule))
	}
	return Result.succeed({ max, min, idleTimeoutMs })
}
