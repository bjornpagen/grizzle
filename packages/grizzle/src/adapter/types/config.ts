import type { DbConnection } from "#adapter/types/layer.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyLogin } from "#compiler/types/schema/world.ts"

/**
 * Where the migration identity connects when DATABASE_URL cannot say it: exactly a DbLayer's destination, credentials
 * and TLS (no login, verify or pool hook: migrate opens one connection), with the migration identity's login role, which
 * owns every declared schema.
 */
export interface MigrationConnectionConfig extends DbConnection {
	readonly role: string
}

/**
 * The shape of grizzle.config.ts, the lean config. Types only: packages/grizzle/src/adapter/config/define.ts implements defineConfig,
 * and the command line (packages/grizzle/src/cli/config.ts, packages/grizzle/src/cli/connection.ts) parses a configuration once into its required form.
 *
 * The config says what grizzle manages; the environment says where it deploys. A configuration names the schemas, the
 * logins (and through them every role and workload) and the migrations directory, is committed, and reads the same in
 * every environment:
 *
 *     import { defineConfig } from "@bjornpagen/grizzle"
 *     export default defineConfig({ schemas: [Blog], logins: [Web, EtlJob] })
 *
 * `grizzle migrate` connects with DATABASE_URL. `connection` overrides it only for what a URL cannot say, such as an
 * RDS IAM token or a secret manager's lookup (a password Effect, evaluated for each connection attempt), or a CA the URL
 * does not give.
 *
 * The default export of grizzle.config.ts.
 */
export interface GrizzleConfig {
	/**
	 * The declared schema values to migrate, each a schema(...) or schema.extend(...) value in its own PostgreSQL schema.
	 */
	readonly schemas: readonly [AnySchema, ...ReadonlyArray<AnySchema>]
	/**
	 * The logins installed with them, each over a configured schema; every role a Db opens is in exactly one of them,
	 * and their workloads plan the schemas' access paths.
	 */
	readonly logins: ReadonlyArray<AnyLogin>
	/** The migrations directory, relative to the configuration; `migrations` by default. */
	readonly migrations?: string
	/** Where `grizzle migrate` connects; DATABASE_URL when absent. generate and check never read it. */
	readonly connection?: MigrationConnectionConfig
}
