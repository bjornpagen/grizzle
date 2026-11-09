/**
 * Public barrel: a configuration file's shape and defineConfig, which every configuration is built by: `export default
 * defineConfig({ schemas, logins, migrations, connection })`, every setting required. The command line reads the
 * configurations defineConfig typed from the same module.
 */
export { defineConfig } from "#adapter/config/define.ts"
export type { GrizzleConfig, MigrationConnectionConfig } from "#adapter/types/config.ts"
