/**
 * An installation's roster codes as `grizzle upgrade` reads them off its live database (deploy/upgrade/history.ts
 * liveRosters), with no database: every history of up to five commands (grow, remove, re-add, rename, reorder) over two
 * rosters, Kind ordered and Mark unordered, which share the names of their handles (test/unit/ir/codes.fixtures.ts),
 * exhausted. The installation the history reached holds each roster's names constant, named by the naming door from
 * the codes it holds and holding each code's handle; the database is that constant's elements and its name, beside a
 * constant of names that is no roster's.
 *
 * The oracle is the history model of each roster: the codes read are exactly the model's, holes and renamed handles'
 * codes among them, for both rosters, never the codes a declaration of the live handles alone would mint. A roster
 * whose constant the database lacks is refused as `none`, and one held twice as `several`, never given codes by
 * default.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { recovered, type LiveCodesSituation } from "#test/unit/deploy/live-history.fixtures.ts"
import { histories } from "#test/unit/ir/codes.fixtures.ts"

/** The codes read off a live installation are exactly its history's, for every roster, holes and renamed handles included, and a roster whose names constant the database does not hold once is refused. */
export const theCodesReadOffALiveInstallationAreExactlyItsHistorysForEveryRosterHolesAndRenamedHandlesIncludedAndARosterWhoseNamesConstantTheDatabaseDoesNotHoldOnceIsRefused =
	property.exhaust(finite(histories), {
		needs: {},
		situations: [
			"a hole",
			"a renamed handle",
			"a live code past a hole",
			"an unordered roster's codes out of its handles' order",
			"both rosters changed"
		] satisfies ReadonlyArray<Reached<LiveCodesSituation>>,
		check: (_, c: Case<LiveCodesSituation>) => (history) => recovered(history, c),
		oracle: { kind: "second-implementation", name: "the naive history model of each roster" },
		box: "two rosters over four names, every history of up to five commands",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/upgrade/history.ts",
				original: "\t\t\tconst codec = rosterCodec(roster.closed, c.names.map(slotOf))",
				replacement:
					'\t\t\tconst codec = rosterCodec(\n\t\t\t\troster.closed,\n\t\t\t\troster.handles.map((handle): CodeSlot => ({ kind: "live", handle }))\n\t\t\t)',
				why: "The codes are minted from the source's declaration alone, re-coding every stored value: a roster with a hole, a renamed handle or an unordered roster out of its handles' order names no live constant, and is refused as none."
			},
			{
				file: "packages/engine/src/deploy/upgrade/history.ts",
				original: "\t\tif (only === undefined || second !== undefined) {",
				replacement: "\t\tif (only === undefined) {",
				why: "A roster two schemas hold a names constant of takes the first, a guess; the several refusal fails."
			}
		]
	})
