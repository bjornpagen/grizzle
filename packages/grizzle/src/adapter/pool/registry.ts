import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Result,
	type Scope
} from "effect"
import { parseSnapshot } from "#adapter/boundary/snapshot.ts"
import {
	loginSettings,
	type ParsedConnection,
	parseConnection
} from "#adapter/connection/config.ts"
import { startupVariableSet } from "#adapter/connection/environment.ts"
import { theoryRole } from "#adapter/connection/role.ts"
import { type TypedContext, typedContext } from "#adapter/db/claims.ts"
import type { RoleContext } from "#adapter/db/context.ts"
import { compileRoleWorkload, type WorkloadForm } from "#adapter/db/workload.ts"
import { fromEngine, readHost, rowOptions } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import {
	ConnectionEnvironmentRefused,
	DbConfigRefused,
	RoleOutsideLayers
} from "#adapter/errors/failures.ts"
import type {
	ConnectionPool,
	DbConfigShape,
	PoolBounds,
	DbLayerService,
	DbLayerOf,
	Verify
} from "#adapter/types/layer.ts"
import type { PrologueStatements } from "#adapter/wire/batch.ts"
import { makePool, type SessionPool } from "#adapter/wire/session.ts"
import { installationWitness } from "#adapter/witness/index.ts"
import { type LawsAbove, lawsAbove } from "#adapter/witness/keylaw.ts"
import {
	type AnyLogin,
	type AnyWorkload,
	baseArtifacts,
	type BindContext,
	type BuiltSchema,
	catchRefusal,
	type Codebook,
	codeNames,
	type CompileError,
	Engine,
	type LoginDesc,
	loginDescOf,
	loginRoleName,
	malformedDescription,
	own,
	ownBuiltLogin,
	type Owned,
	ownedEntry,
	type OwnedLogin,
	parseBuiltSchema,
	parseSchemaInput,
	queryUses,
	roleArtifacts,
	type RoleDesc,
	type SchemaArtifacts,
	SourceLoc
} from "#compiler/plan/common.ts"
import {
	installBasis,
	type InstallBasis,
	ledgerStatements,
	type ServedSnapshot
} from "#compiler/plan/migration.ts"
import { templateFor } from "#compiler/plan/read.ts"

/**
 * The DbLayer service: one login's connection settings, its verify, its snapshot, its workloads compiled, and its one
 * session pool.
 *
 * DbLayer.make(config) builds this service once per instance, for the login the config names, and computes there,
 * once, what every Db of the login reads: the snapshot, parsed (boundary/snapshot.ts parseSnapshot), and the
 * installation's codes it records (deploy/snapshot/served.ts rosterCodebook), the codes of every closed id and set a Db
 * writes or reads, since a roster's codes are its history and no schema alone determines them; each role's artifacts
 * (program/schema.ts schemaArtifacts), compiled under those codes, which compile every program a Db of the role runs;
 * every program of the login's workloads, compiled for every role it runs on (db/workload.ts compileRoleWorkload); the
 * login's own PostgreSQL role; and the login's one session pool. The snapshot is the database's: the layer compiles
 * under what it records and compares nothing with it, and a program's access paths are `grizzle check`'s to compare
 * (program/workload/compile.ts accessDrift). Every session of the pool logs in as the login's
 * role (program/names.ts loginRoleName, the role roleNameOf names), which no Db outlives: each of a Db's transactions
 * enters the Db's own role by its prologue (wire/batch.ts runFramed), two statements run as the login. So one pool
 * serves every role of the login. The pool lives as long as the layer, in its
 * scope, never on globalThis. A snapshot that does not parse, a role or program that does not compile, or a login whose
 * role name the naming door refuses, a role past 63 bytes among them, fails the layer with its CompileError.
 *
 * One key per login. The requirement DbLayer<R> names the role only as a type; Db.open(Web.roles.member) resolves it
 * through the login the role is reached by, whose layer is stored under that login's key, so a program may provide the
 * layers of several logins and each Db.open finds its own. A login whose layer is not provided is
 * OpenError{stage: "role"} (RoleOutsideLayers). Two layers of one login share a key, and the later one wins, as
 * Effect's context does for any service.
 *
 * The config's verify is required exactly when a role of the login reads a context, which the type states and the
 * parse checks for a JavaScript caller (DbConfigRefused): every Db of such a login can then turn a token into claims.
 *
 * How a layer's Dbs turn a token into claims: by its verify, or not at all, for a login whose roles read no context.
 */
