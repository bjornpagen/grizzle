import type * as Layer from "effect/Layer"
import type { OpenError } from "#adapter/errors/execution.ts"
import { liveSourceLayer } from "#adapter/pool/live.ts"
import { servedLayer } from "#adapter/pool/served.ts"
import { served as servedValue } from "#adapter/served/served.ts"
import type {
	LoginBase,
	DbConfigShape,
	DbLayerConstructor,
	DbLayerOf,
	DbLayerService,
	LiveOf,
	LiveSourceConfigShape,
	LiveSourceConstructor,
	LiveSourceService,
	ServedConstructor
} from "#adapter/types/layer.ts"
import type { AnyLogin } from "#compiler/plan/common.ts"

/**
 * Public barrel: served, DbLayer and DbConfig, a login's served workload and the connection of it with its driver,
 * transport, credentials, pool and verify, and the Token verify is handed.
 *
 * served(file, name) is a login's committed workload, `migrations/<schema>/served/<login>.json`, which `grizzle
 * generate` compiles and `grizzle check` holds to the compile, served as the login's type: `served<typeof App>(file,
 * "app")`, the type imported with `import type`, so no schema module is evaluated. DbLayer.make(config) is the one
 * integration input: the served login, the driver the caller imports, the transport and its verify-full TLS, the
 * credentials, the connect timeout, the pool's bounds, and the verify that turns a Db's token into its claims. grizzle
 * states no number of its own: every bound is the caller's, and none it does not name exists (no retry, no statement or
 * acquisition deadline). The config is parsed once, where it is given: one no connection can use fails the layer with
 * OpenError{stage: "config"}, as does an environment that sets a connection option grizzle cannot override
 * (connection/environment.ts) and a served file of another login than its name. Build the layer once per instance, in
 * module scope, never per request and never on globalThis: building it reads the served file once and rebuilds what
 * runs its programs, compiling nothing, and creates the login's session pool, which lives as long as the layer and
 * serves every role of the login. Closing the layer's scope destroys every connection of its pool at once, awaiting
 * nothing from the network.
 *
 * The Effect service Db.open requires, a layer serving exactly that role (adapter/types/layer.ts). An alias, not an
 * interface of its own: an instantiation compares with Db.open's requirement through the one interface's variance.
 */
export type DbLayer<R> = DbLayerService<R>

/** The connection configuration DbLayer.make takes for the login L. */
export type DbConfig<L> = DbConfigShape<L>

export type { Token } from "#adapter/db/token.ts"
export type { PgDriver, PgSocket } from "#adapter/types/driver.ts"
export type {
	ConnectionPool,
	DbConnection,
	DbLayerOf,
	LiveOf,
	LiveSourceConfigShape,
	LiveSourceService,
	PoolBounds,
	ServedLogin,
	ServedRole,
	ServedRoles,
	Transport,
	Verify
} from "#adapter/types/layer.ts"

export const DbLayer: DbLayerConstructor = {
	make: <const L extends AnyLogin>(
		config: DbConfig<L>
	): Layer.Layer<DbLayerOf<L>, OpenError, LiveOf<L>> => servedLayer(config)
}

/**
 * LiveSource.layer(config): an installation's live source for the process, built once per process per installation and
 * provided to every DbLayer of a login of it that serves a read, which requires it (LiveOf): the connection of the
 * installation's decoder login, whose `password` is its credential, and a served login of the installation that serves
 * a read. It connects nothing until a Db's first watch; from then on, for its scope, it holds one listening session of
 * the decoder login and the process's candidacy for the installation's live leader, which every layer it serves shares.
 */
export const LiveSource: LiveSourceConstructor = {
	layer: <const L extends AnyLogin>(
		config: LiveSourceConfigShape<L>
	): Layer.Layer<LiveSourceService<LoginBase<L>>, OpenError> => liveSourceLayer(config)
}

/**
 * served(file, name): a login's committed workload, `migrations/<root>/served/<login>.json`, which `grizzle generate`
 * compiles and `grizzle check` holds to the compile, served as the login's type: `served<typeof App>(file, "app")`, the
 * type imported with `import type`, so no schema module is evaluated.
 */
export const served: ServedConstructor = servedValue
