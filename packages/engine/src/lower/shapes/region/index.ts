import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { NodeOf, RelNode, VarDecl } from "#compiler/ir/rel.ts"
import { baseOf, type Carrier } from "#compiler/ir/scalar.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import {
	type ColumnEqualities,
	distinctSelect,
	type Env,
	extendEnv,
	type LowerContext,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import {
	type KeyedProbes,
	type PlacedOccurrence,
	regionParts
} from "#compiler/lower/conservative/match-region/index.ts"
import { probesByKey } from "#compiler/lower/optimize/cte-policy/index.ts"
import { keyedGroup } from "#compiler/lower/shapes/aggregate/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { keyedUnion } from "#compiler/lower/shapes/union/index.ts"
import { type NativeOp, nativeOp, operandCarriers } from "#compiler/scalar/compute/registry.ts"
import type { Expr, FromItem, JoinStep, OperandBody, Select, Target } from "#compiler/sql/ast.ts"
import {
	and,
	col,
	conjunction,
	core,
	derived,
	lit,
	operandSelect,
	select,
	target
} from "#compiler/sql/build.ts"
import { identityHooks, inertVisitor, transformExpr, visitSelect } from "#compiler/sql/transform.ts"

/**
 * PostgreSQL's default join_collapse_limit, which is from_collapse_limit's too: the most FROM items the planner flattens
 * one join problem into, and plans exhaustively, before it plans the rest as separate subproblems in the order written.
 * No grizzle session sets either, so the default is the value every statement is planned under. The docs state it
 * through from_collapse_limit, "By default, this variable is set the same as from_collapse_limit", whose "default is
 * eight" (https://www.postgresql.org/docs/19/runtime-config-query.html).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's planner
 * @unit FROM items
 * @scope one join problem the planner flattens, under the session default no grizzle session changes
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L1538-L1546
 * @quote { name => 'join_collapse_limit', type => 'int', context => 'PGC_USERSET', [...] boot_val => '8',
 * @verified 2026-11-20
 */
export const collapseLimit = 8

/** The relation aliases a query fragment reads through column references, at any depth. */
const aliasesRead = (body: OperandBody, within: ReadonlySet<string>): ReadonlySet<string> => {
	const out = new Set<string>()
	visitSelect(operandSelect(body), {
		...inertVisitor,
		expr: (e) => {
			if (e.kind === "column" && e.table !== undefined && within.has(e.table)) {
				out.add(e.table)
			}
		}
	})
	return out
}

const exprReads = (e: Expr, within: ReadonlySet<string>): ReadonlySet<string> =>
	aliasesRead(core([target(e)], [], undefined), within)

const itemReads = (item: FromItem, within: ReadonlySet<string>): ReadonlySet<string> =>
	aliasesRead(core([target(lit.bool(true))], [item], undefined), within)

/** A SQL conjunction's terms, nested conjunctions flattened. */
const sqlConjuncts = (e: Expr): ReadonlyArray<Expr> =>
	e.kind === "and" ? e.args.flatMap(sqlConjuncts) : [e]

interface RegionColumn {
	readonly alias: string
	readonly column: string
}

/**
 * One condition term: what it reads of the region, and what a plain equality of a region column states.
 *
 * `alias.column = <value read from no occurrence>`: the column is fixed from outside the region.
 *
 * `a.x = b.y` between two occurrences: each column is determined once the other occurrence is chained.
 */
type Term = { readonly expr: Expr; readonly reads: ReadonlySet<string> } & (
	| { readonly kind: "other" }
	| { readonly kind: "fixes"; readonly fixes: RegionColumn }
	| { readonly kind: "links"; readonly links: readonly [RegionColumn, RegionColumn] }
)

const termOf = (expr: Expr, within: ReadonlySet<string>): Term => {
	const reads = exprReads(expr, within)
	if (expr.kind !== "binary" || expr.op !== "=" || expr.schema !== undefined) {
		return { expr, reads, kind: "other" }
	}
	const sides = [expr.left, expr.right]
	const regionColumn = (e: Expr) =>
		e.kind === "column" && e.table !== undefined && within.has(e.table)
			? { alias: e.table, column: e.column }
			: undefined
	const [l, r] = sides.map(regionColumn)
	if (l !== undefined && r !== undefined) {
		return l.alias === r.alias
			? { expr, reads, kind: "other" }
			: { expr, reads, kind: "links", links: [l, r] }
	}
	if (l !== undefined && exprReads(expr.right, within).size === 0) {
		return { expr, reads, kind: "fixes", fixes: l }
	}
	if (r !== undefined && exprReads(expr.left, within).size === 0) {
		return { expr, reads, kind: "fixes", fixes: r }
	}
	return { expr, reads, kind: "other" }
}

