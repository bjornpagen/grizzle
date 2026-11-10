import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Rec from "effect/Record"
import * as Result from "effect/Result"
import { compileFailure } from "#adapter/apply/run.ts"
import { type Claims, claimsOf, noClaims, type TypedContext } from "#adapter/db/claims.ts"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { servedHandles } from "#adapter/db/handles.ts"
import { readHost } from "#adapter/engine.ts"
import { OpenError, ReadFailure } from "#adapter/errors/execution.ts"
import { TokenError } from "#adapter/errors/failures.ts"
import { type ServedSessions, servedSessions } from "#adapter/pool/served.ts"
import type { DbConstructor, DbOf, OpenOptions, WorkloadHandles } from "#adapter/types/db.ts"
import type { DbLayerService, ServedRole, Verify } from "#adapter/types/layer.ts"
import { prologueOf } from "#adapter/wire/batch.ts"
import type { AnyRole, CompileError } from "#compiler/plan/common.ts"
import {
	SourceLoc,
	defect,
	malformedDescription,
	noOpaque,
	readsAsData
} from "#compiler/plan/runtime.ts"

const openLoc = SourceLoc("Db.open", [])

const refusedOption = (capability: string): OpenError =>
	new OpenError({ reason: malformedDescription(openLoc, capability) })

/**
 * The one site of the fact that the record of handles Db.open builds (workload.ts workloadHandles), one under the name
 * of each program the layer loaded for the role, is WorkloadHandles<R, P>, a mapped type over P, the programs the
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

/** Whether a value holds the kind and the three names a layer is found by, which served(...)'s tokens alone hold. */
const holdsTokenParts = (value: unknown): boolean =>
	typeof value === "object" &&
	value !== null &&
	"kind" in value &&
	value.kind === "servedRole" &&
	"base" in value &&
	typeof value.base === "string" &&
	"login" in value &&
	typeof value.login === "string" &&
	"role" in value &&
	typeof value.role === "string"

/**
 * Whether a value is a served role token, as a JavaScript caller may pass any value: served(...)'s tokens alone hold
 * the kind and the three names a layer is found by. The value is read at the boundary (engine.ts readHost), so a value
 * whose reading runs the caller's code and throws (a proxy's trap, a getter) is no token, and Db.open refuses it as it
 * refuses any other, never escaping as a defect.
 */
export const isServedRole = (value: unknown): value is ServedRole<unknown, unknown> =>
	Result.getOrElse(
		readHost(false, () => Result.succeed(holdsTokenParts(value))),
		() => false
	)

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
	sessions: ServedSessions,
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

/**
 * Whether a value is an object that is no list: every property of one reads as some value, which unknown describes,
 * so this claims no more than it checks.
 */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

/**
 * Db.open's options as a JavaScript caller passes them, read once at the boundary: the token they give, a string, or
 * none. The options are an object whose properties read as data (core/host.ts readsAsData), and the token
 * is their own property; no options, null, a list, a value that is no object, one whose reading throws or that holds
 * a getter or a setter, and a token that is no string are each refused at stage schema. The types require the options
 * and type the token, so only a JavaScript caller meets a refusal here.
 */
export const openToken = (options: unknown): Result.Result<Option.Option<string>, OpenError> => {
	if (!isRecord(options)) {
		return Result.fail(refusedOption("Db.open's options: an object, { token } or {}"))
	}
	if (!readsAsData([options], noOpaque)) {
		return Result.fail(
			refusedOption(
				"an argument whose properties can be read as data: no getter, setter or refusing proxy"
			)
		)
	}
	const token: unknown = Rec.has(options, "token") ? options["token"] : undefined
	if (token === undefined) {
		return Result.succeed(Option.none())
	}
	if (typeof token === "string") {
		return Result.succeed(Option.some(token))
	}
	return Result.fail(refusedOption("Db.open's token: a string, the token the layer's verify reads"))
}

/** An opened served Db and the one context every operation of it reads (context.ts). */
interface OpenedServed<R, P> {
	readonly db: DbOf<R, P>
	readonly ctx: ServedDbContext
}

