import * as runtime from "#compiler/program/workload/value.ts"
import type {
	AnsweredConstructor,
	ClockedConstructor,
	PagedConstructor,
	WorkloadConstructor
} from "#compiler/types/db/workload.ts"

export type { ClockUnit } from "#compiler/core/clock.ts"
export type { Answered, Clocked, Paged, Workload } from "#compiler/types/db/workload.ts"

/**
 * Public barrel: workload, the query workload. packages/grizzle/src/index.ts re-exports it.
 *
 * workload is the runtime of packages/engine/src/program/workload, which has its public signature (types/db/workload.ts): the
 * exported application artifact naming the queries, ordered queries and ChangeSets the application runs, which the
 * migration generator reads beside the schema. It installs nothing and gates no execution.
 */
export const workload: WorkloadConstructor = runtime.workload

/** paged(ordered): the workload member that pages an ordered query (program/workload/value.ts pagedMember). */
export const paged: PagedConstructor = runtime.pagedMember

/**
 * answered(read): the workload member that answers a read at its call's instant alone, never live, so its handle holds
 * no watch and its login needs no live source for it (program/workload/value.ts answeredMember).
 */
export const answered: AnsweredConstructor = runtime.answeredMember

/**
 * clocked(program, binding, keys): the workload member that serves a query, an ordered query or a ChangeSet with each
 * parameter `binding` names bound to the database's clock in its unit, read at the instant the call's transaction began,
 * a parameter of a consumer's contract under its key in `keys`, `{ now: millisKey }` (program/workload/value.ts
 * clockedMember).
 */
export const clocked: ClockedConstructor = runtime.clockedMember
