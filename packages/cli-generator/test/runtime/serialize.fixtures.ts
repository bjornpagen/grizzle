/**
 * What the properties of serialize.test.ts read: the values a parameter, a header, a cookie and a body are drawn from,
 * and a reference of each serializer written from its specification (RFC 3986 percent-encoding byte by byte, RFC 6570's
 * expansion operators, the design's refusal rules, JSON text through effect's formatter), which the properties hold the
 * runtime's serializers to.
 */

import {
	aimed,
	array,
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Predicate,
	Record as Rec,
	Result,
	Stream,
	String as Str
} from "effect"
import type { HttpBody } from "effect/http"
import type { UsageError } from "#runtime-src/domain/errors.ts"
import { JsonNull, JsonNumber, jsonNull } from "#runtime-src/runtime/input.ts"
import type { Json, Nested, Scalar } from "#runtime-src/runtime/serialize.ts"

/** A model's reading: the value, or a refusal (a value the serializer cannot send and must refuse with a `UsageError`). */
export type Read<A> = Result.Result<A, "refused">

export const refused: Read<never> = Result.fail("refused")

/** What a descriptor's expansion gives: its text, nothing at all, or a refusal. */
export type Outcome =
	| Readonly<{ kind: "sent"; text: string }>
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "refused" }>

/** An outcome from a model's reading of an optional text. */
export const outcomeOf = (read: Read<Option.Option<string>>): Outcome =>
	Result.match(read, {
		onFailure: (): Outcome => ({ kind: "refused" }),
		onSuccess: (text): Outcome =>
			Option.match(text, {
				onNone: (): Outcome => ({ kind: "none" }),
				onSome: (sent): Outcome => ({ kind: "sent", text: sent })
			})
	})

/** What a serializer's expansion did, with the message of a refusal kept apart, so an outcome compares as a model's. */
export type Expanded = Readonly<{ outcome: Outcome; message: Option.Option<string> }>

/** An expansion run to its outcome: a `UsageError` a refusal, `undefined` nothing sent. A defect stays a defect. */
export const expanded = (
	expansion: Effect.Effect<string | undefined, UsageError>
): Effect.Effect<Expanded> =>
	Effect.match(expansion, {
		onFailure: (error): Expanded => ({
			outcome: { kind: "refused" },
			message: Option.some(error.message)
		}),
		onSuccess: (text): Expanded => ({
			outcome: text === undefined ? { kind: "none" } : { kind: "sent", text },
			message: Option.none()
		})
	})

/** The text every drawn string may hold that a refusal must never repeat: a value's text never reaches a message. */
export const SECRET = "SECRET"

/**
 * The pieces a drawn string is made of: plain letters, every character RFC 3986 reserves, percent triplets (one
 * spelling a delimiter, one a dot, one not hex), characters a header or cookie cannot carry, code points of one, two
 * and four UTF-8 bytes, a code point above U+00FF, both halves of a surrogate pair alone, and the secret marker.
 */
const PIECES: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"Z",
	"0",
	"-",
	".",
	"_",
	"~",
	" ",
	"/",
	"?",
	"#",
	"[",
	"]",
	"@",
	"!",
	"$",
	"&",
	"'",
	"(",
	")",
	"*",
	"+",
	",",
	";",
	"=",
	":",
	"|",
	"%",
	"%2F",
	"%7C",
	"%7c",
	"%20",
	"%2e",
	"%zz",
	'"',
	"\\",
	"<",
	"^",
	"`",
	"{",
	"\t",
	"\r",
	"\n",
	"\u0000",
	"é",
	"\u0080",
	"ā",
	"😀",
	"\uD800",
	"\uDC00",
	SECRET
]

/** Plain pieces only, so most strings are ordinary text and a hostile piece stands out in a case. */
const PLAIN: Arr.NonEmptyReadonlyArray<string> = ["a", "b", "Z", "0", "x"]

/** A drawn string: mostly plain pieces, now and then any piece. */
export const text: Gen<string> = string(
	weighted([
		[3, characterOf(PLAIN)],
		[2, characterOf(PIECES)]
	]),
	{ min: 0, max: 4 }
)

/** A number the type-to-text rule writes: zero of both signs, fractions, past 2^53, exponents, and none that is finite. */
const NUMBERS: Arr.NonEmptyReadonlyArray<number> = [
	0,
	-0,
	1.5,
	42,
	0.1 + 0.2,
	1e21,
	1e-7,
	Number.MAX_SAFE_INTEGER + 2,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY
]

/** A digit text that is a JSON number a `JsonNumber` keeps: past 2^53, a trailing zero, an exponent, a negative zero. */
const NUMBER_DIGITS: Arr.NonEmptyReadonlyArray<string> = [
	"9007199254740993",
	"1.50",
	"1e2",
	"-0",
	"12345678901234567890"
]

/** A digit text a `JsonNumber` carries: a JSON number's, and texts that are no JSON number. */
const DIGITS: Arr.NonEmptyReadonlyArray<string> = [
	...NUMBER_DIGITS,
	"1&x=2",
	"01",
	"",
	" 1",
	'1,"x":2'
]

/** A number: a whole number near zero, or one of the edge numbers. */
export const number: Gen<number> = oneOf([int(-1000, 1000), element(NUMBERS)])

/** A number kept as its digit text. */
const jsonNumber: Gen<JsonNumber> = map(element(DIGITS), (digits) => new JsonNumber(digits))

/** A scalar of a parameter's value: text above all, then numbers, booleans, both absences and digit texts. */
const scalar: Gen<Scalar> = weighted<Scalar>([
	[8, text],
	[2, number],
	[1, boolean],
	[1, constant(jsonNull)],
	[1, constant(undefined)],
	[2, jsonNumber]
])

/** An object of drawn members under drawn keys, in the order drawn (a repeated key keeps its last value). */
export const objectWith = <A>(
	key: Gen<string>,
	member: Gen<A>
): Gen<{ readonly [key: string]: A }> =>
	map(
		array((source) => [key(source), member(source)] as const, { min: 0, max: 3 }),
		(members) => Rec.fromEntries(members)
	)

/** An object of drawn members under drawn text keys. */
const objectOf = <A>(member: Gen<A>): Gen<{ readonly [key: string]: A }> => objectWith(text, member)

/** A value one level deep: what an RFC 6570 style expands. */
const flatValue: Gen<Nested> = weighted<Nested>([
	[3, scalar],
	[2, array(scalar, { min: 0, max: 3 })],
	[2, objectOf(scalar)]
])

/** A value nested up to three levels: what the bracket convention sends and every other style refuses. */
const nestedValue: Gen<Nested> = (source) => {
	const level = (depth: number): Gen<Nested> =>
		depth === 0
			? scalar
			: weighted<Nested>([
					[2, scalar],
					[1, array(level(depth - 1), { min: 0, max: 3 })],
					[1, objectOf(level(depth - 1))]
				])
	return level(3)(source)
}

/** A parameter's value: one level deep most often, nested deeper now and then. */
const parameterValue: Gen<Nested> = weighted([
	[4, flatValue],
	[1, nestedValue]
])

/** A JSON scalar of a body or content value, a digit text among them. */
export const jsonScalar: Gen<Json> = weighted<Json>([
	[6, text],
	[2, number],
	[1, boolean],
	[1, constant(jsonNull)],
	[2, jsonNumber]
])

/** A JSON value up to three levels deep. */
export const jsonValue: Gen<Json> = (source) => {
	const level = (depth: number): Gen<Json> =>
		depth === 0
			? jsonScalar
			: weighted<Json>([
					[2, jsonScalar],
					[1, array(level(depth - 1), { min: 0, max: 3 })],
					[1, objectOf(level(depth - 1))]
				])
	return level(3)(source)
}

/** A media type a body or content parameter is declared under: JSON, a `+json` suffix with parameters, text, others. */
const MEDIA: Arr.NonEmptyReadonlyArray<string> = [
	"application/json",
	"text/plain",
	"application/merge-patch+json",
	"Application/Vnd.Api+JSON; charset=utf-8",
	"image/png",
	"text/csv",
	"text/plain\r\nX: y",
	"text/plain; x=Ā",
	" text/plain",
	""
]

const loneSurrogate = regex("\\p{Cs}", "u")

/** Whether `value` holds half of a surrogate pair alone, which has no UTF-8 form. */
export const holdsLone = (value: string): boolean => loneSurrogate.test(value)

const jsonNumberGrammar = regex("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$", "u")

/** Whether a digit text is a JSON number (RFC 8259 section 6). */
const isNumberText = (digits: string): boolean => jsonNumberGrammar.test(digits)

/** A scalar's text by the type-to-text rule (design 6.1), none for an absence, or its refusal. */
const scalarText = (value: Scalar): Read<Option.Option<string>> => {
	if (value instanceof JsonNumber) {
		return isNumberText(value.text) ? Result.succeed(Option.some(value.text)) : refused
	}
	if (value === undefined || value instanceof JsonNull) {
		return Result.succeed(Option.none())
	}
	if (Predicate.isString(value)) {
		return holdsLone(value) ? refused : Result.succeed(Option.some(value))
	}
	if (Predicate.isNumber(value)) {
		return Number.isFinite(value) ? Result.succeed(Option.some(String(value))) : refused
	}
	return Result.succeed(Option.some(String(value)))
}

/** A list item's or member's text: an absence there is refused, as is anything a scalar refuses. */
export const itemText = (value: Scalar): Read<string> =>
	Result.flatMap(scalarText(value), (read) =>
		Option.match(read, { onNone: (): Read<string> => refused, onSome: Result.succeed })
	)

/** Whether a value is a scalar, not a list or an object. */
export const isScalar = (value: Nested): value is Scalar =>
	value === undefined ||
	value instanceof JsonNumber ||
	value instanceof JsonNull ||
	!Predicate.isObjectOrArray(value)

/** Whether a value is a list. */
const isList = (value: Nested): value is ReadonlyArray<Nested> => Arr.isArray<Nested>(value)

/** The members of an object value, in the object's own order. */
const membersOf = (value: Nested): ReadonlyArray<readonly [string, Nested]> =>
	isList(value) || isScalar(value) ? [] : Rec.toEntries(value)

/** A list value's items, or none for any other. */
const itemsOf = (value: Nested): Option.Option<ReadonlyArray<Nested>> =>
	isList(value) ? Option.some(value) : Option.none()

/** Whether a value is one level deep: a scalar, or a list or object of scalars. */
const isFlat = (value: Nested): boolean =>
	isScalar(value) ||
	Option.match(itemsOf(value), {
		onNone: () => Arr.every(membersOf(value), ([, member]) => isScalar(member)),
		onSome: (items) => Arr.every(items, isScalar)
	})

