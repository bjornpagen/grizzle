/**
 * Declared functions drawn as sketches (schema/function.ts fn): a case's headings, its functions' signatures over
 * them, and each body's text, written as the template `fn.body` reads, its placeholders the headings it names. The
 * migration property (test/pg/migrate/functions) installs them, calls them and drafts their changes; the ownership
 * property (test/unit/schema/function-bodies) holds a body's named headings to the function's reach.
 *
 * A body is a list of parts, text and the headings it names, rendered three ways from the one list: as the template
 * `fn.body` builds, as the text PostgreSQL stores once each heading is its row type's name, and as a key that names
 * each heading by its content, which tells two versions' bodies apart exactly where their installed texts differ.
 */

import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, oneOf, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { DeclaredLanguage, FunctionVolatility } from "#compiler/core/function.ts"
import { conversionOf } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { date, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	type AnyFunction,
	type AnyRows,
	type FunctionBody,
	fn,
	rows
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { bodyBuilder } from "#compiler/schema/function.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { parsedName } from "#test/support/kernel/naming.ts"

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

/** Each value type's base type as a body spells it and PostgreSQL's format_type prints it: what it holds the
 * signature and a row type's attribute to. */
export const spelled: { readonly [T in ValueType]: string } = {
	integer: "integer",
	bigint: "bigint",
	"double precision": "double precision",
	numeric: "numeric(12,2)",
	boolean: "boolean",
	date: "date",
	uuid: "uuid",
	text: "text",
	word: "text",
	natural: "bigint"
}

/** The names a case's functions, arguments and fields take, a dictionary of declared names. */
const functionNames = ["grade", "foldText", "xsdRegex", "drawOf", "credit"] as const
export type FunctionName = (typeof functionNames)[number]
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
export const spellings = ["plain", "tabbed", "dollar quotes", "trailing dollar"] as const
export type Spelling = (typeof spellings)[number]

/**
 * A function of a case: its name, arguments, result, volatility, language and its body's spelling; whether its body
 * calls the helper, a declared function of no argument, by its unqualified name; the drawn functions declared before
 * it that its body calls, each with a composite of NULLs for every argument of rows, built of its row type's name; and
 * the headings its body names beside those, each of its own signature or a callee's, or for a sketch the ownership
 * property draws, any heading of the case.
 */
export interface FunctionSketch {
	readonly name: FunctionName
	readonly args: ReadonlyArray<{ readonly name: string; readonly type: TypeSketch }>
	readonly returns: TypeSketch
	readonly volatility: FunctionVolatility
	readonly language: DeclaredLanguage
	readonly spelling: Spelling
	readonly callsHelper: boolean
	readonly callees: ReadonlyArray<FunctionName>
	readonly names: ReadonlyArray<number>
}

/** A version of a case's declarations: its headings and its drawn functions, each after the functions it calls. */
export interface Declarations {
	readonly headings: NonEmptyReadonlyArray<HeadingSketch>
	readonly functions: ReadonlyArray<FunctionSketch>
}

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

/** The headings a signature takes rows of or returns. */
const signatureHeadings = (f: Pick<FunctionSketch, "args" | "returns">): ReadonlyArray<number> =>
	Arr.dedupe(
		Arr.flatMap([...Arr.map(f.args, (a) => a.type), f.returns], (t: TypeSketch) =>
			t.kind === "rows" ? [t.heading] : []
		)
	)

/** The function of a version by its name. */
const functionNamed = (v: Declarations, name: FunctionName): FunctionSketch =>
	defined(
		Arr.findFirst(v.functions, (f) => f.name === name).pipe(Option.getOrUndefined),
		`the function ${name}`
	)

/** The headings a function's body may name: those its own signature or a callee's takes rows of or returns. */
export const reachOf = (v: Declarations, f: FunctionSketch): ReadonlyArray<number> =>
	Arr.dedupe([
		...signatureHeadings(f),
		...Arr.flatMap(f.callees, (callee) => signatureHeadings(functionNamed(v, callee)))
	])

/**
 * A function drawn after `earlier`, which it may call: its signature over the case's `headings`, and the headings its
 * body names, drawn from its reach where `anyHeading` is false, from every heading of the case where it is true.
 */
const functionGen =
	(
		headings: number,
		name: FunctionName,
		earlier: ReadonlyArray<FunctionSketch>,
		anyHeading: boolean
	): Gen<FunctionSketch> =>
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
		const callees = source.draw(
			subset(
				Arr.map(earlier, (f) => f.name),
				{ min: 0, max: earlier.length }
			)
		)
		const signature = { args, returns }
		const reach = Arr.dedupe([
			...signatureHeadings(signature),
			...Arr.flatMap(callees, (callee) =>
				signatureHeadings(
					defined(
						Arr.findFirst(earlier, (f) => f.name === callee).pipe(Option.getOrUndefined),
						`the callee ${callee}`
					)
				)
			)
		])
		const nameable = anyHeading ? Array.from({ length: headings }, (_, i) => i) : reach
		return {
			name,
			args,
			returns,
			volatility: source.draw(element(["immutable", "stable", "volatile"] as const)),
			language: sqlAdmitted ? source.draw(element(["plpgsql", "sql"] as const)) : "plpgsql",
			spelling: source.draw(element(spellings)),
			callsHelper: source.draw(int(0, 1)) === 1,
			callees,
			names:
				nameable.length === 0 ? [] : source.draw(subset(nameable, { min: 0, max: nameable.length }))
		}
	}

