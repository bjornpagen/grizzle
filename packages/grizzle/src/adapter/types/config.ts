import type { DbConnection } from "#adapter/types/layer.ts"
import type { AnyContract, AnyLogin, AnySchema } from "#compiler/plan/common.ts"

/**
 * Where the migration identity connects: exactly a DbLayer's connection (its driver, transport, database and password;
 * no login, verify or pool: migrate opens one connection), with the migration identity's login role, which owns every
 * declared schema.
 */
export type MigrationConnectionConfig = DbConnection & { readonly role: string }

/**
 * The shape of a configuration file, grizzle.config.ts by convention, which every command names as its argument. Types
 * only: packages/grizzle/src/adapter/config/define.ts implements defineConfig, and the command line
 * (packages/grizzle/src/cli/config.ts, packages/grizzle/src/cli/connection.ts) parses a configuration once into its
 * required form.
 *
 * Every setting is required, and nothing else is configurable: grizzle chooses no directory and takes no setting from
 * the environment. A configuration names the schemas, the logins (and through them every role and workload), the
 * migrations directory, the longest role prefix an installation is under and where migrate, drift, roles and uninstall
 * connect:
 *
 *     import { defineConfig } from "@bjornpagen/grizzle"
 *     export default defineConfig({
 *         schemas: [Blog], logins: [Web, EtlJob], contracts: [], migrations: "migrations", rolePrefixBytes: 0,
 *         connection
 *     })
 *
 * The connection is the application's to build, from whatever its deploy provides, when a command that connects asks
 * for it: a password Effect (an RDS IAM token, a secret manager's lookup) is evaluated for each connection attempt.
 *
 * The default export of a configuration file.
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
	/**
	 * The consumers' contracts a running application parses values of at a boundary, by their values, so a misspelt one
	 * is a type error: generate compiles each into its checker file, `<migrations>/contract-checks/<name>.json`, which
	 * @bjornpagen/grizzle/runtime's contractParser reads with no compiler loaded, and check holds each current. Empty
	 * where the application parses none.
	 */
	readonly contracts: ReadonlyArray<AnyContract>
	/** The migrations directory: absolute, or relative to the configuration file's directory. */
	readonly migrations: string
	/**
	 * The bytes of the longest role prefix (DbConnection.rolePrefix) any installation of this configuration is under, a
	 * fact of its deployment: 0 where every installation's roles are at their stems, as a production database's alone
	 * on its cluster, or the length of the longest prefix one is under, as a test harness's that installs each case under
	 * a prefix of its own. An integer from 0 to maxRolePrefixBytes (core/identity.ts RolePrefixBound). Every command
	 * refuses a login or role whose PostgreSQL role would pass PostgreSQL's 63 bytes under a prefix of this length,
	 * before anything is written, and every command that calls `connection` refuses one whose `rolePrefix` is longer.
	 */
	readonly rolePrefixBytes: number
	/**
	 * Where `grizzle migrate`, `grizzle drift`, `grizzle roles` and `grizzle uninstall` connect, and under which role
	 * prefix (its `rolePrefix`), built when one of them runs: generate, check and names never
	 * call it, so they read no cluster setting and no CA file, and run where no cluster is reachable.
	 */
	readonly connection: () => MigrationConnectionConfig
}
