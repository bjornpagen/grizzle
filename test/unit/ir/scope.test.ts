import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	constant,
	element,
	type Gen,
	map,
	type Weight,
	type Weighted,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { ExprId, NodeId, OccurrenceId, ScopeId, VarId } from "#compiler/core/ids.ts"
import { nodeScopes, type OuterRefs, toTable } from "#compiler/ir/dag.ts"
import type { TableExpr } from "#compiler/ir/expr.ts"
import {
	conservativeMeta,
	type DagTable,
	inputsOf,
	keptRowsOf,
	type NodeMeta,
	type TableNode,
	type ValidDag
} from "#compiler/ir/rel.ts"
import { binaryCoercion } from "#compiler/scalar/compute/registry.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { liveOf } from "#test/support/oracle/dag-validate.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"
import { heading, scalarTypes } from "#test/unit/ir/fixture.ts"
import { generatedDags } from "#test/unit/ir/population.ts"

const nodeOf = (d: DagTable, id: NodeId): TableNode =>
	defined(d.nodes[id], `a node ${id} in the table`)

const nodeInputs = (n: TableNode): ReadonlyArray<NodeId> => inputsOf(n)

/** The expressions `roots` reach through their arguments in a table, each once, in first-visit order. */
const exprClosure = (d: DagTable, roots: ReadonlyArray<ExprId>): ReadonlyArray<ExprId> => {
	const seen = new Set<ExprId>()
	const queue = [...roots]
	for (const id of queue) {
		if (!seen.has(id)) {
			seen.add(id)
			appendAll(queue, d.exprs[id]?.args ?? [])
		}
	}
	return [...seen]
}

/** The readers of every node through data inputs. */
const readersOf = (d: DagTable): ReadonlyMap<NodeId, ReadonlyArray<NodeId>> => {
	const readers = new Map<NodeId, Array<NodeId>>()
	for (const n of Rec.values(d.nodes)) {
		for (const input of nodeInputs(n)) {
			readers.set(input, [...(readers.get(input) ?? []), n.id])
		}
	}
	return readers
}

/** The definition's scope expressions of a node. */
const scopeExprs = (node: TableNode): ReadonlyArray<ExprId> =>
	node.kind === "Take"
		? Arr.map(node.correlation, (c) => c.expr)
		: node.kind === "MatchRegion"
			? [
					...Arr.flatMap(node.occurrences, (o) => Arr.map(o.constants, (c) => c.expr)),
					...Arr.map(node.correlated, (c) => c.expr)
				]
			: []

/** The nodes a node binds for every reference: itself, and the nodes its scope expressions are evaluated over. */
const ownScope = (node: TableNode): ReadonlyArray<NodeId> =>
	node.kind === "MatchRegion"
		? [node.id, ...Arr.map(node.occurrences, (o) => o.source)]
		: node.kind === "Take"
			? [node.id, node.input]
			: [node.id]

/**
 * The nodes of the delivered rows from `start` in a table: down the kept rows and into the one arm of a union of one
 * arm (dag.ts deliverySpine).
 */
const spineNodes = (d: DagTable, start: NodeId): ReadonlyArray<NodeId> => {
	const nodes: Array<NodeId> = []
	for (let node: TableNode | undefined = nodeOf(d, start); node !== undefined;) {
		nodes.push(node.id)
		const arms: ReadonlyArray<NodeId> =
			node.kind === "Union" ? Arr.flatMap(node.groups, (g) => g.arms) : []
		if (arms.length > 1) {
			return nodes
		}
		const next: NodeId | undefined = node.kind === "Union" ? arms[0] : keptRowsOf(node)?.input
		node = next === undefined ? undefined : nodeOf(d, next)
	}
	return nodes
}

/** The nodes of an attachment's parent's delivered rows, which it binds for a reference its child carries. */
const parentRows = (d: DagTable, node: TableNode): ReadonlyArray<NodeId> =>
	node.kind === "Attach" ? spineNodes(d, node.parent) : []

const isSemiJoin = (
	node: TableNode
): node is TableNode & { readonly kind: "SemiJoin" | "AntiJoin" } =>
	node.kind === "SemiJoin" || node.kind === "AntiJoin"

/** Whether `node` binds a reference to `target` arriving from its input `via`. */
const binds = (d: DagTable, node: TableNode, target: NodeId, via: NodeId): boolean =>
	ownScope(node).includes(target) ||
	(node.kind === "Attach" && via === node.child && parentRows(d, node).includes(target)) ||
	(isSemiJoin(node) && via === node.right && target === node.left)

