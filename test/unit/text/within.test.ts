/**
 * A text type's guarantee of another, decided by their automata (scalar/regex/inclusion.ts languageIncludes, read by
 * check/refinement guarantees): its language within its byte bound lies inside the other's language (regex/within.ts
 * includedWithin, a walk of the two canonical DFAs' product, each pair at the fewest bytes a prefix reaching it takes),
 * and none of those values passes the other's byte bound (dfa.ts longestWithin within the inner bound; regex/within.ts
 * exceedsBytes where the inner type has none, at the bound plus four bytes a state). An inclusion of the languages alone
 * misses a bound that cuts the inner language inside the outer: metis's LearnerId of 69 bytes, `^.+$`, is a Timeback
 * user of 255 characters, `^.{1,255}$`, only within its bound, and before this every variable joining the two was
 * refused or typed by the order of its matches.
 *
 * Searches over an alphabet of characters of one to four UTF-8 bytes:
 *
 * - **the bounded inclusion:** a refutation's witness is a member of the inner conjunction within the bound that
 *   ECMAScript finds outside the outer pattern, and an inclusion leaves no such text among every text of the alphabet
 *   within the bound and walks of the inner members;
 * - **the byte excess:** a language holds a member past a bound exactly where its inclusion in every text within the
 *   bound (a DFA of byte counts, the second implementation) is refuted;
 * - **the guarantee:** over whole-value patterns of the alphabet's characters alone, every value of a bounded type is a
 *   text the brute force enumerates, so the judgment holds exactly where every such text of the inner language lies in
 *   the outer within its bound, in both directions.
 *
 * Oracles: ECMAScript's membership and brute force over every text within the bound; the product with the byte-count
 * DFA (inclusion.ts included); exhaustive brute force over the inner type's values.
 *
 * - **the casts:** a cast into a type holding every value of its operand is proved by the same judgment, a LearnerId's
 *   into a Timeback user's among them, and the reverse refused.
 *
 * Features: included, refuted and cut by the bound; exceeds and within; guaranteed, not guaranteed and refuted by the
 * bytes alone; proved and refused casts. A verdict past the analysis's bounds decides nothing and is held to nothing.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Option } from "effect"
import {
	type CastFeature,
	castCaseGen,
	castCompiles,
	cutByBound,
	type ExceedsFeature,
	exceedsCaseGen,
	exceedsVerdicts,
	type GuaranteeFeature,
	guaranteeCaseGen,
	guaranteeTruth,
	guaranteeVerdict,
	outsideWithin,
	type WithinFeature,
	withinCaseGen,
	withinVerdict,
	witnessHolds
} from "#test/unit/text/within.fixtures.ts"

/**
 * A language within a byte bound is included in another exactly where no member within the bound falls outside it, a
 * refutation naming one.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aLanguageWithinAByteBoundIsIncludedExactlyWhereNoMemberWithinItFallsOutside =
	property.explore(withinCaseGen, {
		needs: {},
		situations: ["included", "refuted", "cut by the bound"] satisfies ReadonlyArray<
			Reached<WithinFeature>
		>,
		check: (_, k: Case<WithinFeature>) => (c) =>
			Effect.sync(() => {
				const verdict = withinVerdict(c)
				switch (verdict.kind) {
					case "bounded":
						return
					case "refuted":
						k.note("refuted")
						assert.ok(
							witnessHolds(c, verdict.witness),
							`${Formatter.format(c)}: the witness ${Formatter.format(verdict.witness)} is a member of the inner conjunction within ${String(c.octets)} bytes outside the outer pattern`
						)
						return
					case "included": {
						k.note("included")
						if (cutByBound(c)) {
							k.note("cut by the bound")
						}
						const outside = outsideWithin(c)
						assert.deepEqual(
							outside,
							[],
							`${Formatter.format(c)}: an inclusion within ${String(c.octets)} bytes leaves no member of the inner conjunction outside the outer pattern`
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "ECMAScript's membership: a witness within the bound in the inner conjunction and outside the outer pattern, none among every text within the bound and the inner members' walks for an inclusion"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/within.ts",
				original:
					'\tif (inner.states.length === 0) {\n\t\treturn { kind: "included" }\n\t}\n\tconst initial',
				replacement:
					'\tif (inner.states.length >= 0) {\n\t\treturn { kind: "included" }\n\t}\n\tconst initial',
				why: "Every bounded inclusion holds: a language with a member within the bound outside the other is called included."
			},
			{
				file: "packages/text/src/regex/within.ts",
				original:
					'\tif (inner.states.length === 0) {\n\t\treturn { kind: "included" }\n\t}\n\tconst initial',
				replacement:
					'\tif (inner.states.length >= 0) {\n\t\treturn { kind: "refuted", witness: "" }\n\t}\n\tconst initial',
				why: "Every bounded inclusion is refuted by the empty text, which no inner conjunction that requires a character holds."
			}
		]
	})

/**
 * A language holds a member past a byte bound exactly where its inclusion in every text within the bound is refuted.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aLanguageHoldsAMemberPastAByteBoundExactlyWhereItsInclusionInTheBoundIsRefuted =
	property.explore(exceedsCaseGen, {
		needs: {},
		situations: ["exceeds", "within"] satisfies ReadonlyArray<Reached<ExceedsFeature>>,
		check: (_, k: Case<ExceedsFeature>) => (c) =>
			Effect.sync(() => {
				const verdicts = exceedsVerdicts(c)
				if (Option.isNone(verdicts)) {
					return
				}
				const { verdict, reference } = verdicts.value
				if (verdict.kind === "bounded" || reference.kind === "bounded") {
					return
				}
				k.note(verdict.kind)
				assert.equal(
					verdict.kind === "exceeds",
					reference.kind === "refuted",
					`${Formatter.format(c)}: the language holds a member past ${String(c.octets)} bytes exactly where its inclusion in every text within them is refuted (${reference.kind})`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the language's inclusion in the canonical DFA of every text within the bound (inclusion.ts included)"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/within.ts",
				original: "\t\t: longest.bytes > octets\n",
				replacement: "\t\t: longest.bytes >= 0\n",
				why: "Every language exceeds every bound."
			},
			{
				file: "packages/text/src/regex/within.ts",
				original: "\t\t: longest.bytes > octets\n",
				replacement: "\t\t: longest.bytes < 0\n",
				why: "No language exceeds a bound."
			},
			{
				file: "packages/text/src/regex/within.ts",
				original: "octets + 4 * dfa.states.length",
				replacement: "octets + 1",
				why: "A member past the bound by more than one byte, of no shorter member past it, is missed: a language of one four-byte character at a bound of two."
			}
		]
	})

/**
 * A text type guarantees another exactly where every value within its bound is a value of the other, its language's and
 * within its bound: the judgment and the exhaustive brute force agree in both directions.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aTextTypeGuaranteesAnotherExactlyWhereEveryValueWithinItsBoundIsTheOthers =
	property.explore(guaranteeCaseGen, {
		needs: {},
		situations: [
			"guaranteed",
			"not guaranteed",
			"refuted by the bytes alone"
		] satisfies ReadonlyArray<Reached<GuaranteeFeature>>,
		check: (_, k: Case<GuaranteeFeature>) => (c) =>
			Effect.sync(() => {
				const verdict = guaranteeVerdict(c)
				const truth = guaranteeTruth(c)
				if (verdict === "bounded") {
					return
				}
				k.note(verdict === "included" ? "guaranteed" : "not guaranteed")
				if (!truth.bytes) {
					k.note("refuted by the bytes alone")
				}
				assert.equal(
					verdict === "included",
					truth.holds,
					`${Formatter.format(c)}: the inner type guarantees the outer exactly where every value within its bound lies in the outer language within the outer bound`
				)
			}),
		oracle: {
			kind: "specification",
			name: "exhaustive brute force over the inner type's values, every text of the alphabet within its bound, held to ECMAScript's membership and the outer bound"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/regex/inclusion.ts",
				original: '\tif (language.kind !== "included") {\n\t\treturn language.kind\n\t}\n',
				replacement: '\tif (language.kind === "bounded") {\n\t\treturn language.kind\n\t}\n',
				why: "A guarantee holds whatever the languages: a type whose values lie outside the other's language is called its subtype."
			},
			{
				file: "packages/engine/src/scalar/regex/inclusion.ts",
				original: '\tif (language.kind !== "included") {\n\t\treturn language.kind\n\t}\n',
				replacement: '\tif (language.kind !== "refuted") {\n\t\treturn "refuted"\n\t}\n',
				why: "No guarantee holds where the languages are included: every proved inclusion is refused."
			}
		]
	})

/**
 * A cast of a text into a text type whose language within its bound holds every value of the operand's is proved
 * total, by the same judgment (scalar/compute/lower.ts languagePremise), and one into a type that misses a value is
 * refused: a LearnerId of 69 bytes casts into a Timeback user of 255 characters, a state into a slug.
 */
export const aCastIntoATextTypeHoldingEveryValueOfItsOperandIsProvedByTheOneJudgment =
	property.exhaust(finite(castCaseGen), {
		needs: {},
		situations: ["proved", "refused"],
		check: (_, k: Case<CastFeature>) => (c) =>
			Effect.sync(() => {
				k.note(c.holds ? "proved" : "refused")
				assert.equal(
					castCompiles(c),
					c.holds,
					`${Formatter.format(c)}: the cast is ${c.holds ? "proved total" : "refused"}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "a LearnerId into a Timeback user and a state into a slug proved, the reverse casts refused"
		},
		box: "casts between a LearnerId and a Timeback user, and between a state and a slug, each way",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/lower.ts",
				original: "\tconst inner = languageOf(regex)\n",
				replacement: "\tconst inner = { patterns: regex.patterns, octets: undefined }\n",
				why: "A cast's premise reads the operand's language without its byte bound, as patternIncludes did: `^.+$` holds texts of more than 255 characters, so a LearnerId's cast into a Timeback user is refused again."
			}
		]
	})
