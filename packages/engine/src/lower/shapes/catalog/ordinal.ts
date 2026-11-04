import { appendAll } from "#compiler/core/array.ts"
import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { CatalogRule } from "#compiler/ir/certificate.ts"
import type { Grounds } from "#compiler/ir/evidence.ts"
import type { ColumnRef, ScalarExpr } from "#compiler/ir/expr.ts"
import { integerLiteral, OpId, sortedOps } from "#compiler/ir/expr.ts"
import {
	type ClassMember,
	claimedColumns,
	claimedMembers,
	rewriteClaim
} from "#compiler/ir/keys.ts"

import {
	type Cell,
	conservativeMeta,
	type EditNode,
	type EditRefs,
	type KeySet,
	type KindOver,
	type MetaSpec,
	type WindowFn,
	type WindowFrame
} from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import {
	bindingsByVar,
	type CatalogContext,
	freshColumn,
	type Held,
	type KeyGrounds,
	sameSource
} from "#compiler/lower/shapes/catalog/context.ts"

import {
	andExpr,
	attempt,
	castExpr,
	colExpr,
	columnsRead,
	compareExpr,
	conjuncts,
	demand,
	literalOf,
	noMatch,
	opView,
	plain,
	rebase,
	required
} from "#compiler/lower/shapes/catalog/exprs.ts"
import { lexicographicOrder } from "#compiler/lower/shapes/catalog/lexicographic.ts"

export interface OrderKeyOf {
	readonly column: string
	readonly dir: "asc" | "desc"
}

/** A recognized inclusive self-match fold: everything a target needs, in source columns. */
export interface SelfMatch {
	readonly group: Held<Group>
	readonly filter: Cell
	readonly region: Cell
	readonly source: Cell
	/** Source columns: the partition (group variables) and the completed order. */
	readonly partition: ReadonlyArray<string>
	readonly order: ReadonlyArray<OrderKeyOf>
	/** Region columns the first and the second occurrence bind (group variables in both), to source columns. */
	readonly firstColumn: ReadonlyMap<string, string>
	readonly secondColumn: ReadonlyMap<string, string>
	/** Constants both occurrences fix to one value: restrictions of the source. */
	readonly shared: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>
	/** Constants only the first occurrence fixes, and the conjuncts that read only first-occurrence fields. */
	readonly firstConstants: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>
	readonly firstConditions: ReadonlyArray<ScalarExpr>
	readonly key: KeyGrounds
	readonly comparisons: ReadonlyArray<OpId>
}

type Group = KindOver<"Group", EditRefs>

const comparisonOps = (exprs: ReadonlyArray<ScalarExpr>): ReadonlyArray<OpId> => {
	const out = new Set<OpId>()
	const stack = [...exprs]
	for (let e = stack.pop(); e !== undefined; e = stack.pop()) {
		const v = opView(e)
		if (v === undefined) {
			continue
		}
		if (v.fn === "and" || v.fn === "or" || v.fn === "not") {
			appendAll(stack, v.args)
		} else {
			out.add(v.op)
		}
	}
	return sortedOps(out)
}

