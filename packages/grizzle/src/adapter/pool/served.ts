import * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type * as Scope from "effect/Scope"
import {
	connectionRole,
	faultAt,
	type ParsedConnection,
	parseConnection,
	type SettingPath,
	servedLoginSettings
} from "#adapter/connection/config.ts"
import { startupVariableSet } from "#adapter/connection/environment.ts"
import { readHost } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import {
	ConnectionEnvironmentRefused,
	DbConfigRefused,
	RoleOutsideLayers,
	type SettingFault
} from "#adapter/errors/failures.ts"
import { liveSourceSessions } from "#adapter/live/layer.ts"
import type { Subscriptions } from "#adapter/live/subscriptions.ts"
import { type LoadedLogin, type LoadedRole, loadServed } from "#adapter/served/load.ts"
import type {
	ConnectionPool,
	DbConfigShape,
	DbLayerOf,
	DbLayerService,
	LiveOf,
	PoolBounds,
	ServedLogin,
	Verify
} from "#adapter/types/layer.ts"
import { type LoginConnection, makePool, type SessionPool } from "#adapter/wire/session.ts"
import type { AnyLogin, Invariant } from "#compiler/plan/common.ts"
import {
	defect,
	SourceLoc,
	malformedDescription,
	nominal,
	readCaller
} from "#compiler/plan/runtime.ts"
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
	/** The layer's live reads' registry, which every watch of its Dbs registers on (live/subscriptions.ts). */
	readonly subscriptions: Subscriptions
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
export interface RoleNames {
	readonly base: string
	readonly login: string
	readonly role: string
}

