/** What the properties of bytea.test.ts read: its spaces, models and helpers. */

import { array, constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { readArrayBinary } from "#test/support/arrays.ts"
import { assert, defined } from "#test/support/assert.ts"

/** What a case does to one value's array after admission. */
type Touch = "none" | "a byte changed" | "a byte written as it was" | "its buffer detached"

/** A value: its bytes, the earlier value whose array it shares when it shares one, and what is done to it. */
interface Value {
	readonly bytes: ReadonlyArray<number>
	readonly shares: number | undefined
	readonly touch: Touch
	readonly at: number
}

const value =
	(index: number): Gen<Value> =>
	(s) => ({
		bytes: s.draw(array(int(0, 255), { min: 0, max: 6 })),
		shares:
			index > 0 &&
			s.draw(
				weighted([
					[2, constant(false)],
					[1, constant(true)]
				])
			)
				? s.draw(int(0, index - 1))
				: undefined,
		touch: s.draw(
			weighted([
				[2, constant("none" as const)],
				[1, constant("a byte changed" as const)],
				[1, constant("a byte written as it was" as const)],
				[1, constant("its buffer detached" as const)]
			])
		),
		at: s.draw(int(0, 5))
	})

export const cases: Gen<ReadonlyArray<Value>> = (s) => {
	const count = s.draw(int(0, 5))
	const out: Array<Value> = []
	for (let i = 0; i < count; i += 1) {
		out.push(s.draw(value(i)))
	}
	return out
}

export type Feature =
	| "no value"
	| "a value its caller left alone"
	| "a byte changed"
	| "a byte written as it was"
	| "a buffer detached"
	| "two values of one array"

/** The values' arrays: each its own, or the one an earlier value holds, as a caller hands them over. */
export const arraysOf = (values: ReadonlyArray<Value>): ReadonlyArray<Uint8Array<ArrayBuffer>> => {
	const out: Array<Uint8Array<ArrayBuffer>> = []
	for (const v of values) {
		out.push(
			v.shares === undefined ? Uint8Array.from(v.bytes) : defined(out[v.shares], "an earlier array")
		)
	}
	return out
}

/** A bytea[] as array_recv reads it (readArrayBinary): its elements' bytes, under bytea's element type, none NULL. */
export const readArray = (out: Uint8Array): ReadonlyArray<ReadonlyArray<number>> => {
	const array = readArrayBinary(out)
	assert.equal(array.flags, 0, "no NULL flag")
	assert.equal(array.elementType, 17, "element type bytea")
	assert.equal(array.lowerBound, 1, "lower bound 1")
	return Arr.map(array.elements, (e) => (e === null ? assert.fail("a NULL element") : [...e]))
}
