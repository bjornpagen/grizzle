/**
 * The insert protocol's two arbitrations against PostgreSQL 19 (write/insert/protocol.ts Arbitration): a role served at
 * READ COMMITTED arbitrates its inserts at the arbiter key, DO SELECT, and probes every other object; one served at
 * SERIALIZABLE arbitrates every object, ON CONFLICT DO NOTHING with no target, and classifies only the requested facts its
 * INSERT met, its immutable family's members drawn from their group's base (write/family/scan.ts GroupState). The shape is
 * pantry's import in small: a Doc with a second declared key, and an immutable Invoice whose counted family of Lines is
 * written whole with it, the Invoice's total their CHECKed sum.
 *
 * - Writers of disjoint keys: two or three sessions, each holding its transaction open across every other's statements,
 *   commit every call at READ COMMITTED but one its Invoice's CHECK refuses (an amount off its Lines' sum); at
 *   SERIALIZABLE each call commits, is refused as it is at READ COMMITTED, or meets a serialization failure, a
 *   TransientFailure the caller retries, and only a race that posts an Invoice meets one.
 * - What disjoint writers read, as pg_locks shows it (SSISCAN-04's contract): at READ COMMITTED they hold no SIRead
 *   lock; at SERIALIZABLE every SIRead lock they hold is on an index of Invoice, the relation Line's foreign key
 *   references and its counted family's owner, at one of two reads: PostgreSQL's own foreign key check (ri_triggers.c
 *   ri_FastPathCheck under the transaction snapshot), and the owner INSERT's probe at its key, which proposes only
 *   Invoices no stored row holds (write/insert/statement.ts Proposal `unstored`), since PostgreSQL judges a proposed
 *   row by every CHECK before an arbiter meets its key (19rc2 nodeModifyTable.c ExecInsert). Each lock is a page, or
 *   the whole index where it holds no entry yet (nbtsearch.c _bt_first locks an empty index whole). A race of Docs
 *   alone, which neither read reaches, holds no SIRead lock. A met row's classification that read the stored rows of
 *   the facts its INSERT inserted would lock more.
 * - Writers of shared keys: every race of calls over a few keys, at the level generate certifies the importer at and at
 *   SERIALIZABLE, is one some serial order of the same calls explains (support/race.ts runIsolationRace): READ
 *   COMMITTED promises that only where generate certifies it.
 * - One history, two forms: the same calls run one after another give the same rows, the same refusals and the same
 *   state at either level.
 *
 * Oracles: the specification of the disjoint writers' outcomes and of their SIRead locks; a serial order of the same calls (support/race.ts),
 * timing drawn from the case (every order where a race makes few moves, a PCT schedule beyond); and the differential of
 * one history at the two levels. Features: Docs only, an Invoice posted, three sessions, a CHECK refused; a stored Doc
 * and two calls at one key; an exact repeat, a key or axis refusal, an unsettled invoice refused and Lines sent alone.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { agree, exact } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import {
	aimedDisjoint,
	aimedHistory,
	type DisjointFeature,
	generatedShape,
	importShape,
	initialOf,
	raceOf,
	readCommittedShape,
	runDisjoint,
	runs,
	runSerial,
	sameHistory,
	type SerialFeature,
	serializableShape,
	type SharedFeature,
	sharedRaces,
	strategyOf
} from "#test/pg/isolation/arbiter.fixtures.ts"
import { generatedShapeIn, runIsolationRace } from "#test/pg/isolation/support/race.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The insert protocol's arbitrations writers of disjoint keys commit every call but an unsettled Invoice, and SIRead-lock Invoice's indexes alone, Docs none.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/pg/isolation/arbiter.test.ts at d8eed1786).
 */
