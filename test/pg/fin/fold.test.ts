/**
 * Folds through grizzle's lowering, on PostgreSQL 19 (fin.md §4.3, §11 "Identities", w4-w7 §2.3): the int4 sum folded
 * by grizzle's `fold` over an ordered family with named accumulators (folds.ts FOLD_SPECS "sum of int4"), families of
 * at most four members over five step values written by a direct SQL writer, the owner, with the accumulators the
 * reference fold computes and with each single junk accumulator, and PostgreSQL's verdict judged three ways.
 *
 * - **Two implementations agreeing:** the reference fold (test/support/families/fold.ts folded), exact; and the host's
 *   fill (runtime/write/fill.ts filler over the installation's own families), which must fill every lawful family
 *   exactly as the reference does before PostgreSQL judges what both wrote. Every lawful state must commit and read
 *   back exactly.
 * - **The fold's model** (fold.ts foldPredicted): each after proved by `CHECK ((after = combine(before, x)) IS TRUE)`
 *   in exact arithmetic, every after drawn, never generated, per the ruling; the identity pins at the first slot and at
 *   the empty family; the befores carried on the predecessor axis and the ends on the last axis. A junk accumulator
 *   must be refused at the model's moment, by an installed constraint whose role (folds.ts foldNativeOf) the model
 *   allows there, with its SQLSTATE, reporting the family's or the fold's law.
 *
 * The junk kinds (doctrine rule 6), each a named variant: the whole fold seeded from a junk identity, every before,
 * after and end consistent with it (the fold accumulator unconstrained at slot 0); one before; one after; one end; an
 * empty family's end. Features are (monoid, axis, verdict).
 *
 * Each case's transaction runs on a seat with no rows and is checked as its COMMIT would check it and rolled back, or
 * ends by a real COMMIT whose rows are read, as the case draws its end on its tape (installed.ts endGen):
 * the search requires both ends, each meeting a refusal at commit, so it shows a real COMMIT never decides otherwise
 * than the checked end.
 */

import { deepEquals } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Option, Result } from "effect"
import {
	axisOf,
	familyOf,
	type FoldFeature,
	foldSeat,
	ORACLE,
	SPEC,
	sketchGen,
	storedOf
} from "#test/pg/fin/fold.fixtures.ts"
import { grizzleFold } from "#test/support/families/fold.ts"
import {
	byMember,
	Disagreed,
	emptyFold,
	foldSeatOf,
	foldWriteOf,
	hostFilled,
	type Judging,
	judgedFold,
	nothingAround
} from "#test/support/pg/fin/folds.ts"
import { endedBy, endGen, refusedAtCommitBy, seatIn } from "#test/support/pg/fin/installed.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Its search budget: the fewest cases a run spends at which every kill it declares is killed and every situation it
 * requires reached. A kill's trial runs the witnesses alone, its kept cases, its floor stream of ⌈runs / 4⌉ cases and its
 * steered phase while a situation is unreached, all fixed by the property's identity and its floor, so runs within one
 * floor draw the same witnesses, and a run adds `runs` rotating cases.
 *
 * @limitKind measured
 * @owner grizzle's test/pg/fin/fold.test.ts
 * @unit independent cases (runs) and steered cases
 * @scope one run of foldsThroughGrizzlesLoweringCommitTheReferenceFoldAndRefuseEverySingleJunkAccumulator
 * @evidence `~/.cache/grizzle/CULL-FIN-tools/measure.sh r<runs> <runs> 200 <files>` over test/pg/fin's counted,
 *   lemmas, fold, plans and counted-set at runs 1, 4, 8, 16 and 32, the steered cases capped at 200, each a
 *   `toolchain-test run` of the files that ran the kills of every property it passed; uncommitted logs
 *   ~/.cache/grizzle/CULL-FIN-tools/measure-r{1,4,8,16,32}.log
 * @observed 2026-11-23 03:50 to 04:26 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load 200 to 520 from other lanes;
 *   PostgreSQL 19.0 (scripts/pg/pin.env) as the lane's in-memory family; Node 26.13.1; grizzle f87b2aaab with lane
 *   CULL-FIN's cull of test/pg/fin; TEST_SEED=2219874524
 * @workload the property with its two kills, the first slot's pin and the empty family's pin left out
 * @result steered cases to reach every required situation: 128 at a floor of one case (runs 1, 4), 128 at two (runs 8),
 *   80 at four (runs 16), 80 at eight (runs 32); both kills killed at every budget, no failure
 * @decision a floor of four spends the fewest, 97 cases a run at runs 13, the fewest runs with that floor, against 130 at a
 *   floor of one (runs 1), 135 at two (runs 5) and 117 at eight (runs 29); the steered cap the 80 it needs. Floors of
 *   three, five, six and seven are unmeasured; the exhaustive box ran 4,766 cases (f1bf91a2f)
 * @revalidate a change of the property, its space, its situations or the code its cases run, which moves its witnesses;
 *   a red that reaches no situation (FeaturesUnreached) or a kill that survives
 */
