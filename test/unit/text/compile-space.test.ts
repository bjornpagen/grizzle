/**
 * PostgreSQL's regex compile limits, as grizzle measures a pattern against them (scalar/regex/space.ts): its colors,
 * the raw NFA PostgreSQL's parser builds from its ARE, the states and arcs held at once, its longest path, and the
 * anchors PostgreSQL must move. That PostgreSQL compiles what the limits admit is test/pg/text/differential.test.ts's.
 *
 * - The raw NFA: the built NFA holds the states and arcs its fold counts, no depth-first walk of it is deeper than its
 *   fold's depth, and its colors are its printed sets' classes. Oracle: a second implementation, the built raw NFA, its
 *   walks either way, and a sweep of every code point's set memberships.
 * - The limits: a shape built to cross one limit along its parameter, drawn on both sides of it, is refused as
 *   ResourceBound naming that limit and what it needed, and admitted inside every limit. Oracle: each shape's measure
 *   by its built raw NFA, its walks, or its code points' set memberships.
 * - RFC 3986: the URI-reference grammar as one pattern is admitted and accepts exactly what ECMAScript's RegExp
 *   accepts, on strings over its alphabet and walks of its own NFA. Oracle: ECMAScript's RegExp.
 *
 * Features: a pattern, sets that cut one another, a loop, a walk longer than its spelling; each limit crossed and a
 * shape admitted; a member, no member, and a walked member.
 *
 * Plants: text-raw-nfa-frame-arcs (the frame's arcs miscounted), text-limit-anchors-at (a pattern at the anchors
 * limit refused), text-charset-upper-bound (a set's last code point left out of it).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, oneOf, string, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import type { RegexSpaceMeasure } from "#compiler/core/errors.ts"
import {
	regexMaxAnchors,
	regexMaxDepth,
	regexMaxHeldArcs,
	regexMaxHeldStates,
	regexMaxMatchCells,
	regexMaxMatchStates
} from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { admitPattern } from "#compiler/scalar/regex/admit.ts"
import { printableIntervals, type SetNode } from "#compiler/scalar/regex/are.ts"
import { folded, type LiveNode, type RegexNode } from "#compiler/scalar/regex/ir.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import {
	colorsOf,
	matchStates,
	type RawNfa,
	rawNfa,
	rawSize,
	withoutAliases
} from "#compiler/scalar/regex/space.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, assertVariant, defined, refused, succeeded } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	families,
	flagsGen,
	jsMatcher,
	nestedPattern,
	patternOver,
	walkGen
} from "#test/unit/text/generators.ts"

const loc = SourceLoc("str.regex", ["Web", "relations", "Link", "fields", "href"])

/** A code point as its braced escape, which means itself inside a class and out. */
const escaped = (c: number): string => `\\u{${c.toString(16)}}`

/** Admitted code points of three widths, which a drawn alphabet takes from, so a pattern's sets cut many colors. */
const widePoints: ReadonlyArray<number> = [
	...Arr.range(0x21, 0x7e),
	...Arr.range(0x4e00, 0x4fff),
	...Arr.range(0x1f600, 0x1f6ff)
]

/** A pattern over a drawn alphabet of up to 48 code points, a family's, or one of nested quantifiers. */
const patternGen: Gen<{ readonly source: string; readonly flags: "u" | "su" }> = (source) => ({
	source: source.draw(
		oneOf<string>([
			nestedPattern,
			(s) => s.draw(patternOver(s.draw(element(families)).alphabet)),
			(s) => {
				const alphabet = s.draw(subset(widePoints, { min: 1, max: 48 }))
				return s.draw(
					patternOver([defined(alphabet[0], "a drawn code point"), ...alphabet.slice(1)])
				)
			}
		])
	),
	flags: source.draw(flagsGen)
})

/** The non-empty IR of a pattern, or undefined where it is malformed or of the empty language. */
const liveIr = (source: string, flags: "u" | "su"): LiveNode | undefined => {
	const parsed = parsePattern(source, flags)
	return parsed.ok && parsed.value.kind !== "never" ? parsed.value : undefined
}