export const theInsertProtocolsArbitrationsWritersOfDisjointKeysCommitEveryCallButAnUnsettledInvoiceAndSIReadLockInvoicesIndexesAloneDocsNone =
	property.explore(steered(aimedDisjoint), {
		needs: {
			readCommitted: Substrate.seat(readCommittedShape),
			serializable: Substrate.seat(serializableShape)
		},
		situations: [
			"docs only",
			"an invoice posted",
			"three sessions",
			"a CHECK refused"
		] satisfies ReadonlyArray<Reached<DisjointFeature>>,
		check:
			({ readCommitted, serializable }, c: Case<DisjointFeature>) =>
			(race) =>
				Effect.gen(function* () {
					const rcSeat = yield* readCommitted
					const serSeat = yield* serializable

					c.note(race.docsOnly ? "docs only" : "an invoice posted")
					if (race.calls.length === 3) {
						c.note("three sessions")
					}
					const rc = yield* Effect.provideService(
						runDisjoint(rcSeat.value, race, "readCommitted"),
						Substrate,
						rcSeat.substrate
					)
					const ser = yield* Effect.provideService(
						runDisjoint(serSeat.value, race, "serializable"),
						Substrate,
						serSeat.substrate
					)
					const refused = (f: string | undefined) => f === "23514" || f === "23000"
					const outcomes = Arr.flatMap(race.calls, (call, i) => {
						const atRc = rc.failures[i]
						const atSer = ser.failures[i]
						return [
							...(call.unsettled === refused(atRc) && (call.unsettled || atRc === undefined)
								? []
								: [`READ COMMITTED s${i}: ${atRc ?? "committed"}`]),
							...((atSer === "40001" && !race.docsOnly) ||
							(call.unsettled === refused(atSer) && (call.unsettled || atSer === undefined))
								? []
								: [`SERIALIZABLE s${i}: ${atSer ?? "committed"}`])
						]
					})
					const locks = [
						...Arr.map(rc.locks, (l) => `READ COMMITTED holds ${l.kind} ${l.relation}`),
						...Arr.flatMap(ser.locks, (l) =>
							!race.docsOnly && l.referenced && (l.kind === "page" || l.kind === "relation")
								? []
								: [`SERIALIZABLE holds ${l.kind} ${l.relation}`]
						)
					]
					const problems = [...outcomes, ...locks]
					if (Arr.some(race.calls, (call) => call.unsettled)) {
						c.note("a CHECK refused")
					}
					if (Arr.some(ser.failures, (f) => f === "40001")) {
						c.note("a 40001 under an Invoice race")
					}
					if (Arr.isReadonlyArrayNonEmpty(problems)) {
						return yield* Effect.die(
							new Error(`${Arr.join(problems, "\n")}\nin ${Formatter.format(race)}`)
						)
					}
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "disjoint calls commit unless their Invoice is unsettled, which the Settled CHECK refuses at either level, an Invoice race's SERIALIZABLE call perhaps with 40001; no SIRead lock at READ COMMITTED, and at SERIALIZABLE none but a page or an index of Invoice, none for Docs alone"
		},
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})

/**
 * The insert protocol's arbitrations every race over shared keys is serial at generate's level and at SERIALIZABLE.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/pg/isolation/arbiter.test.ts at d8eed1786).
 */
export const theInsertProtocolsArbitrationsEveryRaceOverSharedKeysIsSerialAtGeneratesLevelAndAtSERIALIZABLE =
	property.explore(sharedRaces, {
		needs: {
			generated: Substrate.seat(generatedShape),
			serializable: Substrate.seat(serializableShape)
		},
		situations: ["a stored Doc", "two calls at one key"] satisfies ReadonlyArray<
			Reached<SharedFeature>
		>,
		check:
			({ generated, serializable }, c: Case<SharedFeature>) =>
			(race) =>
				Effect.gen(function* () {
					const generatedSeat = yield* generated
					const serSeat = yield* serializable
					const shapes = [
						{
							shape: yield* generatedShapeIn(generatedSeat, importShape),
							seat: generatedSeat.substrate
						},
						{ shape: serSeat.value, seat: serSeat.substrate }
					]
					return yield* Effect.suspend(() => {
						if (race.initial === "doc") {
							c.note("a stored Doc")
						}
						if (race.calls.length === 3) {
							c.note("three sessions")
						}
						if (
							Arr.some(race.calls, (a, i) =>
								Arr.some(race.calls, (b, j) => i < j && Arr.some(a.keys, (k) => b.keys.includes(k)))
							)
						) {
							c.note("two calls at one key")
						}
						return Effect.forEach(
							shapes,
							({ shape, seat }) =>
								Effect.provideService(
									Effect.scoped(
										runIsolationRace(shape, raceOf(race), strategyOf(c), () => undefined)
									),
									Substrate,
									seat
								),
							{ discard: true }
						)
					})
				}).pipe(Effect.scoped),
		oracle: { kind: "specification", name: "a serial order of the same calls" },
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})

/**
 * The insert protocol's arbitrations one history gives the same rows, refusals and state at either level.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/pg/isolation/arbiter.test.ts at d8eed1786).
 */
export const theInsertProtocolsArbitrationsOneHistoryGivesTheSameRowsRefusalsAndStateAtEitherLevel =
	property.explore(steered(aimedHistory), {
		needs: {
			readCommitted: Substrate.seat(readCommittedShape),
			serializable: Substrate.seat(serializableShape)
		},
		situations: [
			"an exact repeat",
			"a key or axis refusal",
			"an unsettled invoice refused",
			"lines sent alone"
		] satisfies ReadonlyArray<Reached<SerialFeature>>,
		check:
			({ readCommitted, serializable }, c: Case<SerialFeature>) =>
			(history) =>
				Effect.gen(function* () {
					const rcSeat = yield* readCommitted
					const serSeat = yield* serializable

					const initial = initialOf(history)
					const rc = yield* Effect.provideService(
						runSerial(rcSeat.value, initial, history.calls, "readCommitted"),
						Substrate,
						rcSeat.substrate
					)
					const ser = yield* Effect.provideService(
						runSerial(serSeat.value, initial, history.calls, "serializable"),
						Substrate,
						serSeat.substrate
					)
					for (const shown of rc.shown) {
						if (shown === "refused by a CHECK" || shown === "refused by the host") {
							c.note("an unsettled invoice refused")
						}
						if (shown === "refused by a key or an axis") {
							c.note("a key or axis refusal")
						}
					}
					if (Arr.some(history.calls, (call) => call.kind === "lines")) {
						c.note("lines sent alone")
					}
					if (
						Arr.some(history.calls, (a, i) =>
							Arr.some(history.calls, (b, j) => i < j && Option.isNone(exact(a.input, b.input)))
						)
					) {
						c.note("an exact repeat")
					}
					yield* agree(
						[
							["READ COMMITTED", rc],
							["SERIALIZABLE", ser]
						],
						sameHistory
					)
				}).pipe(Effect.scoped),
		oracle: { kind: "specification", name: "the READ COMMITTED form's outcomes" },
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})
