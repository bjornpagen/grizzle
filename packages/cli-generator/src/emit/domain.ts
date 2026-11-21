import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	Array as Arr,
	Data,
	Effect,
	JsonPointer,
	Option,
	Order,
	Predicate,
	Record,
	Result
} from "effect"
import type { EmittedFile } from "#emit/package.ts"
import {
	arr,
	arrow,
	bool,
	call,
	fixedIdentifier,
	fixedMemberName,
	fixedModuleSpecifier,
	ident,
	isIdentifier,
	member,
	num,
	obj,
	printModule,
	str,
	typeApply,
	typedArrow,
	typeKeyword,
	typeQuery
} from "#emit/printer.ts"
import type { Expr, Identifier, Module, Statement, TypeExpr } from "#emit/printer.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { domainNamespace } from "#names/domain.ts"
import type { SafeIdentifier } from "#names/fold.ts"
import { codeGenerationCopy } from "#normalize/schemas.ts"

/**
 * The code-generation copy cannot become `domain/schemas.ts`. `identifier-mismatch`: a copy key has no name in the
 * identifier map, or two keys share one, so a cli or api module would import what the module does not export.
 * `unresolved-reference`: a `$ref` names no definition of the copy, which normalize repairs before the copy is made.
 * `unsupported-definition`: a schema position holds neither an object nor a boolean, or a `const` or an `enum` holds
 * an object or an array, which normalize removes first. `unprintable-code`: the printer refuses the module.
 */
export class DomainEmitError extends Data.TaggedError("DomainEmitError")<{
	readonly reason:
		| "identifier-mismatch"
		| "unprintable-code"
		| "unresolved-reference"
		| "unsupported-definition"
}> {}

/** A JSON Schema `type` one scalar reader of read.ts reads. */
type ScalarType = "boolean" | "integer" | "null" | "number" | "string"

/** A JSON Schema `type`. */
type JsonType = ScalarType | "array" | "object"

const jsonTypes: ReadonlyArray<JsonType> = [
	"array",
	"boolean",
	"integer",
	"null",
	"number",
	"object",
	"string"
]

/** The keywords whose value is one number, each the reader of read.ts of its name (`Read.minimum(1)`). */
type LimitKeyword =
	| "exclusiveMaximum"
	| "exclusiveMinimum"
	| "maxItems"
	| "maxLength"
	| "maxProperties"
	| "maximum"
	| "minItems"
	| "minLength"
	| "minProperties"
	| "minimum"
	| "multipleOf"

const limitKeywords: ReadonlyArray<LimitKeyword> = [
	"exclusiveMaximum",
	"exclusiveMinimum",
	"maxItems",
	"maxLength",
	"maxProperties",
	"maximum",
	"minItems",
	"minLength",
	"minProperties",
	"minimum",
	"multipleOf"
]

/** A JSON value with no members, `null` aside: what `const` and `enum` name besides `null`. */
type Primitive = boolean | number | string

/**
 * One schema as a reader of read.ts reads it:
 * - every value, or none;
 * - a scalar type;
 * - one primitive, or one of several (`const`, `enum`);
 * - a reading or `null` (`type` beside `"null"`, an `anyOf` of a schema and `{ type: "null" }`);
 * - an array's items, or a tuple (`prefixItems`, then `items`, `false` refusing any more);
 * - an object's declared members (`properties`, `required`) and what reads the others (`additionalProperties`,
 *   `false` refusing them), a map of one item type, or any object;
 * - a keyword of one JSON type (`minimum`, `uniqueItems`, `propertyNames`), which passes a value of another;
 * - an object's or an array's structure where `type` names neither, which passes a value of another type;
 * - a definition of the copy (`$ref`);
 * - a conjunction (`allOf`, and the keywords of one schema object);
 * - alternatives (`anyOf`, `oneOf`).
 */
