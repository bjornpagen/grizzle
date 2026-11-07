import type { NodeId } from "#compiler/core/ids.ts"
import { OpId } from "#compiler/ir/expr.ts"
import type { OperandPremise, OperationProof } from "#compiler/ir/proof.ts"
import { type Cell, conservativeMeta, type EditRefs, type KindOver } from "#compiler/ir/rel.ts"
import {
	bindingsByVar,
	boundColumns,
	type CatalogContext,
	freshColumn,
	type KeyGrounds,
	type Region,
	sameSource
} from "#compiler/lower/shapes/catalog/context.ts"

import {
	castExpr,
	colExpr,
	demand,
	noMatch,
	plain,
	required
} from "#compiler/lower/shapes/catalog/exprs.ts"
import { bigintSumType } from "#compiler/scalar/aggregate.ts"

/**
 * The total of a fold's counts: it counts rows of one input, which PostgreSQL holds fewer of than 2^63 (a relation has
 * at most 2^32 pages), so it lies in [0, 2^63 - 1].
 */
const countTotal: OperandPremise = {
	kind: "interval",
	operand: 0,
	low: { units: 0n, scale: 0 },
	high: { units: 2n ** 63n - 1n, scale: 0 },
	nan: false
}

/** Why the numeric total of a fold's counts casts into bigint: it is finite, and it fits, by its interval. */
const countTotalProof: OperationProof = [
	{ precondition: { kind: "finite", operand: 0 }, premises: [countTotal] },
	{ precondition: { kind: "fits" }, premises: [countTotal] }
]

/**
 * The rows a Group folds, as one source and the source column of each bound column: a single-occurrence region with
 * no restriction whose bound columns cover a key of the source.
 */
type Group = KindOver<"Group", EditRefs>

const foldedRows = (
	cx: CatalogContext,
	group: Group
): {
	readonly source: Cell
	readonly column: ReadonlyMap<string, string>
	readonly key: KeyGrounds
} => {
	const r = group.input.current
	demand(r.kind === "MatchRegion", "a fold over one match")
	const [occ] = r.occurrences
	demand(
		r.occurrences.length === 1 &&
			r.equalities.length === 0 &&
			r.correlated.length === 0 &&
			occ !== undefined,
		"a fold over one unrestricted occurrence"
	)
	demand(occ.constants.length === 0, "a fold over every row of its source")
	const column = new Map<string, string>()
	for (const b of occ.bindings) {
		const name = b.var.name
		demand(!column.has(name), "each variable bound once")
		column.set(name, b.column)
	}
	const source = occ.source
	const covered = new Set(
		group.bound.columns.flatMap((b) => {
			const c = column.get(b)
			return c === undefined ? [] : [c]
		})
	)
	const key = required(
		cx.keyWithin(source, covered),
		"a complete bound tuple covering a key of the source: one contribution per row"
	)
	return { source, column, key }
}

const countOf = (group: Group): string | undefined =>
	group.aggs.find((a) => a.fn === "count" && a.filter === undefined)?.name

interface ShareResult {
	readonly inputs: ReadonlyArray<NodeId>
	readonly outputs: ReadonlyArray<NodeId>
	readonly premises: ReadonlyArray<KeyGrounds>
}

/**
 * The grouped count beside the total.
 *
 * The total joins every group: no variable is bound twice, which would restrict the pairs (a count equal to the
 * total, a key equal to a count).
 */
