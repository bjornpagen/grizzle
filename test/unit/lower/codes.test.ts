/**
 * A closed literal's lowering (lower/conservative/expr/index.ts lowerLiteral): a handle is its code under the
 * installation's codebook, never its position among the roster's live handles, and a set of handles is bit(n)'s text,
 * n every code the roster has minted, position c set exactly for the handle of code c.
 *
 * - The oracle: an independent replay of the roster's history (test/support/closed/generate.ts), a naive list of slots
 *   replayed command by command that shares no code with ir/cells.ts rosterCodes or ir/codes.ts draftCodebook: a live
 *   handle's code is its slot, and the set's text is the slots read one bit each.
 * - D1 as a checker: for every two live handles, their lowered codes compare as their declared positions do, so a code
 *   comparison agrees with the roster's declared order, holes or none.
 * - Holes weighted up: the generator removes three times as often as it grows, because a lowering that writes the
 *   declared position agrees with the codes on every roster without a hole. Each literal notes its (hole count,
 *   literal) pair, aligned when its code is its position and shifted when a hole before it moved its code, and the
 *   search must reach a shifted literal under one hole and under several.
 *
 * The box: one roster installed with one to four handles, then up to six migrations (growth, removal, re-addition), in
 * plain and awkward spellings; every live handle as a literal, every ordered pair of them, and one drawn set.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { historyGen, type RosterFeature } from "#test/support/closed/generate.ts"
import { closed, lowersByCodes } from "#test/unit/lower/codes.fixtures.ts"

/** Closed literals a handle lowers to its code in the roster's history, never its declared position, and codes keep declared order. */
export const closedLiteralsAHandleLowersToItsCodeInTheRostersHistoryNeverItsDeclaredPositionAndCodesKeepDeclaredOrder =
	property.explore(
		historyGen(closed, {
			handles: { min: 1, max: 4 },
			migrations: { min: 0, max: 6 }
		}),
		{
			needs: {},
			situations: [
				["holes 0", "literal aligned"],
				["holes 1", "literal aligned"],
				["holes 1", "literal shifted"],
				["holes 2+", "literal shifted"]
			] satisfies ReadonlyArray<Reached<RosterFeature>>,
			check: (_, c: Case<RosterFeature>) => (value) => lowersByCodes(value, c),
			oracle: {
				kind: "second-implementation",
				name: "a naive replay of the roster's history (test/support/closed/generate.ts)"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/expr/index.ts",
					original:
						"\t\t\treturn lit.int(BigInt(codeOf(literalCodec(names, type), literal.handle)), sqlType)",
					replacement:
						'\t\t\treturn lit.int(\n\t\t\t\tBigInt(literalCodec(names, type).names.filter((n) => n !== "").indexOf(literal.handle)),\n\t\t\t\tsqlType\n\t\t\t)',
					why: "lowerLiteral lowers a handle to its position among the roster's live handles instead of its code; the search fails on a literal a hole has shifted."
				}
			]
		}
	)