type Reading =
	| { readonly _tag: "Anything" }
	| { readonly _tag: "Never" }
	| { readonly _tag: "Scalar"; readonly type: ScalarType }
	| { readonly _tag: "Literal"; readonly value: Primitive }
	| { readonly _tag: "Enumeration"; readonly values: Arr.NonEmptyReadonlyArray<Primitive> }
	| { readonly _tag: "Nullable"; readonly reading: Reading }
	| { readonly _tag: "Items"; readonly item: Reading }
	| {
			readonly _tag: "Tuple"
			readonly prefix: ReadonlyArray<Reading>
			readonly rest: Reading | false
	  }
	| {
			readonly _tag: "Struct"
			readonly members: ReadonlyArray<Member>
			readonly additional: Reading | false
	  }
	| { readonly _tag: "Map"; readonly item: Reading }
	| { readonly _tag: "AnyObject" }
	| { readonly _tag: "Limit"; readonly keyword: LimitKeyword; readonly limit: number }
	| { readonly _tag: "UniqueItems" }
	| { readonly _tag: "PropertyNames"; readonly names: Reading }
	| { readonly _tag: "When"; readonly type: "array" | "object"; readonly reading: Reading }
	| { readonly _tag: "Reference"; readonly key: string; readonly name: Identifier }
	| {
			readonly _tag: "All"
			readonly first: Reading
			readonly rest: Arr.NonEmptyReadonlyArray<Reading>
	  }
	| {
			readonly _tag: "Alternatives"
			readonly mode: "anyOf" | "oneOf"
			readonly alternatives: Arr.NonEmptyReadonlyArray<Reading>
	  }

/** A declared member of an object: its name, whether `required` lists it, and its reading. */
interface Member {
	readonly name: string
	readonly required: boolean
	readonly reading: Reading
}

const anything: Reading = { _tag: "Anything" }

const never: Reading = { _tag: "Never" }

const nullValue: Reading = { _tag: "Scalar", type: "null" }

/**
 * How precisely a reading's type says what it admits, most precise first. A conjunction reads its value by every
 * conjunct and answers it as its most precise conjunct, the first of the most precise, reads it: its type is that
 * conjunct's, sound since every conjunct admits the value, where no reader builds an intersection without a cast.
 */
const precisions = ["literal", "typed", "reference", "alternatives", "keyword"] as const

type Precision = (typeof precisions)[number]

const precisionOf = (reading: Reading): Precision => {
	switch (reading._tag) {
		case "Never":
		case "Literal":
		case "Enumeration":
			return "literal"
		case "Nullable":
			return precisionOf(reading.reading)
		case "All":
			return precisionOf(reading.first)
		case "Scalar":
		case "Items":
		case "Tuple":
		case "Struct":
		case "Map":
		case "AnyObject":
			return "typed"
		case "Reference":
			return "reference"
		case "Alternatives":
			return "alternatives"
		case "Anything":
		case "Limit":
		case "UniqueItems":
		case "PropertyNames":
		case "When":
			return "keyword"
	}
}

const byPrecision = Order.mapInput(Order.Number, (reading: Reading) =>
	precisions.indexOf(precisionOf(reading))
)

/** The conjuncts of a reading: an `All`'s own, any other reading alone. */
const conjunctsOf = (reading: Reading): ReadonlyArray<Reading> =>
	reading._tag === "All" ? [reading.first, ...reading.rest] : [reading]

/**
 * Every conjunct at once: one that admits nothing makes the conjunction admit nothing, and every value is no
 * conjunct; the most precise of the rest reads first (the sort is stable, so the first of equals), then each other.
 */
const conjoin = (parts: ReadonlyArray<Reading>): Reading => {
	if (Arr.some(parts, (part) => part._tag === "Never")) {
		return never
	}

	const kept = Arr.filter(Arr.flatMap(parts, conjunctsOf), (part) => part._tag !== "Anything")
	const [first, ...rest] = Arr.sort(kept, byPrecision)
	if (first === undefined) {
		return anything
	}

	return Arr.isReadonlyArrayNonEmpty(rest) ? { _tag: "All", first, rest } : first
}

const isNull = (reading: Reading): boolean => reading._tag === "Scalar" && reading.type === "null"

