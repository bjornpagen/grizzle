import { Array as Arr, Effect, Option } from "effect"
import { type Claims, claimsOf, noClaims, type TypedContext } from "#adapter/db/claims.ts"
import type { DbContext } from "#adapter/db/context.ts"
import { makeDb } from "#adapter/db/db.ts"
import { openToken } from "#adapter/db/served.ts"
import { workloadHandles } from "#adapter/db/workload.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { RoleOutsideLayers, TokenError } from "#adapter/errors/failures.ts"
import { type DbSessions, dbSessions } from "#adapter/pool/registry.ts"
import type { DbOf, OpenOptions, WorkloadHandles } from "#adapter/types/db.ts"
import type { DbLayerService, Verify } from "#adapter/types/layer.ts"
import { prologueOf } from "#adapter/wire/batch.ts"
import {
	type AnyRole,
	defect,
	type LoginRole,
	loginRoleOf,
	malformedDescription,
	SourceLoc
} from "#compiler/plan/common.ts"

const openLoc = SourceLoc("Db.open", [])

const refusedOption = (capability: string): OpenError =>
	new OpenError({ reason: malformedDescription(openLoc, capability) })

/**
 * The one site of the fact that the record of handles Db.open builds (workload.ts workloadHandles), one under the name
 * of each program the layer compiled for the role, is WorkloadHandles<R, P>, a mapped type over P, the programs the
 * login's type gives R. P has no runtime value, and a record built key by key is beyond what TypeScript checks against
 * a mapped type (packages/engine/src/schema/record.ts states the same of the engine's records), so the type is this
 * predicate's statement. Its check is the part of that statement a runtime can read, at the boundary that builds the
 * record: the record's own keys are exactly the programs' names. Each handle's records are its own program's decoder's.
 */
const isWorkloadOf = <R, P>(
	handles: object,
	names: ReadonlyArray<string>
): handles is object & WorkloadHandles<R, P> =>
	Reflect.ownKeys(handles).length === names.length &&
	Arr.every(names, (name) => Reflect.has(handles, name))

/**
 * The layer's verify of a token, called at the boundary: a verify that throws instead of returning its Effect has not
 * verified the token, so its throw refuses the token like a verify that fails (a TokenError whose cause is what it
 * threw), as every read of a JavaScript caller's value that throws refuses it. An Effect it returns keeps its own
 * semantics.
 */
const verified = (verify: Verify, token: string): Effect.Effect<unknown, TokenError> =>
	Effect.flatten(
		Effect.try({ try: () => verify(token), catch: (thrown) => new TokenError({ cause: thrown }) })
	)

/**
 * The claims of a Db (claims.ts): none without a token, or on a layer whose login reads no context; else the payload
 * the layer's verify returns for the token, decoded through the role's contexts.
 */
const dbClaims = (
	sessions: DbSessions,
	contexts: ReadonlyArray<TypedContext>,
	token: Option.Option<string>
): Effect.Effect<Claims, OpenError> => {
	const check = sessions.token
	if (Option.isNone(token) || check.kind === "none") {
		return Effect.succeed(noClaims)
	}
	return Effect.mapError(
		Effect.flatMap(verified(check.verify, token.value), (payload) =>
			Effect.fromResult(claimsOf(contexts, payload))
		),
		(reason) => new OpenError({ reason })
	)
}

/** An opened Db and the one context every operation of it reads (context.ts). */
export interface OpenedDb<R, P> {
	readonly db: DbOf<R, P>
	readonly ctx: DbContext
}

