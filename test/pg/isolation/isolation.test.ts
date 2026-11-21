/**
 * The isolation certifier's soundness, against PostgreSQL 19: a role it certifies READ COMMITTED runs its change members
 * at READ COMMITTED, and every run of concurrent calls must still be one some serial order of the same calls explains.
 *
 * The oracle is the serial reference (test/support/schedules/serial.ts runSerialRace): each call is a direct
 * transaction of its served write's statements as the application sends them (race.ts callStatements), at its role's
 * certified level, interleaved at statement boundaries by the one concurrency driver; a run passes when some order of
 * the calls that respects real time, each run alone from the race's initial state, shows every statement's rows or
 * SQLSTATE the run showed and leaves its state.
 *
 * Every installation is drafted as `grizzle generate` drafts it (support/race.ts installShape): generate's draft
 * certifies each role over the statements its served writes send (cli/generate.ts draftSchema), the installation holds
 * the certificates, each table keeping its guard unless every role that writes it is READ COMMITTED, and each role's
 * served file records its level, at which its calls begin.
 *
 * - Positives (support/shapes.ts): every race over the shapes is serial at generate's levels in every run the strategy
 *   reaches: every order where a race makes few moves, PCT beyond.
 * - Counterexamples: each shape a flawed certifier passes (support/certify.ts), installed holding that certifier's
 *   certificates, must give a run no serial order explains, and generate must keep every role the flaw passes
 *   SERIALIZABLE; one the oracle does not catch, or one generate passes, is a failure.
 * - Drawn installations (support/drawn.ts): pivots and members of two statements over four relations are serial at
 *   generate's levels, and at the levels `certify` gives facts stated one to one with the drawing and the conditions
 *   restated over it give, wherever those differ from generate's.
 * - den's lease (support/lease.ts): generate runs its spawner, claimer and committer READ COMMITTED, and every race of
 *   its claims, the winner's Log, reclaims and commits is serial; each search for work (a take of the next due item, a
 *   count of claims, a read at another key than the one the claim raced) is serial at generate's levels, which keep
 *   it SERIALIZABLE, and caught forced READ COMMITTED.
 * - G3's fenced replace (support/shapes.ts fencedShape): a READ COMMITTED learner beside a SERIALIZABLE publisher whose
 *   login deletes and inserts what the learner references, so generate fences it (analysis/isolation/certify.ts Fence):
 *   a same-key replace, an identical one, a removal of the learner's key, a replace of another key, NEGATION's case 3
 *   as a publish that misses a gate, and a removal of two fenced relations the learner checks in either order, each
 *   serial in every run. The learner's key into Pub is deferred, as edullm's learner's keys into its publications are:
 *   its check runs inside its COMMIT, one move, taking ROW SHARE on Pub and then its snapshot. Its required features:
 *   the learner's deferred check waiting on the fenced write's lock of a replace that deletes the checked key and
 *   inserts it again, then finding the committed state; a fenced write's lock waiting on a learner's check, which only
 *   the immediate checks of PubA and PubZ can hold across a move; the learner committing before the replace begins; a
 *   key removed; a check waiting on an in-flight publish; and a deadlock a fenced removal meets, which PostgreSQL breaks
 *   with 40P01, a transient abort the serial reference places nowhere.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	counterCase,
	counterNeeds,
	counterRaces,
	drawnCase,
	type DrawnFeature,
	fencedCase,
	type FencedFeature,
	fencedNeeds,
	fencedValues,
	leaseCase,
	type LeaseFeature,
	leaseNeeds,
	leaseValues,
	positiveCase,
	type PositiveFeature,
	positiveNeeds,
	positiveRaces,
	probeCase,
	type ProbeFeature,
	probeNeeds,
	probeValues,
	publishedCase,
	type PublishedFeature,
	publishedNeeds,
	publishedValues
} from "#test/pg/isolation/isolation.fixtures.ts"
import type { CounterShape } from "#test/pg/isolation/support/certify.ts"
import { drawnRaceGen, twoStatementRace } from "#test/pg/isolation/support/drawn.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every race over a shape is serial at the levels generate certifies, each case on the worker's seats of the four
 * positive shapes.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/isolation/isolation.test.ts at fa10bca50).
 */
export const everyRaceOverAShapeIsSerialAtTheLevelsGenerateCertifies = property.explore(
	positiveRaces,
	{
		needs: positiveNeeds,
		situations: [
			"point",
			"fold",
			"sitting",
			"two calls overlapped",
			"a READ COMMITTED role called"
		] satisfies ReadonlyArray<Reached<PositiveFeature>>,
		check: (needs, c: Case<PositiveFeature>) => (races) => positiveCase(needs, races, c),
		oracle: { kind: "specification", name: "a serial order of the same calls" },
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	}
)

/**
 * A flawed certifier's READ COMMITTED is caught by a run no serial order explains, each case on the worker's seats of
 * the thirteen counterexamples, each holding its flawed certifier's certificates.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/isolation/isolation.test.ts at fa10bca50).
 */