/** Recognizes the self-match below a Group (throws NoMatch with the reason otherwise). */
export const selfMatch = (cx: CatalogContext, groupCell: Cell, group: Group): SelfMatch => {
	const filterCell = group.input
	const f = filterCell.current
	demand(f.kind === "Filter", "a fold over a filtered match")
	const regionCell = f.input
	const r = regionCell.current
	demand(r.kind === "MatchRegion", "a filter over one match region")
	const [o0, o1] = r.occurrences
	demand(
		r.occurrences.length === 2 && o0 !== undefined && o1 !== undefined,
		"exactly two occurrences"
	)
	demand(
		r.equalities.length === 0 && r.correlated.length === 0,
		"an uncorrelated region without stated equalities"
	)
	demand(sameSource(o0.source, o1.source), "two occurrences of one source")
	const source = o0.source
	const byVar = bindingsByVar(r)
	for (const list of byVar.values()) {
		const occs = list.map((b) => b.occurrence)
		demand(new Set(occs).size === occs.length, "each variable bound once per occurrence")
		if (list.length === 2) {
			demand(list[0]?.column === list[1]?.column, "a shared variable naming one column in both")
		}
	}
	const shared: Array<{ column: string; expr: ScalarExpr }> = []
	const constantsOf = (i: 0 | 1) => (i === 0 ? o0 : o1).constants
	for (const c of o0.constants) {
		const other = o1.constants.find((d) => d.column === c.column)
		if (other !== undefined && sameConstant(c.expr, other.expr)) {
			shared.push(c)
		}
	}
	const isShared = (column: string) => shared.some((s) => s.column === column)
	/** The bound tuple separates the predecessors: the second occurrence's tuple and the group. */
	const tryRoles = (first: 0 | 1): SelfMatch => {
		const second = first === 0 ? 1 : 0
		const firstColumn = new Map<string, string>()
		const secondColumn = new Map<string, string>()
		const sharedVars = new Set<string>()
		for (const [v, list] of byVar) {
			const name = v.name
			for (const b of list) {
				;(b.occurrence === first ? firstColumn : secondColumn).set(name, b.column)
			}
			if (list.length === 2) {
				sharedVars.add(name)
			}
		}
		demand(
			constantsOf(second).every((c) => isShared(c.column)),
			"no constant on the second occurrence alone (it would restrict the counted rows)"
		)
		const firstConstants = constantsOf(first).filter((c) => !isShared(c.column))
		const secondOnly = (name: string) => secondColumn.has(name) && !sharedVars.has(name)
		const lexParts: Array<ScalarExpr> = []
		const firstConditions: Array<ScalarExpr> = []
		for (const c of conjuncts(f.pred)) {
			const reads = columnsRead(c)
			if (reads.some((ref) => ref.node === regionCell.id && secondOnly(ref.name))) {
				lexParts.push(c)
			} else {
				firstConditions.push(c)
			}
		}
		demand(lexParts.length > 0, "a comparison restricting the second occurrence")
		/** andExpr is the one part itself when there is one. */
		const pred = andExpr(cx.ed, lexParts)
		const l = required(
			lexicographicOrder(pred, (ref) => {
				if (ref.node !== regionCell.id || sharedVars.has(ref.name)) {
					return undefined
				}
				const s = secondColumn.get(ref.name)
				if (s !== undefined) {
					return { side: "b", id: s }
				}
				const a = firstColumn.get(ref.name)
				return a === undefined ? undefined : { side: "a", id: a }
			}),
			"exactly a lexicographic comparison of paired fields"
		)
		demand(l.inclusive, "the inclusive comparison: the strict one makes the first row vanish")
		const partition = [...sharedVars].map((n) =>
			required(firstColumn.get(n), `the shared variable ${n}`)
		)
		for (const s of shared) {
			if (!partition.includes(s.column)) {
				partition.push(s.column)
			}
		}
		demand(
			l.order.every((o) => o.a === o.b),
			"each comparison between one field of the two occurrences"
		)
		const order = l.order.map((o) => ({ column: o.a, dir: o.dir }))
		demand(
			order.every((o) => !partition.includes(o.column)),
			"an order over fields that are not group variables"
		)
		const orderKey = required(
			cx.keyWithin(source, new Set([...partition, ...order.map((o) => o.column)])),
			"a completed order: group and tuple cover a key of the source"
		)
		/** The keys are first-occurrence fields that determine its row. */
		const keyColumns = new Set<string>(shared.map((s) => s.column))
		for (const k of group.keys) {
			const c = firstColumn.get(k)
			demand(c !== undefined, `a group key ${k} the first occurrence binds`)
			keyColumns.add(c)
		}
		demand(
			cx.keyWithin(source, keyColumns) !== undefined,
			"group keys that determine the first occurrence's row"
		)
		for (const [name, column] of secondColumn) {
			if (order.some((o) => o.column === column) || partition.includes(column)) {
				demand(group.bound.includes(name), `the second occurrence's ${name} in the bound tuple`)
			}
		}
		for (const c of firstConditions) {
			demand(
				columnsRead(c).every((ref) => ref.node === regionCell.id && firstColumn.has(ref.name)),
				"conditions on the first occurrence's fields only"
			)
		}
		return {
			group: { cell: groupCell, node: group },
			filter: filterCell,
			region: regionCell,
			source,
			partition,
			order,
			firstColumn,
			secondColumn,
			shared,
			firstConstants,
			firstConditions,
			key: orderKey,
			comparisons: comparisonOps(lexParts)
		}
	}
	/** Either occurrence may be the first; the reason kept is the first role's. */
	const first = attempt(() => tryRoles(0))
	if (first.kind === "match") {
		return first.value
	}
	const second = attempt(() => tryRoles(1))
	return second.kind === "match" ? second.value : noMatch(first.reason)
}

