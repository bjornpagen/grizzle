import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { Db } from "#adapter/public/db.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import {
	type ClosedFeature,
	handlePool,
	Label,
	labelPool,
	plansCaseGen
} from "#test/pg/reads/closed-only.fixtures.ts"
import { installed } from "#test/pg/reads/support.ts"
import { rowsOf } from "#test/support/calls.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A schema of closed relations only installs with no law and no table, opens, and reads every roster's handles.
 *
 * Its pre-conversion budget: runs 24, coverage cases 24 (test/pg/reads/closed-only.test.ts at d8eed1786).
 */
export const aSchemaOfClosedRelationsOnlyInstallsWithNoLawAndNoTableOpensAndReadsEveryRostersHandles =
	property.explore(plansCaseGen, {
		needs: { substrate: Substrate.installing },
		situations: ["one handle", "every handle"] satisfies ReadonlyArray<Reached<ClosedFeature>>,
		check:
			({ substrate }, notes: Case<ClosedFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const tierFacts = Arr.map(c.tiers, (id, i) => {
							const [seats, label] = defined(c.payload[i])
							return { id, seats, label: defined(labelPool[label]) }
						})
						const Tier = closed.ordered("Tier", c.tiers)
						const TierInfo = closed.relation(
							"TierInfo",
							{ id: closedId(Tier), seats: pg.integer, label: Label },
							["id"],
							tierFacts
						)
						const Region = closed.ordered("Region", c.regions)
						const Plans = schema("Plans", [Tier, TierInfo, Region], [])
						const tiers = query(Plans).rule((r) => {
							const { id } = v(Tier, "tier")
							return r.match(Tier, { id }).find({ id })
						})
						const regions = query(Plans).rule((r) => {
							const { id } = v(Region, "region")
							return r.match(Region, { id }).find({ id })
						})
						const opened = yield* installed(
							Plans,
							{},
							{ label: "real", programs: { tiers, regions } }
						)
						assert.deepEqual(opened.installed.installation.laws.theory.laws, [])
						assert.ok(
							Rec.isEmptyRecord(opened.installed.plan.tables),
							"a schema of rosters and closed relations stores no table"
						)
						yield* Effect.gen(function* () {
							const db = yield* Db.open(opened.served.login.roles.app, {})
							const all = yield* rowsOf(db.workload.tiers.once({ params: {}, facts: {} }))
							unorderedEqual(
								Arr.map(all, (row) => row.id),
								[...c.tiers]
							)
							const rs = yield* rowsOf(db.workload.regions.once({ params: {}, facts: {} }))
							unorderedEqual(
								Arr.map(rs, (row) => row.id),
								[...c.regions]
							)
						}).pipe(Effect.scoped, withLayer(opened.served.layer))
						notes.noteAll(
							Arr.flatMap([c.tiers, c.regions], (roster): ReadonlyArray<ClosedFeature> =>
								roster.length === 1
									? ["one handle"]
									: roster.length === handlePool.length
										? ["every handle"]
										: []
							)
						)
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the schema restated: no law, no table, and each roster's handles as drawn, as a set"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: []
	})
