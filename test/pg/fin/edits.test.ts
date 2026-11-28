/**
 * A counted put through grizzle's own apply, on PostgreSQL 19 (rows-first §2, §3): an owner keyed by an id and a span
 * WITHOUT OVERLAPS is put in place, its row updated, never deleted and inserted again, which its members' foreign key
 * and its drawn count and fold end would refuse. Drawn span-keyed owners (test/support/families/generate.ts
 * `spanOwnersGen`), owners sharing an id over disjoint spans among them, are inserted with their counted members through
 * a served member, one is put with a new label, and PostgreSQL then holds every owner with its label, count and fold
 * end, and every member, exactly as the families model states them.
 *
 * - **A second implementation:** the families model of span-keyed owners and each family's sum of its step values.
 */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	SpanEdited,
	type SpanFeature,
	SpanMember,
	SpanOwner,
	spanSketchGen,
	spannedInstall,
	spannedTemplate
} from "#test/pg/fin/edits.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Counted put and delete through grizzle's apply on PostgreSQL 19 put a span-keyed owner in place, leaving every owner's label, count and fold end and every member as the families model states them.
 *
 * The runner's budget: its kept case is a real catch, a span-keyed owner's put in place refused SpanKeyChange before
 * 1bf388c9e, which no kill plants again: today's put reads a stored row that differs at its family's fields as a change,
 * not a refusal, so the comparison that fix narrowed, widened again, refuses nothing (it survived every budget tried).
 */
export const countedPutAndDeleteThroughGrizzlesApplyOnPostgreSQL19PutASpanKeyedOwnerInPlaceLeavingEveryOwnersLabelCountAndFoldEndAndEveryMemberAsTheFamiliesModelStatesThem =
	property.explore(spanSketchGen, {
		needs: { fixture: Substrate.fresh(spannedTemplate) },
		situations: [
			"a span-keyed owner put in place",
			"a span-keyed owner put in place over its family's members",
			"a span-keyed owner put in place beside an owner of its id over another span"
		] satisfies ReadonlyArray<Reached<SpanFeature>>,
		check:
			({ fixture }, c: Case<SpanFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(SpanEdited, {}, spannedInstall, taken)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const xOf = (member: number): number =>
										defined(sketch.xs[member], "a member's step value")
									const labelOf = (i: number): number =>
										defined(sketch.labels[i], "an owner's label")
									const members = Arr.flatMap(sketch.owners, (owner) =>
										Arr.map(owner.members, (member) => ({
											member,
											g: owner.id,
											gd: owner.during,
											x: xOf(member)
										}))
									)
									const owned = Arr.map(sketch.owners, (owner, i) => ({
										id: owner.id,
										during: owner.during,
										label: labelOf(i)
									}))
									const first = yield* writeAnswerOf(
										db.workload.insertOwners.once({
											params: {},
											facts: { insert: { SpanOwner: owned, SpanMember: members } }
										})
									)
									const target = defined(sketch.owners[sketch.put.at], "the put owner")
									const put = { id: target.id, during: target.during, label: sketch.put.label }
									const outcome = yield* writeAnswerOf(
										db.workload.putOwner.once({
											params: {},
											facts: { put: { SpanOwner: [put] } }
										})
									)
									const owners = yield* tableState(o.installed, SpanOwner)
									const stored = yield* tableState(o.installed, SpanMember)
									assert.equal(first._tag, "accepted", "the owners' and members' insert")
									assert.equal(outcome._tag, "accepted", "the owner's put")
									unorderedEqual(
										owners,
										Arr.map(sketch.owners, (owner, i) => ({
											id: owner.id,
											during: owner.during,
											label: i === sketch.put.at ? sketch.put.label : labelOf(i),
											n: BigInt(owner.members.length),
											end: Arr.reduce(owner.members, 0, (sum, member) => sum + xOf(member))
										})),
										"every owner, the put one with its new label"
									)
									unorderedEqual(stored, members, "every member, as it was inserted")
									c.note("a span-keyed owner put in place")
									if (Arr.isReadonlyArrayNonEmpty(target.members)) {
										c.note("a span-keyed owner put in place over its family's members")
									}
									if (
										Arr.some(
											sketch.owners,
											(owner, i) => i !== sketch.put.at && owner.id === target.id
										)
									) {
										c.note(
											"a span-keyed owner put in place beside an owner of its id over another span"
										)
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the families model of span-keyed owners (test/support/families/generate.ts spanOwnersGen) and each family's sum of its step values"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/fin/edits.test.ts#countedPutAndDeleteThroughGrizzlesApplyOnPostgreSQL19PutASpanKeyedOwnerInPlaceLeavingEveryOwnersLabelCountAndFoldEndAndEveryMemberAsTheFamiliesModelStatesThem:-:1.0.0.0.0.0.1.0.0.0.0.3.0"
				),
				reason:
					"an owner of one member put in place: its count and end, its member's, differ from the starts its put's slot carries them at, which no comparison of the put reads",
				since: "2026-11-19"
			}
		],
		kills: []
	})
