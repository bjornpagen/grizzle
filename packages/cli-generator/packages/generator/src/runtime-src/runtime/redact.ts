import { regex } from "arkregex"
import {
	Array as Arr,
	Context,
	Formatter,
	Layer,
	Option,
	Order,
	Redacted,
	Ref,
	Result,
	String as Str
} from "effect"
import { Base64 } from "effect/encoding"
import { UrlParams } from "effect/http"
import type { Credential } from "#runtime/auth.ts"

/**
 * A value read from a secret-file field flag (design 13.1 R4): scrubbed like a credential, but it
 * answers no security scheme, so its placeholder is `<redacted:<label>>`, the flag's name.
 */
export interface Secret {
	readonly kind: "secret"
	readonly label: string
	readonly value: Redacted.Redacted
}

/**
 * One value the run scrubs: a configured credential or a secret-file value.
 */
export type ScrubEntry = Credential | Secret

const isSecret = (entry: ScrubEntry): entry is Secret => "kind" in entry

/**
 * The one placeholder grammar, bare: `<redacted>`. Every runtime module writes and matches the
 * placeholder through this builder or `labelledPlaceholder`.
 */
export const redactedPlaceholder = (): string => "<redacted>"

/**
 * The one placeholder grammar for a scheme or secret label: `<redacted:label>`, or bare
 * `<redacted>` for an empty label.
 */
export const labelledPlaceholder = (label: string): string =>
	label === "" ? redactedPlaceholder() : `<redacted:${label}>`

const placeholderOf = (entry: ScrubEntry): string =>
	labelledPlaceholder(isSecret(entry) ? entry.label : entry.scheme)

/**
 * The values the run recorded, so the final catch scrubs what the command handler chose: the
 * credentials `send` evaluated and the secret-file values the body read; `send` adds to it and
 * never replaces it. `finalCatch` adds them to its own list. Both require the service, so an entry
 * that omits `runCredentialsLayer` does not compile. It lives here, beside the entries it holds,
 * so `input.ts` records a secret-file value without an import cycle (`output.ts` imports
 * `auth.ts`, which imports `input.ts`).
 */
export class RunCredentials extends Context.Service<
	RunCredentials,
	Ref.Ref<readonly ScrubEntry[]>
>()("effect-openapi-cli-generator/runtime-src/runtime/redact/RunCredentials") {}

export const runCredentialsLayer: Layer.Layer<RunCredentials> = Layer.effect(RunCredentials)(
	Ref.make<readonly ScrubEntry[]>([])
)

/**
 * A query name or value exactly as the request target carries it (audit M F1): percent-encoded
 * with no `+` for a space, and with the `'` an http(s) URL parser percent-encodes in a query
 * already encoded, so the client writes the normalized bytes and redaction matches them.
 */
export const queryWireForm = (text: string): string =>
	Str.replaceAll("'", "%27")(encodeURIComponent(text))

/**
 * A value in `URLSearchParams` form, as `UrlParams.toString` writes it: the form
 * `HttpBody.urlParams` puts on the wire.
 */
const searchParamsForm = (text: string): string => Str.slice(1)(UrlParams.toString([["", text]]))

/**
 * A lone surrogate (any \p{Cs} unit), which has no UTF-8 form; the one test every runtime module
 * shares.
 */
export const loneSurrogate = regex("\\p{Cs}", "u")

/**
 * The forms a value takes in a URL or a form-urlencoded body, shared by credentials and secrets:
 * as `encodeURIComponent` writes it, as the request target carries it (`queryWireForm`), and as
 * URLSearchParams writes it, `+` for a space. `encodeURIComponent` throws on a lone surrogate, so
 * such a value gets only the URLSearchParams form.
 */
const encodedForms = (text: string): readonly string[] =>
	loneSurrogate.test(text)
		? [searchParamsForm(text)]
		: [encodeURIComponent(text), queryWireForm(text), searchParamsForm(text)]

const hexLower = (unit: number): string => Str.padStart(4, "0")(unit.toString(16))

