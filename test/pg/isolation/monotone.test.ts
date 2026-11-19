/**
 * Rules over queries monotone in a READ COMMITTED role's writes (analysis/isolation/certify.ts `laws`, DENSEATS's
 * repro), against PostgreSQL 19: a role generate certifies READ COMMITTED beside a rule its writes fire runs its writes
 * there, its rule's probes reading at COMMIT at a snapshot of their own, and every run of concurrent calls must still be
 * one some strict serial order of the same calls explains; each neighbour that breaks monotonicity stays SERIALIZABLE,
 * and forced READ COMMITTED it is caught.
 *
 * The oracle is the isolation suite's serial reference (support/race.ts runIsolationRace, test/support/schedules/serial.ts):
 * each call a direct transaction of its served write's statements at its role's level, interleaved at statement
 * boundaries; a run passes when some order of the calls that respects real time, each run alone from the race's initial
 * state, shows every statement's rows or SQLSTATE, a rule's refusal at COMMIT among them, and leaves its state.
 *
 * The shapes (monotoneShape), each R(k, n) keyed by k with `Live = R where not E` on the level above, every one but the
 * pair under `check(Below, Live, n < 3)`:
 * - the writer: the `coordinator` inserts R (`hold`) and E (`free`). Its one witness reads one row of R and E's
 *   absence, and E is only inserted, so generate certifies it READ COMMITTED. Raced: a hold of a row over the bound
 *   beside a free of its key, every order.
 * - the deleted: the `holder` inserts R and the `remover` deletes E (`unfree`): E's absence can be made true.
 * - the pair: `key(Live, n)` over the coordinator's inserts of R, two rows of one witness. Its `holdAt` inserts R and
 *   then Q, whose key into P, a relation no role writes, PostgreSQL checks at COMMIT after the rule's probe. Raced
 *   pinned: the owner locks P(1) FOR UPDATE; a hold of n at p 1 runs to its COMMIT, whose probe runs and whose check
 *   then waits on the lock; a hold of the same n at p 2 runs and commits; the owner commits. The two probes overlap,
 *   each before the other's commit, as two COMMITs do on separate connections.
 * - the gated: the `holder` inserts R, the `freer` inserts E(k) where Z(k) is absent (`free`) and the `gater` inserts
 *   Z(k) (`gate`): the freer reads Z unsealed, so it runs SERIALIZABLE and may miss another call's write, and the
 *   holder's probe reads E, which it writes (5c through the probe). Raced on NEGATION's case 3, pinned: the free reads Z
 *   and pauses before its COMMIT, the gate runs, the hold runs and is refused at its probe, then the free commits.
 * - the retired: the `holder` inserts R and E is a retirable unit's body (H its header), which no role writes and the
 *   owner retires (physical/ddl/retire.ts), deleting E's rows of a group. Raced: a hold beside the owner's retirement of
 *   the group holding E(k).
 *
 * Properties: every race of the writer is serial at generate's levels; each other shape's race is serial at generate's
 * levels, and caught (some run no serial order explains) with its writer forced READ COMMITTED (support/race.ts
 * Certifier `forced`).
 *
 * Required features: generate certifies the writer READ COMMITTED and keeps every other shape's writer SERIALIZABLE; a
 * READ COMMITTED hold refused at its probe while the free of its key was in flight, which a strict serial order places
 * before it; a READ COMMITTED hold whose probe read a free that committed after the hold's statements ran, a commit its
 * statement's snapshot never saw, so the probe's fresher read decided it; and each forced writer caught. A commit a
 * monotone probe sees can only withdraw a violation, never add one (certify.ts, its proof's second step), so no run
 * refuses a READ COMMITTED writer for a commit it saw.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type Counter,
	counters,
	type Feature,
	forcedShapes,
	generatedShapes,
	monotoneShape,
	pinnedStrategy,
	raceFor,
	runs,
	valuesGen,
	type Variant,
	writerFeatures,
	writerOf
} from "#test/pg/isolation/monotone.fixtures.ts"
import {
	raceOn,
	type SeatedShape,
	seatedCertified,
	seatedGenerated
} from "#test/pg/isolation/support/race.ts"
import { every, type Strategy } from "#test/support/schedules/interleave.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Rules over queries monotone in a READ COMMITTED writer, on PostgreSQL 19 the monotone writer runs READ COMMITTED and every race is serial; each neighbour stays SERIALIZABLE, and forced READ COMMITTED is caught.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/pg/isolation/monotone.test.ts at d8eed1786).
 */
