import { firstIndex, appendAll } from "#compiler/core/array.ts"
import type { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	type Comparator,
	combine,
	combineAll,
	compareBooleans,
	compareNumbers,
	compareStrings,
	flip,
	mapInput
} from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type {
	AccessKey,
	AccessPath,
	AccessUse,
	ProgramAccess,
	StatisticsShape
} from "#compiler/ir/products.ts"
import type {
	CompletedOrder,
	Heading,
	KeySet,
	NodeOf,
	OrderKey,
	RelNode,
	VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, type Carrier, fewValued } from "#compiler/ir/scalar.ts"
import { type Atom, atomKey, operandOf, predicateAtoms } from "#compiler/physical/access/atoms.ts"
import { uniquePaths } from "#compiler/physical/access/paths.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

/** The most columns one extended statistics object covers (PostgreSQL's STATS_MAX_DIMENSIONS). */
const statisticsMaxColumns = 8

interface ExtractOptions {
	/** The roots that are a paged ordered program: a workload program whose root is an ordered result. */
	readonly pageable: ReadonlyArray<RelNode>
	/** The compilation's meter; each node visit costs one node. */
	readonly meter: BudgetMeter
	/** The program's label, where a ResourceBound refusal is located. */
	readonly label: string
}

type Bound = "lower" | "upper" | "pair"

/** What a node's consumers fix about its heading columns. */
interface Pushed {
	readonly eq: ReadonlyMap<string, "fixed" | "literal">
	readonly range: ReadonlyMap<string, ReadonlySet<Bound>>
	readonly span: ReadonlySet<string>
	readonly pairs: ReadonlyArray<Atom>
}

const nothing: Pushed = { eq: new Map(), range: new Map(), span: new Set(), pairs: [] }

/** The occurrences that drive through their keys around an occurrence with no region: none, it having no partner. */
const alone: ReadonlySet<number> = new Set()

const sorted = (xs: Iterable<string>): ReadonlyArray<string> =>
	[...new Set(xs)].toSorted(compareStrings)

/** Map entries by their key, by code unit. */
const byKey: Comparator<readonly [string, unknown]> = mapInput(
	compareStrings,
	([key]: readonly [string, unknown]) => key
)

/** The identity of the facts pushed on a node: its parts joined by NUL, each part's items by \u0001 and an item's own
 * parts by \u0002, none of which a column name holds; the pair atoms, whose keys hold NUL, are the last part. */
const pushedKey = (p: Pushed): string =>
	[
		[...p.eq.entries()]
			.toSorted(byKey)
			.map(([column, value]) => `${column}\u0002${value}`)
			.join("\u0001"),
		[...p.range.entries()]
			.toSorted(byKey)
			.map(([column, bounds]) => `${column}\u0002${sorted(bounds).join("\u0002")}`)
			.join("\u0001"),
		sorted(p.span).join("\u0001"),
		p.pairs
			.map((a) => atomKey(a))
			.toSorted(compareStrings)
			.join("\u0001")
	].join("\u0000")

/** The order of two statistics shapes' column lists: column by column by code unit, and of two lists one of which
 * begins the other, the longer first. */
const columnsOrder: Comparator<ReadonlyArray<string>> = (a, b) => {
	for (const [i, x] of a.entries()) {
		const y = b[i]
		if (y === undefined) {
			break
		}
		const order = compareStrings(x, y)
		if (order !== 0) {
			return order
		}
	}
	return compareNumbers(b.length, a.length)
}

/** The order of the statistics shapes: by relation, then column list, then use. */
const statisticsOrder: Comparator<StatisticsShape> = combineAll([
	mapInput(compareStrings, (s: StatisticsShape) => s.relation),
	mapInput(columnsOrder, (s: StatisticsShape) => s.columns),
	mapInput(compareStrings, (s: StatisticsShape) => s.use)
])

/** An equality fact on a column: a fixed one replaces a literal one, a literal one only fills an absent one. */
const noteEq = (
	eq: Map<string, "fixed" | "literal">,
	column: string,
	k: "fixed" | "literal"
): void => {
	if (k === "fixed" || !eq.has(column)) {
		eq.set(column, k)
	}
}

const withAtoms = (p: Pushed, atoms: ReadonlyArray<Atom>): Pushed => {
	const eq = new Map(p.eq)
	const range = new Map(p.range)
	const span = new Set(p.span)
	const pairs = [...p.pairs]
	for (const a of atoms) {
		switch (a.kind) {
			case "eq":
				noteEq(eq, a.column, a.with)
				continue
			case "range":
				range.set(a.column, new Set([...(range.get(a.column) ?? []), a.bound]))
				continue
			case "span":
				span.add(a.column)
				continue
			case "pairEq":
			case "pairRange":
			case "pairSpan":
				pairs.push(a)
				continue
		}
	}
	return { eq, range, span, pairs }
}

/** The facts renamed through `rename`, which maps an output column to the input column it is; a fact on a column it
 * maps to nothing is dropped. */
const mapPushed = (p: Pushed, rename: (column: string) => string | undefined): Pushed => {
	const eq = new Map<string, "fixed" | "literal">()
	const range = new Map<string, ReadonlySet<Bound>>()
	const span = new Set<string>()
	/** Two renamed columns of a pair atom, when both rename and stay two. */
	const both = (x: string, y: string): readonly [string, string] | undefined => {
		const a = rename(x)
		const b = rename(y)
		return a !== undefined && b !== undefined && a !== b ? [a, b] : undefined
	}
	/** Each entry of `facts` under its renamed column, an entry whose column renames to nothing dropped. */
	const renamed = <V>(facts: Iterable<readonly [string, V]>): ReadonlyArray<readonly [string, V]> =>
		[...facts].flatMap(([c, v]) => {
			const column = rename(c)
			return column === undefined ? [] : [[column, v] as const]
		})
	for (const [to, k] of renamed(p.eq)) {
		noteEq(eq, to, k)
	}
	for (const [to, b] of renamed(p.range)) {
		range.set(to, new Set([...(range.get(to) ?? []), ...b]))
	}
	for (const c of p.span) {
		const to = rename(c)
		if (to !== undefined) {
			span.add(to)
		}
	}
	/** A pair atom over its renamed columns, none when either renames to nothing or both to one column. */
	const renamedPair = (a: Atom): ReadonlyArray<Atom> => {
		switch (a.kind) {
			case "pairEq": {
				const pair = both(a.a, a.b)
				return pair === undefined ? [] : [{ kind: "pairEq", a: pair[0], b: pair[1] }]
			}
			case "pairRange":
			case "pairSpan": {
				const pair = both(a.column, a.other)
				return pair === undefined ? [] : [{ ...a, column: pair[0], other: pair[1] }]
			}
			case "eq":
			case "range":
			case "span":
				return []
		}
	}
	return { eq, range, span, pairs: p.pairs.flatMap(renamedPair) }
}