const hexUpper = (unit: number): string => Str.toUpperCase(hexLower(unit))

/**
 * The UTF-16 units of one code point: itself, or its surrogate pair above U+FFFF.
 */
const utf16Units = (point: number): readonly number[] => {
	const offset = point - 0x1_00_00

	return offset >= 0
		? [0xd8_00 + Math.floor(offset / 0x4_00), 0xdc_00 + (offset % 0x4_00)]
		: [point]
}

/**
 * A JSON string body with every non-ASCII UTF-16 unit written as `\uXXXX`, as an ASCII-only JSON
 * encoder echoes it. `JSON.stringify` already escaped any lone surrogate, so every code point here
 * is whole.
 */
const asciiEscaped = (escaped: string, hex: (unit: number) => string): string => {
	let ascii = ""
	for (const character of escaped) {
		const point = Option.getOrElse(Str.codePointAt(0)(character), () => 0)

		ascii +=
			point < 0x80
				? character
				: Arr.join(
						Arr.map(utf16Units(point), (unit) => `\\u${hex(unit)}`),
						""
					)
	}

	return ascii
}

const isLineEnd = (character: string): boolean => character === "\n" || character === "\r"

/**
 * The value without its trailing CR and LF characters, which a server reading a line drops.
 */
const withoutLineEnd = (text: string): string => {
	let end = text.length
	while (end > 0 && Option.exists(Str.charAt(end - 1)(text), isLineEnd)) {
		end -= 1
	}

	return Str.slice(0, end)(text)
}

/**
 * Every form a secret travels in or is echoed in (security review of bd3128a): the value as given
 * and without its trailing CR/LF, each also URL- and form-encoded (`encodedForms`) and
 * JSON-escaped, both as written and ASCII-only with lower- and upper-case hex.
 */
const secretForms = (secret: string): readonly string[] =>
	Arr.flatMap([secret, withoutLineEnd(secret)], (base) => {
		const escaped = Str.slice(1, -1)(Formatter.formatJson(base))

		return [
			base,
			...encodedForms(base),
			escaped,
			asciiEscaped(escaped, hexLower),
			asciiEscaped(escaped, hexUpper)
		]
	})

/**
 * Every form a scrub entry travels in, each once and none empty. A secret: `secretForms`. A
 * credential (audit F2): the raw value; for http basic also the base64 token `basicAuth` sends and
 * the password alone; for an apiKey in the query also its `encodedForms`, the form the request
 * target carries and the forms a server may echo.
 */
const wireForms = (entry: ScrubEntry): readonly string[] => {
	const value: string = Redacted.value(entry.value)
	const forms = isSecret(entry) ? secretForms(value) : credentialForms(entry.definition, value)

	return Arr.filter(Arr.dedupe(forms), (form) => form !== "")
}

/**
 * The forms of a configured credential: the raw value; for http basic with a colon also the base64
 * token `basicAuth` sends and the password alone; for an apiKey in the query also its
 * `encodedForms`.
 */
const credentialForms = (
	definition: Credential["definition"],
	value: string
): readonly string[] => {
	if (definition.kind === "apiKey" && definition.in === "query") {
		return [value, ...encodedForms(value)]
	}

	if (definition.kind !== "http" || definition.scheme !== "basic") {
		return [value]
	}

	return Option.match(Str.indexOf(":")(value), {
		onNone: () => [value],
		onSome: (colon) => [value, Base64.encode(value), Str.slice(colon + 1)(value)]
	})
}

/**
 * Every wire form, and each one as `strip` leaves it. Empty forms are dropped.
 */
const formsAround =
	(strip: (text: string) => string) =>
	(entry: ScrubEntry): readonly string[] =>
		Arr.filter(
			Arr.flatMap(wireForms(entry), (form) => [form, strip(form)]),
			(form) => form !== ""
		)

/**
 * The Knuth-Morris-Pratt failure table of `form`: for each prefix, the length of its longest proper
 * prefix that is also its suffix.
 */
