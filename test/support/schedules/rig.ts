import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, type Context, Effect, Layer, type Scope } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { Db } from "#adapter/public/db.ts"
import type { DbLayerOf, ServedLogin } from "#adapter/types/layer.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { AnyLogin, AnyRole, AnySchema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import {
	type Generated,
	generatedTemplate,
	type Installed,
	installGenerated
} from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type GrizzleActor, grizzleActor } from "#test/support/schedules/actors.ts"
import { type ExploreEnv, exploreEnv } from "#test/support/schedules/interleave.ts"
import { servedFixtureOf } from "#test/support/served-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import type { SubstrateWorld } from "#test/support/substrate/session.ts"
import {
	Substrate,
	type SubstrateCase,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"

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
	 * Every relation's rows replaced with what `sql` inserts, as the owner, in one transaction after every stored
	 * relation's rows are deleted: a reset between runs that writes the whole state and is never an SSI pivot
	 * (installationGroup, replaceRows).
	 */
	readonly replace: (
		sql: ReadonlyArray<string>
	) => Effect.Effect<void, SqlError | TransactionRolledBack>
	/**
	 * Builds a DbLayer of the served login `server` of its own, opens a role's Db over it with `open` (the caller's
	 * openServed(served.roles.<role>, {}), provided the layer's context), as an application opens it, runs `first` on
	 * the Db, one call of its workload (the empty ChangeSet the schedule's login serves), and names the writer's grizzle
	 * actor `name` over the Db's pool, the backend its calls hold (grizzleActor).
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
 * `server`, exactly as an application does, and its grizzle actor is the backend that Db's call holds. Direct SQL
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
	Effect.flatMap(
		installGenerated((name) => rigLogins(build(name)), { label: "real", ambient: ordinarySession }),
		(generated) => rigOver(generated, build)
	)

/** A schedule's schema and the logins its installation carries: `server`, whose roles the writers open, and `psql`. */
const rigLogins = (declared: RigWorlds) => ({
	schema: declared.schema,
	logins: [declared.server, declared.psql]
})

/**
 * openRig's installation as a template (install-migrate.ts generatedTemplate): build(name) with its logins drafted and
 * served once per member under the template's name, `name` telling it from the other templates its declaring module
 * states. A case reads its rig over its clone (rigIn), installing nothing.
 */
export const rigTemplate = (
	declaredIn: ImportMeta,
	name: string,
	build: (name: string) => RigWorlds
): SubstrateTemplate<Generated> =>
	generatedTemplate({
		declaredIn,
		name,
		content: { rig: name },
		build: (installed) => rigLogins(build(installed)),
		ambient: ordinarySession
	})

/** The rig of a case over a clone of a schedule's template (rigTemplate), as openRig opens one over its install. */
export const rigIn = <W extends RigWorlds>(
	taken: SubstrateCase<Generated>,
	build: (name: string) => W
): Effect.Effect<Rig<W>, SqlError, Scope.Scope> =>
	Effect.provideService(rigOver(taken.value, build), Substrate, taken.substrate)

/**
 * The rig over a generated installation of build(name) in the substrate's database: the schema and its worlds rebuilt
 * under the installed name, the login `server` served from the same draft, and the observer opened.
 */
const rigOver = <W extends RigWorlds>(
	{ installed, served }: Generated,
	build: (name: string) => W
): Effect.Effect<Rig<W>, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const worlds = build(installed.declared)
		const fixture = servedFixtureOf<W["server"]>(
			installed,
			worlds.server,
			defined(served.get(worlds.server.name), "the served file of the login server")
		)
		const env = yield* exploreEnv(s)
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
			servedWriter: (actorName, open, first) =>
				Effect.gen(function* () {
					const context = yield* Layer.build(fixture.layer)
					const { db, ctx } = yield* open(context)
					yield* Effect.orDie(first(db))
					const actor = yield* grizzleActor(actorName, ctx.pool)
					return { db, ctx, actor }
				})
		}
	})