const restrict = (p: Pushed, columns: ReadonlyArray<string>): Pushed => {
	const keep = new Set(columns)
	return mapPushed(p, (c) => (keep.has(c) ? c : undefined))
}

const fixedOn = (columns: Iterable<string>): Pushed => ({
	eq: new Map([...columns].map((c) => [c, "fixed" as const] as const)),
	range: new Map(),
	span: new Set(),
	pairs: []
})

/**
 * What a join partner fixes about one occurrence's columns in a region, and whether the partner yields at most one row
 * per evaluation (its source's logical cardinality, ir/rel.ts Card): such a partner, a context, a write filter's row or
 * another source the logical analysis proves of at most one row, holds one value of each column per evaluation, as a
 * parameter does, so what it fixes binds every probe of the occurrence (`Extractor.contexts`).
 */
interface PartnerFacts {
	readonly eq: Set<string>
	readonly range: Set<string>
	readonly span: Set<string>
	readonly single: boolean
}

interface OccurrenceFacts {
	readonly source: RelNode
	readonly eq: Map<string, "fixed" | "literal">
	readonly range: Map<string, Set<Bound>>
	readonly span: Set<string>
	/** By partner occurrence index, in occurrence order. */
	readonly partners: Map<number, PartnerFacts>
	/** Each region variable class bound here, to its first column. */
	readonly classes: Map<number, string>
}

interface RegionFacts {
	readonly occurrences: ReadonlyArray<OccurrenceFacts>
	/** A region heading column's variable class. */
	readonly classOf: (column: string) => number | undefined
}

/** The carrier of a heading column's base type, none for a column the heading lacks. */
const carrierOf = (heading: Heading, column: string): Carrier | undefined => {
	const c = heading.find((h) => h.name === column)
	return c === undefined ? undefined : baseOf(c.type).carrier
}

const isSpanColumn = (heading: Heading, column: string): boolean => {
	const carrier = carrierOf(heading, column)
	return carrier === "range4" || carrier === "range8"
}

const isVectorColumn = (heading: Heading, column: string): boolean =>
	carrierOf(heading, column) === "vector"

const isTextColumn = (heading: Heading, column: string): boolean =>
	carrierOf(heading, column) === "text"

/** A column of few values (fewValued): fixing it bounds no scan. */
const isFewValued = (heading: Heading, column: string): boolean => {
	const carrier = carrierOf(heading, column)
	return carrier !== undefined && fewValued[carrier]
}

class UnionFind {
	readonly #parent = new Map<string, string>()
	find(x: string): string {
		let at = x
		for (;;) {
			const p = this.#parent.get(at)
			if (p === undefined || p === at) {
				return at
			}
			at = p
		}
	}
	union(a: string, b: string): void {
		const ra = this.find(a)
		const rb = this.find(b)
		if (ra !== rb) {
			this.#parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb)
		}
	}
}

