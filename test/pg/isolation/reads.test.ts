/**
 * Reads in the isolation oracle: a read member's transaction, plain or deferrable(...), raced against the writers whose
 * rows it reads, judged by the serial reference beside them (support/race.ts runIsolationRace).
 *
 * The shape is the read-only anomaly (Fekete, O'Neil and O'Neil, A Read-Only Transaction Anomaly Under Snapshot
 * Isolation, 2004) in grizzle's terms: the `teller`'s `deposit(batch, n)` inserts a Deposit; the `closer`'s `close`
 * copies every Deposit into Copy, rows of many teller calls, so it can miss a deposit in flight; the `auditor`'s `view`
 * reads every Deposit with the Copy rows of its batch attached, in one statement, as `view` or as its deferrable(...)
 * member `deferredView`. From
 * one stored Deposit, a closer that copied it, a teller that deposited beside it and committed first, and a view that
 * saw the deposit and not the copy make a cycle (the closer before the teller, the teller before the view, the view
 * before the closer) unless PostgreSQL breaks it. A call is a direct transaction of the statements its served member
 * sends: a write at the level its role's served file records; a read in the transaction its served BEGIN states (its
 * modes by SET TRANSACTION), DEFERRABLE exactly for a deferrable member; the barrier sees a read waiting for a safe
 * snapshot as it sees a lock wait (test/support/substrate/barrier.ts).
 *
 * - At generate's levels, where the teller and the closer are SERIALIZABLE, every order of a race's moves is one some
 *   serial order of its calls explains, reads included, and no deferrable read fails: PostgreSQL waits for its safe
 *   snapshot, retaking it where the closer committed with a conflict out to the teller, so it never meets a
 *   serialization failure. A plain read reads at once; the cycle is broken by refusing the closer. The closer runs
 *   SERIALIZABLE and reads what the teller writes, which condition `laws`'s second half refuses the teller; generate's
 *   certificate names condition `absence` instead, which the certifier judges first: the facts read the closer's
 *   insertion as reading Deposit negated.
 * - With the teller forced READ COMMITTED, as a certifier without either condition would pass it, SSI cannot see the
 *   closer miss the teller's deposit, and a deferrable read is safe at once: the oracle must find a run no serial order
 *   explains, and generate must keep the teller SERIALIZABLE.
 *
 * Features: a plain read and a deferrable one; a deferrable read that waited for a safe snapshot, placed after a writer
 * it waited for and placed before one; a writer refused beside a plain read; the forced teller caught.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	depositGen,
	forcedTellerLedger,
	generatedLedger,
	judgedRun,
	type LedgerRace,
	ledgerShape,
	type ReadFeature,
	raceOf,
	readMembers,
	runs
} from "#test/pg/isolation/reads.fixtures.ts"
import { generatedShapeIn, runIsolationRace } from "#test/pg/isolation/support/race.ts"
import { every } from "#test/support/schedules/interleave.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every order of a ledger race, its read plain or deferrable, is serial at generate's levels, and no deferrable read
 * fails, each case on the worker's seat of the ledger as generate certifies it.
 *
 * Its pre-conversion budget: runs 2, coverage cases 2 (test/pg/isolation/reads.test.ts at 4ca3036a9).
 */
export const everyOrderOfALedgerRaceIsSerialAtGeneratesLevelsAndNoDeferrableReadFails =
	property.explore(depositGen, {
		needs: { ledger: Substrate.seat(generatedLedger) },
		situations: [
			"a plain read",
			"a deferrable read",
			"a deferrable read waited for a safe snapshot",
			"a deferrable read placed after a writer it waited for",
			"a deferrable read placed before a writer it waited for",
			"a writer refused beside a plain read"
		] satisfies ReadonlyArray<Reached<ReadFeature>>,
		check:
			({ ledger }, c: Case<ReadFeature>) =>
			(n) =>
				Effect.scoped(
					Effect.flatMap(ledger, (seat) =>
						Effect.flatMap(generatedShapeIn(seat, ledgerShape), (s) =>
							Effect.provideService(
								Effect.forEach(
									readMembers,
									(read) =>
										Effect.gen(function* () {
											const race: LedgerRace = { read, n }
											c.note(read === "view" ? "a plain read" : "a deferrable read")
											const refused: Array<string> = []
											yield* Effect.scoped(
												runIsolationRace(
													s,
													raceOf(race),
													() => every,
													judgedRun(race, refused, (feature) => c.note(feature))
												)
											)
											if (Arr.isReadonlyArrayNonEmpty(refused)) {
												return yield* Effect.die(
													new Error(
														`a deferrable read ended uncommitted, where PostgreSQL's safe snapshot admits no refusal:\n${Arr.join(refused, "\n\n")}`
													)
												)
											}
										}),
									{ discard: true }
								),
								Substrate,
								seat.substrate
							)
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "a serial order of the same calls, reads included; PostgreSQL's safe snapshot"
		},
		show: Formatter.format,
		budget: { runs, steered: runs },
		kept: [],
		kills: []
	})

/**
 * A teller forced READ COMMITTED beside the SERIALIZABLE closer that reads its deposits is caught through a deferrable
 * read, where generate certifies the teller SERIALIZABLE, each case on the worker's seat of the forced ledger.
 *
 * Its pre-conversion budget: runs 1, coverage cases 1 (test/pg/isolation/reads.test.ts at 4ca3036a9).
 */
export const aTellerForcedReadCommittedBesideTheSerializableCloserIsCaughtThroughADeferrableRead =
	property.explore(depositGen, {
		needs: { forced: Substrate.seat(forcedTellerLedger) },
		situations: ["the forced teller caught"] satisfies ReadonlyArray<
			Reached<"the forced teller caught">
		>,
		check:
			({ forced }, c: Case<"the forced teller caught">) =>
			(n) =>
				Effect.scoped(
					Effect.flatMap(forced, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = seat.value
								if (s.generated.get("teller") !== "serializable") {
									return yield* Effect.die(
										new Error(
											`generate certifies the teller ${String(s.generated.get("teller"))}, though the SERIALIZABLE closer reads its deposits`
										)
									)
								}
								const race: LedgerRace = { read: "deferredView", n }
								const result = yield* Effect.result(
									Effect.scoped(
										runIsolationRace(
											s,
											raceOf(race),
											() => every,
											() => undefined
										)
									)
								)
								if (result._tag === "Failure" && result.failure._tag === "NoSerialOrder") {
									c.note("the forced teller caught")
									return
								}
								return result._tag === "Failure"
									? yield* Effect.fail(result.failure)
									: yield* Effect.die(
											new Error(
												`every order of ${Formatter.format(race)} is serial with the teller READ COMMITTED, so the oracle cannot catch the flaw`
											)
										)
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: { kind: "specification", name: "a serial order of the same calls" },
		show: Formatter.format,
		budget: { runs: 1, steered: 1 },
		kept: [],
		kills: []
	})