/** Where a planted reference is made: the expression list of a take or a region it joins. */
const holders = ["take correlation", "region constant", "region correlated"] as const
type Holder = (typeof holders)[number]

/** Which nodes a planted reference may name, relative to the node that makes it. */
const targets = [
	"any node",
	"an enclosing node",
	"an enclosing region",
	"a lateral source",
	"an enclosing attachment's parent rows",
	"the holder's own scope"
] as const
type Target = (typeof targets)[number]

/**
 * A fresh reference to the target's column, bare or under a cast, or an existing expression tree, whatever it reads.
 */
const readings = ["bare", "cast", "existing"] as const
type Reading = (typeof readings)[number]

interface Plant {
	readonly holder: Holder
	readonly holderPick: number
	readonly occurrencePick: number
	readonly target: Target
	readonly targetPick: number
	readonly columnPick: number
	readonly reading: Reading
	readonly exprPick: number
}

/** A plant's picks select among nodes, occurrences, columns and expressions known only once its DAG is drawn. */
const plantGen: Gen<Plant> = (source) => ({
	holder: source.draw(element(holders)),
	holderPick: source.draw(pickGen),
	occurrencePick: source.draw(pickGen),
	target: source.draw(element(targets)),
	targetPick: source.draw(pickGen),
	columnPick: source.draw(pickGen),
	reading: source.draw(element(readings)),
	exprPick: source.draw(pickGen)
})

/**
 * A planted reader: a new root evaluating one input per row of another, neither reaching the other (an attachment of a
 * child to a parent, or a semi-join of a left input by a right one), and a reference to a node of the parent's or left
 * input's delivered rows, made in the child or right side or, where a node of the parent's subtree reads one it is not
 * evaluated in, such as an intersection's or another semi-join's right side, in the parent.
 */
interface ReaderPlant {
	readonly reader: "attachment" | "semi-join"
	readonly side: "child" | "parent"
	readonly parentPick: number
	readonly childPick: number
	readonly holderPick: number
	readonly targetPick: number
	readonly columnPick: number
	readonly holder: Holder
	readonly occurrencePick: number
}

const readerPlantGen: Gen<ReaderPlant> = (source) => ({
	reader: source.draw(element(["attachment", "semi-join"] as const)),
	side: source.draw(element(["child", "parent"] as const)),
	parentPick: source.draw(pickGen),
	childPick: source.draw(pickGen),
	holderPick: source.draw(pickGen),
	targetPick: source.draw(pickGen),
	columnPick: source.draw(pickGen),
	holder: source.draw(element(holders)),
	occurrencePick: source.draw(pickGen)
})

/** The nodes a node is evaluated in: every node above it through data inputs. */
const enclosing = (d: DagTable, id: NodeId): ReadonlyArray<NodeId> => {
	const readers = readersOf(d)
	const seen = new Set<NodeId>([id])
	const queue = [id]
	for (const at of queue) {
		for (const r of readers.get(at) ?? []) {
			if (!seen.has(r)) {
				seen.add(r)
				queue.push(r)
			}
		}
	}
	seen.delete(id)
	return [...seen]
}

/** The nodes a node evaluates: itself and every node below it through data inputs. */
const below = (d: DagTable, id: NodeId): ReadonlySet<NodeId> => {
	const seen = new Set<NodeId>([id])
	const queue = [id]
	for (const at of queue) {
		for (const input of nodeInputs(nodeOf(d, at))) {
			if (!seen.has(input)) {
				seen.add(input)
				queue.push(input)
			}
		}
	}
	return seen
}

const isHolder = (n: TableNode): boolean => n.kind === "Take" || n.kind === "MatchRegion"

