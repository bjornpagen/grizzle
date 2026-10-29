import * as runtime from "#compiler/program/workload/value.ts"
import type { WorkloadConstructor } from "#compiler/types/db/workload.ts"

export type { Workload } from "#compiler/types/db/workload.ts"

/**
 * Public barrel: workload, the query workload. packages/grizzle/src/index.ts re-exports it.
 *
 * workload is the runtime of packages/engine/src/program/workload, which has its public signature (types/db/workload.ts): the
 * exported application artifact naming the queries, ordered queries and ChangeSets the application runs, which the
 * migration generator reads beside the schema. It installs nothing and gates no execution.
 */
export const workload: WorkloadConstructor = runtime.workload
