/**
 * Counted swap-with-last through grizzle's lowering, on PostgreSQL 19 (fin.md §4.2, §11, "Counted swap-with-last
 * with the deferred closure FK"): a counted family hides its index ‹i› and its fold's accumulators, so removing a
 * member moves the last member into the freed slot, refolds the hidden accumulators from that slot on, and lowers the
 * count with the new end (test/support/families/counted.ts swapWithLast). Between the delete and the move the freed
 * slot's successor has no predecessor, so the predecessor axis must be deferred, and the installed one is.
 *
 * - **Two implementations agreeing:** the reference fold (families/fold.ts) and the host's fill (runtime/write/fill.ts
 *   filler) of the families swap-with-last leaves must be one state; every swap-with-last commits to those families,
 *   its stored state that fold of them, and the end unchanged but for the removed member's step,
 *   since every monoid is commutative.
 * - **The fold's model** (fold.ts foldPredicted) judges every order: the move before the delete is refused by the key,
 *   the count before the delete by the bound (the count's cascade), each at its statement; and with the predecessor
 *   axis made immediate (SET CONSTRAINTS, the control), the prescribed order is refused at its delete by that axis
 *   whenever the slot freed is not the last.
 *
 * - **The relations' standing** (folds.ts Standing): over a mutable owner and member every order above is sent as it
 *   is; over the immutable default, the one every consumer gets, the swap is refused at its count by the owner's
 *   guard (42501), its count and end fields the guard holds fixed as the schema decides (ir/law.ts RelationInfo
 *   `inPlace`), and the family rewritten whole, every member deleted, the owner inserted again with the kept count
 *   and end and the kept members at their slots (test/support/families/counted.ts rewrittenWhole), commits to the
 *   reference fold: the owner cannot be inserted again alone, its members' copy of its count a foreign key ON UPDATE
 *   CASCADE that is not deferrable.
 *
 * The box (doctrine rule 9): owner 0 with every counted family of one to four members over the five step values of
 * each counted fold seat (folds.ts), each member's removal, sent, over mutable relations, in the prescribed order,
 * move first and count first, and in the prescribed order with the predecessor axis immediate, and, over the immutable
 * default, prescribed and rewritten whole.
 *
 * Each case is one transaction from an empty seat: it writes its family, then sends its removal, checked as its COMMIT
 * would check it and rolled back, or ended by a real COMMIT whose rows are then cleared, as the case draws its end on
 * its tape (installed.ts endGen; folds.ts judgedFold): the box holds every case under both ends.
 */
import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, family, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	byMember,
	Disagreed,
	foldInstalledOf,
	foldSeatOf,
	hostFilled,
	judgedFold,
	type Judging,
	sentOver
} from "#test/pg/fin/folds.ts"
import { endedBy, endGen, refusedAtCommitBy, seatIn } from "#test/pg/fin/installed.ts"
import { rewrittenWhole, swapWithLast } from "#test/support/families/counted.ts"
import { foldApplied, foldStoredOf, grizzleFold } from "#test/support/families/fold.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import {
	sketchGen,
	sent,
	type Position,
	type CountedFeature,
	COUNTED,
	countedSeats
} from "#test/pg/fin/counted.fixtures.ts"

/**
 * Counted swap-with-last through grizzle's lowering on PostgreSQL 19: remove every member of every counted family of
 * at most four by swap-with-last under the deferred predecessor axis, and refuse every misorder, one property for each
 * counted fold spec, each case on the worker's seat of its spec's schema.
 */
