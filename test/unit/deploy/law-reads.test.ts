/**
 * A law's check reads what the law reads (deploy/snapshot/violation.ts readsOf): a migration that drops or renames a
 * column no law reads checks none of the laws again. A rule's check is its violation query over every row, which the
 * migration that adds the rule, or changes it or a definition it reads, runs once, keyed by the identity of what it
 * asks of the rows it reads (deploy/snapshot/violation.ts checkOf); it reads of each stored relation the columns the
 * law binds and the relation's key, so a column it never reads, dropped or renamed, leaves its reads, and the identity,
 * as they were. Each case is a rule over D, T's facts by document
 * and place, selected by a literal of T's `a` or not: S's containment in it, a check over its `b` or a key over its `b`
 * by document; whole, T and S immutable, or probed, both mutable in their document's unit and D joining T to W, in a
 * unit of its own; T's `pay`, which no law reads, dropped or renamed.
 *
 * Oracle: a specification, read off the shape: the second draft checks no law, and the first checks the rule wherever
 * the schema holds one (a containment of an unselected D is a foreign key, which no check holds).
 *
 * Features: a whole rule and a probed rule left unchecked; a column dropped and a column renamed.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { drafted, type Reached, shapeGen } from "#test/unit/deploy/law-reads.fixtures.ts"

/** A migration that drops or renames a column no law reads checks none of the laws again. */
export const aMigrationThatDropsOrRenamesAColumnNoLawReadsChecksNoneOfTheLawsAgain =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: [
			"a whole rule kept unchecked",
			"a probed rule kept unchecked",
			"a column dropped",
			"a column renamed"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (shape) =>
			Effect.sync(() => {
				const { first, second } = drafted(shape)
				assert.deepEqual(second, [], "the draft that drops or renames pay checks no law")
				c.note(shape.change === "drop" ? "a column dropped" : "a column renamed")
				if (first.length > 0) {
					c.note(
						shape.judge === "whole" ? "a whole rule kept unchecked" : "a probed rule kept unchecked"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the shape's laws read no pay: its drop or rename checks none of them again"
		},
		box: "every rule over D of T, a containment of S, a check or a key, its arm selecting T by a literal or not, whole or probed, T's unread pay dropped or renamed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/violation.ts",
				original: "\tconst reads = readsOf(installation, violation)",
				replacement: "\tconst reads = { dag: violations.dag, root: violation }",
				why: "A law's check reads its relations' whole headings again, so dropping or renaming pay changes every rule's reads and its identity, and the draft checks every rule again; the property fails."
			}
		]
	})
