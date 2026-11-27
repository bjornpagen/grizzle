/**
 * A one-row write's judge work at COMMIT is bounded by its delta, however many rows its declared unit holds: a derived
 * relation is stored only where its upkeep costs what the delta that runs it bounds (analysis/derived/storage.ts
 * deltaBounded), its unit wider than its declared unit's, so a write re-derives the stored rows at the keys it touched
 * alone (physical/ddl/rules.ts upkeepBlock); a derived relation whose unit is its declared unit's own, whose upkeep
 * would re-derive the whole unit at every write of it, a learner's whole history at each answer, is live, its readers
 * reading its definition at the keys they bind. On PostgreSQL 19, over UpkeepBound (upkeep-bound.fixtures.ts): a
 * learner's enrolment, sessions and answers, closed, in the learner's unit; SessionCount, each session's answers
 * counted, stored at (child, s); Answered, the learners who answered, at (child), stored by its checked delta form
 * (analysis/theory/upkeep.ts deltaBoundOf); Tally, each learner's answers counted, a fold at (child), live; and a
 * containment over each stored one, which the judge probes.
 *
 * Each case enrols learner 1 with a few sessions of answers beside 2,048 other learners of one session and answer each,
 * committed, and measures the judge's work at a fresh answer's COMMIT:
 * every statement the judge runs over the written deltas, SessionCount's upkeep's DELETE and INSERT and each rule's
 * probe, the upkeep's alike, explained with ANALYZE before the judge runs, in a transaction rolled back
 * (test/support/judge.ts judgeRun), each under its routine's advice (test/support/advice.ts routineAdviceHeld); then
 * adds more sessions of answers to the same learner, committed, and measures again.
 *
 * Oracle: a bound and invariance: each statement does the same work, the rows it reads of stored relations and of the
 * deltas (judge.ts scannedWork), beside the few sessions and beside the many, the rows counted over every loop, never a
 * clock. SessionCount's upkeep re-derives the one session the answer touched, and Answered's reads
 * the answer and its row at the learner by key; stored at (child), Tally's upkeep would read every answer of the
 * learner, which the second measure's sessions add to.
 *
 * The box, exhausted: one or four sessions before, sixteen or sixty-four added, of one or three answers each.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type FoldFeature,
	foldGen,
	latestBound,
	runFold,
	runSpan,
	runUpkeep,
	type SpanFeature,
	spanGen,
	unmovedBound,
	spanMomentFirst,
	spanShownFirst,
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
			"Answered's upkeep ran"
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
			name: "a bound and invariance: each statement the judge runs at a one-row write's COMMIT, a stored relation's upkeep's and a rule's alike, does the same work beside a few rows of its declared unit and beside many"
		},
		box: "one or four sessions of the learner before the write, sixteen or sixty-four added, of one or three answers each",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					"\t(unit.fields.length > unit.declared.fields.length && unitRooted(definition, known, unit)) ||\n",
				replacement:
					"\t(unit.fields.length >= unit.declared.fields.length && unitRooted(definition, known, unit)) ||\n",
				why: "A derived relation is stored at its declared unit's own width: Tally is kept at (child), its upkeep re-deriving the learner's every answer at each answer, so its INSERT reads the history the added sessions grow."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					"\tunitKeyed(definition, known, unit) ||\n\tfoundedAt(owned, unit.declared.unit)\n",
				replacement: "\tunitKeyed(definition, known, unit) ||\n\ttrue\n",
				why: "Every declared unit counts as sealed, so every unit-local derived relation is stored, Tally at (child) among them, its upkeep reading the learner's whole history at each answer."
			}
		]
	})

/**
 * A successor's upkeep reads one row of the relation its fold reads for each row before it, however many rows past the
 * cut the unit holds (analysis/theory/successor.ts): Span, each item shown with its session's least later moment
 * (ledger's presentedSpans), stored at (child, s), re-derives the session a moment touched at its COMMIT, each item's
 * end the one moment past it, read by one descent of Moment's key order (analysis/theory/navigate.ts #chain), whichever
 * match the rule states first. Over SpanBound (upkeep-bound.fixtures.ts), each case shows one or four items in session 1
 * with four moments after them, beside 2,048 other learners' sessions, committed, and measures the judge's work at a
 * later moment's COMMIT; then adds sixteen or sixty-four moments more, committed, and measures again.
 *
 * Oracle: a bound and invariance, as above: each statement does the same work beside four moments and beside the many.
 * A fold over
 * every moment past each item, the rule as written, reads the added moments for every item (ledger's presentedSpans,
 * 180 to 244 pages a write).
 */
