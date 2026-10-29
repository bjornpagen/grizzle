import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import type { ColumnRef, OpId, ScalarExpr } from "#compiler/ir/expr.ts"
import type { Cell, EditNode, EditRefs, HeadingColumn, KindOver } from "#compiler/ir/rel.ts"
import { baseOf, sameScalarType } from "#compiler/ir/scalar.ts"
import { columnRefs, DagEditor, paramRefs, total } from "#compiler/lower/optimize/demand/editor.ts"
import {
	type Measure,
	multiset,
	nodePremises,
	type RewriteCx,
	type Rule
} from "#compiler/lower/optimize/demand/frame.ts"
import { conjuncts } from "#compiler/lower/optimize/simplify/boolean.ts"
import {
	carriedColumns,
	positiveLinear,
	printsAlike
} from "#compiler/lower/shapes/attach-recursive/carried.ts"
import { overloadOf } from "#compiler/scalar/compute/registry.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"

/**
 * Proved root pushdown: a predicate on a completed recursion's carried columns placed in its seed.
 *
 * A bound root is pushed into a recursion's seed only when equivalence is proved. An endpoint filter is not
 * automatically a seed filter, and a predicate on final results is not automatically safe at every intermediate
 * vertex. The proof here is the carried-column argument (shapes/attach-recursive/carried.ts): when the step delivers
 * a state column unchanged from the state it extends, every state of the fixed point has its seed's value in that
 * column. With positive linear feedback every state has a derivation from one seed through states that all share
 * that seed's carried values, so for a predicate p over carried columns only
 *
 *   sigma_p(lfp(B, T)) = lfp(sigma_p(B), T)
 *
 * and the recursion seeded by sigma_p(B) explores only the roots the consumer keeps. The column the traversal advances
 * (the endpoint) is not carried, so an endpoint filter never moves (the generator's endFilterIntoSeed mutant), nor
 * does a predicate the step must satisfy at every state (neFilterIntoStep): only a carried column is a seed filter.
 *
 * The sites, each a predicate the consumer applies to a recursion R it alone reads:
 *
 * - graph.seedPushdown.filter: a conjunct of a filter directly over R;
 * - graph.seedPushdown.constant: a constant an occurrence of R in a region fixes a column to, `match(R, { root: p })`;
 * - graph.seedPushdown.region: a conjunct of a filter over a region that reads only region variables bound by one
 *   occurrence of R, `match(R, { root, node }).where(r.eq(root, p))`.
 *
 * Each conjunct must be total, so evaluating it on the seed raises nothing the consumer would not; it
 * reads R's columns or its region variables and parameters, nothing correlated; and every column it reads must be
 * carried and of a type whose equal values print alike, so the predicate on the seed's spelling is the predicate on
 * the state's (carried.ts printsAlike). R must be read only by the site's node, through one data input (a region
 * matching R twice reads it twice, DagEditor.readers), so restricting R changes no other consumer; it is never a
 * root, never on another recursion's step (the frame skips the feedback region), and its feedback is positive and
 * linear. The predicate is added to R's base as a filter and also stays where it was: the consumer's predicate is then
 * implied, and keeping it changes nothing and needs no proof that the consumer's own value is the state's.
 *
 * Measure: the multiset, over every site predicate not yet in its recursion's seed, of the number of Recursive nodes
 * in that recursion's subtree. A push places the predicate in the seed, which removes it from the multiset; the new
 * seed filter can itself be a site only of a recursion inside R's base, whose subtree holds fewer Recursive nodes.
 */
export const seedRules = {
	filter: "graph.seedPushdown.filter",
	constant: "graph.seedPushdown.constant",
	region: "graph.seedPushdown.region"
} as const

type Recursive = KindOver<"Recursive", EditRefs>

/** A predicate the consumer of a recursion applies, and how it reads over the recursion's base. */
interface Site {
	readonly rule: (typeof seedRules)[keyof typeof seedRules]
	/** The cell that applies it: a filter or a region. */
	readonly at: Cell
	/** The recursion's cell, and the recursion it holds. */
	readonly recursive: Cell
	readonly rec: Recursive
	/** The predicate as it is spelled at the site: a filter conjunct, or a constant's expression. */
	readonly expr: ScalarExpr
	readonly form: SiteForm
}

