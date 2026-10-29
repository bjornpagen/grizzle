import { Array as Arr, Effect, Option, Result } from "effect"
import { admit } from "#adapter/admission/admit.ts"
import { admissionExpectation } from "#adapter/admission/expectation.ts"
import { type Claims, claimsOf, noClaims, type TypedContext } from "#adapter/db/claims.ts"
import type { DbContext } from "#adapter/db/context.ts"
import { makeDb } from "#adapter/db/db.ts"
import { workloadHandles, workloadMissing } from "#adapter/db/workload.ts"
import { fromEngine } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import {
	ClaimRefused,
	MissingCapability,
	RoleOutsideLayers,
	TokenError
} from "#adapter/errors/failures.ts"
import { type DbSessions, dbSessions } from "#adapter/pool/registry.ts"
import type { DbConstructor, DbOf, OpenOptions, WorkloadHandles } from "#adapter/types/db.ts"
import type { DbLayerService, Verify } from "#adapter/types/layer.ts"
import { prologueOf } from "#adapter/wire/batch.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import { loginRoleOf } from "#compiler/schema/world.ts"
import type { AnyRole, LoginRole } from "#compiler/types/schema/world.ts"

const openLoc = SourceLoc("Db.open", [])

const refusedOption = (capability: string): OpenError =>
	OpenError.make({ reason: malformedDescription(openLoc, capability) })

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
		Effect.try({ try: () => verify(token), catch: (thrown) => TokenError.make({ cause: thrown }) })
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
		(reason) => OpenError.make({ reason })
	)
}

/** The token among a JavaScript caller's options: a string, or none. */
const givenToken = <R>(
	options: OpenOptions<R>
): Result.Result<Option.Option<string>, OpenError> => {
	const token: unknown = options.token
	if (token === undefined) {
		return Result.succeed(Option.none())
	}
	if (typeof token === "string") {
		return Result.succeed(Option.some(token))
	}
	return Result.fail(refusedOption("Db.open's token: a string, the token the layer's verify reads"))
}

/**
 * Db.open(Web.roles.member, { token? }).
 *
 * Opening acquires a database for a role reached through its login and admits it before it yields; it never installs
 * or changes a schema. In order:
 *
 * 1. The role. A value that is no role reached through its login (Web.roles.member) is OpenError{stage: "schema"}
 *    whose reason is the CompileError.
 * 2. The layer. The requirement DbLayer<R> names the role only as a type, so the layer of the role's login is resolved
 *    among the layers the context holds (pool/registry.ts dbSessions): a login whose layer is not provided is
 *    OpenError{stage: "role"}.
 * 3. The schema. The role's artifacts, the contexts its relations read and its workload programs, compiled, are the
 *    layer's, computed once when it was built (a role or program that does not compile fails the layer), as is the
 *    snapshot the layer was given.
 * 4. The token. A Db opened with a token turns it into claims once: the layer's verify runs on it, and the payload it
 *    returns is decoded through the contexts the role's relations read (claims.ts). A refusal is OpenError{stage:
 *    "token"} whose reason is verify's TokenError, or ClaimRefused for a payload that does not decode. A Db opened
 *    without one, or on a layer whose login reads no context, has no context facts.
 * 5. Admission (../admission), one flight on the login's pool: the server version, the database's encoding and builtin
 *    C.UTF-8 locale and the schema's extensions; the fence every transaction of the Db takes, the ledger's lock NOWAIT
 *    and the guard of the snapshot's fingerprint, refused while a migration runs and once the ledger holds another;
 *    and the database's and the login's role settings, the login's membership in the role, and the role's
 *    privileges and policies against the snapshot. The installed extensions are kept on the Db's context, for the
 *    capability check of each program it runs. The same flight asks each refined claim's domain whether it admits the
 *    claim, PostgreSQL being the one judge of a pattern or a contract's predicate: once admission passes, a claim it
 *    refused is OpenError{stage: "token"} whose reason is ClaimRefused naming the field. Every failure while opening is
 *    OpenError, a CredentialError its reason on a credential failure.
 *
 * Admission compares the ledger, the settings and the privileges with the snapshot the layer was given (DbConfig): no
 * snapshot is ever derived from the schema alone. The Db's workload handles (`db.workload`) are built here over the
 * programs the layer compiled for the role, each ChangeSet's for the contexts the Db's claims hold a fact of.
 *
 * The options are the caller's value, read once as data at the builder's boundary (query/build/host.ts
 * hostArguments): one whose reading throws, or that holds a getter or a setter, is refused at stage schema.
 */
export const openDb = Effect.fn("openDb")(function* <R extends AnyRole, P>(
	role: LoginRole<R, P>,
	options: OpenOptions<R>
): Effect.fn.Return<DbOf<R, P>, OpenError, DbLayerService<R>> {
	const reached = loginRoleOf(role)
	if (reached === undefined) {
		return yield* refusedOption("a role reached through its login: Db.open(Web.roles.member, ...)")
	}
	const sessions = yield* dbSessions<R>(reached.login, reached.role.name)
	/** The role as the layer holds it, parsed with its artifacts, contexts and programs when the layer was built. */
	const held = Arr.findFirst(sessions.roles, (r) => r.value === reached.role)
	if (Option.isNone(held)) {
		return yield* OpenError.make({
			reason: RoleOutsideLayers.make({ role: reached.role.name, login: sessions.login.name })
		})
	}
	const { schema, declared, artifacts, compile, theory, contexts, witness, workload } = held.value
	const desc = schema.desc
	yield* Effect.mapError(
		fromEngine(
			catchCompileError(() => {
				hostArguments("Db.open", options)
			})
		),
		(reason) => OpenError.make({ reason })
	)
	const token = yield* Effect.fromResult(givenToken(options))
	const snapshot = sessions.snapshot
	const claims = yield* dbClaims(sessions, contexts, token)
	const pool = sessions.pool
	const admitted = yield* admit(pool, admissionExpectation(artifacts), {
		artifacts,
		login: sessions.owned,
		role: desc,
		snapshot,
		claims: claims.values
	})
	/**
	 * A refined claim PostgreSQL found no value of its field's domain is refused as the token's, after admission.
	 */
	const [refusedClaim] = admitted.refusedClaims
	if (refusedClaim !== undefined) {
		return yield* OpenError.make({
			reason: ClaimRefused.make({
				context: refusedClaim.context,
				fault: { kind: "refused", field: refusedClaim.field }
			})
		})
	}
	const ctx: DbContext = {
		schema,
		declared,
		role: desc,
		prologue: prologueOf(sessions.prologue, theory, claims.text, snapshot.fingerprint),
		claims: claims.present,
		artifacts,
		compile,
		witness,
		pool,
		installedExtensions: admitted.extensions
	}
	const missing = workloadMissing(workload, admitted.extensions)
	if (Option.isSome(missing)) {
		return yield* OpenError.make({
			reason: MissingCapability.make({ capability: missing.value })
		})
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
	return makeDb<R, P>(ctx, handles)
})

/** Db.open. The role is reached through its login, whose layer provides the Effect. */
export const DbValue: DbConstructor = {
	open: (role, options) => openDb(role, options)
}
