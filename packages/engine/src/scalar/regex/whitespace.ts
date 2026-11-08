import { defect } from "#compiler/core/invariant.ts"
import { regexMaxRepeat } from "#compiler/core/limits.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import type { PatternSource } from "#compiler/ir/scalar.ts"
import { toAre } from "#compiler/scalar/regex/are.ts"
import {
	type CharSet,
	charSet,
	complement,
	domain,
	has,
	isEmpty,
	union
} from "#compiler/scalar/regex/charset.ts"
import {
	folded,
	type LiveNode,
	RegexBuilder,
	type RegexNode,
	set
} from "#compiler/scalar/regex/ir.ts"
import type { RegexFlags } from "#compiler/scalar/regex/parse.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { anchoredAt, sourceFlags, sourceSet } from "#compiler/scalar/regex/source.ts"

/**
 * XML Schema's whiteSpace facet over the four characters XML calls white space, `S ::= (#x20 | #x9 | #xD | #xA)+`
 * (XML 1.0, §2.3): replace maps each of tab, LF and CR to a space, and collapse, after replacing, folds each run of
 * spaces to one and drops a leading and a trailing one (XML Schema 1.1 Part 2, §4.3.6 whiteSpace).
 *
 * The four white space characters, tab, LF, CR and space.
 */
const whitespace: CharSet = charSet([
	[0x09, 0x0a],
	[0x0d, 0x0d],
	[0x20, 0x20]
])

/** whiteSpace replace's map, as Compute.translate states it: tab, LF and CR, each a space. */
export const replaceMap = Object.freeze({ from: "\t\n\r", to: "   " })

/**
 * whiteSpace collapse of a text, by code points: each run of white space between two other characters is one space,
 * and a run at either end is nothing.
 */
export const collapsed = (text: string): string => {
	const out: Array<number> = []
	let spaced = false
	for (const c of codePoints(text)) {
		if (has(whitespace, c)) {
			spaced = out.length > 0
			continue
		}
		if (spaced) {
			out.push(0x20)
			spaced = false
		}
		out.push(c)
	}
	return codePointsText(out)
}

/**
 * The ARE of a run of white space, `[ \t\n\r]+` as the ARE printer spells it (are.ts), which PostgreSQL's
 * regexp_replace reads in collapse's SQL, `btrim(regexp_replace(x, run, ' ', 'g'))`.
 */
export const whitespaceRun: string = ((): string => {
	const run: RegexNode = new RegexBuilder().repeat(set(whitespace), 1, "unbounded")
	if (run.kind === "never") {
		throw defect("a run of white space, a language with a member")
	}
	return toAre(run)
})()

/** Every code point a node's sets hold. */
const setsOf = (node: LiveNode): CharSet =>
	folded(new Map<RegexNode, CharSet>(), node, (n, of): CharSet => {
		switch (n.kind) {
			case "set":
				return n.set
			case "seq":
				return union(n.items.map(of))
			case "alt":
				return union(n.arms.map(of))
			case "repeat":
				return of(n.body)
			case "empty":
			case "start":
			case "end":
				return []
		}
	})

/**
 * Every code point a value of a pattern's language may hold: its sets', where it is anchored at both ends, and every
 * admitted code point otherwise, since a match anywhere admits any prefix and suffix.
 */
const alphabetOf = (node: LiveNode): CharSet =>
	anchoredAt(node, "start") && anchoredAt(node, "end") ? setsOf(node) : domain

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
	const node = patterns.parse(pattern).node
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
	if (lengthBound === undefined || lengthBound - boundedEnds > regexMaxRepeat.value) {
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
