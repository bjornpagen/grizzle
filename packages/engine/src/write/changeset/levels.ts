import type { RelationDesc } from "#compiler/ir/desc.ts"
import { type Level, levelOf } from "#compiler/schema/level.ts"
import { levelRelations } from "#compiler/schema/levels.ts"

/** What a ChangeSet is built over: a level (schema/level.ts Level), with every relation of every level of its schema,
 * or of its role's base, by name (`levelRelations`), or every relation of its fragment, read once when the ChangeSet is
 * begun, which its members' relations are found in. */
export type BuiltOver =
	| (Extract<Level, { readonly kind: "schema" | "fragment" }> & {
			readonly relations: ReadonlyMap<string, RelationDesc>
	  })
	| Extract<Level, { readonly kind: "role" }>

/** What a ChangeSet begun over a built value is built over (`levelOf`), its relations read; undefined for a value no
 * builder made a schema, a fragment or a role. */
export const builtOverOf = (value: unknown): BuiltOver | undefined => {
	const level = levelOf(value)
	if (level === undefined || level.kind === "role") {
		return level
	}
	return level.kind === "fragment"
		? { ...level, relations: level.content.relations }
		: { ...level, relations: levelRelations(level.desc) }
}
