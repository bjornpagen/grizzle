/**
 * What the properties of human.test.ts read: text drawn from characters labelled by their Unicode General_Category,
 * diagnostics drawn over every part of design 8.1's human line, and a model of the line and of each character's
 * escape, written apart from the module's own: the escapes are spelled out by hand, the field and its media type are
 * read from the sketch, never from the pointer.
 */

import {
	aimed,
	type Aimed,
	array,
	characterOf,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	option,
	type Size,
	string
} from "@bjornpagen/testing/gen"
import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Option, Record, String as Str } from "effect"
import type { DiagnosticInput } from "#model/diagnostic.ts"
import { formatPointer } from "#model/pointer.ts"

/** The kinds of character design 8.1 writes as a visible escape, by their General_Category. */
type UnsafeKind = "control" | "format" | "separator" | "surrogate"

/**
 * The unsafe characters drawn, each with the escape design 8.1 writes for it, by its General_Category in Unicode's
 * UnicodeData.txt: controls (Cc, C0, DEL and C1), format characters (Cf), the line and paragraph separators (Zl, Zp),
 * and lone surrogates (Cs), low halves only, so no two drawn characters pair into one.
 */
const ESCAPES: Readonly<Record<UnsafeKind, Arr.NonEmptyReadonlyArray<readonly [string, string]>>> =
	{
		control: [
			["\u0000", "\\u{0}"],
			["\u0007", "\\u{7}"],
			["\t", "\\u{9}"],
			["\n", "\\u{a}"],
			["\r", "\\u{d}"],
			["\u001B", "\\u{1b}"],
			["\u007F", "\\u{7f}"],
			["\u0085", "\\u{85}"],
			["\u009B", "\\u{9b}"]
		],
		format: [
			["\u00AD", "\\u{ad}"],
			["\u200B", "\\u{200b}"],
			["\u200E", "\\u{200e}"],
			["\u202E", "\\u{202e}"],
			["\u2066", "\\u{2066}"],
			["\uFEFF", "\\u{feff}"]
		],
		separator: [
			["\u2028", "\\u{2028}"],
			["\u2029", "\\u{2029}"]
		],
		surrogate: [
			["\uDC00", "\\u{dc00}"],
			["\uDFFF", "\\u{dfff}"]
		]
	}

const UNSAFE_KINDS: Arr.NonEmptyReadonlyArray<UnsafeKind> = [
	"control",
	"format",
	"separator",
	"surrogate"
]

/** Each unsafe character's escape. */
const escapeOf: Readonly<Record<string, string>> = Record.fromEntries(
	Arr.flatMap(UNSAFE_KINDS, (kind) => ESCAPES[kind])
)

const unsafeOf = (kind: UnsafeKind): Arr.NonEmptyReadonlyArray<string> =>
	Arr.map(ESCAPES[kind], ([character]) => character)

const ALL_UNSAFE: Arr.NonEmptyReadonlyArray<string> = Arr.flatMap(UNSAFE_KINDS, unsafeOf)

/** Space separators (Zs) beyond ASCII's, which stay as they are: only the line and paragraph separators are escaped. */
const WIDE_SPACES: Arr.NonEmptyReadonlyArray<string> = ["\u00A0", "\u3000"]

/** A character beyond the Basic Multilingual Plane (U+1F600, So), two UTF-16 units, one code point. */
const ASTRAL = "\u{1F600}"

/**
 * Characters that stay as they are: ASCII letters, digits and punctuation, a combining mark (Mn), Latin and CJK
 * letters, the space separators and an astral character.
 */
const PRINTABLE: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"Z",
	"0",
	"/",
	"~",
	'"',
	"\\",
	"[",
	"{",
	"\u0301",
	"é",
	"日",
	"本",
	ASTRAL,
	" ",
	...WIDE_SPACES
]

const printableText: Gen<string> = string(characterOf(PRINTABLE), { min: 0, max: 6 })

const anyText: Gen<string> = string(characterOf([...PRINTABLE, ...ALL_UNSAFE]), {
	min: 0,
	max: 6
})

/** Text holding at least one of `characters`. */
const textWith =
	(characters: Arr.NonEmptyReadonlyArray<string>): Gen<string> =>
	(s) =>
		`${s.draw(anyText)}${s.draw(characterOf(characters))}${s.draw(anyText)}`

