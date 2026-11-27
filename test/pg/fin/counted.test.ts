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
 * - **The fold's model** (fold.ts foldPredicted) judges every order: the move before the delete is refused by the key
 *   at its statement; the count lowered before the delete commits, since no member holds it and the owner axis, its
 *   holding reference, is checked at COMMIT, after the delete, a family of one member's lowered to 0 among them; and
 *   with the predecessor axis made immediate (SET CONSTRAINTS, the control), the prescribed order is refused at its delete by
 *   that axis whenever the slot freed is not the last.
 *
 * - **The relations' standing** (folds.ts Standing): over a mutable owner and member every order above is sent as it
 *   is; over the immutable default, the one every consumer gets, the swap is refused at its delete by the member's
 *   guard (42501), a closed relation's rows never removed but in a data step, and the family rewritten whole, every
 *   member deleted, the owner inserted again with the kept count and end and the kept members at their slots
 *   (test/support/families/counted.ts rewrittenWhole), a data step inside the one bracket of the closed relations'
 *   removals (physical/ddl/immutable.ts guardBracketTexts), commits to the reference fold.
 *
 * The space (counted.fixtures.ts sketchGen): owner 0 with a counted family of one to four members over the five step
 * values of each counted fold seat (folds.ts), one member's removal, sent, over mutable relations, in the prescribed
 * order, move first or count first, or in the prescribed order with the predecessor axis immediate, or, over the
 * immutable default, prescribed or rewritten whole; the search requires every one of them.
 *
 * Each case is one transaction from an empty seat: it writes its family, then sends its removal, checked as its COMMIT
 * would check it and rolled back, or ended by a real COMMIT whose rows are then read, as the case draws its end on
 * its tape (installed.ts endGen; folds.ts judgedFold): the search requires both ends.
 */
