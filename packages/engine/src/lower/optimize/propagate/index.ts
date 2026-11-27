import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { NodeId, OccurrenceId, VarId } from "#compiler/core/ids.ts"
import { type CertificateRule, localCertificate } from "#compiler/ir/certificate.ts"
import type { ColumnRef, ScalarExpr } from "#compiler/ir/expr.ts"
import { drive } from "#compiler/ir/fold.ts"
import {
	type Cell,
	type EditNode,
	type EditRefs,
	edgesOf,
	type KindOver,
	keptRefs,
	mapNode,
	type RelNode,
	type Roots,
	regionVarClasses,
	unionArms,
	type ValidDag,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, equalityIsIdentity, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import { type RewriteCx, traversalPass } from "#compiler/lower/optimize/demand/frame.ts"
import { conjunction } from "#compiler/lower/optimize/simplify/boolean.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { meets } from "#compiler/scalar/compute/types.ts"

const propagateRules = {
	restrict: "propagate.restrict",
	substitute: "propagate.substitute"
} as const

/** The columns of one node that hold one value of the statement's own, each by the expression that spells it. */
type Values = ReadonlyMap<string, ScalarExpr>

const none: Values = new Map()

type Region = KindOver<"MatchRegion", EditRefs>

/** What the pass reads of a rewrite's state: the editor, its cells, and where a rewrite's certificate is recorded. */
type PropagateCx = Pick<RewriteCx, "editor" | "cells" | "certify">

/**
 * Whether two statement values are one value: one parameter through the same casts to the same types. A parameter's
 * role is only how its placeholder is cast where it is spelled, never what it holds.
 */
const sameValue = (a: ScalarExpr, b: ScalarExpr): boolean => {
	if (a === b) {
		return true
	}
	if (!sameScalarType(a.type, b.type)) {
		return false
	}
	switch (a.kind) {
		case "param":
			return b.kind === "param" && a.param === b.param
		case "cast":
			return b.kind === "cast" && a.cast === b.cast && sameValue(a.args[0], b.args[0])
		case "domainCast":
			return b.kind === "domainCast" && sameValue(a.args[0], b.args[0])
		case "column":
		case "value":
		case "literal":
		case "op":
		case "cond":
		case "variant":
		case "closedAt":
		case "closedRow":
		case "closedHas":
		case "call":
			return false
	}
}

/** Whether a value of `value`'s type may stand as a constant of a source column of `column`'s type (its base, or the exact family it widens into), compared at the column's type. */
const fits = (column: ScalarType, value: ScalarType): boolean =>
	sameScalarType(baseOf(column), baseOf(value)) || meets(baseOf(column), baseOf(value))

/** What a column reference reads, where its node holds the column at a statement value: that value. */
type ValueOf = (ref: ColumnRef) => ScalarExpr | undefined

/**
 * Whether `e` is a statement value once each column `valueOf` holds at one is read as that value: such a column, or a
 * parameter, through casts and domain casts, immutable. A statement value is one value wherever the statement reads it,
 * as cheap to read again as its placeholder is, so a reference to a column that holds it may read it in the column's
 * place; a literal is spelled where it is written, and a computation over parameters is no placeholder's to repeat.
 */
const closes = (e: ScalarExpr, valueOf: ValueOf): boolean =>
	e.kind === "column"
		? valueOf(e.column) !== undefined
		: e.volatility === "immutable" &&
			(e.kind === "param" ||
				((e.kind === "cast" || e.kind === "domainCast") && closes(e.args[0], valueOf)))

/** `e` with each column reference `valueOf` holds at a value read as that value, where the value has the reference's type. */
const readThrough = (ed: DagEditor, e: ScalarExpr, valueOf: ValueOf): ScalarExpr =>
	ed.copyExpr(e, (ref, expr) => {
		const value = valueOf(ref)
		return value !== undefined && sameScalarType(value.type, expr.type) ? value : undefined
	})

/**
 * The column of `input` a conjunct of a filter's predicate holds at a value, where it is one: `column = v` of
 * PostgreSQL's equality, v a statement value once read through `valueOf`, with v as it is spelled.
 */
const fixing = (
	conjunct: ScalarExpr,
	input: Cell,
	valueOf: ValueOf
): { readonly column: string; readonly value: ScalarExpr } | undefined => {
	const [x, y, ...more] =
		conjunct.kind === "op" && nativeOp(conjunct.op)?.fn === "eq" ? conjunct.args : []
	if (x === undefined || y === undefined || more.length > 0) {
		return undefined
	}
	const at = (column: ScalarExpr, value: ScalarExpr) =>
		column.kind === "column" && column.column.node === input.id && closes(value, valueOf)
			? { column: column.column.name, value }
			: undefined
	return at(x, y) ?? at(y, x)
}

/**
 * The columns of `input` a conjunct of a filter's predicate `pred` equates with a literal, PostgreSQL's equality: each
 * column whose canonical value is that literal (`fixings`).
 */
const literalFixed = (pred: ScalarExpr, input: Cell): ReadonlySet<string> =>
	new Set(
		conjuncts(pred).flatMap((e) => {
			const [x, y, ...more] = e.kind === "op" && nativeOp(e.op)?.fn === "eq" ? e.args : []
			if (x === undefined || y === undefined || more.length > 0) {
				return []
			}
			const at = (column: ScalarExpr, value: ScalarExpr): ReadonlyArray<string> =>
				column.kind === "column" && column.column.node === input.id && value.kind === "literal"
					? [column.column.name]
					: []
			return [...at(x, y), ...at(y, x)]
		})
	)

/**
 * The columns of `input` a filter's predicate `pred` holds at a value (fixing), each value read through `valueOf`. A
 * column's canonical value is its most specific name, a literal over a parameter and a parameter over a column, so a
 * column a conjunct equates with a literal holds that literal, which is spelled where it is written and never read in
 * the column's place: it holds no statement value, and a conjunct equating it with a parameter stays as written. So
 * `Bool = 0 AND Bool = $p` keeps Bool, fixed to 0, wherever it is read, where reading it as `$p` left `$p = 0` and a
 * reader of `$p` alone, a union's arm no analysis then told apart from another's (public-programs, rotating 0xb475cf76,
 * case 150).
 */
const fixings = (
	ed: DagEditor,
	pred: ScalarExpr,
	input: Cell,
	valueOf: ValueOf
): ReadonlyArray<{ readonly column: string; readonly value: ScalarExpr }> => {
	const literal = literalFixed(pred, input)
	return conjuncts(pred).flatMap((e) => {
		const f = fixing(e, input, valueOf)
		return f === undefined || literal.has(f.column)
			? []
			: [{ column: f.column, value: readThrough(ed, f.value, valueOf) }]
	})
}

/** The values both `a` and `b` hold a column at: the columns they agree on. */
const meet = (a: Values, b: Values): Values => {
	const out = new Map<string, ScalarExpr>()
	for (const [column, value] of a) {
		const other = b.get(column)
		if (other !== undefined && sameValue(value, other)) {
			out.set(column, value)
		}
	}
	return out
}

/**
 * What a region holds each class of its variables at (regionVarClasses), as an equality holds it: a column its
 * occurrence's source holds at a value (`of`), a constant of an occurrence that binds a column of the class, a
 * correlation of a variable of it, and each variable of its heading its readers keep at a value (`kept`). A class an
 * occurrence's literal constant binds holds that literal, its canonical value (`fixings`), and so no statement value.
 */
const classValues = (
	ed: DagEditor,
	region: Region,
	of: (cell: Cell) => Values,
	valueOf: ValueOf,
	kept: Values
): { readonly classOf: (v: VarDecl) => VarId; readonly values: ReadonlyMap<VarId, ScalarExpr> } => {
	const classOf = regionVarClasses(region)
	const values = new Map<VarId, ScalarExpr>()
	const literal = new Set(
		region.occurrences.flatMap((o) =>
			o.constants.flatMap((k) => {
				const b = o.bindings.find((x) => x.column === k.column)
				return b !== undefined && k.expr.kind === "literal" ? [classOf(b.var)] : []
			})
		)
	)
	const hold = (v: VarDecl, value: ScalarExpr): void => {
		const at = classOf(v)
		if (!values.has(at) && !literal.has(at)) {
			values.set(at, value)
		}
	}
	for (const o of region.occurrences) {
		const source = of(o.source)
		for (const b of o.bindings) {
			const value = source.get(b.column)
			if (value !== undefined) {
				hold(b.var, value)
			}
		}
		for (const k of o.constants) {
			const b = o.bindings.find((x) => x.column === k.column)
			if (b !== undefined && closes(k.expr, valueOf)) {
				hold(b.var, readThrough(ed, k.expr, valueOf))
			}
		}
	}
	for (const c of region.correlated) {
		if (closes(c.expr, valueOf)) {
			hold(c.var, readThrough(ed, c.expr, valueOf))
		}
	}
	for (const v of region.vars) {
		const value = kept.get(v.name)
		if (value !== undefined) {
			hold(v, value)
		}
	}
	return { classOf, values }
}

/**
 * The nodes each opaque leaf of a write's DAG holds rows of, the leaf's producers: a delta's added side holds rows of the
 * actions that insert or put its relation, each its source's (ir/write.ts ActionCore). A leaf holds a column at a value
 * where every producer does (meet), and none where it has none, or one whose rows it cannot read, a slot's. A query's
 * DAG has no producer.
 */
export interface Producers {
	/** The sources of the rows each relation's delta.added holds, by relation: none where any is no described query. */
	readonly added: ReadonlyMap<string, ReadonlyArray<RelNode>>
}

const noProducers: Producers = { added: new Map() }

/** The values an opaque leaf holds: the meet of its producers' (Producers), none where it has none. */
type LeafValues = (node: EditNode) => Values

/** The leaf values `producers` give, each producer's cell read through `of`. */
const leavesOf =
	(ed: DagEditor, producers: Producers, of: (cell: Cell) => Values): LeafValues =>
	(node) => {
		const sources =
			node.kind === "Delta" && node.side === "added"
				? (producers.added.get(node.relation) ?? [])
				: []
		const [first, ...rest] = sources.map((n) => of(ed.cellOf(n)))
		return first === undefined ? none : rest.reduce(meet, first)
	}

/**
 * The columns of `cell`'s node that hold a statement value in every row, each with the value (Values): read off its
 * inputs' (`of`), each column a reference reads through `valueOf`.
 *
 * - A projection holds an output whose expression is one once its inputs' columns are read as theirs.
 * - A filter holds its input's, and a column a conjunct equates with one, but a column a conjunct equates with a
 *   literal, whose canonical value is the literal (`fixings`).
 * - A region holds a variable its class holds at one (classValues); where only stated equalities hold (Holds), only
 *   where every column bound to the class holds it itself (statedAtEveryBinding).
 * - A semi-join holds its left's, and, where the joined equalities hold (Holds), a left column paired with a right
 *   column that holds one; an anti-join, a set difference and an intersection hold their left's; a take its input's and the columns its correlation fixes at one; a
 *   fold and an ordered-set aggregate their input's at their grouping keys; a step, an ordered result, a window and a
 *   law's check their input's; an attachment its parent's.
 * - A union holds a column every arm holds at one value.
 * - A delta holds what its producers hold (Producers), where an equality names it: the write casts each value into
 *   its column, which on a numeric's scale or a float's zero may be another value.
 *
 * A column an equality holds at a value holds it only where the equality names one value (ir/scalar.ts equalityIsIdentity): a region's
 * variable, a filter's, a semi-join's or a take's column on a float carrier holds none.
 */
const valuesOf = (
	ed: DagEditor,
	cell: Cell,
	of: (cell: Cell) => Values,
	valueOf: ValueOf,
	leaves: LeafValues,
	holds: Holds
): Values => {
	const node = cell.current
	const out = new Map<string, ScalarExpr>()
	const put = (column: string, value: ScalarExpr, byEquality: boolean): void => {
		const h = node.heading.find((c) => c.name === column)
		if (
			h !== undefined &&
			sameScalarType(h.type, value.type) &&
			(!byEquality || equalityIsIdentity(h.type)) &&
			!out.has(column)
		) {
			out.set(column, value)
		}
	}
	const carry = (input: Cell, columns: ReadonlyArray<string> | undefined): void => {
		for (const [column, value] of of(input)) {
			if (columns === undefined || columns.includes(column)) {
				put(column, value, false)
			}
		}
	}
	switch (node.kind) {
		case "ProjectSet":
			for (const o of node.out) {
				if (closes(o.expr, valueOf)) {
					put(o.name, readThrough(ed, o.expr, valueOf), false)
				}
			}
			break
		case "Filter": {
			const literal = literalFixed(node.pred, node.input)
			carry(
				node.input,
				node.heading.map((c) => c.name).filter((c) => !literal.has(c))
			)
			for (const f of fixings(ed, node.pred, node.input, valueOf)) {
				put(f.column, f.value, true)
			}
			break
		}
		case "MatchRegion": {
			const { classOf, values } = classValues(ed, node, of, valueOf, none)
			for (const v of node.vars) {
				const value = values.get(classOf(v))
				if (
					value !== undefined &&
					(holds === "joined" ||
						statedAtEveryBinding(ed, node, classOf, classOf(v), value, of, valueOf))
				) {
					put(v.name, value, !exactlyBound(node, v, of))
				}
			}
			break
		}
		case "SemiJoin": {
			carry(node.left, undefined)
			if (holds === "joined") {
				const right = of(node.right)
				for (const p of node.on) {
					const value = right.get(p.right)
					if (value !== undefined) {
						put(p.left, value, true)
					}
				}
			}
			break
		}
		case "AntiJoin":
		case "Difference":
		case "Intersect":
			carry(node.left, undefined)
			break
		case "Take":
			carry(node.input, undefined)
			for (const c of node.correlation) {
				if (closes(c.expr, valueOf)) {
					put(c.column, readThrough(ed, c.expr, valueOf), true)
				}
			}
			break
		case "Group":
		case "OrderedSetAggregate":
			carry(node.input, node.keys)
			break
		case "Step":
		case "OrderedResult":
		case "Window":
			carry(node.input, undefined)
			break
		case "Forbid":
			carry(node.violation, undefined)
			break
		case "Attach":
			carry(node.parent, undefined)
			break
		case "Union": {
			const [first, ...rest] = unionArms(node.groups).map(of)
			if (first !== undefined) {
				for (const [column, value] of rest.reduce(meet, first)) {
					put(column, value, false)
				}
			}
			break
		}
		case "Delta":
			for (const [column, value] of leaves(node)) {
				put(column, value, true)
			}
			break
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "Call":
			break
	}
	return out
}

/**
 * Whether a region's variable takes the very value its class holds, whatever its carrier: its class is the variable
 * alone, bound once, by a column its source holds at that value, so the region reads its value from that column and
 * compares it with nothing.
 */
const exactlyBound = (region: Region, v: VarDecl, of: (cell: Cell) => Values): boolean => {
	const bindings = region.occurrences.flatMap((o) =>
		o.bindings.filter((b) => b.var.id === v.id).map((b) => ({ o, b }))
	)
	const [only, ...others] = bindings
	return (
		only !== undefined &&
		others.length === 0 &&
		!region.equalities.some((e) => e.a.id === v.id || e.b.id === v.id) &&
		!region.correlated.some((c) => c.var.id === v.id) &&
		!only.o.constants.some((k) => k.column === only.b.column) &&
		of(only.o.source).has(only.b.column)
	)
}

/**
 * Whether every column a region binds to the class `at` holds `value` itself: its source holds it, or its occurrence's
 * own constant states it, so the value stands where each such column is read. A variable whose class holds a value only
 * through a join, a column of a source that holds nothing equated with another occurrence's held one, holds no value:
 * every row of the region holds it, but a reference reading the value in the variable's place would cut the column's
 * lineage, which a keyed restriction follows to the column's read and the facts rule reads (edullm's take: a projection
 * delivering `$98` for a fenced read's package, its join to the parameter then `$98 = $98` over every package's nodes).
 * Where the restriction states the value at each bound stored column, every binding holds it. A class no occurrence
 * binds is its correlation's value alone.
 */
const statedAtEveryBinding = (
	ed: DagEditor,
	region: Region,
	classOf: (v: VarDecl) => VarId,
	at: VarId,
	value: ScalarExpr,
	of: (cell: Cell) => Values,
	valueOf: ValueOf
): boolean =>
	region.occurrences.every((o) =>
		o.bindings.every((b) => {
			if (classOf(b.var) !== at) {
				return true
			}
			const held = of(o.source).get(b.column)
			return (
				(held !== undefined && sameValue(held, value)) ||
				o.constants.some(
					(k) =>
						k.column === b.column &&
						closes(k.expr, valueOf) &&
						sameValue(readThrough(ed, k.expr, valueOf), value)
				)
			)
		})
	)

/**
 * Which equalities hold a column at a value, as a reading of the DAG asks: `joined`, every one, a join's and a
 * semi-join's pair to another column held at it among them, since every row the node delivers holds the value, which
 * is what a restriction reads (a restriction drops only rows no root reads); `stated`, only those stated on the column
 * itself, a constant of its own read, a filter's conjunct, a projection of the value, a correlation, and the columns a
 * node carries of its inputs' so held, which is what a substitution reads, since a reference read as the value no longer
 * reads the column, whose lineage a keyed restriction and the facts rule follow.
 */
type Holds = "joined" | "stated"

/** The values each node holds (valuesOf), and what a reference to a column reads through them. */
interface Reading {
	readonly of: (cell: Cell) => Values
	readonly valueOf: ValueOf
}

/**
 * The values of every column of the cells `order` holds, in topological order: each node's from its inputs'
 * (valuesOf), a reference to another node's column read through that node's, which a correlated source reads before
 * its node is reached, so the reading runs again while it finds more. Each round finds at least one more column of the
 * DAG's headings, so it ends within their count. A cell outside `order` holds none, and a leaf what its `producers`
 * hold.
 */
const valuesAll = (ed: DagEditor, order: ReadonlyArray<Cell>, producers: Producers): Reading => {
	const known = new Map<Cell, Values>()
	const byId = new Map<NodeId, Cell>(order.map((c) => [c.id, c]))
	const of = (cell: Cell): Values => known.get(cell) ?? none
	const valueOf: ValueOf = (ref) => {
		const cell = byId.get(ref.node)
		return cell === undefined ? undefined : of(cell).get(ref.name)
	}
	const leaves = leavesOf(ed, producers, of)
	const size = (): number => [...known.values()].reduce((n, v) => n + v.size, 0)
	for (let before = -1; size() > before;) {
		before = size()
		for (const cell of order) {
			known.set(cell, valuesOf(ed, cell, of, valueOf, leaves, "joined"))
		}
	}
	return { of, valueOf }
}

/**
 * The values of every column of the cells `order` holds by equalities stated on the column itself (Holds `stated`):
 * from every value the joined equalities hold (valuesAll), each node's read again under the stated ones from what the
 * others hold now, each value kept only where it is read again, until a round drops none. A value a join alone holds
 * goes; a column a correlated source holds by its correlation with the region that reads it, which holds the value by
 * another column's own, stays, since each is read again from the other's. Each round drops at least one value, so it
 * ends within their count.
 */
const statedValues = (ed: DagEditor, order: ReadonlyArray<Cell>, producers: Producers): Reading => {
	const joined = valuesAll(ed, order, producers)
	const known = new Map<Cell, Values>(order.map((c) => [c, joined.of(c)]))
	const byId = new Map<NodeId, Cell>(order.map((c) => [c.id, c]))
	const of = (cell: Cell): Values => known.get(cell) ?? none
	const valueOf: ValueOf = (ref) => {
		const cell = byId.get(ref.node)
		return cell === undefined ? undefined : of(cell).get(ref.name)
	}
	const leaves = leavesOf(ed, producers, of)
	for (let dropped = true; dropped;) {
		dropped = false
		for (const cell of order) {
			const before = of(cell)
			const again = valuesOf(ed, cell, of, valueOf, leaves, "stated")
			const still = new Map(
				[...before].filter(([column, value]) => {
					const now = again.get(column)
					return now !== undefined && sameValue(now, value)
				})
			)
			if (still.size < before.size) {
				known.set(cell, still)
				dropped = true
			}
		}
	}
	return { of, valueOf }
}

/**
 * Each place `reader` reads `input` at, with the values it keeps that read's rows at, `kept` the values its own readers
 * keep its rows at, `of` the values each node holds (valuesOf): the rows of `input` it reads there whose columns hold
 * other values reach no row any root reads.
 *
 * - A filter keeps its input as it is kept, and at each column a conjunct equates with a value.
 * - A projection keeps its input at each column an output it is kept at copies; a fold and an ordered-set aggregate at
 *   their grouping keys, a window at its partition, each a whole group or partition; a step, an ordered result, a union's
 *   arm, an intersection's sides, a set difference's sides, a semi- or anti-join's left and an attachment's parent as it
 *   is kept.
 * - A region keeps each occurrence's source at the columns its constants fix at a value and those bound to a variable
 *   whose class holds one (classValues), its kept variables among them.
 * - A semi- or anti-join keeps its right at each column paired with a left column kept or held at a value: a left row's
 *   verdict reads the right rows at its pair values alone; a semi-join keeps its left at each column paired with a right
 *   column holding one; an attachment keeps its child at each correlated column whose parent column is so kept, a parent
 *   row's attachment reading the child at it.
 * - A take keeps its input at the columns its correlation fixes at a value, a take's rank reading every row else; a law's
 *   check, which refuses where its violation holds any row, keeps nothing, and no other kind keeps anything.
 */
const keptBy = (
	ed: DagEditor,
	reader: Cell,
	input: Cell,
	kept: Values,
	of: (cell: Cell) => Values,
	valueOf: ValueOf
): ReadonlyArray<Values> => {
	const node = reader.current
	const at = (columns: ReadonlyArray<string>): Values =>
		new Map([...kept].filter(([c]) => columns.includes(c)))
	switch (node.kind) {
		case "Filter": {
			const literal = literalFixed(node.pred, node.input)
			return [
				new Map([
					...[...kept].filter(([c]) => !literal.has(c)),
					...fixings(ed, node.pred, node.input, valueOf).map((f) => [f.column, f.value] as const)
				])
			]
		}
		case "ProjectSet":
			return [
				new Map(
					node.out.flatMap((o) => {
						const value = kept.get(o.name)
						return value !== undefined &&
							o.expr.kind === "column" &&
							o.expr.column.node === input.id
							? [[o.expr.column.name, value] as const]
							: []
					})
				)
			]
		case "Group":
		case "OrderedSetAggregate":
			return [at(node.keys)]
		case "Window":
			return [at(node.partition)]
		case "Step":
		case "OrderedResult":
		case "Union":
		case "Intersect":
			return edgesOf(node)
				.filter((e) => e === input)
				.map(() => kept)
		case "Difference":
			return edgesOf(node)
				.filter((e) => e === input)
				.map(() => kept)
		case "MatchRegion": {
			const kept_ = regionKept(ed, node, kept, of, valueOf)
			return node.occurrences.flatMap((o) => (o.source === input ? [kept_.get(o.id) ?? none] : []))
		}
		case "SemiJoin":
		case "AntiJoin": {
			const out: Array<Values> = []
			if (node.left === input) {
				const right = node.kind === "SemiJoin" ? of(node.right) : none
				out.push(
					new Map([
						...kept,
						...node.on.flatMap((p) => {
							const value = right.get(p.right)
							return value === undefined ? [] : [[p.left, value] as const]
						})
					])
				)
			}
			if (node.right === input) {
				const left = of(node.left)
				out.push(
					new Map(
						node.on.flatMap((p) => {
							const value = kept.get(p.left) ?? left.get(p.left)
							return value === undefined ? [] : [[p.right, value] as const]
						})
					)
				)
			}
			return out
		}
		case "Attach": {
			const out: Array<Values> = []
			if (node.parent === input) {
				out.push(kept)
			}
			if (node.child === input) {
				const parent = of(node.parent)
				out.push(
					new Map(
						node.correlation.flatMap((c) => {
							const value = kept.get(c.parent) ?? parent.get(c.parent)
							return value === undefined ? [] : [[c.child, value] as const]
						})
					)
				)
			}
			return out
		}
		case "Take":
			return [
				new Map(
					node.correlation.flatMap((c) =>
						closes(c.expr, valueOf) ? [[c.column, readThrough(ed, c.expr, valueOf)] as const] : []
					)
				)
			]
		case "Forbid":
		case "Produce":
		case "Recursive":
		case "ApproximateNearest":
		case "Call":
			return edgesOf(node)
				.filter((e) => e === input)
				.map(() => none)
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "SelfRef":
			return []
	}
}

/** What a region keeps each occurrence's source at (keptBy), by occurrence. */
const regionKept = (
	ed: DagEditor,
	region: Region,
	kept: Values,
	of: (cell: Cell) => Values,
	valueOf: ValueOf
): ReadonlyMap<OccurrenceId, Values> => {
	const { classOf, values } = classValues(ed, region, of, valueOf, kept)
	return new Map(
		region.occurrences.map((o) => {
			const out = new Map<string, ScalarExpr>()
			for (const k of o.constants) {
				if (closes(k.expr, valueOf)) {
					out.set(k.column, readThrough(ed, k.expr, valueOf))
				}
			}
			for (const b of o.bindings) {
				const value = values.get(classOf(b.var))
				if (value !== undefined && !out.has(b.column)) {
					out.set(b.column, value)
				}
			}
			return [o.id, out] as const
		})
	)
}

const certify = (
	cx: PropagateCx,
	rule: CertificateRule,
	inputs: ReadonlyArray<NodeId>,
	cell: Cell,
	outputs: ReadonlyArray<NodeId>
): void => {
	cx.certify(
		localCertificate(
			rule,
			inputs,
			outputs,
			inputs,
			cell.current.heading.map((c) => c.name)
		)
	)
}

/**
 * The constants `at` holds that an occurrence of a source of `source`'s heading may state beside `constants`: each
 * column it holds at a value of a type the column takes (fits) and no constant of it fixes already.
 */
const statable = (
	source: EditNode,
	constants: ReadonlyArray<{ readonly column: string }>,
	at: Values
): ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }> =>
	[...at].flatMap(([column, expr]) => {
		const h = source.heading.find((c) => c.name === column)
		return h !== undefined && fits(h.type, expr.type) && !constants.some((k) => k.column === column)
			? [{ column, expr }]
			: []
	})