/** The facts of every occurrence of a region under the pushed facts on its heading. */
const regionFacts = (n: NodeOf<"MatchRegion">, pushed: Pushed): RegionFacts => {
	const uf = new UnionFind()
	for (const v of n.vars) {
		uf.find(v.id)
	}
	for (const e of n.equalities) {
		uf.union(e.a.id, e.b.id)
	}
	const classIds = new Map<string, number>()
	const classOfVar = (v: VarDecl): number => {
		const root = uf.find(v.id)
		const known = classIds.get(root)
		if (known !== undefined) {
			return known
		}
		classIds.set(root, classIds.size)
		return classIds.size - 1
	}
	const varByName = new Map(n.vars.map((v) => [v.name, v] as const))
	const classOf = (column: string): number | undefined => {
		const v = varByName.get(column)
		return v === undefined ? undefined : classOfVar(v)
	}
	/** Each occurrence beside its facts, index for index. */
	const sites = n.occurrences.map((o) => {
		const classes = new Map<number, string>()
		for (const b of o.bindings) {
			const k = classOfVar(b.var)
			if (!classes.has(k)) {
				classes.set(k, b.column)
			}
		}
		const facts: OccurrenceFacts = {
			source: o.source,
			eq: new Map(),
			range: new Map(),
			span: new Set(),
			partners: new Map(),
			classes
		}
		return { occurrence: o, facts }
	})
	const occurrences: Array<OccurrenceFacts> = sites.map((site) => site.facts)
	const headingOf = (o: OccurrenceFacts): Heading => o.source.heading
	const bindingsOf = (
		k: number
	): ReadonlyArray<{
		readonly at: number
		readonly column: string
		readonly facts: OccurrenceFacts
	}> =>
		sites.flatMap(({ occurrence, facts }, at) =>
			occurrence.bindings
				.filter((b) => classOfVar(b.var) === k)
				.map((b) => ({ at, column: b.column, facts }))
		)
	const setEq = (o: OccurrenceFacts, column: string, kind: "fixed" | "literal"): void => {
		if (kind === "fixed" || !o.eq.has(column)) {
			o.eq.set(column, kind)
		}
		if (kind === "fixed" && isSpanColumn(headingOf(o), column)) {
			o.span.add(column)
		}
	}
	const partner = (o: OccurrenceFacts, at: number, of: OccurrenceFacts): PartnerFacts => {
		const known = o.partners.get(at)
		if (known !== undefined) {
			return known
		}
		const fresh: PartnerFacts = {
			eq: new Set(),
			range: new Set(),
			span: new Set(),
			single: of.source.meta.card !== "many"
		}
		o.partners.set(at, fresh)
		return fresh
	}
	/** A constant or correlated operand that fixes its column: a fixed value or a literal. */
	const fixing = (expr: ScalarExpr): "fixed" | "literal" | undefined => {
		const operand = operandOf(n.id, expr)
		return operand.kind === "fixed" || operand.kind === "literal" ? operand.kind : undefined
	}
	for (const { occurrence: o, facts } of sites) {
		for (const c of o.constants) {
			const kind = fixing(c.expr)
			if (kind !== undefined) {
				setEq(facts, c.column, kind)
			}
		}
	}
	for (const c of n.correlated) {
		const kind = fixing(c.expr)
		if (kind === undefined) {
			continue
		}
		for (const b of bindingsOf(classOfVar(c.var))) {
			setEq(b.facts, b.column, kind)
		}
	}
	/** The bindings of a pushed column's variable class, none for a column no variable names. */
	const bindingsAt = (column: string) => {
		const k = classOf(column)
		return k === undefined ? [] : bindingsOf(k)
	}
	for (const [column, kind] of pushed.eq) {
		for (const b of bindingsAt(column)) {
			setEq(b.facts, b.column, kind)
		}
	}
	for (const [column, bounds] of pushed.range) {
		for (const b of bindingsAt(column)) {
			b.facts.range.set(b.column, new Set([...(b.facts.range.get(b.column) ?? []), ...bounds]))
		}
	}
	for (const column of pushed.span) {
		for (const b of bindingsAt(column).filter((x) => isSpanColumn(headingOf(x.facts), x.column))) {
			b.facts.span.add(b.column)
		}
	}
	/** Join conditions: shared variable classes and pair atoms between classes. */
	const relate = (k1: number, k2: number, kind: "eq" | "range" | "span"): void => {
		const joined = bindingsOf(k1).flatMap((x) =>
			bindingsOf(k2).flatMap((y) =>
				x.at === y.at || (kind === "span" && !isSpanColumn(headingOf(x.facts), x.column))
					? []
					: [{ x, y }]
			)
		)
		for (const { x, y } of joined) {
			partner(x.facts, y.at, y.facts)[kind].add(x.column)
		}
	}
	for (const k of new Set(classIds.values())) {
		relate(k, k, "eq")
	}
	/** The classes a pair atom relates, both ways for an equality; none when a column has no class. */
	const relatedBy = (
		a: Atom
	): ReadonlyArray<readonly [number, number, "eq" | "range" | "span"]> => {
		switch (a.kind) {
			case "pairEq": {
				const k1 = classOf(a.a)
				const k2 = classOf(a.b)
				return k1 === undefined || k2 === undefined
					? []
					: [
							[k1, k2, "eq"],
							[k2, k1, "eq"]
						]
			}
			case "pairRange":
			case "pairSpan": {
				const k1 = classOf(a.column)
				const k2 = classOf(a.other)
				return k1 === undefined || k2 === undefined
					? []
					: [[k1, k2, a.kind === "pairRange" ? "range" : "span"]]
			}
			case "eq":
			case "range":
			case "span":
				return []
		}
	}
	for (const [k1, k2, kind] of pushed.pairs.flatMap(relatedBy)) {
		relate(k1, k2, kind)
	}
	return { occurrences, classOf }
}

/** Whether an occurrence carries a fixed restriction: an equality with a fixed value, a range or a span predicate. */
const restricted = (o: OccurrenceFacts): boolean =>
	[...o.eq.values()].some((k) => k === "fixed") || o.range.size > 0 || o.span.size > 0

type KeysOf = (base: NodeOf<"Base">) => ReadonlyArray<KeySet>

/** A span key's index is GiST; every other key's is a B-tree. */
const keyMethod = (base: NodeOf<"Base">, key: ReadonlyArray<string>): "btree" | "gist" =>
	key.some((f) => isSpanColumn(base.heading, f)) ? "gist" : "btree"

/** What one probe of an occurrence binds (see `extractAccess`): its equalities and ranges, and its span columns, those under a
 * span predicate or fixed by equality, in code point order. */
interface Binding {
	readonly eq: ReadonlyMap<string, "fixed" | "literal">
	readonly range: ReadonlyMap<string, ReadonlySet<Bound>>
	readonly spans: ReadonlyArray<string>
}

/** A binding classified for its probe context: a key lookup, a scalar probe fixing no key, or a span binding, which
 * only the span predicate's context requests. */
type Classified =
	| { readonly kind: "keyed"; readonly context: ProbeContext }
	| { readonly kind: "unkeyed"; readonly context: ProbeContext }
	| { readonly kind: "spanned" }

/** A ranged column of a probe, and whether it is bounded on both sides. */
interface RangeColumn {
	readonly column: string
	readonly both: boolean
}

/** The range a B-tree path leads with: one bounded on both sides first, then by column. */
const rangeOrder: Comparator<RangeColumn> = combine(
	mapInput(flip(compareBooleans), (r: RangeColumn) => r.both),
	mapInput(compareStrings, (r: RangeColumn) => r.column)
)

/** One probe of an occurrence (see `extractAccess`): a key lookup, when its equalities contain a declared key; an equality
 * and range probe binding no span, the occurrence's own facts and its partners' of one row alone or with one join
 * partner's; or the span predicate's probe of what its own facts and every partner fixing none of its keys bind
 * together, the only form a span is requested in. */
type ProbeContext =
	| { readonly kind: "key"; readonly key: ReadonlyArray<string>; readonly bound: Binding }
	| {
			readonly kind: "scalar"
			readonly eq: ReadonlyMap<string, "fixed" | "literal">
			readonly range: ReadonlyMap<string, ReadonlySet<Bound>>
			readonly use: "equality lookup" | "join key"
	  }
	| {
			readonly kind: "span"
			readonly eq: ReadonlyMap<string, "fixed" | "literal">
			readonly range: ReadonlyMap<string, ReadonlySet<Bound>>
			readonly spans: NonEmptyReadonlyArray<string>
	  }

/** What a probe context pushes into a non-stored source. */
const pushedOf = (ctx: ProbeContext): Pushed => {
	switch (ctx.kind) {
		case "key":
			return { eq: ctx.bound.eq, range: ctx.bound.range, span: new Set(ctx.bound.spans), pairs: [] }
		case "scalar":
			return { eq: ctx.eq, range: ctx.range, span: new Set(), pairs: [] }
		case "span":
			return { eq: ctx.eq, range: ctx.range, span: new Set(ctx.spans), pairs: [] }
	}
}

