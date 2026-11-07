import { textColumn } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { int4Max } from "#compiler/core/limits.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { isRegexFlags, type RegexFlags } from "#compiler/scalar/regex/parse.ts"
import {
	type DescriptorLanguage,
	registeredText,
	registerTextDescriptor
} from "#compiler/scalar/registry.ts"
import { textLookup, textLookupWithin } from "#compiler/text/refinement.ts"
import type { TextField } from "#compiler/types/fields/field.ts"
import type {
	Refused,
	RegexFlagsValidate,
	RegexInfer,
	RegexValidate
} from "#compiler/types/fields/regex.ts"

/**
 * str.regex: the one text field constructor.
 *
 * ArkRegex appears here only as a type: `regex.validate` checks the literal source at the type level and `regex.infer`
 * computes the host type, so `str.regex("^(yes|no)$")` is a field whose host type is "yes" | "no". The
 * import is `import type`, so no ArkRegex code, no RegExp and no matcher reaches the runtime. The runtime keeps only
 * the immutable literal source and flags; schema compilation checks the admitted grammar and lowers it
 * (refinement.ts), and PostgreSQL alone validates values.
 *
 * Inference is an overapproximation of membership: a narrow host type is not proof that a runtime string
 * matches, and a pattern ArkRegex cannot infer precisely widens, at worst to string. ArkRegex accepts constructs the
 * admitted grammar rejects (backreferences, lookarounds, property escapes); the grammar check, not the inference,
 * decides admission. `regex.as` assertions and RegExp objects are not accepted.
 *
 * A text field descriptor: its host type, its PostgreSQL base type, and its literal pattern, a TextField
 * (types/fields/field.ts) whose column is a pattern-refined text column (core/decoder.ts textColumn): a cell's text is
 * its value, a member of the pattern's language, which PostgreSQL's CHECK enforces and the host type overapproximates.
 * The host type is the field's language, which a JavaScript value at it is one of; its domain is text, which a term of
 * any pattern meets. `desc` states the pattern as written; schema compilation reads the field's Description from the
 * descriptor registry (scalar/registry.ts registerTextDescriptor), which carries the pattern's language as the text
 * analysis proved it once, when the descriptor was made.
 */
export interface RegexText<
	out Host extends string,
	out S extends string,
	out F extends RegexFlags
> extends TextField<Host, S, F> {
	readonly sql: "text"
	readonly desc: { readonly kind: "text"; readonly source: S; readonly flags: F }
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

/** The descriptor of a pattern, its language analyzed by `lookup`, which cuts it to a byte bound where it has one. */
const textField = <Host extends string, S extends string, F extends RegexFlags>(
	source: S,
	flags: F,
	lookup: DescriptorLanguage
): RegexText<Host, S, F> =>
	registerTextDescriptor(
		Object.freeze({
			...builtMark,
			sql: "text",
			pattern: Object.freeze({ source, flags }),
			desc: Object.freeze({ kind: "text", source, flags }),
			column: textColumn<Host>()
		}),
		lookup
	)

/**
 * The descriptor of an admitted source and flags arguments. Its host type is the one the caller names, its column's
 * claim. str.regex is this over literal arguments, naming the pattern's inferred language; a caller driving the
 * runtime path over sources known only at run time calls it directly.
 */
export const regexField = <Host extends string, S extends string, A extends RegexFlagsArguments>(
	source: S,
	flags: A
): RegexText<Host, S, RegexFlagsOf<A>> => {
	const first = firstFlags(flags)
	admitRegex(source, first)
	const resolved: RegexFlagsOf<A> = flagsOf[`${first}` as const]
	return textField<Host, S, RegexFlagsOf<A>>(source, resolved, textLookup)
}

/** A JavaScript caller's str.bytes arguments the types forbid: a malformed argument, thrown synchronously. */
const refuseBytes = (capability: string): never => {
	throw malformedDescription(captureLoc("str.bytes", []), capability)
}

/**
 * The admission core of str.bytes: a byte bound octet_length's integer result compares with, from 0 to int4's
 * greatest, and a text descriptor a builder made, str.regex's or str.bytes's; the bound the descriptor states, the
 * tighter of the two where the pattern is already bounded.
 */
const admitBytes = (bytes: unknown, pattern: unknown): number => {
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
	const registered = registeredText(pattern)
	if (registered === undefined) {
		return refuseBytes(
			"a text descriptor a builder made, str.regex(...), whose language the byte bound cuts"
		)
	}
	return registered.bytes === undefined ? bytes : Math.min(bytes, registered.bytes)
}

/**
 * str.bytes(N, pattern): text of `pattern`'s language of at most N UTF-8 bytes. The bound is a refinement as the
 * pattern is, not a type: the field's host type and domain are the pattern's, so it meets any text a pattern-refined
 * text meets. Its domain checks `octet_length(VALUE) <= N` before the pattern, one domain for each language and bound,
 * and a key reads N as its bytes exactly; a bound every value of the pattern already meets leaves the pattern's own
 * type. Text always carries a pattern, so the bound takes one: `str.bytes(N, str.regex("^.*$", "su"))` is any text of
 * at most N bytes.
 */
const bytesConstructor = <Host extends string, S extends string, F extends RegexFlags>(
	bytes: number,
	pattern: RegexText<Host, S, F>
): RegexText<Host, S, F> => {
	const octets = admitBytes(bytes, pattern)
	return textField<Host, S, F>(
		pattern.pattern.source,
		pattern.pattern.flags,
		textLookupWithin(octets)
	)
}

/** The regex is mandatory and the flags default to "u". Both are literals. */
const regexConstructor = <
	const S extends string,
	const A extends RegexFlagsArguments = readonly []
>(
	source: RegexValidate<S, RegexFlagsOf<A>>,
	...flags: A & RegexFlagsRefusal<A>
): RegexText<RegexInfer<S, RegexFlagsOf<A>>, S, RegexFlagsOf<A>> =>
	regexField<RegexInfer<S, RegexFlagsOf<A>>, S, A>(source, flags)

interface Str {
	readonly regex: typeof regexConstructor
	readonly bytes: typeof bytesConstructor
}

/** Bare `str` is not a field descriptor: it has no host or SQL type, only the constructors. */
export const str: Str = Object.freeze({ regex: regexConstructor, bytes: bytesConstructor })