/** A defined value's texts: one scalar's, a list's items', or an object's members' in order. */
type Texts =
	| Readonly<{ kind: "primitive"; text: string }>
	| Readonly<{ kind: "list"; items: ReadonlyArray<string> }>
	| Readonly<{ kind: "pairs"; pairs: ReadonlyArray<readonly [string, string]> }>

/** The texts of each piece a delimiter could be confused with: list items, or member names and texts. */
const piecesOf = (texts: Texts): ReadonlyArray<string> => {
	switch (texts.kind) {
		case "primitive":
			return []
		case "list":
			return texts.items
		case "pairs":
			return Arr.flatMap(texts.pairs, ([key, value]) => [key, value])
	}
}

/** Every text a value carries, a scalar's own among them. */
const allTexts = (texts: Texts): ReadonlyArray<string> =>
	texts.kind === "primitive" ? [texts.text] : piecesOf(texts)

/** The texts after `encode`, which sees every key and text alike. */
const encodedTexts = (texts: Texts, encode: (piece: string) => string): Texts => {
	switch (texts.kind) {
		case "primitive":
			return { kind: "primitive", text: encode(texts.text) }
		case "list":
			return { kind: "list", items: Arr.map(texts.items, encode) }
		case "pairs":
			return {
				kind: "pairs",
				pairs: Arr.map(texts.pairs, ([key, value]) => [encode(key), encode(value)] as const)
			}
	}
}

/**
 * A one-level value's texts by the type-to-text rule (design 6.1): none for an absence, an empty list or an object
 * whose every member is absent; an absent member is left out, an absent item, a null member and any refused scalar
 * refuse the value.
 */
const textsOf = (value: Nested): Read<Option.Option<Texts>> =>
	Option.match(itemsOf(value), {
		onSome: (items) =>
			Result.map(
				Result.all(Arr.map(items, (item) => (isScalar(item) ? itemText(item) : refused))),
				(texts): Option.Option<Texts> =>
					Arr.isReadonlyArrayNonEmpty(texts)
						? Option.some({ kind: "list", items: texts })
						: Option.none()
			),
		onNone: () =>
			isScalar(value)
				? Result.map(
						scalarText(value),
						Option.map((sent): Texts => ({ kind: "primitive", text: sent }))
					)
				: Result.map(
						Result.all(
							Arr.map(
								Arr.filter(membersOf(value), ([, member]) => member !== undefined),
								([key, member]) =>
									Result.all([
										itemText(key),
										isScalar(member) ? itemText(member) : refused
									] as const)
							)
						),
						(pairs): Option.Option<Texts> =>
							Arr.isReadonlyArrayNonEmpty(pairs)
								? Option.some({ kind: "pairs", pairs })
								: Option.none()
					)
	})

const unreservedCharacter = regex("^[A-Za-z0-9._~-]$", "u")

const tripletToken = regex("^%[0-9A-Fa-f]{2}$", "u")

const encoderTokens = regex("%[0-9A-Fa-f]{2}|[\\s\\S]", "gu")

/** A code point's UTF-8 bytes, each as an upper-case percent triplet. */
const byteTriplets = (codePoint: string): string =>
	Arr.join(
		Arr.map(
			Arr.fromIterable(new TextEncoder().encode(codePoint)),
			(byte) => `%${Str.toUpperCase(Str.padStart(2, "0")(byte.toString(16)))}`
		),
		""
	)

/** RFC 3986 percent-encoding of everything outside unreserved, one code point at a time. */
const strictly = (piece: string): string =>
	Arr.join(
		Arr.map(Arr.fromIterable(piece), (codePoint) =>
			unreservedCharacter.test(codePoint) ? codePoint : byteTriplets(codePoint)
		),
		""
	)

/** The tokens an `allowReserved` encoder reads: each percent triplet whole, every other code point alone. */
const tokensOf = (piece: string): ReadonlyArray<string> =>
	Arr.map(Arr.fromIterable(Str.matchAll(encoderTokens)(piece)), ([token]) => token)

/** RFC 6570 reserved expansion: a percent triplet and each of `passed` are written as they are, the rest strictly. */
const passing =
	(passed: string) =>
	(piece: string): string =>
		Arr.join(
			Arr.map(tokensOf(piece), (token) =>
				tripletToken.test(token) || Str.includes(token)(passed) ? token : strictly(token)
			),
			""
		)

/** What a path value may write raw under `allowReserved`: RFC 3986 reserved but `/`, `?` and `#` (OAS 3.2.1). */
const PATH_RESERVED = ":[]@!$&'()*+,;="

/** What a query value may write raw under `allowReserved`: reserved less `&`, `=`, `+`, `#` and `'` (D-OC7). */
const QUERY_RESERVED = ":/?[]@!$()*,;"

/** What a 3.2 form cookie value may write raw under `allowReserved`: reserved less `,` and `;` (OAS Appendix D.1). */
const COOKIE_RESERVED = ":/?#[]@!$&'()*+="

/** RFC 6570 operators (Appendix A): what opens the expansion, what joins its pieces, whether it names them. */
type Operator = Readonly<{
	first: string
	separator: string
	named: boolean
	ifEmpty: string
}>

/** `{name}`, `{.name}` and `{;name}`: the three path styles, and `simple` also the header style. */
const OPERATORS = {
	simple: { first: "", separator: ",", named: false, ifEmpty: "" },
	label: { first: ".", separator: ".", named: false, ifEmpty: "" },
	matrix: { first: ";", separator: ";", named: true, ifEmpty: "" },
	cookie: { first: "", separator: "; ", named: true, ifEmpty: "=" }
} as const satisfies Record<string, Operator>

/**
 * RFC 6570's expansion of one variable by `operator` (Appendix A), its name and texts already encoded: a named
 * operator writes `name=text`, or `name` and the operator's empty marker for empty text; exploded, a list repeats the
 * name per item and an object names each member by its key.
 */
const expandBy = (operator: Operator, name: string, texts: Texts, explode: boolean): string => {
	const assigned = (key: string, piece: string) =>
		operator.named ? `${key}${piece === "" ? operator.ifEmpty : `=${piece}`}` : piece
	switch (texts.kind) {
		case "primitive":
			return `${operator.first}${assigned(name, texts.text)}`
		case "list":
			return `${operator.first}${
				explode
					? Arr.join(
							Arr.map(texts.items, (item) => assigned(name, item)),
							operator.separator
						)
					: assigned(name, Arr.join(texts.items, ","))
			}`
		case "pairs":
			return `${operator.first}${
				explode
					? Arr.join(
							Arr.map(texts.pairs, ([key, value]) =>
								operator.named ? assigned(key, value) : `${key}=${value}`
							),
							operator.separator
						)
					: assigned(name, Arr.join(Arr.flatten(texts.pairs), ","))
			}`
	}
}

/** A path parameter's style. */
export type PathStyle = "simple" | "label" | "matrix"

/** A path parameter as drawn: its style, name, value and the two RFC 6570 switches. */
export type PathParameterCase = Readonly<{
	style: PathStyle
	name: string
	value: Nested
	explode: boolean
	allowReserved: boolean
}>

/**
 * The delimiters a path style writes raw, which a list item or a member must not hold (design 6.1 runtime refusals):
 * under `allowReserved` the comma of every style, the equals sign of a label and of a matrix and of an exploded simple
 * object, and a matrix's semicolon; an exploded label's dot always.
 */
const pathDelimiters = (parameter: PathParameterCase, texts: Texts): ReadonlyArray<string> => {
	const reserved = parameter.allowReserved
	switch (parameter.style) {
		case "simple":
			return reserved ? [",", ...(parameter.explode && texts.kind === "pairs" ? ["="] : [])] : []
		case "label":
			return [...(parameter.explode ? ["."] : []), ...(reserved ? [",", "="] : [])]
		case "matrix":
			return reserved ? [";", ",", "="] : []
	}
}

/** Whether a piece of the value holds one of `delimiters`. */
const clashes = (texts: Texts, delimiters: ReadonlyArray<string>): boolean =>
	Arr.some(piecesOf(texts), (piece) =>
		Arr.some(delimiters, (delimiter) => Str.includes(delimiter)(piece))
	)

/**
 * A path parameter's expansion, or its refusal: a matrix name with no UTF-8 form, a value nested deeper than one
 * level, no value (a path parameter is required), any refused text, and a piece holding a delimiter the style writes
 * raw. Texts are encoded strictly, or under `allowReserved` with the path's reserved set passing; a matrix name always
 * strictly.
 */
export const pathParameterModel = (parameter: PathParameterCase): Read<string> => {
	if ((parameter.style === "matrix" && holdsLone(parameter.name)) || !isFlat(parameter.value)) {
		return refused
	}
	return Result.flatMap(textsOf(parameter.value), (read) =>
		Option.match(read, {
			onNone: (): Read<string> => refused,
			onSome: (texts): Read<string> =>
				clashes(texts, pathDelimiters(parameter, texts))
					? refused
					: Result.succeed(
							expandBy(
								OPERATORS[parameter.style],
								strictly(parameter.name),
								encodedTexts(texts, parameter.allowReserved ? passing(PATH_RESERVED) : strictly),
								parameter.explode
							)
						)
		})
	)
}

/** One segment piece of a drawn path template: literal text, or the placeholder of the parameter at an index. */
export type TemplatePiece =
	| Readonly<{ kind: "literal"; text: string }>
	| Readonly<{ kind: "placeholder"; name: string }>

/** A path as drawn: its template's segments and the parameters bound to it. */
export type PathCase = Readonly<{
	segments: ReadonlyArray<ReadonlyArray<TemplatePiece>>
	parameters: ReadonlyArray<PathParameterCase>
}>

/** A template's text: each segment after a slash, a placeholder as `{name}`. */
export const templateOf = (path: PathCase): string =>
	Arr.join(
		Arr.map(
			path.segments,
			(segment) =>
				`/${Arr.join(
					Arr.map(segment, (piece) => (piece.kind === "literal" ? piece.text : `{${piece.name}}`)),
					""
				)}`
		),
		""
	)

const percentDot = regex("%2e", "giu")

/** Whether a segment is `.` or `..`, a percent-encoded dot read as a dot (servers and WHATWG read it so). */
const isDotSegment = (segment: string): boolean => {
	const read = Str.replaceAll(percentDot, ".")(segment)
	return read === "." || read === ".."
}

/**
 * A path's expansion, or its refusal: two parameters with one name, a placeholder no parameter fills, a parameter no
 * placeholder holds, a parameter's own refusal or empty expansion, and a `.` or `..` segment in the result.
 */
