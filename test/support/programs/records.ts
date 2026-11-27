/**
 * The names the records agreement's generated program reads (test/types/schema/records.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export { ChangeSet } from "#compiler/public/changeset.ts"
export { pg } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export type { HeadOf, ImmediateHeadOf } from "#compiler/public/query.ts"
export {
	login,
	records,
	recordsFacts,
	recordsQuery,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
export { workload } from "#compiler/public/workload.ts"
export type { Fact, RecordPaths } from "#compiler/public/schema.ts"
export {
	Blurb,
	Book,
	Chapter,
	Digital,
	Ink,
	Paper,
	Remark,
	Shelf,
	Shelves,
	Spine
} from "#test/support/fixtures/records/shelves.ts"
export { Id, toId } from "#test/support/ids.ts"
