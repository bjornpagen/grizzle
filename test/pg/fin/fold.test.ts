/**
 * Folds through grizzle's lowering, on PostgreSQL 19rc2 (fin.md §4.3, §11 "Identities", w4-w7 §2.3): one family per
 * (monoid, carrier) folded by grizzle's `fold` (folds.ts), every family of at most four members over a five-value
 * domain written by a direct SQL writer, the owner, with the accumulators the reference fold computes and with each
 * single junk accumulator, and PostgreSQL's verdict judged three ways.
 *
 * - **Two implementations agreeing:** the reference fold (test/support/families/fold.ts folded), exact: counts, int4
 *   and numeric sums and max in their least units, sets as code masks; and the host's fill (runtime/write/fill.ts
 *   filler over the installation's own families and codes), which must fill every lawful family exactly as the
 *   reference does before PostgreSQL judges what both wrote. Every lawful state must commit and read back exactly; the
 *   twos fold's at most one of K, `bit_count(twos & K) = 0` as a check of its twos plane, refuses exactly the families
 *   where a handle of K is held twice.
 * - **The fold's model** (fold.ts foldPredicted): each after proved by `CHECK ((after = combine(before, x)) IS TRUE)`
 *   in exact arithmetic, every after drawn, never generated, per the ruling; the identity pins at the first slot and at
 *   the empty family; the befores carried on the predecessor axis and the ends on the last axis. A junk accumulator
 *   must be refused at the model's moment, by an installed constraint whose role (folds.ts foldNativeOf) the model
 *   allows there, with its SQLSTATE, reporting the family's or the fold's law.
 * - **The pin at a tree's root:** a tree folded by count over each node's children, written in every forest of at most
 *   four rows with its root's accumulators over every small value: the root is outside its family, so its pin must
 *   admit it exactly one state, and refuse every other.
 *
 * The junk kinds (doctrine rule 6), each a named variant: the whole fold seeded from a junk identity, every before,
 * after and end consistent with it (the fold accumulator unconstrained at slot 0); one before; one after; one end; an
 * empty family's end. **Mutation rediscovery:** the int4 sum's installation with its first-slot pin dropped, and with
 * its empty-family pin dropped, each a schema of its own and judged beside grizzle's at once; each must be killed,
 * committing a junk seed and a junk empty end respectively. Features are (monoid, axis, verdict).
 *
 * Each case's transaction runs on a seat with no rows and is checked as its COMMIT would check it and rolled back, or
 * ends by a real COMMIT whose rows are read and cleared, as the case draws its end on its tape (installed.ts endGen):
 * every box requires both ends, each meeting a refusal at commit, so the search itself shows a real COMMIT never
 * decides otherwise than the checked end.
 */
/** The stored state a sketch writes: the reference fold of its family, then its junk. */

import { deepEquals, defined } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, family, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result, Record as Rec } from "effect"
import {
	attemptedText,
	byMember,
	Disagreed,
	emptyFold,
	FOLD_SPECS,
	foldWriteOf,
	hostFilled,
	type Judging,
	judgedFold,
	foldSeatOf
} from "#test/pg/fin/folds.ts"
import { cleared, endedBy, endGen, refusedAtCommitBy, seatIn } from "#test/pg/fin/installed.ts"
import { type TreeRow } from "#test/pg/substrate/tree.ts"
import { grizzleFold } from "#test/support/families/fold.ts"
import { attempt } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import {
	axisOf,
	sketchGen,
	familyOf,
	storedOf,
	type FoldFeature,
	ORACLE,
	requiredOf,
	type FoldedRow,
	TREE_COLUMNS,
	foldSeats,
	killsOf,
	forestGen,
	type RootFeature,
	foldTree
} from "#test/pg/fin/fold.fixtures.ts"

/**
 * Folds through grizzle's lowering on PostgreSQL 19rc2 commit the reference fold of every family of at most four members
 * over five values, and refuse every single junk accumulator by the native that owns its axis: one property for each
 * fold spec, each case on the worker's seat of its spec's schema.
 */