const subset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
	[...a].every((x) => b.has(x))

/**
 * One occurrence still to chain: the region aliases its derived table reads, and its SQL column names back to its
 * source's heading names.
 */
interface Pending {
	readonly placed: PlacedOccurrence
	readonly reads: ReadonlySet<string>
	readonly names: ReadonlyMap<string, string>
}

const pendingOf = (o: PlacedOccurrence, within: ReadonlySet<string>): Pending => {
	const names = new Map<string, string>()
	for (const [name, e] of o.map) {
		if (e.kind === "column" && e.table === o.alias) {
			names.set(e.column, name)
		}
	}
	return { placed: o, reads: itemReads(o.item, within), names }
}

/** A region's occurrences in chain order: the first, then each later one. */
interface Chain {
	readonly start: PlacedOccurrence
	readonly rest: ReadonlyArray<PlacedOccurrence>
}

/**
 * The occurrences in chain order, by the header's evidence. They come in placement order (regionParts), in which every
 * occurrence follows what it reads, so the first one still pending reads only chained occurrences and is always ready.
 */
const chainOrder = (
	first: PlacedOccurrence,
	others: ReadonlyArray<PlacedOccurrence>,
	terms: ReadonlyArray<Term>,
	read: ReadonlyArray<RegionColumn>,
	facts: ShapeFacts,
	within: ReadonlySet<string>,
	once: (node: RelNode) => boolean
): Chain => {
	const fixed = (o: PlacedOccurrence): ReadonlySet<string> =>
		new Set([
			...terms.flatMap((t) =>
				t.kind === "fixes" && t.fixes.alias === o.alias ? [t.fixes.column] : []
			),
			...read.flatMap((c) => (c.alias === o.alias ? [c.column] : []))
		])
	const determined = (o: PlacedOccurrence, chained: ReadonlySet<string>): ReadonlySet<string> => {
		const out = new Set(fixed(o))
		for (const t of terms) {
			if (t.kind !== "links") {
				continue
			}
			const [a, b] = t.links
			if (a.alias === o.alias && chained.has(b.alias)) {
				out.add(a.column)
			}
			if (b.alias === o.alias && chained.has(a.alias)) {
				out.add(b.column)
			}
		}
		return out
	}
	/** 0: at most one row per chained binding; 1: a column fixed from outside; 2: neither. */
	const tier = (p: Pending, chained: ReadonlySet<string>): 0 | 1 | 2 => {
		const columns = [...determined(p.placed, chained)].flatMap((c) => {
			const name = p.names.get(c)
			return name === undefined ? [] : [name]
		})
		if (columns.length > 0 && facts.keyedBy(p.placed.occurrence.source, columns) !== undefined) {
			return 0
		}
		return fixed(p.placed).size > 0 ? 1 : 2
	}
	const joined = (p: Pending, chained: ReadonlySet<string>): boolean =>
		terms.some((t) => t.reads.has(p.placed.alias) && [...t.reads].some((a) => chained.has(a)))
	const chained = new Set<string>()
	/**
	 * The chain's start by rank: an occurrence of at most one row; else one the statement derives once (`once`, a CTE),
	 * which no index reads, so it stands outside every loop and each later occurrence is reached through what it binds;
	 * else by tier.
	 */
	const startRank = (p: Pending): 0 | 1 | 2 | 3 => {
		const t = tier(p, chained)
		return t === 0 ? 0 : once(p.placed.occurrence.source) ? 1 : t === 1 ? 2 : 3
	}
	/** The earliest candidate of the lowest rank: the start's (startRank) while nothing is chained, the tier after. */
	const rank = (p: Pending): number => (chained.size === 0 ? startRank(p) : tier(p, chained))
	const best = (candidate: Pending, more: ReadonlyArray<Pending>): Pending =>
		more.reduce((acc, p) => (rank(p) < rank(acc) ? p : acc), candidate)
	let pending: ReadonlyArray<Pending> = others.map((o) => pendingOf(o, within))
	/**
	 * The next occurrence chained, of the pending `head` and `tail`: the best ready one joined to the chain, else the
	 * best ready one.
	 */
	const take = (head: Pending, tail: ReadonlyArray<Pending>): PlacedOccurrence => {
		const ready = tail.filter((p) => subset(p.reads, chained))
		const [connected, ...more] = [head, ...ready].filter((p) => joined(p, chained))
		const next = connected === undefined ? best(head, ready) : best(connected, more)
		chained.add(next.placed.alias)
		pending = [head, ...tail].filter((p) => p !== next)
		return next.placed
	}
	const start = take(pendingOf(first, within), pending)
	const rest: Array<PlacedOccurrence> = []
	for (let [head, ...tail] = pending; head !== undefined; [head, ...tail] = pending) {
		rest.push(take(head, tail))
	}
	return { start, rest }
}

