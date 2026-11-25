import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { sameContent } from "#compiler/core/canonical.ts"
import { CompileError, undeclaredRelation } from "#compiler/core/errors.ts"
import { once } from "#compiler/core/lazy.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import {
	type AdmittedClosedRelation,
	builtNode,
	type FieldDesc,
	type FunctionDesc,
	type RelationDesc,
	type RosterDesc,
	type SchemaDesc,
	type SchemaRelationDesc,
	type StatementDesc,
	levelChain,
	schemaLevelDesc
} from "#compiler/ir/desc.ts"
import { type DeclaredEntries, mergedDeclared } from "#compiler/schema/declared-entries.ts"
import { fragmentName, fragmentReach } from "#compiler/schema/fragment.ts"
import { functionDescOf } from "#compiler/schema/function.ts"
import { declaredEntriesOf } from "#compiler/schema/law-entries.ts"
import { isLevelOver, type Level, levelOf } from "#compiler/schema/level.ts"
import {
	type BuiltSchemaContent,
	levelContent,
	type SchemaContent
} from "#compiler/schema/levels.ts"
import { type CanonicalStatement, ownBuilt } from "#compiler/schema/own.ts"
import {
	builderLoc,
	builderRefusal,
	frozenTuple,
	malformed,
	ownedDesc,
	ownedEntry,
	ownedEntryOf,
	ownValue,
	requireDeclaredName
} from "#compiler/schema/protocol.ts"
import { levelRecord, levelRecordOver } from "#compiler/schema/record.ts"
import {
	type DerivedDraft,
	derivedDraftOf,
	type OrdinaryRelationDesc,
	relationDescOf,
	rosterHandlesOf
} from "#compiler/schema/relation.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { AnyFunction } from "#compiler/types/schema/function.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type {
	AnyFragment,
	AnySchema,
	Declared,
	Extension,
	Fragment,
	FragmentsIn,
	Schema,
	StatementsByName,
	StatementsReadBack
} from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"

export const schemaDescOf = (value: unknown): SchemaDesc | undefined => ownedDesc(value, "schema")

/**
 * One declaration of a name a schema's build meets: a relation, closed relation, roster or derived relation value, a
 * level's list or a listed fragment holds it or a statement was built over it, and its meaning, its Description (a
 * derived relation's, its draft), whose location is where it was declared.
 */
interface Declaration {
	readonly value: unknown
	readonly meaning: OrdinaryRelationDesc | RosterDesc | AdmittedClosedRelation | DerivedDraft
}

const declarationOf = (value: unknown, label: string): Declaration => ({
	value,
	meaning: derivedDraftOf(value) ?? relationDescOf(value, label)
})

/**
 * A name declared twice differently: `later` refused, `earlier` the declaration it differs from, both where they were
 * written.
 */
/**
 * The level a derived relation's definition is written over (query/build/state.ts defineDesc's schema), none for a
 * value no builder made: what its type reads its level from (types/schema/schema.ts DerivedAt), which a definition that
 * imports a live derived relation of another schema as its definition leaves no read of to check.
 */
const definitionLevel = (value: unknown): Level | undefined => {
	const entry = ownedEntryOf(hasProperties(value) ? value["definition"] : undefined)
	return entry?.kind === "query" ? levelOf(entry.content.schema) : undefined
}

const declaredTwice = (later: Declaration, earlier: Declaration): CompileError =>
	CompileError.make({
		_tag: "DuplicateIdentity",
		at: later.meaning.loc,
		duplicate: { kind: "relation", name: later.meaning.name, earlier: earlier.meaning.loc }
	})

/**
 * Whether `d` is the first declaration of its name in its level, `declared` the level's so far and `below` every
 * level's below it. A name is one meaning: a later declaration of a name is the same declaration where its meaning is
 * the first one's, the lowest level's (sameContent, the semantic identity, which no source location is part of), so
 * the level records it once, and is refused (DuplicateIdentity) where it differs, the first one its earlier. A name a
 * level below declares alike is the level's own declaration too, which ownership owns once, at the lower level.
 */