const hostileText: Gen<string> = textWith(ALL_UNSAFE)

/** The model of sanitizeField: each code point with an escape written as it, every other kept. */
export const sanitizedModel = (text: string): string =>
	Arr.join(
		Arr.map(Arr.fromIterable(text), (character) =>
			Option.getOrElse(Record.get(escapeOf, character), () => character)
		),
		""
	)

const holdsAny =
	(characters: ReadonlyArray<string>) =>
	(text: string): boolean =>
		Arr.some(Arr.fromIterable(text), (character) => Arr.contains(characters, character))

const isHostile = holdsAny(ALL_UNSAFE)

export type FieldFeature =
	| `a ${UnsafeKind} escaped`
	| "an ANSI escape made inert"
	| "an astral character kept whole"
	| "a space separator kept"
	| "text with nothing to escape"

export const fieldFeaturesOf = (text: string): ReadonlyArray<FieldFeature> => [
	...Arr.flatMap(UNSAFE_KINDS, (kind) =>
		holdsAny(unsafeOf(kind))(text) ? [`a ${kind} escaped` as const] : []
	),
	...(Str.includes("\u001B[")(text) ? ["an ANSI escape made inert" as const] : []),
	...(Str.includes(ASTRAL)(text) ? ["an astral character kept whole" as const] : []),
	...(holdsAny(WIDE_SPACES)(text) ? ["a space separator kept" as const] : []),
	...(Str.isNonEmpty(text) && !isHostile(text) ? ["text with nothing to escape" as const] : [])
]

/** Field texts, aimed at each kind of character. */
export const fieldSpace: Aimed<string, FieldFeature> = aimed(anyText, [
	...Arr.map(UNSAFE_KINDS, (kind) => [`a ${kind} escaped`, textWith(unsafeOf(kind))] as const),
	["an ANSI escape made inert", (s) => `${s.draw(printableText)}\u001B[31m${s.draw(anyText)}`],
	["an astral character kept whole", (s) => `${s.draw(anyText)}${ASTRAL}${s.draw(anyText)}`],
	["a space separator kept", (s) => `${s.draw(anyText)}\u00A0${s.draw(printableText)}`],
	["text with nothing to escape", (s) => `a${s.draw(printableText)}`]
])

type Scope = DiagnosticInput["scope"]

type Severity = DiagnosticInput["severity"]

/**
 * Where a diagnostic points: at a field's Encoding entry, `<media>/encoding/<name>` under some prefix, or at a pointer
 * of tokens none of which is `encoding`. Tokens are raw, unescaped.
 */
type Place =
	| Readonly<{
			kind: "entry"
			prefix: ReadonlyArray<string>
			media: string
			name: string
	  }>
	| Readonly<{ kind: "plain"; tokens: ReadonlyArray<string> }>

type Operation = Readonly<{ method: string; path: string; operationId: Option.Option<string> }>

/** The parts a diagnostic may carry that its line leaves out. */
type Beside = Pick<DiagnosticInput, "column" | "hint" | "line" | "related" | "wire">

/** A diagnostic as drawn for its human line: every part the line shows, and the parts it leaves out, if it has them. */
export type LineSketch = Readonly<{
	severity: Severity
	scope: Scope
	code: string
	place: Place
	element: string
	message: string
	operation: Option.Option<Operation>
	specSection: string
	beside: Option.Option<Beside>
}>

const tokenGen: Gen<string> = element([
	"paths",
	"~1x",
	"post",
	"requestBody",
	"content",
	"schema",
	"a b",
	"3"
])

const hostileToken: Gen<string> = (s) => s.draw(hostileText)

const mediaGen: Gen<string> = element([
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"a/b"
])

const nameGen: Gen<string> = element(["a", "a/b~c", "~", "m~n", "file"])

const entryPlace =
	(media: Gen<string>, name: Gen<string>): Gen<Place> =>
	(s) => ({
		kind: "entry",
		prefix: s.draw(array(tokenGen, { min: 0, max: 3 })),
		media: s.draw(media),
		name: s.draw(name)
	})

const plainPlace =
	(token: Gen<string>, size: Size): Gen<Place> =>
	(s) => ({ kind: "plain", tokens: s.draw(array(token, size)) })

