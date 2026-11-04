import { CompileError } from "#compiler/core/errors.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { isList } from "#compiler/core/record.ts"
import {
	decodeDesc,
	descText,
	type RelationDesc,
	type SchemaDesc,
	type StatementDesc
} from "#compiler/ir/desc.ts"

import {
	builderLoc,
	frozenCopy,
	frozenTuple,
	isPlainRecord,
	malformed,
	orThrow,
	ownedDesc,
	ownValue,
	requireName
} from "#compiler/schema/protocol.ts"
import { derivedDraftOf, relationDescOf } from "#compiler/schema/relation.ts"
import { alternativesDescOf, statementDescOf } from "#compiler/schema/statements.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema, Schema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"

export const schemaDescOf = (value: unknown): SchemaDesc | undefined => ownedDesc(value, "schema")

const identity = (desc: unknown): string => orThrow(descText(desc))

/** Adds `desc` to a level's declarations unless an equal declaration of its name is already there; a conflicting one
 * is refused. */
const addRelation = (descs: Array<RelationDesc>, desc: RelationDesc): void => {
	const prior = descs.find((r) => r.name === desc.name)
	if (prior === undefined) {
		descs.push(desc)
		return
	}
	if (identity(prior) === identity(desc)) {
		return
	}
	throw CompileError.make({
		_tag: "DuplicateIdentity",
		at: desc.loc,
		duplicate: { kind: "relation", name: desc.name, earlier: prior.loc }
	})
}

/** The list of statements a caller handed in. */
const statementValues = (statements: unknown, label: string): ReadonlyArray<unknown> => {
	if (!isList(statements)) {
		throw malformed(label, "a list of statements")
	}
	return statements
}

/**
 * An alternatives(...) value is one statement of the list, which the schema expands into its containment and mirrors,
 * in roster order.
 */
const statementList = (
	statements: ReadonlyArray<unknown>,
	label: string
): ReadonlyArray<StatementDesc> =>
	statements.flatMap((s, i) => {
		if (isList(s)) {
			throw malformed(
				`${label} statement ${i}`,
				"a statement; alternatives(...) is one statement, not a list"
			)
		}
		const expansion = alternativesDescOf(s)
		if (expansion !== undefined) {
			return expansion.statements
		}
		const desc = statementDescOf(s)
		if (desc === undefined) {
			throw malformed(
				`${label} statement ${i}`,
				"a statement built by key, mutable, check, contained, mirrors, alternatives or capacity"
			)
		}
		return [desc]
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
): SchemaDesc => {
	const label = `schema ${typeof name === "string" ? name : "?"}`
	const schemaName = requireName(name, label, "a schema name")
	if (extra.length > 0) {
		throw malformed(label, "schema(name, relations, statements): three arguments")
	}
	if (!isPlainRecord(relations)) {
		throw malformed(label, "a record of relations and closed relations")
	}
	const descs: Array<RelationDesc> = []
	for (const [key, value] of Object.entries(relations)) {
		if (derivedDraftOf(value) !== undefined) {
			throw malformed(
				`${label} relation ${key}`,
				"a relation or closed relation: a derived relation is declared in schema.extend"
			)
		}
		addRelation(descs, relationDescOf(value, `${label} relation ${key}`))
	}
	const stmts = statementList(statementValues(statements, label), label)
	return orThrow(
		decodeDesc("schema", {
			name: schemaName,
			relations: descs,
			statements: stmts,
			loc: builderLoc(label, [schemaName])
		})
	)
}

/**
 * schema(name, relations, statements). The relations are a frozen copy, and the statements a frozen copy, `readonly
 * [...Statements]`, which is Statements for every tuple a call writes.
 */
const rootSchema = <
	const Name extends string,
	const Relations extends Readonly<Record<string, AnyRelation | AnyClosed>>,
	const Statements extends ReadonlyArray<Statement>
>(
	name: Name,
	relations: Relations,
	statements: Statements,
	extra: ReadonlyArray<unknown>
): Schema<Name, Relations, readonly [...Statements]> => {
	const desc = admitSchema(name, relations, statements, extra)
	return ownValue(
		{
			...builtMark,
			name,
			relations: frozenCopy(relations),
			statements: frozenTuple<Statements>(statements),
			extends: undefined
		},
		"schema",
		desc
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
	relations: unknown,
	statements: unknown,
	extra: ReadonlyArray<unknown>
): SchemaDesc => {
	const baseDesc = schemaDescOf(base)
	if (baseDesc === undefined) {
		throw malformed("schema.extend", "a base schema built by schema(...) or schema.extend")
	}
	const label = `schema.extend ${baseDesc.name}`
	if (extra.length > 0) {
		throw malformed(label, "schema.extend(base, relations, statements): three arguments")
	}
	if (!isPlainRecord(relations)) {
		throw malformed(label, "a record of relations, closed and derived relations")
	}
	const below = levelRelations(baseDesc)
	const descs: Array<RelationDesc> = []
	for (const [key, value] of Object.entries(relations)) {
		const draft = derivedDraftOf(value)
		if (draft === undefined) {
			addRelation(descs, relationDescOf(value, `${label} relation ${key}`))
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
		addRelation(descs, {
			kind: "derived",
			name: draft.name,
			query: draft.query,
			level,
			loc: draft.loc
		})
	}
	const stmts = statementList(statementValues(statements, label), label)
	return orThrow(
		decodeDesc("schema", {
			name: baseDesc.name,
			relations: descs,
			statements: stmts,
			extends: baseDesc,
			loc: builderLoc(label, [baseDesc.name, "extend"])
		})
	)
}

/**
 * Adds relations, derived relations among them, and statements to `base`, under its name; the value holds the base's
 * relations and statements before its own, and the base it extends.
 */
const extend = <
	Base extends AnySchema,
	const Relations extends Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived>>,
	const Statements extends ReadonlyArray<Statement>
>(
	base: Base,
	relations: Relations,
	statements: Statements,
	extra: ReadonlyArray<unknown>
): Schema<
	Base["name"],
	Base["relations"] & Relations,
	readonly [...Base["statements"], ...Statements],
	Base
> => {
	const desc = admitExtend(base, relations, statements, extra)
	const below: Base["statements"] = base.statements
	const added: Statements = statements
	const all: readonly [...Base["statements"], ...Statements] = [...below, ...added]
	Object.freeze(all)
	return ownValue(
		{
			...builtMark,
			name: base.name,
			relations: frozenCopy({ ...base.relations, ...relations }),
			statements: all,
			extends: base
		},
		"schema",
		desc
	)
}

/**
 * schema and schema.extend.
 *
 * `schema(name, relations, statements)` records relations and closed relations, under the property names the caller
 * chose, and the statements, which the type captures as a tuple. `schema.extend(base, relations,
 * statements)` adds relations, derived relations among them, and statements under the base's name: the extension is
 * one installation in one PostgreSQL schema, and its Description records the base under `extends`.
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