const declaresFirst = (
	declared: Map<string, Declaration>,
	below: ReadonlyMap<string, Declaration>,
	d: Declaration
): boolean => {
	const prior = below.get(d.meaning.name) ?? declared.get(d.meaning.name)
	if (prior !== undefined && !sameContent(prior.meaning, d.meaning)) {
		throw declaredTwice(d, prior)
	}
	if (declared.has(d.meaning.name)) {
		return false
	}
	declared.set(d.meaning.name, d)
	return true
}

/**
 * Every relation a statement was built over is the schema's declaration of its name (statements.ts relationsOver): a
 * statement's Description names each by name alone, so one built over another relation of a declared name would be
 * read as a statement over the declared one. One of a name no level declares is refused as the statement's.
 */
const statementsDeclared = (
	statements: ReadonlyArray<LevelStatement>,
	declared: ReadonlyMap<string, Declaration>,
	below: ReadonlyMap<string, Declaration>,
	label: string
): void => {
	for (const s of statements) {
		for (const value of s.over) {
			const d = declarationOf(value, `${label} statement relation`)
			const prior = below.get(d.meaning.name) ?? declared.get(d.meaning.name)
			if (prior === undefined) {
				throw new CompileError(undeclaredRelation(s.desc.loc, d.meaning.name))
			}
			if (!sameContent(prior.meaning, d.meaning)) {
				throw declaredTwice(d, prior)
			}
		}
	}
}

/**
 * Whether `fn` is the first declaration of its name in its level, `declared` the level's functions so far and `below`
 * every level's below it: a later declaration whose Description is the first one's (sameContent) is that one, and one
 * that differs is refused (DuplicateIdentity), as a relation's is.
 */
const declaresFunction = (
	declared: Map<string, FunctionDesc>,
	below: ReadonlyMap<string, FunctionDesc>,
	fn: FunctionDesc
): boolean => {
	const prior = below.get(fn.name) ?? declared.get(fn.name)
	if (prior !== undefined && !sameContent(prior, fn)) {
		throw CompileError.make({
			_tag: "DuplicateIdentity",
			at: fn.loc,
			duplicate: { kind: "function", name: fn.name, earlier: prior.loc }
		})
	}
	if (prior !== undefined) {
		return false
	}
	declared.set(fn.name, fn)
	return true
}

/** Every function `desc` and the levels below it declare, by name, a higher level's declaration of a name its own. */
const levelFunctions = (desc: SchemaDesc): Map<string, FunctionDesc> => {
	const out = new Map<string, FunctionDesc>()
	for (const level of levelChain(desc)) {
		for (const fn of level.functions ?? []) {
			out.set(fn.name, fn)
		}
	}
	return out
}

/** A closed id's roster, through any depth of contracts; none for any other field. */
const closedIdRoster = (desc: FieldDesc): string | undefined =>
	desc.kind === "closedId"
		? desc.roster
		: desc.kind === "contract"
			? closedIdRoster(desc.base)
			: undefined

/**
 * Each closed relation of a level's declarations held to the schema's rosters, `rosters` the schema's relations by
 * name, the level's own among them: closed.relation() admitted its rows against the rosters its closed-id fields were
 * built over, so each of those rosters' handles must be one of the schema's roster of that name, and then each row's
 * is. A field over a roster the schema does not declare is ownership's refusal.
 */
const heldToRosters = (
	label: string,
	declarations: Iterable<Declaration>,
	rosters: ReadonlyMap<string, RelationDesc>
): void => {
	for (const { value, meaning } of declarations) {
		const desc = rosters.get(meaning.name)
		const fields = hasProperties(value) ? value["fields"] : undefined
		if (desc?.kind !== "closedRelation" || !hasProperties(fields)) {
			continue
		}
		for (const [field, type] of Object.entries(desc.fields)) {
			const roster = closedIdRoster(type)
			const declared = roster === undefined ? undefined : rosters.get(roster)
			const carried = rosterHandlesOf(fields[field])
			if (declared?.kind !== "closed" || carried === undefined) {
				continue
			}
			const held = new Set(declared.handles)
			const stray = carried.find((handle) => !held.has(handle))
			if (stray !== undefined) {
				throw malformed(
					`${label} relation ${desc.name}`,
					`a closed relation over the schema's roster ${declared.name}; its field ${field} is over another roster of that name, which holds ${JSON.stringify(stray)}`
				)
			}
		}
	}
}

