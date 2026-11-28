import { createSecureContext, type SecureContext } from "node:tls"
import * as Arr from "effect/Array"
import * as Brand from "effect/Brand"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Rec from "effect/Record"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Str from "effect/String"
import { readHost } from "#adapter/engine.ts"
import type { SettingFault, SettingRule } from "#adapter/errors/failures.ts"
import type { PgDriver, PgSocket } from "#adapter/types/driver.ts"
import type {
	ConnectionPassword,
	DbConnection,
	PoolBounds,
	SslRequestTransport,
	Transport
} from "#adapter/types/layer.ts"
import {
	type CallerObject,
	type CallerRecord,
	roleInSpace,
	type RoleSpace,
	readCaller,
	roleSpaceOf
} from "#compiler/plan/runtime.ts"

/**
 * The least delay a Node timer waits: an SSE heartbeat's tick is a Node timer, and grizzle admits a heartbeatMs from
 * it.
 *
 * @limitKind published
 * @owner Node.js 26.13.0 timers
 * @unit milliseconds
 * @scope an HttpConfig's heartbeatMs, the delay of a Node timer
 * @constraint protocol constant
 * @source https://nodejs.org/docs/v26.13.0/api/timers.html#settimeoutcallback-delay-args
 * @quote When `delay` is larger than `2147483647` or less than `1` or `NaN`, the `delay` will be set to `1`.
 * @verified 2026-11-05
 */
export const timerMinMs = 1

/**
 * The longest delay a Node timer keeps: an SSE heartbeat's tick is a Node timer, and one longer is set to 1, so it
 * fires at once.
 *
 * @limitKind published
 * @owner Node.js 26.13.0 timers
 * @unit milliseconds
 * @scope an HttpConfig's heartbeatMs, the delay of a Node timer
 * @constraint protocol constant
 * @source https://nodejs.org/docs/v26.13.0/api/timers.html#settimeoutcallback-delay-args
 * @quote When `delay` is larger than `2147483647` or less than `1` or `NaN`, the `delay` will be set to `1`.
 * @verified 2026-11-05
 */
export const timerMaxMs = 2_147_483_647

/**
 * The largest port number: TCP's, the transport a connection's socket runs over, whose port numbers are 16 bits, the
 * Dynamic Ports ending the range.
 *
 * @limitKind published
 * @owner the IETF's transport port number registries (RFC 6335)
 * @unit port numbers
 * @scope the port of one connection's host
 * @constraint protocol constant
 * @source https://www.rfc-editor.org/rfc/rfc6335.html#section-6
 * @quote the Dynamic Ports, also known as the Private or Ephemeral Ports, from 49152-65535 (never assigned)
 * @verified 2026-11-05
 */
const portMax = 65_535

/**
 * A connection block, parsed once where it is given: the DbConfig DbLayer.make takes, and the migration connection
 * grizzle.config.ts types (cli/connection.ts). Its type says what a block holds, and a block written in JavaScript is
 * checked all the same; the rules no type states (a driver whose Client, Pool and DatabaseError are classes, a
 * transport of one of the two kinds holding exactly its own kind's settings, a nonempty network host that is no path, a
 * socket directory that is an absolute path, a nonempty servername and database, a port from 1 to 65535, a nonempty CA
 * bundle of PEM texts, a password beside a network transport and none beside a Unix socket, a migration connection's
 * nonempty role) hold for every caller, and the parsed transport's type carries the host's, the directory's and the
 * bundle's, and the credential of its kind (ParsedTransport). The parsed block is required throughout: a session and a
 * pool connect only with one (wire/session.ts). No refusal quotes a password.
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
 * A served DbConfig's: its served login, pool bounds and verify. The parse returns the pool bounds, plain data parsed
 * with the connection's (parsePool); the served login and verify are read off the typed config by the layer
 * (pool/served.ts).
 */
