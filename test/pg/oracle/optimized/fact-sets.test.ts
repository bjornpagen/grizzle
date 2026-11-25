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
import { type Case as PropertyCase, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
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

/**
 * Rows as the set they are: each row's canonical text, sorted, so one set delivered in any order reads alike. A root
 * that orders nothing delivers its rows in whatever order its plan yields, a hash aggregate's under enable_sort = off
 * among them, and PostgreSQL's order holds -0 and +0 tied besides.
 */
const asSet = (rows: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (row) => canonicalTextOf(row)),
		Order.String
	)

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
		kept: [
			{
				token: ReplayToken(
					"test/pg/oracle/optimized/fact-sets.test.ts#twoFactsApartInAZerosSignAreTwoRowsUnderBothLoweringsCountedTwo:-:2.0.0.0.1.0.0.0.0.0.0"
				),
				reason:
					"rotating seed 0xfcd2b402, case 8, shrunk: the result over float4 under enable_sort = off, its two facts delivered -0 first",
				since: "2026-11-24"
			}
		],
		/**
		 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
		 * (grizzle main, 2026-11-23).
		 *
		 * @limitKind measured
		 * @owner test/pg/oracle/optimized/fact-sets.test.ts twoFactsApartInAZerosSignAreTwoRowsUnderBothLoweringsCountedTwo
		 * @unit cases
		 * @scope one search of this property: `runs` cases of its rotating stream and a quarter of them, rounded up, of its
		 *   floor stream; `steered` the most its steered phase runs while a required situation is unreached
		 * @evidence `toolchain-test kills` and `toolchain-test run` of test/pg/oracle's test files at TEST_SEED=2219874524
		 *   (a property's witnesses, its kept cases, floor and steered phase, are fixed by its identity, the same on every
		 *   seed), each killed kill's failing witness printed by an uncommitted line in vendor/toolchain's
		 *   mutate/commands.ts; the logs kills0.log (the pre-conversion budgets), run1.log, kills2.log, run3.log,
		 *   kills4.log, v1at5.log, fs5.log, fs9.log, fs13.log and run5.log in ~/.cache/grizzle/CULL-ORACLE-out on
		 *   cassowary, uncommitted
		 * @observed 2026-11-23 03:12 to 04:36 UTC
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load average 130 to 410 from other
		 *   lanes; vendor/toolchain 2cc48172; the budgets measured on grizzle f87b2aaab with 47748474c's change and
		 *   verified on dff9200ef (run5.log, every property green and every kill killed); lane CULL-ORACLE's in-memory
		 *   family of two PostgreSQL 19 members
		 * @workload its witnesses with its kill applied, on workers of its own, and its full run, at runs 24, 13, 9, 5 and
		 *   1, steered 24
		 * @result runs 24 (pre-conversion): the analysis/physical kill fails floor case 0; runs 13 (a floor of four):
		 *   killed, its six situations reached with 16 steered cases, 33 cases in all where 5374a0575's record ran 46; runs
		 *   9, 5 and 1: a situation of its six unreached (take over float4 at each, with take over float8 at 5 and 1 and
		 *   result over float8 at 1), so the property fails with no kill
		 * @decision runs 13, the fewest at which its situations are all reached, and the kill fails its first floor case
		 *   there. steered stays its pre-conversion 24: at fewer runs the steered phase did not reach the three situations
		 *   the floor left, so the floor's size is the lever
		 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
		 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
		 *   survives
		 */
		budget: { runs: 13, steered: 24 },
		kills: [
			{
				file: "packages/engine/src/analysis/physical/analyze.ts",
				original:
					"\t\t\t(input.columns.every((c) => heading.includes(c)) ? input.facts : undefined)",
				replacement: "\t\t\tundefined",
				why: "An observer is discharged by a native key alone (analysis/physical/analyze.ts obligations), as at 59d57455f: placement puts a DISTINCT on the region over the parameter, which merges (0, 1) and (-0, 1), and the count is 1."
			},
			{
				file: "packages/engine/src/ir/compare.ts",
				original: "\t\tgroupBy: [...targets.map((t) => t.expr), ...signs]\n",
				replacement: "\t\tgroupBy: targets.map((t) => t.expr)\n",
				why: "A set of facts grouped under PostgreSQL's equality alone (ir/compare.ts factSet), its zeros' signs left out: the parameter's (0, 1) and (-0, 1) are one row of the result."
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
					expected === undefined ||
					canonicalTextOf(asSet(rows)) === canonicalTextOf(asSet(expected))
				if (!agrees(o) || !decided) {
					return yield* new PropertyFailed({
						report: `two facts apart in a zero's sign are not two rows under both lowerings\n${printDifferential(o)}`
					})
				}
			})
	}
)