/**
 * The source columns of a region's one occurrence its readers fix already where its stored relation is read: where the
 * region is that relation renamed, its one occurrence of a stored relation binding every column to a variable of its
 * own with nothing fixed, equated or correlated, which every lowering prints as the relation's own scan, and every reader
 * is a filter, whose fixings then stand on that scan; none otherwise.
 */
const fixedAbove = (
	ed: DagEditor,
	cx: PropagateCx,
	cell: Cell,
	region: Region,
	valueOf: ValueOf
): ReadonlyArray<{ readonly column: string }> => {
	const [o, ...others] = region.occurrences
	const readers = cx.cells.readers(cell)
	if (
		o === undefined ||
		others.length > 0 ||
		o.source.current.kind !== "Base" ||
		o.constants.length > 0 ||
		region.equalities.length > 0 ||
		region.correlated.length > 0 ||
		new Set(o.bindings.map((b) => b.var.id)).size !== o.source.current.heading.length ||
		!isNonEmpty(readers)
	) {
		return []
	}
	const [first, ...rest] = mapNonEmpty(readers, (r) =>
		r.current.kind === "Filter" && r.current.input === cell
			? new Map(fixings(ed, r.current.pred, cell, valueOf).map((f) => [f.column, f.value] as const))
			: none
	)
	const common = rest.reduce(meet, first)
	return o.bindings.flatMap((b) => (common.has(b.var.name) ? [{ column: b.column }] : []))
}

