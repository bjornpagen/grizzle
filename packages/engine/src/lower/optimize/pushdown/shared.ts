import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { immediateDominators } from "@bjornpagen/grizzle-text/base/graph"
import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { NodeId } from "#compiler/core/ids.ts"
import { localCertificate } from "#compiler/ir/certificate.ts"
import { storedColumn } from "#compiler/ir/expr.ts"
import type { Cell, HeadingColumn, VarDecl } from "#compiler/ir/rel.ts"
import { baseOf, sameScalarType } from "#compiler/ir/scalar.ts"
import { type CellState, DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import {
	type CellPhysical,
	overPhysical,
	type Potential,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"

const sharedRule = "pushdown.shared"

/** An outer node's column: a value per evaluation, the unit's inside a whole rule's step. */
interface Outer {
	readonly node: NodeId
	readonly column: string
}

const sameOuter = (a: Outer, b: Outer): boolean => a.node === b.node && a.column === b.column

/** Each column's outer columns, by the column's name. */
type Kept = ReadonlyMap<string, ReadonlyArray<Outer>>

const nothingKept: Kept = new Map()

/**
 * The values per evaluation the cells of `order` hold columns at, as outer columns: `canonical`, an outer column read
 * through its own node's fixed facts (analysis/physical/props.ts PhysicalProps fixed) to the outermost column it is
 * fixed to, so two readers that hold one value through different outer columns, a step's channel and a row the step
 * fixed at it, name the same one; `of`, the canonical outer columns a cell's facts fix its column to.
 */
interface Values {
	readonly canonical: (outer: Outer) => Outer
	readonly of: (cell: Cell, column: string) => ReadonlyArray<Outer>
}

const valuesOf = (physical: CellPhysical, order: ReadonlyArray<Cell>): Values => {
	const byId = new Map(order.map((c) => [c.id, c] as const))
	const fixedTo = (cell: Cell, column: string): ReadonlyArray<Outer> =>
		(physical.props(cell).fixed.get(column) ?? []).flatMap((f) =>
			f.fixed.kind === "outer" ? [{ node: f.fixed.node, column: f.fixed.column }] : []
		)
	const canonical = (outer: Outer): Outer => {
		const seen = new Set<string>()
		let at = outer
		for (;;) {
			const key = `${at.node}.${at.column}`
			const cell = byId.get(at.node)
			const [next] = cell === undefined || seen.has(key) ? [] : fixedTo(cell, at.column)
			if (next === undefined) {
				return at
			}
			seen.add(key)
			at = next
		}
	}
	return { canonical, of: (cell, column) => fixedTo(cell, column).map(canonical) }
}

/** The union of two holds, each column's outer columns in order. */
const unionKept = (a: Kept, b: Kept): Kept => {
	const out = new Map<string, ReadonlyArray<Outer>>(a)
	for (const [column, outers] of b) {
		const held = a.get(column)
		out.set(column, held === undefined ? outers : [...held, ...outers])
	}
	return out
}

/** The outer columns every one of `holds` holds each column at; nothing where there is no hold. */
const intersectKept = (holds: ReadonlyArray<Kept>): Kept => {
	const [first, ...rest] = holds
	if (first === undefined) {
		return nothingKept
	}
	const out = new Map<string, ReadonlyArray<Outer>>()
	for (const [column, outers] of first) {
		const common = outers.filter((x) =>
			rest.every((h) => (h.get(column) ?? []).some((y) => sameOuter(x, y)))
		)
		if (common.length > 0) {
			out.set(column, common)
		}
	}
	return out
}

/**
 * What every reader keeps of each cell's rows (`kept`): for each column, the outer columns every reader, and every
 * reader of theirs on to the roots, keeps the cell's rows at, so a row of the cell another value holds is in no row any
 * root reads. The local part is the fixed facts of the physical props (analysis/physical/props.ts PhysicalProps fixed),
 * which a region's correlations, its equalities and a filter's conjuncts state; this carries them down to the cells
 * that deliver the rows: a region's occurrence keeps its source at the outer columns its constants read and those its
 * variables are fixed to there or kept at by the region's readers; a filter keeps its input at those of its own facts
 * and of its readers'; an arm of a union, a step and the left of a semi- or anti-join, an intersection or a difference
 * are kept as their reader is, a semi- or anti-join's right at the left's columns its `on` pairs read, a projection's
 * input at the columns it carries and a group's input at its keys, as their readers keep them. Any other reader keeps
 * nothing, nor does a root. Read readers first, the cells in reverse topological order.
 */
const keptRows = (
	order: ReadonlyArray<Cell>,
	readers: (cell: Cell) => ReadonlyArray<Cell>,
	values: Values,
	isRoot: (cell: Cell) => boolean
): ((cell: Cell) => Kept) => {
	const kept = new Map<Cell, Kept>()
	const keptOf = (cell: Cell): Kept => kept.get(cell) ?? nothingKept
	/** What reader `r` keeps of `cell`'s rows, one hold for each place `r` reads it at. */
	const keptBy = (r: Cell, cell: Cell): ReadonlyArray<Kept> => {
		const node = r.current
		switch (node.kind) {
			case "MatchRegion":
				return node.occurrences.flatMap((o) => {
					if (o.source !== cell) {
						return []
					}
					const held = new Map<string, Array<Outer>>()
					const hold = (column: string, outers: ReadonlyArray<Outer>): void => {
						appendAll(
							held.getOrInsertComputed(column, () => []),
							outers
						)
					}
					for (const c of o.constants) {
						if (c.expr.kind === "column") {
							hold(c.column, [
								values.canonical({ node: c.expr.column.node, column: c.expr.column.name })
							])
						}
					}
					for (const b of o.bindings) {
						hold(b.column, [...values.of(r, b.var.name), ...(keptOf(r).get(b.var.name) ?? [])])
					}
					return [held]
				})
			case "Filter": {
				const own = new Map(node.heading.map((c) => [c.name, values.of(r, c.name)] as const))
				return [unionKept(own, keptOf(r))]
			}
			case "Union":
				return node.groups.flatMap((g) => g.arms.filter((a) => a === cell).map(() => keptOf(r)))
			case "Step":
				return [keptOf(r)]
			case "SemiJoin":
			case "AntiJoin": {
				const left = node.left
				const right = node.right
				const above = keptOf(r)
				const onRight = new Map<string, ReadonlyArray<Outer>>()
				for (const pair of node.on) {
					onRight.set(pair.right, [
						...(onRight.get(pair.right) ?? []),
						...values.of(left, pair.left),
						...(above.get(pair.left) ?? [])
					])
				}
				return [...(left === cell ? [above] : []), ...(right === cell ? [onRight] : [])]
			}
			case "ProjectSet": {
				const above = keptOf(r)
				const held = new Map<string, ReadonlyArray<Outer>>()
				for (const o of node.out) {
					if (o.expr.kind === "column" && o.expr.column.node === cell.id) {
						held.set(o.expr.column.name, [
							...(held.get(o.expr.column.name) ?? []),
							...(above.get(o.name) ?? [])
						])
					}
				}
				return [held]
			}
			case "Group": {
				const above = keptOf(r)
				return [
					new Map(
						node.keys.flatMap((k) => {
							const outers = above.get(k)
							return outers === undefined ? [] : [[k, outers] as const]
						})
					)
				]
			}
			case "Intersect":
			case "Difference":
				return node.left === cell ? [keptOf(r)] : [nothingKept]
			case "Base":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "Take":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Attach":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
			case "Call":
				return [nothingKept]
		}
	}
	for (const cell of order.toReversed()) {
		const rs = [...new Set(readers(cell))]
		kept.set(
			cell,
			isRoot(cell) || rs.length === 0
				? nothingKept
				: intersectKept(rs.flatMap((r) => keptBy(r, cell)))
		)
	}
	return keptOf
}

/**
 * pushdown.shared: a node several readers read, which every reader keeps at the same outer columns on some of its
 * columns (`keptRows`), the unit's values inside a whole rule's step, is read through one filter of those equalities,
 * which every reader then reads: every row the filter drops is in no row a root reads, so every root's rows are as they
 * were, and the filter, correlated with the unit, is one node the CTE policy computes once per unit
 * (lower/optimize/cte-policy rule 3b), where the node alone, correlated with nothing, was computed once in the
 * statement over every unit's rows: metis's concurrent pantry imports (2026-11-21), whose judges each read every
 * package through such nodes, branch_resolution_in_resolved_branch_rule's union of candidates among them, read by both
 * arms of the rule it negates. All or none: a node some reader keeps at no such column, or at another, is left as it
 * is, and a column the node holds at that value itself is not filtered again.
 */
/**
 * Whether `cell` is a node the pass may restrict: several readers read it, every one a region's occurrence, so the CTE
 * policy holds it in one region's SELECT once it is correlated (cte-policy holdingRegion, rule 3b), where a node another
 * kind of reader reads would be inlined at each read, its whole subtree copied; it reads nothing outside itself; and it
 * is no root and on no recursive step.
 */
const restrictable = (
	cell: Cell,
	state: CellState,
	readers: (cell: Cell) => ReadonlyArray<Cell>,
	isRoot: (cell: Cell) => boolean
): boolean => {
	const rs = readers(cell)
	return (
		rs.length > 1 &&
		rs.every((r) => r.current.kind === "MatchRegion") &&
		!state.feedback.has(cell) &&
		!isRoot(cell) &&
		!DagEditor.correlated(cell)
	)
}

/** A column of a node every reader keeps at one value, the value's column, and the column the restriction reads it by. */
interface Held {
	readonly column: HeadingColumn
	readonly at: Outer
	readonly outer: HeadingColumn
}

/**
 * The columns of `cell` every reader keeps at one value per evaluation (`keptRows`) that its own rows do not already
 * hold there, each read by the variable an enclosing region is correlated to that value by, of the outermost such
 * region on the cell's chain of dominators (grizzle-text base/graph.ts immediateDominators), which every path from a
 * root to every reader passes through, the region of the unit's own step, whose correlated values every node inside it
 * reads in scope, where an inner region's own correlated column is no outer value of a CTE held inside it (cte-policy
 * holdingRegion holds the node's CTE in that region's SELECT, once per unit), a variable no occurrence of that region
 * binds, so no source inside the region reads what its own occurrence binds (a restriction this pass made binds every
 * column of its node and is correlated too); none where no column is so kept, or no enclosing region is correlated to
 * its value, which the restriction could read in no scope. A region whose subtree holds every reader without
 * dominating them all is none: a reader shared with another region's subtree, an import two steps read at one key, is
 * spelled outside it too, where the restriction's correlation named a column of no node in scope (edullm's result
 * installation with imports of one Description identity made one node: a whole rule's step read through its channel's
 * slot, n478.__unit0).
 */
const heldOf = (
	cell: Cell,
	order: ReadonlyArray<Cell>,
	readers: (cell: Cell) => ReadonlyArray<Cell>,
	isRoot: (cell: Cell) => boolean,
	values: Values,
	kept: (cell: Cell) => Kept
): ReadonlyArray<Held> => {
	const byId = new Map(order.map((c) => [c.id, c] as const))
	const rs = [...new Set(readers(cell))]
	const dominator = immediateDominators(order, readers, isRoot)
	/** The regions dominating every reader, none of them a reader, innermost first; read outermost first. */
	const enclosing: Array<Cell> = []
	for (let at = dominator(cell); at !== undefined; at = dominator(at)) {
		if (at.current.kind === "MatchRegion" && !rs.includes(at)) {
			enclosing.push(at)
		}
	}
	const readAt = (value: Outer): Outer | undefined =>
		enclosing
			.toReversed()
			.flatMap((c) => {
				const region = c.current
				return region.kind !== "MatchRegion"
					? []
					: region.correlated.flatMap((k) => {
							if (
								region.occurrences.some((o) =>
									o.bindings.some((bound) => bound.var.id === k.var.id)
								)
							) {
								return []
							}
							const at = { node: c.id, column: k.var.name }
							return sameOuter(values.canonical(at), value) ? [at] : []
						})
			})
			.at(0)
	const held = kept(cell)
	return cell.current.heading.flatMap((column) => {
		const value = (held.get(column.name) ?? []).find(
			(x) => !values.of(cell, column.name).some((y) => sameOuter(x, y))
		)
		const at = value === undefined ? undefined : readAt(value)
		const outer =
			at === undefined
				? undefined
				: byId.get(at.node)?.current.heading.find((h) => h.name === at.column)
		return at === undefined ||
			outer === undefined ||
			!sameScalarType(baseOf(column.type), baseOf(outer.type))
			? []
			: [{ column, at, outer }]
	})
}

/**
 * Whether no node above `cell` that the pass restricts (`pushable`) reads it, through any chain of readers: the pass
 * restricts the outermost first, so a node inside one it restricts is restricted after it, at the region that holds
 * it then, where restricted first it made every node above it correlated, each inlined at each read.
 */
const outermost = (
	cell: Cell,
	readers: (cell: Cell) => ReadonlyArray<Cell>,
	pushable: (cell: Cell) => boolean
): boolean => {
	const seen = new Set<Cell>([cell])
	const pending = [...readers(cell)]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (seen.has(next)) {
			continue
		}
		seen.add(next)
		if (pushable(next)) {
			return false
		}
		for (const r of readers(next)) {
			pending.push(r)
		}
	}
	return true
}

const sharedPushRule: Rule = {
	name: "pushdown",
	at: (cell, cx) => {
		const state = cx.cells
		const readers = state.readers
		const isRoot = (c: Cell): boolean => cx.editor.isRoot(c)
		if (!restrictable(cell, state, readers, isRoot)) {
			return false
		}
		return overPhysical(({ physical }) => {
			const ed = cx.editor
			const values = valuesOf(physical, state.order)
			const kept = keptRows(state.order, readers, values, isRoot)
			const held = (c: Cell): ReadonlyArray<Held> =>
				heldOf(c, state.order, readers, isRoot, values, kept)
			const pushable = (c: Cell): boolean =>
				restrictable(c, state, readers, isRoot) && held(c).length > 0
			const own = held(cell)
			if (!isNonEmpty(own) || !outermost(cell, readers, pushable)) {
				return false
			}
			const node = cell.current
			const vars = node.heading.map((c): VarDecl => ({
				id: ed.freshVar(),
				name: c.name,
				type: c.type
			}))
			const varOf = new Map(vars.map((v) => [v.name, v] as const))
			const filter = ed.insertAbove(cell, (input) =>
				ed.add({
					kind: "MatchRegion",
					scope: ed.freshScope(),
					vars,
					occurrences: [
						{
							id: ed.freshOccurrence(),
							source: input,
							bindings: vars.map((v) => ({ column: v.name, var: v })),
							constants: []
						}
					],
					equalities: [],
					correlated: own.flatMap((h) => {
						const v = varOf.get(h.column.name)
						return v === undefined
							? []
							: [{ var: v, expr: ed.expr(storedColumn(h.at.node, h.at.column, h.outer.type)) }]
					}),
					heading: node.heading,
					meta: DagEditor.subsetMeta(node.meta),
					loc: undefined
				})
			)
			cx.certify(
				localCertificate(
					sharedRule,
					[cell.id],
					[filter.id],
					[cell.id],
					node.heading.map((c) => c.name)
				)
			)
			return true
		})
	}
}

/**
 * The potential: the nodes several readers read that read nothing outside themselves, which every move lowers by one: it
 * leaves the node one reader, its filter, which reads the unit's outer columns.
 */
const sharedPotential: Potential = (cx) => {
	const readers = cx.cells.readers
	return cx.cells.order.filter((cell) =>
		restrictable(cell, cx.cells, readers, (c) => cx.editor.isRoot(c))
	).length
}

/**
 * The shared restriction pass (pushdown.shared), over a rule's judged statements alone (lower/optimize/pipeline.ts
 * rewritePipeline): a node every reader keeps at the same outer columns is read through one filter of them.
 */
export const sharedPushdownPass = rewritePass({
	name: "pushdown.shared",
	rules: [sharedPushRule],
	potential: () => sharedPotential
})