const failureOf = (form: string): readonly number[] => {
	const fallback = [0]

	for (let at = 1, matched = 0; at < form.length; at += 1) {
		while (matched > 0 && form[at] !== form[matched]) {
			matched = fallback[matched - 1] ?? 0
		}

		matched += form[at] === form[matched] ? 1 : 0
		fallback.push(matched)
	}

	return fallback
}

/**
 * Every start of a non-empty `form` in `text`, overlapping ones included, in order
 * (Knuth-Morris-Pratt, so a long text costs linear time).
 */
const startsOf = (text: string, form: string): readonly number[] => {
	const fallback = failureOf(form)
	const starts: number[] = []
	let matched = 0

	for (let at = 0; at < text.length; at += 1) {
		while (matched > 0 && text[at] !== form[matched]) {
			matched = fallback[matched - 1] ?? 0
		}

		matched += text[at] === form[matched] ? 1 : 0

		if (matched === form.length) {
			starts.push(at + 1 - form.length)
			matched = fallback[matched - 1] ?? 0
		}
	}

	return starts
}

interface Covered {
	readonly start: number
	readonly end: number
	readonly placeholder: string
}

const byStartThenLongest = Order.combine(
	Order.mapInput(Order.Number, (range: Covered) => range.start),
	Order.mapInput(Order.flip(Order.Number), (range: Covered) => range.end)
)

/**
 * Every occurrence of a placeholder this run's runtime emits (security review of m3-hb1): exactly
 * `<redacted>`, or `<redacted:<label>>` for the scheme or secret label of a scrubbed entry. Each is
 * matched as a literal string, so no label is read as a pattern. Other placeholder-shaped text,
 * such as a server echoing `<redacted:` + credential + `>`, is ordinary input.
 */
const placeholderTokens = (text: string, entries: readonly ScrubEntry[]): readonly Covered[] =>
	Arr.flatMap(
		Arr.dedupe([redactedPlaceholder(), ...Arr.map(entries, placeholderOf)]),
		(placeholder) =>
			Arr.map(startsOf(text, placeholder), (start) => ({
				end: start + placeholder.length,
				placeholder,
				start
			}))
	)

/**
 * Every occurrence of every wire form of every credential as a character range, overlapping
 * occurrences included, except one that lies wholly inside a placeholder the runtime emits already
 * in the text (hater m3 HB1, `placeholderTokens`): such a placeholder is opaque, so a credential
 * shorter than one, such as `a`, is never spelled out inside it. An occurrence that only overlaps
 * one is kept and merged, so no character of a form survives.
 */
const occurrences = (
	text: string,
	entries: readonly ScrubEntry[],
	formsOf: (entry: ScrubEntry) => readonly string[]
): readonly Covered[] => {
	const tokens = placeholderTokens(text, entries)
	const insideToken = (start: number, end: number): boolean =>
		Arr.some(tokens, (token) => token.start <= start && end <= token.end)

	return Arr.flatMap(entries, (entry) =>
		Arr.flatMap(formsOf(entry), (form) => {
			const placeholder = placeholderOf(entry)

			return Arr.filterMap(startsOf(text, form), (start) =>
				insideToken(start, start + form.length)
					? Result.failVoid
					: Result.succeed({ end: start + form.length, placeholder, start })
			)
		})
	)
}

/**
 * Merge ranges that overlap or touch. A merged run keeps the placeholder of its earliest,
 * longest range.
 */
const mergeRuns = (ranges: readonly Covered[]): readonly Covered[] => {
	const runs: Covered[] = []

	for (const range of Arr.sort(ranges, byStartThenLongest)) {
		const last = runs.at(-1)

		if (last !== undefined && range.start <= last.end) {
			runs[runs.length - 1] = { ...last, end: Math.max(last.end, range.end) }
		} else {
			runs.push(range)
		}
	}

	return runs
}

