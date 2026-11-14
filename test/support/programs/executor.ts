/**
 * The names the executor-boundary program reads (test/types/executor/boundary.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export { loadedEntry, type WriteEntryParts } from "#adapter/apply/compile.ts"
export { runWrite } from "#adapter/apply/run.ts"
export { runtimeEntry } from "#adapter/served/forms.ts"
export { layerOver } from "#adapter/served/login.ts"
export type { RoleContext, SliceArtifacts } from "#adapter/served/role.ts"
export { type InstalledParams, noParamTypes } from "#compiler/physical/ddl/domains.ts"
export type { PlanBasis } from "#compiler/physical/install/plan.ts"
export { compileParsed } from "#compiler/plan/change.ts"
export { baseArtifacts, type ParamSource, unserved } from "#compiler/plan/common.ts"
export type { Slice } from "#compiler/plan/serve.ts"
