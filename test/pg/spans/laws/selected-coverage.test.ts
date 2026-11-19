/**
 * Selected-source span coverage at the limits of a span's stored domain, over bigint and over date endpoints, native: a
 * billable visit is accepted exactly when the union of its site's shifts contains its span, and refused otherwise with
 * 23503 on the PERIOD foreign key from the visit's range law column into Shift's WITHOUT OVERLAPS key (fin.md §7), at
 * its statement.
 *
 * The oracle is a second implementation: `covers`, a sweep over the disjoint shifts in order, over the endpoint's
 * values as bigints (a date as its day number, the order of dates). The box is an endpoint, bigint or date, a cover cut
 * at distinct points of its `points` (pointsAround: the domain's limits and the points beside them, and an inside value
 * and the points beside it: int8's limits and zero, a date's 0001-01-01, 9999-12-31 and leap day), each piece dropped
 * one time in four, and a nonempty visit between two of the points, required to reach, over each endpoint, a
 * covered and a refused visit from the lower limit, to the upper limit and inside them.
 *
 * These edges stay a suite of their own rather than kept cases of the span-coverage box (test/support/laws/boxes.ts
 * spanCoverage): that harness's host model spells a span's ends as JavaScript numbers
 * (test/support/laws/model.ts Span), which hold no int8 limit exactly and no date, so the limits can be stated only
 * here, as int8range and daterange literals.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { visitsLaw } from "#test/pg/spans/laws/schemas.ts"
import {
	coverageTemplates,
	type CoverFeature,
	covers,
	coverSketchGen,
	endpointKinds,
	endpoints,
	literal,
	resolveCover,
	runs,
	type Where
} from "#test/pg/spans/laws/selected-coverage.fixtures.ts"
import { spanInstallIn, writerOf } from "#test/pg/spans/laws/support.ts"
import { assert } from "#test/support/assert.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Selected-source span coverage at the limits of bigint and date spans a billable visit is accepted iff the union of its site's shifts contains it, at the limits of its endpoint.
 *
 * Its pre-conversion budget: runs runs, coverage cases runs (test/pg/spans/laws/selected-coverage.test.ts at d8eed1786).
 */
export const selectedSourceSpanCoverageAtTheLimitsOfBigintAndDateSpansABillableVisitIsAcceptedIffTheUnionOfItsSitesShiftsContainsItAtTheLimitsOfItsEndpoint =
	property.explore(coverSketchGen, {
		needs: Substrate.oneOf(coverageTemplates, Substrate.seat),
		situations: Arr.flatMap(endpointKinds, (endpoint) =>
			Arr.flatMap(["covered", "refused"] as const, (o) =>
				Arr.map(
					["from the lower limit", "to the upper limit", "inside the limits"] as const,
					(where): CoverFeature => `${endpoint} ${o} ${where}`
				)
			)
		) satisfies ReadonlyArray<Reached<CoverFeature>>,
		check: (seats, c: Case<CoverFeature>) => (sketch) =>
			Effect.gen(function* () {
				const resolved = resolveCover(sketch)
				if (resolved === "no visit") {
					return
				}
				const { points } = endpoints[sketch.endpoint]
				const taken = yield* seats[sketch.endpoint]
				const s = taken.substrate
				const install = spanInstallIn(taken)
				const writer = yield* Effect.provideService(
					writerOf(install, `writer ${sketch.endpoint}`),
					Substrate,
					s
				)
				const foreignKey = install.periodForeignKey(visitsLaw(sketch.endpoint))
				const expected = covers(resolved.shifts, resolved.visit)
				const where: Where =
					resolved.visit.start === Arr.headNonEmpty(points)
						? "from the lower limit"
						: resolved.visit.end === Arr.lastNonEmpty(points)
							? "to the upper limit"
							: "inside the limits"
				c.note(`${sketch.endpoint} ${expected ? "covered" : "refused"} ${where}`)
				yield* replaceRows(
					s.admin,
					install.group,
					resolved.shifts.length === 0
						? []
						: [
								{
									sql: `INSERT INTO ${install.table("Shift")} VALUES ${Arr.join(
										Arr.map(resolved.shifts, (x, i) => `(1, ${literal(sketch.endpoint, x)}, ${i})`),
										", "
									)}`,
									params: []
								}
							]
				)
				const insert = writer.query(
					`INSERT INTO ${install.table("Visit")} VALUES (1, 1, ${literal(sketch.endpoint, resolved.visit)}, true)`,
					[]
				)
				if (expected) {
					yield* insert
				} else {
					const refused = yield* expectSqlstate(insert, "23503")
					assert.equal(refused.constraint, foreignKey)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "a sweep over the disjoint shifts in order, over the endpoint's values"
		},
		budget: { runs: runs, steered: runs },
		kept: [],
		kills: []
	})
