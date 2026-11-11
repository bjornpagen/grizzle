import * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type * as Scope from "effect/Scope"
import {
	type ParsedConnection,
	parseConnection,
	servedLoginSettings
} from "#adapter/connection/config.ts"
import { startupVariableSet } from "#adapter/connection/environment.ts"
import { readHost } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import {
	ConnectionEnvironmentRefused,
	DbConfigRefused,
	RoleOutsideLayers
} from "#adapter/errors/failures.ts"
import { type LoadedLogin, type LoadedRole, loadServed } from "#adapter/served/load.ts"
import type {
	ConnectionPool,
	DbConfigShape,
	DbLayerOf,
	DbLayerService,
	PoolBounds,
	Verify
} from "#adapter/types/layer.ts"
import { makePool, type SessionPool } from "#adapter/wire/session.ts"
import type { AnyLogin, Invariant } from "#compiler/plan/common.ts"
import { SourceLoc, malformedDescription, nominal, readCaller } from "#compiler/plan/runtime.ts"
import type { ServedFile } from "#compiler/plan/serve.ts"

/**
 * The DbLayer service: one served login's workload, loaded, its verify, and its one session pool.
 *
 * DbLayer.make(config) builds this service once per instance, for the served login the config names, and loads there,
 * once, what every Db of the login reads: its served file, read and rebuilt (served/load.ts loadServed), every
 * program's codecs, readers and decoders, each role's refusal classifier and contexts, the prologue's texts and the
 * fingerprint it guards with, under the codebook of the file's own rosters; and the login's one session pool. Nothing
 * is compiled and no schema is evaluated: the file is `grizzle generate`'s, which `grizzle check` holds to the compile.
 * Every session of the pool logs in as the login's role (the role roleNameOf names), which no Db outlives: each of a
 * Db's transactions enters the Db's own role by its prologue (wire/batch.ts runFramed), two statements run as the
 * login. So one pool serves every role of the login. The pool lives as long as the layer, in its scope, never on
 * globalThis. A file of another login than the one served(...) was given fails the layer at stage config.
 *
 * One key per login. The requirement DbLayer<R> names the role only as a type; Db.open(Web.roles.member) resolves it
 * through the token's login, whose layer is stored under that login's key, so a program may provide the layers of
 * several logins and each Db.open finds its own. A login whose layer is not provided is OpenError{stage: "role"}
 * (RoleOutsideLayers). Two layers of one login share a key, and the later one wins, as Effect's context does for any
 * service.
 *
 * The config's verify is required exactly when a role of the login reads a context, which the type states and the
 * layer checks for a JavaScript caller (DbConfigRefused): every Db of such a login can then turn a token into claims.
 *
 * How a layer's Dbs turn a token into claims: by its verify, or not at all, for a login whose roles read no context.
 */
export type TokenCheck =
	| { readonly kind: "none" }
	| { readonly kind: "verify"; readonly verify: Verify }

/** The layer's service, provided as DbLayer<R> for each role R of its login: what every Db of the login shares. */
export interface ServedSessions {
	/** The served login, loaded. */
	readonly login: LoadedLogin
	/** The one pool of the login's role. */
	readonly pool: SessionPool
	readonly token: TokenCheck
}

const keyPrefix = "@bjornpagen/grizzle/ServedLayer/"

/**
 * The service key of the layer of a login, by its base's declared name and its own, under the identifier the reader of
 * the key names: the layer's ServedSessions.
 */
const sessionsKey = <I>(base: string, login: string): Context.Service<I, ServedSessions> =>
	Context.Service<I, ServedSessions>(`${keyPrefix}${base}/${login}`)

declare const roleAddressBrand: unique symbol

/**
 * The role a Db.open names, read once off its token (readServedRole): its login's base and the login by their declared
 * names, and its own name in the login, plain strings, the key its layer is found by. Only readServedRole mints one, so
 * a lookup is never handed the caller's token, which it would read again; R, the role, is a phantom.
 */
export interface RoleAddress<R> {
	readonly base: string
	readonly login: string
	readonly role: string
	readonly [roleAddressBrand]: Invariant<R>
}

/** The names of a role's address, as its token's read copy holds them. */
interface RoleNames {
	readonly base: string
	readonly login: string
	readonly role: string
}

