/**
 * The names the recursion agreement's generated program reads (test/support/agreement/recursion.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export type { Brand } from "effect"
export { pg, uuid } from "#compiler/public/fields.ts"
export type { Uuid } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export type {
	Evidence,
	EvidenceOfQuery,
	HeadOf,
	ParamsOf,
	ParamType
} from "#compiler/public/query.ts"
export type { DbOf, GetArg } from "#adapter/types/db.ts"
export { Edge, Graph, Node, Reader } from "#test/support/agreement/recursion-schema.ts"
