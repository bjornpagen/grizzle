/** What fixed-names.test.ts reads: its schema and the query of a case, a chain of equalities naming its columns. */

import { defined } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
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

/**
 * A query over a relation of m columns, c0 to c(m − 1), each equal to the next and each a parameter of its own: every
 * column holds every parameter's name, each reached through the equalities from its own column, so a column is offered
 * each of m names by each equality it is read through.
 */
export const namedChainQuery = (m: number): LogicalQuery => {
	const columns = Array.from({ length: m }, (_, i) => `c${i}`)
	const W = relation("W", Rec.fromEntries(Arr.map(columns, (c) => [c, pg.bigint] as const)), ["c0"])
	const Named = schema("Named", [W], [])
	const q = query(Named).rule((r) => {
		const vars = v(W, "w")
		const at = (c: string) => defined(vars[c], "a column's variable")
		const linked = Arr.reduce(
			Arr.zip(columns, columns.slice(1)),
			r.match(W, vars),
			(match, [x, y]) => match.where(r.eq(at(x), at(y)))
		)
		const named = Arr.reduce(columns, linked, (match, c, j) =>
			match.where(r.eq(at(c), r.param(`p${j}`, pg.bigint)))
		)
		return named.find(vars)
	})
	const desc = queryValueDesc(q)
	if (desc === undefined) {
		throw new Error("a named chain's query is a query value")
	}
	return succeeded(checkQuery(checking(Named), desc, checkOptions("query")))
}
