/**
 * A session table's emptying on PostgreSQL 19 (sql/print.ts sessionTableEmptied), through a write's carrier, which the
 * session stands up once and every use empties by its session function (sql/print.ts carrierEmptying): over drawn
 * sequences of two to six uses on one session, each writing no row, one, or more than the pages the carrier's emptying
 * keeps hold (sql/print.ts sessionTableKeptBytes), narrow in its heap or wide in its TOAST table, and ending in COMMIT
 * or ROLLBACK, a carrier keyed or not, every emptying leaves the carrier with no row; keeps its file, so it sent no
 * invalidation, where the use before left its heap and its TOAST table's each within what it keeps; gives it back
 * where either held more; and leaves each within what it keeps.
 *
 * Features: a carrier that kept its file and one that gave it back, outgrown in its heap and in its TOAST table, and an
 * emptying after a rollback.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { runUses, type SessionTableFeature, usesGen } from "#test/pg/sql/session-tables.fixtures.ts"
import { ownerSession, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A session table's emptying keeps its file while it holds the pages it keeps and gives the file back once it holds
 * more.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/sql/session-tables.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/sql/session-tables.test.ts` at its budget
 *   before, the runner's, runs 150 and steered 200, each kill's verdict printed with where its witnesses went red
 *   (judgedLine with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log;
 *   this budget run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result each of its 2 kills went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const aSessionTablesEmptyingKeepsItsFileWhileItHoldsThePagesItKeepsAndGivesTheFileBackOnceItHoldsMore =
	property.explore(usesGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
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
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "the carrier's rows, file and heap and TOAST bytes at each emptying, against the bytes the use before left: none holds a row, a file within its page kept, one past it given back, each within its page after"
		},
		budget: { runs: 1, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original:
					'\t\t{ condition: sessionTableOvergrown(name), body: [{ kind: "truncateSessionTable", name }] }',
				replacement:
					'\t\t{ condition: lit.bool(false), body: [{ kind: "truncateSessionTable", name }] }',
				why: "The emptying never truncates, a DELETE at every use as e8de84026's judge did: a carrier refilled past its page keeps every page, and a session's carriers grow by each use."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original:
					'\t\t{ condition: sessionTableOvergrown(name), body: [{ kind: "truncateSessionTable", name }] }',
				replacement:
					'\t\t{ condition: lit.bool(true), body: [{ kind: "truncateSessionTable", name }] }',
				why: "The emptying truncates at every use: a carrier within its page gets a new file at each use, and every backend of the database walks every plan it holds for the invalidations."
			}
		]
	})
