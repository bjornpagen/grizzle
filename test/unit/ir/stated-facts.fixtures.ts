/** What stated-facts.test.ts reads: an installation's closed facts, and the closed reads a caller's DAGs make of them. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ClosedFacts } from "#compiler/ir/dag.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { scalarTypes } from "#test/support/unit/ir/fixture.ts"

/** A closed relation's facts keyed by k: each row k and its payloads, `rows` of them. */
const factsOf = (
	payloads: ReadonlyArray<string>,
	rows: number,
	cell: (row: number, payload: number) => TypedLiteral
): ClosedFacts => ({
	relation: { primaryFields: [{ name: "k" }] },
	heading: [
		{ name: "k", type: scalarTypes.int4 },
		...Arr.map(payloads, (name): HeadingColumn => ({ name, type: scalarTypes.text }))
	],
	rows: Array.from({ length: rows }, (_, row) => [
		{ kind: "int", value: BigInt(row) },
		...Arr.map(payloads, (_, payload) => cell(row, payload))
	])
})

/** An installation's closed facts: R keyed by k with payloads a and b, S keyed by k with payload v. */
export const closedFacts = (rows: number): ReadonlyMap<string, ClosedFacts> =>
	new Map([
		[
			"R",
			factsOf(["a", "b"], rows, (row, payload) => ({ kind: "text", value: `r${row}.${payload}` }))
		],
		["S", factsOf(["v"], rows, (row) => ({ kind: "text", value: `s${row}` }))]
	])

/** A closed read a DAG makes: its relation, and the payload it names (C.at's one field), or none (C.has, C.row). */
export interface ClosedRead {
	readonly relation: string
	readonly payload: ReadonlyArray<string>
}

/** The closed reads one closed relation admits: its key set, or each payload field. */
const reads: readonly [ClosedRead, ...Array<ClosedRead>] = [
	{ relation: "R", payload: [] },
	{ relation: "R", payload: ["a"] },
	{ relation: "R", payload: ["b"] },
	{ relation: "S", payload: [] },
	{ relation: "S", payload: ["v"] }
]

/** The rows of each closed relation, and the closed reads a caller's DAGs make, in order, many reading alike. */
export const statedGen: Gen<readonly [number, ReadonlyArray<ClosedRead>]> = (source) =>
	[source.draw(int(0, 12)), source.draw(array(element(reads), { min: 1, max: 24 }))] as const

/** The key a read is one of (relation and payload), the distinct reads of a list counted by it. */
export const readKey = (read: ClosedRead): string => jsonText([read.relation, read.payload])
