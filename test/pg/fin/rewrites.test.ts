/**
 * Ordered rewrites through grizzle's lowering, on PostgreSQL 19 (fin.md §4.5, §11, "Ordered rewrites" and "The
 * shrink order"): a member's removal, an insertion at a slot, a swap and an append are each a rewrite of the family's
 * suffix, sent as the planner sends it, deletes, then the owner's one count update, then inserts, and each commits to
 * the families it states. Sent in the wrong order, a shrink is refused: its count update lowers the count while rows
 * remain at or above it, the owner axis's cascade carries the lower count into their copies inside that statement, and
 * the bound CHECK (i < ‹n›), never deferred, refuses it there with 23514, reporting the family's law. That is the
 * shrink-order cascade failure the RFC's history found by hand (testing doctrine, "The bar"), rediscovered here as the
 * misordered plan's refusal.
 *
 * - **A second implementation:** the families model (test/support/families/mutate.ts run) of each transaction;
 *   PostgreSQL judging grizzle's installed lowering must agree on the verdict, the moment and a constraint the model
 *   allows there, and a commit must read back as the model's families (family.ts judgedFamily).
 *
 * The box (doctrine rule 9): owner 0 with every ordered family of zero to four members beside owner 1 with one, every
 * removal, insertion of one new member at each slot, swap of two slots and append, each sent in the prescribed order,
 * with its count update first, and with its inserts before its deletes.
 *
 * Each case writes its families by one transaction that replaces the seat's rows, then sends its rewrite as one
 * transaction checked as its COMMIT would check it and rolled back, or ended by a real COMMIT, as the case draws its
 * end on its tape (installed.ts endGen): the box holds every case under both ends.
 */

import { deepEquals } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { constraintOf, Disagreed, familySeatIn, judgedFamily } from "#test/pg/fin/family.ts"
import { endedBy, endGen, refusedAtCommitBy } from "#test/pg/fin/installed.ts"
import {
	before,
	type RewriteFeature,
	rewriteGen,
	rewritesTemplate,
	shrinks,
	statementsOf
} from "#test/pg/fin/rewrites.fixtures.ts"
import { run, settledOf } from "#test/support/families/mutate.ts"
import { storedOf } from "#test/support/families/theorem.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Ordered rewrites and the shrink order through grizzle's lowering on PostgreSQL 19 commit every suffix rewrite sent deletes, count, inserts, and refuse a shrink whose count comes first at that count by the bound.
 */
export const orderedRewritesAndTheShrinkOrderThroughGrizzlesLoweringOnPostgreSQL19CommitEverySuffixRewriteSentDeletesCountInsertsAndRefuseAShrinkWhoseCountComesFirstAtThatCountByTheBound =
	property.exhaust(finite(rewriteGen), {
		needs: { ordered: Substrate.seat(rewritesTemplate) },
		situations: [
			"a case ended by COMMIT",
			"a case ended by SET CONSTRAINTS and ROLLBACK",
			"remove prescribed committed",
			"insert-at prescribed committed",
			"swap prescribed committed",
			"append prescribed committed",
			"remove count first refused",
			"insert-at count first committed",
			"remove inserts first refused",
			"swap inserts first refused",
			"a shrink sent count first refused at its count by the bound, 23514, reporting the family's law"
		] satisfies ReadonlyArray<Reached<RewriteFeature>>,
		check:
			({ ordered }, c: Case<RewriteFeature>) =>
			(r) =>
				Effect.gen(function* () {
					const taken = yield* ordered
					const f = yield* familySeatIn("ordered", taken, "rewrites")

					const { statements, after } = statementsOf(r)
					const outcome = run("ordered", before(r.members), statements)
					const j = yield* judgedFamily(
						f,
						{ kind: "replaced", before: storedOf(before(r.members)) },
						statements,
						settledOf(outcome),
						c.draw(endGen)
					)
					c.note(`${r.form} ${r.sending} ${j.committed ? "committed" : "refused"}`)
					c.note(endedBy(j.end))
					if (Option.exists(j.moment, (m) => m.kind === "commit")) {
						c.note(refusedAtCommitBy(j.end))
					}
					if (
						r.sending === "prescribed" &&
						(!j.committed || outcome.kind !== "committed" || !deepEquals(outcome.after, after))
					) {
						return yield* new Disagreed({
							message: `the prescribed ${r.form} of ${Formatter.format(r)} was ${j.verdict}, or committed to other families than ${Formatter.format(after)}`
						})
					}
					if (r.sending === "count first" && shrinks(r)) {
						const bound = Option.flatMap(j.refusedBy, (k) => constraintOf(f, k))
						const counted = Arr.findFirstIndex(statements, (s) => s.kind === "count")
						if (
							!Option.contains(bound, "bound") ||
							!Option.exists(
								j.moment,
								(m) => m.kind === "statement" && Option.contains(counted, m.index)
							) ||
							!Option.exists(j.refusedBy, (k) => Option.contains(k.law, f.law))
						) {
							return yield* new Disagreed({
								message: `a shrink sent count first was ${j.verdict}, not refused at its count by the bound reporting the family's law: ${Formatter.format(r)}`
							})
						}
						c.note(
							"a shrink sent count first refused at its count by the bound, 23514, reporting the family's law"
						)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the families model of each transaction (test/support/families/mutate.ts run); the prescribed order's families as the rewrite states them"
		},
		box: "owner 0 with every ordered family of zero to four members, owner 1 with one: every removal, insertion of a new member at each slot, swap of two slots and append, each sent deletes-count-inserts, count first, and inserts before deletes, each case ended by a real COMMIT and by the checked end",
		kept: [],
		kills: []
	})