/** A reading or `null`: beside every value, every value; beside none, `null` alone. */
const nullable = (reading: Reading): Reading => {
	if (reading._tag === "Anything" || reading._tag === "Nullable" || isNull(reading)) {
		return reading
	}

	return reading._tag === "Never" ? nullValue : { _tag: "Nullable", reading }
}

/**
 * Alternatives. An `anyOf` holding every value admits every value, one that admits nothing adds nothing to it, and of
 * two, one beside `null` alone is that one or `null`. A `oneOf` keeps each alternative, since one that admits what
 * another admits refuses the value. None admits nothing, and one alone is itself.
 */
const alternatives = (mode: "anyOf" | "oneOf", readings: ReadonlyArray<Reading>): Reading => {
	if (mode === "anyOf" && Arr.some(readings, (reading) => reading._tag === "Anything")) {
		return anything
	}

	const kept =
		mode === "anyOf" ? Arr.filter(readings, (reading) => reading._tag !== "Never") : readings
	const [first, second, ...more] = kept
	if (first === undefined) {
		return never
	}

	if (second === undefined) {
		return first
	}

	if (mode === "anyOf" && more.length === 0 && (isNull(first) || isNull(second))) {
		return nullable(isNull(first) ? second : first)
	}

	return { _tag: "Alternatives", alternatives: [first, second, ...more], mode }
}

type Read<A> = Result.Result<A, DomainEmitError>

const unsupported = (): Read<never> =>
	Result.fail(new DomainEmitError({ reason: "unsupported-definition" }))

const keyword = (node: JsonObject, name: string): Option.Option<Json> => Record.get(node, name)

/** The types `type` declares: one type, or a list of types; a value that names anything else declares none. */
const declaredTypes = (node: JsonObject): Option.Option<ReadonlyArray<JsonType>> =>
	Option.flatMap(keyword(node, "type"), (value) => {
		const named = Arr.dedupe(isArray(value) ? value : [value])
		const types = Arr.filter(jsonTypes, (type) => Arr.contains(named, type))

		return types.length === named.length ? Option.some(types) : Option.none()
	})

const objectKeywords: ReadonlyArray<string> = ["additionalProperties", "properties", "required"]

const arrayKeywords: ReadonlyArray<string> = ["items", "prefixItems"]

const holdsAny = (node: JsonObject, names: ReadonlyArray<string>): boolean =>
	Arr.some(names, (name) => Record.has(node, name))

/** Whether a primitive's JSON type is among `types`: an integer is a `number`, and an `integer` too. */
const conforms = (types: ReadonlyArray<JsonType>, value: Primitive | null): boolean => {
	if (value === null) {
		return Arr.contains(types, "null")
	}

	if (Predicate.isNumber(value)) {
		return (
			Arr.contains(types, "number") || (Arr.contains(types, "integer") && Number.isInteger(value))
		)
	}

	return Arr.contains(types, Predicate.isString(value) ? "string" : "boolean")
}

const isScalarType = (type: JsonType): boolean => type !== "array" && type !== "object"

const isPrimitive = (value: Json): value is Primitive | null =>
	value === null ||
	Predicate.isString(value) ||
	Predicate.isNumber(value) ||
	Predicate.isBoolean(value)

/** What reads a schema position: `true` every value, `false` none, an object by its keywords. */
const readingOf = (schema: Json, names: ReadonlyMap<string, Identifier>): Read<Reading> => {
	if (Predicate.isBoolean(schema)) {
		return Result.succeed(schema ? anything : never)
	}

	return isObject(schema) ? schemaReading(schema, names) : unsupported()
}

/** What reads a schema position that `false` makes refuse (`items`, `additionalProperties`): every value when absent. */
const restOf = (
	node: JsonObject,
	name: string,
	names: ReadonlyMap<string, Identifier>
): Read<Reading | false> =>
	Option.match(keyword(node, name), {
		onNone: () => Result.succeed(anything),
		onSome: (value) => (value === false ? Result.succeed(false) : readingOf(value, names))
	})

const byMemberName = Order.mapInput(Order.String, (declared: Member) => declared.name)

