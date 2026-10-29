import { encode, omitSourceLocs } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { RoleDesc, SchemaDesc } from "#compiler/ir/desc.ts"
import { isLevelOf, levelRelations } from "#compiler/schema/levels.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { roleDescOf } from "#compiler/schema/world.ts"

/** What a ChangeSet is built over: a schema with its levels, or a role over its base. A role's levels are itself and,
 * for a full role, which holds every relation of its base whole under its own name, every level of its base: programs
 * over the base run on it unchanged. */
export type BuiltOver =
	| { readonly kind: "schema"; readonly desc: SchemaDesc }
	| { readonly kind: "role"; readonly desc: RoleDesc }

/** The role's whole entries, by name. */
const wholeEntries = (role: RoleDesc): ReadonlySet<string> =>
	new Set(role.relations.flatMap((e) => (e.kind === "whole" ? [e.name] : [])))

/** Whether a role holds every relation of every level of its base whole. */
const isFullRole = (role: RoleDesc): boolean => {
	const whole = wholeEntries(role)
	return [...levelRelations(role.base).keys()].every((name) => whole.has(name))
}

/** The canonical text of a role description, source locations left out. */
const roleText = (role: RoleDesc): Result.Result<string, CompileError> =>
	encode(role, { omit: omitSourceLocs })

/** Whether `lower` is one of the levels of `higher` (see `BuiltOver`), compared by content.
 * A schema records the schema it extends, so its levels are itself and every schema below it (`LevelsOf`). A ChangeSet
 * over S accepts members and read-backs written over any level of S, and `ChangeSet.union` and `sequence` are over the
 * highest of their arguments' schemas; schemas of which neither is a level of the other do not combine. The relations a
 * ChangeSet may write are the ordinary relations of every level (`WritableOf`). A level is its content, not its name,
 * by the one level check every entry point shares, `isLevelOf`. */
export const isLevelOver = (
	lower: BuiltOver,
	higher: BuiltOver
): Result.Result<boolean, CompileError> => {
	if (higher.kind === "schema") {
		return lower.kind === "schema" ? isLevelOf(lower.desc, higher.desc) : Result.ok(false)
	}
	if (lower.kind === "role") {
		return Result.flatMap(roleText(lower.desc), (a) =>
			Result.map(roleText(higher.desc), (b) => a === b)
		)
	}
	return isFullRole(higher.desc) ? isLevelOf(lower.desc, higher.desc.base) : Result.ok(false)
}

/** The higher of two built-overs when one is a level of the other, or neither. */
export const higherOver = (
	a: BuiltOver,
	b: BuiltOver
): Result.Result<"a" | "b" | "neither", CompileError> =>
	Result.flatMap(isLevelOver(a, b), (aBelowB) =>
		aBelowB
			? Result.ok("b" as const)
			: Result.map(isLevelOver(b, a), (bBelowA) => (bBelowA ? "a" : "neither"))
	)

/** What a built value is built over: a schema built by schema(...) or schema.extend(...), or a role built by role(...);
 * undefined for any other value. */
export const builtOverOf = (value: unknown): BuiltOver | undefined => {
	const role = roleDescOf(value)
	if (role !== undefined) {
		return { kind: "role", desc: role }
	}
	const schema = schemaDescOf(value)
	return schema === undefined ? undefined : { kind: "schema", desc: schema }
}

/** The name a built-over's ChangeSet Description labels it by: the schema's or the role's. */
export const overName = (over: BuiltOver): string => over.desc.name
