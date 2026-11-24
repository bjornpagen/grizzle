/** What navigation-extent.test.ts reads: its space, its query of an import read more than once, and its navigations. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter } from "effect"
import { queryColumns } from "#compiler/analysis/theory/columns.ts"
import { Navigation, navigateQuery, type RegionExtent } from "#compiler/analysis/theory/navigate.ts"
import { buildTheory } from "#compiler/analysis/theory/theory.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { descIdentity, type InferredQuery } from "#compiler/ir/desc.ts"
import { queryInput } from "#compiler/program/input.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { checking } from "#test/support/policy.ts"

/**
 * One case: a rule over BV's rows reading an import `reads` times, each read at the value the one before it bound, the
 * import of one rule (a named attribute of a node, a join of two stored relations, as qti's declared names are) or of
 * two (a union of attributes of two names), navigated over the region `extent` holds.
 */
export interface Extent {
	readonly reads: 2 | 3
	readonly import: "one rule" | "a union"
	readonly extent: RegionExtent
}

export const extentGen: Gen<Extent> = (s) => ({
	reads: s.draw(element<Extent["reads"]>([2, 3])),
	import: s.draw(element<Extent["import"]>(["one rule", "a union"])),
	extent: s.draw(element<RegionExtent>(["units", "every"]))
})

export type Reached =
	| "an import of one rule over the units"
	| "an import of one rule over every row"
	| "a union over the units"
	| "a union over every row"
	| "an import read three times"

const Node = relation("Node", { doc: pg.integer, start: pg.integer, kind: pg.integer }, [
	"doc",
	"start"
])
const Attr = relation(
	"Attr",
	{ doc: pg.integer, start: pg.integer, name: pg.integer, value: pg.integer },
	["doc", "start", "name"]
)
const BV = relation("BV", { doc: pg.integer, start: pg.integer, attribute: pg.integer }, [
	"doc",
	"start"
])
const Base = schema("navigation_extent", [Node, Attr, BV], [])

/** The named attribute of a node: an import of one rule, a join of Attr and Node. */
const named = query(Base).rule((r) => {
	const { doc, start, value } = v(Attr, "a")
	const { kind } = v(Node, "n")
	return r
		.match(Attr, { doc, start, name: 7, value })
		.match(Node, { doc, start, kind })
		.find({ doc, start, value, kind })
})

/** The attributes of two names, each beside its node: an import of two rules. */
const either = query(Base)
	.rule((r) => {
		const { doc, start, value } = v(Attr, "a")
		const { kind } = v(Node, "n")
		return r
			.match(Attr, { doc, start, name: 7, value })
			.match(Node, { doc, start, kind })
			.find({ doc, start, value, kind })
	})
	.rule((r) => {
		const { doc, start, value } = v(Attr, "a")
		const { kind } = v(Node, "n")
		return r
			.match(Attr, { doc, start, name: 8, value })
			.match(Node, { doc, start, kind })
			.find({ doc, start, value, kind })
	})

/** The case's query: BV's rows, each attribute read from the one before, the import read `reads` times. */
const queryOf = (c: Extent): InferredQuery => {
	const imported = c.import === "one rule" ? named : either
	const twice = query(Base).rule((r) => {
		const { doc, start: s, attribute: a } = v(BV, "b")
		const { value: x } = v(imported, "x")
		const { value: y } = v(imported, "y")
		return r
			.match(BV, { doc, start: s, attribute: a })
			.match(imported, { doc, start: a, value: x, kind: 1 })
			.match(imported, { doc, start: x, value: y, kind: 2 })
			.find({ doc, s, last: y })
	})
	const thrice = query(Base).rule((r) => {
		const { doc, start: s, attribute: a } = v(BV, "b")
		const { value: x } = v(imported, "x")
		const { value: y } = v(imported, "y")
		const { value: z } = v(imported, "z")
		return r
			.match(BV, { doc, start: s, attribute: a })
			.match(imported, { doc, start: a, value: x, kind: 1 })
			.match(imported, { doc, start: x, value: y, kind: 2 })
			.match(imported, { doc, start: y, value: z, kind: 3 })
			.find({ doc, s, last: z })
	})
	return succeeded(queryInput(c.reads === 2 ? twice : thrice)).desc
}

