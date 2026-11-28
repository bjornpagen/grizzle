import { isPlainRecord } from "#compiler/core/record.ts"
import {
	descriptorCopy,
	isOwnedDescriptor,
	isTextDescriptor,
	writtenTypeOf
} from "#compiler/scalar/registry.ts"
import {
	type DeclaredEntries,
	mergedEntry,
	noDeclaredEntries
} from "#compiler/schema/declared-entries.ts"
import type { CanonicalStatement } from "#compiler/schema/own.ts"
import { isName, malformed, ownedCopy, ownedEntry } from "#compiler/schema/protocol.ts"
import { generatedFieldCopy } from "#compiler/schema/relation.ts"
import type { DeclaredEntry } from "#compiler/types/changeset/changeset.ts"

/** What law(...) takes for a catalog entry. */
const anEntry = "a catalog entry { name, source }, each a nonempty storable text, and nothing else"

/** What law(...) takes for the declaration it names. */
const aDeclaration =
	"a declaration a law comes from: a statement built by key, check, contained, mirrors, series, ordered, counted, tree or fold, a relation, a field generated(type, term) made, a str.regex, str.and or str.bytes type, or a domain"

/** A catalog entry its author declares, read once, here: a plain record of a name and a source, nonempty texts. */
const admitEntry = (entry: unknown): DeclaredEntry => {
	if (!isPlainRecord(entry) || Object.keys(entry).length !== 2) {
		throw malformed("law", anEntry)
	}
	const name = entry["name"]
	const source = entry["source"]
	if (!isName(name) || !isName(source)) {
		throw malformed("law", anEntry)
	}
	return Object.freeze({ kind: "declared", name, source })
}

/** A statement's canonical form with the entry its author declares, refused where law(...) already gave it one. */
const declaredIn = (canonical: CanonicalStatement, entry: DeclaredEntry): CanonicalStatement => {
	if (canonical.entry.kind === "declared") {
		throw malformed("law", "a statement no law(...) has given a catalog entry")
	}
	return Object.freeze({ ...canonical, entry })
}

/**
 * The entries law(...) declared, by the copy it returned: a relation's, for its primary key; a generated field's, for its
 * generated law; and a type's, a refined text's for its fields' pattern laws or a contract's for its law. A WeakMap holds
 * nothing alive and is never enumerated, so none is a cache.
 */
const declaredRelations = new WeakMap<object, DeclaredEntry>()

/** The entries law(...) declared at generated fields, by the copy it returned (`declaredRelations`'s kin). */
const declaredGenerated = new WeakMap<object, DeclaredEntry>()

/** The entries law(...) declared at types, by the copy it returned (`declaredRelations`'s kin). */
const declaredTypes = new WeakMap<object, DeclaredEntry>()

/** The entry `entries` holds for `value`; none for a value it holds none for, and for any value but an object. */
const declaredAt = (
	entries: WeakMap<object, DeclaredEntry>,
	value: unknown
): DeclaredEntry | undefined =>
	(typeof value === "object" || typeof value === "function") && value !== null
		? entries.get(value)
		: undefined

/** `copy`, held in `entries` with `entry`; refused where `value`, the declaration it copies, holds one already. */
const held = <S extends object>(
	entries: WeakMap<object, DeclaredEntry>,
	value: S,
	copy: S,
	entry: DeclaredEntry
): S => {
	if (declaredAt(entries, value) !== undefined) {
		throw malformed("law", "a declaration no law(...) has given a catalog entry")
	}
	entries.set(copy, entry)
	return copy
}

/**
 * law({ name, source }, declaration): a law's catalog entry, declared at the declaration the law comes from
 * (types/changeset LawEntry `declared`), held beside the declaration and outside its Description, so its identity, the
 * schema's fingerprint and the installation read none of it:
 *
 * - a statement, for every law it states, held beside its canonical form (own.ts CanonicalStatement);
 * - a relation, for its primary key's law;
 * - a field generated(type, term) made, for its generated law;
 * - a str.regex, str.and or str.bytes type, for the pattern law of every stored field it types, one entry for the type,
 *   whatever field it types;
 * - a contract, for its law.
 *
 * law(...) returns a copy of the declaration owned or registered as the declaration is, with the entry, and leaves the
 * declaration as it was (`declared`). A mutable and a race state no law; a value of any other kind declares none; and a
 * declaration given an entry already is refused (MalformedDescription).
 */

