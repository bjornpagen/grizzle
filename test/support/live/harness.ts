import { Array as Arr, Effect, type Layer, type Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { DbLayer, served } from "#adapter/public/layer.ts"
import type { DbLayerOf, PoolBounds, ServedLogin } from "#adapter/types/layer.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { type Installed, installGenerated } from "#test/support/install-migrate.ts"
import { commitDirectly, commitStatements } from "#test/support/live/direct.ts"
import {
	type LiveCase,
	type LiveCommit,
	type LiveWrite,
	liveWorld,
	type RelationPlace
} from "#test/support/live/world.ts"
import { clusterConnection, type SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { makeTap, type Tap } from "#test/support/wire-tap.ts"
import { testVerify } from "#test/support/worlds.ts"

/**
 * A live case installed as an application deploys it: its schema drafted and served as `grizzle generate` drafts it
 * (test/support/install-migrate.ts installGenerated), which plans the live source of its served programs' footprint
 * (the publication and replica identity migrate installs) and certifies its role; migrated by the real runner; its facts stored by its direct
 * writer; and its login served from the file generate wrote, over a DbLayer whose every session, pooled and listening,
 * goes through one wire tap.
 */
export interface LiveInstallation {
	readonly c: LiveCase
	readonly installed: Installed
	/** The full world's login `server` and its one role `app` (test/support/worlds.ts fullWorld). */
	readonly world: ReturnType<typeof liveWorld>["world"]
	/** The login's served file, as an application imports it. */
	readonly json: unknown
	readonly file: ServedLogin<AnyLogin>
	/** The direct SQL writer: a session of the login that has taken on `app`. */
	readonly writer: RawSession
	readonly tap: Tap
	/** The login's DbLayer, every session through `tap`. */
	readonly layer: Layer.Layer<DbLayerOf<AnyLogin>, OpenError>
}

/** The login every live world serves (test/support/worlds.ts fullWorld). */
export const liveLogin = "server"

/** The inserts of every fact of `c`, as one direct writer's commit, none where it has no fact. */
const factsCommit = (c: LiveCase): ReadonlyArray<LiveCommit> => {
	const inserts = Arr.flatMap([0, 1] as const, (place: RelationPlace) =>
		Arr.map(c.facts[place], (fact): LiveWrite => ({ kind: "insert", relation: place, fact }))
	)
	return Arr.isReadonlyArrayNonEmpty(inserts) ? [{ writer: "psql", writes: inserts }] : []
}

/**
 * Installs `c` as a LiveInstallation, in the scope (see LiveInstallation), its layer's pool bounded by `pool`: a suite
 * that gates the tap's first session runs one session, so every call it gates runs on it.
 */
export const installLive = (
	c: LiveCase,
	label: string,
	pool: PoolBounds
): Effect.Effect<
	LiveInstallation,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const generated = yield* installGenerated(
			(name) => {
				const built = liveWorld(c, name)
				return { schema: built.schema, logins: built.logins }
			},
			{ label, ambient: ordinarySession }
		)
		const installed = generated.installed
		const world = liveWorld(c, installed.declared).world
		const json = defined(generated.served.get(liveLogin), `the served file of ${liveLogin}`)
		const writer = yield* substrate.session(worldSession(installed.world(world.app)))
		for (const commit of factsCommit(c)) {
			yield* commitDirectly(writer, commitStatements(installed.plan, c, commit))
		}
		const tap = makeTap(installed.cluster)
		const file = served(json, liveLogin)
		const layer = DbLayer.make({
			...clusterConnection(
				installed.cluster,
				installed.database,
				installed.as(world.server).password
			),
			transport: tap.transport,
			pool,
			login: file,
			verify: testVerify
		})
		return { c, installed, world, json, file, writer, tap, layer }
	})
