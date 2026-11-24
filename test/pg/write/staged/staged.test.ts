/**
 * A nested write whose rows are past one Bind message (write/program/staged.ts), on PostgreSQL 19: its rows travel
 * through transaction carriers filled chunk by chunk in the call's one flight, and the statement that writes them runs
 * once over every row, so the write is the write its statement sends inline.
 *
 * The schema holds pantry's import shape, a fresh immutable Package whose ordered Entry family of bytes is nested in
 * its insert. Each entry is also a counted member twice over, as a sequence's member may be: of a Bin, an immutable owner
 * the write inserts beside it, and of a Shelf, a mutable owner stored before the write, each folding its entries' sizes
 * into its end, so the family statement draws their counts, indexes and ends in SQL and recounts the stored Shelf. A
 * CHECK on an entry's size is a law that statement judges. A case inserts packages with their entries nested, each
 * entry's bytes of a drawn length, and both bins, on a session whose message bound is planted (Session.messageMaxBytes,
 * the bound both the flight's builder and the cut read), with the database's TEMPORARY privilege revoked from PUBLIC
 * or held, and the session's flight bound in force or planted below any flight. The planted bound is the longest Parse
 * message of the write's statements (test/support/staged.ts textBound), so every statement's text fits it and only the
 * entries' bytes pass it. An entry's length is boxed apart from the bound: within it by more than the rest of its row's
 * arrays, a drawn share of the most such an entry holds, or past it; its size is its share, which the CHECK bounds.
 *
 * Each write is a member of the full role's served workload, called once with its call's facts on the opened Db's
 * context, or on that context with its pool's sessions planted.
 *
 * Oracle: PostgreSQL, the same write sent with the bounds in force, where every statement goes in one Bind message,
 * from the same stored shelves:
 *
 * - **A flight past one write** fails as `input` (InputTooLarge, of the flight or of a row past one fill): nothing sent
 *   and nothing stored.
 * - **A row no fill carries even alone** fails as `input` (InputTooLarge of Entry's fill, its Bind message past the
 *   planted bound), before any SQL: nothing sent and nothing stored.
 * - **A write that creates a temporary table on a role without TEMPORARY**, its staged carriers and its carriers of the
 *   program's own, which a put of Tags from a query over the call's relation parameter needs, all made by the one
 *   stand-up before its first call, fails as `failed` (TemporaryRefused, naming the privilege, with the server's
 *   42501), and stores nothing. A carrier is the session's,
 *   made by the session's stand-up of the write, before its first call, and kept by every COMMIT (sql/ast.ts
 *   CreateCarrier), so such a write runs on a served Db opened for it, whose session holds no carrier yet. The put is a displacing
 *   deletion and an insert (write/put/choose.ts), and both read the query's rows, which the program carries from one
 *   to the other (write/schedule/plan.ts).
 * - **Any other write is the inline write**: it leaves the same rows of every table, every column of each row read as
 *   its row's text, each entry's indexes and its copies of its owners' counts and each owner's count and end among them,
 *   and answers the same outcome, its kind, its counts, and a refusal's laws and witness.
 *
 * The staged statement keeps no value beside its rows, so its rows pass the bound exactly when one fill of them would:
 * a staged write here fills its carrier more than once, and the unit search of the cut reaches a carrier of one fill
 * (test/unit/write/staged.test.ts).
 *
 * Kept: pantry's import, a fresh immutable Package whose Entry bytes pass the bound in several fills.
 *
 * Features: inline under the planted bound, staged in several fills, a stored mutable shelf recounted, a refusal the
 * staged statement judges, an owner of no member, a row past one fill alone, a flight past one write, a write without
 * TEMPORARY, and a carrier of the program's own.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	type Feature,
	stagedCases,
	stagedOn,
	stagedTemplate
} from "#test/pg/write/staged/staged.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Leaves through its carriers what it leaves inline, and refuses a row, a flight or a carrier no transport carries, each
 * case on a clone of its own of Staged, installed once per member.
 *
 * Its pre-conversion budget: runs 64, coverage cases 96 (test/pg/write/staged/staged.test.ts at 3748a799c).
 */
export const leavesThroughItsCarriersWhatItLeavesInlineAndRefusesARowAFlightOrACarrierNoTransportCarries =
	property.explore(stagedCases, {
		needs: { staged: Substrate.fresh(stagedTemplate) },
		situations: [
			"inline under the planted bound",
			"staged in several fills",
			"a stored mutable shelf recounted",
			"a refusal the staged statement judges",
			"an owner of no member",
			"a row past one fill alone",
			"a flight past one write",
			"a write without TEMPORARY",
			"a carrier of the program's own"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ staged }, c: Case<Feature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(staged, (taken) =>
						Effect.provideService(
							Effect.flatMap(stagedOn(taken), (write) => write(sketch, c)),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "the same write sent inline: its rows, every column, and its outcome"
		},
		show: Formatter.format,
		budget: { runs: 64, steered: 96 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/staged/staged.test.ts#leavesThroughItsCarriersWhatItLeavesInlineAndRefusesARowAFlightOrACarrierNoTransportCarries:-:1"
				),
				reason:
					"pantry's import: a fresh immutable Package whose Entry bytes pass one Bind message, which failed with InputTooLarge (164aeb06e)",
				since: "2026-11-09"
			}
		],
		kills: []
	})
