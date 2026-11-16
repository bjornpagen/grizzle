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

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { byteaArray } from "#compiler/codec/bytea.ts"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { assert, defined } from "#test/support/assert.ts"
import { arraysOf, cases, type Feature, readArray } from "#test/unit/codec/bytea.fixtures.ts"

/**
 * A bytes column's binary array holds each value as admitted, and refuses an array a caller changed since admission.
 *
 * Budget: its suite's count before the conversion (unit/codec/bytea: 200 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const aBytesColumnsBinaryArrayHoldsEachValueAsAdmittedAndRefusesAnArrayACallerChangedSinceAdmission =
	property.explore(cases, {
		needs: {},
		situations: [
			"no value",
			"a value its caller left alone",
			"a byte changed",
			"a byte written as it was",
			"a buffer detached",
			"two values of one array"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (values) =>
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
						a.buffer.detached || a.length !== was.length || a.some((byte, at) => byte !== was[at])
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
			}),
		oracle: { kind: "second-implementation", name: "the array binary format read back" },
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/bytea.ts",
				original:
					'\t\tif (sha256Hex(out.subarray(at, at + n)) !== value.digest) {\n\t\t\treturn Result.err(encodeFailure("bytesChanged", slotPlace(input)))\n\t\t}\n',
				replacement: "",
				why: "The copy is written without its digest checked, so a value whose bytes changed since admission is written rather than refused as bytesChanged."
			}
		]
	})
