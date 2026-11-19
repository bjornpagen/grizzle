import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	type DeclaredLanguage,
	declaredLanguages,
	type FunctionVolatility,
	functionVolatilities
} from "#compiler/core/function.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import { isValidText } from "#compiler/core/text.ts"
import {
	builtNode,
	type FieldDesc,
	type FunctionBodyDesc,
	type FunctionDesc,
	type FunctionTypeDesc,
	type HeadingDesc,
	type NamedDesc
} from "#compiler/ir/desc.ts"
import {
	builderLoc,
	frozenCopy,
	malformed,
	ownedDesc,
	ownedEntry,
	ownValue,
	requireName
} from "#compiler/schema/protocol.ts"
import { valueTypeOf } from "#compiler/schema/relation.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type {
	AnyFunction,
	AnyRows,
	DeclaredFunction,
	FunctionBody,
	Rows
} from "#compiler/types/schema/function.ts"

/**
 * The builders of a declared function (fn) and of the heading whose rows a function takes or returns (rows).
 *
 * A declared function is the application's own PostgreSQL function, a schema object its level lists beside its
 * relations: its name, its typed arguments, its result, its volatility, and its body, PL/pgSQL or SQL text the
 * application owns, carried byte for byte. Its argument and result types are field descriptors, a value of one, or
 * rows of a heading of them. The builders read the descriptors once, into the function's Description
 * (ir/desc.ts FunctionDesc), and ownership judges which types a signature admits (schema/own.ts).
 */

/** The field descriptors of a heading or a signature, each a value type no writing of its own declares. */
const valueDesc = (value: unknown, label: string): FieldDesc =>
	valueTypeOf(value, label, () =>
		malformed(label, "a value type, which no field of a writing of its own is")
	).desc

/** A heading's fields in declared order, at least one, each a value type. */
const headingOf = (fields: unknown, label: string): HeadingDesc => {
	if (!isPlainRecord(fields)) {
		throw malformed(label, "a record of field descriptors")
	}
	const heading = Object.entries(fields).map(([name, value]): NamedDesc<FieldDesc> => ({
		name: requireName(name, label, "a field name"),
		type: valueDesc(value, `${label} field ${name}`)
	}))
	if (!isNonEmpty(heading)) {
		throw malformed(label, "a heading of at least one field")
	}
	return Object.freeze(heading)
}

/**
 * rows(fields): the heading of the rows a declared function takes as an argument or returns, its fields in the order
 * the record writes them, which is its row type's attribute order. Its Description is the heading itself.
 */
export const rowsBuilder = <const Fields extends Readonly<Record<string, FieldBase>>>(
	fields: Fields,
	extra: ReadonlyArray<unknown>
): Rows<Fields> => {
	if (extra.length > 0) {
		throw malformed("rows", "rows(fields): one argument")
	}
	const heading = headingOf(fields, "rows")
	return ownValue({
		kind: "rows",
		value: { ...builtMark, kind: "rows", fields: frozenCopy(fields) },
		desc: heading,
		content: undefined
	})
}

/** A run of a body's text: storable, as the text PostgreSQL stores whole. */
const bodyText = (text: unknown, label: string): string => {
	if (typeof text !== "string" || !isValidText(text)) {
		throw malformed(label, "body: the function's text, storable, each escape of it a character's")
	}
	return text
}

/**
 * fn.body`...`: a declared function's body, the application's PL/pgSQL or SQL text as a template literal reads it,
 * each placeholder a heading rows() built, which the installation names by its row type's name alone, the one the
 * function's pinned search_path resolves (physical/ddl/functions.ts). Its Description is the text and, between its
 * runs, the headings it names (ir/desc.ts FunctionBodyDesc); ownership holds each to a heading of the function's own
 * signature or a callee's (schema/function-own.ts).
 */
export const bodyBuilder = (
	strings: TemplateStringsArray,
	rowTypes: ReadonlyArray<AnyRows>
): FunctionBody => {
	const label = "fn.body"
	const [text, ...after] = strings.map((run, i) => bodyText(run, `${label} text ${i}`))
	const headings = rowTypes.map((value, i) => {
		const heading = ownedEntry(value, "rows")
		if (heading === undefined) {
			throw malformed(`${label} placeholder ${i}`, "a heading built by rows(...)")
		}
		return heading.desc
	})
	const desc: FunctionBodyDesc = Object.freeze({
		text: bodyText(text, label),
		named: Object.freeze(
			headings.map((rowType, i) =>
				Object.freeze({ rowType, text: bodyText(after[i], `${label} text ${i + 1}`) })
			)
		)
	})
	return ownValue({ kind: "body", value: { ...builtMark, kind: "body" }, desc, content: undefined })
}

