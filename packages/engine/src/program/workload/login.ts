import type { LoginRule } from "#compiler/core/causes.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { isList } from "#compiler/core/record.ts"
import { workloadState } from "#compiler/program/workload/value.ts"
import { isLevelOf } from "#compiler/schema/levels.ts"
import { builderLoc, isPlainRecord, malformed, ownedEntry } from "#compiler/schema/protocol.ts"
import { login as loginBuilder } from "#compiler/schema/world.ts"
import type { Refusal } from "#compiler/types/core/phantom.ts"
import type { AnyWorkload } from "#compiler/types/db/workload.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type {
	AnyRole,
	Login,
	RolesOver,
	SharedNames,
	WorkloadsOver
} from "#compiler/types/schema/world.ts"

/**
 * The workloads a login owns, admitted: none without options, else `options.workload`, a list of workload values, each
 * over the login's base, a level of it, or one of its roles, and no two of their programs of one name, since a Db of
 * the login reaches each program by its name (`db.workload.<name>`). A JavaScript caller's options are read here once:
 * a value that is no options record, or a workload no workload(...) built, is MalformedDescription; a workload over
 * another schema, or a program name two workloads share, is LoginRefused.
 */
const admitWorkloads = (
	base: unknown,
	name: unknown,
	roles: ReadonlyArray<unknown>,
	rest: ReadonlyArray<unknown>
): void => {
	const baseEntry = ownedEntry(base, "schema")
	const label = `login ${baseEntry === undefined ? "?" : baseEntry.desc.name}.${typeof name === "string" ? name : "?"}`
	const [options, ...extra] = rest
	if (extra.length > 0) {
		throw malformed(label, "login(base, name, roles, options?): at most four arguments")
	}
	if (options === undefined) {
		return
	}
	if (!isPlainRecord(options) || Object.keys(options).some((k) => k !== "workload")) {
		throw malformed(label, "options { workload }: the workloads the login owns")
	}
	const given = options["workload"]
	if (!isList(given)) {
		throw malformed(label, "options.workload: a list of workloads built by workload(...)")
	}
	const refused = (rule: LoginRule): CompileError =>
		CompileError.make({
			_tag: "LoginRefused",
			at: builderLoc(`${label} workload`, []),
			login: typeof name === "string" ? name : "?",
			rule
		})
	const seen = new Set<string>()
	for (const [i, w] of given.entries()) {
		const state = workloadState(w)
		if (state === undefined) {
			throw malformed(`${label} workload ${i}`, "a workload built by workload(...)")
		}
		const over = state.schema
		const admitted =
			over.kind === "role"
				? roles.includes(over.value)
				: baseEntry !== undefined && isLevelOf(over.content, baseEntry.content)
		if (!admitted) {
			throw refused({
				kind: "workloadOver",
				schema: over.desc.name,
				base: baseEntry === undefined ? "?" : baseEntry.desc.name
			})
		}
		const twice = state.programs.find((program) => seen.has(program.name))
		if (twice !== undefined) {
			throw refused({ kind: "programTwice", program: twice.name })
		}
		for (const program of state.programs) {
			seen.add(program.name)
		}
	}
}

/**
 * One credential and one pool for roles over the base, and the workloads it owns: each role is in exactly one login,
 * the login's roles share its base, and each workload is over the base, a level of it, or one of its roles, no two
 * programs of one name among them. Each role is reached through the login by its name, `Web.roles.member`, with the
 * programs a Db of it runs, which Db.open takes.
 *
 * A role off the base and a workload over none of these each carry their refusal. The shared-name check reads the
 * whole list, so it is written against the options object beside its `workload`: the refusal it reaches is a
 * constituent of the options' own type, so the call's diagnostic names it, not a long tuple type that hides it.
 */
export const login = <
	Base extends AnySchema,
	const Name extends string,
	const Roles extends readonly [AnyRole, ...ReadonlyArray<AnyRole>],
	const Ws extends ReadonlyArray<AnyWorkload> = readonly []
>(
	base: Base,
	name: Name,
	roles: Roles & RolesOver<Base, Roles>,
	...options:
		| readonly []
		| readonly [
				options: { readonly workload: Ws & WorkloadsOver<Base, Roles[number], Ws> } & ([
					SharedNames<Ws, never>
				] extends [never]
					? unknown
					: Refusal<"two programs of one name across a login's workloads">)
		  ]
): Login<Base, Name, readonly [...Roles], Ws> => {
	admitWorkloads(base, name, roles, options)
	return loginBuilder<Base, Name, Roles, Ws>(base, name, roles, options)
}
