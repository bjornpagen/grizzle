/**
 * A reference reads a parameter in a column's place only where every row holds that very value (the constant-column
 * pass, lower/optimize/propagate valuesOf): a union holds its column at a value only where every arm holds it there (the
 * meet), and an equality holds a column at its value only on a carrier whose equality is identity (ir/scalar.ts
 * equalityIsIdentity). The box: the marks of each key of a union of two arms, each projecting the key, an arm that holds
 * it at the parameter p and an arm that holds every session's key, in either order, or two arms that both hold it at p;
 * and a stored row read where its double precision column equals the parameter q, its stored -0 at q's 0, which a
 * float's equality holds equal and its identity tells apart, delivered with a projection that reads the column. The optimized lowering agrees with the conservative one, which reads every arm and every column as it stands
 * (lower/conservative): both deliver every mark of every session where one arm holds no value, the mark at p where both
 * hold p, which the pass reads by M's key at a = p and delivers as p (propagate.restrict and propagate.substitute), and
 * the stored -0, never q's 0. The optimizer's population (optimizer.test.ts) projects no parameter, so no
 * column of it is held at one; this box is the one that reaches the pass and the cases where a value is not held.
 *
 * Oracle: the conservative lowering on the same installation and facts, and the facts' own rows.
 *
 * Features: each case, and each of the pass's two rules, which the case both of whose arms hold p rests on.
 */

import type { Reached } from "@bjornpagen/testing/features"
import type { Case as PropertyCase } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import {
	casesSpace,
	type ConstantColumnsFeature,
	type ConstantColumnsCase,
	constantColumnsCase,
	constantColumnsCases,
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

/** A reference reads a parameter in a column's place only where every row holds that very value, both lowerings alike. */
export const aReferenceReadsAParameterInAColumnsPlaceOnlyWhereEveryRowHoldsThatVeryValue =
	oracleProperty(casesSpace, {
		situations: [...constantColumnsCases, ...passRules] satisfies ReadonlyArray<
			Reached<ConstantColumnsFeature>
		>,
		perturb: "planner",
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering on the same installation and facts, and the facts' own rows"
		},
		kept: [],
		/**
		 * Its search budget: the fewest runs at which its kill still fails a witness and every situation is reached.
		 *
		 * @limitKind measured
		 * @owner test/pg/oracle/optimized/constant-columns.test.ts
		 *   aReferenceReadsAParameterInAColumnsPlaceOnlyWhereEveryRowHoldsThatVeryValue
		 * @unit cases
		 * @scope one search of this property: `runs` cases of its rotating stream and a quarter of them, rounded up, of its
		 *   floor stream; `steered` the most its steered phase runs while a required situation is unreached
		 * @evidence EVIDENCE_LINE
		 * @observed OBSERVED_LINE
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, grizzle.slice's 16-CPU cap, other
		 *   lanes' load beside it; lane PROPAGATE's in-memory family of PostgreSQL 19 members
		 * @workload its run and its kill's, at TEST_SEED=2219874524
		 * @result RESULT_LINE
		 * @decision runs 3 and steered 12: its box is four cases, each drawn under a plan perturbation, and each
		 *   situation is aimed at the case that reaches it, so the floor case and the steered phase reach all six within
		 *   as many steered cases as situations, and each kill fails the case it names
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
			},
			{
				file: "packages/engine/src/ir/scalar.ts",
				original:
					"const equalityIsIdentityOf: { readonly [C in Carrier]: boolean } = {\n\tint2: true,\n\tint4: true,\n\tint8: true,\n\tnumeric: false,\n\tfloat4: false,\n\tfloat8: false,\n",
				replacement:
					"const equalityIsIdentityOf: { readonly [C in Carrier]: boolean } = {\n\tint2: true,\n\tint4: true,\n\tint8: true,\n\tnumeric: false,\n\tfloat4: true,\n\tfloat8: true,\n",
				why: "A float's equality reads as identity: x = q holds x at q, so the projection delivers q's 0 for the stored -0."
			}
		],
		show: Formatter.format,
		check: (k: PropertyCase<ConstantColumnsFeature>) => (c: ConstantColumnsCase) =>
			Effect.gen(function* () {
				k.note(c)
				const placement = yield* namedPlacement("constcols")
				const o = yield* differentialCase(constantColumnsCase(c), {
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
				if (!agrees(o) || canonicalTextOf(delivered) !== canonicalTextOf(marks(deliveredRows(c)))) {
					return yield* new PropertyFailed({
						report: `a reference read a parameter where a row held another value\n${printDifferential(o)}`
					})
				}
			})
	})
