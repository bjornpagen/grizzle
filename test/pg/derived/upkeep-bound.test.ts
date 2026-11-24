/**
 * A one-row write's judge work at COMMIT is bounded by its delta, however many rows its declared unit holds: a derived
 * relation is stored only where its upkeep costs what the delta that runs it bounds (analysis/derived/storage.ts
 * deltaBounded), its unit wider than its declared unit's, so a write re-derives the stored rows at the keys it touched
 * alone (physical/ddl/rules.ts upkeepBlock); a derived relation whose unit is its declared unit's own, whose upkeep
 * would re-derive the whole unit at every write of it, a learner's whole history at each answer, is live, its readers
 * reading its definition at the keys they bind. On PostgreSQL 19, over UpkeepBound (upkeep-bound.fixtures.ts): a
 * learner's enrolment, sessions and answers, closed, in the learner's unit; SessionCount, each session's answers
 * counted, stored at (child, s); Answered, the learners who answered, live at (child); and a containment over each,
 * which the judge probes.
 *
 * Each case enrols learner 1 with a few sessions of answers, committed, and measures the judge's work at a fresh
 * answer's COMMIT: every statement the judge runs over the written deltas, SessionCount's upkeep's DELETE and INSERT
 * and each rule's probe, the upkeep's alike, explained with ANALYZE before the judge runs, in a transaction rolled back
 * (test/support/judge.ts judgeRun); then adds more sessions of answers to the same learner, committed, and measures
 * again.
 *
 * Oracle: invariance: each statement reads the same rows, of stored relations and of the deltas, beside the few
 * sessions and beside the many, the rows counted over every loop, never a clock. SessionCount's upkeep re-derives the
 * one session the answer touched, and the probe of Answered's rule reads its definition at the answer's learner and the
 * learner's enrolment; stored at (child), Answered's upkeep would read every answer of the learner, which the second
 * measure's sessions add to.
 *
 * The box, exhausted: one or four sessions before, sixteen or sixty-four added, of one or three answers each.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runUpkeep,
	type UpkeepFeature,
	upkeepBoundTemplate,
	upkeepGen
} from "#test/pg/derived/upkeep-bound.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A one-row write's judge work at COMMIT reads the same rows however many rows its declared unit holds. */
export const aOneRowWritesJudgeWorkAtCommitIsBoundedByItsDeltaHoweverManyRowsItsUnitHolds =
	property.exhaust(finite(upkeepGen), {
		needs: { upkeep: Substrate.fresh(upkeepBoundTemplate) },
		situations: [
			"the stored relation's upkeep ran",
			"the live relation's rule probed"
		] satisfies ReadonlyArray<Reached<UpkeepFeature>>,
		check:
			({ upkeep }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* upkeep
					const session = yield* substrate.session({ ...ownerSession(), label: "upkeep bound" })
					yield* runUpkeep(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "universal",
			name: "invariance: each statement the judge runs at a one-row write's COMMIT, a stored relation's upkeep's and a rule's alike, reads the same rows beside a few rows of its declared unit and beside many"
		},
		box: "one or four sessions of the learner before the write, sixteen or sixty-four added, of one or three answers each",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\tunit.fields.length > unit.declared.fields.length ||\n",
				replacement: "\tunit.fields.length >= unit.declared.fields.length ||\n",
				why: "A derived relation is stored at its declared unit's own width: Answered is kept at (child), its upkeep re-deriving the learner's every answer at each answer, so its INSERT reads the history the added sessions grow."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\tkeyedAt(unit, known) ||\n\tfoundedAt(owned, unit.declared.unit)\n",
				replacement: "\tkeyedAt(unit, known) ||\n\ttrue\n",
				why: "Every declared unit counts as sealed, so every unit-local derived relation is stored, Answered at (child) among them, its upkeep reading the learner's whole history at each answer."
			}
		]
	})
