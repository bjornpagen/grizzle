import { assert, containsEqual, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { KeyHost } from "#compiler/types/changeset/changeset.ts"
import {
	expected,
	CountedMember,
	membersOf,
	Owner,
	ownerCaseGen,
	type OwnerFeature,
	ownerRow,
	Owners,
	requestedOf,
	situations,
	storedOf,
	unique,
	ownersInstall,
	ownersTemplate
} from "#test/pg/write/owner-key/owner-key.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Inserts into a family owner's primary key agree with the key's model on drawn stored owners and requested ones, an exact repeat changing nothing and a stored conflict refused by the key law.
 *
 * Its pre-conversion budget: runs 80, coverage cases 80 (test/pg/write/owner-key/owner-key.test.ts at 991e0f9ab).
 */
export const insertsIntoAFamilyOwnersPrimaryKeyAgreeWithTheKeysModelOnDrawnStoredOwnersAndRequestedOnesAnExactRepeatChangingNothingAndAStoredConflictRefusedByTheKeyLaw =
	property.explore(ownerCaseGen, {
		needs: { fixture: Substrate.fresh(ownersTemplate) },
		situations: situations satisfies ReadonlyArray<Reached<OwnerFeature>>,
		check:
			({ fixture }, cx: Case<OwnerFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Owners, {}, ownersInstall, taken)
								const names = namesOf(o.installed)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})

									const stored = storedOf(c.stored)
									const requested = unique(Arr.map(c.requested, (r) => requestedOf(stored, r)))
									const members = membersOf(stored)
									if (stored.length > 0) {
										const loaded = yield* writeAnswerOf(
											db.workload.load.once({
												params: {},
												facts: {
													insert: {
														Owner: Arr.map(stored, (owner) => ({ id: owner.id, cap: owner.cap })),
														Member: members
													}
												}
											})
										)
										assert.equal(loaded.kind, "accepted", "the stored state loads")
									}
									const facts = Arr.map(requested, (f) => ({ id: f.id, cap: f.cap }))
									const outcome =
										c.form === "enumerated"
											? yield* writeAnswerOf(
													db.workload.insertEnumerated.once({
														params: {},
														facts: { insert: { Owner: facts } }
													})
												)
											: yield* writeAnswerOf(
													db.workload.insertDescribed.once({
														params: { items: facts },
														facts: {}
													})
												)
									const want = expected(c.form, stored, requested)
									cx.note(`insert ${c.form}`)
									const storedMembers = yield* tableState(o.installed, CountedMember)
									unorderedEqual(
										storedMembers,
										members,
										"no insert of an owner touches a stored member"
									)
									const owners = yield* tableState(o.installed, Owner)
									if (want.kind === "refused") {
										if (outcome.kind !== "refused") {
											return assert.fail(`a refusal by the owner's key law, not ${outcome.kind}`)
										}
										assert.deepEqual(refusedLaws(outcome.refused), [
											names.described(names.primaryKeyLaw(Owner))
										])
										const witness = outcome.witness
										if (witness.kind !== "key") {
											return assert.fail(`a witness key, not ${witness.kind}`)
										}
										assert.equal(witness.relation, "Owner")
										containsEqual(
											Arr.map(want.witnesses, (id): Readonly<Record<string, KeyHost>> => ({
												id
											})),
											witness.values,
											"the witness is a key the model refuses"
										)
										unorderedEqual(owners, Arr.map(stored, ownerRow), "a refusal writes nothing")
										if (want.within) {
											cx.note("two requested owners at one key refused by the key law")
											return
										}
										cx.note("a stored owner at the other payload refused by the key law")
										if (
											Arr.some(stored, (owner) =>
												Arr.some(
													requested,
													(f) =>
														f.id === owner.id && f.cap !== owner.cap && owner.members.length > 0
												)
											)
										) {
											cx.note("a stored owner with members at the other payload refused")
										}
										return
									}
									unorderedEqual(
										owners,
										[
											...Arr.map(stored, ownerRow),
											...Arr.map(want.added, (f) => ownerRow({ ...f, members: [] }))
										],
										"the stored owners and each requested one at a key no row held"
									)
									const repeats = Arr.filter(stored, (owner) =>
										Arr.some(requested, (f) => f.id === owner.id)
									)
									if (repeats.length > 0) {
										cx.note("a stored owner's exact repeat changed nothing")
									}
									if (Arr.some(repeats, (owner) => owner.members.length > 0)) {
										cx.note("a stored owner with members repeated exactly")
									}
									if (want.added.length === 0) {
										assert.equal(outcome.kind, "unchanged")
										return
									}
									if (outcome.kind !== "accepted") {
										return assert.fail(`accepted, not ${outcome.kind}`)
									}
									assert.deepEqual(
										Arr.map(outcome.counts, (n) => ({ ...n })),
										[
											{
												relation: "Owner",
												added: BigInt(want.added.length),
												deleted: 0n,
												put: 0n
											}
										]
									)
									cx.note("a fresh owner added")
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "a host model of the owner's key over the stored and requested owners"
		},
		budget: { runs: 80, steered: 80 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/owner-key/owner-key.test.ts#insertsIntoAFamilyOwnersPrimaryKeyAgreeWithTheKeysModelOnDrawnStoredOwnersAndRequestedOnesAnExactRepeatChangingNothingAndAStoredConflictRefusedByTheKeyLaw:-:0.1.0.1.0.1.0.0.0"
				),
				reason:
					"a8b31081: an owner inserted beside its counted member carries the member's count and end, which its check over the end judges at the insert",
				since: "2026-11-19"
			}
		],
		kills: []
	})
