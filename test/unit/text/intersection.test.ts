/**
 * The intersection of two languages of whole texts as one node (packages/text/src/regex/intersection.ts), over drawn
 * pairs of nodes of no assertion over a small alphabet and drawn texts, random ones and words of either language:
 * the intersection holds a text exactly when both languages do, or is refused only where the second's DFA passes its
 * bound.
 *
 * Oracle: ECMAScript's RegExp test (test/support/regex.ts jsMatcher) of each language and of the intersection printed in
 * grizzle's grammar (print.ts printSource).
 *
 * Where one language strictly includes the other over the same alphabet (the first's alternation with the second
 * narrowed to the first's code points includes the first, and a drawn text the first lacks shows it strictly), the
 * intersection is the included node as it stands, the same canonical IR, never a product of it read through the other.
 *
 * Every language's texts of an even length are its intersection with the texts of an even length, whose DFA of two
 * states moves on every code point, so one side is read through the other's and each repetition's closure is drawn
 * from both states, each side read through the other's and the smaller reading kept; and its nonempty texts its intersection with the repetition of
 * one or more, whose accepting state loops on every code point, so a repetition read there is kept whole.
 *
 * Features: a text both hold, one only the first holds, one only the second holds, one neither holds, an empty
 * intersection, and an included side.
 */

import { charSet, intersection } from "@bjornpagen/grizzle-text/regex/charset"
import { alphabetOf, mapSets } from "@bjornpagen/grizzle-text/regex/folds"
import { intersect } from "@bjornpagen/grizzle-text/regex/intersection"
import {
	canonicalText,
	end,
	RegexBuilder,
	type RegexNode,
	seq,
	set,
	start
} from "@bjornpagen/grizzle-text/regex/ir"
import { regexDfaMaxStates, regexDfaMaxWork } from "@bjornpagen/grizzle-text/regex/limits"
import { printSource } from "@bjornpagen/grizzle-text/regex/print"
import { codePoints, codePointsText } from "@bjornpagen/grizzle-text/text"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsMatcher } from "#test/support/regex.ts"
import { stringsOver, wholeLanguageGen, wordOf } from "#test/support/unit/text/generators.ts"

