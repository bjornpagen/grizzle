import {
	Array as Arr,
	Equal,
	Number as Num,
	Option,
	Predicate,
	Record as Rec,
	Result
} from "effect"

/** A JSON value with no members: what `const` and `enum` name. */
export type Scalar = string | number | boolean | null

/** The JSON types a value can fail to be, as JSON Schema's `type` names them. */
export type JsonType = "string" | "number" | "integer" | "boolean" | "null" | "array" | "object"

/** The JSON Schema keywords that bound a number, a length, a count of items or of members, by one number. */
export type LimitKeyword =
	| "minimum"
	| "maximum"
	| "exclusiveMinimum"
	| "exclusiveMaximum"
	| "multipleOf"
	| "minLength"
	| "maxLength"
	| "minItems"
	| "maxItems"
	| "minProperties"
	| "maxProperties"

/**
 * Why a value fails where it fails, by the JSON Schema keyword it breaks: of another `type`; not the `const` a literal
 * expects, nor any value an `enum` lists; a member `required` lists and the object lacks; a member `additionalProperties: false`
 * refuses; an item past a tuple's `prefixItems` that `items: false` refuses; a value the `false` schema refuses; a
 * number, length or count outside a limit keyword's; items `uniqueItems` refuses; no alternative of an `anyOf` or
 * `oneOf` admitting it, each alternative's issues kept, their paths from the value the alternatives read; more than
 * one alternative of a `oneOf` admitting it; or a keyword of the caller's own (`check`, `refine`), with the reason the
 * caller gave. A refusal never holds the value, so a secret in a body stays out of it; its caller words it.
 */
export type Refusal =
	| { readonly _tag: "Type"; readonly expected: JsonType }
	| { readonly _tag: "Const"; readonly expected: Scalar }
	| { readonly _tag: "Enum"; readonly expected: Arr.NonEmptyReadonlyArray<Scalar> }
	| { readonly _tag: "Required" }
	| { readonly _tag: "AdditionalProperties" }
	| { readonly _tag: "AdditionalItems" }
	| { readonly _tag: "False" }
	| { readonly _tag: "Limit"; readonly keyword: LimitKeyword; readonly limit: number }
	| { readonly _tag: "UniqueItems" }
	| {
			readonly _tag: "NoAlternative"
			readonly alternatives: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<ReadIssue>>
	  }
	| { readonly _tag: "ManyAlternatives" }
	| { readonly _tag: "Keyword"; readonly reason: string }

/**
 * One place a value read from outside breaks what its reader admits: `path`, the member names and item indices from the
 * value's root down to the place, empty at the root, and the refusal there.
 */
export interface ReadIssue {
	readonly path: ReadonlyArray<string | number>
	readonly refusal: Refusal
}

/** Every place a value breaks its reader: at least one, or the value conforms. */
export type ReadIssues = Arr.NonEmptyReadonlyArray<ReadIssue>

/**
 * A narrowing reader of a value from outside (a request body, its parts, an event's data, a document's JSON, a file, a
 * child's answer): the value read as an A when it conforms; else every place it breaks the reader, never only the
 * first. A scalar's reader answers the value itself; an array's or a record's, a new container of what its item reader
 * read; a struct's, the struct `struct` gathers from its members' reads, typed field by field. The domain module of a
 * generated package writes one reader per schema from these, and the generator, its tests and its tools build theirs
 * from them too: no module reads a foreign value by combinators of its own.
 */
export type Reader<A> = (value: unknown) => Result.Result<A, ReadIssues>

/** The type a reader reads, so a generated domain module states each schema's type as its reader proves it. */
export type TypeOf<R> = R extends Reader<infer A> ? A : never

/** A JSON object's members, not yet read. */
export type Members = { readonly [member: string]: unknown }

/** An object's members by their names, as JSON reads them. */
const membersOf = (object: { readonly [member: PropertyKey]: unknown }): Members => object

