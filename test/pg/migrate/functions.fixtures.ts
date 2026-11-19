/** What the property of functions.test.ts reads: its space, the schemas a case installs, and the facts it reads back. */

import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import type { DeclaredLanguage, FunctionVolatility } from "#compiler/core/function.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { quoteIdent, wellFormed } from "#compiler/core/text.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	type AnyFunction,
	fn,
	login,
	relation,
	role,
	schema,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import {
	bodyParts,
	bodyText,
	type Declarations,
	declarationsGen,
	drawnFunctions,
	type FunctionSketch,
	headingKey,
	helperName,
	helperOf,
	helperSource,
	installedName,
	reachOf,
	type Spelling,
	spelled,
	spellings,
	templateOf,
	type TypeSketch
} from "#test/support/declared-functions.ts"
import { Id } from "#test/support/ids.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** A version of a case: its declarations, beside the helper and the table reader every declaring version holds,
 * the helper declared before the functions that call it or after them; or no function at all, so the installation
 * holds no function owner either. */
export type VersionSketch =
	| (Declarations & {
			readonly kind: "declares"
			/** Whether the level's list declares the helper before the functions that call it, or after them. */
			readonly helperFirst: boolean
	  })
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

/** What a case plants by hand after its migrations, before the drift check runs again. */
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

/** What the second version's migration does to a declared function: create it, replace it in place, drop it and create
 * it again, drop it, or leave it as it stands. */
const fates = ["created", "replaced", "recreated", "dropped", "untouched"] as const
export type Fate = (typeof fates)[number]

export type FunctionFeature =
	| `a change: ${Change}`
	| `a plant: ${FunctionPlant}`
	| `a body ${Spelling}`
	| `a ${DeclaredLanguage} body`
	| `a ${FunctionVolatility} function`
	| `a ${DeclaredLanguage} body naming a row type`
	| `a function ${Fate} by the second version`
	| "an argument of rows"
	| "a result of rows"
	| "a result of a value"
	| "a helper call"
	| "a call of a drawn function with a composite"
	| "a body naming a callee's row type alone"
	| "a body naming a changed heading it takes no rows of"
	| "functions at an extension"
	| "a row type shared by two functions"
	| "a table read refused"
	| "an SQL caller declared before its callee"

export const caseGen: Gen<FunctionCase> = (source) => ({
	level: source.draw(element(["root", "extension"] as const)),
	first: {
		kind: "declares",
		helperFirst: source.draw(int(0, 1)) === 1,
		...source.draw(declarationsGen(false))
	},
	change: source.draw(element(changes)),
	plant: source.draw(element(functionPlants))
})

/** The function the second version adds, which no first version declares. */
const added: FunctionSketch = {
	name: "credit",
	args: [{ name: "seed", type: { kind: "value", type: "integer" } }],
	returns: { kind: "value", type: "integer" },
	volatility: "immutable",
	language: "sql",
	spelling: "plain",
	callsHelper: true,
	callees: [],
	names: []
}

/** The second version of a case: its first, changed as its change says, on its first function or heading; a removed
 * function's callers call it no longer. */
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
			return declares(
				Arr.map(rest, (f) => ({
					...f,
					callees: Arr.filter(f.callees, (callee) => callee !== first?.name)
				}))
			)
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

/** The function every version declares that reads a table, whose call its owner's privileges refuse. */
const peekName = "peek"

/** The body of the function that reads a table: the count of N's rows, read by N's unqualified name, which its search
 * path resolves to its own schema's table as it runs; PL/pgSQL, which reads its statements' names at its first call,
 * since an SQL body's are read as it is created, before any table stands on a first migration. */
const peekBody = "\nBEGIN\n  RETURN (SELECT count(*) FROM n);\nEND\n"

/** The functions of a version, its helper and its table reader among them, the helper declared where the version
 * places it, before or after the functions that call it; none for a version that declares none. */
