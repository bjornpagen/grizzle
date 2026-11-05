import { analyzeDemand, type DemandAnalysis, noPins } from "#compiler/analysis/demand/demand.ts"
import {
	analyzePhysical,
	type PhysicalAnalysis,
	type PhysicalNode,
	unplaced
} from "#compiler/analysis/physical/analyze.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { invariant } from "#compiler/core/invariant.ts"
import type * as Result from "#compiler/core/result.ts"
import { type Certificate, makeCertificate } from "#compiler/ir/certificate.ts"
import type { FinishedCells } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, Premise } from "#compiler/ir/evidence.ts"
import type { Pass, PassContext } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	type Cell,
	type EditNode,
	exprsOf,
	inputsOf,
	type RelDag,
	type Rooted,
	type Roots,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { columnRefs, DagEditor } from "#compiler/lower/optimize/demand/editor.ts"

/**
 * Demand analysis (analysis/demand) of one snapshot of the editor, read cell by cell: each cell is read as its node in
 * that snapshot, so a reading taken before a rewrite still reads the DAG it analyzed after it.
 */
export interface CellDemand {
	readonly analysis: DemandAnalysis
	readonly demanded: (cell: Cell) => ReadonlySet<string>
	readonly liveVars: (cell: Cell) => ReadonlySet<VarDecl>
	readonly references: (cell: Cell) => number
	/**
	 * Whether a scope expression reads a column of the cell's node (demand analysis's lateral reads): a correlated
	 * source, or a constant of a region the node is an occurrence's source of, names it, so moving or replacing it would
	 * change what that reference names.
	 */
	readonly lateral: (cell: Cell) => boolean
}

/** The demand analysis of a snapshot, read cell by cell. */
export const cellDemand = (
	snapshot: FinishedCells<Roots>,
	analysis: DemandAnalysis
): CellDemand => ({
	analysis,
	demanded: (cell) => analysis.demanded(snapshot.node(cell)),
	liveVars: (cell) => analysis.liveVars(snapshot.node(cell)),
	references: (cell) => analysis.references(snapshot.node(cell)),
	lateral: (cell) => analysis.lateral(snapshot.node(cell))
})

/** The physical analysis (analysis/physical) of one snapshot of the editor, read cell by cell. */
export interface CellPhysical {
	readonly analysis: PhysicalAnalysis
	readonly of: (cell: Cell) => PhysicalNode
}

/** What a rule sees while it decides and rewrites. */
export interface RewriteCx {
	readonly editor: DagEditor
	readonly ctx: PassContext
	readonly pass: string
	readonly catalog: EvidenceCatalog
	/** The current DAG, finished, and each cell's node in it, memoized until a change. */
	readonly dag: () => FinishedCells<Roots>
	/** The demand analysis of the current DAG. */
	readonly demand: () => CellDemand
	/** The physical analysis of the current DAG in the artifact's evidence context. */
	readonly physical: () => CellPhysical
	/** Records a rewrite's certificate in the context's log; a refused certificate fails the pass. */
	readonly certify: (input: Certificate) => void
}

export interface Rule {
	readonly name: string
	/**
	 * Rewrites at `cell` and returns true, or changes nothing and returns false, deciding by nothing but what it reads at
	 * the cell (affectedBy) and the compilation's catalog.
	 */
	readonly at: (cell: Cell, cx: RewriteCx) => boolean
}

/**
 * A pass's potential: a natural number of the DAG that every rewrite of the pass strictly lowers. It is polynomial in
 * the size of the DAG the pass starts from, so the pass takes at most its first value in steps, which is the pass's
 * whole bound: no step budget beside it.
 */
export type Potential = (cx: RewriteCx) => number

interface RewritePassSpec {
	readonly name: string
	readonly rules: ReadonlyArray<Rule>
	/** The pass's potential, chosen once from the DAG the pass starts from. */
	readonly potential: (start: RewriteCx) => Potential
}

/** The success of a compile result, or a refusal that fails the pass with its error. */
const unwrap = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/** A node premise for each node a proof reads. */
export const nodePremises = (ids: ReadonlyArray<NodeId>): ReadonlyArray<Premise> =>
	ids.map((node) => ({ kind: "node", node }))

/**
 * The frame's end: the edited DAG finished. A frame that changed nothing delivers the DAG it started from, which is
 * what finishing it would build again: every node of a DAG is final when it is built.
 */
const settle = (query: LogicalQuery, editor: DagEditor<Rooted>): LogicalQuery =>
	editor.version === 0 ? query : { ...query, dag: editor.finish() }

/** The physical analysis of a finished DAG in a pass context's evidence context, under its catalog. */
const physicalOf = (dag: RelDag, ctx: PassContext): PhysicalAnalysis =>
	analyzePhysical(dag, {
		context: ctx.evidenceContext,
		catalog: ctx.catalog,
		realization: unplaced,
		roots: "result"
	})

/** A memo before its first read, or since its reset. */
const unread = { kind: "unread" } as const

