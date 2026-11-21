/**
 * A rule statement over the units a transaction wrote reads an import of one rule no parameter restricts at each read,
 * a step of its chain keyed by the steps before it, and a check over every row reads it whole (analysis/theory/navigate.ts
 * RegionExtent): read whole in a probe, the import is read for every unit, at the chain's head, before any step binds
 * it, as the cull of `perUnit` left qti's declared names in the assembled catalog's probes, every package's attribute
 * rows of one name read for each written binding (edullm's qti and pantry, metis's pantry, 2026-11-21); read at each
 * read in a check over every row, every read is a read of every row again. An import of several rules stays whole over
 * either, one node, never distributed into the rule's conjunctions.
 *
 * Oracle: a specification, read off the navigated query: the reads of the import it keeps whole.
 *
 * Features: an import of one rule and a union, each over the units and over every row; an import read three times.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	extentGen,
	navigatedOver,
	type Reached
} from "#test/unit/analysis/navigation-extent.fixtures.ts"

/** Over the units an import of one rule no parameter restricts is read at each read; over every row, whole. */
export const anUnrestrictedImportOfOneRuleIsReadAtEachReadOverTheUnitsAndWholeOverEveryRow =
	property.exhaust(finite(extentGen), {
		needs: {},
		situations: [
			"an import of one rule over the units",
			"an import of one rule over every row",
			"a union over the units",
			"a union over every row",
			"an import read three times"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (drawn) => Effect.sync(() => navigatedOver(drawn, c.note)),
		oracle: {
			kind: "specification",
			name: "the navigated query: the reads of the import it keeps whole"
		},
		box: "a rule over BV reading a join import of one rule or a union of two, two or three times, each read at the value the one before bound, over the units and over every row",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: '\t\t\tsharing.extent === "units" &&\n',
				replacement: '\t\t\tsharing.extent === "every" &&\n',
				why: "The import of one rule is kept whole over the units and read at each read over every row: a probe reads every unit's rows at its chain's head, as the cull left qti's declared names, and the check over every row reads every row again at each read; the property fails."
			}
		]
	})
