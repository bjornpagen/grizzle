import * as Result from "@bjornpagen/grizzle-text/base/result"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { CompileError, malformedDescription, type RoleAccess } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { decodeDesc, type QueryDesc, type RoleDesc, type SchemaDesc } from "#compiler/ir/desc.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import { publicDesc, queryState } from "#compiler/query/build/state.ts"
import { admitSchemaDesc } from "#compiler/schema/admit.ts"
import { unheldOf } from "#compiler/schema/level.ts"
import {
	type BuiltSchemaContent,
	contentOfDesc,
	isLevelOf,
	levelRelations,
	type SchemaContent,
	sameRoleLevel
} from "#compiler/schema/levels.ts"
import { type Owned, ownBuiltRole, ownedOf } from "#compiler/schema/own.ts"
import { ownedEntry } from "#compiler/schema/protocol.ts"
import type { FragmentDesc } from "#compiler/schema/schema.ts"
import { type BuiltRoleLevel, roleLevelOver } from "#compiler/schema/world.ts"

/**
 * What a program is given, parsed once where it is given: a schema, a role or a fragment its builders made, or a
 * Description decoded from any other value (SchemaInput, Over), and a query value or a bare query Description
 * (QueryInput), with the level rule a value built over one schema is compiled against another by (levelSchema). Parsing
 * reads what the builders recorded and compiles nothing, so the builders that parse what they are given (a workload,
 * program/workload/value.ts) load none of the compiler; program/schema.ts compiles a parsed schema's artifacts and
 * program/compile.ts a parsed query.
 */

/**
 * The schema a compilation is given, parsed once: a value schema(...) or schema.extend built, with the description and
 * the content its builder recorded; an Owned own() returned, with its description; a SchemaDesc decoded from any other
 * value; or a role role(...) built, with its description and its level. An Owned's and a decoded description's content
 * is read where it is parsed, the one place such a value enters (levels.ts contentOfDesc).
 */
export type SchemaInput =
	| {
			readonly kind: "built"
			readonly value: object
			readonly desc: SchemaDesc
			readonly content: BuiltSchemaContent
	  }
	| {
			readonly kind: "owned"
			readonly owned: Owned
			readonly desc: SchemaDesc
			readonly content: SchemaContent
	  }
	| { readonly kind: "desc"; readonly desc: SchemaDesc; readonly content: SchemaContent }
	| { readonly kind: "role"; readonly desc: RoleDesc; readonly level: BuiltRoleLevel }

/** A role value role(...) built, parsed: its Description, and its level as role(...) read it once. */
const builtRole = (role: {
	readonly desc: RoleDesc
	readonly content: BuiltRoleLevel
}): ParsedRole => Object.freeze({ kind: "role", desc: role.desc, level: role.content })

/**
 * A schema input, or the decoder's own refusal of it, its path included: the one door a schema value passes, once, so
 * every reader past it takes the SchemaInput it parsed to. A value no builder made is the caller's, read once at the
 * builder's boundary (query/build/host.ts hostArguments) before it is decoded, so one whose reading throws is refused
 * as MalformedDescription, never a defect.
 */
export const parseSchemaInput = (value: unknown): Result.Result<SchemaInput, CompileError> => {
	const owned = ownedOf(value)
	if (owned !== undefined) {
		return Result.ok(
			Object.freeze<SchemaInput>({
				kind: "owned",
				owned,
				desc: owned.desc,
				content: contentOfDesc(owned.desc)
			})
		)
	}
	const role = ownedEntry(value, "role")
	if (role !== undefined) {
		return Result.ok(builtRole(role))
	}
	const built = ownedEntry(value, "schema")
	if (built !== undefined) {
		return Result.ok(
			Object.freeze<SchemaInput>({
				kind: "built",
				value: built.value,
				desc: built.desc,
				content: built.content
			})
		)
	}
	return Result.flatMap(
		catchCompileError(() => hostArguments("schema", [value])),
		() =>
			Result.map(admitSchemaDesc(value), (desc) =>
				Object.freeze<SchemaInput>({ kind: "desc", desc, content: contentOfDesc(desc) })
			)
	)
}

