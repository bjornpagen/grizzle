import type { SchemaDesc } from "#compiler/ir/desc.ts"
import { isLevelOf, type SchemaContent } from "#compiler/schema/levels.ts"
import { ownedEntry } from "#compiler/schema/protocol.ts"
import { type RoleLevel, roleLevelOf } from "#compiler/schema/world.ts"

/** What a query or a ChangeSet is written over, as a level: a schema with its levels and its content, or a role over
 * its base, with its level as role(...) read it once (`RoleLevel`). A role's levels are itself and, for a full role,
 * which holds every relation of its base whole under its own name, every level of its base: programs over the base run
 * on it unchanged. */
export type Level =
	| { readonly kind: "schema"; readonly desc: SchemaDesc; readonly content: SchemaContent }
	| ({ readonly kind: "role" } & RoleLevel)

/** Whether `lower` is one of the levels of `higher`, compared by content.
 * A schema records the schema it extends, so its levels are itself and every schema below it (`LevelsOf`). A rule over S
 * matches a query written over any level of S, and a ChangeSet over S accepts members and read-backs written over any
 * level of S. A level is its content, not its name, by the one level check every entry point shares, `isLevelOf`; two
 * roles are one level when their identities are. */
export const isLevelOver = (lower: Level, higher: Level): boolean => {
	if (higher.kind === "schema") {
		return lower.kind === "schema" && isLevelOf(lower.content, higher.content)
	}
	if (lower.kind === "role") {
		return lower.identity === higher.identity
	}
	return higher.full && isLevelOf(lower.content, higher.base)
}

/** The level of a built value: a schema built by schema(...) or schema.extend(...), or a role built by role(...);
 * undefined for any other value. */
export const levelOf = (value: unknown): Level | undefined => {
	const role = roleLevelOf(value)
	if (role !== undefined) {
		return { kind: "role", ...role }
	}
	const schema = ownedEntry(value, "schema")
	return schema === undefined
		? undefined
		: { kind: "schema", desc: schema.desc, content: schema.content }
}
