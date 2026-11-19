import { type CharSet, domain, union } from "#text/regex/charset.ts"
import { folded, type LiveNode, RegexBuilder, type RegexNode, set } from "#text/regex/ir.ts"
import type { RegexFlags } from "#text/regex/parse.ts"

/** The flags a printed source is read under: its sets are explicit classes, so no dot is left for a flag to read. */
export const sourceFlags: RegexFlags = "u"

/** Whether every match a node makes starts at the value's start, or ends at its end: a sequence it opens or closes. */
export const anchoredAt = (node: LiveNode, side: "start" | "end"): boolean => {
	const edge = node.kind === "seq" ? (side === "start" ? node.items[0] : node.items.at(-1)) : node
	return edge?.kind === side
}

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
export const alphabetOf = (node: LiveNode): CharSet =>
	anchoredAt(node, "start") && anchoredAt(node, "end") ? setsOf(node) : domain

/** Any run of admitted code points, `.*` under the flags "su". */
export const anyText = (): RegexNode => new RegexBuilder().repeat(set(domain), 0, "unbounded")
