import { heldRelation, type SchemaDesc } from "#compiler/ir/desc.ts"
import { isLevelOf, type SchemaContent, sameLevel, sameRoleLevel } from "#compiler/schema/levels.ts"
import { ownedEntry } from "#compiler/schema/protocol.ts"
import type { FragmentDesc } from "#compiler/schema/schema.ts"
import type { RoleLevel } from "#compiler/schema/world.ts"
import type { AnyFragment, AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyRole } from "#compiler/types/schema/world.ts"

/** What a query or a ChangeSet is written over, as a level: a schema value with its levels and its content; a fragment
 * value with its content, a root level's (schema.ts fragment); or a role value over its base, with its level as role(...)
 * read it once (`RoleLevel`). A role's levels are itself, every level of its base it holds whole, with every relation of
 * the levels below it, under its own name (RoleLevel.whole), and every fragment of its base whose relations it holds
 * whole (`heldWhole`): programs over such a level run on it unchanged, a full role's base's among them. */
export type Level =
	| {
			readonly kind: "schema"
			readonly value: AnySchema
			readonly desc: SchemaDesc
			readonly content: SchemaContent
	  }
	| {
			readonly kind: "fragment"
			readonly value: AnyFragment
			readonly desc: FragmentDesc
			readonly content: SchemaContent
	  }
	| ({ readonly kind: "role"; readonly value: AnyRole } & RoleLevel)

/** The first relation of a fragment of content `fragment` that the role `role` does not hold whole under its own name,
 * a relation no role holds (ir/desc.ts heldRelation) aside: a program over the fragment reads or writes it, so the
 * program runs on the role only where there is none. */
export const unheldOf = (fragment: SchemaContent, role: RoleLevel): string | undefined => {
	for (const [name, desc] of fragment.relations) {
		if (heldRelation(desc) && role.entries.get(name)?.kind !== "whole") {
			return name
		}
	}
	return undefined
}

/** Whether `lower` is one of the levels of `higher`, compared by content.
 * A schema records the schema it extends and the fragments its list holds, so its levels are itself, every schema below
 * it and every fragment one of those lists (`LevelsOf`). A rule over S matches a query written over any level of S, and
 * a ChangeSet over S accepts members and read-backs written over any level of S. A level is its content, not its name,
 * by the one level check every entry point shares, `isLevelOf`; two roles are one level when they are one Description
 * over one base (`sameRoleLevel`); a fragment's one level is itself, and a role's levels hold a fragment of its base it
 * holds every relation of whole. */
export const isLevelOver = (lower: Level, higher: Level): boolean => {
	if (higher.kind !== "role") {
		if (lower.kind === "role") {
			return false
		}
		return higher.kind === "fragment"
			? sameLevel(lower.content, higher.content)
			: isLevelOf(lower.content, higher.content)
	}
	switch (lower.kind) {
		case "role":
			return sameRoleLevel(lower, higher)
		case "fragment":
			return isLevelOf(lower.content, higher.base) && unheldOf(lower.content, higher) === undefined
		case "schema":
			return higher.whole !== undefined && isLevelOf(lower.content, higher.whole)
	}
}

/** The level of a built value: a schema built by schema(...) or schema.extend(...), a fragment built by fragment(...),
 * or a role built by role(...); undefined for any other value. */
export const levelOf = (value: unknown): Level | undefined => {
	const role = ownedEntry(value, "role")
	if (role !== undefined) {
		return { kind: "role", value: role.value, ...role.content }
	}
	const fragment = ownedEntry(value, "fragment")
	if (fragment !== undefined) {
		return {
			kind: "fragment",
			value: fragment.value,
			desc: fragment.desc,
			content: fragment.content.level
		}
	}
	const schema = ownedEntry(value, "schema")
	return schema === undefined
		? undefined
		: { kind: "schema", value: schema.value, desc: schema.desc, content: schema.content }
}
