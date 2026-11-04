/**
 * DbLayer: the connection's destination, credentials, verify-full TLS and login, and nothing else, and the one service
 * Db.open requires, keyed by the role: the layer of a login serves each of its roles and no other. verify is required
 * exactly when a role of the login reads a context, and Db.open's token exactly when the opened role does. Every
 * `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 *
 * A program provided with a layer runs at a consumer's entry point, NodeRuntime.runMain, which takes only an Effect that
 * needs no service: each runMain here compiles only if the layer leaves its program needing nothing.
 *
 * A config refused through an Effect's error or service channel is refused by Takes, never at a refused call: there the
 * Effect language service restates the checker's error beside it (missingEffectError, missingEffectContext), so the
 * line would raise two diagnostics.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect, type Layer, Redacted } from "effect"
import {
	type AnyLoginRole,
	ChangeSet,
	type CredentialError,
	context,
	Db,
	type DbConfig,
	DbLayer,
	login,
	type OpenError,
	query,
	role,
	str,
	TokenError,
	uuid,
	v
} from "#index.ts"

import {
	Account,
	type Refresher,
	type Reporter,
	ReportsLogin,
	Task,
	Work,
	WorkLogin,
	type WorkReader,
	type WorkWriter
} from "#test/types/api/fixtures/schema.ts"
import type { Equals, Expect } from "#test/types/api/support.ts"

/** The committed snapshot.json every layer here is given. */
declare const snapshot: { readonly fingerprint: string }
const destination = {
	host: "localhost",
	port: 5433,
	database: "work",
	tls: { ca: "PEM" },
	snapshot
} as const

/** Whether DbLayer.make takes the config C for the login L: whether C is assignable to its parameter, DbConfig<L>. */
type Takes<L, C> = [C] extends [DbConfig<L>] ? true : false

/** The layer of a login provides the layer of each of its roles. */
export const workLayer = DbLayer.make({
	...destination,
	login: WorkLogin,
	password: Redacted.make("secret")
})

/** A config no connection can use fails the layer as OpenError{stage: "config"}. */
export type WorkLayer = Expect<
	Equals<
		typeof workLayer,
		Layer.Layer<DbLayer<typeof WorkReader> | DbLayer<typeof WorkWriter>, OpenError>
	>
>
/** A rotating credential is an Effect that fails only with CredentialError and needs no service. */
declare const rotating: Effect.Effect<Redacted.Redacted, CredentialError>
export const rotatingLayer = DbLayer.make({ ...destination, login: WorkLogin, password: rotating })
/** A tunnel verifies the server's own name. */
export const tunnel = DbLayer.make({
	...destination,
	login: WorkLogin,
	password: rotating,
	tls: { ca: ["PEM", "PEM"], servername: "db.example.com" }
})

/**
 * Db.open of a role reached through its login requires exactly the layer of its role; its login's layer satisfies it,
 * another login's does not.
 */
const opened = Db.open(WorkLogin.roles.writer, {})
export type OpenedNeeds = Expect<Equals<Effect.Services<typeof opened>, DbLayer<typeof WorkWriter>>>
export type OpenedFails = Expect<Equals<Effect.Error<typeof opened>, OpenError>>
NodeRuntime.runMain(Effect.provide(opened, workLayer))
const reportsLayer = DbLayer.make({
	...destination,
	login: ReportsLogin,
	password: Redacted.make("secret")
})

export type ReportsLayer = Expect<
	Equals<
		typeof reportsLayer,
		Layer.Layer<DbLayer<typeof Reporter> | DbLayer<typeof Refresher>, OpenError>
	>
>

/**
 * The reports login's layer provides no writer of Work, so the opened program still needs the writer's layer, and no
 * runMain takes it. Effect.provide types what a provided program needs as the layer's own inputs, none here
 * (ReportsLayer), and the program's services the layer does not output.
 */
export type MisprovidedStillNeedsWriter = Expect<
	Equals<
		Exclude<Effect.Services<typeof opened>, Layer.Success<typeof reportsLayer>>,
		DbLayer<typeof WorkWriter>
	>
