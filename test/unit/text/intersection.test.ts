/**
 * The intersection of two languages of whole texts as one node (packages/text/src/regex/intersection.ts), over drawn
 * pairs of nodes of no assertion over a small alphabet and drawn texts, random ones and words of either language:
 * the intersection holds a text exactly when both languages do, or is refused only where the second's DFA passes its
 * bound.
 *
 * Oracle: ECMAScript's RegExp test (generators.ts jsMatcher) of each language and of the intersection printed in
 * grizzle's grammar (print.ts printSource).
 *
 * Features: a text both hold, one only the first holds, one only the second holds, one neither holds, and an empty
 * intersection.
 */

import { intersect } from "@bjornpagen/grizzle-text/regex/intersection"
import { end, type RegexNode, seq, start } from "@bjornpagen/grizzle-text/regex/ir"
import { printSource } from "@bjornpagen/grizzle-text/regex/print"
import { codePointsText } from "@bjornpagen/grizzle-text/text"
import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { regexDfaMaxStates, regexDfaMaxWork } from "#compiler/scalar/regex/inclusion.ts"
import { assert } from "#test/support/assert.ts"
import { jsMatcher, stringsOver, wholeLanguageGen, wordOf } from "#test/unit/text/generators.ts"

type IntersectionFeature =
	| "both hold"
	| "only the first holds"
	| "only the second holds"
	| "neither holds"
	| "an empty intersection"

/** The alphabet a case draws its languages and texts over. */
const alphabet: Arr.NonEmptyReadonlyArray<number> = [0x61, 0x62, 0x63]

interface IntersectionCase {
	readonly left: RegexNode
	readonly right: RegexNode
	readonly texts: ReadonlyArray<string>
}

const intersectionCaseGen: Gen<IntersectionCase> = (source) => {
	const left = source.draw(wholeLanguageGen(alphabet, 3))
	const right = source.draw(wholeLanguageGen(alphabet, 3))
	const words = [
		...source.draw(array(wordOf(left), { min: 3, max: 6 })),
		...source.draw(array(wordOf(right), { min: 3, max: 6 }))
	]
	return {
		left,
		right,
		texts: [
			...source.draw(array(stringsOver(element(alphabet), 6), { min: 4, max: 10 })),
			...Arr.map(words, (word) => codePointsText(word))
		]
	}
}

/** Whether a node holds a whole text, by ECMAScript's test of `^(?:node)$` printed in grizzle's grammar. */
const holds = (node: RegexNode): ((text: string) => boolean) => {
	const whole = seq([start, node, end])
	return whole.kind === "never"
		? () => false
		: jsMatcher(
				printSource(whole, (s) => s),
				"u"
			)
}

/** The bound of the second language's DFA: the text analysis' own. */
const limits = Object.freeze({ maxStates: regexDfaMaxStates, maxWork: regexDfaMaxWork })

/** The intersection of two languages of whole texts holds a text exactly when both do. */
export const theIntersectionOfTwoLanguagesOfWholeTextsHoldsATextExactlyWhenBothDo =
	property.explore(intersectionCaseGen, {
		needs: {},
		situations: [
			"both hold",
			"only the first holds",
			"only the second holds",
			"neither holds",
			"an empty intersection"
		] satisfies ReadonlyArray<Reached<IntersectionFeature>>,
		check: (_, c: Case<IntersectionFeature>) => (k) =>
			Effect.sync(() => {
				const met = intersect(k.left, k.right, limits)
				assert.ok(met.ok, "a small pair's intersection is within the DFA's bound")
				if (met.value.kind === "never") {
					c.note("an empty intersection")
				}
				const ofLeft = holds(k.left)
				const ofRight = holds(k.right)
				const ofBoth = holds(met.value)
				for (const text of k.texts) {
					const l = ofLeft(text)
					const r = ofRight(text)
					c.note(
						l && r
							? "both hold"
							: l
								? "only the first holds"
								: r
									? "only the second holds"
									: "neither holds"
					)
					assert.equal(ofBoth(text), l && r, `${Formatter.format(text)}: the intersection`)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's RegExp test of each language and of the intersection"
		},
		budget: { runs: 400, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/intersection.ts",
				original: "\t\tif (keepsWhere(n, state)) {",
				replacement: "\t\tif (true) {",
				why: "Every subtree stays whole at every state, as if every code point kept the automaton where it is: the intersection is the first language."
			},
			{
				file: "packages/text/src/regex/intersection.ts",
				original: "(dfa.states[state]?.accept === true ? [words] : [])",
				replacement: "[words]",
				why: "The first language's words read to any state count, accepting or not: the intersection holds a text only the first holds."
			},
			{
				file: "packages/text/src/regex/intersection.ts",
				original:
					"\tconst out = new Map<number, RegexNode>([[state, builder.alt([empty, cell(fromState, 0)])]])",
				replacement: "\tconst out = new Map<number, RegexNode>([[state, cell(fromState, 0)]])",
				why: "An unbounded repetition's closure loses its empty word: a word that iterates it no time is dropped."
			}
		]
	})
