/**
 * templates. The ArkRegex inference matrix.
 *
 * One row per pattern shape. Each row states three things:
 *
 * - `host`: what typed authoring makes of the call: the diagnostic code with which the call site is refused, the
 *   widened host type `string` where the scan's rules widen (packages/engine/src/types/fields/source.ts), or an inferred host
 *   type, whose spelling is ArkRegex's and no contract: what is asserted of it is what must and must not compile;
 * - `admission`: what the compiler's grammar check decides, which, not the inference, decides admission;
 * - `members` and `outside`: values ECMAScript accepts, which must inhabit the host type, and values
 *   outside the host type, which ECMAScript must reject too, so that every refusal by the type is sound.
 *
 * program.ts turns the rows into one generated program, the type-test batch typechecks it, and matrix.test.ts checks
 * the rest at runtime with the development oracle (ECMAScript's RegExp, which never appears under src/)
 * and the compiler's own NFA.
 */
import { Array as Arr, Formatter, String as Str } from "effect"
export type Admission =
	| "admitted"
	| "MalformedDescription"
	| "UnsupportedOperation"
	| "ResourceBound"

export type Host =
	| { readonly kind: "refused"; readonly refused: "TS2345" | "TS2589"; readonly reason: string }
	| { readonly kind: "widened" }
	| { readonly kind: "inferred" }

export type Category =
	| "literal"
	| "template"
	| "widening"
	| "length"
	| "malformed"
	| "flags"
	| "outsideFragment"
	| "escapes"
	| "nonLiteral"

/**
 * How a row calls str.regex: with its source and flags written as literals, or (a nonLiteral row) with arguments whose
 * types it declares: the declarations it reads, as TypeScript text, and its argument list. `v` is the row's own
 * variable prefix, which keeps the declarations unique in the generated program.
 */
export type Call =
	| { readonly kind: "literal" }
	| {
			readonly kind: "declared"
			readonly declarations: (v: string) => ReadonlyArray<string>
			readonly args: (v: string) => string
	  }

export interface Row {
	readonly name: string
	readonly category: Category
	/** For a nonLiteral row, the source and flags a JavaScript caller holds at runtime in the declared variables. */
	readonly source: string
	/** A refused flag is any other string; the matrix spells it as written. */
	readonly flags: string
	readonly call: Call
	readonly host: Host
	readonly admission: Admission
	/** None for a refused call, which has no host type. */
	readonly members: ReadonlyArray<string>
	readonly outside: ReadonlyArray<string>
}

/** A long literal alternation: finite, but longer than the typed-authoring scan budget (source.ts, Budget = 40). */
const greek = "^(?:alpha|beta|gamma|delta|epsilon|zeta|eta)$"
/**
 * A 510-code-point literal: at the compiler's fixed regex node budget (512), far past
 * the scan.
 */
const longLiteral = `^${Str.repeat(254)("ab")}$`
/**
 * Past the node budget: the compiler refuses it with ResourceBound, and the type still widens
 * to string without exhausting the checker.
 */
const overBudget = `^${Str.repeat(256)("ab")}$`
/** A long malformed source: the scan does not reach ArkRegex, and the compiler alone refuses it. */
const longMalformed = `^(${Str.repeat(60)("a")}$`

