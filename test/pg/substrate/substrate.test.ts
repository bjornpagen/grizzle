/**
 * What the native multi-session test substrate judges a test to leave behind in its database: every object a clean
 * test database does not hold. Its sessions, psql writers and expectations are the substrate every other pg suite runs
 * on, the lock barrier among them under every schedule (test/support/schedules/interleave.ts); psql's native errors are
 * the direct-writer suites' (test/pg/direct-writers); the expectations' judgment is the unit tier's
 * (test/unit/substrate). Each case runs in a database of its own (Substrate.fresh), cloned from the base template for
 * it and dropped after it.
 *
 * The leftovers property requires the case's own database to be clean, then plants a drawn set of strays, each a kind
 * of object a test may create in its database under a name of its own, and requires the leftover listing to name
 * exactly those strays, and none once they are dropped.
 *
 * The clearing property draws a schema a test owns whole, as a substrate proof's seat is: its tables, plain or
 * partitioned, each referencing nothing, itself or an earlier table, with rows or none, and a view and a sequence beside
 * them. It clears the schema by its catalog group (substrate/replace.ts schemaGroup, clearRows), on a session of its own
 * as a seat's, and requires every table it drew to hold no row and no page after: a table left out of the group keeps
 * its rows or refuses the TRUNCATE of the table it references (0A000), a relation that is no table put in it refuses
 * the TRUNCATE (42809), and a DELETE leaves the pages of the versions it removed.
 *
 * The released-roles property draws a schema and who creates roles under its prefix: the substrate, which gives each
 * role a finalizer of its own, an installation, a shop generated and migrated into it (test/pg/cli/fixture.ts shopV1)
 * whose migration creates its world roles `reader` and `writer` with no finalizer, both, or neither. Once the schema's
 * scope closes, no role under its prefix remains on the substrate's member, the one the case's database is on, where
 * its roles live, cluster-wide: the schema's release sweeps every `<schema>_*` role, so a role an installation created
 * is dropped though nothing else names it. Each situation is required, and a steered case whose turn aims at one draws
 * a schema constructed to reach it (releaseAims).
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { shopV1 } from "#test/pg/cli/fixture.ts"
import {
	type ClearingFeature,
	clearingFeatures,
	clearingFeaturesOf,
	drawnSchemaGen,
	drawnSql,
	drawnTablesOf,
	type LeftoverFeature,
	plantedOf,
	plantingGen,
	releaseAims,
	type ReleaseFeature,
	releaseFeatures,
	releasingGen,
	rolesUnder,
	strays
} from "#test/pg/substrate/substrate.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { qualified } from "#test/support/substrate.ts"
import { clearRows, schemaGroup } from "#test/support/substrate/replace.ts"
import { leftovers } from "#test/support/substrate/shared.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A case's own database is clean, and the leftover listing names exactly the strays a test leaves in it, and none once
 * they are dropped.
 */
export const listsExactlyTheStrays = property.explore(plantingGen, {
	needs: { substrate: Substrate.fresh },
	situations: [...strays, "clean"] satisfies ReadonlyArray<Reached<LeftoverFeature>>,
	check:
		({ substrate }, c: Case<LeftoverFeature>) =>
		(p) =>
			Effect.gen(function* () {
				const s = yield* substrate
				const planted = plantedOf(p)
				const before = yield* leftovers(s.admin)
				assert.deepEqual(before, [], "the case's own database is clean")
				yield* Effect.forEach(planted, (stray) => s.admin.query(stray.create, []), {
					discard: true
				})
				const listed = yield* leftovers(s.admin)
				yield* Effect.forEach(Arr.reverse(planted), (stray) => s.admin.query(stray.drop, []), {
					discard: true
				})
				assert.deepEqual(
					Arr.sort(listed, Order.String),
					Arr.sort(
						Arr.map(planted, (stray) => stray.listed),
						Order.String
					)
				)
				const cleared = yield* leftovers(s.admin)
				assert.deepEqual(cleared, [])
				c.noteAll(p.strays)
				if (!Arr.isReadonlyArrayNonEmpty(planted)) {
					c.note("clean")
				}
			}),
	oracle: {
		kind: "specification",
		name: "the strays planted, each named by the line of its kind, and none once they are dropped"
	},
	kept: [],
	kills: []
})

/**
 * Clearing a schema a test owns whole leaves every table of it, partitioned or referenced, with no row and no page,
 * whatever views and sequences sit beside them.
 */
export const clearsAnOwnedSchema = property.explore(drawnSchemaGen, {
	needs: { substrate: Substrate.fresh },
	situations: clearingFeatures satisfies ReadonlyArray<Reached<ClearingFeature>>,
	check:
		({ substrate }, c: Case<ClearingFeature>) =>
		(d) =>
			Effect.gen(function* () {
				const s = yield* substrate
				const session = yield* s.session({ ...ownerSession(), label: "clearing" })
				const schema = yield* s.schema(freshSchema)
				yield* Effect.forEach(drawnSql(schema, d), (sql) => s.admin.query(sql, []), {
					discard: true
				})
				const group = yield* schemaGroup(s.admin, schema)
				yield* clearRows(session, group)
				const tables = Arr.map(drawnTablesOf(d), (t) => qualified(schema, t))
				const held = yield* Effect.forEach(tables, (table) =>
					Effect.map(
						s.admin.queryValues(
							`SELECT count(*)::int4, pg_catalog.pg_relation_size($1::text::regclass)::int4 FROM ${table}`,
							[table]
						),
						(rows) =>
							Arr.map(
								rows,
								([count, bytes]) => `${table} holds ${Number(count)} rows in ${Number(bytes)} bytes`
							)
					)
				)
				assert.deepEqual(
					held,
					Arr.map(tables, (table) => [`${table} holds 0 rows in 0 bytes`])
				)
				c.noteAll(clearingFeaturesOf(d))
			}),
	oracle: {
		kind: "specification",
		name: "every table the schema's DDL created holds no row and no page"
	},
	kept: [],
	kills: []
})

/** A schema's release drops every role under its prefix, the ones an installation created among them. */
export const releasesEveryRoleUnderItsPrefix = property.explore(aimed(releasingGen, releaseAims), {
	needs: { substrate: Substrate.fresh },
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
	kills: []
})
