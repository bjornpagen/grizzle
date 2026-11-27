import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Rec from "effect/Record"
import * as Result from "effect/Result"
import {
	attestedFacts,
	type Claims,
	claimsOf,
	noExpiry,
	noFacts,
	type TypedContext,
	tokenFacts
} from "#adapter/db/claims.ts"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { servedHandles } from "#adapter/db/handles.ts"
import { parseToken, type Token } from "#adapter/db/token.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { TokenRefused, type VerifierUnavailable } from "#adapter/errors/failures.ts"
import {
	type HeldRole,
	readServedRole,
	type ServedSessions,
	servedSessions
} from "#adapter/pool/served.ts"
import type { DbConstructor, DbOf, OpenOptions, WorkloadHandles } from "#adapter/types/db.ts"
import type { DbLayerService, ServedRole, Verify } from "#adapter/types/layer.ts"
import { prologueOf } from "#adapter/wire/batch.ts"
import type { AnyRole } from "#compiler/plan/common.ts"
import { SourceLoc, defect, malformedDescription, readCaller } from "#compiler/plan/runtime.ts"

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

/**
 * The layer's verify of a token, called at the boundary: a verify that throws instead of returning its Effect has not
 * verified the token, so its throw refuses the token like a verify that refuses it (a TokenRefused whose cause is what
 * it threw), as every read of a JavaScript caller's value that throws refuses it. An Effect it returns keeps its own
 * semantics: TokenRefused where its verifier refused the token, VerifierUnavailable where none could judge it now.
 */
const verified = (
	verify: Verify,
	token: Token
): Effect.Effect<unknown, TokenRefused | VerifierUnavailable> =>
	Effect.flatten(
		Effect.try({ try: () => verify(token), catch: (thrown) => new TokenRefused({ cause: thrown }) })
	)

/**
 * The claims of a Db (claims.ts): its token's contexts' facts, none without a token or on a layer whose login reads no
 * token's context, else those of the payload the layer's verify returns for the token; and its attested contexts'
 * facts, those the server attests (`attested`), decoded first, on the host, so a refused attestation calls no verify.
 */
const dbClaims = (
	sessions: ServedSessions,
	contexts: ReadonlyArray<TypedContext>,
	opening: Opening
): Effect.Effect<Claims, OpenError> =>
	Effect.mapError(
		Effect.flatMap(Effect.fromResult(attestedFacts(contexts, opening.attested)), (attested) => {
			const check = sessions.token
			if (Option.isNone(opening.token) || check.kind === "none") {
				return Effect.succeed(claimsOf(noFacts, attested, noExpiry))
			}
			return Effect.flatMap(verified(check.verify, opening.token.value), (payload) =>
				Effect.fromResult(
					Result.map(tokenFacts(contexts, payload), ({ facts, expiry }) =>
						claimsOf(facts, attested, expiry)
					)
				)
			)
		}),
		(reason) => new OpenError({ reason })
	)

/**
 * What a Db opens with beside its role: the token it gives, parsed as every door parses one (db/token.ts parseToken),
 * or none; and the facts its server attests, a record by context name (claims.ts attestedFacts), or none.
 */
export interface Opening {
	readonly token: Option.Option<Token>
	readonly attested: Option.Option<Readonly<Record<string, unknown>>>
}

/** No key of Db.open's options is left unread: every own property is copied. */
const optionKeys: ReadonlySet<string> = new Set()

/** The keys Db.open's options hold: its token and its attested facts. */
const openKeys: ReadonlySet<string> = new Set(["token", "attested"])

/**
 * Db.open's options as a JavaScript caller passes them, read once at the boundary (core/host.ts readCaller): the token
 * they give, parsed as every door parses one (db/token.ts parseToken), or none; and the facts its server attests, a
 * record, or none. The options are an object that is no list, every own property of which, at any depth, reads as
 * data, holding no key but `token` and `attested`, each their own property, read off the copy; no options, null, a
 * list, a value that is no object, one whose reading throws or that holds a getter or a setter, another key, a token
 * that is no string and attested facts that are no record are each refused at stage schema, and a string that is no
 * token68 at stage token (TokenMalformed), before any verify runs, as an HTTP call's is.
 */
export const openOptions = (options: unknown): Result.Result<Opening, OpenError> => {
	if (!Predicate.isObject(options)) {
		return Result.fail(refusedOption("Db.open's options: an object, { token?, attested? }"))
	}
	const read = readCaller(options, optionKeys)
	if (!read.ok) {
		return Result.fail(
			refusedOption(
				"an argument whose properties can be read as data: no getter, setter or refusing proxy"
			)
		)
	}
	const copy = read.value.data
	if (Arr.some(Rec.keys(copy), (key) => !openKeys.has(key))) {
		return Result.fail(
			refusedOption("Db.open's options: their token and attested facts, nothing else")
		)
	}
	const attested: unknown = Rec.has(copy, "attested") ? copy["attested"] : undefined
	if (attested !== undefined && !Predicate.isObject(attested)) {
		return Result.fail(
			refusedOption(
				"Db.open's attested facts: a record of each attested context's fact, by its name"
			)
		)
	}
	const facts = attested === undefined ? Option.none() : Option.some(attested)
	const token: unknown = Rec.has(copy, "token") ? copy["token"] : undefined
	if (token === undefined) {
		return Result.succeed({ token: Option.none(), attested: facts })
	}
	if (typeof token === "string") {
		return Result.mapBoth(parseToken(token), {
			onFailure: (reason) => new OpenError({ reason }),
			onSuccess: (parsed) => ({ token: Option.some(parsed), attested: facts })
		})
	}
	return Result.fail(refusedOption("Db.open's token: a string, the token the layer's verify reads"))
}

