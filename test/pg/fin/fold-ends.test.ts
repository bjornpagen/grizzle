import { assert, deepEquals, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	applied,
	brokenBy,
	caseGen,
	formsTouched,
	groupOf,
	judgedCaseGen,
	judgedFacts,
	JudgedMember,
	judgedMemberRows,
	JudgedOwner,
	judgedOwnerRow,
	type JudgedOwnerState,
	judgedSchema,
	type JudgedSituation,
	judgedSituationOf,
	judgedSituations,
	judgeOwner,
	judgeRefused,
	reaches,
	refusedBy,
	rowsAfter,
	schemas,
	servedOf,
	type Situation,
	situations,
	slotsOf,
	storedRelations,
	treesRows,
	endsTemplates,
	judgedTemplate
} from "#test/pg/fin/fold-ends.fixtures.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import {
	brokenOf,
	cellLabel,
	emptyState,
	type ModelRow,
	storedRows,
	treeRows
} from "#test/support/families/ends.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Every fold's end through grizzle's apply on PostgreSQL 19 stores exactly the README's fold of every member's step, every end and running value, after every write of every family kind.
 *
 * Its pre-conversion budget: runs 16, coverage cases 320 (test/pg/fin/fold-ends.test.ts at d8eed1786).
 */
export const everyFoldsEndThroughGrizzlesApplyOnPostgreSQL19StoresExactlyTheREADMEsFoldOfEveryMembersStepEveryEndAndRunningValueAfterEveryWriteOfEveryFamilyKind =
	property.explore(caseGen, {
		needs: Substrate.oneOf(endsTemplates, Substrate.seat),
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check: (seats, c: Case<Situation>) => (sketch) =>
			Effect.scoped(
				Effect.flatMap(seats[sketch.kind], (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = schemas[sketch.kind]
							const done = taken.value
							const value = s.value(done.schema)
							const world = fullWorld(value, {})
							const db = yield* openServedDb(done, world.server.roles.app, {})
							const o = { kind: sketch.kind, s, done, value, db } as const
							let state = emptyState
							for (const w of sketch.writes) {
								const served = servedOf(o.value, slotsOf(o.s, w))
								const members = yield* o.db.serve({ write: served.changes })
								const outcome = yield* writeAnswerOf(
									writeOnce(member(members, "write"))({ params: {}, facts: served.facts })
								)
								const broken = brokenOf(o.s, rowsAfter(o.s, state, w))
								if (Arr.isReadonlyArrayNonEmpty(broken)) {
									const named = judgeRefused(o.s, w, broken, outcome)
									const kept = w.kind === "trees" ? treesRows(o.s, []) : storedRows(o.s, state)
									for (const r of storedRelations(o.s)) {
										const stored = yield* tableState(o.done, r)
										unorderedEqual<ModelRow>(
											stored,
											kept.get(r.name) ?? [],
											`${r.name}'s rows after a refused ${Formatter.format(w)}`
										)
									}
									for (const b of named) {
										c.note(`${cellLabel(b.cell)} in a ${sketch.kind} family, ${refusedBy(b)}`)
									}
									continue
								}
								const next = applied(o.s, state, w)
								assert.equal(
									outcome.kind,
									deepEquals(next, state) && w.kind !== "trees" ? "unchanged" : "accepted",
									`the write ${Formatter.format(w)}`
								)
								state = next
								if (sketch.kind === "tree" && w.kind === "trees") {
									for (const g of o.s.groups) {
										const stored = yield* tableState(o.done, g.member)
										unorderedEqual<ModelRow>(
											stored,
											treeRows(
												g,
												Arr.map(
													Arr.filter(w.trees, (t) => t.monoid === g.monoid),
													(t) => t.root
												)
											),
											`${g.member.name}'s rows`
										)
									}
								} else {
									const expected = storedRows(o.s, state)
									for (const r of storedRelations(o.s)) {
										const stored = yield* tableState(o.done, r)
										unorderedEqual<ModelRow>(
											stored,
											expected.get(r.name) ?? [],
											`${r.name}'s rows after ${Formatter.format(w)}`
										)
									}
								}
								for (const [monoid, form] of formsTouched(o.s, w)) {
									for (const cell of Arr.filter(groupOf(o.s, monoid).cells, (cell) =>
										reaches(cell, form)
									)) {
										c.note(`${cellLabel(cell)} in a ${sketch.kind} family, ${form}`)
									}
								}
							}
						}),
						Substrate,
						taken.substrate
					)
				)
			),
		oracle: {
			kind: "specification",
			name: "the README's fold of each family's members (test/support/families/ends.ts)"
		},
		budget: { runs: 16, steered: 320 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/fin/fold-ends.test.ts#everyFoldsEndThroughGrizzlesApplyOnPostgreSQL19StoresExactlyTheREADMEsFoldOfEveryMembersStepEveryEndAndRunningValueAfterEveryWriteOfEveryFamilyKind:-:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.1.1.1.1.1.1.1.1.1.0.2.2.2.2.2.2.2.2.0.0"
				),
				reason:
					"a counted Monoid.or's end, its owner and members inserted separately, was written as its identity",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/fin/fold-ends.test.ts#everyFoldsEndThroughGrizzlesApplyOnPostgreSQL19StoresExactlyTheREADMEsFoldOfEveryMembersStepEveryEndAndRunningValueAfterEveryWriteOfEveryFamilyKind:-:1.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.2.1.0.1.0.1.1.1.1.1.0.0.0.0.0.0.0.1.1.2.1.2.0.0.0.0.0.0.0.1.1.0.1.0.1"
				),
				reason:
					"an ordered concat of generated byte-bounded pieces into another pattern, accepted and refused",
				since: "2026-11-19"
			}
		],
		kills: []
	})

