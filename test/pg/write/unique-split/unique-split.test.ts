/**
 * A put that may move a value of a unique object outside the primary key routes only the rows that move one through the
 * DELETE-then-insert pair, and updates every other in place, on PostgreSQL 19 (write/put/choose.ts uniqueSplit): over
 * Test, keyed by its id with its name a candidate key, metis's Test in small, an enumerated put of every stored test,
 * some swapping their names pairwise and every other changing its note. An UPDATE checks the name's UNIQUE at each row,
 * so one that swapped two names would raise 23505 on a lawful final state; the pair deletes every moved row before it
 * inserts any. A row that keeps its name takes no part in a swap, so it is updated in place: no dead tuple, no new entry
 * in the key's or the name's index, and no deferred reference to it checked again, where the pair deleted and
 * inserted every row (FKJUDGE: 660 buffers of RI checks for one test referenced by 20 deferred keys).
 *
 * The budget: the put's statements, each explained with ANALYZE in its place and rolled back
 * (bench/write/support/writes.ts explainedChange), delete and insert exactly the moved rows and update exactly the
 * others, counted off their ModifyTable nodes, never a clock; and the put, applied, leaves Test holding exactly the
 * facts put, the swap lawful at every statement.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runSplit,
	type SplitFeature,
	splitGen
} from "#test/pg/write/unique-split/unique-split.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A put routes through the pair only the rows that move a unique value, and updates every other in place. */
export const aPutRoutesThroughThePairOnlyTheRowsThatMoveAUniqueValueAndUpdatesEveryOtherInPlace =
	property.exhaust(finite(splitGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["no name moved", "names swapped"] satisfies ReadonlyArray<Reached<SplitFeature>>,
		check:
			({ substrate }, c: Case<SplitFeature>) =>
			(drawn) =>
				Effect.provideServiceEffect(
					runSplit(drawn, (f) => c.note(f)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "universal",
			name: "a counted budget: the moved rows deleted and inserted, every other updated in place, and Test holding exactly the facts put"
		},
		box: "eight or 32 stored tests, none, two or four of them swapping names pairwise and every other changing its note",
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/unique-split/unique-split.test.ts#aPutRoutesThroughThePairOnlyTheRowsThatMoveAUniqueValueAndUpdatesEveryOtherInPlace:-:0.0"
				),
				reason:
					"Eight tests, no name moved, each changing its note: the put was the pair (candidateKey), every row deleted and inserted again, 8 deleted and 8 inserted where 8 updates in place do it (main 55f62b1d; metis's Test, FKJUDGE)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/write/put/choose.ts",
				original:
					'\t\t\t\t\t\treturn primary.kind === "key" && !deltaRead.has(action.relation)\n\t\t\t\t\t\t\t? chosen({ ...place, target: "uniqueSplit", reason: "candidateKey", inPlace, moved })\n\t\t\t\t\t\t\t: pair("candidateKey")\n',
				replacement: '\t\t\t\t\t\treturn pair("candidateKey")\n',
				why: "Every row of a put that may move a name routed through the pair: each test whose name stays deleted and inserted again, a dead tuple and an entry in the key's and the name's index each, and every deferred reference to it checked again."
			}
		]
	})
