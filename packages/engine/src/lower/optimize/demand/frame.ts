import { invariant } from "@bjornpagen/grizzle-text/base/invariant"
import type { DemandAnalysis } from "#compiler/analysis/demand/demand.ts"
import { type PropsUnder, propsUnder, unplaced } from "#compiler/analysis/physical/analyze.ts"
import type { PhysicalProps } from "#compiler/analysis/physical/props.ts"
import { catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import { type Certificate, makeCertificate } from "#compiler/ir/certificate.ts"
import type { FinishedCells } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { Pass, PassContext } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Cell, Rooted, Roots, VarDecl } from "#compiler/ir/rel.ts"
import { type CellState, DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import { QuietCells } from "#compiler/lower/optimize/demand/quiet.ts"

/**
 * Demand analysis (analysis/demand) of one snapshot of the editor, read cell by cell: each cell is read as its node in
 * that snapshot, so a reading taken before a rewrite still reads the DAG it analyzed after it. Pruning reads it; a
 * rewrite asks only how a cell is read (CellState structure), which needs no demand.
 */
export interface CellDemand {
	readonly analysis: DemandAnalysis
	readonly demanded: (cell: Cell) => ReadonlySet<string>
	readonly liveVars: (cell: Cell) => ReadonlySet<VarDecl>
}

/** The demand analysis of a snapshot, read cell by cell. */
export const cellDemand = (
	snapshot: FinishedCells<Roots>,
	analysis: DemandAnalysis
): CellDemand => ({
	analysis,
	demanded: (cell) => analysis.demanded(snapshot.node(cell)),
	liveVars: (cell) => analysis.liveVars(snapshot.node(cell))
})

/** The physical properties (analysis/physical) of one snapshot of the editor's cells, read cell by cell: each cell's
 * node's, computed when a decision first reads them and once for the pass (PropsUnder). */
export interface CellPhysical {
	readonly props: (cell: Cell) => PhysicalProps
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

/** What a decision reads of the DAG as its driver found it: the DAG finished, each cell's node in it. */
export interface FinishedAnalyses {
	readonly dag: FinishedCells<Roots>
}

/** The finished DAG, and its physical analysis in the artifact's evidence context. */
export interface PhysicalAnalyses extends FinishedAnalyses {
	readonly physical: CellPhysical
}

/**
 * A rule's decision at a cell whose shape admits it, over the analyses of the current DAG it reads: the driver computes
 * them once per state of the DAG, for every decision that reads them, and hands them to it. It rewrites and returns
 * true, changes nothing and returns false, or asks for more (a decision over the physical analyses).
 */
export type Decision =
	| { readonly reads: "finished"; readonly decide: (analyses: FinishedAnalyses) => Verdict }
	| { readonly reads: "physical"; readonly decide: (analyses: PhysicalAnalyses) => Verdict }

/** What a rule answers: true where it rewrote, false where it changed nothing, or the decision the analyses settle. */
export type Verdict = boolean | Decision

/** A decision over the finished DAG. */
export const overFinished = (decide: (analyses: FinishedAnalyses) => Verdict): Decision => ({
	reads: "finished",
	decide
})

/** A decision over the physical analyses, the finished DAG with them. */
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

/** A potential's value as the cells alone give it, or the value the finished DAG settles. */
export type Measure =
	| number
	| { readonly reads: "finished"; readonly of: (analyses: FinishedAnalyses) => number }

/** A potential's value over the finished DAG. */
export const measureOverFinished = (of: (analyses: FinishedAnalyses) => number): Measure => ({
	reads: "finished",
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

/**
 * The frame's end: the edited DAG finished. A frame that changed nothing delivers the DAG it started from, which is
 * what finishing it would build again: every node of a DAG is final when it is built.
 */
const settle = (query: LogicalQuery, editor: DagEditor<Rooted>): LogicalQuery =>
	editor.version === 0 ? query : { ...query, dag: editor.finish() }

/**
 * The physical properties a pass reads its DAG's physical analyses through, in the pass context's evidence context,
 * under its catalog: one for every state of the DAG the pass edits, so a node an edit kept is computed once.
 */
const passProps = (ctx: PassContext): PropsUnder =>
	propsUnder({
		context: ctx.evidenceContext,
		catalog: ctx.catalog,
		realization: unplaced,
		roots: "result"
	})

/**
 * The DAG the editor holds now, finished: what the driver hands a decision, and what a rule that rewrites and then
 * decides again over its own edit computes for itself.
 */
export const finishedAnalyses = (editor: DagEditor): FinishedAnalyses => ({
	dag: editor.finished()
})

/**
 * The finished DAG `finished`, each cell's physical properties read off the pass's properties `props` at the cell's node
 * there, when a decision first reads them: a decision reads the properties of the cells it weighs and of nothing else,
 * where each state computed the analysis of its whole DAG (analysis/physical analysisOver: every node's edges classified
 * and every observed input's properties computed, its observed nodes and its obligations), the spine above every edit
 * among them, which no decision read (qti's write compile at hub 7a0902e41: 64.5 s of 961 s of its readback lowering).
 */
const physicalAnalyses = (finished: FinishedAnalyses, props: PropsUnder): PhysicalAnalyses => ({
	...finished,
	physical: { props: (cell) => props.of(finished.dag.node(cell)) }
})

/**
 * The analyses of one state of the edited DAG its driver has computed, each once: none yet, the demand analyses, or the
 * physical ones too. An edit makes them another state's, so the driver starts each state from none.
 */
type Computed =
	| { readonly kind: "none" }
	| { readonly kind: "finished"; readonly analyses: FinishedAnalyses }
	| { readonly kind: "physical"; readonly analyses: PhysicalAnalyses }

const noneComputed: Computed = { kind: "none" }

/** The editor's DAG finished, `computed`'s or finished now, and what is computed then. */
const withFinished = (
	editor: DagEditor,
	computed: Computed
): { readonly analyses: FinishedAnalyses; readonly computed: Computed } => {
	if (computed.kind !== "none") {
		return { analyses: computed.analyses, computed }
	}
	const analyses = finishedAnalyses(editor)
	return { analyses, computed: { kind: "finished", analyses } }
}

/** The physical analyses of the editor's DAG, `computed`'s or computed now, and what is computed then. */
const withPhysical = (
	editor: DagEditor,
	props: PropsUnder,
	computed: Computed
): { readonly analyses: PhysicalAnalyses; readonly computed: Computed } => {
	if (computed.kind === "physical") {
		return { analyses: computed.analyses, computed }
	}
	const analyses = physicalAnalyses(withFinished(editor, computed).analyses, props)
	return { analyses, computed: { kind: "physical", analyses } }
}

/** The rewrite cx over one editor's cells `cells`, under the compilation's catalog. */
const rewriteCx = (
	editor: DagEditor,
	ctx: PassContext,
	pass: string,
	cells: CellState
): RewriteCx => ({
	editor,
	ctx,
	pass,
	catalog: ctx.catalog,
	cells,
	certify: (input) => {
		const cert = unwrap(makeCertificate(input))
		ctx.certificates.record(cert)
	}
})

/**
 * The rewrite cx at the next state of a pass's cells (DagEditor drivenState), its quiet cells told what the edits since
 * the last state moved (QuietCells taken).
 */
const drivenCx = (
	editor: DagEditor,
	ctx: PassContext,
	pass: string,
	quiet: QuietCells
): RewriteCx => {
	const { cells, moved } = editor.drivenState()
	quiet.taken(cells, moved, editor.drainMoves())
	return rewriteCx(editor, ctx, pass, cells)
}

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
	const known = withFinished(cx.editor, computed)
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
 * A rule reads how each cell is read, its references and whether a scope expression reads it, off the state's cells
 * (CellState structure), which the editor keeps with their order as the edits move them (editor.ts Reach, order.ts
 * KeptOrder): whether a rewrite may change a cell's set is what it asks, and no demand of the DAG's columns answers
 * that, so no state's demand is computed. A rule whose shape matches at a cell may answer a decision over the finished
 * DAG or its physical analysis (Decision). The driver computes each of a state of the DAG once, the first time a
 * decision or the potential reads it, and hands it to every later one until an edit, so an analysis no decision reads
 * is never computed. A state's scan judges again only the cells an edit could have changed the verdict of (quiet.ts
 * QuietCells), in order, so a firing costs what its edits reach, never the DAG.
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
			const props = passProps(ctx)
			const quiet = new QuietCells(editor)
			let cx = drivenCx(editor, ctx, spec.name, quiet)
			const potential = spec.potential(cx)
			let start = measured(potential, cx, noneComputed)
			for (
				let fired = fireNext(spec.rules, cx, props, start.computed, quiet);
				fired !== undefined;
				fired = fireNext(spec.rules, cx, props, start.computed, quiet)
			) {
				cx = drivenCx(editor, ctx, spec.name, quiet)
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
 * current DAG `computed` holds and those its decisions read, each computed once, the physical ones through the pass's
 * properties `props` (rewritePass). No rule is applied at a cell that reads a recursion's feedback. The cells are judged
 * in order from the first one the pass's quiet cells (QuietCells) hold to judge, a quiet cell passed over: every rule
 * would settle false there again, drawing nothing, so the first rule that fires at the first cell is the one a scan of
 * every cell finds, and every identifier is drawn as that scan draws it.
 */
const fireNext = (
	rules: ReadonlyArray<Rule>,
	cx: RewriteCx,
	props: PropsUnder,
	computed: Computed,
	quiet: QuietCells
): Fired | undefined => {
	const editor = cx.editor
	let known = computed
	const settled = (verdict: Verdict): boolean => {
		for (let at = verdict; ;) {
			if (typeof at === "boolean") {
				return at
			}
			switch (at.reads) {
				case "finished": {
					const read = withFinished(editor, known)
					known = read.computed
					at = at.decide(read.analyses)
					break
				}
				case "physical": {
					const read = withPhysical(editor, props, known)
					known = read.computed
					at = at.decide(read.analyses)
					break
				}
			}
		}
	}
	for (
		let cell = quiet.next(cx.cells.feedback);
		cell !== undefined;
		cell = quiet.next(cx.cells.feedback)
	) {
		const hearing = quiet.hear(cell)
		let asked = false
		for (const rule of rules) {
			const verdict = rule.at(cell, cx)
			asked ||= typeof verdict !== "boolean"
			if (settled(verdict)) {
				quiet.ended()
				return { cell, rule }
			}
		}
		quiet.settledFalse(hearing, asked)
	}
	quiet.ended()
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
			const cx = rewriteCx(editor, ctx, spec.name, editor.cellState())
			spec.step(cx)
			return settle(query, editor)
		})
})