/** A failure at the read value's root. */
const refused = (refusal: Refusal): Result.Result<never, ReadIssues> =>
	Result.fail([{ path: [], refusal }])

/** Issues placed under the member name or item index their value was read at. */
const under =
	(segment: string | number) =>
	(issues: ReadIssues): ReadIssues =>
		Arr.map(issues, (issue) => ({ path: [segment, ...issue.path], refusal: issue.refusal }))

/** A read's issues, none when it conformed. */
const issuesOf = (read: Result.Result<unknown, ReadIssues>): ReadonlyArray<ReadIssue> =>
	Option.getOrElse(Result.getFailure(read), () => [])

/** A reader of the values of one JSON type, which `admits` narrows to. */
const typed =
	<A>(admits: (value: unknown) => value is A, expected: JsonType): Reader<A> =>
	(value) =>
		admits(value) ? Result.succeed(value) : refused({ _tag: "Type", expected })

/** JSON Schema's `true`: every value, as it is. */
export const anything: Reader<unknown> = Result.succeed

/** JSON Schema's `false`, and `not: {}`: no value. */
export const nothing: Reader<never> = () => refused({ _tag: "False" })

/** JSON Schema's `type: string`. */
export const string: Reader<string> = typed(Predicate.isString, "string")

/** JSON Schema's `type: number`. */
export const number: Reader<number> = typed(Predicate.isNumber, "number")

/** JSON Schema's `type: integer`: a number with no fractional part. */
export const integer: Reader<number> = (value) =>
	Predicate.isNumber(value) && Number.isInteger(value)
		? Result.succeed(value)
		: refused({ _tag: "Type", expected: "integer" })

/** JSON Schema's `type: boolean`. */
export const boolean: Reader<boolean> = typed(Predicate.isBoolean, "boolean")

/** JSON Schema's `type: null`. */
export const nullValue: Reader<null> = typed(Predicate.isNull, "null")

/** JSON Schema's `type: object`, its members not yet read: what `member`, `optionalMember` and `struct` read. */
export const members: Reader<Members> = typed(Predicate.isObject, "object")

/** JSON Schema's `const`, and each member of an `enum`: the one value `expected` is. */
export const literal =
	<const L extends Scalar>(expected: L): Reader<L> =>
	(value) =>
		value === expected ? Result.succeed(expected) : refused({ _tag: "Const", expected })

/**
 * A reader with one more keyword of the caller's own: what `reader` reads and `holds` keeps, `reason` saying, in the
 * caller's words, what the keyword expects where `holds` refuses.
 */
export const check =
	<A>(reader: Reader<A>, holds: (value: A) => boolean, reason: string): Reader<A> =>
	(value) =>
		Result.flatMap(reader(value), (read) =>
			holds(read) ? Result.succeed(read) : refused({ _tag: "Keyword", reason })
		)

/**
 * A JSON Schema keyword over the values of one JSON type, which `applies` narrows to: a value of another type keeps
 * it, as JSON Schema's keywords are kept, so a keyword needs no `type` beside it; `allOf` joins it to one.
 */
const keyword =
	<A>(
		applies: (value: unknown) => value is A,
		keeps: (value: A) => boolean,
		refusal: Refusal
	): Reader<unknown> =>
	(value) =>
		!applies(value) || keeps(value) ? Result.succeed(value) : refused(refusal)

/** A text's length in code points, as JSON Schema counts it. */
const codePoints = (text: string): number => Arr.fromIterable(text).length

/** JSON Schema's `minimum`. */
export const minimum = (limit: number): Reader<unknown> =>
	keyword(Predicate.isNumber, (value) => value >= limit, {
		_tag: "Limit",
		keyword: "minimum",
		limit
	})

/** JSON Schema's `maximum`. */
export const maximum = (limit: number): Reader<unknown> =>
	keyword(Predicate.isNumber, (value) => value <= limit, {
		_tag: "Limit",
		keyword: "maximum",
		limit
	})

