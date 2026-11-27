/**
 * A closed id column of a subset holds its subset's handles, whoever writes it, against PostgreSQL 19.
 *
 * closedId(R, { only }) is stored under R's domain, which holds every live code of R, so its column carries a CHECK of
 * its subset's codes (physical/closed/storage.ts closedSubset), named at the naming door. A direct writer that has taken
 * on the full role inserts a row whose drawn column holds the code of a drawn handle of the roster and every other column
 * a code its subset holds. The oracle restates the subset: a handle it holds is stored as its code; every other is
 * refused with 23514 under the column's subset CHECK, and stores nothing.
 *
 * The box, exhausted: every subset of a four-handle roster short of every handle, a column each, and every handle.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	columnOf,
	type Feature,
	Mark,
	Marked,
	subsets,
	subsetsTemplate,
	world,
	writes
} from "#test/pg/closed/subset.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { expectConstraint } from "#test/support/substrate/expect.ts"
import { claimsOfNoFact, Substrate, worldSession } from "#test/support/substrate/substrate.ts"

/** A closed id column of a subset stores a direct writer's code exactly when its subset holds the handle, and refuses every other by its subset CHECK. */
export const aClosedIdColumnOfASubsetStoresADirectWritersCodeExactlyWhenItsSubsetHoldsTheHandleAndRefusesEveryOtherByItsSubsetCHECK =
	property.exhaust(finite(writes), {
		needs: { fresh: Substrate.fresh(subsetsTemplate) },
		situations: ["stored", "refused by the subset CHECK"] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fresh }, c: Case<Feature>) =>
			({ held, handle }) =>
				Effect.gen(function* () {
					const {
						substrate: s,
						value: { installed }
					} = yield* fresh
					const names = namesOf(installed)
					const writer = yield* s.session({
						...worldSession(installed.world(world.app), claimsOfNoFact),
						label: "writer"
					})
					const drawn = columnOf(held)
					const codes = Arr.map(subsets, (other) =>
						names.code(Mark, columnOf(other) === drawn ? handle : Arr.headNonEmpty(other))
					)
					const insert = writer.values(
						`INSERT INTO ${names.table(Marked)} (${names.column(Marked, "id")}, ${Arr.join(
							Arr.map(subsets, (other) => names.column(Marked, columnOf(other))),
							", "
						)}) VALUES ($1::integer, ${Arr.join(
							Arr.map(subsets, (_, at) => `$${at + 2}::smallint`),
							", "
						)})`,
						["1", ...Arr.map(codes, String)]
					)
					if (!Arr.contains(held, handle)) {
						c.note("refused by the subset CHECK")
						yield* expectConstraint(insert, names.subsetCheck(Marked, drawn), "23514")
						const stored = yield* s.admin.queryValues(`SELECT 1 FROM ${names.table(Marked)}`, [])
						assert.deepEqual(stored, [], "the refused row stores nothing")
						return
					}
					c.note("stored")
					yield* insert
					const [row] = yield* s.admin.queryValues(
						`SELECT ${names.column(Marked, drawn)}::text FROM ${names.table(Marked)} WHERE ${names.column(Marked, "id")} = 1`,
						[]
					)
					assert.deepEqual(
						defined(row, "the stored row"),
						[String(names.code(Mark, handle))],
						"the column stores the handle's code"
					)
				}),
		oracle: {
			kind: "specification",
			name: "the subset restated over the drawn handle: stored when the subset holds it, refused by its CHECK otherwise"
		},
		box: "every subset of four handles short of every handle, a column each, and every handle of the roster",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/closed/storage.ts",
				original:
					"\t\tmapNonEmpty(only, (handle) => lit.int(codeOf(codec, handle), types.smallint))",
				replacement:
					"\t\tmapNonEmpty(roster.handles, (handle) => lit.int(codeOf(codec, handle), types.smallint))",
				why: "The subset CHECK holds the whole roster's codes: a direct writer stores a handle outside the subset."
			}
		]
	})
