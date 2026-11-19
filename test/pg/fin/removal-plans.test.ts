import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import {
	Disagreed,
	type Feature,
	memberOf,
	readByIndex,
	RELATIONS,
	Removals,
	seqScans,
	SHAPES,
	type Sketch,
	sketchGen,
	removalsInstall,
	removalsTemplate
} from "#test/pg/fin/removal-plans.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { judgedSettings, unanalyzed } from "#test/support/plans.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A family write's removals read their stored tables by index on PostgreSQL 19rc2 plan every keyset arm, the keyset's join and the write with no sequential scan of a family table, at every drawn size.
 */
export const aFamilyWritesRemovalsReadTheirStoredTablesByIndexOnPostgreSQL19rc2PlanEveryKeysetArmTheKeysetsJoinAndTheWriteWithNoSequentialScanOfAFamilyTableAtEveryDrawnSize =
	property.exhaust(finite(sketchGen), {
		needs: { fixture: Substrate.seat(removalsTemplate) },
		situations: Arr.map(SHAPES, readByIndex) satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(s) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const substrate = yield* Substrate
								const o = yield* openedIn(Removals, {}, removalsInstall, taken)
								const seat = yield* seatOfInstalled(o.installed, RELATIONS, "removal_plans")
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
									/** The instance of `s` over emptied tables: its owners of each kind, each with its members of each family. */
									const loaded = (s: Sketch) =>
										Effect.gen(function* () {
											yield* cleared(seat, RELATIONS)
											const owners = upTo(s.owners, (id) => id)
											const indexes = upTo(s.members, (i) => i)
											yield* db.workload.loadOwners.once({
												params: {},
												facts: {
													insert: {
														Owner: Arr.map(owners, (id) => ({ id, v: 1 })),
														Other: Arr.map(owners, (id) => ({ id, w: 1 })),
														Order: Arr.map(owners, (id) => ({
															id,
															n: Arr.map(indexes, (i) => ({ line: id * s.members + i }))
														}))
													}
												}
											})
											yield* db.workload.loadMembers.once({
												params: {},
												facts: {
													insert: {
														Member: Arr.flatMap(owners, (id) =>
															Arr.map(indexes, (i) => memberOf(s, id, i))
														),
														Second: Arr.flatMap(owners, (id) =>
															Arr.map(indexes, (i) => ({ member: id * s.members + i, g: id }))
														)
													}
												}
											})
										})
									const plansOf = (s: Sketch) => {
										const next = (s.at + 1) % s.owners
										switch (s.shape) {
											case "removed":
												return db.workload.removeAndMove.explain({
													params: {},
													facts: {
														delete: { Member: [memberOf(s, s.at, 0)] },
														put: { Member: [{ ...memberOf(s, s.at, 1), g: next }] }
													}
												})
											case "two ways":
												return db.workload.twoWays.explain({
													params: {},
													facts: {
														put: { Owner: [{ id: s.at, v: 2 }], Other: [{ id: next, w: 2 }] }
													}
												})
											case "edited and refilled":
												return db.workload.editAndRefill.explain({
													params: {},
													facts: {
														put: { Owner: [{ id: s.at, v: 2 }] },
														delete: { Member: [memberOf(s, next, 0)] }
													}
												})
											case "re-placed":
												return db.workload.deleteLine.explain({
													params: {},
													facts: { delete: { Line: [{ line: s.at * s.members, order: s.at }] } }
												})
											case "recounted":
												return db.workload.twoFamilies.explain({
													params: {},
													facts: {
														delete: {
															Member: [memberOf(s, s.at, 0)],
															Second: [{ member: s.at * s.members + 1, g: s.at }]
														}
													}
												})
										}
									}

									yield* loaded(s)
									const plans = yield* plansOf(s)
									const scans = Arr.flatMap(plans, (p) =>
										Arr.map(seqScans(p.plan), (relation) => `${p.statement}: ${relation}`)
									)
									if (scans.length > 0) {
										return yield* new Disagreed({
											message: `${s.shape} reads by a sequential scan: ${Arr.join(scans, "; ")}: ${Formatter.format(s)}`
										})
									}
									c.note(readByIndex(s.shape))
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "EXPLAIN of each statement the member sends, sequential, index and index-only scans disabled over unanalyzed relations: no sequential scan of a family table"
		},
		box: "each of the five shapes where the removals statement's arms meet, over two to four owners of each kind with two or three members of each family, at every owner",
		kept: [],
		kills: []
	})
