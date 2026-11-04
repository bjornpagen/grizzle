import { Array as Arr, Effect, Formatter, Option, Record as Rec, Redacted, Result } from "effect"
import { readHost } from "#adapter/engine.ts"
import type { DbConnection } from "#adapter/types/layer.ts"
import type { Password, TlsConfig } from "#adapter/wire/session.ts"
import { hostArguments } from "#compiler/query/build/host.ts"

/**
 * A connection block, parsed once where it is given: the DbConfig DbLayer.make takes, and the migration connection
 * grizzle.config.ts types (cli/connection.ts). Its type says what a block holds, and a block written in JavaScript is
 * checked all the same; the rules no type states (a nonempty host and database, a port from 1 to 65535, a nonempty CA
 * bundle, a migration connection's nonempty role) hold for every caller. The parsed block is required throughout: its
 * TLS names the servername the server certificate must carry, which is the host when the block names none. No refusal
 * quotes a password.
 *
 * What a block holds besides its destination, credentials and TLS: a migration connection's login role, a nonempty
 * string (`role`); or a DbConfig's login value, snapshot, pool hook and verify (`login`), which the layer reads itself
 * (pool/registry.ts).
 */
export type BlockKind = "role" | "login"

const extraSettings: { readonly [K in BlockKind]: ReadonlyArray<string> } = {
	role: ["role"],
	login: ["login", "snapshot", "attachPool", "verify"]
}

/** The settings read off the typed block rather than as plain data: the password, and a DbConfig's functions. */
const ownSettings: ReadonlySet<string> = new Set(["password", "attachPool", "verify"])

/** A block's destination, credentials and verify-full TLS. */
export interface ParsedConnection {
	readonly host: string
	readonly port: number
	readonly database: string
	readonly password: Password
	readonly tls: TlsConfig
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Arr.isArray(v)

const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0

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

/** A Redacted whose value is a string: the password form a block can carry as data. */
const isRedactedText = (v: unknown): v is Redacted.Redacted =>
	Redacted.isRedacted(v) && typeof Redacted.value(v) === "string"

/** A block's tls.ca, read: PEM text, or a nonempty list of PEM texts, each nonempty; none for anything else. */
const caBundle = (setting: unknown): Option.Option<string | ReadonlyArray<string>> => {
	if (nonempty(setting)) {
		return Option.some(setting)
	}
	return Arr.isArray(setting) && setting.length > 0 && Arr.every(setting, nonempty)
		? Option.some(setting)
		: Option.none()
}

/**
 * The block named `where`, of kind `kind` (see BlockKind): parsed, or the refusal's text, which names the setting it
 * refuses. The caller reads its own settings from its typed block once this has checked the block's keys.
 *
 * A DbConfig's pool hook and verify are functions the layer reads itself (pool/registry.ts), never plain data.
 */
export const parseConnection = (
	block: DbConnection,
	where: string,
	kind: BlockKind
): Result.Result<ParsedConnection, string> => {
	const value: unknown = block
	if (!isObject(value)) {
		return Result.fail(`${where} must be an object`)
	}
	/**
	 * The caller's block, read once at the boundary (core/host.ts hostRead): each own setting once. The
	 * password, read off the typed block so an Effect keeps the channels its type states, is recognized by its library's
	 * own guard, a Redacted of text or an Effect, and kept opaque: the credential stage reveals or runs it. Every other
	 * setting is plain data, read once as data (query/build/host.ts hostArguments), so no read below runs caller code.
	 */
	const read = readHost(
		`${where} must be an object whose settings read as data: no getter, setter or refusing proxy`,
		() => {
			const keys = Rec.keys(value)
			const given = block.password
			const password: Password | undefined = isRedactedText(given)
				? given
				: Effect.isEffect(given)
					? given
					: undefined
			const plain: Record<string, unknown> = {}
			for (const key of keys) {
				if (!ownSettings.has(key)) {
					plain[key] = value[key]
				}
			}
			hostArguments(where, [plain])
			return Result.succeed({ keys, plain, password })
		}
	)
	if (Result.isFailure(read)) {
		return Result.fail(read.failure)
	}
	const { keys, plain, password } = read.success
	const settings = ["host", "port", "database", "password", "tls", ...extraSettings[kind]]
	const extra = unknownKey(keys, settings, where)
	if (Option.isSome(extra)) {
		return Result.fail(extra.value)
	}
	const { host, database, role, port, tls } = plain
	if (!nonempty(host)) {
		return Result.fail(`${where}.host must be a nonempty string`)
	}
	if (!nonempty(database)) {
		return Result.fail(`${where}.database must be a nonempty string`)
	}
	if (kind === "role" && !nonempty(role)) {
		return Result.fail(`${where}.role must be a nonempty string`)
	}
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
		return Result.fail(`${where}.port must be an integer port number from 1 to 65535`)
	}
	if (password === undefined) {
		return Result.fail(
			`${where}.password must be a Redacted or an Effect yielding one, evaluated for each connection attempt`
		)
	}
	if (!isObject(tls)) {
		return Result.fail(
			`${where}.tls must be an object with ca (PEM text) and an optional servername`
		)
	}
	const tlsExtra = unknownKey(Rec.keys(tls), ["ca", "servername"], `${where}.tls`)
	if (Option.isSome(tlsExtra)) {
		return Result.fail(tlsExtra.value)
	}
	const { ca: caSetting, servername } = tls
	const ca = caBundle(caSetting)
	if (Option.isNone(ca)) {
		return Result.fail(
			`${where}.tls.ca must be PEM certificate text, or a nonempty list of them: TLS is always verify-full`
		)
	}
	if (servername !== undefined && !nonempty(servername)) {
		return Result.fail(`${where}.tls.servername must be a nonempty string when given`)
	}
	return Result.succeed({
		host,
		port,
		database,
		password,
		tls: {
			ca: typeof ca.value === "string" ? ca.value : [...ca.value],
			servername: servername ?? host
		}
	})
}