const groupedShare = (cx: CatalogContext, cell: Cell, region: Region): ShareResult => {
	const [a, b] = region.occurrences
	demand(a !== undefined && b !== undefined, "a region joining two stages")
	const ga = a.source.current
	const gb = b.source.current
	demand(ga.kind === "Group" && gb.kind === "Group", "two aggregate stages")
	let grouped: Group = ga
	let total: Group = gb
	let og = a
	let ot = b
	if (grouped.keys.length === 0) {
		;[grouped, total] = [total, grouped]
		;[og, ot] = [ot, og]
	}
	demand(
		grouped.keys.length > 0 && total.keys.length === 0,
		"a grouped count and a count with no group key"
	)
	const groupedCount = countOf(grouped)
	const totalCount = countOf(total)
	demand(groupedCount !== undefined && totalCount !== undefined, "unfiltered counts on both sides")
	demand(og.constants.length === 0 && ot.constants.length === 0, "no restriction of either stage")
	demand(
		ot.bindings.every((x) => x.column === totalCount),
		"the total stage read for its count only"
	)
	/** The premises that both counts fold the same rows: none over one input, the folded rows' keys over two. */
	const oneInput = grouped.input === total.input
	const sameRows = oneInput
		? []
		: (() => {
				const g = foldedRows(cx, grouped)
				const t = foldedRows(cx, total)
				demand(sameSource(g.source, t.source), "both counts over one source")
				return [g.key, t.key]
			})()
	if (oneInput) {
		demand(
			grouped.bound.columns.length === total.bound.columns.length &&
				grouped.bound.columns.every((c) => total.bound.columns.includes(c)),
			"both counts over the same binding set"
		)
	}
	const heading = grouped.heading
	const out = freshColumn(
		heading.map((h) => h.name),
		"__total"
	)
	const window = cx.ed.node({
		kind: "Window",
		input: og.source,
		partition: [],
		order: { keys: [] },
		fn: "sum",
		op: OpId("sum(bigint)"),
		args: [colExpr(cx.ed, og.source, groupedCount, plain.int8)],
		out,
		rule: "R28",
		heading: [...heading, { name: out, type: bigintSumType }],
		meta: conservativeMeta,
		filter: undefined,
		frame: undefined,
		loc: undefined
	})
	const byVar = bindingsByVar(region)
	for (const list of byVar.values()) {
		demand(list.length <= 1, "a grouped count beside its total, unrestricted")
	}
	const exprs = region.heading.map((h) => {
		const list = boundColumns(region, byVar, h.name)
		const binding = required(
			list.length === 1 ? list[0] : undefined,
			`a region column ${h.name} one stage binds`
		)
		const occ = required(region.occurrences[binding.occurrence], `the stage of ${h.name}`)
		if (occ.id === ot.id) {
			return {
				name: h.name,
				expr: castExpr(cx.ed, colExpr(cx.ed, window, out, bigintSumType), h.type, countTotalProof)
			}
		}
		return { name: h.name, expr: colExpr(cx.ed, window, binding.column, h.type) }
	})
	cx.ed.redefine(cell, {
		kind: "ProjectSet",
		input: window,
		out: exprs,
		heading: region.heading,
		meta: region.meta,
		loc: undefined
	})
	return {
		inputs: [cell.id, og.source.id, ot.source.id],
		outputs: [cell.id, window.id],
		premises: sameRows
	}
}