/** The list of relations a caller handed in. */
const relationValues = (
	relations: unknown,
	label: string,
	what: string
): ReadonlyArray<unknown> => {
	if (!isList(relations)) {
		throw malformed(label, what)
	}
	return relations
}

/**
 * The catalog entries a level's list declares (law-entries.ts declaredEntriesOf), its relations' and its listed
 * fragments' together: two declarations of one law that declare two entries are refused (MalformedDescription), since
 * one law has one name.
 */
const levelEntries = (
	values: ReadonlyArray<unknown>,
	fragments: ReadonlyArray<{ readonly content: FragmentContent }>,
	label: string
): DeclaredEntries => {
	const conflict = (what: string): never => {
		throw malformed(label, `one catalog entry for ${what}: one law has one entry`)
	}
	return mergedDeclared(
		[declaredEntriesOf(values, conflict), ...fragments.map((f) => f.content.level.entries)],
		conflict
	)
}

/** The list of statements a caller handed in. */
const statementValues = (statements: unknown, label: string): ReadonlyArray<unknown> => {
	if (!isList(statements)) {
		throw malformed(label, "a list of statements")
	}
	return statements
}

/**
 * A statement of a level or a fragment: its Description, the canonical form its builder read (statements.ts
 * ownedStatement), and the relations it was built over.
 */
export interface LevelStatement {
	readonly desc: StatementDesc
	readonly canonical: CanonicalStatement
	readonly over: ReadonlyArray<unknown>
}

/**
 * A mirrors(...) or alternatives(...) value is one statement of the list, which the schema expands into the statements
 * it is sugar for: a mirrors' two containments, an alternatives law's containment and its arms' mirrors, in roster
 * order. Each is read with the canonical form its value carries from its build.
 */
const statementList = (
	statements: ReadonlyArray<unknown>,
	label: string
): ReadonlyArray<LevelStatement> =>
	statements.flatMap((s, i): ReadonlyArray<LevelStatement> => {
		if (isList(s)) {
			throw malformed(
				`${label} statement ${i}`,
				"a statement; alternatives(...) is one statement, not a list"
			)
		}
		const expansion = ownedEntry(s, "expansion")
		if (expansion !== undefined) {
			const [left, right] = expansion.desc.statements
			const [leftCanonical, rightCanonical] = expansion.content.canonical
			const over = expansion.content.over
			return [
				{ desc: left, canonical: leftCanonical, over },
				{ desc: right, canonical: rightCanonical, over }
			]
		}
		const statement = ownedEntry(s, "statement")
		if (statement === undefined) {
			throw malformed(
				`${label} statement ${i}`,
				"a statement built by key, mutable, race, check, contained, mirrors, alternatives, unit, series, ordered, counted, tree or fold"
			)
		}
		return [
			{ desc: statement.desc, canonical: statement.content.canonical, over: statement.content.over }
		]
	})

/**
 * What a schema builder's admission core reads of its arguments: the level's Description, its content, and the name
 * and value of each relation it declares, in list order, its record's entries.
 */
interface AdmittedLevel {
	readonly desc: SchemaDesc
	readonly content: SchemaContent
	readonly names: ReadonlyArray<readonly [string, unknown]>
}

/**
 * A fragment's Description: its name in diagnostics, which its relations give it (fragment.ts fragmentName), since it
 * declares none, and where it was built.
 */
export interface FragmentDesc {
	readonly name: string
	readonly loc: SourceLoc
}

/**
 * What a fragment was built with, read once at its build: its content, a root level's that lists no fragment (levels.ts
 * SchemaContent), which is its identity; each of its relations' declarations, in list order; and its statements.
 */
export interface FragmentContent {
	readonly level: SchemaContent
	readonly declarations: ReadonlyArray<FragmentDeclaration>
	readonly statements: ReadonlyArray<LevelStatement>
}

