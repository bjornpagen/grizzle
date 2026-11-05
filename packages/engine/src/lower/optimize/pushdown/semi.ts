import type { NodeId } from "#compiler/core/ids.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	type Cell,
	type EditRefs,
	type KindOver,
	mapAggregate,
	type OccurrenceOver,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import {
	nodePremises,
	type Potential,
	type RewriteCx,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"
import { exclusive } from "#compiler/lower/optimize/simplify/rules.ts"

const semiRules = {
	source: "pushdown.semiSource",
	group: "pushdown.semiGroup"
} as const satisfies Readonly<Record<string, CertificateRule>>

type Semi = KindOver<"SemiJoin", EditRefs>
type Group = KindOver<"Group", EditRefs>

type ColumnPairs = Semi["on"]

/** The semi-join being moved: its cell, and the semi-join it holds. */
interface Moving {
	readonly cell: Cell
	readonly semi: Semi
}

const certify = (
	cx: RewriteCx,
	rule: CertificateRule,
	m: Moving,
	through: NodeId,
	outputs: ReadonlyArray<NodeId>
): void => {
	cx.certify({
		rule,
		inputs: [m.cell.id, through],
		outputs,
		premises: nodePremises([through]),
		context: "queryLocal",
		preservedHeading: m.semi.heading.map((c) => c.name),
		equality: [],
		coercion: [],
		params: undefined
	})
}

/** A new semi-join of `left` against `right` on `on`: a subset of `left` (DagEditor.subsetMeta). */
const semiOver = (ed: DagEditor, left: Cell, right: Cell, on: ColumnPairs): Cell => {
	const node = left.current
	return ed.add({
		kind: "SemiJoin",
		left,
		right,
		on,
		heading: node.heading,
		meta: DagEditor.subsetMeta(node.meta),
		loc: undefined
	})
}

/**
 * Whether a cell may take a semi-join from above it: one reference, the semi-join's, uncorrelated and off any recursive
 * step.
 */
const movable = (cx: RewriteCx, cell: Cell): boolean =>
	exclusive(cx, cell) && !cx.editor.correlated(cell) && !cx.editor.readsFeedback(cell)

/** The source column `occurrence` binds `variable` to, where it binds it. */
const boundColumn = (
	occurrence: OccurrenceOver<Cell, ScalarExpr, VarDecl>,
	variable: VarDecl
): string | undefined => occurrence.bindings.find((b) => b.var.id === variable.id)?.column

/**
 * Whether a semi-join comparing `columns` of a group's rows keeps or removes whole groups: the group has grouping
 * columns, and every compared column is one.
 */
const restrictsGroups = (group: Group, columns: ReadonlyArray<string>): boolean =>
	group.keys.length > 0 && columns.every((c) => group.keys.includes(c))

/** The region now denotes the semi-join's set and takes its readers, so it carries the semi-join's metadata. */
const intoOccurrence = (
	cx: RewriteCx,
	m: Moving,
	regionCell: Cell,
	region: KindOver<"MatchRegion", EditRefs>
): boolean => {
	const ed = cx.editor
	const semi = m.semi
	/** Each compared pair with the region variable its left column names, where one does. */
	const variables = semi.on.map((pair) => ({
		pair,
		variable: region.vars.find((v) => v.name === pair.left)
	}))
	/** Only onto a group the next rule takes it below (belowGroup), never one it would stay above. */
	const [chosen] = region.occurrences.flatMap((o) => {
		const source = o.source.current
		if (source.kind !== "Group" || !movable(cx, o.source)) {
			return []
		}
		const on = variables.flatMap(({ pair, variable }) => {
			const column = variable === undefined ? undefined : boundColumn(o, variable)
			return column === undefined ? [] : [{ left: column, right: pair.right }]
		})
		const compared = on.map((p) => p.left)
		return on.length === semi.on.length && restrictsGroups(source, compared)
			? [{ occurrence: o, on }]
			: []
	})
	if (chosen === undefined) {
		return false
	}
	const moved = semiOver(ed, chosen.occurrence.source, semi.right, chosen.on)
	const occurrences = region.occurrences.map((o) =>
		o.id === chosen.occurrence.id ? { ...o, source: moved } : o
	)
	ed.set(regionCell, { ...region, occurrences, meta: semi.meta })
	ed.redirect(m.cell, regionCell)
	certify(cx, semiRules.source, m, regionCell.id, [regionCell.id, moved.id])
	return true
}

/** The group now denotes the semi-join's set and takes its readers, so it carries the semi-join's metadata. */
const belowGroup = (cx: RewriteCx, m: Moving, groupCell: Cell, group: Group): boolean => {
	const ed = cx.editor
	const semi = m.semi
	const compared = semi.on.map((p) => p.left)
	if (!restrictsGroups(group, compared)) {
		return false
	}
	/** A grouping column is its input's column of the same name. */
	const moved = semiOver(ed, group.input, semi.right, semi.on)
	const remap = ed.retarget(group.input, moved)
	const aggs = group.aggs.map((a) => mapAggregate(a, (e) => ed.copyExpr(e, remap)))
	ed.set(groupCell, { ...group, input: moved, aggs, meta: semi.meta })
	ed.redirect(m.cell, groupCell)
	certify(cx, semiRules.group, m, groupCell.id, [groupCell.id, moved.id])
	return true
}

const semiRule: Rule = {
	name: "semi-join pushdown",
	at: (cell, cx) => {
		const ed = cx.editor
		const semi = cell.current
		if (semi.kind !== "SemiJoin" || semi.on.length === 0) {
			return false
		}
		if (ed.correlated(semi.right) || cx.demand().lateral(semi.right)) {
			return false
		}
		const m: Moving = { cell, semi }
		const leftCell = semi.left
		const left = leftCell.current
		if (!movable(cx, leftCell)) {
			return false
		}
		switch (left.kind) {
			case "MatchRegion":
				return intoOccurrence(cx, m, leftCell, left)
			case "Group":
				return belowGroup(cx, m, leftCell, left)
			case "Base":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "Filter":
			case "ProjectSet":
			case "SemiJoin":
			case "AntiJoin":
			case "Union":
			case "Intersect":
			case "Difference":
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
				return false
		}
	}
}

const semiPotential: Potential = (cx) => {
	let sum = 0
	for (const cell of cx.editor.topoOrder()) {
		const node = cell.current
		if (node.kind === "SemiJoin") {
			sum += cx.editor.subtree(node.left).size
		}
	}
	return sum
}

/**
 * The semi-join movement pass.
 *
 * Semi-join movement: push a semi-join toward the rows it restricts, where the move preserves the set, so an aggregate
 * below a semi-join on its group key folds only the groups the semi-join keeps.
 *
 * - pushdown.semiSource: a semi-join over a region, each of whose left columns is a variable an occurrence of a group
 *   binds, moves onto that occurrence's source: a region row survives exactly when that occurrence's row, whose bound
 *   columns equal those variables, has a match on the right. The move goes onto a group's occurrence only, and only
 *   where the next rule takes it below the group (the group read by the region alone, the columns its grouping
 *   columns); a semi-join over a join of stored relations stays where PostgreSQL plans it, and a region an approximate
 *   search reads keeps its stored scan;
 * - pushdown.semiGroup: a semi-join over a group, each of whose left columns is a grouping column, moves below the
 *   group: every row of one group has the group's key values, so the semi-join keeps or removes whole groups and leaves
 *   every surviving group's contributions unchanged, as pushdown.group moves a filter on a group's key. A group without
 *   grouping columns delivers one row even over no input, so nothing moves below it.
 *
 * A semi-join without a column pair moves nowhere. The right side is evaluated as before, and a semi-join's condition
 * is equality on columns: below a group the semi-join removes only whole groups the answer never delivers, whose
 * aggregates go unevaluated. Each move needs
 * the node it moves through to be the semi-join's left alone, one reference (simplify/rules.ts exclusive), uncorrelated
 * and off any recursive step, and the right side uncorrelated: a semi-join of a node with itself references it twice,
 * so it never moves below that node, which would then read itself.
 *
 * Potential: the sum of every semi-join's left subtree size, at most the semi-joins times the nodes. A move takes one
 * semi-join from above a node onto a strict part of its former left subtree, and copies none; every other semi-join
 * keeps its left subtree's size, since the moved one leaves it as many nodes as it enters. So the sum falls.
 */
export const semiPushdownPass = rewritePass({
	name: "semi-join pushdown",
	rules: [semiRule],
	potential: () => semiPotential
})
