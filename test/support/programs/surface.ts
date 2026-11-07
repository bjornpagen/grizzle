/**
 * The names the query surface's generated program reads (test/types/api/surface.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export type {
	Evidence,
	Finished,
	Ordered,
	Query,
	QueryBuilder,
	Rule
} from "#compiler/public/query.ts"
export type { Work } from "#test/support/agreement/access-schema.ts"