const operationGen =
	(text: Gen<string>): Gen<Operation> =>
	(s) => ({
		method: s.draw(element(["GET", "POST", "QUERY"])),
		path: `/${s.draw(text)}`,
		operationId: s.draw(option(text))
	})

const besideGen: Gen<Beside> = constant({
	column: 7,
	hint: "a hint",
	line: 3,
	related: [{ document: "file:///other.json", pointer: "/info" }],
	wire: "X-Trace"
})

const lineGen =
	(parts: Readonly<{ text: Gen<string>; place: Gen<Place> }>): Gen<LineSketch> =>
	(s) => ({
		severity: s.draw(element<Severity>(["refusal", "notice"])),
		scope: s.draw(element<Scope>(["document", "operation", "element", "field"])),
		code: s.draw(
			element(["PRM-27/compound-nested", "S30-4/a", "A1B-9/x1-y2", "CFG-1/unknown-key"])
		),
		place: s.draw(parts.place),
		element: s.draw(parts.text),
		message: s.draw(parts.text),
		operation: s.draw(option(operationGen(parts.text))),
		specSection: s.draw(
			element([
				"https://spec.openapis.org/oas/v3.0.4.html#style-values",
				"https://spec.openapis.org/oas/v3.1.1.html#encoding-object",
				"https://www.rfc-editor.org/rfc/rfc6901#section-4"
			])
		),
		beside: s.draw(option(besideGen))
	})

const anyLine: Gen<LineSketch> = lineGen({
	text: anyText,
	place: oneOf([entryPlace(mediaGen, nameGen), plainPlace(tokenGen, { min: 0, max: 4 })])
})

/** The raw tokens of a sketch's pointer. */
const tokensOf = (place: Place): ReadonlyArray<string> =>
	place.kind === "entry" ? [...place.prefix, place.media, "encoding", place.name] : place.tokens

/** The factory's input for a sketch, with the parts its line leaves out where it has them. */
export const lineInputOf = (sketch: LineSketch): DiagnosticInput => ({
	...Option.match(sketch.beside, { onNone: (): Beside => ({}), onSome: (beside) => beside }),
	code: sketch.code,
	document: "file:///spec.json",
	element: sketch.element,
	message: sketch.message,
	openapi: "3.1.0",
	operation: Option.getOrUndefined(
		Option.map(sketch.operation, (operation) =>
			Option.match(operation.operationId, {
				onNone: () => ({ method: operation.method, path: operation.path }),
				onSome: (operationId) => ({ method: operation.method, operationId, path: operation.path })
			})
		)
	),
	pointer: formatPointer(tokensOf(sketch.place)),
	scope: sketch.scope,
	severity: sketch.severity,
	specSection: sketch.specSection
})

/** The field part's text: the Encoding entry's name as JSON text and its media type, or the element as JSON text. */
const fieldTextOf = (sketch: LineSketch): string =>
	sketch.place.kind === "entry"
		? `${jsonText(sketch.place.name)} in ${sketch.place.media}`
		: jsonText(sketch.element)

/**
 * The model of design 8.1's line: `<refused|notice> <code> at #<pointer>[ (<METHOD> <path>[, <operationId>])][ field
 * <name> in <media type>]: <message>; <specSection>`, the field part for a `field` scope alone, every part sanitized,
 * and `hint`, `line`, `column`, `related` and `wire` nowhere in it.
 */
export const expectedLine = (sketch: LineSketch): string => {
	const severity = sketch.severity === "refusal" ? "refused" : "notice"
	const operation = Option.match(sketch.operation, {
		onNone: () => "",
		onSome: (found) =>
			` (${sanitizedModel(
				`${found.method} ${found.path}${Option.match(found.operationId, {
					onNone: () => "",
					onSome: (operationId) => `, ${operationId}`
				})}`
			)})`
	})
	const field = sketch.scope === "field" ? ` field ${sanitizedModel(fieldTextOf(sketch))}` : ""
	const pointer = sanitizedModel(formatPointer(tokensOf(sketch.place)))
	return `${severity} ${sanitizedModel(sketch.code)} at #${pointer}${operation}${field}: ${sanitizedModel(sketch.message)}; ${sanitizedModel(sketch.specSection)}`
}