export type TokenCheck =
	| { readonly kind: "none" }
	| { readonly kind: "verify"; readonly verify: Verify }

/**
 * One role of the layer's login, as every Db of it reads it: the role value the login holds, its compilation context
 * (db/context.ts RoleContext); the PostgreSQL role a Db of it enters; the contexts its relations read, typed, which a
 * token's claims decode through; and the programs of the login's workloads over it, compiled.
 */
export interface LayerRole extends RoleContext {
	readonly value: object
	readonly theory: string
	readonly contexts: ReadonlyArray<TypedContext>
	readonly workload: ReadonlyArray<WorkloadForm>
}

/**
 * The contexts the role's relations read (schema/own.ts OwnedRole.contexts), their fields typed against the base, each
 * with its codec under the installation's codes: a contract or roster a context names is the base's.
 */
const typedContexts = (
	artifacts: SchemaArtifacts
): Engine.Result<ReadonlyArray<TypedContext>, CompileError> => {
	const world = artifacts.world
	const contexts = world.kind === "role" ? Rec.values(world.role.contexts) : []
	const checked = artifacts.derived.schema
	return catchRefusal(() =>
		Arr.map(contexts, (context) =>
			typedContext(
				context,
				(field) => checked.fieldType(field, SourceLoc(`context ${context.name}`, [])),
				artifacts.names.codes
			)
		)
	)
}

/** The layer's service, provided as DbLayer<R> for each role R of its login: what every Db of the login shares. */
export interface DbSessions {
	/** The login the layer was built for. */
	readonly login: LoginDesc
	/** The login's PostgreSQL role, which every session of the pool logs in as (program/names.ts loginRoleName). */
	readonly loginRole: string
	/** What the layer and its Dbs read of the snapshot it was given, parsed once (boundary/snapshot.ts parseSnapshot). */
	readonly snapshot: ServedSnapshot
	/** Each role of the login, in the login's order. */
	readonly roles: Arr.NonEmptyReadonlyArray<LayerRole>
	/** The one pool of the login's role. */
	readonly pool: SessionPool
	/** The texts of the prologue's two statements. */
	readonly prologue: PrologueStatements
	readonly token: TokenCheck
}

const keyPrefix = "@bjornpagen/grizzle/DbLayer/"

/**
 * The service key of the layer of a login, by its base's declared name and its own, under the identifier the reader of
 * the key names: the layer's DbSessions.
 */
const sessionsKey = <I>(login: LoginDesc): Context.Service<I, DbSessions> =>
	Context.Service<I, DbSessions>(`${keyPrefix}${login.base.name}/${login.name}`)

/** Whether a role's relations read a context: some query entry matches one. */
const roleReadsContext = (role: RoleDesc): boolean =>
	Arr.some(
		role.relations,
		(entry) => entry.kind === "world" && queryUses(entry.query).contexts.size > 0
	)

/**
 * The layer of `login`, the login value the role `role` was reached through, among the layers the context holds (see
 * the header).
 */
export const dbSessions = <R>(
	login: AnyLogin,
	role: string
): Effect.Effect<DbSessions, OpenError<RoleOutsideLayers>, DbLayerService<R>> =>
	Effect.flatMap(Effect.context<DbLayerService<R>>(), (context) => {
		const desc = loginDescOf(login)
		const found =
			desc === undefined
				? undefined
				: Context.getOption(context, sessionsKey<DbLayerService<R>>(desc))
		return found !== undefined && Option.isSome(found)
			? Effect.succeed(found.value)
			: Effect.fail(new OpenError({ reason: new RoleOutsideLayers({ role, login: login.name }) }))
	})

