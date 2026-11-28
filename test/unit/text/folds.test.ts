/**
 * The regex IR's folds (packages/text/src/regex/folds.ts, ir.ts RegexBuilder.firstIn), over admitted patterns of each
 * family's alphabet, each read as a whole text, `^(?:pattern)$`, with a drawn set of code points and drawn texts:
 *
 * - firstIn narrows the pattern to exactly its nonempty texts whose first code point lies in the set, and lastIn to
 *   those whose last does;
 * - reversed holds exactly the pattern's texts read backwards;
 * - alphabetOf holds every code point of every text the pattern holds;
 * - mapSets, each set narrowed to the drawn set, holds exactly the pattern's texts whose every code point lies in it.
 *
 * Oracle: ECMAScript's RegExp test (test/support/regex.ts jsMatcher) of the pattern as written and of each fold printed in
 * grizzle's grammar (print.ts printSource), against the definitions restated over the text's code points.
 *
 * - firstIn of a node every match of which consumes, over the node's own alphabet, is the node itself, as it stands.
 *
 * Features: a text held and refused by each fold; a fold that keeps every text and one that keeps none; a node its own
 * firstIn.
 */

import { charSet, has, intersection } from "@bjornpagen/grizzle-text/regex/charset"
import { alphabetOf, lastIn, mapSets, reversed } from "@bjornpagen/grizzle-text/regex/folds"
import {
	end,
	RegexBuilder,
	type RegexNode,
	seq,
	set,
	start
} from "@bjornpagen/grizzle-text/regex/ir"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { printSource } from "@bjornpagen/grizzle-text/regex/print"
import { codePoints, codePointsText } from "@bjornpagen/grizzle-text/text"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsMatcher } from "#test/support/regex.ts"
import { admittedPatternOver, families, stringsOver } from "#test/support/unit/text/generators.ts"

type FoldFeature =
	| "firstIn held"
	| "firstIn refused"
	| "lastIn held"
	| "lastIn refused"
	| "reversed held"
	| "mapSets held"
	| "mapSets refused"
	| "a fold of no text"
	| "a node its own firstIn"

interface FoldCase {
	readonly pattern: string
	readonly within: ReadonlyArray<number>
	readonly texts: ReadonlyArray<string>
}

/** An admitted pattern over a family's alphabet, a subset of that alphabet, and texts over it. */
const foldCaseGen: Gen<FoldCase> = (source) => {
	const { alphabet } = source.draw(element(families))
	const pattern = source.draw(admittedPatternOver(alphabet))
	const within = Arr.filter(alphabet, () => source.draw(boolean))
	const texts = source.draw(array(stringsOver(element(alphabet), 6), { min: 4, max: 12 }))
	return {
		pattern,
		within,
		texts: [...texts, source.draw(stringsOver(element(alphabet), source.draw(int(1, 3))))]
	}
}

/** Whether a node holds a whole text, by ECMAScript's test of the node printed in grizzle's grammar. */
const holds = (node: RegexNode): ((text: string) => boolean) =>
	node.kind === "never"
		? () => false
		: jsMatcher(
				printSource(node, (s) => s),
				"u"
			)

/** The whole-text reading of a node: `^(?:node)$`. */
const whole = (node: RegexNode): RegexNode => seq([start, node, end])