/** A role as its login's layer loaded it, beside the layer: what a Db of the role opens on. */
export interface HeldRole {
	readonly sessions: ServedSessions
	readonly role: LoadedRole
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
 * The role `names` names, among the layers `context` holds, as its login's layer loaded it (see the header): a login
 * whose layer `context` does not hold, or whose layer holds no role of the name, is RoleOutsideLayers.
 */
export const heldRole = <S>(
	context: Context.Context<S>,
	names: RoleNames
): Result.Result<HeldRole, OpenError> =>
	Result.fromOption(
		Option.flatMap(
			Context.getOption(context, sessionsKey<S>(names.base, names.login)),
			(sessions) =>
				Option.map(
					Arr.findFirst(sessions.login.roles, (r) => r.name === names.role),
					(loaded) => ({ sessions, role: loaded })
				)
		),
		() => new OpenError({ reason: new RoleOutsideLayers({ role: names.role, login: names.login }) })
	)

/** The role at `address`, among the layers the context holds, as its login's layer loaded it (heldRole). */
export const servedSessions = <R>(
	address: RoleAddress<R>
): Effect.Effect<HeldRole, OpenError, DbLayerService<R>> =>
	Effect.flatMap(Effect.context<DbLayerService<R>>(), (context) =>
		Effect.fromResult(heldRole(context, address))
	)

/** A served login as a config's read names it: its declared name, its base's, and its file as served(...) read it. */
export interface ReadLogin {
	readonly name: string
	readonly base: string
	readonly file: ServedFile
}

/**
 * A DbConfig parsed: the served login it names, its file as served(...) read it and its name, its connection, its pool's bounds,
 * the hook each pool is handed when it is built, which attaches nothing when the config names none, and its token
 * check.
 */
interface ParsedDbConfig extends ParsedConnection {
	readonly login: ReadLogin
	readonly pool: PoolBounds
	readonly attachPool: (pool: ConnectionPool) => void
	readonly token: TokenCheck
}

/** The pool hook of a config that names none. */
const attachNothing = (): void => undefined

const refusedConfig = (fault: SettingFault): OpenError =>
	new OpenError({ reason: new DbConfigRefused(fault) })

/** The block a DbConfig's settings sit in, as a refusal names their paths. */
const dbConfig: SettingPath = ["DbConfig"]

/**
 * The keys of a served login value the layer leaves unread when it reads the value: its file, which it takes once off
 * the typed value, and its roles' tokens, which only Db.open reads.
 */
const loginUnread: ReadonlySet<string> = new Set(["file", "roles"])

const loginRefused: SettingFault = faultAt(dbConfig, "login", { kind: "servedLogin" })

/**
 * A served login a block names, read once at the boundary (core/host.ts readCaller) as a JavaScript caller may pass any
 * value: an object whose kind is a served login's and whose name and base are strings, read off its copy, holding a
 * file, which is taken once off the typed value; anything else is `refused`. Its roles' tokens are left unread.
 */
export const readServedLogin = <L>(
	login: ServedLogin<L>,
	refused: SettingFault
): Result.Result<ReadLogin, SettingFault> => {
	const passed: unknown = login
	if (typeof passed !== "object" || passed === null) {
		return Result.fail(refused)
	}
	const read = readCaller(passed, loginUnread)
	if (!read.ok) {
		return Result.fail(refused)
	}
	const { kind, name, base } = read.value.data
	if (
		kind !== "servedLogin" ||
		typeof name !== "string" ||
		typeof base !== "string" ||
		!read.value.keys.includes("file")
	) {
		return Result.fail(refused)
	}
	return Result.succeed({ name, base, file: login.file })
}

/**
 * The config's own settings, read once at the boundary as the connection's are (core/host.ts readCaller): the served
 * login, the pool hook and verify, each read once off the typed config and checked as a JavaScript caller may pass any
 * value, and the login's kind and names read once off its copy; nothing after reads the config or the login again. The
 * pool's bounds are plain data, parsed with the connection (connection/config.ts servedLoginSettings).
 */
const ownSettings = <L extends AnyLogin>(
	config: DbConfigShape<L>
): Result.Result<Pick<ParsedDbConfig, "login" | "attachPool" | "token">, SettingFault> =>
	readHost({ setting: dbConfig, rule: { kind: "data" } }, () => {
		const login = config.login
		const hook = config.attachPool
		const verify = config.verify
		/** The same values as plain JavaScript passes them: a block written in JavaScript is checked all the same. */
		const passedHook: unknown = hook
		const passedVerify: unknown = verify
		const read = readServedLogin(login, loginRefused)
		if (Result.isFailure(read)) {
			return Result.fail(read.failure)
		}
		if (hook !== undefined && typeof passedHook !== "function") {
			return Result.fail(faultAt(dbConfig, "attachPool", { kind: "function" }))
		}
		if (verify !== undefined && typeof passedVerify !== "function") {
			return Result.fail(faultAt(dbConfig, "verify", { kind: "function" }))
		}
		return Result.succeed({
			login: read.success,
			attachPool: hook ?? attachNothing,
			token: verify === undefined ? { kind: "none" } : { kind: "verify", verify }
		})
	})

/** The DbConfig given to DbLayer.make, parsed once (connection/config.ts); a refusal is OpenError{stage: "config"}. */
export const parseServedConfig = <L extends AnyLogin>(
	config: DbConfigShape<L>
): Result.Result<ParsedDbConfig, OpenError> =>
	Result.mapError(
		Result.flatMap(parseConnection(config, dbConfig, servedLoginSettings), (parsed) =>
			Result.map(ownSettings(config), (settings) => ({ ...parsed, ...settings }))
		),
		refusedConfig
	)

/**
 * `login` as the config's installation installs it: its PostgreSQL role, which every session of its pool logs in as,
 * and each of its roles', which a Db's prologue takes on, the file's stems each under the config's role space
 * (connection/config.ts connectionRole).
 */
const installedLogin = (
	config: ParsedDbConfig,
	login: LoadedLogin
): Result.Result<LoadedLogin, SettingFault> =>
	Result.flatMap(connectionRole(config, dbConfig, login.role), (role) =>
		Result.map(
			Result.all(
				Arr.map(login.roles, (r) =>
					Result.map(connectionRole(config, dbConfig, r.installed), (installed) => ({
						...r,
						installed
					}))
				)
			),
			(roles) => ({ ...login, role, roles })
		)
	)

/**
 * Builds the service in the current scope (the layer's) from a parsed config: the served login loaded (see the header),
 * a login a role of which reads a context refused without a verify, then the login's pool.
 */
const makeServedSessions = Effect.fn("makeServedSessions")(function* <L>(
	config: ParsedDbConfig
): Effect.fn.Return<ServedSessions, OpenError, Scope.Scope | LiveOf<L>> {
	const loaded = yield* Effect.fromResult(loadServed(config.login.file, config.login.name))
	const login = yield* Effect.fromResult(
		Result.mapError(installedLogin(config, loaded), refusedConfig)
	)
	const reading = Arr.findFirst(login.roles, (role) => role.contexts.length > 0)
	if (config.token.kind === "none" && Option.isSome(reading)) {
		return yield* refusedConfig(
			faultAt(dbConfig, "verify", {
				kind: "verifier",
				role: reading.value.name,
				login: login.login
			})
		)
	}
	const connection: LoginConnection = {
		driver: config.driver,
		transport: config.transport,
		database: config.database,
		role: login.role,
		password: config.password,
		connectTimeoutMs: config.connectTimeoutMs
	}
	const pool = yield* makePool({
		connection,
		session: login.session,
		bounds: config.pool,
		attachPool: config.attachPool
	})
	const subscriptions = yield* liveSubscriptions<L>(login)
	return { login, pool, token: config.token, subscriptions }
})

/**
 * The registry the layer's watches register on: its installation's live source's, which the layer requires where its
 * login serves a read (types/layer.ts LiveOf) and finds by its base (live/layer.ts liveSourceSessions); a login that
 * serves none registers no watch.
 */
const liveSubscriptions = <L>(
	login: LoadedLogin
): Effect.Effect<Subscriptions, OpenError, LiveOf<L>> => {
	switch (login.live.kind) {
		case "none":
			return Effect.succeed(readFree)
		case "source":
			return Effect.map(liveSourceSessions<LiveOf<L>>(login.base), (live) => live.subscriptions)
	}
}

/** The registry of a login that serves no read, which no watch of its Dbs registers on. */
const readFree: Subscriptions = {
	register: () => Effect.die(defect("a login that serves no read registers no live read"))
}

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
): Layer.Layer<DbLayerOf<L>, OpenError, LiveOf<L>> => {
	const read = parseServedConfig(config)
	return Layer.unwrap(
		Effect.gen(function* () {
			const parsed = yield* Effect.fromResult(read)
			yield* loginEnvironment
			return Layer.effect(
				sessionsKey<DbLayerOf<L>>(parsed.login.base, parsed.login.name),
				makeServedSessions<L>(parsed)
			)
		})
	)
}