/** The carriers whose equality is the equality of their B-tree order. */
const orderedCarriers: ReadonlySet<Carrier> = new Set<Carrier>([
	"int2",
	"int4",
	"int8",
	"numeric",
	"float4",
	"float8",
	"money",
	"uuid",
	"text",
	"sha256",
	"code"
])

const orderFns: ReadonlySet<string> = new Set(["lt", "le", "gt", "ge"])

/** The equality, whose conjunct fixes the variable it compares. */
const equalityFns: ReadonlySet<string> = new Set(["eq"])

/**
 * The expression kinds a copied bound may read: the variable's column, and parameters and literals through operators
 * and casts.
 */
const valueKinds: ReadonlySet<string> = new Set([
	"column",
	"param",
	"literal",
	"op",
	"cast",
	"domainCast"
])

/** A conjunct of a region's reader comparing one of its variables, `v`, by the native operator `op`. */
interface ReaderComparison {
	readonly conjunct: ScalarExpr
	readonly op: NativeOp
	readonly v: VarDecl
}

/**
 * The conjuncts of the region's only reader, a filter, each of which compares one variable of the region by `fns` with a
 * value read from no relation, a parameter or a literal through operators and casts, with that variable; none when
 * anything else reads the region.
 */
const readerComparisons = (
	node: NodeOf<"MatchRegion">,
	cx: LowerContext,
	fns: ReadonlySet<string>
): ReadonlyArray<ReaderComparison> => {
	const index = cx.index
	const [filter, ...others] = index.readersOf(node)
	if (filter === undefined || others.length > 0 || index.isRoot(node)) {
		return []
	}
	if (filter.kind !== "Filter") {
		return []
	}
	/** Every expression that reads the region's columns is one of the filter's own. */
	const own = new Set(exprClosure([filter.pred]))
	if (!index.columnReadsOf(node.id).every((e) => own.has(e))) {
		return []
	}
	return conjuncts(filter.pred).flatMap((e) => {
		const fn = e.kind === "op" ? nativeOp(e.op) : undefined
		if (e.kind !== "op" || fn === undefined || !fns.has(fn.fn) || e.args.length !== 2) {
			return []
		}
		const closure = exprClosure([e])
		if (!closure.every((x) => valueKinds.has(x.kind))) {
			return []
		}
		const [ref, ...more] = closure.flatMap((x) => (x.kind === "column" ? [x.column] : []))
		if (ref === undefined || more.length > 0 || ref.node !== node.id) {
			return []
		}
		if (!e.args.some((a) => a.kind === "column")) {
			return []
		}
		const v = node.vars.find((x) => x.name === ref.name)
		return v === undefined ? [] : [{ conjunct: e, op: fn, v }]
	})
}

/** The region columns bound to `v`. */
const columnsOf = (v: VarDecl, parts: ReturnType<typeof regionParts>): ReadonlyArray<Expr> =>
	parts.occurrences.flatMap((o) =>
		o.occurrence.bindings.flatMap((b) => {
			const column = b.var === v ? o.map.get(b.column) : undefined
			return column === undefined ? [] : [column]
		})
	)

/**
 * The region columns its only reader fixes: each column bound to a variable the reader equates with a value read from
 * no relation, which the chain may start at as at a column the region's own conditions fix (chainOrder).
 */