/**
 * An object by `properties`, `required` and `additionalProperties`: each declared member, by name, read by its
 * property's schema, or, for a name `required` lists alone, by what reads the other members, so it is never where they
 * are refused; then the other members. With no declared member: an object that refuses every member, a map, or any
 * object.
 */
const objectReading = (node: JsonObject, names: ReadonlyMap<string, Identifier>): Read<Reading> =>
	Result.flatMap(restOf(node, "additionalProperties", names), (additional) => {
		const properties = Option.getOrElse(
			Option.filter(keyword(node, "properties"), isObject),
			() => ({})
		)
		const required = Arr.filter(
			Option.getOrElse(Option.filter(keyword(node, "required"), isArray), () => []),
			Predicate.isString
		)
		const others = additional === false ? never : additional
		const declared = Arr.dedupe([...Record.keys(properties), ...required])

		return Result.map(
			Result.all(
				Arr.map(declared, (name) =>
					Result.map(
						Option.match(Record.get(properties, name), {
							onNone: () => Result.succeed(others),
							onSome: (schema) => readingOf(schema, names)
						}),
						(reading): Member => ({ name, reading, required: Arr.contains(required, name) })
					)
				)
			),
			(members): Reading => {
				if (Arr.isReadonlyArrayNonEmpty(members) || additional === false) {
					return { _tag: "Struct", additional, members: Arr.sort(members, byMemberName) }
				}

				return additional._tag === "Anything"
					? { _tag: "AnyObject" }
					: { _tag: "Map", item: additional }
			}
		)
	})

/** An array by `prefixItems` and `items`: a tuple where either fixes a position, else its items. */
const arrayReading = (node: JsonObject, names: ReadonlyMap<string, Identifier>): Read<Reading> =>
	Result.flatMap(restOf(node, "items", names), (rest) =>
		Option.match(Option.filter(keyword(node, "prefixItems"), isArray), {
			onNone: (): Read<Reading> =>
				Result.succeed(
					rest === false ? { _tag: "Tuple", prefix: [], rest } : { _tag: "Items", item: rest }
				),
			onSome: (items) =>
				Result.map(
					Result.all(Arr.map(items, (item) => readingOf(item, names))),
					(prefix): Reading => ({ _tag: "Tuple", prefix, rest })
				)
		})
	)

const typeReading = (
	node: JsonObject,
	type: JsonType,
	names: ReadonlyMap<string, Identifier>
): Read<Reading> => {
	if (type === "object") {
		return objectReading(node, names)
	}

	return type === "array" ? arrayReading(node, names) : Result.succeed({ _tag: "Scalar", type })
}

/** What `type` admits, and the types it names. */
interface Typed {
	readonly reading: Reading
	readonly types: ReadonlyArray<JsonType>
}

/**
 * What `type` admits, each type read by its own keywords; none where `type` declares none. JSON types are disjoint, so
 * their alternatives are an `anyOf`.
 */
const typedReading = (
	node: JsonObject,
	names: ReadonlyMap<string, Identifier>
): Read<Option.Option<Typed>> =>
	Option.match(declaredTypes(node), {
		onNone: () => Result.succeed(Option.none()),
		onSome: (declared) =>
			Result.map(
				Result.all(Arr.map(declared, (type) => typeReading(node, type, names))),
				(readings) => Option.some({ reading: alternatives("anyOf", readings), types: declared })
			)
	})

/**
 * The structure of an object or an array a schema holds where `type` declares no type: read where the value is of that
 * type, as JSON Schema applies an object's keywords to objects alone, and every other value passing.
 */
const untypedReadings = (
	node: JsonObject,
	names: ReadonlyMap<string, Identifier>
): Read<ReadonlyArray<Reading>> => {
	const kinds = Option.isSome(declaredTypes(node))
		? []
		: Arr.filter(["object", "array"] as const, (type) =>
				holdsAny(node, type === "object" ? objectKeywords : arrayKeywords)
			)

	return Result.all(
		Arr.map(kinds, (type) =>
			Result.map(typeReading(node, type, names), (reading): Reading => ({
				_tag: "When",
				reading,
				type
			}))
		)
	)
}

