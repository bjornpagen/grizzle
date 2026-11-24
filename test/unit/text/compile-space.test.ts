/**
 * PostgreSQL's regex compile limits, as grizzle measures a pattern against them (ir/pattern-space.ts): its colors,
 * the raw NFA PostgreSQL's parser builds from its ARE, the states and arcs held at once, its longest path, and the
 * anchors PostgreSQL must move. That PostgreSQL compiles what the limits admit is test/pg/text/differential.test.ts's.
 *
 * - The raw NFA: the built NFA holds the states and arcs its fold counts, no depth-first walk of it is deeper than its
 *   fold's depth, and its colors are its printed sets' classes, over admitted patterns, every one live and within the
 *   states a compile holds by construction, and nested ones, which the search passes over where they are not. Oracle: a second implementation, the built raw NFA, its
 *   walks either way, and a sweep of every code point's set memberships.
 * - The limits: a shape built to cross one limit along its parameter, drawn on both sides of it, is refused as
 *   ResourceBound naming that limit and what it needed, and admitted inside every limit. Oracle: each shape's measure
 *   by its built raw NFA, its walks, or its code points' set memberships.
 * - RFC 3986: the URI-reference grammar as one pattern is admitted and accepts exactly what ECMAScript's RegExp
 *   accepts, on strings over its alphabet and walks of its own NFA. Oracle: ECMAScript's RegExp.
 *
 * Features: a pattern, sets that cut one another, a loop, a walk longer than its spelling; each limit crossed and a
 * shape admitted; a member, no member, and a walked member.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import type { Reached as ReachedOf } from "@bjornpagen/testing/features"
import { oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { regexMaxHeldStates, colorsOf, rawNfa, rawSize } from "#compiler/ir/pattern-space.ts"
import { admitIr } from "#compiler/ir/pattern.ts"
import { refusalAt } from "#compiler/scalar/regex/admit.ts"
import { refused } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import {
	builtArcs,
	liveIr,
	loc,
	type Membership,
	ofUriReference,
	parts,
	patternGen,
	printedSets,
	type Reached,
	refinement,
	shapeSpace,
	sweptColors,
	type Verdict,
	walkDepth,
	walked
} from "#test/unit/text/compile-space.fixtures.ts"

/** The raw NFA PostgreSQL's parser builds holds the states and arcs its fold counts, no walk of it is deeper than its fold's depth, and its colors are its printed sets' classes. Its budget is its suite's before it was a property (test/unit/text/compile-space.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const theRawNFAPostgreSQLsParserBuildsHoldsTheStatesAndArcsItsFoldCountsNoWalkOfItIsDeeperThanItsFoldsDepthAndItsColorsAreItsPrintedSetsClasses =
	property.explore(patternGen, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: [
			"a pattern",
			"sets that cut one another",
			"a loop",
			"a walk longer than its spelling"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check:
			(_, c: Case<Reached>) =>
			({ arm, source, flags }) =>
				Effect.sync(() => {
					const label = `/${source}/${flags}`
					const ir = liveIr(source, flags)
					if (arm === "nested" && ir === undefined) {
						c.note("a nested pattern no compile holds")
						return
					}
					if (ir === undefined) {
						return assert.fail(`${label}: an admitted pattern is live`)
					}
					const colors = colorsOf(ir)
					const size = rawSize(ir, colors)
					if (arm === "nested" && size.states > regexMaxHeldStates) {
						c.note("a nested pattern no compile holds")
						return
					}
					assert.ok(
						size.states <= regexMaxHeldStates,
						`${label}: an admitted pattern holds no more states than a compile holds`
					)
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
						assert.ok(walked <= size.depth, `${label}: a walk ${walked} deep past ${size.depth}`)
						if (walked > Arr.fromIterable(source).length) {
							c.note("a walk longer than its spelling")
						}
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the built raw NFA, depth-first walks of it, and every code point's set memberships"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/pattern-space.ts",
				original: "\tframe: { states: 4, arcs: 6, path: 2 }",
				replacement: "\tframe: { states: 4, arcs: 4, path: 2 }",
				why: "The fold counts newnfa's frame as four arcs, not six; the raw NFA property fails."
			},
			{
				file: "packages/engine/src/ir/pattern-space.ts",
				original: "\t\t\tprinted.push(intervals)",
				replacement: "\t\t\tprinted.push(intervals.map(([lo, hi]): Interval => [lo, hi - 1]))",
				why: "The colors leave each printed set's last code point out of it; the raw NFA property's colors fail, and so does the limits property."
			}
		]
	})

/** PostgreSQL's regex compile limits refuse a pattern as ResourceBound with the limit it crosses and admit it inside every limit. Its budget is its suite's before it was a property (test/unit/text/compile-space.test.ts at 4ca3036a): 32 runs and 64 steered cases. */
export const postgreSQLsRegexCompileLimitsRefuseAPatternAsResourceBoundWithTheLimitItCrossesAndAdmitItInsideEveryLimit =
	property.explore(shapeSpace, {
		needs: {},
		budget: { runs: 32, steered: 64 },
		situations: [
			"depth",
			"arcs",
			"matchStates",
			"matchCells",
			"anchors",
			"anchorLoop",
			"admitted",
			"anchors at the limit"
		] satisfies ReadonlyArray<ReachedOf<Verdict>>,
		check: (_, c: Case<Verdict>) => (shape) =>
			Effect.sync(() => {
				const label = `${shape.crosses}: /${Str.slice(0, 120)(shape.source)}/u`
				const admitted = Result.mapError(admitIr(shape.source, "u"), (r) =>
					refusalAt(r, shape.source, "u", loc)
				)
				const refusal = admitted.ok ? undefined : refused(admitted, "ResourceBound", label).reason
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
					if (shape.crosses === "anchors" && shape.measured(ir) === shape.limit) {
						c.note("anchors at the limit")
					}
					return
				}
				const got = defined(measure, `${label}: refused`)
				assertVariant(got, "kind", shape.crosses, label)
				assert.equal(got.limit, shape.limit, label)
				if ("needed" in got) {
					assert.equal(got.needed, shape.measured(ir), label)
				}
				c.note(shape.crosses)
			}),
		oracle: {
			kind: "second-implementation",
			name: "each shape's measure by its built raw NFA, its walks, or its code points' set memberships"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/pattern-space.ts",
				original: "\tif (anchors > regexMaxAnchors) {",
				replacement: "\tif (anchors >= regexMaxAnchors) {",
				why: "A pattern with exactly as many moving anchors as the anchors limit allows is refused; the limits property fails."
			},
			{
				file: "packages/text/src/regex/ir.ts",
				original:
					'\t\t\t\t\treturn (n.max === "unbounded" && this.#zeroPathsOf(n.body).asserted) || of(n.body)',
				replacement: "\t\t\t\t\treturn of(n.body)",
				why: "A loop through an assertion the rewrite leaves is not refused as anchorLoop, so the arcs measure refuses it instead; the limits property fails."
			},
			{
				file: "packages/engine/src/ir/pattern-space.ts",
				original: "\t\t\tprinted.push(intervals)",
				replacement: "\t\t\tprinted.push(intervals.map(([lo, hi]): Interval => [lo, hi - 1]))",
				why: "The colors leave each printed set's last code point out of it; the raw NFA property's colors fail, and so does the limits property."
			}
		]
	})