const readerFixed = (
	node: NodeOf<"MatchRegion">,
	cx: LowerContext,
	parts: ReturnType<typeof regionParts>,
	within: ReadonlySet<string>
): ReadonlyArray<RegionColumn> =>
	readerComparisons(node, cx, equalityFns).flatMap(({ v }) =>
		columnsOf(v, parts).flatMap((c) =>
			c.kind === "column" && c.table !== undefined && within.has(c.table)
				? [{ alias: c.table, column: c.column }]
				: []
		)
	)

/**
 * The copies of the bounds the region's only reader places on a variable several columns bind, each on one further
 * column (see the head of this file); none when anything else reads the region.
 *
 * The variable is one side of the comparison, the other side reads no relation.
 */
const impliedBounds = (
	node: NodeOf<"MatchRegion">,
	cx: LowerContext,
	env: Env,
	parts: ReturnType<typeof regionParts>
): ReadonlyArray<Expr> => {
	const out: Array<Expr> = []
	for (const { conjunct: e, op, v } of readerComparisons(node, cx, orderFns)) {
		const carrier = baseOf(v.type).carrier
		if (!orderedCarriers.has(carrier) || operandCarriers(op.operands).some((a) => a !== carrier)) {
			continue
		}
		const value = parts.columns.find((c) => c.column.name === v.name)?.value
		for (const column of columnsOf(v, parts).filter((c) => c !== value)) {
			out.push(lowerExpr(cx, e, extendEnv(env, [[node.id, new Map([[v.name, column]])]])))
		}
	}
	return out
}

/**
 * The folds and unions a region reads per key (cte-policy probesByKey), each a LATERAL derived table of one binding's
 * keys: a fold `LATERAL (SELECT k, count(*) FROM (<input>) WHERE k = r2.c1 GROUP BY k)`, the keys restricted below the
 * aggregate (aggregate/index.ts keyedGroup); a union `LATERAL (SELECT ... FROM (<arm 1>) WHERE k = r2.c1 UNION ...)`,
 * each arm at the keys (union/index.ts keyedUnion). A derived relation's definition always wants every row, and a node
 * the region reads, or one it reads it through, that the statement shares (a CTE: read by two readers, or derived once
 * beside a recursion) is derived once for every reader, so each is read whole.
 */
const keyedProbes =
	(facts: ShapeFacts, shared: (node: RelNode) => boolean): KeyedProbes =>
	(region) =>
		new Map(
			facts.derivedDefinition
				? []
				: [...probesByKey(region)].flatMap(([o, byKey]) => {
						const probed = byKey.probed
						return shared(probed) || byKey.through.some(shared)
							? []
							: [
									[
										o,
										{
											probed,
											keys: byKey.keys,
											lower: (cx: LowerContext, env: Env, restriction: ColumnEqualities) =>
												probed.kind === "Group"
													? keyedGroup(facts, probed, cx, env, restriction)
													: keyedUnion(facts, probed, cx, env, restriction)
										}
									] as const
								]
					})
		)

