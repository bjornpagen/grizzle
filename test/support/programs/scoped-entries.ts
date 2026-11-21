/**
 * The names the scoped entries program reads (test/types/schema/scoped-entries.ts), its prelude (test/support/prelude.ts):
 * the program imports these alone, each through this module.
 */
export { pg } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export {
	contained,
	context,
	on,
	relation,
	role,
	schema,
	scopedEntriesOf
} from "#compiler/public/schema.ts"
export { str } from "#compiler/public/text.ts"
export { workload } from "#compiler/public/workload.ts"