export const pathModel = (
	template: string,
	parameters: ReadonlyArray<PathParameterCase>
): Read<string> => {
	const names = Arr.map(parameters, (parameter) => parameter.name)
	if (Arr.dedupe(names).length !== names.length) {
		return refused
	}
	return Result.flatMap(
		Result.all(
			Arr.map(parameters, (parameter) =>
				Result.flatMap(pathParameterModel(parameter), (expansion) =>
					expansion === "" ? refused : Result.succeed([parameter.name, expansion] as const)
				)
			)
		),
		(expansions) => {
			const byName = new Map(expansions)
			const used = new Set<string>()
			const pieces = Str.split(regex("\\{([^{}]*)\\}", "u"))(template)
			const filled = Arr.map(pieces, (piece, at) => {
				if (at % 2 === 0) {
					return Option.some(piece)
				}
				used.add(piece)
				return Option.fromUndefinedOr(byName.get(piece))
			})
			const whole = Option.all(filled)
			return Option.match(whole, {
				onNone: (): Read<string> => refused,
				onSome: (parts): Read<string> => {
					const path = Arr.join(parts, "")
					return used.size !== names.length || Arr.some(Str.split("/")(path), isDotSegment)
						? refused
						: Result.succeed(path)
				}
			})
		}
	)
}

/** A query parameter's style. */
export type QueryStyle = "form" | "spaceDelimited" | "pipeDelimited" | "deepObject"

/** A query parameter as drawn: style, name, value and its options. */
export type QueryCase = Readonly<{
	style: QueryStyle
	name: string
	value: Nested
	explode: boolean
	allowReserved: boolean
	required: boolean
	allowEmptyValue: boolean
	brackets: boolean
	scalars: boolean
}>

/** How pairs are written where they travel: names, values, and the joiner of a non-exploded value per style. */
export type PairCodec = Readonly<{
	name: (piece: string) => string
	value: (piece: string) => string
	joiner: Readonly<Record<QueryStyle, string>>
}>

/** A query string's codec: names strictly, values strictly or with the query's reserved set passing. */
const queryCodec = (allowReserved: boolean): PairCodec => ({
	name: strictly,
	value: allowReserved ? passing(QUERY_RESERVED) : strictly,
	joiner: { form: ",", deepObject: ",", spaceDelimited: "%20", pipeDelimited: "%7C" }
})

/** One sent pair: its encoded name and encoded value. */
export type SentPair = readonly [name: string, value: string]

/** The pairs of an encoded pair list as `name=value` joined by `&`. */
export const pairsText = (pairs: ReadonlyArray<SentPair>): string =>
	Arr.join(
		Arr.map(pairs, ([name, value]) => `${name}=${value}`),
		"&"
	)

/** A query style's settings, as the form body's Encoding Object and a query parameter share them. */
export type StyleSettings = Readonly<{
	style: QueryStyle
	explode: boolean
	allowReserved: boolean
	brackets: boolean
	scalars: boolean
}>

/** Whether `deepObject` takes the value through the bracket convention: brackets on, and no scalar the switch sends. */
const isBracketed = (settings: StyleSettings, value: Nested): boolean =>
	settings.style === "deepObject" && settings.brackets && !(settings.scalars && isScalar(value))

const bracketCharacter = regex("[[\\]]", "u")

/** One leaf of the bracket convention: the keys down to it and its text. */
type Leaf = readonly [keys: ReadonlyArray<string>, text: string]

/**
 * Every leaf below a value, keys and indexes from the top, in document order; an absent member is left out, and an
 * absent or null leaf, a member name with a bracket and any refused text refuse the whole value.
 */
const leavesOf = (value: Nested, keys: ReadonlyArray<string>): Read<ReadonlyArray<Leaf>> => {
	if (isScalar(value)) {
		return Result.map(itemText(value), (leaf): ReadonlyArray<Leaf> => [[keys, leaf]])
	}
	const children: ReadonlyArray<readonly [Read<string>, Nested]> = Option.match(itemsOf(value), {
		onSome: (items) =>
			Arr.map(items, (item, index) => [Result.succeed(String(index)), item] as const),
		onNone: () =>
			Arr.map(
				Arr.filter(membersOf(value), ([, member]) => member !== undefined),
				([key, member]) => [bracketCharacter.test(key) ? refused : itemText(key), member] as const
			)
	})
	return Result.map(
		Result.all(
			Arr.map(children, ([key, child]) =>
				Result.flatMap(key, (read) => leavesOf(child, [...keys, read]))
			)
		),
		Arr.flatten
	)
}

/** What a styled value sends: its pairs (members marks pairs named by the value's members), none, or a refusal. */
export type Styled = Readonly<{ pairs: ReadonlyArray<SentPair>; members: boolean }>

/**
 * The bracket convention (design 6.1, D-OQ1 (b)): each leaf at keys `k1 … kn` as `name[k1]…[kn]=text`, the whole name
 * encoded as a name; none for an absence or a value with no leaf; a scalar is refused, as are two leaves whose names
 * encode alike.
 */
const bracketModel = (
	name: string,
	value: Nested,
	codec: PairCodec
): Read<Option.Option<Styled>> => {
	if (isScalar(value)) {
		return value === undefined || value instanceof JsonNull
			? Result.succeed(Option.none())
			: refused
	}
	return Result.flatMap(leavesOf(value, []), (leaves) => {
		const pairs = Arr.map(leaves, ([keys, leaf]): SentPair => [
			codec.name(
				`${name}${Arr.join(
					Arr.map(keys, (key) => `[${key}]`),
					""
				)}`
			),
			codec.value(leaf)
		])
		const names = Arr.map(pairs, ([pairName]) => pairName)
		return Arr.dedupe(names).length !== names.length
			? refused
			: Result.succeed(
					Arr.isReadonlyArrayNonEmpty(pairs) ? Option.some({ pairs, members: true }) : Option.none()
				)
	})
}

/**
 * The query delimiter a non-exploded list or object must not hold (design 6.1): a delimited style's own joiner, and
 * under `allowReserved` a form's comma and the delimited joiner's triplet (which passes unencoded there).
 */
const queryClash = (settings: StyleSettings, texts: Texts): boolean => {
	if (settings.style === "deepObject" && texts.kind === "pairs") {
		return Arr.some(texts.pairs, ([key]) => bracketCharacter.test(key))
	}
	if (settings.explode || texts.kind === "primitive") {
		return false
	}
	const delimiter = {
		form: settings.allowReserved ? Option.some(",") : Option.none(),
		deepObject: Option.none(),
		spaceDelimited: Option.some(" "),
		pipeDelimited: Option.some("|")
	}[settings.style]
	const triplet = settings.allowReserved
		? {
				form: Option.none(),
				deepObject: Option.none(),
				spaceDelimited: Option.some("%20"),
				pipeDelimited: Option.some("%7C")
			}[settings.style]
		: Option.none<string>()
	return Arr.some(
		piecesOf(texts),
		(piece) =>
			Option.exists(delimiter, (raw) => Str.includes(raw)(piece)) ||
			Option.exists(triplet, (encoded) => Str.includes(encoded)(Str.toUpperCase(piece)))
	)
}

/** A styled value's pairs once its texts are read: by member under deepObject, by item or member when exploded. */
const styledPairs = (
	settings: StyleSettings,
	name: string,
	texts: Texts,
	codec: PairCodec
): Styled => {
	const joined = (pieces: ReadonlyArray<string>) =>
		Arr.join(Arr.map(pieces, codec.value), codec.joiner[settings.style])
	if (settings.style === "deepObject" && texts.kind === "pairs") {
		return {
			pairs: Arr.map(texts.pairs, ([key, value]): SentPair => [
				codec.name(`${name}[${key}]`),
				codec.value(value)
			]),
			members: true
		}
	}
	switch (texts.kind) {
		case "primitive":
			return { pairs: [[codec.name(name), codec.value(texts.text)]], members: false }
		case "list":
			return {
				pairs: settings.explode
					? Arr.map(texts.items, (item): SentPair => [codec.name(name), codec.value(item)])
					: [[codec.name(name), joined(texts.items)]],
				members: false
			}
		case "pairs":
			return settings.explode
				? {
						pairs: Arr.map(texts.pairs, ([key, value]): SentPair => [
							codec.name(key),
							codec.value(value)
						]),
						members: true
					}
				: { pairs: [[codec.name(name), joined(Arr.flatten(texts.pairs))]], members: false }
	}
}

/**
 * A styled value's pairs, none, or its refusal (design 6.1 and 6.3): the bracket convention where it applies, else a
 * value nested deeper than one level is refused; no text sends nothing; deepObject takes an object, or a scalar under
 * its switch; a delimiter a piece must not hold refuses it.
 */
export const styledModel = (
	settings: StyleSettings,
	name: string,
	value: Nested,
	codec: PairCodec
): Read<Option.Option<Styled>> => {
	if (isBracketed(settings, value)) {
		return bracketModel(name, value, codec)
	}
	if (!isFlat(value)) {
		return refused
	}
	return Result.flatMap(textsOf(value), (read) =>
		Option.match(read, {
			onNone: (): Read<Option.Option<Styled>> => Result.succeed(Option.none()),
			onSome: (texts): Read<Option.Option<Styled>> =>
				(settings.style === "deepObject" &&
					!(texts.kind === "pairs" || (settings.scalars && texts.kind === "primitive"))) ||
				queryClash(settings, texts)
					? refused
					: Result.succeed(Option.some(styledPairs(settings, name, texts, codec)))
		})
	)
}

/** Whether a value is a list or object with nothing in it, which `allowEmptyValue` sends as `name=`. */
const isEmptyCompound = (value: Nested): boolean =>
	Option.match(itemsOf(value), {
		onSome: Arr.isReadonlyArrayEmpty,
		onNone: () => !isScalar(value) && membersOf(value).length === 0
	})

/**
 * A query parameter's expansion, none, or its refusal: a name with no UTF-8 form is refused; a value that sends no
 * pair sends `name=` under `allowEmptyValue` when it is an empty list or object, else nothing, or a refusal when
 * required.
 */
export const queryModel = (parameter: QueryCase): Read<Option.Option<string>> => {
	if (holdsLone(parameter.name)) {
		return refused
	}
	return Result.flatMap(
		styledModel(parameter, parameter.name, parameter.value, queryCodec(parameter.allowReserved)),
		(styled) =>
			Option.match(styled, {
				onSome: (sent) => Result.succeed(Option.some(pairsText(sent.pairs))),
				onNone: (): Read<Option.Option<string>> =>
					parameter.allowEmptyValue && isEmptyCompound(parameter.value)
						? Result.succeed(Option.some(`${strictly(parameter.name)}=`))
						: parameter.required
							? refused
							: Result.succeed(Option.none())
			})
	)
}

const token = regex("^[A-Za-z0-9_!#$%&'*+.^`|~-]+$", "u")

/** Whether a name is an RFC 9110 token, as a header or cookie name must be. */
const isToken = (name: string): boolean => token.test(name)

const edgeSpace = regex("^[\\t ]|[\\t ]$", "u")

const wide = regex("[\\u{100}-\\u{10FFFF}]", "u")

