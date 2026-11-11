/**
 * A bytes column's binary array (codec/bytea.ts byteaArray) over admitted values whose callers may change them after
 * admission: each value is copied once into the array from its caller's array, and the copy is checked against the
 * digest worked out at admission, so the array is written exactly when no value changed, its bytes, its length or its
 * buffer, detached since, and is refused as bytesChanged otherwise. A case admits a few short values, some sharing one array, then writes into some
 * of them, a byte changed or a byte written as it was, or detaches one's buffer, and writes the array.
 *
 * Oracle: the array binary format read back by a second reader (array_recv's layout: dimensions, flags, element type,
 * then each dimension's length and lower bound, then each element's length and bytes), and the values as admitted.
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): bytea-digest-unchecked (the copy written without its digest checked).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { byteaArray } from "#compiler/codec/bytea.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { readArrayBinary } from "#test/support/arrays.ts"
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

/** A bytea[] as array_recv reads it (readArrayBinary): its elements' bytes, under bytea's element type, none NULL. */
const readArray = (out: Uint8Array): ReadonlyArray<ReadonlyArray<number>> => {
	const array = readArrayBinary(out)
	assert.equal(array.flags, 0, "no NULL flag")
	assert.equal(array.elementType, 17, "element type bytea")
	assert.equal(array.lowerBound, 1, "lower bound 1")
	return Arr.map(array.elements, (e) => (e === null ? assert.fail("a NULL element") : [...e]))
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
