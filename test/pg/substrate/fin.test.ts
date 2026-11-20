/**
 * The fin lemmas of fin.md §5.2, proved against PostgreSQL 19 inside a stated box: the lowering's DDL written by hand
 * (test/pg/substrate/fin.ts), every state and every single mutation the box holds sent to PostgreSQL, and PostgreSQL's
 * verdict judged by two oracles.
 *
 * - **The specification turned into a checker:** the families theorem (test/support/families/theorem.ts), per
 *   direction. F[g, at] ⊆ fin(O, n) holds when every row has an owner and an index below its count; fin(O, n) ⊆ F[g, at]
 *   when every slot below a count holds a row; mirrors when both hold and no slot holds two rows. PostgreSQL must accept
 *   exactly the states where the direction's lemma holds and refuse every other one.
 * - **A second implementation:** the model of each transaction (fin.ts predicted), which applies the statements to a
 *   state on the host and checks each constraint at the moment the lowering declares, so it says whether PostgreSQL
 *   commits, and where it refuses with which SQLSTATE and which constraints it may name. PostgreSQL must agree on the
 *   verdict, the moment, the SQLSTATE and a constraint the model allows, and a committed state must read back as the
 *   model's.
 *
 * The box (doctrine rules 6, 9): at most two owners, counts 0 to 3, at most four rows, indices 0 to 4, so every count
 * has a slot above it. Its invalid states are the theorem's named breaches: a slot two rows hold (twice), a row with no
 * owner (orphan), a row at or past its count (beyond), and a slot below the count no row holds (gap). The RFC's
 * lowering is the minimal deferral §5.1 states: the owner's last slot deferred (the owner ↔ family cycle), an ordered
 * family's closure immediate and a counted family's deferred, and the copy's foreign key immediate, since every write
 * updates the count before it inserts, which the families model (mutate.ts checkedAt) states.
 *
 * Each of the RFC's choices is necessary or chosen, and the boxes say which. The closure restricted to indices below the
 * copy: unrestricted, a covers lowering refuses a state whose covers lemma holds, a gap above n, which the box of
 * states commits, a kill of the box of states; under mirrors the bound refuses that state anyway, so mirrors holds its
 * lemma exactly either way. The last slot deferred: checked at its statement, no owner of a non-empty family can be
 * written at all, its rows inserted after it, the box's other kill. The copy immediate: deferred too, every state
 * and single mutation the box holds commits exactly as under the RFC's, the one difference that an owner dropped before
 * its rows commits, where the immediate copy refuses it, so deferring it buys nothing a write grizzle sends needs.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	cycleCase,
	type CycleFeature,
	cycleGen,
	mirrorsTemplate,
	mutationCase,
	type MutationFeature,
	mutationGen,
	mutationSituations,
	orderCase,
	type OrderFeature,
	orderGen,
	programCase,
	type ProgramFeature,
	programsGen,
	programSituations,
	rewriteCase,
	type RewriteFeature,
	rewriteGen,
	rfcTemplate,
	riCase,
	type RiFeature,
	riSituations,
	riTemplate,
	riWriteGen,
	seatNamed,
	seatsIn,
	stateCase,
	type StateFeature,
	stateGen,
	stateSituations
} from "#test/pg/substrate/fin.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Accept exactly the states of the box where the lowered direction's lemma holds, and refuse every other with a
 * constraint the model allows, each case on the worker's seats of the RFC's lowerings.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/fin.test.ts at fa10bca50).
 */
export const acceptExactlyTheStatesOfTheBoxWhereTheLoweredDirectionsLemmaHolds = property.exhaust(
	finite(stateGen),
	{
		needs: { fin: Substrate.seat(rfcTemplate) },
		situations: stateSituations,
		check:
			({ fin }, c: Case<StateFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(Effect.flatMap(fin, seatsIn), (seats) => stateCase(seats, sketch, c))
				),
		oracle: {
			kind: "specification",
			name: "the families theorem per direction (test/support/families/theorem.ts), and the model of each transaction (fin.ts predicted)"
		},
		box: "every state of two owners, each absent or counting 0 to 3 rows, with at most four rows at indices 0 to 4, under each direction's lowering",
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "test/pg/substrate/fin.fixtures.ts",
				original: 'restriction: "restricted"',
				replacement: 'restriction: "unrestricted"',
				why: "the RFC's closure unrestricted (CASE WHEN at > 0 THEN at - 1 END): a covers lowering refuses a covered state, a gap above n the lemma allows"
			},
			{
				file: "test/pg/substrate/fin.fixtures.ts",
				original: 'last: "commit"',
				replacement: 'last: "statement"',
				why: "the owner's last slot checked at its statement: no owner of a non-empty family can be written before its rows, though its state's lemma holds"
			}
		]
	}
)

/**
 * Commit a single mutation of a family state exactly when the state it leaves satisfies the lemma with every copy its
 * owner's count, each case on the worker's seats of the RFC's lowerings.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/fin.test.ts at fa10bca50).
 */
export const commitASingleMutationOfAFamilyStateExactlyWhenTheStateItLeavesSatisfiesTheLemma =
	property.exhaust(finite(mutationGen), {
		needs: { fin: Substrate.seat(rfcTemplate) },
		situations: mutationSituations,
		check:
			({ fin }, c: Case<MutationFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(Effect.flatMap(fin, seatsIn), (seats) => mutationCase(seats, sketch, c))
				),
		oracle: {
			kind: "second-implementation",
			name: "the model of each transaction (fin.ts predicted): its verdict, its moment, its SQLSTATE and a constraint it allows, and the theorem over the state it leaves"
		},
		box: "every single mutation of every family state of the box, each named",
		show: Formatter.format,
		kept: [],
		kills: []
	})

