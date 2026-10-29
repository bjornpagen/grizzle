import type { NodeId } from "#compiler/core/ids.ts"
import type { ColumnRef } from "#compiler/ir/expr.ts"
import { OpId } from "#compiler/ir/expr.ts"
import type { Cell } from "#compiler/ir/rel.ts"
import type { CatalogContext } from "#compiler/lower/shapes/catalog/context.ts"
import {
	columnsRead,
	demand,
	noMatch,
	rebase,
	required
} from "#compiler/lower/shapes/catalog/exprs.ts"
import { metaWithKeys, plainKeys } from "#compiler/lower/shapes/catalog/ordinal.ts"

interface ModeResult {
	readonly inputs: ReadonlyArray<NodeId>
	readonly outputs: ReadonlyArray<NodeId>
}

/**
 * R31: the count-and-take mode is MODE() WITHIN GROUP.
 *
 * The composition: a count per value of a stage, ordered by the count descending and then by the value
 * ascending, closed with take(1):
 *
 *   Take(1, by [count desc, value asc]) <- Group(keys [value], count) <- X
 *
 * The native aggregate reads X's values in their ascending native order and collation and keeps the first value with
 * the highest count, so the two agree exactly when the tiebreak is the value's own ascending order (C.UTF-8 for text). MODE delivers the value alone, so the rewrite applies where nothing reads the count: each consumer of the
 * take is a projection or a match that leaves the count unbound, and each is redefined to read the aggregate. The
 * group's bound tuple is X's complete heading, so each count is a number of X's rows, which is what MODE counts over
 * the established distinct input. With no group key the aggregate groups by a carried constant, so an
 * empty X delivers no row in both forms (native.ts).
 */
export const tryMode = (cx: CatalogContext, cell: Cell): ModeResult => {
	const take = cell.current
	if (take.kind !== "Take") {
		return noMatch("a take")
	}
	demand(
		take.bound.kind === "literal" && take.bound.k === 1n && take.correlation.length === 0,
		"an uncorrelated take(1)"
	)
	const groupCell = take.input
	const group = groupCell.current
	demand(group.kind === "Group", "a take over a grouped count")
	const [value] = group.keys
	const [agg] = group.aggs
	demand(
		group.keys.length === 1 && group.aggs.length === 1 && value !== undefined && agg !== undefined,
		"a count per value"
	)
	demand(agg.fn === "count" && agg.filter === undefined, "an unfiltered count")
	const inputCell = group.input
	const input = inputCell.current
	demand(
		group.bound.length === input.heading.length &&
			input.heading.every((h) => group.bound.includes(h.name)),
		"a count of the input's rows: the bound tuple is its whole heading"
	)
	const [first, second] = take.order.keys
	demand(
		first?.column === agg.name &&
			first.dir === "desc" &&
			second?.column === value &&
			second.dir === "asc",
		"the order count descending, then the value ascending"
	)
	demand(!cx.isRoot(cell), "a take whose count nobody reads")
	const consumers = cx.consumers(cell)
	demand(consumers.length > 0, "a consumer of the take")
	for (const consumer of consumers) {
		const c = consumer.current
		if (c.kind === "ProjectSet") {
			demand(
				c.input === cell &&
					c.out.every((o) => columnsRead(o.expr).every((r) => r.name !== agg.name)),
				"a projection that drops the count"
			)
		} else if (c.kind === "MatchRegion") {
			demand(
				c.occurrences.every(
					(o) =>
						o.source !== cell ||
						(!o.bindings.some((b) => b.column === agg.name) &&
							!o.constants.some((k) => k.column === agg.name))
				),
				"a match that leaves the count unbound"
			)
		} else {
			noMatch("consumers that read the value only")
		}
	}
	const valueColumn = required(
		input.heading.find((h) => h.name === value),
		"the value in the input"
	)
	const mode = cx.ed.node({
		kind: "OrderedSetAggregate",
		input: inputCell,
		keys: [],
		fn: "mode",
		op: OpId("mode(anyelement)"),
		order: { keys: [{ column: value, dir: "asc" }] },
		fractions: [],
		outs: [value],
		rule: "R31",
		heading: [{ name: value, type: valueColumn.type }],
		meta: { ...metaWithKeys(plainKeys([[]])), card: "atMostOne" },
		loc: undefined
	})
	const toMode = (ref: ColumnRef): ColumnRef | undefined =>
		ref.node === cell.id && ref.name === value ? { node: mode.id, name: value } : undefined
	for (const consumer of consumers) {
		const c = consumer.current
		if (c.kind === "ProjectSet") {
			cx.ed.redefine(consumer, {
				...c,
				input: mode,
				out: c.out.map((o) => ({ name: o.name, expr: rebase(cx.ed, o.expr, toMode) }))
			})
		} else if (c.kind === "MatchRegion") {
			cx.ed.redefine(consumer, {
				...c,
				occurrences: c.occurrences.map((o) => (o.source === cell ? { ...o, source: mode } : o))
			})
		}
	}
	const consumed = consumers.map((c) => c.id)
	return { inputs: [cell.id, groupCell.id, ...consumed], outputs: [mode.id, ...consumed] }
}