/** Whether two constants fix one value: one expression, or one parameter or one literal of one type. */
const sameConstant = (x: ScalarExpr, y: ScalarExpr): boolean => {
	if (x === y) {
		return true
	}
	if (x.kind === "param" && y.kind === "param") {
		return x.param === y.param && sameScalarType(x.type, y.type)
	}
	if (x.kind === "literal" && y.kind === "literal") {
		return sameScalarType(x.type, y.type) && canonicalEquals(x.value, y.value, everyProperty)
	}
	return false
}

/**
 * Keys a rewrite claims of a node it builds, over the classes of equal columns of its rows: a member stands for the key
 * column it names in each key holding that column.
 */
export interface RowKeys {
	readonly keys: ReadonlyArray<KeySet>
	readonly members: ReadonlyArray<ClassMember>
}

/** Keys of rows of no class of several columns. */
export const plainKeys = (keys: ReadonlyArray<KeySet>): RowKeys => ({ keys, members: [] })

/**
 * The keys a new node over `source`'s rows keeps, as the rewrite claims them of it: the source's own (a Filter and a
 * Window keep their input's), with their classes' members, a stored relation's declared keys.
 */
export const keysOfRows = (source: EditNode): RowKeys =>
	source.kind === "Base"
		? plainKeys([source.primaryKey, ...source.keys])
		: {
				keys: source.meta.logicalKeys.map(claimedColumns),
				members: source.meta.logicalKeys.flatMap(claimedMembers)
			}

/** The metadata of a node a rewrite builds, claiming `rows`' keys of it by construction, each once. */
export const metaWithKeys = (rows: RowKeys): MetaSpec => {
	const distinct: Array<KeySet> = []
	for (const k of rows.keys) {
		if (!distinct.some((d) => d.length === k.length && d.every((c) => k.includes(c)))) {
			distinct.push(k)
		}
	}
	return { ...conservativeMeta, logicalKeys: distinct.map((k) => rewriteClaim(k, rows.members)) }
}

/** A Filter over `input` restricting `column = expr` for each constant, plus `conditions` already over its columns. */
export const restrict = (
	cx: CatalogContext,
	input: Cell,
	constants: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>,
	conditions: ReadonlyArray<ScalarExpr>,
	keys: RowKeys
): Cell => {
	if (constants.length === 0 && conditions.length === 0) {
		return input
	}
	const heading = input.current.heading
	const preds = constants.map((c) => {
		const col = required(
			heading.find((h) => h.name === c.column),
			`a column ${c.column} to restrict`
		)
		return compareExpr(cx.ed, "eq", colExpr(cx.ed, input, c.column, col.type), c.expr)
	})
	return cx.ed.node({
		kind: "Filter",
		input,
		pred: andExpr(cx.ed, [...preds, ...conditions]),
		heading,
		meta: metaWithKeys(keys),
		loc: undefined
	})
}

