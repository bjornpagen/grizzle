/**
 * Counted put and delete through grizzle's own apply, on PostgreSQL 19 (rows-first §2, §3): a counted family's
 * members are rows, and grizzle draws every edit to them in SQL. A member put that changes its step value refills the
 * fold from its slot, and a member delete swaps the last member into the freed slot and refills from there, each one
 * suffix rewrite in the write's own statements.
 *
 * - **Two implementations agreeing:** the families model (test/support/families/counted.ts `stepPut`, `swapWithLast`)
 *   and the reference fold (fold.ts) state what each edit leaves, every slot and every hidden accumulator, and what
 *   PostgreSQL holds after the served member's apply must be exactly that.
 * - **PostgreSQL as the judge:** every state the apply leaves holds every installed native, or the apply could not have
 *   committed.
 *
 * The box (doctrine rule 9): owner 0 with every counted family of one to four members over the int4 sum seat's five
 * values (folds.ts), stored as the reference writes it by one transaction that replaces the seat's rows; each member's
 * delete, and each member's put to every other value.
 *
 * An owner keyed by an id and a span WITHOUT OVERLAPS is put in place: its row updated, never deleted and inserted
 * again, which its members' foreign key and its drawn count and fold end would refuse. Drawn span-keyed owners
 * (test/support/families/generate.ts `spanOwnersGen`), owners sharing an id over disjoint spans among them, are
 * inserted with their counted members through a served member, one is put with a new label, and PostgreSQL then holds
 * every owner with its label, count and fold end, and every member, exactly as the families model states them.
 */

import { assert, deepEquals, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	Edited,
	type EditFeature,
	m,
	sketchGen,
	SpanEdited,
	type SpanFeature,
	SpanMember,
	SpanOwner,
	spanSketchGen,
	SPEC,
	editedInstall,
	editedTemplate,
	spannedInstall,
	spannedTemplate
} from "#test/pg/fin/edits.fixtures.ts"
import {
	attemptedText,
	byMember,
	Disagreed,
	foldRead,
	foldSeatOf,
	foldStatementSql,
	foldWriteOf
} from "#test/pg/fin/folds.ts"
import { cleared, replaced, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { answered } from "#test/support/calls.ts"
import { stepPut, swapWithLast } from "#test/support/families/counted.ts"
import { foldStoredOf } from "#test/support/families/fold.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Counted put and delete through grizzle's apply on PostgreSQL 19 leave exactly the state the families model and the reference fold state after each member's put of a new step value and each member's delete.
 */
export const countedPutAndDeleteThroughGrizzlesApplyOnPostgreSQL19LeaveExactlyTheStateTheFamiliesModelAndTheReferenceFoldStateAfterEachMembersPutOfANewStepValueAndEachMembersDelete =
	property.exhaust(finite(sketchGen), {
		needs: { fixture: Substrate.seat(editedTemplate) },
		situations: [
			"delete of the last slot applied as the model states",
			"delete of a slot before the last applied as the model states",
			"put of the last slot applied as the model states",
			"put of a slot before the last applied as the model states",
			"a put of the first slot refilled every slot"
		] satisfies ReadonlyArray<Reached<EditFeature>>,
		check:
			({ fixture }, c: Case<EditFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Edited, {}, editedInstall, taken)
								const seat = yield* seatOfInstalled(o.installed, ["Owner", "Member"], "edits")
								const f = foldSeatOf(SPEC, seat)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})

									const members = Arr.map(sketch.values, (i, member) => ({
										member,
										x: Arr.getUnsafe(SPEC.domain, i),
										selected: true
									}))
									const before = foldStoredOf(m, [{ owner: 0, members }])
									const written = yield* replaced(
										seat,
										["Owner", "Member"],
										Arr.map(foldWriteOf(before), (s) => foldStatementSql(f, s))
									)
									if (written.kind !== "committed") {
										return yield* new Disagreed({
											message: `the reference state ${Formatter.format(before)} met ${attemptedText(written)}`
										})
									}
									const target = Arr.getUnsafe(members, sketch.edit.at)
									const fact = { member: target.member, g: 0, x: Number(target.x) }
									if (sketch.edit.kind === "delete") {
										yield* answered(
											db.workload.deleteMember.once({
												params: {},
												facts: { delete: { Member: [fact] } }
											})
										)
									} else {
										const put = { ...fact, x: Number(Arr.getUnsafe(SPEC.domain, sketch.edit.to)) }
										yield* answered(
											db.workload.putMember.once({
												params: {},
												facts: { put: { Member: [put] } }
											})
										)
									}
									const read = yield* foldRead(f)
									const after =
										sketch.edit.kind === "delete"
											? swapWithLast(m, before, 0, sketch.edit.at).after
											: stepPut(
													before,
													0,
													target.member,
													Arr.getUnsafe(SPEC.domain, sketch.edit.to)
												)
									const expected = foldStoredOf(m, after)
									if (!deepEquals(read, byMember(expected))) {
										return yield* new Disagreed({
											message: `${sketch.edit.kind} of slot ${sketch.edit.at} left ${Formatter.format(read)}, where the model states ${Formatter.format(byMember(expected))}, from ${Formatter.format(before)}`
										})
									}
									const position =
										sketch.edit.at === sketch.values.length - 1
											? "the last slot"
											: "a slot before the last"
									c.note(`${sketch.edit.kind} of ${position} applied as the model states`)
									if (
										sketch.edit.kind === "put" &&
										sketch.edit.at === 0 &&
										sketch.values.length > 1
									) {
										c.note("a put of the first slot refilled every slot")
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
			name: "the families model (test/support/families/counted.ts stepPut, swapWithLast) and the reference fold (fold.ts) of the families each edit leaves"
		},
		box: "owner 0 with every counted family of one to four members over five int4 values, each member deleted and each put to every other value",
		kept: [],
		kills: []
	})

/**
 * Counted put and delete through grizzle's apply on PostgreSQL 19 put a span-keyed owner in place, leaving every owner's label, count and fold end and every member as the families model states them.
 *
 * Its pre-conversion budget: runs 24, coverage cases 40 (test/pg/fin/edits.test.ts at fd71eef13).
 */
export const countedPutAndDeleteThroughGrizzlesApplyOnPostgreSQL19PutASpanKeyedOwnerInPlaceLeavingEveryOwnersLabelCountAndFoldEndAndEveryMemberAsTheFamiliesModelStatesThem =
	property.explore(spanSketchGen, {
		needs: { fixture: Substrate.seat(spannedTemplate) },
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
								const seat = yield* seatOfInstalled(
									o.installed,
									["SpanOwner", "SpanMember"],
									"span_edits"
								)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})

									yield* cleared(seat, ["SpanOwner", "SpanMember"])
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
									const first = yield* answered(
										db.workload.insertOwners.once({
											params: {},
											facts: { insert: { SpanOwner: owned, SpanMember: members } }
										})
									)
									const target = defined(sketch.owners[sketch.put.at], "the put owner")
									const put = { id: target.id, during: target.during, label: sketch.put.label }
									const outcome = yield* answered(
										db.workload.putOwner.once({
											params: {},
											facts: { put: { SpanOwner: [put] } }
										})
									)
									const owners = yield* tableState(o.installed, SpanOwner)
									const stored = yield* tableState(o.installed, SpanMember)
									assert.equal(first.kind, "accepted", "the owners' and members' insert")
									assert.equal(outcome.kind, "accepted", "the owner's put")
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
		budget: { runs: 24, steered: 40 },
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
