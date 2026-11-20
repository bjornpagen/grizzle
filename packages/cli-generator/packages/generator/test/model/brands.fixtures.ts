/**
 * What the property of brands.test.ts reads: each brand's text space, and a recognizer per brand written from its
 * grammar (RFC 9110 tokens and media types, RFC 3986 path and URI characters, RFC 6901 pointers, OpenAPI's path and
 * server templates, the help-safe text categories) that decides membership without the brand's own pattern.
 */

import {
	aimed,
	type Aimed,
	array,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	type Space,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import {
	CookieName,
	DocumentUri,
	HeaderName,
	JsonPointer,
	MediaRange,
	MediaType,
	MethodToken,
	PathTemplate,
	SafeText,
	ServerTemplate,
	stripUnsafeText,
	WireName
} from "#model/brands.ts"

export type BrandName =
	| "WireName"
	| "HeaderName"
	| "CookieName"
	| "MediaType"
	| "MediaRange"
	| "PathTemplate"
	| "ServerTemplate"
	| "MethodToken"
	| "SafeText"
	| "DocumentUri"
	| "JsonPointer"

const brandNames: Arr.NonEmptyReadonlyArray<BrandName> = [
	"WireName",
	"HeaderName",
	"CookieName",
	"MediaType",
	"MediaRange",
	"PathTemplate",
	"ServerTemplate",
	"MethodToken",
	"SafeText",
	"DocumentUri",
	"JsonPointer"
]

/** One case: a brand and the text it decodes, or a JSON number, which no brand admits. */
export type BrandCase = Readonly<{
	brand: BrandName
	input: Readonly<{ kind: "text"; text: string } | { kind: "number"; value: number }>
}>

export type Feature =
	| `${BrandName} admitted`
	| `${BrandName} refused`
	| "a template of several segments admitted"
	| "a dot segment refused"
	| "an interior empty segment refused"
	| "CONNECT refused"
	| "unsafe text stripped"
	| "line breaks and tabs kept through the strip"

const isIn =
	(chars: string) =>
	(char: string): boolean =>
		Str.includes(char)(chars)

const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

const digit = "0123456789"

const hexDigit = `${digit}ABCDEFabcdef`

/** RFC 9110 5.6.2 tchar. */
const isTchar = isIn(`!#$%&'*+-.^_\`|~${digit}${alpha}`)

/** A media type's type and subtype characters: tchar without `*`. */
const isConcrete = (char: string): boolean => isTchar(char) && char !== "*"

/** RFC 3986 unreserved and sub-delims, `:` and `@`: a path segment's pchar but percent-encodings. */
const isPchar = isIn(`${alpha}${digit}-._~!$&'()*+,;=:@`)

/** RFC 3986's URI characters a server template or document URI holds, but percent-encodings. */
const isUriChar = isIn(`${alpha}${digit}-._~:/?#[]@!$&'()*+,;=`)

/** The characters of a string, each a code point, a lone surrogate standing alone. */
const charsOf = (text: string): ReadonlyArray<string> => Arr.fromIterable(text)

const codeOf = (char: string): number => Option.getOrElse(Str.codePointAt(0)(char), () => 0)

/** Unicode general category Cc: C0, DEL and C1. */
const isControl = (char: string): boolean => {
	const code = codeOf(char)
	return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

/** A lone surrogate, category Cs. */
const isSurrogate = (char: string): boolean => {
	const code = codeOf(char)
	return char.length === 1 && code >= 0xd8_00 && code <= 0xdf_ff
}

/** The format characters (Cf) and separators (Zl, Zp) the text alphabet below holds; it holds no others. */
const formatOrSeparator: ReadonlySet<string> = new Set([
	"\u00AD",
	"\u200B",
	"\u200E",
	"\u202E",
	"\u2066",
	"\uFEFF",
	"\u2028",
	"\u2029"
])

const isUnsafeTextChar = (char: string): boolean =>
	char !== "\n" &&
	char !== "\t" &&
	(isControl(char) || isSurrogate(char) || formatOrSeparator.has(char))

/** Whether `text` reads as `%` and two hex digits at `index`. */
const percentAt = (chars: ReadonlyArray<string>, index: number): boolean =>
	Arr.get(chars, index).pipe(Option.contains("%")) &&
	Option.exists(Arr.get(chars, index + 1), isIn(hexDigit)) &&
	Option.exists(Arr.get(chars, index + 2), isIn(hexDigit))

/**
 * Reads `chars` as a run of single characters `single` admits, percent-encodings and brace expressions whose inner
 * characters `inner` admits (non-empty, no nesting): whether the whole run reads so.
 */
const readsAs = (
	chars: ReadonlyArray<string>,
	single: (char: string) => boolean,
	inner: (char: string) => boolean
): boolean => {
	let index = 0
	while (index < chars.length) {
		const char = Arr.getUnsafe(chars, index)
		if (char === "%") {
			if (!percentAt(chars, index)) {
				return false
			}
			index += 3
		} else if (char === "{") {
			const close = Arr.findFirstIndex(Arr.drop(chars, index + 1), (c) => c === "}")
			if (Option.isNone(close) || close.value === 0) {
				return false
			}
			if (!Arr.every(Arr.take(Arr.drop(chars, index + 1), close.value), inner)) {
				return false
			}
			index += close.value + 2
		} else if (single(char)) {
			index += 1
		} else {
			return false
		}
	}
	return true
}

/** ECMAScript's WhiteSpace and LineTerminator code points: what a pattern's `\s` reads. */
const isWhitespace = isIn(
	"\t\n\u000B\u000C\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"
)

/** A path segment's dot form once `%2e` (any case) reads as `.`. */
const isDotSegment = (segment: string): boolean => {
	const decoded = Str.replaceAll("%2E", ".")(Str.replaceAll("%2e", ".")(segment))
	return decoded === "." || decoded === ".."
}

/** OpenAPI's path template: `/`-led segments of pchar, percent-encodings and expressions; no dot segment; empty last only. */
const isPathTemplate = (text: string): boolean => {
	if (!Str.startsWith("/")(text)) {
		return false
	}
	const segments = Arr.drop(Str.split("/")(text), 1)
	return Arr.every(
		segments,
		(segment, index) =>
			(segment !== "" || index === segments.length - 1) &&
			!isDotSegment(segment) &&
			readsAs(
				charsOf(segment),
				isPchar,
				(c) => !isIn("{}/?#")(c) && !isWhitespace(c) && !isControl(c) && !isSurrogate(c)
			)
	)
}

/** RFC 9110 8.3.1's qdtext: tab, space, `!`, and `#` to `~` but the backslash. */
const isQdtext = (char: string): boolean => {
	const code = codeOf(char)
	return (
		char === "\t" ||
		code === 0x20 ||
		code === 0x21 ||
		(code >= 0x23 && code <= 0x7e && char !== "\\")
	)
}

/** RFC 9110 5.6.4's quoted-pair: a backslash and a tab, a space or a visible ASCII character. */
const isQuotable = (char: string): boolean =>
	char === "\t" || (codeOf(char) >= 0x20 && codeOf(char) <= 0x7e)

/** How far a run of `admitted` characters from `from` reaches. */
const runEnd = (
	chars: ReadonlyArray<string>,
	from: number,
	admitted: (char: string) => boolean
): number => from + Arr.takeWhile(Arr.drop(chars, from), admitted).length

/** Where a quoted string opened at `from` ends, past its closing quote, or none when it never closes. */
const quotedEnd = (chars: ReadonlyArray<string>, from: number): Option.Option<number> => {
	let index = from + 1
	while (index < chars.length) {
		const char = Arr.getUnsafe(chars, index)
		if (char === '"') {
			return Option.some(index + 1)
		}
		if (char === "\\") {
			if (!Option.exists(Arr.get(chars, index + 1), isQuotable)) {
				return Option.none()
			}
			index += 2
		} else if (isQdtext(char)) {
			index += 1
		} else {
			return Option.none()
		}
	}
	return Option.none()
}

const isBlank = isIn(" \t")

/** RFC 9110 8.3.1's parameters: each optional blanks, `;`, optional blanks, a token, `=`, a token or a quoted string. */
const parametersRead = (chars: ReadonlyArray<string>): boolean => {
	let index = 0
	while (index < chars.length) {
		index = runEnd(chars, index, isBlank)
		if (!Arr.get(chars, index).pipe(Option.contains(";"))) {
			return false
		}
		index = runEnd(chars, index + 1, isBlank)
		const nameEnd = runEnd(chars, index, isTchar)
		if (nameEnd === index || !Arr.get(chars, nameEnd).pipe(Option.contains("="))) {
			return false
		}
		const valueStart = nameEnd + 1
		if (Arr.get(chars, valueStart).pipe(Option.contains('"'))) {
			const end = quotedEnd(chars, valueStart)
			if (Option.isNone(end)) {
				return false
			}
			index = end.value
		} else {
			const valueEnd = runEnd(chars, valueStart, isTchar)
			if (valueEnd === valueStart) {
				return false
			}
			index = valueEnd
		}
	}
	return true
}

const concrete = (part: ReadonlyArray<string>): boolean =>
	Arr.isReadonlyArrayNonEmpty(part) && Arr.every(part, isConcrete)

const isStar = (part: ReadonlyArray<string>): boolean =>
	part.length === 1 && Arr.getUnsafe(part, 0) === "*"

/** A media type or range: a type, `/`, the subtype's token run, then parameters. */
const isMedia = (text: string, wildcards: boolean): boolean => {
	const chars = charsOf(text)
	const slash = Arr.findFirstIndex(chars, (c) => c === "/")
	if (Option.isNone(slash)) {
		return false
	}
	const kind = Arr.take(chars, slash.value)
	const subtypeEnd = runEnd(chars, slash.value + 1, isTchar)
	const subtype = Arr.take(Arr.drop(chars, slash.value + 1), subtypeEnd - slash.value - 1)
	const rangeReads = wildcards
		? (isStar(kind) && isStar(subtype)) ||
			(concrete(kind) && (isStar(subtype) || concrete(subtype)))
		: concrete(kind) && concrete(subtype)
	return rangeReads && parametersRead(Arr.drop(chars, subtypeEnd))
}

/** RFC 6901: empty, or `/`-led tokens whose `~` is always `~0` or `~1`. */
const isPointer = (text: string): boolean =>
	text === "" ||
	(Str.startsWith("/")(text) &&
		Arr.every(Arr.drop(Str.split("/")(text), 1), (token) =>
			Arr.every(
				Arr.drop(Str.split("~")(token), 1),
				(rest) => Str.startsWith("0")(rest) || Str.startsWith("1")(rest)
			)
		))

/** RFC 3986's absolute URI: a scheme of a letter then letters, digits, `+`, `-` or `.`, a colon, URI characters. */
const isDocumentUri = (text: string): boolean => {
	const chars = charsOf(text)
	const schemeEnd = runEnd(chars, 0, isIn(`${alpha}${digit}+-.`))
	return (
		schemeEnd > 0 &&
		isIn(alpha)(Arr.getUnsafe(chars, 0)) &&
		Arr.get(chars, schemeEnd).pipe(Option.contains(":")) &&
		readsAs(Arr.drop(chars, schemeEnd + 1), isUriChar, () => false)
	)
}

const isToken = (text: string): boolean => text !== "" && Arr.every(charsOf(text), isTchar)

/** Each brand's membership, read from its grammar. */
const admits: Readonly<Record<BrandName, (text: string) => boolean>> = {
	WireName: (text) =>
		text !== "" && !Arr.some(charsOf(text), (c) => isControl(c) || isSurrogate(c)),
	HeaderName: isToken,
	CookieName: isToken,
	MethodToken: (text) => isToken(text) && text !== "CONNECT",
	MediaType: (text) => isMedia(text, false),
	MediaRange: (text) => isMedia(text, true),
	PathTemplate: isPathTemplate,
	ServerTemplate: (text) =>
		text !== "" && readsAs(charsOf(text), isUriChar, (c) => !isIn("{}/?#")(c) && !isWhitespace(c)),
	SafeText: (text) => !Arr.some(charsOf(text), isUnsafeTextChar),
	DocumentUri: isDocumentUri,
	JsonPointer: isPointer
}

const codecs = {
	WireName,
	HeaderName,
	CookieName,
	MediaType,
	MediaRange,
	PathTemplate,
	ServerTemplate,
	MethodToken,
	SafeText,
	DocumentUri,
	JsonPointer
} as const

/** What a brand answers for a case: whether it admits the input, and for SafeText the text its stripper leaves. */
export type Answer = Readonly<{ admitted: boolean; stripped: Option.Option<string> }>

/** The brand's own codec and stripper. */
export const actualOf = (c: BrandCase): Answer => ({
	admitted: Schema.is(codecs[c.brand])(c.input.kind === "text" ? c.input.text : c.input.value),
	stripped:
		c.brand === "SafeText" && c.input.kind === "text"
			? Option.some(stripUnsafeText(c.input.text))
			: Option.none()
})

/** Whether the grammar admits the input (no number is text). */
const admitted = (c: BrandCase): boolean => c.input.kind === "text" && admits[c.brand](c.input.text)

/** The grammar's answer: its membership, and for SafeText the text with every character it refuses removed. */
export const expectedOf = (c: BrandCase): Answer => ({
	admitted: admitted(c),
	stripped:
		c.brand === "SafeText" && c.input.kind === "text"
			? Option.some(
					Arr.join(
						Arr.filter(charsOf(c.input.text), (char) => !isUnsafeTextChar(char)),
						""
					)
				)
			: Option.none()
})

const joined =
	(pieces: Gen<string>, size: Readonly<{ min: number; max: number }>): Gen<string> =>
	(s) =>
		Arr.join(s.draw(array(pieces, size)), "")

/** Characters of every category the text brands decide on: letters, marks, controls, format, separators, surrogates. */
const textChar = element([
	"a",
	" ",
	"\n",
	"\t",
	"{",
	"$",
	"`",
	"\\",
	"é",
	"😀",
	"_",
	"\r",
	"\u0007",
	"\u0000",
	"\u007F",
	"\u0085",
	"\u009F",
	"\u00AD",
	"\u200B",
	"\u200E",
	"\u202E",
	"\u2066",
	"\uFEFF",
	"\u2028",
	"\u2029",
	"\uD800",
	"\uDC00"
])

const tokenPiece = element([
	"X-Request-Id",
	"session_id",
	"PROPFIND",
	"GET",
	"CONNECT",
	"a",
	"__proto__",
	"constructor",
	"a=b",
	"bad name",
	"x;y",
	'"q"',
	"",
	"é",
	"*"
])

const mediaPiece = oneOf<string>([
	(s) =>
		`${s.draw(element(["application", "image", "text", "*", "", "a b", "x+json", "vnd.a-b"]))}/${s.draw(element(["json", "*", "png", "", "plain", "x/y", "a b"]))}`,
	element(["image", "application/*", "*/*", "*/json"])
])

const parameterPiece = element([
	"; charset=utf-8",
	";charset=utf-8",
	" ; q=0.5",
	'; a="b c"',
	'; a="b\\"c"',
	'; a="unclosed',
	"; a",
	"; =b",
	"; a=b c",
	";"
])

const segmentPiece = element([
	"users",
	"{id}",
	"posts",
	"",
	".",
	"..",
	"%2e",
	"%2E%2e",
	"%2e%2ex",
	"..a",
	".b",
	"%ff",
	"%zz",
	"%2",
	"a b",
	"{}",
	"{x{y}}",
	"{café}",
	"{b\u0001}",
	"{b\uD800}",
	"a?x=1",
	"a:b@c",
	"}",
	"{"
])

const serverPiece = element([
	"https://",
	"{region}",
	".example.com",
	"/v1",
	":8080",
	"%20",
	"%g0",
	"{}",
	"{a b}",
	"a b",
	"{x",
	"}",
	"?q=1#f",
	"[::1]",
	"é"
])

const uriPiece = element([
	"file:",
	"https:",
	"x+y.z-1:",
	"1a:",
	":",
	"no scheme",
	"//host",
	"/specs/api.yaml",
	"%41",
	"%4",
	"é",
	"?a=b",
	"#frag",
	"[v]"
])

const pointerPiece = element([
	"/a",
	"/",
	"/a~1b",
	"/m~0n",
	"/~",
	"/~2",
	"/~01",
	"/\uD800",
	"/ ",
	"a",
	"/0",
	"~1"
])

/** Text for a brand, built from the pieces its grammar turns on, some admitted, some refused. */
const textFor = (brand: BrandName): Gen<string> => {
	switch (brand) {
		case "WireName":
		case "SafeText":
			return joined(textChar, { min: 0, max: 6 })
		case "HeaderName":
		case "CookieName":
		case "MethodToken":
			return joined(tokenPiece, { min: 1, max: 2 })
		case "MediaType":
		case "MediaRange":
			return (s) => `${s.draw(mediaPiece)}${s.draw(joined(parameterPiece, { min: 0, max: 2 }))}`
		case "PathTemplate":
			return oneOf<string>([
				(s) =>
					Arr.join(
						Arr.map(s.draw(array(segmentPiece, { min: 1, max: 3 })), (segment) => `/${segment}`),
						""
					),
				(s) => s.draw(segmentPiece)
			])
		case "ServerTemplate":
			return joined(serverPiece, { min: 0, max: 4 })
		case "DocumentUri":
			return joined(uriPiece, { min: 1, max: 3 })
		case "JsonPointer":
			return joined(pointerPiece, { min: 0, max: 3 })
	}
}

const caseFor =
	(brand: BrandName): Gen<BrandCase> =>
	(s) => ({ brand, input: { kind: "text", text: s.draw(textFor(brand)) } })

const anyCase: Gen<BrandCase> = (s) => {
	const brand = s.draw(element(brandNames))
	return s.draw(
		weighted<BrandCase>([
			[3, caseFor(brand)],
			[1, constant({ brand, input: { kind: "number", value: 42 } })]
		])
	)
}

/** Cases of `brand` the grammar decides `wanted`: the first of eight drawn that is, else a number, which no brand admits. */
const decidedAs =
	(brand: BrandName, wanted: boolean): Space<BrandCase> =>
	(s) =>
		Option.getOrElse(
			Arr.findFirst(
				s.draw(array(caseFor(brand), { min: 8, max: 8 })),
				(c) => admitted(c) === wanted
			),
			(): BrandCase => ({ brand, input: { kind: "number", value: 42 } })
		)

const pathCase = (text: string): Gen<BrandCase> =>
	constant({ brand: "PathTemplate", input: { kind: "text", text } })

/** Brand cases, aimed at each brand admitting and refusing, and at the path template's and method's own refusals. */
export const brandSpace: Aimed<BrandCase, Feature> = aimed(anyCase, [
	...Arr.flatMap(brandNames, (brand) => [
		[`${brand} admitted`, decidedAs(brand, true)] as const,
		[`${brand} refused`, decidedAs(brand, false)] as const
	]),
	[
		"a dot segment refused",
		map(element(["/a/%2E%2e/b", "/a/./b", "/a/.."]), (text): BrandCase => ({
			brand: "PathTemplate",
			input: { kind: "text", text }
		}))
	],
	[
		"a template of several segments admitted",
		map(
			array(element(["users", "{id}", "%ff", "..a", ".b", "{café}", "a:b@c"]), { min: 2, max: 3 }),
			(segments): BrandCase => ({
				brand: "PathTemplate",
				input: {
					kind: "text",
					text: Arr.join(
						Arr.map(segments, (segment) => `/${segment}`),
						""
					)
				}
			})
		)
	],
	["an interior empty segment refused", oneOf([pathCase("/a//b"), pathCase("//a")])],
	[
		"CONNECT refused",
		constant<BrandCase>({ brand: "MethodToken", input: { kind: "text", text: "CONNECT" } })
	],
	[
		"unsafe text stripped",
		map(joined(textChar, { min: 2, max: 6 }), (text): BrandCase => ({
			brand: "SafeText",
			input: { kind: "text", text: `a\u202E${text}` }
		}))
	],
	[
		"line breaks and tabs kept through the strip",
		map(joined(textChar, { min: 0, max: 4 }), (text): BrandCase => ({
			brand: "SafeText",
			input: { kind: "text", text: `a\n\u200Bb\t${text}` }
		}))
	]
])

/** The situations a case reaches. */
export const featuresOf = (c: BrandCase): ReadonlyArray<Feature> => {
	const isAdmitted = admitted(c)
	const text = c.input.kind === "text" ? c.input.text : ""
	const segments = Arr.drop(Str.split("/")(text), 1)
	const pathRefusal = c.brand === "PathTemplate" && Str.startsWith("/")(text) && !isAdmitted
	return [
		isAdmitted ? `${c.brand} admitted` : `${c.brand} refused`,
		...(c.brand === "PathTemplate" && isAdmitted && segments.length > 1
			? ["a template of several segments admitted" as const]
			: []),
		...(pathRefusal && Arr.some(segments, isDotSegment) ? ["a dot segment refused" as const] : []),
		...(pathRefusal &&
		Arr.some(segments, (segment, index) => segment === "" && index < segments.length - 1)
			? ["an interior empty segment refused" as const]
			: []),
		...(c.brand === "MethodToken" && text === "CONNECT" ? ["CONNECT refused" as const] : []),
		...(c.brand === "SafeText" &&
		Arr.some(charsOf(text), isUnsafeTextChar) &&
		Arr.some(charsOf(text), (char) => char === "\n" || char === "\t")
			? ["line breaks and tabs kept through the strip" as const]
			: []),
		...(c.brand === "SafeText" && Arr.some(charsOf(text), isUnsafeTextChar)
			? ["unsafe text stripped" as const]
			: [])
	]
}
