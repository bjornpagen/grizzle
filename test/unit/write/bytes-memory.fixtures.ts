/** What the properties of bytes-memory.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { bindFrame } from "#adapter/wire/batch.ts"
import { byteaElementBytes, byteaHeaderBytes } from "#compiler/codec/bytea.ts"
import { messageMaxBytes } from "#compiler/core/wire.ts"
import { bytes, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"

/** The one value every fact of a case holds: 64 MiB, so sixteen facts of one column pass a message. */
export const valueLength = 64 * 1024 * 1024

export const One = relation("One", { id: pg.integer, body: bytes }, ["id"])

export const Two = relation("Two", { id: pg.integer, body: bytes, more: bytes }, ["id"])

export const Large = schema("BytesMemory", [One, Two], [])

/** A case: the relation written, by its bytes columns, and how many facts the member holds. */
interface Drawn {
	readonly columns: 1 | 2
	readonly facts: number
}

export const cases: Gen<Drawn> = (s) => {
	const columns = s.draw(element([1, 2] as const))
	return { columns, facts: s.draw(int(1, columns === 1 ? 20 : 10)) }
}

export type Feature = "a member refused from its lengths" | "a member bound" | "two bytes columns"

/** The bytes the member's write statement carries at least: its fixed fields, its placeholders, its binary arrays. */
export const carried = (d: Drawn): number => {
	const frame = bindFrame
	const array = byteaHeaderBytes(d.facts) + d.facts * byteaElementBytes(valueLength)
	return frame.statement + (d.columns + 1) * frame.parameter + d.columns * array
}

/** The binary arrays' bytes a bound member holds: one copy of every value. */
export const copied = (d: Drawn): number => d.columns * d.facts * valueLength

/**
 * What the bind may allocate beside its one copy of every value (texts, maps, the process's own churn): less than one
 * value's length, the least a second copy of any value allocates.
 */
export const slack = valueLength

export const notes = (d: Drawn): ReadonlyArray<Feature> => [
	carried(d) > messageMaxBytes ? "a member refused from its lengths" : "a member bound",
	...(d.columns === 2 ? (["two bytes columns"] as const) : [])
]

export const reality = realityWrite(succeeded(testArtifacts(Large, testCompile)))

/** What the search built once before its cases (value), now once per worker: every case on it reads them. */
export const valueNeed = {
	key: "test/unit/write/bytes-memory.fixtures.ts valueNeed",
	open: Effect.sync(() => {
		const value = new Uint8Array(valueLength).fill(7)
		return Effect.succeed(value)
	})
} as const satisfies Need<unknown>