const asc = (field: string): AccessKey => ({ field, dir: "asc" })

/** A requested column as one occurrence of a stored relation reads it: a column of the relation, or fixed per
 * evaluation (an equality fact pins it, or a projection computes a constant), which orders and groups nothing. */
type Resolved = { readonly kind: "stored"; readonly column: string } | { readonly kind: "fixed" }

const fixedColumn: Resolved = Object.freeze({ kind: "fixed" })

const resolvedIn = (facts: OccurrenceFacts, column: string): Resolved =>
	facts.eq.has(column) ? fixedColumn : { kind: "stored", column }

/** A resolved column's stored column, none for one fixed to a constant. */
const storedColumn = (resolved: Resolved): string | undefined =>
	resolved.kind === "stored" ? resolved.column : undefined

/** A column a node is asked to resolve, with what its asker reads back beside the answer (`A`): a heading column of
 * the node, or one a projection above it already fixed to a constant it computes. */
type Request<A> =
	| { readonly kind: "column"; readonly name: string; readonly asked: A }
	| { readonly kind: "fixed"; readonly asked: A }

/** Each heading column of `columns` as a request that reads back the column itself. */
const columnRequests = (columns: ReadonlyArray<string>): ReadonlyArray<Request<string>> =>
	columns.map((name) => ({ kind: "column", name, asked: name }))

/** A request answered: what its asker reads back, and the column of the occurrence it resolved to. */
interface Answer<A> {
	readonly asked: A
	readonly resolved: Resolved
}

/** The requested columns of a node read from one occurrence of a stored relation: the relation, the facts pushed on
 * that occurrence and its region's other occurrences, and each request's answer, in request order. */
interface Resolution<A> {
	readonly base: NodeOf<"Base">
	readonly facts: OccurrenceFacts
	readonly others: ReadonlyArray<OccurrenceFacts>
	readonly columns: ReadonlyArray<Answer<A>>
}

/** A request of a region's heading column by the class of its variable, or one already fixed. */
type Classed<A> =
	| { readonly kind: "class"; readonly k: number; readonly asked: A }
	| Extract<Request<A>, { readonly kind: "fixed" }>

class Extractor {
	readonly options: ExtractOptions
	readonly paths: Array<AccessPath> = []
	readonly statistics = new Map<string, StatisticsShape>()
	/** The pushed facts each node was visited under, by their key: the walk's seen-set. */
	readonly #visited = new Map<RelNode, Set<string>>()
	readonly #pageable: ReadonlySet<RelNode>

	constructor(options: ExtractOptions) {
		this.options = options
		this.#pageable = new Set(options.pageable)
	}

	/** The declared keys of a stored relation's occurrence, or the proven keys of a derived relation's view, which its
	 * unique indexes carry and the checker stamped on its Base. */
	readonly keysOf: KeysOf = (base) => {
		const keys =
			base.relationKind === "derived"
				? base.view.map((k) => k.fields)
				: [base.primaryKey, ...base.keys]
		return keys.filter((k) => k.length > 0)
	}

	keyWithin(base: NodeOf<"Base">, columns: ReadonlySet<string>): ReadonlyArray<string> | undefined {
		return this.keysOf(base).find((k) => k.every((f) => columns.has(f)))
	}

	visit(n: RelNode, pushed: Pushed): Result.Result<void, CompileError> {
		const key = pushedKey(pushed)
		const seen = this.#visited.get(n)
		if (seen?.has(key) === true) {
			return Result.ok(undefined)
		}
		if (seen === undefined) {
			this.#visited.set(n, new Set([key]))
		} else {
			seen.add(key)
		}
		const charged = this.options.meter.charge(
			"nodes",
			1,
			SourceLoc(this.options.label, ["nodes", n.id])
		)
		if (!charged.ok) {
			return charged
		}
		const all = (
			steps: ReadonlyArray<readonly [RelNode, Pushed]>
		): Result.Result<void, CompileError> => {
			for (const [child, p] of steps) {
				const r = this.visit(child, p)
				if (!r.ok) {
					return r
				}
			}
			return Result.ok(undefined)
		}
		switch (n.kind) {
			case "MatchRegion":
				return this.region(n, pushed)
			case "Base":
				this.basePaths(
					n,
					{
						source: n,
						eq: new Map(pushed.eq),
						range: new Map([...pushed.range].map(([c, b]) => [c, new Set(b)] as const)),
						span: new Set([...pushed.span].filter((c) => isSpanColumn(n.heading, c))),
						partners: new Map(),
						classes: new Map()
					},
					alone
				)
				return Result.ok(undefined)
			case "Filter":
				return this.visit(n.input, withAtoms(pushed, predicateAtoms(n.input.id, n.pred)))
			case "ProjectSet":
				return this.visit(n.input, mapPushed(pushed, this.projection(n)))
			case "Take": {
				const input = fixedOn(n.correlation.map((c) => c.column))
				this.ordered(n.input, n.order, "take seek", input)
				return this.visit(n.input, input)
			}
			case "OrderedResult":
				if (this.#pageable.has(n)) {
					this.ordered(n.input, n.order, "page seek", pushed)
				}
				return this.visit(n.input, pushed)
			case "Group":
				this.groupStatistics(n.input, n.keys)
				return this.visit(n.input, restrict(pushed, n.keys))
			case "Union":
				return all(
					n.groups.flatMap((g) =>
						g.arms.map((arm): readonly [RelNode, Pushed] => [
							arm,
							restrict(
								pushed,
								arm.heading.map((c) => c.name)
							)
						])
					)
				)
			case "Intersect":
			case "Difference":
				return all([
					[n.left, pushed],
					[n.right, fixedOn(n.right.heading.map((c) => c.name))]
				])
			case "SemiJoin":
			case "AntiJoin":
				return all([
					[n.left, pushed],
					[n.right, fixedOn(n.on.map((p) => p.right))]
				])
			case "Attach":
				return all([
					[n.parent, pushed],
					[n.child, fixedOn(n.correlation.map((c) => c.child))]
				])
			case "Recursive":
				return all([
					[n.base, nothing],
					[n.step, nothing]
				])
			case "ApproximateNearest":
				this.nearest(n.source, n.score)
				return this.visit(n.source, nothing)
			case "Produce":
				return this.visit(n.input, restrict(pushed, n.carried))
			case "Window":
				return this.visit(n.input, restrict(pushed, n.partition))
			case "OrderedSetAggregate":
				return this.visit(n.input, restrict(pushed, n.keys))
			case "Forbid":
				return this.visit(n.violation, nothing)
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "SelfRef":
				return Result.ok(undefined)
		}
	}

