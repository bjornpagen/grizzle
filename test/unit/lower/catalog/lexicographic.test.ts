/**
 * The lexicographic recognizer (lower/shapes/catalog/lexicographic.ts), whose decision diagram replaced an enumeration
 * of every sign vector over at most six pairs, against that enumeration as the oracle: on every generated predicate
 * over at most six pairs, any Boolean arrangement of native comparisons between paired fields, the lexicographic
 * spellings and their perturbations among them, the recognizer finds exactly the order, directions and inclusiveness
 * the enumeration finds, or, with it, none. Past six pairs, where the enumeration refused, the nested spelling of any
 * order is still recognized as itself. A predicate any of whose parts is a native test of a pair that compares no order,
 * a prefix test of its text fields, is no lexicographic order, whatever the rest of it is. And a predicate nested a
 * hundred thousand connectives deep, which a recursion would overflow the call stack on, is recognized or refused
 * exactly as the shallow predicate it is equivalent to.
 *
 * Oracle: the enumeration of every sign vector the recognizer replaced, a second implementation, over up to six pairs;
 * past six, the order the nested spelling was built from; and the deep predicate's shallow equivalent, a metamorphic
 * relation.
 *
 * Features: recognized or not, inclusive or strict, several pairs ordered, a prefix test among the parts.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, int } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { directions } from "#compiler/core/order.ts"
import { lexicographicOrder } from "#compiler/lower/shapes/catalog/lexicographic.ts"
import { assert } from "#test/support/assert.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	caseExpr,
	caseGen,
	classify,
	deepened,
	deepGen,
	expectedOf,
	exprOf,
	type LexFeature,
	nested
} from "#test/unit/lower/catalog/lexicographic.fixtures.ts"

/** The lexicographic recognizer decides every arrangement of up to six pairs exactly as the enumeration of every sign vector does. */
export const theLexicographicRecognizerDecidesEveryArrangementOfUpToSixPairsExactlyAsTheEnumerationOfEverySignVectorDoes =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"recognized",
			"not lexicographic",
			"inclusive",
			"strict",
			"several pairs ordered",
			"a prefix test among the parts"
		] satisfies ReadonlyArray<Reached<LexFeature>>,
		check: (_, c: CaseOf<LexFeature>) => (k) =>
			Effect.sync(() => {
				const expected = expectedOf(k)
				const got = lexicographicOrder(caseExpr(k, "p"), classify)
				assert.deepEqual(got, expected)
				if (k.kind === "prefixed") {
					c.note("a prefix test among the parts")
				}
				if (expected === undefined) {
					c.note("not lexicographic")
					return
				}
				c.note("recognized")
				c.note(expected.inclusive ? "inclusive" : "strict")
				if (expected.order.length > 1) {
					c.note("several pairs ordered")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the enumeration of every sign vector of the pairs a predicate compares"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/catalog/lexicographic.ts",
				original: '\t\treturn { kind: "atom", pair: index, cmp: lc.side === "b" ? fn : flip[fn] }',
				replacement:
					'\t\treturn { kind: "atom", pair: index, cmp: (lc.side === "b") !== (index === 1) ? fn : flip[fn] }',
				why: "The parser reads the direction of the second pair it parses backwards; the oracle and the wide searches fail."
			}
		]
	})

/** The lexicographic recognizer recognizes the nested spelling of any order of seven to ten pairs, past the enumeration's six. */
export const theLexicographicRecognizerRecognizesTheNestedSpellingOfAnyOrderOfSevenToTenPairsPastTheEnumerationsSix =
	property.explore(
		(source) => {
			const pairs = source.draw(int(7, 10))
			return {
				order: upTo(pairs, (pair) => ({
					pair,
					dir: source.draw(element(directions))
				})),
				inclusive: source.draw(boolean)
			}
		},
		{
			needs: {},
			situations: ["inclusive", "strict"] satisfies ReadonlyArray<Reached<"inclusive" | "strict">>,
			check: (_, c: CaseOf<"inclusive" | "strict">) => (s) =>
				Effect.sync(() => {
					c.note(s.inclusive ? "inclusive" : "strict")
					assert.deepEqual(
						lexicographicOrder(exprOf(nested(s.order, s.inclusive), "p"), classify),
						{
							order: Arr.map(s.order, (o) => ({
								b: `b${o.pair}`,
								a: `a${o.pair}`,
								dir: o.dir
							})),
							inclusive: s.inclusive
						}
					)
				}),
			oracle: {
				kind: "specification",
				name: "the order and inclusiveness the nested spelling was built from"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/catalog/lexicographic.ts",
					original:
						'\t\treturn { kind: "atom", pair: index, cmp: lc.side === "b" ? fn : flip[fn] }',
					replacement:
						'\t\treturn { kind: "atom", pair: index, cmp: (lc.side === "b") !== (index === 1) ? fn : flip[fn] }',
					why: "The parser reads the direction of the second pair it parses backwards; the oracle and the wide searches fail."
				}
			]
		}
	)

/** The lexicographic recognizer recognizes or refuses a predicate nested a hundred thousand connectives deep exactly as its shallow equivalent. */
export const theLexicographicRecognizerRecognizesOrRefusesAPredicateNestedAHundredThousandConnectivesDeepExactlyAsItsShallowEquivalent =
	property.explore(deepGen, {
		needs: {},
		situations: ["recognized", "not lexicographic"] satisfies ReadonlyArray<
			Reached<"recognized" | "not lexicographic">
		>,
		check: (_, c: CaseOf<"recognized" | "not lexicographic">) => (s) =>
			Effect.sync(() => {
				const shallow = lexicographicOrder(exprOf(s.tree, "p"), classify)
				c.note(shallow === undefined ? "not lexicographic" : "recognized")
				assert.deepEqual(lexicographicOrder(deepened(s.tree, s.pattern), classify), shallow)
			}),
		oracle: {
			kind: "universal",
			name: "a predicate deepened by wrappers that keep its function decides as its shallow self"
		},
		kept: [],
		kills: []
	})
