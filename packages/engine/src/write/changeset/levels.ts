import type { RelationDesc, SchemaDesc } from "#compiler/ir/desc.ts"
import { isLevelOver, levelOf } from "#compiler/schema/level.ts"
import { levelRelations, type SchemaContent } from "#compiler/schema/levels.ts"
import type { RoleLevel } from "#compiler/schema/world.ts"

/** What a ChangeSet is built over: a level (schema/level.ts Level), with every relation of every level of its schema,
 * or of its role's base, by name (`levelRelations`), read once when the ChangeSet is begun, which its members' relations
 * are found in. */
export type BuiltOver =
	| {
			readonly kind: "schema"
			readonly desc: SchemaDesc
			readonly content: SchemaContent
			readonly relations: ReadonlyMap<string, RelationDesc>
	  }
	| ({ readonly kind: "role" } & RoleLevel)

/** The higher of two built-overs when one is a level of the other (schema/level.ts isLevelOver), or neither:
 * `ChangeSet.union` and `sequence` are over the highest of their arguments' schemas, and schemas of which neither is a
 * level of the other do not combine. The relations a ChangeSet may write are the ordinary relations of every level
 * (`WritableOf`). */
export const higherOver = (a: BuiltOver, b: BuiltOver): "a" | "b" | "neither" =>
	isLevelOver(a, b) ? "b" : isLevelOver(b, a) ? "a" : "neither"

/** What a ChangeSet begun over a built value is built over (`levelOf`), its relations read; undefined for a value no
 * builder made a schema or a role. */
export const builtOverOf = (value: unknown): BuiltOver | undefined => {
	const level = levelOf(value)
	return level === undefined || level.kind === "role"
		? level
		: { ...level, relations: levelRelations(level.desc) }
}

/** The name a built-over's ChangeSet Description labels it by: the schema's or the role's. */
export const overName = (over: BuiltOver): string => over.desc.name
