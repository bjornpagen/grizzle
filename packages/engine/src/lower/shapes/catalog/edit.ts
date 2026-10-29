import { Refusal } from "#compiler/core/canonical.ts"
import { allocatedKinds, ExprId, NodeId, OccurrenceId, ScopeId, VarId } from "#compiler/core/ids.ts"
import { cellFold, finishCells, topoOrder } from "#compiler/ir/dag.ts"
import { builtExpr, type ExprSpec, exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { Fold } from "#compiler/ir/fold.ts"
import {
	type Cell,
	type EditNode,
	exprsOf,
	inputsOf,
	type RelNode,
	type Roots,
	type ValidDag
} from "#compiler/ir/rel.ts"
import { FreshIds } from "#compiler/lower/optimize/demand/editor.ts"

type Kind = keyof typeof allocatedKinds

/** Every label of each allocated kind a DAG holds: its nodes', expressions', variables', occurrences' and scopes'. */
const usedIds = (dag: ValidDag): Readonly<Record<Kind, ReadonlyArray<string>>> => {
	const nodes = topoOrder(dag)
	const vars: Array<string> = []
	const occurrences: Array<string> = []
	const scopes: Array<string> = []
	for (const node of nodes) {
		if (node.kind === "Base") {
			occurrences.push(node.occurrence)
		}
		if (node.kind === "MatchRegion") {
			scopes.push(node.scope)
			vars.push(...node.vars.map((v) => v.id))
			occurrences.push(...node.occurrences.map((o) => o.id))
		}
	}
	return {
		node: nodes.map((node) => node.id),
		expr: exprClosure(nodes.flatMap((node) => exprsOf(node))).map((e) => e.id),
		var: vars,
		occurrence: occurrences,
		scope: scopes
	}
}

/** A point in an editor's history an attempt can roll back to (CatalogEditor.mark). */
export interface EditMark {
	readonly cells: number
	readonly log: number
}

/**
 * An editable overlay over a built relational DAG, for the catalog rewrites.
 *
 * The editor holds the DAG as cells (ir/rel.ts Cell), one per node, each with its label and its current edit form. A
 * rewrite replaces a matched composition by its native target without disturbing anything around it. It does so in
 * place: the cell that roots the composition keeps its label and its heading, column for column, and is redefined as
 * the target's last node, so every consumer and every expression that names its columns stays valid unchanged (a
 * column reference names the node whose heading supplies it). The target's other nodes and expressions are new,
 * under labels no existing one uses. Logical metadata is normative and an equivalence rewrite does not change it, so a
 * redefined cell keeps its own; a new node states what it proves or claims nothing (rel.ts conservativeMeta).
 *
 * A rewrite is all or nothing: an attempt marks the editor first (mark) and rolls every redefinition and addition since
 * back when its recognizer gives up halfway (undo), through an undo log of each redefined cell's previous body. Fresh
 * labels keep counting, so a label a failed attempt took is never reused.
 *
 * build() folds the cells the roots reach into nodes (ir/dag.ts finishCells), each built by the one constructor, which
 * computes its structural fields from what the edits left, so a rewrite can never hand on stale ones.
 *
 * It is not the optimizer's editor (lower/optimize/demand/editor.ts) because the two mint fresh labels apart: this one
 * mints the allocated kinds' own prefixes past every label the DAG holds, the optimizer's `nw`, `ew`, `vw`, `ow` and
 * `sw` labels, so for one DAG they mint different labels.
 */
export class CatalogEditor<R extends Roots = Roots> {
	readonly base: ValidDag<R>
	/** Every cell, in creation order: the base's, each after its inputs, then each one a rewrite added. */
	readonly #cells: Array<Cell> = []
	/** The cell of each node of the base, made when the editor starts. */
	readonly #cellOf: Fold<RelNode, Cell>
	readonly #fresh: Readonly<Record<Kind, FreshIds>>
	/** The undo log: each redefined cell with the body it had, in the order of the redefinitions. */
	readonly #log: Array<{ readonly cell: Cell; readonly previous: EditNode }> = []

	constructor(dag: ValidDag<R>) {
		this.base = dag
		this.#cellOf = cellFold((cell) => {
			this.#cells.push(cell)
		})
		for (const root of dag.roots) {
			this.#cellOf.of(root)
		}
		const used = usedIds(dag)
		this.#fresh = {
			node: new FreshIds(allocatedKinds.node, used.node),
			expr: new FreshIds(allocatedKinds.expr, used.expr),
			var: new FreshIds(allocatedKinds.var, used.var),
			occurrence: new FreshIds(allocatedKinds.occurrence, used.occurrence),
			scope: new FreshIds(allocatedKinds.scope, used.scope)
		}
	}

	/** The cell a node of the base DAG became when the editor started. */
	cellOf(node: RelNode): Cell {
		return this.#cellOf.of(node)
	}

	/** The base's roots' cells: a catalog rewrite redefines a cell in place, so a root never moves. */
	get roots(): ReadonlyArray<Cell> {
		return this.base.roots.map((root) => this.#cellOf.of(root))
	}

	isRoot(cell: Cell): boolean {
		return this.base.roots.some((root) => this.#cellOf.of(root) === cell)
	}

	/** Every cell, in creation order, those no root reaches any more included. */
	cells(): ReadonlyArray<Cell> {
		return this.#cells
	}

	freshVar(): VarId {
		return VarId(this.#fresh.var.take())
	}

	freshOccurrence(): OccurrenceId {
		return OccurrenceId(this.#fresh.occurrence.take())
	}

	freshScope(): ScopeId {
		return ScopeId(this.#fresh.scope.take())
	}

	/** A new cell of `node` under a fresh label; its structural fields are computed by build. */
	node(node: EditNode): Cell {
		const cell: Cell = { id: NodeId(this.#fresh.node.take()), current: node }
		this.#cells.push(cell)
		return cell
	}

	/**
	 * Redefines `cell` in place as `body`: the same label, the same heading, a new body. Its logical metadata stays the
	 * cell's own, whatever `body` states.
	 */
	redefine(cell: Cell, body: EditNode): void {
		this.#log.push({ cell, previous: cell.current })
		cell.current = { ...body, meta: cell.current.meta }
	}

	/** The expression of `spec` under a fresh label, built over its arguments (ir/expr.ts builtExpr). */
	expr(spec: ExprSpec): ScalarExpr {
		return builtExpr(spec, ExprId(this.#fresh.expr.take()))
	}

	/** The point an attempt rolls back to when its recognizer gives up halfway (undo). */
	mark(): EditMark {
		return { cells: this.#cells.length, log: this.#log.length }
	}

	/**
	 * Rolls the editor back to `mark`: every redefinition since, the latest first, and every cell added since, dropped.
	 * Fresh labels keep counting.
	 */
	undo(mark: EditMark): void {
		for (const entry of this.#log.splice(mark.log).toReversed()) {
			entry.cell.current = entry.previous
		}
		this.#cells.length = mark.cells
	}

	/** The cells the roots reach through their current data inputs. */
	reachable(): ReadonlySet<Cell> {
		const seen = new Set<Cell>(this.roots)
		for (const cell of seen) {
			for (const input of inputsOf(cell.current)) {
				seen.add(input)
			}
		}
		return seen
	}

	/**
	 * The DAG the cells the roots reach hold now (ir/dag.ts finishCells): every structural field computed. A cycle a
	 * rewrite made through the cells is that rewrite's refusal.
	 */
	build(): ValidDag<R> {
		const done = finishCells(this.base.roots, (root) => this.#cellOf.of(root))
		if (!done.ok) {
			throw new Refusal(done.error)
		}
		return done.value.dag
	}
}