/** The arcs a built raw NFA holds: a set's once for each color, an anchor's two, a frame's three, an empty one. */
const builtArcs = (nfa: RawNfa): number =>
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
const walkDepth = (nfa: RawNfa, reversed: boolean): number => {
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
const printedSets = (ir: LiveNode): ReadonlyArray<SetNode> => {
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
const sweptColors = (
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

describe("the raw NFA PostgreSQL's parser builds", () => {
	type Reached =
		| "a pattern"
		| "sets that cut one another"
		| "a loop"
		| "a walk longer than its spelling"
	it.effect(
		"holds the states and arcs its fold counts, no walk of it is deeper than its fold's depth, and its colors are its printed sets' classes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/text/raw-nfa",
						draw: drawn(patternGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the built raw NFA, depth-first walks of it, and every code point's set memberships"
						},
						coverage: required<Reached>(
							[
								"a pattern",
								"sets that cut one another",
								"a loop",
								"a walk longer than its spelling"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ source, flags }, c) =>
						Effect.gen(function* () {
							const ir = liveIr(source, flags)
							yield* c.assume(ir !== undefined)
							if (ir === undefined) {
								return
							}
							const label = `/${source}/${flags}`
							const colors = colorsOf(ir)
							const size = rawSize(ir, colors)
							yield* c.assume(size.states <= regexMaxHeldStates.value)
							c.note("a pattern")
							const swept = sweptColors(ir)
							assert.equal(colors.count, swept.count, `${label}: its colors`)
							for (const [i, node] of printedSets(ir).entries()) {
								assert.equal(
									colors.spanned(node),
									defined(swept.spans[i], `the sweep's set ${i}`),
									`${label}: the colors of set ${i}`
								)
							}
							if (colors.count > printedSets(ir).length + 1) {
								c.note("sets that cut one another")
							}
							const nfa = rawNfa(ir, colors)
							assert.equal(nfa.arcs.length, size.states, `${label}: its states`)
							assert.equal(builtArcs(nfa), size.arcs, `${label}: its arcs`)
							if (Arr.some(["*", "+", ",}"], (loop) => Str.includes(loop)(source))) {
								c.note("a loop")
							}
							for (const reversed of [false, true]) {
								const walked = walkDepth(nfa, reversed)
								assert.ok(
									walked <= size.depth,
									`${label}: a walk ${walked} deep past ${size.depth}`
								)
								if (walked > Arr.fromIterable(source).length) {
									c.note("a walk longer than its spelling")
								}
							}
						})
				)
			)
	)
})

/** The anchors of a built raw NFA, each of which the shapes below put before a code point, so each must move. */
const anchorsOf = (nfa: RawNfa): number =>
	Arr.filter(Arr.flatten(nfa.arcs), (arc) => arc.kind === "anchor").length

/** A pattern's built raw NFA. */
const built = (ir: LiveNode): RawNfa => rawNfa(ir, colorsOf(ir))

/** The states a pattern's match reads, as the model counts them (scalar/regex/space.ts matchStates). */
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
		source: chainOf(regexMaxDepth.value + s.draw(int(-600, 40))),
		measured: (ir) => walkDepth(built(ir), false),
		limit: regexMaxDepth.value
	}),
	(s) => ({
		crosses: "arcs",
		source: `${Arr.join(Arr.makeBy(512, cjk), "")}(?:[${Arr.join(Arr.makeBy(512, cjk), "")}]{255}){${s.draw(int(6, 9))}}`,
		measured: (ir) => 2 * builtArcs(built(ir)),
		limit: regexMaxHeldArcs.value
	}),
	(s) => ({
		crosses: "matchStates",
		source: `^(?:${Arr.join(upTo(Math.floor(regexMaxMatchStates.value / 3) + s.draw(int(-40, 40)), wordOf), "|")})$`,
		measured: matchStatesOf,
		limit: regexMaxMatchStates.value
	}),
	(s) => ({
		crosses: "matchCells",
		source: `^(?:${Arr.join(
			upTo(
				Math.floor(Math.sqrt(regexMaxMatchCells.value)) + s.draw(int(-8, 8)),
				(i) => `${cjk(i)}y`
			),
			"|"
		)})$`,
		measured: (ir) => matchStatesOf(ir) * sweptColors(ir).count,
		limit: regexMaxMatchCells.value
	}),
	(s) => ({
		crosses: "anchors",
		source: Str.repeat(regexMaxAnchors.value + s.draw(int(-1, 2)))("(?:$|a|)b"),
		measured: (ir) => anchorsOf(built(ir)),
		limit: regexMaxAnchors.value
	}),
	(s) => {
		const k = s.draw(int(1, 64))
		return {
			crosses: "anchorLoop",
			source: `(?:(?:(?:(?:ab){255}){255}){${k}}|$)*b`,
			loops: 2 * 255 * 255 * k + 1 > regexMaxHeldArcs.value
		}
	}
])

