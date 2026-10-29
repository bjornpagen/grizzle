import type { CompileReasonTag } from "#compiler/core/errors.ts"
import { assert, contains, containsText, like } from "#test/support/assert.ts"

import { regex } from "arkregex"
/**
 * The assertion door's types (test/support/assert.ts): every equality takes its expected value at the actual value's
 * type, so an expected literal that drifted from that type is a compile error, never a run-time mismatch; a string is
 * text, never a collection; a failure check is a predicate or a class, never a message pattern. Typechecked, never
 * executed.
 */
declare const reason: CompileReasonTag
declare const rows: ReadonlyArray<{ readonly id: string; readonly loc: { readonly line: number } }>
declare const row: { readonly id: string; readonly loc: { readonly line: number } }

export const admitted = (): void => {
	assert.equal(reason, "MalformedDescription")
	assert.deepEqual(rows, [{ id: "a", loc: { line: 1 } }])
	containsText("haystack", "hay")
	contains(["a"], "a")
}

export const refusals = (): void => {
	// @ts-expect-error -- TS2345: a word outside CompileReasonTag
	assert.equal(reason, "MalformedDescriptionX")
	// @ts-expect-error -- TS2741: an expected row without the loc the actual carries
	assert.deepEqual(rows, [{ id: "a" }])
	// @ts-expect-error -- TS2345: a string is no collection: containsText reads text
	contains("haystack", "hay")
	// @ts-expect-error -- TS2345: a message pattern is no failure check
	assert.throws(() => undefined, regex("boom"))
	// @ts-expect-error -- TS2353: a field the actual lacks
	like(row, { id: "a", loc: { line: 1 }, extra: 1 })
}
