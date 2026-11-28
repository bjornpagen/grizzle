/** What the property of fact-sets.test.ts reads: its observers, the case each builds and the count it must deliver. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { floatLiteral } from "#compiler/ir/carriers.ts"
import { conservativeMeta, type Heading, type RelNode } from "#compiler/ir/rel.ts"
import { countOverload } from "#compiler/scalar/aggregate.ts"
import { asc } from "#test/support/fixtures/ir/build.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { float4, float8, int4 } from "#test/support/oracle/gen/domain.ts"
import type { LiteralRow } from "#test/support/oracle/gen/facts.ts"
import { normalQuery } from "#test/support/oracle/gen/query.ts"
import { Q } from "#test/support/unit/lower/conservative/fixtures.ts"

/**
 * An observer of a relation parameter's facts read whole by a region: a count of them grouped by n, a bound of them,
 * or the program's result delivering them.
 */
export type Observer = "count" | "take" | "result"

export const observers = ["count", "take", "result"] as const satisfies ReadonlyArray<Observer>

/** A real column's carrier: real or double precision. */
export type Carrier = "float4" | "float8"

/** One case: an observer over a relation parameter of a real column x and an int4 column n. */
export interface FactSetCase {
	readonly observer: Observer
	readonly carrier: Carrier
}

export const factSetCaseGen: Gen<FactSetCase> = (source) => ({
	observer: source.draw(element(observers)),
	carrier: source.draw(element(["float4", "float8"] as const))
})

/** The parameter's facts: (0, 1) and (-0, 1), two facts by their identity, natively equal. */
const facts: ReadonlyArray<LiteralRow> = [
	[floatLiteral(0), { kind: "int", value: 1n }],
	[floatLiteral(-0), { kind: "int", value: 1n }]
]

/**
 * The case of `c`: its observer over a region binding x and n of the relation parameter p, which holds (0, 1) and
 * (-0, 1); a schema of one relation it never reads.
 */
export const factSetCase = (c: FactSetCase): QueryCase => {
	const q = new Q()
	const heading: Heading = [
		{ name: "x", type: c.carrier === "float4" ? float4 : float8 },
		{ name: "n", type: int4 }
	]
	const region = q.region([
		{ source: q.input("p", heading), bind: { x: "x", n: "n" }, constants: {} }
	])
	const root = ((): RelNode => {
		switch (c.observer) {
			case "count": {
				const count = countOverload()
				return q.group(
					region,
					["x", "n"],
					["n"],
					[{ name: "c", fn: "count", op: count.op, args: [], type: count.result }],
					conservativeMeta
				)
			}
			case "take":
				return q.take(region, asc("x", "n"), { kind: "literal", k: 2n }, [], conservativeMeta)
			case "result":
				return region
		}
	})()
	return {
		schema: {
			name: "FactSets",
			relations: [
				{
					name: "R0",
					columns: [{ name: "a", type: int4 }],
					primaryKey: ["a"],
					keys: [],
					mutable: false
				}
			],
			closed: [],
			containments: []
		},
		facts: { R0: [] },
		query: {
			dag: normalQuery(q.build(root).dag),
			params: { p: { kind: "relation", heading, rows: facts } }
		},
		spelling: { mode: "drawn", edge: false }
	}
}

/**
 * The rows both lowerings deliver of a case, where its facts decide them: the count of both facts, one row of 2; both
 * facts as the result's two rows. A bound decides by its own duplicate elimination, which both lowerings place before
 * the LIMIT under PostgreSQL's equality, so only their agreement is asked of it.
 */
export const deliveredRows = (
	observer: Observer
): ReadonlyArray<ReadonlyArray<string>> | undefined => {
	switch (observer) {
		case "count":
			return [["1", "2"]]
		case "result":
			return [
				["0", "1"],
				["-0", "1"]
			]
		case "take":
			return undefined
	}
}
