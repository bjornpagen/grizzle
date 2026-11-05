import type { Layer } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { dbSessionsLayer } from "#adapter/pool/registry.ts"
import type {
	DbConfigShape,
	DbLayerConstructor,
	DbLayerOf,
	DbLayerService
} from "#adapter/types/layer.ts"
import type { AnyLogin } from "#compiler/types/schema/world.ts"

/**
 * Public barrel: DbLayer and DbConfig, the connection of one login with its driver, transport, credentials, pool and
 * verify.
 *
 * DbLayer.make(config) is the one integration input: a login, its snapshot, the driver the caller imports, the
 * transport and its verify-full TLS, the credentials, the connect timeout, the pool's bounds, and the verify that turns
 * a Db's token into its claims. grizzle states no number of its own: every bound is the caller's, and none it does not
 * name exists (no retry, no statement or acquisition deadline). The config is parsed once, where it is given: one no
 * connection can use fails the layer with OpenError{stage: "config"}, as does an environment that sets a connection
 * option grizzle cannot override (connection/environment.ts). Build the layer once per instance, in module scope, never
 * per request and never on globalThis: building it compiles every program of the login's workloads once and checks
 * their access against the snapshot (OpenError{stage: "schema"} names a program that does not compile or whose access
 * moved), and creates the login's session pool, which lives as long as the layer and serves every role of the login.
 * Closing the layer's scope destroys every connection of its pool at once, awaiting nothing from the network.
 *
 * The Effect service Db.open requires, a layer serving exactly that role (adapter/types/layer.ts). An alias, not an
 * interface of its own: an instantiation compares with Db.open's requirement through the one interface's variance.
 */
export type DbLayer<R> = DbLayerService<R>

/** The connection configuration DbLayer.make takes for the login L. */
export type DbConfig<L> = DbConfigShape<L>

export type { PgDriver, PgSocket } from "#adapter/types/driver.ts"
export type {
	ConnectionPool,
	DbConnection,
	DbLayerOf,
	PoolBounds,
	Transport,
	Verify
} from "#adapter/types/layer.ts"

export const DbLayer: DbLayerConstructor = {
	make: <const L extends AnyLogin>(config: DbConfig<L>): Layer.Layer<DbLayerOf<L>, OpenError> =>
		dbSessionsLayer(config)
}

/**
 * A configuration file's shape and defineConfig, which every configuration is built by: `export default defineConfig({
 * schemas, logins, migrations, connection })`, every setting required. The command line reads the configurations
 * defineConfig typed from the same module.
 */
export { defineConfig } from "#adapter/config/define.ts"
export type { GrizzleConfig, MigrationConnectionConfig } from "#adapter/types/config.ts"
