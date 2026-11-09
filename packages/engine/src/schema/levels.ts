import { compareText } from "#compiler/core/canonical.ts"
import {
	type ContentDigest,
	contentDigest,
	type RelationDesc,
	type SchemaDesc
} from "#compiler/ir/desc.ts"
import { type CanonicalStatement, canonicalStatementOf } from "#compiler/schema/own.ts"

/**
 * Schema levels: a schema is itself and every schema its extends chain reaches (LevelsOf).
 *
 * A level is its content, not its name or its declaration order: the content ownership's canonical description holds
 * (own.ts own), each level's relations by name and its statements by canonical text. A schema value's content is read
 * once, when schema(...) or schema.extend(...) builds it, from the content digests its relations carry and its own
 * statements' canonical texts, over the content of the level below; every level check compares contents, never the
 * descriptions they were read from.
 *
 * The content of one level of a schema and of every level below it, as its description's extends chain is: each
 * relation the level declares that no level below declares alike, by name with its content digest; the canonical text
 * of each statement the level writes that no level below writes; and the level below. Its digest digests the level's
 * own part with the digest of the level below, so two schemas are one content exactly when their digests are, whatever
 * name places them.
 */
export interface SchemaContent {
	readonly digest: ContentDigest
	readonly relations: ReadonlyMap<string, ContentDigest>
	readonly statements: ReadonlySet<string>
	/**
	 * Each statement the level writes, in the order its description holds them, in canonical form with its canonical
	 * text, read once where the statement was built or entered: what ownership reads the level's statements by.
	 */
	readonly canonical: ReadonlyArray<CanonicalStatement>
	readonly below: SchemaContent | undefined
}

/** A relation a level declares: its name and its content digest. */
export interface LevelRelation {
	readonly name: string
	readonly digest: ContentDigest
}

/** Whether a level below declares the relation alike: under its name, with its content. */
const declaredBelow = (below: SchemaContent | undefined, relation: LevelRelation): boolean => {
	for (let at = below; at !== undefined; at = at.below) {
		if (at.relations.get(relation.name) === relation.digest) {
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
		relations.flatMap((r) => (declaredBelow(below, r) ? [] : [[r.name, r.digest] as const]))
	)
	const texts = new Set(statements.flatMap((s) => (writtenBelow(below, s.text) ? [] : [s.text])))
	const digest = contentDigest("schema-level", {
		relations: [...own].toSorted(([a], [b]) => compareText(a, b)),
		statements: [...texts].toSorted(compareText),
		below: below === undefined ? [] : [below.digest]
	})
	return Object.freeze({
		digest,
		relations: own,
		statements: texts,
		canonical: Object.freeze(statements),
		below
	})
}

/** The content digest of a relation's description, which a relation value carries from its build. */
const relationDigest = (desc: RelationDesc): ContentDigest => contentDigest("relation", desc)

/**
 * The content of a schema description no builder made, read where it enters (program/schema.ts parseSchemaInput): each
 * level's relations digested and its statements' canonical texts read from their descriptions, which a built schema's
 * relations and statements carry instead.
 */
export const contentOfDesc = (desc: SchemaDesc): SchemaContent =>
	levelContent(
		desc.relations.map((r) => ({ name: r.name, digest: relationDigest(r) })),
		desc.statements.map(canonicalStatementOf),
		desc.extends === undefined ? undefined : contentOfDesc(desc.extends)
	)

/**
 * Whether `lower` is one of the levels of `higher`, higher itself or a level its extends chain reaches, compared by
 * content whatever name places them (as types/schema/schema.ts IsLevelOf states at the type level): the one level check
 * every entry point shares (role admission of a query entry, ChangeSet building, workload(...), login(...), a query's
 * and a ChangeSet's compilation against the Db's schema, program/schema.ts levelSchema).
 */
export const isLevelOf = (lower: SchemaContent, higher: SchemaContent): boolean => {
	for (let at: SchemaContent | undefined = higher; at !== undefined; at = at.below) {
		if (at.digest === lower.digest) {
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
