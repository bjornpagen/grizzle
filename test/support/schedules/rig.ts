import { Array as Arr, type Context, Effect, Layer, type Scope } from "effect"
import type { DbContext, ServedDbContext } from "#adapter/db/context.ts"
import type { OpenedDb } from "#adapter/db/open.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { Db } from "#adapter/public/db.ts"
import type { DbLayerOf, ServedLogin } from "#adapter/types/layer.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import type { AnyLogin, AnyRole, AnySchema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { type Installed, installGenerated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import { dbRuntime } from "#test/support/runtime-db.ts"
import { type GrizzleActor, grizzleActor } from "#test/support/schedules/actors.ts"
import { type ExploreEnv, exploreEnv } from "#test/support/schedules/interleave.ts"
import { servedFixtureOf } from "#test/support/served-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import type { SubstrateWorld } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

/**
 * A schedule's schema and its worlds: every role a grizzle writer opens is in the login `server`; `direct`, the role
 * direct SQL actors take on, is in the login `psql`, never `server`.
 */
interface RigWorlds {
	readonly schema: AnySchema
	readonly server: AnyLogin
	readonly psql: AnyLogin
	readonly direct: AnyRole
}

/** A grizzle writer: its role's Db and the context it reads, and the actor its operation steps run as. */
export interface Writer<R, P> {
	readonly db: Db<R, P>
	readonly ctx: DbContext
	readonly actor: GrizzleActor
}

/** A grizzle writer of the served login: its role's Db and the context it reads, and its actor. */
export interface ServedWriter<R, P> {
	readonly db: Db<R, P>
	readonly ctx: ServedDbContext
	readonly actor: GrizzleActor
}

export interface Rig<W extends RigWorlds> {
	readonly installed: Installed
	/**
	 * The schema and its worlds rebuilt under the installed name: ChangeSets and queries over them are the Dbs' own.
	 */
	readonly worlds: W
	/** The login `server` as an application serves it: the roles a served writer opens are reached through it. */
	readonly served: ServedLogin<W["server"]>
	/** The role `direct` as a direct SQL actor takes it on (ActorSpec). */
	readonly direct: SubstrateWorld
	readonly env: ExploreEnv
	/** Owner statements in one transaction. */
	readonly owner: (
		sql: ReadonlyArray<string>
	) => Effect.Effect<void, SqlError | TransactionRolledBack>
	/**
	 * Every relation's rows replaced with what `sql` inserts, as the owner, in one transaction that truncates every
	 * stored relation's table first: a reset between runs that writes the whole state and is never an SSI pivot
	 * (installationGroup).
	 */
	readonly replace: (
		sql: ReadonlyArray<string>
	) => Effect.Effect<void, SqlError | TransactionRolledBack>
	/**
	 * Builds a DbLayer of the worlds' login of its own, given the installation's snapshot, opens a role's Db over it
	 * with `open` (the caller's openDbContext(server.roles.<role>, {}), provided the layer's context), as an application
	 * opens it, applies the empty ChangeSet through the runtime its methods dispatch to, which leases the Db's session,
	 * and resolves the writer's grizzle actor, named `name`: the one session of the login that no earlier writer of the
	 * rig holds.
	 */
	readonly writer: <R, P>(
		name: string,
		open: (
			context: Context.Context<DbLayerOf<W["server"]>>
		) => Effect.Effect<OpenedDb<R, P>, OpenError>
	) => Effect.Effect<Writer<R, P>, OpenError, Substrate | Scope.Scope>
	/**
	 * Builds a DbLayer of the served login `server` of its own, opens a role's Db over it with `open` (the caller's
	 * openServed(served.roles.<role>, {}), provided the layer's context), as an application opens it, runs `first` on
	 * the Db, one call of its workload (the empty ChangeSet the schedule's login serves), which leases the Db's session,
	 * and resolves the writer's grizzle actor, named `name`: the one session of the login that no earlier writer of the
	 * rig holds.
	 */
	readonly servedWriter: <R, P, E>(
		name: string,
		open: (
			context: Context.Context<DbLayerOf<W["server"]>>
		) => Effect.Effect<{ readonly db: Db<R, P>; readonly ctx: ServedDbContext }, OpenError>,
		first: (db: Db<R, P>) => Effect.Effect<unknown, E>
	) => Effect.Effect<ServedWriter<R, P>, OpenError, Substrate | Scope.Scope>
}

/**
 * A schedule's installation and its grizzle writers.
 *
 * A schedule's schema and its worlds are declared through the public API as a function of the schema's name, installed
 * under a fresh schema name as `grizzle generate` drafts and serves it (installGenerated: roles are cluster-wide; each
 * role runs at the level its served workload certifies, and each table keeps its guard by those levels), and rebuilt
 * under the installed name, so the Dbs, their ChangeSets and their queries are typed by the schema and its roles
 * themselves. Each grizzle writer opens its role's Db through a DbLayer of its own over the login
 * `server`, exactly as an application does, and its grizzle actor is the one session that Db's pool holds. Direct SQL
 * actors take on the role `direct` through a login of their own, so no direct session is ever mistaken for a writer's.
 * Seeds and constraint rebuilds name tables through the installation, so a caller runs them with `owner` after openRig
 * and before its writers open.
 *
 * Installs build(name) with its logins under a fresh name, serves the login `server` from the same draft, and opens the
 * observer.
 */
export const openRig = <W extends RigWorlds>(
	build: (name: string) => W
): Effect.Effect<
	Rig<W>,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const { installed, served } = yield* installGenerated(
			(name) => {
				const declared = build(name)
				return { schema: declared.schema, logins: [declared.server, declared.psql] }
			},
			{ label: "real", ambient: ordinarySession }
		)
		const worlds = build(installed.declared)
		const fixture = servedFixtureOf<W["server"]>(
			installed,
			worlds.server,
			defined(served.get(worlds.server.name), "the served file of the login server")
		)
		const env = yield* exploreEnv(s)
		/**
		 * The backends of the writers opened so far: a new writer's actor is the one session of the login beside them.
		 */
		const opened: Array<number> = []
		return {
			installed,
			worlds,
			served: fixture.login,
			direct: installed.world(worlds.direct),
			env,
			owner: (sql) => transaction(s.admin, sql),
			replace: (sql) =>
				replaceRows(
					s.admin,
					installationGroup(namesOf(installed)),
					Arr.map(sql, (text) => ({ sql: text, params: [] }))
				),
			writer: (actorName, open) =>
				Effect.gen(function* () {
					const login: W["server"] = worlds.server
					const context = yield* Layer.build(loginLayer(installed, login))
					const { db, ctx } = yield* open(context)
					const first = dbRuntime(ctx).methods.apply(ChangeSet.empty(worlds.schema), {})
					const actor = yield* grizzleActor(actorName, installed.as(login).role, first, opened)
					opened.push(actor.pid)
					return { db, ctx, actor }
				}),
			servedWriter: (actorName, open, first) =>
				Effect.gen(function* () {
					const context = yield* Layer.build(fixture.layer)
					const { db, ctx } = yield* open(context)
					const actor = yield* grizzleActor(
						actorName,
						installed.as(worlds.server).role,
						first(db),
						opened
					)
					opened.push(actor.pid)
					return { db, ctx, actor }
				})
		}
	})
