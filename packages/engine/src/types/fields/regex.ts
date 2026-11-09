import type { regex } from "arkregex"
import type { RegexFlags } from "#compiler/scalar/regex/parse.ts"
import type {
	LanguageCount,
	Rejected,
	RewriteSource,
	ValidatedSource,
	ZeroWidthSpace
} from "#compiler/types/fields/source.ts"

/**
 * The type-level reading of a pattern's literal source, which str.regex (text/field.ts) and Compute.matches
 * (types/compute/compute.ts) share: ArkRegex's grammar check, refusing a source that is no single literal, and its
 * inference of the pattern's language.
 */

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
 * A source the scan rejects (a counted repetition's bounds out of order, a quantified anchor) is branded with the
 * scan's message, the compiler's refusal, before ArkRegex reads it.
 * A source too long to scan is left to the compiler's grammar check. A source that is no single literal is refused
 * first (SourceRefusal). The result is always S or a subtype of it, so the runtime source has the source type S.
 */
declare const regexRefusal: unique symbol
export interface Refused<out Message> {
	readonly [regexRefusal]: Message
}

type RegexRefusal<S extends string, F extends RegexFlags> =
	SourceRefusal<S> extends infer Refusal extends string
		? Refused<Refusal>
		: RewriteSource<S> extends infer Read
			? Read extends Rejected<infer Message>
				? Refused<Message>
				: Read extends readonly [infer N extends string, boolean]
					? ValidatedSource<N> extends infer V extends string
						? regex.validate<V, F> extends V
							? unknown
							: Refused<regex.validate<V, F>>
						: unknown
					: unknown
			: unknown
export type RegexValidate<S extends string, F extends RegexFlags> = S & RegexRefusal<S, F>

/**
 * A Compute.pattern source written as a JavaScript string: a literal source, checked as str.regex checks its own, or a
 * source typed string, which Compute.pattern admits where it is called (scalar/regex/admit.ts admitMatch).
 */
export type PatternValidate<S extends string> = string extends S ? S : RegexValidate<S, "u">

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
		: [Restored<Token, `${S[0]}${RunPlaceholder<S[1]>}`>, "none"]

/**
 * One member rebuilt: a member with no placeholder left is appended whole; otherwise eight tokens are read at a time
 * while eight remain, each a code unit or a placeholder, so a long text costs an eighth of its length in steps. Each
 * stand-in is written back as the zero-width space it stands for.
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
		: Restored<T, `${Out}${RunPlaceholder<R>}`>

/**
 * Out followed by a member's text with each stand-in written back as the zero-width space it stands for
 * (types/fields/source.ts), one step per stand-in.
 */
type Restored<
	T extends string,
	Out extends string
> = T extends `${infer Before}${ZeroWidthSpace["standIn"]}${infer After}`
	? Restored<After, `${Out}${Before}${ZeroWidthSpace["marker"]}`>
	: `${Out}${T}`

/** Every member of an inferred host type rebuilt. */
type OnePlaceholderPerRun<T extends string> = T extends string ? Rebuilt<T, "", "none"> : never

/**
 * The inferred host type of a pattern's members: ArkRegex's inference on the rewritten source with one placeholder per
 * run, or string where that would not be sound, the source is too long to scan, or its members are more than
 * TypeScript represents as one union (LanguageCount, types/fields/source.ts), the same field RegexText<string, S, F>.
 */
export type RegexInfer<S extends string, F extends RegexFlags> =
	RewriteSource<S> extends readonly [infer N extends string, infer Widen extends boolean]
		? Widen extends true
			? string
			: LanguageCount<N> extends "over"
				? string
				: OnePlaceholderPerRun<regex.infer<N, F>>
		: string