/** A value computed on its first read and kept until it is reset. */
class Memo<A> {
	#state: { readonly kind: "unread" } | { readonly kind: "read"; readonly value: A } = unread

	get(compute: () => A): A {
		const value = this.#state.kind === "read" ? this.#state.value : compute()
		this.#state = { kind: "read", value }
		return value
	}

	reset(): void {
		this.#state = unread
	}
}

/** The rewrite cx over one editor, under the compilation's catalog. */
const rewriteCx = (editor: DagEditor, ctx: PassContext, pass: string): RewriteCx => {
	const catalog = ctx.catalog
	/** The editor version the memos below were computed at; undefined before the first read. */
	let version: number | undefined
	const dag = new Memo<FinishedCells<Roots>>()
	const demand = new Memo<CellDemand>()
	const physical = new Memo<CellPhysical>()
	const fresh = () => {
		if (version === editor.version) {
			return
		}
		version = editor.version
		dag.reset()
		demand.reset()
		physical.reset()
	}
	const current = (): FinishedCells<Roots> => {
		fresh()
		return dag.get(() => editor.finished())
	}
	const cx: RewriteCx = {
		editor,
		ctx,
		pass,
		catalog,
		dag: current,
		demand: () => {
			const snapshot = current()
			return demand.get(() => cellDemand(snapshot, analyzeDemand(snapshot.dag, noPins)))
		},
		physical: () => {
			const snapshot = current()
			return physical.get(() => {
				const analysis = physicalOf(snapshot.dag, ctx)
				return { analysis, of: (cell) => analysis.of(snapshot.node(cell)) }
			})
		},
		certify: (input) => {
			const cert = unwrap(makeCertificate(input))
			ctx.certificates.record(cert)
		}
	}
	return cx
}

/**
 * The pass over a checked query: rules applied to a fixed point, each step strictly lowering the pass's potential.
 *
 * The driver every relational rewrite pass runs under.
 *
 * A rewrite pass is a set of rules, each recognizing one pattern at one node and replacing it by an equivalent form
 * through the editor. The driver applies the first rule that matches at the first node, inputs first, where one does,
 * and stops when no rule matches anywhere. Its termination is the pass's potential (Potential): a natural number of
 * the DAG, polynomial in the size of the DAG the pass starts from, that every applied rewrite strictly lowers, so a
 * pass takes at most its first value in steps and needs no step budget. A step that does not lower it is a defect of
 * the rule, grizzle's and never the query's, so it breaks an internal invariant (core/invariant.ts).
 *
 * The driver keeps a worklist of the nodes a rule may match, which it visits in topological order: after a rewrite only
 * the nodes whose view the rewrite changed are visited again (affectedBy), so every other node, which matched no rule
 * before, matches none now, and the first match the worklist finds is the first match anywhere: the rewrites are the
 * ones a scan of the whole DAG from its first node after every step would apply, in the same order.
 *
 * Every applied rewrite records a certificate: its rule, the nodes it read and wrote, the premises
 * its proof used, the evidence context it requires, the heading it preserves, and through its constraint premises the
 * installed constraints it rests on. Rewrites run only in the optimized lowering, the one that
 * runs passes; the conservative one uses no certificate.
 *
 * The feedback region of a recursion is the recursive lowering's.
 */
export const rewritePass = (spec: RewritePassSpec): Pass<LogicalQuery, LogicalQuery> => ({
	name: spec.name,
	measure: "bounded-worklist",
	run: (query, ctx) =>
		catchRefusal(() => {
			const editor = new DagEditor(query.dag)
			const cx = rewriteCx(editor, ctx, spec.name)
			const potential = spec.potential(cx)
			const pending = new Set<Cell>(editor.topoOrder())
			let before = potential(cx)
			for (
				let fired = fireNext(editor, spec.rules, cx, pending);
				fired !== undefined;
				fired = fireNext(editor, spec.rules, cx, pending)
			) {
				const after = potential(cx)
				invariant(
					Number.isInteger(after) && after >= 0 && after < before,
					`the ${spec.name} rewrite ${fired.rule.name} at node ${fired.cell.id} strictly lowers its pass's potential, a natural; ${before} became ${after}`
				)
				before = after
			}
			return settle(query, editor)
		})
})

/** A rule that fired, and the cell it fired at. */
interface Fired {
	readonly cell: Cell
	readonly rule: Rule
}

/** What the driver keeps of the DAG before a step: each reachable cell's node, and how many roots stand at each. */
interface Before {
	readonly nodes: ReadonlyMap<Cell, EditNode>
	readonly roots: ReadonlyMap<Cell, number>
}

/** How many of `roots` stand at each cell. */
const rootCounts = (roots: ReadonlyArray<Cell>): ReadonlyMap<Cell, number> => {
	const counts = new Map<Cell, number>()
	for (const r of roots) {
		counts.set(r, (counts.get(r) ?? 0) + 1)
	}
	return counts
}

/**
 * Applies the first rule that fires at the first pending cell in topological order where one does, and makes every cell
 * the rewrite affected pending again (affectedBy); a pending cell no rule fires at leaves the worklist. No rule is
 * applied at a cell that reads a recursion's feedback.
 */