export const rows: ReadonlyArray<Row> = [
	{
		name: "answer",
		category: "literal",
		source: "^(yes|no)$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["yes", "no"],
		outside: ["maybe", "yesno", ""]
	},
	{
		name: "state",
		category: "literal",
		source: "^(?:draft|published)$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["draft", "published"],
		outside: ["Draft", "draft "]
	},
	{
		name: "status",
		category: "literal",
		source: "^(wanted|leased|done)$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["wanted", "leased", "done"],
		outside: ["undone"]
	},
	{
		name: "single literal",
		category: "literal",
		source: "^abc$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["abc"],
		outside: ["ab", "abcd"]
	},
	{
		name: "optional",
		category: "literal",
		source: "^colou?r$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["color", "colour"],
		outside: ["colouur"]
	},
	{
		name: "class of literals",
		category: "literal",
		source: "^[abc]$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["a", "b", "c"],
		outside: ["d", "ab"]
	},
	{
		name: "product of alternatives",
		category: "literal",
		source: "^(?:x|y)(?:1|2)$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["x1", "x2", "y1", "y2"],
		outside: ["x3", "xy"]
	},
	{
		name: "exact repetition",
		category: "literal",
		source: "^a{3}$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["aaa"],
		outside: ["aa", "aaaa"]
	},
	{
		name: "bounded repetition",
		category: "literal",
		source: "^a{1,2}$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["a", "aa"],
		outside: ["", "aaa"]
	},
	{
		name: "empty string only",
		category: "literal",
		source: "^$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: [""],
		outside: ["a"]
	},
	{
		name: "escaped syntax character",
		category: "literal",
		source: "^\\.$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["."],
		outside: ["a"]
	},
	{
		name: "literal union under su",
		category: "literal",
		source: "^(a|b)$",
		flags: "su",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["a", "b"],
		outside: ["ab"]
	},
	{
		name: "class dash escape",
		category: "literal",
		source: "^[\\-a]$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["-", "a"],
		outside: ["b"]
	},

	{
		name: "version with +",
		category: "template",
		source: "^(\\d+)\\.(\\d+)\\.(\\d+)$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["1.2.3", "10.0.255"],
		/** `${number}` accepts every numeric spelling, "3." and "+1" among them, so neither is outside. */
		outside: ["1.2", "..."]
	},
	{
		/**
		 * Not `${number}.${number}.${number}`: \d* admits the empty string, and both ArkRegex and typed authoring
		 * infer the eight templates that cover each empty component.
		 */
		name: "version with *",
		category: "template",
		source: "^(\\d*)\\.(\\d*)\\.(\\d*)$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["1.2.3", "..", "1..", ".2.3"],
		outside: ["1.2", "..."]
	},
	{
		name: "ein",
		category: "template",
		source: "^\\d{2}-\\d{7}$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["12-3456789"],
		outside: ["12_3456789", "123456789"]
	},
	{
		name: "prefixed digits",
		category: "template",
		source: "^v\\d+$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["v1", "v2026"],
		outside: ["v", "w1"]
	},
	{
		name: "signed digits",
		category: "template",
		source: "^-?\\d+$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["0", "-12"],
		outside: ["1-", "-"]
	},
	{
		name: "digit range",
		category: "template",
		source: "^[0-9]+$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["7", "007"],
		outside: ["x"]
	},
	{
		name: "unanchored literal is a substring predicate",
		category: "template",
		source: "draft",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["draft", "a draft b"],
		outside: ["drat"]
	},
	{
		name: "start anchor only",
		category: "template",
		source: "^draft",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["draft", "drafts"],
		outside: ["a draft"]
	},
	{
		name: "end anchor only",
		category: "template",
		source: "draft$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["draft", "redraft"],
		outside: ["drafts"]
	},
	{
		name: "dot under su",
		category: "template",
		source: "^a.c$",
		flags: "su",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["abc", "a\nc", "a\u{1f600}c"],
		outside: ["ab"]
	},
	{
		name: "dot under u",
		category: "template",
		source: "^a.c$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["abc", "a\u{1f600}c"],
		outside: ["bc"]
	},
	{
		name: "unbounded literal repetition",
		category: "template",
		source: "^a+$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["a", "aaaa"],
		outside: ["", "b"]
	},
	{
		name: "starred group",
		category: "template",
		source: "^(?:ab)*$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["", "ab", "abab"],
		outside: ["ba"]
	},
	{
		name: "class lower bound",
		category: "template",
		source: "^[ab]{2,}$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["ab", "bab"],
		outside: ["a", "ca"]
	},
	{
		name: "bounded wide class before a literal",
		category: "template",
		source: "^[a-z]{1,32}w$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["aw", "zzzw"],
		outside: ["wa"]
	},

	{
		name: "slug",
		category: "widening",
		source: "^[a-z][a-z0-9-]*$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["a", "a-1"],
		outside: []
	},
	{
		name: "wildcard",
		category: "widening",
		source: "^.*$",
		flags: "su",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["", "a\nb", "\u2028"],
		outside: []
	},
	{
		name: "empty pattern",
		category: "widening",
		source: "",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["", "anything"],
		outside: []
	},
	{
		name: "word shorthand",
		category: "widening",
		source: "^\\w+$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["a_1"],
		outside: []
	},
	{
		name: "negated class",
		category: "widening",
		source: "^[^a]$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["b", "\u{1f600}"],
		outside: []
	},
	{
		name: "range between non-digits",
		category: "widening",
		source: "^[a-c]{2}$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["ab", "cc"],
		outside: []
	},
	{
		/** ArkRegex collapses the class union to `${number}`, which excludes "_1"; typed authoring widens. */
		name: "digits mixed with a literal in a class",
		category: "widening",
		source: "^[\\d_]{1,3}$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["_1", "___", "12"],
		outside: []
	},
	{
		/**
		 * ArkRegex refuses an anchor away from the edges; the admitted grammar accepts it and typed authoring widens.
		 */
		name: "anchors in the middle",
		category: "widening",
		source: "$^",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: [""],
		outside: []
	},
	{
		name: "end anchor inside a group",
		category: "widening",
		source: "^(?:a$)?b",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["b", "bx"],
		outside: []
	},

	{
		name: "finite alternation at the scan budget",
		category: "length",
		source: "^(?:aaaa|bbbb|cccc|dddd|eeee|ffff|gggg)$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["aaaa", "gggg"],
		outside: ["aaa", "hhhh"]
	},
	{
		name: "finite alternation one past the scan budget",
		category: "length",
		source: "^(?:aaaa|bbbb|cccc|dddd|eeee|ffff|ggggg)$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["aaaa", "ggggg"],
		outside: []
	},
	{
		name: "finite alternation past the scan budget",
		category: "length",
		source: greek,
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["alpha", "eta"],
		outside: []
	},
	{
		name: "a source at the node budget",
		category: "length",
		source: longLiteral,
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: [Str.repeat(254)("ab")],
		outside: []
	},
	{
		name: "a source over the node budget",
		category: "length",
		source: overBudget,
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "ResourceBound",
		members: [],
		outside: []
	},
	{
		name: "malformed past the scan budget",
		category: "length",
		source: longMalformed,
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},

	{
		name: "tab escape",
		category: "escapes",
		source: "^\\t$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["\t"],
		outside: ["t"]
	},
	{
		name: "hex escapes",
		category: "escapes",
		source: "^\\x41\\x2E$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["A."],
		outside: ["A,"]
	},
	{
		name: "unicode escape widens",
		category: "escapes",
		source: "^\\u00e9$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "admitted",
		members: ["\u00e9"],
		outside: []
	},

	{
		name: "unterminated group",
		category: "malformed",
		source: "^(ab$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "refused", refused: "TS2345", reason: "an unterminated group" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		name: "unterminated class",
		category: "malformed",
		source: "^[a$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "refused", refused: "TS2345", reason: "an unterminated class" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		name: "unmatched close",
		category: "malformed",
		source: "a)",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "refused", refused: "TS2345", reason: "an unmatched )" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		name: "nothing to repeat",
		category: "malformed",
		source: "*a",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "refused", refused: "TS2345", reason: "a quantifier without a preceding token" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		name: "doubled quantifier",
		category: "malformed",
		source: "a**",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "refused", refused: "TS2345", reason: "a quantifier on a quantifier" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		name: "lone plus",
		category: "malformed",
		source: "+",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "refused", refused: "TS2345", reason: "a quantifier without a preceding token" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		name: "trailing backslash",
		category: "malformed",
		source: "\\",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "refused", refused: "TS2345", reason: "a source ending in a backslash" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		name: "incomplete group",
		category: "malformed",
		source: "(?",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "refused", refused: "TS2345", reason: "an incomplete group" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		/**
		 * Under the u flag a reference to a missing group is an ECMAScript syntax error ("Invalid escape"), so the
		 * reason is MalformedDescription, not the UnsupportedOperation of a well-formed backreference.
		 */
		name: "missing group reference",
		category: "malformed",
		source: "^(a)\\2$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "refused", refused: "TS2345", reason: "a backreference to a missing group" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		/** ECMAScript: "Invalid named capture referenced", a syntax error, so MalformedDescription. */
		name: "missing named group reference",
		category: "malformed",
		source: "(?<n>a)\\k<m>",
		flags: "u",
		call: { kind: "literal" },
		host: {
			kind: "refused",
			refused: "TS2345",
			reason: "a named backreference to a missing group"
		},
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		/**
		 * ArkRegex 0.0.13 recurses without bound on a reversed quantifier range, so the refusal is the checker's depth
		 * limit rather than a validate message; the call is still refused.
		 */
		name: "reversed quantifier bounds",
		category: "malformed",
		source: "a{2,1}",
		flags: "u",
		call: { kind: "literal" },
		host: {
			kind: "refused",
			refused: "TS2589",
			reason: "ArkRegex exhausts the instantiation depth on a reversed range"
		},
		admission: "MalformedDescription",
		members: [],
		outside: []
	},
	{
		name: "NUL escape",
		category: "malformed",
		source: "^\\0$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "refused", refused: "TS2345", reason: "\\0 is NUL" },
		admission: "UnsupportedOperation",
		members: [],
		outside: []
	},
	{
		/** ArkRegex accepts a reversed class range; the compiler's grammar check refuses it. */
		name: "reversed class range",
		category: "malformed",
		source: "^[z-a]$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "MalformedDescription",
		members: [],
		outside: []
	},

	{
		name: "lookbehind",
		category: "outsideFragment",
		source: "(?<=a)b",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "UnsupportedOperation",
		members: [],
		outside: []
	},
	{
		name: "backreference",
		category: "outsideFragment",
		source: "^(a)\\1$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "UnsupportedOperation",
		members: [],
		outside: []
	},
	{
		name: "property escape",
		category: "outsideFragment",
		source: "^\\p{L}$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "widened" },
		admission: "UnsupportedOperation",
		members: [],
		outside: []
	},
	{
		name: "word boundary",
		category: "outsideFragment",
		source: "\\bword\\b",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "UnsupportedOperation",
		members: [],
		outside: []
	},
	{
		name: "lazy quantifier",
		category: "outsideFragment",
		source: "^a*?$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "UnsupportedOperation",
		members: [],
		outside: []
	},
	{
		/** ArkRegex infers only three of \s's members; the shorthand is refused, so no field ever carries this type. */
		name: "space shorthand",
		category: "outsideFragment",
		source: "^\\s$",
		flags: "u",
		call: { kind: "literal" },
		host: { kind: "inferred" },
		admission: "UnsupportedOperation",
		members: [],
		outside: []
	},

	...Arr.map(
		["i", "m", "g", "y", "d", "v", "s", "us", "", "iu", "sui", "gu", "uu", "U", "uv", "sus"],
		(flags): Row => ({
			name: `flags ${Formatter.format(flags)}`,
			category: "flags",
			source: "^ok$",
			flags,
			call: { kind: "literal" },
			host: {
				kind: "refused",
				refused: "TS2345",
				reason: `the ${Formatter.format(flags)} flags are not admitted`
			},
			admission: "MalformedDescription",
			members: [],
			outside: []
		})
	),
	...Arr.map(
		[
			["(", "i"],
			["a{2,1}", "i"],
			["(?=a)b", "us"]
		] as const,
		([source, flags]): Row => ({
			name: `flags ${Formatter.format(flags)} over ${Formatter.format(source)}`,
			category: "flags",
			source,
			flags,
			call: { kind: "literal" },
			host: {
				kind: "refused",
				refused: "TS2345",
				reason: `the ${Formatter.format(flags)} flags are not admitted`
			},
			admission: "MalformedDescription",
			members: [],
			outside: []
		})
	),

	{
		name: "source typed string",
		category: "nonLiteral",
		source: "^a$",
		flags: "u",
		call: {
			kind: "declared",
			declarations: (v) => [`declare const ${v}s: string`],
			args: (v) => `${v}s`
		},
		host: { kind: "refused", refused: "TS2345", reason: "a source typed string is no literal" },
		admission: "admitted",
		members: [],
		outside: []
	},
	{
		name: "source template with a string hole",
		category: "nonLiteral",
		source: "^a$",
		flags: "u",
		call: {
			kind: "declared",
			declarations: (v) => [`declare const ${v}s: string`],
			args: (v) => `\`^\${${v}s}$\``
		},
		host: {
			kind: "refused",
			refused: "TS2345",
			reason: "a template with a string hole is no literal"
		},
		admission: "admitted",
		members: [],
		outside: []
	},
	{
		name: "source template with a number hole",
		category: "nonLiteral",
		source: "^a1$",
		flags: "u",
		call: {
			kind: "declared",
			declarations: (v) => [`declare const ${v}n: number`],
			args: (v) => `\`^a\${${v}n}$\``
		},
		host: {
			kind: "refused",
			refused: "TS2345",
			reason: "a template with a number hole is no literal"
		},
		admission: "admitted",
		members: [],
		outside: []
	},
	{
		name: "source union",
		category: "nonLiteral",
		source: "^a$",
		flags: "u",
		call: {
			kind: "declared",
			declarations: (v) => [`declare const ${v}s: "^a$" | "^b$"`],
			args: (v) => `${v}s`
		},
		host: { kind: "refused", refused: "TS2345", reason: "a union of sources is no single literal" },
		admission: "admitted",
		members: [],
		outside: []
	},
	{
		name: "flags typed u or su",
		category: "nonLiteral",
		source: "^a.c$",
		flags: "su",
		call: {
			kind: "declared",
			declarations: (v) => [`declare const ${v}f: "u" | "su"`],
			args: (v) => `"^a.c$", ${v}f`
		},
		host: { kind: "refused", refused: "TS2345", reason: 'flags typed "u" | "su" are no literal' },
		admission: "admitted",
		members: [],
		outside: []
	},
	{
		name: "flags typed string",
		category: "nonLiteral",
		source: "^a$",
		flags: "u",
		call: {
			kind: "declared",
			declarations: (v) => [`declare const ${v}f: string`],
			args: (v) => `"^a$", ${v}f`
		},
		host: { kind: "refused", refused: "TS2345", reason: "flags typed string are no literal" },
		admission: "admitted",
		members: [],
		outside: []
	},
	{
		name: "literal source through a variable",
		category: "nonLiteral",
		source: "^(a|b)$",
		flags: "u",
		call: {
			kind: "declared",
			declarations: (v) => [`declare const ${v}s: "^(a|b)$"`],
			args: (v) => `${v}s`
		},
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["a", "b"],
		outside: ["c", "ab"]
	},
	{
		name: "literal flags through a variable",
		category: "nonLiteral",
		source: "^a.c$",
		flags: "su",
		call: {
			kind: "declared",
			declarations: (v) => [`declare const ${v}f: "su"`],
			args: (v) => `"^a.c$", ${v}f`
		},
		host: { kind: "inferred" },
		admission: "admitted",
		members: ["abc", "a\nc"],
		outside: ["ab"]
	}
]
