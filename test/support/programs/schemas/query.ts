/**
 * The names of public/query.ts the schema agreement's generated program reads as Q (test/support/agreement/schemas.ts),
 * its prelude (test/support/prelude.ts): the program reads that namespace through this module alone.
 */
export { query, v } from "#compiler/public/query.ts"
export type { HeadOf, ParamsOf } from "#compiler/public/query.ts"
