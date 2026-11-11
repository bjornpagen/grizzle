import type { DbOf } from "#adapter/types/db.ts"

/**
 * Public barrel: Db, its workload handles' types (WorkloadHandles, MemberHandle, MemberCalls and the explains) and the
 * explain types (StatementPlan, Plan and their parts). packages/grizzle/src/index.ts re-exports it.
 *
 * `Db` is both the value Db.open lives on and the type of an opened database. The types are the public shapes of
 * packages/grizzle/src/adapter/types/db.ts; the value is the adapter's (packages/grizzle/src/adapter/db/served.ts). No
 * driver type appears here. A call's input, value and events, and the CallError every failure is, are the live event
 * model's (engine live/index.ts: Input, ValueOf, EventOf, CallError).
 */
import { DbValue } from "#adapter/db/served.ts"

export type { NoTokenOptions, OpenOptions, TokenOptions } from "#adapter/types/db.ts"

export const Db: typeof DbValue = DbValue
export type Db<R, P> = DbOf<R, P>

export type {
	ChangeExplain,
	ExecutedPlan,
	ExecutedStatement,
	MemberCalls,
	MemberHandle,
	Plan,
	PlanIndex,
	PlanTarget,
	ReadExplain,
	StatementPlan,
	WorkloadHandles
} from "#adapter/types/db.ts"