/** The primitives one `const` or `enum` admits, as one reading: one, several, or either beside `null`. */
const valuesReading = (values: ReadonlyArray<Primitive | null>): Reading => {
	const [first, ...rest] = Arr.dedupe(Arr.filter(values, Predicate.isNotNull))
	const primitives: Reading =
		first === undefined
			? never
			: Arr.isReadonlyArrayNonEmpty(rest)
				? { _tag: "Enumeration", values: [first, ...rest] }
				: { _tag: "Literal", value: first }

	return Arr.contains(values, null) ? nullable(primitives) : primitives
}

/** The values one `const` or `enum` admits, and their reading. */
interface Listed {
	readonly reading: Reading
	readonly values: ReadonlyArray<Primitive | null>
}

const listedReadings = (node: JsonObject): Read<ReadonlyArray<Listed>> => {
	const lists = [
		...Option.toArray(Option.map(keyword(node, "const"), (value): ReadonlyArray<Json> => [value])),
		...Option.toArray(Option.filter(keyword(node, "enum"), isArray))
	]

	return Result.all(
		Arr.map(lists, (list) =>
			Arr.every(list, isPrimitive)
				? Result.succeed({ reading: valuesReading(list), values: list })
				: unsupported()
		)
	)
}

/** The definition a `$ref` names, `#/$defs/<key>` for a key of the copy, under its export name. */
const referenceReading = (ref: string, names: ReadonlyMap<string, Identifier>): Read<Reading> => {
	const [defs, key, ...more] = JsonPointer.parseUriFragment(ref) ?? []
	const name =
		defs === "$defs" && more.length === 0 && key !== undefined ? names.get(key) : undefined

	return key === undefined || name === undefined
		? Result.fail(new DomainEmitError({ reason: "unresolved-reference" }))
		: Result.succeed({ _tag: "Reference", key, name })
}

/** The schemas of a list keyword (`allOf`, `anyOf`, `oneOf`), each read; none when the schema holds no such list. */
const listReadings = (
	node: JsonObject,
	name: string,
	names: ReadonlyMap<string, Identifier>
): Read<Option.Option<ReadonlyArray<Reading>>> =>
	Option.match(Option.filter(keyword(node, name), isArray), {
		onNone: () => Result.succeed(Option.none()),
		onSome: (schemas) =>
			Result.map(Result.all(Arr.map(schemas, (schema) => readingOf(schema, names))), Option.some)
	})

/**
 * The keywords of one JSON type a schema holds: each limit that holds a number, `uniqueItems: true`, and a
 * `propertyNames` that refuses some name.
 */
const keywordReadings = (
	node: JsonObject,
	names: ReadonlyMap<string, Identifier>
): Read<ReadonlyArray<Reading>> => {
	const limits = Arr.flatMap(limitKeywords, (name) =>
		Option.toArray(
			Option.map(Option.filter(keyword(node, name), Predicate.isNumber), (limit): Reading => ({
				_tag: "Limit",
				keyword: name,
				limit
			}))
		)
	)
	const unique: ReadonlyArray<Reading> = Option.exists(
		keyword(node, "uniqueItems"),
		(value) => value === true
	)
		? [{ _tag: "UniqueItems" }]
		: []

	return Result.map(
		Option.match(keyword(node, "propertyNames"), {
			onNone: () => Result.succeed(anything),
			onSome: (schema) =>
				Result.map(readingOf(schema, names), (keys): Reading =>
					keys._tag === "Anything" ? anything : { _tag: "PropertyNames", names: keys }
				)
		}),
		(propertyNames) => [...limits, ...unique, propertyNames]
	)
}

/** Whether `not` holds the schema every value meets, so the schema admits none. */
const negatesEverything = (node: JsonObject): boolean =>
	Option.exists(
		keyword(node, "not"),
		(value) => value === true || (isObject(value) && Record.isEmptyReadonlyRecord(value))
	)