const candidates = (d: DagTable, holder: TableNode, target: Target): ReadonlyArray<NodeId> => {
	switch (target) {
		case "any node":
			return Arr.map(Rec.values(d.nodes), (n) => n.id)
		case "an enclosing node":
			return enclosing(d, holder.id)
		case "an enclosing region":
			return Arr.filter(enclosing(d, holder.id), (id) => nodeOf(d, id).kind === "MatchRegion")
		case "a lateral source": {
			/** A source of an enclosing region that the holder is not evaluated in: an earlier occurrence's source. */
			const above = enclosing(d, holder.id)
			const path = new Set([holder.id, ...above])
			return Arr.flatMap(above, (id) => {
				const n = nodeOf(d, id)
				return n.kind === "MatchRegion"
					? Arr.filter(
							Arr.map(n.occurrences, (o) => o.source),
							(s) => !path.has(s)
						)
					: []
			})
		}
		case "an enclosing attachment's parent rows":
			return Arr.flatMap(enclosing(d, holder.id), (id) => parentRows(d, nodeOf(d, id)))
		case "the holder's own scope":
			return ownScope(holder)
	}
}

/** A fresh reference to a column of `target`, bare or under a cast, its expressions with the root last. */
const freshReference = (
	target: TableNode,
	columnPick: number,
	reading: Exclude<Reading, "existing">,
	fresh: (n: number) => ExprId
): { readonly root: ExprId; readonly added: ReadonlyArray<TableExpr> } | undefined => {
	if (!Arr.isReadonlyArrayNonEmpty(target.heading)) {
		return undefined
	}
	const { name, type } = pickFrom(target.heading, columnPick)
	const common = {
		type,
		volatility: "immutable",
		deps: { params: [], nodes: [target.id] }
	} as const
	const column: TableExpr = {
		...common,
		id: fresh(0),
		kind: "column",
		column: { node: target.id, name },
		args: [],
		nonNull: "storage"
	}
	if (reading === "bare") {
		return { root: column.id, added: [column] }
	}
	const cast: TableExpr = {
		...common,
		id: fresh(1),
		kind: "cast",
		cast: binaryCoercion,
		args: [column.id],
		nonNull: "strict"
	}
	return { root: cast.id, added: [column, cast] }
}

/**
 * The expressions a plant adds, its root last, none for an existing tree; undefined when its choice has no option here.
 */
const plantedExprs = (
	d: DagTable,
	holder: TableNode,
	p: Plant,
	fresh: (n: number) => ExprId
): { readonly root: ExprId; readonly added: ReadonlyArray<TableExpr> } | undefined => {
	if (p.reading === "existing") {
		const exprs = Rec.values(d.exprs)
		return Arr.isReadonlyArrayNonEmpty(exprs)
			? { root: pickFrom(exprs, p.exprPick).id, added: [] }
			: undefined
	}
	const named = candidates(d, holder, p.target)
	return Arr.isReadonlyArrayNonEmpty(named)
		? freshReference(nodeOf(d, pickFrom(named, p.targetPick)), p.columnPick, p.reading, fresh)
		: undefined
}

/**
 * `holder` making one more scope reference, through `expr`, into the list `list` names when it has one; undefined when
 * it has none.
 */
const withReference = (
	holder: TableNode,
	list: Holder,
	occurrencePick: number,
	expr: ExprId
): TableNode | undefined => {
	if (holder.kind === "Take") {
		const [first] = holder.heading
		return first === undefined
			? undefined
			: { ...holder, correlation: [...holder.correlation, { column: first.name, expr }] }
	}
	if (holder.kind !== "MatchRegion") {
		return undefined
	}
	if (list === "region correlated") {
		const [first] = holder.vars
		return first === undefined
			? undefined
			: { ...holder, correlated: [...holder.correlated, { var: first.id, expr }] }
	}
	if (!Arr.isReadonlyArrayNonEmpty(holder.occurrences)) {
		return undefined
	}
	const at = pickFrom(holder.occurrences, occurrencePick)
	return {
		...holder,
		occurrences: Arr.map(holder.occurrences, (o) =>
			o === at
				? { ...o, constants: [...o.constants, { column: `planted${o.constants.length}`, expr }] }
				: o
		)
	}
}

/** `d` with `holder` replaced by `node` and the expressions added. */
const withPlanted = (d: DagTable, node: TableNode, added: ReadonlyArray<TableExpr>): DagTable => ({
	roots: d.roots,
	nodes: { ...d.nodes, [node.id]: node },
	exprs: { ...d.exprs, ...Rec.fromEntries(Arr.map(added, (e) => [e.id, e])) }
})