/**
 * What a program is written over, parsed once: a schema input (SchemaInput), or a fragment fragment(...) built, with
 * its Description and its content, a root level's (schema/schema.ts fragmentBuilder). A fragment is never what a
 * program compiles against: it installs nothing, and a program over it is compiled against a schema that lists it, or a
 * role that holds it whole (levelSchema).
 */
export type Over =
	| SchemaInput
	| {
			readonly kind: "fragment"
			readonly value: object
			readonly desc: FragmentDesc
			readonly content: SchemaContent
	  }

/** What a program value was written over, or the decoder's refusal of it: a fragment, or a schema input. */
export const parseOver = (value: unknown): Result.Result<Over, CompileError> => {
	const fragment = ownedEntry(value, "fragment")
	return fragment === undefined
		? parseSchemaInput(value)
		: Result.ok(
				Object.freeze<Over>({
					kind: "fragment",
					value: fragment.value,
					desc: fragment.desc,
					content: fragment.content.level
				})
			)
}

/** A schema value schema(...) or schema.extend built, parsed: what Db.open is given, read once there. */
export type BuiltSchema = Extract<SchemaInput, { readonly kind: "built" }>

/**
 * A schema input of a schema, not a role, with its content: what a login is over and an installation installs, a value
 * schema(...) or schema.extend built, an Owned, or a Description.
 */
export type BaseInput = Exclude<SchemaInput, ParsedRole>

/**
 * A role parsed: its Description and its level (schema/world.ts BuiltRoleLevel), what a role's programs compile against
 * and what a login's compile reads of each of its roles. It holds no value, so nothing past the door a role enters by
 * can read one again. A role value enters by parseRole, or by parseSchemaInput as every schema value does, and a role's
 * Description over its base's Owned by roleOfDesc; no reader can tell which door a role entered by.
 */
export type ParsedRole = Extract<SchemaInput, { readonly kind: "role" }>

/**
 * The parsed role a value is, or the refusal of any other value at `loc`: a value role(...) did not build. Its level is
 * the one role(...) read once, at its build (schema/world.ts BuiltRoleLevel).
 */
export const parseRole = (
	value: unknown,
	loc: SourceLoc
): Result.Result<ParsedRole, CompileError> => {
	const role = ownedEntry(value, "role")
	return role === undefined
		? Result.err(malformedDescription(loc, "a role built by role(...)"))
		: Result.ok(builtRole(role))
}

/**
 * A role read from its Description, over the Owned `base` of the schema its Description is over: its level read from
 * the descriptions (schema/world.ts roleLevelOver), its base's content as a schema's is read from its description
 * (schema/levels.ts contentOfDesc), and the role owned over `base` once, where it is first read, as a built role's level
 * owns it over its base's Owned. A role role(...) built over that base, from that Description, parses to one level with
 * it (parseRole, schema/levels.ts sameRoleLevel).
 */
export const roleOfDesc = (desc: RoleDesc, base: Owned): ParsedRole =>
	Object.freeze({
		kind: "role",
		desc,
		level: roleLevelOver(desc, contentOfDesc(desc.base), levelRelations(desc.base), () =>
			ownBuiltRole(desc, base)
		)
	})

/**
 * The built schema a value is, or the refusal of any other value at `loc`: a value no schema builder made, an
 * Owned or a bare SchemaDesc among them.
 */
export const parseBuiltSchema = (
	value: unknown,
	loc: SourceLoc
): Result.Result<BuiltSchema, CompileError> => {
	const entry = ownedEntry(value, "schema")
	if (entry === undefined) {
		return Result.err(
			malformedDescription(loc, "a schema built by schema(...) or schema.extend(...)")
		)
	}
	return Result.ok(
		Object.freeze<BuiltSchema>({
			kind: "built",
			value: entry.value,
			desc: entry.desc,
			content: entry.content
		})
	)
}