const functionsOf = (v: VersionSketch): ReadonlyArray<AnyFunction> => {
	if (v.kind === "none") {
		return []
	}
	const helper = helperOf()
	const declared = drawnFunctions(v, helper)
	const peek = fn(peekName, {
		calls: [],
		args: {},
		returns: pg.integer,
		volatility: "stable",
		language: "plpgsql",
		body: templateOf([peekBody], [])
	})
	return v.helperFirst ? [helper, ...declared, peek] : [...declared, peek, helper]
}

/** A version of a case under `name`: N(id), which `peek` reads, and its functions, declared at the root or at an
 * extension over a root of B(id), N beside them in the schema `peek`'s search_path names; one login writes and reads
 * them. */
export const versionFor = (c: FunctionCase, v: VersionSketch) => (name: string) => {
	const N = relation("N", { id: Id }, ["id"])
	const functions = functionsOf(v)
	if (c.level === "root") {
		const s = schema(name, [N, ...functions], [])
		const writer = role(s, "writer", wholeEntriesOf(s), { write: writableNamesOf(s) })
		return { schema: s, logins: [login(s, "desk", [writer])] }
	}
	const base = schema(name, [relation("B", { id: Id }, ["id"])], [])
	const s = schema.extend(base, `${name}_fn`, [N, ...functions], [])
	const writer = role(s, "writer", wholeEntriesOf(s), { write: writableNamesOf(s) })
	return { schema: s, logins: [login(s, "desk", [writer])] }
}

/** A version's drawn functions: none for a version that declares none. */
const drawnOf = (v: VersionSketch): ReadonlyArray<FunctionSketch> =>
	v.kind === "none" ? [] : v.functions

/** A type of a version as a key: a value by the base type PostgreSQL holds it as, rows by its heading's content. */
const typeKey = (v: Declarations, t: TypeSketch): string =>
	t.kind === "value"
		? spelled[t.type]
		: `rows of (${headingKey(defined(v.headings[t.heading], `heading ${t.heading}`))})`

/**
 * What PostgreSQL holds of a declared function of a version, as keys: its signature, the argument types and the
 * result it is identified and dropped by; and its definition, its volatility, language and body, each heading the body
 * names by its content. A version's function is the same object in another exactly where its keys are the same.
 */
interface Held {
	readonly signature: string
	readonly definition: string
}

/** Each declared function of a version by its installed name, as PostgreSQL holds it (Held): the drawn ones, the
 * helper and the table reader; none for a version that declares none. */
const heldOf = (v: VersionSketch): ReadonlyMap<string, Held> => {
	if (v.kind === "none") {
		return new Map()
	}
	const constant = (body: string): Held => ({ signature: "() integer", definition: body })
	return new Map([
		...Arr.map(v.functions, (f) => {
			const signature = `(${Arr.join(
				Arr.map(f.args, (a) => `${a.name} ${typeKey(v, a.type)}`),
				", "
			)}) ${typeKey(v, f.returns)}`
			const body = bodyText(bodyParts(v, f), (h) =>
				headingKey(defined(v.headings[h], `heading ${h}`))
			)
			return [
				installedName(f.name),
				{ signature, definition: `${f.volatility} ${f.language} ${body}` }
			] as const
		}),
		[installedName(helperName), constant(helperSource)] as const,
		[installedName(peekName), constant(peekBody)] as const
	])
}

/**
 * What the second version's migration does to each declared function of either version, by its installed name: a
 * function only the second declares is created, one only the first declares dropped; one both declare is dropped and
 * created again where its signature changed, replaced in place where its definition alone did, and untouched where
 * neither did.
 */
export const fatesOf = (c: FunctionCase): ReadonlyMap<string, Fate> => {
	const before = heldOf(c.first)
	const after = heldOf(secondOf(c))
	const names = Arr.dedupe([...before.keys(), ...after.keys()])
	return new Map(
		Arr.map(names, (name): readonly [string, Fate] => {
			const was = before.get(name)
			const now = after.get(name)
			if (was === undefined) {
				return [name, "created"]
			}
			if (now === undefined) {
				return [name, "dropped"]
			}
			if (was.signature !== now.signature) {
				return [name, "recreated"]
			}
			return [name, was.definition === now.definition ? "untouched" : "replaced"]
		})
	)
}

