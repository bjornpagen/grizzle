/**
 * Retirements of a key's last references racing a keep of the same key on PostgreSQL 19: the records of a Shelves
 * query, the read shelf's row alone or its books three relations deep with an arm, keyed by their digest alone,
 * reachable from Ref, a body of Root's unit (reachable-race.fixtures.ts); roots 1 and 2 reference the kept key, either or both, and either, both or neither the
 * other key; and three calls race, each a transaction of its served statements at the level generate certifies its role,
 * interleaved at statement boundaries: the retirer's retirement of root 1, its retirement of root 2, and the writer's
 * keep of the kept key's records beside root 3's reference to them, as den keeps a row beside its reference. Every
 * order where the race makes few moves, a PCT schedule of depth 3 the case draws beyond.
 *
 * Generate certifies the writer and the retirer SERIALIZABLE, and at SERIALIZABLE every race ends one of two ways: a
 * serial order commits, or a call fails 40001, retried alone after the run as an application calls again.
 *
 * Oracle: the model of a serial order. Every order of the three calls ends alike: roots 1 and 2 retired and root 3
 * open; root 3's reference the one reference left; the kept key's records whole in every relation, released and stored
 * again where the keep came after the last retirement, kept by root 3's reference otherwise; and the other key's gone
 * from every relation. A run that ends otherwise, a call refused for anything but a transient failure (a reference's
 * foreign key refusing a release, 23503), or a transient failure beside no other call, is refused.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { racedGenerated } from "#test/pg/isolation/support/race.ts"
import {
	raceCase,
	type RaceFeature,
	raceGen,
	raceShapeOf,
	raceTemplates
} from "#test/pg/records/reachable-race.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Retirements of a key's last references racing a keep of the same key end as every serial order of them ends, each
 * call aborted by SERIALIZABLE's certification retried alone.
 *
 * Budget: 24 runs and 96 steered cases. Each case opens a served Db, which compiles the login's workloads, three psql
 * sessions and a run of the race, seconds apiece; the steered phase ends at its last situation.
 */
export const retirementsOfAKeysLastReferencesRacingAKeepOfTheSameKeyEndAsEverySerialOrderOfThemEnds =
	property.explore(raceGen, {
		needs: {
			flat: Substrate.freshOf(raceTemplates.flat),
			deep: Substrate.freshOf(raceTemplates.deep)
		},
		budget: { runs: 24, steered: 96 },
		situations: [
			"a retirement aborted and retried",
			"the keep aborted and retried",
			"released by the last retirement, then stored again by the keep",
			"released and stored again three relations deep",
			"kept by the keep's reference"
		] satisfies ReadonlyArray<Reached<RaceFeature>>,
		check: (needs, c: Case<RaceFeature>) => (race) =>
			Effect.flatMap(
				Effect.flatMap(needs[race.depth], racedGenerated(raceShapeOf(race.depth))),
				(raced) => raceCase(raced, race, c)
			),
		oracle: {
			kind: "specification",
			name: "the model of a serial order: roots 1 and 2 retired, root 3's reference alone, the kept key's records whole and the other key's gone"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/member-facts.ts",
				original: '\t\t\t\t\t\top: "delete"',
				replacement: '\t\t\t\t\t\top: "retire"',
				why: "Certification reads a release as no deletion of the records (program/isolation/member-facts.ts extractNames, retirementOf), so it can certify their writer or their retirer READ COMMITTED, where a race leaks a key no reference names or refuses a reference 23503."
			}
		]
	})
