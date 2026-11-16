/**
 * A pattern no text matches, decided by the IR (scalar/regex/ir.ts): its constructors make a node the empty language
 * exactly when none of its paths can match, an empty class's or an order of anchors no match passes (`^$a`). The oracle
 * is a search of the pattern's own NFA, written here and blind to the IR's profiles: the pattern is spelled again with
 * each `^` and `$` a pair of marks, private-use code points no family holds, so its parse keeps every path an anchor
 * would make impossible; each mark's edge is then read back as its anchor's, and a reachability over (state, consumed a
 * code point, passed a `$`) follows walk's rules (generators.ts walk): a `^` only before the first code point, no code
 * point after a `$`. The IR is never, and matchPattern and analyzeText refuse the pattern as UnsupportedOperation at the
 * pattern, exactly when the search reaches no accepting state; a path it finds spells a member, which ECMAScript's own
 * test accepts, and a path that breaks the rules spells a text the pattern rejects when it is empty.
 *
 * Features: empty through an anchor, through a class, and past the DFA bounds; non-empty with an inner anchor and past
 * the DFA bounds.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, String as Str } from "effect"
import { matchPattern } from "#compiler/scalar/regex/admit.ts"
import { minimalDfa } from "#compiler/scalar/regex/dfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, succeeded } from "#test/support/assert.ts"
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
import { type Flags, jsMatcher } from "#test/unit/text/generators.ts"

/** A pattern no text matches is never in the IR, and refused by matchPattern and analyzeText, exactly when no way through its NFA can match. Its budget is its suite's before it was a property (test/unit/text/emptiness.test.ts at 4ca3036a): 600 runs and 1000 steered cases. */
export const aPatternNoTextMatchesIsNeverInTheIRAndRefusedByMatchPatternAndAnalyzeTextExactlyWhenNoWayThroughItsNFACanMatch =
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
							judged(matchPattern(source, loc), empty, `matchPattern ${label}`)
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
					file: "packages/engine/src/scalar/regex/ir.ts",
					original: '\t\tif (item.kind === "never") {\n\t\t\treturn never',
					replacement: '\t\tif (item.kind === "never") {\n\t\t\tcontinue',
					why: "A sequence passes over an item no text matches, as if it matched the empty text; the property fails."
				}
			]
		}
	)
