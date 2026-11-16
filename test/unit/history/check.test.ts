/**
 * The history checker against a naive enumerator, over generated histories of two or three operations on one keyed
 * relation.
 *
 * The checker is itself an oracle, so its failure modes are silent: accepting a history no serial order explains (a
 * vacuous oracle), refusing one some order does (a false alarm in every suite that uses it), or letting an abort pass
 * that nothing in the history explains. The enumerator here states the same contract with no pruning and no
 * memoization. Every writer runs SERIALIZABLE, and the contract is:
 *
 * - the committed state holds the key;
 * - every abort, and every discarded attempt of a grizzle operation, has an operation overlapping it in real time, and
 *   a cause a concurrent transaction gives: a direct writer's 40001 or 40P01, a discarded attempt's TransientFailure of
 *   a concurrent reason (never GeneratedSerialUnique). Only a direct writer aborts: a grizzle writer
 *   calls again after each TransientFailure until a call answers;
 * - a grizzle operation refused as its ChangeSet compiled (UnorderableStratum) is one its writer's model refuses so,
 *   whatever the state: in this box, whose every operation writes one fact, never;
 * - some order of the committed operations that respects real time replays each through its writer's model, each
 *   committing there (a grizzle no-change exactly no-change), and ends at the committed state;
 * - each refusal has such an order of the committed operations and itself, in which the model refuses it at its place
 *   with its law, and its witness names the violating fact's key: grizzle's always, a direct writer's never, since
 *   PostgreSQL states a native key's violation in prose. A direct writer's key refusal is also explained where an
 *   operation after it in the order, overlapping it in real time, inserted at the key a fact its place does not hold:
 *   an occupant committed after its snapshot, which PostgreSQL's key check meets whatever the snapshot.
 *
 * The box is defined by its bounds: facts of Worker(id, name) with an id of 1 or 2 and a name of a or b; a lawful
 * initial state; each operation an insertion or a deletion of one fact, by a grizzle writer or a direct one, over an
 * interval of a clock of seven ticks; each outcome its writer can report, with each discarded attempt's reason of
 * either kind, and each refusal's witness the written fact's key, a key outside the box, or none; and the committed
 * state any set of the box's facts, one breaking the key among them, or the state some order of the operations reaches.
 *
 * Features: explained and unexplained histories, aborts, refusals and discarded attempts; a wrong witness; three
 * operations explained; intervals that touch; an unorderable outcome its model orders.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checkHistory } from "#test/support/history/check.ts"
import {
	type CheckerFeature,
	explained,
	historyGen,
	sameKeys,
	hostWitnessOf
} from "#test/unit/history/check.fixtures.ts"

/**
 * The history checker agrees with a naive enumerator on generated histories of two or three operations on one keyed
 * relation.
 *
 * Budget: its suite's count before the conversion (unit/history-checker: 3000 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theHistoryCheckerAgreesWithANaiveEnumeratorOnGeneratedHistoriesOfTwoOrThreeOperationsOnOneKeyedRelation =
	property.explore(historyGen, {
		needs: {},
		situations: [
			"explained",
			"unexplained",
			"explained abort",
			"unexplained abort",
			"explained refusal",
			"unexplained refusal",
			"a wrong witness",
			"explained discarded attempt",
			"unexplained discarded attempt",
			"three operations explained",
			"intervals that touch",
			"an unorderable outcome its model orders"
		] satisfies ReadonlyArray<Reached<CheckerFeature>>,
		check: (_, noted: Case<CheckerFeature>) => (h) =>
			Effect.sync(() => {
				const want = explained(h)
				const got = checkHistory(h).ok
				noted.note(want ? "explained" : "unexplained")
				if (want && h.recorded.length === 3) {
					noted.note("three operations explained")
				}
				if (Arr.some(h.recorded, (r) => Arr.some(h.recorded, (q) => q.end === r.start))) {
					noted.note("intervals that touch")
				}
				if (Arr.some(h.recorded, (r) => r.outcome.kind === "aborted")) {
					noted.note(want ? "explained abort" : "unexplained abort")
				}
				if (Arr.some(h.recorded, (r) => r.outcome.kind === "invariant-rejected")) {
					noted.note(want ? "explained refusal" : "unexplained refusal")
				}
				if (
					Arr.some(
						h.recorded,
						(r) =>
							r.outcome.kind === "invariant-rejected" &&
							!sameKeys(r.outcome.keys, hostWitnessOf(r.kind, r.ops))
					)
				) {
					noted.note("a wrong witness")
				}
				if (Arr.some(h.recorded, (r) => r.outcome.kind === "unorderable")) {
					noted.note("an unorderable outcome its model orders")
				}
				if (Arr.some(h.recorded, (r) => r.kind === "grizzle" && r.transients.length > 0)) {
					noted.note(want ? "explained discarded attempt" : "unexplained discarded attempt")
				}
				assert.equal(
					got,
					want,
					`the checker says ${got ? "explained" : "unexplained"}, the enumerator not`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "a naive enumerator of every real-time-respecting serial order"
		},
		budget: { runs: 3000, steered: 0 },
		kept: [],
		kills: []
	})
