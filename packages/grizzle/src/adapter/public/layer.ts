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
 * Public barrel: DbLayer and DbConfig, the connection of one login with its credentials, TLS and verify.
 *
 * DbLayer.make(config) is the one integration input: a login, its snapshot, a destination, the credentials, verify-full
 * TLS, and the verify that turns a Db's token into its claims, with no field for pool size, statement caching, retries,
 * timeouts or a TLS mode. The config is parsed once, where it is given: one no connection can use fails the layer with
 * OpenError{stage: "config"}. Build the layer once per instance, in module scope, never per request and never on
 * globalThis: building it compiles every program of the login's workloads once and checks their access against the
 * snapshot (OpenError{stage: "schema"} names a program that does not compile or whose access moved), and creates the
 * login's session pool, which lives as long as the layer and serves every role of the login. No driver type appears
 * here.
 *
 * The Effect service Db.open requires, a layer serving exactly that role (adapter/types/layer.ts). An alias, not an
 * interface of its own: an instantiation compares with Db.open's requirement through the one interface's variance.
 */
export type DbLayer<R> = DbLayerService<R>

/** The connection configuration DbLayer.make takes for the login L. */
export type DbConfig<L> = DbConfigShape<L>

export type { ConnectionPool, DbConnection, DbLayerOf, Verify } from "#adapter/types/layer.ts"

export const DbLayer: DbLayerConstructor = {
	make: <const L extends AnyLogin>(config: DbConfig<L>): Layer.Layer<DbLayerOf<L>, OpenError> =>
		dbSessionsLayer(config)
}

/**
 * grizzle.config.ts's shape and defineConfig, which every configuration is built by: `export default defineConfig({
 * schemas, logins })`, with an optional typed connection for what DATABASE_URL cannot say. The command line reads the
 * configurations defineConfig typed from the same module.
 */
export { defineConfig } from "#adapter/config/define.ts"
export type { GrizzleConfig, MigrationConnectionConfig } from "#adapter/types/config.ts"
