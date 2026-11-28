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
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import {
	type DeclaredLanguage,
	type FunctionNullInput,
	type FunctionVolatility,
	functionNullInputs
} from "#compiler/core/function.ts"
import { conversionOf } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { date, natural, uuid, bool, float8, int4, int8, numeric } from "#compiler/public/fields.ts"
import {
	type AnyFunction,
	type AnyRows,
	type FunctionBody,
	type FunctionType,
	fn,
	row,
	rows
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { bodyBuilder } from "#compiler/schema/function.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { byCodePoints } from "#test/support/key-order.ts"

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
	integer: int4,
	bigint: int8,
	"double precision": float8,
	numeric: numeric(12, 2),
	boolean: bool,
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

/** A heading of a case: its fields in order, each a name and a type, a field of rows or of a row holding a heading
 * drawn before it. */
export interface HeadingSketch {
	readonly fields: NonEmptyReadonlyArray<readonly [string, TypeSketch]>
}

/** What a function takes or returns, or a heading's field holds: a value, rows of the case's heading at `heading`, or
 * one row of it. */
export type TypeSketch =
	| { readonly kind: "value"; readonly type: ValueType }
	| { readonly kind: "rows" | "row"; readonly heading: number }

/** How a body's text is spelled around its statements: each spelling is one a migration file must carry exactly. */
export const spellings = ["plain", "tabbed", "dollar quotes", "trailing dollar"] as const
export type Spelling = (typeof spellings)[number]

/**
 * A function of a case: its name, arguments, result, volatility, null input, language and its body's spelling; whether its body
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
	readonly nullInput: FunctionNullInput
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

const valueGen: Gen<TypeSketch> = (source) => ({
	kind: "value",
	type: source.draw(element(valueTypes))
})

/** A type over the first `headings` headings of a case: a value where there is none. */
const typeGen = (headings: number): Gen<TypeSketch> =>
	headings === 0
		? valueGen
		: oneOf<TypeSketch>([
				valueGen,
				(source) => ({
					kind: source.draw(element(["rows", "row"] as const)),
					heading: source.draw(int(0, headings - 1))
				})
			])

/** The heading at `at` of a case: each field a value, or rows or a row of a heading before it. */
const headingGen =
	(at: number): Gen<HeadingSketch> =>
	(source) => {
		const names = source.draw(array(element(fieldNames), { min: 1, max: 3 }))
		const distinct = Arr.dedupe(names)
		return {
			fields: mapNonEmpty(
				nonEmpty(distinct, "a heading's fields"),
				(name) => [name, source.draw(typeGen(at))] as const
			)
		}
	}

/** A case's headings: one to three, each over the ones before it. */
const headingsGen: Gen<NonEmptyReadonlyArray<HeadingSketch>> = (source) => {
	const count = source.draw(int(1, 3))
	return nonEmpty(
		Array.from({ length: count }, (_, at) => source.draw(headingGen(at))),
		"a case's headings"
	)
}

/** The heading of a version at `at`. */
const headingAt = (v: Pick<Declarations, "headings">, at: number): HeadingSketch =>
	defined(v.headings[at], `heading ${at}`)

/**
 * A heading's fields as PostgreSQL holds them, its row type's attributes: in their names' code point order, whatever
 * order the sketch drew them in, which its rows() record writes them in (test/support/key-order.ts).
 */
export const attributesOf = (h: HeadingSketch): ReadonlyArray<readonly [string, TypeSketch]> =>
	Arr.sort(
		h.fields,
		Order.mapInput(byCodePoints, ([name]: readonly [string, TypeSketch]) => name)
	)

/**
 * A function's arguments as PostgreSQL holds them, its parameters: in their names' code point order, whatever order the
 * sketch drew them in, which its args record writes them in.
 */
export const parametersOf = (f: Pick<FunctionSketch, "args">): FunctionSketch["args"] =>
	Arr.sort(
		f.args,
		Order.mapInput(byCodePoints, (a: FunctionSketch["args"][number]) => a.name)
	)

/** The headings a type names: the heading it is rows or a row of, then each heading a field of that one names. */
const namedByType = (v: Pick<Declarations, "headings">, t: TypeSketch): ReadonlyArray<number> =>
	t.kind === "value"
		? []
		: [t.heading, ...Arr.flatMap(headingAt(v, t.heading).fields, ([, f]) => namedByType(v, f))]

/** The argument whose value a function's result of rows or of a row is, of the same kind and heading: the body returns
 * it. */
const returnsAnArgument = (args: FunctionSketch["args"], returns: TypeSketch): string | undefined =>
	returns.kind === "value"
		? undefined
		: Option.getOrUndefined(
				Option.map(
					Arr.findFirst(
						args,
						(a) => a.type.kind === returns.kind && a.type.heading === returns.heading
					),
					(a) => a.name
				)
			)

/** The headings a signature names: those its arguments and result are rows or a row of, and those their fields name. */
const signatureHeadings = (
	v: Pick<Declarations, "headings">,
	f: Pick<FunctionSketch, "args" | "returns">
): ReadonlyArray<number> =>
	Arr.dedupe(
		Arr.flatMap([...Arr.map(f.args, (a) => a.type), f.returns], (t: TypeSketch) =>
			namedByType(v, t)
		)
	)

/** The function of a version by its name. */
const functionNamed = (v: Declarations, name: FunctionName): FunctionSketch =>
	defined(
		Arr.findFirst(v.functions, (f) => f.name === name).pipe(Option.getOrUndefined),
		`the function ${name}`
	)

/** The headings a function's body may name: those its own signature or a callee's names. */
export const reachOf = (v: Declarations, f: FunctionSketch): ReadonlyArray<number> =>
	Arr.dedupe([
		...signatureHeadings(v, f),
		...Arr.flatMap(f.callees, (callee) => signatureHeadings(v, functionNamed(v, callee)))
	])

/**
 * A function drawn after `earlier`, which it may call: its signature over the case's `headings`, and the headings its
 * body names, drawn from its reach where `anyHeading` is false, from every heading of the case where it is true.
 */
const functionGen =
	(
		headings: NonEmptyReadonlyArray<HeadingSketch>,
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
						type: s.draw(typeGen(headings.length))
					}),
					{ min: 0, max: 3 }
				)
			),
			(a, b) => a.name === b.name
		)
		const returns = source.draw(typeGen(headings.length))
		const sqlAdmitted = returns.kind !== "rows" || returnsAnArgument(args, returns) !== undefined
		const callees = source.draw(
			subset(
				Arr.map(earlier, (f) => f.name),
				{ min: 0, max: earlier.length }
			)
		)
		const signature = { args, returns }
		const v = { headings }
		const reach = Arr.dedupe([
			...signatureHeadings(v, signature),
			...Arr.flatMap(callees, (callee) =>
				signatureHeadings(
					v,
					defined(
						Arr.findFirst(earlier, (f) => f.name === callee).pipe(Option.getOrUndefined),
						`the callee ${callee}`
					)
				)
			)
		])
		const nameable = anyHeading ? Array.from({ length: headings.length }, (_, i) => i) : reach
		return {
			name,
			args,
			returns,
			volatility: source.draw(element(["immutable", "stable", "volatile"] as const)),
			nullInput: source.draw(element(functionNullInputs)),
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
		const headings = source.draw(headingsGen)
		const names = Arr.dedupe(source.draw(array(element(functionNames), { min: 1, max: 3 })))
		const none: ReadonlyArray<FunctionSketch> = []
		const functions = Arr.reduce(names, none, (earlier, name) => [
			...earlier,
			source.draw(functionGen(headings, name, earlier, anyHeading))
		])
		return { headings, functions }
	}