/** The regex IR's folds read every text as their definitions state it. */
export const theRegexIRsFoldsNarrowReverseAndMapAPatternExactlyAsTheirDefinitionsReadItsTexts =
	property.explore(foldCaseGen, {
		needs: {},
		situations: [
			"firstIn held",
			"firstIn refused",
			"lastIn held",
			"lastIn refused",
			"reversed held",
			"mapSets held",
			"mapSets refused",
			"a fold of no text",
			"a node its own firstIn"
		] satisfies ReadonlyArray<Reached<FoldFeature>>,
		check: (_, c: Case<FoldFeature>) => (k) =>
			Effect.sync(() => {
				const parsed = parsePattern(k.pattern, "u")
				assert.ok(parsed.ok, `/${k.pattern}/u parses`)
				const node = whole(parsed.value)
				const within = charSet(Arr.map(k.within, (cp): readonly [number, number] => [cp, cp]))
				const builder = new RegexBuilder()
				const first = builder.firstIn(node, within)
				const last = lastIn(node, within)
				const mirror = reversed(node)
				const narrowed = mapSets(node, (s) => set(intersection(s, within)))
				const alphabet = alphabetOf(node)
				if (builder.zeroPart(node).kind === "never") {
					assert.equal(
						builder.firstIn(node, alphabet),
						node,
						`/${k.pattern}/u: a node every match of which consumes is its own firstIn over its alphabet`
					)
					c.note("a node its own firstIn")
				}
				if (first.kind === "never" || last.kind === "never" || narrowed.kind === "never") {
					c.note("a fold of no text")
				}
				const original = holds(node)
				const ofFirst = holds(first)
				const ofLast = holds(last)
				const ofMirror = holds(mirror)
				const ofNarrowed = holds(narrowed)
				for (const text of k.texts) {
					const points = codePoints(text)
					const shown = `/${k.pattern}/u over ${Formatter.format(text)}, within ${Formatter.format(k.within)}`
					const member = original(text)
					const head = points[0]
					const tail = points.at(-1)
					const firstHeld = member && head !== undefined && has(within, head)
					assert.equal(ofFirst(text), firstHeld, `${shown}: firstIn`)
					c.note(firstHeld ? "firstIn held" : "firstIn refused")
					const lastHeld = member && tail !== undefined && has(within, tail)
					assert.equal(ofLast(text), lastHeld, `${shown}: lastIn`)
					c.note(lastHeld ? "lastIn held" : "lastIn refused")
					assert.equal(ofMirror(codePointsText(Arr.reverse(points))), member, `${shown}: reversed`)
					if (member) {
						c.note("reversed held")
						for (const cp of points) {
							assert.ok(has(alphabet, cp), `${shown}: alphabetOf holds ${cp}`)
						}
					}
					const mapped = member && Arr.every(points, (cp) => has(within, cp))
					assert.equal(ofNarrowed(text), mapped, `${shown}: mapSets`)
					c.note(mapped ? "mapSets held" : "mapSets refused")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's RegExp test of the pattern and of each fold, against each fold's definition over the text's code points"
		},
		budget: { runs: 400, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/ir.ts",
				original:
					'\t\t\t\tthis.zeroPart(n).kind === "never" &&\n\t\t\t\tsize(intersection(firsts, within)) === size(firsts)',
				replacement:
					"\t\t\t\tfalse &&\n\t\t\t\tsize(intersection(firsts, within)) === size(firsts)",
				why: "firstIn rebuilds a node it narrows nothing of: the node is no longer itself, and every collapse and token fold over it grows."
			},
			{
				file: "packages/text/src/regex/ir.ts",
				original: "\t\t\t\t\tconst kept = intersection(n.set, within)",
				replacement: "\t\t\t\t\tconst kept = n.set",
				why: "firstIn keeps a set whole: a text whose first code point lies outside the set is kept."
			},
			{
				file: "packages/text/src/regex/folds.ts",
				original: "\t\t\t\treturn seq(n.items.map((item) => of(item)).toReversed())",
				replacement: "\t\t\t\treturn seq(n.items.map((item) => of(item)))",
				why: "reversed keeps a sequence's order: a text of two parts reads backwards as the parts in their own order, and lastIn narrows the first code point."
			},
			{
				file: "packages/text/src/regex/folds.ts",
				original:
					'\t\t\tcase "start":\n\t\t\t\treturn end\n\t\t\tcase "end":\n\t\t\t\treturn start',
				replacement:
					'\t\t\tcase "start":\n\t\t\t\treturn start\n\t\t\tcase "end":\n\t\t\t\treturn end',
				why: "reversed keeps each assertion where it stands, so a whole text's mirror is anchored at no end it reads."
			},
			{
				file: "packages/text/src/regex/folds.ts",
				original:
					'\t\t\tcase "repeat":\n\t\t\t\treturn of(n.body)\n\t\t\tcase "empty":\n\t\t\tcase "start":\n\t\t\tcase "end":\n\t\t\tcase "never":\n\t\t\t\treturn []',
				replacement:
					'\t\t\tcase "repeat":\n\t\t\t\treturn []\n\t\t\tcase "empty":\n\t\t\tcase "start":\n\t\t\tcase "end":\n\t\t\tcase "never":\n\t\t\t\treturn []',
				why: "alphabetOf drops a repetition's code points."
			},
			{
				file: "packages/text/src/regex/folds.ts",
				original: '\t\t\tcase "set":\n\t\t\t\treturn map(n.set)',
				replacement: '\t\t\tcase "set":\n\t\t\t\treturn n',
				why: "mapSets leaves a set unmapped, so a text of a code point outside the drawn set is kept."
			}
		]
	})