	/** An output column of a projection to the input column it is, or undefined when it is computed. */
	projection(n: NodeOf<"ProjectSet">): (column: string) => string | undefined {
		return (column) => {
			const out = n.out.find((o) => o.name === column)
			if (out === undefined) {
				return undefined
			}
			const e = out.expr
			return e.kind === "column" && e.column.node === n.input.id ? e.column.name : undefined
		}
	}

	/** Whether an output column of a projection is a constant: a literal, a parameter, or an outer value. */
	constantColumn(n: NodeOf<"ProjectSet">, column: string): boolean {
		const out = n.out.find((o) => o.name === column)
		if (out === undefined) {
			return false
		}
		const operand = operandOf(n.input.id, out.expr)
		return operand.kind === "fixed" || operand.kind === "literal"
	}

	region(n: NodeOf<"MatchRegion">, pushed: Pushed): Result.Result<void, CompileError> {
		const facts = regionFacts(n, pushed)
		const keyDriven = new Set(
			facts.occurrences.flatMap((o, at) => {
				const source = o.source
				return source.kind === "Base" && this.drivesByKey(source, o) ? [at] : []
			})
		)
		for (const o of facts.occurrences) {
			const r = this.occurrence(o, keyDriven)
			if (!r.ok) {
				return r
			}
		}
		return Result.ok(undefined)
	}

	/** Whether an occurrence of a stored relation drives a plan through one of its keys' own indexes: its own fixed
	 * facts bind every column of a key, each scalar column by an equality and a span column by an equality or a span
	 * predicate, so a key lookup, or a span key's GiST index read through the span predicate, serves them. A world
	 * relation holds no index of its own. */
	drivesByKey(base: NodeOf<"Base">, o: OccurrenceFacts): boolean {
		return (
			base.relationKind !== "world" &&
			this.keysOf(base).some((key) =>
				key.every((f) => o.eq.has(f) || (isSpanColumn(base.heading, f) && o.span.has(f)))
			)
		)
	}

	/** One occurrence of a region: a stored source's access paths, or each probe context pushed into another source.
	 * `keyDriven` holds the region's occurrences that drive through their keys (drivesByKey), by index. */
	occurrence(
		o: OccurrenceFacts,
		keyDriven: ReadonlySet<number>
	): Result.Result<void, CompileError> {
		const source = o.source
		if (source.kind === "Base") {
			this.basePaths(source, o, keyDriven)
			return Result.ok(undefined)
		}
		for (const ctx of this.contexts(o, source.heading, () => undefined, keyDriven)) {
			const r = this.visit(o.source, pushedOf(ctx))
			if (!r.ok) {
				return r
			}
		}
		return Result.ok(undefined)
	}

	/** The probe contexts of an occurrence whose source has `heading` and whose keys `keyWithin` finds among equal
	 * columns (see `extractAccess`): the base context, unless a partner in `keyDriven` (the region's occurrences that
	 * drive through their keys) reaches the occurrence by its key, and one per join partner of many rows that fixes
	 * something, each a key lookup or binding no span; and the span predicate's context, when one of the others binds a
	 * span, of the base facts and every partner that fixes no key. What a partner of at most one row per evaluation
	 * fixes is part of every context, the base one included, as the occurrence's own fixed facts are. A source that is
	 * not stored receives each probe context pushed into it. */
	contexts(
		o: OccurrenceFacts,
		heading: Heading,
		keyWithin: (columns: ReadonlySet<string>) => ReadonlyArray<string> | undefined,
		keyDriven: ReadonlySet<number>
	): ReadonlyArray<ProbeContext> {
		const fixing = [...o.partners.entries()]
			.toSorted(mapInput(compareNumbers, ([at]: readonly [number, unknown]) => at))
			.filter(([, p]) => p.eq.size > 0 || p.range.size > 0 || p.span.size > 0)
		/** The partners of at most one row per evaluation, which bind every context. */
		const singles = fixing.flatMap(([, p]) => (p.single ? [p] : []))
		const partners = fixing.filter(([, p]) => !p.single)
		/** The base facts with those of every partner of one row and of `joined`, each partner's equalities fixed and
		 * ranges paired. */
		const bound = (joined: ReadonlyArray<PartnerFacts>): Binding => {
			const eq = new Map(o.eq)
			const range = new Map<string, ReadonlySet<Bound>>(o.range)
			const span = new Set(o.span)
			for (const p of [...singles, ...joined]) {
				for (const c of p.eq) {
					eq.set(c, "fixed")
				}
				for (const c of p.range) {
					range.set(c, new Set([...(range.get(c) ?? []), "pair" as const]))
				}
				for (const c of p.span) {
					span.add(c)
				}
			}
			const spans = sorted([
				...span,
				...[...eq].filter(([c, k]) => k === "fixed" && isSpanColumn(heading, c)).map(([c]) => c)
			])
			return { eq, range, spans }
		}
		const classify = (b: Binding, use: "equality lookup" | "join key"): Classified => {
			const key = keyWithin(new Set(b.eq.keys()))
			if (key !== undefined) {
				return { kind: "keyed", context: { kind: "key", key, bound: b } }
			}
			return b.spans.length > 0
				? { kind: "spanned" }
				: { kind: "unkeyed", context: { kind: "scalar", eq: b.eq, range: b.range, use } }
		}
		const joined = partners.map(([at, p]) => ({
			at,
			partner: p,
			classified: classify(bound([p]), "join key")
		}))
		/** A partner that drives through its own key and reaches this occurrence by this occurrence's key: the region
		 * has a plan through key indexes alone, that partner first, so an index on the occurrence's own facts would
		 * serve only the other order. */
		const reachedByKey = joined.some((j) => j.classified.kind === "keyed" && keyDriven.has(j.at))
		const base = classify(bound([]), "equality lookup")
		const classified = [
			...(reachedByKey && base.kind === "unkeyed" ? [] : [base]),
			...joined.map((j) => j.classified)
		]
		const out = classified.flatMap((c): ReadonlyArray<ProbeContext> =>
			c.kind === "spanned" ? [] : [c.context]
		)
		if (!classified.some((c) => c.kind === "spanned")) {
			return out
		}
		/** The partners the span predicate's context binds: those fixing no key. */
		const unkeyed = joined.flatMap((j) => (j.classified.kind === "keyed" ? [] : [j.partner]))
		const keyed = classified.some((c) => c.kind === "keyed")
		const all = bound(unkeyed)
		const key = keyWithin(new Set(all.eq.keys()))
		/** Beside a key lookup a span predicate is requested only with a scalar a GiST index leads: on the span alone it
		 * is an index no plan reads, the occurrence being reached by its key, or a span key's own index, which the key
		 * already holds and through which the occurrence drives (drivesByKey). */
		const scalar = [...all.eq].some(
			([c, k]) => k === "fixed" && !isSpanColumn(heading, c) && !isVectorColumn(heading, c)
		)
		if (key !== undefined) {
			return [...out, { kind: "key", key, bound: all }]
		}
		return isNonEmpty(all.spans) && (!keyed || scalar)
			? [...out, { kind: "span", eq: all.eq, range: all.range, spans: all.spans }]
			: out
	}

