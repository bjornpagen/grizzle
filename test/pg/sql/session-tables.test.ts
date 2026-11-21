/**
 * A session table's emptying on PostgreSQL 19 (sql/print.ts sessionTableEmptied), through a write's carrier, whose
 * every use stands it up (carrierStandUp): over drawn sequences of two to six uses on one session, each writing no row,
 * one, or more than the carrier's one page holds, narrow in its heap or wide in its TOAST table, and ending in COMMIT or
 * ROLLBACK, a carrier keyed or not, every stand-up after the first leaves the carrier with no row; keeps its file, so it
 * sent no invalidation, where the use before left its heap and its TOAST table's each within one page; gives it back
 * where either held more; and leaves each within one page.
 *
 * Features: a carrier that kept its file and one that gave it back, outgrown in its heap and in its TOAST table, and a
 * stand-up after a rollback.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { runUses, type SessionTableFeature, usesGen } from "#test/pg/sql/session-tables.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A session table's emptying keeps its file while it holds its one page and gives the file back once it holds more.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aSessionTablesEmptyingKeepsItsFileWhileItHoldsItsOnePageAndGivesTheFileBackOnceItHoldsMore =
	property.explore(usesGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"kept its file",
			"gave its file back",
			"outgrew its heap",
			"outgrew its TOAST table",
			"after a rollback"
		] satisfies ReadonlyArray<Reached<SessionTableFeature>>,
		check:
			({ substrate }, c) =>
			(k) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const s = yield* Substrate
							const session = yield* s.session({ ...ownerSession(), label: "carrier uses" })
							yield* runUses(session, k, c)
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "postgresql",
			name: "the carrier's rows, file and heap and TOAST bytes at each stand-up, against the bytes the use before left: none holds a row, a file within its page kept, one past it given back, each within its page after"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original:
					'\t\t{ condition: sessionTableOvergrown(name), body: [{ kind: "truncateSessionTable", name }] }',
				replacement:
					'\t\t{ condition: not(sessionTableStands(name)), body: [{ kind: "truncateSessionTable", name }] }',
				why: "The emptying never truncates, a DELETE at every use as e8de84026's judge did: a carrier refilled past its page keeps every page, and a session's carriers grow by each use."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original:
					'\t\t{ condition: sessionTableOvergrown(name), body: [{ kind: "truncateSessionTable", name }] }',
				replacement:
					'\t\t{ condition: sessionTableStands(name), body: [{ kind: "truncateSessionTable", name }] }',
				why: "The emptying truncates at every use, as carrierStandUp did: a carrier within its page gets a new file at each use, and every backend of the database walks every plan it holds for the invalidations."
			}
		]
	})
