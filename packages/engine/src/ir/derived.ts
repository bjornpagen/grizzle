import { appendAll, sameOrder } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { NodeId } from "#compiler/core/ids.ts"
import {
	assembledDag,
	CanonicalDigests,
	LabelSupply,
	nodeScopes,
	nodeShapes,
	relNode
} from "#compiler/ir/dag.ts"
import { builtExpr, type LiveArgs, mapArgs, type ScalarExpr, sameArgs } from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import type { ViewRead } from "#compiler/ir/keys.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	conservativeMeta,
	edgesOf,
	exprsOf,
	keptRefs,
	type LiveRefs,
	mapNode,
	mapRoots,
	metaSpecOf,
	type NodeOf,
	type NodeSpec,
	type RelNode,
	type RootedDag,
	type Roots,
	type SpecRefs,
	regionVarClasses,
	unionArms,
	type ValidDag,
	type VarDecl
} from "#compiler/ir/rel.ts"

/** A DAG whose derived relations read their rows where the lowering reads them, and the node standing there in the
 * place of each node of the DAG it was made from. */
export interface ServedDag<R extends Roots> {
	readonly dag: ValidDag<R>
	readonly of: (node: RelNode) => RelNode
}

/**
 * How the lowering reads a schema's relations: whether a derived relation's table serves the read (analysis/schema.ts
 * CheckedSchema serves), and each derived relation's definition as the schema checked it (CheckedSchema definition),
 * read where its table does not; and the rows of each stored relation its world holds (`world`).
 */
export interface DerivedRows {
	readonly serves: (relation: string) => boolean
	readonly definition: (relation: string) => LogicalQuery
	/** The stored canonical relations a read may read in place of their forms (CanonicalForms). */
	readonly forms: CanonicalForms
	readonly world: WorldRows
}

/**
 * What the reader's world holds of the stored relations (schema/scope.ts): every row of each, but of each one it
 * restricts, by name, the rows its owner's keys pair with alone (`Restriction`). Reality restricts none; a role whose
 * claims bind a unit restricts every member of it, each ordinary relation keyed leading with its heading and each
 * stored derived relation it holds, unit-local by its admission, so reading that table at the owner's keys is reading
 * the definition over the world's rows.
 */
export interface WorldRows {
	readonly restricted: ReadonlyMap<string, Restriction>
}

/** Reality's rows: every row of every stored relation. */
export const realityRows: WorldRows = Object.freeze({ restricted: new Map<string, Restriction>() })

/**
 * The rows a world holds of one stored relation: those a row of its unit's owner meets at `on`, each pair a field of
 * the relation holding the unit's key (`left`) and the owner's head field of that key (`right`).
 */
export interface Restriction {
	readonly owner: Owning
	readonly on: NonEmptyReadonlyArray<{ readonly left: string; readonly right: string }>
}

/**
 * Whether every row of `node`, a node of a checked DAG, holds at `column` a key of unit `unit` the world's claims bind:
 * the column is, through every node that keeps or renames its input's rows, a variable of a region some occurrence
 * binds at such a column, every arm of a union's, down to a Base over a relation the world restricts by `unit`'s owner
 * read at a field that holds the unit's key (`world` restricted), each of whose rows the world holds at the owner's keys
 * alone. A write whose every fact so stems from the world's rows states none outside it (write/frontend/compile.ts), so
 * its claims precheck is proven, and emitted nowhere.
 */
