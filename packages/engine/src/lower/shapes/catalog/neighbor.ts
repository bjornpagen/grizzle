import { firstIndex, appendAll } from "#compiler/core/array.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { CatalogRule } from "#compiler/ir/certificate.ts"
import { type ColumnRef, type OpId, type ScalarExpr, sortedOps } from "#compiler/ir/expr.ts"
import {
	type Cell,
	conservativeMeta,
	type EditRefs,
	type HeadingColumn,
	inputsOf,
	type KindOver,
	keptRowsOf,
	type OccurrenceOver,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { cellGraph, readsOutside, subtreeOf } from "#compiler/lower/optimize/demand/editor.ts"
import {
	bindingsByVar,
	type CatalogContext,
	freshColumn,
	type Held,
	type KeyGrounds,
	type Region,
	sameSource,
	varByName
} from "#compiler/lower/shapes/catalog/context.ts"

import {
	andExpr,
	attempt,
	colExpr,
	columnRef,
	columnsRead,
	compareExpr,
	condExpr,
	conjuncts,
	demand,
	litExpr,
	noMatch,
	plain,
	rebase,
	required
} from "#compiler/lower/shapes/catalog/exprs.ts"
import { lexicographicOrder } from "#compiler/lower/shapes/catalog/lexicographic.ts"
import {
	keysOfRows,
	metaWithKeys,
	plainKeys,
	type RowKeys,
	type OrderKeyOf,
	restrict,
	runningFrame,
	windowChain
} from "#compiler/lower/shapes/catalog/ordinal.ts"

/** What a column of the child's heading carries. */
type ChildColumn =
	| { readonly kind: "own"; readonly column: string }
	| { readonly kind: "parent"; readonly ref: ColumnRef }

type Take = KindOver<"Take", EditRefs>

interface TakeShape {
	readonly take: Held<Take>
	readonly region: Held<Region>
	/** The taken source Q. */
	readonly q: Cell
	/** The child's heading columns, by what they carry. */
	readonly columns: ReadonlyMap<string, ChildColumn>
	/** Q columns equal to a parent column. */
	readonly group: ReadonlyArray<{ readonly q: string; readonly parent: ColumnRef }>
	/** Q columns compared with a parent column, in the order under which the child precedes the parent. */
	readonly compared: ReadonlyArray<{
		readonly q: string
		readonly parent: ColumnRef
		readonly dir: "asc" | "desc"
	}>
	readonly inclusive: boolean
	/** Q's own restrictions: constants and conditions that read no parent value. */
	readonly qConstants: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>
	readonly qConditions: ReadonlyArray<ScalarExpr>
	/** The take's order over Q columns that are not fixed per parent. */
	readonly order: ReadonlyArray<OrderKeyOf>
	readonly comparisons: ReadonlyArray<OpId>
}

const reverse = (d: "asc" | "desc"): "asc" | "desc" => (d === "asc" ? "desc" : "asc")

const sameRef = (a: ColumnRef, b: ColumnRef): boolean => a.node === b.node && a.name === b.name

/**
 * Reads a correlated take(1). `outer` says whether a column reference names the parent's side.
 *
 * The take's correlation: a child column fixed to a parent value.
 */
const analyzeTake = (
	cx: CatalogContext,
	takeCell: Cell,
	take: Take,
	outer: (ref: ColumnRef) => boolean
): TakeShape => {
	demand(take.bound.kind === "literal" && take.bound.k === 1n, "take(1)")
	const top = take.input.current
	const project = top.kind === "ProjectSet" ? top : undefined
	const projectedCell = project === undefined ? take.input : project.input
	const projected = projectedCell.current
	const filter = projected.kind === "Filter" ? projected : undefined
	const regionCell = filter === undefined ? projectedCell : filter.input
	const region = regionCell.current
	demand(region.kind === "MatchRegion", "a take over one match")
	/** The parent column an expression reads when it is a bare reference to the parent's side. */
	const outerRef = (e: ScalarExpr): ColumnRef | undefined => {
		const r = columnRef(e)
		return r !== undefined && outer(r) ? r : undefined
	}
	const [occ] = region.occurrences
	demand(
		region.occurrences.length === 1 && region.equalities.length === 0 && occ !== undefined,
		"one occurrence of the taken source"
	)
	const q = occ.source
	const byVar = bindingsByVar(region)
	/** Region variables: own (a Q column) or a parent value. */
	const own = new Map<string, string>()
	const parentVar = new Map<string, ColumnRef>()
	for (const v of region.vars) {
		const bound = byVar.get(v) ?? []
		const corr = region.correlated.find((c) => c.var.id === v.id)
		if (corr !== undefined) {
			demand(bound.length === 0, "a correlated variable no column binds")
			parentVar.set(
				v.name,
				required(outerRef(corr.expr), "a correlated value read from the parent")
			)
		} else {
			const [only] = bound
			demand(bound.length === 1 && only !== undefined, "each own variable bound by one column")
			own.set(v.name, only.column)
		}
	}
	const group: Array<{ q: string; parent: ColumnRef }> = []
	const addGroup = (column: string, parent: ColumnRef) => {
		const known = group.find((g) => g.q === column)
		if (known !== undefined) {
			demand(sameRef(known.parent, parent), "one parent value per group column")
		} else {
			group.push({ q: column, parent })
		}
	}
	const qConstants: Array<{ column: string; expr: ScalarExpr }> = []
	for (const c of occ.constants) {
		const ref = outerRef(c.expr)
		if (ref !== undefined) {
			addGroup(c.column, ref)
		} else {
			demand(
				columnsRead(c.expr).every((r) => !outer(r)),
				"a constant that is a parent value or reads none"
			)
			qConstants.push(c)
		}
	}
	/** The child's heading columns through the projection. */
	const regionColumn = (name: string): ChildColumn => {
		const o = own.get(name)
		if (o !== undefined) {
			return { kind: "own", column: o }
		}
		const p = parentVar.get(name)
		if (p !== undefined) {
			return { kind: "parent", ref: p }
		}
		return noMatch(`a region column ${name}`)
	}
	const columns = new Map<string, ChildColumn>()
	for (const h of take.heading) {
		if (project === undefined) {
			columns.set(h.name, regionColumn(h.name))
			continue
		}
		const out = project.out.find((o) => o.name === h.name)
		const ref = out === undefined ? undefined : columnRef(out.expr)
		demand(
			ref !== undefined && ref.node === projectedCell.id,
			`a projected column ${h.name} the match binds`
		)
		columns.set(h.name, regionColumn(ref.name))
	}
	for (const c of take.correlation) {
		const ref = required(outerRef(c.expr), "a take correlated on parent values")
		const col = columns.get(c.column)
		if (col?.kind === "own") {
			addGroup(col.column, ref)
		} else {
			demand(col !== undefined && sameRef(col.ref, ref), "a parent column correlated to itself")
		}
	}
	/** The predicate: Q's own conditions, and the comparison with the parent. */
	const qConditions: Array<ScalarExpr> = []
	const lexParts: Array<ScalarExpr> = []
	const regionCols = filter === undefined ? [] : conjuncts(filter.pred)
	for (const c of regionCols) {
		const reads = columnsRead(c)
		demand(
			reads.every((r) => r.node === regionCell.id),
			"conditions over the match's columns"
		)
		if (reads.some((r) => parentVar.has(r.name))) {
			lexParts.push(c)
		} else {
			qConditions.push(c)
		}
	}
	demand(lexParts.length > 0, "a comparison with the parent")
	/** andExpr is the one part itself when there is one. */
	const pred = andExpr(cx.ed, lexParts)
	const l = required(
		lexicographicOrder(pred, (ref) => {
			if (ref.node !== regionCell.id) {
				return undefined
			}
			const o = own.get(ref.name)
			if (o !== undefined) {
				return { side: "b", id: o }
			}
			return parentVar.has(ref.name) ? { side: "a", id: ref.name } : undefined
		}),
		"exactly a lexicographic comparison of Q's fields with the parent's"
	)
	const compared = l.order.map((o) => ({
		q: o.b,
		parent: required(parentVar.get(o.a), `the parent value ${o.a}`),
		dir: o.dir
	}))
	demand(
		compared.every((c) => !group.some((g) => g.q === c.q)),
		"compared fields that are not group variables"
	)
	/** The take's order, without the columns fixed per parent. */
	const fixed = new Set<string>(group.map((g) => g.q))
	const order: Array<OrderKeyOf> = []
	for (const k of take.order.keys) {
		const col = columns.get(k.column)
		demand(col !== undefined, `an order column ${k.column}`)
		if (col.kind !== "own" || fixed.has(col.column)) {
			continue
		}
		if (!order.some((o) => o.column === col.column)) {
			order.push({ column: col.column, dir: k.dir })
		}
	}
	return {
		take: { cell: takeCell, node: take },
		region: { cell: regionCell, node: region },
		q,
		columns,
		group,
		compared,
		inclusive: l.inclusive,
		qConstants,
		qConditions,
		order,
		comparisons: sortedOps(lexParts.flatMap((p) => opsOf(p)))
	}
}

const opsOf = (e: ScalarExpr): ReadonlyArray<OpId> => {
	if (e.kind !== "op") {
		return []
	}
	const op = e.op
	return op === "and" || op === "or" || op === "not" ? e.args.flatMap((a) => opsOf(a)) : [op]
}

/** Whether the take's order begins with the compared fields, each reversed: the first row past the parent. */
const nearestPast = (t: TakeShape): boolean =>
	t.compared.length <= t.order.length &&
	t.compared.every((c, i) => t.order[i]?.column === c.q && t.order[i].dir === reverse(c.dir))

/** The parent's side: where its values come from, and the relation of its rows. */
interface ParentSide {
	/** The parent occurrence's source, or the attachment's parent node, that the parent values are columns of. */
	readonly rows: Cell
	/** A parent reference as a column of `rows`. */
	readonly column: (ref: ColumnRef) => string
	/** Whether the parent's rows are a bound set. */
	readonly bound: boolean
}

/**
 * The bound form's parent: the one occurrence of the outer region that binds every parent value the take reads.
 *
 * Prefer an occurrence that binds every reference.
 */
const boundParent = (
	cx: CatalogContext,
	regionCell: Cell,
	outerRegion: Region,
	takeIndex: number,
	refs: ReadonlyArray<ColumnRef>
): {
	readonly side: ParentSide
	readonly occurrence: number
	readonly vars: ReadonlyMap<string, VarDecl>
} => {
	const byVar = bindingsByVar(outerRegion)
	const vars = new Map<string, VarDecl>()
	/** The first occurrence binding `v` that binds every parent value, else the first binding it at all. */
	const choose = (ref: ColumnRef, v: VarDecl): number => {
		const bindings = (byVar.get(v) ?? []).filter((b) => b.occurrence !== takeIndex)
		const [first] = bindings
		demand(
			bindings.length > 0 && first !== undefined,
			`a parent variable ${ref.name} another occurrence binds`
		)
		const bindsAll = bindings.find((b) => {
			const occ = required(outerRegion.occurrences[b.occurrence], `the occurrence ${b.occurrence}`)
			return refs.every((r) => {
				const rv = varByName(outerRegion, r.name)
				return rv !== undefined && occ.bindings.some((x) => x.var.id === rv.id)
			})
		})
		return (bindsAll ?? first).occurrence
	}
	const choices: Array<number> = []
	for (const ref of refs) {
		demand(ref.node === regionCell.id, "parent values from the enclosing match")
		const v = required(
			varByName(outerRegion, ref.name),
			`a variable ${ref.name} of the enclosing match`
		)
		vars.set(ref.name, v)
		if (choices.length === 0) {
			choices.push(choose(ref, v))
		}
	}
	const [chosen] = choices
	demand(chosen !== undefined, "a parent occurrence")
	const occ = required(outerRegion.occurrences[chosen], `the occurrence ${chosen}`)
	const columnOfRef = (ref: ColumnRef): string => {
		const v = vars.get(ref.name)
		return required(
			v === undefined ? undefined : occ.bindings.find((x) => x.var.id === v.id),
			`the parent value ${ref.name} on one parent occurrence`
		).column
	}
	for (const ref of refs) {
		columnOfRef(ref)
	}
	demand(
		!readsOutside(cellGraph, subtreeOf(cellGraph, occ.source)),
		"an uncorrelated parent source"
	)
	return {
		side: {
			rows: occ.source,
			column: columnOfRef,
			bound: boundRegion(cx, regionCell, outerRegion, takeIndex)
		},
		occurrence: chosen,
		vars
	}
}

/**
 * Whether an occurrence restricts its region to a bound set of rows: a relation parameter, whose facts every row of
 * the region joins, a key lookup, which fixes every column of a declared key of a stored relation and so matches at
 * most one row, or a source whose rows are themselves bound.
 */
const boundOccurrence = (o: OccurrenceOver<Cell, ScalarExpr, VarDecl>): boolean => {
	const source = o.source.current
	const fixed = new Set(o.constants.map((c) => c.column))
	if (source.kind === "Base") {
		return [source.primaryKey, ...source.keys].some((k) => k.every((c) => fixed.has(c)))
	}
	return boundRows(o.source)
}

/**
 * Whether a relation's rows are a bound set: a relation parameter, a context's at most one fact, a region with a bound
 * occurrence, or a filter, projection or semi-join of a bound set.
 */
const boundRows = (cell: Cell): boolean => {
	const node = cell.current
	switch (node.kind) {
		case "InputSet":
		case "Context":
			return true
		case "MatchRegion":
			return node.occurrences.some((o) => boundOccurrence(o))
		case "Filter":
		case "ProjectSet":
			return boundRows(node.input)
		case "SemiJoin":
			return boundRows(node.left) || boundRows(node.right)
		case "Base":
		case "Closed":
		case "Delta":
		case "AntiJoin":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Take":
		case "Group":
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

/**
 * Whether the rows of a region the take is an occurrence of are a bound parent set (R27, R42), for
 * which the automatic policy keeps the LATERAL probe: some other occurrence restricts the region to a bound set, or
 * every consumer of the region is a semi-join that keeps only its rows matching a bound set, as the relational
 * rewrites state a relation parameter's match that delivers none of its fields. Each restricts the parents to what
 * it matches, so the whole-input pass would compute for every row of the parent source what the probe computes for a
 * few.
 */
const boundRegion = (
	cx: CatalogContext,
	regionCell: Cell,
	region: Region,
	takeIndex: number
): boolean => {
	if (region.occurrences.some((o, i) => i !== takeIndex && boundOccurrence(o))) {
		return true
	}
	return restrictedAbove(cx, regionCell, 0)
}

/**
 * Whether every node that reads a node's rows keeps only those matching a bound set: a semi-join against a bound set,
 * or a filter or projection whose own readers do. A node that only names its columns in an expression, as the take's
 * correlation names the region's, does not read its rows. The walk follows at most a few nodes up the plan.
 */
const restrictedAbove = (cx: CatalogContext, cell: Cell, depth: number): boolean => {
	const consumers = cx.consumers(cell).filter((c) => inputsOf(c.current).includes(cell))
	if (consumers.length === 0 || depth > 8) {
		return false
	}
	const restricts = (c: Cell): boolean => {
		const n = c.current
		switch (n.kind) {
			case "SemiJoin":
				return (
					(n.left === cell && n.right !== cell && boundRows(n.right)) ||
					restrictedAbove(cx, c, depth + 1)
				)
			case "Filter":
			case "ProjectSet":
				return restrictedAbove(cx, c, depth + 1)
			case "Base":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "MatchRegion":
			case "AntiJoin":
			case "Union":
			case "Intersect":
			case "Difference":
			case "Take":
			case "Group":
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
	return consumers.every(restricts)
}

/** A column of the node a cell holds. */
interface At {
	readonly cell: Cell
	readonly name: string
}

/**
 * Traces a column a reference names to the source column of one occurrence it is a copy of, through projections and
 * every node that keeps its input's rows (rel.ts keptRowsOf); none when it is computed. A reference names its node by
 * label, read through the editor's cells by label (`byLabel`); a label no cell has traces nothing.
 */
const trace = (byLabel: ReadonlyMap<NodeId, Cell>, ref: ColumnRef): Traced | undefined => {
	const start = byLabel.get(ref.node)
	if (start === undefined) {
		return undefined
	}
	let at: At = { cell: start, name: ref.name }
	for (let steps = 0; steps < 10_000; steps++) {
		const step = traceStep(byLabel, at)
		if (step.kind === "found") {
			return step.traced
		}
		at = step.at
	}
	return undefined
}

/** A source column of one occurrence. */
interface Traced {
	readonly occurrence: string
	readonly source: Cell
	readonly column: string
}

/** One step of a trace: the source column found (or none), or the column of the next node to look in. */
type TraceStep =
	| { readonly kind: "found"; readonly traced: Traced | undefined }
	| { readonly kind: "next"; readonly at: At }

const untraced: TraceStep = { kind: "found", traced: undefined }

/** Any node other than a Base, a region or a projection passes the column on only when it keeps its input's rows. */
const traceStep = (byLabel: ReadonlyMap<NodeId, Cell>, at: At): TraceStep => {
	const n = at.cell.current
	if (n.kind === "Base") {
		return { kind: "found", traced: { occurrence: at.cell.id, source: at.cell, column: at.name } }
	}
	if (n.kind === "MatchRegion") {
		return { kind: "found", traced: occurrenceColumn(at.cell, n, at.name) }
	}
	if (n.kind === "ProjectSet") {
		const o = n.out.find((x) => x.name === at.name)
		const next = o === undefined ? undefined : columnRef(o.expr)
		const cell = next === undefined ? undefined : byLabel.get(next.node)
		return next === undefined || cell === undefined
			? untraced
			: { kind: "next", at: { cell, name: next.name } }
	}
	const kept = keptRowsOf(n)
	return kept === undefined ? untraced : { kind: "next", at: { cell: kept.input, name: at.name } }
}

/** The source column the one occurrence binding the region's variable `name` reads. */
const occurrenceColumn = (cell: Cell, n: Region, name: string): Traced | undefined => {
	const v = varByName(n, name)
	if (v === undefined) {
		return undefined
	}
	for (const [i, occ] of n.occurrences.entries()) {
		const b = occ.bindings.find((x) => x.var.id === v.id)
		if (b !== undefined) {
			return { occurrence: `${cell.id}/${i}`, source: occ.source, column: b.column }
		}
	}
	return undefined
}

const headingOf = (cell: Cell) => cell.current.heading
const columnTypeOf = (cell: Cell, name: string): ScalarType =>
	required(
		headingOf(cell).find((h) => h.name === name),
		`a column ${name} of ${cell.id}`
	).type

/**
 * R27's target over Q: L = Filter(presence = 1) <- Window(presence) <- Window(LEAD f)... <- Q. Returns L and the
 * LEAD output of each delivered own column.
 */
const successorRows = (
	cx: CatalogContext,
	t: TakeShape
): {
	readonly rows: Cell
	readonly lead: ReadonlyMap<string, string>
	readonly nodes: ReadonlyArray<Cell>
} => {
	const keys = keysOfRows(t.q.current)
	const delivered = [
		...new Set([...t.columns.values()].flatMap((c) => (c.kind === "own" ? [c.column] : [])))
	].filter((c) => !t.group.some((g) => g.q === c))
	const partition = t.group.map((g) => g.q)
	const order = t.order
	const leadSpecs = delivered.map((c) => {
		const type = columnTypeOf(t.q, c)
		return {
			fn: "lead" as const,
			op: "lead(anycompatible,integer,anycompatible)",
			args: (input: Cell) => [
				colExpr(cx.ed, input, c, type),
				litExpr(cx.ed, { kind: "int", value: 1n }, plain.int4),
				colExpr(cx.ed, input, c, type)
			],
			filter: undefined,
			frame: undefined,
			type,
			rule: "R27" as const,
			stem: `__next_${c}`
		}
	})
	const presence = {
		fn: "count" as const,
		op: "count()",
		args: () => [],
		filter: undefined,
		frame: { unit: "rows" as const, start: { following: 1n }, end: { following: 1n } },
		type: plain.int8,
		rule: "R27" as const,
		stem: "__has_next"
	}
	const chain = windowChain(cx, t.q, partition, order, [...leadSpecs, presence], keys)
	const presenceOut = required(chain.outs[chain.outs.length - 1], "the presence window's output")
	const rows = cx.ed.node({
		kind: "Filter",
		input: chain.last,
		pred: compareExpr(
			cx.ed,
			"eq",
			colExpr(cx.ed, chain.last, presenceOut, plain.int8),
			litExpr(cx.ed, { kind: "int", value: 1n }, plain.int8)
		),
		heading: headingOf(chain.last),
		meta: metaWithKeys(keys),
		loc: undefined
	})
	const lead = new Map(
		delivered.map((c, i) => [c, required(chain.outs[i], `the LEAD output of ${c}`)] as const)
	)
	return { rows, lead, nodes: [...chain.nodes, rows] }
}

/** R27's conditions on top of the take shape. */
const successorHolds = (
	cx: CatalogContext,
	t: TakeShape,
	parentColumn: (ref: ColumnRef) => Traced | undefined
): KeyGrounds => {
	demand(!t.inclusive, "a strict comparison")
	demand(
		t.qConstants.length === 0 && t.qConditions.length === 0,
		"an unrestricted source: the successor in it"
	)
	demand(nearestPast(t), "a take ordered from the parent outward, the compared tuple first")
	const occurrences = new Set<string>()
	for (const pair of [...t.group, ...t.compared]) {
		const pc = required(
			parentColumn(pair.parent),
			"a parent value that is a column of the parent's source"
		)
		occurrences.add(pc.occurrence)
		demand(occurrences.size === 1, "parent values of one parent row")
		demand(sameSource(pc.source, t.q), "a successor in the parent's own source")
		demand(pc.column === pair.q, "each compared or group field the parent's same field")
	}
	return required(
		cx.keyWithin(t.q, new Set([...t.group.map((g) => g.q), ...t.compared.map((c) => c.q)])),
		"group and tuple covering a key of the source"
	)
}

/** R42's conditions: types, a prefix of the completed order, and a total order over Q. */
const asOfHolds = (
	cx: CatalogContext,
	t: TakeShape,
	parentType: (ref: ColumnRef) => ScalarType
): KeyGrounds => {
	demand(nearestPast(t), "a take ordered from the parent backward, the compared prefix first")
	for (const pair of [...t.group, ...t.compared]) {
		demand(
			sameScalarType(columnTypeOf(t.q, pair.q), parentType(pair.parent)),
			"compared and correlated fields of the same types on both sides"
		)
	}
	return required(
		cx.keyWithin(t.q, new Set([...t.group.map((g) => g.q), ...t.order.map((o) => o.column)])),
		"a completed order of Q: it includes a key of Q"
	)
}

/**
 * The carrying pass's A: the numbered parent rows, every column but the position under its own name, joined by
 * position to the parents' rows of the carried window, and by (group, carried rank) to Q's ranked rows, whose
 * delivered fields it adds under fresh names.
 */
const carriedParents = (
	cx: CatalogContext,
	spec: {
		readonly parents: { readonly rows: Cell; readonly position: string }
		readonly window: {
			readonly rows: Cell
			readonly group: ReadonlyArray<string>
			readonly rank: string
			readonly carried: string
		}
		readonly q: {
			readonly rows: Cell
			readonly group: ReadonlyArray<string>
			readonly rank: string
		}
		readonly delivered: ReadonlyArray<string>
		readonly keys: RowKeys
	}
): { readonly rows: Cell; readonly field: ReadonlyMap<string, string> } => {
	const ed = cx.ed
	const pHeading = headingOf(spec.parents.rows)
	const own = pHeading.filter((h) => h.name !== spec.parents.position)
	const vars = new Map<string, VarDecl>()
	const declare = (n: string, type: ScalarType): VarDecl => {
		const v: VarDecl = { id: ed.freshVar(), name: n, type }
		vars.set(n, v)
		return v
	}
	const parentVars = own.map((h) => ({ column: h.name, var: declare(h.name, h.type) }))
	const taken = () => [...vars.keys(), ...pHeading.map((h) => h.name)]
	const position = declare(freshColumn(taken(), "__position"), plain.int8)
	const rank = declare(freshColumn(taken(), "__rank"), plain.int8)
	const groupVars = spec.q.group.map((c, i) => ({
		q: c,
		window: required(spec.window.group[i], `the window's group column ${i + 1}`),
		var: declare(freshColumn(taken(), `__g${i + 1}`), columnTypeOf(spec.q.rows, c))
	}))
	const field = new Map<string, string>()
	const fieldVars = spec.delivered.map((c) => {
		const n = freshColumn(taken(), `f_${c}`)
		field.set(c, n)
		return { column: c, var: declare(n, columnTypeOf(spec.q.rows, c)) }
	})
	const o0 = ed.freshOccurrence()
	const o1 = ed.freshOccurrence()
	const o2 = ed.freshOccurrence()
	const o0Bindings = [...parentVars, { column: spec.parents.position, var: position }]
	const o1Bindings = [
		{ column: spec.window.rank, var: position },
		{ column: spec.window.carried, var: rank },
		...groupVars.map((x) => ({ column: x.window, var: x.var }))
	]
	const o2Bindings = [
		{ column: spec.q.rank, var: rank },
		...groupVars.map((x) => ({ column: x.q, var: x.var })),
		...fieldVars
	]
	const outNames = [...own.map((h) => h.name), ...field.values()]
	const rows = ed.node({
		kind: "MatchRegion",
		scope: ed.freshScope(),
		vars: [...vars.values()],
		occurrences: [
			{ id: o0, source: spec.parents.rows, bindings: o0Bindings, constants: [] },
			{ id: o1, source: spec.window.rows, bindings: o1Bindings, constants: [] },
			{ id: o2, source: spec.q.rows, bindings: o2Bindings, constants: [] }
		],
		equalities: [],
		correlated: [],
		heading: outNames.map((n) => ({
			name: n,
			type: required(vars.get(n), `the variable ${n}`).type
		})),
		meta: metaWithKeys(spec.keys),
		loc: undefined
	})
	return { rows, field }
}

/**
 * The parent rows of R42's carrying pass, numbered: `row_number()` over the parent's rows in the order of one of their
 * keys, every column of which is ordered. The order is total, so every evaluation of the numbering gives each parent
 * row the same position, whether the node is shared or read twice; the position is a key of the numbered rows.
 */
const numberedParents = (
	cx: CatalogContext,
	parentRows: Cell
): { readonly rows: Cell; readonly position: string; readonly nodes: ReadonlyArray<Cell> } => {
	const source = parentRows.current
	const keys = keysOfRows(source)
	const ordered = required(
		keys.keys.find(
			(k) =>
				k.length > 0 &&
				k.every(
					(c) => source.heading.find((h) => h.name === c)?.type.caps.includes("ordering") === true
				)
		),
		"parent rows with a key of ordered columns"
	)
	const numbered = windowChain(
		cx,
		parentRows,
		[],
		ordered.map((column) => ({ column, dir: "asc" as const })),
		[
			{
				fn: "rowNumber",
				op: "row_number()",
				args: () => [],
				filter: undefined,
				frame: undefined,
				type: plain.int8,
				rule: "R42",
				stem: "__p_pos"
			}
		],
		keys
	)
	return {
		rows: numbered.last,
		position: required(numbered.outs[0], "the parent position window's output"),
		nodes: numbered.nodes
	}
}

/**
 * R42's ordered pass. Returns A, a relation of the parent's group and compared values, and of Q's delivered fields of
 * the latest qualifying Q row, with no row for a parent that has none, plus the A column of each.
 *
 * With `carry`, the bound form's pass reads the parents once ("the ordered pass reads each input once"):
 * the parent arm is the parent rows numbered by numberedParents, its rank column the parent's position, and A is the
 * parent rows themselves, every column under its own name, joined by position to their carried rank and by (group,
 * rank) to Q's delivered fields, each under the name `field` gives. A parent row's position is unique, so no two parent
 * rows of the union collapse, and each parent row meets at most one Q row: A has the parent's keys. Without `carry`, A
 * is keyed by the parent's (group, compared) values, which the caller joins back to the parents.
 */
const asOfPass = (
	cx: CatalogContext,
	t: TakeShape,
	parentRows: Cell,
	parentColumn: (ref: ColumnRef) => string,
	carry: boolean
): {
	readonly rows: Cell
	readonly groupColumn: ReadonlyArray<string>
	readonly comparedColumn: ReadonlyArray<string>
	readonly field: ReadonlyMap<string, string>
	readonly nodes: ReadonlyArray<Cell>
} => {
	const ed = cx.ed
	const qKeys = keysOfRows(t.q.current)
	const nodes: Array<Cell> = []
	const numbered = carry ? numberedParents(cx, parentRows) : undefined
	if (numbered !== undefined) {
		appendAll(nodes, numbered.nodes)
	}
	const pRows = numbered?.rows ?? parentRows
	/** Q's own restrictions first. */
	const qRef =
		(input: Cell) =>
		(ref: ColumnRef): ColumnRef | undefined => {
			if (ref.node !== t.region.cell.id) {
				return undefined
			}
			const v = varByName(t.region.node, ref.name)
			const own =
				v === undefined
					? undefined
					: t.region.node.occurrences[0]?.bindings.find((b) => b.var.id === v.id)
			return own === undefined ? undefined : { node: input.id, name: own.column }
		}
	const qf = restrict(
		cx,
		t.q,
		t.qConstants,
		t.qConditions.map((c) => rebase(ed, c, qRef(t.q))),
		qKeys
	)
	if (qf !== t.q) {
		nodes.push(qf)
	}
	const group = t.group.map((g) => g.q)
	const prefix = t.compared.map((c) => ({ column: c.q, dir: c.dir }))
	/** Within an equal prefix the row the take selects comes last: the rest of the take's order, reversed. */
	const rest = t.order
		.slice(t.compared.length)
		.map((o) => ({ column: o.column, dir: reverse(o.dir) }))
	const ranked = windowChain(
		cx,
		qf,
		group,
		[...prefix, ...rest],
		[
			{
				fn: "rowNumber",
				op: "row_number()",
				args: () => [],
				filter: undefined,
				frame: undefined,
				type: plain.int8,
				rule: "R42",
				stem: "__q_rank"
			}
		],
		qKeys
	)
	appendAll(nodes, ranked.nodes)
	const qr = ranked.last
	const qRank = required(ranked.outs[0], "the rank window's output")
	/** The tagged union's heading: group, compared prefix, side, rank. */
	const taken = new Set<string>()
	const name = (stem: string) => {
		const n = freshColumn(taken, stem)
		taken.add(n)
		return n
	}
	/** Each group field and each compared field with its column of the union, named in that order. */
	const gs = t.group.map((x, i) => ({ column: x.q, parent: x.parent, name: name(`g${i + 1}`) }))
	const ks = t.compared.map((x, i) => ({
		column: x.q,
		dir: x.dir,
		parent: x.parent,
		name: name(`k${i + 1}`)
	}))
	const g = gs.map((x) => x.name)
	const k = ks.map((x) => x.name)
	const side = name("side")
	const rank = name("rank")
	/** Q rows before parents at equal prefixes for <=, after them for <. */
	const qSide = t.inclusive ? 0n : 1n
	const pSide = t.inclusive ? 1n : 0n
	const sideType = plain.int4
	const heading: Array<HeadingColumn> = [
		...gs.map((x) => ({ name: x.name, type: columnTypeOf(t.q, x.column) })),
		...ks.map((x) => ({ name: x.name, type: columnTypeOf(t.q, x.column) })),
		{ name: side, type: sideType },
		{ name: rank, type: plain.int8 }
	]
	const qArm = ed.node({
		kind: "ProjectSet",
		input: qr,
		out: [
			...gs.map((x) => ({
				name: x.name,
				expr: colExpr(ed, qr, x.column, columnTypeOf(qr, x.column))
			})),
			...ks.map((x) => ({
				name: x.name,
				expr: colExpr(ed, qr, x.column, columnTypeOf(qr, x.column))
			})),
			{ name: side, expr: litExpr(ed, { kind: "int", value: qSide }, sideType) },
			{ name: rank, expr: colExpr(ed, qr, qRank, plain.int8) }
		],
		heading,
		meta: metaWithKeys(plainKeys([[...g, rank]])),
		loc: undefined
	})
	const pCols = [...gs, ...ks].map((x) => ({ name: x.name, column: parentColumn(x.parent) }))
	const pArm = ed.node({
		kind: "ProjectSet",
		input: pRows,
		out: [
			...pCols.map((c) => ({
				name: c.name,
				expr: colExpr(ed, pRows, c.column, columnTypeOf(pRows, c.column))
			})),
			{ name: side, expr: litExpr(ed, { kind: "int", value: pSide }, sideType) },
			{
				name: rank,
				expr:
					numbered === undefined
						? litExpr(ed, { kind: "int", value: 0n }, plain.int8)
						: colExpr(ed, pRows, numbered.position, plain.int8)
			}
		],
		heading,
		meta: metaWithKeys(plainKeys(numbered === undefined ? [[...g, ...k]] : [[rank]])),
		loc: undefined
	})
	const union = ed.node({
		kind: "Union",
		groups: [{ heading, arms: [qArm, pArm] }],
		discriminant: [],
		heading,
		meta: conservativeMeta,
		loc: undefined
	})
	nodes.push(qArm, pArm, union)
	/** The latest qualifying Q row, carried forward by its rank. */
	const carried = windowChain(
		cx,
		union,
		g,
		[
			...ks.map((x) => ({ column: x.name, dir: x.dir })),
			{ column: side, dir: "asc" },
			{ column: rank, dir: "asc" }
		],
		[
			{
				fn: "max",
				op: "max(bigint)",
				args: (input) => [
					condExpr(
						ed,
						compareExpr(
							ed,
							"eq",
							colExpr(ed, input, side, sideType),
							litExpr(ed, { kind: "int", value: qSide }, sideType)
						),
						colExpr(ed, input, rank, plain.int8),
						litExpr(ed, { kind: "int", value: 0n }, plain.int8),
						plain.int8
					)
				],
				filter: undefined,
				frame: runningFrame,
				type: plain.int8,
				rule: "R42",
				stem: "carried"
			}
		],
		plainKeys([[...g, ...k, side, rank]])
	)
	appendAll(nodes, carried.nodes)
	const w = carried.last
	const carriedOut = required(carried.outs[0], "the carried window's output")
	const parents = ed.node({
		kind: "Filter",
		input: w,
		pred: andExpr(ed, [
			compareExpr(
				ed,
				"eq",
				colExpr(ed, w, side, sideType),
				litExpr(ed, { kind: "int", value: pSide }, sideType)
			),
			compareExpr(
				ed,
				"gt",
				colExpr(ed, w, carriedOut, plain.int8),
				litExpr(ed, { kind: "int", value: 0n }, plain.int8)
			)
		]),
		heading: headingOf(w),
		meta: metaWithKeys(plainKeys(numbered === undefined ? [[...g, ...k]] : [[rank]])),
		loc: undefined
	})
	nodes.push(parents)
	/** Join back: the parent's (group, prefix, carried rank) to Q's (group, rank) and Q's delivered fields. */
	const delivered = [
		...new Set([...t.columns.values()].flatMap((c) => (c.kind === "own" ? [c.column] : [])))
	].filter((c) => !group.includes(c))
	if (numbered !== undefined) {
		const final = carriedParents(cx, {
			parents: numbered,
			window: { rows: parents, group: g, rank, carried: carriedOut },
			q: { rows: qr, group, rank: qRank },
			delivered,
			keys: keysOfRows(parentRows.current)
		})
		nodes.push(final.rows)
		return { rows: final.rows, groupColumn: [], comparedColumn: [], field: final.field, nodes }
	}
	const vars = new Map<string, VarDecl>()
	const declare = (n: string, type: ScalarType): VarDecl => {
		const v: VarDecl = { id: ed.freshVar(), name: n, type }
		vars.set(n, v)
		return v
	}
	const gv = gs.map((x) => ({ ...x, var: declare(x.name, columnTypeOf(t.q, x.column)) }))
	const kv = ks.map((x) => ({ ...x, var: declare(x.name, columnTypeOf(t.q, x.column)) }))
	const rv = declare(freshColumn([...vars.keys()], "__rank"), plain.int8)
	const fieldName = new Map<string, string>()
	const fv = delivered.map((c) => {
		const n = freshColumn([...vars.keys()], `f_${c}`)
		fieldName.set(c, n)
		return { column: c, name: n, var: declare(n, columnTypeOf(t.q, c)) }
	})
	const o1 = ed.freshOccurrence()
	const o2 = ed.freshOccurrence()
	const o1Bindings = [
		...gv.map((x) => ({ column: x.name, var: x.var })),
		...kv.map((x) => ({ column: x.name, var: x.var })),
		{ column: carriedOut, var: rv }
	]
	const o2Bindings = [
		...gv.map((x) => ({ column: x.column, var: x.var })),
		{ column: qRank, var: rv },
		...fv.map((x) => ({ column: x.column, var: x.var }))
	]
	const outNames = [...g, ...k, ...fv.map((x) => x.name)]
	const a = ed.node({
		kind: "MatchRegion",
		scope: ed.freshScope(),
		vars: [...vars.values()],
		occurrences: [
			{ id: o1, source: parents, bindings: o1Bindings, constants: [] },
			{ id: o2, source: qr, bindings: o2Bindings, constants: [] }
		],
		equalities: [],
		correlated: [],
		heading: outNames.map((n) => ({
			name: n,
			type: required(vars.get(n), `the variable ${n}`).type
		})),
		meta: metaWithKeys(plainKeys([[...g, ...k]])),
		loc: undefined
	})
	nodes.push(a)
	return { rows: a, groupColumn: g, comparedColumn: k, field: fieldName, nodes }
}

interface NeighborResult {
	readonly rules: ReadonlyArray<CatalogRule>
	readonly inputs: ReadonlyArray<NodeId>
	readonly outputs: ReadonlyArray<NodeId>
	readonly key: KeyGrounds
	readonly comparisons: ReadonlyArray<OpId>
}

/**
 * The bound form, at the region that matches the take: rewrite one take occurrence.
 *
 * R27 and R42: a take(1) correlated to its parent by a comparison of a completed tuple (R42).
 *
 * The composition is a `take(1)` of a source Q under its completed order, restricted by a lexicographic comparison of
 * some of Q's fields with the parent's, and correlated on group variables, either attached to the parent or bound in
 * one of the parent's matches. The checker states it as
 *
 *   Take(1) <- [ProjectSet] <- [Filter: comparison] <- MatchRegion(Q, correlated to the parent)
 *
 * with the parent's values entering as correlated variables, constants of Q's columns, the take's correlation and the
 * attachment's correlation. One analysis (analyzeTake) reads that shape into Q columns: the group pairs (a Q column
 * equal to a parent column), the compared pairs with the order "the child precedes the parent" the truth table of
 * lexicographic.ts yields, whether that comparison is inclusive, Q's own restrictions, and the take's order over the
 * columns that are not fixed per parent. Two entries then apply:
 *
 * - R27, the strict successor or predecessor: Q is the parent's own source, every compared and group column is the
 *   parent's same column, the comparison is strict over a tuple that covers a key of Q with the group, Q is not
 *   restricted, and the take's order begins with the compared tuple reversed (the nearest row past the parent). The
 *   target is LEAD(f, 1, f) of every delivered field over the window of Q in the take's order, with the row's own
 *   value as the default rather than NULL, and the presence count over ROWS BETWEEN 1 FOLLOWING AND 1 FOLLOWING, which
 *   is zero or one. A zero presence removes the row: the bound form joins no successor, and the attached form delivers
 *   no child. LEAD over the take's order is LAG over its reverse: the predecessor is the same window.
 * - R42, as-of: the compared fields are a prefix of Q's completed order, of the same types as the parent's, the
 *   comparison is inclusive or strict, and the take's order begins with the prefix reversed (the latest Q at or before
 *   the parent). Over whole inputs the target is one ordered pass (asOfPass below); for a small bound parent set it is
 *   the LATERAL probe the composed lowering already is. The bound form's pass reads each input once:
 * its tagged union carries the parent rows' positions, and the parent occurrence reads the parent rows
 *   with their as-of fields from the pass, so the parents are never read a second time to join the pass back.
 *
 * The parent set decides between the probe and the whole-input target (context.ts ParentPolicy): an
 * attachment's delivered parents and a relation parameter are a bound set, and keep the LATERAL probe under "auto". A
 * region's parents are a relation parameter's when another occurrence of the region is one, or a key lookup, or when
 * every reader of the region's rows is a semi-join against one, which is how the relational rewrites leave a matched
 * parameter that delivers no field (boundRegion). The automatic policy is fixed, not a per-execution choice:
 * R27 keeps the LATERAL take(1) for a relation parameter, as R42 does for a bound parent set.
 * R27 itself has no parent-set condition: its target is LEAD over the window inside the parent statement.
 * The bound form realizes that, the window running over the parent occurrence's own source in the parent's
 * statement. The attached form cannot yet: an attachment statement receives only the delivered parents' heading
 * columns (lower/conservative/deliver.ts), so the parent statement cannot hand it LEAD columns, and the
 * child would have to window all of Q itself, which for a bound parent set is the whole-relation cost R20 forbids.
 * So the attached successor takes R27 only where the parents are every row ("whole"), and keeps the LATERAL probe
 * otherwise, until the delivery carries private parent columns to attachments.
 *
 * The variables the take occurrence binds: an own field's own variable, or a parent value's own variable.
 */
export const tryBoundNeighbor = (cx: CatalogContext, cell: Cell): NeighborResult => {
	const region = cell.current
	if (region.kind !== "MatchRegion") {
		return noMatch("a match region")
	}
	for (const [index, o] of region.occurrences.entries()) {
		const take = o.source.current
		if (take.kind === "Take") {
			return boundNeighbor(cx, { cell, node: region }, index, { cell: o.source, node: take })
		}
	}
	return noMatch("a take occurrence correlated to the region")
}

/** The bound form at the region's first take occurrence, `index`, over `take`. */
const boundNeighbor = (
	cx: CatalogContext,
	held: Held<Region>,
	index: number,
	take: Held<Take>
): NeighborResult => {
	const region = held.node
	const occ = required(region.occurrences[index], "the take occurrence")
	const t = analyzeTake(cx, take.cell, take.node, (ref) => ref.node === held.cell.id)
	demand(occ.constants.length === 0, "a take occurrence without constants")
	const refs = [...t.group.map((g) => g.parent), ...t.compared.map((c) => c.parent)]
	const parent = boundParent(cx, held.cell, region, index, refs)
	for (const b of occ.bindings) {
		const col = t.columns.get(b.column)
		demand(col !== undefined, `a bound column ${b.column}`)
		if (col.kind === "parent") {
			demand(
				parent.vars.get(col.ref.name)?.id === b.var.id,
				"a parent value bound to its own variable"
			)
		}
		if (col.kind === "own" && t.group.some((g) => g.q === col.column)) {
			const g = t.group.find((x) => x.q === col.column)
			demand(
				g !== undefined && parent.vars.get(g.parent.name)?.id === b.var.id,
				"a group field bound to the parent's variable"
			)
		}
	}
	const outer = required(region.occurrences[parent.occurrence], "the parent occurrence")
	const parentColumn = (ref: ColumnRef) => parent.side.column(ref)
	/** R27 first: the window over the parent's own source. */
	const succ = attempt(() =>
		successorHolds(cx, t, (ref) => ({
			occurrence: `${parent.occurrence}`,
			source: outer.source,
			column: parentColumn(ref)
		}))
	)
	if (succ.kind === "match") {
		const policy = cx.options.parents
		demand(policy !== "bound" && !(policy === "auto" && parent.side.bound), "a whole parent set")
		const built = successorRows(cx, t)
		/** The parent occurrence reads the successor rows, which are its source's rows with the LEAD columns. */
		const bindings = [
			...outer.bindings,
			...occ.bindings.flatMap((b) => {
				const col = required(t.columns.get(b.column), `a bound column ${b.column}`)
				if (col.kind !== "own" || t.group.some((g) => g.q === col.column)) {
					return []
				}
				return [
					{
						column: required(built.lead.get(col.column), `the LEAD of ${col.column}`),
						var: b.var
					}
				]
			})
		]
		const occurrences = region.occurrences
			.toSpliced(index, 1)
			.map((o) => (o.id === outer.id ? { ...o, source: built.rows, bindings } : o))
		cx.ed.redefine(held.cell, { ...region, occurrences, heading: region.heading })
		return {
			rules: ["R27"],
			inputs: [held.cell.id, take.cell.id, t.region.cell.id, t.q.id],
			outputs: [held.cell.id, ...built.nodes.map((c) => c.id)],
			key: succ.value,
			comparisons: t.comparisons
		}
	}
	const key = asOfHolds(cx, t, (ref) => columnTypeOf(parent.side.rows, parentColumn(ref)))
	const policy = cx.options.parents
	demand(policy !== "bound" && !(policy === "auto" && parent.side.bound), "a whole parent set")
	/** The pass carries the parent rows, so the parent occurrence reads them, with Q's delivered fields, from it. */
	const pass = asOfPass(cx, t, parent.side.rows, parentColumn, true)
	const bindings = [...outer.bindings]
	for (const b of occ.bindings) {
		const col = required(t.columns.get(b.column), `a bound column ${b.column}`)
		if (col.kind !== "own" || t.group.some((g) => g.q === col.column)) {
			continue
		}
		const f = pass.field.get(col.column)
		demand(f !== undefined, `a delivered field ${col.column}`)
		if (!bindings.some((x) => x.column === f)) {
			bindings.push({ column: f, var: b.var })
		}
	}
	const occurrences = region.occurrences
		.toSpliced(index, 1)
		.map((o) => (o.id === outer.id ? { ...o, source: pass.rows, bindings } : o))
	cx.ed.redefine(held.cell, { ...region, occurrences, heading: region.heading })
	return {
		rules: ["R42"],
		inputs: [held.cell.id, take.cell.id, t.region.cell.id, t.q.id],
		outputs: [held.cell.id, ...pass.nodes.map((c) => c.id)],
		key,
		comparisons: t.comparisons
	}
}

/**
 * The attached form, at the Attach: the child take redefined as an uncorrelated relation matched by the
 * attachment's correlation.
 *
 * Every parent value the child carries is matched by the attachment's correlation.
 */
export const tryAttachedNeighbor = (cx: CatalogContext, cell: Cell): NeighborResult => {
	const attach = cell.current
	if (attach.kind !== "Attach") {
		return noMatch("an attachment")
	}
	const tk = attach.child
	const take = tk.current
	demand(take.kind === "Take", "an attached take")
	const t = analyzeTake(cx, tk, take, (ref) => ref.node === attach.parent.id)
	/** The attachment's correlation: a child column equal to a parent column. */
	const groupAll = [...t.group]
	for (const c of attach.correlation) {
		const col = t.columns.get(c.child)
		const ref: ColumnRef = { node: attach.parent.id, name: c.parent }
		if (col?.kind !== "own") {
			demand(col !== undefined && sameRef(col.ref, ref), "a parent column correlated to itself")
		} else if (!groupAll.some((g) => g.q === col.column)) {
			groupAll.push({ q: col.column, parent: ref })
		}
	}
	const shape: TakeShape = { ...t, group: groupAll }
	for (const [childCol, col] of t.columns) {
		const matched = attach.correlation.some((c) => c.child === childCol)
		if (col.kind === "parent" || groupAll.some((g) => g.q === col.column)) {
			demand(matched, `the child column ${childCol} in the attachment's correlation`)
		}
	}
	const policy = cx.options.parents
	demand(
		policy === "whole",
		"a whole parent set; an attachment's delivered parents keep the LATERAL probe"
	)
	const parentColumn = (ref: ColumnRef): string => {
		demand(ref.node === attach.parent.id, "parent values of the attachment's parent")
		return ref.name
	}
	const parentType = (ref: ColumnRef) => columnTypeOf(attach.parent, parentColumn(ref))
	const byLabel = new Map<NodeId, Cell>(cx.ed.cells().map((c) => [c.id, c]))
	const succ = attempt(() => successorHolds(cx, shape, (ref) => trace(byLabel, ref)))
	const out = take.heading.map((h) => ({
		h,
		col: required(shape.columns.get(h.name), `a child column ${h.name}`)
	}))
	if (succ.kind === "match") {
		const built = successorRows(cx, shape)
		const rowsHeading = headingOf(built.rows)
		const exprs = out.map(({ h, col }) => {
			const source = (() => {
				if (col.kind === "own") {
					return built.lead.get(col.column) ?? col.column
				}
				return required(
					[...shape.group, ...shape.compared].find((p) => sameRef(p.parent, col.ref)),
					`a parent column ${h.name} the window carries`
				).q
			})()
			demand(
				rowsHeading.some((c) => c.name === source && sameScalarType(c.type, h.type)),
				`${h.name} at its type`
			)
			return { name: h.name, expr: colExpr(cx.ed, built.rows, source, h.type) }
		})
		cx.ed.redefine(tk, {
			kind: "ProjectSet",
			input: built.rows,
			out: exprs,
			heading: take.heading,
			meta: take.meta,
			loc: undefined
		})
		return {
			rules: ["R27"],
			inputs: [cell.id, tk.id, t.region.cell.id, t.q.id],
			outputs: [tk.id, ...built.nodes.map((c) => c.id)],
			key: succ.value,
			comparisons: t.comparisons
		}
	}
	const key = asOfHolds(cx, shape, parentType)
	const pass = asOfPass(cx, shape, attach.parent, parentColumn, false)
	const aHeading = headingOf(pass.rows)
	/** The pass's column carrying a child column: a group column, an own field, or a compared parent value. */
	const carriedBy = (col: ChildColumn): string | undefined => {
		if (col.kind === "own") {
			const gi = firstIndex(shape.group, (g) => g.q === col.column)
			return gi === undefined ? pass.field.get(col.column) : pass.groupColumn[gi]
		}
		const gi = firstIndex(shape.group, (g) => sameRef(g.parent, col.ref))
		if (gi !== undefined) {
			return pass.groupColumn[gi]
		}
		const ki = firstIndex(shape.compared, (c) => sameRef(c.parent, col.ref))
		return ki === undefined ? undefined : pass.comparedColumn[ki]
	}
	const exprs = out.map(({ h, col }) => {
		const source = required(carriedBy(col), `a child column ${h.name} the pass carries`)
		demand(
			aHeading.some((c) => c.name === source && sameScalarType(baseOf(c.type), baseOf(h.type))),
			`${h.name} at its type`
		)
		return {
			name: h.name,
			expr: colExpr(cx.ed, pass.rows, source, columnTypeOf(pass.rows, source))
		}
	})
	demand(
		exprs.every((e, i) =>
			sameScalarType(
				columnTypeOf(pass.rows, required(columnRef(e.expr)?.name, `the column ${e.name} reads`)),
				required(take.heading[i], `the child column ${e.name}`).type
			)
		),
		"child columns at their types"
	)
	cx.ed.redefine(tk, {
		kind: "ProjectSet",
		input: pass.rows,
		out: exprs,
		heading: take.heading,
		meta: take.meta,
		loc: undefined
	})
	return {
		rules: ["R42"],
		inputs: [cell.id, tk.id, t.region.cell.id, t.q.id],
		outputs: [tk.id, ...pass.nodes.map((c) => c.id)],
		key,
		comparisons: t.comparisons
	}
}