/** The refusal of a value handed Db.open that is no served role's token, at stage schema. */
const noToken = (): OpenError =>
	new OpenError({
		reason: malformedDescription(
			SourceLoc("Db.open", []),
			"a role reached through its served login: Db.open(Web.roles.member, ...)"
		)
	})

/** No key of a role's token is left unread: every own property is copied. */
const tokenKeys: ReadonlySet<string> = new Set()

/**
 * The address of the role a JavaScript caller hands Db.open, read once at the boundary (core/host.ts readCaller): an
 * object that is no list, its every own property data, whose kind is a served role's and whose base, login and role are
 * strings, which served(...)'s tokens alone hold. A value that is none, or whose reading throws (a proxy's trap, a
 * getter), is no token, refused at stage schema with no verify call, never escaping as a defect; every later read is of
 * the copy.
 */
export const readServedRole = <R>(value: unknown): Result.Result<RoleAddress<R>, OpenError> => {
	if (typeof value !== "object" || value === null || Arr.isArray(value)) {
		return Result.fail(noToken())
	}
	const read = readCaller(value, tokenKeys)
	if (!read.ok) {
		return Result.fail(noToken())
	}
	const { kind, base, login, role } = read.value.data
	if (
		kind !== "servedRole" ||
		typeof base !== "string" ||
		typeof login !== "string" ||
		typeof role !== "string"
	) {
		return Result.fail(noToken())
	}
	return Result.succeed(nominal<RoleNames, RoleAddress<R>>()({ base, login, role }))
}

/**
 * The layer of the role at `address`'s login, among the layers the context holds, and the role as it loaded (see the
 * header): a login whose layer is not provided, or whose layer holds no role of the address's name, is
 * RoleOutsideLayers.
 */
export const servedSessions = <R>(
	address: RoleAddress<R>
): Effect.Effect<
	{ readonly sessions: ServedSessions; readonly role: LoadedRole },
	OpenError,
	DbLayerService<R>
> =>
	Effect.flatMap(Effect.context<DbLayerService<R>>(), (context) =>
		Effect.mapError(
			Effect.fromOption(
				Option.flatMap(
					Context.getOption(context, sessionsKey<DbLayerService<R>>(address.base, address.login)),
					(sessions) =>
						Option.map(
							Arr.findFirst(sessions.login.roles, (r) => r.name === address.role),
							(loaded) => ({ sessions, role: loaded })
						)
				)
			),
			() =>
				new OpenError({
					reason: new RoleOutsideLayers({ role: address.role, login: address.login })
				})
		)
	)

/**
 * A DbConfig parsed: the served login it names, its file as served(...) read it and its name, its connection, its pool's bounds,
 * the hook each pool is handed when it is built, which attaches nothing when the config names none, and its token
 * check.
 */
interface ParsedDbConfig extends ParsedConnection {
	readonly login: { readonly name: string; readonly base: string; readonly file: ServedFile }
	readonly pool: PoolBounds
	readonly attachPool: (pool: ConnectionPool) => void
	readonly token: TokenCheck
}

/** The pool hook of a config that names none. */
const attachNothing = (): void => undefined

const refusedConfig = (detail: string): OpenError =>
	new OpenError({ reason: new DbConfigRefused({ detail }) })

/**
 * The keys of a served login value the layer leaves unread when it reads the value: its file, which it takes once off
 * the typed value, and its roles' tokens, which only Db.open reads.
 */
const loginUnread: ReadonlySet<string> = new Set(["file", "roles"])

const loginRefused = "DbConfig.login must be a served login built by served(...)"

/**
 * The config's own settings, read once at the boundary as the connection's are (core/host.ts readCaller): the served
 * login, the pool hook and verify, each read once off the typed config and checked as a JavaScript caller may pass any
 * value, and the login's kind and names read once off its copy; nothing after reads the config or the login again. The
 * pool's bounds are plain data, parsed with the connection (connection/config.ts servedLoginSettings).
 */