>
/** A role whose relations read a context: its login's layer needs verify, and opening it needs a token. */
const Session = context("Session", { sub: str.regex("^[a-z]{1,32}$") })
const mine = query(Work).rule((r) => {
	const { id, name } = v(Account, "account")
	return r.match(Account, { id, name }).match(Session, { sub: name }).find({ id })
})
const Mine = role(Work, "mine", { Account, Mine: mine })
const Web = login(Work, "web", [Mine])
const verify = (token: string) => Effect.fail(TokenError.make({ cause: token }))
export const webLayer = DbLayer.make({
	...destination,
	login: Web,
	password: Redacted.make("secret"),
	verify
})

// @ts-expect-error -- TS2345: a role of the web login reads a context, so its layer needs verify
export const webUnverified = DbLayer.make({
	...destination,
	login: Web,
	password: Redacted.make("secret")
})
/** verify is a function from the token to the payload, failing only with TokenError. */
const verified = { ...destination, login: Web, password: rotating, verify } as const
export type WebVerified = Expect<Takes<typeof Web, typeof verified>>
const misverified = {
	...destination,
	login: Web,
	password: rotating,
	verify: () => Effect.fail(1)
} as const
// @ts-expect-error -- TS2344: verify fails with TokenError, never another error
export type WebMisverified = Expect<Takes<typeof Web, typeof misverified>>
/** A login none of whose roles reads a context takes verify too, and needs none. */
export const workVerified = DbLayer.make({
	...destination,
	login: WorkLogin,
	password: rotating,
	verify
})
export const mineOpened = Db.open(Web.roles.mine, { token: "a token" })
export type MineOpenedNeeds = Expect<
	Equals<Effect.Services<typeof mineOpened>, DbLayer<typeof Mine>>
>
// @ts-expect-error -- TS2741: Mine reads a context, so Db.open needs a token
export const mineWithoutToken = Db.open(Web.roles.mine, {})
/** A role that reads no context opens with or without a token. */
export const writerWithToken = Db.open(WorkLogin.roles.writer, { token: "a token" })
/**
 * A program on a Db matches only the contexts its role's relations read, whose facts the Db's claims hold: Mine's Db
 * holds Session's fact, the writer's holds none.
 */
declare const mineDb: Db<typeof Mine, unknown>
declare const writerDb: Db<typeof WorkWriter, unknown>
const myAccounts = query(Mine).rule((r) => {
	const { id, name } = v(Mine.relations.Account, "account")
	return r.match(Mine.relations.Account, { id, name }).match(Session, { sub: name }).find({ id })
})
export const mineReads = mineDb.execute(myAccounts, {})
const sessionAccounts = query(Work).rule((r) => {
	const { id, name } = v(Account, "account")
	return r.match(Account, { id, name }).match(Session, { sub: name }).find({ id })
})
// @ts-expect-error -- TS2345 refusal: a program on a Db of a role matches only the contexts the role's relations read, whose facts its claims hold
export const writerReads = writerDb.execute(sessionAccounts, {})
// @ts-expect-error -- TS2345 refusal: a program on a Db of a role matches only the contexts the role's relations read, whose facts its claims hold
export const writerCompiles = writerDb.compile(sessionAccounts)
const sessionAudit = ChangeSet.empty(Work).read("mine", () => sessionAccounts)
// @ts-expect-error -- TS2345 refusal: a program on a Db of a role matches only the contexts the role's relations read, whose facts its claims hold
export const writerApplies = writerDb.apply(sessionAudit, {})

/**
 * A context read anywhere in an entry's definition is read by the role, a nested claim object's as much as the
 * payload's own: under a negation, in a disjunction, in an interior stage, and through a query the entry matches.
 */
const Org = context("Org", { id: uuid }, { claim: "o" })
const Negated = role(Work, "negated", {
	Task: query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		return r
			.match(Task, { id, account })
			.where(r.not(Org, { id: account }))
			.find({ id, account })
	})
})

const Disjoined = role(Work, "disjoined", {
	Task: query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		return r
			.match(Task, { id, account })
			.where(r.or(r.not(Org, { id: account }), r.eq(account, id)))
			.find({ id, account })
	})
})

