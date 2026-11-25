import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { heldRelation, type RelationDesc, type SchemaDesc } from "#compiler/ir/desc.ts"
import {
	type BuiltSchemaContent,
	isLevelOf,
	levelRelations,
	type SchemaContent,
	sameLevel,
	sameRoleLevel
} from "#compiler/schema/levels.ts"
import { ownedEntryOf } from "#compiler/schema/protocol.ts"
import type { FragmentDesc } from "#compiler/schema/schema.ts"
import type { BuiltRoleLevel, RoleLevel } from "#compiler/schema/world.ts"
import type { AnyFragment, AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyRole } from "#compiler/types/schema/world.ts"

/** What a query or a ChangeSet is written over, as a level: a schema value with its levels and its content; a fragment
 * value with its content, a root level's (schema.ts fragmentBuilder); or a role value over its base, with its level as
 * role(...) read it once (`RoleLevel`). A role's levels are itself, every level of its base it holds, with every
 * relation of the levels below it, whole or scoped under its own name (RoleLevel.whole), and every fragment of its base
 * whose relations it holds so (`unheldOf`): programs over such a level run on it unchanged, a full role's base's among
 * them, each over its scoped relations' owner's rows (program/slice.ts). */
export type Level =
	| {
			readonly kind: "schema"
			readonly value: AnySchema
			readonly desc: SchemaDesc
			readonly content: BuiltSchemaContent
	  }
	| {
			readonly kind: "fragment"
			readonly value: AnyFragment
			readonly desc: FragmentDesc
			readonly content: SchemaContent
	  }
	| ({ readonly kind: "role"; readonly value: AnyRole } & BuiltRoleLevel)

/** The first relation of a fragment of content `fragment` that the role `role` does not hold whole or scoped under its
 * own name, a relation no role holds (ir/desc.ts heldRelation) aside: a program over the fragment reads or writes it, so
 * the program runs on the role only where there is none. */
export const unheldOf = (fragment: SchemaContent, role: RoleLevel): string | undefined => {
	for (const [name, desc] of fragment.relations) {
		if (heldRelation(desc) && role.entries.get(name)?.kind !== "whole" && !role.scoped.has(name)) {
			return name
		}
	}
	return undefined
}

/** Every relation a level declares or reads by name: a schema's of every level of it (levels.ts levelRelations), a
 * fragment's own, a role's of every level of its base (RoleLevel relations). */
export const relationsOfLevel = (level: Level): ReadonlyMap<string, RelationDesc> => {
	switch (level.kind) {
		case "schema":
			return levelRelations(level.desc)
		case "fragment":
			return level.content.relations
		case "role":
			return level.relations
	}
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

/** The highest of `levels`, the one every other is a level of (`isLevelOver`), or none where there is none: what a
 * ChangeSet combined by `union` or `sequence` is over (write/changeset/value.ts), and where a call of rows is matched
 * (query/build/state.ts callSourceValue). Levels are compared by content alone, never by the object that holds one, so
 * queries built by several query(S) calls over one S are over one level. The first pass moves to each level the held
 * one is a level of, so it ends on the highest where there is one; the second holds every level to it. */
export const highestLevel = <L extends Level>(levels: NonEmptyReadonlyArray<L>): L | undefined => {
	const top = levels.reduce((held, level) => (isLevelOver(held, level) ? level : held))
	return levels.every((level) => isLevelOver(level, top)) ? top : undefined
}

/** The level of a built value: a schema built by schema(...) or schema.extend(...), a fragment built by fragment(...),
 * or a role built by role(...); undefined for any other value. */
export const levelOf = (value: unknown): Level | undefined => {
	const entry = ownedEntryOf(value)
	if (entry?.kind === "role") {
		return { kind: "role", value: entry.value, ...entry.content }
	}
	if (entry?.kind === "fragment") {
		return {
			kind: "fragment",
			value: entry.value,
			desc: entry.desc,
			content: entry.content.level
		}
	}
	if (entry?.kind === "schema") {
		return {
			kind: "schema",
			value: entry.value,
			desc: entry.desc,
			content: entry.content
		}
	}
	return undefined
}