/**
 * The optimized MatchRegion: one flat FROM list within PostgreSQL's collapse limit, an explicit JOIN chain past it.
 *
 * R01 fuses a rule's matches into one region, so PostgreSQL sees the full relation graph. PostgreSQL plans one FROM
 * list of n relations as one join problem: exhaustively below geqo_threshold (12), by genetic search from it on. A
 * flat list is never split, whatever from_collapse_limit says, because that limit only bounds the merging of a
 * subquery's own FROM list into its parent's. Explicit JOIN syntax is split: PostgreSQL flattens a JOIN tree into its
 * parent's problem only while the problem stays within join_collapse_limit (8), and plans the rest as separate
 * subproblems in the order written. So a region of at most collapseLimit occurrences keeps its flat FROM list under
 * WHERE, the conservative form, and PostgreSQL orders all of it; a larger region is emitted as a left-deep JOIN chain,
 * which PostgreSQL divides into subproblems of at most collapseLimit relations, each planned exhaustively. That is how
 * handwritten SQL of the same join reads (bench/query/planning.bench.ts), and it is PostgreSQL's own mechanism at its
 * default setting: grizzle raises no planner limit and no login's defaults set one,
 * because the only setting that splits a flat list is geqo_threshold, and raising it is the global change R14 rules
 * out.
 *
 * The chain's order decides which relations share a subproblem, so it is chosen from structural evidence, the same
 * for every execution and never from data:
 *
 * - It starts at the occurrence the evidence makes most selective: one whose columns fixed by values from outside the
 *   region (constants, parameters, outer correlations) determine a physical key of its source, so it delivers at most
 *   one row; else one its statement derives once (a CTE, lower/optimize/cte-policy rule 5b), which no index reads;
 *   else one with any fixed column; else the first placed. A column is fixed by a condition of the region, or by its
 *   only reader, a filter, that equates the variable bound to it with a value read from no relation: the parameter a
 *   rule's probe holds its row at reaches PostgreSQL there, and a chain that started elsewhere would plan its first
 *   subproblem, every relation it holds, before the parameter met any of them. An occurrence that reads another
 *   (LATERAL) never starts.
 * - It continues with an occurrence a condition joins to those already chained, preferring one whose fixed columns and
 *   columns equated to chained ones determine a key (no fan-out), then one with a fixed column, then the first placed,
 *   and only when none is joined, one the query itself leaves unconnected. A LATERAL occurrence follows everything it
 *   reads.
 * - A chain that starts at an occurrence derived once reads the rest of the region once per row of it, LATERAL by its
 *   values (keyedByOnce), so the set stands outside every loop and the rest's scans are restricted by its row.
 *
 * Each condition is the ON of the join at which every occurrence it reads is chained; one that reads only the first,
 * or none, stays in WHERE. A join with no condition is a CROSS JOIN, which appears only where the query has one. For
 * inner joins ON and WHERE mean the same, so the chain has the flat list's rows: only the planner's search changes, and
 * the oracle compares it with the conservative flat form.
 *
 * Bounds implied across the region's joins, so an index can serve every source a range reaches. A region's reader
 * may bound a variable that several occurrences bind, `v >= $1` for a variable bound to both `work.key` and
 * `wanted.key`. The variable takes its value from the first column bound to it, so PostgreSQL sees the bound on that
 * column alone: it propagates equalities through a join, never ranges, and the other source is read from the start of
 * its index (a merge join) or in full, taking a relation-level SSI read lock. So when the region's only reader is a
 * filter, each of its conjuncts that compares one such variable with an order operator against a value read from no
 * relation is also written on every other column bound to that variable. An equality of an ordered carrier is its
 * B-tree order's equality, so each copy holds exactly where the reader's conjunct holds, and the copy is a comparison
 * of the same type, total like the conjunct it copies: the region keeps every binding its reader keeps, and nothing
 * else reads it.
 */
export const regionLowerer =
	(
		facts: ShapeFacts,
		once: (node: RelNode) => boolean,
		shared: (node: RelNode) => boolean
	): NodeLowerer<"MatchRegion"> =>
	(node, cx, env) => {
		const lowered = regionParts(node, cx, env, keyedProbes(facts, shared))
		const parts = {
			...lowered,
			conditions: [...lowered.conditions, ...impliedBounds(node, cx, env, lowered)]
		}
		const [first, ...others] = parts.occurrences
		if (
			first === undefined ||
			parts.occurrences.length <= collapseLimit ||
			parts.from.length > parts.occurrences.length
		) {
			return select(cx.setOf(node, parts.targets, parts.from, conjunction(parts.conditions)))
		}
		const within = new Set(parts.occurrences.map((o) => o.alias))
		const terms = parts.conditions.flatMap(sqlConjuncts).map((e) => termOf(e, within))
		const { start, rest } = chainOrder(
			first,
			others,
			terms,
			readerFixed(node, cx, lowered, within),
			facts,
			within,
			once
		)
		/**
		 * Each term stands at the step of the chain that brings in the last occurrence it reads: in WHERE when that is
		 * the first, in the ON of that step's join otherwise.
		 */
		const steps = [start, ...rest]
		const placed = terms.map((t) => ({
			expr: t.expr,
			step: steps.reduce((at, o, i) => (t.reads.has(o.alias) ? i : at), 0)
		}))
		const at = (step: number): ReadonlyArray<Expr> =>
			placed.flatMap((t) => (t.step === step ? [t.expr] : []))
		/** The chain of `head` then `tail`, steps `from` on of `steps`, each step's terms in the ON of its join. */
		const chainOf = (
			head: PlacedOccurrence,
			tail: ReadonlyArray<PlacedOccurrence>,
			from: number
		): FromItem =>
			isNonEmpty(tail)
				? {
						kind: "joins",
						first: head.item,
						steps: mapNonEmpty(tail, (o, i): JoinStep => {
							const on = at(from + i + 1)
							return isNonEmpty(on)
								? { kind: "on", source: o.item, on: and(on) }
								: { kind: "cross", source: o.item }
						})
					}
				: head.item
		const [next, ...after] = rest
		if (next === undefined || !once(start.occurrence.source)) {
			return select(cx.setOf(node, parts.targets, [chainOf(start, rest, 0)], conjunction(at(0))))
		}
		return keyedByOnce(
			cx,
			node,
			parts.targets,
			start,
			chainOf(next, after, 1),
			at(1),
			at(0),
			within
		)
	}

