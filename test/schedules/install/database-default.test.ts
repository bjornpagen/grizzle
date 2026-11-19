/**
 * Two installations into one database at once: each sets the database's default_transaction_isolation, one row of
 * pg_db_role_setting, and both commit.
 *
 * Every installation's first migration runs the database-default blocks (databaseDefaults,
 * each as sql/print.ts prints it), each an ALTER DATABASE ... SET of the database's one pg_db_role_setting row. Two
 * transactions that update that row at once fail the later with XX000 (tuple concurrently updated), as installations
 * into one shared worker database did; so each block is the database lock's command, a transaction-scoped advisory
 * lock, and its own (sql/print.ts databaseWide), and a second installation waits at the lock for the first to commit,
 * then sets the default again.
 *
 * Over every interleaving of two installations' transactions, each running the blocks and committing as the
 * database's owner (`every`): both commit; in an interleaving where both ran their blocks before either
 * committed, the later block waited on the earlier installation, and in any other nothing waited; and the database's
 * default isolation is SERIALIZABLE after.
 *
 * Oracle: the specification restated as a judge of each interleaving (judge), over every interleaving, reduced by
 * sleep sets; the database's settings read after each.
 *
 * Feature: an interleaving in which a block waited, which the space must hold.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { installationsCase } from "#test/schedules/install/database-default.fixtures.ts"
import { everyInterleaving } from "#test/support/schedules/interleave.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Both set the database's default isolation and commit, the later waiting on the earlier, over every interleaving of
 * the two installations' transactions, on a database of the case's own (Substrate.fresh), since each sets the database's
 * default, where the search set the shared file's.
 *
 * Its pre-conversion budget: every interleaving (test/schedules/install/database-default.test.ts at 948630c1c).
 */
export const bothSetTheDatabasesDefaultIsolationAndCommitTheLaterWaitingOnTheEarlier =
	property.exhaust(everyInterleaving, {
		needs: { own: Substrate.fresh },
		situations: [],
		check:
			({ own }) =>
			() =>
				Effect.provideServiceEffect(Effect.scoped(installationsCase), Substrate, own),
		oracle: {
			kind: "specification",
			name: "the specification restated as a judge of each interleaving (judge), and the database's settings after"
		},
		box: "every interleaving of two installations' transactions, each running the database-default blocks and committing, reduced by sleep sets",
		kept: [],
		kills: []
	})