const Staged = role(Work, "staged", {
	Task: query(Work).rule((r) => {
		const stage = r.interior((r2) => {
			const { id } = v(Org, "org")
			return r2.match(Org, { id }).find({ id })
		})
		const { id, account } = v(Task, "task")
		return r.match(Task, { id, account }).match(stage, { id: account }).find({ id, account })
	})
})
/** The three roles above, in a login of their own. */
const Scoped = login(Work, "scoped", [Negated, Disjoined, Staged])
// @ts-expect-error -- TS2741: Negated reads Org under a negation, so Db.open needs a token
export const negatedWithoutToken = Db.open(Scoped.roles.negated, {})
// @ts-expect-error -- TS2741: Disjoined reads Org in a disjunction, so Db.open needs a token
export const disjoinedWithoutToken = Db.open(Scoped.roles.disjoined, {})
// @ts-expect-error -- TS2741: Staged reads Org in an interior stage, so Db.open needs a token
export const stagedWithoutToken = Db.open(Scoped.roles.staged, {})
const orgAccounts = query(Work).rule((r) => {
	const { id } = v(Org, "org")
	return r.match(Account, { id }).match(Org, { id }).find({ id })
})

const Imported = role(Work, "imported", {
	Task: query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		return r.match(Task, { id, account }).match(orgAccounts, { id: account }).find({ id, account })
	})
})
/**
 * One role of a login that reads a context is enough for its layer to need verify; its other roles still open
 * without a token.
 */
const Plain = role(Work, "plain", { Account })
const Mixed = login(Work, "mixed", [Plain, Imported])
// @ts-expect-error -- TS2741: Imported reads Org through the query it matches, so Db.open needs a token
export const importedWithoutToken = Db.open(Mixed.roles.imported, {})
export const importedOpened = Db.open(Mixed.roles.imported, { token: "a token" })
// @ts-expect-error -- TS2345: Imported reads a context, so the mixed login's layer needs verify
export const mixedUnverified = DbLayer.make({ ...destination, login: Mixed, password: rotating })
export const mixedLayer = DbLayer.make({ ...destination, login: Mixed, password: rotating, verify })
NodeRuntime.runMain(Effect.provide(Db.open(Mixed.roles.plain, {}), mixedLayer))
/** A role whose type does not say which contexts it reads may read one, so it opens only with a token. */
declare const someRole: AnyLoginRole
// @ts-expect-error -- TS2741: a role of unknown contexts may read one, so Db.open needs a token
export const someRoleWithoutToken = Db.open(someRole, {})

/** Nothing else is configurable: no pool size, isolation, timeout, retry policy or TLS mode, and no plaintext. */
export const pooled = DbLayer.make({
	...destination,
	login: WorkLogin,
	password: rotating,
	// @ts-expect-error -- TS2353: the layer has no pool size
	poolSize: 10
})

export const unverified = DbLayer.make({
	...destination,
	login: WorkLogin,
	password: rotating,
	// @ts-expect-error -- TS2353: TLS is always verify-full; there is no mode to relax it
	tls: { ca: "PEM", rejectUnauthorized: false }
})

// @ts-expect-error -- TS2345: TLS is required
export const plaintext = DbLayer.make({
	host: "localhost",
	port: 5433,
	database: "work",
	login: WorkLogin,
	snapshot,
	password: rotating
})
// @ts-expect-error -- TS2322: a password is Redacted, never a plain string
export const plainPassword = DbLayer.make({ ...destination, login: WorkLogin, password: "secret" })
const rotatingConfig = { ...destination, login: WorkLogin, password: rotating } as const
export type RotatingTaken = Expect<Takes<typeof WorkLogin, typeof rotatingConfig>>
declare const failsOtherwise: Effect.Effect<Redacted.Redacted, Error>
const failing = { ...destination, login: WorkLogin, password: failsOtherwise } as const
// @ts-expect-error -- TS2344: a password Effect fails only with CredentialError
export type OtherFailure = Expect<Takes<typeof WorkLogin, typeof failing>>
declare const needsService: Effect.Effect<Redacted.Redacted, CredentialError, "Vault">
const serviced = { ...destination, login: WorkLogin, password: needsService } as const
// @ts-expect-error -- TS2344: a password Effect needs no service
export type Serviced = Expect<Takes<typeof WorkLogin, typeof serviced>>
/** The config's login is a field of DbConfig<L>: a config of one login is none of another. */
declare const reportsConfig: DbConfig<typeof ReportsLogin>
// @ts-expect-error -- TS2375: a reports config is no work config
export const relabelled: DbConfig<typeof WorkLogin> = reportsConfig