/**
 * How a site's predicate reads the recursion's state: a filter conjunct through the state column each of its column
 * references reads, or a constant an occurrence fixes the state column `column` to (the base's column of that name),
 * compared by the native equality `op`.
 */
type SiteForm =
	| { readonly kind: "conjunct"; readonly column: (ref: ColumnRef) => string | undefined }
	| { readonly kind: "constant"; readonly column: HeadingColumn; readonly op: OpId }

/**
 * The recursion `cell` holds when `reader` reads it as its one consumer, provably restrictable at its seed, with its
 * carried columns of types whose equal values print alike.
 */
const restrictable = (cx: RewriteCx, cell: Cell, reader: Cell): ReadonlySet<string> | undefined => {
	const ed = cx.editor
	const node = cell.current
	if (node.kind !== "Recursive") {
		return undefined
	}
	if (ed.isRoot(cell) || ed.readsFeedback(cell)) {
		return undefined
	}
	const readers = ed.readers()(cell)
	if (readers.length !== 1 || readers[0] !== reader) {
		return undefined
	}
	if (cx.demand().lateral(cell)) {
		return undefined
	}
	/** The recursion as the current DAG holds it, whose step the carried-column argument reads. */
	const finished = cx.dag().node(cell)
	if (finished.kind !== "Recursive" || !positiveLinear(finished)) {
		return undefined
	}
	const names = new Set(node.base.current.heading.map((c) => c.name))
	if (!node.heading.every((c) => names.has(c.name))) {
		return undefined
	}
	const carried = carriedColumns(finished)
	return new Set(
		node.heading.filter((c) => carried.has(c.name) && printsAlike(c.type)).map((c) => c.name)
	)
}

/**
 * Whether a conjunct reads, apart from parameters and literals, only columns `column` maps to `allowed` state
 * columns, at least one of them, and cannot fail.
 */
const readsOnly = (
	expr: ScalarExpr,
	column: (ref: ColumnRef) => string | undefined,
	allowed: ReadonlySet<string>
): boolean => {
	if (!total([expr])) {
		return false
	}
	const refs = columnRefs([expr])
	return (
		refs.length > 0 &&
		refs.every((r) => {
			const c = column(r)
			return c !== undefined && allowed.has(c)
		})
	)
}

const filterSites = (
	cx: RewriteCx,
	cell: Cell,
	f: KindOver<"Filter", EditRefs>
): ReadonlyArray<Site> => {
	const inputCell = f.input
	const input = inputCell.current
	if (input.kind === "Recursive") {
		const allowed = restrictable(cx, inputCell, cell)
		if (allowed === undefined) {
			return []
		}
		const column = (ref: ColumnRef) => (ref.node === inputCell.id ? ref.name : undefined)
		return conjuncts(f.pred)
			.filter((c) => readsOnly(c, column, allowed))
			.map((expr) => ({
				rule: seedRules.filter,
				at: cell,
				recursive: inputCell,
				rec: input,
				expr,
				form: { kind: "conjunct", column }
			}))
	}
	if (input.kind !== "MatchRegion") {
		return []
	}
	/** A conjunct over region variables that one occurrence of a recursion binds. */
	const out: Array<Site> = []
	for (const o of input.occurrences) {
		const rec = o.source.current
		if (rec.kind !== "Recursive") {
			continue
		}
		const allowed = restrictable(cx, o.source, inputCell)
		if (allowed === undefined) {
			continue
		}
		const byName = new Map(
			input.vars.flatMap((v) => {
				const bound = o.bindings.find((b) => b.var.id === v.id && allowed.has(b.column))
				return bound !== undefined &&
					rec.heading.some((c) => c.name === bound.column && sameScalarType(v.type, c.type))
					? [[v.name, bound.column] as const]
					: []
			})
		)
		const column = (ref: ColumnRef) =>
			ref.node === inputCell.id ? byName.get(ref.name) : undefined
		out.push(
			...conjuncts(f.pred)
				.filter((expr) => readsOnly(expr, column, allowed))
				.map((expr): Site => ({
					rule: seedRules.region,
					at: cell,
					recursive: o.source,
					rec,
					expr,
					form: { kind: "conjunct", column }
				}))
		)
	}
	return out
}

