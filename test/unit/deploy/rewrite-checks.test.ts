/**
 * A rule over a query is checked again by the migration that writes again the values of a column it reads
 * (deploy/diff/diff.ts heldBefore, rewrittenColumns), and a stored derived relation above that column's table is
 * created again and refilled (Differ.viewDropsOf): one reading of "this migration rewrites that column" decides both. A rule's check
 * identity is the law's meaning over the columns it reads (snapshot/violation.ts checkOf), never their values, and its
 * judge's triggers never see a migration's ALTER TABLE, so a migration that re-expressed a stored generated column, gave
 * it other values through a closed row its generation reads, or drew a family's values again under an unchanged rule
 * kept the rule's identity and installed values the rule never judged: a cap raised from 20 to 30 under `g <= 25`
 * admitted every high-tier row, and the migration passed.
 *
 * The schema: T1's documents, each of a tier, with an amount `x` and `g`, generated, its tier's cap in the closed Cap;
 * T2's signed texts with `h`, generated, whether the text starts with a minus; O's counted members M, their amounts
 * summed into O's `total`. At level 1: Capped over `g`, Plain over `x`, Unsigned over `h` and Bounded over `total`,
 * each a rule over a query of its own derived relation, and XsView over T1, stored, T1 and T2 in a unit of the document.
 *
 * Property: the first version's draft, from no installation, checks every rule and creates every stored table; the second's,
 * which changes nothing, a cap of Cap, `h`'s generation or the field O's fold sums, checks again exactly the rules over
 * a column whose values it writes again, Plain never, though `x` is T1's beside the rewritten `g`, and creates again
 * exactly the stored tables above the tables it rewrites.
 *
 * Oracle: a specification read off the schema's own reads. The box, exhausted: every change.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import {
	type Change,
	changeGen,
	checkedBy,
	drafted,
	laws,
	recreatedBy,
	views
} from "#test/unit/deploy/rewrite-checks.fixtures.ts"

/** What the property reaches: each kind of change. */
type Feature =
	| "nothing changed"
	| "a closed row a generation reads changed"
	| "a generation changed"
	| "a fold drawn again"

const featureOf = (change: Change): Feature => {
	switch (change) {
		case "none":
			return "nothing changed"
		case "cap":
			return "a closed row a generation reads changed"
		case "generation":
			return "a generation changed"
		case "fold":
			return "a fold drawn again"
	}
}

/** A migration that writes a column's values again checks again exactly the rules over it and creates again exactly the stored tables above its table. */
export const aMigrationThatRewritesAColumnChecksAgainExactlyTheRulesOverIt = property.exhaust(
	finite(changeGen),
	{
		needs: {},
		situations: [
			"nothing changed",
			"a closed row a generation reads changed",
			"a generation changed",
			"a fold drawn again"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (change) =>
			Effect.sync(() => {
				const { first, second } = drafted(change)
				assert.deepEqual(
					Arr.sort(first.checked, Order.String),
					Arr.sort(laws, Order.String),
					"the first draft checks every rule it adds"
				)
				assert.deepEqual(
					Arr.sort(first.created, Order.String),
					Arr.sort(views, Order.String),
					"the first draft creates every stored table"
				)
				assert.deepEqual(
					Arr.sort(second.checked, Order.String),
					Arr.sort(checkedBy(change), Order.String),
					`${change}: the second draft checks again exactly the rules over a column it rewrites`
				)
				assert.deepEqual(
					Arr.sort(second.created, Order.String),
					Arr.sort(recreatedBy(change), Order.String),
					`${change}: the second draft creates again exactly the stored tables above a table it rewrites`
				)
				c.note(featureOf(change))
			}),
		oracle: {
			kind: "specification",
			name: "the schema's own reads: each rule reads its own column, so a migration checks again exactly the rules over the columns it rewrites"
		},
		box: "T1's g generated from the closed Cap and x, T2's h generated from its text, O's total folded over M, each read by a rule over a query of its own, XsView over T1 stored; the second version changing nothing, a cap, h's generation or the fold's field",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					"\tif (was === undefined || [...check.reads].some((column) => rewritten.has(column))) {",
				replacement: "\tif (was === undefined) {",
				why: "A rule is held across a migration that writes a column it reads again, as before: a raised cap under Capped, a re-expressed h under Unsigned and a total drawn again under Bounded each pass unchecked."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: '\t\t\t\trevalues(fate) || k.changes.get(column)?.kind === "reexpressed"',
				replacement: "\t\t\t\trevalues(fate)",
				why: "A column SET EXPRESSION computes again reads as kept, so a cap raised under g or h's new generation leaves Capped and Unsigned unchecked and XsView's rows stale."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: '\t\tcase "redefined":\n\t\tcase "revalued":\n\t\t\treturn true',
				replacement:
					'\t\tcase "redefined":\n\t\t\treturn true\n\t\tcase "revalued":\n\t\t\treturn false',
				why: "A column the backfill draws again reads as kept, so O's totals drawn again over another field leave Bounded unchecked."
			},
			{
				file: "packages/engine/src/deploy/snapshot/violation.ts",
				original: '\t\t\tif (node.kind !== "Base" || node.relationKind !== "relation") {',
				replacement: '\t\t\tif (node.kind === "Base") {',
				why: "A check reads no stored column, so no migration's rewrite checks a rule again."
			}
		]
	}
)
