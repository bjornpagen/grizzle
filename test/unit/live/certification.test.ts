/**
 * Certification stays put: a role's isolation certificate is decided by its writes alone, so the live source a login's
 * reads install over their footprint tables (the publication and the replica identity its plan asks for) changes no
 * verdict. Over the QTI-shaped learner (the isolation oracle's sitting
 * shape, test/support/pg/isolation/support/shapes.ts: an importer writing a Doc and its Pools, a learner starting a Sitting by
 * reading the Doc's group, or naming every value of it) and the platform fixture (test/support/fixtures/api/platform.ts,
 * its billing role's served workload), each drafted as `grizzle generate` drafts it from the empty snapshot
 * (cli/generate.ts draftSchema):
 *
 * - every role's certificate, its level and its reasons, under a drawn set of the login's reads, is the one it has
 *   under no read at all, where no table is a live source;
 * - the draft with no read plans no live table (its snapshot's live plan is empty), and the sitting shape's draft with
 *   reads plans exactly the relations its reads match as footprint tables, so the two drafts certify over
 *   installations that differ by their live source, and the first property is not met by two equal drafts. The
 *   platform's reads run through derived relations, whose footprints the live suites judge; here their draft is held
 *   to the certificates alone.
 *
 * The oracle is the certifier's verdict without the live source: the same logins' draft with every read left out, whose
 * workloads hold their writes alone, and whose roles, privileges and writes are the drawn draft's.
 *
 * Reads drawn: for the sitting shape, a drawn set of reads over its four relations (a Doc by its node, a Doc's Pools,
 * a Doc's Sittings, a Sitting's Served rows, every Doc), served to a reader of its own login, which holds every relation
 * whole and writes nothing, and serves nothing in the draft without reads; for the platform, a drawn subset of the
 * billing workload's reads, its billing role and login built again over the same schema.
 *
 * The live source is a publication and a replica identity, and the certifier reads neither: its input holds the law
 * model's facts, the grants and the change members alone (program/isolation/input.ts IsolationInput), so no field of it
 * can carry a read, a bug that couples a certificate to the reads is unrepresentable, and a certifier's bug moves both
 * drafts alike. The bug this file can catch is the one that would make its first property hold of two equal drafts: a
 * live plan without the reads' footprint tables.
 *
 * Features: each fixture, a role certified READ COMMITTED, a role certified SERIALIZABLE, a live table a READ
 * COMMITTED role writes, no read kept, a read kept.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { subset } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import {
	caseGen,
	draftOf,
	type Feature,
	platformBillingReads,
	sittingFootprint
} from "#test/unit/live/certification.fixtures.ts"

/**
 * A role's certificate is the same with the live source of any reads as with none, for the QTI-shaped learner and the
 * platform.
 *
 * Budget: its suite's count before the conversion (unit/live/certification: 12 independent cases and 8 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const aRolesCertificateIsTheSameWithTheLiveSourceOfAnyReadsAsWithNoneForTheQTIShapedLearnerAndThePlatform =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"the sitting shape",
			"the platform",
			"a role certified READ COMMITTED",
			"a role certified SERIALIZABLE",
			"a live table a READ COMMITTED role writes",
			"no read kept",
			"a read kept"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: CaseOf<Feature>) => (c) =>
			Effect.gen(function* () {
				notes.note(c.fixture.kind === "platform" ? "the platform" : "the sitting shape")
				const platformReads = notes.draw(
					subset(platformBillingReads, { min: 0, max: platformBillingReads.length })
				)
				const withTriggers = yield* draftOf(c, platformReads, true)
				const without = yield* draftOf(c, platformReads, false)
				notes.note(Arr.isReadonlyArrayNonEmpty(withTriggers.kept) ? "a read kept" : "no read kept")
				assert.deepEqual(
					withTriggers.certification,
					without.certification,
					`every role certifies as it does with no live source\n${Formatter.format(c)}`
				)
				assert.deepEqual([...without.live], [], "a draft with no read plans no live table")
				if (c.fixture.kind === "sitting") {
					assert.deepEqual(
						Arr.sort([...withTriggers.live], Order.String),
						Arr.sort(
							Arr.dedupe(Arr.map(c.sitting, (read) => sittingFootprint[read])),
							Order.String
						),
						"the sitting shape's draft with reads plans exactly the relations its reads match"
					)
				}
				for (const certified of withTriggers.certification) {
					if (certified.certificate.level === "readCommitted") {
						notes.note("a role certified READ COMMITTED")
						const writes = withTriggers.writes.get(certified.role) ?? []
						if (Arr.some(writes, (relation) => withTriggers.live.has(relation))) {
							notes.note("a live table a READ COMMITTED role writes")
						}
					} else {
						notes.note("a role certified SERIALIZABLE")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the certifier's verdict over the same logins' draft with no read, which holds no live source"
		},
		budget: { runs: 12, steered: 8 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original:
					"\t\ttables: [...tables]\n\t\t\t.toSorted(([a], [b]) => compareStrings(a, b))\n\t\t\t.map(([relation, fields]) => ({ relation, routes: [...fields].toSorted(compareStrings) }))\n",
				replacement: "\t\ttables: []\n",
				why: "The live plan holds no footprint table whatever the reads (program/workload/compile.ts livePlanOf), so the drafts with and without reads install the same tables; the sitting shape's draft with reads fails the footprint property."
			}
		]
	})
