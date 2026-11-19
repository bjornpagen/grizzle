import { type CharSet, union } from "#text/regex/charset.ts"
import { end, folded, RegexBuilder, type RegexNode, seq, start } from "#text/regex/ir.ts"

/**
 * Folds over the regex IR: each set of a node mapped (mapSets), the code points its words draw on (alphabetOf), its
 * mirror image (reversed), and a node narrowed to its consuming matches whose last code point lies in a set (lastIn,
 * the mirror of RegexBuilder.firstIn), what a facet composition reads to hold a word to end outside a class without an
 * assertion. Each reads its node children first (ir.ts folded), so a node of any depth folds without recursing, and
 * each is exact over the language its node spells.
 */

/** A node with each set replaced by the node `map` gives it, every other node rebuilt over its mapped children. */
export const mapSets = (node: RegexNode, map: (s: CharSet) => RegexNode): RegexNode => {
	const builder = new RegexBuilder()
	return folded(new Map<RegexNode, RegexNode>(), node, (n, of) => {
		switch (n.kind) {
			case "set":
				return map(n.set)
			case "seq":
				return seq(n.items.map((item) => of(item)))
			case "alt":
				return builder.alt(n.arms.map((arm) => of(arm)))
			case "repeat":
				return builder.repeat(of(n.body), n.min, n.max)
			case "empty":
			case "start":
			case "end":
			case "never":
				return n
		}
	})
}

/** Every code point a node's words may hold: the union of its sets, none for an assertion or the empty string. */
export const alphabetOf = (node: RegexNode): CharSet =>
	folded(new Map<RegexNode, CharSet>(), node, (n, of) => {
		switch (n.kind) {
			case "set":
				return n.set
			case "seq":
				return union(n.items.map((item) => of(item)))
			case "alt":
				return union(n.arms.map((arm) => of(arm)))
			case "repeat":
				return of(n.body)
			case "empty":
			case "start":
			case "end":
			case "never":
				return []
		}
	})

/**
 * A node's mirror image, whose language is every word of the node's read backwards: each sequence's items in reverse
 * order and each assertion its mirror, `^` the value's end and `$` its start.
 */
export const reversed = (node: RegexNode): RegexNode => {
	const builder = new RegexBuilder()
	return folded(new Map<RegexNode, RegexNode>(), node, (n, of) => {
		switch (n.kind) {
			case "seq":
				return seq(n.items.map((item) => of(item)).toReversed())
			case "alt":
				return builder.alt(n.arms.map((arm) => of(arm)))
			case "repeat":
				return builder.repeat(of(n.body), n.min, n.max)
			case "start":
				return end
			case "end":
				return start
			case "set":
			case "empty":
			case "never":
				return n
		}
	})
}

/**
 * A node narrowed to its consuming matches whose last code point lies in `within`: the mirror image's first
 * (RegexBuilder.firstIn), mirrored back.
 */
export const lastIn = (node: RegexNode, within: CharSet): RegexNode =>
	reversed(new RegexBuilder().firstIn(reversed(node), within))
