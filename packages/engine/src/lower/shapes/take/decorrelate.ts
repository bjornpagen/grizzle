import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId, OccurrenceId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	type Cell,
	type Correlation,
	type EditNode,
	type EditRefs,
	exprsOf,
	type Heading,
	type HeadingColumn,
	type KindOver,
	type OccurrenceOver,
	type RelNode,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { columnRefs, DagEditor } from "#compiler/lower/optimize/demand/editor.ts"

/**
 * A query restated by everyParentTakes, and the node standing in the restated DAG in place of each node of the query's
 * DAG, which a reader of the input DAG's nodes (a write's actions and read-backs) names the restated DAG's by.
 */
export interface RestatedQuery<Q extends LogicalQuery> {
	readonly query: Q
	readonly node: (node: RelNode) => RelNode
}

const unchanged = (node: RelNode): RelNode => node

interface OuterConstant {
	readonly occurrence: OccurrenceId
	readonly column: string
	readonly expr: ScalarExpr
}

/** A node of the chain between a take and its region, with the cell it stands in. */
interface ChainLink {
	readonly cell: Cell
	readonly node: KindOver<"ProjectSet" | "Filter", EditRefs>
}

interface Candidate {
	/** The take's cell and its body when the candidate was found. */
	readonly cell: Cell
	readonly take: KindOver<"Take", EditRefs>
	/** From the take's input down to, not including, the region. */
	readonly chain: ReadonlyArray<ChainLink>
	readonly regionCell: Cell
	readonly region: KindOver<"MatchRegion", EditRefs>
	readonly outer: ReadonlyArray<OuterConstant>
}

/** The take in `cell` as a candidate, or undefined when the rewrite's conditions do not all hold. */
const candidateAt = (ed: DagEditor, cell: Cell): Candidate | undefined => {
	const take = cell.current
	if (take.kind !== "Take" || ed.isRoot(cell)) {
		return undefined
	}
	if (take.correlation.some((c) => columnRefs([c.expr]).length > 0)) {
		return undefined
	}
	/** One reader through one input position (DagEditor.readers): a region matching the take twice reads it twice. */
	const readers = DagEditor.readers(ed.topoOrder())
	const [consumer, ...others] = readers(cell)
	if (consumer === undefined || others.length > 0) {
		return undefined
	}
	if (consumer.current.kind !== "MatchRegion") {
		return undefined
	}
	const chain: Array<ChainLink> = []
	let at = take.input
	for (;;) {
		if (ed.refCount(at, readers) !== 1) {
			return undefined
		}
		const node = at.current
		if (node.kind === "ProjectSet" || node.kind === "Filter") {
			chain.push({ cell: at, node })
			at = node.input
			continue
		}
		if (node.kind !== "MatchRegion") {
			return undefined
		}
		const reading = node.occurrences
			.flatMap((o) => o.constants.map((c) => ({ o, c, refs: columnRefs([c.expr]) })))
			.filter(({ refs }) => refs.length > 0)
		if (reading.some(({ refs }) => refs.some((r) => r.node !== consumer.id))) {
			return undefined
		}
		const outer: ReadonlyArray<OuterConstant> = reading.map(({ o, c }) => ({
			occurrence: o.id,
			column: c.column,
			expr: c.expr
		}))
		if (outer.length === 0) {
			return undefined
		}
		/** Nothing else in the take's input reads a node outside it. */
		const inside = DagEditor.subtree(take.input)
		const insideLabels = new Set<NodeId>([...inside].map((n) => n.id))
		const rewritten = new Set(outer.map((c) => c.expr))
		const region = at
		const readsOutside = [...inside].some((n) =>
			columnRefs(exprsOf(n.current).filter((e) => !(n === region && rewritten.has(e)))).some(
				(r) => !insideLabels.has(r.node)
			)
		)
		return readsOutside ? undefined : { cell, take, chain, regionCell: region, region: node, outer }
	}
}

