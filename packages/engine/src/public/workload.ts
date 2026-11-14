import * as runtime from "#compiler/program/workload/value.ts"
import type {
	ClockedConstructor,
	DeferrableConstructor,
	PagedConstructor,
	RefreshConstructor,
	WorkloadConstructor
} from "#compiler/types/db/workload.ts"

export type { ClockUnit } from "#compiler/core/clock.ts"
export type { Clocked, Deferrable, Paged, Refresh, Workload } from "#compiler/types/db/workload.ts"

/**
 * Public barrel: workload, the query workload. packages/grizzle/src/index.ts re-exports it.
 *
 * workload is the runtime of packages/engine/src/program/workload, which has its public signature (types/db/workload.ts): the
 * exported application artifact naming the queries, ordered queries, ChangeSets and refreshes the application runs, which the
 * migration generator reads beside the schema. It installs nothing and gates no execution.
 */
export const workload: WorkloadConstructor = runtime.workload

/** paged(ordered): the workload member that pages an ordered query (program/workload/value.ts pagedMember). */
export const paged: PagedConstructor = runtime.pagedMember

/**
 * deferrable(read): the workload member that runs a read in a SERIALIZABLE READ ONLY DEFERRABLE transaction, which waits
 * for a safe snapshot and then never fails with a serialization failure (program/workload/value.ts deferrableMember).
 */
export const deferrable: DeferrableConstructor = runtime.deferrableMember

/**
 * refresh(relations): the workload member that refreshes a nonempty list of materialized derived relations in one
 * transaction
 * (program/workload/value.ts refreshMember).
 */
export const refresh: RefreshConstructor = runtime.refreshMember

/**
 * clocked(program, binding): the workload member that serves a query, an ordered query or a ChangeSet with each
 * parameter `binding` names bound to the database's clock in its unit, read at the instant the call's transaction began
 * (program/workload/value.ts clockedMember).
 */
export const clocked: ClockedConstructor = runtime.clockedMember
