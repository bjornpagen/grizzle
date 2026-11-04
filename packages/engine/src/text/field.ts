import type { regex } from "arkregex"
import { textColumn } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { registerTextDescriptor } from "#compiler/scalar/registry.ts"
import { isRegexFlags, type RegexFlags } from "#compiler/text/parse.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import type { TextField } from "#compiler/types/fields/field.ts"
import type { RewriteSource } from "#compiler/types/fields/source.ts"

/** True when T is a union of two or more members. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never

/**
 * Typed schema authoring requires a literal source and literal flags: the descriptor carries them as its
 * pattern, and the host type is inferred from exactly that pattern. A source typed `string`, a template with a hole
 * (`^${string}$`, `${number}`), or a union of sources is no single literal, so it is refused rather than accepted with
 * a host type no declared pattern backs. Each refusal is a message type that no argument of that type satisfies.
 */
type SourceRefusal<S extends string> = string extends S
	? "str.regex needs a literal source in typed schema authoring; this source is typed string"
	: Record<never, never> extends Record<S, 1>
		? "str.regex needs a literal source in typed schema authoring; this source is a template with a hole"
		: true extends IsUnion<S>
			? "str.regex needs a literal source in typed schema authoring; this source is a union of sources"
			: undefined

/**
 * ArkRegex's type-level pattern check on the rewritten source (types/fields/source.ts): S itself when it parses,
 * otherwise S branded with ArkRegex's error message, which no string satisfies, so the message shows in the diagnostic.
 * A source too long to scan is left to the compiler's grammar check. A source that is no single literal is refused
 * first (SourceRefusal). The result is always S or a subtype of it, so the runtime source has the source type S.
 */
declare const regexRefusal: unique symbol
interface Refused<out Message> {
	readonly [regexRefusal]: Message
}

type RegexRefusal<S extends string, F extends RegexFlags> =
	SourceRefusal<S> extends infer Refusal extends string
		? Refused<Refusal>
		: RewriteSource<S> extends readonly [infer N extends string, boolean]
			? regex.validate<N, F> extends N
				? unknown
				: Refused<regex.validate<N, F>>
			: unknown
export type RegexValidate<S extends string, F extends RegexFlags> = S & RegexRefusal<S, F>

/**
 * The flags argument: F itself when it is one literal, "u" or "su"; a union such as a value typed `"u" | "su"` is no
 * literal flags argument and is refused with a message type neither flag satisfies.
 */
export type RegexFlagsValidate<F extends RegexFlags> =
	true extends IsUnion<F>
		? 'str.regex needs literal flags in typed schema authoring: "u" or "su"'
		: F

/**
 * ArkRegex writes a member it infers as string as a `${string}` placeholder and concatenates placeholders as they come,
 * but TypeScript makes a placeholder followed by another match exactly one code point: `(.|)a` infers
 * `${string}${string}a${string}`, which refuses "a". The host type is the inferred one with every run of adjacent
 * placeholders written as one, so it holds no two adjacent placeholders: `${number}` for a run of `${number}` alone,
 * which ArkRegex writes only for digits, and `${string}` for any other. Either holds every string the run stands for.
 *
 * A run read so far: none, `${number}` alone, or one holding any other placeholder.
 */
type PlaceholderRun = "none" | "number" | "string"

/** The placeholder a run is written as. */
type RunPlaceholder<R extends PlaceholderRun> = R extends "string"
	? string
	: R extends "number"
		? `${number}`
		: ""

/**
 * The text written so far and the open run, after one more token: a placeholder joins the run; a code unit closes it.
 */
type ReadToken<S extends readonly [string, PlaceholderRun], Token extends string> =
	Record<never, never> extends Record<Token, 1>
		? [
				S[0],
				S[1] extends "string"
					? "string"
					: string extends Token
						? "string"
						: `${number}` extends Token
							? "number"
							: "string"
			]
		: [`${S[0]}${RunPlaceholder<S[1]>}${Token}`, "none"]

/**
 * One member rebuilt: a member with no placeholder left is appended whole; otherwise eight tokens are read at a time
 * while eight remain, each a code unit or a placeholder, so a long text costs an eighth of its length in steps.
 */
type Rebuilt<T extends string, Out extends string, R extends PlaceholderRun> = string extends T
	? `${Out}${string}`
	: Record<never, never> extends Record<T, 1>
		? T extends `${infer A}${infer B}${infer C}${infer D}${infer E}${infer F}${infer G}${infer H}${infer Rest}`
			? ReadToken<
					ReadToken<
						ReadToken<
							ReadToken<ReadToken<ReadToken<ReadToken<ReadToken<[Out, R], A>, B>, C>, D>, E>,
							F
						>,
						G
					>,
					H
				> extends [infer Read extends string, infer Open extends PlaceholderRun]
				? Rebuilt<Rest, Read, Open>
				: never
			: T extends `${infer A}${infer Rest}`
				? ReadToken<[Out, R], A> extends [
						infer Read extends string,
						infer Open extends PlaceholderRun
					]
					? Rebuilt<Rest, Read, Open>
					: never
				: `${Out}${RunPlaceholder<R>}`
		: `${Out}${RunPlaceholder<R>}${T}`

/** Every member of an inferred host type rebuilt. */
type OnePlaceholderPerRun<T extends string> = T extends string ? Rebuilt<T, "", "none"> : never

/**
 * The inferred host type of a pattern's members: ArkRegex's inference on the rewritten source with one placeholder per
 * run, or string where that would not be sound or the source is too long to scan (types/fields/source.ts).
 */
export type RegexInfer<S extends string, F extends RegexFlags> =
	RewriteSource<S> extends readonly [infer N extends string, infer Widen extends boolean]
		? Widen extends true
			? string
			: OnePlaceholderPerRun<regex.infer<N, F>>
		: string

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
 * any pattern meets. `desc` is the field's Description (ir/desc.ts FieldDesc), which schema compilation consumes.
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
	return registerTextDescriptor(
		Object.freeze({
			...builtMark,
			sql: "text",
			pattern: Object.freeze({ source, flags: resolved }),
			desc: Object.freeze({ kind: "text", source, flags: resolved }),
			column: textColumn<Host>()
		}),
		textLookup
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
}

/** Bare `str` is not a field descriptor: it has no host or SQL type, only the constructor. */
export const str: Str = Object.freeze({ regex: regexConstructor })
