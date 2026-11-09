import type { NodeId } from "#compiler/core/ids.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type CertificateRule, localCertificate } from "#compiler/ir/certificate.ts"
import type { ColumnRef, ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"

import {
	type Cell,
	type EditNode,
	type EditRefs,
	edgesOf,
	type Heading,
	inputsOf,
	type KindOver,
	keptRowsOf,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, sameScalarType } from "#compiler/ir/scalar.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"

import {
	type CellDemand,
	overDemand,
	type Potential,
	type RewriteCx,
	type Rule
} from "#compiler/lower/optimize/demand/frame.ts"
import { allenNormal } from "#compiler/lower/optimize/simplify/allen.ts"
import {
	conjunction,
	foldBoolean,
	foldedExpr,
	folds,
	noColumns
} from "#compiler/lower/optimize/simplify/boolean.ts"
import { firstOperand, nativeOp } from "#compiler/scalar/compute/registry.ts"

const simplifyRules = {
	fold: "simplify.fold",
	finiteFold: "simplify.finiteFold",
	empty: "simplify.empty",
	mergeFilters: "simplify.mergeFilters",
	mergeProjections: "simplify.mergeProjections",
	identityProjection: "simplify.identityProjection",
	equality: "simplify.equality",
	allen: "simplify.allen"
} as const

const isEmptyRelation = (node: EditNode): boolean =>
	node.kind === "Closed" && node.rows.length === 0

/**
 * Whether `cell` is read through exactly one input position and named by no root and no lateral reference: a rewrite
 * may then change its set as long as that one reader's set is unchanged. A node one reader reads twice (a semi-join's
 * both sides, a region's two occurrences) is no exclusive input of either.
 */
export const exclusive = (cx: RewriteCx, demand: CellDemand, cell: Cell): boolean =>
	demand.references(cell) === 1 && !cx.editor.isRoot(cell) && !demand.lateral(cell)

const certify = (
	cx: RewriteCx,
	rule: CertificateRule,
	inputs: ReadonlyArray<NodeId>,
	heading: Heading,
	outputs: ReadonlyArray<NodeId>
): void => {
	cx.certify(
		localCertificate(
			rule,
			inputs,
			outputs,
			inputs,
			heading.map((c) => c.name)
		)
	)
}

/**
 * `cell`, whose node is `node`, redefined as the closed relation `rows` of its own heading, keeping its metadata: every
 * claim about the set still holds, since the set is unchanged.
 */
const toClosed = (
	cx: RewriteCx,
	cell: Cell,
	node: EditNode,
	closed: string,
	rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>
): void => {
	cx.editor.set(cell, {
		kind: "Closed",
		closed,
		rows,
		heading: node.heading,
		meta: node.meta,
		loc: node.loc
	})
}

/**
 * The names of the closed relations the simplifier introduces: an empty relation, and the facts of a declared closed
 * relation a filter keeps, fewer than all of them. A declared name starts with no underscore (core/identity.ts
 * parseNameCharacters), so neither names a declared closed relation, and a Closed node that carries a declared name
 * holds that relation's every fact: the closed rewrite (lower/optimize/closed) reads such a node as the relation's
 * installed constants, which hold every fact.
 */
const emptyClosedName = "__empty"
const narrowedClosedName = "__narrowed"

/** `cell`, whose node is `node`, becomes the empty relation of its heading. */
const toEmpty = (cx: RewriteCx, cell: Cell, node: EditNode): void => {
	toClosed(cx, cell, node, emptyClosedName, [])
}

/**
 * `cell`, whose node is `node`, delivers exactly the rows of `input`: the one way a node is dropped into its input. Only
 * where it is the input's one reference does `input` take over its readers and its evidence, which they were checked
 * against (an attachment's child by its card relative to the parent, an order by its keys: valid DAG) and which an
 * input a rewrite built need not state; with no other reader, no other evidence changes. `certified` records the
 * rewrite's certificate, then. False, changing nothing, where the input is read elsewhere.
 */
const collapseInto = (
	cx: RewriteCx,
	demand: CellDemand,
	cell: Cell,
	node: EditNode,
	input: Cell,
	certified: () => void
): boolean => {
	if (!exclusive(cx, demand, input)) {
		return false
	}
	certified()
	cx.editor.set(input, { ...input.current, meta: node.meta })
	cx.editor.redirect(cell, input)
	return true
}

const foldFilter: Rule = {
	name: simplifyRules.fold,
	at: (cell, cx) => {
		const node = cell.current
		if (node.kind !== "Filter") {
			return false
		}
		const folded = foldBoolean(cx.editor, node.pred, noColumns)
		if (folded.kind === "expr" && folded.expr === node.pred) {
			return false
		}
		if (folded.kind === "value" && !folded.value && !replaceable(cx, cell)) {
			return false
		}
		if (folded.kind === "value" && folded.value) {
			return overDemand(({ demand }) =>
				collapseInto(cx, demand, cell, node, node.input, () => {
					certify(cx, simplifyRules.fold, [node.input.id], node.heading, [cell.id])
				})
			)
		}
		certify(cx, simplifyRules.fold, [node.input.id], node.heading, [cell.id])
		if (folded.kind === "value") {
			toEmpty(cx, cell, node)
		} else {
			cx.editor.set(cell, { ...node, pred: foldedExpr(cx.editor, node.pred, folded) })
		}
		return true
	}
}

/**
 * simplify.allen, once over every filter: a filter's predicate in Allen normal form (allen.ts), which no other
 * simplification takes out of normal form, since none writes an endpoint comparison, and folding, merging and
 * equality propagation only drop parts of a predicate or conjoin normal ones. So the normal form is one traversal, run
 * before the rewrite pass (index.ts), and no rule of that pass need lower an endpoint count.
 */
export const allenNormalForm = (cx: RewriteCx): void => {
	for (const cell of cx.cells.order) {
		const node = cell.current
		if (node.kind !== "Filter" || cx.cells.feedback.has(cell)) {
			continue
		}
		const pred = allenNormal(cx.editor, node.pred)
		if (pred !== undefined) {
			certify(cx, simplifyRules.allen, [node.input.id], node.heading, [cell.id])
			cx.editor.set(cell, { ...node, pred })
		}
	}
}

const finiteFold: Rule = {
	name: simplifyRules.finiteFold,
	at: (cell, cx) => {
		const node = cell.current
		if (node.kind !== "Filter") {
			return false
		}
		const sourceCell = node.input
		const source = sourceCell.current
		if (source.kind !== "Closed" || source.rows.length === 0 || !replaceable(cx, cell)) {
			return false
		}
		const index = new Map(source.heading.map((c, i) => [c.name, i]))
		const kept: Array<ReadonlyArray<TypedLiteral>> = []
		for (const row of source.rows) {
			const column = (ref: ColumnRef): TypedLiteral | undefined => {
				const at = ref.node === sourceCell.id ? index.get(ref.name) : undefined
				return at === undefined ? undefined : row[at]
			}
			const folded = foldBoolean(cx.editor, node.pred, column)
			if (folded.kind !== "value") {
				return false
			}
			if (folded.value) {
				kept.push(row)
			}
		}
		certify(cx, simplifyRules.finiteFold, [sourceCell.id], node.heading, [cell.id])
		toClosed(
			cx,
			cell,
			node,
			kept.length === source.rows.length ? source.closed : narrowedClosedName,
			kept
		)
		return true
	}
}

/**
 * Whether `cell` may be replaced by a closed relation of its heading: it lies on no discriminant spine and no
 * attachment hangs below it, since an attachment is a delivered statement of its own that an empty parent would
 * silently drop.
 */
const replaceable = (cx: RewriteCx, cell: Cell): boolean => {
	if (DagEditor.discriminantSpine(cx.cells.order).has(cell)) {
		return false
	}
	for (const c of DagEditor.subtree(cell)) {
		if (c.current.kind === "Attach") {
			return false
		}
	}
	return true
}

/**
 * The inputs whose emptiness makes `node` empty, by `empty`, or undefined when none does.
 *
 * A union of several heading groups is delivered one statement per group, a shape an empty
 * relation does not have, so only its arms are removed.
 *
 * A leaf, or a node an empty input does not empty by these rules.
 */
const emptiedBy = (
	node: EditNode,
	empty: (input: Cell) => boolean
): ReadonlyArray<Cell> | undefined => {
	switch (node.kind) {
		case "Filter":
		case "ProjectSet":
		case "Take":
		case "Group":
			return empty(node.input) ? [node.input] : undefined
		case "MatchRegion": {
			const e = node.occurrences.find((o) => empty(o.source))
			return e === undefined ? undefined : [e.source]
		}
		case "SemiJoin":
		case "Intersect":
			return empty(node.left) || empty(node.right) ? [node.left, node.right] : undefined
		case "AntiJoin":
		case "Difference":
			return empty(node.left) ? [node.left] : undefined
		case "Union": {
			if (node.groups.length > 1) {
				return undefined
			}
			const arms = node.groups.flatMap((g) => g.arms)
			return arms.every(empty) ? arms : undefined
		}
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return undefined
	}
}

/**
 * Whether a cell denotes the empty relation by the emptiness rules: an empty closed relation, or a node one of them
 * empties.
 */
const vacuous = (cell: Cell, memo: Map<Cell, boolean>): boolean => {
	const known = memo.get(cell)
	if (known !== undefined) {
		return known
	}
	memo.set(cell, false)
	const node = cell.current
	const out = isEmptyRelation(node) || emptiedBy(node, (c) => vacuous(c, memo)) !== undefined
	memo.set(cell, out)
	return out
}

const ids = (cells: ReadonlyArray<Cell>): ReadonlyArray<NodeId> => cells.map((c) => c.id)

const emptyRule: Rule = {
	name: simplifyRules.empty,
	/**
	 * An anti-join or difference with nothing to remove is its left side; the right side is a closed relation, so
	 * nothing that could raise is dropped.
	 */
	at: (cell, cx) => {
		const ed = cx.editor
		const node = cell.current
		if (node.kind === "Union") {
			const memo = new Map<Cell, boolean>()
			const gone = (a: Cell) => vacuous(a, memo)
			if (
				node.groups.length === 1 &&
				node.groups.every((g) => g.arms.every(gone)) &&
				replaceable(cx, cell)
			) {
				const arms = node.groups.flatMap((g) => g.arms)
				certify(cx, simplifyRules.empty, ids(arms), node.heading, [cell.id])
				toEmpty(cx, cell, node)
				return true
			}
			let removed: Array<Cell> = []
			const groups = mapNonEmpty(node.groups, (g) => {
				const live = g.arms.filter((a) => !gone(a))
				const keep: NonEmptyReadonlyArray<Cell> = isNonEmpty(live) ? live : [g.arms[0]]
				removed = [...removed, ...g.arms.filter((a) => !keep.includes(a))]
				return { heading: g.heading, arms: keep }
			})
			if (removed.length === 0) {
				return false
			}
			certify(cx, simplifyRules.empty, ids(removed), node.heading, [cell.id])
			ed.set(cell, { ...node, groups })
			return true
		}
		const emptied = (): boolean => {
			const inputs = emptiedBy(node, (c) => isEmptyRelation(c.current))
			if (inputs === undefined || !replaceable(cx, cell)) {
				return false
			}
			certify(cx, simplifyRules.empty, ids(inputs), node.heading, [cell.id])
			toEmpty(cx, cell, node)
			return true
		}
		if (
			(node.kind === "AntiJoin" || node.kind === "Difference") &&
			isEmptyRelation(node.right.current)
		) {
			const { left, right } = node
			return overDemand(
				({ demand }) =>
					collapseInto(cx, demand, cell, node, left, () => {
						certify(cx, simplifyRules.empty, [right.id], node.heading, [left.id])
					}) || emptied()
			)
		}
		return emptied()
	}
}

const mergeFilters: Rule = {
	name: simplifyRules.mergeFilters,
	at: (cell, cx) => {
		const ed = cx.editor
		const outer = cell.current
		if (outer.kind !== "Filter") {
			return false
		}
		const innerCell = outer.input
		const inner = innerCell.current
		if (inner.kind !== "Filter") {
			return false
		}
		return overDemand(({ demand }) => {
			if (!exclusive(cx, demand, innerCell)) {
				return false
			}
			const moved = ed.copyExpr(outer.pred, ed.retarget(innerCell, inner.input))
			const pred = conjunction(ed, [...conjuncts(inner.pred), ...conjuncts(moved)], outer.pred)
			certify(cx, simplifyRules.mergeFilters, [innerCell.id], outer.heading, [cell.id])
			ed.set(cell, { ...outer, input: inner.input, pred })
			return true
		})
	}
}

const mergeProjections: Rule = {
	name: simplifyRules.mergeProjections,
	at: (cell, cx) => {
		const ed = cx.editor
		const outer = cell.current
		if (outer.kind !== "ProjectSet") {
			return false
		}
		const innerCell = outer.input
		const inner = innerCell.current
		if (inner.kind !== "ProjectSet") {
			return false
		}
		return overDemand(({ demand }) => {
			if (!exclusive(cx, demand, innerCell)) {
				return false
			}
			const byName = new Map(inner.out.map((o) => [o.name, o.expr]))
			const copy = ed.copier((ref) =>
				ref.node === innerCell.id ? byName.get(ref.name) : undefined
			)
			const out = outer.out.map((o) => ({ name: o.name, expr: copy.of(o.expr) }))
			certify(cx, simplifyRules.mergeProjections, [innerCell.id], outer.heading, [cell.id])
			ed.set(cell, { ...outer, input: inner.input, out })
			return true
		})
	}
}

const sameHeadingExactly = (a: Heading, b: Heading): boolean =>
	a.length === b.length &&
	a.every((c, i) => {
		const d = b[i]
		return d !== undefined && c.name === d.name && sameScalarType(c.type, d.type)
	})

/**
 * Whether the rows of `cell` reach their reader through a chain that shapes delivery: a union of several heading
 * groups, met through every node that keeps its input's rows (rel.ts keptRowsOf), the chain the delivery's spine walks
 * (dag.ts deliverySpine). A law check delivers its violation rows as they are, so the walk passes through it. A
 * projection over such a chain delivers one plain relation; removing it would deliver the heading groups instead. On
 * a valid DAG no attachment or ordered result lies below a projection, by construction, so only a union
 * of several heading groups shapes a delivery here.
 */
const deliveryShaped = (cell: Cell): boolean => {
	for (let node: EditNode | undefined = cell.current; node !== undefined;) {
		if (node.kind === "Union") {
			return node.groups.length > 1
		}
		node = keptRowsOf(node)?.input.current
	}
	return false
}

const identityProjection: Rule = {
	name: simplifyRules.identityProjection,
	/** The projection delivers exactly its input's rows; an input read elsewhere keeps the projection. */
	at: (cell, cx) => {
		const ed = cx.editor
		const node = cell.current
		if (node.kind !== "ProjectSet") {
			return false
		}
		const inputCell = node.input
		const input = inputCell.current
		if (node.out.length !== input.heading.length) {
			return false
		}
		const copies = node.out.every((o, i) => {
			const col = input.heading[i]
			const e = o.expr
			return (
				col !== undefined &&
				o.name === col.name &&
				e.kind === "column" &&
				e.column.node === inputCell.id &&
				e.column.name === col.name
			)
		})
		if (!copies || deliveryShaped(inputCell)) {
			return false
		}
		const sameHeading = ed.isRoot(cell)
			? sameHeadingExactly(node.heading, input.heading)
			: node.heading.every((c, i) => {
					const h = input.heading[i]
					return h !== undefined && c.name === h.name && sameScalarType(c.type, h.type)
				})
		if (!sameHeading) {
			return false
		}
		return overDemand(({ demand }) =>
			collapseInto(cx, demand, cell, node, inputCell, () => {
				certify(cx, simplifyRules.identityProjection, [inputCell.id], node.heading, [inputCell.id])
			})
		)
	}
}

type Region = KindOver<"MatchRegion", EditRefs>
type VarPair = { readonly a: VarDecl; readonly b: VarDecl }

const samePair = (p: VarPair, q: VarPair): boolean =>
	(p.a.id === q.a.id && p.b.id === q.b.id) || (p.a.id === q.b.id && p.b.id === q.a.id)

/** A `var = var` conjunct over the region's own variables, as the pair of variables, or undefined. */
const variableEquality = (
	regionId: NodeId,
	region: Region,
	conjunct: ScalarExpr
): VarPair | undefined => {
	if (conjunct.kind !== "op" || nativeOp(conjunct.op)?.fn !== "eq" || conjunct.args.length !== 2) {
		return undefined
	}
	const [l, r] = conjunct.args
	if (
		l?.kind !== "column" ||
		r?.kind !== "column" ||
		l.column.node !== regionId ||
		r.column.node !== regionId
	) {
		return undefined
	}
	const a = region.vars.find((v) => v.name === l.column.name)
	const b = region.vars.find((v) => v.name === r.column.name)
	if (a === undefined || b === undefined || a.id === b.id) {
		return undefined
	}
	if (!sameScalarType(baseOf(a.type), baseOf(b.type))) {
		return undefined
	}
	const native = nativeOp(conjunct.op)
	if (native === undefined || firstOperand(native.operands) !== baseOf(a.type).carrier) {
		return undefined
	}
	return { a, b }
}

const equality: Rule = {
	name: simplifyRules.equality,
	/**
	 * The region now denotes the filter's set and takes its readers, so it carries the filter's metadata: an order
	 * the filter's keys made total stays total over it.
	 */
	at: (cell, cx) => {
		const ed = cx.editor
		const filter = cell.current
		if (filter.kind !== "Filter") {
			return false
		}
		const regionCell = filter.input
		const region = regionCell.current
		if (region.kind !== "MatchRegion") {
			return false
		}
		const parts = conjuncts(filter.pred)
		const moved: Array<VarPair> = []
		const rest: Array<ScalarExpr> = []
		for (const c of parts) {
			const eq = variableEquality(regionCell.id, region, c)
			if (eq === undefined) {
				rest.push(c)
			} else {
				moved.push(eq)
			}
		}
		if (moved.length === 0) {
			return false
		}
		return overDemand(({ demand }) => {
			if (!exclusive(cx, demand, regionCell)) {
				return false
			}
			const added = moved.filter(
				(m, i) =>
					!region.equalities.some((e) => samePair(e, m)) &&
					!moved.slice(0, i).some((p) => samePair(p, m))
			)
			certify(cx, simplifyRules.equality, [regionCell.id], filter.heading, [regionCell.id, cell.id])
			const equalities = [...region.equalities, ...added]
			if (rest.length > 0) {
				ed.set(regionCell, { ...region, equalities })
				ed.set(cell, { ...filter, pred: conjunction(ed, rest, filter.pred) })
				return true
			}
			ed.set(regionCell, { ...region, equalities, meta: filter.meta })
			ed.redirect(cell, regionCell)
			return true
		})
	}
}

/**
 * Semantic simplification: literal and finite folding, equality propagation, branch
 * removal, and the normalizations that let fusion and pushdown see one stage where the builder wrote several and one
 * span relation where it wrote endpoint comparisons.
 *
 * Each rule replaces a node by an equivalent one and records a certificate whose rule id names it:
 *
 * - simplify.fold: a filter predicate folded in the host-decided boolean fragment (boolean.ts); a filter that is
 *   always true disappears into its input where it is that input's one reference, the input taking its evidence, and
 *   one that is always false is the empty relation;
 * - simplify.finiteFold: a filter over a closed relation's declared facts decided fact by fact, so the filter is the
 *   closed relation's satisfying facts ("the query compiler can inline or fold this finite source");
 * - simplify.empty: branch removal. An operator over the empty relation that yields the empty relation is the empty
 *   relation; an anti-join or difference whose right side is empty is its left side where it is the left side's one
 *   reference; an empty union arm is dropped
 *   while its heading group keeps another arm. No dropped evaluation could raise, since none does;
 * - simplify.mergeFilters: a filter over a filter read by nothing else is one filter over the conjunction (the outer
 *   predicate then meets rows the inner one rejects, which raise nothing);
 * - simplify.mergeProjections: a projection of a projection read by nothing else is one projection of the composed
 *   expressions ("successive ordinary projections may sometimes be combined"): under set semantics
 *   pi_g(pi_f(X)) = pi_(g . f)(X);
 * - simplify.identityProjection: a projection that copies every input column in order, and is its input's one
 *   reference, is its input, which takes over the projection's evidence;
 * - simplify.equality: a `var = var` conjunct of a filter over a region read by nothing else becomes a region
 *   equality ("an equality is reserved for var = var between distinct variables"), where key propagation
 *   reads it;
 * - simplify.allen, before them all, once (allenNormalForm): a filter's predicate in Allen normal form (allen.ts): the
 *   comparisons and memberships of span endpoints over one pair of spans, with the Allen atoms over that pair beside
 *   them, as the table formula of their mask, so predicate movement and the shapes meet range operators.
 *
 * The potential (simplificationPotential) weighs the structure above the expressions: every rule removes a non-leaf
 * node, a node or an input edge and adds none, or in place folds a predicate or takes a filter's equalities into its
 * region.
 */
export const simplificationRules: ReadonlyArray<Rule> = [
	foldFilter,
	finiteFold,
	emptyRule,
	mergeFilters,
	mergeProjections,
	identityProjection,
	equality
]

/**
 * What the simplification potential reads of the reachable DAG: its shape, its nodes, non-leaf nodes and input edges
 * together; its unfolded filters, whose predicate folding changes (boolean.ts folds); and its equated filters, those
 * over a region with a `var = var` conjunct over the region's own variables (variableEquality), which equality
 * propagation takes.
 */
interface Standing {
	readonly shape: number
	readonly unfolded: number
	readonly equated: number
}

const standingOf = (cx: RewriteCx): Standing => {
	let shape = 0
	let unfolded = 0
	let equated = 0
	for (const cell of cx.cells.order) {
		const node = cell.current
		shape += 1 + (inputsOf(node).length > 0 ? 1 : 0) + edgesOf(node).length
		if (node.kind !== "Filter") {
			continue
		}
		if (folds(node.pred, noColumns)) {
			unfolded++
		}
		const regionCell = node.input
		const region = regionCell.current
		if (
			region.kind === "MatchRegion" &&
			conjuncts(node.pred).some((c) => variableEquality(regionCell.id, region, c) !== undefined)
		) {
			equated++
		}
	}
	return { shape, unfolded, equated }
}

/**
 * The simplification potential: W × (shape + unfolded) + equated (Standing), W one more than the filters the pass
 * starts with.
 *
 * No rule adds a node or makes one reachable, so the pass never holds more filters than it starts with, and equated
 * stays below W. No rule raises unfolded: a merged filter conjoins the conjuncts of the two it merges, an equality
 * propagated keeps the rest of its filter's conjuncts, and a redirection retargets column references, none of which
 * folding decides. Every rule but two removes a node, a non-leaf node or an input edge, lowering shape by at least
 * one and W × shape by more than equated can rise. The two that keep shape work in place: a fold leaves a predicate
 * folding leaves unchanged, which lowers unfolded by one and raises equated by at most one, its own filter's; an
 * equality propagated leaves its filter none of the conjuncts it takes, which lowers equated by one. So every rule
 * lowers it, and its first value is quadratic in the pass's DAG.
 */
export const simplificationPotential = (start: RewriteCx): Potential => {
	const weight = start.cells.order.filter((c) => c.current.kind === "Filter").length + 1
	return (cx) => {
		const now = standingOf(cx)
		return weight * (now.shape + now.unfolded) + now.equated
	}
}