/**
 * The constant-column pass, one traversal of the DAG in three readings and two edits.
 *
 * 1. The values every node holds (valuesAll): the columns each holds at a value of the statement's own in every row, a
 *    parameter through its casts, read up from the projections, filters, correlations and constants that state them,
 *    through every node that carries its input's columns, and through a union where every arm holds one value.
 * 2. What every node is kept at (keptBy), top down: the values its readers read its rows at, the meet over every read of
 *    it, a root reading every row. A node every read of which keeps a column at one value, a CTE every reader reads at
 *    the statement's key among them, is read at that value alone.
 * 3. The restriction (propagate.restrict): each occurrence of a stored relation in a region fixes, beside its constants,
 *    each column the region keeps it at. So a key the statement fixes stands at the stored read it keys, spelled
 *    `t.child = $1`, wherever the statement holds it: through a column of a CTE, of a derived table or of a LATERAL's
 *    outer row, or through the readers of a node every one of which keeps it there, where PostgreSQL would read the
 *    stored relation whole or by a column the plan joins and the borrow checker sees no binding. A restriction drops
 *    only rows no root reads, so every root's rows are unchanged; what a node it restricts claims is its output's
 *    analysis's, as every pass's (pipeline.ts claimed), so the pass weakens no claim itself.
 * 4. The values again, over the restricted DAG, and the substitution (propagate.substitute): every reference to a column
 *    its node holds at a value reads the value instead, so a projection delivers the parameter, a CTE's column carries
 *    it where its reader reads it, and a LATERAL's correlation to an earlier source's column fixes its key at the value.
 *    Every reference reads, in every row, the very value it read.
 *
 * No cell reading a recursion's feedback is read or edited: its rows are the recursion's, which no step's value fixes.
 */