/** JSON Schema's `exclusiveMinimum`, a number. */
export const exclusiveMinimum = (limit: number): Reader<unknown> =>
	keyword(Predicate.isNumber, (value) => value > limit, {
		_tag: "Limit",
		keyword: "exclusiveMinimum",
		limit
	})

/** JSON Schema's `exclusiveMaximum`, a number. */
export const exclusiveMaximum = (limit: number): Reader<unknown> =>
	keyword(Predicate.isNumber, (value) => value < limit, {
		_tag: "Limit",
		keyword: "exclusiveMaximum",
		limit
	})

/** JSON Schema's `multipleOf`: a remainder of zero by the divisor's magnitude, decimals kept as effect's Number does. */
export const multipleOf = (divisor: number): Reader<unknown> =>
	keyword(Predicate.isNumber, (value) => Num.remainder(value, Math.abs(divisor)) === 0, {
		_tag: "Limit",
		keyword: "multipleOf",
		limit: divisor
	})

/** JSON Schema's `minLength`, in code points. */
export const minLength = (limit: number): Reader<unknown> =>
	keyword(Predicate.isString, (value) => codePoints(value) >= limit, {
		_tag: "Limit",
		keyword: "minLength",
		limit
	})

/** JSON Schema's `maxLength`, in code points. */
export const maxLength = (limit: number): Reader<unknown> =>
	keyword(Predicate.isString, (value) => codePoints(value) <= limit, {
		_tag: "Limit",
		keyword: "maxLength",
		limit
	})

/** JSON Schema's `minItems`. */
export const minItems = (limit: number): Reader<unknown> =>
	keyword<ReadonlyArray<unknown>>(Arr.isArray, (value) => value.length >= limit, {
		_tag: "Limit",
		keyword: "minItems",
		limit
	})

/** JSON Schema's `maxItems`. */
export const maxItems = (limit: number): Reader<unknown> =>
	keyword<ReadonlyArray<unknown>>(Arr.isArray, (value) => value.length <= limit, {
		_tag: "Limit",
		keyword: "maxItems",
		limit
	})

/** JSON Schema's `uniqueItems: true`: no two items equal as JSON values, compared by effect's structural equality. */
export const uniqueItems: Reader<unknown> = keyword<ReadonlyArray<unknown>>(
	Arr.isArray,
	(value) => Arr.dedupeWith(value, Equal.equals).length === value.length,
	{ _tag: "UniqueItems" }
)

/** JSON Schema's `minProperties`. */
export const minProperties = (limit: number): Reader<unknown> =>
	keyword(Predicate.isObject, (value) => Rec.size(membersOf(value)) >= limit, {
		_tag: "Limit",
		keyword: "minProperties",
		limit
	})

/** JSON Schema's `maxProperties`. */
export const maxProperties = (limit: number): Reader<unknown> =>
	keyword(Predicate.isObject, (value) => Rec.size(membersOf(value)) <= limit, {
		_tag: "Limit",
		keyword: "maxProperties",
		limit
	})

/** JSON Schema's `propertyNames`: each member's name read by `reader`, each issue under that name. */
export const propertyNames =
	(reader: Reader<unknown>): Reader<unknown> =>
	(value) => {
		if (!Predicate.isObject(value)) {
			return Result.succeed(value)
		}

		const issues = Arr.flatMap(Rec.keys(membersOf(value)), (name) =>
			issuesOf(Result.mapError(reader(name), under(name)))
		)
		return Arr.isReadonlyArrayNonEmpty(issues) ? Result.fail(issues) : Result.succeed(value)
	}

/**
 * A reader narrowed by a predicate: what `reader` reads and `holds` admits, as the `B` it proves, `reason` saying, in
 * the caller's words, what is expected where `holds` refuses. A brand's predicate makes its reader:
 * `refine(string, isJsonPointer, "a JSON Pointer")`.
 */