type IntersectionFeature =
	| "both hold"
	| "only the first holds"
	| "only the second holds"
	| "neither holds"
	| "an empty intersection"
	| "an included side"

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
			"an empty intersection",
			"an included side"
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
				const swapped = intersect(k.right, k.left, limits)
				assert.ok(swapped.ok, "a small pair's intersection is within the DFA's bound")
				const ofBoth = holds(met.value)
				const ofSwapped = holds(swapped.value)
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
					assert.equal(
						ofSwapped(text),
						l && r,
						`${Formatter.format(text)}: the intersection, its sides swapped`
					)
				}
				const any = set(charSet(Arr.map(alphabet, (cp): readonly [number, number] => [cp, cp])))
				const builder = new RegexBuilder()
				const even = builder.repeat(seq([any, any]), 0, "unbounded")
				const nonempty = builder.repeat(any, 1, "unbounded")
				for (const [other, lengthHolds, what] of [
					[even, (n: number) => n % 2 === 0, "of an even length"],
					[nonempty, (n: number) => n > 0, "of one code point or more"]
				] as const) {
					for (const [a, b] of [
						[k.left, other],
						[other, k.left]
					] as const) {
						const read = intersect(a, b, limits)
						assert.ok(read.ok, "a small pair's intersection is within the DFA's bound")
						const ofRead = holds(read.value)
						for (const text of k.texts) {
							assert.equal(
								ofRead(text),
								ofLeft(text) && lengthHolds(codePoints(text).length),
								`${Formatter.format(text)}: the first language's texts ${what}`
							)
						}
					}
				}
				const within = alphabetOf(k.left)
				const wider = new RegexBuilder().alt([
					k.left,
					mapSets(k.right, (s) => set(intersection(s, within)))
				])
				const ofWider = holds(wider)
				if (Arr.some(k.texts, (text) => ofWider(text) && !ofLeft(text))) {
					for (const [a, b] of [
						[k.left, wider],
						[wider, k.left]
					] as const) {
						const kept = intersect(a, b, limits)
						assert.ok(kept.ok, "a small pair's intersection is within the DFA's bound")
						assert.equal(
							canonicalText(kept.value),
							canonicalText(k.left),
							"the intersection of a language and one that strictly includes it is the included one as it stands"
						)
					}
					c.note("an included side")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's RegExp test of each language and of the intersection"
		},
		budget: { runs: 400, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/text/intersection.test.ts#theIntersectionOfTwoLanguagesOfWholeTextsHoldsATextExactlyWhenBothDo:-:3.2.0.3.2.0.3.2.0.0.0.1.2.2.3.0.0.1.2.1.2.1.0.2.2.2.2.2.2.1.2.0.0.0.2.1.0.2.2.0.2.2.0.2.2.5.2.1.2.0.1.1.1.0.0.0.0.0.0.0.0.1.1.1.0.1.1.2.0.0.0.1.1.1.1.0.0.1.0.1.1.1.0.0.0.1.1.1.1.0.0.0.0.0.0.0.1.2.0.1.1.1.1.1.1.1.0.1.1.1.0.1.1.0.0.1.2.1.1.1.1.1.1.0.0.1.0.1.1.0.1.1.1.1.0.1.0.0.0.0.0.0.1.0.1.1.0.0.0.0.1.2.2.1.1.1.1.0.1.1.2.0.1.0.0.1.1.0.1.1.2.1.1.1.0.0.1.1.2.1.0.1.0.2.1.0.1.0.0.0.1.2.1.0.0.0.0.0.1.2.0.1.1.2.0.1.0.0.0.1.0.2.0.1.0.1.0.2.2.0.0.1.1.1.1.0.1.2.0.0.0.0.2.0.0.0.0.1.1.1.0.0.0.0.0.0.1.0.3.0.0.0.0.1.0.6.4.0.2.0.0.0.2.0.2.3.1.2xg.1.r1q.0.0.3.0.2.0.0.0.0.4.0.2.0.1.0.0.0.2.5.0.2.0.1.1.z37.2.82x.0.0.6.0.0.0.1.2.k2u5.0.1.0.2.0.1"
				),
				reason:
					"nested unbounded repetitions, ((([ab]){2,}){2,}){2,}, whose texts of an even length read through the two states are exponential in the nesting",
				since: "2026-11-21"
			}
		],
		kills: [
			{
				file: "packages/text/src/regex/intersection.ts",
				original: "new Map([[from, builder.repeat(n.body, 0, more)]])",
				replacement: "new Map([[from, builder.repeat(n.body, 1, more)]])",
				why: "A repetition's rest kept whole at a state it loops at must run at least once: the words that stop at its least count are dropped."
			},
			{
				file: "packages/text/src/regex/intersection.ts",
				original: "\tif (mineInTheirs || theirsInMine) {",
				replacement: "\tif (false) {",
				why: "An included side is read through the other's DFA as a product: the intersection is the same language and no longer the included node."
			},
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
				original: '\tconst returns = builder.repeat(cell(fromState, 0), 0, "unbounded")',
				replacement: '\tconst returns = builder.repeat(cell(fromState, 0), 1, "unbounded")',
				why: "An unbounded repetition's closure loses its empty word: a word that iterates it no time is dropped."
			},
			{
				file: "packages/text/src/regex/intersection.ts",
				original: "\t\tofThroughMine < ofThroughTheirs ||",
				replacement: "\t\tfalse ||",
				why: "Each side is read through the DFA of fewer states whatever the reading's size: ((([ab]){2,}){2,}){2,}'s texts of an even length are 64,198 bytes of nested repetitions read through the two states, which ECMAScript's backtracking does not decide within the case's deadline on an odd text, where the even texts read through its own DFA are 92 bytes."
			}
		]
	})