const scrubForms = (
	text: string,
	entries: readonly ScrubEntry[],
	formsOf: (entry: ScrubEntry) => readonly string[]
): string => {
	const runs = mergeRuns(occurrences(text, entries, formsOf))
	let scrubbed = ""
	let at = 0

	for (const run of runs) {
		scrubbed += Str.slice(at, run.start)(text) + run.placeholder
		at = run.end
	}

	return scrubbed + Str.slice(at)(text)
}

/**
 * Replace every wire form of every configured credential with `<redacted:<scheme>>` (design 7.5,
 * C5). Occurrences that overlap or touch merge into one run replaced by one placeholder, so no
 * character of any form survives (recheck N1), and placeholders are never rescanned.
 */
export const scrub = (text: string, credentials: readonly ScrubEntry[]): string =>
	scrubForms(text, credentials, wireForms)

/**
 * Scrub, apply `strip`, then scrub again (design 7.4, audit S2). The first pass runs before
 * anything is removed, so a credential holding a character `strip` removes is found as sent. The
 * second pass finds a credential that removed characters had split, matching each form both as
 * sent and as `strip` leaves it.
 */
export const scrubAround = (
	text: string,
	credentials: readonly ScrubEntry[],
	strip: (text: string) => string
): string => scrubForms(strip(scrub(text, credentials)), credentials, formsAround(strip))

/**
 * The one UTF-8 encoder every runtime module shares.
 */
export const encoder = new TextEncoder()

/**
 * The largest of `values`, 0 for none.
 */
const largest = (values: readonly number[]): number =>
	Arr.reduce(values, 0, (most, value) => Math.max(most, value))

export const longestFormBytes = (credentials: readonly ScrubEntry[]): number =>
	largest(Arr.map(Arr.flatMap(credentials, wireForms), (form) => encoder.encode(form).length))

/**
 * The length of the longest proper prefix of `form` that `text` ends with (Knuth-Morris-Pratt, so
 * a long credential costs linear time). Only the last `form.length - 1` characters can hold a
 * proper prefix, so a full match never forms.
 */
const trailingPrefixLength = (text: string, form: string): number => {
	const fallback = failureOf(form)
	let matched = 0

	for (let at = Math.max(0, text.length - form.length + 1); at < text.length; at += 1) {
		while (matched > 0 && text[at] !== form[matched]) {
			matched = fallback[matched - 1] ?? 0
		}

		matched += text[at] === form[matched] ? 1 : 0
	}

	return matched
}

/**
 * The last code point one UTF-16 unit holds; a larger one is a surrogate pair of two.
 */
const lastSingleUnit = 0xff_ff

/**
 * The length of the shortest tail of `text` that holds `kept` characters `strip` keeps. `strip`
 * removes characters one at a time, so each code point is kept or removed on its own.
 */
const tailKeeping = (text: string, kept: number, strip: (text: string) => string): number => {
	let end = text.length

	for (let remaining = kept; remaining > 0 && end > 0;) {
		const start =
			end - (Option.getOrElse(Str.codePointAt(end - 2)(text), () => 0) > lastSingleUnit ? 2 : 1)

		remaining -= strip(Str.slice(start, end)(text)).length
		end = start
	}

	return text.length - end
}

/**
 * Drop the trailing partial match of any credential form (audit F1). A read cut at its budget can
 * end inside a credential; that fragment never matches, so scrubbing would leave it, and a shorter
 * placeholder earlier in the text would pull it into the visible window. The fragment is also
 * matched as `strip` leaves the text, against each form both as sent and as `strip` leaves it
 * (audit S2), so a credential that removed characters split is dropped too.
 */
export const dropTrailingFragment = (
	text: string,
	credentials: readonly ScrubEntry[],
	strip: (text: string) => string
): string => {
	const stripped = strip(text)
	const sent = largest(
		Arr.map(Arr.flatMap(credentials, wireForms), (form) => trailingPrefixLength(text, form))
	)
	const asStripped = largest(
		Arr.map(Arr.flatMap(credentials, formsAround(strip)), (form) =>
			trailingPrefixLength(stripped, form)
		)
	)

	return Str.slice(0, text.length - Math.max(sent, tailKeeping(text, asStripped, strip)))(text)
}
