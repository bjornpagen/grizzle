import { builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList, isPlainRecord } from "#compiler/core/record.ts"
import {
	builtNode,
	contentDigest,
	type FieldDesc,
	type RelationDesc,
	type SchemaDesc,
	type SchemaRelationDesc,
	type StatementDesc,
	schemaLevelDesc
} from "#compiler/ir/desc.ts"
import { type LevelRelation, levelContent, type SchemaContent } from "#compiler/schema/levels.ts"
import type { CanonicalStatement } from "#compiler/schema/own.ts"
import {
	builderLoc,
	frozenCopy,
	frozenTuple,
	malformed,
	ownedDesc,
	ownedEntry,
	ownValue,
	requireName
} from "#compiler/schema/protocol.ts"
import { derivedDraftOf, relationContentOf, rosterHandlesOf } from "#compiler/schema/relation.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type {
	AnySchema,
	Schema,
	StatementsBelow,
	StatementsByName,
	StatementsReadBack
} from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"

export const schemaDescOf = (value: unknown): SchemaDesc | undefined => ownedDesc(value, "schema")

/** What a schema builder's admission core reads of its arguments: the level's Description and its content. */
interface AdmittedLevel {
	readonly desc: SchemaDesc
	readonly content: SchemaContent
}

/**
 * A level's record is its index by name: each relation sits under its own name, as a role's whole entries do. The
 * record's keys are then the level's names, each once, so a lookup by name is one property read, no name index is
 * derived from the record, and no level declares one name twice.
 */
const underOwnName = <D extends RelationDesc>(label: string, key: string, desc: D): D => {
	if (desc.name !== key) {
		throw malformed(
			`${label} relation ${key}`,
			`a relation under its own name; ${key} holds the relation ${desc.name}`
		)
	}
	return desc
}

/** A closed id's roster, through any depth of contracts; none for any other field. */
const closedIdRoster = (desc: FieldDesc): string | undefined =>
	desc.kind === "closedId"
		? desc.roster
		: desc.kind === "contract"
			? closedIdRoster(desc.base)
			: undefined

/**
 * Each closed relation of a level's record held to the schema's rosters, `rosters` the schema's relations by name, the
 * level's own among them: closed.relation()
 * admitted its rows against the rosters its closed-id fields were built over, so each of those rosters' handles must
 * be one of the schema's roster of that name, and then each row's is. A field over a roster the schema does not
 * declare is ownership's refusal.
 */
const heldToRosters = (
	label: string,
	record: Readonly<Record<string, unknown>>,
	rosters: ReadonlyMap<string, RelationDesc>
): void => {
	for (const [key, value] of Object.entries(record)) {
		const desc = rosters.get(key)
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
					`${label} relation ${key}`,
					`a closed relation over the schema's roster ${declared.name}; its field ${field} is over another roster of that name, which holds ${JSON.stringify(stray)}`
				)
			}
		}
	}
}

/** The list of statements a caller handed in. */
const statementValues = (statements: unknown, label: string): ReadonlyArray<unknown> => {
	if (!isList(statements)) {
		throw malformed(label, "a list of statements")
	}
	return statements
}