const ownSettings = <L extends AnyLogin>(
	config: DbConfigShape<L>
): Result.Result<Pick<ParsedDbConfig, "login" | "attachPool" | "token">, string> =>
	readHost(
		"DbConfig must be an object whose settings read as data: no getter, setter or refusing proxy",
		() => {
			const login = config.login
			const hook = config.attachPool
			const verify = config.verify
			/** The same values as plain JavaScript passes them: a block written in JavaScript is checked all the same. */
			const passedLogin: unknown = login
			const passedHook: unknown = hook
			const passedVerify: unknown = verify
			if (typeof passedLogin !== "object" || passedLogin === null) {
				return Result.fail(loginRefused)
			}
			const read = readCaller(passedLogin, loginUnread)
			if (!read.ok) {
				return Result.fail(loginRefused)
			}
			const { kind, name, base } = read.value.data
			if (
				kind !== "servedLogin" ||
				typeof name !== "string" ||
				typeof base !== "string" ||
				!read.value.keys.includes("file")
			) {
				return Result.fail(loginRefused)
			}
			if (hook !== undefined && typeof passedHook !== "function") {
				return Result.fail(
					"DbConfig.attachPool must be a function, called with each pool the layer builds"
				)
			}
			if (verify !== undefined && typeof passedVerify !== "function") {
				return Result.fail(
					"DbConfig.verify must be a function from a token to the payload its claims are read from"
				)
			}
			return Result.succeed({
				login: { name, base, file: login.file },
				attachPool: hook ?? attachNothing,
				token: verify === undefined ? { kind: "none" } : { kind: "verify", verify }
			})
		}
	)

/** The DbConfig given to DbLayer.make, parsed once (connection/config.ts); a refusal is OpenError{stage: "config"}. */
export const parseServedConfig = <L extends AnyLogin>(
	config: DbConfigShape<L>
): Result.Result<ParsedDbConfig, OpenError> =>
	Result.mapError(
		Result.flatMap(parseConnection(config, "DbConfig", servedLoginSettings), (parsed) =>
			Result.map(ownSettings(config), (settings) => ({ ...parsed, ...settings }))
		),
		refusedConfig
	)

/**
 * Builds the service in the current scope (the layer's) from a parsed config: the served login loaded (see the header),
 * a login a role of which reads a context refused without a verify, then the login's pool.
 */
const makeServedSessions = Effect.fn("makeServedSessions")(function* (
	config: ParsedDbConfig
): Effect.fn.Return<ServedSessions, OpenError, Scope.Scope> {
	const login = yield* Effect.fromResult(loadServed(config.login.file, config.login.name))
	const reading = Arr.findFirst(login.roles, (role) => role.contexts.length > 0)
	if (config.token.kind === "none" && Option.isSome(reading)) {
		return yield* refusedConfig(
			`DbConfig.verify must be a function: role ${reading.value.name} of login ${login.login} reads a context`
		)
	}
	const pool = yield* makePool({
		connection: {
			driver: config.driver,
			transport: config.transport,
			database: config.database,
			role: login.role,
			password: config.password,
			connectTimeoutMs: config.connectTimeoutMs
		},
		session: login.session,
		bounds: config.pool,
		attachPool: config.attachPool
	})
	return { login, pool, token: config.token }
})

/**
 * The process environment the layer's sessions would start in, read where pg reads it, which sets no startup variable
 * that reaches a login's session (connection/environment.ts): one it sets is OpenError{stage: "config"}.
 */
export const loginEnvironment: Effect.Effect<void, OpenError> = Effect.flatMap(
	Effect.sync(() => startupVariableSet("login")),
	Option.match({
		onNone: () => Effect.void,
		onSome: (variable) =>
			Effect.fail(new OpenError({ reason: new ConnectionEnvironmentRefused({ variable }) }))
	})
)

/**
 * The DbLayer of a DbConfig: the config parsed once, where DbLayer.make is given it, so a layer built again never reads
 * the caller's config again; then, each time the layer is built, its refusal, the process environment its sessions
 * would start in (loginEnvironment), then the service built in the layer's scope, stored under its login's key. Either
 * refusal is OpenError{stage: "config"}. The key is the file's base and the login's name, which loading holds to the
 * file's.
 */
export const servedLayer = <const L extends AnyLogin>(
	config: DbConfigShape<L>
): Layer.Layer<DbLayerOf<L>, OpenError> => {
	const read = parseServedConfig(config)
	return Layer.unwrap(
		Effect.gen(function* () {
			const parsed = yield* Effect.fromResult(read)
			yield* loginEnvironment
			return Layer.effect(
				sessionsKey<DbLayerOf<L>>(parsed.login.base, parsed.login.name),
				makeServedSessions(parsed)
			)
		})
	)
}