/** Whether a header line cannot carry `piece` unchanged (RFC 9110 5.5): CR, LF, NUL, edge space, above U+00FF. */
export const breaksHeader = (piece: string): boolean =>
	Str.includes("\r")(piece) ||
	Str.includes("\n")(piece) ||
	Str.includes("\u0000")(piece) ||
	wide.test(piece) ||
	edgeSpace.test(piece)

/** A header parameter as drawn. */
export type HeaderCase = Readonly<{
	name: string
	value: Nested
	explode: boolean
	required: boolean
}>

/**
 * A header parameter's value text, none, or its refusal: a name that is no token, a value nested deeper than one
 * level, no value when required, a text no header line carries unchanged, a comma inside an item or member, and an
 * equals sign inside an exploded object's key (header text is never percent-encoded, so each is ambiguous).
 */
export const headerModel = (parameter: HeaderCase): Read<Option.Option<string>> => {
	if (!isToken(parameter.name) || !isFlat(parameter.value)) {
		return refused
	}
	return Result.flatMap(textsOf(parameter.value), (read) =>
		Option.match(read, {
			onNone: (): Read<Option.Option<string>> =>
				parameter.required ? refused : Result.succeed(Option.none()),
			onSome: (texts): Read<Option.Option<string>> =>
				Arr.some(allTexts(texts), breaksHeader) ||
				clashes(texts, [","]) ||
				(parameter.explode &&
					texts.kind === "pairs" &&
					Arr.some(texts.pairs, ([key]) => Str.includes("=")(key)))
					? refused
					: Result.succeed(
							Option.some(expandBy(OPERATORS.simple, parameter.name, texts, parameter.explode))
						)
		})
	)
}

/** A cookie parameter as drawn: its OpenAPI line and style beside the usual switches. */
export type CookieCase = Readonly<{
	name: string
	value: Nested
	line: "3.0" | "3.1" | "3.2"
	style: "form" | "cookie"
	explode: boolean
	allowReserved: boolean
	required: boolean
}>

const cookieOctet = regex(
	"^[\\u0021\\u0023-\\u002B\\u002D-\\u003A\\u003C-\\u005B\\u005D-\\u007E]*$",
	"u"
)

/** Whether a text is all RFC 6265 `cookie-octet`. */
const isCookieOctets = (piece: string): boolean => cookieOctet.test(piece)

/**
 * A cookie parameter's pairs, none, or its refusal (OAS 3.2 and Appendix D): a name that is no token, style `cookie`
 * before 3.2, `explode: false` on 3.2, a value nested deeper than one level, no value when required. Style `cookie`
 * sends its texts as given, each all `cookie-octet` and each member name a token; style `form` sends a scalar only
 * (PRM-34), encoded strictly, or on 3.2 with `allowReserved` with the cookie's reserved set passing.
 */
export const cookieModel = (parameter: CookieCase): Read<Option.Option<string>> => {
	if (
		!isToken(parameter.name) ||
		(parameter.style === "cookie" && parameter.line !== "3.2") ||
		(parameter.line === "3.2" && !parameter.explode) ||
		!isFlat(parameter.value)
	) {
		return refused
	}
	return Result.flatMap(textsOf(parameter.value), (read) =>
		Option.match(read, {
			onNone: (): Read<Option.Option<string>> =>
				parameter.required ? refused : Result.succeed(Option.none()),
			onSome: (texts): Read<Option.Option<string>> => {
				if (parameter.style === "cookie") {
					return (texts.kind === "pairs" && Arr.some(texts.pairs, ([key]) => !isToken(key))) ||
						!Arr.every(allTexts(texts), isCookieOctets)
						? refused
						: Result.succeed(
								Option.some(expandBy(OPERATORS.cookie, parameter.name, texts, parameter.explode))
							)
				}
				return texts.kind === "primitive"
					? Result.succeed(
							Option.some(
								expandBy(
									OPERATORS.cookie,
									parameter.name,
									encodedTexts(
										texts,
										parameter.line === "3.2" && parameter.allowReserved
											? passing(COOKIE_RESERVED)
											: strictly
									),
									parameter.explode
								)
							)
						)
					: refused
			}
		})
	)
}

/** A media type's essence: before any parameter, trimmed and lower-cased. */
export const essenceOf = (mediaType: string): string =>
	Str.toLowerCase(Str.trim(Arr.headNonEmpty(Str.split(";")(mediaType))))

/** Whether a media type is JSON: `application/json` or a `+json` suffix, by essence. */
export const isJsonMedia = (mediaType: string): boolean => {
	const essence = essenceOf(mediaType)
	return essence === "application/json" || Str.endsWith("+json")(essence)
}

/** Whether a JSON value is a list. */
export const isJsonList = (value: Json): value is ReadonlyArray<Json> => Arr.isArray<Json>(value)

/**
 * Compact JSON text of a value, a digit text written as given, every string and key through effect's JSON writer;
 * none when a number has no JSON text (a non-finite number, a digit text that is no JSON number).
 */
export const jsonModel = (value: Json): Option.Option<string> => {
	if (value instanceof JsonNumber) {
		return isNumberText(value.text) ? Option.some(value.text) : Option.none()
	}
	if (value instanceof JsonNull) {
		return Option.some("null")
	}
	if (Predicate.isNumber(value)) {
		return Number.isFinite(value) ? Option.some(Formatter.formatJson(value)) : Option.none()
	}
	if (Predicate.isString(value) || Predicate.isBoolean(value)) {
		return Option.some(Formatter.formatJson(value))
	}
	if (isJsonList(value)) {
		return Option.map(Option.all(Arr.map(value, jsonModel)), (items) => `[${Arr.join(items, ",")}]`)
	}
	return Option.map(
		Option.all(
			Arr.map(Rec.toEntries(value), ([key, member]) =>
				Option.map(jsonModel(member), (written) => `${Formatter.formatJson(key)}:${written}`)
			)
		),
		(members) => `{${Arr.join(members, ",")}}`
	)
}

/**
 * A content-based parameter's text before its location's encoding (PRM-23, PRM-24): compact JSON under JSON media,
 * else the value itself, which must then be text with a UTF-8 form.
 */
const contentTextModel = (mediaType: string, value: Json): Read<string> => {
	if (isJsonMedia(mediaType)) {
		return Option.match(jsonModel(value), {
			onNone: (): Read<string> => refused,
			onSome: Result.succeed
		})
	}
	return Predicate.isString(value) && !holdsLone(value) ? Result.succeed(value) : refused
}

/** Whether a name or value anywhere in a JSON value holds a lone surrogate. */
export const jsonHoldsLone = (value: Json): boolean => {
	if (Predicate.isString(value)) {
		return holdsLone(value)
	}
	if (isJsonList(value)) {
		return Arr.some(value, jsonHoldsLone)
	}
	return (
		Predicate.isObject(value) &&
		!(value instanceof JsonNumber) &&
		!(value instanceof JsonNull) &&
		Arr.some(Rec.toEntries(value), ([key, member]) => holdsLone(key) || jsonHoldsLone(member))
	)
}

/** The situations of a feature list that hold. */
export const holding = <F extends string>(
	features: ReadonlyArray<readonly [F, boolean]>
): ReadonlyArray<F> =>
	Arr.map(
		Arr.filter(features, ([, holds]) => holds),
		([feature]) => feature
	)

/** Names a path parameter is drawn under: plain, one each delimiter a matrix name encodes, astral, and a lone half. */
const PATH_NAMES: Arr.NonEmptyReadonlyArray<string> = ["id", "name", "a;b=c,d", "a😀", "a\uD800"]

/** A path parameter as drawn. */
const pathParameter =
	(name: Gen<string>): Gen<PathParameterCase> =>
	(source) => ({
		style: element<PathStyle>(["simple", "label", "matrix"])(source),
		name: name(source),
		value: parameterValue(source),
		explode: boolean(source),
		allowReserved: boolean(source)
	})

/** What may go wrong between a template and its parameters, mostly nothing. */
type PathFault = "none" | "missing" | "extra" | "twice"

/** A literal piece of a path segment: plain, a dot and two dots in both spellings. */
const LITERALS: Arr.NonEmptyReadonlyArray<string> = ["users", "a", "", ".", "..", "%2e", "x."]

/**
 * A path: up to two parameters under distinct names, segments whose placeholders name them (each at least once when
 * nothing goes wrong), and now and then a fault: a placeholder naming no parameter, a parameter no placeholder names,
 * or a second parameter under a name already bound.
 */
const pathDrawn: Gen<PathCase> = (source) => {
	const named = array(pathParameter(element(PATH_NAMES)), { min: 0, max: 2 })(source)
	const parameters = Arr.dedupeWith(named, (left, right) => left.name === right.name)
	const fault = weighted<PathFault>([
		[6, constant("none")],
		[1, constant("missing")],
		[1, constant("extra")],
		[1, constant("twice")]
	])(source)
	const literal: Gen<TemplatePiece> = map(element(LITERALS), (piece) => ({
		kind: "literal",
		text: piece
	}))
	const placeholders: ReadonlyArray<TemplatePiece> = Arr.map(parameters, (parameter) => ({
		kind: "placeholder",
		name: parameter.name
	}))
	const placed = Arr.map(placeholders, (placeholder) =>
		weighted<ReadonlyArray<TemplatePiece>>([
			[3, constant([placeholder])],
			[1, map(literal, (before) => [before, placeholder])],
			[1, map(literal, (after) => [placeholder, after])]
		])(source)
	)
	const plain = array(
		map(literal, (piece) => [piece]),
		{ min: 0, max: 2 }
	)(source)
	const segments = [...placed, ...plain]
	switch (fault) {
		case "none":
			return { segments, parameters }
		case "missing":
			return { segments: [...segments, [{ kind: "placeholder", name: "other" }]], parameters }
		case "extra":
			return { segments, parameters: [...parameters, pathParameter(constant("extra"))(source)] }
		case "twice":
			return {
				segments,
				parameters: [...parameters, pathParameter(element(PATH_NAMES))(source)]
			}
	}
}

/** A path, aimed at a matrix parameter's exploded list of several items, which a plain draw reaches rarely. */
export const pathSpace = aimed<PathCase, PathFeature>(pathDrawn, [
	[
		"matrix list of several items exploded",
		(source) => ({
			segments: [[{ kind: "placeholder", name: "id" }]],
			parameters: [
				{
					style: "matrix",
					name: "id",
					value: array(element(["a", "b", "x y", "1"]), { min: 2, max: 3 })(source),
					explode: true,
					allowReserved: false
				}
			]
		})
	]
])