/**
 * An opened served Db, the one context every operation of it reads (context.ts), and its login's layer and the role as
 * it loaded, which the open found at the address it read off the token once.
 */
export interface OpenedServed<R, P> extends HeldRole {
	readonly db: DbOf<R, P>
	readonly ctx: ServedDbContext
}

/**
 * The context every operation of a Db of the held role reads, opened with `token` (step 3 of openServed): the claims the
 * layer's verify and the role's contexts give the token (dbClaims), and the prologue each of its transactions begins
 * with. Db.open and the HTTP handler both open through it, so a token means one thing to either.
 */
export const servedContext = (
	held: HeldRole,
	opening: Opening
): Effect.Effect<ServedDbContext, OpenError> =>
	Effect.map(dbClaims(held.sessions, held.role.contexts, opening), (claims) => {
		const login = held.sessions.login
		return {
			prologue: prologueOf(login.prologue, held.role.installed, claims.text, login.fingerprint),
			claims: claims.present,
			expiry: claims.expiry,
			subscriptions: held.sessions.subscriptions,
			pool: held.sessions.pool,
			isolation: held.role.isolation,
			domain: held.role.domain
		}
	})

/**
 * Db.open(Web.roles.member, { token? }), and the context the Db reads.
 *
 * Opening builds a database handle for a role reached through its served login, on the host alone: it contacts
 * nothing and checks nothing of the database, which is the one its snapshot was migrated to (grizzle migrate and grizzle
 * drift judge it), so a request's first call is its first round trip. Every transaction of the Db still takes the fence
 * first, the ledger's lock and the snapshot guard with the served file's fingerprint, and fails with StaleSnapshot at a
 * database another snapshot leads or a migration holds. It never installs or changes a schema. In order:
 *
 * 1. The role and the options, each read once at the boundary into a copy every later step reads (pool/served.ts
 *    readServedRole, openToken). A value that is no role token of a served login (Web.roles.member) is
 *    OpenError{stage: "schema"} whose reason is the CompileError, and so are options a JavaScript caller passes that are
 *    no object read as data, or whose token is no string; a token that is no token68 is OpenError{stage: "token"}
 *    whose reason is TokenMalformed (db/token.ts parseToken, the one reading of a token, an HTTP call's too).
 * 2. The layer. The requirement DbLayer<R> names the role only as a type, so the layer of the token's login is resolved
 *    among the layers the context holds, at the address read off the token (pool/served.ts servedSessions): a login
 *    whose layer is not provided, or whose served file holds no role of the token's name, is OpenError{stage: "role"}.
 * 3. The token. A Db opened with a token turns it into claims once: the layer's verify runs on it, and the payload it
 *    returns is decoded through the contexts the role declares (claims.ts). A refusal is OpenError{stage:
 *    "token"} whose reason is verify's TokenRefused, VerifierUnavailable (its retry `safe`), or ClaimRefused for a
 *    payload that does not decode. A Db opened
 *    without one, or on a layer whose login reads no context, has no context facts. PostgreSQL judges a claim of a
 *    refined field where a statement reads it, by its field's domain.
 *
 * The Db's workload handles (`db.workload`) are built here over the programs the layer loaded for the role, each
 * ChangeSet's for the contexts the Db's claims hold a fact of, each explain naming its plans by the login's installed
 * tables.
 */
export const openServed = Effect.fn("openServed")(function* <R extends AnyRole, P>(
	role: ServedRole<R, P>,
	options: OpenOptions<R>
): Effect.fn.Return<OpenedServed<R, P>, OpenError, DbLayerService<R>> {
	return yield* openedWith<R, P>(role, options, (ctx, held) =>
		servedHandles(ctx, held.role.members, held.sessions.login.tables)
	)
})

/**
 * A Db of `role` opened with `options` as openServed opens one (steps 1 to 3), its workload handles the record
 * `handlesFor` builds over its context and its held role: a served Db's (servedHandles), or a Db's over a moved clock
 * (db/moved.ts).
 */
export const openedWith = <R extends AnyRole, P>(
	role: ServedRole<R, P>,
	options: OpenOptions<R>,
	handlesFor: (ctx: ServedDbContext, held: HeldRole) => object
): Effect.Effect<OpenedServed<R, P>, OpenError, DbLayerService<R>> =>
	Effect.gen(function* () {
		const reached: unknown = role
		const address = yield* Effect.fromResult(readServedRole<R>(reached))
		const opening = yield* Effect.fromResult(openOptions(options))
		const held = yield* servedSessions(address)
		const ctx = yield* servedContext(held, opening)
		const handles = handlesFor(ctx, held)
		if (
			!isWorkloadOf<R, P>(
				handles,
				Arr.map(held.role.members, (m) => m.name)
			)
		) {
			return yield* Effect.sync(() =>
				defect(`the workload handles of role ${held.role.name}: one per program of its layer`)
			)
		}
		return { db: { workload: handles }, ctx, ...held }
	})

/** Db.open: the Db openServed opens. The role is reached through its served login, whose layer provides the Effect. */
export const openDb: DbConstructor["open"] = (role, options) =>
	Effect.map(openServed(role, options), (opened) => opened.db)
