import { textColumn } from "#compiler/core/decoder.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { int4Max } from "#compiler/core/limits.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import { flatMapNonEmpty, isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import type * as Result from "#compiler/core/result.ts"
import type { PatternLanguage, Patterns } from "#compiler/ir/scalar.ts"
import { isRegexFlags, type RegexFlags } from "#compiler/scalar/regex/parse.ts"
import { registeredText, registerTextDescriptor } from "#compiler/scalar/registry.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import type { TextField } from "#compiler/types/fields/field.ts"
import type {
	Refused,
	RegexFlagsValidate,
	RegexInfer,
	RegexValidate
} from "#compiler/types/fields/regex.ts"

/**
 * str.regex, str.and and str.bytes: the text field constructors.
 *
 * ArkRegex appears here only as a type: `regex.validate` checks the literal source at the type level and `regex.infer`
 * computes the host type, so `str.regex("^(yes|no)$")` is a field whose host type is "yes" | "no". The
 * import is `import type`, so no ArkRegex code, no RegExp and no matcher reaches the runtime. The runtime keeps only
 * the immutable literal patterns; schema compilation checks the admitted grammar and lowers them (refinement.ts), and
 * PostgreSQL alone validates values.
 *
 * Inference is an overapproximation of membership: a narrow host type is not proof that a runtime string
 * matches, and a pattern ArkRegex cannot infer precisely widens, at worst to string. ArkRegex accepts constructs the
 * admitted grammar rejects (backreferences, lookarounds, property escapes); the grammar check, not the inference,
 * decides admission. `regex.as` assertions and RegExp objects are not accepted.
 *
 * A text field descriptor: its host type, its PostgreSQL base type, and its literal patterns, a non-empty conjunction
 * whose language is every text each pattern matches, a TextField (types/fields/field.ts) whose column is a
 * pattern-refined text column (core/decoder.ts textColumn): a cell's text is its value, a member of the patterns'
 * language, which PostgreSQL's CHECK enforces and the host type overapproximates. The host type is the field's
 * language, which a JavaScript value at it is one of; its domain is text, which a term of any patterns meets. Schema
 * compilation reads the field's Description from the descriptor registry (scalar/registry.ts registerTextDescriptor),
 * which carries the patterns' language as the text analysis proved it once, when the descriptor was made.
 */
export interface RegexText<out Host extends string> extends TextField<Host> {
	readonly sql: "text"
}

/** The flags arguments of a call: none, or one flags value. */
type RegexFlagsArguments = readonly [] | readonly [flags: RegexFlags]

/** A flags argument typed as a union is refused (RegexFlagsValidate), with the message in the diagnostic. */
type RegexFlagsRefusal<A extends RegexFlagsArguments> = A extends readonly [
	infer F extends RegexFlags
]
	? [F] extends [RegexFlagsValidate<F>]
		? unknown
		: Refused<RegexFlagsValidate<F>>
	: unknown

/**
 * The flags a call resolves to, read through the type of its first flags argument: "u" when there is none.
 * The runtime resolves them through the same table, so the descriptor's flags have this type by
 * construction, and a call cannot claim "su" flags it did not pass.
 */
const flagsOf = Object.freeze({ u: "u", su: "su", undefined: "u" } as const)
type RegexFlagsOf<A extends RegexFlagsArguments> = (typeof flagsOf)[`${A[0]}`]

/** A JavaScript caller can pass what the types forbid; that is a malformed argument, thrown synchronously. */
const refuse = (capability: string): never => {
	throw malformedDescription(captureLoc("str.regex", []), capability)
}

/**
 * The admission core: refuses a source or a flags argument the types forbid. str.regex runs it on its arguments; a
 * test of what a JavaScript caller passes calls it directly.
 */
export const admitRegex = (source: unknown, flags: unknown): void => {
	if (typeof source !== "string") {
		refuse("a regex source string; a RegExp object or regex.as assertion is not accepted")
	}
	if (flags !== undefined && !isRegexFlags(flags)) {
		refuse('regex flags "u" or "su"')
	}
}

/** The first flags argument, undefined when there is none. */
const firstFlags = <A extends RegexFlagsArguments>(flags: A): A[0] => flags[0]

/**
 * The descriptor of patterns of `language`, as the text analysis proved it (text/refinement.ts textLookup), cut to
 * `octets` UTF-8 bytes where the descriptor has a byte bound.
 */
const textField = <Host extends string>(
	patterns: Patterns,
	language: Result.Result<PatternLanguage, CompileError>,
	octets: number | undefined
): RegexText<Host> =>
	registerTextDescriptor(
		Object.freeze({
			...builtMark,
			sql: "text",
			patterns: Object.freeze(patterns),
			column: textColumn<Host>()
		}),
		language,
		octets
	)

/**
 * The descriptor of an admitted source and flags arguments. Its host type is the one the caller names, its column's
 * claim. str.regex is this over literal arguments, naming the pattern's inferred language; a caller driving the
 * runtime path over sources known only at run time calls it directly.
 */
export const regexField = <Host extends string>(
	source: string,
	flags: RegexFlagsArguments
): RegexText<Host> => {
	const first = firstFlags(flags)
	admitRegex(source, first)
	const resolved: RegexFlags = flagsOf[`${first}` as const]
	const patterns: Patterns = [Object.freeze({ source, flags: resolved })]
	return textField<Host>(patterns, textLookup(patterns), undefined)
}

