import type { DeclaredEntry, StatedEntry } from "#compiler/types/changeset/changeset.ts"

/**
 * What a schema's authors declare of their laws' catalog entries (law(...), schema/law-entries.ts), and how the
 * declarations of several levels read together: the schema's side of a law's name, which ownership reads
 * (schema/own.ts) and the runtime reads none of (runtime/law-entry.ts names a law from what it states and this).
 */

/** No entry declared: each law the statement states has its derived entry. */
export const derivedStatement: StatedEntry = Object.freeze({ kind: "derived" })

/**
 * The one entry of two statements that are one statement, or that state one law: the entry either declares, where one
 * does or both declare one alike; undefined where they declare two, which the schema refuses, since one law has one
 * name.
 */
export const mergedEntry = (a: StatedEntry, b: StatedEntry): StatedEntry | undefined => {
	if (a.kind === "derived") {
		return b
	}
	return b.kind === "derived" || (a.name === b.name && a.source === b.source) ? a : undefined
}

/**
 * The catalog entries a schema's authors declare for the laws no statement states, each at the declaration the law
 * comes from (law(...), schema/law-entries.ts): a relation's primary key's, by the relation; a generated field's, by
 * its relation and field; a refined text's pattern law's, by the relation and field its type types, the type's one entry
 * for every field it types; and a contract's, by the contract's name. A law none of these names derives its entry.
 */
export interface DeclaredEntries {
	readonly primaryKeys: ReadonlyMap<string, DeclaredEntry>
	readonly generated: ReadonlyMap<string, ReadonlyMap<string, DeclaredEntry>>
	readonly patterns: ReadonlyMap<string, ReadonlyMap<string, DeclaredEntry>>
	readonly contracts: ReadonlyMap<string, DeclaredEntry>
}

/** No entry declared at any declaration: a schema read from its description, whose values declare none. */
export const noDeclaredEntries: DeclaredEntries = Object.freeze({
	primaryKeys: new Map(),
	generated: new Map(),
	patterns: new Map(),
	contracts: new Map()
})

/** The entry `entries` holds for a field of a relation, by relation and field; none where it holds none. */
export const fieldEntry = (
	entries: ReadonlyMap<string, ReadonlyMap<string, DeclaredEntry>>,
	relation: string,
	field: string
): DeclaredEntry | undefined => entries.get(relation)?.get(field)

/**
 * The declared entries of declarations read together (DeclaredEntries), each key's one entry: where two declarations
 * of one relation, field or contract declare two entries, `conflict` names the key and its refusal is the caller's,
 * since one law has one name.
 */
export const mergedDeclared = (
	all: ReadonlyArray<DeclaredEntries>,
	conflict: (what: string) => never
): DeclaredEntries => {
	const one = (
		into: Map<string, DeclaredEntry>,
		key: string,
		entry: DeclaredEntry,
		what: string
	): void => {
		const known = into.get(key)
		if (known !== undefined && mergedEntry(known, entry) === undefined) {
			conflict(what)
		}
		into.set(key, entry)
	}
	const keyed = (
		pick: (e: DeclaredEntries) => ReadonlyMap<string, DeclaredEntry>,
		what: (key: string) => string
	): ReadonlyMap<string, DeclaredEntry> => {
		const into = new Map<string, DeclaredEntry>()
		for (const e of all) {
			for (const [key, entry] of pick(e)) {
				one(into, key, entry, what(key))
			}
		}
		return into
	}
	const byField = (
		pick: (e: DeclaredEntries) => ReadonlyMap<string, ReadonlyMap<string, DeclaredEntry>>,
		what: string
	): ReadonlyMap<string, ReadonlyMap<string, DeclaredEntry>> => {
		const into = new Map<string, Map<string, DeclaredEntry>>()
		for (const e of all) {
			for (const [relation, fields] of pick(e)) {
				const at = into.get(relation) ?? new Map<string, DeclaredEntry>()
				into.set(relation, at)
				for (const [field, entry] of fields) {
					one(at, field, entry, `the ${what} of ${relation}.${field}`)
				}
			}
		}
		return into
	}
	return Object.freeze({
		primaryKeys: keyed(
			(e) => e.primaryKeys,
			(r) => `the primary key of ${r}`
		),
		generated: byField((e) => e.generated, "generated field"),
		patterns: byField((e) => e.patterns, "pattern"),
		contracts: keyed(
			(e) => e.contracts,
			(c) => `the domain ${c}`
		)
	})
}