export const refine =
	<A, B extends A>(reader: Reader<A>, holds: (value: A) => value is B, reason: string): Reader<B> =>
	(value) =>
		Result.flatMap(reader(value), (read) =>
			holds(read) ? Result.succeed(read) : refused({ _tag: "Keyword", reason })
		)

/** JSON Schema's `type: array` with its `items`: every item read by `item`, each issue under its index. */
export const array =
	<A>(item: Reader<A>): Reader<ReadonlyArray<A>> =>
	(value) => {
		if (!Arr.isArray(value)) {
			return refused({ _tag: "Type", expected: "array" })
		}

		const reads = Arr.map(value, (element, index) => Result.mapError(item(element), under(index)))
		const issues = Arr.flatMap(reads, issuesOf)
		return Arr.isReadonlyArrayNonEmpty(issues) ? Result.fail(issues) : Result.all(reads)
	}

/**
 * JSON Schema's `type: object` read as a map: every member's name read by `key` (`propertyNames`) and its value by
 * `item` (`additionalProperties`), each issue under the member's name. Its keys are typed as Effect's records type
 * them: a branded key keeps its brand, and a literal one reads as `string`, since a map need not hold every literal.
 */
export const record =
	<K extends string, A>(
		key: Reader<K>,
		item: Reader<A>
	): Reader<Readonly<Record<Rec.ReadonlyRecord.NonLiteralKey<K>, A>>> =>
	(value) =>
		Result.flatMap(members(value), (read) => {
			const reads = Arr.map(Rec.toEntries(read), ([name, member]) => {
				const named = key(name)
				const valued = item(member)
				const issues = [...issuesOf(named), ...issuesOf(valued)]
				return Arr.isReadonlyArrayNonEmpty(issues)
					? Result.fail(under(name)(issues))
					: Result.all([named, valued])
			})
			const issues = Arr.flatMap(reads, issuesOf)
			return Arr.isReadonlyArrayNonEmpty(issues)
				? Result.fail(issues)
				: Result.map(Result.all(reads), Rec.fromEntries)
		})

/** The object's member `name`, read by `reader`; its absence is an issue at `name` (`required`). */
export const member = <A>(
	object: Members,
	name: string,
	reader: Reader<A>
): Result.Result<A, ReadIssues> =>
	Rec.has(object, name)
		? Result.mapError(reader(object[name]), under(name))
		: Result.fail([{ path: [name], refusal: { _tag: "Required" } }])

/** The object's member `name`, read by `reader` when it is there; none when it is absent. */
export const optionalMember = <A>(
	object: Members,
	name: string,
	reader: Reader<A>
): Result.Result<Option.Option<A>, ReadIssues> =>
	Rec.has(object, name)
		? Result.map(member(object, name, reader), Option.some)
		: Result.succeed(Option.none())

/** The reads gathered, each issue of `others` after theirs: `Result.all` of them, typed field by field, or every issue. */
const gathered = <const R extends Readonly<Record<string, Result.Result<unknown, ReadIssues>>>>(
	reads: R,
	others: ReadonlyArray<ReadIssue>
) => {
	const issues = [...Arr.flatMap(Rec.values(reads), issuesOf), ...others]
	return Arr.isReadonlyArrayNonEmpty(issues) ? Result.fail(issues) : Result.all(reads)
}

/**
 * Reads gathered into one struct: `Result.all` of them, typed field by field, when every one succeeds; else every
 * read's issues, never only the first's.
 */
export const all = <const R extends Readonly<Record<string, Result.Result<unknown, ReadIssues>>>>(
	reads: R
) => gathered(reads, [])

/**
 * JSON Schema's `type: object` with its `properties`, `required` and `additionalProperties`, read as a struct: `reads`
 * holds each declared member's read (`member` or `optionalMember`) under the member's own name, in declared order, and
 * `additional` reads each member of `object` that `reads` does not name; `false`, as `additionalProperties: false`,
 * refuses each such member at its name. The struct, typed field by field, when nothing fails; else every declared
 * member's issues, then every other member's.
 */