export const claimedColumn = (
	world: WorldRows,
	unit: string,
	node: RelNode,
	column: string
): boolean => {
	switch (node.kind) {
		case "Base": {
			const restriction = world.restricted.get(node.relation)
			return restriction?.owner.unit === unit && restriction.on.some((p) => p.left === column)
		}
		case "MatchRegion": {
			const classOf = regionVarClasses(node)
			const v = node.vars.find((x) => x.name === column)
			return (
				v !== undefined &&
				node.occurrences.some((o) =>
					o.bindings.some(
						(b) => classOf(b.var) === classOf(v) && claimedColumn(world, unit, o.source, b.column)
					)
				)
			)
		}
		case "ProjectSet": {
			const e = node.out.find((o) => o.name === column)?.expr
			return (
				e?.kind === "column" &&
				e.column.node === node.input.id &&
				claimedColumn(world, unit, node.input, e.column.name)
			)
		}
		case "Union":
			return unionArms(node.groups).every((arm) => claimedColumn(world, unit, arm, column))
		case "Filter":
		case "Step":
		case "Take":
		case "OrderedResult":
			return claimedColumn(world, unit, node.input, column)
		case "SemiJoin":
		case "AntiJoin":
		case "Difference":
			return claimedColumn(world, unit, node.left, column)
		case "ApproximateNearest":
		case "Attach":
		case "Call":
		case "Closed":
		case "Context":
		case "Delta":
		case "Forbid":
		case "Group":
		case "InputSet":
		case "Intersect":
		case "OrderedSetAggregate":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "Window":
			return false
	}
}

/** A unit's owner as the lowering reads it: the unit, and the owner's query as the base checked it, its root the keys. */
export interface Owning {
	readonly unit: string
	readonly dag: RootedDag
}

/**
 * The stored canonical relations of a schema (analysis/derived/canonical.ts) as the lowering reads them in place of their
 * forms: each by its form's digest, with its name, by which `DerivedRows` serves says whether its table serves the
 * read, and how a Base over it reads it; and the form shape (`formShape`) of each form's root, so only a node of one of
 * them is digested.
 */
export interface CanonicalForms {
	readonly stored: ReadonlyMap<string, StoredForm>
	readonly shapes: ReadonlySet<string>
}

/** A stored canonical relation as a Base over its table reads it: its name, its heading and its proven keys. */
export interface StoredForm {
	readonly relation: string
	readonly read: ViewRead
}

/**
 * What a node is told from a stored form's root by before its digest is taken (CanonicalForms `shapes`): its shape
 * (ir/dag.ts nodeShapes) and the stored relations it reads (ir/rel.ts NodeMeta `reads`), each a function of its node and
 * what it reaches, so a node a form's root's digest names has its form's, and a node of another shape or other reads is
 * none and is never digested.
 */
export const formShape = (shapes: Fold<RelNode, string>, node: RelNode): string =>
	`${shapes.of(node)}\u0000${node.meta.reads.join("\u0000")}`

/** No canonical relation read in place of its form: what a stored relation's own fill, upkeep and meaning read. */
export const noForms: CanonicalForms = Object.freeze({
	stored: new Map<string, StoredForm>(),
	shapes: new Set<string>()
})

/**
 * The stored canonical relation whose form a node is, where its table serves the read (`rows`): a node no Base, reading
 * no outer value, whose shape is a stored form's root's and whose digest names that form (CanonicalForms), none for
 * any other. A form reads no parameter, so a node that reads one has a digest no form has. Its digests are its own
 * (ir/dag.ts CanonicalDigests), held by it alone, so they go with the walk that reads them and no served DAG holds them.
 */
const storedForms = (rows: DerivedRows): ((node: RelNode) => StoredForm | undefined) => {
	const shapes = nodeShapes()
	const scopes = nodeScopes()
	const forms = new CanonicalDigests()
	return (node) => {
		if (
			node.kind === "Base" ||
			!rows.forms.shapes.has(formShape(shapes, node)) ||
			scopes.of(node).outer.size > 0
		) {
			return undefined
		}
		const digest = forms.of(node)
		const form = digest.ok ? rows.forms.stored.get(digest.value) : undefined
		return form !== undefined && rows.serves(form.relation) ? form : undefined
	}
}

