/**
 * How `grizzle upgrade` reads a live installation off the drift check of its target (adapter/admission/upgrade.ts
 * liveObjects), with no database: a drawn target of functions, CHECKs, rule and isolation triggers, indexes and tables,
 * each with a drawn fate in the database (held, proven by its row, held otherwise, absent, renamed by a format, or held
 * under another key), drawn objects the database holds besides (a function, an index, a generated column, a stored
 * column, a table), and the database default of format 7 or before and a slot a leader of format 7 or before made,
 * each held or not. The drift check's findings are built
 * as descriptionSelect spells them.
 *
 * The oracle is the model of the box: each object held, stale or absent by its fate, each renamed object's old name,
 * each dropped extra, a former database default and a former leader's slot departed; or the one fault of a part no
 * rebase may change: a table held otherwise, under another column, renamed or held besides, and a stored column, hold
 * rows; an isolation trigger held otherwise is of a kind no draft changes; any other object under another key is
 * reshaped.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { boxSpace, judgedCase, type LiveFeature } from "#test/unit/cli/live-objects.fixtures.ts"

/** An upgrade reads each object of a drawn target as held, stale, absent or departed exactly as the database holds it, and refuses by name the one part that holds rows, is of a kind no draft changes, or stands under another key. */
export const anUpgradeReadsEachObjectOfADrawnTargetAsHeldStaleAbsentOrDepartedExactlyAsTheDatabaseHoldsItAndRefusesByNameTheOnePartThatHoldsRowsIsOfAKindNoDraftChangesOrStandsUnderAnotherKey =
	property.explore(boxSpace, {
		needs: {},
		situations: [
			"an object held",
			"an object proven by its row",
			"an object held otherwise",
			"an object absent",
			"an object renamed",
			"a departed object",
			"a departed generated column",
			"a former database default departed",
			"a former leader's slot departed",
			"a stored table refused",
			"an unreplaceable kind refused",
			"an object under another key refused"
		] satisfies ReadonlyArray<Reached<LiveFeature>>,
		check: (_, c: Case<LiveFeature>) => (box) => judgedCase(box, c),
		oracle: {
			kind: "second-implementation",
			name: "the box's model: each object's fate in the database, and the one part no rebase may change"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/admission/upgrade.ts",
				original: "\t\t\tstale.add(object)",
				replacement: "\t\t\theld.add(object)",
				why: "An object the database defines otherwise is read as held, the drift identity check skipped: the upgrade would write the base snapshot over a database its target does not describe; the stale objects of every box held otherwise fail."
			},
			{
				file: "packages/grizzle/src/adapter/admission/upgrade.ts",
				original: '\tkind === "table" || kind === "ledger" || kind === "liveSecret"',
				replacement: '\tkind === "ledger" || kind === "liveSecret"',
				why: "A table held otherwise is refused as of a kind no draft changes, or as reshaped, where it holds rows; the stored fault of every such box fails."
			},
			{
				file: "packages/grizzle/src/adapter/admission/upgrade.ts",
				original: "\t\treturn generated(f) ? f.object : f.within",
				replacement: "\t\treturn f.within",
				why: "A generated column the database holds besides is read as its table's, a relation holding rows, and refused, where the upgrade drops it; the departed generated column fails."
			},
			{
				file: "packages/grizzle/src/adapter/admission/upgrade.ts",
				original: "\tif (found.formerDefault) {",
				replacement: "\tif (!found.formerDefault) {",
				why: "A former database default read as none: the upgrade leaves it where the database holds it and resets one where it holds none; the departed objects of every box fail."
			},
			{
				file: "packages/grizzle/src/adapter/admission/upgrade.ts",
				original: "\tfor (const name of found.formerSlots) {",
				replacement: "\tfor (const name of []) {",
				why: "A former leader's slot read as none: the upgrade leaves it, holding its WAL, where the database holds it; the departed objects of every box holding one fail."
			}
		]
	})
