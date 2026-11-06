import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, oneOf, string, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { CompileReason, RegexSpaceMeasure } from "#compiler/core/errors.ts"
import {
	regexMaxAnchors,
	regexMaxAnchorWeight,
	regexMaxClosurePairs,
	regexMaxPositions
} from "#compiler/core/limits.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { buildNfa, type Nfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import {
	assert,
	assertVariant,
	deepEquals,
	defined,
	refused,
	succeeded
} from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { jsAccepts, walkGen } from "#test/unit/text/generators.ts"

/**
 * The compile-space measures (core/limits.ts regexMaxPositions, regexMaxClosurePairs, regexMaxAnchors,
 * regexMaxAnchorWeight), which stand for PostgreSQL's REG_MAX_COMPILE_SPACE: a pattern is refused as ResourceBound with
 * the first measure it crosses, in their fixed order (a loop through an anchor, positions, anchors, their weight,
 * closure pairs), at any nesting depth, and admitted when it crosses none, so no count of constructs refuses anything
 * and the strict RFC 3986 URI-reference grammar, written out as one pattern, is admitted. That PostgreSQL compiles what
 * the measures admit is test/pg/text/differential.test.ts's.
 */
const loc = SourceLoc("str.regex", ["Web", "relations", "Link", "fields", "href"])

/** A code point as its braced escape, which means itself inside a class and out. */
const escaped = (c: number): string => `\\u{${c.toString(16)}}`

/**
 * A shape whose measures its parameters state, each drawn on both sides of the limits:
 * - counted runs, `^(?:[xy]{1,n}){k}$`: n·k + 2 positions, two anchors;
 * - an optional chain d deep, `(?:x(?:x…)?)?`: d positions, the empty arms costing none;
 * - optional anchors, `(?:$|x|){k}y`: 2k + 1 positions and k anchors;
 * - weighted anchors, `(?:$|x|){p}(?:^|x|){q}(?:[xy]{255}){m}y`: 2(p + q) + 255m + 1 positions, p + q anchors;
 * - optional pairs, `(?:x?){n}(?:y?){m}z`: n + m + 1 positions, joined in pairs by empty paths about (n² + m²) / 2 times;
 * - a + chain d deep, `(?:(?:x)+…)+`: one position, its loops joining pairs of states;
 * - a loop through an anchor, `(?:(?:[xy]{255}){k}|$)*y`: a body of 255k + 1 positions, which the IR writes as a loop
 *   of consuming matches only within regexMaxPositions.
 */
type Shape =
	| { readonly kind: "counted runs"; readonly n: number; readonly k: number }
	| { readonly kind: "an optional chain"; readonly depth: number }
	| { readonly kind: "optional anchors"; readonly anchor: "^" | "$"; readonly k: number }
	| {
			readonly kind: "weighted anchors"
			readonly p: number
			readonly q: number
			readonly m: number
	  }
	| { readonly kind: "optional pairs"; readonly n: number; readonly m: number }
	| { readonly kind: "a + chain"; readonly depth: number }
	| {
			readonly kind: "a loop through an anchor"
			readonly anchor: "^" | "$"
			readonly k: number
			readonly quantifier: "*" | "+" | "{2,}"
	  }

/**
 * A depth within a thousand levels, or past them, where a recursion would exhaust a small stack, up to 100,000 levels;
 * a deeper chain costs its depth to write and read, so the deepest are drawn the least.
 */
const depthGen: Gen<number> = weighted([
	[6, int(1, 1_000)],
	[2, int(1_001, 10_000)],
	[1, int(10_001, 100_000)]
])

const anchorGen = element(["^", "$"] as const)

const shapeGen: Gen<Shape> = oneOf<Shape>([
	(s) => ({ kind: "counted runs", n: s.draw(int(1, 255)), k: s.draw(int(1, 40)) }),
	(s) => ({ kind: "an optional chain", depth: s.draw(depthGen) }),
	(s) => ({ kind: "optional anchors", anchor: s.draw(anchorGen), k: s.draw(int(1, 16)) }),
	(s) => ({
		kind: "weighted anchors",
		p: s.draw(int(0, 8)),
		q: s.draw(int(0, 8)),
		m: s.draw(int(1, 16))
	}),
	(s) => ({ kind: "optional pairs", n: s.draw(int(150, 255)), m: s.draw(int(150, 255)) }),
	(s) => ({ kind: "a + chain", depth: s.draw(depthGen) }),
	(s) => ({
		kind: "a loop through an anchor",
		anchor: s.draw(anchorGen),
		k: s.draw(int(1, 40)),
		quantifier: s.draw(element(["*", "+", "{2,}"] as const))
	})
])