/**
 * A schema object by its keywords, which all hold at once: `not: {}` admits nothing; then `const` and `enum`; `type`
 * with each type's structure, left out where `const` and `enum` admit only values of its types and those are scalars;
 * `$ref`; each member of `allOf`; `anyOf`; `oneOf`; an object's or an array's structure where `type` names no type;
 * and the keywords of one JSON type. Annotations, extensions and the keywords normalize leaves out of the copy read
 * nothing.
 */
const schemaReading = (node: JsonObject, names: ReadonlyMap<string, Identifier>): Read<Reading> => {
	if (negatesEverything(node)) {
		return Result.succeed(never)
	}

	return Result.gen(function* conjunction() {
		const listed = yield* listedReadings(node)
		const typed = yield* typedReading(node, names)
		const implied = Option.exists(
			typed,
			({ types }) =>
				Arr.isReadonlyArrayNonEmpty(listed) &&
				Arr.every(types, isScalarType) &&
				Arr.every(listed, ({ values }) => Arr.every(values, (value) => conforms(types, value)))
		)
		const reference = yield* Option.match(
			Option.filter(keyword(node, "$ref"), Predicate.isString),
			{
				onNone: () => Result.succeed(anything),
				onSome: (ref) => referenceReading(ref, names)
			}
		)
		const all = yield* listReadings(node, "allOf", names)
		const anyOf = yield* listReadings(node, "anyOf", names)
		const oneOf = yield* listReadings(node, "oneOf", names)
		const keywords = yield* keywordReadings(node, names)
		const untyped = yield* untypedReadings(node, names)

		return conjoin([
			...Arr.map(listed, ({ reading }) => reading),
			...(implied ? [] : Option.toArray(Option.map(typed, ({ reading }) => reading))),
			reference,
			...Option.getOrElse(all, () => []),
			...Option.toArray(Option.map(anyOf, (readings) => alternatives("anyOf", readings))),
			...Option.toArray(Option.map(oneOf, (readings) => alternatives("oneOf", readings))),
			...untyped,
			...keywords
		])
	})
}

/** The readings a reading holds, one level down. */
const childrenOf = (reading: Reading): ReadonlyArray<Reading> => {
	switch (reading._tag) {
		case "Nullable":
			return [reading.reading]
		case "Items":
		case "Map":
			return [reading.item]
		case "Tuple":
			return [...reading.prefix, ...(reading.rest === false ? [] : [reading.rest])]
		case "Struct":
			return [
				...Arr.map(reading.members, (declared) => declared.reading),
				...(reading.additional === false ? [] : [reading.additional])
			]
		case "PropertyNames":
			return [reading.names]
		case "When":
			return [reading.reading]
		case "All":
			return [reading.first, ...reading.rest]
		case "Alternatives":
			return reading.alternatives
		case "Anything":
		case "Never":
		case "Scalar":
		case "Literal":
		case "Enumeration":
		case "AnyObject":
		case "Limit":
		case "UniqueItems":
		case "Reference":
			return []
	}
}

type Reference = Extract<Reading, { readonly _tag: "Reference" }>

/** The references a reading holds, in reading order. */
const referencesOf = (reading: Reading): ReadonlyArray<Reference> =>
	reading._tag === "Reference" ? [reading] : Arr.flatMap(childrenOf(reading), referencesOf)

/**
 * The references that close a cycle of definitions: a depth-first walk of the definitions in key order, each one's
 * references in reading order, and each reference to a definition the walk is still inside. Every cycle of a graph
 * holds a back edge of any depth-first walk of it, so typing those references as any value's leaves no definition's
 * inferred type depending on its own, while every other reference keeps its definition's type.
 */
const closingReferences = (readings: ReadonlyMap<string, Reading>): ReadonlySet<Reading> => {
	const closing = new Set<Reading>()
	const done = new Set<string>()
	const inside = new Set<string>()
	const visit = (key: string): void => {
		const reading = readings.get(key)
		if (reading === undefined || done.has(key)) {
			return
		}

		done.add(key)
		inside.add(key)
		for (const reference of referencesOf(reading)) {
			if (inside.has(reference.key)) {
				closing.add(reference)
			}

			visit(reference.key)
		}

		inside.delete(key)
	}
	for (const key of Arr.sort(readings.keys(), Order.String)) {
		visit(key)
	}

	return closing
}

