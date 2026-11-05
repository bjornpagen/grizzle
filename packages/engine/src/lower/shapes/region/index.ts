import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import { exprsOf, inputsOf, type NodeOf } from "#compiler/ir/rel.ts"
import { baseOf, type Carrier } from "#compiler/ir/scalar.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import {
	distinctSelect,
	type Env,
	extendEnv,
	type LowerContext,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import {
	type PlacedOccurrence,
	regionParts
} from "#compiler/lower/conservative/match-region/index.ts"
import { collapseLimit } from "#compiler/lower/optimize/existence/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { nativeOp, operandCarriers } from "#compiler/scalar/compute/registry.ts"
import type { Expr, FromItem, JoinStep, SelectBody } from "#compiler/sql/ast.ts"
import { and, core, lit, select, target } from "#compiler/sql/build.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"

/** The relation aliases a query fragment reads through column references, at any depth. */
const aliasesRead = (body: SelectBody, within: ReadonlySet<string>): ReadonlySet<string> => {
	const out = new Set<string>()
	visitSelect(select(body), {
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
	facts: ShapeFacts,
	within: ReadonlySet<string>
): Chain => {
	const fixed = (o: PlacedOccurrence): ReadonlySet<string> =>
		new Set(
			terms.flatMap((t) =>
				t.kind === "fixes" && t.fixes.alias === o.alias ? [t.fixes.column] : []
			)
		)
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
		if (columns.length > 0 && facts.keyedBy(p.placed.occurrence.source, columns)) {
			return 0
		}
		return fixed(p.placed).size > 0 ? 1 : 2
	}
	const joined = (p: Pending, chained: ReadonlySet<string>): boolean =>
		terms.some((t) => t.reads.has(p.placed.alias) && [...t.reads].some((a) => chained.has(a)))
	/** The earliest candidate of the lowest tier. */
	const best = (
		candidate: Pending,
		more: ReadonlyArray<Pending>,
		chained: ReadonlySet<string>
	): Pending =>
		more.reduce((acc, p) => (tier(p, chained) < tier(acc, chained) ? p : acc), candidate)
	const chained = new Set<string>()
	let pending: ReadonlyArray<Pending> = others.map((o) => pendingOf(o, within))
	/**
	 * The next occurrence chained, of the pending `head` and `tail`: the best ready one joined to the chain, else the
	 * best ready one.
	 */
	const take = (head: Pending, tail: ReadonlyArray<Pending>): PlacedOccurrence => {
		const ready = tail.filter((p) => subset(p.reads, chained))
		const [connected, ...more] = [head, ...ready].filter((p) => joined(p, chained))
		const next =
			connected === undefined ? best(head, ready, chained) : best(connected, more, chained)
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
	"code"
])

const orderFns: ReadonlySet<string> = new Set(["lt", "le", "gt", "ge"])

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
	const nodes = topoOrder(cx.dag)
	const [filter, ...others] = nodes.filter((n) => inputsOf(n).includes(node))
	if (filter === undefined || others.length > 0 || cx.dag.roots.includes(node)) {
		return []
	}
	if (filter.kind !== "Filter") {
		return []
	}
	/** Every expression that reads the region's columns is one of the filter's own. */
	const own = new Set(exprClosure([filter.pred]))
	const readsRegion = (e: ScalarExpr): boolean => e.kind === "column" && e.column.node === node.id
	if (!exprClosure(nodes.flatMap((n) => exprsOf(n))).every((e) => !readsRegion(e) || own.has(e))) {
		return []
	}
	const out: Array<Expr> = []
	for (const e of conjuncts(filter.pred)) {
		const fn = e.kind === "op" ? nativeOp(e.op) : undefined
		if (e.kind !== "op" || fn === undefined || !orderFns.has(fn.fn) || e.args.length !== 2) {
			continue
		}
		const closure = exprClosure([e])
		if (!closure.every((x) => valueKinds.has(x.kind))) {
			continue
		}
		const [ref, ...more] = closure.flatMap((x) => (x.kind === "column" ? [x.column] : []))
		if (ref === undefined || more.length > 0 || ref.node !== node.id) {
			continue
		}
		if (!e.args.some((a) => a.kind === "column")) {
			continue
		}
		const v = node.vars.find((x) => x.name === ref.name)
		if (v === undefined) {
			continue
		}
		const carrier = baseOf(v.type).carrier
		if (!orderedCarriers.has(carrier) || operandCarriers(fn.operands).some((a) => a !== carrier)) {
			continue
		}
		const value = parts.columns.find((c) => c.column.name === v.name)?.value
		const columns = parts.occurrences.flatMap((o) =>
			o.occurrence.bindings.flatMap((b) => {
				const column = b.var === v ? o.map.get(b.column) : undefined
				return column === undefined || value === column ? [] : [column]
			})
		)
		for (const column of columns) {
			out.push(lowerExpr(cx, e, extendEnv(env, [[node.id, new Map([[v.name, column]])]])))
		}
	}
	return out
}

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
 *   one row; else one with any fixed column; else the first placed. An occurrence that reads another (LATERAL) never
 *   starts.
 * - It continues with an occurrence a condition joins to those already chained, preferring one whose fixed columns and
 *   columns equated to chained ones determine a key (no fan-out), then one with a fixed column, then the first placed,
 *   and only when none is joined, one the query itself leaves unconnected. A LATERAL occurrence follows everything it
 *   reads.
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
	(facts: ShapeFacts): NodeLowerer<"MatchRegion"> =>
	(node, cx, env) => {
		const lowered = regionParts(node, cx, env)
		const parts = {
			...lowered,
			conditions: [...lowered.conditions, ...impliedBounds(node, cx, env, lowered)]
		}
		const [first, ...others] = parts.occurrences
		if (first === undefined || parts.occurrences.length <= collapseLimit.value) {
			return distinctSelect(
				parts.targets,
				parts.occurrences.map((o) => o.item),
				parts.conditions
			)
		}
		const within = new Set(parts.occurrences.map((o) => o.alias))
		const terms = parts.conditions.flatMap(sqlConjuncts).map((e) => termOf(e, within))
		const { start, rest } = chainOrder(first, others, terms, facts, within)
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
		const chain: FromItem = isNonEmpty(rest)
			? {
					kind: "joins",
					first: start.item,
					steps: mapNonEmpty(rest, (o, i): JoinStep => {
						const on = at(i + 1)
						return isNonEmpty(on)
							? { kind: "on", source: o.item, on: and(on) }
							: { kind: "cross", source: o.item }
					})
				}
			: start.item
		return distinctSelect(parts.targets, [chain], at(0))
	}