/** A part of a body: its text, or a heading it names, by its place among the case's headings. */
export type Part = string | { readonly heading: number }

/** The helper every body that calls one calls: a declared PL/pgSQL function of no argument returning 1. */
export const helperName = "helper"

/**
 * The composite of NULLs a body passes for a value of `t`: a NULL of a value's type; one row of a heading, each field's
 * own composite of NULLs, cast to its row type by its name; or an array of one such row.
 */
const valueParts = (v: Declarations, t: TypeSketch): ReadonlyArray<Part> => {
	switch (t.kind) {
		case "value":
			return [`NULL::${spelled[t.type]}`]
		case "row":
			return [
				"ROW(",
				...Arr.flatMap(attributesOf(headingAt(v, t.heading)), ([, f], i) => [
					...(i === 0 ? [] : [", "]),
					...valueParts(v, f)
				]),
				")::",
				{ heading: t.heading }
			]
		case "rows":
			return ["ARRAY[", ...valueParts(v, { kind: "row", heading: t.heading }), "]"]
	}
}

/** A function's installed name: its declared name's conversion, which a body calls it by. */
export const installedName = (name: string): string => conversionOf(parsedName(name))

/** A call of `callee` with a composite of NULLs for each of its arguments. */
const callParts = (v: Declarations, callee: FunctionSketch): ReadonlyArray<Part> => [
	`${quoteIdent(installedName(callee.name))}(`,
	...Arr.flatMap(parametersOf(callee), (a, i) => [
		...(i === 0 ? [] : [", "]),
		...valueParts(v, a.type)
	]),
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
 * it returns NULL for a value; no row, or the rows of an argument of its result's heading, for rows; and for one row
 * the argument of that row, or a row of NULLs built of its row type's name.
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
			const result: ReadonlyArray<Part> = (() => {
				switch (f.returns.kind) {
					case "value":
						return ["RETURN NULL;"]
					case "rows":
						return [
							passed === undefined
								? "RETURN;"
								: `RETURN QUERY SELECT * FROM unnest(${quoteIdent(passed)});`
						]
					case "row":
						return [
							"RETURN ",
							...(passed === undefined ? valueParts(v, f.returns) : [quoteIdent(passed)]),
							";"
						]
				}
			})()
			const lines: ReadonlyArray<ReadonlyArray<Part>> = [
				...(declared.length === 0 ? [] : [["DECLARE"], ...declared]),
				["BEGIN"],
				...(f.callsHelper ? [[`PERFORM ${helperName}();`]] : []),
				...Arr.map(callees, (call) => ["PERFORM ", ...call, ";"]),
				result,
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
			const selected: ReadonlyArray<Part> = (() => {
				switch (f.returns.kind) {
					case "value":
						return [`SELECT NULL::${spelled[f.returns.type]}`]
					case "rows":
						return [
							`SELECT * FROM unnest(${quoteIdent(defined(passed, "the argument an SQL body returns"))})`
						]
					case "row":
						return [
							"SELECT ",
							...(passed === undefined ? valueParts(v, f.returns) : [quoteIdent(passed)])
						]
				}
			})()
			return spelledParts(f.spelling, [[...selected, ...where]], "--")
		}
	}
}