/** One relation a fragment declares: its value and its Description, never a derived relation's draft. */
interface FragmentDeclaration extends Declaration {
	readonly meaning: OrdinaryRelationDesc | RosterDesc | AdmittedClosedRelation
}

/**
 * The fragment a list item is, its value, Description and content, or undefined for any other item: a level's list
 * declares a fragment's relations at its place, in the fragment's order, and writes its statements.
 */
const listedFragment = (
	value: unknown
):
	| {
			readonly value: AnyFragment
			readonly desc: FragmentDesc
			readonly content: FragmentContent
	  }
	| undefined => ownedEntry(value, "fragment")

/**
 * Each fragment a level lists is the level's as it was built: no statement of the schema, at any of its levels or of
 * another fragment it lists, decides how one of the fragment's relations is written unless it is one of the
 * fragment's own (fragment.ts fragmentReach).
 */
const reachesListed = (
	fragments: ReadonlyArray<FragmentContent>,
	below: SchemaContent | undefined,
	statements: ReadonlyArray<LevelStatement>
): void => {
	if (fragments.length === 0) {
		return
	}
	const written: Array<CanonicalStatement> = statements.map((st) => st.canonical)
	for (let at = below; at !== undefined; at = at.below) {
		appendAll(written, at.canonical)
	}
	for (const f of fragments) {
		fragmentReach(f.level, written)
	}
}

/** The names and values of a level's declarations, in the order its list first declares each. */
const namesOf = (
	declared: ReadonlyMap<string, Declaration>
): ReadonlyArray<readonly [string, unknown]> =>
	[...declared].map(([name, d]) => [name, d.value] as const)

const noDeclarations: ReadonlyMap<string, Declaration> = new Map()

const noFunctions: ReadonlyMap<string, FunctionDesc> = new Map()

/**
 * The admission cores of schema(...) and schema.extend(...): a JavaScript caller's arguments checked and
 * described, the one path a schema's Description is built by.
 */
export const admitSchema = (
	name: unknown,
	relations: unknown,
	statements: unknown,
	extra: ReadonlyArray<unknown>
): AdmittedLevel => {
	const label = `schema ${typeof name === "string" ? name : "?"}`
	const schemaName = requireDeclaredName(name, label, "schema")
	if (extra.length > 0) {
		throw malformed(label, "schema(name, relations, statements): three arguments")
	}
	const values = relationValues(
		relations,
		label,
		"a list of relations, closed relations and fragments"
	)
	const declared = new Map<string, Declaration>()
	const descs: Array<SchemaRelationDesc> = []
	const functions = new Map<string, FunctionDesc>()
	const fragments: Array<{ readonly content: FragmentContent }> = []
	for (const [i, value] of values.entries()) {
		const listed = listedFragment(value)
		if (listed !== undefined) {
			for (const d of listed.content.declarations) {
				if (declaresFirst(declared, noDeclarations, d)) {
					descs.push(d.meaning)
				}
			}
			fragments.push(listed)
			continue
		}
		const fn = functionDescOf(value)
		if (fn !== undefined) {
			declaresFunction(functions, noFunctions, fn)
			continue
		}
		if (derivedDraftOf(value) !== undefined) {
			throw malformed(
				`${label} relation ${i}`,
				"a relation, closed relation or fragment: a derived relation is declared in schema.extend"
			)
		}
		const desc = relationDescOf(value, `${label} relation ${i}`)
		if (declaresFirst(declared, noDeclarations, { value, meaning: desc })) {
			descs.push(desc)
		}
	}
	heldToRosters(label, declared.values(), new Map(descs.map((d) => [d.name, d] as const)))
	const stmts = [
		...statementList(statementValues(statements, label), label),
		...fragments.flatMap((f) => f.content.statements)
	]
	statementsDeclared(stmts, declared, noDeclarations, label)
	reachesListed(
		fragments.map((f) => f.content),
		undefined,
		stmts
	)
	const desc = schemaLevelDesc({
		name: schemaName,
		relations: descs,
		statements: stmts.map((s) => s.desc),
		functions: [...functions.values()],
		bases: [],
		loc: builderLoc(label, [schemaName])
	})
	return {
		desc,
		content: levelContent(
			descs.map((d) => ({ name: d.name, desc: d })),
			stmts.map((s) => s.canonical),
			undefined,
			fragments.map((f) => f.content.level),
			levelEntries(values, fragments, label)
		),
		names: namesOf(declared)
	}
}

