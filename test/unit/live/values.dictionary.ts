/** The closed roster values.test.ts exhausts: every form a key value takes. */

import { dictionary } from "@bjornpagen/testing/dictionary"
import { Numeric } from "#compiler/scalar/values/decimal.ts"

/**
 * Values of every form a key takes, each a maker with its key class, PostgreSQL's equality, and its delivery,
 * Object.is on primitives: ±0 one key of two deliveries, a Numeric one value however written.
 */
export const forms = dictionary<{
	readonly key: number
	readonly delivery: number
	readonly make: () => unknown
}>([
	{ key: 0, delivery: 0, make: () => 0 },
	{ key: 0, delivery: 1, make: () => -0 },
	{ key: 1, delivery: 2, make: () => Number.NaN },
	{ key: 1, delivery: 2, make: () => Number.parseFloat("x") },
	{ key: 2, delivery: 3, make: () => 1 },
	{ key: 3, delivery: 4, make: () => 1n },
	{ key: 4, delivery: 5, make: () => "1" },
	{ key: 5, delivery: 6, make: () => true },
	{ key: 6, delivery: 7, make: () => Numeric.of("1.5") },
	{ key: 6, delivery: 7, make: () => Numeric.of("1.50") },
	{ key: 7, delivery: 8, make: () => Numeric.of("15") },
	{ key: 8, delivery: 9, make: () => ({ start: 1, end: 2 }) },
	{ key: 9, delivery: 10, make: () => ({ start: 1, end: 3 }) },
	{ key: 10, delivery: 11, make: () => new Set(["x", "y"]) },
	{ key: 11, delivery: 12, make: () => new Set(["x"]) },
	{ key: 12, delivery: 13, make: () => Uint8Array.of(1, 2) },
	{ key: 13, delivery: 14, make: () => Float32Array.of(1, 2) },
	{ key: 14, delivery: 15, make: () => [1, 2] },
	{ key: 15, delivery: 16, make: () => [[1], 2] },
	{ key: 16, delivery: 17, make: () => ({ a: 1 }) },
	{ key: 17, delivery: 18, make: () => ["a", 1] }
])