/** A body's text with each heading it names rendered by `heading`. */
export const bodyText = (parts: ReadonlyArray<Part>, heading: (at: number) => string): string =>
	Arr.join(
		Arr.map(parts, (p) => (typeof p === "string" ? p : heading(p.heading))),
		""
	)

/**
 * A heading's content as a key: its fields' names and the types PostgreSQL holds them as, in order, a field of rows or
 * of a row by `named`'s rendering of the heading it holds.
 */
export const headingKey = (
	v: Pick<Declarations, "headings">,
	at: number,
	named: (at: number) => string
): string =>
	Arr.join(
		Arr.map(attributesOf(headingAt(v, at)), ([name, t]) => {
			switch (t.kind) {
				case "value":
					return `${name} ${spelled[t.type]}`
				case "rows":
					return `${name} ${named(t.heading)}[]`
				case "row":
					return `${name} ${named(t.heading)}`
			}
		}),
		", "
	)

/** A heading's content as a key that names each heading it holds by its own content, in parentheses. */
export const contentKey = (v: Pick<Declarations, "headings">, at: number): string =>
	headingKey(v, at, (inner) => `(${contentKey(v, inner)})`)

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

/** The field, rows or row a sketch's type is, over the version's headings. */
const typeOf = (t: TypeSketch, headings: ReadonlyArray<AnyRows>): FunctionType => {
	switch (t.kind) {
		case "value":
			return fieldOf[t.type]
		case "rows":
			return defined(headings[t.heading], `heading ${t.heading}`)
		case "row":
			return row(defined(headings[t.heading], `heading ${t.heading}`))
	}
}

/** The helper's body. */
const helperBody = "\nBEGIN\n  RETURN 1;\nEND\n"

/** The helper, a declared function of no argument. */
export const helperOf = (): AnyFunction =>
	fn(helperName, {
		calls: [],
		args: {},
		returns: int4,
		volatility: "immutable",
		nullInput: "called",
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
	const none: ReadonlyArray<AnyRows> = []
	const headings = Arr.reduce(v.headings, none, (built, h) => [
		...built,
		rows(Rec.fromEntries(Arr.map(h.fields, ([name, t]) => [name, typeOf(t, built)] as const)))
	])
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
				nullInput: f.nullInput,
				language: f.language,
				body: templateOf(bodyParts(v, f), headings)
			})
		)
	}
	return Arr.map(v.functions, (f) => defined(built.get(f.name), `the function ${f.name}`))
}