/**
 * A built schema's content: its level's, and the schema owned once, held by the value from its first read (levels.ts
 * BuiltSchemaContent), over the content of the levels below, each the content its own value carries.
 */
const builtContent = (admitted: AdmittedLevel): BuiltSchemaContent =>
	Object.freeze({
		...admitted.content,
		owned: once(() => ownBuilt({ desc: admitted.desc, content: admitted.content }))
	})

/**
 * schema(name, relations, statements). The relations are a list, held by name (record.ts levelRecord), each name's one
 * declaration; the statements a frozen copy, held by name and read back whole (types/schema/schema.ts
 * StatementsReadBack), which is Statements for every tuple a call writes.
 */
const rootSchema = <
	const Name extends string,
	const Relations extends ReadonlyArray<AnyRelation | AnyClosed | AnyFragment | AnyFunction>,
	const Statements extends ReadonlyArray<Statement>
>(
	name: Name,
	relations: Relations,
	statements: Statements & StatementsReadBack<Statements, Declared<Relations>>,
	extra: ReadonlyArray<unknown>
): Schema<
	Name,
	Declared<Relations>,
	StatementsByName<Statements, Declared<Relations>>,
	never,
	FragmentsIn<Relations>
> => {
	const admitted = admitSchema(name, relations, statements, extra)
	const read: StatementsReadBack<Statements, Declared<Relations>> = statements
	return ownValue({
		kind: "schema",
		value: {
			...builtMark,
			kind: "schema",
			name,
			relations: levelRecord<Relations>(admitted.names),
			statements: frozenTuple(read),
			listed: listedStatements(relations),
			bases: []
		},
		desc: admitted.desc,
		content: builtContent(admitted)
	})
}

/**
 * Every relation of `desc` and the levels below it, by name, the lowest level's declaration of a name, with the derived
 * level of each derived relation.
 */
const levelRelations = (desc: SchemaDesc): Map<string, RelationDesc> => {
	const out = new Map<string, RelationDesc>()
	for (const level of levelChain(desc)) {
		for (const r of level.relations) {
			out.getOrInsert(r.name, r)
		}
	}
	return out
}

/**
 * The one base a JavaScript caller's list of bases holds: a list of one schema built by schema(...) or schema.extend.
 * A base that is no list, the spelling before the list, is refused by the rule the types name (schema.extend takes its
 * bases as a list), and a list of several by theirs (a level over several bases is not built yet).
 */
const oneBase = (bases: unknown) => {
	if (!isList(bases)) {
		throw builderRefusal(
			"schema.extend",
			"schema.extend takes its bases as a list: schema.extend([base], name, relations, statements)"
		)
	}
	if (bases.length > 1) {
		throw builderRefusal(
			"schema.extend",
			"schema.extend takes one base: a level over several bases is not built yet"
		)
	}
	const baseEntry = ownedEntry(bases[0], "schema")
	if (baseEntry === undefined) {
		throw malformed("schema.extend", "[base], a base schema built by schema(...) or schema.extend")
	}
	return baseEntry
}

