/** What the properties of bytes-memory.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { bindFrame } from "#adapter/wire/batch.ts"
import { byteaElementBytes, byteaHeaderBytes } from "#compiler/codec/bytea.ts"
import { bytea, int4 } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { inForce, type Transport } from "#compiler/runtime/write/transport.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"

/** The one value every fact of a case holds: 1 MiB. */
export const valueLength = 1024 * 1024

/**
 * The transport the cases bind under: the one in force (runtime/write/transport.ts inForce) but for its message, which
 * holds sixteen values, so sixteen facts of one column pass it, as sixteen of 64 MiB pass PostgreSQL's longest
 * message. The bound is the transport's, read by every check of a member's bytes (runtime/write/normalize.ts), so a
 * case copies at most one such message, 16 MiB, where at PostgreSQL's own a bound member copied up to 960 MiB.
 */
export const transport: Transport = { ...inForce(bindFrame), messageBytes: 16 * valueLength }

export const One = relation("One", { id: int4, body: bytea }, ["id"])

export const Two = relation("Two", { id: int4, body: bytea, more: bytea }, ["id"])

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
	const { frame } = transport
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
	carried(d) > transport.messageBytes ? "a member refused from its lengths" : "a member bound",
	...(d.columns === 2 ? (["two bytes columns"] as const) : [])
]

export const reality = realityWrite(succeeded(testArtifacts(Large, testCompile)))

/** What the search built once before its cases (value), now once per worker: every case on it reads them. */
export const valueNeed = {
	key: "test/unit/write/bytes-memory.fixtures.ts valueNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const value = new Uint8Array(valueLength).fill(7)
		return Effect.succeed(value)
	})
} as const satisfies Need<unknown>
