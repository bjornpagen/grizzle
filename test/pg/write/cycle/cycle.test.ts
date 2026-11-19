import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { Db } from "#adapter/public/db.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	A,
	B,
	caseGen,
	Cycle,
	type CycleFeature,
	dangling,
	type Fact,
	intoA,
	intoB,
	minus,
	cycleInstall,
	cycleTemplate
} from "#test/pg/write/cycle/cycle.fixtures.ts"
import { assert, deepEquals, unorderedEqual } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Plain foreign keys on a cycle commit a ChangeSet whose final state meets every reference, and refuse one that breaks one at COMMIT.
 *
 * Its pre-conversion budget: runs 80, coverage cases 80 (test/pg/write/cycle/cycle.test.ts at 991e0f9ab).
 */
export const plainForeignKeysOnACycleCommitAChangeSetWhoseFinalStateMeetsEveryReferenceAndRefuseOneThatBreaksOneAtCOMMIT =
	property.explore(caseGen, {
		needs: { fixture: Substrate.seat(cycleTemplate) },
		situations: [
			"accepted",
			"unchanged",
			"a cycle inserted in one ChangeSet",
			"refused by A's reference",
			"refused by B's reference",
			"a deletion of a fact still named, refused"
		] satisfies ReadonlyArray<Reached<CycleFeature>>,
		check:
			({ fixture }, c: Case<CycleFeature>) =>
			([stored, requested]) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Cycle, {}, cycleInstall, taken)
								const s = yield* Substrate
								const names = namesOf(o.installed)
								const laws = {
									a: names.described(names.lawOf(intoB)),
									b: names.described(names.lawOf(intoA))
								}
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})

									const insert = (table: string, columns: string, f: Fact) => ({
										sql: `INSERT INTO ${table} (${columns}) VALUES ($1::int4, $2::int4)`,
										params: [String(f.id), String(f.ref)]
									})
									yield* replaceRows(s.admin, installationGroup(names), [
										...Arr.map(stored.a, (f) =>
											insert(names.table(A), `${names.column(A, "id")}, ${names.column(A, "b")}`, f)
										),
										...Arr.map(stored.b, (f) =>
											insert(names.table(B), `${names.column(B, "id")}, ${names.column(B, "a")}`, f)
										)
									])
									const outcome = yield* answered(
										db.workload.change.once({
											params: {},
											facts: {
												insert: {
													A: Arr.map(requested.insertA, (f) => ({ id: f.id, b: f.ref })),
													B: Arr.map(requested.insertB, (f) => ({ id: f.id, a: f.ref }))
												},
												delete: {
													A: Arr.map(requested.deleteA, (f) => ({ id: f.id, b: f.ref })),
													B: Arr.map(requested.deleteB, (f) => ({ id: f.id, a: f.ref }))
												}
											}
										})
									)
									const finalA = [...minus(stored.a, requested.deleteA), ...requested.insertA]
									const finalB = [...minus(stored.b, requested.deleteB), ...requested.insertB]
									const brokenA = dangling(finalA, finalB)
									const brokenB = dangling(finalB, finalA)
									const stateA = yield* tableState(o.installed, A)
									const stateB = yield* tableState(o.installed, B)
									if (brokenA || brokenB) {
										if (outcome.kind !== "refused") {
											return assert.fail(`a refusal by a reference, not ${outcome.kind}`)
										}
										assert.ok(
											refusedLaws(outcome.refused).length > 0 &&
												Arr.every(
													refusedLaws(outcome.refused),
													(law) =>
														(brokenA && deepEquals(law, laws.a)) ||
														(brokenB && deepEquals(law, laws.b))
												),
											"the refusal names a law of a reference the final state breaks"
										)
										c.noteAll([
											...(brokenA ? (["refused by A's reference"] as const) : []),
											...(brokenB ? (["refused by B's reference"] as const) : [])
										])
										if (
											Arr.some(requested.deleteA, (d) => Arr.some(finalB, (f) => f.ref === d.id)) ||
											Arr.some(requested.deleteB, (d) => Arr.some(finalA, (f) => f.ref === d.id))
										) {
											c.note("a deletion of a fact still named, refused")
										}
										unorderedEqual(
											stateA,
											Arr.map(stored.a, (f) => ({ id: f.id, b: f.ref }))
										)
										unorderedEqual(
											stateB,
											Arr.map(stored.b, (f) => ({ id: f.id, a: f.ref }))
										)
										return
									}
									unorderedEqual(
										stateA,
										Arr.map(finalA, (f) => ({ id: f.id, b: f.ref }))
									)
									unorderedEqual(
										stateB,
										Arr.map(finalB, (f) => ({ id: f.id, a: f.ref }))
									)
									const changed =
										requested.insertA.length +
										requested.insertB.length +
										requested.deleteA.length +
										requested.deleteB.length
									if (changed === 0) {
										assert.equal(outcome.kind, "unchanged")
										c.note("unchanged")
										return
									}
									if (outcome.kind !== "accepted") {
										return assert.fail(`accepted, not ${outcome.kind}`)
									}
									c.note("accepted")
									if (
										Arr.some(requested.insertA, (f) =>
											Arr.some(requested.insertB, (g) => g.id === f.ref && g.ref === f.id)
										)
									) {
										c.note("a cycle inserted in one ChangeSet")
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: { kind: "specification", name: "a host model of containment at COMMIT" },
		budget: { runs: 80, steered: 80 },
		kept: [],
		kills: []
	})