/**
 * `dag` as the lowering reads it: every Base over a derived relation whose table does not serve the read (`rows`
 * serves) read as its definition instead, the definition its schema checked (`rows` definition) spliced in under
 * labels past every label of the DAG (ir/dag.ts LabelSupply renamed), one copy of each relation's however many Bases
 * read it, whose own derived relations are read alike, to any depth; every other Base, a stored relation's whose table
 * serves the read among them, read as it is. The checker reads a derived relation as a relation, stored or live alike,
 * keyed by the keys its definition proves (analysis/derived/analyze.ts DerivedDefinition), so no verdict reads where its
 * rows live: the lowering alone decides it, here, before its first pass. A definition delivers the relation's heading,
 * so every column a reader binds or names keeps its name; a column reference to a replaced Base names its definition's
 * root. Converse to it, every node whose form is a stored canonical relation's (analysis/derived/canonical.ts), an
 * anonymous import's or a definition's, whose table serves the read (`rows` forms), is read from that table, a Base over
 * it under the node's own label, so every column a reader names of it keeps its name and its node, the topmost such
 * node of a path read and nothing below it. Each node and expression on a path to a replaced Base or a stored form is
 * rebuilt under its own label (the one constructor recomputes what it derives), and every other one is kept as it is,
 * so a DAG that reads no derived relation whose table does not serve and no stored form is itself.
 *
 * Every Base it then reads over a stored relation its world restricts (`rows` world), a definition's and a stored form's
 * among them, is read joined with the relation's unit's owner at the fields holding the unit's key: a region of the
 * Base's heading under a label past every label so far, the Base under its own label inside it, its table read as it
 * is, so every reader reads the world's rows of it wherever it stands, a negation's, an aggregate's and a take's among
 * them, and a column reference to the Base names the region. The region's chain starts at the owner, a set the
 * session's claims fix (lower/shapes/share/sites.ts), so the relation is probed at the owner's keys wherever the
 * lowering reads it. Each owner is spliced in once, its own reads read whole: the owner is what the world's rows are
 * the keys of.
 */
