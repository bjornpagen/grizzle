/**
 * The native multi-session test substrate's release of the roles a schema's scope leaves. Its sessions and psql writers
 * are the substrate every other pg suite runs on, the lock barrier among them under every schedule
 * (test/support/schedules/interleave.ts); psql's native errors are the direct-writer suites' (test/pg/direct-writers).
 * Each case runs in a database of its own (Substrate.fresh), cloned from the base template for it and dropped after it.
 *
 * The released-roles property draws a schema and who creates roles under its prefix: the substrate, which gives each
 * role a finalizer of its own, an installation, a shop generated and migrated into it (test/pg/cli/fixture.ts shopV1)
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
import { shopV1 } from "#test/pg/cli/fixture.ts"
import {
	releaseAims,
	type ReleaseFeature,
	releaseFeatures,
	releasingGen,
	rolesUnder
} from "#test/pg/substrate/substrate.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/** A schema's release drops every role under its prefix, the ones an installation created among them. */
export const releasesEveryRoleUnderItsPrefix = property.explore(aimed(releasingGen, releaseAims), {
	needs: { substrate: Substrate.fresh },
	/** Its pre-conversion budget: runs 4, coverage cases 8 (substrate.test.ts:509-511 at d55043f1^). */
	budget: { runs: 4, steered: 8 },
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
			resources.substrate
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
				"\tfor (const line of body) {\n\t\tout.line(line)\n\t}\n\tout.line(tag)\n}\n\n/** A statement of the catalog language (sql/catalog.ts), written into `out`: a read on one line, a DO block nested. */",
			replacement:
				"\tfor (const line of body) {\n\t\tout.line(line)\n\t}\n\t{}\n}\n\n/** A statement of the catalog language (sql/catalog.ts), written into `out`: a read on one line, a DO block nested. */",
			why: "Operator mutant (statement) at packages/engine/src/sql/print.ts:2383 in writeDo: `out.line(tag)` becomes `{}`; the property fails (lane CATCH, grizzle b0d74512)."
		}
	]
})