type Verdict = RegexSpaceMeasure["kind"] | "admitted"

describe("PostgreSQL's regex compile limits", () => {
	it.effect(
		"refuse a pattern as ResourceBound with the limit it crosses and admit it inside every limit",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/text/compile-limits",
						draw: drawn(shapeGen),
						literal: (shape) =>
							Formatter.format({ crosses: shape.crosses, source: Str.slice(0, 120)(shape.source) }),
						oracle: {
							kind: "second-implementation",
							name: "each shape's measure by its built raw NFA, its walks, or its code points' set memberships"
						},
						coverage: required<Verdict>(
							["depth", "arcs", "matchStates", "matchCells", "anchors", "anchorLoop", "admitted"],
							{ cases: 64, sense: notesOnly }
						),
						kept: [],
						runs: 32,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(shape, c) =>
						Effect.sync(() => {
							const label = `${shape.crosses}: /${Str.slice(0, 120)(shape.source)}/u`
							const admitted = admitPattern(shape.source, "u", loc)
							const refusal = admitted.ok
								? undefined
								: refused(admitted, "ResourceBound", label).reason
							const measure =
								refusal?._tag === "ResourceBound" && refusal.bound.kind === "regexCompileSpace"
									? refusal.bound.measure
									: undefined
							if (shape.crosses === "anchorLoop") {
								assert.equal(measure?.kind === "anchorLoop", shape.loops, label)
								if (shape.loops) {
									c.note("anchorLoop")
								}
								return
							}
							const ir = defined(liveIr(shape.source, "u"), label)
							const crossed = shape.measured(ir) > shape.limit
							if (!crossed) {
								assert.equal(admitted.ok, true, `${label}: admitted inside every limit`)
								c.note("admitted")
								return
							}
							const got = defined(measure, `${label}: refused`)
							assertVariant(got, "kind", shape.crosses, label)
							assert.equal(got.limit, shape.limit, label)
							if ("needed" in got) {
								assert.equal(got.needed, shape.measured(ir), label)
							}
							c.note(shape.crosses)
						})
				)
			)
	)
})

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
const ofUriReference = jsMatcher(uriReference, "u")

/** The code points a URI-reference is spelled in, the delimiters that make one malformed, and percent signs. */
const uriAlphabet = "aZ09-._~!$&'()*+,;=:@/?#[]%vF "

describe("the RFC 3986 URI-reference grammar as one pattern", () => {
	type Membership = "a member" | "no member" | "a walked member"
	it.effect(
		"is admitted, and accepts exactly the strings ECMAScript's RegExp accepts, on strings over its alphabet and walks of its own NFA",
		(ctx) => {
			const refinement = succeeded(
				analyzeText([{ source: uriReference, flags: "u" }], loc),
				"the grammar"
			)
			const parts = map(
				array(string(element(Str.split(uriAlphabet, "")), { min: 0, max: 4 }), { min: 0, max: 6 }),
				(drawnParts) => ({ value: Arr.join(drawnParts, ""), walked: false })
			)
			const walked = map(walkGen(buildNfa(refinement.members[0].ir)), (value) => ({
				value,
				walked: true
			}))
			return searched(
				ctx,
				explore(
					{
						suite: "unit/text/rfc3986-membership",
						draw: drawn(oneOf([parts, walked])),
						literal: Formatter.format,
						oracle: { kind: "second-implementation", name: "ECMAScript's own RegExp test" },
						coverage: required<Membership>(["a member", "no member", "a walked member"], {
							cases: 2000,
							sense: notesOnly
						}),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ value, walked: isWalk }, n) =>
						Effect.sync(() => {
							if (value === undefined) {
								return
							}
							const member = ofUriReference(value)
							n.note(member ? "a member" : "no member")
							if (isWalk) {
								assert.equal(member, true, `a walk spells a member: ${Formatter.format(value)}`)
								n.note("a walked member")
							}
							assert.equal(accepts(refinement, value), member, value)
						})
				)
			)
		}
	)
})
