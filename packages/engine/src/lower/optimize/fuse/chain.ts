import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { Cell, EditNode, EditRefs, KindOver, VarDecl } from "#compiler/ir/rel.ts"

interface ChainPredicate {
	readonly pred: ScalarExpr
	/** The cell whose columns the predicate reads, and those columns' region variables by name. */
	readonly over: Cell
	readonly columns: ReadonlyMap<string, VarDecl>
}

export interface RegionChain {
	readonly top: Cell
	/** The chain's filters and renames, top first; the region is not among them. */
	readonly nodes: ReadonlyArray<Cell>
	/** The chain's region: its cell, and the region it holds. */
	readonly regionCell: Cell
	readonly region: KindOver<"MatchRegion", EditRefs>
	/** Each column of the chain's top, by name, to the region variable it carries. */
	readonly columns: ReadonlyMap<string, VarDecl>
	readonly preds: ReadonlyArray<ChainPredicate>
}

/**
 * The chain whose top is `top`, or undefined when `top` is not a region under filters and renames.
 *
 * A region chain: a stage that is one match region seen through filters and column renames.
 *
 * An imported query, a rule's find, or a stage the simplifier has not merged yet reaches its reader as a MatchRegion
 * under any number of Filter nodes and ProjectSet nodes whose every output is a column of its input. Such a chain
 * introduces no boundary but set projection, so its rows are determined by the region's bindings: every column of the
 * chain's top is one of the region's variables under a rename, and every predicate on the way is a predicate over
 * those variables. This module recognizes the chain and records both maps, for fusion (R01) and for tracing a column
 * back to the stored field it copies (R06).
 */
export const regionChain = (top: Cell): RegionChain | undefined => {
	const nodes: Array<Cell> = []
	let at = top
	let link = at.current
	while (link.kind !== "MatchRegion") {
		const input = linkInput(link)
		if (input === undefined) {
			return undefined
		}
		nodes.push(at)
		at = input
		link = at.current
	}
	const region = link
	const delivered = new Set(region.heading.map((c) => c.name))
	let columns: ReadonlyMap<string, VarDecl> = new Map(
		region.vars.flatMap((v): ReadonlyArray<readonly [string, VarDecl]> =>
			delivered.has(v.name) ? [[v.name, v]] : []
		)
	)
	const preds: Array<ChainPredicate> = []
	for (const cell of nodes.toReversed()) {
		const node = cell.current
		if (node.kind === "Filter") {
			preds.push({ pred: node.pred, over: node.input, columns })
			continue
		}
		const next = node.kind === "ProjectSet" ? renamedThrough(node, columns) : columns
		if (next === undefined) {
			return undefined
		}
		columns = next
	}
	return { top, nodes, regionCell: at, region, columns, preds }
}

/** The cell beneath a link of a chain: a filter's input, or a projection's that only renames its input's columns. */
const linkInput = (node: EditNode): Cell | undefined => {
	if (node.kind === "Filter") {
		return node.input
	}
	if (node.kind !== "ProjectSet") {
		return undefined
	}
	const input = node.input
	const renames = node.out.every((o) => o.expr.kind === "column" && o.expr.column.node === input.id)
	return renames ? input : undefined
}

/** The region variable each output of a renaming projection carries, given what its input's columns carry. */
const renamedThrough = (
	node: KindOver<"ProjectSet", EditRefs>,
	below: ReadonlyMap<string, VarDecl>
): ReadonlyMap<string, VarDecl> | undefined => {
	const next = new Map<string, VarDecl>()
	for (const o of node.out) {
		const e = o.expr
		const v = e.kind === "column" ? below.get(e.column.name) : undefined
		if (v === undefined) {
			return undefined
		}
		next.set(o.name, v)
	}
	return next
}
