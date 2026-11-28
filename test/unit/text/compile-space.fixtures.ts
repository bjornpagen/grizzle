/** What the properties of compile-space.test.ts read: its spaces, models and helpers. */

import { printableIntervals, type SetNode } from "@bjornpagen/grizzle-text/regex/are"
import {
	regexMaxHeldArcs,
	folded,
	type LiveNode,
	type RegexNode
} from "@bjornpagen/grizzle-text/regex/ir"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { defined } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	subset
} from "@bjornpagen/testing/gen"
import { Array as Arr, Order, String as Str } from "effect"
import type { RegexSpaceMeasure } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	regexMaxAnchors,
	regexMaxDepth,
	regexMaxMatchCells,
	regexMaxMatchStates,
	colorsOf,
	matchStates,
	type RawNfa,
	rawNfa,
	withoutAliases
} from "#compiler/ir/pattern-space.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsMatcher } from "#test/support/regex.ts"
import {
	admittedPatternOver,
	families,
	flagsGen,
	nestedPattern,
	walkGen
} from "#test/support/unit/text/generators.ts"
import { upTo } from "#test/support/up-to.ts"

export const loc = SourceLoc("str.regex", ["Web", "relations", "Link", "fields", "href"])

/** A code point as its braced escape, which means itself inside a class and out. */
const escaped = (c: number): string => `\\u{${c.toString(16)}}`

/** Admitted code points of three widths, which a drawn alphabet takes from, so a pattern's sets cut many colors. */
const widePoints: ReadonlyArray<number> = [
	...Arr.range(0x21, 0x7e),
	...Arr.range(0x4e00, 0x4fff),
	...Arr.range(0x1f600, 0x1f6ff)
]

/** A pattern over a drawn alphabet of up to 48 code points, a family's, or one of nested quantifiers. */
/**
 * A pattern the raw NFA search draws, by its arm: an admitted one (admittedPatternOver) over a family's alphabet or a
 * drawn wide one, which is live and within every compile limit by construction, or one of nested quantifiers
 * (nestedPattern), which may match no text or hold more states than a compile holds, and which the search passes over
 * then.
 */
interface RawCase {
	readonly arm: "admitted" | "nested"
	readonly source: string
	readonly flags: "u" | "su"
}

export const patternGen: Gen<RawCase> = oneOf<RawCase>([
	(s) => ({ arm: "nested", source: s.draw(nestedPattern), flags: s.draw(flagsGen) }),
	(s) => ({
		arm: "admitted",
		source: s.draw(admittedPatternOver(s.draw(element(families)).alphabet)),
		flags: s.draw(flagsGen)
	}),
	(s) => {
		const alphabet = s.draw(subset(widePoints, { min: 1, max: 48 }))
		return {
			arm: "admitted",
			source: s.draw(
				admittedPatternOver([defined(alphabet[0], "a drawn code point"), ...alphabet.slice(1)])
			),
			flags: s.draw(flagsGen)
		}
	}
])

/** The non-empty IR of a pattern, or undefined where it is malformed or of the empty language. */
export const liveIr = (source: string, flags: "u" | "su"): LiveNode | undefined => {
	const parsed = parsePattern(source, flags)
	return parsed.ok && parsed.value.kind !== "never" ? parsed.value : undefined
}

/** The arcs a built raw NFA holds: a set's once for each color, an anchor's two, a frame's three, an empty one. */
export const builtArcs = (nfa: RawNfa): number =>
	Arr.reduce(
		Arr.flatten(nfa.arcs),
		0,
		(n, arc) => n + (arc.kind === "empty" ? 1 : arc.kind === "anchor" ? 2 : arc.weight)
	)

/**
 * The deepest a depth-first walk of a built raw NFA goes from its first state, in arcs, as PostgreSQL's recursive walks
 * of it go (regc_nfa.c markreachable), taking each state's arcs in the order given or reversed: what max_stack_depth
 * bounds.
 */
export const walkDepth = (nfa: RawNfa, reversed: boolean): number => {
	const seen = new Uint8Array(nfa.arcs.length)
	const outs = (state: number) => {
		const arcs = defined(nfa.arcs[state], `the arcs of state ${state}`)
		return reversed ? Arr.reverse(arcs) : arcs
	}
	const stack: Array<{ readonly state: number; next: number }> = [{ state: 0, next: 0 }]
	seen[0] = 1
	let deepest = 0
	for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
		deepest = Math.max(deepest, stack.length - 1)
		const arc = outs(top.state)[top.next]
		if (arc === undefined) {
			stack.pop()
		} else {
			top.next += 1
			if (seen[arc.to] === 0) {
				seen[arc.to] = 1
				stack.push({ state: arc.to, next: 0 })
			}
		}
	}
	return deepest
}