/** The situations a path reaches. */
export type PathFeature =
	| "simple"
	| "label"
	| "matrix"
	| "list exploded"
	| "matrix list of several items exploded"
	| "object exploded"
	| "list joined"
	| "object joined"
	| "reserved character passed"
	| "percent triplet passed"
	| "non-ASCII text encoded"
	| "empty text"
	| "delimiter refused"
	| "lone surrogate refused"
	| "nested value refused"
	| "absent value refused"
	| "non-finite number refused"
	| "digit text kept"
	| "empty expansion refused"
	| "dot segment refused"
	| "placeholder with no parameter"
	| "parameter with no placeholder"
	| "two parameters with one name"
	| "path expanded"

/** Whether a parameter's value is drawn of the given kind. */
const valueKind = (value: Nested): "scalar" | "list" | "object" =>
	isScalar(value) ? "scalar" : isList(value) ? "list" : "object"

/** Every scalar a one-level value holds. */
const scalarsOf = (value: Nested): ReadonlyArray<Scalar> =>
	isScalar(value)
		? [value]
		: isList(value)
			? Arr.filter(value, isScalar)
			: Arr.flatMap(membersOf(value), ([key, member]) => (isScalar(member) ? [key, member] : [key]))

/** Every string a one-level value holds. */
const stringsOf = (value: Nested): ReadonlyArray<string> =>
	Arr.filter(scalarsOf(value), Predicate.isString)

/** Whether a text holds a code point past ASCII, which percent-encoding writes as its UTF-8 bytes. */
const isNonAscii = (piece: string): boolean =>
	Arr.some(Arr.fromIterable(piece), (codePoint) =>
		Option.exists(Str.codePointAt(0)(codePoint), (point) => point >= 0x80)
	)

/** What a path parameter's case reaches, given its model's reading. */
const parameterFeatures = (parameter: PathParameterCase): ReadonlyArray<PathFeature> => {
	const read = pathParameterModel(parameter)
	const sent = Result.isSuccess(read)
	const kind = valueKind(parameter.value)
	const strings = stringsOf(parameter.value)
	const texts = Result.getOrElse(textsOf(parameter.value), () => Option.none<Texts>())
	return holding<PathFeature>([
		[parameter.style, sent],
		["list exploded", sent && kind === "list" && parameter.explode],
		[
			"matrix list of several items exploded",
			sent &&
				parameter.style === "matrix" &&
				parameter.explode &&
				Option.exists(texts, (held) => held.kind === "list" && held.items.length > 1)
		],
		["object exploded", sent && kind === "object" && parameter.explode],
		["list joined", sent && kind === "list" && !parameter.explode],
		["object joined", sent && kind === "object" && !parameter.explode],
		[
			"reserved character passed",
			sent &&
				parameter.allowReserved &&
				Arr.some(strings, (piece) =>
					Arr.some(Arr.fromIterable(PATH_RESERVED), (raw) => Str.includes(raw)(piece))
				)
		],
		[
			"percent triplet passed",
			sent && parameter.allowReserved && Arr.some(strings, (piece) => Str.includes("%2")(piece))
		],
		["non-ASCII text encoded", sent && Arr.some(strings, isNonAscii)],
		["empty text", sent && Option.exists(texts, (held) => Arr.some(allTexts(held), Str.isEmpty))],
		[
			"delimiter refused",
			!sent &&
				isFlat(parameter.value) &&
				Result.isSuccess(textsOf(parameter.value)) &&
				Option.isSome(texts) &&
				!(parameter.style === "matrix" && holdsLone(parameter.name))
		],
		[
			"lone surrogate refused",
			!sent && (Arr.some(strings, holdsLone) || holdsLone(parameter.name))
		],
		["nested value refused", !isFlat(parameter.value)],
		[
			"absent value refused",
			isFlat(parameter.value) && Result.isSuccess(textsOf(parameter.value)) && Option.isNone(texts)
		],
		[
			"non-finite number refused",
			Arr.some(
				scalarsOf(parameter.value),
				(piece) => Predicate.isNumber(piece) && !Number.isFinite(piece)
			)
		],
		[
			"digit text kept",
			sent && Arr.some(scalarsOf(parameter.value), (piece) => piece instanceof JsonNumber)
		]
	])
}

/** What a path case reaches. */
export const pathFeatures = (path: PathCase, template: string): ReadonlyArray<PathFeature> => {
	const names = Arr.map(path.parameters, (parameter) => parameter.name)
	const placeholders = Arr.flatMap(path.segments, (segment) =>
		Arr.flatMap(segment, (piece) => (piece.kind === "placeholder" ? [piece.name] : []))
	)
	const expansions = Arr.map(path.parameters, pathParameterModel)
	const whole = pathModel(template, path.parameters)
	const parameterRead = Result.all(expansions)
	return [
		...Arr.flatMap(path.parameters, parameterFeatures),
		...holding<PathFeature>([
			[
				"empty expansion refused",
				Arr.some(expansions, (read) => Result.isSuccess(read) && read.success === "")
			],
			[
				"dot segment refused",
				Result.isFailure(whole) &&
					Result.isSuccess(parameterRead) &&
					Arr.dedupe(names).length === names.length &&
					Arr.every(placeholders, (name) => Arr.contains(names, name)) &&
					Arr.every(names, (name) => Arr.contains(placeholders, name)) &&
					Arr.every(parameterRead.success, (expansion) => expansion !== "")
			],
			[
				"placeholder with no parameter",
				Arr.some(placeholders, (name) => !Arr.contains(names, name))
			],
			[
				"parameter with no placeholder",
				Arr.some(names, (name) => !Arr.contains(placeholders, name))
			],
			["two parameters with one name", Arr.dedupe(names).length !== names.length],
			["path expanded", Result.isSuccess(whole) && names.length > 0]
		])
	]
}

/** Names a query parameter is drawn under: plain, ones whose every character a name encodes, and a lone half. */
const QUERY_NAMES: Arr.NonEmptyReadonlyArray<string> = ["q", "a b[]", "a:b", "q\uDC00"]

/** A query parameter as drawn, under every style and switch. */
const queryDrawn: Gen<QueryCase> = (source) => {
	const style = element<QueryStyle>(["form", "spaceDelimited", "pipeDelimited", "deepObject"])(
		source
	)
	return {
		style,
		name: weighted([
			[4, constant("q")],
			[1, element(QUERY_NAMES)]
		])(source),
		value: parameterValue(source),
		explode: boolean(source),
		allowReserved: boolean(source),
		required: boolean(source),
		allowEmptyValue: boolean(source),
		brackets: style === "deepObject" && boolean(source),
		scalars: style === "deepObject" && boolean(source)
	}
}

/** Texts of plain letters with one delimiter a style could be confused by. */
const delimited: Gen<string> = (source) =>
	`${text(source)}${element([" ", "|", ",", "%20", "%7C", "%7c"])(source)}${text(source)}`

/** Member names holding a bracket, alone or inside text. */
const bracketed: Gen<string> = (source) =>
	`${element(["", "SECRET", "a"])(source)}${element(["[", "]", "[b]"])(source)}${element(["", "b"])(source)}`

/**
 * A query parameter, aimed at a non-exploded list whose item holds a delimiter, and at a deepObject member name
 * holding a bracket, which plain draws reach rarely.
 */
export const querySpace = aimed<QueryCase, QueryFeature>(queryDrawn, [
	[
		"delimiter refused",
		(source) => ({
			...queryDrawn(source),
			style: element<QueryStyle>(["spaceDelimited", "pipeDelimited", "form"])(source),
			explode: false,
			allowReserved: true,
			brackets: false,
			scalars: false,
			value: array(delimited, { min: 1, max: 2 })(source)
		})
	],
	[
		"bracket in a member name refused",
		(source) => ({
			...queryDrawn(source),
			style: "deepObject",
			brackets: boolean(source),
			value: weighted<Nested>([
				[1, (inner) => ({ [bracketed(inner)]: text(inner) })],
				[1, (inner) => ({ x: { [bracketed(inner)]: text(inner) } })]
			])(source)
		})
	]
])

/** The situations a query parameter reaches. */
export type QueryFeature =
	| "form"
	| "spaceDelimited"
	| "pipeDelimited"
	| "deepObject"
	| "list exploded"
	| "object exploded"
	| "list joined"
	| "object joined"
	| "bracket convention"
	| "scalar under deepObject"
	| "reserved character passed"
	| "percent triplet passed"
	| "empty value sent"
	| "nothing sent"
	| "required value refused"
	| "delimiter refused"
	| "bracket in a member name refused"
	| "nested value refused"
	| "lone surrogate refused"
	| "name encoded"

/** What a query parameter's case reaches, given its model's reading. */
export const queryFeatures = (parameter: QueryCase): ReadonlyArray<QueryFeature> => {
	const read = queryModel(parameter)
	const sent = Result.isSuccess(read) && Option.isSome(read.success)
	const kind = valueKind(parameter.value)
	const strings = stringsOf(parameter.value)
	const flatSent = sent && !isBracketed(parameter, parameter.value)
	return holding<QueryFeature>([
		[parameter.style, sent],
		["list exploded", flatSent && kind === "list" && parameter.explode],
		[
			"object exploded",
			flatSent && kind === "object" && parameter.explode && parameter.style !== "deepObject"
		],
		["list joined", flatSent && kind === "list" && !parameter.explode],
		[
			"object joined",
			flatSent && kind === "object" && !parameter.explode && parameter.style !== "deepObject"
		],
		[
			"bracket convention",
			sent && isBracketed(parameter, parameter.value) && !isFlat(parameter.value)
		],
		["scalar under deepObject", sent && parameter.style === "deepObject" && kind === "scalar"],
		[
			"reserved character passed",
			sent &&
				parameter.allowReserved &&
				Arr.some(strings, (piece) =>
					Arr.some(Arr.fromIterable(QUERY_RESERVED), (raw) => Str.includes(raw)(piece))
				)
		],
		[
			"percent triplet passed",
			sent && parameter.allowReserved && Arr.some(strings, (piece) => Str.includes("%2")(piece))
		],
		["empty value sent", sent && parameter.allowEmptyValue && isEmptyCompound(parameter.value)],
		["nothing sent", Result.isSuccess(read) && Option.isNone(read.success)],
		[
			"required value refused",
			Result.isFailure(read) &&
				parameter.required &&
				Result.isSuccess(queryModel({ ...parameter, required: false })) &&
				Option.isNone(
					Result.getOrElse(queryModel({ ...parameter, required: false }), () => Option.some(""))
				)
		],
		[
			"delimiter refused",
			Result.isFailure(read) &&
				isFlat(parameter.value) &&
				!holdsLone(parameter.name) &&
				!isBracketed(parameter, parameter.value) &&
				Option.exists(
					Result.getOrElse(textsOf(parameter.value), () => Option.none<Texts>()),
					(texts) =>
						queryClash(parameter, texts) &&
						!(parameter.style === "deepObject" && texts.kind === "pairs")
				)
		],
		[
			"bracket in a member name refused",
			Result.isFailure(read) &&
				parameter.style === "deepObject" &&
				Arr.some(membersOf(parameter.value), ([key]) => bracketCharacter.test(key))
		],
		[
			"nested value refused",
			Result.isFailure(read) && !isFlat(parameter.value) && !isBracketed(parameter, parameter.value)
		],
		[
			"lone surrogate refused",
			Result.isFailure(read) && (holdsLone(parameter.name) || Arr.some(strings, holdsLone))
		],
		["name encoded", sent && strictly(parameter.name) !== parameter.name]
	])
}

