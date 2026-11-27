import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { admitHostKey } from "#compiler/core/brand.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	type DeclaredLanguage,
	declaredLanguages,
	type FunctionNullInput,
	type FunctionVolatility,
	functionNullInputs,
	functionVolatilities
} from "#compiler/core/function.ts"
import { hostRead } from "#compiler/core/host.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import { isValidText } from "#compiler/core/text.ts"
import {
	type BodyPlaceholderDesc,
	builtNode,
	type FieldDesc,
	type FunctionBodyDesc,
	type FunctionDesc,
	type FunctionTypeDesc,
	type HeadingDesc,
	type NamedDesc,
	type VariantSpellingDesc
} from "#compiler/ir/desc.ts"
import { ownedContractNames } from "#compiler/scalar/contract.ts"
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
import { type VariantArmParts, type VariantParts, variantDesc } from "#compiler/schema/variant.ts"
import type {
	AnyFunction,
	AnyRows,
	DeclaredFunction,
	FunctionBody,
	FunctionType,
	Row,
	Rows,
	VariantSpelling
} from "#compiler/types/schema/function.ts"

/**
 * The builders of a declared function (fn), of the heading whose rows a function takes or returns (rows), and of one
 * row of a heading (row).
 *
 * A declared function is the application's own PostgreSQL function, a schema object its level lists beside its
 * relations: its name, its typed arguments, its result, its volatility, what it does with a NULL argument (its null
 * input, `called` or `strict`, which every declaration states, since neither is a default), and its body, PL/pgSQL or
 * SQL text the application owns, carried byte for byte. Its argument and result types, and a heading's fields, are each a value of a
 * field descriptor, rows of a heading, or one row of a heading. The builders read them once, into the function's
 * Description (ir/desc.ts FunctionDesc), and ownership judges which types a signature admits (schema/own.ts).
 *
 * A heading's fields and a function's arguments are each a set of names, and PostgreSQL reads both by position: a row
 * type's attributes (`ROW(...)::<row type>`, a row read back) and a function's parameters (`f(a, b)`, `$1`). So both
 * stand in one order grizzle defines, code point order of their names (byName), the order oxlint's sort-keys holds a
 * record's keys to, and never in the order a record's keys were written: a record written in any key order installs
 * the same row type and the same function.
 */

/**
 * A record's members in code point order of their names: the order a heading's fields install in, its row type's
 * attributes, and a function's arguments, its parameters, whatever order the record's keys were written in.
 */
const byName = <T>(record: Readonly<Record<string, T>>): ReadonlyArray<readonly [string, T]> =>
	Object.entries(record).toSorted(([a], [b]) => compareCodePoints(a, b))

/**
 * A copy of `record` whose keys are set in code point order of their names (byName), each holding its value: the record
 * a built heading holds, which a query reads a call's sources and variables off, so every reader of it reads one order
 * of its keys whatever order they were written in. (JavaScript keeps a key that names an array index before every other,
 * in numeric order, which is one order of them too.)
 */
const nameOrdered = <T extends Readonly<Record<string, unknown>>>(record: T): T => {
	const copy = { ...record }
	for (const [name, value] of byName(record)) {
		Reflect.deleteProperty(copy, name)
		Reflect.set(copy, name, value)
	}
	return copy
}

/** The field descriptors of a heading or a signature, each a value type no writing of its own declares. */
const valueDesc = (value: unknown, label: string): FieldDesc =>
	valueTypeOf(value, label, () =>
		malformed(label, "a value type, which no field of a writing of its own is")
	).desc

/**
 * What an argument, the result or a heading's field is: rows of a heading rows() built, one row of a heading row()
 * built, or a value of a field.
 */
const functionTypeOf = (value: unknown, label: string): FunctionTypeDesc => {
	const heading = ownedEntry(value, "rows")
	if (heading !== undefined) {
		return { kind: "rows", heading: heading.desc }
	}
	const row = ownedEntry(value, "row")
	if (row !== undefined) {
		return { kind: "row", heading: row.desc }
	}
	return { kind: "value", type: valueDesc(value, label) }
}

