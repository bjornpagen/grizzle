/**
 * A pattern no text matches, decided by the IR (scalar/regex/ir.ts): its constructors make a node the empty language
 * exactly when none of its paths can match, an empty class's or an order of anchors no match passes (`^$a`). The oracle
 * is a search of the pattern's own NFA, written here and blind to the IR's profiles: the pattern is spelled again with
 * each `^` and `$` a pair of marks, private-use code points no family holds, so its parse keeps every path an anchor
 * would make impossible; each mark's edge is then read back as its anchor's, and a reachability over (state, consumed a
 * code point, passed a `$`) follows walk's rules (generators.ts walk): a `^` only before the first code point, no code
 * point after a `$`. The IR is never, and analyzeText refuses the pattern as UnsupportedOperation at the pattern, which no
 * value of a refinement could hold, exactly when the search reaches no accepting state; matchPattern then admits it, the
 * empty language, which Text.matches holds of no text: its ARE is the empty language's (print.ts emptyLanguageAre) and
 * the host's match of it fails on every text. A path the search finds spells a member, which ECMAScript's own test
 * accepts, and a path that breaks the rules spells a text the pattern rejects when it is empty.
 *
 * Features: empty through an anchor, through a class, and past the DFA bounds; non-empty with an inner anchor and past
 * the DFA bounds.
 */

import { minimalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { emptyLanguageAre } from "@bjornpagen/grizzle-text/regex/print"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached as ReachedOf } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { matchAre, matchPattern } from "#compiler/scalar/regex/admit.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsMatcher } from "#test/support/regex.ts"
import { type Flags } from "#test/support/unit/text/generators.ts"
import {
	caseGen,
	classEmptiedGen,
	dfaLimits,
	type Emptiness,
	judged,
	loc,
	pastBoundsMisanchoredGen,
	patternNfa,
	searchOf
} from "#test/unit/text/emptiness.fixtures.ts"

/** A pattern no text matches is never in the IR, refused by analyzeText and admitted by matchPattern as matching no text, exactly when no way through its NFA can match. Its budget is its suite's before it was a property (test/unit/text/emptiness.test.ts at 4ca3036a): 600 runs and 1000 steered cases. */
export const aPatternNoTextMatchesIsNeverInTheIRRefusedByAnalyzeTextAndMatchedByNoTextExactlyWhenNoWayThroughItsNFACanMatch =
	property.explore(
		aimed<readonly [source: string, flags: Flags], Emptiness>(caseGen, [
			["empty through a class", classEmptiedGen],
			["empty past the DFA bounds", pastBoundsMisanchoredGen]
		]),
		{
			needs: {},
			budget: { runs: 600, steered: 1000 },
			situations: [
				"empty through an anchor",
				"empty through a class",
				"empty past the DFA bounds",
				"non-empty with an inner anchor",
				"non-empty past the DFA bounds"
			] satisfies ReadonlyArray<ReachedOf<Emptiness>>,
			check:
				(_, c: Case<Emptiness>) =>
				([source, flags]) =>
					Effect.sync(() => {
						const label = `/${source}/${flags}`
						const ir = succeeded(parsePattern(source, flags), label)
						const nfa = patternNfa(source, flags)
						const { member, broken } = searchOf(nfa)
						const ofPattern = jsMatcher(source, flags)
						const empty = member === undefined
						assert.equal(ir.kind === "never", empty, `${label} is never exactly when it is empty`)
						if (member !== undefined) {
							assert.equal(ofPattern(member), true, `${label} matches ${Formatter.format(member)}`)
						}
						if (empty && broken !== undefined) {
							assert.equal(ofPattern(broken), false, `${label} rejects ${Formatter.format(broken)}`)
						}
						const analyzed = analyzeText([{ source, flags }], loc)
						judged(analyzed, empty, `analyzeText ${label}`)
						if (flags === "u") {
							const admitted = matchPattern(source, loc)
							if (empty) {
								succeeded(admitted, `matchPattern ${label} admits the empty language`)
								assert.equal(
									matchAre(source),
									emptyLanguageAre,
									`${label} prints as the empty language's ARE`
								)
								const reads = new CompilePatterns()
								for (const text of Arr.filter(
									[member, broken, "", source],
									(t) => t !== undefined
								)) {
									assert.equal(
										reads.matches(source, text),
										false,
										`${label} matches no text, ${Formatter.format(text)} among them`
									)
								}
							} else {
								judged(admitted, false, `matchPattern ${label}`)
							}
						}
						if (empty) {
							c.note(broken === undefined ? "empty through a class" : "empty through an anchor")
							if (broken !== undefined && minimalDfa(nfa, dfaLimits).kind === "bounded") {
								c.note("empty past the DFA bounds")
							}
							return
						}
						if (broken !== undefined) {
							c.note("non-empty with an inner anchor")
						}
						if (analyzed.ok && Str.startsWith("ir:")(analyzed.value.key)) {
							c.note("non-empty past the DFA bounds")
						}
					}),
			oracle: {
				kind: "second-implementation",
				name: "a reachability over the NFA of the pattern's spelling with its anchors as marks, and ECMAScript's own test of what it spells"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/pattern.ts",
					original: "\tResult.map(admitIr(spelling, matchFlags), (ir) =>\n",
					replacement:
						'\tResult.map(Result.flatMap(admitIr(spelling, matchFlags), (ir) => ir.kind === "never" ? Result.err({ kind: "compileSpace", measure: { kind: "anchorLoop" } }) : Result.ok(ir)), (ir) =>\n',
					why: "A Text.matches pattern of the empty language is refused again, as no text matching it; the property fails."
				},
				{
					file: "packages/text/src/regex/ir.ts",
					original: '\t\tif (item.kind === "never") {\n\t\t\treturn never',
					replacement: '\t\tif (item.kind === "never") {\n\t\t\tcontinue',
					why: "A sequence passes over an item no text matches, as if it matched the empty text; the property fails."
				}
			]
		}
	)
