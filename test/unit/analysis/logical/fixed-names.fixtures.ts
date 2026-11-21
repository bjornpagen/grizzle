/** What fixed-names.test.ts reads: its schema and the query of a case, a chain of equalities naming its columns. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { succeeded } from "#test/support/assert.ts"
import { checkOptions, checking } from "#test/support/policy.ts"

const R = relation("R", { a: pg.bigint, b: pg.bigint, c: pg.bigint, d: pg.bigint }, ["a"])
const Chains = schema("Chains", [R], [])

/** A case: how many equalities chain the columns, a to b and on, and how many parameters name the chain's columns too. */
export interface Chain {
	readonly links: number
	readonly names: number
}

export const chainGen: Gen<Chain> = (source) => ({
	links: source.draw(int(1, 3)),
	names: source.draw(int(0, 2))
})

/**
 * The case's query over R: its columns a, b, c and d, each of the first `links` equal to the next, the last of them a
 * constant, and each of the first `names` of them, from the last back, also a parameter of its own.
 */
export const chainQuery = (chain: Chain): LogicalQuery => {
	const q = query(Chains).rule((r) => {
		const vars = v(R, "r")
		const [first, ...rest] = [vars.a, vars.b, vars.c, vars.d]
		const chained = Arr.prepend(rest.slice(0, chain.links), first)
		const linked = Arr.reduce(Arr.zip(chained, chained.slice(1)), r.match(R, vars), (m, [x, y]) =>
			m.where(r.eq(x, y))
		)
		const constant = linked.where(r.eq(Arr.lastNonEmpty(chained), 5n))
		const named = Arr.reduce(Arr.reverse(chained).slice(0, chain.names), constant, (m, column, j) =>
			m.where(r.eq(column, r.param(`p${j}`, pg.bigint)))
		)
		return named.find(vars)
	})
	const desc = queryValueDesc(q)
	if (desc === undefined) {
		throw new Error("a chain's query is a query value")
	}
	return succeeded(checkQuery(checking(Chains), desc, checkOptions("query")))
}
