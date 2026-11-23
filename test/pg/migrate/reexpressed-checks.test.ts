/**
 * A CHECK the target defines otherwise over a generated field Structure re-expresses in place, migrated over stored
 * rows on PostgreSQL 19 by the real runner. SET EXPRESSION computes the field again on every row and rebuilds every
 * constraint over it in its statement, checking each over the rows as it leaves them (PostgreSQL's tablecmds.c,
 * AT_SetExpression), so the previous definition of a CHECK the target replaces is taken away before it, in Structure's
 * drops (deploy/diff/diff.ts takenByReplacement, reexpressionTakes), and the target's added after it NOT VALID and
 * validated. Kept through Structure, the previous definition judges the new values at the SET EXPRESSION and refuses
 * rows the target admits (23514), its drop drafted after them in the structure.constraints alteration that replaces it:
 * the class of S7's n_1_sentinel, over a re-expressed field where that was over a redrawn one.
 *
 * A case stores one to four rows of O, each an `a` of 0 to 10 and a `b` of 0 to 20, under the first version, whose `g`
 * is `a` and whose Bounded, a CHECK on O, holds `g` to at most 10; then migrates to the second, whose `g` is `b` under
 * Bounded holding it to at most 20. Every stored row keeps both Boundeds over its own `g`; a row whose `b` passes 10 is
 * the one the first Bounded refuses at the SET EXPRESSION.
 *
 * Oracle: a second implementation, each row's `b` as its `g`, which the migration must leave in O, the folder applying
 * and no constraint left NOT VALID.
 *
 * Features: a row the new expression takes past the first CHECK, and one it keeps within it, each a steered case
 * constructs while it is pending.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	aims,
	expectedOf,
	type Feature,
	featuresOf,
	migratedOver,
	type Stored,
	storedGen
} from "#test/pg/migrate/reexpressed-checks.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A CHECK the target defines otherwise over a generated field re-expressed in place is dropped before the SET EXPRESSION, so the migration applies over every row its previous definition held and leaves the new values. */
export const redefinedChecksOverReexpressedFields = property.explore(aimed(storedGen, aims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"a row the new expression takes past the first CHECK",
		"a row the new expression keeps within the first CHECK"
	] satisfies ReadonlyArray<Reached<Feature>>,
	budget: { runs: 4, steered: 8 },
	check:
		({ substrate }, c: Case<Feature>) =>
		(stored: Stored) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.gen(function* () {
						c.noteAll(featuresOf(stored))
						const read = yield* migratedOver(stored)
						assert.deepEqual(read, expectedOf(stored), "each row's g is its b")
					})
				),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "second-implementation",
		name: "each row's b as its g over the stored rows"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				"\t\t\t\t(sides.some(([table, columns]) => reexpressedAt(table, columns)) &&\n\t\t\t\t\treexpressionTakes(o, over, sides))\n",
			replacement: "\t\t\t\tfalse\n",
			why: "A re-expression takes nothing built over its column: the first Bounded stands through Structure, PostgreSQL's SET EXPRESSION rebuilds it over the rewritten rows and refuses the row whose b passes 10 (23514), its drop drafted after it in the structure.constraints alteration that replaces it."
		}
	]
})