/** The Description of a declared function a builder made, or undefined for any other value. */
export const functionDescOf = (value: unknown): FunctionDesc | undefined =>
	ownedDesc(value, "function")

/** What an argument or the result of a declared function is: rows of a heading rows() built, or a value of a field. */
const functionTypeOf = (value: unknown, label: string): FunctionTypeDesc => {
	const heading = ownedEntry(value, "rows")
	return heading === undefined
		? { kind: "value", type: valueDesc(value, label) }
		: { kind: "rows", heading: heading.desc }
}

/** The members a declared function's definition states, and no other. */
const definitionKeys = ["calls", "args", "returns", "volatility", "language", "body"] as const

/** The names of the declared functions a body calls, each once, in code point order: a list of functions fn built. */
const callsOf = (calls: unknown, label: string): ReadonlyArray<string> => {
	if (!isList(calls)) {
		throw malformed(label, "calls: a list of the declared functions its body calls")
	}
	const names = calls.map((callee, i) => {
		const desc = functionDescOf(callee)
		if (desc === undefined) {
			throw malformed(`${label} call ${i}`, "a declared function built by fn(...)")
		}
		return desc.name
	})
	return Object.freeze([...new Set(names)].toSorted(compareStrings))
}

const isVolatility = (value: unknown): value is FunctionVolatility =>
	functionVolatilities.some((v) => v === value)

const isLanguage = (value: unknown): value is DeclaredLanguage =>
	declaredLanguages.some((l) => l === value)

/** The admission core of fn(name, definition): a JavaScript caller's arguments checked and described. */
const admitFunction = (
	name: unknown,
	definition: unknown,
	extra: ReadonlyArray<unknown>
): FunctionDesc => {
	const label = `function ${typeof name === "string" ? name : "?"}`
	const functionName = requireName(name, label, "a function name")
	if (extra.length > 0) {
		throw malformed(label, "fn(name, definition): two arguments")
	}
	if (
		!isPlainRecord(definition) ||
		Object.keys(definition).some((k) => !definitionKeys.some((d) => d === k))
	) {
		throw malformed(label, `a definition of ${definitionKeys.join(", ")}`)
	}
	const { calls, args, returns, volatility, language, body } = definition
	if (!isPlainRecord(args)) {
		throw malformed(label, "args: a record of argument types")
	}
	if (!isVolatility(volatility)) {
		throw malformed(label, `volatility: one of ${functionVolatilities.join(", ")}`)
	}
	if (!isLanguage(language)) {
		throw malformed(label, `language: one of ${declaredLanguages.join(", ")}`)
	}
	const bodyDesc = ownedDesc(body, "body")
	if (bodyDesc === undefined) {
		throw malformed(label, "body: the function's text, fn.body`...`")
	}
	return builtNode({
		name: functionName,
		calls: callsOf(calls, label),
		args: Object.freeze(
			Object.entries(args).map(([arg, type]) => ({
				name: requireName(arg, label, "an argument name"),
				type: functionTypeOf(type, `${label} argument ${arg}`)
			}))
		),
		returns: functionTypeOf(returns, `${label} result`),
		volatility,
		language,
		body: bodyDesc,
		loc: builderLoc(label, [functionName])
	})
}

/**
 * fn(name, definition): a declared function, which a level lists among its relations, `schema("App", [...relations,
 * f], statements)`. Its value holds its name, its argument types by name, its result type and its volatility; its
 * Description holds the functions its body calls and its body too.
 */
export const fnBuilder = <
	const Name extends string,
	const Args extends Readonly<Record<string, FieldBase | AnyRows>>,
	const Returns extends FieldBase | AnyRows,
	const V extends FunctionVolatility
>(
	name: Name,
	definition: {
		readonly calls: ReadonlyArray<AnyFunction>
		readonly args: Args
		readonly returns: Returns
		readonly volatility: V
		readonly language: DeclaredLanguage
		readonly body: FunctionBody
	},
	extra: ReadonlyArray<unknown>
): DeclaredFunction<Name, Args, Returns, V> => {
	const desc = admitFunction(name, definition, extra)
	return ownValue({
		kind: "function",
		value: {
			...builtMark,
			kind: "function",
			name,
			args: frozenCopy(definition.args),
			returns: definition.returns,
			volatility: definition.volatility,
			language: definition.language
		},
		desc,
		content: undefined
	})
}