/**
 * How a value built over `carried` relates to `named`, the schema it is compiled against: one of its levels (reality
 * over a level of itself by content or a fragment it lists, schema/levels.ts isLevelOf, the one level check; a role over
 * itself; a role over a level of its base whose every relation it holds whole, the empty level among them, which every
 * role holds; a role over a fragment of its base whose every relation it holds whole); a level or a fragment of the base
 * of a role that holds not every relation of it whole, whose program reads relations outside the role (`access`); or
 * neither.
 */
type Level =
	| { readonly kind: "level" }
	| { readonly kind: "outsideRole"; readonly role: string; readonly access: RoleAccess }
	| { readonly kind: "none" }

const level: Level = { kind: "level" }
const none: Level = { kind: "none" }

const levelOf = (carried: Over, named: SchemaInput): Level => {
	if (named.kind !== "role") {
		return carried.kind !== "role" && isLevelOf(carried.content, named.content) ? level : none
	}
	if (carried.kind === "role") {
		return sameRoleLevel(carried.level, named.level) ? level : none
	}
	if (!isLevelOf(carried.content, named.level.base)) {
		return none
	}
	const outside = (access: RoleAccess): Level => ({
		kind: "outsideRole",
		role: named.desc.name,
		access
	})
	if (carried.kind === "fragment") {
		const unheld = unheldOf(carried.content, named.level)
		return unheld === undefined
			? level
			: outside({ kind: "read", relation: unheld, base: named.desc.base.name })
	}
	return isLevelOf(carried.content, named.level.whole)
		? level
		: outside({ kind: "wholeBase", base: named.desc.base.name })
}

/**
 * The schema a value built over the schema or fragment `carried` describes compiles against when the caller names
 * `named`: `named` itself, when `carried` is one of its levels (levelOf); OutsideRole for a level or a fragment of the
 * base of a role that holds not every relation of it whole, which only a JavaScript caller reaches (the types refuse
 * it); otherwise a MalformedDescription at `loc`, before any SQL.
 */
export const levelSchema = (
	carried: Over,
	named: SchemaInput,
	loc: SourceLoc
): Result.Result<SchemaInput, CompileError> => {
	const l = levelOf(carried, named)
	switch (l.kind) {
		case "level":
			return Result.ok(named)
		case "outsideRole":
			return Result.err(
				CompileError.make({
					_tag: "OutsideRole",
					at: loc,
					role: l.role,
					access: l.access
				})
			)
		case "none":
			return Result.err(
				malformedDescription(
					loc,
					"a value built over a level of the schema it is compiled against (the schema itself, one its extends chain reaches, a fragment one of those lists or the empty level, or the base of a role that holds every relation of it whole, or a fragment of it the role holds whole); its schema is none of them"
				)
			)
	}
}

/**
 * A query as the compiler takes it, parsed once at the facade that received it (queryInput): a query or ordered value
 * the builder made over a schema, a fragment or a role, with that value parsed (program/schema.ts parseOver); or a bare
 * Description, which carries none and compiles against the schema the caller names.
 */
export type QueryInput =
	| { readonly kind: "built"; readonly desc: QueryDesc; readonly schema: Over }
	| { readonly kind: "described"; readonly desc: QueryDesc }

/**
 * The parse of a caller's query value, the one door from `unknown`: the Description of a query or ordered value with
 * the schema it was built over, or a QueryDesc given directly. A value the builder did not make is the caller's, read
 * once at the builder's boundary (query/build/host.ts hostArguments) before it is decoded, so one whose reading throws
 * is refused as MalformedDescription, never a defect.
 */
export const queryInput = (query: unknown): Result.Result<QueryInput, CompileError> => {
	const built = queryState(query)
	if (built !== undefined) {
		return Result.flatMap(
			catchCompileError(() => publicDesc(built, "query")),
			(desc) =>
				Result.map(parseOver(built.schema.over.value), (schema): QueryInput => ({
					kind: "built",
					desc,
					schema
				}))
		)
	}
	return Result.flatMap(
		catchCompileError(() => hostArguments("compile", [query])),
		() =>
			Result.map(decodeDesc("query", query), (desc): QueryInput => ({ kind: "described", desc }))
	)
}