const constantSites = (
	cx: RewriteCx,
	cell: Cell,
	region: KindOver<"MatchRegion", EditRefs>
): ReadonlyArray<Site> => {
	const out: Array<Site> = []
	for (const o of region.occurrences) {
		const rec = o.source.current
		if (rec.kind !== "Recursive") {
			continue
		}
		const allowed = restrictable(cx, o.source, cell)
		if (allowed === undefined) {
			continue
		}
		const baseHeading = rec.base.current.heading
		out.push(
			...o.constants.flatMap((c): ReadonlyArray<Site> => {
				if (!allowed.has(c.column) || columnRefs([c.expr]).length > 0 || !total([c.expr])) {
					return []
				}
				const stateColumn = rec.heading.find((h) => h.name === c.column)
				const seedColumn = baseHeading.find((h) => h.name === c.column)
				const eq =
					stateColumn === undefined
						? undefined
						: overloadOf("eq", [baseOf(stateColumn.type).carrier, baseOf(c.expr.type).carrier])
				return eq === undefined || seedColumn === undefined
					? []
					: [
							{
								rule: seedRules.constant,
								at: cell,
								recursive: o.source,
								rec,
								expr: c.expr,
								form: { kind: "constant", column: seedColumn, op: eq.id }
							}
						]
			})
		)
	}
	return out
}

const sitesAt = (cx: RewriteCx, cell: Cell): ReadonlyArray<Site> => {
	const node = cell.current
	if (node.kind === "Filter") {
		return filterSites(cx, cell, node)
	}
	if (node.kind === "MatchRegion") {
		return constantSites(cx, cell, node)
	}
	return []
}

/** The conjuncts of the filters stacked at a recursion's base, outermost first. */
const seedConjuncts = (rec: Recursive): ReadonlyArray<ScalarExpr> => {
	const out: Array<ScalarExpr> = []
	for (let n: EditNode = rec.base.current; n.kind === "Filter"; n = n.input.current) {
		out.push(...conjuncts(n.pred))
	}
	return out
}

/**
 * The base column a filter conjunct over the recursion's seed reads for each state column: the column of the same
 * name of whichever cell in the base's filter chain the conjunct names.
 */
const seedColumn = (rec: Recursive, ref: ColumnRef): string | undefined => {
	for (let at = rec.base; ;) {
		if (at.id === ref.node) {
			return ref.name
		}
		const n = at.current
		if (n.kind !== "Filter") {
			return undefined
		}
		at = n.input
	}
}

/**
 * Whether `x`, read at the site, is `y`, read over the seed: the same tree, with each column reference reading the
 * same state column.
 */
const sameAtSeed = (
	rec: Recursive,
	column: (ref: ColumnRef) => string | undefined,
	x: ScalarExpr,
	y: ScalarExpr
): boolean => {
	if (
		x.kind !== y.kind ||
		x.args.length !== y.args.length ||
		!canonicalEquals(x.type, y.type, everyProperty)
	) {
		return false
	}
	const argsAlike = (): boolean =>
		x.args.every((arg, i) => {
			const other = y.args[i]
			return other !== undefined && sameAtSeed(rec, column, arg, other)
		})
	switch (x.kind) {
		case "column": {
			if (y.kind !== "column") {
				return false
			}
			const s = column(x.column)
			return s !== undefined && seedColumn(rec, y.column) === s
		}
		case "param":
			return y.kind === "param" && x.param === y.param && x.role === y.role
		case "literal":
			return y.kind === "literal" && canonicalEquals(x.value, y.value, everyProperty)
		case "op":
			return y.kind === "op" && x.op === y.op && argsAlike()
		case "cast":
			return y.kind === "cast" && x.checked === y.checked && argsAlike()
		case "value":
		case "domainCast":
		case "cond":
			return argsAlike()
	}
}

