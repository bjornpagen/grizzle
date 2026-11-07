import { keyEvidence } from "#compiler/analysis/physical/evidence.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { assembledDag } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, Grounds } from "#compiler/ir/evidence.ts"
import { keyIn } from "#compiler/ir/keys.ts"
import {
	type Cell,
	type EditRefs,
	exprsOf,
	inputsOf,
	type KeySet,
	type KindOver,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import { analyzeLogical, queryEvidence } from "#compiler/logical/annotate.ts"
import type { Props } from "#compiler/logical/props.ts"
import { columnRefs } from "#compiler/lower/optimize/demand/editor.ts"
import type { CatalogEditor } from "#compiler/lower/shapes/catalog/edit.ts"

/** A region as a catalog rewrite reads it: its occurrences' sources are cells. */
export type Region = KindOver<"MatchRegion", EditRefs>

/** A cell and the node it holds, read once: a recognizer's view of one node of a composition. */
export interface Held<N> {
	readonly cell: Cell
	readonly node: N
}

/**
 * How the catalog treats a correlated take(1) (R27, R42): "bound" keeps the LATERAL probe
 * per parent, "whole" takes the whole-input target, and "auto" decides by the parent set, LATERAL for a bound set
 * (an attachment's delivered parents, a relation parameter) and the whole-input target otherwise. A derived-relation
 * definition always wants every group, so its compilation passes "whole".
 */
export type ParentPolicy = "auto" | "bound" | "whole"

export interface CatalogOptions {
	/** Resolves a stored relation's declared keys to their installed constraints (analysis/physical/evidence.ts). */
	readonly catalog: EvidenceCatalog
	readonly parents: ParentPolicy
}

/**
 * A key a rewrite relies on, with the grounds the rewrite's certificate records: a stored relation's declared key on
 * its installed constraint, or a stage's logical key on its KeyProof's grounds, a node a rewrite built among them. It
 * carries no derivation (ir/keys.ts KeyProof says why).
 */
export interface KeyGrounds extends Grounds {
	readonly key: KeySet
}

/**
 * What every catalog recognizer shares: the DAG being edited, the evidence a total order rests on, the parent-set
 * policy, consumers, and the certificate a rewrite records.
 */
export class CatalogContext {
	readonly ed: CatalogEditor
	readonly options: CatalogOptions
	/** The consumer table of the current DAG, by the label of the node consumed, built on first read and dropped by every rewrite. */
	#consumers: ReadonlyMap<NodeId, ReadonlyArray<Cell>> | undefined = undefined

	constructor(ed: CatalogEditor, options: CatalogOptions) {
		this.ed = ed
		this.options = options
	}

	/** The cells that read `cell` as a data input or name its columns in an expression, in the current DAG. */
	consumers(cell: Cell): ReadonlyArray<Cell> {
		const table = this.#consumers ?? this.#consumerTable()
		this.#consumers = table
		return table.get(cell.id) ?? []
	}

	#consumerTable(): ReadonlyMap<NodeId, ReadonlyArray<Cell>> {
		const map = new Map<NodeId, Array<Cell>>()
		const add = (from: Cell, to: NodeId) => {
			const list = map.get(to) ?? []
			if (!list.includes(from)) {
				list.push(from)
			}
			map.set(to, list)
		}
		for (const cell of this.ed.cells()) {
			for (const input of inputsOf(cell.current)) {
				add(cell, input.id)
			}
			for (const r of columnRefs(exprsOf(cell.current))) {
				if (r.node !== cell.id) {
					add(cell, r.node)
				}
			}
		}
		return map
	}

	isRoot(cell: Cell): boolean {
		return this.ed.isRoot(cell)
	}

	/** The first declared key of a stored relation `covered` contains whose installed constraint the catalog resolves. */
	#declaredKeyWithin(
		source: KindOver<"Base", EditRefs>,
		covered: ReadonlySet<string>
	): KeyGrounds | undefined {
		const declared = [
			{ key: source.primaryKey, primary: true },
			...source.keys.map((key) => ({ key, primary: false }))
		]
		for (const d of declared.filter((x) => x.key.every((c) => covered.has(c)))) {
			const constraint = this.options.catalog.keyConstraint(source.relation, d.key, {
				primary: d.primary,
				derived: source.relationKind === "derived"
			})
			if (constraint !== undefined) {
				return { key: d.key, ...keyEvidence(constraint) }
			}
		}
		return undefined
	}

	/** The consumer table changes with every rewrite. */
	invalidate(): void {
		this.#consumers = undefined
	}

	/**
	 * The logical properties of `cell` as the cells stand now: a fresh analysis (logical/annotate.ts analyzeLogical) of
	 * the DAG the roots reach when they reach `cell`, so a node under an attachment is read relative to its parent; else,
	 * a node a rewrite is still building, of the cells it reaches alone. It runs under the evidence the optimized input is
	 * annotated with (lower/optimize/pipeline.ts optimizedInput, queryEvidence), so a node a rewrite built is keyed by
	 * what the analysis proves of it, as every other node is.
	 */
	propsOf(cell: Cell): Props {
		const finished = this.ed.finished()
		const node = finished.node(cell)
		const analysis = analyzeLogical(
			this.ed.reachable().has(cell) ? finished.dag : assembledDag([node] as const),
			queryEvidence
		)
		if (!analysis.ok) {
			throw new Refusal(analysis.error)
		}
		return analysis.value.of(node).props
	}

	/**
	 * The keys of the rows `cell` holds: a stored relation's declared keys, its primary key first, or the minimal keys the
	 * analysis proves of any other node (propsOf).
	 */
	keysOf(cell: Cell): ReadonlyArray<KeySet> {
		const node = cell.current
		return node.kind === "Base"
			? [node.primaryKey, ...node.keys]
			: this.propsOf(cell).keys.map((proof) => proof.key)
	}

	/**
	 * A key of `source` the columns `covered` contain, with the evidence that makes it hold: a stored relation's declared
	 * key through its installed constraint, which holds at every statement (analysis/physical/evidence.ts keyEvidence);
	 * or a logical key the analysis proves of it now (propsOf), a node a rewrite built included, on the premises and in
	 * the context its proof rests on, as a world relation's keys are its definition's, which no constraint of its view
	 * installs. A logical key is read through its classes: the columns `covered` holds of each (ir/keys.ts keyIn).
	 */
	keyWithin(sourceCell: Cell, covered: ReadonlySet<string>): KeyGrounds | undefined {
		const source = sourceCell.current
		if (source.kind === "Base" && source.relationKind !== "world") {
			return this.#declaredKeyWithin(source, covered)
		}
		for (const proof of this.propsOf(sourceCell).keys) {
			const key = keyIn(proof, (c) => covered.has(c))
			if (key !== undefined) {
				return { key, premises: proof.premises, context: proof.context }
			}
		}
		return undefined
	}
}