/**
 * Db.open(Web.roles.member, { token? }), and the context the Db reads.
 *
 * Opening builds a database handle for a role reached through its login, on the host alone: it contacts nothing and
 * checks nothing of the database, which is the one its snapshot was migrated to (grizzle migrate and grizzle drift judge
 * it), so a request's first call is its first round trip. Every transaction of the Db still takes the fence first, the
 * ledger's lock and the snapshot guard, and fails with StaleSnapshot at a database another snapshot leads or a
 * migration holds. It never installs or changes a schema. In order:
 *
 * 1. The role and the options. A value that is no role reached through its login (Web.roles.member) is
 *    OpenError{stage: "schema"} whose reason is the CompileError, and so are options a JavaScript caller passes that are
 *    no object read as data, or whose token is no string (openToken).
 * 2. The layer. The requirement DbLayer<R> names the role only as a type, so the layer of the role's login is resolved
 *    among the layers the context holds (pool/registry.ts dbSessions): a login whose layer is not provided is
 *    OpenError{stage: "role"}.
 * 3. The schema. The role's artifacts, the contexts its relations read and its workload programs, compiled, are the
 *    layer's, computed once when it was built (a role or program that does not compile fails the layer), as is the
 *    snapshot the layer was given.
 * 4. The token. A Db opened with a token turns it into claims once: the layer's verify runs on it, and the payload it
 *    returns is decoded through the contexts the role's relations read (claims.ts). A refusal is OpenError{stage:
 *    "token"} whose reason is verify's TokenError, or ClaimRefused for a payload that does not decode. A Db opened
 *    without one, or on a layer whose login reads no context, has no context facts. PostgreSQL judges a claim of a
 *    refined field where a statement reads it, by its field's domain.
 *
 * A statement that names an extension's type the database does not install, or in a schema the role holds no USAGE
 * on, is PostgreSQL's to refuse at the call, with its ServerError.
 *
 * The Db's workload handles (`db.workload`) are built here over the programs the layer compiled for the role, each
 * ChangeSet's for the contexts the Db's claims hold a fact of.
 */
export const openDbContext = Effect.fn("openDb")(function* <R extends AnyRole, P>(
	role: LoginRole<R, P>,
	options: OpenOptions<R>
): Effect.fn.Return<OpenedDb<R, P>, OpenError, DbLayerService<R>> {
	const reached = loginRoleOf(role)
	if (reached === undefined) {
		return yield* refusedOption("a role reached through its login: Db.open(Web.roles.member, ...)")
	}
	const token = yield* Effect.fromResult(openToken(options))
	const sessions = yield* dbSessions<R>(reached.login, reached.role.name)
	/** The role as the layer holds it, parsed with its artifacts, contexts and programs when the layer was built. */
	const held = Arr.findFirst(sessions.roles, (r) => r.value === reached.role)
	if (Option.isNone(held)) {
		return yield* new OpenError({
			reason: new RoleOutsideLayers({ role: reached.role.name, login: sessions.login.name })
		})
	}
	const {
		schema,
		declared,
		artifacts,
		compile,
		theory,
		contexts,
		programArtifacts,
		bind,
		workload
	} = held.value
	const desc = schema.desc
	const snapshot = sessions.snapshot
	const claims = yield* dbClaims(sessions, contexts, token)
	const ctx: DbContext = {
		schema,
		declared,
		role: desc,
		prologue: prologueOf(sessions.prologue, theory, claims.text, snapshot.fingerprint),
		claims: claims.present,
		artifacts,
		compile,
		programArtifacts,
		bind,
		pool: sessions.pool,
		isolation: "serializable"
	}
	const handles: object = workloadHandles(ctx, workload)
	if (
		!isWorkloadOf<R, P>(
			handles,
			Arr.map(workload, (w) => w.name)
		)
	) {
		return yield* Effect.die(
			defect(`the workload handles of role ${desc.name}: one per program of its layer`)
		)
	}
	return { db: makeDb<R, P>(ctx, handles), ctx }
})

/**
 * Db.open over a layer compiled in-process (pool/registry.ts compiledDbLayer), from a role reached through its login
 * value: the tests' until they move onto served layers, which the deletion commit removes with it.
 */
export const compiledOpen = <R extends AnyRole, P>(
	role: LoginRole<R, P>,
	options: OpenOptions<R>
): Effect.Effect<DbOf<R, P>, OpenError, DbLayerService<R>> =>
	Effect.map(openDbContext(role, options), (opened) => opened.db)