export const servedLoginSettings: BlockSettings<{ readonly pool: PoolBounds }> = {
	settings: ["login", "pool", "verify"],
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
 * members may be getters; the password; the transport, read by its own read (readTransport), whose `open`, a network
 * transport's, is the caller's function; and a DbConfig's login value, its verify and its snapshot, which the layer
 * reads (pool/served.ts),
 * the snapshot by its own parser (boundary/snapshot.ts parseSnapshot).
 */
const typedSettings: ReadonlySet<string> = new Set([
	"driver",
	"password",
	"transport",
	"login",
	"verify",
	"snapshot"
])

/**
 * The transport setting its read leaves unread, read once off the typed transport: `open`, a network transport's
 * function, the caller's.
 */
const typedTransportSettings: ReadonlySet<string> = new Set(["open"])

/** A connection block's own settings, every block's beside its extras' (BlockSettings). */
export const connectionSettings = [
	"driver",
	"transport",
	"database",
	"rolePrefix",
	"password"
] as const

/**
 * A transport's settings, by its kind: each kind admits exactly its own, so a setting of the other kind's, a CA beside a
 * Unix socket or a directory beside a network host, is no setting of it. Every kind a Transport has is here, by its
 * type.
 */
export const transportSettings = {
	sslRequest: ["kind", "host", "port", "open", "ca", "servername"],
	unixSocket: ["kind", "directory", "port"]
} as const satisfies {
	readonly [K in Transport["kind"]]: ReadonlyArray<keyof Extract<Transport, { readonly kind: K }>>
}

/** A pool's settings: its most sessions, the one bound a pool takes (types/layer.ts PoolBounds). */
export const poolSettings = ["max"] as const

/**
 * A host a socket reaches over the network, as the parse admits it (parseTransport): a name or an IP address, nonempty,
 * and never a path. node-postgres reads a host that starts with / as the directory of a Unix socket, which it connects
 * by path alone, and PostgreSQL offers TLS over no Unix socket, so an SSLRequest transport never has one: a Unix socket
 * is the unixSocket transport's.
 */
type NetworkHost = string & Brand.Brand<"NetworkHost">
const networkHost = Brand.nominal<NetworkHost>()

/**
 * The directory a server's Unix socket is in, as the parse admits it (parseTransport): an absolute path, which
 * node-postgres reads as a socket's directory, the host it connects to by path, and holding no NUL, which no path
 * holds.
 */
type SocketDirectory = string & Brand.Brand<"SocketDirectory">
const socketDirectory = Brand.nominal<SocketDirectory>()

/** PEM certificate text, as the parse admits it (caBundle): more than whitespace, which no certificate is. */
type PemText = string & Brand.Brand<"PemText">
const pemText = Brand.nominal<PemText>()

/**
 * A transport as the parse admits it (parseTransport), the one a connection reaches its server through, with the
 * credential the connection signs in with over it: a network connection's TLS and password (ParsedSslRequest), or a
 * Unix socket, over which the server authenticates the operating-system account the kernel names, with none
 * (ParsedUnixSocket). So no parsed connection holds a password beside a Unix socket. Only the parse makes one.
 */
export type ParsedTransport = ParsedSslRequest | ParsedUnixSocket

/**
 * A network transport as the parse admits it: its host a network host, its port from 1 to 65535, the caller's `open`,
 * its CA bundle a nonempty list of PEM texts, so a certificate always has an authority to chain to, the bundle parsed
 * once into the trust store every connection's TLS verifies against (`authority`), its servername nonempty, and the
 * password the server asks for once TLS is up.
 */
export interface ParsedSslRequest {
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
	readonly password: ConnectionPassword
}

/**
 * A Unix socket transport as the parse admits it: its directory an absolute path, and its port from 1 to 65535, which
 * names the socket file in it. It holds no credential.
 */
export interface ParsedUnixSocket {
	readonly kind: "unixSocket"
	readonly directory: SocketDirectory
	readonly port: number
}

/**
 * A block's destination and credentials, its transport's (ParsedTransport), as its driver connects them, and the role
 * space of the installation in its database, its `rolePrefix` read (core/identity.ts roleSpaceOf).
 */
export interface ParsedConnection {
	readonly driver: PgDriver
	readonly transport: ParsedTransport
	readonly database: string
	readonly roles: RoleSpace
}

/** Whether `v` is a safe integer from `least` to `most`. */
const integerIn = (v: number, least: number, most: number): boolean =>
	Number.isSafeInteger(v) && v >= least && v <= most

/** Whether `v` is a timer's delay: an integer number of milliseconds from 1 to the longest a timer keeps. */
export const timerDelay = (v: number): boolean => integerIn(v, timerMinMs, timerMaxMs)

/** The rule a timer's delay keeps. */
export const timerRule: SettingRule = {
	kind: "integer",
	least: timerMinMs,
	most: timerMaxMs,
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
const givenPassword = (given: DbConnection["password"]): Option.Option<ConnectionPassword> => {
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
 * and the caller's `open` where the typed transport holds one, read once off it: a network transport's.
 */
interface TransportRead {
	readonly setting: CallerObject
	readonly open: SslRequestTransport["open"] | undefined
}

/**
 * A block's transport, read once off the typed block: its settings copied but `open`, which is read once off the typed
 * transport where it holds one; none for a value that is no object, and refused when its reading throws or meets a
 * getter or a setter.
 */
const readTransport = (
	typed: Transport
): Result.Result<Option.Option<TransportRead>, undefined> => {
	const passed: unknown = typed
	if (!Predicate.isObject(passed)) {
		return Result.succeed(Option.none())
	}
	const read = readCaller(passed, typedTransportSettings)
	return read.ok
		? Result.succeed(
				Option.some({ setting: read.value, open: "open" in typed ? typed.open : undefined })
			)
		: Result.fail(undefined)
}

/** A transport's own settings as the parse admits them, before its kind's credential joins them (credentialed). */
type AdmittedTransport = Omit<ParsedSslRequest, "password"> | ParsedUnixSocket

/** The port of a transport at `where`: an integer from 1 to 65535, or refused. */
const parsePort = (port: unknown, where: SettingPath): Result.Result<number, SettingFault> =>
	typeof port === "number" && integerIn(port, 1, portMax)
		? Result.succeed(port)
		: Result.fail(
				faultAt(where, "port", { kind: "integer", least: 1, most: portMax, unit: "port" })
			)

/**
 * A block's transport as its read left it (readTransport): its kind read first, and then exactly its kind's settings
 * (transportSettings), each parsed, or the setting it refuses, a setting of the other kind's refused as no setting of
 * it.
 */
const parseTransport = (
	read: TransportRead,
	where: SettingPath
): Result.Result<AdmittedTransport, SettingFault> => {
	const { kind } = read.setting.data
	switch (kind) {
		case "sslRequest":
			return parseSslRequest(read, where)
		case "unixSocket":
			return parseUnixSocket(read, where)
		default:
			return Result.fail(faultAt(where, "kind", { kind: "transportKind" }))
	}
}

/** A network transport's settings as its read left them: its host minted a network host and its CA a bundle of PEM
 * texts, or the setting it refuses. */
const parseSslRequest = (
	read: TransportRead,
	where: SettingPath
): Result.Result<AdmittedTransport, SettingFault> => {
	const extra = unknownKey(read.setting.keys, transportSettings.sslRequest, where)
	if (Option.isSome(extra)) {
		return Result.fail(extra.value)
	}
	const { host, port: portSetting, ca: caSetting, servername } = read.setting.data
	const open = read.open
	if (typeof host !== "string" || host === "") {
		return Result.fail(faultAt(where, "host", { kind: "nonemptyText" }))
	}
	if (Str.startsWith("/")(host)) {
		return Result.fail(faultAt(where, "host", { kind: "networkHost" }))
	}
	const port = parsePort(portSetting, where)
	if (Result.isFailure(port)) {
		return Result.fail(port.failure)
	}
	if (typeof open !== "function") {
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
		(authority): AdmittedTransport => ({
			kind: "sslRequest",
			host: networkHost(host),
			port: port.success,
			open,
			ca: bundle,
			authority,
			servername
		})
	)
}

/** A Unix socket transport's settings as its read left them: its directory minted a socket directory, or the setting
 * it refuses. */
const parseUnixSocket = (
	read: TransportRead,
	where: SettingPath
): Result.Result<AdmittedTransport, SettingFault> => {
	const extra = unknownKey(read.setting.keys, transportSettings.unixSocket, where)
	if (Option.isSome(extra)) {
		return Result.fail(extra.value)
	}
	const { directory, port: portSetting } = read.setting.data
	if (
		typeof directory !== "string" ||
		!Str.startsWith("/")(directory) ||
		Str.includes("\0")(directory)
	) {
		return Result.fail(faultAt(where, "directory", { kind: "socketDirectory" }))
	}
	return Result.map(parsePort(portSetting, where), (port): AdmittedTransport => ({
		kind: "unixSocket",
		directory: socketDirectory(directory),
		port
	}))
}

/**
 * A block's transport with the credential its kind signs in with: a network transport's password, which the block must
 * give; and nothing beside a Unix socket, over which the server authenticates the operating-system account, so a block
 * that states a password there is refused at it.
 */
const credentialed = (
	transport: AdmittedTransport,
	password: Option.Option<ConnectionPassword>,
	keys: ReadonlyArray<string>,
	where: SettingPath
): Result.Result<ParsedTransport, SettingFault> => {
	switch (transport.kind) {
		case "sslRequest":
			return Option.isSome(password)
				? Result.succeed({ ...transport, password: password.value })
				: Result.fail(faultAt(where, "password", { kind: "password" }))
		case "unixSocket":
			return keys.includes("password")
				? Result.fail(faultAt(where, "password", { kind: "socketPassword" }))
				: Result.succeed(transport)
	}
}

/**
 * The block at `where`, which holds `extras` besides its connection: parsed, with what `extras` parses of it, or the
 * setting it refuses and the rule it breaks.
 *
 * A DbConfig's login value and verify are the layer's to read (pool/served.ts), never plain data.
 */
export const parseConnection = <E>(
	block: DbConnection,
	where: SettingPath,
	extras: BlockSettings<E>
): Result.Result<ParsedConnection & E, SettingFault> => {
	const value: unknown = block
	const settings = [...connectionSettings, ...extras.settings]
	if (!Predicate.isObject(value)) {
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
	const { database, rolePrefix } = plain
	if (Option.isNone(transportRead)) {
		return Result.fail(faultAt(where, "transport", { kind: "object", settings: ["kind"] }))
	}
	const admitted = parseTransport(transportRead.value, [...where, "transport"])
	if (Result.isFailure(admitted)) {
		return Result.fail(admitted.failure)
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
	const transport = credentialed(admitted.success, password, keys, where)
	if (Result.isFailure(transport)) {
		return Result.fail(transport.failure)
	}
	return Result.succeed({
		driver: driver.value,
		transport: transport.success,
		database,
		roles: roles.success,
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
		return Result.fail(
			faultAt(where, "rolePrefix", { kind: "rolePrefix", fault: { kind: "notText" } })
		)
	}
	const space = roleSpaceOf(rolePrefix)
	return space.ok
		? Result.succeed(space.value)
		: Result.fail(faultAt(where, "rolePrefix", { kind: "rolePrefix", fault: space.error }))
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
					kind: "installedRole",
					role: role.error.role,
					limit: role.error.limit
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
	if (!Predicate.isObject(setting)) {
		return Result.fail({ setting: where, rule: { kind: "object", settings: poolSettings } })
	}
	const extra = unknownKey(Rec.keys(setting), poolSettings, where)
	if (Option.isSome(extra)) {
		return Result.fail(extra.value)
	}
	const { max } = setting
	if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) {
		return Result.fail(faultAt(where, "max", { kind: "integerFrom", least: 1 }))
	}
	return Result.succeed({ max })
}