export const lawBuilder = <S extends object>(entry: unknown, declaration: S): S => {
	const named = admitEntry(entry)
	const expansion = ownedEntry(declaration, "expansion")
	if (expansion !== undefined) {
		const [left, right] = expansion.content.canonical
		return ownedCopy(declaration, {
			...expansion,
			content: {
				...expansion.content,
				canonical: [declaredIn(left, named), declaredIn(right, named)]
			}
		})
	}
	const stated = ownedEntry(declaration, "statement")
	if (stated !== undefined) {
		if (stated.desc.kind === "mutable" || stated.desc.kind === "race") {
			throw malformed("law", aDeclaration)
		}
		return ownedCopy(declaration, {
			...stated,
			content: { ...stated.content, canonical: declaredIn(stated.content.canonical, named) }
		})
	}
	const relation = ownedEntry(declaration, "relation")
	if (relation !== undefined) {
		return held(declaredRelations, declaration, ownedCopy(declaration, relation), named)
	}
	const generated = generatedFieldCopy(declaration)
	if (generated !== undefined) {
		return held(declaredGenerated, declaration, generated, named)
	}
	const type = descriptorCopy(declaration)
	if (type === undefined) {
		throw malformed("law", aDeclaration)
	}
	return held(declaredTypes, declaration, type, named)
}

/** The members of a value, read as a record; none for any other value. */
const membersOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	(typeof value === "object" || typeof value === "function") && value !== null
		? Object.fromEntries(Object.entries(value))
		: undefined

/**
 * The entries the declarations `values` of one level declare (schema/declared-entries.ts DeclaredEntries): each ordinary
 * relation's, for its primary key; each of its fields' a generated law's, where law(...) named the field; the entry of
 * the type of each of its stored fields, where law(...) named a str.regex, str.and or str.bytes type, for the field's
 * pattern law, the type's one entry at every field it types, a field of a writing of its own (a drawn, accumulated or
 * generated one) typed by the descriptor its values are of (registry.ts writtenTypeOf), as every reader types it; and
 * each contract's down every field's chain, grizzle's own natural as any other, by the contract's name. Two contracts
 * of one name that declare two entries are refused where the level is owned.
 */
export const declaredEntriesOf = (
	values: ReadonlyArray<unknown>,
	conflict: (what: string) => never
): DeclaredEntries => {
	const primaryKeys = new Map<string, DeclaredEntry>()
	const generated = new Map<string, Map<string, DeclaredEntry>>()
	const patterns = new Map<string, Map<string, DeclaredEntry>>()
	const contracts = new Map<string, DeclaredEntry>()
	const atField = (
		into: Map<string, Map<string, DeclaredEntry>>,
		relation: string,
		field: string,
		entry: DeclaredEntry
	): void => {
		const at = into.get(relation) ?? new Map<string, DeclaredEntry>()
		into.set(relation, at)
		at.set(field, entry)
	}
	for (const value of values) {
		const relation = ownedEntry(value, "relation")
		if (relation === undefined) {
			continue
		}
		const name = relation.desc.name
		const key = declaredAt(declaredRelations, value)
		if (key !== undefined) {
			primaryKeys.set(name, key)
		}
		for (const [field, member] of Object.entries(membersOf(relation.value.fields) ?? {})) {
			const generatedEntry = declaredAt(declaredGenerated, member)
			if (generatedEntry !== undefined) {
				atField(generated, name, field, generatedEntry)
			}
			const type = writtenTypeOf(member) ?? member
			const typeEntry = declaredAt(declaredTypes, type)
			if (typeEntry !== undefined && isTextDescriptor(type)) {
				atField(patterns, name, field, typeEntry)
			}
			for (
				let at: unknown = type;
				isOwnedDescriptor(at) && at.desc.kind === "domain";
				at = membersOf(at)?.["base"]
			) {
				const entry = declaredAt(declaredTypes, at)
				const contract = at.desc.name
				if (entry === undefined) {
					continue
				}
				const known = contracts.get(contract)
				if (known !== undefined && mergedEntry(known, entry) === undefined) {
					conflict(`the domain ${contract}`)
				}
				contracts.set(contract, entry)
			}
		}
	}
	return primaryKeys.size + generated.size + patterns.size + contracts.size === 0
		? noDeclaredEntries
		: Object.freeze({ primaryKeys, generated, patterns, contracts })
}
