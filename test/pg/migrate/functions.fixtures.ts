/** What the property of functions.test.ts reads: its space, the schemas a case installs, and the facts it reads back. */

import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { type Aimed, aimed, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import type {
	DeclaredLanguage,
	FunctionNullInput,
	FunctionVolatility
} from "#compiler/core/function.ts"
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
	wholeWritesOf
} from "#compiler/public/schema.ts"
import { joined } from "#test/support/chunked.ts"
import {
	bodyParts,
	bodyText,
	contentKey,
	type Declarations,
	declarationsGen,
	drawnFunctions,
	type FunctionSketch,
	headingKey,
	helperName,
	helperOf,
	helperSource,
	installedName,
	parametersOf,
	reachOf,
	type Spelling,
	spelled,
	spellings,
	templateOf,
	type TypeSketch,
	type ValueType
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
	"a null input",
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
	"a null input altered",
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
	| `a ${FunctionNullInput} function`
	| `a ${DeclaredLanguage} body naming a row type`
	| `a function ${Fate} by the second version`
	| "an argument of rows"
	| "a result of rows"
	| "a result of a value"
	| "an argument of one row"
	| "a PL/pgSQL result of one row"
	| "a heading field of rows"
	| "a heading field of one row"
	| "a call passing a nested composite"
	| "a helper call"
	| "a call of a drawn function with a composite"
	| "a body naming a callee's row type alone"
	| "a body naming a changed heading it takes no rows of"
	| "functions at an extension"
	| "a row type shared by two functions"
	| "a table read refused"
	| "an SQL caller declared before its callee"

const drawnCaseGen: Gen<FunctionCase> = (source) => ({
	level: source.draw(element(["root", "extension"] as const)),
	first: {
		kind: "declares",
		helperFirst: source.draw(int(0, 1)) === 1,
		...source.draw(declarationsGen(false))
	},
	change: source.draw(element(changes)),
	plant: source.draw(element(functionPlants))
})

/** A drawn case whose second version removes its first function. */
const removedGen: Gen<FunctionCase> = (source) => ({
	...source.draw(drawnCaseGen),
	change: "a function removed"
})

/**
 * A drawn case whose second version changes its first heading, which its first version's two functions hold so: grade
 * takes rows of it, and drawOf, which takes and returns a value, calls grade, so its body builds rows of the heading
 * and names its row type, which its own signature reaches only through its callee's.
 */
const calleeHeadingGen: Gen<FunctionCase> = (source) => {
	const drawn = source.draw(drawnCaseGen)
	const grade: FunctionSketch = {
		name: "grade",
		args: [{ name: "program", type: { kind: "rows", heading: 0 } }],
		returns: { kind: "value", type: "integer" },
		volatility: "immutable",
		nullInput: "called",
		language: source.draw(element(["plpgsql", "sql"] as const)),
		spelling: source.draw(element(spellings)),
		callsHelper: false,
		callees: [],
		names: []
	}
	const drawOf: FunctionSketch = {
		name: "drawOf",
		args: [{ name: "seed", type: { kind: "value", type: "integer" } }],
		returns: { kind: "value", type: "integer" },
		volatility: "stable",
		nullInput: "called",
		language: source.draw(element(["plpgsql", "sql"] as const)),
		spelling: source.draw(element(spellings)),
		callsHelper: false,
		callees: ["grade"],
		names: [0]
	}
	return {
		...drawn,
		first: { ...drawn.first, functions: [grade, drawOf] },
		change: "a heading"
	}
}

/**
 * A case's space: drawn whole, and aimed while pending at the two situations a drawn case seldom reaches, a second
 * version that removes a function (removedGen) and a changed heading a body names through a callee alone
 * (calleeHeadingGen), each drawn so it is reached.
 */
export const functionCaseSpace: Aimed<FunctionCase, FunctionFeature> = aimed(drawnCaseGen, [
	["a change: a function removed", removedGen],
	["a body naming a changed heading it takes no rows of", calleeHeadingGen]
])

/** The function the second version adds, which no first version declares. */
const added: FunctionSketch = {
	name: "credit",
	args: [{ name: "seed", type: { kind: "value", type: "integer" } }],
	returns: { kind: "value", type: "integer" },
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	spelling: "plain",
	callsHelper: true,
	callees: [],
	names: []
}

/** The second version of a case: its first, changed as its change says, on its first function or heading; a removed
 * function's callers call it no longer, nor name a heading only its signature named. */
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
		case "a null input":
			return first === undefined
				? c.first
				: at({ ...first, nullInput: first.nullInput === "strict" ? "called" : "strict" })
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
				headings: [
					{ fields: [...h.fields, ["extra", { kind: "value", type: "boolean" }] as const] },
					...more
				]
			}
		}
		case "a function removed": {
			const callers = Arr.map(rest, (f) => ({
				...f,
				callees: Arr.filter(f.callees, (callee) => callee !== first?.name)
			}))
			const after = { headings, functions: callers }
			return declares(
				Arr.map(callers, (f) => ({
					...f,
					names: Arr.filter(f.names, (h) => reachOf(after, f).includes(h))
				}))
			)
		}
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
		nullInput: "called",
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
		const writer = role(s, "writer", wholeEntriesOf(s), wholeWritesOf(s))
		return { schema: s, logins: [login(s, "desk", [writer])] }
	}
	const base = schema(name, [relation("B", { id: Id }, ["id"])], [])
	const s = schema.extend([base], `${name}_fn`, [N, ...functions], [])
	const writer = role(s, "writer", wholeEntriesOf(s), wholeWritesOf(s))
	return { schema: s, logins: [login(s, "desk", [writer])] }
}