interface WindowSpecOf {
	readonly fn: WindowFn
	readonly op: string
	/** Builds the arguments and filter over the window's input node; a window without a FILTER clause has no filter. */
	readonly args: (input: Cell) => ReadonlyArray<ScalarExpr>
	readonly filter: ((input: Cell) => ScalarExpr) | undefined
	/** The frame, or undefined for the default one, which a ranking or offset function ignores. */
	readonly frame: WindowFrame | undefined
	readonly type: ScalarType
	readonly rule: CatalogRule
	readonly stem: string
}

/** A chain of windows over `input`, one per spec, each over the previous; returns the last node and each output name. */
export const windowChain = (
	cx: CatalogContext,
	input: Cell,
	partition: ReadonlyArray<string>,
	order: ReadonlyArray<OrderKeyOf>,
	specs: ReadonlyArray<WindowSpecOf>,
	keys: RowKeys
): {
	readonly last: Cell
	readonly outs: ReadonlyArray<string>
	readonly nodes: ReadonlyArray<Cell>
} => {
	let current = input
	const outs: Array<string> = []
	const nodes: Array<Cell> = []
	for (const spec of specs) {
		const heading = current.current.heading
		const out = freshColumn(
			heading.map((h) => h.name),
			spec.stem
		)
		const extra: Array<KeySet> = spec.fn === "rowNumber" ? [[...partition, out]] : []
		const id = cx.ed.node({
			kind: "Window",
			input: current,
			partition,
			order: { keys: order },
			fn: spec.fn,
			op: OpId(spec.op),
			args: spec.args(current),
			filter: spec.filter === undefined ? undefined : spec.filter(current),
			frame: spec.frame,
			out,
			rule: spec.rule,
			heading: [...heading, { name: out, type: spec.type }],
			meta: metaWithKeys({ keys: [...keys.keys, ...extra], members: keys.members }),
			loc: undefined
		})
		outs.push(out)
		nodes.push(id)
		current = id
	}
	return { last: current, outs, nodes }
}

export const runningFrame: WindowFrame = {
	unit: "rows",
	start: "unboundedPreceding",
	end: "currentRow"
}

/** sum(cond(p, 1, 0)) over integer literals, or numeric ones of an integer value: the conditional count's predicate (R24). */
const conditionalCountOf = (e: ScalarExpr): ScalarExpr | undefined => {
	if (e.kind !== "cond") {
		return undefined
	}
	const [p, t, o] = e.args
	const integer = (x: ScalarExpr, value: bigint): boolean => {
		const l = literalOf(x)
		return l !== undefined && integerLiteral(l) === value
	}
	return integer(t, 1n) && integer(o, 0n) ? p : undefined
}

