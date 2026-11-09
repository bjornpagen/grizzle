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
import { type CellState, DagEditor } from "#compiler/lower/optimize/demand/editor.ts"

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

/** What a rule sees while it decides and rewrites, at one state of the edited DAG. */
export interface RewriteCx {
	readonly editor: DagEditor
	readonly ctx: PassContext
	readonly pass: string
	readonly catalog: EvidenceCatalog
	/** The editor's cells at that state (CellState), which the driver computed once for every reader of the state. */
	readonly cells: CellState
	/** Records a rewrite's certificate in the context's log; a refused certificate fails the pass. */
	readonly certify: (input: Certificate) => void
}

/** What a decision reads of the DAG as its driver found it: the DAG finished, each cell's node in it, and its demand. */
export interface DemandAnalyses {
	readonly dag: FinishedCells<Roots>
	readonly demand: CellDemand
}

/** The demand analyses, and the physical analysis of the same DAG in the artifact's evidence context. */
export interface PhysicalAnalyses extends DemandAnalyses {
	readonly physical: CellPhysical
}

/**
 * A rule's decision at a cell whose shape admits it, over the analyses of the current DAG it reads: the driver computes
 * them once per state of the DAG, for every decision that reads them, and hands them to it. It rewrites and returns
 * true, changes nothing and returns false, or asks for more (a decision over the physical analyses).
 */
export type Decision =
	| { readonly reads: "demand"; readonly decide: (analyses: DemandAnalyses) => Verdict }
	| { readonly reads: "physical"; readonly decide: (analyses: PhysicalAnalyses) => Verdict }

/** What a rule answers: true where it rewrote, false where it changed nothing, or the decision the analyses settle. */
export type Verdict = boolean | Decision

/** A decision over the demand analyses. */
export const overDemand = (decide: (analyses: DemandAnalyses) => Verdict): Decision => ({
	reads: "demand",
	decide
})

/** A decision over the physical analyses, the demand analyses with them. */
export const overPhysical = (decide: (analyses: PhysicalAnalyses) => Verdict): Decision => ({
	reads: "physical",
	decide
})

export interface Rule {
	readonly name: string
	/**
	 * At `cell`: false where it changes nothing, true where it rewrote, or the decision that settles it over the analyses
	 * it reads (Decision), where the cells alone admit a rewrite. It decides by nothing but what it reads at the cell
	 * (affectedBy), those analyses and the compilation's catalog.
	 */
	readonly at: (cell: Cell, cx: RewriteCx) => Verdict
}

/** A potential's value as the cells alone give it, or the value the demand analyses of the DAG settle. */
export type Measure =
	| number
	| { readonly reads: "demand"; readonly of: (analyses: DemandAnalyses) => number }

/** A potential's value over the demand analyses. */
export const measureOverDemand = (of: (analyses: DemandAnalyses) => number): Measure => ({
	reads: "demand",
	of
})

/**
 * A pass's potential: a natural number of the DAG that every rewrite of the pass strictly lowers. It is polynomial in
 * the size of the DAG the pass starts from, so the pass takes at most its first value in steps, which is the pass's
 * whole bound: no step budget beside it. Where the cells alone give its value, it reads no analysis.
 */
export type Potential = (cx: RewriteCx) => Measure

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

/**
 * The DAG the editor holds now, finished, and its demand analysis: what the driver hands a decision, and what a rule
 * that rewrites and then decides again over its own edit computes for itself.
 */
export const demandAnalyses = (editor: DagEditor): DemandAnalyses => {
	const dag = editor.finished()
	return { dag, demand: cellDemand(dag, analyzeDemand(dag.dag, noPins)) }
}

/** The demand analyses `demand`, with the physical analysis of their DAG. */
const physicalAnalyses = (demand: DemandAnalyses, ctx: PassContext): PhysicalAnalyses => {
	const analysis = physicalOf(demand.dag.dag, ctx)
	return { ...demand, physical: { analysis, of: (cell) => analysis.of(demand.dag.node(cell)) } }
}

/**
 * The analyses of one state of the edited DAG its driver has computed, each once: none yet, the demand analyses, or the
 * physical ones too. An edit makes them another state's, so the driver starts each state from none.
 */
