import { Refusal } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Direction } from "#compiler/core/order.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import type { FrameBound, NodeOf, RelKind, RelNode, WindowFrame } from "#compiler/ir/rel.ts"
import {
	type ColumnMap,
	columnIn,
	type Env,
	extendEnv,
	headingTargets,
	type LowerContext,
	type Lowerers,
	type NodeLowerer,
	namedMap,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { conservativeLowerers } from "#compiler/lower/conservative/dispatch.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { aggregateExpr } from "#compiler/lower/conservative/group/index.ts"
import { type AggregateOverload, countOverload, unaryOverload } from "#compiler/scalar/aggregate.ts"
import type {
	Expr,
	FromItem,
	FunctionCall,
	OrderItem,
	FrameBound as SqlFrameBound,
	WindowSpec
} from "#compiler/sql/ast.ts"

import {
	asc,
	call,
	col,
	core,
	derived,
	desc,
	keyedRead,
	lit,
	operandSelect,
	select,
	target
} from "#compiler/sql/build.ts"

const frameBound = (b: FrameBound): SqlFrameBound => {
	if (b === "unboundedPreceding") {
		return { kind: "unboundedPreceding" }
	}
	if (b === "currentRow") {
		return { kind: "currentRow" }
	}
	return "preceding" in b
		? { kind: "offset", offset: b.preceding, direction: "PRECEDING" }
		: { kind: "offset", offset: b.following, direction: "FOLLOWING" }
}

const frameOf = (frame: WindowFrame | undefined): WindowSpec["frame"] | undefined =>
	frame === undefined ? undefined : { start: frameBound(frame.start), end: frameBound(frame.end) }

/** The columns a window reads from its input: partition, order, and those its arguments and filter name. */
const windowReads = (w: NodeOf<"Window">): ReadonlySet<string> => {
	const read = new Set<string>([...w.partition, ...w.order.keys.map((k) => k.column)])
	for (const e of exprClosure([...w.args, ...(w.filter === undefined ? [] : [w.filter])])) {
		if (e.kind === "column") {
			read.add(e.column.name)
		}
	}
	return read
}

/** The ORDER BY items of `keys`, columns of the input `map` reads (valid DAG). */
const orderItems = (
	keys: ReadonlyArray<{ readonly column: string; readonly dir: Direction }>,
	map: ColumnMap
) =>
	keys.map((k): OrderItem => {
		const e = columnIn(map, k.column)
		return k.dir === "asc" ? asc(e) : desc(e)
	})

/**
 * A running aggregate's overload over its argument's type, as a Group's is (conservative/group groupAggregateOverload),
 * refused where PostgreSQL defines none.
 */
const windowOverload = (
	fn: "sum" | "avg" | "min" | "max",
	w: NodeOf<"Window">,
	at: string
): AggregateOverload => {
	const [arg] = w.args
	if (arg === undefined) {
		return refuse("MalformedDescription", at, `${fn} over one argument`)
	}
	const overload = unaryOverload(fn === "avg" ? "mean" : fn, arg.type, SourceLoc(at, []))
	if (!overload.ok) {
		throw new Refusal(overload.error)
	}
	return overload.value
}

/**
 * A window's call over its input's columns `map`: its partition and order are columns of its input (valid DAG). A
 * running aggregate is its overload's lowering (conservative/group aggregateExpr) under the window, so a running sum or
 * mean over real, double precision or money accumulates exactly and is a function of the frame's rows, each once, never
 * of the window's order.
 */
const windowCall = (cx: LowerContext, w: NodeOf<"Window">, map: ColumnMap, scope: Env): Expr => {
	const at = nodeLabel(w)
	const partitionBy = w.partition.map((c) => columnIn(map, c))
	const orderBy = orderItems(w.order.keys, map)
	const frame = frameOf(w.frame)
	const over: WindowSpec = { partitionBy, orderBy, frame }
	const args = w.args.map((a) => lowerExpr(cx, a, scope))
	switch (w.fn) {
		case "rowNumber":
			return { ...call("row_number", []), over }
		case "rank":
			return { ...call("rank", []), over }
		case "denseRank":
			return { ...call("dense_rank", []), over }
		case "count":
			return aggregateExpr(
				countOverload(),
				[],
				w.filter === undefined ? undefined : lowerExpr(cx, w.filter, scope),
				over
			)
		case "sum":
		case "avg":
		case "min":
		case "max":
			return aggregateExpr(windowOverload(w.fn, w, at), args, undefined, over)
		case "lag":
		case "lead":
			if (args.length !== 3) {
				return refuse(
					"MalformedDescription",
					at,
					`${w.fn} with its offset and default, so it never yields NULL`
				)
			}
			return { ...call(w.fn, args), over }
	}
}

/**
 * The Window plug-in: the node and every window below it that it can share a SELECT with.
 *
 * The native targets of the compile-target catalog: SQL for the internal Window and OrderedSetAggregate nodes (R41,
 * R42).
 *
 * Both nodes exist only as the products of the catalog's rewrites (rewrite.ts), and each lowers to exactly the form
 * its entry names, over an input that is already the established distinct set the entry requires: the
 * input is lowered by whatever plug-in its kind has, so the deduplication the optimized pipeline places (or the
 * conservative lowering's own DISTINCT) is the input's, and neither node adds a DISTINCT of its own. A window adds a
 * column to each input row, so its output is a set when its input is; an ordered-set aggregate groups by its keys, so
 * its output is a set by construction.
 *
 * Window: `SELECT <input columns>, <fn>(<args>) [FILTER (WHERE p)] OVER (PARTITION BY ... ORDER BY ... [ROWS BETWEEN
 * ... AND ...]) FROM (<input>) AS r(...)`. A chain of windows over one another lowers into one SELECT when no window of
 * the chain reads a column another window of the chain computes, so the running aggregates of one rule share one sort
 * and one window pass (R41: one sort and one window pass per partition order). ROWS is the only frame unit,
 * always explicit; LEAD and LAG always carry their default, so no window delivers NULL (the kernel's structural audit,
 * test/support/oracle/verify/sql.ts, checks it).
 *
 * OrderedSetAggregate: `SELECT <keys>, percentile_disc(p) WITHIN GROUP (ORDER BY v), ... FROM (<input>) AS r(...)
 * GROUP BY <keys>`; with no key, the input carries one more constant private column and the query groups by it, so
 * an empty input creates no group and no NULL-bearing row, exactly as an aggregate-only Group does.
 * Several fractions are one call each over the same WITHIN GROUP order, which PostgreSQL evaluates over one sorted
 * input; the array overload of PERCENTILE_DISC needs an array constructor and a subscript the SQL AST does not have.
 */
const lowerWindowNative: NodeLowerer<"Window"> = (node, cx, env) => {
	const at = nodeLabel(node)
	const chain: Array<NodeOf<"Window">> = [node]
	let below: RelNode = node.input
	while (below.kind === "Window") {
		const inner = below
		if (chain.some((w) => windowReads(w).has(inner.out))) {
			break
		}
		chain.unshift(inner)
		below = inner.input
	}
	const base = below
	if (base.heading.length === 0) {
		return refuse("MalformedDescription", at, "a window over a relation with columns")
	}
	const source = cx.source(base, env)
	/** Every window of the chain reads its own input's columns, which are the base's: none reads another's output. */
	const scopeIds: Array<NodeId> = [base.id, ...chain.slice(0, -1).map((w) => w.id)]
	const scope = extendEnv(
		env,
		scopeIds.map((id) => [id, source.map] as const)
	)
	const targets = [
		...headingTargets(base.heading, source.map),
		...chain.map((w) => target(windowCall(cx, w, source.map, scope)))
	]
	return operandSelect(keyedRead(targets, [source.item], undefined))
}

/** The OrderedSetAggregate plug-in. */
const lowerOrderedSetAggregateNative: NodeLowerer<"OrderedSetAggregate"> = (node, cx, env) => {
	const inputNode = node.input
	const input = cx.source(node.input, env)
	const ungrouped = node.keys.length === 0
	let from: FromItem
	let map: ColumnMap
	let present: Expr | undefined
	if (ungrouped) {
		/** The constant private group key every input row carries. */
		const origin = { kind: "node", node: node.id } as const
		const names = inputNode.heading.map((c) => c.name)
		const carried = operandSelect(
			keyedRead(
				[...headingTargets(inputNode.heading, input.map), target(lit.bool(true))],
				[input.item],
				undefined
			)
		)
		const named = cx.freshColumns(names, origin)
		const presentColumn = cx.supply.column(origin)
		const alias = cx.relationAlias(origin)
		from = derived(carried, alias, [...named.map((n) => n.column), presentColumn], false)
		map = namedMap(alias, named)
		present = col(alias, presentColumn)
	} else {
		from = input.item
		map = input.map
	}
	const scope = extendEnv(env, [[node.input.id, map]])
	const within = orderItems(node.order.keys, map)
	/** One call per output: mode's one, or one per fraction for a percentile, subscripted from the array overload. */
	const aggregates = (): ReadonlyArray<FunctionCall> => {
		switch (node.fn) {
			case "mode":
				return node.outs.map(() => ({ ...call("mode", []), withinGroup: within }))
			case "percentileDisc":
			case "percentileCont": {
				const fn = node.fn === "percentileDisc" ? "percentile_disc" : "percentile_cont"
				return node.fractions.map((fraction) => ({
					...call(fn, [lowerExpr(cx, fraction, scope)]),
					withinGroup: within
				}))
			}
		}
	}
	const keyExprs = node.keys.map((k) => columnIn(map, k))
	const targets = [...keyExprs.map((e) => target(e)), ...aggregates().map((a) => target(a))]
	return select({
		...core(targets, [from], undefined),
		rows: present === undefined ? "grouped" : "oneRow",
		groupBy: present === undefined ? keyExprs : [present]
	})
}

/**
 * The conservative kind table with the catalog's targets in place of its refusals of the internal kinds: the
 * lowering the agreement suite compares with the composition, and the shape the optimized table takes for them.
 */
export const catalogLowerers: Lowerers<RelKind> = {
	...conservativeLowerers,
	Window: lowerWindowNative,
	OrderedSetAggregate: lowerOrderedSetAggregateNative,
	Group: conservativeLowerers.Group
}