	/** The access paths and correlated-selection statistics of an occurrence of a stored relation, one path family per
	 * probe context under the fixed form policy. Handle columns alone are no access path: equal to a parameter or a
	 * partner as to a literal, they select a roster's share of the rows at best, and a range over them is no more than
	 * an equality. A world relation is a view: its program is planned through its definition, inlined before
	 * extraction, so its own name never reaches an index. */
	basePaths(base: NodeOf<"Base">, o: OccurrenceFacts, keyDriven: ReadonlySet<number>): void {
		if (base.relationKind === "world") {
			return
		}
		const heading = base.heading
		const path = (
			method: AccessPath["method"],
			keys: ReadonlyArray<AccessKey>,
			use: AccessUse
		): AccessPath => ({
			relation: base.relation,
			derived: base.relationKind === "derived",
			method,
			keys,
			use
		})
		const contextPaths = (ctx: ProbeContext): ReadonlyArray<AccessPath> => {
			if (ctx.kind === "key") {
				return [
					path(
						keyMethod(base, ctx.key),
						ctx.key.map((f) => asc(f)),
						"key lookup"
					)
				]
			}
			const equal = new Set(ctx.eq.keys())
			const prefix = sorted(
				[...equal].filter((c) => !isSpanColumn(heading, c) && !isVectorColumn(heading, c))
			)
			if (ctx.kind === "span") {
				return ctx.spans.map((span) =>
					path(
						"gist",
						[...prefix, span].map((f) => asc(f)),
						"span predicate"
					)
				)
			}
			const ranges = [...ctx.range]
				.filter(([c]) => !equal.has(c) && !isSpanColumn(heading, c) && !isVectorColumn(heading, c))
				.map(([c, b]): RangeColumn => ({
					column: c,
					both: (b.has("lower") && b.has("upper")) || b.has("pair")
				}))
			const [range] = ranges.toSorted(rangeOrder)
			if (range !== undefined) {
				const { both, column } = range
				const use: AccessUse =
					both && ctx.range.get(column)?.has("pair") !== true && isTextColumn(heading, column)
						? "prefix search"
						: "range"
				return [...prefix, column].some((c) => !isFewValued(heading, c))
					? [
							path(
								"btree",
								[...prefix, column].map((f) => asc(f)),
								use
							)
						]
					: []
			}
			return prefix.some((c) => !isFewValued(heading, c))
				? [
						path(
							"btree",
							prefix.map((f) => asc(f)),
							ctx.use
						)
					]
				: []
		}
		for (const ctx of this.contexts(
			o,
			heading,
			(columns) => this.keyWithin(base, columns),
			keyDriven
		)) {
			appendAll(this.paths, contextPaths(ctx))
		}
		/** Correlated selections. */
		const selected = sorted([...o.eq.keys()].filter((c) => !isVectorColumn(heading, c)))
		if (
			selected.length >= 2 &&
			selected.length <= statisticsMaxColumns &&
			this.keyWithin(base, new Set(selected)) === undefined
		) {
			this.addStatistics({
				relation: base.relation,
				columns: selected,
				use: "correlated selection"
			})
		}
	}

	addStatistics(s: StatisticsShape): void {
		const key = `${s.relation}\u0000${s.columns.join("\u0001")}\u0000${s.use}`
		if (!this.statistics.has(key)) {
			this.statistics.set(key, s)
		}
	}

