/**
 * A relation parameter's facts that differ in a real column's zero's sign alone, (0, 1) and (-0, 1), are two facts every
 * lowering delivers as two: counted, bounded or delivered by a region that reads them whole, the optimized lowering
 * agrees with the conservative one, which reads the parameter as its set of facts by their identity
 * (lower/conservative/input-set), and both count both facts, 2, and deliver both as the result. A bound's own duplicate
 * elimination compares under PostgreSQL's equality in both lowerings, so only their agreement is asked of it.
 *
 * The region over them proves no native key, since PostgreSQL's equality holds -0 and +0 equal
 * (analysis/physical/rules.ts InputSet), but its rows are distinct facts (PhysicalProps facts), which discharges each
 * observer: placement puts no DISTINCT on it, which would merge the two facts into one, a count of 1, as the optimized
 * lowering did at 59d57455f.
 *
 * Oracle: the conservative lowering on the same installation and facts, and the facts' own count.
 *
 * Features: each observer over each real carrier.
 */

import type { Reached } from "@bjornpagen/testing/features"
import type { Case as PropertyCase } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import {
	type Carrier,
	deliveredRows,
	factSetCase,
	factSetCaseGen,
	type FactSetCase,
	type Observer,
	observers
} from "#test/pg/oracle/optimized/fact-sets.fixtures.ts"
import {
	agrees,
	differentialCase,
	plainDifferential,
	printDifferential
} from "#test/pg/oracle/optimized/support.ts"
import { namedPlacement, oracleProperty, PropertyFailed } from "#test/support/oracle/runner.ts"

type FactSetFeature = `${Observer} over ${Carrier}`

/** Two facts of a relation parameter apart in a zero's sign alone are two rows under both lowerings, counted 2. */
export const twoFactsApartInAZerosSignAreTwoRowsUnderBothLoweringsCountedTwo = oracleProperty(
	factSetCaseGen,
	{
		situations: Arr.flatMap(observers, (o) =>
			Arr.map(["float4", "float8"] as const, (c): FactSetFeature => `${o} over ${c}`)
		) satisfies ReadonlyArray<Reached<FactSetFeature>>,
		perturb: "planner",
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering on the same installation and facts, and the facts' own count"
		},
		kept: [],
		/** Its space is six cases, an observer over a carrier: 24 runs draw each of them, as do 24 steered cases. */
		budget: { runs: 24, steered: 24 },
		kills: [
			{
				file: "packages/engine/src/analysis/physical/analyze.ts",
				original:
					"\t\t\t(input.columns.every((c) => heading.includes(c)) ? input.facts : undefined)",
				replacement: "\t\t\tundefined",
				why: "An observer is discharged by a native key alone (analysis/physical/analyze.ts obligations), as at 59d57455f: placement puts a DISTINCT on the region over the parameter, which merges (0, 1) and (-0, 1), and the count is 1."
			}
		],
		show: Formatter.format,
		check: (k: PropertyCase<FactSetFeature>) => (c: FactSetCase) =>
			Effect.gen(function* () {
				k.note(`${c.observer} over ${c.carrier}`)
				const placement = yield* namedPlacement("facts")
				const o = yield* differentialCase(factSetCase(c), { ...plainDifferential, placement })
				const rows = Arr.flatMap(o.conservative.statements, (s) => s.rows)
				const expected = deliveredRows(c.observer)
				const decided =
					expected === undefined || canonicalTextOf(rows) === canonicalTextOf(expected)
				if (!agrees(o) || !decided) {
					return yield* new PropertyFailed({
						report: `two facts apart in a zero's sign are not two rows under both lowerings\n${printDifferential(o)}`
					})
				}
			})
	}
)