/**
 * A case's declarations: one or two headings, and one to three functions, each after the ones it may call; their
 * bodies name headings of their reach, or of the whole case where `anyHeading` is true.
 */
export const declarationsGen =
	(anyHeading: boolean): Gen<Declarations> =>
	(source) => {
		const headings = nonEmpty(
			source.draw(array(headingGen, { min: 1, max: 2 })),
			"a case's headings"
		)
		const names = Arr.dedupe(source.draw(array(element(functionNames), { min: 1, max: 3 })))
		const none: ReadonlyArray<FunctionSketch> = []
		const functions = Arr.reduce(names, none, (earlier, name) => [
			...earlier,
			source.draw(functionGen(headings.length, name, earlier, anyHeading))
		])
		return { headings, functions }
	}

/** A part of a body: its text, or a heading it names, by its place among the case's headings. */
export type Part = string | { readonly heading: number }

/** The helper every body that calls one calls: a declared PL/pgSQL function of no argument returning 1. */
export const helperName = "helper"

/** The composite of NULLs a body passes for a callee's argument of `t`: a NULL of a value's type, or an array of one
 * row of NULLs, cast to its heading's row type by its name. */
const argumentParts = (v: Declarations, t: TypeSketch): ReadonlyArray<Part> => {
	switch (t.kind) {
		case "value":
			return [`NULL::${spelled[t.type]}`]
		case "rows": {
			const heading = defined(v.headings[t.heading], `heading ${t.heading}`)
			const fields = Arr.join(
				Arr.map(heading.fields, ([, type]) => `NULL::${spelled[type]}`),
				", "
			)
			return [`ARRAY[ROW(${fields})::`, { heading: t.heading }, "]"]
		}
	}
}

/** A function's installed name: its declared name's conversion, which a body calls it by. */
export const installedName = (name: string): string => conversionOf(parsedName(name))

/** A call of `callee` with a composite of NULLs for each of its arguments. */
const callParts = (v: Declarations, callee: FunctionSketch): ReadonlyArray<Part> => [
	`${quoteIdent(installedName(callee.name))}(`,
	...Arr.flatMap(callee.args, (a, i) => [...(i === 0 ? [] : [", "]), ...argumentParts(v, a.type)]),
	")"
]

/** Each line of a body's statements spelled as `spelling` says: indented by tabs, by spaces, with a dollar-quote tag in
 * a comment, or ending in a dollar sign, each a text a migration file and PostgreSQL's source must hold exactly. */
const spelledParts = (
	spelling: Spelling,
	lines: ReadonlyArray<ReadonlyArray<Part>>,
	comment: string
): ReadonlyArray<Part> => {
	const joined = (indent: string): ReadonlyArray<Part> =>
		Arr.flatMap(lines, (l, i) => [...(i === 0 ? [] : ["\n"]), indent, ...l])
	switch (spelling) {
		case "plain":
			return ["\n", ...joined("  "), "\n"]
		case "tabbed":
			return ["\n", ...joined("\t"), "\n"]
		case "dollar quotes":
			return [`\n${comment} $$ and $gz$ quote nothing\n`, ...joined(""), "\n"]
		case "trailing dollar":
			return [...joined(""), `\n${comment} costs $`]
	}
}

/**
 * The body of a function of a version, valid for its signature: PL/pgSQL declares a variable of each heading it names
 * and performs the helper and each callee, SQL tests a NULL of each heading it names and a call of each in its WHERE;
 * it returns NULL, no row, or the rows of an argument of its result's heading.
 */