/** A JavaScript caller's str.bytes arguments the types forbid: a malformed argument, thrown synchronously. */
const refuseBytes = (capability: string): never => {
	throw malformedDescription(captureLoc("str.bytes", []), capability)
}

/** A text descriptor a builder made, str.regex's, str.and's or str.bytes's, which a byte bound or a conjunction reads. */
const textDescriptor =
	"a text descriptor a builder made: str.regex(...), str.and(...) or str.bytes(...)"

/**
 * The admission core of str.bytes: a byte bound octet_length's integer result compares with, from 0 to int4's
 * greatest, and a text descriptor a builder made; the bound the descriptor states, the tighter of the two where the
 * patterns are already bounded, and the language the text's registration proved, which the bound cuts.
 */
const admitBytes = (
	bytes: unknown,
	text: unknown
): {
	readonly octets: number
	readonly language: Result.Result<PatternLanguage, CompileError>
} => {
	if (
		typeof bytes !== "number" ||
		!Number.isSafeInteger(bytes) ||
		bytes < 0 ||
		bytes > int4Max.value
	) {
		return refuseBytes(
			`a byte bound: an integer from 0 to ${int4Max.value}, which octet_length's integer result is compared with`
		)
	}
	const registered = registeredText(text)
	if (registered === undefined) {
		return refuseBytes(`${textDescriptor}, whose language the byte bound cuts`)
	}
	return {
		octets: registered.bytes === undefined ? bytes : Math.min(bytes, registered.bytes),
		language: registered.language
	}
}

/**
 * str.bytes(N, text): text of `text`'s language of at most N UTF-8 bytes. The bound is a refinement as the patterns
 * are, not a type: the field's host type and domain are the text's, so it meets any text a pattern-refined text meets.
 * Its domain checks `octet_length(VALUE) <= N` before the patterns, one domain for each language and bound, and a key
 * reads N as its bytes exactly; a bound every value of the patterns already meets leaves the text's own type. Text
 * always carries a pattern, so the bound takes one: `str.bytes(N, str.regex("^.*$", "su"))` is any text of at most N
 * bytes.
 */
const bytesConstructor = <Host extends string>(
	bytes: number,
	text: RegexText<Host>
): RegexText<Host> => {
	const { octets, language } = admitBytes(bytes, text)
	return textField<Host>(text.patterns, language, octets)
}

/** A JavaScript caller's str.and arguments the types forbid: a malformed argument, thrown synchronously. */
const refuseAnd = (at: number, capability: string): never => {
	throw malformedDescription(captureLoc("str.and", [at]), capability)
}

/** One text str.and joins: its patterns and its byte bound, as its builder registered them. */
const admitMember = (
	member: unknown,
	at: number
): { readonly patterns: Patterns; readonly bytes: number | undefined } =>
	registeredText(member) ?? refuseAnd(at, `${textDescriptor}, whose patterns the conjunction joins`)

/**
 * The host type of the texts str.and joins: each one's host type, intersected, since every value of the conjunction is
 * a value of each.
 */
export type JoinedHost<M extends ReadonlyArray<RegexText<string>>> = M extends readonly [
	RegexText<infer H>,
	...infer Rest extends ReadonlyArray<RegexText<string>>
]
	? H & JoinedHost<Rest>
	: string

/**
 * str.and(a, b, ...): text of every language its texts hold at once, their intersection. Its patterns are each text's
 * in order, each held to PostgreSQL's limits alone, and its domain checks `VALUE ~ p AND VALUE ~ q ...`, one test for
 * each pattern; its host type is the texts' host types intersected; its byte bound is the tightest of its texts'. Two
 * conjunctions of one language, or a conjunction and a pattern of its language, share one domain wherever the text
 * analysis proves the language, and a conjunction no text matches is refused there.
 */
const andConstructor = <
	const M extends readonly [RegexText<string>, ...ReadonlyArray<RegexText<string>>]
>(
	...members: M
): RegexText<JoinedHost<M>> => {
	const given: ReadonlyArray<unknown> = members
	if (!isNonEmpty(given)) {
		return refuseAnd(0, "at least one text to join")
	}
	const texts = mapNonEmpty(given, admitMember)
	const patterns = flatMapNonEmpty(texts, (t) => t.patterns)
	const [bound, ...bounds] = texts.flatMap((t) => (t.bytes === undefined ? [] : [t.bytes]))
	return textField<JoinedHost<M>>(
		patterns,
		textLookup(patterns),
		bound === undefined ? undefined : bounds.reduce((tightest, b) => Math.min(tightest, b), bound)
	)
}

/** The regex is mandatory and the flags default to "u". Both are literals. */
const regexConstructor = <
	const S extends string,
	const A extends RegexFlagsArguments = readonly []
>(
	source: RegexValidate<S, RegexFlagsOf<A>>,
	...flags: A & RegexFlagsRefusal<A>
): RegexText<RegexInfer<S, RegexFlagsOf<A>>> =>
	regexField<RegexInfer<S, RegexFlagsOf<A>>>(source, flags)

interface Str {
	readonly regex: typeof regexConstructor
	readonly and: typeof andConstructor
	readonly bytes: typeof bytesConstructor
}

/** Bare `str` is not a field descriptor: it has no host or SQL type, only the constructors. */
export const str: Str = Object.freeze({
	regex: regexConstructor,
	and: andConstructor,
	bytes: bytesConstructor
})
