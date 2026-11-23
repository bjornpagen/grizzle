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
 * ends by a real COMMIT whose rows are read and cleared, as the case draws its end on its tape (installed.ts endGen):
 * the search requires both ends, each meeting a refusal at commit, so it shows a real COMMIT never decides otherwise
 * than the checked end.
 */

import { deepEquals } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
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
import {
	byMember,
	Disagreed,
	emptyFold,
	foldSeatOf,
	foldWriteOf,
	hostFilled,
	type Judging,
	judgedFold
} from "#test/pg/fin/folds.ts"
import { endedBy, endGen, refusedAtCommitBy, seatIn } from "#test/pg/fin/installed.ts"
import { grizzleFold } from "#test/support/families/fold.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Folds through grizzle's lowering on PostgreSQL 19 commit the reference fold of every family of at most four members
 * over five values, and refuse every single junk accumulator by the native that owns its axis, each case on the
 * worker's seat of the int4 sum's schema.
 */
export const foldsThroughGrizzlesLoweringCommitTheReferenceFoldAndRefuseEverySingleJunkAccumulator =
	property.exhaust(finite(sketchGen(SPEC.planes.length)), {
		box: "owner 0 with every family of zero to four members over the seat's five step values, each written lawful, and every family of zero to three members with every single junk accumulator: a junk seed, one before, one after, one end, each case ended by a real COMMIT and by the checked end",
		needs: { fold: Substrate.seat(foldSeat) },
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
								/** Uninterruptible: a seat's transaction and its clearing run whole, so one seat's failure never leaves another's rows. */
								const end = c.draw(endGen)
								const judgedOn = (judging: Judging) =>
									Effect.uninterruptible(
										judgedFold(judging, emptyFold, foldWriteOf(stored), [], end)
									)
								const j = yield* judgedOn(grizzle)
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
