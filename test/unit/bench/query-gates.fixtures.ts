/** What the properties of query-gates.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, map, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"

type KeyedRows = ReadonlyArray<readonly [string, string]>

export const keys = ["a", "b", "c", "d"] as const

/**
 * Decimal texts whose numbers are equal, near, apart or not numbers at all: "1" and "1.0000000001" agree within 1e-9,
 * "1" and "1.001" within 1e-3 only, "0" and "-0" as numbers, "NaN" only with itself.
 */
const valueGen = element(["0", "1", "1.0000000001", "1.001", "-0", "NaN", "2"])

/** At most six rows over four keys: enough for a key repeated on a side, a key on one side only and a key on both. */
export const keyedRowsGen: Gen<KeyedRows> = array(
	(source) => [source.draw(element(keys)), source.draw(valueGen)] as const,
	{ min: 0, max: 6 }
)

export const valuesOf = (rows: KeyedRows, key: string): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(rows, ([k]) => k === key),
		([, v]) => v
	)

export const close = (a: string, b: string, tolerance: number): boolean =>
	a === b || Math.abs(Number(a) - Number(b)) <= tolerance

export type WithinFeature =
	| "repeated key left"
	| "repeated key right"
	| "key only left"
	| "key only right"
	| "difference above tolerance"
	| "agree within tolerance"
	| "agree exactly"

interface Delivered {
	readonly id: bigint
	readonly xs: ReadonlyArray<number>
}

export type DeliveredFeature =
	| "permutation"
	| "nested permutation"
	| "changed field"
	| "repeated row"
	| "repeated nested item"

export const sameOrder = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
	a.length === b.length && Arr.every(a, (x, i) => x === b[i])

/** At least one row, distinct by construction, each with its own id, and nested arrays that repeat no item. */
export const rowsGen: Gen<ReadonlyArray<Delivered>> = map(
	array(shuffled([0, 1, 2], { min: 0, max: 3 }), { min: 1, max: 5 }),
	(arrays) => Arr.map(arrays, (xs, i): Delivered => ({ id: BigInt(i), xs }))
)