/**
 * A DbConfig parsed: the login it names, its connection, its pool's bounds, the hook each pool is handed when it is
 * built, which attaches nothing when the config names none, and its token check.
 */
interface ParsedDbConfig extends ParsedConnection {
	readonly login: BuiltLogin
	/** The snapshot as the config gives it: the JSON value an import of snapshot.json yields, parsed by the layer. */
	readonly snapshot: object
	readonly pool: PoolBounds
	readonly attachPool: (pool: ConnectionPool) => void
	readonly token: TokenCheck
}

/** The pool hook of a config that names none. */
const attachNothing = (): void => undefined

const refusedConfig = (detail: string): OpenError =>
	new OpenError({ reason: new DbConfigRefused({ detail }) })

/**
 * The config's own settings, read once at the boundary as the connection's are (core/host.ts hostRead): the login
 * value, the snapshot, the pool hook and verify, each checked as a JavaScript caller may pass any value. The pool's
 * bounds are plain data, parsed with the connection (connection/config.ts loginSettings).
 */
const ownSettings = <L extends AnyLogin>(
	config: DbConfigShape<L>
): Result.Result<Pick<ParsedDbConfig, "login" | "snapshot" | "attachPool" | "token">, string> =>
	readHost(
		"DbConfig must be an object whose settings read as data: no getter, setter or refusing proxy",
		() => {
			const built = builtLogin(config.login)
			if (built === undefined) {
				return Result.fail("DbConfig.login must be a login built by login(...)")
			}
			const login = built.desc
			const hook = config.attachPool
			const verify = config.verify
			/** The same values as plain JavaScript passes them: a block written in JavaScript is checked all the same. */
			const passedHook: unknown = hook
			const passedVerify: unknown = verify
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
			const reading = Arr.findFirst(login.roles, roleReadsContext)
			if (verify === undefined && Option.isSome(reading)) {
				return Result.fail(
					`DbConfig.verify must be a function: role ${reading.value.name} of login ${login.name} reads a context`
				)
			}
			const snapshot: unknown = config.snapshot
			if (typeof snapshot !== "object" || snapshot === null) {
				return Result.fail(
					"DbConfig.snapshot must be the committed snapshot.json, as an import of it yields"
				)
			}
			return Result.succeed({
				login: built,
				snapshot,
				attachPool: hook ?? attachNothing,
				token: verify === undefined ? { kind: "none" } : { kind: "verify", verify }
			})
		}
	)

/** The DbConfig given to DbLayer.make, parsed once (connection/config.ts); a refusal is OpenError{stage: "config"}. */
const parseDbConfig = <L extends AnyLogin>(
	config: DbConfigShape<L>
): Result.Result<ParsedDbConfig, OpenError> =>
	Result.mapError(
		Result.flatMap(parseConnection(config, "DbConfig", loginSettings), (parsed) =>
			Result.map(ownSettings(config), (settings) => ({ ...parsed, ...settings }))
		),
		refusedConfig
	)

const makeLoc = SourceLoc("DbLayer.make", [])

/**
 * A login value login(...) built, read once where it is given: its Description, its base's built schema, its role
 * values in its order, and its workloads, as login(...) admitted them. login(...) held each role to the base, by
 * content (schema/world.ts admitLogin), so every role is compiled over the base the login's compilation owns once.
 */
export interface BuiltLogin {
	readonly desc: LoginDesc
	readonly base: BuiltSchema
	readonly roles: ReadonlyArray<unknown>
	readonly workload: ReadonlyArray<AnyWorkload>
}

/** The built login a value is, undefined for a value login(...) did not build. */
export const builtLogin = (value: unknown): BuiltLogin | undefined => {
	const entry = ownedEntry(value, "login")
	if (entry === undefined) {
		return undefined
	}
	const base = parseBuiltSchema(entry.value.base, makeLoc)
	return base.ok
		? {
				desc: entry.desc,
				base: base.value,
				roles: Arr.map(Rec.values(entry.value.roles), (r) => r.role),
				workload: entry.value.workload
			}
		: undefined
}