const planted = (d: DagTable, plants: ReadonlyArray<Plant>): DagTable =>
	Arr.reduce(plants, d, (current, p, i) => {
		const kind: TableNode["kind"] = p.holder === "take correlation" ? "Take" : "MatchRegion"
		/** A holder of the plant's kind with a node of the plant's target to read, when it reads a fresh reference. */
		const eligible = Arr.filter(
			Rec.values(current.nodes),
			(n) =>
				n.kind === kind && (p.reading === "existing" || candidates(current, n, p.target).length > 0)
		)
		if (!Arr.isReadonlyArrayNonEmpty(eligible)) {
			return current
		}
		const holder = pickFrom(eligible, p.holderPick)
		const exprs = plantedExprs(current, holder, p, (n) => ExprId(`planted#${i}.${n}`))
		const node =
			exprs === undefined
				? undefined
				: withReference(holder, p.holder, p.occurrencePick, exprs.root)
		return exprs === undefined || node === undefined
			? current
			: withPlanted(current, node, exprs.added)
	})

/**
 * The parent, the child and the holders the plant's reference may be made in, each with the nodes of the parent's
 * delivered rows it may read: on the child's side any, on the parent's side those the holder is not evaluated in.
 */
interface ReaderSite {
	readonly parent: TableNode
	readonly child: TableNode
	readonly made: ReadonlyArray<{
		readonly holder: TableNode
		readonly targets: Arr.NonEmptyReadonlyArray<NodeId>
	}>
}

const readerSite = (d: DagTable, p: ReaderPlant): ReaderSite | undefined => {
	const nodes = Rec.values(d.nodes)
	const belowOf = new Map(Arr.map(nodes, (n) => [n.id, below(d, n.id)]))
	const evaluated = (id: NodeId): ReadonlySet<NodeId> =>
		defined(belowOf.get(id), `the nodes below ${id}`)
	const holdersBelow = (id: NodeId): ReadonlyArray<TableNode> =>
		Arr.filter(
			Arr.map([...evaluated(id)], (h) => nodeOf(d, h)),
			isHolder
		)
	const disjoint = (a: NodeId, b: NodeId): boolean => !evaluated(a).has(b) && !evaluated(b).has(a)
	const reading = (made: NodeId, parent: NodeId): ReaderSite["made"] => {
		const rows = spineNodes(d, parent)
		return Arr.flatMap(holdersBelow(made), (holder) => {
			const path = [holder.id, ...enclosing(d, holder.id)]
			const targets = p.side === "child" ? rows : Arr.filter(rows, (r) => !path.includes(r))
			return Arr.isReadonlyArrayNonEmpty(targets) ? [{ holder, targets }] : []
		})
	}
	if (p.side === "child") {
		const children = Arr.filter(nodes, (n) => holdersBelow(n.id).length > 0)
		if (!Arr.isReadonlyArrayNonEmpty(children)) {
			return undefined
		}
		const child = pickFrom(children, p.childPick)
		const parents = Arr.filter(nodes, (n) => disjoint(n.id, child.id))
		if (!Arr.isReadonlyArrayNonEmpty(parents)) {
			return undefined
		}
		const parent = pickFrom(parents, p.parentPick)
		return { parent, child, made: reading(child.id, parent.id) }
	}
	const parents = Arr.filter(nodes, (n) => reading(n.id, n.id).length > 0)
	if (!Arr.isReadonlyArrayNonEmpty(parents)) {
		return undefined
	}
	const parent = pickFrom(parents, p.parentPick)
	const children = Arr.filter(nodes, (n) => disjoint(n.id, parent.id))
	if (!Arr.isReadonlyArrayNonEmpty(children)) {
		return undefined
	}
	return { parent, child: pickFrom(children, p.childPick), made: reading(parent.id, parent.id) }
}

const withReaders = (d: DagTable, plants: ReadonlyArray<ReaderPlant>): DagTable =>
	Arr.reduce(plants, d, (current, p, i) => {
		const site = readerSite(current, p)
		if (site === undefined || !Arr.isReadonlyArrayNonEmpty(site.made)) {
			return current
		}
		const { holder, targets } = pickFrom(site.made, p.holderPick)
		const id = NodeId(`reader#${i}`)
		const common = { id, heading: site.parent.heading, meta: sketchedMeta, loc: undefined }
		const reader: TableNode =
			p.reader === "attachment"
				? {
						...common,
						kind: "Attach",
						parent: site.parent.id,
						child: site.child.id,
						name: "attached",
						correlation: [],
						delivered: "array",
						order: { keys: [] }
					}
				: { ...common, kind: "SemiJoin", left: site.parent.id, right: site.child.id, on: [] }
		const withReader: DagTable = {
			roots: [...current.roots, id],
			nodes: { ...current.nodes, [id]: reader },
			exprs: current.exprs
		}
		const exprs = freshReference(
			nodeOf(current, pickFrom(targets, p.targetPick)),
			p.columnPick,
			"bare",
			(n) => ExprId(`reader#${i}.${n}`)
		)
		const node =
			exprs === undefined
				? undefined
				: withReference(holder, p.holder, p.occurrencePick, exprs.root)
		return exprs === undefined || node === undefined
			? withReader
			: withPlanted(withReader, node, exprs.added)
	})

