import { regex } from "arkregex"
import { Array as Arr, Option, Record, Schema, String as Str } from "effect"

/**
 * The column limit of every printed file.
 */
export const lineWidth = 100

/**
 * A JavaScript identifier name that needs no quoting as an object key.
 */
export const identifierPattern = regex("^[A-Za-z_$][A-Za-z0-9_$]*$", "u")

/**
 * Code points never left raw in a string literal (R10): controls, format characters (bidi controls
 * included), U+2028, U+2029 and lone surrogates.
 */
const unsafePattern = regex("^[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}]", "u")

/**
 * The code points a string literal writes as a short escape, each with its escape.
 */
const shortEscapes: Readonly<Record<string, string>> = {
	"\b": "\\b",
	"\t": "\\t",
	"\n": "\\n",
	"\f": "\\f",
	"\r": "\\r"
}

const unitEscape = (unit: number): string =>
	`\\u${Str.padStart(4, "0")(Str.toUpperCase(unit.toString(16)))}`

/**
 * The UTF-16 code units of one code point: two surrogates outside the BMP, else one.
 */
const codeUnits = (char: string): ReadonlyArray<number> =>
	Arr.getSomes(Arr.makeBy(Str.length(char), (index) => Str.charCodeAt(char, index)))

/**
 * One escape per UTF-16 code unit: a code point outside the BMP becomes its two surrogates.
 */
const unitEscapes = (char: string): string => Arr.join(Arr.map(codeUnits(char), unitEscape), "")

const count = (text: string, char: string): number => Str.split(text, char).length - 1

/**
 * One code point of a string literal quoted with `quote`, escaped as `docs/printer.md` Strings says;
 * `asciiOnly` escapes every code unit above U+007E as well.
 */
const escaped = (char: string, quote: string, asciiOnly: boolean): string => {
	if (char === "\\" || char === quote) {
		return `\\${char}`
	}

	return Option.match(Record.get(shortEscapes, char), {
		onNone: () =>
			unsafePattern.test(char) || (asciiOnly && char > "~") ? unitEscapes(char) : char,
		onSome: (short) => short
	})
}

const literal = (value: string, asciiOnly: boolean): string => {
	const quote = count(value, '"') > count(value, "'") ? "'" : '"'
	const body = Arr.join(
		Arr.map(Arr.fromIterable(value), (char) => escaped(char, quote, asciiOnly)),
		""
	)

	return `${quote}${body}${quote}`
}

/**
 * Prints a string literal: `JSON.stringify` escapes, the formatter's quote choice, and `\uXXXX`
 * for controls, format characters, U+2028, U+2029 and lone surrogates. Printable non-ASCII stays
 * literal (Mind ruling R10).
 */
export const stringLiteral = (value: string): string => literal(value, false)

/**
 * Prints a string literal with every code unit above U+007E escaped, so the formatter never reads
 * it as an identifier name. Used for quoted object keys.
 */
const asciiStringLiteral = (value: string): string => literal(value, true)

/**
 * One space between words; printable ASCII without * _ ` # < > [ ] { } | \ @ ~; no word starts
 * with -, + or a digit.
 */
const jsDocPattern = regex(
	"^[A-Z][!\"$%&'()+,\\-./0-9:;=?A-Z^a-z]*(?: [!\"$%&'(),./:;=?A-Z^a-z][!\"$%&'()+,\\-./0-9:;=?A-Z^a-z]*)*$",
	"u"
)

/**
 * Generator-owned JSDoc text from a fixed template (`docs/printer.md` JSDoc). Spec prose never
 * decodes to it.
 */
export const JsDocText = Schema.String.pipe(
	Schema.check(Schema.isPattern(jsDocPattern)),
	Schema.brand("JsDocText")
)

/**
 * Prints the JSDoc block for a top-level statement: one paragraph, filled greedily to column 100.
 */
export const jsDoc = (text: typeof JsDocText.Type): string => {
	const lines: string[] = []
	let current = ""
	for (const word of Str.split(text, " ")) {
		if (current === "") {
			current = word
		} else if (` * ${current} ${word}`.length <= lineWidth) {
			current = `${current} ${word}`
		} else {
			lines.push(current)
			current = word
		}
	}

	lines.push(current)

	return Arr.join(["/**", ...Arr.map(lines, (line) => ` * ${line}`), " */"], "\n")
}

/**
 * oxlint reads the cooked value of a literal, so no escape hides `${...}` from
 * `no-template-curly-in-string`; the statement is fenced with a disable range instead.
 */
const templateCurlyPattern = regex("\\$\\{[^]*\\}", "u")

const templateCurlyRule = "no-template-curly-in-string"

/**
 * Fences a printed statement that holds a `${...}` string literal in a disable/enable range for
 * `no-template-curly-in-string`; any other statement is returned as it is.
 */
export const guardTemplateCurly = (statement: string): string =>
	templateCurlyPattern.test(statement)
		? Arr.join(
				[
					`/* oxlint-disable ${templateCurlyRule} -- a spec string holds a template placeholder */`,
					statement,
					`/* oxlint-enable ${templateCurlyRule} */`
				],
				"\n"
			)
		: statement

/**
 * Prints an object key: bare when it is an identifier name, quoted (ASCII-escaped) otherwise, and
 * computed for `__proto__` so it stays an own property.
 */
export const keyText = (key: string): string => {
	if (key === "__proto__") {
		return `[${stringLiteral(key)}]`
	}

	return identifierPattern.test(key) ? key : asciiStringLiteral(key)
}

/**
 * Prints a number literal with no `+` in its exponent, as the formatter does.
 */
export const numberText = (value: number): string =>
	value < 0 ? `-${numberText(-value)}` : Str.replace("e+", "e")(String(value))
