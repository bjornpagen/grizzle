import type { RegexFlags } from "@bjornpagen/grizzle-text/regex/parse"
import { defined } from "@bjornpagen/testing/assert"
import { regex } from "arkregex"
import { Array as Arr, String as Str } from "effect"

/** RegExp's flags in the order RegExp.prototype.flags spells them. */
const FLAG_ORDER = "dgimsuvy"

/** A flags text in that order, each flag at most once and never both u and v: the flags arkregex takes. */
const orderedFlags = regex("^d?g?i?m?s?[uv]?y?$")

/**
 * A pattern compiled from a source and flags a value holds, its flags read in RegExp's own order. Flags RegExp refuses
 * (a flag twice, an unknown one, both u and v) are refused here with the SyntaxError RegExp throws.
 */
export const compiledPattern = (source: string, flags: string): RegExp => {
	const ordered = Arr.join(
		Arr.filter(Str.split("")(FLAG_ORDER), (flag) => Str.includes(flag)(flags)),
		""
	)
	if (ordered.length !== flags.length || !orderedFlags.test(ordered)) {
		throw new SyntaxError(`Invalid flags supplied to RegExp constructor '${flags}'`)
	}
	return regex.as(source, ordered)
}

/**
 * ECMAScript's own reading of grizzle's patterns, the development oracle every regex property and the reference
 * evaluator hold the engine's automata to: grizzle's grammar is ECMA-262's under its flags, so a pattern's membership
 * is RegExp's `test`, which shares no code with the engine's parser, NFA, DFA or matcher. It appears only under test/,
 * never under src/.
 */

/**
 * A class's body from `from`, just past its opening, to its closing `]`, each escape kept whole, and where the `]` is.
 */
const classBody = (
	chars: ReadonlyArray<string>,
	from: number
): { readonly body: string; readonly close: number } => {
	let body = ""
	let j = from
	while (j < chars.length && chars[j] !== "]") {
		body += chars[j] === "\\" ? `\\${chars[j + 1] ?? ""}` : chars[j]
		j += chars[j] === "\\" ? 2 : 1
	}
	return { body, close: j }
}

/**
 * V8 (14.6, Node 26) computes the complement of a class holding U+10FFFE without U+10FFFF, so `/[^\u{10FFFE}]/u`
 * refuses "\u{10FFFF}", against ECMA-262 (CharacterComplement is every code point outside the set). The oracle
 * therefore spells each negated class `[^X]` as `(?:(?![X])[\0-\u{10FFFF}])`: a negative lookahead over the positive
 * class, then any code point, which is the specification's meaning with no complement computed by the engine.
 */
const withoutComplements = (source: string): string => {
	const chars = Arr.fromIterable(source)
	let out = ""
	let i = 0
	while (i < chars.length) {
		const ch = defined(chars[i], "a character")
		if (ch === "\\") {
			out += ch + (chars[i + 1] ?? "")
			i += 2
		} else if (ch === "[" && chars[i + 1] === "^") {
			const { body, close } = classBody(chars, i + 2)
			/** A body that starts with ^ would negate the positive class again; escaped, it is the literal. */
			const positive = Str.startsWith("^")(body) ? `\\${body}` : body
			out += `(?:(?![${positive}])[\\0-\\u{10FFFF}])`
			i = close + 1
		} else if (ch === "[") {
			/** A positive class is copied whole, so a `[^` inside it is not taken for a negated class. */
			const { body, close } = classBody(chars, i + 1)
			out += `[${body}]`
			i = close + 1
		} else {
			out += ch
			i += 1
		}
	}
	return out
}

/**
 * The development oracle: ECMAScript's own membership test of a pattern, compiled once, on the source with its negated
 * classes spelled without an engine complement. The search is spelled as an anchored match after a lazy prefix, which
 * accepts exactly the strings an unanchored `test` does: V8 in Node 26.11 misses an unanchored match of a class that
 * reaches the supplementary planes followed by `$` under the u flag (`/[\s\S]$/u.test("\u{1F600}")` is false), which
 * a rotating seed of the membership suite found as /[^]$/u refusing U+10FFFF. The flags hold neither g nor y, so a
 * test reads no lastIndex and the one RegExp answers every value alike.
 */
export const jsMatcher = (source: string, flags: RegexFlags): ((value: string) => boolean) => {
	const compiled = regex.as(`^[\\s\\S]*?(?:${withoutComplements(source)})`, flags)
	return (value) => compiled.test(value)
}

/** Whether ECMAScript's test finds a match of `source` under `flags` in `text` (jsMatcher). */
export const ecmaMatches = (source: string, flags: RegexFlags, text: string): boolean =>
	jsMatcher(source, flags)(text)
