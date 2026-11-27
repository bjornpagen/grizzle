import { assert, deepEquals, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	applied,
	caseGen,
	formsTouched,
	groupOf,
	judgeRefused,
	reaches,
	refusedBy,
	rowsAfter,
	schemas,
	endsCompiles,
	type Situation,
	situations,
	slotsOf,
	storedRelations,
	treesRows,
	endsTemplates
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
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Every fold's end through grizzle's apply on PostgreSQL 19 stores exactly the README's fold of every member's step, every end and running value, after every write of every family kind.
 *
 * The runner's budget: its kept cases are real catches, the downstream's or-end written as its identity (fixed in
 * 1bf3dbb0a, in write/family/edit.ts's host planner, deleted since in 48c2c38e3) and its concat over generated pieces
 * (dca3d40b0, a feature, no fix), and PostgreSQL's summarized SSI conflict-out (5500c92e8) another, none of which a kill
 * plants again in today's code.
 */
export const everyFoldsEndThroughGrizzlesApplyOnPostgreSQL19StoresExactlyTheREADMEsFoldOfEveryMembersStepEveryEndAndRunningValueAfterEveryWriteOfEveryFamilyKind =
	property.explore(caseGen, {
		needs: { ...Substrate.oneOf(endsTemplates, Substrate.fresh), compiles: endsCompiles },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check: (ends, c: Case<Situation>) => (sketch) =>
			Effect.scoped(
				Effect.flatMap(ends[sketch.kind], (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = schemas[sketch.kind]
							const done = taken.value
							const value = s.value(done.installed.schema)
							const compiles = yield* ends.compiles
							const db = yield* compiles.db(
								done.installed,
								fullWorld(value, {}, []).server.roles.app
							)
							const o = { kind: sketch.kind, s, done, value, db } as const
							let state = emptyState
							for (const w of sketch.writes) {
								const served = yield* compiles.write(
									o.db,
									o.done.installed,
									o.value,
									slotsOf(o.s, w)
								)
								const outcome = yield* writeAnswerOf(
									writeOnce(served.calls)({ params: {}, facts: served.facts })
								)
								const broken = brokenOf(o.s, rowsAfter(o.s, state, w))
								if (Arr.isReadonlyArrayNonEmpty(broken)) {
									const named = judgeRefused(o.s, w, broken, outcome)
									const kept = w.kind === "trees" ? treesRows(o.s, []) : storedRows(o.s, state)
									for (const r of storedRelations(o.s)) {
										const stored = yield* tableState(o.done.installed, r)
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
										const stored = yield* tableState(o.done.installed, g.member)
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
										const stored = yield* tableState(o.done.installed, r)
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