	/** Resolves requested heading columns of `n` to one stored occurrence under the facts pushed on `n`: the
	 * occurrence, each request's answer (a stored column, or fixed to a constant), and the facts of every occurrence of
	 * its region. It reaches through a filter, a projection by column reference, a union's arms, an
	 * attachment's parent and the left side of a semi-join, anti-join, intersection or difference, which keep that
	 * input's rows and heading columns and the facts pushed on it; an attached column is computed. Empty when a column
	 * is computed, the columns span several occurrences, or another node stands between: one whose columns are computed
	 * or whose rows are not one occurrence's. */
	resolve<A>(
		n: RelNode,
		requests: ReadonlyArray<Request<A>>,
		pushed: Pushed
	): ReadonlyArray<Resolution<A>> {
		switch (n.kind) {
			case "Filter":
				return this.resolve(
					n.input,
					requests,
					withAtoms(pushed, predicateAtoms(n.input.id, n.pred))
				)
			case "ProjectSet": {
				const rename = this.projection(n)
				/** Each request as the input reads it: an input column the projection renames, or fixed to a constant the
				 * projection computes; none when a column is computed otherwise. */
				const inner: Array<Request<A>> = []
				for (const r of requests) {
					if (r.kind === "fixed") {
						inner.push(r)
						continue
					}
					const column = rename(r.name)
					if (column !== undefined) {
						inner.push({ kind: "column", name: column, asked: r.asked })
					} else if (this.constantColumn(n, r.name)) {
						inner.push({ kind: "fixed", asked: r.asked })
					} else {
						return []
					}
				}
				return this.resolve(n.input, inner, mapPushed(pushed, rename))
			}
			case "Union":
				return n.groups.flatMap((g) =>
					g.arms.flatMap((arm) => {
						const heading = arm.heading.map((c) => c.name)
						return requests.every((r) => r.kind === "fixed" || heading.includes(r.name))
							? this.resolve(arm, requests, restrict(pushed, heading))
							: []
					})
				)
			case "Base": {
				const facts: OccurrenceFacts = {
					source: n,
					eq: new Map(pushed.eq),
					range: new Map([...pushed.range].map(([c, b]) => [c, new Set(b)] as const)),
					span: new Set(pushed.span),
					partners: new Map(),
					classes: new Map()
				}
				const columns = requests.map((r): Answer<A> => ({
					asked: r.asked,
					resolved: r.kind === "fixed" ? fixedColumn : resolvedIn(facts, r.name)
				}))
				return [{ base: n, facts, others: [], columns }]
			}
			case "MatchRegion": {
				const region = regionFacts(n, pushed)
				/** Each request by its column's class, a fixed one as it is; none when a column has no class. */
				const classed: Array<Classed<A>> = []
				for (const r of requests) {
					if (r.kind === "fixed") {
						classed.push(r)
						continue
					}
					const k = region.classOf(r.name)
					if (k === undefined) {
						return []
					}
					classed.push({ kind: "class", k, asked: r.asked })
				}
				/** The answers of an occurrence that binds every requested class, none when it binds not every one. */
				const answers = (facts: OccurrenceFacts): ReadonlyArray<Answer<A>> | undefined => {
					const out: Array<Answer<A>> = []
					for (const c of classed) {
						if (c.kind === "fixed") {
							out.push({ asked: c.asked, resolved: fixedColumn })
							continue
						}
						const own = facts.classes.get(c.k)
						if (own === undefined) {
							return undefined
						}
						out.push({ asked: c.asked, resolved: resolvedIn(facts, own) })
					}
					return out
				}
				for (const facts of region.occurrences) {
					const source = facts.source
					if (source.kind !== "Base") {
						continue
					}
					const columns = answers(facts)
					if (columns !== undefined) {
						return [
							{
								base: source,
								facts,
								others: region.occurrences.filter((o) => o !== facts),
								columns
							}
						]
					}
				}
				return []
			}
			case "Attach":
				return requests.some((r) => r.kind === "column" && r.name === n.name)
					? []
					: this.resolve(n.parent, requests, pushed)
			case "SemiJoin":
			case "AntiJoin":
			case "Intersect":
			case "Difference":
				return this.resolve(n.left, requests, pushed)
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "Take":
			case "Group":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "OrderedResult":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
				return []
		}
	}

	/** The ordered path of a take, a page or a paged ordered program (see `extractAccess`). */
	ordered(input: RelNode, order: CompletedOrder, use: AccessUse, pushed: Pushed): void {
		const requests = order.keys.map((k): Request<OrderKey> => ({
			kind: "column",
			name: k.column,
			asked: k
		}))
		for (const r of this.resolve(input, requests, pushed)) {
			const path = this.orderedPath(r, use)
			if (path !== undefined) {
				this.paths.push(path)
			}
		}
	}

	/** The ordered path of one resolution of an ordered input: none when another occurrence of its region is
	 * restricted, its equalities already fix a key, the order reaches a vector column, no ordered column is stored, or
	 * the relation is a world's. */
	orderedPath(r: Resolution<OrderKey>, use: AccessUse): AccessPath | undefined {
		if (r.others.some((o) => restricted(o)) || r.base.relationKind === "world") {
			return undefined
		}
		const heading = r.base.heading
		if (this.keyWithin(r.base, new Set(r.facts.eq.keys())) !== undefined) {
			return undefined
		}
		const prefix = sorted(
			[...r.facts.eq]
				.filter(
					([c, k]) => k === "fixed" && !isSpanColumn(heading, c) && !isVectorColumn(heading, c)
				)
				.map(([c]) => c)
		)
		const seen = new Set(prefix)
		/** The columns already determined: the equalities, literal ones included, and the order so far. Once they
		 * contain a declared key the rest of the completed order breaks no tie, so the index stops there
		 * (`(account, priority DESC, id)`). */
		const determined = new Set(r.facts.eq.keys())
		const ordered: Array<AccessKey> = []
		for (const { asked: k, resolved } of r.columns) {
			const column = storedColumn(resolved)
			if (column === undefined || seen.has(column)) {
				continue
			}
			if (isVectorColumn(heading, column)) {
				return undefined
			}
			seen.add(column)
			determined.add(column)
			ordered.push({ field: column, dir: k.dir })
			if (this.keyWithin(r.base, determined) !== undefined) {
				break
			}
		}
		if (!isNonEmpty(ordered)) {
			return undefined
		}
		const [lead] = ordered
		return {
			relation: r.base.relation,
			derived: r.base.relationKind === "derived",
			method: "btree",
			keys: [...prefix.map((field): AccessKey => ({ field, dir: lead.dir })), ...ordered],
			use
		}
	}

	/** The HNSW path of an approximate retrieval whose score is the cosine distance of a stored vector column and a
	 * fixed vector. */
	nearest(n: RelNode, score: string): void {
		if (n.kind !== "ProjectSet") {
			return
		}
		const e = n.out.find((o) => o.name === score)?.expr
		if (e?.kind !== "op" || nativeOp(e.op)?.fn !== "cosineDistance") {
			return
		}
		const operands = e.args.map((a) => operandOf(n.input.id, a))
		/** The stored column operand and the other one. */
		const at = firstIndex(operands, (o) => o.kind === "column")
		const column = at === undefined ? undefined : operands[at]
		const other = at === undefined ? undefined : operands[1 - at]
		if (column?.kind !== "column" || other?.kind !== "fixed") {
			return
		}
		for (const r of this.resolve(n.input, columnRequests([column.name]), nothing)) {
			for (const { resolved } of r.columns) {
				const field = storedColumn(resolved)
				if (
					field === undefined ||
					r.base.relationKind === "world" ||
					!isVectorColumn(r.base.heading, field)
				) {
					continue
				}
				this.paths.push({
					relation: r.base.relation,
					derived: r.base.relationKind === "derived",
					method: "hnsw",
					keys: [{ field, dir: "asc" }],
					use: "approximate vector retrieval"
				})
			}
		}
	}

