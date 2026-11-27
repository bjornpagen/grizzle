import { assert, deepEquals, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	aims,
	Attr,
	attrRowOf,
	type Broken,
	caseGen,
	countedSetTemplate,
	declaredSchema,
	family,
	Owner,
	ownerFact,
	ownerRowsOf,
	type Situation,
	situations,
	situationsOf,
	type State,
	verdictOf
} from "#test/pg/fin/counted-set.fixtures.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { applicationOf, member, openServedDb } from "#test/support/served-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Its search budget: the fewest cases a run spends at which every kill it declares is killed and every situation it
 * requires reached. A kill's trial runs the witnesses alone, its kept cases, its floor stream of ⌈runs / 4⌉ cases and its
 * steered phase while a situation is unreached, all fixed by the property's identity and its floor, so runs within one
 * floor draw the same witnesses, and a run adds `runs` rotating cases.
 *
 * @limitKind measured
 * @owner grizzle's test/pg/fin/counted-set.test.ts
 * @unit independent cases (runs) and steered cases
 * @scope one run of aCountedSetKeyedByThreeFieldsAndANameStoresEachOwnersCountAndFoldsOfExactlyTheModelsMembersAfterEveryInsertDeleteMoveAndRefill
 * @evidence `~/.cache/grizzle/CULL-FIN-tools/measure.sh r<runs> <runs> 200 <files>` over test/pg/fin's counted,
 *   lemmas, fold, plans and counted-set at runs 1, 4, 8, 16 and 32, the steered cases capped at 200, each a
 *   `toolchain-test run` of the files that ran the kills of every property it passed; uncommitted logs
 *   ~/.cache/grizzle/CULL-FIN-tools/measure-r{1,4,8,16,32}.log
 * @observed 2026-11-23 03:50 to 04:26 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load 200 to 520 from other lanes;
 *   PostgreSQL 19.0 (scripts/pg/pin.env) as the lane's in-memory family; Node 26.13.1; grizzle f87b2aaab with lane
 *   CULL-FIN's cull of test/pg/fin; TEST_SEED=2219874524
 * @workload the property with its kill, a family's insert through no probe gate (283f02952)
 * @result steered cases to reach every required situation: 16 at every floor measured, one to eight cases (runs 1 to
 *   32); the kill killed at every budget, no failure
 * @decision a floor of one case spends the fewest, 18 cases a run and its kept case at runs 1, against 23 at runs 5, 33 at
 *   13 and 53 at 29; the steered cap the 16 it needs. It ran 46 cases at runs 24, steered 96
 * @revalidate a change of the property, its space, its situations or the code its cases run, which moves its witnesses;
 *   a red that reaches no situation (FeaturesUnreached) or a kill that survives
 */
const countedSetBudget = { runs: 1, steered: 16 } as const

/**
 * A counted set keyed by three fields and a name stores each owner's count and folds of exactly the model's members after every insert, delete, move and refill.

 */