const readName = fixedIdentifier(domainNamespace[0])

const read = (name: string): Expr => member(ident(readName), fixedMemberName(name))

const readCall = (name: string, args: ReadonlyArray<Expr>): Expr => call(read(name), args)

const readType = (name: string, args: ReadonlyArray<TypeExpr>): TypeExpr =>
	typeApply(readName, [fixedMemberName(name)], args)

const objectName = fixedIdentifier("object")

const scalarReaders: Readonly<Record<ScalarType, string>> = {
	boolean: "boolean",
	integer: "integer",
	null: "nullValue",
	number: "number",
	string: "string"
}

const primitiveExpr = (value: Primitive): Expr => {
	if (Predicate.isString(value)) {
		return str(value)
	}

	return Predicate.isNumber(value) ? num(value) : bool(value)
}

/**
 * Where a reading is written: at its definition's top, where the module's statements run in name order, so a reference
 * there reads its definition lazily; or inside a struct's member reads, which run when a value is read, after every
 * definition is, so a reference there names its definition.
 */
type Place = "top" | "read"

/**
 * A reference, by its definition's name where a value is read and through `Read.lazy` at a definition's top. One that
 * closes a cycle states its reader as any value's, `(): Read.Reader<unknown> =>`, so no definition's type is inferred
 * from its own.
 */
const referenceExpr = (name: Identifier, closes: boolean, place: Place): Expr => {
	if (closes) {
		return readCall("lazy", [
			typedArrow([], ident(name), readType("Reader", [typeKeyword("unknown")]))
		])
	}

	return place === "read" ? ident(name) : readCall("lazy", [arrow([], ident(name))])
}

/** A reading as read.ts's combinators write it. */
const exprOf = (reading: Reading, closing: ReadonlySet<Reading>, place: Place): Expr => {
	const of = (inner: Reading): Expr => exprOf(inner, closing, place)
	const restExpr = (rest: Reading | false): Expr => (rest === false ? bool(false) : of(rest))
	switch (reading._tag) {
		case "Anything":
			return read("anything")
		case "Never":
			return read("nothing")
		case "Scalar":
			return read(scalarReaders[reading.type])
		case "Literal":
			return readCall("literal", [primitiveExpr(reading.value)])
		case "Enumeration":
			return readCall("enumeration", [arr(Arr.map(reading.values, primitiveExpr))])
		case "Nullable":
			return readCall("nullable", [of(reading.reading)])
		case "Items":
			return readCall("array", [of(reading.item)])
		case "Tuple":
			return readCall("tuple", [arr(Arr.map(reading.prefix, of)), restExpr(reading.rest)])
		case "Struct":
			return readCall("object", [
				arrow(
					Arr.isReadonlyArrayNonEmpty(reading.members) ? [{ name: objectName }] : [],
					obj(
						Arr.map(reading.members, (declared) => [
							declared.name,
							readCall(declared.required ? "member" : "optionalMember", [
								ident(objectName),
								str(declared.name),
								exprOf(declared.reading, closing, "read")
							])
						])
					)
				),
				restExpr(reading.additional)
			])
		case "Map":
			return readCall("record", [read("string"), of(reading.item)])
		case "AnyObject":
			return read("members")
		case "Limit":
			return readCall(reading.keyword, [num(reading.limit)])
		case "UniqueItems":
			return read("uniqueItems")
		case "PropertyNames":
			return readCall("propertyNames", [of(reading.names)])
		case "When":
			return readCall(reading.type === "object" ? "whenObject" : "whenArray", [of(reading.reading)])
		case "Reference":
			return referenceExpr(reading.name, closing.has(reading), place)
		case "All":
			return readCall("allOf", [of(reading.first), arr(Arr.map(reading.rest, of))])
		case "Alternatives":
			return readCall(reading.mode === "anyOf" ? "union" : "oneOf", [
				arr(Arr.map(reading.alternatives, of))
			])
	}
}

