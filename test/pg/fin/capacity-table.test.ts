/**
 * fin.md §6's capacity table through grizzle's lowering, on PostgreSQL 19rc2: every use of the deleted `capacity` is
 * a native law, and a state the old capacity refused is refused natively, by PostgreSQL, with the SQLSTATE of the
 * native its row names, reporting that row's law.
 *
 * - **The specification turned into a checker:** each row of §6's table is a schema stating the row's replacement over
 *   a club and its seats, and a model of the row's law over a state: a club's seats and their lead flags, its count of
 *   seats and the count it needs, its seats' weights or shift lengths, or a seat's club and home. Each case is a row
 *   and a state of the box; PostgreSQL must commit it exactly when the model's law holds, and otherwise refuse it with
 *   the SQLSTATE of the native the law installs as, by a constraint of the relation the model names, reporting a law of
 *   the row's kind (installed.ts reads the law off the installation's constraint map).
 *
 * One departure from §6's text, recorded in NP's report: "at least one" as a bare containment into `select(S, φ)` is no
 * native, because a containment's target must contain a key (laws/model/plan.ts, "a containment into an unkeyed side
 * is not admitted"); its replacement here is the counted family with `check(T, n ≥ 1)`, the count row with lo = 1.
 */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { seatIn } from "#test/pg/fin/installed.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import {
	rows,
	schemas,
	sketchGen,
	statementsOf,
	capacityRefusalOf,
	type CapacityFeature,
	capacitySeats
} from "#test/pg/fin/capacity-table.fixtures.ts"

/**
 * fin.md §6's capacity table through grizzle's lowering on PostgreSQL 19rc2: commit each row's states its law admits
 * and refuse every other natively, with the row's SQLSTATE and law, each case on the worker's seat of its row's schema.
 */
export const finMdsCapacityTableThroughGrizzlesLoweringCommitEachRowsStatesItsLawAdmitsAndRefuseEveryOtherNatively =
	property.exhaust(finite(sketchGen), {
		box: "every row of §6's table, under every state of club 1 with up to four seats by their lead flags, a count of seats and a count needed of 0 to 5, up to three weights of -1 to 6 or shifts of 1 to 6, and a seat's club and home of 1 to 3",
		needs: Substrate.oneOf(capacitySeats, Substrate.seat),
		situations: nonEmpty(
			Arr.flatMap(rows, (row): ReadonlyArray<CapacityFeature> => [
				`${row} committed`,
				`${row} refused natively`
			])
		),
		check: (seats, c: Case<CapacityFeature>) => (sketch) =>
			Effect.scoped(
				Effect.flatMap(seats[sketch.row], (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const seat = yield* seatIn(
								taken,
								schemas[sketch.row].relations,
								`capacity ${sketch.row}`
							)
							const real = yield* attempt(seat.session, statementsOf(seat, sketch))
							const expected = capacityRefusalOf(sketch)
							if (Option.isNone(expected)) {
								assert.equal(
									real.kind,
									"committed",
									`${sketch.row}: a state its law admits commits: ${Formatter.format(real)}`
								)
								c.note(`${sketch.row} committed`)
								return
							}
							if (real.kind !== "refused") {
								return assert.fail(`${sketch.row}: a state its law refuses committed`)
							}
							const refusal = expected.value
							const named = seat.refusedBy(real.fields)
							const laws = Arr.flatMap(refusal.law, seat.lawsOf)
							assert.ok(
								real.fields.code === refusal.sqlstate &&
									Option.exists(
										named,
										(k) =>
											k.relation === refusal.relation &&
											Option.exists(k.law, (l) => laws.includes(l))
									),
								`${sketch.row}: refused by ${refusalText(real.fields)}, not ${refusal.sqlstate} by a ${Arr.join(refusal.law, " or ")} law of ${refusal.relation}`
							)
							c.note(`${sketch.row} refused natively`)
						}),
						Substrate,
						taken.substrate
					)
				)
			),
		oracle: {
			kind: "specification",
			name: "fin.md §6's capacity table as a checker: each row's law over a state, the native it installs as, its SQLSTATE and law"
		},
		kept: [],
		kills: []
	})
