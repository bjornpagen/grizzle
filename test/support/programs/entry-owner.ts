/**
 * The names the entry-owner program reads (test/types/changeset/entry-owner.ts), its prelude (test/support/prelude.ts):
 * the program imports these alone, each through this module.
 */
export { ChangeSet } from "#compiler/public/changeset.ts"
export { query, v } from "#compiler/public/query.ts"
export { role } from "#compiler/public/schema.ts"
export { shopOf } from "#test/support/families/entry-owner.ts"