export const bodyParts = (v: Declarations, f: FunctionSketch): ReadonlyArray<Part> => {
	const passed = returnsAnArgument(f.args, f.returns)
	const callees = Arr.map(f.callees, (callee) => callParts(v, functionNamed(v, callee)))
	switch (f.language) {
		case "plpgsql": {
			const declared = Arr.map(f.names, (h, i): ReadonlyArray<Part> => [
				`n${i} `,
				{ heading: h },
				";"
			])
			const result =
				f.returns.kind === "value"
					? "RETURN NULL;"
					: passed === undefined
						? "RETURN;"
						: `RETURN QUERY SELECT * FROM unnest(${quoteIdent(passed)});`
			const lines: ReadonlyArray<ReadonlyArray<Part>> = [
				...(declared.length === 0 ? [] : [["DECLARE"], ...declared]),
				["BEGIN"],
				...(f.callsHelper ? [[`PERFORM ${helperName}();`]] : []),
				...Arr.map(callees, (call) => ["PERFORM ", ...call, ";"]),
				[result],
				["END"]
			]
			return spelledParts(f.spelling, lines, "--")
		}
		case "sql": {
			const guards: ReadonlyArray<ReadonlyArray<Part>> = [
				...(f.callsHelper ? [[`${helperName}() = 1`]] : []),
				...Arr.map(f.names, (h): ReadonlyArray<Part> => ["NULL::", { heading: h }, " IS NULL"]),
				...Arr.map(callees, (call): ReadonlyArray<Part> => ["EXISTS (SELECT ", ...call, ")"])
			]
			const where: ReadonlyArray<Part> =
				guards.length === 0
					? []
					: [" WHERE ", ...Arr.flatMap(guards, (g, i) => [...(i === 0 ? [] : [" AND "]), ...g])]
			const result: ReadonlyArray<Part> =
				f.returns.kind === "value"
					? [`SELECT NULL::${spelled[f.returns.type]}`, ...where]
					: [
							`SELECT * FROM unnest(${quoteIdent(defined(passed, "the argument an SQL body returns"))})`,
							...where
						]
			return spelledParts(f.spelling, [result], "--")
		}
	}
}

/** A body's text with each heading it names rendered by `heading`. */
export const bodyText = (parts: ReadonlyArray<Part>, heading: (at: number) => string): string =>
	Arr.join(
		Arr.map(parts, (p) => (typeof p === "string" ? p : heading(p.heading))),
		""
	)

/** A heading's content as a key: its fields' names and the types PostgreSQL holds them as, in order. */
export const headingKey = (h: HeadingSketch): string =>
	Arr.join(
		Arr.map(h.fields, ([name, type]) => `${name} ${spelled[type]}`),
		", "
	)

/** A body's parts as the template fn.body builds: its texts between the headings it names, each heading's rows(). */
export const templateOf = (
	parts: ReadonlyArray<Part>,
	headings: ReadonlyArray<AnyRows>
): FunctionBody => {
	const texts: Array<string> = [""]
	const named: Array<AnyRows> = []
	for (const p of parts) {
		if (typeof p === "string") {
			texts[texts.length - 1] = `${texts[texts.length - 1] ?? ""}${p}`
		} else {
			named.push(defined(headings[p.heading], `heading ${p.heading}`))
			texts.push("")
		}
	}
	return bodyBuilder(Object.assign([...texts], { raw: [...texts] }), named)
}

/** The field or rows a sketch's type is, over the version's headings. */
const typeOf = (t: TypeSketch, headings: ReadonlyArray<AnyRows>): FieldBase | AnyRows =>
	t.kind === "value" ? fieldOf[t.type] : defined(headings[t.heading], `heading ${t.heading}`)

/** The helper's body. */
const helperBody = "\nBEGIN\n  RETURN 1;\nEND\n"

/** The helper, a declared function of no argument. */
export const helperOf = (): AnyFunction =>
	fn(helperName, {
		calls: [],
		args: {},
		returns: pg.integer,
		volatility: "immutable",
		language: "plpgsql",
		body: templateOf([helperBody], [])
	})

/** The helper as PostgreSQL stores its source. */
export const helperSource = helperBody

/** The drawn functions of a version, each built after the functions it calls, `helper` the one its bodies call. */
export const drawnFunctions = (
	v: Declarations,
	helper: AnyFunction
): ReadonlyArray<AnyFunction> => {
	const headings = Arr.map(v.headings, (h) =>
		rows(Rec.fromEntries(Arr.map(h.fields, ([name, t]) => [name, fieldOf[t]] as const)))
	)
	const built = new Map<string, AnyFunction>()
	for (const f of v.functions) {
		built.set(
			f.name,
			fn(f.name, {
				calls: [
					...(f.callsHelper ? [helper] : []),
					...Arr.map(f.callees, (callee) => defined(built.get(callee), `the callee ${callee}`))
				],
				args: Rec.fromEntries(Arr.map(f.args, (a) => [a.name, typeOf(a.type, headings)] as const)),
				returns: typeOf(f.returns, headings),
				volatility: f.volatility,
				language: f.language,
				body: templateOf(bodyParts(v, f), headings)
			})
		)
	}
	return Arr.map(v.functions, (f) => defined(built.get(f.name), `the function ${f.name}`))
}
