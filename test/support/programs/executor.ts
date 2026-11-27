/**
 * The names the executor-boundary program reads (test/types/executor/boundary.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export type { WriteEntryParts } from "#adapter/apply/compile.ts"
export { runWrite } from "#adapter/apply/run.ts"
export { runtimeEntry } from "#adapter/served/forms.ts"
export { loadedEntry } from "#adapter/served/load.ts"
export { loginRoles } from "#adapter/served/login.ts"
export type { Compiled } from "#bench/query/support/kit.ts"
export type { RoleContext } from "#adapter/served/role.ts"
export { type InstalledParams, noServedTypes } from "#compiler/physical/ddl/domains.ts"
export type { PlanBasis } from "#compiler/physical/install/plan.ts"
export { compileParsed, servableEntry } from "#compiler/plan/change.ts"
export { baseArtifacts, type ParamSource, unserved } from "#compiler/plan/common.ts"
