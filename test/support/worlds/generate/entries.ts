import { Array as Arr } from "effect"
import { derivedHeading, fieldsOfSource } from "#test/support/worlds/generate/domain.ts"
import { roleContexts } from "#test/support/worlds/model/session/state.ts"
import type {
	BaseSpec,
	ContextSpec,
	EntrySpec,
	FieldSpec,
	RoleSpec
} from "#test/support/worlds/model/types.ts"

/** The contexts a role's relations read, in the base's order: a token is required exactly when there is one. */
export const contextsRead = (base: BaseSpec, role: RoleSpec): ReadonlyArray<ContextSpec> => {
	const read = roleContexts(role)
	return Arr.filter(base.contexts, (c) => read.has(c.name))
}

/** An entry's heading: a whole entry's relation's fields, a query entry's first rule's head fields. */
export const headingOf = (base: BaseSpec, entry: EntrySpec): ReadonlyArray<FieldSpec> =>
	entry.kind === "whole" ? fieldsOfSource(base, entry.relation) : derivedHeading(base, entry.rules)
