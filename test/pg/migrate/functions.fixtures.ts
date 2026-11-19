/** What the property of functions.test.ts reads: its space, the schemas a case installs, and the facts it reads back. */

import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { array, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import type { DeclaredLanguage, FunctionVolatility } from "#compiler/core/function.ts"
import { conversionOf } from "#compiler/core/identity.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { quoteIdent, wellFormed } from "#compiler/core/text.ts"
import { date, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	type AnyFunction,
	type AnyRows,
	fn,
	login,
	relation,
	role,
	rows,
	schema,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** The value types a case's signatures and headings draw from: a roster of the kinds a signature takes. */
const valueTypes = [
	"integer",
	"bigint",
	"double precision",
	"numeric",
	"boolean",
	"date",
	"uuid",
	"text",
	"word",
	"natural"
] as const
export type ValueType = (typeof valueTypes)[number]

/** Each value type's field: a base type, a refined text, or the natural contract. */
const fieldOf: { readonly [T in ValueType]: FieldBase } = {
	integer: pg.integer,
	bigint: pg.bigint,
	"double precision": pg["double precision"],
	numeric: pg.numeric(12, 2),
	boolean: pg.boolean,
	date,
	uuid,
	text: str.regex("^.*$", "su"),
	word: str.regex("^[a-z]+$", "u"),
	natural
}

/** Each value type's base type as a body spells it: what PostgreSQL holds the signature to. */
const spelled: { readonly [T in ValueType]: string } = {
	integer: "integer",
	bigint: "bigint",
	"double precision": "double precision",
	numeric: "numeric",
	boolean: "boolean",
	date: "date",
	uuid: "uuid",
	text: "text",
	word: "text",
	natural: "bigint"
}

/** The names a case's functions, arguments and fields take, a dictionary of declared names. */
const functionNames = ["grade", "foldText", "xsdRegex", "drawOf", "credit"] as const
const argNames = ["program", "variables", "draw", "seed"] as const
const fieldNames = ["start", "kind", "weight", "label", "place"] as const

/** A heading of a case: its fields in order, each a name and a value type. */
export interface HeadingSketch {
	readonly fields: NonEmptyReadonlyArray<readonly [string, ValueType]>
}

/** What a function takes or returns: a value, or rows of the case's heading at `heading`. */
export type TypeSketch =
	| { readonly kind: "value"; readonly type: ValueType }
	| { readonly kind: "rows"; readonly heading: number }

/** How a body's text is spelled around its statements: each spelling is one a migration file must carry exactly. */
const spellings = ["plain", "tabbed", "dollar quotes", "trailing dollar"] as const
export type Spelling = (typeof spellings)[number]

/** A function of a case: its name, arguments, result, volatility, language, its body's spelling, and whether it calls
 * the helper, a declared function of no argument, by its unqualified name. */
export interface FunctionSketch {
	readonly name: (typeof functionNames)[number]
	readonly args: ReadonlyArray<{ readonly name: string; readonly type: TypeSketch }>
	readonly returns: TypeSketch
	readonly volatility: FunctionVolatility
	readonly language: DeclaredLanguage
	readonly spelling: Spelling
	readonly callsHelper: boolean
}

/** A version of a case's declarations: its headings and its drawn functions, beside the helper and the table reader
 * every declaring version holds; or no function at all, so the installation holds no function owner either. */
export type VersionSketch =
	| {
			readonly kind: "declares"
			readonly headings: NonEmptyReadonlyArray<HeadingSketch>
			readonly functions: ReadonlyArray<FunctionSketch>
			/** Whether the level's list declares the helper before the functions that call it, or after them. */
			readonly helperFirst: boolean
	  }
	| { readonly kind: "none" }

/** What the second version does to the first's functions. */
const changes = [
	"none",
	"a body",
	"a volatility",
	"a signature",
	"a heading",
	"a function removed",
	"a function added",
	"every function removed"
] as const
export type Change = (typeof changes)[number]

/** What a case functionPlants by hand after its migrations, before the drift check runs again. */
const functionPlants = [
	"nothing",
	"a body edited",
	"a table privilege",
	"a row type altered"
] as const
export type FunctionPlant = (typeof functionPlants)[number]

export interface FunctionCase {
	readonly level: "root" | "extension"
	readonly first: Extract<VersionSketch, { readonly kind: "declares" }>
	readonly change: Change
	readonly plant: FunctionPlant
}

export type FunctionFeature =
	| `a change: ${Change}`
	| `a plant: ${FunctionPlant}`
	| `a body ${Spelling}`
	| `a ${DeclaredLanguage} body`
	| `a ${FunctionVolatility} function`
	| "an argument of rows"
	| "a result of rows"
	| "a result of a value"
	| "a helper call"
	| "functions at an extension"
	| "a row type shared by two functions"
	| "a table read refused"
	| "an SQL caller declared before its callee"

const headingGen: Gen<HeadingSketch> = (source) => {
	const names = source.draw(array(element(fieldNames), { min: 1, max: 3 }))
	const distinct = Arr.dedupe(names)
	return {
		fields: mapNonEmpty(
			nonEmpty(distinct, "a heading's fields"),
			(name) => [name, source.draw(element(valueTypes))] as const
		)
	}
}

const valueGen: Gen<TypeSketch> = (source) => ({
	kind: "value",
	type: source.draw(element(valueTypes))
})

const typeGen = (headings: number): Gen<TypeSketch> =>
	oneOf<TypeSketch>([
		valueGen,
		(source) => ({ kind: "rows", heading: source.draw(int(0, headings - 1)) })
	])

/** Whether a function's result is rows of a heading one of its arguments takes rows of: the body returns them. */
const returnsAnArgument = (args: FunctionSketch["args"], returns: TypeSketch): string | undefined =>
	returns.kind === "rows"
		? Option.getOrUndefined(
				Option.map(
					Arr.findFirst(args, (a) => a.type.kind === "rows" && a.type.heading === returns.heading),
					(a) => a.name
				)
			)
		: undefined

const functionGen =
	(headings: number, name: FunctionSketch["name"]): Gen<FunctionSketch> =>
	(source) => {
		const args = Arr.dedupeWith(
			source.draw(
				array(
					(s): FunctionSketch["args"][number] => ({
						name: s.draw(element(argNames)),
						type: s.draw(typeGen(headings))
					}),
					{ min: 0, max: 3 }
				)
			),
			(a, b) => a.name === b.name
		)
		const returns = source.draw(typeGen(headings))
		const sqlAdmitted = returns.kind === "value" || returnsAnArgument(args, returns) !== undefined
		return {
			name,
			args,
			returns,
			volatility: source.draw(element(["immutable", "stable", "volatile"] as const)),
			language: sqlAdmitted ? source.draw(element(["plpgsql", "sql"] as const)) : "plpgsql",
			spelling: source.draw(element(spellings)),
			callsHelper: source.draw(int(0, 1)) === 1
		}
	}

export const caseGen: Gen<FunctionCase> = (source) => {
	const headings = nonEmpty(source.draw(array(headingGen, { min: 1, max: 2 })), "a case's headings")
	const names = Arr.dedupe(source.draw(array(element(functionNames), { min: 1, max: 3 })))
	return {
		level: source.draw(element(["root", "extension"] as const)),
		first: {
			kind: "declares",
			helperFirst: source.draw(int(0, 1)) === 1,
			headings,
			functions: Arr.map(names, (name) => source.draw(functionGen(headings.length, name)))
		},
		change: source.draw(element(changes)),
		plant: source.draw(element(functionPlants))
	}
}

/** The function the second version adds, which no first version declares. */
const added: FunctionSketch = {
	name: "credit",
	args: [{ name: "seed", type: { kind: "value", type: "integer" } }],
	returns: { kind: "value", type: "integer" },
	volatility: "immutable",
	language: "sql",
	spelling: "plain",
	callsHelper: true
}

/** The second version of a case: its first, changed as its change says, on its first function. */
export const secondOf = (c: FunctionCase): VersionSketch => {
	const [first, ...rest] = c.first.functions
	const headings = c.first.headings
	const declares = (functions: ReadonlyArray<FunctionSketch>): VersionSketch => ({
		...c.first,
		functions
	})
	const at = (f: FunctionSketch): VersionSketch => declares([f, ...rest])
	switch (c.change) {
		case "none":
			return c.first
		case "a body":
			return first === undefined
				? c.first
				: at({ ...first, spelling: first.spelling === "plain" ? "tabbed" : "plain" })
		case "a volatility":
			return first === undefined
				? c.first
				: at({ ...first, volatility: first.volatility === "volatile" ? "stable" : "volatile" })
		case "a signature":
			return first === undefined
				? c.first
				: at({
						...first,
						args: [...first.args, { name: "extra", type: { kind: "value", type: "uuid" } }]
					})
		case "a heading": {
			const [h, ...more] = headings
			return {
				...c.first,
				headings: [{ fields: [...h.fields, ["extra", "boolean"]] }, ...more]
			}
		}
		case "a function removed":
			return declares(rest)
		case "a function added":
			return declares(
				Arr.some(c.first.functions, (f) => f.name === added.name)
					? c.first.functions
					: [...c.first.functions, added]
			)
		case "every function removed":
			return { kind: "none" }
	}
}

/** A function's installed name: its declared name's conversion. */
const installedName = (name: string): string => conversionOf(parsedName(name))

/** The helper every body that calls one calls: a declared PL/pgSQL function of no argument returning 1. */
const helperName = "helper"

/** The function every version declares that reads a table, whose call its owner's privileges refuse. */
const peekName = "peek"

/** A body's statements spelled as `spelling` says: indented by tabs, by spaces, with a dollar-quote tag in a comment, or
 * ending in a dollar sign, each a text a migration file and PostgreSQL's source must hold exactly. */
const spelledBody = (spelling: Spelling, lines: ReadonlyArray<string>, comment: string): string => {
	switch (spelling) {
		case "plain":
			return `\n${Arr.join(
				Arr.map(lines, (l) => `  ${l}`),
				"\n"
			)}\n`
		case "tabbed":
			return `\n${Arr.join(
				Arr.map(lines, (l) => `\t${l}`),
				"\n"
			)}\n`
		case "dollar quotes":
			return `\n${comment} $$ and $gz$ quote nothing\n${Arr.join(lines, "\n")}\n`
		case "trailing dollar":
			return `${Arr.join(lines, "\n")}\n${comment} costs $`
	}
}

/** The body of a function of a version, valid for its signature: it returns NULL, no row, or the rows of an argument of
 * its result's heading, after its call of the helper where it calls one. */
const bodyOf = (f: FunctionSketch): string => {
	const passed = returnsAnArgument(f.args, f.returns)
	switch (f.language) {
		case "plpgsql": {
			const result =
				f.returns.kind === "value"
					? "RETURN NULL;"
					: passed === undefined
						? "RETURN;"
						: `RETURN QUERY SELECT * FROM unnest(${quoteIdent(passed)});`
			const lines = ["BEGIN", ...(f.callsHelper ? [`PERFORM ${helperName}();`] : []), result, "END"]
			return spelledBody(f.spelling, lines, "--")
		}
		case "sql": {
			const guard = f.callsHelper ? ` WHERE ${helperName}() = 1` : ""
			const result =
				f.returns.kind === "value"
					? `SELECT NULL::${spelled[f.returns.type]}${guard}`
					: `SELECT * FROM unnest(${quoteIdent(defined(passed, "the argument an SQL body returns"))})${guard}`
			return spelledBody(f.spelling, [result], "--")
		}
	}
}

/** The helper's body. */
const helperBody = "\nBEGIN\n  RETURN 1;\nEND\n"

/** The body of the function that reads a table: the count of N's rows, read by N's unqualified name, which its search
 * path resolves to its own schema's table as it runs; PL/pgSQL, which reads its statements' names at its first call,
 * since an SQL body's are read as it is created, before any table stands on a first migration. */
const peekBody = "\nBEGIN\n  RETURN (SELECT count(*) FROM n);\nEND\n"

/** The field or rows a sketch's type is, over the version's headings. */
const typeOf = (t: TypeSketch, headings: ReadonlyArray<AnyRows>): FieldBase | AnyRows =>
	t.kind === "value" ? fieldOf[t.type] : defined(headings[t.heading], `heading ${t.heading}`)

/** The functions of a version, its helper and its table reader among them, the helper declared where the version
 * places it, before or after the functions that call it; none for a version that declares none. */
const functionsOf = (v: VersionSketch): ReadonlyArray<AnyFunction> => {
	if (v.kind === "none") {
		return []
	}
	const headings = Arr.map(v.headings, (h) =>
		rows(Rec.fromEntries(Arr.map(h.fields, ([name, t]) => [name, fieldOf[t]] as const)))
	)
	const helper = fn(helperName, {
		calls: [],
		args: {},
		returns: pg.integer,
		volatility: "immutable",
		language: "plpgsql",
		body: helperBody
	})
	const declared = Arr.map(v.functions, (f) =>
		fn(f.name, {
			calls: f.callsHelper ? [helper] : [],
			args: Rec.fromEntries(Arr.map(f.args, (a) => [a.name, typeOf(a.type, headings)] as const)),
			returns: typeOf(f.returns, headings),
			volatility: f.volatility,
			language: f.language,
			body: bodyOf(f)
		})
	)
	const peek = fn(peekName, {
		calls: [],
		args: {},
		returns: pg.integer,
		volatility: "stable",
		language: "plpgsql",
		body: peekBody
	})
	return v.helperFirst ? [helper, ...declared, peek] : [...declared, peek, helper]
}

/** A version of a case under `name`: N(id), which `peek` reads, and its functions, declared at the root or at an
 * extension over a root of B(id), N beside them in the schema `peek`'s search_path names; one login writes and reads
 * them. */
export const versionFor = (c: FunctionCase, v: VersionSketch) => (name: string) => {
	const N = relation("N", { id: uuid }, ["id"])
	const functions = functionsOf(v)
	if (c.level === "root") {
		const s = schema(name, [N, ...functions], [])
		const writer = role(s, "writer", wholeEntriesOf(s), { write: writableNamesOf(s) })
		return { schema: s, logins: [login(s, "desk", [writer])] }
	}
	const base = schema(name, [relation("B", { id: uuid }, ["id"])], [])
	const s = schema.extend(base, `${name}_fn`, [N, ...functions], [])
	const writer = role(s, "writer", wholeEntriesOf(s), { write: writableNamesOf(s) })
	return { schema: s, logins: [login(s, "desk", [writer])] }
}

/** A version's drawn functions: none for a version that declares none. */
const drawnOf = (v: VersionSketch): ReadonlyArray<FunctionSketch> =>
	v.kind === "none" ? [] : v.functions

/** The features a case reaches by its declarations, its change and its plant. */
export const reached = (c: FunctionCase): ReadonlyArray<FunctionFeature> => {
	const all = [...c.first.functions, ...drawnOf(secondOf(c))]
	const rowsUses = Arr.flatMap(c.first.functions, (f) =>
		Arr.flatMap([...Arr.map(f.args, (a) => a.type), f.returns], (t: TypeSketch) =>
			t.kind === "rows" ? [t.heading] : []
		)
	)
	const features: ReadonlyArray<FunctionFeature> = [
		`a change: ${c.change}`,
		`a plant: ${c.plant}`,
		"a table read refused",
		...Arr.map(all, (f): FunctionFeature => `a body ${f.spelling}`),
		...Arr.map(all, (f): FunctionFeature => `a ${f.language} body`),
		...Arr.map(all, (f): FunctionFeature => `a ${f.volatility} function`),
		...(Arr.some(all, (f) => Arr.some(f.args, (a) => a.type.kind === "rows"))
			? (["an argument of rows"] as const)
			: []),
		...(Arr.some(all, (f) => f.returns.kind === "rows") ? (["a result of rows"] as const) : []),
		...(Arr.some(all, (f) => f.returns.kind === "value") ? (["a result of a value"] as const) : []),
		...(Arr.some(all, (f) => f.callsHelper) ? (["a helper call"] as const) : []),
		...(c.level === "extension" ? (["functions at an extension"] as const) : []),
		...(Arr.dedupe(rowsUses).length < rowsUses.length
			? (["a row type shared by two functions"] as const)
			: []),
		...(!c.first.helperFirst && Arr.some(all, (f) => f.callsHelper && f.language === "sql")
			? (["an SQL caller declared before its callee"] as const)
			: [])
	]
	return Arr.dedupe(features)
}

/** Every feature the property requires. */
export const features: NonEmptyReadonlyArray<FunctionFeature> = [
	...mapNonEmpty(changes, (c): FunctionFeature => `a change: ${c}`),
	...Arr.map(functionPlants, (p): FunctionFeature => `a plant: ${p}`),
	...Arr.map(spellings, (s): FunctionFeature => `a body ${s}`),
	"a plpgsql body",
	"a sql body",
	"a immutable function",
	"a stable function",
	"a volatile function",
	"an argument of rows",
	"a result of rows",
	"a result of a value",
	"a helper call",
	"functions at an extension",
	"a row type shared by two functions",
	"a table read refused",
	"an SQL caller declared before its callee"
]

/** The order of a function's name and its digest by its name. */
const byName = Order.mapInput(Str.Order, (pair: readonly [string, string]) => pair[0])

/** Each declared function of a version by its installed name, with the SHA-256 of the body it declares, in name
 * order. */
export const declaredBodies = (v: VersionSketch): ReadonlyArray<readonly [string, string]> =>
	v.kind === "none"
		? []
		: Arr.sort(
				Arr.map(
					[
						...Arr.map(v.functions, (f) => [f.name, bodyOf(f)] as const),
						[helperName, helperBody] as const,
						[peekName, peekBody] as const
					],
					([name, body]) => [installedName(name), sha256Hex(wellFormed(body))] as const
				),
				byName
			)

/** Installed functions' names and digests, in name order. */
export const heldBodies = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): ReadonlyArray<readonly [string, string]> =>
	Arr.sort(
		Arr.map(rows, ([name, digest]) => [String(name), String(digest)] as const),
		byName
	)

/** The installed functions of `schemaName` but grizzle's own: each one's name, its source's SHA-256 as PostgreSQL
 * stores it, and its owner. */
export const installedFunctions = (owner: RawSession, schemaName: string) =>
	owner.values(
		"SELECT p.proname::text, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'), pg_catalog.pg_get_userbyid(p.proowner)::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1::text AND p.proname NOT LIKE '\\_\\_%' ORDER BY 1",
		[schemaName]
	)

/** The functions of `schemaName` but grizzle's own that PUBLIC may execute, by name: none of a declared one's. */
export const publicFunctions = (owner: RawSession, schemaName: string) =>
	owner.values(
		"SELECT p.proname::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1::text AND p.proname NOT LIKE '\\_\\_%' AND pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') ORDER BY 1",
		[schemaName]
	)

/** The privileges the function owner holds on every relation of the installation's schemas: none, by its grants or
 * any role's it inherits. */
export const ownerTablePrivileges = (
	owner: RawSession,
	role: string,
	schemas: ReadonlyArray<string>
) =>
	owner.values(
		"SELECT c.relname::text, p.t FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(t) WHERE n.nspname = ANY($2::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND pg_catalog.has_table_privilege($1::name, c.oid, p.t) ORDER BY 1, 2",
		[role, schemas]
	)

/** The call of a function of no row type argument by NULLs, a set-returning one in FROM: each argument's NULL takes its
 * parameter's type, since the name is one function's. */
export const callOf = (
	schemaName: string,
	name: string,
	args: ReadonlyArray<string>,
	rowsResult: boolean
): string => {
	const called = `${quoteIdent(schemaName)}.${quoteIdent(installedName(name))}(${Arr.join(
		Arr.map(args, () => "NULL"),
		", "
	)})`
	return rowsResult ? `SELECT count(*) FROM ${called} AS r` : `SELECT ${called}`
}

/** The calls of a version's functions, each by its name, its argument count and whether it returns rows. */
export const callsOf = (
	v: VersionSketch
): ReadonlyArray<{
	readonly name: string
	readonly args: ReadonlyArray<string>
	readonly rows: boolean
}> =>
	v.kind === "none"
		? []
		: [
				...Arr.map(v.functions, (f) => ({
					name: f.name,
					args: Arr.map(f.args, (a) => a.name),
					rows: f.returns.kind === "rows"
				})),
				{ name: helperName, args: [], rows: false }
			]

/** The table reader's call. */
export const peekCall = (schemaName: string): string => callOf(schemaName, peekName, [], false)

/** The plant's statement, as the migration identity: a body created again under its header, SELECT on N granted to the
 * function owner, or an attribute added to a row type. */
export const plantOf = (
	plant: Exclude<FunctionPlant, "nothing">,
	schemaName: string,
	owner: string,
	rowType: Option.Option<string>
): Option.Option<string> => {
	const s = quoteIdent(schemaName)
	switch (plant) {
		case "a body edited":
			return Option.some(
				`CREATE OR REPLACE FUNCTION ${s}."helper"() RETURNS integer LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, ${s}, pg_temp AS $$BEGIN RETURN 2; END$$`
			)
		case "a table privilege":
			return Option.some(`GRANT SELECT ON ${s}."n" TO ${quoteIdent(owner)}`)
		case "a row type altered":
			return Option.map(
				rowType,
				(t) => `ALTER TYPE ${s}.${quoteIdent(t)} ADD ATTRIBUTE "planted" integer`
			)
	}
}

/** The row types of `schemaName`, by name. */
export const rowTypesOf = (owner: RawSession, schemaName: string) =>
	owner.values(
		"SELECT t.typname::text FROM pg_catalog.pg_type AS t JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace JOIN pg_catalog.pg_class AS c ON c.oid = t.typrelid WHERE n.nspname = $1::text AND c.relkind = 'c' ORDER BY 1",
		[schemaName]
	)

/** The text of a row of values. */
export const rowText = (row: ReadonlyArray<unknown>): string => Arr.join(Arr.map(row, String), " ")