/**
 * A sketched node: its kind, those with scopes or several inputs the more often, and its inputs among the few nodes
 * just before it, so the DAG nests deeply and shares inputs.
 */
const sketchKinds = [
	"Base",
	"Filter",
	"Union",
	"MatchRegion",
	"Take",
	"Attach",
	"SemiJoin",
	"AntiJoin",
	"Intersect",
	"Difference"
] as const
type SketchKind = (typeof sketchKinds)[number]
const sketchWeights: Readonly<Record<SketchKind, Weight>> = {
	Base: 1,
	Filter: 1,
	Union: 1,
	MatchRegion: 3,
	Take: 2,
	Attach: 2,
	SemiJoin: 2,
	AntiJoin: 1,
	Intersect: 1,
	Difference: 1
}
const nearby = 3

interface NodeSketch {
	readonly kind: SketchKind
	readonly inputs: ReadonlyArray<number>
}

const sketchKindGen = weighted(
	Arr.map(sketchKinds, (k): Weighted<SketchKind> => [sketchWeights[k], constant(k)])
)

const nodeSketchGen: Gen<NodeSketch> = (source) => ({
	kind: source.draw(sketchKindGen),
	inputs: source.draw(array(pickGen, { min: 1, max: 3 }))
})

const sketchedHeading = heading(["a", scalarTypes.int8], ["b", scalarTypes.int8])
const sketchedMeta: NodeMeta = { ...conservativeMeta, paramDeps: [], reads: [] }
const sketchedId = (i: number): NodeId => NodeId(`n${i}`)

/** One sketched node, numbered i, over `inputs`: a source when it reads no node. */
const sketchedNode = (
	s: NodeSketch,
	i: number,
	inputs: ReadonlyArray<NodeId>,
	truth: ExprId
): TableNode => {
	const common = { id: sketchedId(i), heading: sketchedHeading, meta: sketchedMeta, loc: undefined }
	const [first, second] = inputs
	if (first === undefined || s.kind === "Base") {
		return {
			...common,
			kind: "Base",
			relation: "Sketched",
			occurrence: OccurrenceId(`o${i}`),
			primaryKey: ["a"],
			keys: [],
			relationKind: "relation"
		}
	}
	switch (s.kind) {
		case "Filter":
			return { ...common, kind: "Filter", input: first, pred: truth }
		case "Union":
			return {
				...common,
				kind: "Union",
				groups: [{ heading: sketchedHeading, arms: [first, ...inputs.slice(1)] }],
				discriminant: []
			}
		case "Take":
			return {
				...common,
				kind: "Take",
				input: first,
				order: { keys: [] },
				bound: { kind: "literal", k: 1n },
				correlation: []
			}
		case "Attach":
			return {
				...common,
				kind: "Attach",
				parent: first,
				child: second ?? first,
				name: "attached",
				correlation: [],
				delivered: "array",
				order: { keys: [] }
			}
		case "SemiJoin":
		case "AntiJoin":
			return { ...common, kind: s.kind, left: first, right: second ?? first, on: [] }
		case "Intersect":
		case "Difference":
			return { ...common, kind: s.kind, left: first, right: second ?? first }
		case "MatchRegion": {
			const vars = Arr.map(sketchedHeading, (c) => ({
				id: VarId(`v${i}${c.name}`),
				name: c.name,
				type: c.type
			}))
			return {
				...common,
				kind: "MatchRegion",
				scope: ScopeId(`s${i}`),
				vars,
				occurrences: Arr.map(inputs, (source, k) => ({
					id: OccurrenceId(`o${i}.${k}`),
					source,
					bindings: Arr.map(vars, (v) => ({ column: v.name, var: v.id })),
					constants: []
				})),
				equalities: [],
				correlated: []
			}
		}
	}
}