/**
 * The names of the consumers' contracts a function type holds a value of at any depth (scalar/contract.ts
 * ownedContractNames): its value's type's, or each field's of the heading of its rows or its row; each once, in code
 * point order.
 */
const ownedNames = (t: FunctionTypeDesc): ReadonlyArray<string> => {
	switch (t.kind) {
		case "value":
			return ownedContractNames(t.type).toSorted(compareCodePoints)
		case "rows":
		case "row":
			return [...new Set(t.heading.flatMap((field) => ownedNames(field.type)))].toSorted(
				compareCodePoints
			)
	}
}

/**
 * What a declared function takes after its definition, `mints`, as a JavaScript caller passes it (types/schema MintsOf):
 * where its result holds a value of a consumer's contract, a record of each such contract's key by the contract's name,
 * each a value mintOf would take (core/brand.ts admitHostKey), since its body makes the contract's values; nothing
 * otherwise. Whose each key is, the types judge.
 */
const admitMints = (
	result: FunctionTypeDesc,
	mints: ReadonlyArray<unknown>,
	label: string
): void => {
	const names = ownedNames(result)
	const [first] = names
	if (first === undefined) {
		if (mints.length > 0) {
			throw malformed(label, "fn(name, definition): two arguments")
		}
		return
	}
	const [record, ...extra] = mints
	if (
		extra.length > 0 ||
		!isPlainRecord(record) ||
		Object.keys(record).toSorted(compareCodePoints).join("\n") !== names.join("\n")
	) {
		throw malformed(
			label,
			`fn(name, definition, mints): its result holds ${names.join(", ")}, a consumer's contract its body makes values of, so mints holds each one's key by its name, { ${first}: key }`
		)
	}
	for (const name of names) {
		admitHostKey(record[name], `${label} mint ${name}`)
	}
}

/** A heading's fields by name (byName), at least one, each a value type, rows of a heading or one row of one. */
const headingOf = (fields: unknown, label: string): HeadingDesc => {
	if (!isPlainRecord(fields)) {
		throw malformed(label, "a record of field descriptors, headings and rows of headings")
	}
	const heading = byName(fields).map(([name, value]): NamedDesc<FunctionTypeDesc> => ({
		name: requireName(name, label, "a field name"),
		type: functionTypeOf(value, `${label} field ${name}`)
	}))
	if (!isNonEmpty(heading)) {
		throw malformed(label, "a heading of at least one field")
	}
	return Object.freeze(heading)
}

/**
 * rows(fields): the heading of the rows a declared function takes as an argument or returns, its fields in code point
 * order of their names (byName), which is its row type's attribute order, each a value, rows of another heading (an
 * array of its row type) or one row of one (a value of its row type). Its Description is the heading itself.
 */
export const rowsBuilder = <const Fields extends Readonly<Record<string, FunctionType>>>(
	fields: Fields,
	extra: ReadonlyArray<unknown>
): Rows<Fields> => {
	if (extra.length > 0) {
		throw malformed("rows", "rows(fields): one argument")
	}
	const heading = headingOf(fields, "rows")
	return ownValue({
		kind: "rows",
		value: { ...builtMark, kind: "rows", fields: frozenCopy(nameOrdered(fields)) },
		desc: heading,
		content: undefined
	})
}

/**
 * row(heading): one row of a heading rows() built, a value of its row type: an argument, a result or a heading's field
 * that is a composite, not an array or a set of rows. Its Description is the heading's.
 */