/**
 * What a migration folder does to each function of `schemaName` it names, by the function's name: its statements, the
 * DDL a person reviews, each `DROP FUNCTION` and `CREATE OR REPLACE FUNCTION` of a function of the schema read off the
 * line it begins; a function dropped and created is recreated, one created alone created or replaced, which the
 * folder's text tells apart by what the snapshot held, so `knew` names the functions the version before declared.
 */
export const fatesIn = (
	folder: Option.Option<FolderTexts>,
	schemaName: string,
	knew: ReadonlySet<string>
): ReadonlyMap<string, Fate> => {
	const lines = Arr.flatMap(Option.toArray(folder), (f) =>
		Arr.flatMap(f.files, (file) => Str.split(file.text, "\n"))
	)
	const named = (statement: string): ReadonlyArray<string> =>
		Arr.flatMap(lines, (line) => {
			const head = `${statement} ${quoteIdent(schemaName)}.`
			if (!Str.startsWith(head)(line)) {
				return []
			}
			const rest = Str.slice(head.length)(line)
			return Option.match(Str.indexOf('"(')(rest), {
				onNone: () => [],
				onSome: (end) => (Str.startsWith('"')(rest) && end > 0 ? [Str.slice(1, end)(rest)] : [])
			})
		})
	const dropped = new Set(named("DROP FUNCTION"))
	const created = new Set(named("CREATE OR REPLACE FUNCTION"))
	return new Map(
		Arr.map(Arr.dedupe([...dropped, ...created]), (name): readonly [string, Fate] => [
			name,
			dropped.has(name)
				? created.has(name)
					? "recreated"
					: "dropped"
				: knew.has(name)
					? "replaced"
					: "created"
		])
	)
}

/** The fates a model's map states of the functions a migration touches: every fate but untouched, in name order. */
export const touched = (fates: ReadonlyMap<string, Fate>): ReadonlyArray<readonly [string, Fate]> =>
	Arr.sort(
		Arr.filter([...fates.entries()], ([, fate]) => fate !== "untouched"),
		Order.mapInput(Str.Order, (pair: readonly [string, Fate]) => pair[0])
	)

/** The installed names of the functions a version declares. */
export const declaredNames = (v: VersionSketch): ReadonlySet<string> => new Set(heldOf(v).keys())

/** Whether a function's body names a heading its own signature takes no rows of and returns none of: a callee's alone. */
const namesACalleesAlone = (v: Declarations, f: FunctionSketch): boolean => {
	const own = reachOf(v, { ...f, callees: [] })
	return Arr.some(
		Arr.flatMap(bodyParts(v, f), (p) => (typeof p === "string" ? [] : [p.heading])),
		(h) => !own.includes(h)
	)
}

