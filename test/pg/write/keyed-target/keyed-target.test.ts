import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	Disagreed,
	type Feature,
	featureOf,
	FEATURES,
	modified,
	RELATIONS,
	seqScans,
	type Sketch,
	sketchGen,
	stored,
	unitFacts,
	World,
	worldInstall,
	worldTemplate
} from "#test/pg/write/keyed-target/keyed-target.fixtures.ts"
import { judgedSettings, unanalyzed } from "#test/support/plans.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A write statement reads the relations it writes only through a key it binds, on PostgreSQL 19 plan no statement of a unit's replace or delete or of its ledger's rewrite with a sequential scan of a relation it modifies.
 */
export const aWriteStatementReadsTheRelationsItWritesOnlyThroughAKeyItBindsOnPostgreSQL19PlanNoStatementOfAUnitsReplaceOrDeleteOrOfItsLedgersRewriteWithASequentialScanOfARelationItModifies =
	property.exhaust(finite(sketchGen), {
		needs: { fixture: Substrate.seat(worldTemplate) },
		situations: FEATURES satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(s) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const substrate = yield* Substrate
								const o = yield* openedIn(World, {}, worldInstall, taken)
								const seat = yield* seatOfInstalled(o.installed, RELATIONS, "keyed_target")
								const login = quoteIdent(o.installed.as(o.server).role)
								for (const setting of judgedSettings) {
									yield* substrate.superuser(
										`ALTER ROLE ${login} IN DATABASE ${quoteIdent(substrate.database)} SET ${setting.parameter} = ${setting.value}`
									)
								}
								yield* unanalyzed(
									substrate.admin,
									Arr.map(RELATIONS, (r) => o.installed.names.relation(r))
								)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									/** The instance of `s` over emptied tables. */
									const loaded = (s: Sketch) =>
										Effect.gen(function* () {
											yield* cleared(seat, RELATIONS)
											const units = stored(s)
											yield* db.workload.load.once({
												params: {},
												facts: {
													insert: {
														...unitFacts(units),
														Pub: Arr.flatMap(units, (u) =>
															Arr.map(
																upTo(u.size, (j) => j),
																(j) => ({ pkg: u.key, item: BigInt(j) })
															)
														)
													}
												}
											})
										})
									const plansOf = (s: Sketch) => {
										const unit = Arr.filter(stored(s), (u) => u.key === BigInt(s.at))
										const added = unitFacts(
											s.fate === "deleted"
												? []
												: s.fate === "replaced unchanged"
													? unit
													: Arr.map(unit, (u) => ({ ...u, label: u.label + 1n, size: u.size + 1 }))
										)
										const at = BigInt(s.at)
										switch (s.program) {
											case "replace":
												return db.workload.replace.explain({
													params: {},
													facts: {
														delete: {
															Node: [{ doc: at }],
															Shelf: Arr.map(unit, (u) => ({ id: u.key, note: u.label })),
															Test: Arr.map(unit, (u) => ({ t: u.key, note: u.label })),
															Asm: Arr.map(unit, (u) => ({ a: u.key, note: u.label }))
														},
														insert: added
													}
												})
											case "replace by query":
												return db.workload.replaceByQuery.explain({
													params: { doc: at, shelf: at, test: at, asm: at },
													facts: { insert: added }
												})
											case "prune":
												return db.workload.prune.explain({
													params: { pkg: at, kept: [{ item: 0n }] },
													facts: {}
												})
											case "republish":
												return db.workload.republish.explain({
													params: { pkg: at },
													facts: { insert: { Pub: [{ pkg: at, item: 0n }] } }
												})
											case "lead":
												return db.workload.lead.explain({
													params: {},
													facts: { insert: { Lead: [{ id: at, pkg: at, leads: true }] } }
												})
										}
									}

									yield* loaded(s)
									const plans = yield* plansOf(s)
									const scans = Arr.flatMap(plans, (p) =>
										Arr.map(
											seqScans(p.plan, new Set(modified(p.plan))),
											(relation) => `${p.statement}: ${relation}`
										)
									)
									if (scans.length > 0) {
										return yield* new Disagreed({
											message: `${featureOf(s)} reads a relation it writes by a sequential scan: ${Arr.join(scans, "; ")}: ${Formatter.format(s)}`
										})
									}
									c.note(featureOf(s))
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "EXPLAIN of each statement the member sends, sequential, index and index-only scans disabled over unanalyzed relations: no sequential scan of a relation the statement modifies"
		},
		box: "one or two units of each kind, each of one or two nodes, books, tags, instances and ledger items, and a call at one of them: its units deleted, replaced unchanged or replaced changed, named by facts or by a query, or its ledger pruned or republished, or a lead inserted",
		kept: [],
		kills: []
	})
