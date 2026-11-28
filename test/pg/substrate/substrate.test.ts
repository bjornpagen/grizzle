/**
 * The native multi-session test substrate's release of the roles a schema's scope leaves. Its sessions and psql writers
 * are the substrate every other pg suite runs on, the lock barrier among them under every schedule
 * (test/support/schedules/interleave.ts).
 * Each case runs in a database of its own (Substrate.fresh), cloned from the base template for it and dropped after it.
 *
 * The released-roles property draws a schema and who creates roles under its prefix: the substrate, which gives each
 * role a finalizer of its own, an installation, a shop generated and migrated into it (test/support/pg/cli/fixture.ts shopV1)
 * whose migration creates its world roles `reader` and `writer` with no finalizer, both, or neither. Once the schema's
 * scope closes, no role under its prefix remains on the substrate's member, the one the case's database is on, where
 * its roles live, cluster-wide: the schema's release sweeps every `<schema>_*` role, so a role an installation created
 * is dropped though nothing else names it. Each situation is required, and a steered case whose turn aims at one draws
 * a schema constructed to reach it (releaseAims).
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	releaseAims,
	type ReleaseFeature,
	releaseFeatures,
	releasingGen,
	rolesUnder
} from "#test/pg/substrate/substrate.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { shopV1 } from "#test/support/pg/cli/fixture.ts"
import { freshSchema, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A schema's release drops every role under its prefix, the ones an installation created among them. */
export const releasesEveryRoleUnderItsPrefix = property.explore(aimed(releasingGen, releaseAims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	/**
	 * Its search budget: one case of each stream, the least the runner runs, and three steered cases, one for each
	 * situation its floor case leaves pending, each aimed at it (releaseAims).
	 *
	 * @limitKind measured
	 * @owner grizzle's network tier (test/pg/substrate/substrate.test.ts)
	 * @unit cases: the rotating stream's runs (its floor a quarter of them, rounded up), and steered cases at most
	 * @scope one run of this property's search, on whichever worker runs it
	 * @evidence ~/.cache/grizzle-release/CULL-SUBSTRATE/budget: `measure.sh 1 2 4` (run-<runs>.log, steered 8) and
	 *   `measure-steered.sh 0 2 3 4 6 7` (steered-<steered>.log, runs 1), each one `toolchain-test run` of the property
	 *   under TEST_SEED=2219874524, its search and then its kill; env.txt beside them
	 * @observed 2026-11-23 04:49:35 to 05:00:05 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GB, shared with other lanes' runs (load
	 *   average 400 to 546, 223 GB of memory in use); the machine's PostgreSQL 19.0 as postgres@grizzle-m-cull-substrate-0
	 *   and -1, in memory; grizzle dbcb0992 with vendor/toolchain at its pin; Node 26.13.1
	 * @workload this property on one worker, beside forms.test.ts's five exhaustions in the runs grid
	 * @result at steered 8: runs 1, 2 and 4 ran 10, 11 and 13 cases, every situation reached, the kill (sql/print.ts
	 *   quotedLines) killed. At runs 1: steered 0 left three situations unreached and 2 left "no role", each a failed
	 *   search; steered 3, 4, 6 and 7 ran 5, 6, 8 and 9 cases, every situation reached and the kill killed. Its
	 *   witnesses, the floor and the steered phase, are fixed by the property's identity, so each holds on every run seed
	 * @decision runs 1 and steered 3, the least at which every situation is reached and the kill killed: 5 cases, where
	 *   its pre-conversion budget (runs 4, coverage cases 8, substrate.test.ts:509-511 at d55043f1^) ran 13. No
	 *   headroom: a situation the steered phase stops reaching fails the search, never passes it
	 * @revalidate a change to releasingGen, releaseAims or releaseFeatures; a kill added; the runner's floor or steering
	 */
	budget: { runs: 1, steered: 3 },
	situations: releaseFeatures satisfies ReadonlyArray<Reached<ReleaseFeature>>,
	check: (resources, c: Case<ReleaseFeature>) => (p) =>
		Effect.provideServiceEffect(
			Effect.gen(function* () {
				const s = yield* Substrate
				const held = yield* Effect.scoped(
					Effect.gen(function* () {
						const schema = Arr.contains(p.creators, "an installation")
							? (yield* installGenerated(
									(name) => {
										const shop = shopV1(name, "none")
										return { schema: shop.schema, logins: [shop.server] }
									},
									{ label: "released", ambient: ordinarySession }
								)).installed.declared
							: yield* s.schema(freshSchema)
						const allocated = Arr.contains(p.creators, "the substrate")
							? [(yield* s.role(schema, "allocated")).role]
							: []
						return { schema, allocated, present: yield* rolesUnder(s, schema) }
					})
				)
				const left = yield* rolesUnder(s, held.schema)
				assert.deepEqual(left, [], `the roles left under ${held.schema} once it is released`)
				const installed = Arr.filter(held.present, (role) => !Arr.contains(held.allocated, role))
				if (Arr.isReadonlyArrayNonEmpty(held.allocated)) {
					c.note("a role the substrate created")
				}
				if (Arr.isReadonlyArrayNonEmpty(installed)) {
					c.note("a role an installation created")
				}
				if (Arr.isReadonlyArrayNonEmpty(held.allocated) && Arr.isReadonlyArrayNonEmpty(installed)) {
					c.note("roles of both creators")
				}
				if (!Arr.isReadonlyArrayNonEmpty(held.present)) {
					c.note("no role")
				}
			}),
			Substrate,
			Effect.map(resources.substrate, (taken) => taken.substrate)
		),
	oracle: {
		kind: "specification",
		name: "no role under a released schema's prefix on the substrate's member, whoever created it"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/print.ts",
			original:
				"\tfor (const line of body) {\n\t\tout.line(line)\n\t}\n\tout.line(tag)\n}\n\n/** What a stub constant returns (sql/ast.ts StubConstant): NULL of its result type. */",
			replacement:
				"\tfor (const line of body) {\n\t\tout.line(line)\n\t}\n\t{}\n}\n\n/** What a stub constant returns (sql/ast.ts StubConstant): NULL of its result type. */",
			why: "Operator mutant (statement) in packages/engine/src/sql/print.ts quotedLines, which writeDo quotes a DO block by: `out.line(tag)` becomes `{}`; the property fails (lane CATCH, grizzle b0d74512, re-pointed where lane DRIFTREDS moved writeDo's quoting into quotedLines)."
		}
	]
})
