/**
 * A CHECK the target defines otherwise over a column the backfill draws again, migrated over stored rows on PostgreSQL
 * 19 by the real runner. The backfill's UPDATE meets every CHECK on its table at each row it writes, so the previous
 * definition of a CHECK the target replaces is taken away before it, in Structure's drops (deploy/diff/diff.ts
 * takenByReplacement, dropReplaced), and the target's added after it NOT VALID and validated; a CHECK the target keeps
 * as it is stands, since the target's values hold it. Whether the target keeps one is read off its two definitions
 * (Differ.redefinedConstraint), never its two records: a CHECK its table's CREATE TABLE declares is recorded with no
 * statement of its own, so by its records every such CHECK was kept, its previous definition stood through the
 * backfill and judged the drawn values, and the backfill refused rows the target admits: S7's qti migration, whose
 * drawing of Node's parent copies met the previous n_1_sentinel, which tied a sentinel's copies to its own values,
 * refused every sentinel whose own path is not the copies' base (23514), its drop drafted after the drawing.
 *
 * A case stores one to three owners O and their members M, each with amounts `x` and `y`, under a plain version, then
 * migrates to O's counted members whose sum of `x` is each owner's `total`, held by Bounded, a CHECK on O, to at most 10;
 * then to the same family summing `y`, Bounded holding `total` to at most 100, so the second migration draws every total
 * again under Bounded defined otherwise. Every stored row keeps the first Bounded (each `x` at most 3, three members at
 * most) and the second (each `y` at most 33); an owner whose `y` sum passes 10 is the row the first Bounded refuses as
 * the backfill draws it, S7's sentinel whose own path is not the base.
 *
 * Oracle: a second implementation, each owner's count and `y` sum over the stored rows, which the migration must leave
 * in O, every folder applying and no constraint left NOT VALID.
 *
 * Features: an owner the second fold takes past the first CHECK, one it keeps within it, and one of no members, each a
 * steered case constructs while it is pending.
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
} from "#test/pg/migrate/redefined-checks.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A CHECK the target defines otherwise over a column the backfill draws again is dropped before the backfill, so the migration applies over every row its previous definition held and leaves the drawn values. */
export const redefinedChecksOverRedrawnColumns = property.explore(aimed(storedGen, aims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"an owner the second fold takes past the first CHECK",
		"an owner the second fold keeps within the first CHECK",
		"an owner of no members"
	] satisfies ReadonlyArray<Reached<Feature>>,
	budget: { runs: 4, steered: 12 },
	check:
		({ substrate }, c: Case<Feature>) =>
		(stored: Stored) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.gen(function* () {
						c.noteAll(featuresOf(stored))
						const read = yield* migratedOver(stored)
						assert.deepEqual(
							read,
							expectedOf(stored),
							"each owner holds its count and the sum of its members' y"
						)
					})
				),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "second-implementation",
		name: "each owner's count of members and sum of their y over the stored rows"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				"\t\t\t\tthis.redefinedConstraint(o, this.constraintOf(now, this.next)) === undefined\n",
			replacement: "\t\t\t\tsameRecord(o, now)\n",
			why: "A CHECK is kept as it is by its record, which holds no statement of an inline CHECK: the first Bounded stands through the backfill that draws the second fold, and refuses the owner it takes past 10 (23514), its drop drafted after the backfill, as S7's n_1_sentinel."
		}
	]
})