export const foldsThroughGrizzlesLoweringCommitTheReferenceFoldAndRefuseEverySingleJunkAccumulator =
	family(
		Rec.fromEntries(
			Arr.map(FOLD_SPECS, (spec) => {
				const planes = spec.planes.length
				return [
					spec.label,
					property.exhaust(finite(sketchGen(planes)), {
						box: "owner 0 with every family of zero to four members over the seat's five step values, each written lawful, and every family of zero to three members with every single junk accumulator: a junk seed, one before, one after, one end, each case ended by a real COMMIT and by the checked end",
						needs: { fold: Substrate.seat(defined(foldSeats[spec.label], "the spec's seat")) },
						situations: requiredOf(spec),
						check:
							({ fold }, c: Case<FoldFeature>) =>
							(sketch) =>
								Effect.scoped(
									Effect.flatMap(fold, (taken) =>
										Effect.provideService(
											Effect.gen(function* () {
												const seat = yield* seatIn(taken, ["Owner", "Member"], spec.label)
												const grizzle: Judging = {
													label: spec.label,
													fold: foldSeatOf(spec, seat),
													lowering: grizzleFold(spec.shape)
												}
												const stored = storedOf(spec, sketch)
												const axis = axisOf(sketch.junk, sketch.values.length)
												if (sketch.junk.kind === "none") {
													const host = hostFilled(grizzle.fold, familyOf(spec, sketch))
													if (
														Result.isFailure(host) ||
														!deepEquals(byMember(host.success), byMember(stored))
													) {
														return yield* new Disagreed({
															message: `${spec.label}: the host's fill ${Result.isFailure(host) ? host.failure : Formatter.format(host.success)} is not the reference fold ${Formatter.format(stored)}`
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
												c.note(`${spec.label} ${axis} ${j.verdict}`)
												c.note(endedBy(j.end))
												if (Option.exists(j.moment, (m) => m.kind === "commit")) {
													c.note(refusedAtCommitBy(j.end))
												}
												if (sketch.junk.kind !== "none" && j.verdict === "committed") {
													return yield* new Disagreed({
														message: `${spec.label}: ${axis} committed: ${Formatter.format(stored)}`
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
						kills: killsOf(spec)
					})
				] as const
			})
		)
	)

/**
 * Folds through grizzle's lowering on PostgreSQL 19rc2 admit a tree's root exactly one state of its fold's
 * accumulators, and refuse every other, in every forest of at most four rows.
 */
export const foldsThroughGrizzlesLoweringAdmitATreesRootExactlyOneStateOfItsFoldsAccumulatorsInEveryForestOfAtMostFourRows =
	property.exhaust(finite(forestGen), {
		box: "every tree and forest of two trees of at most four rows, each root's before over 0 to 1 and after over 0 to 2, every other accumulator the count fold's",
		needs: { tree: Substrate.seat(foldTree) },
		situations: ["a root's one state committed", "a root's other states refused"],
		check:
			({ tree }, c: Case<RootFeature>) =>
			(forest) =>
				Effect.scoped(
					Effect.flatMap(tree, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const seat = yield* seatIn(taken, ["Node"], "fold tree")
								const laws = [...seat.lawsOf("tree"), ...seat.lawsOf("fold")]
								/** A forest's rows with each member's count accumulators by its slot, each total its count. */
								const lawful = (rows: ReadonlyArray<TreeRow>): ReadonlyArray<FoldedRow> =>
									Arr.map(rows, (r) => ({ ...r, before: r.at, after: r.at + 1, total: r.children }))
								const candidates = Arr.flatMap([0, 1], (before) =>
									Arr.map([0, 1, 2], (after) => ({ before, after }))
								)
								const committed: Array<{ readonly before: number; readonly after: number }> = []
								for (const candidate of candidates) {
									const rows = Arr.map(lawful(forest), (r) =>
										r.start === 0 ? { ...r, ...candidate } : r
									)
									const values = (r: FoldedRow) => [
										r.root,
										r.parentStart,
										r.at,
										r.children,
										r.start,
										r.end,
										r.copy,
										r.before,
										r.after,
										r.total
									]
									const real = yield* attempt(seat.session, [
										`INSERT INTO ${seat.table("Node")} (${Arr.join(
											Arr.map(TREE_COLUMNS, (col) => seat.column("Node", col)),
											", "
										)}) VALUES ${Arr.join(
											Arr.map(rows, (r) => `(${Arr.join(Arr.map(values(r), String), ", ")})`),
											", "
										)}`
									])
									if (real.kind === "committed") {
										committed.push(candidate)
										yield* cleared(seat, ["Node"])
									} else {
										const named = seat.refusedBy(real.fields)
										if (
											real.fields.code !== "23514" ||
											!Option.exists(named, (n) => Option.exists(n.law, (l) => laws.includes(l)))
										) {
											return yield* new Disagreed({
												message: `a root's accumulators ${Formatter.format(candidate)} were refused by ${attemptedText(real)}, not by a pin of the tree or the fold`
											})
										}
										c.note("a root's other states refused")
									}
								}
								if (committed.length !== 1) {
									return yield* new Disagreed({
										message: `the root admits ${committed.length} states of its accumulators, ${Formatter.format(committed)}, not exactly one, in ${Formatter.format(forest)}`
									})
								}
								c.note("a root's one state committed")
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "a pin's contract: the root, outside its family, admits exactly one state of its accumulators"
		},
		kept: [],
		kills: []
	})
