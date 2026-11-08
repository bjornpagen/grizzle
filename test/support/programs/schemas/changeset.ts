/**
 * The names of types/changeset/changeset.ts and public/changeset.ts the schema agreement's generated program reads as
 * Cs (test/support/agreement/schemas.ts), its prelude (test/support/prelude.ts): the program reads that namespace
 * through this module alone.
 */
export { ChangeSet } from "#compiler/public/changeset.ts"
export type {
	Addition,
	AdditionIn,
	InsertableNameOf,
	InsertAllRowsOf,
	WritableOf,
	Written
} from "#compiler/types/changeset/changeset.ts"