/** The rewrite: the Group redefined as a projection of a window chain over the source. */
const rewriteSelfMatch = (
	cx: CatalogContext,
	m: SelfMatch
): { readonly rules: ReadonlyArray<CatalogRule>; readonly outputs: ReadonlyArray<NodeId> } => {
	const group = m.group.node
	const keys = keysOfRows(m.source.current)
	/** Second-occurrence and group fields, as source columns of the window's input. */
	const toSource =
		(input: Cell) =>
		(ref: ColumnRef): ColumnRef | undefined => {
			if (ref.node !== m.filter.id) {
				return undefined
			}
			const c = m.secondColumn.get(ref.name)
			return c === undefined ? undefined : { node: input.id, name: c }
		}
	const pre = restrict(cx, m.source, m.shared, [], keys)
	/** `cast`: the window counts in bigint, and the fold's own type is another one. */
	const specs: Array<WindowSpecOf & { readonly agg: string; readonly cast: boolean }> = []
	for (const agg of group.aggs) {
		const type = required(
			group.heading.find((h) => h.name === agg.name),
			`an aggregate ${agg.name} in the heading`
		).type
		const reads = [...agg.args, ...(agg.filter === undefined ? [] : [agg.filter])].flatMap((a) =>
			columnsRead(a)
		)
		demand(
			reads.every((ref) => ref.node === m.filter.id && m.secondColumn.has(ref.name)),
			`the fold ${agg.name} reading the second occurrence only`
		)
		const [summed] = agg.args
		const conditional =
			agg.fn === "sum" && summed !== undefined ? conditionalCountOf(summed) : undefined
		if (agg.fn === "count" && agg.filter === undefined) {
			specs.push({
				agg: agg.name,
				fn: "rowNumber",
				op: "row_number()",
				args: () => [],
				filter: undefined,
				frame: undefined,
				type,
				rule: "R26",
				stem: "__ordinal",
				cast: false
			})
			continue
		}
		/** A count's filter is set here, the unfiltered count being the ordinal above. */
		const filtered = agg.fn === "count" ? agg.filter : conditional
		if (filtered !== undefined) {
			const p = filtered
			/** count is bigint; the composition's sum is bigint over integer literals and numeric otherwise (R24). */
			const cast = baseOf(type).carrier !== "int8"
			specs.push({
				agg: agg.name,
				fn: "count",
				op: "count()",
				args: () => [],
				filter: (input) => rebase(cx.ed, p, toSource(input)),
				frame: runningFrame,
				type: cast ? plain.int8 : type,
				rule: "R41",
				stem: "__running",
				cast
			})
			continue
		}
		const fn: WindowFn | undefined =
			agg.fn === "sum" || agg.fn === "avg" || agg.fn === "min" || agg.fn === "max"
				? agg.fn
				: agg.fn === "boolAnd"
					? "min"
					: agg.fn === "boolOr"
						? "max"
						: undefined
		demand(fn !== undefined, `a running form of ${agg.fn}`)
		const arg = required(agg.args[0], `the argument of ${agg.name}`)
		if (fn === "min" || fn === "max") {
			demand(sameScalarType(arg.type, type), `${agg.name} at its value's type`)
		}
		specs.push({
			agg: agg.name,
			fn,
			op: agg.op,
			args: (input) => [rebase(cx.ed, arg, toSource(input))],
			filter: undefined,
			frame: runningFrame,
			type,
			rule: "R41",
			stem: "__running",
			cast: false
		})
	}
	demand(specs.length > 0, "a fold to rewrite")
	const chain = windowChain(cx, pre, m.partition, m.order, specs, keys)
	/** First-occurrence conditions, over the chain's columns. */
	const last = chain.last
	const firstRef = (ref: ColumnRef): ColumnRef | undefined => {
		if (ref.node !== m.region.id) {
			return undefined
		}
		const c = m.firstColumn.get(ref.name)
		return c === undefined ? undefined : { node: last.id, name: c }
	}
	const conditions = m.firstConditions.map((c) => rebase(cx.ed, c, firstRef))
	const post = restrict(cx, last, m.firstConstants, conditions, keys)
	const postHeading = post.current.heading
	const out = group.heading.map((h) => {
		const window = [...specs.entries()].find(([, spec]) => spec.agg === h.name)
		if (window !== undefined) {
			const [index, spec] = window
			const name = required(chain.outs[index], `the window output of ${h.name}`)
			const col = required(
				postHeading.find((c) => c.name === name),
				`a window output ${name}`
			)
			const ref = colExpr(cx.ed, post, name, col.type)
			return { name: h.name, expr: spec.cast ? castExpr(cx.ed, ref, h.type, undefined) : ref }
		}
		const c = required(
			m.firstColumn.get(h.name),
			`a group key ${h.name} the first occurrence binds`
		)
		required(
			postHeading.find((p) => p.name === c && sameScalarType(p.type, h.type)),
			`the key ${h.name} at its source type`
		)
		return { name: h.name, expr: colExpr(cx.ed, post, c, h.type) }
	})
	cx.ed.redefine(m.group.cell, {
		kind: "ProjectSet",
		input: post,
		out,
		heading: group.heading,
		meta: group.meta,
		loc: undefined
	})
	const rules = [...new Set(specs.map((s) => s.rule))].toSorted()
	return {
		rules,
		outputs: [
			m.group.cell.id,
			...chain.nodes.map((c) => c.id),
			...(post === last ? [] : [post.id]),
			...(pre === m.source ? [] : [pre.id])
		]
	}
}

