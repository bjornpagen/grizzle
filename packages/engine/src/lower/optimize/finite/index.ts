import type { NodeId } from "#compiler/core/ids.ts"
import { nativeEqualityKey, OpId, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type Cell,
	closedRows,
	type EditRefs,
	type KindOver,
	type OccurrenceOver,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { columnIn } from "#compiler/lower/conservative/context.ts"
import {
	columnRefs,
	type DagEditor,
	derivedMeta,
	widenedHeading
} from "#compiler/lower/optimize/demand/editor.ts"

import {
	type Measure,
	nodePremises,
	type RewriteCx,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"
import { overloadOf } from "#compiler/scalar/compute/registry.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"

const membershipRule = "R07.finiteMembership"

type Region = KindOver<"MatchRegion", EditRefs>
type Occurrence = OccurrenceOver<Cell, ScalarExpr, VarDecl>

const terms = (o: Occurrence, rows: number): number =>
	rows * Math.max(1, o.bindings.length + o.constants.length)

/** The membership-only closed occurrences of the region `cell` holds. */
const membershipOnly = (cx: RewriteCx, cell: Cell, region: Region): ReadonlyArray<Occurrence> => {
	const ed = cx.editor
	if (region.occurrences.length < 2 || ed.readsFeedback(cell)) {
		return []
	}
	const d = cx.demand()
	return region.occurrences.filter((o) => {
		const source = o.source.current
		if (source.kind !== "Closed" || d.lateral(o.source)) {
			return false
		}
		if (terms(o, source.rows.length) > cx.ctx.budgets.limit("variants")) {
			return false
		}
		/**
		 * A variable is bound elsewhere only by an occurrence placeable before any reader of it: a correlated source (one
		 * whose subtree reads outside itself, such as an import bound to the region's variables) may read the very
		 * variable it binds, so it cannot stand in for the closed occurrence, whose removal would leave that source
		 * waiting on itself.
		 */
		const others = region.occurrences.filter((x) => x.id !== o.id && !ed.correlated(x.source))
		const elsewhere = new Set(others.flatMap((x) => x.bindings.map((b) => b.var.id)))
		if (!o.bindings.every((b) => elsewhere.has(b.var.id))) {
			return false
		}
		return columnRefs(o.constants.map((c) => c.expr)).length === 0
	})
}

/** A boolean operator over `args`, total and immutable of itself: it can fail or is stable where one of them is. */
const opExpr = (ed: DagEditor, op: OpId, args: ReadonlyArray<ScalarExpr>): ScalarExpr =>
	ed.expr({
		kind: "op",
		op,
		args,
		type: plainType("bool"),
		nonNull: "strict",
		volatility: "immutable",
		failure: "total"
	})

const literalExpr = (ed: DagEditor, value: TypedLiteral, type: ScalarType): ScalarExpr =>
	ed.expr({
		kind: "literal",
		value,
		args: [],
		type,
		nonNull: "literal"
	})

/**
 * A reference to the region's column for `v`, typed as the variable; the region delivers it, widened if need be,
 * before the predicate is placed over it.
 */
const varRef = (ed: DagEditor, region: Cell, v: VarDecl): ScalarExpr =>
	ed.expr({
		kind: "column",
		column: { node: region.id, name: v.name },
		args: [],
		type: v.type,
		nonNull: "storage"
	})

const comparison = (fn: "eq" | "in", type: ScalarType): OpId | undefined => {
	const carrier = baseOf(type).carrier
	return (fn === "eq" ? overloadOf("eq", [carrier, carrier]) : overloadOf("in", [carrier]))?.id
}

/**
 * The predicate the occurrence stands for, over the region's own columns; `true` when it holds for every binding,
 * `false` when for none; undefined when no native operator expresses it.
 */
const membership = (
	cx: RewriteCx,
	region: Cell,
	o: Occurrence,
	source: KindOver<"Closed", EditRefs>
): { readonly pred: ScalarExpr | boolean; readonly equality: ReadonlyArray<OpId> } | undefined => {
	const ed = cx.editor
	const typeOf = new Map(source.heading.map((c) => [c.name, c.type]))
	/** One column per variable: a variable bound to two columns of the fact equates them. */
	const bound: Array<{ readonly column: string; readonly var: VarDecl }> = []
	const sameVar: Array<readonly [string, string]> = []
	for (const b of o.bindings) {
		const prior = bound.find((x) => x.var.id === b.var.id)
		if (prior === undefined) {
			bound.push({ column: b.column, var: b.var })
		} else {
			sameVar.push([prior.column, b.column])
		}
	}
	const literalConstants: Array<{ readonly column: string; readonly value: TypedLiteral }> = []
	const paramConstants: Array<{ readonly column: string; readonly expr: ScalarExpr }> = []
	for (const c of o.constants) {
		const e = c.expr
		if (e.kind === "literal") {
			literalConstants.push({ column: c.column, value: e.value })
		} else {
			paramConstants.push({ column: c.column, expr: c.expr })
		}
	}
	/** Each fact by its columns' names; every column an occurrence names is one of its source's (columnIn). */
	type Fact = ReadonlyMap<string, TypedLiteral>
	const cell = (row: Fact, column: string): TypedLiteral => columnIn(row, column)
	const typeOfColumn = (column: string): ScalarType => columnIn(typeOf, column)
	const facts: ReadonlyArray<Fact> = closedRows(source).map(
		(row) => new Map(row.map((c) => [c.column.name, c.literal]))
	)
	const rows = facts.filter(
		(row) =>
			literalConstants.every(
				(c) => nativeEqualityKey(cell(row, c.column)) === nativeEqualityKey(c.value)
			) &&
			sameVar.every(([a, b]) => nativeEqualityKey(cell(row, a)) === nativeEqualityKey(cell(row, b)))
	)
	const tested = [...bound.map((b) => b.column), ...paramConstants.map((c) => c.column)]
	if (rows.length === 0) {
		return { pred: false, equality: [] }
	}
	if (tested.length === 0) {
		return { pred: true, equality: [] }
	}
	/** The distinct tuples of the tested columns, each by the columns' names. */
	const tuples = new Map<string, Fact>()
	for (const row of rows) {
		const tuple: Fact = new Map(tested.map((c) => [c, cell(row, c)]))
		tuples.set(tested.map((c) => nativeEqualityKey(cell(row, c))).join("\u0000"), tuple)
	}
	const equality: Array<OpId> = []
	const eqOf = (column: string): OpId | undefined => {
		const op = comparison("eq", typeOfColumn(column))
		if (op !== undefined && !equality.includes(op)) {
			equality.push(op)
		}
		return op
	}
	const [only] = bound
	if (bound.length === 1 && paramConstants.length === 0 && only !== undefined) {
		const type = typeOfColumn(only.column)
		const values = [...tuples.values()].map((tuple) => cell(tuple, only.column))
		const roster = rosterOf(baseOf(type))
		if (
			roster?.handles.every((h) => values.some((v) => v.kind === "enum" && v.handle === h)) === true
		) {
			return { pred: true, equality: [] }
		}
		const column = varRef(ed, region, only.var)
		const [value] = values
		if (values.length === 1 && value !== undefined) {
			const op = eqOf(only.column)
			return op === undefined
				? undefined
				: { pred: opExpr(ed, op, [column, literalExpr(ed, value, type)]), equality }
		}
		const op = comparison("in", type)
		const eq = eqOf(only.column)
		if (op === undefined || eq === undefined) {
			return undefined
		}
		return {
			pred: opExpr(ed, op, [column, ...values.map((v) => literalExpr(ed, v, type))]),
			equality
		}
	}
	const operands = (): ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }> => [
		...bound.map((b) => ({ column: b.column, expr: varRef(ed, region, b.var) })),
		...paramConstants
	]
	/** The conjunction of a fact's equalities, or undefined when a column has no native equality. */
	const conjunctionOf = (tuple: Fact): ScalarExpr | undefined => {
		const conj: Array<ScalarExpr> = []
		for (const { column, expr } of operands()) {
			const op = eqOf(column)
			if (op === undefined) {
				return undefined
			}
			const value = cell(tuple, column)
			conj.push(opExpr(ed, op, [expr, literalExpr(ed, value, typeOfColumn(column))]))
		}
		const [sole] = conj
		return conj.length === 1 && sole !== undefined ? sole : opExpr(ed, OpId("and"), conj)
	}
	const disjuncts: Array<ScalarExpr> = []
	for (const tuple of tuples.values()) {
		const conj = conjunctionOf(tuple)
		if (conj === undefined) {
			return undefined
		}
		disjuncts.push(conj)
	}
	const [single] = disjuncts
	return {
		pred:
			disjuncts.length === 1 && single !== undefined ? single : opExpr(ed, OpId("or"), disjuncts),
		equality
	}
}

const membershipRuleImpl: Rule = {
	name: membershipRule,
	/** membershipOnly admits closed sources only. */
	at: (cell, cx) => {
		const ed: DagEditor = cx.editor
		const region = cell.current
		if (region.kind !== "MatchRegion") {
			return false
		}
		for (const o of membershipOnly(cx, cell, region)) {
			const source = o.source.current
			if (source.kind !== "Closed") {
				continue
			}
			const m = membership(cx, cell, o, source)
			if (m === undefined) {
				continue
			}
			const remaining: Region = {
				...region,
				occurrences: region.occurrences.filter((x) => x.id !== o.id)
			}
			const outputs: Array<NodeId> = [cell.id]
			if (m.pred === true) {
				ed.set(cell, remaining)
			} else {
				const pred =
					m.pred === false
						? ed.expr({
								kind: "literal",
								value: { kind: "bool", value: false },
								args: [],
								type: plainType("bool"),
								nonNull: "literal"
							})
						: m.pred
				/**
				 * The predicate reads the bound variables as the region's columns: one the region does not deliver widens
				 * it, and a projection restores the heading it had.
				 */
				const read = new Set(columnRefs([pred]).map((r) => r.name))
				const heading = widenedHeading(
					region.heading,
					region.vars.filter((v) => read.has(v.name))
				)
				const widened = heading.length > region.heading.length
				ed.set(cell, { ...remaining, heading, meta: derivedMeta(region.meta) })
				ed.insertAbove(cell, (input) => {
					const f = ed.add({
						kind: "Filter",
						input,
						pred,
						heading,
						meta: widened ? derivedMeta(region.meta) : region.meta,
						loc: undefined
					})
					outputs.push(f.id)
					if (!widened) {
						return f
					}
					const restored = ed.add({
						kind: "ProjectSet",
						input: f,
						out: region.heading.map((c) => ({ name: c.name, expr: ed.column(f, c) })),
						heading: region.heading,
						meta: region.meta,
						loc: undefined
					})
					outputs.push(restored.id)
					return restored
				})
			}
			cx.certify({
				rule: membershipRule,
				inputs: [o.source.id, cell.id],
				outputs,
				premises: nodePremises(o.source.id),
				context: "descriptor",
				preservedHeading: region.heading.map((c) => c.name),
				equality: m.equality,
				coercion: [],
				params: undefined
			})
			return true
		}
		return false
	}
}

const membershipMeasure: Measure = (cx) => {
	let count = 0
	for (const cell of cx.editor.topoOrder()) {
		const node = cell.current
		if (node.kind === "MatchRegion") {
			count += membershipOnly(cx, cell, node).length
		}
	}
	return [count]
}

/**
 * The R07 pass.
 *
 * R07: keep finite schema facts visible to PostgreSQL.
 *
 * Pattern: an occurrence of a closed relation's declared facts that only tests membership: every variable it binds
 * is bound by another occurrence of the region that is no correlated source, and its constants are literals or
 * parameters. Joining a VALUES source
 * for facts the schema already fixes hides them from the planner; the occurrence becomes a predicate over the region
 * instead ("closed facts ... can become enum membership, tuple membership, constants"):
 *
 * - one bound column: native constant membership, `v IN (l1, ..., ln)`, or `v = l` for one value. PostgreSQL may
 *   evaluate a constant IN list by hashing; the compiler neither pads it nor states the threshold. An
 *   enum column whose facts cover the whole roster is a tautology, since the variable is bound elsewhere to a value of
 *   that enum: the occurrence simply disappears;
 * - several bound columns, or parameter constants: tuple membership, the disjunction over the facts of the
 *   conjunction of each fact's equalities. For tuple rosters, independent column IN lists
 *   are not equivalent, so the correlation of each fact's values is kept;
 * - a literal constant selects the facts it matches at compile time, under native equality (ir/expr.ts
 *   nativeEqualityKey): numeric scale and float zero sign ignored, NaN equal to itself;
 * - no fact left: the predicate is false, which simplification turns into the empty relation; no bound column and no
 *   parameter constant with some fact left: the occurrence is a tautology and disappears.
 *
 * The predicate reads the bound variables as columns of the remaining region; a variable the region does not deliver
 * (a join variable outside its heading) widens it under the filter, and a projection restores its heading.
 *
 * The expansion is bounded by the policy's specialization variants (`budgets.variants`): a membership with more terms
 * keeps the VALUES join rather than growing into many branches (closed-domain
 * variants stay bounded). The facts are descriptor evidence: schema-declared, unconditional, the same in every context.
 *
 * Measure: the number of membership-only closed occurrences, which each rewrite lowers by one.
 */
export const finitePass = rewritePass({
	name: "finite",
	rules: [membershipRuleImpl],
	measure: membershipMeasure
})
