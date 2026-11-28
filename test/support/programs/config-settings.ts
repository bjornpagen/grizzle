/**
 * The names the configuration-settings program reads (test/types/api/config-settings.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export type { MigrationConnectionConfig } from "#adapter/types/config.ts"
export { int4 } from "#compiler/public/fields.ts"
export { relation, schema } from "#compiler/public/schema.ts"
export { defineConfig } from "#index.ts"
