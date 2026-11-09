import { analyzeDemand, type DemandAnalysis, noPins } from "#compiler/analysis/demand/demand.ts"
import {
	analyzePhysical,
	type PhysicalAnalysis,
	type PhysicalNode,
	unplaced
} from "#compiler/analysis/physical/analyze.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { invariant } from "#compiler/core/invariant.ts"
import type * as Result from "#compiler/core/result.ts"
import { type Certificate, makeCertificate } from "#compiler/ir/certificate.ts"
import type { FinishedCells } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { Pass, PassContext } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Cell, RelDag, Rooted, Roots, VarDecl } from "#compiler/ir/rel.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"

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
 * Every applied rewrite records a certificate: its rule, the nodes it read and wrote, the premises
 * its proof used, the evidence context it requires, the heading it preserves, and through its constraint premises the
 * installed constraints it rests on. Rewrites run only in the optimized lowering, the one that
 * runs passes; the conservative one uses no certificate.
 *
 * The feedback region of a recursion is the recursive lowering's.
 */
export const rewritePass = (spec: RewritePassSpec): Pass<LogicalQuery, LogicalQuery> => ({
	name: spec.name,
	run: (query, ctx) =>
		catchRefusal(() => {
			const editor = new DagEditor(query.dag)
			const cx = rewriteCx(editor, ctx, spec.name)
			const potential = spec.potential(cx)
			let before = potential(cx)
			for (
				let fired = fireNext(editor, spec.rules, cx);
				fired !== undefined;
				fired = fireNext(editor, spec.rules, cx)
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

/**
 * Applies the first rule that fires at the first cell in topological order where one does. No rule is applied at a cell
 * that reads a recursion's feedback.
 */
const fireNext = (
	editor: DagEditor,
	rules: ReadonlyArray<Rule>,
	cx: RewriteCx
): Fired | undefined => {
	for (const cell of editor.topoOrder()) {
		if (editor.readsFeedback(cell)) {
			continue
		}
		for (const rule of rules) {
			if (rule.at(cell, cx)) {
				return { cell, rule }
			}
		}
	}
	return undefined
}

/** A pass of one traversal: `step` edits the DAG once, so the pass terminates with it. */
export const traversalPass = (spec: {
	readonly name: string
	readonly step: (cx: RewriteCx) => void
}): Pass<LogicalQuery, LogicalQuery> => ({
	name: spec.name,
	run: (query, ctx) =>
		catchRefusal(() => {
			const editor = new DagEditor(query.dag)
			const cx = rewriteCx(editor, ctx, spec.name)
			spec.step(cx)
			return settle(query, editor)
		})
})
