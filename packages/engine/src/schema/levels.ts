import {
	type EncodeOptions,
	encode,
	type OmitRule,
	omitSourceLocs
} from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { RelationDesc, SchemaDesc } from "#compiler/ir/desc.ts"
import { own } from "#compiler/schema/own.ts"

/**
 * What a level's content leaves out beside the source locations: the level's own schema name, at the description and
 * at each description its extends chain reaches (every level of one chain carries the schema's one name). The name only
 * places the installation, and compilation takes every placed name from the schema it is compiled against, so one
 * schema's relations installed under several names are one content. The chain's order and every other field (the
 * relations, the statements, each relation's and statement's own name) stay in the text.
 */
const omitLevelName: OmitRule = (key, value, path) =>
	omitSourceLocs(key, value, path) ||
	(key === "name" && path.every((segment) => segment === "extends"))

const contentOptions: EncodeOptions = { omit: omitLevelName }

/**
 * The content text of a schema description, its levels included: the canonical text of its canonical description,
 * without the level's own name.
 */
const contentText = (desc: SchemaDesc): Result.Result<string, CompileError> =>
	Result.flatMap(own(desc), (owned) => encode(owned.desc, contentOptions))

/**
 * Schema levels: a schema is itself and every schema its extends chain reaches (LevelsOf).
 *
 * A level is its content, not its name or its declaration order: the one level check every entry point shares (role
 * admission of a query entry, ChangeSet building, workload(...), a query's and a ChangeSet's compilation against the Db's
 * schema, program/schema.ts levelSchema). The content is the canonical description ownership makes (own.ts own: each
 * level's relations by name, its statements by canonical text), so a schema as built and the base an owned role holds
 * are one content.
 *
 * Whether `lower` is one of the levels of `higher`, higher itself or a schema its extends chain reaches, compared by
 * content whatever name places them (as types/schema/schema.ts IsLevelOf states at the type level). A description with no
 * canonical text is the typed refusal encode gives, never a "no".
 */
export const isLevelOf = (
	lower: SchemaDesc,
	higher: SchemaDesc
): Result.Result<boolean, CompileError> => {
	for (let at: SchemaDesc | undefined = higher; at !== undefined; at = at.extends) {
		if (at === lower) {
			return Result.ok(true)
		}
	}
	return Result.flatMap(contentText(lower), (lowerText) => {
		for (let at: SchemaDesc | undefined = higher; at !== undefined; at = at.extends) {
			const text = contentText(at)
			if (!text.ok) {
				return Result.err(text.error)
			}
			if (text.value === lowerText) {
				return Result.ok(true)
			}
		}
		return Result.ok(false)
	})
}

/**
 * Every relation of every level of a schema, by declared name; the highest level's declaration wins, though a name is
 * declared once across the levels (ownership refuses a conflicting redeclaration).
 */
export const levelRelations = (desc: SchemaDesc): ReadonlyMap<string, RelationDesc> => {
	const out = new Map<string, RelationDesc>()
	for (let at: SchemaDesc | undefined = desc; at !== undefined; at = at.extends) {
		for (const r of at.relations) {
			if (!out.has(r.name)) {
				out.set(r.name, r)
			}
		}
	}
	return out
}
