/**
 * A bytes column's binary array (codec/bytea.ts byteaArray) over admitted values whose callers may change them after
 * admission: each value is copied once into the array from its caller's array, and the copy is checked against the
 * digest worked out at admission, so the array is written exactly when no value changed, its bytes, its length or its
 * buffer, detached since, and is refused as bytesChanged otherwise. A case admits a few short values, some sharing one array, then writes into some
 * of them, a byte changed or a byte written as it was, or detaches one's buffer, and writes the array.
 *
 * Oracle: the array binary format read back by a second reader (array_recv's layout: dimensions, flags, element type,
 * then each dimension's length and lower bound, then each element's length and bytes), and the values as admitted.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { byteaArray } from "#compiler/codec/bytea.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

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
			index > 0 && s.draw(element([false, false, true] as const))
				? s.draw(int(0, index - 1))
				: undefined,
		touch: s.draw(
			element([
				"none",
				"none",
				"a byte changed",
				"a byte written as it was",
				"its buffer detached"
			] as const)
		),
		at: s.draw(int(0, 5))
	})

const cases: Gen<ReadonlyArray<Value>> = (s) => {
	const count = s.draw(int(0, 5))
	const out: Array<Value> = []
	for (let i = 0; i < count; i += 1) {
		out.push(s.draw(value(i)))
	}
	return out
}

type Feature =
	| "no value"
	| "a value its caller left alone"
	| "a byte changed"
	| "a byte written as it was"
	| "a buffer detached"
	| "two values of one array"

/** The values' arrays: each its own, or the one an earlier value holds, as a caller hands them over. */
const arraysOf = (values: ReadonlyArray<Value>): ReadonlyArray<Uint8Array<ArrayBuffer>> => {
	const out: Array<Uint8Array<ArrayBuffer>> = []
	for (const v of values) {
		out.push(
			v.shares === undefined ? Uint8Array.from(v.bytes) : defined(out[v.shares], "an earlier array")
		)
	}
	return out
}

/** Reads a one-dimensional bytea[] in the array binary format, or none of no dimension: its elements' bytes. */
const readArray = (out: Uint8Array): ReadonlyArray<ReadonlyArray<number>> => {
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
	let at = 0
	const field = (): number => {
		const n = view.getInt32(at)
		at += 4
		return n
	}
	const dimensions = field()
	assert.equal(field(), 0, "no NULL flag")
	assert.equal(field(), 17, "element type bytea")
	if (dimensions === 0) {
		assert.equal(at, out.length, "an empty array is its header alone")
		return []
	}
	assert.equal(dimensions, 1, "one dimension")
	const count = field()
	assert.equal(field(), 1, "lower bound 1")
	const elements: Array<ReadonlyArray<number>> = []
	for (let i = 0; i < count; i += 1) {
		const n = field()
		elements.push([...out.subarray(at, at + n)])
		at += n
	}
	assert.equal(at, out.length, "the array ends with its last element")
	return elements
}

describe("a bytes column's binary array", () => {
	it.effect(
		"holds each value as admitted, and refuses an array a caller changed since admission",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/codec/bytea",
						oracle: { kind: "second-implementation", name: "the array binary format read back" },
						draw: drawn(cases),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"no value",
								"a value its caller left alone",
								"a byte changed",
								"a byte written as it was",
								"a buffer detached",
								"two values of one array"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(values, c) =>
						Effect.sync(() => {
							const arrays = arraysOf(values)
							const admitted = Arr.map(arrays, (a) => new AdmittedBytes(a))
							const before = Arr.map(arrays, (a) => [...a])
							if (values.length === 0) {
								c.note("no value")
							}
							for (const [i, v] of values.entries()) {
								const a = defined(arrays[i], "each value's array")
								if (v.shares !== undefined) {
									c.note("two values of one array")
								}
								if (v.touch === "none" || (v.touch !== "its buffer detached" && a.length === 0)) {
									c.note("a value its caller left alone")
									continue
								}
								if (v.touch === "its buffer detached") {
									if (!a.buffer.detached) {
										a.buffer.transfer()
									}
									c.note("a buffer detached")
									continue
								}
								const at = v.at % a.length
								const old = defined(a[at], "a byte of the value")
								a[at] = v.touch === "a byte changed" ? (old + 1) & 0xff : old
								c.note(v.touch)
							}
							const changed = Arr.some(arrays, (a, i) => {
								const was = defined(before[i], "each value as admitted")
								return (
									a.buffer.detached ||
									a.length !== was.length ||
									a.some((byte, at) => byte !== was[at])
								)
							})
							const written = byteaArray("Input", "body", admitted)
							if (changed) {
								assert.ok(
									!written.ok && written.error._tag === "EncodingFailure",
									"an array a caller changed since admission is refused"
								)
								assert.equal(written.error.reason._tag, "bytesChanged", "as bytesChanged")
								return
							}
							assert.ok(written.ok, "an array no caller changed is written")
							assert.deepEqual(readArray(written.value), before, "each value as admitted, in order")
						})
				)
			)
	)
})
