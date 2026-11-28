/**
 * The names the public-Result program reads (test/types/api/results.ts), its prelude (test/support/prelude.ts): the
 * program imports these alone, each through this module, each public reader through the package's root or its compile
 * entry, as a caller imports it.
 */
export type { Result } from "effect"
export { indexesOf } from "#adapter/public/compile.ts"
export type { Err, Ok } from "@bjornpagen/grizzle-text/base/result"
export {
	check,
	type FactsDecoder,
	generated,
	type InsertPreview,
	int8,
	relation,
	schema,
	uuid
} from "#index.ts"
export { codecText, factsDecoder, insertPreview, rowEvaluator } from "#adapter/public/host.ts"
export type { RowEvaluation, RowEvaluator } from "#compiler/plan/common.ts"
export { Id } from "#test/support/ids.ts"