export const rulesOverQueriesMonotoneInAREADCOMMITTEDWriterOnPostgreSQL19TheMonotoneWriterRunsREADCOMMITTEDAndEveryRaceIsSerialEachNeighbourStaysSERIALIZABLEAndForcedREADCOMMITTEDIsCaught =
	property.explore(valuesGen, {
		needs: {
			writer: Substrate.seat(generatedShapes.writer),
			deleted: Substrate.seat(generatedShapes.deleted),
			pair: Substrate.seat(generatedShapes.pair),
			gated: Substrate.seat(generatedShapes.gated),
			retired: Substrate.seat(generatedShapes.retired),
			forcedDeleted: Substrate.seat(forcedShapes.deleted),
			forcedPair: Substrate.seat(forcedShapes.pair),
			forcedGated: Substrate.seat(forcedShapes.gated),
			forcedRetired: Substrate.seat(forcedShapes.retired)
		},
		situations: [
			"generate certifies the writer READ COMMITTED",
			"generate keeps every other shape's writer SERIALIZABLE",
			"a READ COMMITTED hold refused at its probe while a free of its key was in flight",
			"a READ COMMITTED hold whose probe read a free committed after its statements ran",
			...Arr.map(counters, (c) => `the ${c} caught forced READ COMMITTED` as const)
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (needs, c: Case<Feature>) => (x) =>
			Effect.gen(function* () {
				const installed: Readonly<Record<Variant, SeatedShape>> = {
					writer: yield* Effect.flatMap(needs.writer, seatedGenerated(monotoneShape("writer"))),
					deleted: yield* Effect.flatMap(needs.deleted, seatedGenerated(monotoneShape("deleted"))),
					pair: yield* Effect.flatMap(needs.pair, seatedGenerated(monotoneShape("pair"))),
					gated: yield* Effect.flatMap(needs.gated, seatedGenerated(monotoneShape("gated"))),
					retired: yield* Effect.flatMap(needs.retired, seatedGenerated(monotoneShape("retired")))
				}
				const forced: Readonly<Record<Counter, SeatedShape>> = {
					deleted: yield* Effect.map(needs.forcedDeleted, seatedCertified),
					pair: yield* Effect.map(needs.forcedPair, seatedCertified),
					gated: yield* Effect.map(needs.forcedGated, seatedCertified),
					retired: yield* Effect.map(needs.forcedRetired, seatedCertified)
				}
				const strategy = (pinned: boolean) => (pinned ? pinnedStrategy(c) : (): Strategy => every)
				const variants: Arr.NonEmptyReadonlyArray<Variant> = ["writer", ...counters]
				for (const variant of variants) {
					const { race, pinned } = raceFor(variant, x)
					yield* raceOn(installed[variant], race, strategy(pinned), (e) => {
						if (variant === "writer") {
							for (const f of writerFeatures(e)) {
								c.note(f)
							}
						}
					})
				}
				const level = (variant: Variant) =>
					installed[variant].shape.generated.get(writerOf(variant))
				if (level("writer") === "readCommitted") {
					c.note("generate certifies the writer READ COMMITTED")
				}
				if (Arr.every(counters, (v) => level(v) === "serializable")) {
					c.note("generate keeps every other shape's writer SERIALIZABLE")
				}
				for (const counter of counters) {
					const { race, pinned } = raceFor(counter, x)
					const result = yield* Effect.result(
						raceOn(forced[counter], race, strategy(pinned), () => undefined)
					)
					if (result._tag === "Failure" && result.failure._tag === "NoSerialOrder") {
						c.note(`the ${counter} caught forced READ COMMITTED`)
					} else if (result._tag === "Failure") {
						return yield* Effect.fail(result.failure)
					} else {
						return yield* Effect.die(
							new Error(
								`the ${counter}: every run is serial with its writer forced READ COMMITTED, so the oracle cannot catch it`
							)
						)
					}
				}
			}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "a strict serial order of the same calls"
		},
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})
