/**
 * The query kit's agreement judgments, against independent models.
 *
 * - `within(tolerance)` agrees on two keyed lists of numeric texts exactly when every key occurs once on each side and
 *   its two values are equal texts or within the tolerance as numbers: a repeated key, a key on one side only, or a
 *   difference above the tolerance disagrees. `agreementCounts` counts as unmatched exactly the keys on one side only.
 * - `deliveredAgree` compares delivered values as sets of rows: a permutation of the rows agrees, a permutation inside
 *   a nested array agrees as a set and disagrees in order unless it changed nothing, and a changed field, a repeated
 *   row, or an item a nested set repeats disagrees.
 *
 * Oracles: second implementations, a model of keyed agreement over the drawn rows and the drawn changes' own verdicts.
 * The keyed rows are drawn over four keys and a few decimal texts that are equal, near, apart or no number at all, so
 * every verdict is in reach; the delivered rows are distinct by construction, at least one, each with its own id.
 * Features: every way two keyed lists agree or not; every change to a delivery.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { agreementCounts, deliveredAgree, within } from "#bench/query/support/kit.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	close,
	type DeliveredFeature,
	keyedRowsGen,
	keys,
	rowsGen,
	sameOrder,
	valuesOf,
	type WithinFeature
} from "#test/unit/bench/query-gates.fixtures.ts"

/**
 * The query kit's keyed numeric agreement within agrees exactly when the keyed values match within the tolerance.
 *
 * Budget: its suite's count before the conversion (unit/bench/within: 200 independent cases and 16 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theQueryKitsKeyedNumericAgreementWithinAgreesExactlyWhenTheKeyedValuesMatchWithinTheTolerance =
	property.explore(
		(source) =>
			[
				source.draw(keyedRowsGen),
				source.draw(keyedRowsGen),
				source.draw(element([0, 1e-9, 1e-3]))
			] as const,
		{
			needs: {},
			situations: [
				"repeated key left",
				"repeated key right",
				"key only left",
				"key only right",
				"difference above tolerance",
				"agree within tolerance",
				"agree exactly"
			] satisfies ReadonlyArray<Reached<WithinFeature>>,
			check:
				(_, c: Case<WithinFeature>) =>
				([left, right, tolerance]) =>
					Effect.sync(() => {
						let agrees = true
						let unmatched = 0
						for (const key of keys) {
							const l = valuesOf(left, key)
							const r = valuesOf(right, key)
							if (l.length > 1) {
								c.note("repeated key left")
							}
							if (r.length > 1) {
								c.note("repeated key right")
							}
							if (l.length > 0 && r.length === 0) {
								c.note("key only left")
								unmatched++
							}
							if (r.length > 0 && l.length === 0) {
								c.note("key only right")
								unmatched++
							}
							const [a] = l
							const [b] = r
							if (l.length !== r.length || l.length > 1) {
								agrees = false
							} else if (a !== undefined && b !== undefined) {
								if (a === b) {
									c.note("agree exactly")
								} else if (close(a, b, tolerance)) {
									c.note("agree within tolerance")
								} else {
									c.note("difference above tolerance")
									agrees = false
								}
							}
						}
						assert.equal(Option.isNone(within(tolerance)(left, right)), agrees)
						assert.equal(agreementCounts(tolerance, left, right).unmatched, unmatched)
					}),
			oracle: {
				kind: "second-implementation",
				name: "a model of keyed agreement: every key once on each side, equal or within the tolerance"
			},
			budget: { runs: 200, steered: 16 },
			kept: [],
			kills: []
		}
	)

/**
 * The query kit's delivered agreement deliveredAgree is set equality of delivered values.
 *
 * Budget: its suite's count before the conversion (unit/bench/delivered-agree: 200 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theQueryKitsDeliveredAgreementDeliveredAgreeIsSetEqualityOfDeliveredValues =
	property.explore(
		(source) =>
			[source.draw(rowsGen), source.draw(int(0, 2 ** 31 - 1)), source.draw(boolean)] as const,
		{
			needs: {},
			situations: [
				"permutation",
				"nested permutation",
				"changed field",
				"repeated row",
				"repeated nested item"
			] satisfies ReadonlyArray<Reached<DeliveredFeature>>,
			check:
				(_, c: Case<DeliveredFeature>) =>
				([rows, n, reverse]) =>
					Effect.sync(() => {
						const ordered = deliveredAgree("ordered")
						const unordered = deliveredAgree("set")
						/** A permutation: the rows rotated by n, reversed when drawn so. */
						const at = n % rows.length
						const rotated = [...rows.slice(at), ...rows.slice(0, at)]
						const permuted = reverse ? Arr.reverse(rotated) : rotated
						if (Arr.some(permuted, (r, i) => r !== rows[i])) {
							c.note("permutation")
						}
						assert.deepEqual(unordered(rows, permuted), Option.none())
						assert.deepEqual(ordered(rows, permuted), Option.none())
						/** A nested permutation: the n-th row's array reversed. */
						const nested = Arr.map(rows, (r, i) =>
							i === at ? { id: r.id, xs: Arr.reverse(r.xs) } : r
						)
						const target = defined(rows[at])
						const unchanged = sameOrder(target.xs, Arr.reverse(target.xs))
						if (!unchanged) {
							c.note("nested permutation")
						}
						assert.deepEqual(unordered(rows, nested), Option.none())
						assert.equal(Option.isNone(ordered(rows, nested)), unchanged)
						/** A changed field: the n-th row's id, or its first element, moved outside every drawn value. */
						const changed = Arr.map(rows, (r, i) =>
							i !== at
								? r
								: reverse || r.xs.length === 0
									? { id: r.id + 4n, xs: r.xs }
									: { id: r.id, xs: Arr.map(r.xs, (x, j) => (j === 0 ? x + 3 : x)) }
						)
						c.note("changed field")
						assert.notDeepEqual(unordered(rows, changed), Option.none())
						assert.notDeepEqual(ordered(rows, changed), Option.none())
						/** A repeated row: the n-th row delivered again. */
						const repeated = [...permuted, target]
						c.note("repeated row")
						assert.notDeepEqual(unordered(rows, repeated), Option.none())
						assert.notDeepEqual(unordered(repeated, repeated), Option.none())
						assert.notDeepEqual(ordered(repeated, repeated), Option.none())
						/** A repeated nested item: the n-th row's first item delivered again in its array. */
						const [first] = target.xs
						if (first !== undefined) {
							const doubled = Arr.map(rows, (r, i) =>
								i === at ? { id: r.id, xs: [...r.xs, first] } : r
							)
							c.note("repeated nested item")
							assert.notDeepEqual(unordered(doubled, doubled), Option.none())
						}
					}),
			oracle: {
				kind: "specification",
				name: "a delivery is a set of rows: a permutation agrees, a changed field, a repeat or a nested repeat does not"
			},
			budget: { runs: 200, steered: 0 },
			kept: [],
			kills: []
		}
	)