/** A generated DAG's table. */
const succeededTable = (g: ValidDag): DagTable => succeeded(toTable(g))

/** The DAG of sketched nodes, node i reading only the few nodes just before it, rooted at the last. */
const sketchedDag = (sketches: ReadonlyArray<NodeSketch>): DagTable => {
	const truthId = ExprId("true")
	const truth: TableExpr = {
		kind: "literal",
		value: { kind: "bool", value: true },
		args: [],
		nonNull: "literal",
		type: scalarTypes.bool,
		volatility: "immutable",
		id: truthId,
		deps: { params: [], nodes: [] }
	}
	const nodes: Record<NodeId, TableNode> = {}
	for (const [i, s] of sketches.entries()) {
		const inputs =
			i === 0 ? [] : Arr.map(s.inputs, (p) => sketchedId(i - 1 - pickIndex(p, Math.min(i, nearby))))
		const node = sketchedNode(s, i, inputs, truthId)
		nodes[node.id] = node
	}
	return {
		roots: [sketchedId(sketches.length - 1)],
		nodes,
		exprs: { [truthId]: truth }
	}
}

const population: Gen<DagTable> = (source) => {
	const d = source.draw(
		weighted([
			[1, map(generatedDags, (g) => succeededTable(g))],
			[2, map(array(nodeSketchGen, { min: 2, max: 12 }), sketchedDag)]
		])
	)
	const readerPlants = source.draw(array(readerPlantGen, { min: 0, max: 2 }))
	return planted(withReaders(d, readerPlants), source.draw(array(plantGen, { min: 1, max: 8 })))
}

type Feature =
	| "a free variable"
	| "a reference to a node that is no region"
	| "a reference inside an expression tree"
	| "a reference its maker binds"
	| "a reference bound at the node it names"
	| "a reference bound at a region's source"
	| "a reference bound on one path and carried on another"
	| "a reference bound at an attachment"
	| "a reference bound at an attachment below its parent"
	| "a reference an attachment carries from its parent"
	| "a reference bound at a semi-join"
	| "a reference a semi-join carries from below its left"
	| "a scope shared with an input"

/**
 * Every node's outer references by the definition: each reference a scope expression makes, carried from its maker to
 * every node above along a path on which no node binds what it names.
 */
const reference = (
	d: DagTable,
	note: (f: Feature) => void
): ReadonlyMap<NodeId, Map<NodeId, Set<string>>> => {
	const readers = readersOf(d)
	const refs = new Map(Arr.map(Rec.values(d.nodes), (n) => [n.id, new Map<NodeId, Set<string>>()]))
	const noteAll = (features: ReadonlyArray<Feature>): void => {
		for (const f of features) {
			note(f)
		}
	}
	/** Carries the reference to `target`'s `column` from `maker` up to every node above on a path that does not bind it. */
	const carry = (maker: NodeId, target: NodeId, column: string): void => {
		const reached = new Set<NodeId>([maker])
		/** Records the reference at `at`, and the readers above it the reference travels on to. */
		const climb = (at: NodeId): ReadonlyArray<NodeId> => {
			const here = refs.get(at) ?? new Map<NodeId, Set<string>>()
			here.set(target, new Set([...(here.get(target) ?? []), column]))
			refs.set(at, here)
			const above = readers.get(at) ?? []
			const next: Array<NodeId> = []
			for (const r of above) {
				const reader = nodeOf(d, r)
				if (binds(d, reader, target, at)) {
					const elsewhere = Arr.some(above, (other) => !binds(d, nodeOf(d, other), target, at))
					noteAll([
						...boundFeatures(reader, r, target),
						...(elsewhere ? ["a reference bound on one path and carried on another" as const] : [])
					])
					continue
				}
				noteAll(carriedFeatures(d, reader, at, target))
				if (!reached.has(r)) {
					reached.add(r)
					next.push(r)
				}
			}
			return next
		}
		const queue = [maker]
		for (const at of queue) {
			appendAll(queue, climb(at))
		}
	}
	for (const maker of Rec.values(d.nodes)) {
		const roots = scopeExprs(maker)
		for (const e of exprClosure(d, roots)) {
			const expr = d.exprs[e]
			if (expr?.kind !== "column") {
				continue
			}
			const target = expr.column.node
			if (ownScope(maker).includes(target)) {
				note("a reference its maker binds")
				continue
			}
			if (!roots.includes(e)) {
				note("a reference inside an expression tree")
			}
			carry(maker.id, target, expr.column.name)
		}
	}
	return refs
}