const admitExtend = (
	bases: unknown,
	name: unknown,
	relations: unknown,
	statements: unknown,
	extra: ReadonlyArray<unknown>
): AdmittedLevel => {
	const baseEntry = oneBase(bases)
	const baseDesc = baseEntry.desc
	const label = `schema.extend ${baseDesc.name} ${typeof name === "string" ? name : "?"}`
	const levelName = requireDeclaredName(name, label, "schema")
	if (extra.length > 0) {
		throw malformed(label, "schema.extend([base], name, relations, statements): four arguments")
	}
	const values = relationValues(
		relations,
		label,
		"a list of relations, closed and derived relations"
	)
	const below = levelRelations(baseDesc)
	const baseLevel: Level = {
		kind: "schema",
		value: baseEntry.value,
		desc: baseDesc,
		content: baseEntry.content
	}
	const lower = new Map(
		Object.entries(baseEntry.value.relations).map(
			([key, value]) => [key, declarationOf(value, `${label} base relation ${key}`)] as const
		)
	)
	const declared = new Map<string, Declaration>()
	const descs: Array<SchemaRelationDesc> = []
	const functions = new Map<string, FunctionDesc>()
	const lowerFunctions = levelFunctions(baseDesc)
	const fragments: Array<{ readonly content: FragmentContent }> = []
	for (const [i, value] of values.entries()) {
		const listed = listedFragment(value)
		if (listed !== undefined) {
			for (const d of listed.content.declarations) {
				if (declaresFirst(declared, lower, d)) {
					descs.push(d.meaning)
				}
			}
			fragments.push(listed)
			continue
		}
		const fn = functionDescOf(value)
		if (fn !== undefined) {
			declaresFunction(functions, lowerFunctions, fn)
			continue
		}
		const draft = derivedDraftOf(value)
		if (draft === undefined) {
			const desc = relationDescOf(value, `${label} relation ${i}`)
			if (declaresFirst(declared, lower, { value, meaning: desc })) {
				descs.push(desc)
			}
			continue
		}
		if (!declaresFirst(declared, lower, { value, meaning: draft })) {
			continue
		}
		let level = 1
		/** A definition written over no level of the schema it extends is refused before what it reads: a relation of its
		 * own level, which it may name, is no level below. */
		const over = definitionLevel(value)
		if (over !== undefined && !isLevelOver(over, baseLevel)) {
			throw builderRefusal(
				`${label} derived ${draft.name}`,
				"a derived definition is a query over a level of the schema it extends"
			)
		}
		for (const read of draft.reads) {
			const lowerRead = below.get(read)
			if (lowerRead === undefined) {
				throw malformed(
					`${label} derived ${draft.name}`,
					`a definition over the levels below it; it reads ${read}, which no level below declares`
				)
			}
			if (lowerRead.kind === "derived") {
				level = Math.max(level, lowerRead.level + 1)
			}
		}
		descs.push(
			builtNode({
				kind: "derived",
				name: draft.name,
				query: draft.query,
				level,
				loc: draft.loc
			})
		)
	}
	heldToRosters(
		label,
		declared.values(),
		new Map([...below, ...descs.map((d) => [d.name, d] as const)])
	)
	const stmts = [
		...statementList(statementValues(statements, label), label),
		...fragments.flatMap((f) => f.content.statements)
	]
	statementsDeclared(stmts, declared, lower, label)
	reachesListed(
		fragments.map((f) => f.content),
		baseEntry.content,
		stmts
	)
	const desc = schemaLevelDesc({
		name: levelName,
		relations: descs,
		statements: stmts.map((s) => s.desc),
		functions: [...functions.values()],
		bases: [baseDesc],
		loc: builderLoc(label, [levelName])
	})
	/** A derived relation's description is the level's own, as the level holds it; any other its value's. */
	const ownDeclared = [
		...descs.flatMap((d) => (d.kind === "derived" ? [] : [{ name: d.name, desc: d }])),
		...desc.relations.flatMap((r) => (r.kind === "derived" ? [{ name: r.name, desc: r }] : []))
	]
	return {
		desc,
		content: levelContent(
			ownDeclared,
			stmts.map((s) => s.canonical),
			baseEntry.content,
			fragments.map((f) => f.content.level),
			levelEntries(values, fragments, label)
		),
		names: namesOf(declared)
	}
}

/**
 * A level named `name` over its one base, `[base]`: relations, derived relations among them, and statements; the value
 * holds the base's relations, then each relation of its own list the base does not declare (record.ts levelRecordOver),
 * and the base's statements before its own, its own read back whole as the root's are over the record SpelledOver they
 * are spelled over (types/schema/schema.ts Extension), and its bases, `[base]`.
 */
