import * as runtime from "#compiler/program/workload/value.ts"
import type {
	PagedConstructor,
	RefreshConstructor,
	WorkloadConstructor
} from "#compiler/types/db/workload.ts"

export type { Paged, Refresh, Workload } from "#compiler/types/db/workload.ts"

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
 * refresh(relations): the workload member that refreshes a nonempty list of materialized derived relations in one
 * transaction
 * (program/workload/value.ts refreshMember).
 */
export const refresh: RefreshConstructor = runtime.refreshMember