export type LineFeature =
	| `a ${Severity}`
	| "no operation"
	| "an operation with its id"
	| "an operation without its id"
	| "a field at its Encoding entry"
	| "a field off an Encoding entry"
	| "an Encoding pointer outside a field refusal"
	| "a field name with pointer escapes"
	| "a hostile pointer"
	| "a hostile message"
	| "a hostile operation"
	| "a hostile field"
	| "the fields beside the line"

const isHostileOperation = (operation: Operation): boolean =>
	isHostile(operation.path) || Option.exists(operation.operationId, isHostile)

export const lineFeaturesOf = (sketch: LineSketch): ReadonlyArray<LineFeature> => {
	const when = (holds: boolean, feature: LineFeature): ReadonlyArray<LineFeature> =>
		holds ? [feature] : []
	const field = sketch.scope === "field"
	const entry = sketch.place.kind === "entry"
	return [
		`a ${sketch.severity}`,
		...Option.match(sketch.operation, {
			onNone: () => ["no operation" as const],
			onSome: (operation) => [
				Option.isSome(operation.operationId)
					? ("an operation with its id" as const)
					: ("an operation without its id" as const),
				...when(isHostileOperation(operation), "a hostile operation")
			]
		}),
		...when(field && entry, "a field at its Encoding entry"),
		...when(field && !entry, "a field off an Encoding entry"),
		...when(!field && entry, "an Encoding pointer outside a field refusal"),
		...when(
			field && sketch.place.kind === "entry" && Str.includes("~")(sketch.place.name),
			"a field name with pointer escapes"
		),
		...when(isHostile(Arr.join(tokensOf(sketch.place), "")), "a hostile pointer"),
		...when(isHostile(sketch.message), "a hostile message"),
		...when(field && isHostile(fieldTextOf(sketch)), "a hostile field"),
		...when(Option.isSome(sketch.beside), "the fields beside the line")
	]
}

const fieldLine =
	(place: Gen<Place>): Gen<LineSketch> =>
	(s) => ({ ...s.draw(anyLine), place: s.draw(place), scope: "field" })

/** Line sketches, aimed at each part of the line and each place a hostile character can stand. */
export const lineSpace: Aimed<LineSketch, LineFeature> = aimed(anyLine, [
	["a refusal", map(anyLine, (sketch): LineSketch => ({ ...sketch, severity: "refusal" }))],
	["a notice", map(anyLine, (sketch): LineSketch => ({ ...sketch, severity: "notice" }))],
	["no operation", map(anyLine, (sketch) => ({ ...sketch, operation: Option.none() }))],
	[
		"an operation with its id",
		(s) => ({
			...s.draw(anyLine),
			operation: Option.some({ ...s.draw(operationGen(anyText)), operationId: Option.some("list") })
		})
	],
	[
		"an operation without its id",
		(s) => ({
			...s.draw(anyLine),
			operation: Option.some({ ...s.draw(operationGen(anyText)), operationId: Option.none() })
		})
	],
	["a field at its Encoding entry", fieldLine(entryPlace(mediaGen, nameGen))],
	["a field off an Encoding entry", fieldLine(plainPlace(tokenGen, { min: 1, max: 4 }))],
	[
		"an Encoding pointer outside a field refusal",
		(s) => ({
			...s.draw(anyLine),
			place: s.draw(entryPlace(mediaGen, nameGen)),
			scope: s.draw(element<Scope>(["document", "operation", "element"]))
		})
	],
	[
		"a field name with pointer escapes",
		fieldLine(entryPlace(mediaGen, element(["a/b~c", "~", "m~n"])))
	],
	[
		"a hostile pointer",
		(s) => ({ ...s.draw(anyLine), place: s.draw(plainPlace(hostileToken, { min: 1, max: 3 })) })
	],
	["a hostile message", (s) => ({ ...s.draw(anyLine), message: s.draw(hostileText) })],
	[
		"a hostile operation",
		(s) => ({ ...s.draw(anyLine), operation: Option.some(s.draw(operationGen(hostileText))) })
	],
	["a hostile field", fieldLine(entryPlace((s) => `a/${s.draw(hostileText)}`, hostileToken))],
	[
		"the fields beside the line",
		(s) => ({ ...s.draw(anyLine), beside: Option.some(s.draw(besideGen)) })
	]
])
