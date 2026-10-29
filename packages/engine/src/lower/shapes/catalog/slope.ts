import { sameOrder } from "#compiler/core/array.ts"
import { compareText } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { ColumnRef, LiveArgs, ScalarExpr } from "#compiler/ir/expr.ts"
import { describeOp, OpId, withArgs } from "#compiler/ir/expr.ts"
import {
	type AggregateSpec,
	type Cell,
	type EditNode,
	type EditRefs,
	exprsOf,
	type KindOver,
	keptRowsOf,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import {
	type CatalogContext,
	freshColumn,
	type Held,
	type Region,
	sameSource,
	varByName
} from "#compiler/lower/shapes/catalog/context.ts"

import {
	attempt,
	binaryOperands,
	colExpr,
	columnRef,
	conjuncts,
	demand,
	eitherOrderHolds,
	litExpr,
	literalOf,
	noMatch,
	opExpr,
	plain,
	required,
	sameExpr
} from "#compiler/lower/shapes/catalog/exprs.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

interface Sums {
	readonly n: string
	readonly sx: string
	readonly sy: string
	readonly sxy: string
	readonly sxx: string
	readonly x: ScalarExpr
	readonly y: ScalarExpr
}

type Group = KindOver<"Group", EditRefs>

const isFloat = (e: ScalarExpr) => baseOf(e.type).carrier === "float8"

/** The count and the four sums over one x and one y. */
const sumsOf = (group: Group): Sums => {
	const n = required(
		group.aggs.find((a) => a.fn === "count" && a.filter === undefined),
		"an unfiltered count"
	).name
	const sums = group.aggs.filter(
		(a): a is AggregateSpec & { args: readonly [ScalarExpr] } => a.fn === "sum"
	)
	for (const s of sums) {
		demand(isFloat(s.args[0]), "double precision sums")
	}
	const plainSum = (e: ScalarExpr): string | undefined =>
		sums.find((s) => sameExpr(s.args[0], e))?.name
	const productSum = (u: ScalarExpr, v: ScalarExpr): string | undefined =>
		sums.find((s) =>
			eitherOrderHolds(s.args[0], "float8mul", (a, b) => sameExpr(a, u) && sameExpr(b, v))
		)?.name
	/** The sums over x and one y beside it: Σy and Σxy. */
	const withY = (x: ScalarExpr, sx: string, sq: string): Sums | undefined => {
		for (const s of sums) {
			const y = s.args[0]
			if (sameExpr(y, x) || binaryOperands(y, "float8mul") !== undefined) {
				continue
			}
			const sxy = productSum(x, y)
			if (sxy !== undefined) {
				return { n, sx, sy: s.name, sxy, sxx: sq, x, y }
			}
		}
		return undefined
	}
	for (const sq of sums) {
		const args = binaryOperands(sq.args[0], "float8mul")
		const sx = args !== undefined && sameExpr(args[0], args[1]) ? plainSum(args[0]) : undefined
		const found = args === undefined || sx === undefined ? undefined : withY(args[0], sx, sq.name)
		if (found !== undefined) {
			return found
		}
	}
	return noMatch("the count and the sums Σx, Σy, Σxy, Σx² over double precision x and y")
}

/** The comparisons a denominator test makes with zero. */
type DenFn = "gt" | "ge" | "lt" | "le" | "eq" | "ne"

/** The expression shapes over the aggregate columns, read through `agg` (a column of an arm naming an aggregate). */
class Shapes {
	readonly s: Sums
	readonly agg: (ref: ColumnRef) => string | undefined
	constructor(s: Sums, agg: (ref: ColumnRef) => string | undefined) {
		this.s = s
		this.agg = agg
	}
	is(e: ScalarExpr, name: string): boolean {
		const ref = columnRef(e)
		return ref !== undefined && this.agg(ref) === name
	}
	n(e: ScalarExpr): boolean {
		const arg = e.args[0]
		return (
			e.kind === "cast" &&
			baseOf(e.type).carrier === "float8" &&
			arg !== undefined &&
			this.is(arg, this.s.n)
		)
	}
	den(e: ScalarExpr): boolean {
		const args = binaryOperands(e, "float8mi")
		if (args === undefined) {
			return false
		}
		const [l, r] = args
		const square = binaryOperands(r, "float8mul")
		return (
			eitherOrderHolds(l, "float8mul", (a, b) => this.n(a) && this.is(b, this.s.sxx)) &&
			square !== undefined &&
			this.is(square[0], this.s.sx) &&
			this.is(square[1], this.s.sx)
		)
	}
	num(e: ScalarExpr): boolean {
		const args = binaryOperands(e, "float8mi")
		if (args === undefined) {
			return false
		}
		const [l, r] = args
		return (
			eitherOrderHolds(l, "float8mul", (a, b) => this.n(a) && this.is(b, this.s.sxy)) &&
			eitherOrderHolds(r, "float8mul", (a, b) => this.is(a, this.s.sx) && this.is(b, this.s.sy))
		)
	}
	slope(e: ScalarExpr): boolean {
		const args = binaryOperands(e, "float8div")
		return args !== undefined && this.num(args[0]) && this.den(args[1])
	}
	/** den <op> 0 or 0 <op> den: the comparison as "den <op> 0", and which side den is on. */
	denTest(e: ScalarExpr): { readonly fn: string; readonly denLeft: boolean } | undefined {
		if (e.kind !== "op" || typeof e.op !== "string") {
			return undefined
		}
		const fns: Readonly<Record<string, DenFn>> = {
			float8gt: "gt",
			float8ge: "ge",
			float8lt: "lt",
			float8le: "le",
			float8eq: "eq",
			float8ne: "ne"
		}
		const fn = fns[e.op]
		const [l, r] = e.args
		if (fn === undefined || e.args.length !== 2 || l === undefined || r === undefined) {
			return undefined
		}
		const zero = (x: ScalarExpr) => {
			const lit = literalOf(x)
			return lit?.kind === "float" && lit.value === 0
		}
		const flipped: Readonly<Record<DenFn, DenFn>> = {
			gt: "lt",
			ge: "le",
			lt: "gt",
			le: "ge",
			eq: "eq",
			ne: "ne"
		}
		if (this.den(l) && zero(r)) {
			return { fn, denLeft: true }
		}
		if (zero(l) && this.den(r)) {
			return { fn: flipped[fn], denLeft: false }
		}
		return undefined
	}
	mentions(e: ScalarExpr): boolean {
		if (this.den(e) || this.num(e)) {
			return true
		}
		return e.args.some((a) => this.mentions(a))
	}
}

const excludesZero = (fn: string) => fn === "gt" || fn === "lt" || fn === "ne"
const complementExcludesZero = (fn: string) => fn === "eq" || fn === "le" || fn === "ge"

/** What an arm's expressions read the group through: the group itself, or a one-occurrence region over it. */
type ArmSource =
	| { readonly kind: "group" }
	| { readonly kind: "region"; readonly cell: Cell; readonly region: Region }

interface Arm {
	readonly source: ArmSource
	/**
	 * The filters between the arm's base and its projection, innermost first: none when the projection reads the base
	 * itself, else the one filter it reads.
	 */
	readonly filters: ReadonlyArray<Held<KindOver<"Filter", EditRefs>>>
	readonly head: Held<KindOver<"ProjectSet", EditRefs>>
}

/** Whether a column reference reads an arm's input: its base or one of its filters. */
const readsArmInput = (group: Cell, arm: Arm, ref: ColumnRef): boolean =>
	ref.node === armBase(group, arm).id || arm.filters.some((f) => f.cell.id === ref.node)

/** The cell an arm of the group `group` holds reads: the group, or its region. */
const armBase = (group: Cell, arm: Pick<Arm, "source">): Cell =>
	arm.source.kind === "region" ? arm.source.cell : group

interface SlopeResult {
	readonly inputs: ReadonlyArray<NodeId>
	readonly outputs: ReadonlyArray<NodeId>
}

/** The source columns a fold over one unrestricted occurrence reads, by its input's column names. */
const foldColumns = (
	group: Group
): { readonly source: Cell; readonly column: ReadonlyMap<string, string> } | undefined => {
	const input = group.input.current
	if (input.kind !== "MatchRegion" || input.occurrences.length !== 1) {
		return undefined
	}
	if (input.correlated.length > 0 || input.equalities.length > 0) {
		return undefined
	}
	const [occ] = input.occurrences
	if (occ === undefined || occ.constants.length > 0) {
		return undefined
	}
	const column = new Map<string, string>()
	for (const b of occ.bindings) {
		column.set(b.var.name, b.column)
	}
	return { source: occ.source, column }
}

const set = (xs: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...new Set(xs)].toSorted(compareText)

/**
 * Whether two folds compute the same sums over the same rows: the checker gives every import of the sums' query its
 * own nodes, and every arm switching on the denominator of either must switch on the same quantity.
 */
const sameFold = (a: Group, sa: Sums, b: Group, sb: Sums): boolean => {
	const fa = foldColumns(a)
	const fb = foldColumns(b)
	if (fa === undefined || fb === undefined || !sameSource(fa.source, fb.source)) {
		return false
	}
	/** The source columns of fold columns: an unmapped column is no evidence that two folds read the same rows. */
	const map = (f: typeof fa, names: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
		const out: Array<string> = []
		for (const n of names) {
			const c = f.column.get(n)
			if (c === undefined) {
				return undefined
			}
			out.push(c)
		}
		return out
	}
	const col = (f: typeof fa, e: ScalarExpr): string | undefined => {
		const ref = columnRef(e)
		return ref === undefined ? undefined : f.column.get(ref.name)
	}
	const sameColumn = (x: ScalarExpr, y: ScalarExpr): boolean => {
		const cx1 = col(fa, x)
		return cx1 !== undefined && cx1 === col(fb, y)
	}
	const boundA = map(fa, a.bound)
	const boundB = map(fb, b.bound)
	const keysA = map(fa, a.keys)
	const keysB = map(fb, b.keys)
	if (boundA === undefined || boundB === undefined || keysA === undefined || keysB === undefined) {
		return false
	}
	return (
		sameOrder(set(boundA), set(boundB)) &&
		sameOrder(keysA, keysB) &&
		sameColumn(sa.x, sb.x) &&
		sameColumn(sa.y, sb.y)
	)
}

/**
 * R32: the closed-form slope is REGR_SLOPE, its zero test REGR_SXX > 0.
 *
 * The composition: one grouped pass computing n = count and the sums Σx, Σy, Σxy, Σx², then the slope
 * (n·Σxy − Σx·Σy) / (n·Σx² − (Σx)²) guarded by a test of its denominator, either as two arms (a filter on the
 * denominator's test and a projection of the slope, beside an arm on its complement) or as a two-arm cond in a head.
 * The target adds REGR_SLOPE(y, x) and REGR_SXX(y, x) to the same grouped pass, replaces every guarded slope by the
 * former and every denominator test, in every arm, by the same test of the latter: the composed denominator is n
 * times Sxx, so its sign is Sxx's, and every arm switching on it switches on one quantity, so no group lands in two arms
 * or in none. That holds only when every reader of the denominator is a rewritten arm: an expression anywhere else
 * that reads the sums, through any chain of copied columns, keeps the composition (armsOf). REGR_SLOPE is NULL where
 * Sxx is zero, so the grouped stage evaluates it only under its own guard, CASE WHEN REGR_SXX(y, x) <> 0 THEN
 * REGR_SLOPE(y, x) ELSE 0 END (native.ts): no relation the statement builds carries a NULL, the complement arm reads
 * only REGR_SXX, and the guard's ELSE is never delivered, since every slope is read under an arm test excluding zero.
 *
 * The preconditions: x and y are double precision, since the regression aggregates accept nothing else and would
 * round an exact type; every slope is guarded by a denominator test that excludes zero, because REGR_SLOPE is NULL
 * where REGR_SXX is zero and the composition then raises division_by_zero (a composition without the test keeps its
 * form); the denominator and numerator appear nowhere but in those tests and slopes. Pairs with a
 * missing member cannot occur, inputs being non-null. The native test and the composed one are two double-precision
 * roundings of one quantity, so a near-degenerate group can fall in the other arm; the gate records that rate.
 */
export const trySlope = (cx: CatalogContext, cell: Cell): SlopeResult => {
	const node = cell.current
	if (node.kind !== "Group") {
		return noMatch("a grouped pass")
	}
	const s = sumsOf(node)
	const reachable = cx.ed.reachable()
	const folds: Array<{ readonly group: Held<Group>; readonly sums: Sums }> = [
		{ group: { cell, node }, sums: s }
	]
	for (const otherCell of cx.ed.cells()) {
		const other = otherCell.current
		if (other.kind !== "Group" || otherCell === cell || !reachable.has(otherCell)) {
			continue
		}
		const sums = attempt(() => sumsOf(other))
		if (sums.kind === "match" && sameFold(node, s, other, sums.value)) {
			folds.push({ group: { cell: otherCell, node: other }, sums: sums.value })
		}
	}
	/** Every fold's arms are found, and every other reader of its denominator refused, before any is rewritten. */
	const planned = folds.map((f) => ({ ...f, arms: armsOf(cx, f.group, f.sums) }))
	const done = planned.map((f) => rewriteFold(cx, f.group, f.sums, f.arms))
	demand(
		done.some((d) => d.slopes > 0),
		"a slope guarded by a test that excludes a zero denominator"
	)
	return {
		inputs: done.flatMap((d) => d.inputs),
		outputs: done.flatMap((d) => d.outputs)
	}
}

/**
 * The aggregate of `group` a column reference carries, through every node that copies a column of its input: every
 * node that keeps its input's rows (rel.ts keptRowsOf), a projection's bare reference, and a match's variable bound
 * to a column that carries it. None for a computed column. A column reference names its node by label, read through
 * the editor's cells by label; a label no cell has carries nothing.
 */
const carriedAggregate = (
	cx: CatalogContext,
	group: Held<Group>
): ((ref: ColumnRef) => string | undefined) => {
	const byLabel = new Map<NodeId, Cell>(cx.ed.cells().map((c) => [c.id, c]))
	return (ref) => {
		const seen = new Set<string>()
		const resolveRef = (r: ColumnRef): string | undefined => {
			const cell = byLabel.get(r.node)
			return cell === undefined ? undefined : resolve(cell, r.name)
		}
		const resolve = (cell: Cell, name: string): string | undefined => {
			const at = `${cell.id}/${name}`
			if (seen.has(at)) {
				return undefined
			}
			seen.add(at)
			if (cell === group.cell) {
				return group.node.aggs.some((a) => a.name === name) ? name : undefined
			}
			return resolveAt(cell.current, name)
		}
		/** The first source column, of a variable's bindings in order, that resolves to the aggregate. */
		const firstResolved = (columns: ReadonlyArray<readonly [Cell, string]>): string | undefined => {
			for (const [source, column] of columns) {
				const carried = resolve(source, column)
				if (carried !== undefined) {
					return carried
				}
			}
			return undefined
		}
		const resolveAt = (n: EditNode, name: string): string | undefined => {
			switch (n.kind) {
				case "ProjectSet": {
					const o = n.out.find((x) => x.name === name)
					const r = o === undefined ? undefined : columnRef(o.expr)
					return r === undefined ? undefined : resolveRef(r)
				}
				case "MatchRegion": {
					const v = varByName(n, name)
					return v === undefined
						? undefined
						: firstResolved(
								n.occurrences.flatMap((o) =>
									o.bindings
										.filter((b) => b.var.id === v.id)
										.map((b) => [o.source, b.column] as const)
								)
							)
				}
				case "Base":
				case "Closed":
				case "Context":
				case "InputSet":
				case "Delta":
				case "Filter":
				case "SemiJoin":
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
				case "OrderedSetAggregate": {
					const kept = keptRowsOf(n)
					return kept === undefined ? undefined : resolve(kept.input, name)
				}
			}
		}
		return resolveRef(ref)
	}
}

/**
 * The arms of one fold: every consumer chain of the group in a recognized shape whose expressions mention the
 * denominator or numerator. Any other expression in the DAG that reads them, through any chain of copied columns,
 * would keep the composed test beside the arms' native one, so a near-degenerate group could land in two arms or in
 * none: then the composition is kept.
 */
const armsOf = (cx: CatalogContext, group: Held<Group>, s: Sums): ReadonlyArray<Arm> => {
	const arms: Array<Arm> = []
	const only = (cell: Cell): Cell | undefined => {
		const list = cx.consumers(cell)
		const [first] = list
		return list.length === 1 && first !== undefined && !cx.isRoot(cell) ? first : undefined
	}
	const armFrom = (source: ArmSource): Arm | undefined => {
		const firstCell = only(armBase(group.cell, { source }))
		if (firstCell === undefined) {
			return undefined
		}
		const first = firstCell.current
		const filters = first.kind === "Filter" ? [{ cell: firstCell, node: first }] : []
		const headCell = first.kind === "Filter" ? only(firstCell) : firstCell
		const head = headCell?.current
		return headCell !== undefined && head?.kind === "ProjectSet"
			? { source, filters, head: { cell: headCell, node: head } }
			: undefined
	}
	for (const consumer of cx.consumers(group.cell)) {
		const c = consumer.current
		const arm =
			c.kind === "MatchRegion" &&
			c.occurrences.length === 1 &&
			c.occurrences[0]?.source === group.cell &&
			c.occurrences[0].constants.length === 0 &&
			c.correlated.length === 0
				? armFrom({ kind: "region", cell: consumer, region: c })
				: c.kind === "Filter" || c.kind === "ProjectSet"
					? armFrom({ kind: "group" })
					: undefined
		if (arm === undefined || arms.some((a) => a.head.cell === arm.head.cell)) {
			continue
		}
		const shapes = new Shapes(s, aggOf(group, arm))
		const exprs = [...arm.filters.map((f) => f.node.pred), ...arm.head.node.out.map((o) => o.expr)]
		if (exprs.some((e) => shapes.mentions(e))) {
			arms.push(arm)
		}
	}
	const inArm = new Set<Cell>(arms.flatMap((a) => [a.head.cell, ...a.filters.map((f) => f.cell)]))
	const anywhere = new Shapes(s, carriedAggregate(cx, group))
	for (const cell of cx.ed.reachable()) {
		if (inArm.has(cell) || cell === group.cell) {
			continue
		}
		demand(
			!exprsOf(cell.current).some((e) => anywhere.mentions(e)),
			"every reader of the denominator an arm in a recognized shape"
		)
	}
	return arms
}

/**
 * A column of an arm naming an aggregate of `group`: through the group itself, or through the arm's one-occurrence
 * region over it, read at the region or at one of the arm's filters.
 */
const aggOf =
	(group: Held<Group>, arm: Arm) =>
	(ref: ColumnRef): string | undefined => {
		if (!readsArmInput(group.cell, arm, ref)) {
			return undefined
		}
		if (arm.source.kind === "group") {
			return group.node.aggs.some((a) => a.name === ref.name) ? ref.name : undefined
		}
		const region = arm.source.region
		const v = varByName(region, ref.name)
		return v === undefined
			? undefined
			: region.occurrences[0]?.bindings.find((b) => b.var.id === v.id)?.column
	}

const rewriteFold = (
	cx: CatalogContext,
	held: Held<Group>,
	s: Sums,
	arms: ReadonlyArray<Arm>
): {
	readonly slopes: number
	readonly inputs: ReadonlyArray<NodeId>
	readonly outputs: ReadonlyArray<NodeId>
} => {
	if (arms.length === 0) {
		return { slopes: 0, inputs: [], outputs: [] }
	}
	const group = held.node
	/** The extended group: the same fold with REGR_SLOPE, lowered under its own Sxx guard (native.ts), and REGR_SXX. */
	const group2Name = (stem: string) =>
		freshColumn(
			group.heading.map((h) => h.name),
			stem
		)
	const slopeCol = group2Name("__regr_slope")
	const sxxCol = freshColumn([...group.heading.map((h) => h.name), slopeCol], "__regr_sxx")
	const g2 = cx.ed.node({
		kind: "Group",
		input: group.input,
		bound: group.bound,
		keys: group.keys,
		aggs: [
			...group.aggs,
			{
				name: slopeCol,
				fn: "regrSlope",
				op: OpId("regr_slope(double precision,double precision)"),
				args: [s.y, s.x],
				filter: undefined
			},
			{
				name: sxxCol,
				fn: "regrSxx",
				op: OpId("regr_sxx(double precision,double precision)"),
				args: [s.y, s.x],
				filter: undefined
			}
		],
		heading: [
			...group.heading,
			{ name: slopeCol, type: plain.float8 },
			{ name: sxxCol, type: plain.float8 }
		],
		meta: group.meta,
		loc: undefined
	})
	const outputs: Array<NodeId> = [g2.id]
	let slopes = 0
	for (const arm of arms) {
		const shapes = new Shapes(s, aggOf(held, arm))
		/** The arm's new base: the extended group, or the region over it with two more variables. */
		let base: Cell = g2
		let slopeName = slopeCol
		let sxxName = sxxCol
		if (arm.source.kind === "region") {
			const r = arm.source.region
			const taken = r.heading.map((h) => h.name)
			slopeName = freshColumn(taken, "__regr_slope")
			sxxName = freshColumn([...taken, slopeName], "__regr_sxx")
			const vs: VarDecl = { id: cx.ed.freshVar(), name: slopeName, type: plain.float8 }
			const vx: VarDecl = { id: cx.ed.freshVar(), name: sxxName, type: plain.float8 }
			const occ = required(r.occurrences[0], "the occurrence of an arm's region")
			base = cx.ed.node({
				...r,
				scope: cx.ed.freshScope(),
				vars: [...r.vars, vs, vx],
				occurrences: [
					{
						...occ,
						id: cx.ed.freshOccurrence(),
						source: g2,
						bindings: [...occ.bindings, { column: slopeCol, var: vs }, { column: sxxCol, var: vx }]
					}
				],
				heading: [
					...r.heading,
					{ name: slopeName, type: plain.float8 },
					{ name: sxxName, type: plain.float8 }
				],
				meta: r.meta
			})
		}
		outputs.push(base.id)
		const baseHeading = base.current.heading
		const guard = arm.filters.flatMap((f) => conjuncts(f.node.pred)).map((c) => shapes.denTest(c))
		const armGuarded = guard.some((t) => t !== undefined && excludesZero(t.fn))
		const rewrite = (e: ScalarExpr, into: Cell, guarded: boolean): ScalarExpr => {
			const typeOf = (name: string) =>
				required(
					into.current.heading.find((h) => h.name === name),
					`a column ${name} of ${into.id}`
				).type
			if (shapes.slope(e)) {
				demand(guarded, "a slope guarded by a test that excludes a zero denominator")
				slopes++
				return colExpr(cx.ed, into, slopeName, typeOf(slopeName))
			}
			const denTest = shapes.denTest(e)
			if (denTest !== undefined) {
				const t = denTest
				const sxx = colExpr(cx.ed, into, sxxName, plain.float8)
				const zero = litExpr(cx.ed, { kind: "float", value: 0 }, plain.float8)
				demand(e.kind === "op", "a denominator test that is an operator")
				const op = required(nativeOp(e.op), `a native denominator test ${describeOp(e.op)}`)
				return opExpr(cx.ed, op, t.denLeft ? [sxx, zero] : [zero, sxx], plain.bool)
			}
			demand(
				!shapes.den(e) && !shapes.num(e),
				"the denominator and numerator read only by tests and slopes"
			)
			if (e.kind === "column") {
				const ref = e.column
				demand(readsArmInput(held.cell, arm, ref), "an arm reading its own input")
				return colExpr(cx.ed, into, ref.name, e.type)
			}
			if (e.kind === "cond") {
				const [p, then, otherwise] = e.args
				const test = shapes.denTest(p)
				const thenGuarded = guarded || (test !== undefined && excludesZero(test.fn))
				const elseGuarded = guarded || (test !== undefined && complementExcludesZero(test.fn))
				return cx.ed.expr({
					...e,
					args: [
						rewrite(p, into, guarded),
						rewrite(then, into, thenGuarded),
						rewrite(otherwise, into, elseGuarded)
					]
				})
			}
			if (e.args.length === 0) {
				return e
			}
			return cx.ed.expr(withArgs<LiveArgs, LiveArgs>(e, (a) => rewrite(a, into, guarded)))
		}
		let input = base
		for (const f of arm.filters) {
			input = cx.ed.node({
				kind: "Filter",
				input,
				pred: rewrite(f.node.pred, input, false),
				heading: baseHeading,
				meta: f.node.meta,
				loc: undefined
			})
			outputs.push(input.id)
		}
		const head = arm.head.node
		cx.ed.redefine(arm.head.cell, {
			kind: "ProjectSet",
			input,
			out: head.out.map((o) => ({ name: o.name, expr: rewrite(o.expr, input, armGuarded) })),
			heading: head.heading,
			meta: head.meta,
			loc: undefined
		})
		outputs.push(arm.head.cell.id)
	}
	return { slopes, inputs: [held.cell.id, ...arms.map((a) => a.head.cell.id)], outputs }
}
