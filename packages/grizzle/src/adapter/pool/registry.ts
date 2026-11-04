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
import { registeredSnapshot, servesSchema } from "#adapter/admission/snapshots.ts"
import { parseSnapshot } from "#adapter/boundary/snapshot.ts"
import { type ParsedConnection, parseConnection } from "#adapter/connection/config.ts"
import { setStartupVariable } from "#adapter/connection/environment.ts"
import { loginRole, theoryRole } from "#adapter/connection/role.ts"
import { type TypedContext, typedContext } from "#adapter/db/claims.ts"
import type { RoleContext } from "#adapter/db/context.ts"
import { compileRoleWorkload, type WorkloadForm } from "#adapter/db/workload.ts"
import { fromEngine, readHost } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import {
	ConnectionEnvironmentRefused,
	DbConfigRefused,
	RoleOutsideLayers,
	WorkloadUngenerated
} from "#adapter/errors/failures.ts"
import { acquisitionBudgets } from "#adapter/pool/budgets.ts"
import type {
	ConnectionPool,
	DbConfigShape,
	DbLayerService,
	DbLayerOf,
	Verify
} from "#adapter/types/layer.ts"
import type { PrologueStatements } from "#adapter/wire/batch.ts"
import { makePool, type SessionPool, serverStatement } from "#adapter/wire/session.ts"
import { installationWitness } from "#adapter/witness/index.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { poolBounds } from "#compiler/core/policy.ts"
import * as Engine from "#compiler/core/result.ts"
import { ledgerStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { LoginDesc, RoleDesc } from "#compiler/ir/desc.ts"
import {
	parseSchemaInput,
	type SchemaArtifacts,
	schemaArtifacts
} from "#compiler/program/schema.ts"
import { templateFor } from "#compiler/program/template.ts"
import { accessDrift, accessDriftText, loginAccess } from "#compiler/program/workload/compile.ts"
import { type OwnedLogin, type OwnedRole, ownLogin } from "#compiler/schema/own.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import type { AnyWorkload } from "#compiler/types/db/workload.ts"
import type { AnyLogin } from "#compiler/types/schema/world.ts"

/**
 * The DbLayer service: one login's connection settings, its verify, its snapshot, its workloads compiled, and its one
 * session pool.
 *
 * DbLayer.make(config) builds this service once per instance, for the login the config names, and computes there,
 * once, what every Db of the login reads: the snapshot, parsed (boundary/snapshot.ts parseSnapshot); each role's
 * artifacts (program/schema.ts schemaArtifacts), which compile every program a Db of the role runs; every program of
 * the login's workloads, compiled for every role it runs on (db/workload.ts compileRoleWorkload), after their access
 * paths are compared with the snapshot's (program/workload/compile.ts accessDrift): a schema that is not the
 * snapshot's, or a program the snapshot does not record as it is, fails the layer with WorkloadUngenerated naming it;
 * the login's own PostgreSQL role; and the login's one session pool. Every session
 * of the pool logs in as the login's role (connection/role.ts loginRole), which no Db outlives: each of a Db's
 * transactions enters the Db's own role by its prologue (wire/batch.ts runFramed), whose two statements are server
 * statements of the pool, named once per session. So one pool serves every role of the login. The pool lives as long
 * as the layer, in its scope, never on globalThis. A snapshot that does not parse, a role or program that does not
 * compile, or a login whose role name passes 63 bytes, fails the layer.
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
 * The contexts the role's relations read (schema/own.ts OwnedRole.contexts), their fields typed against the base: a
 * contract or roster a context names is the base's.
 */
const typedContexts = (
	artifacts: SchemaArtifacts
): Engine.Result<ReadonlyArray<TypedContext>, CompileError> => {
	const world = artifacts.world
	const contexts = world.kind === "role" ? Rec.values(world.role.contexts) : []
	const checked = artifacts.derived.schema
	return catchRefusal(() =>
		Arr.map(contexts, (context) =>
			typedContext(context, (field) =>
				checked.fieldType(field, SourceLoc(`context ${context.name}`, []))
			)
		)
	)
}

/** The layer's service, provided as DbLayer<R> for each role R of its login: what every Db of the login shares. */
export interface DbSessions {
	/** The login the layer was built for, and owned. */
	readonly login: LoginDesc
	readonly owned: OwnedLogin
	/** The snapshot the layer was given, parsed once: what every Db's admission compares the catalog with. */
	readonly snapshot: DeploySnapshot
	/** Each role of the login, in the login's order. */
	readonly roles: Arr.NonEmptyReadonlyArray<LayerRole>
	/** The one pool of the login's role. */
	readonly pool: SessionPool
	/** The prologue's two statements, server statements of the pool. */
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
): Effect.Effect<DbSessions, OpenError, DbLayerService<R>> =>
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
 * A DbConfig parsed: the login it names, its destination, credentials and verify-full TLS, the hook each pool is handed
 * when it is built, which attaches nothing when the config names none, and its token check.
 */
interface ParsedDbConfig extends ParsedConnection {
	readonly login: LoginDesc
	/** The login's role values, in its order. */
	readonly roles: ReadonlyArray<unknown>
	/** The login's workloads, as login(...) admitted them. */
	readonly workload: ReadonlyArray<AnyWorkload>
	/** The snapshot as the config gives it: the JSON value an import of snapshot.json yields, parsed by the layer. */
	readonly snapshot: object
	readonly attachPool: (pool: ConnectionPool) => void
	readonly token: TokenCheck
}

/** The pool hook of a config that names none. */
const attachNothing = (): void => undefined

const refusedConfig = (detail: string): OpenError =>
	new OpenError({ reason: new DbConfigRefused({ detail }) })

/**
 * The config's own settings, read once at the boundary as the connection's are (core/host.ts hostRead): the login
 * value, the pool hook and verify, each checked as a JavaScript caller may pass any value.
 */
const ownSettings = <L extends AnyLogin>(
	config: DbConfigShape<L>
): Result.Result<
	Pick<ParsedDbConfig, "login" | "roles" | "workload" | "snapshot" | "attachPool" | "token">,
	string
> =>
	readHost(
		"DbConfig must be an object whose settings read as data: no getter, setter or refusing proxy",
		() => {
			const login = loginDescOf(config.login)
			if (login === undefined) {
				return Result.fail("DbConfig.login must be a login built by login(...)")
			}
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
			const roles: ReadonlyArray<unknown> = Arr.map(Rec.values(config.login.roles), (r) => r.role)
			return Result.succeed({
				login,
				roles,
				workload: config.login.workload,
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
		Result.flatMap(parseConnection(config, "DbConfig", "login"), (parsed) =>
			Result.map(ownSettings(config), (own) => ({ ...parsed, ...own }))
		),
		refusedConfig
	)

const makeLoc = SourceLoc("DbLayer.make", [])

/**
 * One role of the login, parsed, its artifacts computed and the programs of the login's workloads over it compiled: a
 * role or program that does not compile fails the layer.
 */
const layerRole = Effect.fn("layerRole")(
	function* (
		value: unknown,
		workload: ReadonlyArray<AnyWorkload>
	): Effect.fn.Return<LayerRole, CompileError> {
		const input = yield* fromEngine(parseSchemaInput(value))
		if (input.kind !== "role" || typeof value !== "object" || value === null) {
			return yield* Effect.fail(malformedDescription(makeLoc, "a login's role built by role(...)"))
		}
		const artifacts = yield* fromEngine(
			schemaArtifacts(input, { installation: undefined, vectorSchema: undefined })
		)
		const theory = theoryRole(artifacts)
		const world = artifacts.world
		if (theory === undefined || world.kind !== "role") {
			return yield* Effect.fail(malformedDescription(makeLoc, "a login's role built by role(...)"))
		}
		const owned: OwnedRole = world.role
		const role: RoleContext = {
			schema: input,
			declared: input.desc.base.name,
			role: input.desc,
			artifacts,
			compile: (query, request) => templateFor(query, input, artifacts, request),
			witness: installationWitness(artifacts)
		}
		const contexts = yield* fromEngine(typedContexts(artifacts))
		const forms = yield* Effect.fromResult(compileRoleWorkload(role, owned, workload))
		return { ...role, value, theory, contexts, workload: forms }
	},
	Effect.mapError((reason) => new OpenError({ reason }))
)

/**
 * The snapshot the config gives, parsed once: one the test installer registered as registered
 * (admission/snapshots.ts), any other the JSON value an import of snapshot.json yields, read as the generator wrote it
 * and its fingerprint checked (boundary/snapshot.ts parseSnapshot), so a hand-edited file is refused.
 */
const layerSnapshot = (given: object): Effect.Effect<DeploySnapshot, OpenError> => {
	const registered = registeredSnapshot(given)
	return Option.isNone(registered)
		? Effect.mapError(
				Effect.fromResult(parseSnapshot(given)),
				(reason) => new OpenError({ reason })
			)
		: Effect.succeed(registered.value)
}

/**
 * The startup check: the snapshot is of the login's base, and records the access of every program of the login's
 * workloads exactly as they compile now (program/workload/compile.ts loginAccess, accessDrift), the comparison
 * `grizzle check` makes. A schema change, or a program added, renamed, dropped or whose access paths or statistics moved
 * since the snapshot was generated, is WorkloadUngenerated, naming the first such program.
 */
const startupCheck = Effect.fn("startupCheck")(function* (
	snapshot: DeploySnapshot,
	login: OwnedLogin,
	workload: ReadonlyArray<AnyWorkload>
): Effect.fn.Return<void, OpenError> {
	const ungenerated = (fault: WorkloadUngenerated["fault"]) =>
		new OpenError({ reason: new WorkloadUngenerated({ login: login.name, fault }) })
	if (!servesSchema(snapshot, login.base)) {
		return yield* ungenerated({ kind: "schema", schema: login.base.name })
	}
	const access = yield* Effect.mapError(
		fromEngine(
			Engine.flatMap(parseSchemaInput(login.base), (base) =>
				Engine.flatMap(
					schemaArtifacts(base, { installation: undefined, vectorSchema: undefined }),
					(artifacts) => loginAccess(workload, base, artifacts)
				)
			)
		),
		(reason) => new OpenError({ reason })
	)
	const [drift] = accessDrift(snapshot.workload, login.name, access)
	if (drift !== undefined) {
		return yield* ungenerated({ kind: "program", sentence: accessDriftText(login.name, drift) })
	}
})

/**
 * Builds the service in the current scope (the layer's) from a parsed config: the snapshot, parsed and checked against
 * the login's workloads, every role's artifacts and programs, the login's role, its pool and the prologue's server
 * statements (see the header).
 */
const makeDbSessions = Effect.fn("makeDbSessions")(function* (
	config: ParsedDbConfig
): Effect.fn.Return<DbSessions, OpenError, Scope.Scope> {
	const snapshot = yield* layerSnapshot(config.snapshot)
	const owned = yield* Effect.mapError(
		fromEngine(ownLogin(config.login)),
		(reason) => new OpenError({ reason })
	)
	yield* startupCheck(snapshot, owned, config.workload)
	const roles = yield* Effect.forEach(config.roles, (value) => layerRole(value, config.workload))
	if (!Arr.isArrayNonEmpty(roles)) {
		return yield* new OpenError({ reason: malformedDescription(makeLoc, "a login with a role") })
	}
	const [first] = roles
	const role = loginRole(first.artifacts, owned)
	if (Result.isFailure(role)) {
		return yield* new OpenError({ reason: role.failure })
	}
	const ledger = yield* Effect.mapError(
		fromEngine(ledgerStatements(first.artifacts.names.schema)),
		(reason) => new OpenError({ reason })
	)
	const pool = yield* makePool({
		connection: {
			host: config.host,
			port: config.port,
			database: config.database,
			role: role.success,
			password: config.password
		},
		transport: { _tag: "tls", tls: config.tls },
		pool: poolBounds,
		budgets: acquisitionBudgets,
		attachPool: config.attachPool
	})
	const prologue: PrologueStatements = {
		fence: serverStatement(ledger.fence.text),
		enter: serverStatement(ledger.enter.text)
	}
	return { login: config.login, owned, snapshot, roles, pool, prologue, token: config.token }
})

/**
 * The process environment the layer's sessions would start in, read where pg reads it, which sets no startup variable
 * that reaches a login's session (connection/environment.ts): one it sets is OpenError{stage: "config"}.
 */
const loginEnvironment: Effect.Effect<void, OpenError> = Effect.flatMap(
	Effect.sync(() => setStartupVariable(process.env, "login")),
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
			return Layer.effect(sessionsKey<DbLayerOf<L>>(parsed.login), makeDbSessions(parsed))
		})
	)