/**
 * A shape over two code points, its pattern, and what its parameters state: its written-out NFA positions and anchors,
 * or, for a loop through an anchor, whether the IR leaves it looping, which is refused before any count, while a loop
 * it writes out again has measures of its rewriting, which this shape does not state.
 */
interface Spelled {
	readonly source: string
	readonly states:
		| { readonly kind: "measures"; readonly positions: number; readonly anchors: number }
		| { readonly kind: "a loop"; readonly loops: boolean }
}

const spelledOf = (shape: Shape, x: string, y: string): Spelled => {
	const pair = `[${x}${y}]`
	switch (shape.kind) {
		case "counted runs":
			return {
				source: `^(?:${pair}{1,${shape.n}}){${shape.k}}$`,
				states: { kind: "measures", positions: shape.n * shape.k + 2, anchors: 2 }
			}
		case "an optional chain":
			return {
				source: `${Str.repeat(shape.depth)(`(?:${x}`)}${Str.repeat(shape.depth)(")?")}`,
				states: { kind: "measures", positions: shape.depth, anchors: 0 }
			}
		case "optional anchors":
			return {
				source: `(?:${shape.anchor}|${x}|){${shape.k}}${y}`,
				states: { kind: "measures", positions: 2 * shape.k + 1, anchors: shape.k }
			}
		case "weighted anchors":
			return {
				source: `(?:$|${x}|){${shape.p}}(?:^|${x}|){${shape.q}}(?:${pair}{255}){${shape.m}}${y}`,
				states: {
					kind: "measures",
					positions: 2 * (shape.p + shape.q) + 255 * shape.m + 1,
					anchors: shape.p + shape.q
				}
			}
		case "optional pairs":
			return {
				source: `(?:${x}?){${shape.n}}(?:${y}?){${shape.m}}${x}`,
				states: { kind: "measures", positions: shape.n + shape.m + 1, anchors: 0 }
			}
		case "a + chain":
			return {
				source: `${Str.repeat(shape.depth)("(?:")}${x}${Str.repeat(shape.depth)(")+")}`,
				states: { kind: "measures", positions: 1, anchors: 0 }
			}
		case "a loop through an anchor":
			return {
				source: `(?:(?:${pair}{255}){${shape.k}}|${shape.anchor})${shape.quantifier}${y}`,
				states: { kind: "a loop", loops: 255 * shape.k + 1 > regexMaxPositions.value }
			}
	}
}

/**
 * The pairs of NFA states joined by a path of ε and assertion edges, each state with itself, counted up to `cap` + 1:
 * PostgreSQL's empty-arc removal copies, into each state, the arcs of every state its empty arcs reach.
 */
const closurePairsUpTo = (nfa: Nfa, cap: number): number => {
	let total = 0
	for (const [from] of nfa.edges.entries()) {
		const reached = new Set<number>([from])
		const pending = [from]
		for (let s = pending.pop(); s !== undefined && total <= cap; s = pending.pop()) {
			total += 1
			for (const e of defined(nfa.edges[s], `the edges of state ${s}`)) {
				if (e.kind !== "set" && !reached.has(e.to)) {
					reached.add(e.to)
					pending.push(e.to)
				}
			}
		}
		if (total > cap) {
			return total
		}
	}
	return total
}

/** The first measure a shape of stated measures crosses, in the measures' order, or undefined where it crosses none. */
const crossed = (
	source: string,
	positions: number,
	anchors: number
): RegexSpaceMeasure | undefined => {
	if (positions > regexMaxPositions.value) {
		return { kind: "positions", limit: regexMaxPositions.value, needed: positions }
	}
	if (anchors > regexMaxAnchors.value) {
		return { kind: "anchors", limit: regexMaxAnchors.value, needed: anchors }
	}
	if (anchors * positions > regexMaxAnchorWeight.value) {
		return { kind: "anchorWeight", limit: regexMaxAnchorWeight.value, anchors, positions }
	}
	const ir = succeeded(parsePattern(source, "u"), source)
	return closurePairsUpTo(buildNfa(ir), regexMaxClosurePairs.value) > regexMaxClosurePairs.value
		? { kind: "closurePairs", limit: regexMaxClosurePairs.value }
		: undefined
}

/** The refusal of a pattern whose IR still loops through an anchor. */
const anchorLoop = (source: string): CompileReason => ({
	_tag: "ResourceBound",
	at: childLoc(loc, "pattern"),
	bound: {
		kind: "regexCompileSpace" as const,
		pattern: `/${source}/u`,
		measure: { kind: "anchorLoop" as const }
	}
})

type Crossed = RegexSpaceMeasure["kind"] | "admitted" | "refused past a thousand levels"

/** Code points a shape is spelled over: ASCII letters and digits, and ones the printer escapes. */
const shapePoints: Arr.NonEmptyReadonlyArray<number> = [0x61, 0x62, 0x7a, 0x30, 0x2e, 0xe9, 0x1f600]

describe("the compile-space measures", () => {
	it.effect(
		"refuse a pattern as ResourceBound with the first measure it crosses, 100,000 levels deep included, and admit one that crosses none",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/text/compile-space",
						draw: drawn((source) => ({
							shape: source.draw(shapeGen),
							x: source.draw(element(shapePoints)),
							y: source.draw(element(shapePoints))
						})),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "each shape's measures by its parameters, and a second count of the closure pairs"
						},
						coverage: required<Crossed>(
							[
								"positions",
								"anchors",
								"anchorWeight",
								"closurePairs",
								"anchorLoop",
								"admitted",
								"refused past a thousand levels"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 80,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ shape, x, y }, c) =>
						Effect.sync(() => {
							const spelled = spelledOf(shape, escaped(x), escaped(y))
							const label = `${shape.kind}: /${spelled.source}/u`
							const analyzed = analyzeText(spelled.source, "u", loc)
							const { states } = spelled
							if (states.kind === "a loop") {
								const loops =
									!analyzed.ok && deepEquals(analyzed.error.reason, anchorLoop(spelled.source))
								assert.equal(loops, states.loops, label)
								if (loops) {
									c.note("anchorLoop")
								}
								return
							}
							const expected = crossed(spelled.source, states.positions, states.anchors)
							if (expected === undefined) {
								c.note("admitted")
								succeeded(analyzed, label)
								return
							}
							c.note(expected.kind)
							if ("depth" in shape && shape.depth > 1_000) {
								c.note("refused past a thousand levels")
							}
							const { reason } = refused(analyzed, "ResourceBound", label)
							assertVariant(reason, "_tag", "ResourceBound", label)
							assert.deepEqual(
								reason.bound,
								{ kind: "regexCompileSpace", pattern: `/${spelled.source}/u`, measure: expected },
								label
							)
						})
				)
			)
	)
})