/** Names a header is drawn under: a token, and ones that are none (a space, a line break, nothing at all). */
const HEADER_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"X-Test",
	"X Test",
	"X-Test\r\nInjected",
	"",
	"x-test"
]

/** A header parameter as drawn. */
const headerDrawn: Gen<HeaderCase> = (source) => ({
	name: weighted([
		[4, constant("X-Test")],
		[1, element(HEADER_NAMES)]
	])(source),
	value: parameterValue(source),
	explode: boolean(source),
	required: boolean(source)
})

/** The situations a header parameter reaches. */
export type HeaderFeature =
	| "scalar sent unencoded"
	| "list sent"
	| "object sent"
	| "object exploded"
	| "empty text sent"
	| "latin-1 text sent"
	| "nothing sent"
	| "required value refused"
	| "unsafe text refused"
	| "comma refused"
	| "name not a token refused"
	| "nested value refused"

/** What a header parameter's case reaches. */
export const headerFeatures = (parameter: HeaderCase): ReadonlyArray<HeaderFeature> => {
	const read = headerModel(parameter)
	const sent = Result.isSuccess(read) && Option.isSome(read.success)
	const kind = valueKind(parameter.value)
	const strings = stringsOf(parameter.value)
	const texts = Result.getOrElse(textsOf(parameter.value), () => Option.none<Texts>())
	return holding<HeaderFeature>([
		[
			"scalar sent unencoded",
			sent && kind === "scalar" && Arr.some(strings, (piece) => strictly(piece) !== piece)
		],
		["list sent", sent && kind === "list"],
		["object sent", sent && kind === "object"],
		["object exploded", sent && kind === "object" && parameter.explode],
		[
			"empty text sent",
			sent && Option.exists(texts, (held) => Arr.some(allTexts(held), Str.isEmpty))
		],
		[
			"latin-1 text sent",
			sent &&
				Arr.some(strings, (piece) => Str.includes("é")(piece) || Str.includes("\u0080")(piece))
		],
		["nothing sent", Result.isSuccess(read) && Option.isNone(read.success)],
		[
			"required value refused",
			Result.isFailure(read) &&
				parameter.required &&
				isToken(parameter.name) &&
				isFlat(parameter.value) &&
				Result.isSuccess(textsOf(parameter.value)) &&
				Option.isNone(texts)
		],
		[
			"unsafe text refused",
			Result.isFailure(read) &&
				Option.exists(texts, (held) => Arr.some(allTexts(held), breaksHeader)) &&
				isToken(parameter.name)
		],
		[
			"comma refused",
			Result.isFailure(read) && Option.exists(texts, (held) => clashes(held, [","]))
		],
		["name not a token refused", !isToken(parameter.name)],
		["nested value refused", !isFlat(parameter.value)]
	])
}

/**
 * A header parameter, aimed at latin-1 text sent as it is, at text no header line carries, and at a comma inside an
 * item or member, each of which a plain draw reaches rarely.
 */
export const headerSpace = aimed<HeaderCase, HeaderFeature>(headerDrawn, [
	[
		"latin-1 text sent",
		(source) => ({
			...headerDrawn(source),
			name: "X-Test",
			value: `${element(["caf", "na", ""])(source)}${element(["\u00E9", "\u0080"])(source)}x`
		})
	],
	[
		"unsafe text refused",
		(source) => ({
			...headerDrawn(source),
			name: "X-Test",
			value: `x${element(["\r\n", "\n", "\u0000", "\u20AC"])(source)}y`
		})
	],
	[
		"comma refused",
		(source) => ({
			...headerDrawn(source),
			name: "X-Test",
			value: element<Nested>([["a,b", "c"], { k: "a,b" }])(source)
		})
	]
])

/** Names a cookie is drawn under: a token, and ones that are none. */
const COOKIE_NAMES: Arr.NonEmptyReadonlyArray<string> = ["c", "a b", "a;b"]

/** A cookie parameter as drawn, on every line and style. */
const cookieDrawn: Gen<CookieCase> = (source) => ({
	name: weighted([
		[5, constant("c")],
		[1, element(COOKIE_NAMES)]
	])(source),
	value: parameterValue(source),
	line: element<CookieCase["line"]>(["3.2", "3.1", "3.0"])(source),
	style: element<CookieCase["style"]>(["form", "cookie"])(source),
	explode: weighted([
		[3, constant(true)],
		[1, constant(false)]
	])(source),
	allowReserved: boolean(source),
	required: boolean(source)
})

/** Text holding one character a 3.2 form cookie may write raw under allowReserved. */
const reservedText: Gen<string> = (source) =>
	`${text(source)}${characterOf(["/", "?", "#", "[", "@", "&", "+", "="])(source)}${text(source)}`

/** Cookie-octet text: plain letters and the reserved characters a cookie value may hold as they are. */
const octets: Gen<string> = string(characterOf(["a", "b", "0", "/", "=", "%", "!"]), {
	min: 0,
	max: 3
})

/**
 * A cookie parameter, aimed at a 3.2 cookie-style list and object (whose member names must be tokens), at 3.2
 * cookie-style text refused for a character no cookie-octet admits, and at a 3.2 cookie refused for its `explode: false`
 * alone.
 */
export const cookieSpace = aimed<CookieCase, CookieFeature>(cookieDrawn, [
	[
		"form reserved character encoded before 3.2",
		(source) => ({
			...cookieDrawn(source),
			name: "c",
			style: "form",
			line: element<CookieCase["line"]>(["3.0", "3.1"])(source),
			allowReserved: true,
			value: reservedText(source)
		})
	],
	[
		"form reserved character passed on 3.2",
		(source) => ({
			...cookieDrawn(source),
			name: "c",
			style: "form",
			line: "3.2",
			explode: true,
			allowReserved: true,
			value: reservedText(source)
		})
	],
	[
		"explode false refused on 3.2",
		(source) => ({
			...cookieDrawn(source),
			name: "c",
			line: "3.2",
			explode: false,
			value: octets(source)
		})
	],
	[
		"cookie style text refused",
		(source) => ({
			...cookieDrawn(source),
			name: "c",
			style: "cookie",
			line: "3.2",
			explode: true,
			value: `${octets(source)}${characterOf([" ", ";", ",", '"', "\\"])(source)}${octets(source)}`
		})
	],
	[
		"cookie style list exploded",
		(source) => ({
			...cookieDrawn(source),
			style: "cookie",
			line: "3.2",
			explode: true,
			value: array(octets, { min: 1, max: 3 })(source)
		})
	],
	[
		"cookie style object exploded",
		(source) => ({
			...cookieDrawn(source),
			style: "cookie",
			line: "3.2",
			explode: true,
			value: objectWith(string(characterOf(["a", "b", "0"]), { min: 1, max: 2 }), octets)(source)
		})
	]
])

/** The situations a cookie parameter reaches. */
export type CookieFeature =
	| "form scalar encoded"
	| "form reserved character passed on 3.2"
	| "form reserved character encoded before 3.2"
	| "cookie style text sent"
	| "cookie style list exploded"
	| "cookie style object exploded"
	| "nothing sent"
	| "required value refused"
	| "form list or object refused"
	| "cookie style text refused"
	| "explode false refused on 3.2"
	| "cookie style before 3.2 refused"
	| "name not a token refused"

/** What a cookie parameter's case reaches. */
export const cookieFeatures = (parameter: CookieCase): ReadonlyArray<CookieFeature> => {
	const read = cookieModel(parameter)
	const sent = Result.isSuccess(read) && Option.isSome(read.success)
	const kind = valueKind(parameter.value)
	const strings = stringsOf(parameter.value)
	const reservedIn = Arr.some(strings, (piece) =>
		Arr.some(Arr.fromIterable(COOKIE_RESERVED), (raw) => Str.includes(raw)(piece))
	)
	const shaped = isToken(parameter.name) && !(parameter.line === "3.2" && !parameter.explode)
	return holding<CookieFeature>([
		[
			"form scalar encoded",
			sent && parameter.style === "form" && Arr.some(strings, (piece) => strictly(piece) !== piece)
		],
		[
			"form reserved character passed on 3.2",
			sent &&
				parameter.style === "form" &&
				parameter.line === "3.2" &&
				parameter.allowReserved &&
				reservedIn
		],
		[
			"form reserved character encoded before 3.2",
			sent &&
				parameter.style === "form" &&
				parameter.line !== "3.2" &&
				parameter.allowReserved &&
				reservedIn
		],
		["cookie style text sent", sent && parameter.style === "cookie" && kind === "scalar"],
		["cookie style list exploded", sent && parameter.style === "cookie" && kind === "list"],
		["cookie style object exploded", sent && parameter.style === "cookie" && kind === "object"],
		["nothing sent", Result.isSuccess(read) && Option.isNone(read.success)],
		[
			"required value refused",
			Result.isFailure(read) &&
				parameter.required &&
				shaped &&
				Result.isSuccess(cookieModel({ ...parameter, required: false })) &&
				Option.isNone(
					Result.getOrElse(cookieModel({ ...parameter, required: false }), () => Option.some(""))
				)
		],
		[
			"form list or object refused",
			Result.isFailure(read) &&
				shaped &&
				parameter.style === "form" &&
				kind !== "scalar" &&
				isFlat(parameter.value) &&
				Option.isSome(Result.getOrElse(textsOf(parameter.value), () => Option.none<Texts>()))
		],
		[
			"cookie style text refused",
			Result.isFailure(read) &&
				shaped &&
				parameter.style === "cookie" &&
				parameter.line === "3.2" &&
				Arr.some(strings, (piece) => !isCookieOctets(piece) && !holdsLone(piece))
		],
		[
			"explode false refused on 3.2",
			parameter.line === "3.2" &&
				!parameter.explode &&
				Result.isSuccess(cookieModel({ ...parameter, explode: true }))
		],
		[
			"cookie style before 3.2 refused",
			parameter.style === "cookie" &&
				parameter.line !== "3.2" &&
				Result.isSuccess(cookieModel({ ...parameter, line: "3.2", explode: true }))
		],
		["name not a token refused", !isToken(parameter.name)]
	])
}

/** Where a content-based parameter travels: the query, a header, a cookie, or the whole query string. */
export type ContentLocation = "query" | "header" | "cookie" | "querystring"

