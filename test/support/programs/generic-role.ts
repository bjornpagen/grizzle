/**
 * The names the generic-role program reads (test/types/changeset/generic-role.ts), its prelude (test/support/prelude.ts):
 * the program imports these alone, each through this module.
 */
export { ChangeSet } from "#compiler/public/changeset.ts"
export { natural } from "#compiler/public/fields.ts"
export type { AnyRole, RoleOver } from "#compiler/public/schema.ts"
export { relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