/**
 * The strict URI-reference grammar of RFC 3986 Appendix A, each rule spelled as the pattern of its ABNF and composed
 * into one pattern: about 6,200 code points, 1,569 NFA positions written out, two anchors and 3,169 pairs of states
 * joined by empty paths, inside every compile-space measure. ABNF's quoted strings are case-insensitive, so HEXDIG is
 * either case and IPvFuture's "v" is `[vV]`.
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

/** The code points a URI-reference is spelled in, the delimiters that make one malformed, and percent signs. */
const uriAlphabet = "aZ09-._~!$&'()*+,;=:@/?#[]%vF "

describe("the RFC 3986 URI-reference grammar as one pattern", () => {
	type Membership = "a member" | "no member" | "a walked member"
	it.effect(
		"is admitted, and accepts exactly the strings ECMAScript's RegExp accepts, on strings over its alphabet and walks of its own NFA",
		(ctx) => {
			const refinement = succeeded(analyzeText(uriReference, "u", loc), "the grammar")
			const parts = map(
				array(string(element(Str.split(uriAlphabet, "")), { min: 0, max: 4 }), { min: 0, max: 6 }),
				(drawnParts) => ({ value: Arr.join(drawnParts, ""), walked: false })
			)
			const walked = map(walkGen(buildNfa(refinement.ir)), (value) => ({ value, walked: true }))
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
							const member = jsAccepts(uriReference, "u", value)
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