/**
 * The artifacts of a login's base, owned once, compiled once under the installation's codes `codes`, under its own
 * installation and vector schema (program/schema.ts baseArtifacts): what the login's programs' access and every one of
 * its roles read.
 */
export const artifactsUnder = (
	base: Owned,
	codes: Codebook
): Engine.Result<SchemaArtifacts, CompileError> =>
	Engine.flatMap(installBasis(base, codes), artifactsOver)

/** The artifacts of a base over its basis (physical/install/plan.ts installBasis), under its own installation. */
export const artifactsOver = (basis: InstallBasis): Engine.Result<SchemaArtifacts, CompileError> =>
	baseArtifacts(basis)

/** A built login owned over its base's Owned, which login(...) held each of its roles to. */
export const ownLoginOver = (
	login: BuiltLogin,
	base: Owned
): Engine.Result<OwnedLogin, CompileError> => ownBuiltLogin(login.desc, base)

/**
 * One role of the login, parsed, its artifacts read over the base's (program/schema.ts roleArtifacts) and the programs
 * of the login's workloads over it compiled, its decoders bound under `bind`: a role or program that does not compile is
 * its CompileError.
 */
const layerRole = Effect.fn("layerRole")(function* (
	value: unknown,
	owned: OwnedLogin,
	base: SchemaArtifacts,
	workload: ReadonlyArray<AnyWorkload>,
	bind: BindContext,
	above: LawsAbove
): Effect.fn.Return<LayerRole, CompileError> {
	const input = yield* fromEngine(parseSchemaInput(value))
	const ownedRole =
		input.kind === "role"
			? Arr.findFirst(owned.roles, (r) => r.name === input.desc.name)
			: Option.none()
	if (
		input.kind !== "role" ||
		Option.isNone(ownedRole) ||
		typeof value !== "object" ||
		value === null
	) {
		return yield* Effect.fail(malformedDescription(makeLoc, "a login's role built by role(...)"))
	}
	const artifacts = yield* fromEngine(roleArtifacts(ownedRole.value, base))
	const theory = theoryRole(artifacts)
	if (theory === undefined) {
		return yield* Effect.fail(malformedDescription(makeLoc, "a login's role built by role(...)"))
	}
	const role: RoleContext = {
		schema: input,
		declared: input.desc.base.name,
		role: input.desc,
		artifacts,
		compile: (query, request) => templateFor(query, input, artifacts, request),
		witness: installationWitness(artifacts, above),
		bind
	}
	const contexts = yield* fromEngine(typedContexts(artifacts))
	const forms = yield* Effect.fromResult(compileRoleWorkload(role, ownedRole.value, workload))
	return { ...role, value, theory, contexts, workload: forms }
})

/**
 * Every role of a login, each parsed, its artifacts read over its base's artifacts `base` (compileBase) and every
 * program of the login's workloads over it compiled, as every Db of the login runs it (layerRole): the one compilation
 * of a login's programs. DbLayer.make runs it at startup under the snapshot's codes, and `grizzle generate` and `grizzle
 * check` run it under the codes they draft before they draft (cli/generate.ts draftInput), so a program generate admits
 * is one the layer compiles. Nothing here owns or installs the base again: the login is owned over the base's Owned
 * (ownLoginOver) and every role reads the one installation. A role or program that does not compile is its
 * CompileError. Every role reads the one installation's codes, so the roles share one bind context, each roster's
 * names in code order.
 */
export const loginRoles = (
	login: BuiltLogin,
	owned: OwnedLogin,
	base: SchemaArtifacts,
	above: LawsAbove
): Effect.Effect<ReadonlyArray<LayerRole>, CompileError> => {
	const bind: BindContext = { options: rowOptions, names: codeNames(base.names.codes) }
	return Effect.forEach(login.roles, (value) =>
		layerRole(value, owned, base, login.workload, bind, above)
	)
}

