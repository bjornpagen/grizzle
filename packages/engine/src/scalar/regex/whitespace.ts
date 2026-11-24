import {
	type CharSet,
	charSet,
	complement,
	domain,
	intersection,
	isEmpty,
	union
} from "@bjornpagen/grizzle-text/regex/charset"
import type { LiveNode } from "@bjornpagen/grizzle-text/regex/ir"
import type { Patterns, PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { regexMaxRepeat } from "@bjornpagen/grizzle-text/regex/parse"
import type { RegexFlags } from "@bjornpagen/grizzle-text/regex/parse"
import { sourceSet } from "@bjornpagen/grizzle-text/regex/print"
import { alphabetOf, sourceFlags } from "@bjornpagen/grizzle-text/regex/source"
import { xmlWhitespace } from "@bjornpagen/grizzle-text/text"
import { tokenPattern } from "#compiler/ir/scalar.ts"
import { memberNode, type PatternAutomata } from "#compiler/scalar/regex/patterns.ts"

/**
 * XML Schema's whiteSpace facet over the four characters XML calls white space, `S ::= (#x20 | #x9 | #xD | #xA)+`
 * (XML 1.0, §2.3): replace maps each of tab, LF and CR to a space, and collapse, after replacing, folds each run of
 * spaces to one and drops a leading and a trailing one (XML Schema 1.1 Part 2, §4.3.6 whiteSpace).
 *
 * The four white space characters, tab, LF, CR and space.
 */
const whitespace: CharSet = charSet(Array.from(xmlWhitespace, (c) => [c, c] as const))

/** Whether a node is one class repeated freely and anchored at both ends, `^[A]*$`: every text over A. */
const isFreeOver = (node: LiveNode): boolean => {
	if (node.kind !== "seq" || node.items.length !== 3) {
		return false
	}
	const [first, middle, last] = node.items
	return (
		first?.kind === "start" &&
		last?.kind === "end" &&
		middle?.kind === "repeat" &&
		middle.min === 0 &&
		middle.max === "unbounded" &&
		middle.body.kind === "set"
	)
}

/** The code points of `a` that `b` does not hold. */
const without = (a: CharSet, b: CharSet): CharSet => complement(union([complement(a), b]))

/** Every admitted code point but white space: what a token of a text of any characters is a run of. */
const solid: CharSet = without(domain, whitespace)

/**
 * The characters of N a bounded image's run begins and ends with, around its counted middle: `N(?:[N ]{0,n-2}N)?`.
 *
 * @formatConstant the first and the last character of a bounded image's run
 */
const boundedEnds = 2

/** A pattern a text type of the collapse's image is stated by, and whether its language is the image exactly. */
export interface CollapseSource {
	readonly source: string
	readonly flags: RegexFlags
	readonly exact: boolean
}

/**
 * The patterns the image of one pattern's language under collapse is stated by, the tightest first, each holding every
 * value of the image; the first the text analysis admits states the member's image. The pattern is a member of a text
 * type's conjunction (ir/scalar.ts textPatterns), and `lengthBound` the conjunction's, which bounds every value of it, so
 * each source holds the image of every value of the conjunction. N is the language's alphabet without white space, so a
 * value of the image is a run of N's characters, then any number of a space and such a run, or empty:
 * - a language whose alphabet holds no white space is its own image, exactly, since collapse leaves its values as they
 *   are;
 * - one whose alphabet holds no other character collapses to the empty text alone, exactly;
 * - one whose length is bounded by n is held by the texts of at most n characters of N and the space that begin and
 *   end with N's, `^(?:N(?:[N ]{0,n-2}N)?)?$`: collapse never lengthens a text, so the bound holds; this allows two
 *   spaces together, which no value of the image has, so it holds more than the image. A counted repetition holds at
 *   most 255, so a bound past 257 is not spelled;
 * - any language is held by every collapsed text over N, `^(?:N+(?: N+)*)?$`, exactly the image of every text over
 *   an alphabet, `^[A]*$` (the wildcard among them), and more than the image of any other.
 */
export const collapseSources = (
	pattern: PatternSource,
	lengthBound: number | undefined,
	patterns: PatternAutomata
): readonly [CollapseSource, ...ReadonlyArray<CollapseSource>] => {
	const node = memberNode(pattern, patterns)
	const alphabet = alphabetOf(node)
	if (isEmpty(without(alphabet, without(alphabet, whitespace)))) {
		return [{ source: pattern.source, flags: pattern.flags, exact: true }]
	}
	const other = without(alphabet, whitespace)
	if (isEmpty(other)) {
		return [{ source: "^$", flags: sourceFlags, exact: true }]
	}
	const n = sourceSet(other)
	const spaced = sourceSet(union([other, charSet([[0x20, 0x20]])]))
	const free: CollapseSource = {
		source: `^(?:${n}+(?:\\u{20}${n}+)*)?$`,
		flags: sourceFlags,
		exact: isFreeOver(node)
	}
	if (lengthBound === undefined || lengthBound - boundedEnds > regexMaxRepeat) {
		return [free]
	}
	const bounded =
		lengthBound === 0
			? "^$"
			: lengthBound === 1
				? `^${n}?$`
				: `^(?:${n}(?:${spaced}{0,${lengthBound - boundedEnds}}${n})?)?$`
	return [{ source: bounded, flags: sourceFlags, exact: false }, free]
}

/**
 * The pattern a token of a text of `patterns`' conjunction is stated by (r.tokens, ir/rel.ts TextSplit `tokens`), a
 * piece of the text collapsed and split at its spaces, so a maximal run of the text's characters but white space: a run
 * of N's, `^N+$`, N the characters every pattern's alphabet holds (source.ts alphabetOf) without white space. It is
 * exactly the tokens of every text over an alphabet, `^[A]*$`, and holds every token of any other text, each of whose
 * characters its alphabet holds. Where N is every character but white space, as it is of any text, the split's own
 * pattern (ir/scalar.ts tokenPattern) states it, that language's one spelling; where N is none, the text holds no
 * token, and the split's own pattern types the tokens it never yields.
 */
export const tokenSource = (patterns: Patterns, automata: PatternAutomata): PatternSource => {
	const n = without(
		patterns.reduce(
			(a, pattern) => intersection(a, alphabetOf(memberNode(pattern, automata))),
			domain
		),
		whitespace
	)
	return isEmpty(n) || isEmpty(without(solid, n))
		? tokenPattern
		: { source: `^${sourceSet(n)}+$`, flags: sourceFlags }
}