/**
 * The R26/R41 recognizer at a Group: the rewrite, or the reason it does not apply.
 *
 * R26 and R41: an inclusive self-match counted or folded is a window over the source (R41).
 *
 * The composition: one source matched twice on the same group variables, the second occurrence
 * restricted by the inclusive lexicographic comparison of a tuple the order completes, grouped by the first
 * occurrence's fields, and counted (an ordinal) or folded over a field of the second occurrence (a running total,
 * maximum, mean, or a conditional count of run starts):
 *
 *   Group(keys: first's fields, aggs) <- Filter(t <= s lexicographically) <- MatchRegion(S as s, S as t)
 *
 * becomes, with the group's heading and identity unchanged,
 *
 *   ProjectSet <- [Filter: first-only conditions] <- Window ... <- Window <- [Filter: shared constants] <- S
 *
 * ROW_NUMBER() OVER (PARTITION BY group ORDER BY tuple) for the count, and <agg>(x) OVER (PARTITION BY group ORDER BY
 * tuple ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) for each fold, the tuple's directions as the comparison
 * states them ("descending for >=", which the truth table of lexicographic.ts yields as a direction per field).
 *
 * The exact preconditions, each checked here and each a reason the composed self-join is kept when it fails:
 *
 * - The two occurrences read one source; a variable both bind is a group variable and names one column in both.
 * - The predicate's conjuncts that read a second-occurrence field form exactly the inclusive lexicographic comparison
 *   "second <= first" over pairs of one column each; no other condition reads the second occurrence (R41: a
 *   further predicate there makes the group possibly empty, where the frame aggregate would be NULL). A constant on
 *   both occurrences is a shared restriction applied to the source first; a constant or condition reading only the
 *   first occurrence filters the result rows afterward.
 * - The group, the tuple and the shared constants cover a key of the source, so the order is total and the count of
 *   predecessors is a position; the key's evidence is admitted for the compiled context.
 * - The group keys are first-occurrence fields that determine its row (they cover a key), so each group is one row
 *   of the source; the bound tuple carries the second occurrence's tuple, so each contribution is one predecessor.
 * - Every fold reads only the second occurrence and the group: count, sum, mean, min, max, a filtered count, and
 *   sum(cond(p, 1, 0)), the conditional count, which is count(*) FILTER (WHERE p) cast to the sum's type (R24's
 *   typing).
 *
 * The inclusive comparison is satisfied by the row itself, so every group is nonempty, the first row has ordinal one,
 * and no frame is empty: no running result is NULL.
 */
export const tryOrdinal = (cx: CatalogContext, cell: Cell): OrdinalResult => {
	const node = cell.current
	if (node.kind !== "Group" || node.aggs.length === 0) {
		return noMatch("a Group with aggregates")
	}
	const m = selfMatch(cx, cell, node)
	const done = rewriteSelfMatch(cx, m)
	return {
		rules: done.rules,
		inputs: [cell.id, m.filter.id, m.region.id, m.source.id],
		outputs: done.outputs,
		premises: m.key.premises,
		context: m.key.context,
		equality: m.comparisons
	}
}

/** What the ordinal rewrite records: its rules, the nodes it read and wrote, and the order's key evidence. */
interface OrdinalResult extends Grounds {
	readonly rules: ReadonlyArray<CatalogRule>
	readonly inputs: ReadonlyArray<NodeId>
	readonly outputs: ReadonlyArray<NodeId>
	readonly equality: ReadonlyArray<OpId>
}