/**
 * The refusal of a program outside the login's served workload: a served Db runs its workload's programs alone, which
 * `grizzle generate` compiled, and compiles none at the call.
 */
const outsideWorkload = (): CompileError =>
	malformedDescription(
		SourceLoc("db", []),
		"a program of the login's workloads, through db.workload: a served Db compiles no program at the call"
	)

/**
 * A served Db: its workload handles, and every other operation refused before any SQL (outsideWorkload), since no
 * program outside the login's served workload runs.
 */
const servedDb = <R, P>(workload: WorkloadHandles<R, P>): DbOf<R, P> => {
	const unread = () => Effect.fail(new ReadFailure({ reason: outsideWorkload() }))
	const unapplied = () => compileFailure(outsideWorkload())
	return {
		workload,
		get: unread,
		execute: unread,
		page: unread,
		compile: () => Effect.fail(outsideWorkload()),
		apply: unapplied,
		refresh: unapplied,
		explain: unread
	}
}

/**
 * Db.open(Web.roles.member, { token? }), and the context the Db reads.
 *
 * Opening builds a database handle for a role reached through its served login, on the host alone: it contacts
 * nothing and checks nothing of the database, which is the one its snapshot was migrated to (grizzle migrate and grizzle
 * drift judge it), so a request's first call is its first round trip. Every transaction of the Db still takes the fence
 * first, the ledger's lock and the snapshot guard with the served file's fingerprint, and fails with StaleSnapshot at a
 * database another snapshot leads or a migration holds. It never installs or changes a schema. In order:
 *
 * 1. The role and the options. A value that is no role token of a served login (Web.roles.member) is
 *    OpenError{stage: "schema"} whose reason is the CompileError, and so are options a JavaScript caller passes that are
 *    no object read as data, or whose token is no string (openToken).
 * 2. The layer. The requirement DbLayer<R> names the role only as a type, so the layer of the token's login is resolved
 *    among the layers the context holds (pool/registry.ts dbSessions): a login whose layer is not provided, or whose
 *    served file holds no role of the token's name, is OpenError{stage: "role"}.
 * 3. The token. A Db opened with a token turns it into claims once: the layer's verify runs on it, and the payload it
 *    returns is decoded through the contexts the role's relations read (claims.ts). A refusal is OpenError{stage:
 *    "token"} whose reason is verify's TokenError, or ClaimRefused for a payload that does not decode. A Db opened
 *    without one, or on a layer whose login reads no context, has no context facts. PostgreSQL judges a claim of a
 *    refined field where a statement reads it, by its field's domain.
 *
 * The Db's workload handles (`db.workload`) are built here over the programs the layer loaded for the role, each
 * ChangeSet's for the contexts the Db's claims hold a fact of.
 */
export const openServed = Effect.fn("openServed")(function* <R extends AnyRole, P>(
	role: ServedRole<R, P>,
	options: OpenOptions<R>
): Effect.fn.Return<OpenedServed<R, P>, OpenError, DbLayerService<R>> {
	const reached: unknown = role
	if (!isServedRole(reached)) {
		return yield* refusedOption(
			"a role reached through its served login: Db.open(Web.roles.member, ...)"
		)
	}
	const token = yield* Effect.fromResult(openToken(options))
	const { sessions, role: held } = yield* servedSessions(role)
	const claims = yield* dbClaims(sessions, held.contexts, token)
	const login = sessions.login
	const ctx: ServedDbContext = {
		prologue: prologueOf(login.prologue, held.installed, claims.text, login.fingerprint),
		claims: claims.present,
		pool: sessions.pool
	}
	const handles: object = servedHandles(ctx, held.members)
	if (
		!isWorkloadOf<R, P>(
			handles,
			Arr.map(held.members, (m) => m.name)
		)
	) {
		return yield* Effect.die(
			defect(`the workload handles of role ${held.name}: one per program of its layer`)
		)
	}
	return { db: servedDb<R, P>(handles), ctx }
})

/** Db.open: the Db openServed opens. The role is reached through its served login, whose layer provides the Effect. */
export const DbValue: DbConstructor = {
	open: (role, options) => Effect.map(openServed(role, options), (opened) => opened.db)
}