/** The consumer leaves the take's new columns unbound, as existential witnesses: the correlation already equates them. */
const rewrite = (ed: DagEditor, c: Candidate): void => {
	const taken = new Set<string>([
		...c.region.vars.map((v) => v.name),
		...c.region.heading.map((h) => h.name),
		...c.chain.flatMap((link) => link.node.heading.map((h) => h.name)),
		...c.take.heading.map((h) => h.name)
	])
	/** The region: each outer constant becomes a binding to a variable it delivers. */
	const vars = [...c.region.vars]
	const heading = [...c.region.heading]
	const occurrences = new Map<OccurrenceId, OccurrenceOver<Cell, ScalarExpr, VarDecl>>(
		c.region.occurrences.map((o) => [o.id, o])
	)
	const added: Array<{ readonly column: HeadingColumn; readonly expr: ScalarExpr }> = []
	for (const k of c.outer) {
		const occurrence = defined(
			occurrences.get(k.occurrence),
			"an outer constant's occurrence of the region"
		)
		const source = defined(
			occurrence.source.current.heading.find((h) => h.name === k.column),
			"an outer constant's column of its occurrence's source"
		)
		/**
		 * A bound column delivers the variable its binding names, which the region declares; an unbound one delivers
		 * a fresh variable, named apart from every column in play.
		 */
		const bound = occurrence.bindings.find((b) => b.column === k.column)
		const variable: VarDecl =
			bound === undefined
				? { id: ed.freshVar(), name: DagEditor.freshName(taken, k.column), type: source.type }
				: bound.var
		const column: HeadingColumn = { name: variable.name, type: variable.type }
		if (bound === undefined) {
			vars.push(variable)
		}
		occurrences.set(k.occurrence, {
			...occurrence,
			constants: occurrence.constants.filter((x) => x.column !== k.column || x.expr !== k.expr),
			bindings:
				bound === undefined
					? [...occurrence.bindings, { column: k.column, var: variable }]
					: occurrence.bindings
		})
		const present = heading.find((h) => h.name === variable.name)
		if (present === undefined) {
			heading.push(column)
		}
		added.push({ column: present ?? column, expr: k.expr })
	}
	ed.set(c.regionCell, { ...c.region, vars, occurrences: [...occurrences.values()], heading })
	/** The chain, bottom up: each projection carries the new columns, each filter delivers its input's heading. */
	let below: { readonly cell: Cell; readonly heading: Heading } = { cell: c.regionCell, heading }
	for (const link of [...c.chain].toReversed()) {
		const n = link.node
		const extra = added
			.map((a) => a.column)
			.filter((col) => !n.heading.some((h) => h.name === col.name))
		const next: EditNode =
			n.kind === "Filter"
				? { ...n, heading: below.heading }
				: {
						...n,
						out: [
							...n.out,
							...extra.map((col) => ({ name: col.name, expr: ed.column(below.cell, col) }))
						],
						heading: [...n.heading, ...extra]
					}
		ed.set(link.cell, next)
		below = { cell: link.cell, heading: next.heading }
	}
	/** The take: the new columns in its heading, each fixed by its parent's value. */
	const correlation: ReadonlyArray<Correlation> = [
		...c.take.correlation,
		...added.map((a) => ({ column: a.column.name, expr: a.expr }))
	]
	ed.set(c.cell, { ...c.take, heading: below.heading, correlation })
}

/**
 * The query with every bind-correlated take restated over every parent, or the query itself when there is none, and
 * each node's counterpart in it.
 *
 * A take correlated through `bind`, stated with its correlation explicit for the take policy (lower/shapes/take).
 *
 * It is the take policy's own rewrite of the logical DAG, in the lower layer, before any lowering: every compiler that
 * lowers a take restates its DAG through it first, the query compiler (program/compile.ts), a derived relation's
 * definition (physical/derived/definition.ts) and the write front end for the optimized artifact
 * (write/frontend/compile.ts).
 *
 * The take shapes read a take's correlation from its `correlation` list, which the checker fills for
 * an attachment's child (check/checker.ts take). A take correlated through `bind` instead reaches the lowering with an
 * empty list: the importer's outer value is an occurrence constant inside the take's input, a column of the import's
 * match fixed to a column of the importing region, so the take is lowered as an uncorrelated ORDER BY ... LIMIT and
 * its consumer reads it LATERAL, one LIMIT probe per parent row whatever the parent set, the per-row pathology the take
 * policy exists to rule out over a whole relation.
 *
 * everyParentTakes restates each such take with its correlation explicit, an equivalent DAG the take policy then lowers
 * by its parent set: a query's (program/compile.ts) LATERAL for a small bound set, per execution for a relation
 * parameter's facts, over every group otherwise; a derived-relation definition's (physical/derived/definition.ts),
 * which "always wants every group, so it never takes the correlated form", over every group (DISTINCT ON for k = 1,
 * row_number otherwise); a write's optimized artifact's like a query's:
 *
 *   region O { ..., occurrence of T binding (h...) }
 *   T = Take(k, order) over (ProjectSet | Filter)* over region R { occurrence s with constant c = <expr over O> }
 *
 * becomes
 *
 *   R binds s.c to a fresh variable x, delivered beside its heading and carried up through every projection and filter
 *   to T; T's heading gains x and its correlation is x = <expr over O>; O leaves T's x existential.
 *
 * Per parent the two agree: the parent fixes x, so the rows of T's input with that x are exactly the rows the original
 * input delivers for that parent, a projection keeps them a set because x is constant within the group, and the
 * completed order, which never named the fixed column, stays total with x among the correlation columns (valid DAG
 * Take). The rewrite applies only where that argument holds as stated: T has no correlation of its own and one reader,
 * the region O, through one occurrence; the chain between T and R is ProjectSet and Filter nodes, each read only by
 * the next; R is read only by the chain; each constant rewritten reads only O; and nothing else in T's input reads a
 * node outside it. Any other take is left as it is.
 */
export const everyParentTakes = <Q extends LogicalQuery>(
	query: Q
): Result.Result<RestatedQuery<Q>, CompileError> =>
	Result.flatMap(
		catchRefusal(() => {
			const ed = new DagEditor(query.dag)
			let changed = false
			for (const cell of ed.topoOrder()) {
				const candidate = candidateAt(ed, cell)
				if (candidate === undefined) {
					continue
				}
				rewrite(ed, candidate)
				changed = true
			}
			if (!changed) {
				return Result.ok({ query, node: unchanged })
			}
			const done = ed.finished()
			return Result.ok({
				query: { ...query, dag: done.dag },
				node: (n: RelNode) => done.node(ed.cellOf(n))
			})
		}),
		(r) => r
	)
