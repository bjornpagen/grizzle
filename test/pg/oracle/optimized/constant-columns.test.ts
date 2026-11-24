/**
 * A union holds its column at a value only where every arm holds it there (the constant-column pass,
 * lower/optimize/propagate valuesOf, the meet): the marks of each key of a union of two arms, each projecting the key,
 * an arm that holds it at the parameter p and an arm that holds every session's key, in either order, or two arms that
 * both hold it at p. The optimized lowering agrees with the conservative one, which reads every arm as it stands
 * (lower/conservative), and both deliver every mark of every session where one arm holds no value, and the mark at p
 * where both hold p, which the pass reads by M's key at a = p and delivers as p (propagate.restrict and
 * propagate.substitute). The optimizer's population (optimizer.test.ts) projects no parameter, so no column of it is
 * held at one; this box is the one that reaches the pass and the arms where its value is not held.
 *
 * Oracle: the conservative lowering on the same installation and facts, and the facts' own marks.
 *
 * Features: each arrangement of the arms, and each of the pass's two rules, which the case both of whose arms hold p
 * rests on.
 */

import type { Reached } from "@bjornpagen/testing/features"
import type { Case as PropertyCase } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import {
	type ArmsHolding,
	armsHolding,
	armsSpace,
	type ConstantColumnsFeature,
	constantColumnsCase,
	deliveredRows,
	passRules
} from "#test/pg/oracle/optimized/constant-columns.fixtures.ts"
import {
	agrees,
	differentialCase,
	plainDifferential,
	printDifferential
} from "#test/pg/oracle/optimized/support.ts"
import { namedPlacement, oracleProperty, PropertyFailed } from "#test/support/oracle/runner.ts"

/** A union one arm of which holds a key at a parameter is read for every arm's keys, both lowerings alike. */
export const aUnionOneArmOfWhichHoldsAKeyAtAParameterIsReadForEveryArmsKeysUnderBothLowerings =
	oracleProperty(armsSpace, {
		situations: [...armsHolding, ...passRules] satisfies ReadonlyArray<
			Reached<ConstantColumnsFeature>
		>,
		perturb: "planner",
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering on the same installation and facts, and the facts' own marks"
		},
		kept: [],
		/**
		 * Its search budget: the fewest runs at which its kill still fails a witness and every situation is reached.
		 *
		 * @limitKind measured
		 * @owner test/pg/oracle/optimized/constant-columns.test.ts
		 *   aUnionOneArmOfWhichHoldsAKeyAtAParameterIsReadForEveryArmsKeysUnderBothLowerings
		 * @unit cases
		 * @scope one search of this property: `runs` cases of its rotating stream and a quarter of them, rounded up, of its
		 *   floor stream; `steered` the most its steered phase runs while a required situation is unreached
		 * @evidence EVIDENCE_LINE
		 * @observed OBSERVED_LINE
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, grizzle.slice's 16-CPU cap, other
		 *   lanes' load beside it; lane PROPAGATE's in-memory family of PostgreSQL 19 members
		 * @workload its run and its kill's, at TEST_SEED=2219874524
		 * @result RESULT_LINE
		 * @decision runs 3 and steered 12: its box is three arrangements, each drawn under a plan perturbation, and each
		 *   situation is aimed at the arrangement that reaches it, so the floor case and the steered phase reach all five
		 *   within as many steered cases as situations, and the kill fails the case whose first arm holds p
		 * @revalidate a change of its box, its check or its kill's file, or of how the testing library draws a floor or
		 *   steered case; the kill gate (toolchain-test kills, affected) reports a kill that survives
		 */
		budget: { runs: 3, steered: 12 },
		kills: [
			{
				file: "packages/engine/src/lower/optimize/propagate/index.ts",
				original: "\t\t\t\tfor (const [column, value] of rest.reduce(meet, first)) {\n",
				replacement: "\t\t\t\tfor (const [column, value] of first) {\n",
				why: "A union holds a column at the value its first arm holds it at, whatever its other arms hold: the marks of the keys of a union whose first arm projects p are read at M's a = p and delivered with k read as p, so every other session's marks are lost."
			}
		],
		show: Formatter.format,
		check: (k: PropertyCase<ConstantColumnsFeature>) => (holding: ArmsHolding) =>
			Effect.gen(function* () {
				k.note(holding)
				const placement = yield* namedPlacement("constcols")
				const o = yield* differentialCase(constantColumnsCase(holding), {
					...plainDifferential,
					placement
				})
				for (const rule of passRules) {
					if (Arr.some(o.certificates, (c) => c.rule === rule)) {
						k.note(rule)
					}
				}
				/** Each row's key and mark, as text, in one order: the marks a lowering delivered, whatever its rows' order. */
				const marks = (rows: ReadonlyArray<ReadonlyArray<string | null>>) =>
					Arr.sort(
						Arr.map(rows, (r) => canonicalTextOf(r.slice(0, 2))),
						Order.String
					)
				const delivered = marks(Arr.flatMap(o.conservative.statements, (s) => s.rows))
				if (
					!agrees(o) ||
					canonicalTextOf(delivered) !== canonicalTextOf(marks(deliveredRows(holding)))
				) {
					return yield* new PropertyFailed({
						report: `a union's arms are not every arm's keys under both lowerings\n${printDifferential(o)}`
					})
				}
			})
	})
