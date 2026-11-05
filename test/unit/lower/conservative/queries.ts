import type { LogicalQuery } from "#compiler/ir/products.ts"
import { uuidOf } from "#test/unit/lower/conservative/fixtures.ts"

/**
 * The conservative lowering's test queries over the ledger fixture, with the facts the pg tests load and the rows the
 * language's semantics give for them. Each query states the shape a checked rule produces; the expected rows are
 * worked out by hand from the facts below, so the PostgreSQL run checks the lowering against the meaning, not against
 * itself.
 */

export const A = uuidOf(0x1001)
export const B = uuidOf(0x1002)
export const C = uuidOf(0x1003)
const p = (n: number) => uuidOf(0x2000 + n)
const t = (n: number) => uuidOf(0x3000 + n)

/** Facts, as SQL literals per column of each relation, in heading order. */
export const facts: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = {
	Posting: [
		[p(1), A, "100"],
		[p(2), A, "100"],
		[p(3), B, "50"],
		[p(4), B, "70"]
	],
	Account: [
		[A, "alpha"],
		[B, "beta"],
		[C, "gamma"]
	],
	Task: [
		[t(1), A, "Automatic", "10"],
		[t(2), A, "Manual", "20"],
		[t(3), B, "Automatic", "30"],
		[t(4), B, "Automatic", "40"],
		[t(5), A, "Automatic", "50"]
	],
	Edge: [
		["1", "2"],
		["2", "3"],
		["1", "3"],
		["3", "1"],
		["4", "5"]
	],
	Reading: [
		["1", "NaN", "1.0", "1.50", "true"],
		["2", "-0", "1.00", "2.00", "false"],
		["3", "0", "2.5", "1.50", "true"],
		["4", "NaN", "2.50", "0.10", "true"]
	]
}

/** A hand-built query over the ledger fixtures, by name. */
export interface LoweringCase {
	readonly name: string
	readonly query: LogicalQuery
}