const foldBudget = { runs: 13, steered: 80 } as const

/**
 * Folds through grizzle's lowering on PostgreSQL 19 commit the reference fold of a family of at most four members over
 * five values, and refuse a single junk accumulator by the native that owns its axis, each case on a clone of its own
 * of the int4 sum's schema.
 */
export const foldsThroughGrizzlesLoweringCommitTheReferenceFoldAndRefuseEverySingleJunkAccumulator =
	property.explore(sketchGen(SPEC.planes.length), {
		needs: { fold: Substrate.fresh(foldSeat) },
		situations: [
			"a case ended by COMMIT",
			"a case ended by SET CONSTRAINTS and ROLLBACK",
			"a case refused at a real COMMIT",
			"a case refused at its checked commit",
			"sum of int4 lawful committed",
			"sum of int4 a junk seed refused first slot",
			"sum of int4 a junk end of an empty family refused empty family",
			"sum of int4 a junk after refused combine",
			"sum of int4 a junk before past the first slot refused combine",
			"sum of int4 a junk end refused last axis",
			"sum of int4 a junk step at the first slot refused first slot",
			"sum of int4 a junk step past the first slot refused predecessor axis"
		] satisfies ReadonlyArray<Reached<FoldFeature>>,
		check:
			({ fold }, c: Case<FoldFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(fold, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const seat = yield* seatIn(taken, ["Owner", "Member"], SPEC.label)
								const grizzle: Judging = {
									label: SPEC.label,
									fold: foldSeatOf(SPEC, seat),
									lowering: grizzleFold(SPEC.shape)
								}
								const stored = storedOf(SPEC, sketch)
								const axis = axisOf(sketch.junk, sketch.values.length)
								if (sketch.junk.kind === "none") {
									const host = hostFilled(grizzle.fold, familyOf(SPEC, sketch))
									if (
										Result.isFailure(host) ||
										!deepEquals(byMember(host.success), byMember(stored))
									) {
										return yield* new Disagreed({
											message: `${SPEC.label}: the host's fill ${Result.isFailure(host) ? host.failure : Formatter.format(host.success)} is not the reference fold ${Formatter.format(stored)}`
										})
									}
								}
								const end = c.draw(endGen)
								const j = yield* judgedFold(
									grizzle,
									emptyFold,
									foldWriteOf(stored),
									nothingAround,
									end
								)
								c.note(`${SPEC.label} ${axis} ${j.verdict}`)
								c.note(endedBy(j.end))
								if (Option.exists(j.moment, (m) => m.kind === "commit")) {
									c.note(refusedAtCommitBy(j.end))
								}
								if (sketch.junk.kind !== "none" && j.verdict === "committed") {
									return yield* new Disagreed({
										message: `${SPEC.label}: ${axis} committed: ${Formatter.format(stored)}`
									})
								}
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: ORACLE,
		budget: foldBudget,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\t\t\treturn index",
				replacement: "\t\t\t\t\treturn undefined",
				why: "The first slot's pin left out: a junk seed of a family's first member commits."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\t\t\treturn fieldColumn(this.#family.count)",
				replacement: "\t\t\t\t\treturn undefined",
				why: "The empty family's pin left out: a junk end of an empty family commits."
			}
		]
	})
