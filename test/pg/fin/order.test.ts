/**
 * Row order through grizzle's lowering, on PostgreSQL 19rc2 (fin.md §11, "Row order"): a single INSERT whose rows
 * arrive successor before predecessor passes the family's immediate predecessor axis, since a foreign key is checked at
 * the end of its statement, not per row; and the same rows split so a successor's statement ends before its
 * predecessor's begins are refused at that statement when the family is ordered (its predecessor axis immediate), and
 * commit when it is counted (its predecessor axis deferred, for swap-with-last).
 *
 * - **A second implementation:** the families model of each transaction (test/support/families/mutate.ts run), which
 *   checks each constraint at the moment the RFC's lowering does; PostgreSQL, judging grizzle's installed lowering,
 *   must agree on the verdict, the moment and a constraint the model allows there (family.ts judgedFamily).
 *
 * The box (doctrine rule 9): owners 0 and 1 with families whose lengths sum to at most five, for each shape every order
 * of all their rows in one INSERT, and every cut of the rows in descending and in ascending slot order into two
 * INSERTs.
 *
 * Each case's transaction runs on a seat with no rows and is checked as its COMMIT would check it and rolled back, or
 * ends by a real COMMIT whose rows are read and cleared, as the case draws its end on its tape (installed.ts endGen):
 * the box requires both ends.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { Disagreed, familySeat, judgedFamily } from "#test/pg/fin/family.ts"
import { endedBy, endGen, refusedAtCommitBy } from "#test/pg/fin/installed.ts"
import {
	type OrderFeature,
	sketchGen,
	statementsOf,
	successorFirst
} from "#test/pg/fin/order.fixtures.ts"
import { run, settledOf } from "#test/support/families/mutate.ts"
import { type Shape, SHAPES } from "#test/support/families/theorem.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Row order through grizzle's lowering on PostgreSQL 19rc2 pass the immediate predecessor axis on one insert of a family's rows in every order, successor first included, and check it at each statement of a cut write when ordered.
 */
export const rowOrderThroughGrizzlesLoweringOnPostgreSQL19rc2PassTheImmediatePredecessorAxisOnOneInsertOfAFamilysRowsInEveryOrderSuccessorFirstIncludedAndCheckItAtEachStatementOfACutWriteWhenOrdered =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.installing },
		situations: [
			"a case ended by COMMIT",
			"a case ended by SET CONSTRAINTS and ROLLBACK",
			"ordered one insert committed",
			"ordered one insert with a successor first committed",
			"counted one insert with a successor first committed",
			"ordered descending cut refused",
			"ordered ascending cut committed",
			"counted descending cut committed",
			"counted ascending cut committed"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check:
			({ substrate }, c: Case<OrderFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const seats = yield* Effect.forEach(SHAPES, (shape) =>
							familySeat(shape, `order ${shape}`)
						)
						const seatOf = (shape: Shape) =>
							Arr.getUnsafe(
								Arr.filter(seats, (s) => s.shape === shape),
								0
							)

						const statements = statementsOf(sketch)
						const outcome = run(sketch.shape, [], statements)
						const j = yield* judgedFamily(
							seatOf(sketch.shape),
							{ kind: "empty" },
							statements,
							settledOf(outcome),
							c.draw(endGen)
						)
						c.note(endedBy(j.end))
						if (Option.exists(j.moment, (m) => m.kind === "commit")) {
							c.note(refusedAtCommitBy(j.end))
						}
						if (sketch.sent.kind === "one insert") {
							if (!j.committed) {
								return yield* new Disagreed({
									message: `one insert of ${Formatter.format(sketch.sent.rows)} was ${j.verdict}`
								})
							}
							c.note(
								successorFirst(sketch.sent.rows)
									? `${sketch.shape} one insert with a successor first committed`
									: `${sketch.shape} one insert committed`
							)
						} else {
							c.note(
								`${sketch.shape} ${sketch.sent.order} cut ${j.committed ? "committed" : "refused"}`
							)
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the families model of each transaction (test/support/families/mutate.ts run), each constraint at the RFC lowering's moment"
		},
		box: "owners 0 and 1 with families of lengths summing to at most five, ordered and counted: every order of their rows in one INSERT, and every cut of their rows in descending and in ascending slot order into two INSERTs, after the owners, each case ended by a real COMMIT and by the checked end",
		kept: [],
		kills: []
	})