	/** Extended statistics on a group key of two or more stored columns of one occurrence. */
	groupStatistics(input: RelNode, keys: ReadonlyArray<string>): void {
		if (keys.length < 2) {
			return
		}
		for (const r of this.resolve(input, columnRequests(keys), nothing)) {
			const heading = r.base.heading
			const columns = sorted(
				r.columns.flatMap(({ resolved: c }) =>
					c.kind === "stored" && !isVectorColumn(heading, c.column) ? [c.column] : []
				)
			)
			if (columns.length < 2 || columns.length > statisticsMaxColumns) {
				continue
			}
			if (this.keyWithin(r.base, new Set(columns)) !== undefined) {
				continue
			}
			this.addStatistics({ relation: r.base.relation, columns, use: "grouping" })
		}
	}
}

/** The access paths and statistics a program's IR justifies, from its roots: the index requests one program's checked
 * IR justifies, a query's filters in their Allen normal form (`allenNormalDag`), under the fixed form policy below.
 *
 * The walk visits every node reachable from the program's roots once per distinct set of facts its consumers fix about
 * its heading ("pushed" facts), so the work is linear in the nodes times the probe contexts and is charged to the
 * compilation's node budget; it never enumerates column subsets or permutations. Pushed facts are
 * equalities with fixed values (parameters and outer values) or literals, ranges and span predicates against fixed
 * values, and pair relations between two of the node's columns, which a match region turns into join conditions. They
 * pass through a Filter, which adds its predicate's atoms (`predicateAtoms`), and through a projection by column reference;
 * they stop at a take, an approximate retrieval and a recursion, whose inputs PostgreSQL does not filter from outside.
 * A take's correlation, an attachment's correlation, the right side of a semi-join, anti-join, intersection or
 * difference, and a group's key columns pass what PostgreSQL can apply below them.
 *
 * In a match region every occurrence of a stored relation receives probe contexts (ProbeContext), each the columns one
 * probe binds: the base context, its own fixed equalities and ranges, and one context per join partner adding the
 * columns that partner fixes, each when it binds no span; and, when its own facts or a partner bind a span (a span
 * predicate, or a span column fixed by equality), the one span context of every column its fixed values and all its
 * partners bind together. A partner of at most one row per evaluation, by its source's logical cardinality (a context,
 * a write filter's row, a closed relation of one fact, a take of one), fixes its columns as a parameter does: what it
 * fixes joins the base context and every other, and it has no context of its own, so a write filter that reads a
 * relation at its row's values and at a claim, or at its row's values and at another relation's, requests one index of
 * both. A span predicate is requested only with every scalar something
 * binds beside it: a GiST index is read through its first column (`planIndexes`), and a context per partner asked for a
 * span predicate on `during` alone where another partner binds `subscription`, an index no plan reads. An occurrence
 * has no base context when a partner reaches it by its key and that partner drives through its own key (`drivesByKey`:
 * its own facts bind a key, or a span key's scalars and span): the region then has a plan through key indexes alone,
 * that partner first, and an index on the occurrence's own facts would serve only the other order, which PostgreSQL
 * takes only where the data favors it. The platform's rollupVersusLive asked DailySpend(workspace) beside Day's window,
 * which Day's span key serves; PostgreSQL read it at 100,000 usage events and in no drawn read at a million. The fixed
 * form policy turns each context into at most one path family:
 *
 * - a context whose equalities, literal ones included, contain a declared key is a key lookup on that key, which the
 *   key's own index serves: no index is drafted for lookups the primary keys already serve;
 * - otherwise, a span context: one GiST index per span field, the scalar equality columns first through btree_gist,
 *   then the span, and the GiST index subsumes the scalar prefix, so no B-tree is added;
 * - otherwise, with a range: a B-tree on the equality columns then one range column, the one bounded on both sides
 *   first and then by code point, unless every one of them is a handle column (below); a text column bounded on both
 *   sides is a prefix search;
 * - otherwise a B-tree on the equality columns.
 *
 * Equality columns are those equal to a parameter, an outer value, a join partner's column or a literal, in code point
 * order, so an index's name never depends on declaration or predicate order. A literal equality selects its column as
 * a parameter's does: a world entry's filter that fixes a column of another relation to a literal runs at every write
 * and must read that relation by an index, which a plain B-tree on the column serves; the policy builds no partial and
 * no expression access index, because a partial index needs the compiler and the query to agree on its predicate. An
 * equality path whose columns are all handle columns is none, so a low-cardinality handle column is never indexed
 * merely because a program names a handle: a roster of a few handles splits the rows into a few large groups, which
 * PostgreSQL reads by a scan, never by such an index. A vector column is never a B-tree column; it is reached only by
 * HNSW. Ordered paths come from a take (`take seek`) and a workload program whose root is an ordered result,
 * which reader.page can page (`page seek`): the equality columns of the occurrence that holds every column of the
 * completed order, then that order with its directions, when no other occurrence carries a fixed restriction that would
 * drive the plan instead: an index of its equality-filter fields followed by its completed order. An equality column
 * is fixed within the seek, so its direction is free; it takes the order's first key's direction, so the exact reverse
 * of an order is the exact reverse of its path, which one index serves forward and backward. An attachment's delivery order and a read-back's order are no seek: without a bound
 * every child row is read anyway, so only the correlation's equality path is requested. ApproximateNearest over a
 * cosine distance of a stored vector column and a fixed vector requests HNSW with the cosine operator class.
 *
 * Extended statistics follow the same route: equality
 * selections on two to eight columns of one occurrence, literal ones included, and a group key of two to eight stored
 * columns of one occurrence, each unless a declared key lies among the columns, where estimates are already exact. */
export const extractAccess = (
	roots: ReadonlyArray<RelNode>,
	options: ExtractOptions
): Result.Result<ProgramAccess, CompileError> => {
	const x = new Extractor(options)
	for (const root of roots) {
		const r = x.visit(root, nothing)
		if (!r.ok) {
			return r
		}
	}
	return Result.ok({
		paths: uniquePaths(x.paths),
		statistics: [...x.statistics.values()].toSorted(statisticsOrder)
	})
}
