/**
 * A call of rows is over the highest of the levels its rows arguments are written over, comparing levels by their
 * content: rows arguments built each by a query(S) call of its own over one S are written over one level, however many
 * times the schema was read (schema/level.ts highestLevel, query/build/state.ts callSourceValue).
 *
 * Each case draws Compute.rowsOf or Compute.rowOf and its rows arguments, one to 27, each over Base, Upper or Aside
 * (Upper and Aside extend Base; neither is a level of the other) and each a query or a bound query, built by its own
 * query(S) call. Where one drawn level holds every other the call is admitted, and a rule matches it exactly where that
 * level is one of the rule's levels, each such rule compiling, and a rule over any other level is refused ForeignLevel,
 * so the call is over that one level. Where both Upper and Aside are drawn the call is refused, MalformedDescription.
 *
 * Oracles: the levels of the three schemas, stated by hand (call-levels.fixtures.ts levelsOf), a specification.
 *
 * Features: each call kind at one rows argument, at several over one level, at several over levels one of which holds
 * every other, and at several over levels none of which does.
 */

import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { succeeded, throwsRefused } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import {
	type CallFeature,
	callCaseGen,
	callSituations,
	holds,
	levelNames,
	levelsFor,
	modelTop,
	shapeOf
} from "#test/unit/query/build/call-levels.fixtures.ts"

/**
 * A call of rows whose rows arguments are each built by a query(S) call of its own is over the highest of their levels,
 * matched in exactly the rules over a level that holds it, and refused where no level holds every other.
 *
 * Budget: 200 runs and 200 steered cases: every case builds its three schemas and a query(S) for each of up to 27 rows
 * arguments, and the eight situations are reached in the steered phase's first cases.
 */
export const aCallOfRowsIsOverTheHighestOfItsRowsArgumentsLevelsComparedByContentHoweverManyQueryCallsBuiltThem =
	property.explore(callCaseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: callSituations,
		check: (_, c: Case<CallFeature>) => (call) =>
			Effect.sync(() => {
				c.note(`${call.kind}:${shapeOf(call.args)}`)
				const { source, matching, levels } = levelsFor(call.args.length)
				const top = modelTop(call.args)
				if (top === undefined) {
					throwsRefused(
						() => source(call),
						"MalformedDescription",
						"rows arguments over Upper and Aside, neither a level of the other"
					)
					return
				}
				const rows = source(call)
				for (const over of levelNames) {
					if (holds(over, top)) {
						succeeded(
							compileTemplate(matching(over, rows), levels[over], testCompile),
							`a rule over ${over} matches a call over ${top} and compiles`
						)
					} else {
						throwsRefused(
							() => matching(over, rows),
							"ForeignLevel",
							`a rule over ${over} matches no call over ${top}`
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the levels of Base, Upper and Aside, stated by hand (levelsOf)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/query/build/state.ts",
				original: "\tconst over = highestLevel(levels)",
				replacement: "\tconst over = new Set(levels).size === 1 ? levels[0] : undefined",
				why: "Rows arguments' levels are told apart by the object each query(S) call read, so two queries built over one schema count two levels and the call is refused MalformedDescription, the bug edullm's 27 rows arguments met."
			},
			{
				file: "packages/engine/src/schema/level.ts",
				original: "\treturn levels.every((level) => isLevelOver(level, top)) ? top : undefined",
				replacement: "\treturn top",
				why: "A call over Upper and Aside is admitted over the last one the first pass moved to, so the incomparable case builds where it is refused."
			}
		]
	})
