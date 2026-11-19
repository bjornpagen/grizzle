/**
 * Canonical cell keyed-set comparison (test/support/oracle/compare.ts), against models that read no spelling.
 *
 * - Row multisets: compareMultisets(left, right) names as missing exactly the rows left holds more often than right,
 *   each with how many more times, and as extra exactly those right holds more often, against a count-by-row model
 *   (a TupleMap of each row's count), compared as sets of rows with counts. The right side is the left one changed by
 *   a named kind, weighted explicitly: reordered, a row repeated, a row dropped, a cell changed, or drawn apart.
 * - Runs: two runs whose cells spell values in any of their output spellings (1.0 and 1.00, -0 and 0) agree exactly
 *   when each holds every value once and they hold one set of values, against a count of the value classes the cells
 *   spell, which reads no spelling; a run that repeats a value agrees with nothing, a run repeating it alike included.
 *   The right run is the left one respelled and reordered, with one value changed or one row repeated.
 *
 * Oracles: second implementations, the count-by-row model and the count of value classes. Features: each change kind,
 * and each verdict (equal, missing rows, extra rows, both; agreement across spellings, a value, a count or a repeat
 * told apart).
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import { assert } from "#test/support/assert.ts"
import type { ValueIdentity } from "#test/support/kernel/identity.ts"
import { compareMultisets, compareRuns } from "#test/support/oracle/compare.ts"
import {
	type CanonicalFeature,
	countsOf,
	excessOf,
	type MultisetFeature,
	multisetPairGen,
	type Row,
	runOf,
	runPairGen,
	sameExcess,
	valueKey
} from "#test/unit/oracle-runner/compare.fixtures.ts"

/**
 * Row multisets name exactly the rows each side holds more often, against a count-by-row model.
 *
 * Budget: its suite's count before the conversion (unit/oracle-runner/compare-multisets: 400 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const rowMultisetsNameExactlyTheRowsEachSideHoldsMoreOftenAgainstACountByRowModel =
	property.explore(multisetPairGen, {
		needs: {},
		situations: [
			"reordered",
			"a row repeated",
			"a row dropped",
			"a cell changed",
			"drawn apart",
			"equal",
			"missing only",
			"extra only",
			"missing and extra"
		] satisfies ReadonlyArray<Reached<MultisetFeature>>,
		check:
			(_, c: Case<MultisetFeature>) =>
			({ change, left, right }) =>
				Effect.sync(() => {
					const l = countsOf(left)
					const r = countsOf(right)
					const missing = excessOf(l, r)
					const extra = excessOf(r, l)
					const compared = compareMultisets(left, right)
					sameExcess(compared.missing, missing, "the missing rows")
					sameExcess(compared.extra, extra, "the extra rows")
					c.note(change)
					c.note(
						missing.size === 0
							? extra.size === 0
								? "equal"
								: "extra only"
							: extra.size === 0
								? "missing only"
								: "missing and extra"
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "a count of each row, compared as multisets"
		},
		budget: { runs: 400, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/tuple-map.ts",
				original: "\t\t\t\tchild.value = value",
				replacement: "\t\t\t\t{}",
				why: "Operator mutant (statement) at packages/engine/src/core/tuple-map.ts:114 in <module>: `child.value = value` becomes `{}`, so a key held in a slot and set again keeps its old value; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Canonical cell keyed sets agree exactly when each run's cells spell a set of values and the two sets are one,
 * whatever the spellings.
 *
 * Budget: its suite's count before the conversion (unit/oracle-runner/compare-canonical: 400 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const canonicalCellKeyedSetsAgreeExactlyWhenEachRunsCellsSpellASetOfValuesAndTheTwoSetsAreOneWhateverTheSpellings =
	property.explore(runPairGen, {
		needs: {},
		situations: [
			"agree across spellings",
			"a value told apart",
			"a count told apart",
			"a repeat told apart"
		] satisfies ReadonlyArray<Reached<CanonicalFeature>>,
		check:
			(_, c: Case<CanonicalFeature>) =>
			({ left, right }) =>
				Effect.sync(() => {
					const count = (rows: ReadonlyArray<Row>) =>
						Arr.reduce(rows, new TupleMap<ValueIdentity, number>(), (m, row) =>
							m.set(valueKey(row), (m.get(valueKey(row)) ?? 0) + 1)
						)
					const a = count(left)
					const b = count(right)
					const sameCounts = a.size === b.size && Arr.every([...a], ([k, n]) => b.get(k) === n)
					const sets = a.size === left.length && b.size === right.length
					const compared = compareRuns(runOf("left", left), runOf("right", right))
					assert.equal(compared.equal, sameCounts && sets)
					assert.equal(compared.repeated.length > 0, !sets)
					if (sameCounts && sets) {
						c.note("agree across spellings")
					} else if (sameCounts) {
						c.note("a repeat told apart")
					} else if (left.length === right.length) {
						c.note("a value told apart")
					} else {
						c.note("a count told apart")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "a count of the value classes each run's cells spell"
		},
		budget: { runs: 400, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original:
					'export const floatText = (x: number): string => (Object.is(x, -0) ? "-0" : String(x))',
				replacement: "export const floatText = (x: number): string => String(x)",
				why: "A float's -0 is written as 0 again, as before c067533e8, so a run's -0 and 0 are one canonical cell: two rows that differ only by the zero's sign read as one repeated; this property fails."
			},
			{
				file: "packages/engine/src/core/tuple-map.ts",
				original: "\t\t\t\tchild.value = value",
				replacement: "\t\t\t\t{}",
				why: "Operator mutant (statement) at packages/engine/src/core/tuple-map.ts:114 in <module>: `child.value = value` becomes `{}`, so a key held in a slot and set again keeps its old value; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