/** An expression with its arguments by label: what two constants are compared as, each argument by its own label. */
const shallow = (e: ScalarExpr): unknown => ({ ...e, args: e.args.map((a) => a.id) })

/** Whether the seed already applies the site's predicate. */
const pushed = (site: Site): boolean => {
	const present = seedConjuncts(site.rec)
	const form = site.form
	if (form.kind === "constant") {
		const { column, op } = form
		return present.some((e) => {
			const [l, r] = e.args
			if (
				e.kind !== "op" ||
				e.op !== op ||
				e.args.length !== 2 ||
				l === undefined ||
				r === undefined
			) {
				return false
			}
			return (
				l.kind === "column" &&
				seedColumn(site.rec, l.column) === column.name &&
				canonicalEquals(shallow(r), shallow(site.expr), { omit: (k) => k === "id" || k === "deps" })
			)
		})
	}
	return present.some((p) => sameAtSeed(site.rec, form.column, site.expr, p))
}

/** Every site not yet pushed, over the reachable DAG. */
const openSites = (cx: RewriteCx): ReadonlyArray<Site> => {
	const ed = cx.editor
	const out: Array<Site> = []
	for (const cell of ed.topoOrder()) {
		if (ed.readsFeedback(cell)) {
			continue
		}
		out.push(...sitesAt(cx, cell).filter((s) => !pushed(s)))
	}
	return out
}

const recursionsBelow = (cx: RewriteCx, cell: Cell): number =>
	[...cx.editor.subtree(cell)].filter((c) => c.current.kind === "Recursive").length

export const seedMeasure: Measure = (cx) =>
	multiset(openSites(cx).map((s) => recursionsBelow(cx, s.recursive)))

/** The site's predicate over the recursion's current base. */
const seedPredicate = (cx: RewriteCx, site: Site): ScalarExpr => {
	const ed = cx.editor
	const base = site.rec.base
	const form = site.form
	if (form.kind === "constant") {
		return ed.expr({
			kind: "op",
			op: form.op,
			args: [ed.column(base, form.column), site.expr],
			type: plainType("bool"),
			nonNull: "strict",
			volatility: "immutable",
			failure: "total"
		})
	}
	return ed.copyExpr(site.expr, (ref, e) => {
		const s = form.column(ref)
		if (s === undefined) {
			return undefined
		}
		return ed.expr({
			kind: "column",
			column: { node: base.id, name: s },
			args: [],
			type: e.type,
			nonNull: e.nonNull
		})
	})
}

const push = (cx: RewriteCx, site: Site): void => {
	const ed: DagEditor = cx.editor
	const rec = site.rec
	const baseCell = rec.base
	const base = baseCell.current
	const pred = seedPredicate(cx, site)
	const filter = ed.add({
		kind: "Filter",
		input: baseCell,
		pred,
		heading: base.heading,
		meta: DagEditor.subsetMeta(base.meta),
		loc: undefined
	})
	ed.set(site.recursive, { ...rec, base: filter, meta: DagEditor.subsetMeta(rec.meta) })
	const params: Array<ParamId> = [...paramRefs([pred])]
	cx.certify({
		rule: site.rule,
		inputs: [site.at.id, site.recursive.id],
		outputs: [site.recursive.id, filter.id],
		/** The proof reads the step and its feedback scan: which columns the step carries, and that it is linear. */
		premises: nodePremises(rec.step.id, rec.self.id),
		context: "queryLocal",
		preservedHeading: rec.heading.map((c) => c.name),
		equality: site.form.kind === "constant" ? [site.form.op] : [],
		coercion: [],
		params: params.length === 0 ? undefined : params
	})
}

export const seedPushdown: Rule = {
	name: "graph.seedPushdown",
	at: (cell, cx) => {
		const site = sitesAt(cx, cell).find((s) => !pushed(s))
		if (site === undefined) {
			return false
		}
		push(cx, site)
		return true
	}
}