/** A version's drawn functions: none for a version that declares none. */
const drawnOf = (v: VersionSketch): ReadonlyArray<FunctionSketch> =>
	v.kind === "none" ? [] : v.functions

/** A type of a version as a key: a value by the base type PostgreSQL holds it as, rows or a row by its heading's
 * content. */
const typeKey = (v: Declarations, t: TypeSketch): string =>
	t.kind === "value" ? spelled[t.type] : `${t.kind} of (${contentKey(v, t.heading)})`

/**
 * What PostgreSQL holds of a declared function of a version, as keys: its signature, the argument types and the
 * result it is identified and dropped by; and its definition, its volatility, null input, language and body, each heading the body
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
				Arr.map(parametersOf(f), (a) => `${a.name} ${typeKey(v, a.type)}`),
				", "
			)}) ${typeKey(v, f.returns)}`
			const body = bodyText(bodyParts(v, f), (h) => contentKey(v, h))
			return [
				installedName(f.name),
				{ signature, definition: `${f.volatility} ${f.nullInput} ${f.language} ${body}` }
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
		Arr.flatMap(f.files, (file) => Str.split(joined(file.text), "\n"))
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

/** Whether a type is rows or a row of a heading with a field of rows or of a row. */
const nested = (v: Declarations, t: TypeSketch): boolean =>
	t.kind !== "value" &&
	Arr.some(v.headings[t.heading]?.fields ?? [], ([, field]) => field.kind !== "value")

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
	const installedHeadings = Arr.flatMap(
		Arr.dedupe(Arr.flatMap(c.first.functions, (f) => reachOf(c.first, f))),
		(h) => Option.toArray(Arr.get(c.first.headings, h))
	)
	const features: ReadonlyArray<FunctionFeature> = [
		`a change: ${c.change}`,
		`a plant: ${c.plant}`,
		"a table read refused",
		...Arr.map(all, (f): FunctionFeature => `a body ${f.spelling}`),
		...Arr.map(all, (f): FunctionFeature => `a ${f.language} body`),
		...Arr.map(all, (f): FunctionFeature => `a ${f.volatility} function`),
		...Arr.map(all, (f): FunctionFeature => `a ${f.nullInput} function`),
		...Arr.map(fates, (fate): FunctionFeature => `a function ${fate} by the second version`),
		...Arr.flatMap(c.first.functions, (f): ReadonlyArray<FunctionFeature> =>
			naming(c.first, f) ? [`a ${f.language} body naming a row type`] : []
		),
		...(Arr.some(all, (f) => Arr.some(f.args, (a) => a.type.kind === "rows"))
			? (["an argument of rows"] as const)
			: []),
		...(Arr.some(all, (f) => f.returns.kind === "rows") ? (["a result of rows"] as const) : []),
		...(Arr.some(all, (f) => f.returns.kind === "value") ? (["a result of a value"] as const) : []),
		...(Arr.some(all, (f) => Arr.some(f.args, (a) => a.type.kind === "row"))
			? (["an argument of one row"] as const)
			: []),
		...(Arr.some(all, (f) => f.returns.kind === "row" && f.language === "plpgsql")
			? (["a PL/pgSQL result of one row"] as const)
			: []),
		...(Arr.some(installedHeadings, (h) => Arr.some(h.fields, ([, t]) => t.kind === "rows"))
			? (["a heading field of rows"] as const)
			: []),
		...(Arr.some(installedHeadings, (h) => Arr.some(h.fields, ([, t]) => t.kind === "row"))
			? (["a heading field of one row"] as const)
			: []),
		...(Arr.some(c.first.functions, (f) =>
			Arr.some(f.callees, (callee) =>
				Arr.some(
					c.first.functions,
					(g) => g.name === callee && Arr.some(g.args, (a) => nested(c.first, a.type))
				)
			)
		)
			? (["a call passing a nested composite"] as const)
			: []),
		...(Arr.some(all, (f) => f.callsHelper) ? (["a helper call"] as const) : []),
		...(Arr.some(c.first.functions, (f) =>
			Arr.some(f.callees, (callee) =>
				Arr.some(
					c.first.functions,
					(g) => g.name === callee && Arr.some(g.args, (a) => a.type.kind !== "value")
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
	"a called function",
	"a strict function",
	"an argument of rows",
	"a result of rows",
	"a result of a value",
	"an argument of one row",
	"a PL/pgSQL result of one row",
	"a heading field of rows",
	"a heading field of one row",
	"a call passing a nested composite",
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
 * names spelled as `rowType` names the row type PostgreSQL holds of the heading's content, a heading a field of it holds
 * keyed by that one's own row type's name, in name order.
 */
export const declaredBodies = (
	v: VersionSketch,
	rowType: (content: string) => string
): ReadonlyArray<readonly [string, string]> => {
	if (v.kind === "none") {
		return []
	}
	const named = (at: number): string => rowType(headingKey(v, at, named))
	return Arr.sort(
		Arr.map(
			[
				...Arr.map(
					v.functions,
					(f) => [f.name, bodyText(bodyParts(v, f), (h) => quoteIdent(named(h)))] as const
				),
				[helperName, helperSource] as const,
				[peekName, peekBody] as const
			],
			([name, body]) => [installedName(name), sha256Hex(wellFormed(body))] as const
		),
		byName
	)
}

/** Each value type's base type as a signature holds it, its typmod dropped as PostgreSQL drops it from an argument's
 * and a result's type. */
const signatureSpelled = (t: ValueType): string => (t === "numeric" ? "numeric" : spelled[t])

/**
 * Each declared function of a version by its installed name, with its signature as PostgreSQL holds it: whether it
 * returns a set, its result's type and its arguments' types, a row type by the name `rowType` finds of its heading's
 * content (declaredBodies), an argument of rows an array of it; in name order.
 */
export const declaredSignatures = (
	v: VersionSketch,
	rowType: (content: string) => string
): ReadonlyArray<string> => {
	if (v.kind === "none") {
		return []
	}
	const named = (at: number): string => rowType(headingKey(v, at, named))
	const typeText = (t: TypeSketch): string => {
		switch (t.kind) {
			case "value":
				return signatureSpelled(t.type)
			case "rows":
				return `${named(t.heading)}[]`
			case "row":
				return named(t.heading)
		}
	}
	return Arr.sort(
		[
			...Arr.map(v.functions, (f) =>
				Arr.join(
					[
						installedName(f.name),
						f.returns.kind === "rows" ? "set of" : "one",
						f.returns.kind === "rows" ? named(f.returns.heading) : typeText(f.returns),
						Arr.join(
							Arr.map(parametersOf(f), (a) => typeText(a.type)),
							", "
						)
					],
					" | "
				)
			),
			`${installedName(helperName)} | one | integer | `,
			`${installedName(peekName)} | one | integer | `
		],
		Str.Order
	)
}

/** The functions of `schemaName` but grizzle's own, each as `declaredSignatures` writes one, each type as format_type
 * prints it, a row type of the schema by its name alone. */
export const installedSignatures = (owner: RawSession, schemaName: string) =>
	owner.values(
		"SELECT p.proname::text || ' | ' || CASE WHEN p.proretset THEN 'set of' ELSE 'one' END || ' | ' || regexp_replace(pg_catalog.format_type(p.prorettype, NULL), '^.*\\.', '') || ' | ' || coalesce((SELECT string_agg(regexp_replace(pg_catalog.format_type(a.t, NULL), '^.*\\.', ''), ', ' ORDER BY a.i) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(t, i)), '') FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1::text AND p.proname NOT LIKE '\\_\\_%' ORDER BY 1",
		[schemaName]
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
 * content is keyed (headingKey): a type format_type qualifies by its schema, another row type of the schema, by its
 * name alone. */
export const rowTypeContents = (owner: RawSession, schemaName: string) =>
	owner.values(
		"SELECT t.typname::text, string_agg(a.attname || ' ' || regexp_replace(pg_catalog.format_type(a.atttypid, a.atttypmod), '^.*\\.', ''), ', ' ORDER BY a.attnum) FROM pg_catalog.pg_type AS t JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace JOIN pg_catalog.pg_class AS c ON c.oid = t.typrelid JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE n.nspname = $1::text AND c.relkind = 'c' GROUP BY t.typname ORDER BY 1",
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
					args: Arr.map(parametersOf(f), (a) => a.name),
					rows: f.returns.kind === "rows"
				})),
				{ name: helperName, args: [], rows: false }
			]

/** The table reader's call. */
export const peekCall = (schemaName: string): string => callOf(schemaName, peekName, [], false)

/** The plant's statement, as the migration identity: a body created again under its header, the helper made STRICT,
 * SELECT on N granted to the function owner, or an attribute added to a row type. */
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
		case "a null input altered":
			return Option.some(`ALTER FUNCTION ${s}."helper"() STRICT`)
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