const propagate =
	(producers: Producers) =>
	(cx: PropagateCx): void => {
		const ed = cx.editor
		const order = cx.cells.order
		const feedback = cx.cells.feedback
		const live = order.filter((c) => !feedback.has(c))
		const { of, valueOf } = valuesAll(ed, live, producers)

		const reads = new Map<Cell, Array<Values>>()
		for (const root of ed.roots) {
			reads.getOrInsertComputed(root, () => []).push(none)
		}
		const kept = new Map<Cell, Values>()
		for (const cell of order.toReversed()) {
			const [first, ...rest] = reads.get(cell) ?? []
			const here = feedback.has(cell) || first === undefined ? none : rest.reduce(meet, first)
			kept.set(cell, here)
			for (const input of new Set(edgesOf(cell.current))) {
				const at = feedback.has(cell)
					? edgesOf(cell.current)
							.filter((e) => e === input)
							.map(() => none)
					: keptBy(ed, cell, input, here, of, valueOf)
				const held = reads.getOrInsertComputed(input, () => [])
				for (const values of at) {
					held.push(values)
				}
			}
		}
		const keptAt = (cell: Cell): Values => kept.get(cell) ?? none
		for (const cell of live) {
			const node = cell.current
			if (node.kind !== "MatchRegion") {
				continue
			}
			const at = regionKept(ed, node, keptAt(cell), of, valueOf)
			const above = fixedAbove(ed, cx, cell, node, valueOf)
			const added: Array<NodeId> = []
			const occurrences = node.occurrences.map((o) => {
				if (o.source.current.kind !== "Base") {
					return o
				}
				const more = statable(o.source.current, [...o.constants, ...above], at.get(o.id) ?? none)
				if (!isNonEmpty(more)) {
					return o
				}
				added.push(o.source.id)
				return { ...o, constants: [...o.constants, ...more] }
			})
			if (added.length > 0) {
				ed.set(cell, { ...node, occurrences })
				certify(cx, propagateRules.restrict, [cell.id, ...added], cell, [cell.id])
			}
		}

		const restated = ed.topoOrder().filter((c) => !feedback.has(c))
		const after = statedValues(ed, restated, producers)
		for (const cell of restated) {
			const node = cell.current
			const read: Array<NodeId> = []
			const copy = ed.copier((ref, expr) => {
				const value = after.valueOf(ref)
				if (value === undefined || !sameScalarType(value.type, expr.type)) {
					return undefined
				}
				read.push(ref.node)
				return value
			})
			/**
			 * A filter's conjunct that fixes its input's column at a value keeps the column and reads the value as it is held,
			 * so the equality that holds the column states the value on it, never the value compared with itself.
			 */
			const readFilter = (e: ScalarExpr): ScalarExpr =>
				node.kind === "Filter" && e === node.pred
					? conjunction(
							ed,
							conjuncts(e).map((c) => {
								const f = fixing(c, node.input, after.valueOf)
								return f === undefined
									? copy.of(c)
									: ed.copyExpr(c, (ref, expr) => {
											if (ref.node === node.input.id && ref.name === f.column) {
												return undefined
											}
											const value = after.valueOf(ref)
											if (value === undefined || !sameScalarType(value.type, expr.type)) {
												return undefined
											}
											read.push(ref.node)
											return value
										})
							}),
							e
						)
					: copy.of(e)
			const next = drive(
				mapNode<EditRefs, EditRefs>(node, { ...keptRefs, expr: readFilter }),
				(input) => input
			)
			if (read.length > 0) {
				ed.set(cell, next)
				certify(cx, propagateRules.substitute, [...new Set(read)], cell, [cell.id])
			}
		}
	}

/** The constant-column pass (propagate), one traversal of a query's DAG, which has no producer. */
export const propagatePass = traversalPass({ name: "propagate", step: propagate(noProducers) })

/**
 * The constant-column pass over a write's DAG (propagate), the restated DAG its optimized artifact lowers, its leaves
 * read through the write's `producers`: the DAG it leaves, and the node each node of `dag` stands as there, every node's
 * label kept, `dag` itself where it edits nothing. A write's compile records no rewrite's certificate, and a cycle an
 * edit made is the refusal its finish throws, as every step of a write's compile throws one.
 */
export const propagatedWrite = <R extends Roots>(
	dag: ValidDag<R>,
	producers: Producers
): { readonly dag: ValidDag<R>; readonly node: (node: RelNode) => RelNode } => {
	const editor = new DagEditor(dag)
	propagate(producers)({ editor, cells: editor.cellState(), certify: () => undefined })
	if (editor.version === 0) {
		return { dag, node: (node) => node }
	}
	const finished = editor.finished()
	return { dag: finished.dag, node: (node) => finished.node(editor.cellOf(node)) }
}