export const aFlawedCertifiersREADCOMMITTEDIsCaughtByARunNoSerialOrderExplains = property.explore(
	counterRaces,
	{
		needs: counterNeeds,
		situations: [
			"partial caught",
			"copies caught",
			"pointCopies caught",
			"spanning caught",
			"extended caught",
			"single caught",
			"listed caught",
			"fk caught",
			"deferred caught",
			"carrier caught",
			"fallback caught",
			"boundFallback caught",
			"recursiveFallback caught"
		] satisfies ReadonlyArray<Reached<`${CounterShape} caught`>>,
		check: (needs, c: Case<`${CounterShape} caught`>) => (races) => counterCase(needs, races, c),
		oracle: { kind: "specification", name: "a serial order of the same calls" },
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	}
)

/**
 * NEGATION's publication layer: every race is serial at generate's levels, and each forced level is caught, each case
 * on the worker's seats of the published shape at each certifier's levels.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/isolation/isolation.test.ts at fa10bca50).
 */
export const negationsPublicationLayerEveryRaceIsSerialAndEachForcedLevelIsCaught =
	property.explore(publishedValues, {
		needs: publishedNeeds,
		situations: ["every publication race serial", "races 7 and 8 caught"] satisfies ReadonlyArray<
			Reached<PublishedFeature>
		>,
		check: (needs, c: Case<PublishedFeature>) => (values) => publishedCase(needs, values, c),
		oracle: { kind: "specification", name: "a strict serial order of the same calls" },
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	})

/**
 * G3's fenced replace: an RC learner beside a publisher that deletes and inserts what it references, every race serial
 * at generate's levels, each case on the worker's seat of the fenced shape.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/isolation/isolation.test.ts at fa10bca50).
 */
export const g3sFencedReplaceEveryRaceOfAnRCLearnerBesideAFencedPublisherIsSerial =
	property.explore(fencedValues, {
		needs: fencedNeeds,
		situations: [
			"generate certifies the learner READ COMMITTED",
			"generate fences every publisher write of Pub",
			"a learner's deferred check waited on a fenced write's lock",
			"a fenced write's lock waited on a learner's check",
			"a learner committed before a same-key replace began",
			"a key removed beside a learner",
			"a learner's check waited on an in-flight publish",
			"a deadlock a fenced removal met",
			"every fenced race serial"
		] satisfies ReadonlyArray<Reached<FencedFeature>>,
		check: (needs, c: Case<FencedFeature>) => (values) => fencedCase(needs, values, c),
		oracle: { kind: "specification", name: "a strict serial order of the same calls" },
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	})

/**
 * B-03c's probes and the arbitrated read: the savers and the twin serial, the skew and the gated claim caught forced,
 * each case on the worker's seats of the eight probe installations.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/isolation/isolation.test.ts at fa10bca50).
 */
export const b03csProbesAndTheArbitratedReadSerialAndTheSkewAndGatedClaimCaughtForced =
	property.explore(probeValues, {
		needs: probeNeeds,
		situations: [
			"every probe race serial",
			"the skew and the gated claim caught"
		] satisfies ReadonlyArray<Reached<ProbeFeature>>,
		check: (needs, c: Case<ProbeFeature>) => (values) => probeCase(needs, values, c),
		oracle: { kind: "specification", name: "a strict serial order of the same calls" },
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	})

/**
 * den's lease races are serial at generate's levels, which run its claimer READ COMMITTED, and each search for work is
 * caught forced READ COMMITTED, each case on the worker's seats of the seven lease installations.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/isolation/isolation.test.ts at fa10bca50).
 */
export const densLeaseRacesAreSerialAndEachSearchForWorkIsCaughtForcedREADCOMMITTED =
	property.explore(leaseValues, {
		needs: leaseNeeds,
		situations: [
			"every lease race serial",
			"each search for work caught forced",
			"the lease's claimer certified READ COMMITTED"
		] satisfies ReadonlyArray<Reached<LeaseFeature>>,
		check: (needs, c: Case<LeaseFeature>) => (values) => leaseCase(needs, values, c),
		oracle: { kind: "specification", name: "a strict serial order of the same calls" },
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	})

/**
 * Every race over a drawn installation is serial at generate's levels, and at 1:1 facts' and the restated conditions'
 * where they differ, each case installing its drawn installation on its own substrate (Substrate.installing).
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/isolation/isolation.test.ts at fa10bca50).
 */
export const everyRaceOverADrawnInstallationIsSerialAtGeneratesLevelsAndAtEveryOtherCertifiers =
	property.explore(
		aimed(drawnRaceGen, [["a READ COMMITTED member of two statements", twoStatementRace]]),
		{
			needs: { substrate: Substrate.installing },
			situations: [
				"a READ COMMITTED call",
				"a READ COMMITTED pivot",
				"a READ COMMITTED member of two statements",
				"two calls overlapped"
			] satisfies ReadonlyArray<Reached<DrawnFeature>>,
			check:
				({ substrate }, c: Case<DrawnFeature>) =>
				(race) =>
					Effect.provideServiceEffect(drawnCase(race, c), Substrate, substrate),
			oracle: { kind: "specification", name: "a serial order of the same calls" },
			budget: { runs: 8, steered: 8 },
			kept: [],
			kills: []
		}
	)