const fireNext = (
	editor: DagEditor,
	rules: ReadonlyArray<Rule>,
	cx: RewriteCx,
	pending: Set<Cell>
): Fired | undefined => {
	const order = editor.topoOrder()
	const before: Before = {
		nodes: new Map(order.map((c) => [c, c.current])),
		roots: rootCounts(editor.roots)
	}
	for (const cell of order) {
		if (!pending.has(cell)) {
			continue
		}
		pending.delete(cell)
		if (editor.readsFeedback(cell)) {
			continue
		}
		for (const rule of rules) {
			if (rule.at(cell, cx)) {
				for (const c of affectedBy(editor, before)) {
					pending.add(c)
				}
				return { cell, rule }
			}
		}
	}
	return undefined
}

/** The cells a node at `cell` reads: its data inputs and the cells its expressions name, by label, each once. */
const nodeReads = (
	cell: Cell,
	node: EditNode,
	byLabel: ReadonlyMap<NodeId, Cell>
): ReadonlyArray<Cell> => {
	const read = new Set<Cell>(inputsOf(node))
	for (const r of columnRefs(exprsOf(node))) {
		const named = byLabel.get(r.node)
		if (named !== undefined && named !== cell) {
			read.add(named)
		}
	}
	return [...read]
}

/** Every cell `from` reaches along `next`, `from` included. */
const reach = (
	from: Iterable<Cell>,
	next: (cell: Cell) => ReadonlyArray<Cell>
): ReadonlySet<Cell> => {
	const seen = new Set<Cell>(from)
	const queue = [...seen]
	for (const at of queue) {
		for (const n of next(at)) {
			if (!seen.has(n)) {
				seen.add(n)
				queue.push(n)
			}
		}
	}
	return seen
}

/**
 * The cells whose view a rewrite changed, given the DAG before it (Before). What a rule at a cell reads is:
 *
 * - the cell's node;
 * - the cells below it, through data inputs and column references: their rows, keys and dependencies (the physical
 *   analysis), a chain, a correlation, a recursion's feedback;
 * - the cells above it: their demand (the demand analysis), a discriminant spine, the roots at it;
 * - who reads each cell below it, and how: its references, its lateral reads and the roots at it (DagEditor.readers,
 *   the demand analysis's references and lateral);
 * - what each cell above it reads beside it: the right side of every semi-join stacked over a region
 *   (existence/index.ts stacked).
 *
 * So the seeds are every reachable cell whose node changed or is new, every reachable cell such a node reads or read,
 * every reachable cell a cell no longer reachable read, which lost that reader, and every cell that gained or lost a
 * root; and the affected cells are every cell above a seed, and every cell below a seed or a seed's reader. A cell
 * outside them sees what it saw.
 */
const affectedBy = (editor: DagEditor, before: Before): ReadonlySet<Cell> => {
	const order = editor.topoOrder()
	const byLabel = new Map(order.map((c) => [c.id, c]))
	const reads = new Map(order.map((c) => [c, nodeReads(c, c.current, byLabel)]))
	const readers = new Map<Cell, Array<Cell>>()
	for (const [c, read] of reads) {
		for (const r of read) {
			const list = readers.get(r)
			if (list === undefined) {
				readers.set(r, [c])
			} else {
				list.push(c)
			}
		}
	}
	const seeds = new Set<Cell>()
	const seed = (cells: ReadonlyArray<Cell>): void => {
		for (const c of cells) {
			if (reads.has(c)) {
				seeds.add(c)
			}
		}
	}
	for (const [c, read] of reads) {
		const was = before.nodes.get(c)
		if (was === c.current) {
			continue
		}
		seed([c, ...read])
		if (was !== undefined) {
			seed(nodeReads(c, was, byLabel))
		}
	}
	for (const [c, was] of before.nodes) {
		if (!reads.has(c)) {
			seed(nodeReads(c, was, byLabel))
		}
	}
	const roots = rootCounts(editor.roots)
	for (const c of new Set([...before.roots.keys(), ...roots.keys()])) {
		if (before.roots.get(c) !== roots.get(c)) {
			seed([c])
		}
	}
	const above = reach(seeds, (c) => readers.get(c) ?? [])
	const below = reach(
		[...seeds, ...[...seeds].flatMap((c) => readers.get(c) ?? [])],
		(c) => reads.get(c) ?? []
	)
	return new Set([...above, ...below])
}

/** A pass of one traversal: `step` edits the DAG once, so the pass terminates with it. */
export const traversalPass = (spec: {
	readonly name: string
	readonly step: (cx: RewriteCx) => void
}): Pass<LogicalQuery, LogicalQuery> => ({
	name: spec.name,
	measure: "single-traversal",
	run: (query, ctx) =>
		catchRefusal(() => {
			const editor = new DagEditor(query.dag)
			const cx = rewriteCx(editor, ctx, spec.name)
			spec.step(cx)
			return settle(query, editor)
		})
})