export const servedDag = <R extends Roots>(dag: ValidDag<R>, rows: DerivedRows): ServedDag<R> => {
	/** Whether the lowering reads `node`, a Base, as its definition. */
	const replacedBase = (node: NodeOf<"Base">): boolean =>
		node.relationKind === "derived" && !rows.serves(node.relation)
	const supply = new LabelSupply(dag)
	const storedFormOf = storedForms(rows)
	/** Each node read from a stored canonical relation's table in its place, a Base over the table under its label. */
	const stored = new Map<RelNode, RelNode>()
	const storedBase = (node: RelNode, form: StoredForm): RelNode =>
		relNode(node.id, {
			kind: "Base",
			relation: form.relation,
			occurrence: supply.occurrence(),
			primaryKey: mapNonEmpty(form.read.heading, (c) => c.name),
			keys: [],
			relationKind: "derived",
			view: form.read.keys,
			determined: form.read.determined,
			heading: node.heading,
			loc: node.loc,
			meta: conservativeMeta
		})
	/** Each unit's owner spliced into the DAG's label space once, its root there. */
	const owners = new Map<string, RelNode>()
	const ownerRoot = (owner: Owning): RelNode =>
		owners.getOrInsertComputed(owner.unit, () => supply.renamed(owner.dag)(owner.dag.roots[0]))
	/** Whether the world restricts the relation a Base reads (WorldRows). */
	const restricts = (relation: string): boolean => rows.world.restricted.has(relation)
	/** The label of the region each restricted Base is read through, by the Base's label: known before any node is
	 * rebuilt, as `replaced` is, so a column reference to the Base names the region wherever the fold meets it. */
	const regionOf = new Map<NodeId, NodeId>()
	/**
	 * `node` as its world reads it: a Base over a relation the world restricts read as a region of two occurrences under
	 * the label `regionOf` gave it, the relation's unit's owner, its head fields bound to the variables of the fields that
	 * hold the unit's key, and the Base itself, each of its columns bound to a variable of its name; the region's heading
	 * is the Base's.
	 */
	const worldBase = (node: RelNode): RelNode => {
		const restriction = node.kind === "Base" ? rows.world.restricted.get(node.relation) : undefined
		const label = regionOf.get(node.id)
		if (restriction === undefined || label === undefined) {
			return node
		}
		const vars = node.heading.map((c): VarDecl => ({
			id: supply.variable(),
			name: c.name,
			type: c.type
		}))
		const varOf = (column: string): VarDecl =>
			defined(
				vars.find((v) => v.name === column),
				"a variable of each column of a restricted relation"
			)
		return relNode(label, {
			kind: "MatchRegion",
			scope: supply.scope(),
			vars,
			occurrences: [
				{
					id: supply.occurrence(),
					source: ownerRoot(restriction.owner),
					bindings: restriction.on.map((p) => ({ column: p.right, var: varOf(p.left) })),
					constants: []
				},
				{
					id: supply.occurrence(),
					source: node,
					bindings: vars.map((v) => ({ column: v.name, var: v })),
					constants: []
				}
			],
			equalities: [],
			correlated: [],
			heading: node.heading,
			loc: node.loc,
			meta: conservativeMeta
		})
	}
	/** Each relation's definition spliced into the DAG's label space once, its root there. */
	const spliced = new Map<string, RelNode>()
	const definitionOf = (relation: string): RelNode => {
		const known = spliced.get(relation)
		if (known !== undefined) {
			return known
		}
		const definition = rows.definition(relation).dag
		const root = supply.renamed(definition)(definition.roots[0])
		spliced.set(relation, root)
		return root
	}
	/**
	 * The label of the definition's root standing in the place of each replaced Base, by the Base's, over every node the
	 * DAG reaches and every definition a replaced Base reads, to any depth: known before any node is rebuilt, so a column
	 * reference names the definition wherever the fold meets it. A rebuilt node keeps its label.
	 */
	const replaced = new Map<NodeId, NodeId>()
	const seen = new Set<RelNode>()
	const pending: Array<RelNode> = [...dag.roots]
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (seen.has(node)) {
			continue
		}
		seen.add(node)
		if (node.kind === "Base" && replacedBase(node)) {
			const definition = definitionOf(node.relation)
			replaced.set(node.id, definition.id)
			pending.push(definition)
			continue
		}
		const form = storedFormOf(node)
		const read = form === undefined ? node : storedBase(node, form)
		if (form === undefined) {
			appendAll(pending, edgesOf(node))
		} else {
			stored.set(node, read)
		}
		if (read.kind === "Base" && restricts(read.relation)) {
			const label = supply.node()
			regionOf.set(node.id, label)
			replaced.set(node.id, label)
		}
	}
	const exprs = new Fold<ScalarExpr, ScalarExpr>(function* (e) {
		const spec = yield* mapArgs<LiveArgs, LiveArgs>(e)
		if (spec.kind === "column") {
			const to = replaced.get(spec.column.node)
			if (to !== undefined) {
				return builtExpr({ ...spec, column: { node: to, name: spec.column.name } }, e.id)
			}
		}
		return sameArgs(e, spec) ? e : builtExpr(spec, e.id)
	})
	const nodes = new Fold<RelNode, RelNode>(function* (node) {
		if (node.kind === "Base" && replacedBase(node)) {
			return yield definitionOf(node.relation)
		}
		if (node.kind === "Base") {
			return worldBase(node)
		}
		const base = stored.get(node)
		if (base !== undefined) {
			return worldBase(base)
		}
		const spec: NodeSpec = yield* mapNode<LiveRefs, SpecRefs>(node, {
			...keptRefs,
			expr: (e) => exprs.of(e),
			name: (id) => replaced.get(id) ?? id,
			meta: metaSpecOf
		})
		return sameOrder(edgesOf(node), edgesOf(spec)) && sameOrder(exprsOf(node), exprsOf(spec))
			? node
			: relNode(node.id, spec)
	})
	return {
		dag: assembledDag(mapRoots(dag.roots, (root) => nodes.of(root))),
		of: (node) => nodes.of(node)
	}
}

/** `query` as the lowering reads it (`servedDag`): each derived relation whose table does not serve the read read as its
 * definition. */
export const servedQuery = <Q extends LogicalQuery>(query: Q, rows: DerivedRows): Q => ({
	...query,
	dag: servedDag(query.dag, rows).dag
})

/** The relations a read writes: none. A read, a judge and an upkeep read every stored table their COMMIT's upkeep made
 * current (analysis/schema.ts CheckedSchema serves). */
export const noneWritten: ReadonlySet<string> = new Set()
