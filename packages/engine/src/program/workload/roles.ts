import { appendAll } from "#compiler/core/array.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { levelSchema, type ParsedRole, parseSchemaInput } from "#compiler/program/schema.ts"
import { type WorkloadProgram, workloadState } from "#compiler/program/workload/value.ts"
import type { OwnedLogin, OwnedRole } from "#compiler/schema/own.ts"

const loc = SourceLoc("login compile", [])

/** A login's role value parsed, with its login's owned role of its name. */
export interface LoginRole {
	readonly input: ParsedRole
	readonly owned: OwnedRole
}

/**
 * A role value of a login read where its login is compiled: parsed (program/schema.ts parseSchemaInput), with the owned
 * role of `owned` of its name. A value no role(...) built, or a role of no role of the login, is refused.
 */
export const loginRole = (
	value: unknown,
	owned: OwnedLogin
): Result.Result<LoginRole, CompileError> =>
	Result.flatMap(parseSchemaInput(value), (input) => {
		const role =
			input.kind === "role" ? owned.roles.find((r) => r.name === input.desc.name) : undefined
		return input.kind === "role" && role !== undefined
			? Result.ok({ input, owned: role })
			: Result.err(malformedDescription(loc, "a login's role built by role(...)"))
	})

/**
 * The programs of a login's workloads that run on a role, in the workloads' order, each one's programs in its record's
 * order: a workload over the role is the role's own, and a workload over the base or a level of it runs on a full role,
 * whose levels hold the base (program/schema.ts levelSchema), and on no partial one. A workload value no workload(...)
 * built is refused.
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
		const over = state.schema
		const runs = over.kind === "role" ? over.value === role.value : levelSchema(over, role, loc).ok
		if (runs) {
			appendAll(running, state.programs)
		}
	}
	return Result.ok(running)
}