/** The features of a reference to `target` that `reader`, the node `r`, binds. */
const boundFeatures = (reader: TableNode, r: NodeId, target: NodeId): ReadonlyArray<Feature> => {
	if (r === target) {
		return ["a reference bound at the node it names"]
	}
	if (ownScope(reader).includes(target)) {
		return ["a reference bound at a region's source"]
	}
	if (reader.kind === "Attach") {
		return target === reader.parent
			? ["a reference bound at an attachment"]
			: [
					"a reference bound at an attachment",
					"a reference bound at an attachment below its parent"
				]
	}
	return ["a reference bound at a semi-join"]
}

/** The features of a reference to `target` that `reader` carries up from its input `at`. */
const carriedFeatures = (
	d: DagTable,
	reader: TableNode,
	at: NodeId,
	target: NodeId
): ReadonlyArray<Feature> => [
	...(reader.kind === "Attach" && at !== reader.child && parentRows(d, reader).includes(target)
		? ["a reference an attachment carries from its parent" as const]
		: []),
	...(isSemiJoin(reader) && at === reader.right && spineNodes(d, reader.left).includes(target)
		? ["a reference a semi-join carries from below its left" as const]
		: [])
]

/** The variables references name: a column of a region is its variable of that name. */
const namedVars = (
	d: DagTable,
	refs: ReadonlyMap<NodeId, ReadonlySet<string>>
): ReadonlyArray<VarId> =>
	Arr.sort(
		new Set(
			Arr.flatMap([...refs], ([id, columns]) => {
				const n = d.nodes[id]
				return n?.kind === "MatchRegion"
					? Arr.map(
							Arr.filter(n.vars, (v) => columns.has(v.name)),
							(v) => v.id
						)
					: []
			})
		),
		Order.String
	)

const listed = (refs: OuterRefs): ReadonlyArray<readonly [NodeId, ReadonlyArray<string>]> =>
	Arr.sort(
		Arr.map([...refs], ([id, columns]) => [id, Arr.sort(columns, Order.String)] as const),
		Order.mapInput(Order.String, ([id]: readonly [NodeId, ReadonlyArray<string>]) => id)
	)

describe("a node's scope", () => {
	it.effect(
		"is the definition's: the references below it no node on the way binds, and the variables they name",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/scope",
						literal: Formatter.format,
						draw: drawn(population),
						runs: 400,
						shrink: completeShrink,
						coverage: required<Feature>(
							[
								"a free variable",
								"a reference to a node that is no region",
								"a reference inside an expression tree",
								"a reference its maker binds",
								"a reference bound at the node it names",
								"a reference bound at a region's source",
								"a reference bound on one path and carried on another",
								"a reference bound at an attachment",
								"a reference bound at an attachment below its parent",
								"a reference an attachment carries from its parent",
								"a reference bound at a semi-join",
								"a reference a semi-join carries from below its left",
								"a scope shared with an input"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d, c) =>
						Effect.sync(() => {
							/** Every table node is a root of the live DAG, so a region a reference names is one of its labels. */
							const live = liveOf(d)
							const scopes = nodeScopes({
								roots: Arr.map(Rec.keys(d.nodes), (id) => live.node(NodeId(id)))
							})
							const expected = reference(d, c.note)
							for (const n of Rec.values(d.nodes)) {
								const scope = scopes.of(live.node(n.id))
								const refs = expected.get(n.id)
								assert.ok(refs !== undefined, `${n.id} has a scope`)
								assert.deepEqual(
									listed(scope.outer),
									listed(refs),
									`the outer references of ${n.id}`
								)
								const vars = namedVars(d, refs)
								assert.deepEqual(scope.freeVars, vars, `the free variables of ${n.id}`)
								const noted = [
									...(vars.length > 0 ? ["a free variable" as const] : []),
									...(Arr.some([...refs.keys()], (id) => d.nodes[id]?.kind !== "MatchRegion")
										? ["a reference to a node that is no region" as const]
										: []),
									...(refs.size > 0 &&
									Arr.some(nodeInputs(n), (input) => scopes.of(live.node(input)) === scope)
										? ["a scope shared with an input" as const]
										: [])
								]
								for (const f of noted) {
									c.note(f)
								}
							}
						})
				)
			)
	)
})