/**
 * Whether two occurrences read the same relation: one node, or two scans of one stored relation (the checker gives
 * every match its own Base node).
 */
export const sameSource = (x: Cell, y: Cell): boolean => {
	if (x === y) {
		return true
	}
	const a = x.current
	const b = y.current
	if (a.kind !== "Base" || b.kind !== "Base") {
		return false
	}
	return (
		a.relation === b.relation &&
		a.relationKind === b.relationKind &&
		a.heading.length === b.heading.length &&
		a.heading.every((c, i) => {
			const d = b.heading[i]
			return d !== undefined && d.name === c.name && sameScalarType(d.type, c.type)
		})
	)
}

/** One binding of a region variable: the occurrence index and the source column. */
interface RegionBinding {
	readonly occurrence: number
	readonly column: string
}

/** A region's bindings, by variable: every (occurrence index, source column) that binds it. */
export const bindingsByVar = (
	region: Region
): ReadonlyMap<VarDecl, ReadonlyArray<RegionBinding>> => {
	const map = new Map<VarDecl, Array<{ occurrence: number; column: string }>>()
	for (const [i, o] of region.occurrences.entries()) {
		for (const b of o.bindings) {
			const list = map.get(b.var) ?? []
			list.push({ occurrence: i, column: b.column })
			map.set(b.var, list)
		}
	}
	return map
}

/** The region's variable named `name`, the column the region delivers for it. */
export const varByName = (region: Region, name: string): VarDecl | undefined =>
	region.vars.find((v) => v.name === name)

/**
 * The bindings of the region variable named `name`. A variable no occurrence binds has none, and so has an undeclared
 * name: the map holds only bound variables, so the empty list is the domain's answer, not a fallback.
 */
export const boundColumns = (
	region: Region,
	byVar: ReadonlyMap<VarDecl, ReadonlyArray<RegionBinding>>,
	name: string
): ReadonlyArray<RegionBinding> => {
	const v = varByName(region, name)
	return v === undefined ? [] : (byVar.get(v) ?? [])
}

/** A fresh column name for `stem` that `heading` does not use. */
export const freshColumn = (taken: Iterable<string>, stem: string): string => {
	const used = new Set(taken)
	if (!used.has(stem)) {
		return stem
	}
	for (let n = 2; ; n++) {
		if (!used.has(`${stem}_${n}`)) {
			return `${stem}_${n}`
		}
	}
}