/** The per-key count joined back to its input. */
const keyedShare = (cx: CatalogContext, cell: Cell, region: Region): ShareResult => {
	const [a, b] = region.occurrences
	demand(a !== undefined && b !== undefined, "a region joining two stages")
	const ga = a.source.current
	const gb = b.source.current
	const [oc, ox, group] =
		ga.kind === "Group" && gb.kind !== "Group"
			? ([a, b, ga] as const)
			: gb.kind === "Group" && ga.kind !== "Group"
				? ([b, a, gb] as const)
				: noMatch("one aggregate stage and its input")
	const g = group
	demand(g.keys.length > 0, "a per-key unfiltered count")
	const count = required(countOf(g), "a per-key unfiltered count")
	demand(oc.constants.length === 0 && ox.constants.length === 0, "no restriction of either side")
	const rows = foldedRows(cx, g)
	const x = ox.source.current
	demand(sameSource(ox.source, rows.source), "the count joined back to its own input")
	const byVar = bindingsByVar(region)
	/**
	 * The join is exactly the key: every variable is bound at most once on each side, and a variable both sides bind is
	 * a key column (checked below). A variable bound twice on the input, or the count bound to an input column too,
	 * restricts the joined rows, which the window over the whole input would not (R28: both counts over the same
	 * binding set).
	 */
	const ix = region.occurrences.indexOf(ox)
	const ic = region.occurrences.indexOf(oc)
	for (const list of byVar.values()) {
		const onInput = list.filter((y) => y.occurrence === ix)
		const onCount = list.filter((y) => y.occurrence === ic)
		demand(
			onInput.length <= 1 && onCount.length <= 1,
			"each variable bound at most once on each side"
		)
		const [countSide] = onCount
		if (onInput.length === 1 && onCount.length === 1 && countSide !== undefined) {
			demand(g.keys.includes(countSide.column), "the two sides joined on the key only")
		}
	}
	/** Every key column joined to the input's same column. */
	const partition: Array<string> = []
	for (const k of g.keys) {
		const binding = required(
			oc.bindings.find((y) => y.column === k),
			`the key ${k} bound`
		)
		const joined = required(
			(byVar.get(binding.var) ?? []).find((y) => region.occurrences[y.occurrence]?.id === ox.id),
			`the key ${k} joined to its input column`
		)
		demand(joined.column === rows.column.get(k), `the key ${k} joined to its input column`)
		partition.push(joined.column)
	}
	demand(
		oc.bindings.every((y) => y.column === count || g.keys.includes(y.column)),
		"the count stage read for its keys and count"
	)
	const heading = x.heading
	const out = freshColumn(
		heading.map((h) => h.name),
		"__count"
	)
	const window = cx.ed.node({
		kind: "Window",
		input: ox.source,
		partition,
		order: { keys: [] },
		fn: "count",
		op: OpId("count()"),
		args: [],
		out,
		rule: "R28",
		heading: [...heading, { name: out, type: plain.int8 }],
		meta: conservativeMeta,
		filter: undefined,
		frame: undefined,
		loc: undefined
	})
	const exprs = region.heading.map((h) => {
		const list = boundColumns(region, byVar, h.name)
		const onInput = list.find((y) => region.occurrences[y.occurrence]?.id === ox.id)
		if (onInput !== undefined) {
			return { name: h.name, expr: colExpr(cx.ed, window, onInput.column, h.type) }
		}
		demand(
			list.some((y) => region.occurrences[y.occurrence]?.id === oc.id && y.column === count),
			`a region column ${h.name} from the input or the count`
		)
		return { name: h.name, expr: colExpr(cx.ed, window, out, h.type) }
	})
	cx.ed.redefine(cell, {
		kind: "ProjectSet",
		input: window,
		out: exprs,
		heading: region.heading,
		meta: region.meta,
		loc: undefined
	})
	return {
		inputs: [cell.id, oc.source.id, ox.source.id],
		outputs: [cell.id, window.id],
		premises: [rows.key]
	}
}

/**
 * R28: a share of the total is a window sum over the grouped counts, or a window count over the input.
 *
 * Two compositions, each a match region joining two aggregate stages over the same bindings:
 *
 * - a grouped count joined to the count over the same input with no group key: the region binds the grouped stage's
 *   keys and count and the total's count; the target is the grouped stage with `(SUM(count) OVER ())::bigint`
 *   beside it, one pass instead of a second aggregate stage;
 * - a per-key count joined back to its input on that key: the region binds the input's fields and the count, joined
 *   on the key variables; the target is the input with `COUNT(*) OVER (PARTITION BY key)` beside it.
 *
 * The preconditions: both counts range over the same binding set, which holds when the two stages read one stage, or
 * two scans of one source each binding a key of it with no restriction, so every row is one contribution; the group
 * key is part of the grouped binding, so the groups partition the total; the counts are unfiltered. The cast is exact:
 * the sum of a set's group counts is the set's count, while sum over bigint is numeric. An empty input gives no group
 * row, no total row and no window row, so both forms are empty together.
 */
export const tryShare = (cx: CatalogContext, cell: Cell): ShareResult => {
	const node = cell.current
	if (node.kind !== "MatchRegion") {
		return noMatch("a match region")
	}
	demand(
		node.occurrences.length === 2 && node.equalities.length === 0 && node.correlated.length === 0,
		"a region joining two stages"
	)
	const kinds = node.occurrences.map((o) => o.source.current.kind)
	return kinds.every((k) => k === "Group")
		? groupedShare(cx, cell, node)
		: keyedShare(cx, cell, node)
}