/** A statement of a level: its Description and the canonical form its builder read (statements.ts ownedStatement). */
interface LevelStatement {
	readonly desc: StatementDesc
	readonly canonical: CanonicalStatement
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
			const [leftCanonical, rightCanonical] = expansion.content
			return [
				{ desc: left, canonical: leftCanonical },
				{ desc: right, canonical: rightCanonical }
			]
		}
		const statement = ownedEntry(s, "statement")
		if (statement === undefined) {
			throw malformed(
				`${label} statement ${i}`,
				"a statement built by key, mutable, check, contained, mirrors, alternatives, ordered, counted, tree or fold"
			)
		}
		return [{ desc: statement.desc, canonical: statement.content }]
	})

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
	const schemaName = requireName(name, label, "a schema name")
	if (extra.length > 0) {
		throw malformed(label, "schema(name, relations, statements): three arguments")
	}
	if (!isPlainRecord(relations)) {
		throw malformed(label, "a record of relations and closed relations")
	}
	const descs: Array<SchemaRelationDesc> = []
	const digests: Array<LevelRelation> = []
	for (const [key, value] of Object.entries(relations)) {
		if (derivedDraftOf(value) !== undefined) {
			throw malformed(
				`${label} relation ${key}`,
				"a relation or closed relation: a derived relation is declared in schema.extend"
			)
		}
		const relation = relationContentOf(value, `${label} relation ${key}`)
		descs.push(underOwnName(label, key, relation.desc))
		digests.push({ name: key, digest: relation.digest })
	}
	heldToRosters(label, relations, new Map(descs.map((d) => [d.name, d] as const)))
	const stmts = statementList(statementValues(statements, label), label)
	const desc = schemaLevelDesc({
		name: schemaName,
		relations: descs,
		statements: stmts.map((s) => s.desc),
		extends: undefined,
		loc: builderLoc(label, [schemaName])
	})
	return {
		desc,
		content: levelContent(
			digests,
			stmts.map((s) => s.canonical),
			undefined
		)
	}
}

/**
 * schema(name, relations, statements). The relations are a frozen copy, and the statements a frozen copy, held by name
 * and read back whole (types/schema/schema.ts StatementsReadBack), which is Statements for every tuple a call writes.
 */
const rootSchema = <
	const Name extends string,
	const Relations extends Readonly<Record<string, AnyRelation | AnyClosed>>,
	const Statements extends ReadonlyArray<Statement>
>(
	name: Name,
	relations: Relations,
	statements: Statements & StatementsReadBack<Statements, Relations>,
	extra: ReadonlyArray<unknown>
): Schema<Name, Relations, StatementsByName<Statements, Relations>> => {
	const admitted = admitSchema(name, relations, statements, extra)
	const read: StatementsReadBack<Statements, Relations> = statements
	return ownValue(
		{
			...builtMark,
			kind: "schema",
			name,
			relations: frozenCopy(relations),
			statements: frozenTuple(read),
			extends: undefined
		},
		"schema",
		admitted.desc,
		admitted.content
	)
}

/** Every relation of `desc` and the levels below it, by name, with the derived level of each derived relation. */
const levelRelations = (desc: SchemaDesc): Map<string, RelationDesc> => {
	const out =
		desc.extends === undefined ? new Map<string, RelationDesc>() : levelRelations(desc.extends)
	for (const r of desc.relations) {
		if (!out.has(r.name)) {
			out.set(r.name, r)
		}
	}
	return out
}

const admitExtend = (
	base: unknown,
	name: unknown,
	relations: unknown,
	statements: unknown,
	extra: ReadonlyArray<unknown>
): AdmittedLevel => {
	const baseEntry = ownedEntry(base, "schema")
	if (baseEntry === undefined) {
		throw malformed("schema.extend", "a base schema built by schema(...) or schema.extend")
	}
	const baseDesc = baseEntry.desc
	const label = `schema.extend ${baseDesc.name} ${typeof name === "string" ? name : "?"}`
	const levelName = requireName(name, label, "a schema name")
	if (extra.length > 0) {
		throw malformed(label, "schema.extend(base, name, relations, statements): four arguments")
	}
	if (!isPlainRecord(relations)) {
		throw malformed(label, "a record of relations, closed and derived relations")
	}
	const below = levelRelations(baseDesc)
	const descs: Array<SchemaRelationDesc> = []
	const digests: Array<LevelRelation> = []
	for (const [key, value] of Object.entries(relations)) {
		const draft = derivedDraftOf(value)
		if (draft === undefined) {
			const relation = relationContentOf(value, `${label} relation ${key}`)
			descs.push(underOwnName(label, key, relation.desc))
			digests.push({ name: key, digest: relation.digest })
			continue
		}
		let level = 1
		for (const read of draft.reads) {
			const lower = below.get(read)
			if (lower === undefined) {
				throw malformed(
					`${label} derived ${draft.name}`,
					`a definition over the levels below it; it reads ${read}, which no level below declares`
				)
			}
			if (lower.kind === "derived") {
				level = Math.max(level, lower.level + 1)
			}
		}
		descs.push(
			underOwnName(
				label,
				key,
				builtNode({
					kind: "derived",
					name: draft.name,
					query: draft.query,
					level,
					storage: draft.storage,
					loc: draft.loc
				})
			)
		)
	}
	heldToRosters(label, relations, new Map([...below, ...descs.map((d) => [d.name, d] as const)]))
	const stmts = statementList(statementValues(statements, label), label)
	const desc = schemaLevelDesc({
		name: levelName,
		relations: descs,
		statements: stmts.map((s) => s.desc),
		extends: baseDesc,
		loc: builderLoc(label, [levelName])
	})
	/** A derived relation's description is the level's own, digested as the level holds it. */
	const derived = desc.relations.flatMap((r) =>
		r.kind === "derived" ? [{ name: r.name, digest: contentDigest("relation", r) }] : []
	)
	return {
		desc,
		content: levelContent(
			[...digests, ...derived],
			stmts.map((s) => s.canonical),
			baseEntry.content
		)
	}
}

