import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { outerOf } from "#compiler/analysis/physical/rules.ts"
import type { VarId } from "#compiler/core/ids.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import {
	type NodeOf,
	type Occurrence,
	type RelNode,
	regionVarClasses,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, type Carrier } from "#compiler/ir/scalar.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import {
	type ColumnEqualities,
	columnIn,
	type CteTable,
	type InputSource,
	type Env,
	equalitiesOver,
	extendEnv,
	freshCtes,
	heldEnv,
	holdsInside,
	type LowerContext,
	type NodeLowerer,
	noRestriction,
	outputNames,
	restrictedEnv,
	withLeading
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import {
	noRowSites,
	type PlacedOccurrence,
	regionParts,
	type RowSite,
	type RowSites
} from "#compiler/lower/conservative/match-region/index.ts"
import { fencedRead, headingRead } from "#compiler/lower/conservative/step/index.ts"
import {
	type ChainStep,
	type CorrelatedSite,
	correlatedSites,
	heldSet,
	chainPrefix
} from "#compiler/lower/optimize/cte-policy/index.ts"
import { pushedInto } from "#compiler/lower/shapes/share/keyed.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import {
	type ChainSite,
	chainBound,
	chainSites,
	regionChain,
	sitesAtRows
} from "#compiler/lower/shapes/share/sites.ts"
import { type NativeOp, nativeOp, operandCarriers } from "#compiler/scalar/compute/registry.ts"
import {
	type Expr,
	type FromItem,
	type OperandBody,
	type Select,
	selectColumns
} from "#compiler/sql/ast.ts"
import {
	col,
	conjunction,
	core,
	cteRefAs,
	derived,
	distinctCore,
	keyedRead,
	lit,
	operandSelect,
	select,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { namedQuery } from "#compiler/sql/naming.ts"
import {
	identityHooks,
	inertVisitor,
	transformExpr,
	transformQuery,
	visitSelect
} from "#compiler/sql/transform.ts"

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
 * Each choice reads the region's terms stated in the order so far (`termsIn`, RegionParts conditionsIn), the chained
 * occurrences then the pending ones, so a pending occurrence is joined to the chain at every variable a chained one
 * binds, where the terms stated once in placement order joined it only to its variables' first binders in placement.
 */
const chainOrder = (
	first: PlacedOccurrence,
	others: ReadonlyArray<PlacedOccurrence>,
	termsIn: (aliases: ReadonlyArray<string>) => ReadonlyArray<Term>,
	read: ReadonlyArray<RegionColumn>,
	facts: ShapeFacts,
	within: ReadonlySet<string>,
	once: (node: RelNode) => boolean
): Chain => {
	let terms = termsIn([first, ...others].map((o) => o.alias))
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
	const order: Array<string> = []
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
		order.push(next.placed.alias)
		pending = [head, ...tail].filter((p) => p !== next)
		terms = termsIn([...order, ...pending.map((p) => p.placed.alias)])
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
 * The optimized MatchRegion: one flat FROM list in its join order, its conditions in WHERE.
 *
 * R01 fuses a rule's matches into one region. The order of its FROM is the order its statement is planned in: the
 * binding pass carries it as written (sql/bind.ts), each occurrence a later one is bound by read as a probe of it, and
 * nests the level so no join problem PostgreSQL plans holds more than join_collapse_limit's eight items. So the order
 * is the region's to choose, from structural evidence, the same for every execution and never from data
 * (`chainOrder`):
 *
 * - It starts at the occurrence the evidence makes most selective: one whose columns fixed by values from outside the
 *   region (constants, parameters, outer correlations) determine a physical key of its source, so it delivers at most
 *   one row; else one its statement derives once (a CTE, lower/optimize/cte-policy), which no index reads;
 *   else one with any fixed column; else the first placed. A column is fixed by a condition of the region, or by its
 *   only reader, a filter, that equates the variable bound to it with a value read from no relation: the parameter a
 *   rule's probe holds its row at reaches PostgreSQL there, and a chain that started elsewhere would plan its first
 *   subproblem, every relation it holds, before the parameter met any of them. An occurrence that reads another
 *   (LATERAL) never starts.
 * - It continues with an occurrence a condition joins to those already chained, preferring one whose fixed columns and
 *   columns equated to chained ones determine a key (no fan-out), then one with a fixed column, then the first placed,
 *   and only when none is joined, one the query itself leaves unconnected. A LATERAL occurrence follows everything it
 *   reads.
 * - A region a value fixed where it is evaluated binds, or that reads a held set (cte-policy heldSet), is read along
 *   its chain instead (heldChain, chainedSelect), each stored relation it binds on a declared-key prefix fenced at the
 *   values of the steps before it; this order is the rest's.
 *
 * Its conditions are stated in that order (RegionParts conditionsIn), so each occurrence is equated with the ones
 * before it at every variable a chained one binds. The order changes no row: the oracle compares it with the
 * conservative form, its FROM in placement order.
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
	(facts: ShapeFacts, once: (node: RelNode) => boolean): NodeLowerer<"MatchRegion"> =>
	(node, cx, env) => {
		const sites = correlatedSites(node)
		const holding = freshCtes<RelNode>()
		return withLeading(regionSelect(facts, once, node, cx, env, sites, holding), holding.ctes)
	}

/**
 * A region's SELECT (regionLowerer), its correlated sites read at their rows' values (`atSites`), each node they reach at
 * several reads held once in `holding`, which the region's query leads its WITH with.
 */
const regionSelect = (
	facts: ShapeFacts,
	once: (node: RelNode) => boolean,
	node: NodeOf<"MatchRegion">,
	cx: LowerContext,
	env: Env,
	sites: ReadonlyArray<CorrelatedSite>,
	holding: CteTable<RelNode>
): Select => {
	/** The restriction the region holds (context.ts restrictsInside), read where `restrictedParts` places it. */
	const restriction = env.restricted.get(node) ?? noRestriction
	const restricted = restriction.map((e) => e.column)
	/**
	 * The region's chain (share/sites.ts regionChain, the one decision its key analysis and its access read too) and its
	 * row sites (share/sites.ts chainSites), each read at its row's values (heldChain).
	 */
	const chain = regionChain(node, restricted, sites)
	const rowSites = chain === undefined ? [] : chainSites(node, chain, restricted)
	const plan =
		chain === undefined
			? undefined
			: heldChain(cx, env, node, chain, chainBound(node, restricted, sites), rowSites)
	const keySets = plan === undefined ? noKeySets : chainKeySets(cx, node, plan, restriction)
	const lowered = regionParts(
		node,
		cx,
		atSites(cx, env, sites, holding),
		plan === undefined
			? noRowSites
			: new Map([
					...siteReads(cx, plan, rowSites, restriction),
					...[...keySets].map(([o, k]) => [o, k.site] as const)
				])
	)
	/**
	 * The region at the restriction it holds and the bounds its reader implies (`restrictedParts`); the chain reads its
	 * occurrences alone, where no call's evaluation stands among them (regionParts).
	 */
	const parts = restrictedParts(cx, node, env, lowered)
	if (plan !== undefined && parts.from.length === parts.occurrences.length) {
		return chainedSelect(cx, node, parts, plan, keySets, holding, (from, where, rename) =>
			select(
				cx.setOf(
					node,
					mapNonEmpty(parts.targets, (t) => ({ ...t, expr: rename(t.expr) })),
					from,
					where
				)
			)
		)
	}
	const [first, ...others] = parts.occurrences
	if (first === undefined || !isNonEmpty(others) || parts.from.length > parts.occurrences.length) {
		return select(cx.setOf(node, parts.targets, parts.from, conjunction(parts.conditions)))
	}
	const within = new Set(parts.occurrences.map((o) => o.alias))
	const termsIn = (aliases: ReadonlyArray<string>): ReadonlyArray<Term> =>
		parts
			.conditionsIn(aliases)
			.flatMap(sqlConjuncts)
			.map((e) => termOf(e, within))
	const { start, rest } = chainOrder(
		first,
		others,
		termsIn,
		readerFixed(node, cx, lowered, within),
		facts,
		within,
		once
	)
	const steps = [start, ...rest]
	return select(
		cx.setOf(
			node,
			parts.targets,
			steps.map((o) => o.item),
			conjunction(termsIn(steps.map((o) => o.alias)).map((t) => t.expr))
		)
	)
}

/**
 * `env` with each correlated site of a region (cte-policy correlatedSites) read at the values its correlation fixes for
 * the outer row the region is evaluated for: the site holds them where its lowering places a restriction inside it
 * (context.ts restrictsInside, a fold's below its aggregate, a union's in each arm), and every node under it the
 * restriction reaches (share/keyed.ts pushedInto) is lowered there at them, never as the statement's CTE, and each node
 * the walk holds is held once in the region's query (`held`, context.ts heldEnv). A source read at several occurrences
 * of a region is held once by the row site whose walk reaches it (share/keys.ts rowReading), as a judge's whole rule
 * over two reads of a union reads each of its rules once.
 */
const atSites = (
	cx: LowerContext,
	env: Env,
	sites: ReadonlyArray<CorrelatedSite>,
	held: CteTable<RelNode>
): Env => {
	const placed = sites.map((site) => {
		const equalities = site.restriction.map((r) => ({
			column: r.column,
			value: lowerExpr(cx, r.expr, env)
		}))
		return {
			site,
			equalities,
			walked: pushedInto(site.source, equalities, "held", held)
		}
	})
	return heldEnv(
		restrictedEnv(
			env,
			new Map(
				placed.flatMap(({ site, equalities, walked }) => [
					[site.source, holdsInside(site.source, equalities) ? equalities : noRestriction] as const,
					...walked.restricted
				])
			)
		),
		new Map(placed.flatMap((p) => [...p.walked.held]))
	)
}

/**
 * How a step of a region's chain is read (`heldChain`): `lead`, the chain's first occurrence, where it stands; `fenced`,
 * a LATERAL derived table read at the values the steps before it bind, `LATERAL (SELECT ... FROM <it> WHERE <its terms>
 * OFFSET 0)`, a fence PostgreSQL neither pulls up nor reorders, so each of its scans is a seek at those values whatever
 * PostgreSQL estimates; `free`, where it stands, joined by its terms to what the region reads before it; `keyset`, a
 * source computed apart read at the key set of the rows before it (`chainKeySets`): the DISTINCT of the columns they
 * bind it at, a MATERIALIZED CTE of the region's query over the rows before it, themselves its CTE, the source derived
 * LATERAL once per key and joined to those rows free, its key (StepKey) stated with it.
 */
type StepRead =
	| { readonly read: "lead" | "fenced" | "free" }
	| { readonly read: "keyset"; readonly key: StepKey }

/**
 * A region's chain as it is printed (`chainedSelect`): its steps in chain order (cte-policy chainSteps), every
 * occurrence of the region one, each with how it is read.
 */
interface HeldChain {
	readonly steps: ReadonlyArray<ChainStep & StepRead>
}

/**
 * A column of a `keyset` step's source its key set binds (StepKey): `bound`, read at the column of the first occurrence
 * before it that binds the same variable class, and that class.
 */
interface KeyBinding {
	readonly bound: string
	readonly occurrence: Occurrence
	readonly column: string
	readonly class: VarId
}

/**
 * The key a `keyset` step's source is derived at, once for each key (chainKeySets): the columns of its source the key
 * set binds, and the scope it is read in at one key, `at` the key's columns, one for each binding (`keyScope`).
 */
interface StepKey {
	readonly bindings: ReadonlyArray<KeyBinding>
	readonly scope: (scope: Env, at: ReadonlyArray<Expr>) => Env
}

/**
 * The bindings of `o`'s source a key set over `keys` binds (StepKey): each binding at one of `keys` whose variable class
 * an occurrence of `before` binds, at that occurrence's column, the first of them.
 */
const keyBindings = (
	region: NodeOf<"MatchRegion">,
	o: Occurrence,
	keys: ReadonlyArray<string>,
	before: ReadonlyArray<Occurrence>
): ReadonlyArray<KeyBinding> => {
	const classOf = regionVarClasses(region)
	return o.bindings.flatMap((b) => {
		if (!keys.includes(b.column)) {
			return []
		}
		const from = before.find((p) => p.bindings.some((q) => classOf(q.var) === classOf(b.var)))
		const at = from?.bindings.find((q) => classOf(q.var) === classOf(b.var))
		return from === undefined || at === undefined
			? []
			: [{ bound: b.column, occurrence: from, column: at.column, class: classOf(b.var) }]
	})
}

/**
 * The scope `o`'s source is read in at one key of `bindings` (StepKey): the region's scope with every row of the
 * region in it, its variables and each other occurrence's source, held at the key's columns alone, each column whose
 * variable class the key holds at that class's key column and none other, so the source's correlation reads the key
 * and the key set's LATERAL derivation reads no row before it, by construction; undefined where the source reads a row
 * of the region (outerOf) at a column of no class the key holds, whose rows are then each row's own, never one key's.
 * Lowered in the region's scope, a take per parent correlated to the closed relation the chain led with, bound at the
 * column its correlation reads, read the lead's row from inside the key set's derived table, which stands beside the
 * lead, an unbound name the printer refused (key-sets, rotating 0x9368d051); placed LATERAL instead, it would derive the
 * key set again for every row before it.
 */
const keyScope = (
	region: NodeOf<"MatchRegion">,
	o: Occurrence,
	bindings: ReadonlyArray<KeyBinding>
): StepKey["scope"] | undefined => {
	const classOf = regionVarClasses(region)
	/** The key column of a variable's class, none where the key holds no column of it. */
	const keyOf = (v: VarDecl): ReadonlyArray<number> => {
		const j = bindings.findIndex((k) => k.class === classOf(v))
		return j < 0 ? [] : [j]
	}
	/** Each row of the region by its node, each column of it the key holds at that key column. */
	const rows = [
		[region.id, region.vars.flatMap((v) => keyOf(v).map((j) => [v.name, j] as const))] as const,
		...region.occurrences
			.filter((q) => q !== o && region.occurrences.every((r) => r === q || r.source !== q.source))
			.map(
				(q) =>
					[
						q.source.id,
						q.bindings.flatMap((b) => keyOf(b.var).map((j) => [b.column, j] as const))
					] as const
			)
	]
	const local = new Set([region.id, ...region.occurrences.map((q) => q.source.id)])
	const unheld = outerOf(o.source).some(
		(c) =>
			local.has(c.node) &&
			!rows.some(
				([node, columns]) => node === c.node && columns.some(([name]) => name === c.column)
			)
	)
	return unheld
		? undefined
		: (scope, at) =>
				extendEnv(
					scope,
					rows.map(
						([node, columns]) =>
							[
								node,
								new Map(
									columns.map(([name, j]) => [
										name,
										defined(at[j], "a key column for each binding")
									])
								)
							] as const
					)
				)
}

/**
 * Whether a source is a derivation PostgreSQL computes apart from its reader, which a fence read per row would derive
 * again for each row: a union, a fold, a take, a window, an ordered or nearest result, a recursion, a difference, an
 * intersection, a production, a call of anything but values, an attachment or a guard, or a projection, a filter, a
 * step, a region or an existence test's left side over one. Such a source is read at its key set, each key once
 * (share/keys.ts KeyAnalysis: in place at its keys, or its statement CTE), and joins the chain free, never fenced: the
 * one way a node is read at a held set's keys. Pages: a key set derives each distinct key once, where a fence derives it
 * once for each row before it, as often again as rows share a key; planning: the node stands once in its statement,
 * where read per row it stands at each site that reads it. Every other source (a stored relation, and a projection, a
 * filter, a step, a region or an existence test of stored relations alone) is so many seeks per row, fenced at the
 * values the steps before it bind.
 */
const computedApart = (node: RelNode): boolean => {
	switch (node.kind) {
		case "Base":
		case "InputSet":
		case "Delta":
		case "Context":
		case "Closed":
			return false
		case "ProjectSet":
		case "Filter":
		case "Step":
			return computedApart(node.input)
		case "SemiJoin":
		case "AntiJoin":
			return computedApart(node.left)
		case "MatchRegion":
			return node.occurrences.some((o) => computedApart(o.source))
		case "Call":
			return !node.args.every((a) => a.kind === "value")
		case "Union":
		case "Group":
		case "Take":
		case "Window":
		case "OrderedResult":
		case "OrderedSetAggregate":
		case "ApproximateNearest":
		case "Recursive":
		case "SelfRef":
		case "Difference":
		case "Intersect":
		case "Produce":
		case "Attach":
		case "Forbid":
			return true
	}
}

/**
 * How a region's chain reads each step (HeldChain): the first where it stands; a held set (cte-policy heldSet), whose
 * rows no index reads, a source its statement computes once at its key set (LowerContext computedAt, its key set's columns: a share it
 * holds at keys, or a union or a fold in place at its key set), and a source computed apart its statement computes once
 * whole, each where no restriction walked into it reads it at values instead, read free, never inside a fence, where
 * read per row it would be scanned or derived again for each; a share of every row that is no computation apart (a join,
 * a projection, a filter of stored relations) read per row at the values the steps before it bind, so its whole is
 * derived for no reader that binds it; a source computed apart (`computedApart`) free where the restriction the
 * region's reader walks into it (`env`'s) already holds every column the steps before it bind of it, its key set the
 * walk's; else at the key set of the rows before it (`keyset`), each distinct key derived once, or, where those columns
 * hold one key for each evaluation of the region (fixed once for it, or bound by a step of rank `key`, one row), in place
 * at that one key, fenced; every other step fenced at the values the steps before it bind. qti-pie's
 * ItemSessionControl, read per session under metis's sitting, reads the attempts in force at the place of the member its
 * session's item is, a union and a fold the restriction reaching the session carries at the package alone: at the key
 * set of the members its chain reads, never every member of the test. A row site of the chain (`sites`, share/sites.ts
 * chainSites, the one decision the key analysis reads too) of a region a restriction walked into, or of one evaluated
 * per outer row (cte-policy evaluatedPerRow), is read at its rows' values, fenced or at its key set, never from a set
 * its statement computes once: the key analysis computes that set at its other reads' keys alone (share/keys.ts
 * rowReading), so read there the site would find none of its own rows, and joined at each evaluation it is scanned whole. A region an occurrence of which the chain binds on
 * no declared-key prefix has none: it is printed as its parts place it (match-region regionParts), its join
 * PostgreSQL's, where the chain's steps fenced beside that occurrence read no fewer rows at any size held-drives reaches
 * (a call of sixty-four sittings, the feedback beside the share sought per row either way).
 */
const heldChain = (
	cx: LowerContext,
	env: Env,
	region: NodeOf<"MatchRegion">,
	steps: ReadonlyArray<ChainStep>,
	fixed: ReadonlyArray<string>,
	sites: ReadonlyArray<ChainSite>
): HeldChain | undefined => {
	const [lead, ...rest] = steps
	if (lead === undefined || steps.length < region.occurrences.length) {
		return undefined
	}
	/**
	 * Whether a step is a row site (share/sites.ts chainSites) of a region a restriction walked into (`env`'s) or of one
	 * evaluated per outer row (cte-policy evaluatedPerRow), the reads the key analysis leaves out of a source's key set
	 * (share/keys.ts rowReading), each read at its rows' values, never from a set the statement computes once at its
	 * other reads' keys alone; a site of a region evaluated once that nothing walked into is one of the reads that key
	 * set serves, read there. Read free in a region evaluated per outer row, the set is joined again at each evaluation,
	 * a scan of every key's rows, no index reading it: probe-share's bulk population, each of 1,449 Budget rows written at
	 * once scanning the scopes of all 1,449 documents their seats deliver, 2,099,601 index searches.
	 */
	const atRows = sitesAtRows(region, env.restricted.has(region))
		? new Set(sites.map((site) => site.occurrence))
		: new Set<Occurrence>()
	const walkedSite = (s: ChainStep): boolean => atRows.has(s.occurrence)
	const classOf = regionVarClasses(region)
	/** The classes fixed once for each evaluation of the region: its restriction's, its sites', the values it holds. */
	const once = new Set(
		fixed.flatMap((c) => region.vars.filter((v) => v.name === c).map((v) => classOf(v)))
	)
	/** The columns of a step's source the steps before it bind (its seek's, but for a code's or a literal's). */
	const bound = (step: ChainStep): ReadonlyArray<string> =>
		step.occurrence.bindings.flatMap((b) => (step.at.includes(b.column) ? [b.column] : []))
	/**
	 * Whether a step's bound columns hold one key for each evaluation of the region: each is a class fixed once for the
	 * evaluation, or one a step of rank `key` before it binds, which reads one row.
	 */
	const oneKey = (step: ChainStep, before: ReadonlyArray<ChainStep>): boolean =>
		step.occurrence.bindings.every(
			(b) =>
				!step.at.includes(b.column) ||
				once.has(classOf(b.var)) ||
				before.some(
					(p) =>
						p.bound.rank === "key" &&
						p.occurrence.bindings.some((q) => classOf(q.var) === classOf(b.var))
				)
		)
	/** Whether the restriction walked into a step's source holds every column the steps before it bind of it. */
	const walked = (step: ChainStep): boolean => {
		const held = env.restricted.get(step.occurrence.source) ?? []
		return bound(step).every((c) => held.some((e) => e.column === c))
	}
	/**
	 * A step read at the key set of the rows before it over `keys` (its bound columns, or the prefix a stored step is
	 * read at once a value, cte-policy chainPrefix), each key derived once: where its source reads the rows before it at
	 * the key alone (`keyScope`); else fenced, read per row at the values the steps before it bind, a source whose
	 * correlation reads a row of the region at a column the key holds no class of being that row's own rows, never one
	 * key's.
	 */
	const atKeySet = (
		s: ChainStep,
		before: ReadonlyArray<ChainStep>,
		keys: ReadonlyArray<string>
	): StepRead => {
		const bindings = keyBindings(
			region,
			s.occurrence,
			keys,
			before.map((p) => p.occurrence)
		)
		const scope = keyScope(region, s.occurrence, bindings)
		return scope === undefined ? { read: "fenced" } : { read: "keyset", key: { bindings, scope } }
	}
	const readOf = (s: ChainStep, before: ReadonlyArray<ChainStep>): StepRead => {
		const source = s.occurrence.source
		if (heldSet(source)) {
			return { read: "free" }
		}
		const apart = computedApart(source)
		const prefix = prefixOf(s, before)
		const keys = prefix ?? bound(s)
		if (env.restricted.has(source)) {
			return !apart
				? { read: "fenced" }
				: walked(s)
					? { read: "free" }
					: oneKey(s, before)
						? { read: "fenced" }
						: atKeySet(s, before, keys)
		}
		const computed = walkedSite(s) ? undefined : cx.computedAt(source)
		if (computed !== undefined && (computed.length > 0 || apart)) {
			return { read: "free" }
		}
		return !apart
			? prefix === undefined
				? { read: "fenced" }
				: atKeySet(s, before, keys)
			: oneKey(s, before)
				? { read: "fenced" }
				: atKeySet(s, before, keys)
	}
	/** The prefix a stored step is read at once a value (cte-policy chainPrefix), its key set's columns. */
	const prefixOf = (
		s: ChainStep,
		before: ReadonlyArray<ChainStep>
	): ReadonlyArray<string> | undefined => chainPrefix(region, before, s, (n) => cx.computedAt(n))
	return {
		steps: [
			{ ...lead, read: "lead" },
			...rest.map((s, i) => ({ ...s, ...readOf(s, steps.slice(0, i + 1)) }))
		]
	}
}

/**
 * The key set a `keyset` step is read at (chainKeySets): its CTE's name and columns, the occurrence of the rows before
 * it and the column of its source each key column reads, the step's source column each key column binds, the columns
 * the region's restriction holds it at, and its row site, the source derived LATERAL once per key of the CTE.
 */
interface KeySet {
	readonly name: string
	readonly columns: ReadonlyArray<string>
	readonly from: ReadonlyArray<{
		readonly occurrence: NodeOf<"MatchRegion">["occurrences"][number]
		readonly column: string
	}>
	readonly site: RowSite
}

const noKeySets: ReadonlyMap<NodeOf<"MatchRegion">["occurrences"][number], KeySet> = new Map()

/**
 * Each `keyset` step's key set (HeldChain): the columns of its source the steps before it bind, each at the column of
 * the first step before it that binds the same variable class, named a MATERIALIZED CTE of the region's query (its body
 * the DISTINCT of those columns over the rows before it, chainedSelect), and its row site, `SELECT DISTINCT s.* FROM
 * <the key set> AS k, LATERAL (<the source at k's columns and the restriction's values>) AS s`, the source lowered at
 * each key's values (`restrictedAt`), a union's arms and a fold's groups each at the key, derived once for each key, in
 * the scope of its key (StepKey `scope`): every row of the region its correlation reads is read at k, so the site reads
 * no row before it and stands beside them, never LATERAL to them.
 */
const chainKeySets = (
	cx: LowerContext,
	region: NodeOf<"MatchRegion">,
	plan: HeldChain,
	restriction: ColumnEqualities
): ReadonlyMap<NodeOf<"MatchRegion">["occurrences"][number], KeySet> => {
	const classOf = regionVarClasses(region)
	const sets = new Map<NodeOf<"MatchRegion">["occurrences"][number], KeySet>()
	for (const step of plan.steps) {
		if (step.read !== "keyset") {
			continue
		}
		const o = step.occurrence
		const source = o.source
		const origin = { kind: "node", node: source.id } as const
		const keyed = step.key.bindings
		const held = o.bindings.flatMap((b) =>
			restriction.flatMap((e) =>
				region.vars.some((v) => v.name === e.column && classOf(v) === classOf(b.var))
					? [{ column: b.column, value: e.value }]
					: []
			)
		)
		const name = cx.relationAlias(origin)
		const columns = cx.supply.columns(keyed.map(() => origin))
		sets.set(o, {
			name,
			columns,
			from: keyed.map((k) => ({ occurrence: k.occurrence, column: k.column })),
			site: {
				after: [],
				read: (_columnsOf, within) => {
					const alias = cx.relationAlias(origin)
					const at = columns.map((c) => col(alias, c))
					const equalities: ColumnEqualities = [
						...held,
						...keyed.map((k, j) => ({
							column: k.bound,
							value: defined(at[j], "a key set's column for each key")
						}))
					]
					const scope = step.key.scope(within, at)
					const rows =
						source.kind === "Base"
							? fencedAt(cx, scope, source, equalities)
							: readAt(cx, scope, source, equalities)
					return cx.wrapAs(
						select(
							distinctCore(
								mapNonEmpty(outputNames(source.heading), (n) => target(columnIn(rows.map, n))),
								[cteRefAs(name, alias), rows.item],
								undefined
							)
						),
						source.heading,
						origin,
						false
					)
				}
			}
		})
	}
	return sets
}

/**
 * The row sites of a region's chain as its parts read them (match-region RowSites): each of `sites` (share/sites.ts
 * chainSites, the one decision the key analysis reads too) the chain fences, lowered at the values the steps before it
 * bind and the restriction the region holds, each column it binds at the column of the first step before it that binds
 * the same variable class, or at the restriction's value, the restriction walked into it (share/keyed.ts pushedInto) so
 * its own chain reads its relations at those values, where a WHERE over its rows left its join to PostgreSQL's estimates
 * inside the fence; a site read at its key set is its key set's (chainKeySets).
 */
const siteReads = (
	cx: LowerContext,
	plan: HeldChain,
	sites: ReadonlyArray<ChainSite>,
	restriction: ColumnEqualities
): RowSites =>
	new Map(
		sites.flatMap((site) => {
			const o = site.occurrence
			if (plan.steps.find((s) => s.occurrence === o)?.read !== "fenced") {
				return []
			}
			const held = site.held.flatMap((h) =>
				restriction.flatMap((e) =>
					e.column === h.variable ? [{ column: h.column, value: e.value }] : []
				)
			)
			const source = o.source
			const read: RowSite = {
				after: [...new Set(site.columns.map((c) => c.occurrence))],
				read: (columnsAt, scope) =>
					readAt(cx, scope, source, [
						...held,
						...site.columns.map((c) => ({
							column: c.column,
							value: columnIn(columnsAt(c.occurrence), c.at)
						}))
					])
			}
			return [[o, read] as const]
		})
	)

/**
 * A stored relation read at `equalities` in `scope`, LATERAL, a fence PostgreSQL neither pulls up nor reorders
 * (step/index.ts fencedRead): a seek of its key at those values, its rows there alone, which no restriction placed on
 * the relation itself would hold (`restrictedAt` restricts none).
 */
const fencedAt = (
	cx: LowerContext,
	scope: Env,
	source: NodeOf<"Base">,
	equalities: ColumnEqualities
): InputSource => {
	const rows = cx.sourceAs(source, scope, true)
	return cx.wrapAs(
		headingRead(
			source.heading,
			rows.map,
			rows.item,
			conjunction(equalitiesOver(cx, source.heading, rows.map, equalities))
		),
		source.heading,
		{ kind: "node", node: source.id },
		true
	)
}

/**
 * `source` read at `equalities` in `scope`, LATERAL (`restrictedAt`), each node under it read at several reads held once
 * in its own query's WITH, where the values it reads of the rows before it are in scope, never in the region's.
 */
const readAt = (
	cx: LowerContext,
	scope: Env,
	source: RelNode,
	equalities: ColumnEqualities
): InputSource => {
	const own = freshCtes<RelNode>()
	const rows = cx.sourceAs(source, restrictedAt(scope, source, equalities, own), true)
	const item = rows.item
	if (item.kind !== "derived") {
		defect(`a source read at values (${source.kind} ${source.id}) read as a derived table`)
	}
	return { ...rows, item: { ...item, query: withLeading(item.query, own.ctes) } }
}

/**
 * `env` with `source` read at `equalities`: held at them where its lowering places a restriction inside it
 * (context.ts holdsInside), and every node under it they reach (share/keyed.ts pushedInto) lowered at them, each read at
 * several reads held once in `holding`.
 */
const restrictedAt = (
	env: Env,
	source: RelNode,
	equalities: ColumnEqualities,
	holding: CteTable<RelNode>
): Env => {
	const walked = pushedInto(source, equalities, "held", holding)
	return heldEnv(
		restrictedEnv(
			env,
			new Map([
				[source, holdsInside(source, equalities) ? equalities : noRestriction] as const,
				...walked.restricted
			])
		),
		walked.held
	)
}

/**
 * A region's parts in `steps`' order, each step whose derived table reads another occurrence's columns placed after
 * that occurrence: a correlated source's correlation is lowered at the column of the occurrence that first bound its
 * variable in placement order (match-region regionParts), which the chain's order may place later, and a fenced LATERAL
 * step reads only the steps before it. So each step is the first in `steps`' order whose reads of the region are all
 * placed (FOLDKEY's ordering of the key's chain, the one ordering of either chain): the agreement's owned items, bound
 * at a tag's item, read the stage occurrence's id the placement bound it to, where the key's order led with the owned
 * items and the fenced read named an alias not yet in scope; a test's suspensions before its response snapshots, the
 * snapshot's instant they compare read beside them (qti-pie's ledger judge). Placement order is such an order, so one
 * always stands.
 */
const readableOrder = (
	steps: ReadonlyArray<PlacedOccurrence>,
	within: ReadonlySet<string>
): ReadonlyArray<PlacedOccurrence> => {
	const placed: Array<PlacedOccurrence> = []
	const pending = [...steps]
	while (pending.length > 0) {
		const next = pending.findIndex((p) =>
			[...itemReads(p.item, within)].every(
				(alias) => alias === p.alias || placed.some((q) => q.alias === alias)
			)
		)
		const [step] = next < 0 ? [] : pending.splice(next, 1)
		if (step === undefined) {
			defect(
				"a region's occurrences in an order each reads only those before it, as placement orders them"
			)
		}
		placed.push(step)
	}
	return placed
}

/**
 * A region read along its chain (heldChain), its occurrences in chain order:
 *
 *   SELECT <targets> FROM <lead>, LATERAL (SELECT <its columns> FROM <a fenced step> AS n WHERE <its terms> OFFSET 0)
 *     AS <it>, <a free step>, ... WHERE <every term no fenced step brings in last>
 *
 * Each term stands at the step that brings in the last occurrence it reads, as in a JOIN chain (regionSelect): inside a
 * fenced step's fence, where it reads the values of the steps before it, and in WHERE for every other step. So each
 * stored relation the chain binds on a declared-key prefix seeks the values of the rows before it, whatever PostgreSQL
 * estimates of either: a fold of a child's attempts at a stage reads the stage's item sessions by (child, stage), then
 * each session's attempts by its key, never every attempt of the child first; an item's variables read beside the
 * call's answered items, a carried share no index reads, are read at each answer's key, never hashed whole. An
 * occurrence the region's parts read as no derived table of named columns is a defect of the lowering that placed it.
 * The chain is all of the region's occurrences (regionSelect) or some (chainSelect), the set `rows` makes of its FROM
 * items and its WHERE, each column read through `rename` where a key set's CTE carries it; a term that reads an
 * occurrence the chain leaves out stands with that occurrence, outside it.
 */
const chainedSelect = (
	cx: LowerContext,
	node: NodeOf<"MatchRegion">,
	parts: ReturnType<typeof regionParts>,
	plan: HeldChain,
	keySets: ReadonlyMap<NodeOf<"MatchRegion">["occurrences"][number], KeySet>,
	holding: CteTable<RelNode>,
	rows: (
		from: ReadonlyArray<FromItem>,
		where: Expr | undefined,
		rename: (e: Expr) => Expr
	) => Select
): Select => {
	/** The steps in chain order (readableOrder). */
	const order = plan.steps.map((s) => ({ occurrence: s.occurrence, read: s.read }))
	const partOf = (o: NodeOf<"MatchRegion">["occurrences"][number]): PlacedOccurrence =>
		defined(
			parts.occurrences.find((p) => p.occurrence === o),
			"a chained occurrence's part"
		)
	const readOf = new Map(order.map((o) => [o.occurrence, o.read] as const))
	const within = new Set(order.map((o) => partOf(o.occurrence).alias))
	const region = new Set(parts.occurrences.map((p) => p.alias))
	const placed = readableOrder(
		order.map((o) => partOf(o.occurrence)),
		within
	).map((part) => ({
		occurrence: part.occurrence,
		read: defined(readOf.get(part.occurrence), "a placed occurrence's read"),
		part
	}))
	const terms = parts
		.conditionsIn(placed.map((p) => p.part.alias))
		.flatMap(sqlConjuncts)
		.map((e) => termOf(e, region))
		.filter((t) => [...t.reads].every((alias) => within.has(alias)))
	const stepOf = (t: Term): number =>
		placed.reduce((at, p, i) => (t.reads.has(p.part.alias) ? i : at), 0)
	const inside = (step: number): ReadonlyArray<Expr> =>
		terms.flatMap((t) => (stepOf(t) === step ? [t.expr] : []))
	const itemOf = (p: (typeof placed)[number], i: number): FromItem => {
		if (p.read !== "fenced") {
			return p.part.item
		}
		const item = p.part.item
		const columns = item.kind === "derived" ? selectColumns(item.query) : []
		if (item.kind !== "derived" || !isNonEmpty(columns)) {
			defect(
				`region ${node.id}'s chain step ${p.occurrence.source.kind} ${p.occurrence.source.id} read as a derived table of named columns`
			)
		}
		const query = item.query
		const body = query.body
		/**
		 * A plain read (one core, no DISTINCT, grouping, order, bound or WITH): fenced in place, its terms in its own WHERE
		 * at the expressions its columns name and OFFSET 0 on it, no second column list printed around it.
		 */
		const plain =
			body.kind === "core" &&
			body.distinct === false &&
			body.groupBy.length === 0 &&
			body.having === undefined &&
			body.targets.length === columns.length &&
			query.with === undefined &&
			query.orderBy.length === 0 &&
			query.limit === undefined &&
			query.offset === undefined
		if (plain) {
			const at = new Map(columns.map((c, j) => [c, body.targets[j]?.expr] as const))
			const inPlace = {
				...identityHooks,
				expr: (e: Expr) =>
					e.kind === "column" && e.table === p.part.alias ? (at.get(e.column) ?? e) : e
			}
			const fenced = inside(i).map((e) => transformExpr(e, inPlace))
			return derived(
				{
					...query,
					body: {
						...body,
						where: conjunction([...(body.where === undefined ? [] : [body.where]), ...fenced])
					},
					offset: lit.int(0, types.integer)
				},
				p.part.alias,
				true
			)
		}
		const inner = cx.relationAlias({ kind: "node", node: p.occurrence.source.id })
		const renamed = {
			...identityHooks,
			expr: (e: Expr) =>
				e.kind === "column" && e.table === p.part.alias ? { ...e, table: inner } : e
		}
		return derived(
			fencedRead(
				mapNonEmpty(columns, (c) => target(col(inner, c))),
				{ ...item, alias: inner },
				conjunction(inside(i).map((e) => transformExpr(e, renamed)))
			),
			p.part.alias,
			true
		)
	}
	/**
	 * The rows before a `keyset` step, as the region reads them from then on: each a CTE of the region's query (`held`),
	 * every column of each item before it under a fresh column (`renames`, `alias.column` to the CTE's, a column read
	 * through an earlier CTE moving on with it, so a second key set's rows read the first's columns where the second CTE
	 * carries them), its terms the WHERE of the rows they bring in; and the step's key set, the DISTINCT of its key
	 * columns over that CTE.
	 */
	const renames = new Map<string, Expr>()
	const rename = (e: Expr): Expr =>
		transformExpr(e, {
			...identityHooks,
			expr: (x: Expr) =>
				x.kind === "column" && x.table !== undefined
					? (renames.get(`${x.table}.${x.column}`) ?? x)
					: x
		})
	const renameItem = (item: FromItem): FromItem => {
		const wrapped = transformQuery(
			operandSelect(core([target(lit.bool(true))], [item], undefined)),
			{
				...identityHooks,
				expr: (x: Expr) =>
					x.kind === "column" && x.table !== undefined
						? (renames.get(`${x.table}.${x.column}`) ?? x)
						: x
			}
		)
		const body = wrapped.body
		return defined(body.kind === "core" ? body.from[0] : undefined, "a renamed FROM item")
	}
	let from: Array<{
		readonly item: FromItem
		readonly alias: string
		readonly columns: ReadonlyArray<string>
	}> = []
	let pending: Array<Expr> = []
	for (const [i, p] of placed.entries()) {
		const keySet = p.read === "keyset" ? keySets.get(p.occurrence) : undefined
		if (keySet !== undefined) {
			const origin = { kind: "node", node: p.occurrence.source.id } as const
			const held = cx.relationAlias(origin)
			const alias = cx.relationAlias(origin)
			const carried = from.flatMap((f) =>
				f.columns.map((c) => ({ alias: f.alias, column: c, as: cx.supply.column(origin) }))
			)
			const [first, ...more] = carried
			if (first === undefined) {
				defect(`region ${node.id}'s key set read after a step of at least one column`)
			}
			holding.ctes.add({
				name: held,
				materialized: "MATERIALIZED",
				query: namedQuery(
					operandSelect(
						keyedRead(
							mapNonEmpty([first, ...more], (c) => target(col(c.alias, c.column))),
							from.map((f) => renameItem(f.item)),
							conjunction(pending.map(rename))
						)
					),
					carried.map((c) => c.as)
				)
			})
			/** Each carried column's new place, and every column read through one before it moved on with it. */
			const moved = new Map(
				carried.map((c) => [`${c.alias}.${c.column}`, col(alias, c.as)] as const)
			)
			for (const [read, at] of renames) {
				const now = at.kind === "column" ? moved.get(`${at.table}.${at.column}`) : undefined
				if (now !== undefined) {
					renames.set(read, now)
				}
			}
			for (const [read, at] of moved) {
				renames.set(read, at)
			}
			const keyAlias = cx.relationAlias(origin)
			const keys = keySet.from.map((k) =>
				rename(
					defined(
						parts.occurrences.find((q) => q.occurrence === k.occurrence)?.map.get(k.column),
						"a key column's place among the rows before it"
					)
				)
			)
			const [key, ...rest] = keys
			if (key === undefined) {
				defect(`region ${node.id}'s key set of at least one column`)
			}
			holding.ctes.add({
				name: keySet.name,
				materialized: "MATERIALIZED",
				query: namedQuery(
					select(
						distinctCore(
							mapNonEmpty([key, ...rest], (e) =>
								target(
									transformExpr(e, {
										...identityHooks,
										expr: (x: Expr) =>
											x.kind === "column" && x.table === alias ? { ...x, table: keyAlias } : x
									})
								)
							),
							[cteRefAs(held, keyAlias)],
							undefined
						)
					),
					keySet.columns
				)
			})
			from = [{ item: cteRefAs(held, alias), alias, columns: carried.map((c) => c.as) }]
			pending = []
		}
		const item = itemOf(p, i)
		const columns = item.kind === "derived" ? selectColumns(item.query) : []
		from.push({ item, alias: p.part.alias, columns })
		appendAll(
			pending,
			terms.flatMap((t) =>
				stepOf(t) === i && placed[stepOf(t)]?.read !== "fenced" ? [t.expr] : []
			)
		)
	}
	return rows(
		from.map((f) => renameItem(f.item)),
		conjunction(pending.map(rename)),
		rename
	)
}

/**
 * A region's parts read at the restriction it holds in `env` (context.ts restrictsInside), each restricted variable at
 * its value in every occurrence that binds it or one its equalities join, so each relation a chain reads seeks the value
 * itself, and at the bounds its reader implies (`impliedBounds`), both after the region's own conditions in whichever
 * order states them (RegionParts conditionsIn).
 */
const restrictedParts = (
	cx: LowerContext,
	node: NodeOf<"MatchRegion">,
	env: Env,
	lowered: ReturnType<typeof regionParts>
): ReturnType<typeof regionParts> => {
	const restriction = env.restricted.get(node) ?? noRestriction
	const classOf = regionVarClasses(node)
	const held = restriction.flatMap((e) => {
		const v = node.vars.find((x) => x.name === e.column)
		return v === undefined
			? []
			: lowered.occurrences.flatMap((p) =>
					p.occurrence.bindings.flatMap((b) => {
						const x = classOf(b.var) === classOf(v) ? p.map.get(b.column) : undefined
						return x === undefined ? [] : [cx.equal(v.type, x, e.value)]
					})
				)
	})
	const extra = [...held, ...impliedBounds(node, cx, env, lowered)]
	return {
		...lowered,
		conditions: [...lowered.conditions, ...extra],
		conditionsIn: (aliases: ReadonlyArray<string>): ReadonlyArray<Expr> => [
			...lowered.conditionsIn(aliases),
			...extra
		]
	}
}

/**
 * The rows of a chain over some of a region's occurrences (cte-policy keyedRegionChain over them), printed as the
 * region's own chain is (chainedSelect), its lead where it stands and each next step fenced at the values those before
 * it bind: SELECT DISTINCT of each target's variable, read at a column its chain binds, over the chain's occurrences and
 * the terms that read them alone, each variable the region is restricted at in `env` (restrictedEnv, a column of the
 * region's heading at its value) at that value at each occurrence binding it, as a region read at a restriction it
 * holds is (`restrictedParts`). A page's value set is one: the window's region but its driver, chained from the call's
 * values, a value a filter over the region fixes held as its restriction (lower/shapes/page). Undefined where a target's
 * variable is bound by no occurrence of the chain or the chain reads one apart, a step no derived table of named
 * columns.
 */
export const chainSelect = (
	cx: LowerContext,
	env: Env,
	region: NodeOf<"MatchRegion">,
	steps: NonEmptyReadonlyArray<ChainStep>,
	targets: NonEmptyReadonlyArray<{ readonly name: string; readonly var: VarDecl }>
): Select | undefined => {
	const parts = restrictedParts(cx, region, env, regionParts(region, cx, env, noRowSites))
	const chain = steps.map((s) => s.occurrence)
	const placed = parts.occurrences.filter((p) => chain.includes(p.occurrence))
	const classOf = regionVarClasses(region)
	const read = targets.map((t) => {
		const column = placed
			.flatMap((p) =>
				p.occurrence.bindings.flatMap((b) => {
					const e = classOf(b.var) === classOf(t.var) ? p.map.get(b.column) : undefined
					return e === undefined ? [] : [e]
				})
			)
			.at(0)
		return column === undefined ? undefined : targetAs(column, t.name)
	})
	const [lead, ...rest] = steps
	const apart = placed.some(
		(p) =>
			p.occurrence !== lead.occurrence &&
			(p.item.kind !== "derived" || !isNonEmpty(selectColumns(p.item.query)))
	)
	if (placed.length !== chain.length || apart || !read.every((t) => t !== undefined)) {
		return undefined
	}
	const plan: HeldChain = {
		steps: [{ ...lead, read: "lead" }, ...rest.map((s) => ({ ...s, read: "fenced" as const }))]
	}
	return chainedSelect(
		cx,
		region,
		parts,
		plan,
		noKeySets,
		freshCtes<RelNode>(),
		(from, where, rename) =>
			select(
				distinctCore(
					mapNonEmpty(targets, (_, i) => {
						const t = defined(read[i], "a target's column")
						return { ...t, expr: rename(t.expr) }
					}),
					from,
					where
				)
			)
	)
}