/** A content-based parameter as drawn: its location, name, media type, value (none when absent) and presence rule. */
export type ContentCase = Readonly<{
	location: ContentLocation
	name: string
	mediaType: string
	value: Option.Option<Json>
	required: boolean
}>

/** Names a content-based parameter is drawn under, per location: plain, and each location's refused names. */
const CONTENT_NAMES: Readonly<Record<ContentLocation, Arr.NonEmptyReadonlyArray<string>>> = {
	query: ["q", "a b", "q\uDC00"],
	header: ["X-Filter", "X Note", ""],
	cookie: ["c", "a;b"],
	querystring: ["q"]
}

/** A content value: a JSON value or text, absent now and then. */
const contentValue: Gen<Option.Option<Json>> = weighted([
	[1, constant(Option.none())],
	[3, map(jsonValue, Option.some)],
	[3, map(text, Option.some)]
])

/** A content-based parameter as drawn, under JSON and text media alike. */
const contentDrawn: Gen<ContentCase> = (source) => {
	const location = element<ContentLocation>(["query", "header", "cookie", "querystring"])(source)
	return {
		location,
		name: weighted([
			[4, constant(CONTENT_NAMES[location][0])],
			[1, element(CONTENT_NAMES[location])]
		])(source),
		mediaType: element([
			"application/json",
			"text/plain",
			"application/vnd.api+json; charset=utf-8"
		])(source),
		value: contentValue(source),
		required: boolean(source)
	}
}

/** Text a header line cannot carry: a line break, a NUL, a code point past U+00FF, or space at an edge. */
const unheaded: Gen<string> = (source) =>
	`${element(["", " ", "\t"])(source)}${text(source)}${element(["\r", "\n", "\u0000", "ā", "😀"])(source)}${text(source)}`

/** A content-based parameter, aimed at a header whose text no header line carries. */
export const contentSpace = aimed<ContentCase, ContentFeature>(contentDrawn, [
	[
		"header line break refused",
		(source) => ({
			...contentDrawn(source),
			location: "header",
			name: "X-Note",
			mediaType: "text/plain",
			value: Option.some(unheaded(source))
		})
	]
])

/**
 * A content-based parameter's expansion (PRM-23, PRM-24, STY-42, STY-43), none, or its refusal: its location's name
 * rule first (a query name with a UTF-8 form, a header or cookie name a token), an absent value refused only when
 * required, the codec's text, then the location's writing: a query pair encoded strictly on both sides, a header as is
 * where a header line carries it, a cookie as `name=text` when all `cookie-octet`, the query string encoded strictly.
 */
export const contentModel = (parameter: ContentCase): Read<Option.Option<string>> => {
	const named =
		parameter.location === "query"
			? !holdsLone(parameter.name)
			: parameter.location === "querystring" || isToken(parameter.name)
	if (!named) {
		return refused
	}
	return Option.match(parameter.value, {
		onNone: (): Read<Option.Option<string>> =>
			parameter.required ? refused : Result.succeed(Option.none()),
		onSome: (value) =>
			Result.flatMap(
				contentTextModel(parameter.mediaType, value),
				(written): Read<Option.Option<string>> => {
					switch (parameter.location) {
						case "query":
							return Result.succeed(Option.some(`${strictly(parameter.name)}=${strictly(written)}`))
						case "header":
							return breaksHeader(written) ? refused : Result.succeed(Option.some(written))
						case "cookie":
							return isCookieOctets(written)
								? Result.succeed(Option.some(`${parameter.name}=${written}`))
								: refused
						case "querystring":
							return Result.succeed(Option.some(strictly(written)))
					}
				}
			)
	})
}

/** The situations a content-based parameter reaches. */
export type ContentFeature =
	| "query content"
	| "header content"
	| "cookie content"
	| "querystring content"
	| "JSON content"
	| "text content"
	| "digit text kept"
	| "absent and optional"
	| "absent and required refused"
	| "non-text under text media refused"
	| "number with no JSON text refused"
	| "header line break refused"
	| "cookie-octet refused"
	| "name refused"

/** Whether a JSON value holds a number no JSON text writes. */
const unwritable = (value: Json): boolean => Option.isNone(jsonModel(value))

/** Whether a JSON value holds a digit text anywhere. */
const holdsDigits = (value: Json): boolean =>
	value instanceof JsonNumber ||
	(isJsonList(value)
		? Arr.some(value, holdsDigits)
		: Predicate.isObject(value) &&
			!(value instanceof JsonNull) &&
			Arr.some(Rec.values(value), holdsDigits))

/** What a content-based parameter's case reaches. */
export const contentFeatures = (parameter: ContentCase): ReadonlyArray<ContentFeature> => {
	const read = contentModel(parameter)
	const sent = Result.isSuccess(read) && Option.isSome(read.success)
	const json = isJsonMedia(parameter.mediaType)
	const written = Option.flatMap(parameter.value, (value) =>
		Result.getSuccess(contentTextModel(parameter.mediaType, value))
	)
	const located: ReadonlyArray<readonly [ContentFeature, boolean]> = [
		["query content", sent && parameter.location === "query"],
		["header content", sent && parameter.location === "header"],
		["cookie content", sent && parameter.location === "cookie"],
		["querystring content", sent && parameter.location === "querystring"]
	]
	return holding<ContentFeature>([
		...located,
		["JSON content", sent && json],
		["text content", sent && !json],
		["digit text kept", sent && json && Option.exists(parameter.value, holdsDigits)],
		[
			"absent and optional",
			Option.isNone(parameter.value) && !parameter.required && Result.isSuccess(read)
		],
		[
			"absent and required refused",
			Option.isNone(parameter.value) && parameter.required && Result.isFailure(read)
		],
		[
			"non-text under text media refused",
			!json &&
				Option.exists(parameter.value, (value) => !Predicate.isString(value)) &&
				Result.isFailure(read)
		],
		["number with no JSON text refused", json && Option.exists(parameter.value, unwritable)],
		[
			"header line break refused",
			parameter.location === "header" &&
				isToken(parameter.name) &&
				Option.exists(written, breaksHeader)
		],
		[
			"cookie-octet refused",
			parameter.location === "cookie" &&
				isToken(parameter.name) &&
				Option.exists(written, (piece) => !isCookieOctets(piece))
		],
		[
			"name refused",
			Result.isFailure(read) &&
				Option.isSome(written) &&
				!(parameter.location === "header" && Option.exists(written, breaksHeader)) &&
				!(
					parameter.location === "cookie" &&
					Option.exists(written, (piece) => !isCookieOctets(piece))
				)
		]
	])
}

/** A header drawn for a request: a few names, two of them one name in another case, and Cookie in two cases. */
const REQUEST_HEADERS: Arr.NonEmptyReadonlyArray<string> = [
	"X-Id",
	"x-id",
	"If-Match",
	"X-Tags",
	"Cookie",
	"cOOKIE"
]

/** A request as drawn: its method, path, query parameters, headers and cookies. */
export type RequestCase = Readonly<{
	method: string
	path: PathCase
	query: ReadonlyArray<QueryCase>
	headers: ReadonlyArray<HeaderCase>
	cookies: ReadonlyArray<CookieCase>
}>

/** Plain text, at least one letter: what a well-formed request's values are made of. */
const plainText: Gen<string> = string(characterOf(PLAIN), { min: 1, max: 3 })

/** A plain value of one level: a text, a list of texts, an object of texts under plain keys. */
const plainValue: Gen<Nested> = oneOf<Nested>([
	plainText,
	array(plainText, { min: 1, max: 2 }),
	objectWith(plainText, plainText)
])

/** A well-formed path: `/users/{id}` with a plain simple id, or the root. */
const plainPath: Gen<PathCase> = oneOf<PathCase>([
	constant({ segments: [], parameters: [] }),
	map(plainText, (id) => ({
		segments: [[{ kind: "literal", text: "users" }], [{ kind: "placeholder", name: "id" }]],
		parameters: [{ style: "simple", name: "id", value: id, explode: false, allowReserved: false }]
	}))
])

/**
 * A request as drawn, mostly well formed (plain parts, so its assembly is reached), now and then with parts drawn as
 * their own properties draw them; header names repeat in other cases, and Cookie among them.
 */
export const requestSpace: Gen<RequestCase> = (source) => ({
	method: element(["GET", "POST", "PATCH", "PURGE"])(source),
	path: weighted([
		[4, plainPath],
		[1, pathDrawn]
	])(source),
	query: array(
		weighted<QueryCase>([
			[
				4,
				(inner) => ({
					...queryDrawn(inner),
					style: "form",
					value: weighted<Nested>([
						[3, plainValue],
						[1, constant(undefined)]
					])(inner),
					required: false
				})
			],
			[1, queryDrawn]
		]),
		{ min: 0, max: 3 }
	)(source),
	headers: array(
		weighted<HeaderCase>([
			[
				4,
				(inner) => ({
					name: element(REQUEST_HEADERS)(inner),
					value: weighted<Nested>([
						[3, plainValue],
						[1, constant(undefined)]
					])(inner),
					explode: false,
					required: false
				})
			],
			[1, (inner) => ({ ...headerDrawn(inner), name: element(REQUEST_HEADERS)(inner) })]
		]),
		{ min: 0, max: 2 }
	)(source),
	cookies: array(
		weighted<CookieCase>([
			[
				4,
				(inner) => ({
					name: element(["theme", "lang", "sid"])(inner),
					value: weighted<Nested>([
						[3, plainText],
						[1, constant(undefined)]
					])(inner),
					line: "3.1",
					style: "form",
					explode: true,
					allowReserved: false,
					required: false
				})
			],
			[1, (inner) => ({ ...cookieDrawn(inner), name: element(["theme", "lang", "sid"])(inner) })]
		]),
		{ min: 0, max: 3 }
	)(source)
})

/** What a request sends: its URL and its headers by lower-case name. */
export type Sent = Readonly<{ url: string; headers: Readonly<Record<string, string>> }>

/**
 * A request's URL and headers (design 4.5), or its refusal: any descriptor's refusal, two headers of one name in any
 * case, and a header named Cookie beside cookie parameters. The URL is the path and, when any pair is sent, `?` and the
 * query's pairs joined by `&`; each header sent is set; the cookies' pairs form one Cookie header joined by `; `.
 */