export const struct = <
	const R extends Readonly<Record<string, Result.Result<unknown, ReadIssues>>>
>(
	object: Members,
	reads: R,
	additional: Reader<unknown> | false
) =>
	gathered(
		reads,
		Arr.flatMap(Rec.toEntries(object), ([name, value]): ReadonlyArray<ReadIssue> => {
			if (Rec.has(reads, name)) {
				return []
			}

			return additional === false
				? [{ path: [name], refusal: { _tag: "AdditionalProperties" } }]
				: issuesOf(Result.mapError(additional(value), under(name)))
		})
	)

/**
 * The first of `reads` that succeeds, run in order and none after it; else every read's issues, in order. Each read
 * is a thunk, so an `anyOf` reads no alternative past the first that admits the value.
 */
const firstAdmitting = <A>(
	reads: Arr.NonEmptyReadonlyArray<() => Result.Result<A, ReadIssues>>
): Result.Result<A, Arr.NonEmptyReadonlyArray<ReadIssues>> =>
	Arr.reduce(
		Arr.tailNonEmpty(reads),
		Result.mapError(Arr.headNonEmpty(reads)(), Arr.of),
		(sofar: Result.Result<A, Arr.NonEmptyReadonlyArray<ReadIssues>>, read) =>
			Result.orElse(sofar, (failed) =>
				Result.mapError(read(), (issues) => Arr.append(failed, issues))
			)
	)

/** The refusal of a value no alternative admits, at its root, each alternative's issues kept. */
const noAlternative = (alternatives: Arr.NonEmptyReadonlyArray<ReadIssues>): ReadIssues => [
	{ path: [], refusal: { _tag: "NoAlternative", alternatives } }
]

/** Readers of the types of a tuple, position by position, so a union's type is inferred from its alternatives. */
export type Readers<T extends Arr.NonEmptyReadonlyArray<unknown>> = {
	readonly [K in keyof T]: Reader<T[K]>
}

/** The alternatives of a union as readers of what any of them reads. */
const alternativesOf = <T extends Arr.NonEmptyReadonlyArray<unknown>>(
	alternatives: Readers<T>
): Arr.NonEmptyReadonlyArray<Reader<T[number]>> => alternatives

/**
 * JSON Schema's `anyOf`: the value as the first alternative that admits it reads it, typed as the union of what the
 * alternatives read, inferred from them.
 */
export const union =
	<const T extends Arr.NonEmptyReadonlyArray<unknown>>(
		alternatives: Readers<T>
	): Reader<T[number]> =>
	(value) =>
		Result.mapError(
			firstAdmitting(
				Arr.map(alternativesOf(alternatives), (alternative) => () => alternative(value))
			),
			noAlternative
		)

/** JSON Schema's `oneOf`: the value as the one alternative that admits it reads it, typed as `union` types it. */
export const oneOf =
	<const T extends Arr.NonEmptyReadonlyArray<unknown>>(
		alternatives: Readers<T>
	): Reader<T[number]> =>
	(value) => {
		const reads = Arr.map(alternativesOf(alternatives), (alternative) => alternative(value))
		const admitting = Arr.getSomes(Arr.map(reads, Result.getSuccess)).length
		return Result.flatMap(
			Result.mapError(firstAdmitting(Arr.map(reads, (read) => () => read)), noAlternative),
			(read) => (admitting === 1 ? Result.succeed(read) : refused({ _tag: "ManyAlternatives" }))
		)
	}

/**
 * JSON Schema's `allOf`, and a `$ref` beside keywords of its own: the value as `first` reads it, when it and every one
 * of `rest` admit it; else every issue of every one of them.
 */
export const allOf =
	<A>(first: Reader<A>, rest: Arr.NonEmptyReadonlyArray<Reader<unknown>>): Reader<A> =>
	(value) => {
		const read = first(value)
		const issues = [...issuesOf(read), ...Arr.flatMap(rest, (reader) => issuesOf(reader(value)))]
		return Arr.isReadonlyArrayNonEmpty(issues) ? Result.fail(issues) : read
	}

