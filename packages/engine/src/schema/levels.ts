import { sameContent } from "#compiler/core/canonical.ts"
import type { RelationDesc, SchemaDesc } from "#compiler/ir/desc.ts"
import { type CanonicalStatement, canonicalStatementOf } from "#compiler/schema/own.ts"
import type { RoleLevel } from "#compiler/schema/world.ts"

/**
 * Schema levels: a schema is itself and every schema its extends chain reaches (LevelsOf).
 *
 * A level is its content, not its name or its declaration order: the content ownership's canonical description holds
 * (own.ts own), each level's relations by name and its statements by canonical text. A schema value's content is read
 * once, when schema(...) or schema.extend(...) builds it, from the descriptions its relations carry and its own
 * statements' canonical texts, over the content of the level below; every level check compares contents by structure
 * (core/canonical.ts sameContent), never by an encoding of them.
 *
 * The content of one level of a schema and of every level below it, as its description's extends chain is: each
 * relation the level declares that no level below declares alike, by name with its description; the canonical text of
 * each statement the level writes that no level below writes; and the level below. Two schemas are one content exactly
 * when their levels are, level for level (sameLevel), whatever name places them.
 */
export interface SchemaContent {
	readonly relations: ReadonlyMap<string, RelationDesc>
	readonly statements: ReadonlySet<string>
	/**
	 * Each statement the level writes, in the order its description holds them, in canonical form with its canonical
	 * text, read once where the statement was built or entered: what ownership reads the level's statements by.
	 */
	readonly canonical: ReadonlyArray<CanonicalStatement>
	readonly below: SchemaContent | undefined
}

/** A relation a level declares: its name and its description, a derived relation's as the level holds it. */
export interface LevelRelation {
	readonly name: string
	readonly desc: RelationDesc
}

/** Whether a level below declares the relation alike: under its name, with its content. */
const declaredBelow = (below: SchemaContent | undefined, relation: LevelRelation): boolean => {
	for (let at = below; at !== undefined; at = at.below) {
		const declared = at.relations.get(relation.name)
		if (declared !== undefined && sameContent(declared, relation.desc)) {
			return true
		}
	}
	return false
}

/** Whether a level below writes the statement of canonical text `text`. */
const writtenBelow = (below: SchemaContent | undefined, text: string): boolean => {
	for (let at = below; at !== undefined; at = at.below) {
		if (at.statements.has(text)) {
			return true
		}
	}
	return false
}

/**
 * The content of a level that declares `relations` and writes `statements`, each in canonical form with its text
 * (own.ts CanonicalStatement), over the level `below`.
 */
export const levelContent = (
	relations: ReadonlyArray<LevelRelation>,
	statements: ReadonlyArray<CanonicalStatement>,
	below: SchemaContent | undefined
): SchemaContent => {
	const own = new Map(
		relations.flatMap((r) => (declaredBelow(below, r) ? [] : [[r.name, r.desc] as const]))
	)
	const texts = new Set(statements.flatMap((s) => (writtenBelow(below, s.text) ? [] : [s.text])))
	return Object.freeze({
		relations: own,
		statements: texts,
		canonical: Object.freeze(statements),
		below
	})
}

/**
 * The content of a schema description no builder made, read where it enters (program/schema.ts parseSchemaInput): each
 * level's relations and its statements' canonical texts read from their descriptions, which a built schema's relations
 * and statements carry instead.
 */
export const contentOfDesc = (desc: SchemaDesc): SchemaContent =>
	levelContent(
		desc.relations.map((r) => ({ name: r.name, desc: r })),
		desc.statements.map(canonicalStatementOf),
		desc.extends === undefined ? undefined : contentOfDesc(desc.extends)
	)

/**
 * Whether two levels and every level below each are one content, level for level: the same relations by name, each
 * pair one content (core/canonical.ts sameContent), the same statement texts, over levels below that are one content.
 * One level met twice is one content at once, so a level is read only where the two differ.
 */
export const sameLevel = (a: SchemaContent | undefined, b: SchemaContent | undefined): boolean => {
	for (let x = a, y = b; x !== y; x = x.below, y = y.below) {
		if (
			x === undefined ||
			y === undefined ||
			x.relations.size !== y.relations.size ||
			x.statements.size !== y.statements.size ||
			![...x.statements].every((text) => y.statements.has(text)) ||
			![...x.relations].every(([name, desc]) => {
				const other = y.relations.get(name)
				return other !== undefined && sameContent(desc, other)
			})
		) {
			return false
		}
	}
	return true
}

/**
 * Whether two roles are one level (world.ts RoleLevel): one Description but for its base, which each names, over bases
 * of one name and one content (sameLevel). One role met twice is one level at once.
 */
export const sameRoleLevel = (a: RoleLevel, b: RoleLevel): boolean =>
	a === b ||
	(a.desc.base.name === b.desc.base.name &&
		sameLevel(a.base, b.base) &&
		sameContent({ ...a.desc, base: undefined }, { ...b.desc, base: undefined }))

/**
 * Whether `lower` is one of the levels of `higher`, higher itself or a level its extends chain reaches, compared by
 * content whatever name places them (as types/schema/schema.ts IsLevelOf states at the type level): the one level check
 * every entry point shares (role admission of a query entry, ChangeSet building, workload(...), login(...), a query's
 * and a ChangeSet's compilation against the Db's schema, program/schema.ts levelSchema).
 */
export const isLevelOf = (lower: SchemaContent, higher: SchemaContent): boolean => {
	for (let at: SchemaContent | undefined = higher; at !== undefined; at = at.below) {
		if (sameLevel(at, lower)) {
			return true
		}
	}
	return false
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