export const aCountedSetKeyedByThreeFieldsAndANameStoresEachOwnersCountAndFoldsOfExactlyTheModelsMembersAfterEveryInsertDeleteMoveAndRefill =
	property.explore(aimed(caseGen, aims), {
		needs: { counted: Substrate.fresh(countedSetTemplate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ counted }, c: Case<Situation>) =>
			(writes) =>
				Effect.flatMap(counted, ({ substrate: s, value: done }) =>
					Effect.provideService(
						Effect.gen(function* () {
							const value = declaredSchema(done.installed.schema)
							const world = fullWorld(value, {})
							const names = namesOf(done.installed)
							const lawNames = lawNamesOf(value)
							const lawOf: { readonly [B in Broken]: LawId } = {
								"the owner's key": lawNames.primaryKeyLaw({ name: Owner.name }),
								"the member's key": lawNames.primaryKeyLaw({ name: Attr.name }),
								"the family": lawNames.lawOf(family)
							}
							const db = yield* openServedDb(done.installed, world.server.roles.app, {})
							const loaded = yield* db.load({
								insert: ChangeSet.empty(value).insert(Owner, []).insert(Attr, []),
								delete: ChangeSet.empty(value).delete(Attr, []),
								move: ChangeSet.empty(value).delete(Attr, []).insert(Attr, []),
								restep: ChangeSet.empty(value).put(Attr, []),
								relabel: ChangeSet.empty(value).put(Owner, [])
							})

							let state: State = { owners: [], attrs: [] }
							for (const [i, w] of writes.entries()) {
								const label = `write ${String(i)} ${Formatter.format(w)}`
								const verdict = verdictOf(state, w)
								const facts = (() => {
									switch (w.kind) {
										case "insert":
											return {
												insert: {
													Owner: Arr.map(w.owners, ownerFact),
													Attr: Arr.map(w.attrs, attrRowOf)
												}
											}
										case "delete":
											return { delete: { Attr: Arr.map(w.attrs, attrRowOf) } }
										case "move":
											return {
												delete: { Attr: [attrRowOf(w.from)] },
												insert: { Attr: [attrRowOf(w.to)] }
											}
										case "restep":
											return { put: { Attr: Arr.map(w.attrs, attrRowOf) } }
										case "relabel":
											return { put: { Owner: Arr.map(w.owners, ownerFact) } }
									}
								})()
								const outcome: ApplyOutcome<unknown> = yield* applicationOf(
									db.ctx,
									member(loaded, w.kind)
								)({ params: {}, facts })
								if (verdict.kind === "refused") {
									if (outcome.kind !== "invariant-rejected") {
										return assert.fail(
											`${label}: it breaks ${Formatter.format([...verdict.broken])}, so it is invariant-rejected, not ${outcome.kind}`
										)
									}
									const allowed = new Set(Arr.map([...verdict.broken], (b) => lawOf[b]))
									const named = Arr.map(refusedEntries(outcome.refused), names.reported)
									switch (outcome.refused.kind) {
										case "every":
											for (const law of named) {
												assert.ok(
													allowed.has(law),
													`${label}: it names ${law}, which it does not break`
												)
											}
											break
										case "some":
											assert.ok(
												Arr.some(named, (law) => allowed.has(law)),
												`${label}: of ${Formatter.format(named)} it names none it breaks`
											)
											break
										case "first":
										case "above":
											return assert.fail(
												`${label}: a key's or a family's refusal is decided, not ${outcome.refused.kind}`
											)
									}
									const keyNamed = Arr.filter(verdict.keyed, (x) => named.includes(lawOf[x.broken]))
									const witness = outcome.witness
									if (Arr.isReadonlyArrayNonEmpty(keyNamed)) {
										if (witness.kind !== "key") {
											return assert.fail(
												`${label}: a key its stated rows break reports no witness: ${Formatter.format(outcome)}, the rows ${Formatter.format(keyNamed)}`
											)
										}
										assert.ok(
											Arr.some(keyNamed, (x) => {
												const keyFields =
													x.broken === "the owner's key" ? ["a", "b", "k"] : ["a", "b", "k", "name"]
												const row: Readonly<Record<string, unknown>> = { ...x.row }
												return (
													witness.relation ===
														(x.broken === "the owner's key" ? "Owner" : "Attr") &&
													deepEquals<unknown>(
														witness.values,
														Rec.fromEntries(Arr.map(keyFields, (f) => [f, row[f]] as const))
													)
												)
											}),
											`${label}: the witness ${Formatter.format(witness)} is the key of a stated row that breaks it`
										)
									} else {
										assert.equal(
											witness.kind,
											"unreported",
											`${label}: a family's refusal names no row`
										)
									}
								} else {
									assert.equal(outcome.kind, verdict.changed ? "accepted" : "no-change", label)
								}
								c.noteAll(situationsOf(state, w, verdict))
								state = verdict.kind === "written" ? verdict.next : state
								const owners = yield* tableState(done.installed, Owner)
								unorderedEqual<Readonly<Record<string, unknown>>>(
									owners,
									ownerRowsOf(state),
									`the owners after ${label}`
								)
								const attrs = yield* tableState(done.installed, Attr)
								unorderedEqual<Readonly<Record<string, unknown>>>(
									attrs,
									Arr.map(state.attrs, attrRowOf),
									`the members after ${label}`
								)
							}
						}).pipe(Effect.scoped),
						Substrate,
						s
					)
				),
		oracle: {
			kind: "specification",
			name: "the reference fold of each owner's members (test/support/families/fold.ts foldStoredOf) over the README's set of members"
		},
		budget: countedSetBudget,
		kept: [
			{
				token: ReplayToken(
					"test/pg/fin/counted-set.test.ts#aCountedSetKeyedByThreeFieldsAndANameStoresEachOwnersCountAndFoldsOfExactlyTheModelsMembersAfterEveryInsertDeleteMoveAndRefill:-:0.0.0.0.0.0.0.0.0.1.1.1.0.1.0.0.0.2.0.0.0.2.1.0.1.0.0.0"
				),
				reason:
					"a counted member stated again at its stored key with other steps, refused on Attr's primary key with no witness before 283f02952 gated a family's inserts by the probe, the red this property met at its birth (913a3d3a9)",
				since: "2026-11-11"
			}
		],
		kills: [
			{
				file: "packages/engine/src/write/family/statements.ts",
				original: "\treturn { ctes: [...probe.ctes, guarded.cte], guards: [guarded.guard] }",
				replacement: "\treturn { ctes: [...probe.ctes, guarded.cte], guards: [] }",
				why: "A family's insert reads its candidates through no probe gate, as before 283f02952: a counted member stated again at its stored key is refused by PostgreSQL's 23505 on Attr's primary key with no witness (unreported), where the probe names the stated row's key, the red this property met at its birth (913a3d3a9)."
			}
		]
	})
