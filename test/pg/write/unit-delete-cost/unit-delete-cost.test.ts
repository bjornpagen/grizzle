/**
 * A unit delete meets each row it deletes once whatever index PostgreSQL takes: the statement reads every
 * doomed row with its tid in one snapshot and deletes each at that tid (write/family/keyset.ts RowKeyset), never through
 * an index over its key. On PostgreSQL 19, a package of ten documents deleted whole beside tens of stored packages,
 * analyzed or not, where the workload's range over (pkg, path) then kind asks Node for an index shallower than its
 * key's that PostgreSQL estimates at a row as it does the key (unit-delete-cost.fixtures.ts).
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { runDelete, storedGen } from "#test/pg/write/unit-delete-cost/unit-delete-cost.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * The unit delete of a package reads one node for each node it deletes, however many packages stand beside it, with
 * statistics or none.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aUnitDeleteMeetsEachRowItDeletesOnceThroughWhateverIndexPostgreSQLTakes =
	property.explore(storedGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["deleted with no statistics", "deleted analyzed"],
		check:
			({ substrate }, c) =>
			(stored) =>
				Effect.provideServiceEffect(
					runDelete(stored, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "universal",
			name: "bound: the rows of the deleted table its DELETE reads, its scans' outputs and their filters' removals over every loop, are at most the rows it deletes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/delete/unit.ts",
				original:
					"\t\t\t\twhere: conjunction([rowAt(k, found.removed, t), rowsAmong(supply, found.removed, t)]),",
				replacement:
					"\t\t\t\twhere: rowEq({ fields: relation.primaryFields, typeOf: rowType, left: (f) => stored(t, relation, f), right: (f) => col(k, keysetColumn(found.removed, f)) }, w.names),",
				why: "The unit delete meets each removed row at its key: PostgreSQL reads the key through Node's (pkg, path, kind), shallower than the key's index and estimated at a row as it is, filtering start over every node of the document, so the delete reads each document's nodes once per node."
			}
		]
	})