const extend = <
	Base extends AnySchema,
	const Name extends string,
	const Relations extends ReadonlyArray<
		AnyRelation | AnyClosed | AnyDerived | AnyFragment | AnyFunction
	>,
	const Statements extends ReadonlyArray<Statement>,
	SpelledOver
>(
	bases: readonly [Base, ...ReadonlyArray<unknown>],
	name: Name,
	relations: Relations,
	statements: Statements & StatementsReadBack<Statements, SpelledOver>,
	extra: ReadonlyArray<unknown>
): Extension<Base, Name, Relations, Statements, SpelledOver> => {
	const admitted = admitExtend(bases, name, relations, statements, extra)
	const [base] = bases
	const below: Base["statements"] = base.statements
	const added: StatementsReadBack<Statements, SpelledOver> = statements
	const all: readonly [...Base["statements"], ...StatementsReadBack<Statements, SpelledOver>] = [
		...below,
		...added
	]
	Object.freeze(all)
	const listed: ReadonlyArray<
		Base["listed"][number] | FragmentsIn<Relations>["statements"][number]
	> = Object.freeze([...base.listed, ...listedStatements(relations)])
	return ownValue({
		kind: "schema",
		value: {
			...builtMark,
			kind: "schema",
			name,
			relations: levelRecordOver<Base["relations"], Relations>(base.relations, admitted.names),
			statements: all,
			listed,
			bases: [base]
		},
		desc: admitted.desc,
		content: builtContent(admitted)
	})
}

/**
 * The statements of the fragments a level's list holds, each fragment's in its own order and the fragments in the
 * list's, frozen: a listed fragment's statements are its level's, held apart from the level's own (Schema `listed`).
 */
const listedStatements = <Relations extends ReadonlyArray<unknown>>(
	relations: Relations
): ReadonlyArray<FragmentsIn<Relations>["statements"][number]> =>
	Object.freeze(
		relations
			.filter((item): item is FragmentsIn<Relations> => listedFragment(item) !== undefined)
			.flatMap((f): ReadonlyArray<FragmentsIn<Relations>["statements"][number]> => f.statements)
	)

/**
 * The admission core of fragment(...): a JavaScript caller's arguments checked and described, as a root level's are
 * (admitSchema) but for its name, which it has none of. Its list holds relations and closed relations alone: a derived
 * relation needs a level below it to read, and a fragment lists no fragment.
 */
const admitFragment = (
	relations: unknown,
	statements: unknown,
	extra: ReadonlyArray<unknown>
): {
	readonly desc: FragmentDesc
	readonly content: FragmentContent
	readonly names: ReadonlyArray<readonly [string, unknown]>
} => {
	const label = "fragment"
	if (extra.length > 0) {
		throw malformed(label, "fragment(relations, statements): two arguments")
	}
	const values = relationValues(relations, label, "a list of relations and closed relations")
	const declared = new Map<string, Declaration>()
	const declarations: Array<FragmentDeclaration> = []
	for (const [i, value] of values.entries()) {
		if (derivedDraftOf(value) !== undefined || listedFragment(value) !== undefined) {
			throw malformed(
				`${label} relation ${i}`,
				"a relation or closed relation: a fragment declares no derived relation, which reads a level below its own, and lists no fragment"
			)
		}
		const d: FragmentDeclaration = {
			value,
			meaning: relationDescOf(value, `${label} relation ${i}`)
		}
		if (declaresFirst(declared, noDeclarations, d)) {
			declarations.push(d)
		}
	}
	heldToRosters(
		label,
		declared.values(),
		new Map(declarations.map((d) => [d.meaning.name, d.meaning] as const))
	)
	const stmts = statementList(statementValues(statements, label), label)
	statementsDeclared(stmts, declared, noDeclarations, label)
	const level = levelContent(
		declarations.map((d) => ({ name: d.meaning.name, desc: d.meaning })),
		stmts.map((s) => s.canonical),
		undefined,
		[],
		levelEntries(values, [], label)
	)
	return {
		desc: Object.freeze({
			name: fragmentName(level),
			loc: builderLoc(label, [])
		}),
		content: Object.freeze({
			level,
			declarations: Object.freeze(declarations),
			statements: Object.freeze(stmts)
		}),
		names: namesOf(declared)
	}
}