type Computed =
	| { readonly kind: "none" }
	| { readonly kind: "demand"; readonly analyses: DemandAnalyses }
	| { readonly kind: "physical"; readonly analyses: PhysicalAnalyses }

const noneComputed: Computed = { kind: "none" }

/** The demand analyses of the editor's DAG, `computed`'s or computed now, and what is computed then. */
const withDemand = (
	editor: DagEditor,
	computed: Computed
): { readonly analyses: DemandAnalyses; readonly computed: Computed } => {
	if (computed.kind !== "none") {
		return { analyses: computed.analyses, computed }
	}
	const analyses = demandAnalyses(editor)
	return { analyses, computed: { kind: "demand", analyses } }
}

/** The physical analyses of the editor's DAG, `computed`'s or computed now, and what is computed then. */
const withPhysical = (
	editor: DagEditor,
	ctx: PassContext,
	computed: Computed
): { readonly analyses: PhysicalAnalyses; readonly computed: Computed } => {
	if (computed.kind === "physical") {
		return { analyses: computed.analyses, computed }
	}
	const analyses = physicalAnalyses(withDemand(editor, computed).analyses, ctx)
	return { analyses, computed: { kind: "physical", analyses } }
}

/** The rewrite cx over one editor's cells as they are now, under the compilation's catalog. */
const rewriteCx = (editor: DagEditor, ctx: PassContext, pass: string): RewriteCx => ({
	editor,
	ctx,
	pass,
	catalog: ctx.catalog,
	cells: editor.cellState(),
	certify: (input) => {
		const cert = unwrap(makeCertificate(input))
		ctx.certificates.record(cert)
	}
})

/** A potential's value over the editor's DAG, with the analyses computed for it. */
const measured = (
	potential: Potential,
	cx: RewriteCx,
	computed: Computed
): { readonly value: number; readonly computed: Computed } => {
	const measure = potential(cx)
	if (typeof measure === "number") {
		return { value: measure, computed }
	}
	const known = withDemand(cx.editor, computed)
	return { value: measure.of(known.analyses), computed: known.computed }
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
 * A rule whose shape matches at a cell answers a decision over the demand or the physical analyses (Decision). The
 * driver computes each analysis of a state of the DAG once, the first time a decision or the potential reads it, and
 * hands it to every later one until an edit, so an analysis no decision reads is never computed.
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
			let cx = rewriteCx(editor, ctx, spec.name)
			const potential = spec.potential(cx)
			let start = measured(potential, cx, noneComputed)
			for (
				let fired = fireNext(spec.rules, cx, start.computed);
				fired !== undefined;
				fired = fireNext(spec.rules, cx, start.computed)
			) {
				cx = rewriteCx(editor, ctx, spec.name)
				const after = measured(potential, cx, noneComputed)
				invariant(
					Number.isInteger(after.value) && after.value >= 0 && after.value < start.value,
					`the ${spec.name} rewrite ${fired.rule.name} at node ${fired.cell.id} strictly lowers its pass's potential, a natural; ${start.value} became ${after.value}`
				)
				start = after
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
 * Applies the first rule that fires at the first cell in topological order where one does, over the analyses of the
 * current DAG `computed` holds and those its decisions read, each computed once (rewritePass). No rule is applied at a
 * cell that reads a recursion's feedback.
 */
const fireNext = (
	rules: ReadonlyArray<Rule>,
	cx: RewriteCx,
	computed: Computed
): Fired | undefined => {
	const editor = cx.editor
	let known = computed
	const settled = (verdict: Verdict): boolean => {
		for (let at = verdict; ;) {
			if (typeof at === "boolean") {
				return at
			}
			switch (at.reads) {
				case "demand": {
					const read = withDemand(editor, known)
					known = read.computed
					at = at.decide(read.analyses)
					break
				}
				case "physical": {
					const read = withPhysical(editor, cx.ctx, known)
					known = read.computed
					at = at.decide(read.analyses)
					break
				}
			}
		}
	}
	for (const cell of cx.cells.order) {
		if (cx.cells.feedback.has(cell)) {
			continue
		}
		for (const rule of rules) {
			if (settled(rule.at(cell, cx))) {
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