/** The set nodes of a pattern's IR, each set as its bracket expression prints it. */
export const printedSets = (ir: LiveNode): ReadonlyArray<SetNode> => {
	const nodes = new Map<RegexNode, true>()
	folded(nodes, ir, () => true)
	return Arr.flatMap([...nodes.keys()], (node) => (node.kind === "set" ? [node] : []))
}

/** A 32-bit mix of a number (splitmix32's finalizer), so each set's mark is a word of its own. */
const mixed = (n: number): number => {
	let z = Math.imul(n ^ (n >>> 16), 0x85eb_ca6b)
	z = Math.imul(z ^ (z >>> 13), 0xc2b2_ae35)
	return (z ^ (z >>> 16)) >>> 0
}

/**
 * The colors of a pattern by a sweep over every code point, NUL included: each printed set marks the code points it
 * holds with two words of its own, and a code point's membership is the exclusive-or of the marks over it, so two code
 * points share a color exactly when their memberships are equal, as far as 64 bits of marks tell. The colors are the
 * distinct memberships, all and within each set's intervals.
 */
export const sweptColors = (
	ir: LiveNode
): { readonly count: number; readonly spans: ReadonlyArray<number> } => {
	const sets = Arr.map(printedSets(ir), (node) => printableIntervals(node.set))
	const events = new Map<number, [number, number]>([[0, [0, 0]]])
	const flip = (at: number, set: number): void => {
		const [a, b] = events.get(at) ?? [0, 0]
		events.set(at, [a ^ mixed(2 * set), b ^ mixed(2 * set + 1)])
	}
	for (const [index, set] of sets.entries()) {
		for (const [lo, hi] of set) {
			flip(lo, index)
			flip(hi + 1, index)
		}
	}
	const points = Arr.sort([...events.keys()], Order.Number)
	const keys = new Map<number, string>()
	let a = 0
	let b = 0
	for (const point of points) {
		const [da, db] = defined(events.get(point), "an event's flips")
		a ^= da
		b ^= db
		keys.set(point, `${a}:${b}`)
	}
	const inside = Arr.filter(points, (point) => point <= 0x10ffff)
	const keyOf = (point: number): string => defined(keys.get(point), "a point's membership")
	/** The first of the points at or past `c`, by bisection. */
	const firstFrom = (c: number): number => {
		let low = 0
		let high = inside.length
		while (low < high) {
			const middle = (low + high) >>> 1
			if (defined(inside[middle], "a point") < c) {
				low = middle + 1
			} else {
				high = middle
			}
		}
		return low
	}
	return {
		count: new Set(Arr.map(inside, keyOf)).size,
		spans: Arr.map(sets, (set) => {
			const held = new Set<string>()
			for (const [lo, hi] of set) {
				for (let i = firstFrom(lo); i < inside.length && defined(inside[i], "a point") <= hi; i++) {
					held.add(keyOf(defined(inside[i], "a point")))
				}
			}
			return held.size
		})
	}
}

/** What a case reached; a nested arm's pattern that no compile holds, neither live nor within its states, has no NFA
 * to judge, and is noted as such. */
export type Reached =
	| "a pattern"
	| "sets that cut one another"
	| "a loop"
	| "a walk longer than its spelling"
	| "a nested pattern no compile holds"

/** The anchors of a built raw NFA, each of which the shapes below put before a code point, so each must move. */
const anchorsOf = (nfa: RawNfa): number =>
	Arr.filter(Arr.flatten(nfa.arcs), (arc) => arc.kind === "anchor").length

/** A pattern's built raw NFA. */
const built = (ir: LiveNode): RawNfa => rawNfa(ir, colorsOf(ir))

/** The states a pattern's match reads, as the model counts them (ir/pattern-space.ts matchStates). */
const matchStatesOf = (ir: LiveNode): number => matchStates(withoutAliases(built(ir)))