/**
 * fragment(relations, statements): relations and the statements over them, which no schema declares as its own until
 * a schema lists the fragment among its relations, a library's declarations an application composes with its own. The
 * relations are a list, held by name (record.ts levelRecord), and the statements a frozen copy read back whole, as a
 * root schema holds its own (schema(...)). Its identity is its content (levels.ts SchemaContent): a fragment listed
 * twice, or reached through two libraries, is one. A schema that lists it declares its relations and writes its
 * statements at the level whose list holds it, and holds it as one of its levels (levels.ts isLevelOf), so a query or a
 * ChangeSet written over the fragment is a program of every schema that lists it, compiled there by generate as any
 * program over a level is. No statement of such a schema may decide how a relation of the fragment is written unless it
 * is the fragment's own (fragment.ts fragmentReach).
 */
export const fragmentBuilder = <
	const Relations extends ReadonlyArray<AnyRelation | AnyClosed>,
	const Statements extends ReadonlyArray<Statement>
>(
	relations: Relations,
	statements: Statements & StatementsReadBack<Statements, Declared<Relations>>,
	extra: ReadonlyArray<unknown>
): Fragment<Declared<Relations>, StatementsByName<Statements, Declared<Relations>>> => {
	const admitted = admitFragment(relations, statements, extra)
	const read: StatementsReadBack<Statements, Declared<Relations>> = statements
	return ownValue({
		kind: "fragment",
		value: {
			...builtMark,
			kind: "fragment",
			relations: levelRecord<Relations>(admitted.names),
			statements: frozenTuple(read)
		},
		desc: admitted.desc,
		content: admitted.content
	})
}

/**
 * schema and schema.extend.
 *
 * `schema(name, relations, statements)` records a list of relations and closed relations, held by name, and the
 * statements, which the type captures as a tuple. `schema.extend([base], name, relations, statements)` is a level of
 * its own over `base`: relations, derived relations among them, and statements, under its own name, which places its
 * relations in a PostgreSQL schema of their own; its Description records the base under `bases`. A level and every
 * level below it are one installation (schema/own.ts).
 *
 * A derived relation is declared only in an extension, and its definition reads only the levels below it: every
 * relation it names must be a relation of the base or a lower level, never one of its own level, so a dependency cycle
 * cannot be written. Its derived level is one more than the highest derived level it reads, 1 over base relations only
 * (ir/desc.ts RelationDesc).
 *
 * A level's list may hold fragments (fragment(...)): each declares its relations at its place in the list, in its own
 * order, and writes its statements after the level's own, and is one of the schema's levels. A statement of the schema
 * that decides how one of a listed fragment's relations is written, at any level or in another fragment, is refused
 * (FragmentRefused) unless it is one of the fragment's own.
 *
 * Relations are a list, not a record keyed by name: each relation carries its own name, and a record's key, which
 * repeated it, let a JavaScript spread of two records drop one of two declarations of a name before any builder saw it.
 * A list of two libraries' relations is their concatenation, which drops nothing, and the build holds every name to one
 * meaning: within the level, against every level below, and for every relation a statement was built over. Two
 * declarations of one name whose Descriptions agree are one declaration; with conflicting Descriptions the name is
 * claimed twice, which is DuplicateIdentity, at the later declaration with the earlier's location. Every other check of
 * the schema as a whole is ownership's (own.ts).
 *
 * Each builder is the one implementation of its value: its admission core first, then the literal of its arguments,
 * frozen copies, owned with the Description, so the value has its public type (types/schema/schema.ts Schema) by
 * construction. Its type parameters are as wide as that value allows; the typed facade (schema/api.ts) is a view that
 * narrows them to the public signatures.
 */
export const schemaBuilder: typeof rootSchema & { readonly extend: typeof extend } = Object.freeze(
	Object.assign(rootSchema, { extend })
)
