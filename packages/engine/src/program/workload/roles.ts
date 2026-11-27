import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { levelSchema, type ParsedRole } from "#compiler/program/input.ts"
import { type WorkloadProgram, workloadState } from "#compiler/program/workload/value.ts"
import type { OwnedLogin, OwnedRole } from "#compiler/schema/own.ts"

const loc = SourceLoc("login compile", [])

/**
 * The owned role of `owned`, a login owned, of the name of `role`, one of the login's roles, where its login is
 * compiled. The role was parsed where its login was read (program/input.ts parseRole, roleOfDesc), so no step of the
 * compile reads a role value, and the login was owned from the Description its roles were read with, which names each.
 */
export const loginRole = (role: ParsedRole, owned: OwnedLogin): OwnedRole =>
	defined(
		owned.roles.find((r) => r.name === role.desc.name),
		`role ${role.desc.name} of login ${owned.name}, which its Description names`
	)

/**
 * The programs of a login's workloads that run on a role, in the workloads' order, each one's programs in its record's
 * order: a workload over a level of the role runs on it (program/input.ts levelSchema), and on no other one, each of its
 * programs over the role's world (schema/scope.ts): a workload over the role itself, which is one level with it
 * (schema/levels.ts sameRoleLevel), and a workload over the base or a level of it on a role that holds every relation
 * of it whole, whose levels hold the base. A workload value no workload(...) built is refused.
 */
export const programsOn = (
	role: ParsedRole,
	workloads: ReadonlyArray<unknown>
): Result.Result<ReadonlyArray<WorkloadProgram>, CompileError> => {
	const running: Array<WorkloadProgram> = []
	for (const workload of workloads) {
		const state = workloadState(workload)
		if (state === undefined) {
			return Result.err(malformedDescription(loc, "a workload built by workload(...)"))
		}
		if (levelSchema(state.schema, role, loc).ok) {
			appendAll(running, state.programs)
		}
	}
	return Result.ok(running)
}