export const countedSwapWithLast = family(
	Rec.fromEntries(
		Arr.map(COUNTED, (spec) => {
			const l = spec.label
			const seats = defined(countedSeats[spec.label], "the spec's seats")
			return [
				spec.label,
				property.exhaust(finite(sketchGen), {
					box: "owner 0 with every counted family of one to four members over the seat's five step values, each member removed by swap-with-last, sent prescribed, move first, count first, and prescribed with the predecessor axis immediate, each case ended by a real COMMIT and by the checked end",
					needs: {
						mutable: Substrate.seat(seats.mutable),
						immutable: Substrate.seat(seats.immutable)
					},
					situations: [
						"a case ended by COMMIT",
						"a case ended by SET CONSTRAINTS and ROLLBACK",
						`${l} the last slot prescribed committed`,
						`${l} a slot before the last prescribed committed`,
						`${l} a slot before the last move first refused key`,
						`${l} a slot before the last count first refused bound`,
						`${l} the last slot count first refused bound`,
						`${l} a slot before the last closure immediate refused predecessor axis`,
						`${l} the last slot closure immediate committed`,
						`${l} immutable the last slot prescribed refused immutable guard`,
						`${l} immutable a slot before the last prescribed refused immutable guard`,
						`${l} immutable the last slot rewritten whole committed`,
						`${l} immutable a slot before the last rewritten whole committed`
					],
					check:
						({ mutable, immutable }, c: Case<CountedFeature>) =>
						(sketch) =>
							Effect.scoped(
								Effect.flatMap(sketch.standing === "mutable" ? mutable : immutable, (taken) =>
									Effect.provideService(
										Effect.gen(function* () {
											const seat = yield* seatIn(taken, ["Owner", "Member"], `swap ${spec.label}`)
											const f = foldSeatOf(spec, seat)
											const predecessor = foldInstalledOf(f, "predecessor axis")
											assert.ok(
												predecessor.length === 1 && Arr.every(predecessor, (c) => c.deferrable),
												`${spec.label}: the counted family's one predecessor axis is deferrable`
											)
											const grizzle: Judging = {
												label: spec.label,
												fold: f,
												lowering: grizzleFold("counted")
											}
											/** The control: the predecessor axis checked at each statement, as an ordered family's is. */
											const immediate: Judging = {
												...grizzle,
												label: `${spec.label} closure immediate`,
												lowering: grizzleFold("ordered")
											}
											const setImmediate = Arr.map(
												predecessor,
												(c) =>
													`SET CONSTRAINTS ${quoteIdent(f.seat.installed.schema)}.${quoteIdent(c.name)} IMMEDIATE`
											)
											const l = spec.label
											const members = Arr.map(sketch.values, (i, member) => ({
												member,
												x: Arr.getUnsafe(spec.domain, i),
												selected: true
											}))
											const before = foldStoredOf(spec.monoid, [{ owner: 0, members }])
											const change = swapWithLast(spec.monoid, before, 0, sketch.at)
											const reached = Arr.reduce(change.statements, before, foldApplied)
											const reference = foldStoredOf(spec.monoid, change.after)
											if (!deepEquals(byMember(reached), byMember(reference))) {
												return yield* new Disagreed({
													message: `swap-with-last's statements leave ${Formatter.format(reached)}, not the reference fold ${Formatter.format(reference)}`
												})
											}
											const host = Result.flatMap(
												Result.fromOption(
													Arr.head(change.after),
													() => "swap-with-last leaves no family"
												),
												(fam) => hostFilled(f, fam)
											)
											if (
												Result.isFailure(host) ||
												!deepEquals(byMember(host.success), byMember(reference))
											) {
												return yield* new Disagreed({
													message: `the host's fill of the family swap-with-last leaves, ${Result.isFailure(host) ? host.failure : Formatter.format(host.success)}, is not the reference fold ${Formatter.format(reference)}`
												})
											}
											const position: Position =
												sketch.at === sketch.values.length - 1
													? "the last slot"
													: "a slot before the last"
											if (sketch.standing === "immutable") {
												const end = c.draw(endGen)
												if (sketch.sending === "prescribed") {
													/** The swap over the immutable default: refused by the owner's guard at its count, 42501. */
													const countAt = Arr.findFirstIndex(
														change.statements,
														(s) => s.kind === "count"
													)
													const { sent: guarded, unseen } = yield* sentOver(
														f,
														before,
														change.statements,
														[],
														end
													)
													if (
														!seats.countGuarded ||
														guarded.kind !== "refused" ||
														guarded.fields.code !== sqlstates.insufficientPrivilege ||
														guarded.moment.kind !== "statement" ||
														!Option.exists(
															countAt,
															(at) =>
																guarded.moment.kind === "statement" &&
																guarded.moment.index === unseen.length + at
														)
													) {
														return yield* new Disagreed({
															message: `${l}: the swap over the immutable default was not refused at its count by the owner's guard (42501): ${Formatter.format(guarded)}`
														})
													}
													c.note(`${l} immutable ${position} prescribed refused immutable guard`)
													c.note(endedBy(end))
													return
												}
												/** The family rewritten whole: committed, to the reference fold of what swap-with-last leaves. */
												const whole = rewrittenWhole(spec.monoid, before, 0, sketch.at)
												const rewritten = yield* judgedFold(
													grizzle,
													before,
													whole.statements,
													[],
													end
												)
												if (rewritten.verdict !== "committed") {
													return yield* new Disagreed({
														message: `${l}: the immutable family rewritten whole was ${rewritten.verdict}: ${Formatter.format(sketch)}`
													})
												}
												c.note(`${l} immutable ${position} rewritten whole committed`)
												c.note(endedBy(rewritten.end))
												return
											}
											const judging = sketch.sending === "closure immediate" ? immediate : grizzle
											const j = yield* judgedFold(
												judging,
												before,
												sent(change.statements, sketch.sending),
												sketch.sending === "closure immediate" ? setImmediate : [],
												c.draw(endGen)
											)
											c.note(`${l} ${position} ${sketch.sending} ${j.verdict}`)
											c.note(endedBy(j.end))
											if (Option.exists(j.moment, (m) => m.kind === "commit")) {
												c.note(refusedAtCommitBy(j.end))
											}
											if (sketch.sending === "prescribed" && j.verdict !== "committed") {
												return yield* new Disagreed({
													message: `${l}: the prescribed swap-with-last of slot ${sketch.at} was ${j.verdict}: ${Formatter.format(sketch)}`
												})
											}
										}),
										Substrate,
										taken.substrate
									)
								)
							),
					oracle: {
						kind: "second-implementation",
						name: "the reference fold of the families swap-with-last leaves (families/fold.ts), beside the fold's model of each installed native's moment (fold.ts foldPredicted)"
					},
					kept: [],
					kills: [
						{
							file: "packages/engine/src/physical/ddl/immutable.ts",
							original: "\t\tif (relation.mutable || !isNonEmpty(fixed)) {",
							replacement: "\t\tif (relation.mutable || isNonEmpty(fixed)) {",
							why: "No immutable relation carries a guard, as before e51534fba: the swap's count over the immutable default commits where its owner's guard refuses it."
						}
					]
				})
			] as const
		})
	)
)