/**
 * A level named `name` over `base`: relations, derived relations among them, and statements; the value holds the
 * base's relations and statements before its own, its own read back whole as the root's are, and the base it extends.
 */
const extend = <
	Base extends AnySchema,
	const Name extends string,
	const Relations extends Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived>>,
	const Statements extends ReadonlyArray<Statement>
>(
	base: Base & { readonly statements: StatementsBelow<Base> },
	name: Name,
	relations: Relations,
	statements: Statements & StatementsReadBack<Statements, Base["relations"] & Relations>,
	extra: ReadonlyArray<unknown>
): Schema<
	Name,
	Base["relations"] & Relations,
	StatementsByName<Statements, Base["relations"] & Relations>,
	Base
> => {
	const admitted = admitExtend(base, name, relations, statements, extra)
	const below: StatementsBelow<Base> = base.statements
	const added: StatementsReadBack<Statements, Base["relations"] & Relations> = statements
	const all: readonly [
		...StatementsBelow<Base>,
		...StatementsReadBack<Statements, Base["relations"] & Relations>
	] = [...below, ...added]
	Object.freeze(all)
	return ownValue(
		{
			...builtMark,
			kind: "schema",
			name,
			relations: frozenCopy({ ...base.relations, ...relations }),
			statements: all,
			extends: base
		},
		"schema",
		admitted.desc,
		admitted.content
	)
}

/**
 * schema and schema.extend.
 *
 * `schema(name, relations, statements)` records relations and closed relations, each under its own name, and the
 * statements, which the type captures as a tuple. `schema.extend(base, name, relations, statements)` is a level of its
 * own over `base`: relations, derived relations among them, and statements, under its own name, which places its
 * relations in a PostgreSQL schema of their own; its Description records the base under `extends`. A level and every
 * level below it are one installation (schema/own.ts).
 *
 * A derived relation is declared only in an extension, and its definition reads only the levels below it: every
 * relation it names must be a relation of the base or a lower level, never one of its own level, so a dependency
 * cycle cannot be written. Its derived level is one more than the highest derived level it reads, 1 over
 * base relations only (ir/desc.ts RelationDesc).
 *
 * Two relation values with one name in one record are one declaration when their Descriptions agree; with conflicting
 * Descriptions the name is claimed twice, which is DuplicateIdentity. Every other check of the schema as
 * a whole is ownership's (own.ts).
 *
 * Each builder is the one implementation of its value: its admission core first, then the literal of its arguments,
 * frozen copies, owned with the Description, so the value has its public type (types/schema/schema.ts Schema) by
 * construction. Its type parameters are as wide as that value allows; the typed facade (schema/api.ts) is a view that
 * narrows them to the public signatures.
 */
export const schema: typeof rootSchema & { readonly extend: typeof extend } = Object.freeze(
	Object.assign(rootSchema, { extend })
)