export const rowBuilder = <const Heading extends AnyRows>(
	heading: Heading,
	extra: ReadonlyArray<unknown>
): Row<Heading> => {
	if (extra.length > 0) {
		throw malformed("row", "row(heading): one argument")
	}
	const built = ownedEntry(heading, "rows")
	if (built === undefined) {
		throw malformed("row", "row(heading): a heading built by rows(...)")
	}
	return ownValue({
		kind: "row",
		value: { ...builtMark, kind: "row", heading },
		desc: built.desc,
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
 * function's pinned search_path resolves (physical/ddl/functions.ts), or a variant's spelling, its code of an arm, an
 * arm field's attribute or a value of an arm (schema/variant.ts variantSpellings). Its Description is the text and,
 * between its runs, what it names (ir/desc.ts FunctionBodyDesc); ownership holds each heading to one of the function's
 * own signature or a callee's (schema/function-own.ts).
 */
export const bodyBuilder = (
	strings: TemplateStringsArray,
	placeholders: ReadonlyArray<AnyRows | VariantSpelling>
): FunctionBody => {
	const label = "fn.body"
	const [text, ...after] = strings.map((run, i) => bodyText(run, `${label} text ${i}`))
	const named = placeholders.map((value, i): BodyPlaceholderDesc => {
		const runAfter = bodyText(after[i], `${label} text ${i + 1}`)
		const heading = ownedEntry(value, "rows")
		if (heading !== undefined) {
			return Object.freeze({ rowType: heading.desc, text: runAfter })
		}
		const spelling = ownedEntry(value, "spelling")
		if (spelling !== undefined) {
			return Object.freeze({ spelling: spelling.desc, text: runAfter })
		}
		throw malformed(
			`${label} placeholder ${i}`,
			"a heading built by rows(...), or a variant's code, attribute or value"
		)
	})
	const desc: FunctionBodyDesc = Object.freeze({
		text: bodyText(text, label),
		named: Object.freeze(named)
	})
	return ownValue({ kind: "body", value: { ...builtMark, kind: "body" }, desc, content: undefined })
}

/** The Description of a declared function a builder made, or undefined for any other value. */
export const functionDescOf = (value: unknown): FunctionDesc | undefined =>
	ownedDesc(value, "function")

/** The members a declared function's definition states, and no other. */
const definitionKeys = [
	"calls",
	"args",
	"returns",
	"volatility",
	"nullInput",
	"language",
	"body"
] as const

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

const isNullInput = (value: unknown): value is FunctionNullInput =>
	functionNullInputs.some((n) => n === value)

/**
 * The admission core of fn(name, definition, mints): a JavaScript caller's arguments checked and described, `mints`
 * what follows the definition (admitMints).
 */
const admitFunction = (
	name: unknown,
	definition: unknown,
	mints: ReadonlyArray<unknown>
): FunctionDesc => {
	const label = `function ${typeof name === "string" ? name : "?"}`
	const functionName = requireName(name, label, "a function name")
	if (
		!isPlainRecord(definition) ||
		Object.keys(definition).some((k) => !definitionKeys.some((d) => d === k))
	) {
		throw malformed(label, `a definition of ${definitionKeys.join(", ")}`)
	}
	const { calls, args, returns, volatility, nullInput, language, body } = definition
	if (!isPlainRecord(args)) {
		throw malformed(label, "args: a record of argument types")
	}
	if (!isVolatility(volatility)) {
		throw malformed(label, `volatility: one of ${functionVolatilities.join(", ")}`)
	}
	if (!isNullInput(nullInput)) {
		throw malformed(label, `nullInput: one of ${functionNullInputs.join(", ")}`)
	}
	if (!isLanguage(language)) {
		throw malformed(label, `language: one of ${declaredLanguages.join(", ")}`)
	}
	const bodyDesc = ownedDesc(body, "body")
	if (bodyDesc === undefined) {
		throw malformed(label, "body: the function's text, fn.body`...`")
	}
	const result = functionTypeOf(returns, `${label} result`)
	admitMints(result, mints, label)
	const declared = {
		name: functionName,
		calls: callsOf(calls, label),
		args: Object.freeze(
			byName(args).map(([arg, type]) => ({
				name: requireName(arg, label, "an argument name"),
				type: functionTypeOf(type, `${label} argument ${arg}`)
			}))
		),
		returns: result,
		volatility,
		language,
		body: bodyDesc,
		loc: builderLoc(label, [functionName])
	}
	return builtNode(nullInput === "strict" ? { ...declared, nullInput } : declared)
}

/**
 * fn(name, definition, mints): a declared function, which a level lists among its relations, `schema("App",
 * [...relations, f], statements)`, and the keys of the consumers' contracts its result holds (admitMints). Its value
 * holds its name, its argument types by name, its result type, its volatility and its null input; its Description holds
 * its arguments in code point order of their names (byName), its parameters' order, the functions its body calls and
 * its body too.
 */
export const fnBuilder = <
	const Name extends string,
	const Args extends Readonly<Record<string, FunctionType>>,
	const Returns extends FunctionType,
	const V extends FunctionVolatility,
	const N extends FunctionNullInput
>(
	name: Name,
	definition: {
		readonly calls: ReadonlyArray<AnyFunction>
		readonly args: Args
		readonly returns: Returns
		readonly volatility: V
		readonly nullInput: N
		readonly language: DeclaredLanguage
		readonly body: FunctionBody
	},
	mints: ReadonlyArray<unknown>
): DeclaredFunction<Name, Args, Returns, V, N> => {
	const desc = admitFunction(name, definition, mints)
	return ownValue({
		kind: "function",
		value: {
			...builtMark,
			kind: "function",
			name,
			args: frozenCopy(definition.args),
			returns: definition.returns,
			volatility: definition.volatility,
			nullInput: definition.nullInput,
			language: definition.language
		},
		desc,
		content: undefined
	})
}

/**
 * A variant's spellings in a declared function's body (ir/desc.ts VariantSpellingDesc), each a value fn.body takes as
 * a placeholder: `code(handle)`, the code of an arm; `attribute(handle, field)`, the attribute an arm's field's value is;
 * `of(handle, fields)`, a value of an arm, `fields` exactly the arm's, each the SQL text of its value. A handle no arm
 * holds, a field the arm lacks, or a record of fields not exactly the arm's is refused, so no spelling names an attribute
 * or a code the variant does not hold. Its reading of `fields` runs the caller's code at most once (core/host.ts
 * hostRead).
 */
export const variantSpellings = (
	parts: VariantParts
): {
	readonly code: (handle: unknown) => VariantSpelling
	readonly attribute: (handle: unknown, field: unknown) => VariantSpelling
	readonly of: (handle: unknown, fields: unknown) => VariantSpelling
} => {
	const variant = variantDesc(parts)
	const label = `variant ${parts.name}`
	const armOf = (handle: unknown, what: string): VariantArmParts => {
		const arm = parts.arms.find((a) => a.handle === handle)
		if (typeof handle !== "string" || arm === undefined) {
			throw malformed(
				`${label} ${what}`,
				`an arm of the variant: ${parts.arms.map((a) => a.handle).join(", ")}`
			)
		}
		return arm
	}
	const fieldNames = (arm: VariantArmParts): string => arm.fields.map(([name]) => name).join(", ")
	const spelling = (desc: VariantSpellingDesc): VariantSpelling =>
		ownValue({
			kind: "spelling",
			value: { ...builtMark, kind: "spelling" },
			desc: Object.freeze(desc),
			content: undefined
		})
	return Object.freeze({
		code: (handle: unknown) =>
			spelling({ kind: "code", variant, handle: armOf(handle, "code").handle }),
		attribute: (handle: unknown, field: unknown) => {
			const arm = armOf(handle, "attribute")
			if (typeof field !== "string" || !arm.fields.some(([name]) => name === field)) {
				throw malformed(
					`${label} attribute`,
					`a field of the arm ${arm.handle}: ${fieldNames(arm)}`
				)
			}
			return spelling({ kind: "attribute", variant, handle: arm.handle, field })
		},
		of: (handle: unknown, fields: unknown) => {
			const arm = armOf(handle, "of")
			const refused = (): CompileError =>
				malformed(
					`${label} of`,
					`the SQL text of each field of the arm ${arm.handle}, exactly: ${fieldNames(arm)}`
				)
			const read = hostRead(
				refused,
				(): Result.Result<
					ReadonlyArray<{ readonly name: string; readonly sql: string }>,
					CompileError
				> => {
					if (
						!isPlainRecord(fields) ||
						Object.keys(fields).length !== arm.fields.length ||
						arm.fields.some(([name]) => typeof fields[name] !== "string")
					) {
						return Result.err(refused())
					}
					return Result.ok(arm.fields.map(([name]) => ({ name, sql: String(fields[name]) })))
				}
			)
			if (!read.ok) {
				throw read.error
			}
			return spelling({ kind: "of", variant, handle: arm.handle, fields: read.value })
		}
	})
}