/**
 * One definition's two statements: its type, as TypeScript infers it from its reader (`Read.TypeOf<typeof X>`), so
 * the compiler proves every type the module states, and its reader.
 */
const statementsOf = (name: Identifier, value: Expr): ReadonlyArray<Statement> => [
	{ _tag: "TypeAlias", name, type: readType("TypeOf", [typeQuery(name)]) },
	{ _tag: "Const", exported: true, name, value }
]

/** A definition of the copy: its key, its export name and its schema. */
interface Definition {
	readonly key: string
	readonly name: Identifier
	readonly schema: Json
}

const mismatch = (): Read<never> =>
	Result.fail(new DomainEmitError({ reason: "identifier-mismatch" }))

/** Each definition of the copy under its export name: every key named, and no name given twice. */
const definitionsOf = (
	copy: ReadonlyMap<string, Json>,
	identifiers: ReadonlyMap<string, SafeIdentifier>
): Read<ReadonlyArray<Definition>> =>
	Result.flatMap(
		Result.all(
			Arr.map([...copy], ([key, schema]) =>
				Option.match(Option.filter(Option.fromUndefinedOr(identifiers.get(key)), isIdentifier), {
					onNone: mismatch,
					onSome: (name) => Result.succeed({ key, name, schema })
				})
			)
		),
		(definitions) =>
			Arr.dedupe(Arr.map(definitions, ({ name }) => name)).length === definitions.length
				? Result.succeed(definitions)
				: mismatch()
	)

const modulePath = "src/domain/schemas.ts"

const emptyModule = "export {};\n"

const domainImport = {
	_tag: "Namespace",
	from: fixedModuleSpecifier(domainNamespace[1]),
	name: readName,
	typeOnly: false
} as const

const byExportName = Order.mapInput(Order.String, (definition: Definition) => definition.name)

/**
 * Emits `domain/schemas.ts` (design 3.5, 3.6, units EM-2, S1): one narrowing reader of read.ts per definition of the
 * code-generation copy of `roots` (normalize's validation copy reached from them, examples and defaults removed), under
 * the names plan's identifier (`domainIdentifiers`), its type beside it, in name order. A reader admits exactly what
 * its JSON Schema admits, by JSON Schema's semantics over the keywords the copy holds: a closed object refuses a member
 * it does not declare (SCH-13), and a keyword beside a `$ref` reads with its target (SCH-03). It fails with every place
 * the value breaks the schema, each its path and its refusal (read.ts ReadIssue), which the runtime words. A
 * discriminator is a hint that changes no reading (D-OQ9, DSC-06): `anyOf` admits by its first admitting alternative,
 * `oneOf` by its one. A recursive definition reads itself through its name. The copy holds no format but `binary` and
 * `byte`, and those are strings.
 */
export const emitDomainSchemas = (
	validation: ReadonlyMap<string, Json>,
	roots: ReadonlyArray<string>,
	identifiers: ReadonlyMap<string, SafeIdentifier>
): Effect.Effect<EmittedFile, DomainEmitError> =>
	Effect.gen(function* emit() {
		const copy = codeGenerationCopy(validation, roots)
		if (copy.size === 0) {
			return { content: emptyModule, path: modulePath }
		}

		const definitions = yield* Effect.fromResult(definitionsOf(copy, identifiers))
		const names = new Map(Arr.map(definitions, ({ key, name }) => [key, name] as const))
		const readings = yield* Effect.fromResult(
			Result.all(
				Arr.map(Arr.sort(definitions, byExportName), (definition) =>
					Result.map(readingOf(definition.schema, names), (reading) => ({ ...definition, reading }))
				)
			)
		)
		const closing = closingReferences(
			new Map(Arr.map(readings, ({ key, reading }) => [key, reading] as const))
		)
		const module: Module = {
			imports: [domainImport],
			statements: Arr.flatMap(readings, ({ name, reading }) =>
				statementsOf(name, exprOf(reading, closing, "top"))
			)
		}
		const content = yield* Effect.mapError(
			printModule(module),
			() => new DomainEmitError({ reason: "unprintable-code" })
		)

		return { content, path: modulePath }
	})
