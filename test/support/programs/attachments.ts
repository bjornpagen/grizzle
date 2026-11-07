/**
 * The names the attachment agreement's generated program reads (test/support/agreement/attachments.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export type { Brand, Option } from "effect"
export type { Decimal, Uuid } from "#compiler/public/fields.ts"
export { arm, query, v } from "#compiler/public/query.ts"
export type { HeadOf, ImmediateHeadOf } from "#compiler/public/query.ts"
export type { ChangeSet, ReadsOf } from "#compiler/types/changeset/changeset.ts"
export { AccountTally, Tallies } from "#test/support/agreement/deliver-tally.ts"
export { Deliver, DeliverApart } from "#test/support/agreement/schema.ts"