/**
 * A shape that crosses one limit along its parameter, drawn on both sides of it, each limit before it in their order far
 * inside, and its measure along the parameter by an oracle of its own or, for the match, the model's count:
 * - depth: a chain of n code points in counted runs, no loop and no fan, its depth a walk of its built NFA's;
 * - arcs: 512 code points of their own, then k counted runs of 255 copies of a class of all of them, twice its built
 *   arcs, its empty arcs only the frame's;
 * - matchStates: an anchored alternation of n words of four letters, digits and underscores;
 * - matchCells: an anchored alternation of n two-character words, each a code point of its own and a common one, its
 *   colors every code point's set memberships tell apart;
 * - anchors: k `$`, each before a code point, so each must move;
 * - anchorLoop: an unbounded repetition of an anchor or k times 65,025 copies of a pair, which the IR writes as a loop
 *   of consuming matches only within regexMaxHeldArcs written-out positions, refused as a loop past them.
 * The colors and the states held at once bind no shape the match's limits leave: a pattern of more colors holds more
 * states times colors, and one of more states held more states to match with.
 */
type Shape =
	| {
			readonly crosses: Exclude<RegexSpaceMeasure["kind"], "anchorLoop">
			readonly source: string
			readonly measured: (ir: LiveNode) => number
			readonly limit: number
	  }
	| { readonly crosses: "anchorLoop"; readonly source: string; readonly loops: boolean }

const cjk = (i: number): string => escaped(0x4e00 + i)

const chainOf = (n: number): string => {
	const runs = Math.floor(n / 255)
	return `${runs > 0 ? `(?:a{255}){${runs}}` : ""}b{${(n % 255) + 1}}`
}

/** The i-th word of four letters, digits and underscores, every word distinct: i in base 36, padded by underscores. */
const wordOf = (i: number): string => Str.padStart(4, "_")(i.toString(36))

const shapeGen: Gen<Shape> = oneOf<Shape>([
	(s) => ({
		crosses: "depth",
		source: chainOf(regexMaxDepth + s.draw(int(-600, 40))),
		measured: (ir) => walkDepth(built(ir), false),
		limit: regexMaxDepth
	}),
	(s) => ({
		crosses: "arcs",
		source: `${Arr.join(Arr.makeBy(512, cjk), "")}(?:[${Arr.join(Arr.makeBy(512, cjk), "")}]{255}){${s.draw(int(6, 9))}}`,
		measured: (ir) => 2 * builtArcs(built(ir)),
		limit: regexMaxHeldArcs
	}),
	(s) => ({
		crosses: "matchStates",
		source: `^(?:${Arr.join(upTo(Math.floor(regexMaxMatchStates / 3) + s.draw(int(-40, 40)), wordOf), "|")})$`,
		measured: matchStatesOf,
		limit: regexMaxMatchStates
	}),
	(s) => ({
		crosses: "matchCells",
		source: `^(?:${Arr.join(
			upTo(Math.floor(Math.sqrt(regexMaxMatchCells)) + s.draw(int(-8, 8)), (i) => `${cjk(i)}y`),
			"|"
		)})$`,
		measured: (ir) => matchStatesOf(ir) * sweptColors(ir).count,
		limit: regexMaxMatchCells
	}),
	(s) => ({
		crosses: "anchors",
		source: Str.repeat(regexMaxAnchors + s.draw(int(-1, 2)))("(?:$|a|)b"),
		measured: (ir) => anchorsOf(built(ir)),
		limit: regexMaxAnchors
	}),
	(s) => {
		const k = s.draw(int(1, 64))
		return {
			crosses: "anchorLoop",
			source: `(?:(?:(?:(?:ab){255}){255}){${k}}|$)*b`,
			loops: 2 * 255 * 255 * k + 1 > regexMaxHeldArcs
		}
	}
])

export type Verdict = RegexSpaceMeasure["kind"] | "admitted" | "anchors at the limit"

/**
 * A pattern of as many moving anchors as the anchors limit allows, or one fewer: admitted at the limit itself, which a
 * limit compared one off refuses.
 */
const anchorsAtLimitGen: Gen<Shape> = (s) => ({
	crosses: "anchors",
	source: Str.repeat(regexMaxAnchors + s.draw(int(-1, 0)))("(?:$|a|)b"),
	measured: (ir) => anchorsOf(built(ir)),
	limit: regexMaxAnchors
})

/** The drawn shapes, aimed at a pattern at the anchors limit. */
export const shapeSpace: Aimed<Shape, Verdict> = aimed(shapeGen, [
	["anchors at the limit", anchorsAtLimitGen]
])