/**
 * Pass the immediate predecessor key on one insert of a family's rows in every order, successor first included, each
 * case on the worker's seat of the RFC's ordered mirrors lowering.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/fin.test.ts at fa10bca50).
 */
export const passTheImmediatePredecessorKeyOnOneInsertOfAFamilysRowsInEveryOrder = property.exhaust(
	finite(orderGen),
	{
		needs: { fin: Substrate.seat(mirrorsTemplate) },
		situations: ["committed", "committed with a successor sent first"] satisfies ReadonlyArray<
			Reached<OrderFeature>
		>,
		check:
			({ fin }, c: Case<OrderFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(Effect.flatMap(fin, seatsIn), (seats) =>
						orderCase(seatNamed(seats, "ordered"), sketch, c)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the model of each transaction (fin.ts predicted)"
		},
		box: "every family state of the box with every order of its rows in one insert",
		show: Formatter.format,
		kept: [],
		kills: []
	}
)

/**
 * Commit a member's suffix rewrite and swap-with-last in the prescribed order, refuse the count before the delete, and
 * need the counted family's deferred closure for swap-with-last, each case on the worker's seats of the RFC's mirrors
 * lowerings.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/fin.test.ts at fa10bca50).
 */
export const commitAMembersSuffixRewriteAndSwapWithLastInThePrescribedOrder = property.exhaust(
	finite(rewriteGen),
	{
		needs: { fin: Substrate.seat(mirrorsTemplate) },
		situations: [
			"ordered shrink prescribed committed",
			"counted shrink prescribed committed",
			"counted swap prescribed committed",
			"ordered swap prescribed refused closure",
			"ordered shrink count before delete refused bound",
			"counted swap count before delete refused bound",
			"counted swap move before delete refused key",
			"ordered shrink insert before delete refused"
		] satisfies ReadonlyArray<Reached<RewriteFeature>>,
		check:
			({ fin }, c: Case<RewriteFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(Effect.flatMap(fin, seatsIn), (seats) => rewriteCase(seats, sketch, c))
				),
		oracle: {
			kind: "second-implementation",
			name: "the model of each transaction (fin.ts predicted) under the RFC's lowerings of mirrors"
		},
		box: "each member of each non-empty family of the box, both rewrites, every order of their statements",
		show: Formatter.format,
		kept: [],
		kills: []
	}
)

/**
 * Create and drop an owner with its family in one transaction through the deferred last slot, rows first, and refuse
 * an owner dropped before its rows by the immediate copy, each case on the worker's seat of the RFC's ordered mirrors
 * lowering.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/fin.test.ts at fa10bca50).
 */
export const createAndDropAnOwnerWithItsFamilyInOneTransactionThroughTheDeferredLastSlot =
	property.exhaust(finite(cycleGen), {
		needs: { fin: Substrate.seat(mirrorsTemplate) },
		situations: [
			"create committed",
			"drop rows first committed",
			"drop owners first refused copy"
		] satisfies ReadonlyArray<Reached<CycleFeature>>,
		check:
			({ fin }, c: Case<CycleFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(Effect.flatMap(fin, seatsIn), (seats) =>
						cycleCase(seatNamed(seats, "ordered"), sketch, c)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the model of each transaction (fin.ts predicted) under the RFC's lowering"
		},
		box: "every family state of the box with a non-empty family, created from nothing or dropped rows first or owners first",
		show: Formatter.format,
		kept: [],
		kills: []
	})

/**
 * Run every referential-integrity query against the family by the g prefix of UNIQUE (g, at), with no sequential scan,
 * its saved plans custom or generic, each case on the worker's seat of the RFC's ordered mirrors lowering over the
 * analyzed load.
 *
 * Its pre-conversion budget: runs 16, coverage cases 24 (test/pg/substrate/fin.test.ts at fa10bca50).
 */
export const runEveryReferentialIntegrityQueryAgainstTheFamilyByTheGPrefixOfItsKey =
	property.explore(riWriteGen, {
		needs: { fin: Substrate.seat(riTemplate) },
		situations: riSituations,
		check:
			({ fin }, c: Case<RiFeature>) =>
			(w) =>
				Effect.scoped(
					Effect.flatMap(Effect.flatMap(fin, seatsIn), (seats) =>
						riCase(seatNamed(seats, "ordered"), w, c)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the RI queries ri_triggers.c makes of the family per touched owner or deleted row, counted against PostgreSQL's scans of fam and fam_key"
		},
		budget: { runs: 16, steered: 24 },
		show: Formatter.format,
		kept: [],
		kills: []
	})

/**
 * Refuse exactly the steps of a random program of family mutations the model refuses, where it refuses them, and
 * commit the rest to the model's families, each case on the worker's seats of the RFC's mirrors lowerings.
 *
 * Its pre-conversion budget: runs 200, coverage cases 400 (test/pg/substrate/fin.test.ts at fa10bca50).
 */
export const refuseExactlyTheStepsOfARandomProgramOfFamilyMutationsTheModelRefuses =
	property.explore(programsGen, {
		needs: { fin: Substrate.seat(mirrorsTemplate) },
		situations: programSituations,
		check:
			({ fin }, c: Case<ProgramFeature>) =>
			(p) =>
				Effect.scoped(
					Effect.flatMap(Effect.flatMap(fin, seatsIn), (seats) => programCase(seats, p, c))
				),
		oracle: {
			kind: "second-implementation",
			name: "the families model of each step (fin.ts predicted): where it refuses, and the families it commits"
		},
		budget: { runs: 200, steered: 400 },
		show: Formatter.format,
		kept: [],
		kills: []
	})
