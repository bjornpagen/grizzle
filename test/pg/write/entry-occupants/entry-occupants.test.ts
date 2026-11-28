/**
 * A query entry's write meets every unique object of its target a stored fact at any unique object, inside the entry or outside it, is that object's law with the submitted key.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/write/entry-occupants/entry-occupants.test.ts at 8e0978628).
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { type LawId } from "#compiler/core/ids.ts"
import {
	seatsTemplate,
	codeKey,
	metIn,
	type ObjectName,
	occupantCases,
	type OccupantFeature,
	oneLead,
	oneSeat,
	row,
	same,
	Seat,
	seatsAt
} from "#test/pg/write/entry-occupants/entry-occupants.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { Substrate, ownerSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { tokenOf } from "#test/support/worlds.ts"
export const aQueryEntrysWriteMeetsEveryUniqueObjectOfItsTargetAStoredFactAtAnyUniqueObjectInsideTheEntryOrOutsideItIsThatObjectsLawWithTheSubmittedKey =
	property.explore(steered(occupantCases), {
		needs: { seats: Substrate.fresh(seatsTemplate) },
		situations: [
			"hidden occupant at the primary key",
			"hidden occupant at the candidate key",
			"hidden occupant at the at most one lead",
			"hidden occupant at the at most one seat",
			"inside occupant at the at most one lead",
			"inside occupant at the at most one seat",
			"an exact repeat",
			"accepted"
		] satisfies ReadonlyArray<Reached<OccupantFeature>>,
		check:
			({ seats }, cx: Case<OccupantFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(seats, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const m = taken.value
								const { desk } = seatsAt(m.declared)
								const s = yield* Substrate
								const owner = yield* s.session({ ...ownerSession(), label: "seats owner" })
								const names = namesOf(m)
								const lawOf: Readonly<Record<ObjectName, LawId>> = {
									"primary key": names.primaryKeyLaw(Seat),
									"candidate key": names.lawOf(codeKey),
									"at most one lead": names.lawOf(oneLead),
									"at most one seat": names.lawOf(oneSeat)
								}
								const table = names.table(Seat)
								const columns = Arr.join(
									Arr.map(["id", "code", "grp", "lead", "team", "holder"] as const, (f) =>
										names.column(Seat, f)
									),
									", "
								)
								const served = yield* servedFixture(m, desk)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(served.login.roles.holder, {
										token: tokenOf({ sub: "u_ann" })
									})

									const stored = [
										...Option.match(c.hidden, {
											onNone: () => [],
											onSome: (s) => [row(s, "u_carl")]
										}),
										...Option.match(c.inside, {
											onNone: () => [],
											onSome: (s) => [row(s, "u_ann")]
										})
									]
									if (stored.length > 0) {
										yield* owner.query(
											`INSERT INTO ${table} (${columns}) VALUES ${Arr.join(stored, ", ")}`,
											[]
										)
									}
									const before = yield* owner.values(
										`SELECT ${columns} FROM ${table} ORDER BY 1`,
										[]
									)
									const applied = yield* Effect.result(
										writeAnswerOf(
											db.workload.insertSeat.once({
												params: {},
												facts: { insert: { MySeat: [c.submitted] } }
											})
										)
									)
									if (Result.isFailure(applied)) {
										return assert.fail(
											`ann's insert of ${Formatter.format(c.submitted)} failed with ${applied.failure._tag}: ${applied.failure.message}`
										)
									}
									const outcome = applied.success
									const after = yield* owner.values(
										`SELECT ${columns} FROM ${table} ORDER BY 1`,
										[]
									)
									const hiddenMet = metIn(c, "hidden")
									const insideMet = metIn(c, "inside")
									for (const o of hiddenMet) {
										cx.note(`hidden occupant at the ${o.name}`)
									}
									for (const o of insideMet) {
										cx.note(`inside occupant at the ${o.name}`)
									}
									const met = [...hiddenMet, ...insideMet]
									const repeat = Option.exists(c.inside, (s) => same(s, c.submitted))
									if (met.length === 0) {
										cx.note(repeat ? "an exact repeat" : "accepted")
										assert.equal(outcome._tag, repeat ? "unchanged" : "accepted", "the outcome")
										const { id, code, grp, lead, team } = c.submitted
										assert.deepEqual(
											after,
											repeat
												? before
												: Arr.sort(
														[...before, [id, code, grp, lead, team, "u_ann"]],
														Order.mapInput(Order.Number, (r: ReadonlyArray<unknown>) =>
															Number(r[0])
														)
													),
											"the seats stored after the insert: ann's beside the ones before it"
										)
										return
									}
									if (outcome._tag !== "refused") {
										return assert.fail(
											`ann's insert of ${Formatter.format(c.submitted)} met ${Arr.join(
												Arr.map(met, (o) => o.name),
												", "
											)} and answered ${outcome._tag}`
										)
									}
									const [law, ...more] = Arr.map(refusedEntries(outcome.refused), (l) =>
										names.reported(l)
									)
									assert.deepEqual(more, [], "a key's refusal names its one law")
									const object = Option.getOrThrowWith(
										Arr.findFirst(met, (o) => lawOf[o.name] === law),
										() =>
											new Error(
												`the refusal's law ${law} is none of the objects ann's seat met: ${Arr.join(
													Arr.map(met, (o) => o.name),
													", "
												)}`
											)
									)
									assert.deepEqual(
										outcome.witness,
										{
											kind: "key",
											relation: "MySeat",
											values: Rec.fromEntries(
												Arr.map(object.witness, (f) => [f, c.submitted[f]] as const)
											)
										},
										`the witness of the ${object.name}: the key ann submitted, in MySeat's fields`
									)
									assert.deepEqual(after, before, "a refused insert stores nothing")
								}).pipe(Effect.scoped, withLayer(served.layer))
							}).pipe(Effect.scoped),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "each unique object's conflict over the drawn seats, its law and the submitted key as witness"
		},
		budget: { runs: 60, steered: 60 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/entry-occupants/entry-occupants.test.ts#aQueryEntrysWriteMeetsEveryUniqueObjectOfItsTargetAStoredFactAtAnyUniqueObjectInsideTheEntryOrOutsideItIsThatObjectsLawWithTheSubmittedKey:-:0.0.0.0.0.0.0"
				),
				reason:
					"a lead-free seat into an empty table: its precheck read the at most one lead's law column, which ann may not read (TEST_SEED=432815973, floor case 2)",
				since: "2026-11-19"
			}
		],
		kills: []
	})