/**
 * JSON Schema's `prefixItems` with its `items`: each item at a position `prefix` holds read by the reader there, each
 * item past them by `rest`; `false`, as `items: false`, refuses each such item at its index. An array shorter than
 * `prefix` holds only what it holds, as `prefixItems` asks no more; `minItems` bounds it.
 */
export const tuple =
	(
		prefix: ReadonlyArray<Reader<unknown>>,
		rest: Reader<unknown> | false
	): Reader<ReadonlyArray<unknown>> =>
	(value) => {
		if (!Arr.isArray(value)) {
			return refused({ _tag: "Type", expected: "array" })
		}

		const reads = Arr.map(value, (element, index): Result.Result<unknown, ReadIssues> => {
			const reader = Option.orElse(Arr.get(prefix, index), () =>
				rest === false ? Option.none() : Option.some(rest)
			)
			return Option.match(reader, {
				onNone: () => Result.fail([{ path: [index], refusal: { _tag: "AdditionalItems" } }]),
				onSome: (at) => Result.mapError(at(element), under(index))
			})
		})
		const issues = Arr.flatMap(reads, issuesOf)
		return Arr.isReadonlyArrayNonEmpty(issues) ? Result.fail(issues) : Result.all(reads)
	}

/**
 * An object read for its one member `name` alone, by `reader`, its absence an issue at `name` (`required`), its other
 * members left unread.
 */
export const property =
	<A>(name: string, reader: Reader<A>): Reader<A> =>
	(value) =>
		Result.flatMap(members(value), (object) => member(object, name, reader))

/** JSON Schema's `type: [T, "null"]`, and an `anyOf` of a schema and `type: null`: null, or what `reader` reads. */
export const nullable =
	<A>(reader: Reader<A>): Reader<A | null> =>
	(value) =>
		value === null ? Result.succeed(null) : reader(value)

/** JSON Schema's `enum`: the one of `values` the value is. */
export const enumeration =
	<const L extends Arr.NonEmptyReadonlyArray<Scalar>>(values: L): Reader<L[number]> =>
	(value) =>
		Option.match(
			Arr.findFirst(values, (candidate) => candidate === value),
			{
				onNone: () => refused({ _tag: "Enum", expected: values }),
				onSome: Result.succeed
			}
		)

/**
 * JSON Schema's `type: object` read as a struct in one step: `struct` over the object's members, `reads` naming each
 * declared member's read of them.
 */
export const object =
	<const R extends Readonly<Record<string, Result.Result<unknown, ReadIssues>>>>(
		reads: (object: Members) => R,
		additional: Reader<unknown> | false
	) =>
	(value: unknown) => {
		const read = members(value)
		return Result.isFailure(read)
			? Result.fail(read.failure)
			: struct(read.success, reads(read.success), additional)
	}

/** A reader applied to the values `applies` admits, every other value kept as it is. */
const applying =
	(applies: (value: unknown) => boolean, reader: Reader<unknown>): Reader<unknown> =>
	(value) =>
		applies(value) ? reader(value) : Result.succeed(value)

/**
 * An object's structure with no `type` beside it, as an `allOf` member that only adds `properties` holds: an object
 * read by `reader`, a value of another JSON type kept as it is, as JSON Schema keeps it.
 */
export const whenObject = (reader: Reader<unknown>): Reader<unknown> =>
	applying(Predicate.isObject, reader)

/** An array's structure with no `type` beside it: an array read by `reader`, a value of another JSON type kept. */
export const whenArray = (reader: Reader<unknown>): Reader<unknown> =>
	applying((value) => Arr.isArray(value), reader)

/** A reader that refers to itself or to a reader declared after it, as a recursive `$ref` does. */
export const lazy =
	<A>(reader: () => Reader<A>): Reader<A> =>
	(value) =>
		reader()(value)