/**
 * A chain that starts at an occurrence its statement derives once (`start`, a CTE), read as that set and, for each of
 * its rows, the rest of the region, a LATERAL derived table reading the row's values where the rest's terms read
 * `start`'s columns:
 *
 *   SELECT DISTINCT <targets> FROM <start>, LATERAL (SELECT DISTINCT <the rest's columns the targets read>
 *     FROM <the rest's chain> WHERE <its first step's terms>) AS l(...) WHERE <the terms of `start` alone>
 *
 * The rest, DISTINCT, is no subquery PostgreSQL pulls up, so it runs once for each row of `start` with that row's values
 * fixed, its scans restricted by them: `start` stands outside the loop, read once, whatever PostgreSQL estimates. A
 * join of the two would let PostgreSQL put the rest's join inside a nested loop over `start`'s rows, unrestricted,
 * derived again for each (a set read whole is estimated as cheap as one that is restricted when both are estimated at
 * one row), or `start`'s rows inside one over the rest's, each scanned whole. The region's rows are the same: an
 * inner join's terms mean the same in ON and in WHERE, and DISTINCT keeps the bindings a set.
 */
const keyedByOnce = (
	cx: LowerContext,
	node: NodeOf<"MatchRegion">,
	targets: NonEmptyReadonlyArray<Target>,
	start: PlacedOccurrence,
	rest: FromItem,
	restWhere: ReadonlyArray<Expr>,
	startWhere: ReadonlyArray<Expr>,
	within: ReadonlySet<string>
): Select => {
	const restAliases = new Set([...within].filter((a) => a !== start.alias))
	/** The rest's columns the targets read, each once, in the order they are first read. */
	const read = new Map<string, { readonly alias: string; readonly column: string }>()
	for (const t of targets) {
		visitSelect(operandSelect(core([t], [], undefined)), {
			...inertVisitor,
			expr: (e) => {
				if (e.kind === "column" && e.table !== undefined && restAliases.has(e.table)) {
					read.set(`${e.table}.${e.column}`, { alias: e.table, column: e.column })
				}
			}
		})
	}
	const origin = { kind: "node", node: node.id } as const
	const alias = cx.relationAlias(origin)
	const columns = [...read.values()].map((c) => ({ ...c, as: cx.supply.column(origin) }))
	const carried: NonEmptyReadonlyArray<Target> = isNonEmpty(columns)
		? mapNonEmpty(columns, (c) => target(col(c.alias, c.column)))
		: [target(lit.bool(true))]
	const body = distinctSelect(carried, [rest], restWhere)
	const item = derived(
		body,
		alias,
		isNonEmpty(columns) ? columns.map((c) => c.as) : [cx.supply.column(origin)],
		true
	)
	const outside = new Map(columns.map((c) => [`${c.alias}.${c.column}`, col(alias, c.as)]))
	const outer = mapNonEmpty(targets, (t) => ({
		...t,
		expr: transformExpr(t.expr, {
			...identityHooks,
			expr: (e) =>
				e.kind === "column" && e.table !== undefined
					? (outside.get(`${e.table}.${e.column}`) ?? e)
					: e
		})
	}))
	return distinctSelect(outer, [start.item, item], startWhere)
}