/** The features a case reaches by its declarations, its change and its plant. */
export const reached = (c: FunctionCase): ReadonlyArray<FunctionFeature> => {
	const second = secondOf(c)
	const all = [...c.first.functions, ...drawnOf(second)]
	const rowsUses = Arr.flatMap(c.first.functions, (f) =>
		Arr.flatMap([...Arr.map(f.args, (a) => a.type), f.returns], (t: TypeSketch) =>
			t.kind === "rows" ? [t.heading] : []
		)
	)
	const naming = (v: Declarations, f: FunctionSketch): boolean =>
		Arr.some(bodyParts(v, f), (p) => typeof p !== "string")
	const fates = [...fatesOf(c).values()]
	const features: ReadonlyArray<FunctionFeature> = [
		`a change: ${c.change}`,
		`a plant: ${c.plant}`,
		"a table read refused",
		...Arr.map(all, (f): FunctionFeature => `a body ${f.spelling}`),
		...Arr.map(all, (f): FunctionFeature => `a ${f.language} body`),
		...Arr.map(all, (f): FunctionFeature => `a ${f.volatility} function`),
		...Arr.map(fates, (fate): FunctionFeature => `a function ${fate} by the second version`),
		...Arr.flatMap(c.first.functions, (f): ReadonlyArray<FunctionFeature> =>
			naming(c.first, f) ? [`a ${f.language} body naming a row type`] : []
		),
		...(Arr.some(all, (f) => Arr.some(f.args, (a) => a.type.kind === "rows"))
			? (["an argument of rows"] as const)
			: []),
		...(Arr.some(all, (f) => f.returns.kind === "rows") ? (["a result of rows"] as const) : []),
		...(Arr.some(all, (f) => f.returns.kind === "value") ? (["a result of a value"] as const) : []),
		...(Arr.some(all, (f) => f.callsHelper) ? (["a helper call"] as const) : []),
		...(Arr.some(c.first.functions, (f) =>
			Arr.some(f.callees, (callee) =>
				Arr.some(
					c.first.functions,
					(g) => g.name === callee && Arr.some(g.args, (a) => a.type.kind === "rows")
				)
			)
		)
			? (["a call of a drawn function with a composite"] as const)
			: []),
		...(Arr.some(c.first.functions, (f) => namesACalleesAlone(c.first, f))
			? (["a body naming a callee's row type alone"] as const)
			: []),
		...(c.change === "a heading" &&
		Arr.some(
			c.first.functions,
			(f) =>
				!reachOf(c.first, { ...f, callees: [] }).includes(0) &&
				Arr.some(bodyParts(c.first, f), (p) => typeof p !== "string" && p.heading === 0)
		)
			? (["a body naming a changed heading it takes no rows of"] as const)
			: []),
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
	...Arr.map(fates, (f): FunctionFeature => `a function ${f} by the second version`),
	"a plpgsql body",
	"a sql body",
	"a plpgsql body naming a row type",
	"a sql body naming a row type",
	"a immutable function",
	"a stable function",
	"a volatile function",
	"an argument of rows",
	"a result of rows",
	"a result of a value",
	"a helper call",
	"a call of a drawn function with a composite",
	"a body naming a callee's row type alone",
	"a body naming a changed heading it takes no rows of",
	"functions at an extension",
	"a row type shared by two functions",
	"a table read refused",
	"an SQL caller declared before its callee"
]

/** The order of a function's name and its digest by its name. */
const byName = Order.mapInput(Str.Order, (pair: readonly [string, string]) => pair[0])

/**
 * Each declared function of a version by its installed name, with the SHA-256 of the body it declares, each heading it
 * names spelled as `rowType` names the row type PostgreSQL holds of the heading's content, in name order.
 */
export const declaredBodies = (
	v: VersionSketch,
	rowType: (content: string) => string
): ReadonlyArray<readonly [string, string]> =>
	v.kind === "none"
		? []
		: Arr.sort(
				Arr.map(
					[
						...Arr.map(
							v.functions,
							(f) =>
								[
									f.name,
									bodyText(bodyParts(v, f), (h) =>
										quoteIdent(rowType(headingKey(defined(v.headings[h], `heading ${h}`))))
									)
								] as const
						),
						[helperName, helperSource] as const,
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

/** The installed row types of `schemaName`, each by its name and its attributes' names and types, as a heading's
 * content is keyed (headingKey). */
export const rowTypeContents = (owner: RawSession, schemaName: string) =>
	owner.values(
		"SELECT t.typname::text, string_agg(a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) FROM pg_catalog.pg_type AS t JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace JOIN pg_catalog.pg_class AS c ON c.oid = t.typrelid JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE n.nspname = $1::text AND c.relkind = 'c' GROUP BY t.typname ORDER BY 1",
		[schemaName]
	)

/** The row type a heading's content names among a schema's installed ones: the one of exactly its attributes. */
export const rowTypeNamed = (
	contents: ReadonlyArray<ReadonlyArray<unknown>>
): ((content: string) => string) => {
	const byContent = new Map(
		Arr.map(contents, ([name, attributes]) => [String(attributes), String(name)] as const)
	)
	return (content) => byContent.get(content) ?? `no row type of ${content}`
}

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