/**
 * Every fold's end through grizzle's apply on PostgreSQL 19 judges an owner's row CHECKs over the Monoid.or and Monoid.sum ends the host fills from the counted members one ChangeSet inserts it with.
 *
 * Its pre-conversion budget: runs 16, coverage cases 64 (test/pg/fin/fold-ends.test.ts at d8eed1786).
 */
export const everyFoldsEndThroughGrizzlesApplyOnPostgreSQL19JudgesAnOwnersRowCHECKsOverTheMonoidOrAndMonoidSumEndsTheHostFillsFromTheCountedMembersOneChangeSetInsertsItWith =
	property.explore(judgedCaseGen, {
		needs: { judged: Substrate.seat(judgedTemplate) },
		situations: judgedSituations satisfies ReadonlyArray<Reached<JudgedSituation>>,
		check:
			({ judged }, c: Case<JudgedSituation>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(judged, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const done = taken.value
								const value = judgedSchema(done.schema)
								const db = yield* openServedDb(done, fullWorld(value, {}).server.roles.app, {})
								const served = yield* db.serve({
									write: ChangeSet.empty(value).insert(JudgedOwner, []).insert(JudgedMember, [])
								})
								const write = member(served, "write")

								const stored: Array<JudgedOwnerState> = []
								for (const o of sketch) {
									const outcome = yield* writeAnswerOf(
										writeOnce(write)({ params: {}, facts: judgedFacts(o) })
									)
									judgeOwner(o, outcome)
									if (!Arr.isReadonlyArrayNonEmpty(brokenBy(o))) {
										stored.push(o)
									}
									const owners = yield* tableState(done, JudgedOwner)
									unorderedEqual<ModelRow>(
										owners,
										Arr.map(stored, judgedOwnerRow),
										`the owners after ${Formatter.format(o)}`
									)
									const members = yield* tableState(done, JudgedMember)
									unorderedEqual<ModelRow>(
										members,
										Arr.flatMap(stored, judgedMemberRows),
										`the members after ${Formatter.format(o)}`
									)
									c.note(judgedSituationOf(o))
								}
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the README's fold of a counted family's members into its owner's or-end and sum-end, each held to its declared value by the owner's row CHECK"
		},
		budget: { runs: 16, steered: 64 },
		kept: [],
		kills: []
	})
