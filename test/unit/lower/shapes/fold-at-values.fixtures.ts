/** What fold-at-values.test.ts reads: its schema, its box and the optimized statements of a case's read. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"

/** Which component supports which pair of standards' ends, as learning-commons' Supports holds them. */
const Supports = relation(
	"Supports",
	{ state: pg.integer, hub: pg.integer, component: pg.integer },
	["state", "hub", "component"]
)
const Crosswalks = schema("FoldAtValues", [Supports], [])

/** Every pair of ends with how many components support it: one fold of Supports by its two ends. */
const crosswalk = query(Crosswalks).rule((r) => {
	const { state, hub, component } = v(Supports, "support")
	return r.match(Supports, { state, hub, component }).find({ state, hub, n: r.count() })
})

/**
 * How the read's rules read the fold: two rules, one at the asked state and one at the asked hub, each a grouping
 * column at the parameter; or one rule at the asked state, the fold read once.
 */
export type Rules = "two rules, a state's and a hub's" | "one rule, a state's"

export interface Box {
	readonly rules: Rules
}

export const boxGen: Gen<Box> = element<Box>([
	{ rules: "two rules, a state's and a hub's" },
	{ rules: "one rule, a state's" }
])

/** The pairs at the asked end: the state's, and where the box has two rules, the hub's too. */
const readOf = (box: Box) => {
	const atState = query(Crosswalks).rule((r) => {
		const { state, hub, n } = v(crosswalk, "pair")
		return r
			.match(crosswalk, { state, hub, n })
			.where(r.eq(state, r.param("end", pg.integer)))
			.find({ state, hub, n })
	})
	switch (box.rules) {
		case "one rule, a state's":
			return atState
		case "two rules, a state's and a hub's":
			return atState.rule((r) => {
				const { state, hub, n } = v(crosswalk, "pair")
				return r
					.match(crosswalk, { state, hub, n })
					.where(r.eq(hub, r.param("end", pg.integer)))
					.find({ state, hub, n })
			})
	}
}

/** The optimized statements of the case's read, their texts joined. */
export const optimizedOf = (box: Box): string =>
	Arr.join(
		Arr.map(
			succeeded(compileTemplate(readOf(box), undefined, testCompile), "the case's read compiles")
				.optimized,
			(s) => s.sql
		),
		"\n"
	)

/** How many times `sql` scans Supports, the fold's input. */
export const supportScans = (sql: string): number =>
	Str.split('"fold_at_values"."supports" AS')(sql).length - 1

/**
 * How many MATERIALIZED CTEs of `sql` hold the whole fold: a body that groups and keeps every row, no WHERE in it, each
 * body the text from its `AS MATERIALIZED (` to the line that closes it.
 */
export const wholeFoldCtes = (sql: string): number =>
	Arr.filter(Arr.drop(Str.split("AS MATERIALIZED (")(sql), 1), (rest) => {
		const [body] = Str.split("\n)")(rest)
		return Str.includes("GROUP BY")(body) && !Str.includes("WHERE")(body)
	}).length
