/** What the properties of redact.test.ts read: drawn recorded values, the forms a server echoes them in, and texts holding them. */

import {
	type Aimed,
	aimed,
	characterOf,
	element,
	type Gen,
	int,
	map,
	option,
	string
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Redacted,
	Stream,
	String as Str
} from "effect"
import { Base64 } from "effect/encoding"
import type { Credential } from "#runtime-src/runtime/auth.ts"
import { readErrorBody, sanitize } from "#runtime-src/runtime/output.ts"
import {
	dropTrailingFragment,
	type ScrubEntry,
	scrub,
	scrubAround
} from "#runtime-src/runtime/redact.ts"

/** How the run recorded a value: a credential of a kind, or a secret file's text. */
export type Kind = "bearer" | "basic" | "query apiKey" | "header apiKey" | "secret file"

/** Characters a recorded value holds: what URL, form and JSON encodings each treat their own way. */
const VALUE_CHARS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"Z",
	"5",
	" ",
	'"',
	"'",
	"!",
	"/",
	"~",
	"é",
	"🔑",
	"+",
	"%",
	"\\"
]

/** A value: drawn characters, and for a secret file maybe a trailing line end, which a server reading a line drops. */
const valueOf = (kind: Kind): Gen<string> => {
	switch (kind) {
		case "basic":
			return (s) =>
				`${s.draw(string(characterOf(["a", "u", "1"]), { min: 1, max: 4 }))}:${s.draw(string(characterOf(VALUE_CHARS), { min: 3, max: 8 }))}`
		case "secret file":
			return (s) =>
				`${s.draw(string(characterOf(VALUE_CHARS), { min: 3, max: 8 }))}${s.draw(element(["", "\n", "\r\n"]))}`
		case "bearer":
		case "query apiKey":
		case "header apiKey":
			return string(characterOf(VALUE_CHARS), { min: 3, max: 8 })
	}
}

/** A form a value is echoed in, as the design lists them for its kind (7.5, audit F2, M F1, the review of bd3128a). */
export type Form =
	| "as sent"
	| "without its line end"
	| "percent-encoded"
	| "in the request target"
	| "form-encoded"
	| "JSON-escaped"
	| "ASCII-escaped, lower-case hex"
	| "ASCII-escaped, upper-case hex"
	| "the basic token"
	| "the basic password"

const FORMS: Readonly<Record<Kind, Arr.NonEmptyReadonlyArray<Form>>> = {
	bearer: ["as sent"],
	"header apiKey": ["as sent"],
	basic: ["as sent", "the basic token", "the basic password"],
	"query apiKey": ["as sent", "percent-encoded", "in the request target", "form-encoded"],
	"secret file": [
		"as sent",
		"without its line end",
		"percent-encoded",
		"in the request target",
		"form-encoded",
		"JSON-escaped",
		"ASCII-escaped, lower-case hex",
		"ASCII-escaped, upper-case hex"
	]
}

/** One recorded value echoed in one of its forms between plain text, maybe split by characters a print strips. */
export type Echo = Readonly<{
	kind: Kind
	value: string
	form: Form
	cuts: ReadonlyArray<number>
	fragment: number
	split: Option.Option<readonly [number, string]>
}>

/** Characters a print strips, which may split a value's fragment at a chunk's end. */
const STRIPPED: Arr.NonEmptyReadonlyArray<string> = ["\u00AD", "\u0085", "\u0001"]

/** Where an echo's fragment ends (a share of its form) and the stripped character inside it, if any. */
const fragmentGen = (s: Parameters<Gen<number>>[0]) => ({
	fragment: s.draw(int(1, 999)),
	split: s.draw(option(map(int(0, 999), (at) => [at, s.draw(element(STRIPPED))] as const)))
})

const KINDS: Arr.NonEmptyReadonlyArray<Kind> = [
	"bearer",
	"basic",
	"query apiKey",
	"header apiKey",
	"secret file"
]

const echoes: Gen<Echo> = (s) => {
	const kind = s.draw(element(KINDS))
	return {
		kind,
		value: s.draw(valueOf(kind)),
		form: s.draw(element(FORMS[kind])),
		cuts: s.draw(
			map(int(0, 3), (count) => Array.from({ length: count }, (_, at) => (at * 7 + 3) % 11))
		),
		...fragmentGen(s)
	}
}

