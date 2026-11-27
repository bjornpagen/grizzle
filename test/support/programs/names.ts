/**
 * The names the relation-name program reads (test/types/api/names.ts), its prelude (test/support/prelude.ts): the
 * program imports these alone, each through this module.
 */
export type { InsertAllRowsOf } from "#compiler/public/changeset.ts"
export { closed as dynamicClosed, relation as dynamicRelation } from "#compiler/public/dynamic.ts"
export { closedId, generated, pg, uuid } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export {
	closed,
	contained,
	derived,
	on,
	relation,
	type RelationName,
	schema
} from "#compiler/public/schema.ts"
export { Id, toId } from "#test/support/ids.ts"