/**
 * The strict URI-reference grammar of RFC 3986 Appendix A, each rule spelled as the pattern of its ABNF and composed
 * into one pattern of about 6,200 code points, inside every limit of PostgreSQL's regex compiler. ABNF's quoted strings
 * are case-insensitive, so HEXDIG is either case and IPvFuture's "v" is `[vV]`.
 */
const hexdig = "[0-9A-Fa-f]"

const unreserved = "[A-Za-z0-9\\-._~]"

const subDelims = "[!$&'()*+,;=]"

const pctEncoded = `%${hexdig}${hexdig}`

const pchar = `(?:${unreserved}|${pctEncoded}|${subDelims}|:|@)`

const segment = `${pchar}*`

const segmentNz = `${pchar}+`

const segmentNzNc = `(?:${unreserved}|${pctEncoded}|${subDelims}|@)+`

const pathAbempty = `(?:/${segment})*`

const pathAbsolute = `/(?:${segmentNz}(?:/${segment})*)?`

const pathNoscheme = `${segmentNzNc}(?:/${segment})*`

const pathRootless = `${segmentNz}(?:/${segment})*`

const pathEmpty = ""

const query = `(?:${pchar}|/|\\?)*`

const fragment = `(?:${pchar}|/|\\?)*`

const decOctet = "(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])"

const ipv4address = `${decOctet}\\.${decOctet}\\.${decOctet}\\.${decOctet}`

const h16 = `${hexdig}{1,4}`

const ls32 = `(?:${h16}:${h16}|${ipv4address})`

const ipv6address = Arr.join(
	[
		`(?:${h16}:){6}${ls32}`,
		`::(?:${h16}:){5}${ls32}`,
		`(?:${h16})?::(?:${h16}:){4}${ls32}`,
		`(?:(?:${h16}:){0,1}${h16})?::(?:${h16}:){3}${ls32}`,
		`(?:(?:${h16}:){0,2}${h16})?::(?:${h16}:){2}${ls32}`,
		`(?:(?:${h16}:){0,3}${h16})?::${h16}:${ls32}`,
		`(?:(?:${h16}:){0,4}${h16})?::${ls32}`,
		`(?:(?:${h16}:){0,5}${h16})?::${h16}`,
		`(?:(?:${h16}:){0,6}${h16})?::`
	],
	"|"
)

const ipvFuture = `[vV]${hexdig}+\\.(?:${unreserved}|${subDelims}|:)+`

const ipLiteral = `\\[(?:${ipv6address}|${ipvFuture})\\]`

const regName = `(?:${unreserved}|${pctEncoded}|${subDelims})*`

const host = `(?:${ipLiteral}|${ipv4address}|${regName})`

const port = "[0-9]*"

const userinfo = `(?:${unreserved}|${pctEncoded}|${subDelims}|:)*`

const authority = `(?:${userinfo}@)?${host}(?::${port})?`

const scheme = "[A-Za-z][A-Za-z0-9+\\-.]*"

const hierPart = `(?://${authority}${pathAbempty}|${pathAbsolute}|${pathRootless}|${pathEmpty})`

const relativePart = `(?://${authority}${pathAbempty}|${pathAbsolute}|${pathNoscheme}|${pathEmpty})`

const uri = `${scheme}:${hierPart}(?:\\?${query})?(?:#${fragment})?`

const relativeRef = `${relativePart}(?:\\?${query})?(?:#${fragment})?`

const uriReference = `^(?:${uri}|${relativeRef})$`

export const ofUriReference = jsMatcher(uriReference, "u")

/** The code points a URI-reference is spelled in, the delimiters that make one malformed, and percent signs. */
const uriAlphabet = "aZ09-._~!$&'()*+,;=:@/?#[]%vF "

export type Membership = "a member" | "no member" | "a walked member"

export const refinement = succeeded(
	analyzeText([{ source: uriReference, flags: "u" }], loc),
	"the grammar"
)

export const parts = map(
	array(string(element(Str.split(uriAlphabet, "")), { min: 0, max: 4 }), { min: 0, max: 6 }),
	(drawnParts) => ({ value: Arr.join(drawnParts, ""), walked: false })
)

export const walked = map(walkGen(buildNfa(refinement.members[0].ir)), (value) => ({
	value,
	walked: true
}))
