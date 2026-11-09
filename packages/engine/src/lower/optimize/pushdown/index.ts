import type { NodeId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { type CertificateRule, localCertificate } from "#compiler/ir/certificate.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	type Cell,
	type EditNode,
	type EditRefs,
	type HeadingColumn,
	inputsOf,
	type KindOver,
	mapAggregate,
	type OccurrenceOver,
	type RelKind,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import { columnIn } from "#compiler/lower/conservative/context.ts"
import { columnRefs, DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import {
	type CellDemand,
	measureOverDemand,
	overDemand,
	type Potential,
	type RewriteCx,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"
import { conjunction } from "#compiler/lower/optimize/simplify/boolean.ts"
import { exclusive } from "#compiler/lower/optimize/simplify/rules.ts"

const pushdownRules = {
	project: "pushdown.project",
	group: "pushdown.group",
	union: "pushdown.union",
	left: "pushdown.left",
	source: "pushdown.source"
} as const

type Filter = KindOver<"Filter", EditRefs>

/** The filter being moved: its cell, and the filter it holds. */
interface Moving {
	readonly cell: Cell
	readonly filter: Filter
}

const certify = (
	cx: RewriteCx,
	rule: CertificateRule,
	m: Moving,
	through: NodeId,
	outputs: ReadonlyArray<NodeId>
): void => {
	cx.certify(
		localCertificate(
			rule,
			[m.cell.id, through],
			outputs,
			[through],
			m.filter.heading.map((c) => c.name)
		)
	)
}

/** A new filter over `input`: a subset of it (DagEditor.subsetMeta). */
const filterOver = (ed: DagEditor, input: Cell, pred: ScalarExpr): Cell => {
	const node = input.current
	return ed.add({
		kind: "Filter",
		input,
		pred,
		heading: node.heading,
		meta: DagEditor.subsetMeta(node.meta),
		loc: undefined
	})
}

/**
 * The filter's cell taken by `body`, which reads the moved filter; the filter's metadata stands, since its set is
 * unchanged.
 */
const takeOver = (ed: DagEditor, m: Moving, body: EditNode): void => {
	ed.set(m.cell, { ...body, heading: m.filter.heading, meta: m.filter.meta })
}

/**
 * The filter moved below a projection, its predicate reading the projected expressions in place of the projected
 * columns. A conjunct that is a projected conjunction would arrive as several conjuncts, which no rule of this pass may
 * make of one (pushdownPotential): the move is refused then, and the filter stays above the projection, where it is
 * one conjunct.
 */
const throughProject = (
	cx: RewriteCx,
	m: Moving,
	xCell: Cell,
	x: KindOver<"ProjectSet", EditRefs>
): boolean => {
	const ed = cx.editor
	const byName = new Map(x.out.map((o) => [o.name, o.expr]))
	const splits = conjuncts(m.filter.pred).some((c) => {
		const projected =
			c.kind === "column" && c.column.node === xCell.id ? byName.get(c.column.name) : undefined
		return projected !== undefined && conjuncts(projected).length > 1
	})
	if (splits) {
		return false
	}
	const pred = ed.copyExpr(m.filter.pred, (ref) =>
		ref.node === xCell.id ? byName.get(ref.name) : undefined
	)
	const moved = filterOver(ed, x.input, pred)
	const remap = ed.retarget(x.input, moved)
	const out = x.out.map((o) => ({ name: o.name, expr: ed.copyExpr(o.expr, remap) }))
	takeOver(ed, m, { ...x, input: moved, out })
	certify(cx, pushdownRules.project, m, xCell.id, [m.cell.id, moved.id])
	return true
}

const throughGroup = (
	cx: RewriteCx,
	m: Moving,
	xCell: Cell,
	x: KindOver<"Group", EditRefs>
): boolean => {
	const ed = cx.editor
	const refs = columnRefs([m.filter.pred])
	if (x.keys.length === 0 || !refs.every((r) => r.node === xCell.id && x.keys.includes(r.name))) {
		return false
	}
	const moved = filterOver(ed, x.input, ed.copyExpr(m.filter.pred, ed.retarget(xCell, x.input)))
	const remap = ed.retarget(x.input, moved)
	const aggs = x.aggs.map((a) => mapAggregate(a, (e) => ed.copyExpr(e, remap)))
	takeOver(ed, m, { ...x, input: moved, aggs })
	certify(cx, pushdownRules.group, m, xCell.id, [m.cell.id, moved.id])
	return true
}

const throughUnion = (
	cx: RewriteCx,
	m: Moving,
	xCell: Cell,
	x: KindOver<"Union", EditRefs>
): void => {
	const ed = cx.editor
	const moved: Array<NodeId> = []
	const groups = mapNonEmpty(x.groups, (g) => ({
		heading: g.heading,
		arms: mapNonEmpty(g.arms, (arm) => {
			const f = filterOver(ed, arm, ed.copyExpr(m.filter.pred, ed.retarget(xCell, arm)))
			moved.push(f.id)
			return f
		})
	}))
	takeOver(ed, m, { ...x, groups })
	certify(cx, pushdownRules.union, m, xCell.id, [m.cell.id, ...moved])
}

const throughLeft = (
	cx: RewriteCx,
	demand: CellDemand,
	m: Moving,
	xCell: Cell,
	x: KindOver<"SemiJoin" | "AntiJoin" | "Intersect" | "Difference", EditRefs>
): boolean => {
	const ed = cx.editor
	if (demand.lateral(x.left)) {
		return false
	}
	const moved = filterOver(ed, x.left, ed.copyExpr(m.filter.pred, ed.retarget(xCell, x.left)))
	takeOver(ed, m, { ...x, left: moved })
	certify(cx, pushdownRules.left, m, xCell.id, [m.cell.id, moved.id])
	return true
}

const boundaryKinds: ReadonlyArray<RelKind> = [
	"Group",
	"Union",
	"Intersect",
	"Difference",
	"SemiJoin",
	"AntiJoin"
]

/**
 * The region now denotes the filter's set and takes its readers, so it carries the filter's metadata:
 * an order the filter's keys made total stays total over it.
 */
const intoSource = (
	cx: RewriteCx,
	demand: CellDemand,
	m: Moving,
	regionCell: Cell,
	region: KindOver<"MatchRegion", EditRefs>
): boolean => {
	const ed = cx.editor
	const filter = m.filter
	if (cx.cells.feedback.has(regionCell)) {
		return false
	}
	const parts = conjuncts(filter.pred)
	const varsByName = new Map(region.vars.map((v) => [v.name, v]))
	/** Moves the conjunct `part`, which reads `vars`, onto the source of occurrence `o` when that source may take it. */
	const moveInto = (
		part: ScalarExpr,
		vars: ReadonlyArray<VarDecl | undefined>,
		o: OccurrenceOver<Cell, ScalarExpr, VarDecl>
	): boolean => {
		if (!vars.every((v) => v !== undefined && o.bindings.some((b) => b.var.id === v.id))) {
			return false
		}
		const sourceCell = o.source
		const source = sourceCell.current
		if (
			!boundaryKinds.includes(source.kind) ||
			!exclusive(cx, demand, sourceCell) ||
			DagEditor.correlated(sourceCell)
		) {
			return false
		}
		/** The source column each variable the occurrence binds is bound to, by the variable's name. */
		const columnOf = new Map<string, HeadingColumn>()
		for (const b of o.bindings) {
			const column = source.heading.find((c) => c.name === b.column)
			if (column !== undefined && !columnOf.has(b.var.name)) {
				columnOf.set(b.var.name, column)
			}
		}
		const pred = ed.copyExpr(part, (ref) => {
			if (ref.node !== regionCell.id) {
				return undefined
			}
			return ed.column(sourceCell, columnIn(columnOf, ref.name))
		})
		const moved = filterOver(ed, sourceCell, pred)
		const occurrences = region.occurrences.map((x) => (x.id === o.id ? { ...x, source: moved } : x))
		const rest = parts.filter((p) => p !== part)
		if (rest.length > 0) {
			ed.set(regionCell, { ...region, occurrences })
			ed.set(m.cell, { ...filter, pred: conjunction(ed, rest, filter.pred) })
		} else {
			ed.set(regionCell, { ...region, occurrences, meta: filter.meta })
			ed.redirect(m.cell, regionCell)
		}
		certify(cx, pushdownRules.source, m, regionCell.id, [regionCell.id, moved.id])
		return true
	}
	for (const part of parts) {
		const refs = columnRefs([part])
		if (refs.length === 0 || !refs.every((r) => r.node === regionCell.id)) {
			continue
		}
		const vars = refs.map((r) => varsByName.get(r.name))
		if (region.occurrences.some((o) => moveInto(part, vars, o))) {
			return true
		}
	}
	return false
}

const pushRule: Rule = {
	name: "pushdown",
	at: (cell, cx) => {
		const filter = cell.current
		if (filter.kind !== "Filter") {
			return false
		}
		const m: Moving = { cell, filter }
		const xCell = filter.input
		const x = xCell.current
		switch (x.kind) {
			case "ProjectSet":
				return overDemand(({ demand }) =>
					exclusive(cx, demand, xCell) ? throughProject(cx, m, xCell, x) : false
				)
			case "Group":
				return overDemand(({ demand }) =>
					exclusive(cx, demand, xCell) ? throughGroup(cx, m, xCell, x) : false
				)
			case "Union":
				return overDemand(({ demand }) => {
					if (!exclusive(cx, demand, xCell)) {
						return false
					}
					throughUnion(cx, m, xCell, x)
					return true
				})
			case "SemiJoin":
			case "AntiJoin":
			case "Intersect":
			case "Difference":
				return overDemand(({ demand }) =>
					exclusive(cx, demand, xCell) ? throughLeft(cx, demand, m, xCell, x) : false
				)
			case "MatchRegion":
				return overDemand(({ demand }) =>
					exclusive(cx, demand, xCell) ? intoSource(cx, demand, m, xCell, x) : false
				)
			case "Base":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "Filter":
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

/**
 * The pushdown potential: over every filter, its conjuncts times the reach of its input, the non-filter nodes of the
 * input's exclusive tree (a node and, through every input only it reads, that input's tree), none when its input has
 * another reader, which no rule moves a filter below.
 *
 * Exclusive trees nest without overlap: a node only one reader reads lies in that reader's tree alone. So every move
 * lowers it. A move below a projection, a group or the left of a set comparison or a semi- or anti-join takes the
 * filter's conjuncts from above a node onto a strict part of its tree, without splitting one (throughProject); below a
 * union it copies them onto every arm, whose trees are disjoint parts of the union's below the union itself; into a
 * region it takes one conjunct onto an occurrence's source, a strict part of the region's tree. No move changes the
 * reach of any other filter: the moved filter's cell takes the node it passed, which reads the filters the move
 * placed, so every tree keeps its non-filter nodes. Its first value is at most the conjuncts times the nodes.
 */
const pushdownPotential: Potential = (cx) =>
	!cx.cells.order.some((cell) => cell.current.kind === "Filter")
		? 0
		: measureOverDemand(({ demand }) => {
				const reach = new Map<Cell, number>()
				const exclusiveReach = (c: Cell): number =>
					exclusive(cx, demand, c)
						? defined(reach.get(c), "an input's reach, set before its readers in topological order")
						: 0
				let sum = 0
				for (const cell of cx.cells.order) {
					const node = cell.current
					const below = inputsOf(node).reduce((n, input) => n + exclusiveReach(input), 0)
					reach.set(cell, (node.kind === "Filter" ? 0 : 1) + below)
					if (node.kind === "Filter") {
						sum += conjuncts(node.pred).length * exclusiveReach(node.input)
					}
				}
				return sum
			})

/**
 * The predicate movement pass.
 *
 * Legal predicate movement: push a filter toward its sources where the move preserves the set. No expression raises
 * (scalar/compute/registry.ts Totality), so where a filter is evaluated changes nothing but which rows reach it.
 *
 * A filter moves below one node at a time, and only below a node it alone reads (one reference, no root, no lateral
 * reference), so no other consumer's set changes and no shared stage is copied:
 *
 * - pushdown.project: sigma_p(pi_f(X)) = pi_f(sigma_(p . f)(X)). The predicate reads the projected expressions in
 *   place of the projected columns; it is evaluated over the same values as before;
 * - pushdown.group: a predicate that reads only a group's keys moves below the group ("group-key
 *   restrictions can move below an aggregate when proved safe"): every row of one group has the group's key values,
 *   so the filter keeps or removes whole groups and leaves every surviving group's contributions unchanged. A
 *   predicate on an aggregate result never moves ("an aggregate-result restriction cannot simply become
 *   an input filter");
 * - pushdown.union: sigma_p(A u B) = sigma_p(A) u sigma_p(B), each arm filtered on its own columns;
 * - pushdown.left: a semi-join, anti-join, intersection or difference keeps rows of its left side, so
 *   sigma_p(L op R) = sigma_p(L) op R. The filter then sees left rows the right side would have removed, which it
 *   evaluates without raising, as every expression does;
 * - pushdown.source: a conjunct over a region's variables that one occurrence binds moves onto that occurrence's
 *   source, when the source is a stage the filter can be pushed through further (a group, union, set comparison or
 *   semi- or anti-join). The conjunct is then evaluated on every source row, which it does without raising.
 *
 * A filter never moves below a take (the first k of a filtered set are not the filtered first k), a page, recursion,
 * an attachment, or an approximate candidate set ("moving a predicate changes approximate candidate
 * semantics"), nor into a region on a recursive step.
 *
 * Potential: every filter's conjuncts times the non-filter nodes of its input's exclusive tree (pushdownPotential),
 * which every move lowers.
 */
export const pushdownPass = rewritePass({
	name: "pushdown",
	rules: [pushRule],
	potential: () => pushdownPotential
})
