import {
	type RegexFlagsValidate,
	type RegexInfer,
	type RegexText,
	type RegexValidate,
	str
} from "#compiler/public/text.ts"
import type { Field, Infer, TextField } from "#compiler/types/fields/field.ts"
import type { Equals, Expect, IsAssignable, Not } from "#test/types/text/support.ts"

import { regex } from "arkregex"
/**
 * str.regex inference and refusals against the pinned arkregex 0.0.13.
 *
 * Every `// @ts-expect-error -- TSnnnn: reason` names the diagnostic its next line raises; regex.test.ts disarms the
 * directives and checks that exactly those codes appear on exactly those lines.
 *
 * What each shape infers, a member assigned and a value outside refused, is the inference matrix's
 * (test/types/regex/matrix.ts); these fixtures hold the typed API around it and the cases it has no row for.
 */
export const Answer = str.regex("^(yes|no)$")

/**
 * An optional or zero-minimum quantifier over a class that infers string admits the empty repetition (W-03): "." is a
 * value of \D?\. and "x" of \W{0,2}x.
 */
export const OptionalClass = str.regex("\\D?\\.", "u")
export const BoundedClass = str.regex("\\W{0,2}x", "u")
export type OptionalClassAdmitsDot = Expect<IsAssignable<".", Infer<typeof OptionalClass>>>
export type BoundedClassAdmitsX = Expect<IsAssignable<"x", Infer<typeof BoundedClass>>>

export const Slug = str.regex("^[a-z][a-z0-9-]*$")
export const Prose = str.regex("^.*$", "su")

/** The descriptor keeps its literal source and flags; the flags default to "u". */
export type AnswerPattern = Expect<
	Equals<(typeof Answer)["pattern"], { readonly source: "^(yes|no)$"; readonly flags: "u" }>
>
export type ProsePattern = Expect<Equals<(typeof Prose)["pattern"]["flags"], "su">>
export type AnswerDesc = Expect<
	Equals<
		(typeof Answer)["desc"],
		{ readonly kind: "text"; readonly source: "^(yes|no)$"; readonly flags: "u" }
	>
>

/** It is a TextField and a Field: text over its inferred host type. */
export type IsTextField = Expect<
	IsAssignable<typeof Answer, TextField<"yes" | "no", "^(yes|no)$", "u">>
>
export type IsField = Expect<IsAssignable<typeof Answer, Field<"yes" | "no", "text">>>
export type SqlIsText = Expect<Equals<(typeof Slug)["sql"], "text">>
/** Its host is no wider than inferred: a "yes" | "no" field is not a field of arbitrary text. */
export type NotWider = Expect<
	Not<IsAssignable<typeof Answer, TextField<"maybe", "^(yes|no)$", "u">>>
>

/** The aliases are ArkRegex's own. */
export type InferAlias = Expect<Equals<RegexInfer<"^(a|b)$", "u">, "a" | "b">>
export type ValidateAlias = Expect<Equals<RegexValidate<"^a$", "u">, "^a$">>
export type TextAlias = Expect<IsAssignable<typeof Answer, RegexText<string, string, "u">>>

/**
 * Every literal escape the admitted grammar accepts is accepted in typed authoring, though ArkRegex alone
 * refuses most of them, and its code point is inferred wherever the type system can compute one; a \u escape widens to
 * string (source.ts). The descriptor keeps the source as written.
 */
export const Tab = str.regex("^\\t$")
export const Newline = str.regex("^\\n$")
export const VerticalTab = str.regex("^\\v$")
export const FormFeed = str.regex("^\\f$")
export const Return = str.regex("^\\r$")
export const Caret = str.regex("^\\cA\\cz$")
export const Hex = str.regex("^\\x41\\x2E\\x2a$")
export const Braced = str.regex("^\\u{1F600}$")
export const Pair = str.regex("^\\uD83D\\uDE00$")
export const Slash = str.regex("^a\\/b$")
export const Backspace = str.regex("^[\\b]$")
export const ClassDash = str.regex("^[\\-a]$")
export const ClassHex = str.regex("^[\\x5D\\x2d\\x5c]$")
export const UnicodeRange = str.regex("^[\\u0041-\\u{5A}]+$")
export type TabHost = Expect<Equals<Infer<typeof Tab>, "\t">>
export type NewlineHost = Expect<Equals<Infer<typeof Newline>, "\n">>
export type VerticalTabHost = Expect<Equals<Infer<typeof VerticalTab>, "\v">>
export type FormFeedHost = Expect<Equals<Infer<typeof FormFeed>, "\f">>
export type ReturnHost = Expect<Equals<Infer<typeof Return>, "\r">>
export type CaretHost = Expect<Equals<Infer<typeof Caret>, "\u0001\u001A">>
export type HexHost = Expect<Equals<Infer<typeof Hex>, "A.*">>
export type BracedHost = Expect<Equals<Infer<typeof Braced>, string>>
export type PairHost = Expect<Equals<Infer<typeof Pair>, string>>
export type SlashHost = Expect<Equals<Infer<typeof Slash>, "a/b">>
export type BackspaceHost = Expect<Equals<Infer<typeof Backspace>, "\b">>
export type ClassDashHost = Expect<Equals<Infer<typeof ClassDash>, "-" | "a">>
export type ClassHexHost = Expect<Equals<Infer<typeof ClassHex>, "]" | "-" | "\\">>
export type UnicodeRangeHost = Expect<Equals<Infer<typeof UnicodeRange>, string>>
export type TabSource = Expect<Equals<(typeof Tab)["pattern"]["source"], "^\\t$">>

/**
 * Every value a pattern accepts lies in its inferred host type, where ArkRegex alone infers a type that
 * excludes accepted values: a quantified group holding \d and [\b] (source.ts); the matrix holds a quantified class
 * mixing \d with other members and anchors away from the edges, and test/types/text/regex.test.ts checks the same
 * containment on generated patterns and their members.
 */
export const OptionalDigits = str.regex("^(?:\\d?){2}$")
export const DigitOrA = str.regex("^(?:a|\\d)+$")
export const noDigits: Infer<typeof OptionalDigits> = ""
export const digitThenA: Infer<typeof DigitOrA> = "1a"
export const backspace: Infer<typeof Backspace> = "\b"
/** A digit-only repetition keeps a host type narrower than string: a member compiles, letters do not. */
export const Digits = str.regex("^[0-9]{2}\\d+$")
export const threeDigits: Infer<typeof Digits> = "123"
// @ts-expect-error -- TS2322: letters are no digits.
export const letters: Infer<typeof Digits> = "abc"

/** Source strings only: a RegExp object is not a source. */
// @ts-expect-error -- TS2345: a RegExp is not a string source.
export const regexpObject = str.regex(regex("^a$", "u"))

/**
 * Explicit flags are kept in the descriptor. Typed authoring refuses a source or flags that are no literal (the matrix's
 * nonLiteral rows); the refusals are the exported validators' own verdicts.
 */
export const ExplicitSU = str.regex("^(a|b)$", "su")
export type ExplicitSUFlags = Expect<Equals<(typeof ExplicitSU)["pattern"]["flags"], "su">>
export type WidenedRefused = Expect<Not<IsAssignable<string, RegexValidate<string, "u">>>>
export type FlagsUnionRefused = Expect<
	Not<IsAssignable<"u" | "su", RegexFlagsValidate<"u" | "su">>>
>
export type FlagsLiteralKept = Expect<Equals<RegexFlagsValidate<"su">, "su">>

/** Bare `str` is not a field descriptor. */
export type StrIsNoField = Expect<Not<IsAssignable<typeof str, Field<unknown, "text">>>>
