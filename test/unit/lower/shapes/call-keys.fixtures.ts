/** What call-keys.test.ts reads: its schema, its box, and each case's calls with the key sets their reads read them at. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { NodeOf, RelNode } from "#compiler/ir/rel.ts"
import {
	computedAt,
	KeyAnalysis,
	type KeyRestriction,
	Lookups,
	noPagedReads,
	whole
} from "#compiler/lower/shapes/share/keys.ts"
import { Fn } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"

const A = rows({ k: pg.bigint, v: pg.bigint })

/** processing: one rows argument of (k, v), and one row of a field of rows of (k, v), as metis's response processing. */
const processing = fn("processing", {
	calls: [],
	args: { in0: A },
	returns: row(rows({ out: A })),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT NULL`
})

/** A session's items, which the call's argument reads and its readers join it to. */
const Item = relation("Item", { session: pg.integer, k: pg.bigint, v: pg.bigint }, ["session", "k"])

const Calls = schema("CallKeys", [Item, processing], [])

/** The session's items, at the parameter. */
const items = query(Calls).rule((r) => {
	const { k, v: x } = v(Item, "item")
	return r.match(Item, { session: r.param("session", pg.integer), k, v: x }).find({ k, v: x })
})

/** How a read reads the call's field: joined to the session's items by its row, or alone. */
export type Reading = "at the session's items" | "alone"

export interface Box {
	readonly reading: Reading
	/** How many rules read the call's field, each its own read. */
	readonly readers: 1 | 2
}

export const boxGen: Gen<Box> = element<Box>(
	Arr.flatMap(["at the session's items", "alone"] as const, (reading) =>
		Arr.map([1, 2] as const, (readers) => ({ reading, readers }))
	)
)

/** The call's field read by `readers` rules, each as `reading` says, the j-th at its rows at least j. */
const readOf = (box: Box) => {
	const read = (r: Rule<typeof Calls>, j: number) => {
		const out = Fn.row(processing, {
			in0: items.bind({ session: r.param("session", pg.integer) })
		}).out
		const { k, v: x } = v(out, "out")
		const matched =
			box.reading === "alone"
				? r.match(out, { k, v: x })
				: r
						.match(Item, { session: r.param("session", pg.integer), k, v: x })
						.match(out, { k, v: x })
		return matched.where(r.ge(x, BigInt(j))).find({ k, v: x })
	}
	const first = query(Calls).rule((r) => read(r, 0))
	return box.readers === 1 ? first : first.rule((r) => read(r, 1))
}

/**
 * Each call of a case's read, with the key set its reads read it at (keys.ts KeyAnalysis over the checked DAG, its
 * roots whole) and the key set it is computed at (computedAt).
 */
export const callKeysOf = (
	box: Box
): ReadonlyArray<{ readonly read: KeyRestriction; readonly computed: KeyRestriction }> => {
	const dag = succeeded(compileTemplate(readOf(box), undefined, testCompile), "the read compiles")
		.programs.checked.dag
	const nodes = topoOrder(dag)
	const analysis = new KeyAnalysis(
		nodes,
		new Map(Arr.map(dag.roots, (r) => [r, whole] as const)),
		() => new Map(),
		new Lookups(() => false),
		noPagedReads
	)
	return Arr.flatMap(nodes, (node: RelNode) => {
		if (node.kind !== "Call") {
			return []
		}
		const call: NodeOf<"Call"> = node
		const read = analysis.keysOf(call)
		return [{ read, computed: computedAt(call, read) }]
	})
}
