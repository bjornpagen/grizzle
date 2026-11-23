/**
 * A series (r.series, lower/conservative/call lowerSeries) against PostgreSQL 19: a served read of each integer from its
 * bigint parameter `lo` to its bigint parameter `hi`, each held within [-20, 20] by LEAST and GREATEST with constants,
 * delivers exactly the integers between them, none where the low end lies above the high end, each with itself cast
 * into a contract within [-20, 20], which stands on the element's interval alone, no guard (series.fixtures.ts). The
 * oracle is brute force: every integer from the held lo to the held hi.
 *
 * Features: no element, low above high; one element; several elements.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	elementsOf,
	endsGen,
	type Feature,
	Series,
	seriesInstall,
	seriesTemplate
} from "#test/pg/compute/series.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { rowsOf } from "#test/support/calls.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A series of its ends delivers exactly the integers between them, each cast into the ends' contract with no guard. */
export const aSeriesDeliversExactlyTheIntegersFromItsLowEndToItsHighEndNoneWhereLowLiesAboveHigh =
	property.explore(endsGen, {
		needs: { fixture: Substrate.fresh(seriesTemplate) },
		situations: [
			"no element: low above high",
			"one element",
			"several elements"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			([lo, hi]) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(Series, {}, seriesInstall, taken)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const rows = yield* rowsOf(
									db.workload.elements.once({
										params: { lo: BigInt(lo), hi: BigInt(hi) },
										facts: {}
									})
								)
								const expected = elementsOf(lo, hi)
								const delivered = Arr.sort(
									Arr.map(rows, (row) => row.at),
									Order.BigInt
								)
								assert.deepEqual(delivered, expected, `the series from ${lo} to ${hi}`)
								assert.ok(
									Arr.every(rows, (row) => BigInt(row.small) === row.at),
									`each element of the series from ${lo} to ${hi} is itself as a Small`
								)
								c.note(
									expected.length === 0
										? "no element: low above high"
										: expected.length === 1
											? "one element"
											: "several elements"
								)
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "brute force: every integer from lo to hi, none where lo lies above hi"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original:
					'\t\tcall: call("generate_series", [end(seriesArguments.low), end(seriesArguments.high)]),\n',
				replacement:
					'\t\tcall: call("generate_series", [end(seriesArguments.low), end(seriesArguments.low)]),\n',
				why: "A series ends at its low end, so a series of several integers delivers its low end alone."
			}
		]
	})