const hex = (upper: boolean) => (unit: number) => {
	const digits = Str.padStart(4, "0")(unit.toString(16))
	return upper ? Str.toUpperCase(digits) : digits
}

/** A JSON string's body with every non-ASCII UTF-16 unit as `\uXXXX`. */
const asciiOnly = (escaped: string, upper: boolean): string =>
	Arr.join(
		Arr.map(Arr.fromIterable(escaped), (character) => {
			const units = Array.from({ length: character.length }, (_, at) =>
				Option.getOrElse(Str.charCodeAt(at)(character), () => 0)
			)
			return Arr.every(units, (unit) => unit < 0x80)
				? character
				: Arr.join(
						Arr.map(units, (unit) => `\\u${hex(upper)(unit)}`),
						""
					)
		}),
		""
	)

const lineEnd = regex("[\\r\\n]+$", "u")

/** The text a form of the value is, as the encodings the design names write it. */
const formOf = (echo: Echo): string => {
	const bare = Str.replace(lineEnd, "")(echo.value)
	switch (echo.form) {
		case "as sent":
			return echo.value
		case "without its line end":
			return bare
		case "percent-encoded":
			return encodeURIComponent(echo.value)
		case "in the request target":
			return Str.replaceAll("'", "%27")(encodeURIComponent(echo.value))
		case "form-encoded":
			return Str.slice(1)(new URLSearchParams([["", echo.value]]).toString())
		case "JSON-escaped":
			return Str.slice(1, -1)(Formatter.formatJson(echo.value))
		case "ASCII-escaped, lower-case hex":
			return asciiOnly(Str.slice(1, -1)(Formatter.formatJson(echo.value)), false)
		case "ASCII-escaped, upper-case hex":
			return asciiOnly(Str.slice(1, -1)(Formatter.formatJson(echo.value)), true)
		case "the basic token":
			return Base64.encode(echo.value)
		case "the basic password":
			return Option.match(Str.indexOf(":")(echo.value), {
				onNone: () => echo.value,
				onSome: (colon) => Str.slice(colon + 1)(echo.value)
			})
	}
}

/** The scrub entry the run recorded, and the label its placeholder carries. */
const entryOf = (echo: Echo): readonly [ScrubEntry, string] => {
	const value = Redacted.make(echo.value)
	switch (echo.kind) {
		case "bearer":
			return [
				{
					definition: { kind: "http", scheme: "bearer" },
					scheme: "bearerAuth",
					value
				} satisfies Credential,
				"bearerAuth"
			]
		case "basic":
			return [
				{
					definition: { kind: "http", scheme: "basic" },
					scheme: "basicAuth",
					value
				} satisfies Credential,
				"basicAuth"
			]
		case "query apiKey":
			return [
				{
					definition: { in: "query", kind: "apiKey", name: "api_key" },
					scheme: "apiKey",
					value
				} satisfies Credential,
				"apiKey"
			]
		case "header apiKey":
			return [
				{
					definition: { in: "header", kind: "apiKey", name: "X-Key" },
					scheme: "headerKey",
					value
				} satisfies Credential,
				"headerKey"
			]
		case "secret file":
			return [{ kind: "secret", label: "password-file", value }, "password-file"]
	}
}

/** The plain text an echo sits between: no character of any value's alphabet, so nothing of it joins a form. */
const PREFIX = "got:"

const SUFFIX = " ;end"

/**
 * A chunk's end inside the echo: a proper prefix of the form (its first character at least), with a stripped character
 * after one of its characters when the echo draws one.
 */
const fragmentOf = (echo: Echo): string => {
	const form = formOf(echo)
	const units = Arr.fromIterable(form)
	const kept = Arr.take(
		units,
		Math.max(1, Math.min(units.length - 1, Math.floor((echo.fragment * units.length) / 1000)))
	)
	return Option.match(echo.split, {
		onNone: () => Arr.join(kept, ""),
		onSome: ([at, stripped]) => {
			const place = 1 + Math.floor((at * kept.length) / 1000)
			return `${Arr.join(Arr.take(kept, place), "")}${stripped}${Arr.join(Arr.drop(kept, place), "")}`
		}
	})
}

/** The text a server sent: the form between plain text. */
const sentOf = (echo: Echo): string => `${PREFIX}${formOf(echo)}${SUFFIX}`