/**
 * The snapshot the config gives, parsed once: the JSON value an import of snapshot.json yields, read as the generator
 * wrote it, its recorded fingerprint trusted (boundary/snapshot.ts parseSnapshot).
 */
const layerSnapshot = (given: object): Effect.Effect<ServedSnapshot, OpenError> =>
	Effect.mapError(Effect.fromResult(parseSnapshot(given)), (reason) => new OpenError({ reason }))

/** An engine result as the layer's: a refusal is OpenError with the compiler's reason. */
const openStage = <A>(result: Engine.Result<A, CompileError>): Effect.Effect<A, OpenError> =>
	Effect.mapError(fromEngine(result), (reason) => new OpenError({ reason }))

/**
 * Builds the service in the current scope (the layer's) from a parsed config: the snapshot, parsed, its codes read; the
 * login's base owned once and the login over it; the base's artifacts compiled once under the codes (artifactsUnder),
 * which every role reads, and the laws of the levels above the base's that the snapshot records (witness/keylaw.ts
 * lawsAbove), the base's level the last of its own levels; every role's artifacts and programs over them; the login's
 * role, its pool and the prologue's statements (see the header).
 */
const makeDbSessions = Effect.fn("makeDbSessions")(function* (
	config: ParsedDbConfig
): Effect.fn.Return<DbSessions, OpenError, Scope.Scope> {
	const snapshot = yield* layerSnapshot(config.snapshot)
	const codes = snapshot.codes
	const base = yield* openStage(own(config.login.base.desc))
	const owned = yield* openStage(ownLoginOver(config.login, base))
	const loginRole = yield* openStage(loginRoleName(config.login.desc))
	const artifacts = yield* openStage(artifactsUnder(owned.base, codes))
	const above = lawsAbove(snapshot, owned.base.levels.length - 1)
	const roles = yield* Effect.mapError(
		loginRoles(config.login, owned, artifacts, above),
		(reason) => new OpenError({ reason })
	)
	if (!Arr.isReadonlyArrayNonEmpty(roles)) {
		return yield* new OpenError({ reason: malformedDescription(makeLoc, "a login with a role") })
	}
	const [first] = roles
	const ledger = yield* openStage(ledgerStatements(first.artifacts.names.schema))
	const pool = yield* makePool({
		connection: {
			driver: config.driver,
			transport: config.transport,
			database: config.database,
			role: loginRole,
			password: config.password,
			connectTimeoutMs: config.connectTimeoutMs
		},
		bounds: config.pool,
		attachPool: config.attachPool
	})
	const prologue: PrologueStatements = { fence: ledger.fence.text, enter: ledger.enter.text }
	return {
		login: config.login.desc,
		loginRole,
		snapshot,
		roles,
		pool,
		prologue,
		token: config.token
	}
})

/**
 * The process environment the layer's sessions would start in, read where pg reads it, which sets no startup variable
 * that reaches a login's session (connection/environment.ts): one it sets is OpenError{stage: "config"}.
 */
const loginEnvironment: Effect.Effect<void, OpenError> = Effect.flatMap(
	Effect.sync(() => startupVariableSet("login")),
	Option.match({
		onNone: () => Effect.void,
		onSome: (variable) =>
			Effect.fail(new OpenError({ reason: new ConnectionEnvironmentRefused({ variable }) }))
	})
)

/**
 * The DbLayer of a DbConfig: the config parsed once, then the process environment its sessions would start in
 * (loginEnvironment), then the service built in the layer's scope, stored under its login's key, which the parse names.
 * Either refusal is OpenError{stage: "config"}.
 */
export const dbSessionsLayer = <const L extends AnyLogin>(
	config: DbConfigShape<L>
): Layer.Layer<DbLayerOf<L>, OpenError> =>
	Layer.unwrap(
		Effect.gen(function* () {
			const parsed = yield* Effect.fromResult(parseDbConfig(config))
			yield* loginEnvironment
			return Layer.effect(sessionsKey<DbLayerOf<L>>(parsed.login.desc), makeDbSessions(parsed))
		})
	)
