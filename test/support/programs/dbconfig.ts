/**
 * The names the DbConfig agreement's generated program reads (test/support/agreement/dbconfig.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module, but for the driver and the
 * socket module it reads as a caller does.
 */
export { Effect, Redacted } from "effect"
export type { DbConfigShape, PoolBounds, Transport, Verify } from "#adapter/types/layer.ts"
export { DbLayer, served } from "#index.ts"
export type { CredentialError } from "#index.ts"
export { PlainLogin, WebLogin } from "#test/support/agreement/access-schema.ts"