export const requestModel = (request: RequestCase): Read<Sent> => {
	const names = Arr.map(request.headers, (header) => Str.toLowerCase(header.name))
	if (
		Arr.dedupe(names).length !== names.length ||
		(request.cookies.length > 0 && Arr.contains(names, "cookie"))
	) {
		return refused
	}
	return Result.map(
		Result.all([
			pathModel(templateOf(request.path), request.path.parameters),
			Result.all(Arr.map(request.query, queryModel)),
			Result.all(
				Arr.map(request.headers, (header) =>
					Result.map(
						headerModel(header),
						Option.map((written) => [Str.toLowerCase(header.name), written] as const)
					)
				)
			),
			Result.all(Arr.map(request.cookies, cookieModel))
		] as const),
		([path, query, headers, cookies]): Sent => {
			const pairs = Arr.join(Arr.getSomes(query), "&")
			const cookieLine = Arr.join(Arr.getSomes(cookies), "; ")
			return {
				url: pairs === "" ? path : `${path}?${pairs}`,
				headers: Rec.fromEntries([
					...Arr.getSomes(headers),
					...(cookieLine === "" ? [] : [["cookie", cookieLine] as const])
				])
			}
		}
	)
}

/** The situations a request reaches. */
export type RequestFeature =
	| "query pairs joined"
	| "no query pair, no question mark"
	| "header set"
	| "header with no value left out"
	| "cookies joined"
	| "no cookie pair, no Cookie header"
	| "extension method kept"
	| "header names alike refused"
	| "Cookie header beside cookies refused"
	| "descriptor refusal"

/** What a request's case reaches. */
export const requestFeatures = (request: RequestCase): ReadonlyArray<RequestFeature> => {
	const read = requestModel(request)
	const names = Arr.map(request.headers, (header) => Str.toLowerCase(header.name))
	const unique = Arr.dedupe(names).length === names.length
	const beside = request.cookies.length > 0 && Arr.contains(names, "cookie")
	const queries = Arr.map(request.query, queryModel)
	const cookies = Arr.map(request.cookies, cookieModel)
	const headers = Arr.map(request.headers, headerModel)
	const sentAll = (reads: ReadonlyArray<Read<Option.Option<string>>>) =>
		Arr.filter(reads, (one) => Result.isSuccess(one) && Option.isSome(one.success)).length
	const noneAll = (reads: ReadonlyArray<Read<Option.Option<string>>>) =>
		Arr.some(reads, (one) => Result.isSuccess(one) && Option.isNone(one.success))
	const sent = Result.isSuccess(read)
	return holding<RequestFeature>([
		["query pairs joined", sent && sentAll(queries) > 1],
		["no query pair, no question mark", sent && request.query.length > 0 && sentAll(queries) === 0],
		["header set", sent && sentAll(headers) > 0],
		["header with no value left out", sent && noneAll(headers)],
		["cookies joined", sent && sentAll(cookies) > 1],
		[
			"no cookie pair, no Cookie header",
			sent && request.cookies.length > 0 && sentAll(cookies) === 0
		],
		["extension method kept", sent && request.method === "PURGE"],
		["header names alike refused", !unique],
		["Cookie header beside cookies refused", unique && beside],
		["descriptor refusal", unique && !beside && !sent]
	])
}

/** A body's bytes as given: a JSON value or text, or bytes already an HttpBody of each kind. */
export type Payload =
	| Readonly<{ kind: "json"; value: Json }>
	| Readonly<{ kind: "bytes"; bytes: Uint8Array; as: "uint8Array" | "stream" }>
	| Readonly<{ kind: "empty" }>

/** A request body as drawn: its media type and payload. */
export type BodyCase = Readonly<{ mediaType: string; payload: Payload }>

/** A request body as drawn: JSON values and text above all, bytes and the empty body now and then. */
const bodyDrawn: Gen<BodyCase> = (source) => ({
	mediaType: element(MEDIA)(source),
	payload: weighted<Payload>([
		[4, map(jsonValue, (value): Payload => ({ kind: "json", value }))],
		[3, map(text, (value): Payload => ({ kind: "json", value }))],
		[
			1,
			(inner): Payload => ({
				kind: "bytes",
				bytes: Uint8Array.from(array(int(0, 255), { min: 0, max: 4 })(inner)),
				as: element<"uint8Array" | "stream">(["uint8Array", "stream"])(inner)
			})
		],
		[1, constant<Payload>({ kind: "empty" })]
	])(source)
})

/**
 * A request body, aimed at a JSON number kept as its digit text, and at text holding half a surrogate pair under text
 * media.
 */
export const bodySpace = aimed<BodyCase, BodyFeature>(bodyDrawn, [
	[
		"digit text kept",
		(source) => ({
			mediaType: "application/json",
			payload: {
				kind: "json",
				value: { count: new JsonNumber(element(NUMBER_DIGITS)(source)) }
			}
		})
	],
	[
		"lone surrogate in text refused",
		(source) => ({
			mediaType: "text/plain",
			payload: {
				kind: "json",
				value: `${text(source)}${element(["\uD800", "\uDC00"])(source)}${text(source)}`
			}
		})
	]
])

/** What a body sends: its text, bytes passed through as given, or nothing at all, under its Content-Type or none. */
export type BodySent =
	| Readonly<{ kind: "text"; text: string; contentType: string }>
	| Readonly<{ kind: "given"; contentType: string }>
	| Readonly<{ kind: "empty" }>

/**
 * A body's request (design 6.3), or its refusal: a media type no header carries; bytes pass through as given, the
 * empty body with no Content-Type; under JSON media the value's compact JSON text, refused when a number has none;
 * under any other media text with a UTF-8 form, anything else refused.
 */
export const bodyModel = (body: BodyCase): Read<BodySent> => {
	if (body.mediaType === "" || breaksHeader(body.mediaType)) {
		return refused
	}
	switch (body.payload.kind) {
		case "empty":
			return Result.succeed({ kind: "empty" })
		case "bytes":
			return Result.succeed({ kind: "given", contentType: body.mediaType })
		case "json": {
			const value = body.payload.value
			if (isJsonMedia(body.mediaType)) {
				return Option.match(jsonModel(value), {
					onNone: (): Read<BodySent> => refused,
					onSome: (written): Read<BodySent> =>
						Result.succeed({ kind: "text", text: written, contentType: body.mediaType })
				})
			}
			return Predicate.isString(value) && !holdsLone(value)
				? Result.succeed({ kind: "text", text: value, contentType: body.mediaType })
				: refused
		}
	}
}

/** The situations a body reaches. */
export type BodyFeature =
	| "JSON text"
	| "digit text kept"
	| "structured JSON media"
	| "text as given"
	| "bytes passed through"
	| "streamed bytes passed through"
	| "empty body, no Content-Type"
	| "number with no JSON text refused"
	| "non-text under text media refused"
	| "lone surrogate in text refused"
	| "media type no header carries refused"

/** What a body's case reaches. */
export const bodyFeatures = (body: BodyCase): ReadonlyArray<BodyFeature> => {
	const read = bodyModel(body)
	const sent = Result.isSuccess(read)
	const carried = body.mediaType !== "" && !breaksHeader(body.mediaType)
	const json = isJsonMedia(body.mediaType)
	const value = body.payload.kind === "json" ? Option.some(body.payload.value) : Option.none<Json>()
	return holding<BodyFeature>([
		["JSON text", sent && json && Option.isSome(value)],
		["digit text kept", sent && json && Option.exists(value, holdsDigits)],
		[
			"structured JSON media",
			sent && json && essenceOf(body.mediaType) !== "application/json" && Option.isSome(value)
		],
		["text as given", sent && !json && Option.isSome(value)],
		[
			"bytes passed through",
			sent && body.payload.kind === "bytes" && body.payload.as === "uint8Array"
		],
		[
			"streamed bytes passed through",
			sent && body.payload.kind === "bytes" && body.payload.as === "stream"
		],
		["empty body, no Content-Type", sent && body.payload.kind === "empty"],
		["number with no JSON text refused", carried && json && Option.exists(value, unwritable)],
		[
			"non-text under text media refused",
			carried && !json && Option.exists(value, (one) => !Predicate.isString(one))
		],
		[
			"lone surrogate in text refused",
			carried && !json && Option.exists(value, (one) => Predicate.isString(one) && holdsLone(one))
		],
		["media type no header carries refused", !carried]
	])
}

/** A body's bytes as latin-1 text, a stream's run whole (a failing stream a defect); the empty body's none. */
export const bodyBytes = (body: HttpBody.HttpBody): Effect.Effect<Option.Option<string>> => {
	switch (body._tag) {
		case "Uint8Array":
			return Effect.succeedSome(latin1(body.body))
		case "Stream":
			return Effect.map(Stream.runCollect(Stream.orDie(body.stream)), (chunks) =>
				Option.some(Arr.join(Arr.map(Arr.fromIterable(chunks), latin1), ""))
			)
		case "Empty":
			return Effect.succeedNone
		case "Raw":
		case "FormData":
			return Effect.succeedSome(`<${body._tag}>`)
	}
}

/** Bytes as latin-1 text, one character a byte. */
export const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1")

/** A key of the body alternatives a chosen-codec case draws from. */
export type AlternativeKey =
	| "application/json"
	| "application/x-www-form-urlencoded"
	| "image/*"
	| "multipart/form-data"

/** One alternative's body as drawn. */
export type AlternativeCase =
	| Readonly<{ key: "application/json"; contentType: "application/json"; body: Json }>
	| Readonly<{
			key: "application/x-www-form-urlencoded"
			contentType: "application/x-www-form-urlencoded"
			body: Readonly<{ name: string; tags: ReadonlyArray<string> }>
	  }>
	| Readonly<{ key: "image/*"; contentType: string; body: Uint8Array }>
	| Readonly<{
			key: "multipart/form-data"
			contentType: "multipart/form-data"
			body: Readonly<{ name: string; file: Uint8Array }>
	  }>

/** A chosen alternative and its body, each key's body of its own kind, a range key's type one concrete type in it. */
export const alternativeSpace: Gen<AlternativeCase> = oneOf<AlternativeCase>([
	(source) => ({
		key: "application/json",
		contentType: "application/json",
		body: jsonValue(source)
	}),
	(source) => ({
		key: "application/x-www-form-urlencoded",
		contentType: "application/x-www-form-urlencoded",
		body: { name: text(source), tags: array(text, { min: 0, max: 2 })(source) }
	}),
	(source) => ({
		key: "image/*",
		contentType: element(["image/webp", "image/png"])(source),
		body: Uint8Array.from(array(int(0, 255), { min: 0, max: 3 })(source))
	}),
	(source) => ({
		key: "multipart/form-data",
		contentType: "multipart/form-data",
		body: {
			name: text(source),
			file: Uint8Array.from(array(int(0, 255), { min: 0, max: 3 })(source))
		}
	})
])

/** The situations a chosen alternative reaches. */
export type AlternativeFeature = AlternativeKey | "range key's concrete type sent"

/** What a chosen alternative reaches. */
export const alternativeFeatures = (chosen: AlternativeCase): ReadonlyArray<AlternativeFeature> =>
	holding<AlternativeFeature>([
		[chosen.key, true],
		["range key's concrete type sent", chosen.key === "image/*"]
	])