const loc = SourceLoc("navigation extent", [])
const columns = queryColumns(checking(Base), loc)

/** The containments Base's theory holds, which order a chain (analysis/theory/navigate.ts Navigation `within`). */
const facts = succeeded(buildTheory(checking(Base))).regionFacts

/** The reads of an import a navigated query keeps, each a match of a query source, at any depth. */
const importReads = (q: InferredQuery): number =>
	q.stage.kind === "rules"
		? Arr.reduce(q.stage.arms, 0, (n, rule) =>
				Arr.reduce(rule.matches, n, (m, match) =>
					match.source.kind === "query"
						? m + 1 + importReads(match.source.query)
						: match.source.kind === "step"
							? m + importReads(match.source.query)
							: m
				)
			)
		: 0

/**
 * Judges case `c`: over the units, the import of one rule is read at each read, a step of the chain, and no read of it
 * stays whole; over every row it stays whole at every read; and a union stays whole over either.
 */
export const navigatedOver = (c: Extent, note: (r: Reached) => void): void => {
	const navigated = navigateQuery(
		queryOf(c),
		loc,
		columns,
		{ kind: "perStatement", extent: c.extent },
		new Navigation(facts)
	)
	note(
		c.import === "one rule"
			? c.extent === "units"
				? "an import of one rule over the units"
				: "an import of one rule over every row"
			: c.extent === "units"
				? "a union over the units"
				: "a union over every row"
	)
	if (c.reads === 3) {
		note("an import read three times")
	}
	const kept = importReads(navigated)
	const expected = c.import === "one rule" && c.extent === "units" ? 0 : c.reads
	assert.equal(
		kept,
		expected,
		`${Formatter.format(c)}: the navigation keeps ${kept} reads of the import whole, where it keeps ${expected}`
	)
}

/** The reads of the import of one rule, under the units first or every row first: a case of the shared navigation. */
export interface Together {
	readonly reads: 2 | 3
	readonly unitsFirst: boolean
}

export const togetherGen: Gen<Together> = (s) => ({
	reads: s.draw(element<Together["reads"]>([2, 3])),
	unitsFirst: s.draw(element([true, false] as const))
})

/** The navigation of the case's query over `extent` in `navigation`, by its identity (ir/desc.ts descIdentity). */
const navigatedIdentity = (reads: 2 | 3, extent: RegionExtent, navigation: Navigation): string =>
	succeeded(
		descIdentity(
			navigateQuery(
				queryOf({ reads, import: "one rule", extent }),
				loc,
				columns,
				{ kind: "perStatement", extent },
				navigation
			)
		)
	)

/**
 * Judges case `c`: its query navigated over both extents in one navigation, in the case's order, is navigated over each
 * as a navigation of its own navigates it, and the two navigations differ, the import read at each read over the units
 * and whole over every row.
 */
export const navigatedTogether = (c: Together, note: (r: TogetherReached) => void): void => {
	note(c.unitsFirst ? "the units first" : "every row first")
	if (c.reads === 3) {
		note("an import read three times")
	}
	const alone = {
		units: navigatedIdentity(c.reads, "units", new Navigation(facts)),
		every: navigatedIdentity(c.reads, "every", new Navigation(facts))
	}
	assert.notEqual(alone.units, alone.every, "the two extents navigate the query apart")
	const shared = new Navigation(facts)
	const order: ReadonlyArray<RegionExtent> = c.unitsFirst ? ["units", "every"] : ["every", "units"]
	for (const extent of order) {
		assert.equal(
			navigatedIdentity(c.reads, extent, shared),
			alone[extent],
			`${Formatter.format(c)}: over ${extent}, the shared navigation navigates the query as one of its own does`
		)
	}
}

export type TogetherReached = "the units first" | "every row first" | "an import read three times"
