/**
 * The names the evidence agreement's generated program reads (test/support/agreement/queries.ts and the admission and
 * argument modules beside it), its prelude (test/support/prelude.ts): the program imports these alone, each through
 * this module.
 */
export { Array as Arr, Effect } from "effect"
export type { Brand, Option, Stream } from "effect"
export type { DbOf, GetArg, QueryResult, WorkloadHandles } from "#adapter/types/db.ts"
export type { ReadError } from "#adapter/errors/execution.ts"
export type { CursorError } from "#compiler/plan/common.ts"
export { ALLEN } from "#compiler/public/allen.ts"
export { Compute } from "#compiler/public/compute.ts"
export { date, Decimal, Money, pg, uuid, Vector } from "#compiler/public/fields.ts"
export type { CalendarDate, Span, Uuid } from "#compiler/public/fields.ts"
export { query, v } from "#compiler/public/query.ts"
export { paged, workload } from "#compiler/public/workload.ts"
export type {
	EvidenceOfQuery,
	HeadOf,
	ParamsOf,
	ParamType,
	VarsOf
} from "#compiler/public/query.ts"
export { check, role } from "#compiler/public/schema.ts"
export type {
	Carriers,
	Declares,
	Facts,
	FactsOf,
	Headed,
	Rostered
} from "#compiler/types/core/phantom.ts"
export type { Page, PageCursor } from "#compiler/types/page/page.ts"
export {
	Agree,
	AgreeAbove,
	Apart,
	Batch,
	byOwner,
	Cell,
	Cents,
	Item,
	ItemTones,
	Note,
	Owned,
	OwnerCounts,
	Reader,
	Reporter,
	Rollup,
	Shade,
	Slot,
	Stray,
	Tag,
	Tone,
	Tones,
	ToneWeight
} from "#test/support/agreement/schema.ts"
