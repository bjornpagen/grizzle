/**
 * Planted writers below SERIALIZABLE on the platform's tables: every write is refused before it writes a row.
 *
 * grizzle runs every transaction at SERIALIZABLE, and every table's statement trigger refuses a write below it with
 * 25000, naming the table in SCHEMA and TABLE. PostgreSQL checks a statement's
 * privileges before any trigger fires, and grizzle grants a world role INSERT on what it writes, UPDATE and DELETE
 * only on an open relation, mutable inside a unit, and TRUNCATE to no one, so which refusal comes first is a total
 * table of who writes, what statement, and whether the relation is open:
 *
 * - the schema's owner holds every privilege on its tables: every statement is refused by the guard, 25000, but a
 *   TRUNCATE of a closed relation, which its immutability guard of a TRUNCATE refuses first, 42501: PostgreSQL fires a
 *   table's BEFORE TRUNCATE statement triggers in name order, `__immutable_truncate` before `__isolation`
 *   (physical/ddl/immutable.ts);
 * - a world role (the races' `direct`, taken on through its login) is refused by privilege, 42501, for a TRUNCATE, and
 *   for an UPDATE, a DELETE, a DELETE that matches no row and a MERGE that updates or deletes when the relation is
 *   closed; every other statement it is granted (an INSERT, and an UPDATE, a DELETE or a MERGE of an open relation) is
 *   refused by the guard, 25000.
 *
 * Every statement would write rows if it ran (an INSERT of a copy of every row, which the key would refuse, a DELETE of
 * every row), so a guard that let it through is seen as another outcome, or as a row-level failure, never as 25000. A
 * statement trigger fires whether or not any row is touched, so the DELETE that matches nothing and the MERGE whose
 * condition matches nothing are refused too; a TRUNCATE cascades, so no foreign key's check comes before its trigger.
 * The space is exhausted: both writers, every statement kind, every level below SERIALIZABLE, and a mutable and an
 * immutable relation, the platform's tables of each mutability written in turn over the points (the fixture's mutable
 * statements say which are mutable), so every table is written in every run.
 *
 * Features: every point of the space.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	plantedCase,
	plantedCases,
	type PlantedFeature,
	plantedFeatures
} from "#test/schedules/platform/planted.fixtures.ts"
import { racesRig } from "#test/schedules/platform/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every write below SERIALIZABLE is refused before it writes a row, each point on its own clone of the races' rig,
 * installed once per member, where the search installed it.
 *
 * Its pre-conversion budget: the box (test/schedules/platform/planted.test.ts at 9788614e3).
 */
export const everyWriteBelowSerializableIsRefusedBeforeItWritesARow = property.exhaust(
	finite(plantedCases),
	{
		needs: { rigged: Substrate.fresh(racesRig) },
		situations: plantedFeatures satisfies ReadonlyArray<Reached<PlantedFeature>>,
		check:
			({ rigged }, c: Case<PlantedFeature>) =>
			(p) =>
				Effect.scoped(
					Effect.flatMap(rigged, (taken) =>
						Effect.provideService(plantedCase(taken, p, c), Substrate, taken.substrate)
					)
				),
		oracle: {
			kind: "specification",
			name: "privileges before triggers: 42501 for an ungranted statement, the guard's 25000 for every other"
		},
		box: "both writers, every statement kind, every level below SERIALIZABLE, on a mutable and an immutable relation, every table of each written by some point",
		kept: [],
		kills: []
	}
)
