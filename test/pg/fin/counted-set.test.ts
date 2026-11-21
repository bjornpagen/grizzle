import { assert, deepEquals, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
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
 * A counted set keyed by three fields and a name stores each owner's count and folds of exactly the model's members after every insert, delete, move and refill.
 *
 * Its pre-conversion budget: runs 24, coverage cases 96 (test/pg/fin/counted-set.test.ts at d8eed1786).
 */
export const aCountedSetKeyedByThreeFieldsAndANameStoresEachOwnersCountAndFoldsOfExactlyTheModelsMembersAfterEveryInsertDeleteMoveAndRefill =
	property.explore(aimed(caseGen, aims), {
		needs: { counted: Substrate.seat(countedSetTemplate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ counted }, c: Case<Situation>) =>
			(writes) =>
				Effect.flatMap(counted, ({ substrate: s, value: done }) =>
					Effect.provideService(
						Effect.gen(function* () {
							const value = declaredSchema(done.schema)
							const world = fullWorld(value, {})
							const names = namesOf(done)
							const lawNames = lawNamesOf(value)
							const lawOf: { readonly [B in Broken]: LawId } = {
								"the owner's key": lawNames.primaryKeyLaw({ name: Owner.name }),
								"the member's key": lawNames.primaryKeyLaw({ name: Attr.name }),
								"the family": lawNames.lawOf(family)
							}
							const db = yield* openServedDb(done, world.server.roles.app, {})
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
										if (witness.kind === "unreported") {
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
								const owners = yield* tableState(done, Owner)
								unorderedEqual<Readonly<Record<string, unknown>>>(
									owners,
									ownerRowsOf(state),
									`the owners after ${label}`
								)
								const attrs = yield* tableState(done, Attr)
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
		budget: { runs: 24, steered: 96 },
		kept: [],
		kills: []
	})