import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import { type Case, family, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { guardBracketTexts } from "#compiler/physical/ddl/immutable.ts"
import {
	byMember,
	Disagreed,
	foldInstalledOf,
	foldSeatOf,
	hostFilled,
	judgedFold,
	type Judging,
	nothingAround,
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
 * Its search budget: the fewest cases a run spends at which every kill it declares is killed and every situation it
 * requires reached. A kill's trial runs the witnesses alone, its kept cases, its floor stream of ⌈runs / 4⌉ cases and its
 * steered phase while a situation is unreached, all fixed by the property's identity and its floor, so runs within one
 * floor draw the same witnesses, and a run adds `runs` rotating cases.
 *
 * @limitKind measured
 * @owner grizzle's test/pg/fin/counted.test.ts
 * @unit independent cases (runs) and steered cases
 * @scope one run of each member of countedSwapWithLast
 * @evidence `~/.cache/grizzle/CULL-FIN-tools/measure.sh r<runs> <runs> 200 <files>` over test/pg/fin's counted,
 *   lemmas, fold, plans and counted-set at runs 1, 4, 8, 16 and 32, the steered cases capped at 200, each a
 *   `toolchain-test run` of the files that ran the kills of every property it passed; uncommitted logs
 *   ~/.cache/grizzle/CULL-FIN-tools/measure-r{1,4,8,16,32}.log
 * @observed 2026-11-23 03:50 to 04:26 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load 200 to 520 from other lanes;
 *   PostgreSQL 19.0 (scripts/pg/pin.env) as the lane's in-memory family; Node 26.13.1; grizzle f87b2aaab with lane
 *   CULL-FIN's cull of test/pg/fin; TEST_SEED=2219874524
 * @workload both members, sum of int4 and or of a set over a counted family, each with its one kill
 * @result steered cases to reach every required situation, sum and or: 112 and 96 at a floor of one case (runs 1, 4),
 *   128 and 32 at two (runs 8), 64 and 32 at four (runs 16), 64 and 32 at eight (runs 32); the kill killed in both
 *   members at every budget, no failure
 * @decision a floor of four spends the fewest, 81 and 49 cases a run at runs 13, the fewest runs with that floor, against
 *   212 at a floor of one (runs 1), 174 at two (runs 5) and 170 at eight (runs 29); the steered cap the sum member's 64.
 *   Floors of three, five, six and seven are unmeasured; the exhaustive box ran 35,160 cases a member (f1bf91a2f)
 * @revalidate a change of the property, its space, its situations or the code its cases run, which moves its witnesses;
 *   a red that reaches no situation (FeaturesUnreached) or a kill that survives
 */
const swapBudget = { runs: 13, steered: 64 } as const

/**
 * Counted swap-with-last through grizzle's lowering on PostgreSQL 19: remove each member of a counted family of
 * at most four by swap-with-last under the deferred predecessor axis, and refuse every misorder, one property for each
 * counted fold spec, each case on a clone of its own of its spec's schema.
 */
export const countedSwapWithLast = family(
	Rec.fromEntries(
		Arr.map(COUNTED, (spec) => {
			const l = spec.label
			const seats = defined(countedSeats[spec.label], "the spec's seats")
			return [
				spec.label,
				property.explore(sketchGen, {
					needs: {
						mutable: Substrate.fresh(seats.mutable),
						immutable: Substrate.fresh(seats.immutable)
					},
					situations: [
						"a case ended by COMMIT",
						"a case ended by SET CONSTRAINTS and ROLLBACK",
						`${l} the last slot prescribed committed`,
						`${l} a slot before the last prescribed committed`,
						`${l} a slot before the last move first refused key`,
						`${l} a slot before the last count first committed`,
						`${l} the last slot count first committed`,
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
													/** The swap over the immutable default: refused by the member's guard at its delete, 42501, a
													 * closed relation's rows removed by a data step alone. */
													const deleteAt = Arr.findFirstIndex(
														change.statements,
														(s) => s.kind === "delete"
													)
													const { sent: guarded, unseen } = yield* sentOver(
														f,
														before,
														change.statements,
														nothingAround,
														end
													)
													if (
														guarded.kind !== "refused" ||
														guarded.fields.code !== sqlstates.insufficientPrivilege ||
														!Option.contains(
															guarded.fields.table,
															f.seat.installed.installation.names.relation("Member").name
														) ||
														guarded.moment.kind !== "statement" ||
														!Option.exists(
															deleteAt,
															(at) =>
																guarded.moment.kind === "statement" &&
																guarded.moment.index === unseen.length + at
														)
													) {
														return yield* new Disagreed({
															message: `${l}: the swap over the immutable default was not refused at its delete by the member's guard (42501): ${Formatter.format(guarded)}`
														})
													}
													c.note(`${l} immutable ${position} prescribed refused immutable guard`)
													c.note(endedBy(end))
													return
												}
												/** The family rewritten whole, a data step over Owner and Member, inside the one bracket of
												 * their removals (physical/ddl/immutable.ts guardBracketTexts): committed, to the reference fold
												 * of what swap-with-last leaves. */
												const whole = rewrittenWhole(spec.monoid, before, 0, sketch.at)
												const bracket = guardBracketTexts({
													kind: "tables",
													tables: [
														f.seat.installed.installation.names.relation("Owner"),
														f.seat.installed.installation.names.relation("Member")
													]
												})
												const rewritten = yield* judgedFold(
													grizzle,
													before,
													whole.statements,
													{ prefix: [bracket.before], suffix: [bracket.after] },
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
												sketch.sending === "closure immediate"
													? { prefix: setImmediate, suffix: [] }
													: nothingAround,
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
					budget: swapBudget,
					kept: [],
					kills: [
						{
							file: "packages/engine/src/physical/ddl/immutable.ts",
							original: "\t\tif (relation.mutable) {",
							replacement: "\t\tif (relation.mutable || true) {",
							why: "No immutable relation carries a guard, as before e51534fba: the swap's delete over the immutable default commits where the member's guard refuses it."
						}
					]
				})
			] as const
		})
	)
)