/** The RFC 3986 URI-reference grammar as one pattern is admitted, and accepts exactly the strings ECMAScript's RegExp accepts, on strings over its alphabet and walks of its own NFA. Its budget is its suite's before it was a property (test/unit/text/compile-space.test.ts at 4ca3036a): 2000 runs and 2000 steered cases. */
export const theRFC3986URIReferenceGrammarAsOnePatternIsAdmittedAndAcceptsExactlyTheStringsECMAScriptsRegExpAcceptsOnStringsOverItsAlphabetAndWalksOfItsOwnNFA =
	property.explore(oneOf([parts, walked]), {
		needs: {},
		budget: { runs: 2000, steered: 2000 },
		situations: ["a member", "no member", "a walked member"] satisfies ReadonlyArray<
			ReachedOf<Membership>
		>,
		check:
			(_, n: Case<Membership>) =>
			({ value, walked: isWalk }) =>
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
				}),
		oracle: { kind: "second-implementation", name: "ECMAScript's own RegExp test" },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/nfa.ts",
				original:
					'this.edge(from, to, noCounts, (t, counts) => ({ kind: "start", to: t, counts }))\n\t\t\t\treturn\n\t\t\tcase "end":\n\t\t\t\tthis.edge(from, to, noCounts, (t, counts) => ({ kind: "end", to: t, counts }))\n\t\t\t\treturn',
				replacement:
					'this.edge(from, to, noCounts, (t, counts) => ({ kind: "end", to: t, counts }))\n\t\t\t\treturn\n\t\t\tcase "end":\n\t\t\t\tthis.edge(from, to, noCounts, (t, counts) => ({ kind: "start", to: t, counts }))\n\t\t\t\treturn',
				why: "Census mutant 7ce1806494 (packages/text/src/regex/nfa.ts, the builder's assertion edges), restated on the counting automaton: a `^` is built as a `$` edge and a `$` as a `^` edge; the property fails (the census, lane TESTPOLICY2; restated by lane TEXTSPEC)."
			}
		]
	})