export const aSuccessorsUpkeepReadsOneRowPastTheCutForEachRowBeforeItHoweverManyItsUnitHolds =
	property.exhaust(finite(spanGen), {
		needs: { shown: Substrate.fresh(spanShownFirst), moment: Substrate.fresh(spanMomentFirst) },
		situations: [
			"the successor's upkeep ran, shown first",
			"the successor's upkeep ran, moment first"
		] satisfies ReadonlyArray<Reached<SpanFeature>>,
		check:
			({ shown, moment }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* drawn.order === "shown first" ? shown : moment
					const session = yield* substrate.session({ ...ownerSession(), label: "successor bound" })
					yield* runSpan(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "universal",
			name: "a bound and invariance: each statement the judge runs at a moment's COMMIT does the same work beside a few moments of the session past its items and beside many"
		},
		box: "the item matched first or the moment, one or four items shown in the session, sixteen or sixty-four moments added after the first measure",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\tconst successor = successorAt(read)\n",
				replacement: "\t\t\tconst successor: Successor | undefined = undefined\n",
				why: "A successor read by its rows past the cut, folded: ledger's presentedSpans' upkeep reads every later moment of the sitting for each presentation, 180 to 244 pages a write where one descent per presentation reads a few."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\tconst ready = reads.some((r) => !waiting(r))\n",
				replacement: "\t\t\tconst ready = false\n",
				why: "A successor placed before the read that binds its cut: a rule matching the moment first reads its moments before the item's instant is bound, every moment of the sitting for each item, though admission rooted it at the item by one probe."
			},
			{
				file: "packages/engine/src/analysis/theory/successor.ts",
				original: '\tconst dir = fn === "min" ? "asc" : "desc"\n',
				replacement: '\tconst dir = fn === "min" ? "desc" : "asc"\n',
				why: "A least fold read by the greatest row past its cut: each presentation's span ends at the sitting's last moment, a span covering every later presentation's."
			}
		]
	})

/**
 * A fold or a projection that derives one fact at a unit reads one row of the unit at its upkeep, however many rows the
 * unit holds: Latest, each session's latest moment (ledger's latestMoments), its fold of Moment's last key field at the
 * session read as Moment's last row there, one descent (analysis/theory/navigate.ts extremeOf); Unmoved, each session
 * showing an item at an instant no moment stands at, its head the session alone, read by one witness (oneWitness). Over
 * SpanBound, each case holds four items and four moments in session 1 beside 2,048 other learners' sessions, committed,
 * measures the judge's work at a later moment's COMMIT, adds sixteen or sixty-four rows to the session, later moments or
 * unmoved items, committed, and measures again.
 *
 * Oracle: a bound and invariance, as above, and each table's fact at the session: the latest moment, the session
 * unmoved.
 */
export const aFoldThatDerivesOneFactAtAUnitReadsOneRowOfItAtItsUpkeepHoweverManyItHolds =
	property.exhaust(finite(foldGen), {
		needs: { latest: Substrate.fresh(latestBound), unmoved: Substrate.fresh(unmovedBound) },
		situations: ["the latest upkeep ran", "the unmoved upkeep ran"] satisfies ReadonlyArray<
			Reached<FoldFeature>
		>,
		check:
			({ latest, unmoved }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* drawn.shape === "latest" ? latest : unmoved
					const session = yield* substrate.session({ ...ownerSession(), label: "fold bound" })
					yield* runFold(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "universal",
			name: "a bound and invariance: each statement the judge runs at a moment's COMMIT does the same work beside a few rows of the session and beside many, each table's fact at the session as its definition states it"
		},
		box: "the latest moment of a session or a session with an unmoved item, sixteen or sixty-four rows added to the session",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst extreme = extremeOf(stage, interned)\n",
				replacement: "\t\tconst extreme = undefined\n",
				why: "A fold of a key's last field at its prefix read by every row there: ledger's latestMoments re-derives a sitting's latest moment from every moment of the sitting at each write, 19 to 27 pages on the helper's sd6 row, where one descent finds it."
			},
			{
				file: "packages/engine/src/analysis/theory/successor.ts",
				original: "\tif (cut === undefined) {\n\t\treturn { field, variable, dir }\n\t}\n",
				replacement: "\tif (cut === undefined) {\n\t\treturn undefined\n\t}\n",
				why: "A fold with no cut read as no successor: the latest moment of a sitting folded from every moment of it, though its last row in the key's order is its fact."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst witnessed = oneWitness(navigated)\n",
				replacement: "\t\tconst witnessed = undefined\n",
				why: "A rule deriving one fact at a unit read by all its rows: a sitting with an unsuspended visit re-derived from every visit of the sitting at each write, 18 pages at enter on the helper's sd6 row, where its first witness derives it."
			}
		]
	})