/** The text's bytes cut into chunks at the echo's cut points, each a share of its length. */
const chunksOf = (echo: Echo): Stream.Stream<Uint8Array> => {
	const bytes = new TextEncoder().encode(sentOf(echo))
	const at = Arr.dedupe(
		Arr.sort(
			Arr.map(echo.cuts, (cut) => Math.floor((cut * bytes.length) / 11)),
			Order.Number
		)
	)
	const bounds = [0, ...at, bytes.length]
	return Stream.fromIterable(
		Arr.map(Arr.zip(Arr.dropRight(bounds, 1), Arr.drop(bounds, 1)), ([from, to]) =>
			bytes.subarray(from, to)
		)
	)
}

/** What the scrub leaves of a text, by each of its paths: the scrub, the scrub around a strip, the read of a body. */
export const scrubbedOf = (echo: Echo) =>
	Effect.gen(function* () {
		const [entry] = entryOf(echo)
		const sent = sentOf(echo)
		const read = yield* readErrorBody(chunksOf(echo), [entry])
		const once = scrubAround(sent, [entry], sanitize)
		return {
			scrubbed: scrub(sent, [entry]),
			around: once,
			again: scrubAround(once, [entry], sanitize),
			read,
			fragment: dropTrailingFragment(`${PREFIX}${fragmentOf(echo)}`, [entry], sanitize)
		}
	})

/**
 * What the design says each path leaves: the form replaced by the entry's placeholder between the plain text; the scrub
 * around a strip the same with the strip applied to the plain text, and the same again when run on its own result (a
 * placeholder is opaque); a body read across chunks the same as read whole.
 */
export const expectedOf = (echo: Echo) => {
	const [, label] = entryOf(echo)
	const scrubbed = `${PREFIX}<redacted:${label}>${SUFFIX}`
	return { scrubbed, around: scrubbed, again: scrubbed, read: scrubbed, fragment: PREFIX }
}

export type EchoFeature =
	| `${Kind}: ${Form}`
	| "a value holding non-ASCII"
	| "a body cut into chunks"

export const echoFeatures = (echo: Echo): ReadonlyArray<EchoFeature> => [
	`${echo.kind}: ${echo.form}`,
	...(Arr.some(Arr.fromIterable(echo.value), (character) =>
		Option.exists(Str.charCodeAt(0)(character), (unit) => unit >= 0x80)
	)
		? (["a value holding non-ASCII"] as const)
		: []),
	...(Arr.isReadonlyArrayNonEmpty(echo.cuts) ? (["a body cut into chunks"] as const) : [])
]

/** Every kind's forms, each a required situation. */
export const SITUATIONS: ReadonlyArray<EchoFeature> = Arr.flatMap(KINDS, (kind) =>
	Arr.map(FORMS[kind], (form): EchoFeature => `${kind}: ${form}`)
)

/** An echo of `kind`'s value in `form`. */
const echoOf =
	(kind: Kind, form: Form): Gen<Echo> =>
	(s) => ({
		kind,
		value: s.draw(armValue(kind, form)),
		form,
		cuts: s.draw(
			map(int(0, 3), (count) => Array.from({ length: count }, (_, at) => (at * 7 + 3) % 11))
		),
		...fragmentGen(s)
	})

/**
 * The value an aimed echo of `form` draws: one with a line end for the form without it, and one holding a wide and an
 * astral character for the ASCII-escaped forms, so each form differs from the value as sent.
 */
const armValue = (kind: Kind, form: Form): Gen<string> => {
	switch (form) {
		case "without its line end":
			return (s) =>
				`${s.draw(string(characterOf(VALUE_CHARS), { min: 3, max: 8 }))}${s.draw(element(["\n", "\r\n"]))}`
		case "ASCII-escaped, lower-case hex":
		case "ASCII-escaped, upper-case hex":
			return (s) => `${s.draw(string(characterOf(VALUE_CHARS), { min: 1, max: 4 }))}é🔑`
		case "as sent":
		case "percent-encoded":
		case "in the request target":
		case "form-encoded":
		case "JSON-escaped":
		case "the basic token":
		case "the basic password":
			return valueOf(kind)
	}
}

/** Echoes, aimed at each kind and form while it is pending. */
export const aimedEchoes: Aimed<Echo, EchoFeature> = aimed(
	echoes,
	Arr.flatMap(KINDS, (kind) =>
		Arr.map(FORMS[kind], (form) => [`${kind}: ${form}` as const, echoOf(kind, form)] as const)
	)
)
