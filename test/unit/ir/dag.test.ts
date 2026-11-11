/**
 * The relational DAG (ir/dag.ts): its traversals, its labels, its digest and its normal form.
 *
 * - Traversals: topoOrder lists exactly the reachable nodes once each, every node after its inputs, and an
 *   expression's closure is exactly what it reaches through its arguments, over generated DAGs; a chain of any depth,
 *   past what a small stack's recursion holds, passes every entry point. Oracle: a naive reachability, and the chain's
 *   own construction.
 * - Labels: two distinct nodes or two distinct expressions under one label are refused where they stand, and the
 *   validator raises a defect. Oracle: one node and one expression per label.
 * - Digest: it ignores allocation order, label spelling and source locations, and changes with a literal, the domain or
 *   the roots' order. Oracle: universal, the digest is a function of the DAG's meaning.
 * - Normal form: positional names, the same whatever the labels' spelling, a table the re-reader accepts; a region's
 *   variables allocated in either order give one digest and normal form; a contract predicate's spellings give one
 *   digest, and one not in normal form is refused at decode. Oracle: universal invariances.
 *
 * Features: a shared input, a closure past its arguments; a chain a recursion holds and one past it; two nodes and two
 * expressions clashing; each invariance and each change; several roots; y allocated first; an advanced supply and a
 * spelling not in normal form.
 *
 * Plants: ir-dag-order-reversed (topoOrder lists a node before its inputs), ir-dag-postorder-recursive (postorder
 * recurses, past a small stack), ir-dag-expr-label-shared (two expressions under one label taken as one),
 * ir-dag-digest-reads-locations (the digest reads source locations), ir-dag-digest-domain-ignored (the digest's domain
 * ignored), ir-dag-numbering-from-one (positional names counted from one), ir-dag-free-vars-first-only (a region's
 * free variables its first alone), ir-predicate-spelling-unchecked (a predicate not in normal form decoded).
 */
import { describe, it } from "@effect/vitest"
import { type CaseDiscarded, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	shuffled,
	string,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import {
	ExprId,
	type IdSupply,
	makeIdSupply,
	NodeId,
	OccurrenceId,
	ParamId,
	ScopeId,
	VarId
} from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import {
	cellTable,
	dagDigest,
	emptyDag,
	finishCells,
	mergeDags,
	nodeScopes,
	relNode,
	topoOrder,
	unchangedEdges
} from "#compiler/ir/dag.ts"
import { normalizeDag, toTable, rebuildDag } from "#test/support/dag.ts"

import {
	builtExpr,
	type ExprSpec,
	type ExprTable,
	exprClosure,
	type LiveArgs,
	mapArgs,
	type ScalarExpr,
	sameArgs
} from "#compiler/ir/expr.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import {
	type Cell,
	conservativeMeta,
	exprsOf,
	headingOrder,
	inputsOf,
	keptRefs,
	type LiveRefs,
	mapNode,
	metaSpecOf,
	type RelNode,
	type SpecRefs,
	type ValidDag,
	type ValueRefs,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { contractType } from "#compiler/scalar/registry.ts"
import {
	assert,
	defined,
	nonEmpty,
	refusalLoc,
	refused,
	succeeded,
	throwsDefect,
	unorderedEqual
} from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { normalizeExprTable, scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { validateDag, validateTable } from "#test/support/oracle/dag-validate.ts"
import { definedOpOf } from "#test/support/oracle/gen/ops.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { Exprs, everyKind, fail, heading, scalarTypes } from "#test/unit/ir/fixture.ts"
import { generatedDags } from "#test/unit/ir/population.ts"

const { dag } = everyKind(makeIdSupply())

/** Every vertex `from` reaches along `edges`, `from` included, by breadth-first search. */
const reach = <A>(
	from: ReadonlyArray<A>,
	edges: (vertex: A) => ReadonlyArray<A>
): ReadonlySet<A> => {
	const seen = new Set<A>(from)
	const queue = [...from]
	for (const vertex of queue) {
		for (const next of edges(vertex)) {
			if (!seen.has(next)) {
				seen.add(next)
				queue.push(next)
			}
		}
	}
	return seen
}

/** Every expression the DAG's nodes hold, each once. */
const exprsIn = (d: ValidDag): ReadonlyArray<ScalarExpr> =>
	exprClosure(Arr.flatMap(topoOrder(d), (node) => exprsOf(node)))

/**
 * The DAG with `target` standing for itself as `replacement`: every node above it rebuilt by the one constructor over
 * its rebuilt inputs, every other node kept.
 */
const replacedNode = (d: ValidDag, target: RelNode, replacement: RelNode): ValidDag =>
	rebuildDag(d, (node, inputs) =>
		node === target ? replacement : unchangedEdges(node, inputs) ? node : relNode(node.id, inputs)
	)

/**
 * The DAG with the expression `target` replaced by `replacement` wherever it is read: every expression and node above
 * it rebuilt under its own label, every other one kept.
 */
const replacedExpr = (d: ValidDag, target: ScalarExpr, replacement: ScalarExpr): ValidDag => {
	const exprs = new Fold<ScalarExpr, ScalarExpr>(function* (e) {
		if (e === target) {
			return replacement
		}
		const spec = yield* mapArgs<LiveArgs, LiveArgs>(e)
		return sameArgs(e, spec) ? e : builtExpr(spec, e.id)
	})
	return rebuildDag(d, (node, inputs) => {
		const restated = drive(
			mapNode<ValueRefs<RelNode>, ValueRefs<RelNode>>(inputs, {
				...keptRefs,
				expr: (e) => exprs.of(e)
			}),
			(edge) => edge
		)
		const before = exprsOf(node)
		const after = exprsOf(restated)
		return unchangedEdges(node, inputs) && Arr.every(before, (e, i) => after[i] === e)
			? node
			: relNode(node.id, restated)
	})
}

/**
 * Every label of a DAG respelled by `spell`, one to one, through a fold that rebuilds each node and expression: the same
 * DAG, spelled differently.
 */
const respelled = (d: ValidDag, spell: (label: string) => string): ValidDag => {
	const decls = new Map<VarDecl, VarDecl>()
	const decl = (v: VarDecl): VarDecl => {
		const known = decls.get(v)
		if (known !== undefined) {
			return known
		}
		const renamed: VarDecl = { ...v, id: VarId(spell(v.id)) }
		decls.set(v, renamed)
		return renamed
	}
	const node = (id: NodeId): NodeId => NodeId(spell(id))
	const exprs = new Fold<ScalarExpr, ScalarExpr>(function* (e) {
		const spec = yield* mapArgs<LiveArgs, LiveArgs>(e)
		const renamed: ExprSpec =
			spec.kind === "column"
				? { ...spec, column: { node: node(spec.column.node), name: spec.column.name } }
				: spec
		return builtExpr(renamed, ExprId(spell(e.id)))
	})
	const nodes = new Fold<RelNode, RelNode>(function* (n) {
		const spec = yield* mapNode<LiveRefs, SpecRefs>(n, {
			expr: (e) => exprs.of(e),
			var: decl,
			decl,
			occurrence: (id) => OccurrenceId(spell(id)),
			scope: (id) => ScopeId(spell(id)),
			name: node,
			meta: metaSpecOf
		})
		return relNode(node(n.id), spec)
	})
	return new DagBuilder(makeIdSupply()).build(Arr.map(d.roots, (root) => nodes.of(root)))
}

/** A literal with its int or bool value changed, under its own label; none for any other expression. */
const changedLiteral = (e: ScalarExpr): Option.Option<ScalarExpr> => {
	if (e.kind !== "literal") {
		return Option.none()
	}
	if (e.value.kind === "int") {
		return Option.some(builtExpr({ ...e, value: { kind: "int", value: e.value.value + 1n } }, e.id))
	}
	if (e.value.kind === "bool") {
		return Option.some(builtExpr({ ...e, value: { kind: "bool", value: !e.value.value } }, e.id))
	}
	return Option.none()
}

/**
 * The levels a recursion of one frame per node holds on the small stack: at 160 KB, a recursion over a list of 1,000
 * elements overflows (the testing library's SMALL_STACK).
 */
const smallStackRecursion = 1_000

/**
 * A chain's depth: within the levels a recursion holds on the small stack, or past them up to 60,000 levels; a deeper
 * chain costs its depth at every entry point, so the deepest are drawn the least.
 */
const chainDepth: Gen<number> = weighted([
	[3, int(0, smallStackRecursion)],
	[2, int(smallStackRecursion + 1, 20_000)],
	[1, int(20_001, 60_000)]
])

type ChainFeature = "a chain a recursion holds" | "a chain past a small stack's recursion"

describe("traversals of generated DAGs", () => {
	it.effect(
		"order every reachable node after its inputs, and close expressions over their arguments",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "a naive reachability over each node's inputs and each expression's arguments"
						},
						suite: "unit/ir/traversals",
						literal: Formatter.format,
						draw: drawn(generatedDags),
						runs: 300,
						shrink: completeShrink,
						coverage: required<"a shared input" | "a closure past its arguments">(
							["a shared input", "a closure past its arguments"],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(d, c) =>
						Effect.sync(() => {
							const reachable = reach(d.roots, (node) => inputsOf(node))
							const order = topoOrder(d)
							assert.deepEqual<ReadonlySet<RelNode>>(
								new Set(order),
								reachable,
								"topoOrder lists exactly the reachable nodes"
							)
							assert.equal(order.length, reachable.size, "topoOrder lists each node once")
							const position = new Map(Arr.map(order, (node, i) => [node, i]))
							for (const node of order) {
								for (const input of inputsOf(node)) {
									assert.ok(
										(position.get(input) ?? -1) < (position.get(node) ?? -1),
										`${input.id} before ${node.id}`
									)
								}
							}
							const readers = new Map<RelNode, number>()
							for (const node of reachable) {
								for (const input of inputsOf(node)) {
									readers.set(input, (readers.get(input) ?? 0) + 1)
								}
							}
							if (Arr.some([...readers.values()], (n) => n > 1)) {
								c.note("a shared input")
							}
							for (const e of exprsIn(d)) {
								const expected = reach<ScalarExpr>([e], (x) => x.args)
								const closed = exprClosure([e])
								assert.equal(closed[0], e)
								assert.deepEqual<ReadonlySet<ScalarExpr>>(new Set(closed), expected)
								assert.equal(closed.length, expected.size)
								if (expected.size > 1 + new Set(e.args).size) {
									c.note("a closure past its arguments")
								}
							}
						})
				)
			)
	)

	it.effect(
		"handle a chain of any depth, past what the call stack holds, at every entry point",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/deep-chain",
						literal: Formatter.format,
						draw: drawn(chainDepth),
						runs: 6,
						shrink: completeShrink,
						coverage: required<ChainFeature>(
							["a chain a recursion holds", "a chain past a small stack's recursion"],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "specification",
							name: "the chain's own construction: its depth, its one parameter and its one root"
						}
					},
					(depth, c) =>
						Effect.sync(() => {
							c.note(
								depth > smallStackRecursion
									? "a chain past a small stack's recursion"
									: "a chain a recursion holds"
							)
							const b = new DagBuilder(makeIdSupply())
							const pred = b.expr({
								kind: "literal",
								value: { kind: "bool", value: true },
								args: [],
								type: scalarTypes.bool,
								nonNull: "literal"
							})
							let last = b.node({
								kind: "InputSet",
								input: { kind: "declared", param: ParamId("p") },
								heading: heading(["a", scalarTypes.int8]),
								loc: undefined,
								meta: conservativeMeta
							})
							for (let i = 0; i < depth; i++) {
								last = b.node({
									kind: "Filter",
									input: last,
									pred,
									heading: heading(["a", scalarTypes.int8]),
									loc: undefined,
									meta: conservativeMeta
								})
							}
							const built = b.build([last])
							assert.equal(topoOrder(built).length, depth + 1)
							assert.deepEqual(last.meta.paramDeps, [ParamId("p")])
							validateDag(built)
							const normal = succeeded(normalizeDag(built))
							assert.equal(Rec.size(normal.nodes), depth + 1)
							const below = new Fold<RelNode, number>(function* (node) {
								let deepest = 0
								for (const input of inputsOf(node)) {
									const under: number = yield input
									deepest = Math.max(deepest, under + 1)
								}
								return deepest
							})
							assert.equal(below.of(last), depth)
							assert.equal(nodeScopes(built).of(last).outer.size, 0)
							const cells: Array<Cell> = []
							const cellOf = cellTable(built.roots, (cell) => cells.push(cell))
							const finished = succeeded(
								finishCells(built.roots, (root) => defined(cellOf.get(root), "a root's cell"))
							)
							assert.equal(cells.length, depth + 1)
							assert.equal(
								succeeded(dagDigest(finished.dag, "dag")),
								succeeded(dagDigest(built, "dag"))
							)
							assert.equal(
								topoOrder(mergeDags(mergeDags(emptyDag, built).dag, built).dag).length,
								2 * (depth + 1)
							)
						})
				)
			)
	)
})

/**
 * A DAG the label tests take: the every-kind fixture, which holds every kind of node and expression, or a generated
 * one.
 */
const labelled = weighted([
	[1, constant(dag)],
	[4, generatedDags]
])

/** Which labels a clash repeats: two distinct nodes', or two distinct expressions'. */
type Clash = "two nodes" | "two expressions"

describe("validateDag over a DAG of direct references", () => {
	it.effect(
		"refuses two distinct nodes, or two distinct expressions, under one label, wherever they stand",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/validate-label-clash",
						literal: Formatter.format,
						draw: drawn(
							(source) =>
								[
									source.draw(labelled),
									source.draw(boolean),
									source.draw(pickGen),
									source.draw(pickGen)
								] as const
						),
						runs: 100,
						shrink: completeShrink,
						coverage: required<Clash>(["two nodes", "two expressions"], {
							cases: 100,
							sense: notesOnly
						}),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "specification", name: "one node and one expression per label" }
					},
					([d, overExprs, first, second], c) =>
						Effect.gen(function* () {
							const twoOf = <A>(
								pool: ReadonlyArray<A>
							): Effect.Effect<readonly [A, A], CaseDiscarded> =>
								Effect.gen(function* () {
									yield* c.assume(Arr.isReadonlyArrayNonEmpty(pool))
									const kept = pickFrom(nonEmpty(pool, "a label's holder"), first)
									const rest = Arr.filter(pool, (x) => x !== kept)
									yield* c.assume(Arr.isReadonlyArrayNonEmpty(rest))
									return [kept, pickFrom(nonEmpty(rest, "another holder"), second)] as const
								})
							if (overExprs) {
								const [kept, relabelled] = yield* twoOf(exprsIn(d))
								c.note("two expressions")
								const clashed = replacedExpr(d, relabelled, builtExpr(relabelled, kept.id))
								assert.deepEqual(
									refusalLoc(refused(toTable(clashed), "MalformedDescription")).path,
									["exprs", kept.id]
								)
								throwsDefect(() => validateDag(clashed))
								return
							}
							const [kept, relabelled] = yield* twoOf(topoOrder(d))
							c.note("two nodes")
							const clashed = replacedNode(d, relabelled, relNode(kept.id, relabelled))
							assert.deepEqual(refusalLoc(refused(toTable(clashed), "MalformedDescription")).path, [
								"nodes",
								kept.id
							])
							throwsDefect(() => validateDag(clashed))
						})
				)
			)
	)
})

describe("dagDigest", () => {
	const digest = succeeded(dagDigest(dag, "dag"))

	/** A rewrite the digest must not see: the fixture built from an advanced supply, its labels respelled, a location moved. */
	type Invariance = "a supply advanced" | "labels respelled" | "a location moved"
	const invariances: Arr.NonEmptyReadonlyArray<Invariance> = [
		"a supply advanced",
		"labels respelled",
		"a location moved"
	]

	it.effect("ignores allocation order, label spelling and source locations", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "universal",
						name: "the digest is a function of the DAG's meaning: a rewrite that changes none of it keeps it"
					},
					suite: "unit/ir/dag-digest-invariance",
					literal: Formatter.format,
					draw: drawn((source) => ({
						invariance: source.draw(element(invariances)),
						d: source.draw(labelled),
						burn: source.draw(
							array(element(["node", "expr", "var", "occurrence", "scope"] as const), {
								min: 0,
								max: 40
							})
						),
						salt: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 4 }))
					})),
					runs: 200,
					shrink: completeShrink,
					coverage: required<Invariance>(invariances, { cases: 100, sense: notesOnly }),
					kept: [],
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ invariance, d, burn, salt }, c) =>
					Effect.sync(() => {
						c.note(invariance)
						switch (invariance) {
							case "a supply advanced": {
								const supply = makeIdSupply()
								for (const kind of burn) {
									supply[kind]()
								}
								assert.equal(succeeded(dagDigest(everyKind(supply).dag, "dag")), digest)
								return
							}
							case "labels respelled": {
								const other = respelled(
									d,
									(label) => `x${salt}${Arr.join(Arr.reverse(Str.split(label, "")), "")}`
								)
								validateDag(other)
								assert.equal(succeeded(dagDigest(other, "dag")), succeeded(dagDigest(d, "dag")))
								return
							}
							case "a location moved": {
								const nodes = topoOrder(d)
								assert.ok(Arr.isReadonlyArrayNonEmpty(nodes), "a DAG has a node")
								const moved = c.draw(element(nodes))
								const withLoc = replacedNode(
									d,
									moved,
									relNode(moved.id, { ...moved, loc: SourceLoc("moved", ["a"]) })
								)
								assert.equal(succeeded(dagDigest(withLoc, "dag")), succeeded(dagDigest(d, "dag")))
								return
							}
						}
					})
			)
		)
	)

	/** A changed literal, another domain, or the roots in another order is another DAG. */
	type Change = "a literal changed" | "another domain" | "the roots reversed"
	it.effect("changes with any semantic change", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "universal",
						name: "a changed literal, another domain or the roots reordered is another DAG"
					},
					suite: "unit/ir/dag-digest-sensitivity",
					literal: Formatter.format,
					draw: drawn(labelled),
					runs: 100,
					shrink: completeShrink,
					coverage: required<Change>(
						["a literal changed", "another domain", "the roots reversed"],
						{ cases: 100, sense: notesOnly }
					),
					kept: [],
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(d, c) =>
					Effect.sync(() => {
						const digest = succeeded(dagDigest(d, "dag"))
						c.note("another domain")
						assert.notEqual(succeeded(dagDigest(d, "other-domain")), digest)
						const changed = Arr.findFirst(exprsIn(d), (e) =>
							Option.map(changedLiteral(e), (value) => ({ e, value }))
						)
						if (Option.isSome(changed)) {
							c.note("a literal changed")
							const edited = replacedExpr(d, changed.value.e, changed.value.value)
							assert.notEqual(succeeded(dagDigest(edited, "dag")), digest)
						}
						if (new Set(d.roots).size > 1) {
							c.note("the roots reversed")
							assert.notEqual(
								succeeded(dagDigest({ roots: Arr.reverse([...d.roots]) }, "dag")),
								digest
							)
						}
					})
			)
		)
	)
})

const build = (yFirst: boolean) => {
	const b = new DagBuilder(makeIdSupply())
	const x = new Exprs(b)
	const base = b.node({
		kind: "Base",
		relation: "P",
		occurrence: b.ids.occurrence(),
		primaryKey: ["x", "y"],
		keys: [],
		relationKind: "relation",
		heading: heading(["x", scalarTypes.uuid], ["y", scalarTypes.uuid]),
		loc: undefined,
		meta: conservativeMeta
	})
	const first = b.ids.var()
	const second = b.ids.var()
	const [vy, vx] = yFirst ? [first, second] : [second, first]
	const declX: VarDecl = { id: vx, name: "x", type: scalarTypes.uuid }
	const declY: VarDecl = { id: vy, name: "y", type: scalarTypes.uuid }
	const region = b.node({
		kind: "MatchRegion",
		scope: b.ids.scope(),
		vars: [declX, declY],
		occurrences: [
			{
				id: b.ids.occurrence(),
				source: base,
				bindings: [
					{ column: "x", var: declX },
					{ column: "y", var: declY }
				],
				constants: []
			}
		],
		equalities: [],
		correlated: [],
		heading: heading(["x", scalarTypes.uuid], ["y", scalarTypes.uuid]),
		loc: undefined,
		meta: conservativeMeta
	})
	/** The parent reaches the child before the region: a Filter stands between them. */
	const parent = b.node({
		kind: "Filter",
		input: region,
		pred: x.lit({ kind: "bool", value: true }, scalarTypes.bool),
		heading: heading(["x", scalarTypes.uuid], ["y", scalarTypes.uuid]),
		loc: undefined,
		meta: conservativeMeta
	})
	const probe = b.node({
		kind: "Closed",
		closed: "Probe",
		rows: [
			[
				{ kind: "uuid", value: "00000000-0000-0000-0000-000000000001" },
				{ kind: "uuid", value: "00000000-0000-0000-0000-000000000002" }
			]
		],
		heading: heading(["x", scalarTypes.uuid], ["y", scalarTypes.uuid]),
		loc: undefined,
		meta: conservativeMeta
	})
	/**
	 * The child takes the probe's fact correlated to both of the region's variables: its free variables, which
	 * the attachment binds for it.
	 */
	const child = b.node({
		kind: "Take",
		input: probe,
		order: {
			keys: [
				{ column: "x", dir: "asc" },
				{ column: "y", dir: "asc" }
			]
		},
		bound: { kind: "literal", k: 1n },
		correlation: [
			{ column: "x", expr: x.col(region, "x", scalarTypes.uuid) },
			{ column: "y", expr: x.col(region, "y", scalarTypes.uuid) }
		],
		heading: heading(["x", scalarTypes.uuid], ["y", scalarTypes.uuid]),
		loc: undefined,
		meta: conservativeMeta
	})
	const attach = b.node({
		kind: "Attach",
		parent,
		child,
		name: "probe",
		correlation: [{ parent: "x", child: "x" }],
		judged: "array",
		delivered: "array",
		heading: heading(["x", scalarTypes.uuid], ["y", scalarTypes.uuid]),
		order: headingOrder(child.heading),
		loc: undefined,
		meta: conservativeMeta
	})
	return { dag: b.build([attach]), child, vars: [declX.id, declY.id] }
}

/** Cents over int8 whose domain checks `table`, as the registry builds a checked contract. */
const cents = (table: ExprTable): ScalarType =>
	succeeded(
		contractType(
			parsedName("Cents"),
			scalarOf(f.bigint, {}),
			SourceLoc("a test's checked contract", []),
			table,
			[]
		)
	)

/** Numbered by position from zero: the nodes n#0 to n#k-1, the expressions e#0 to e#m-1. */
const positional = (prefix: string, count: number) =>
	Arr.map(indices(count), (i) => `${prefix}#${i}`)

const predicate = (
	rootSpelling: string,
	valueSpelling: string,
	zeroSpelling: string
): ExprTable => {
	const [root, value, zero] = [ExprId(rootSpelling), ExprId(valueSpelling), ExprId(zeroSpelling)]
	return {
		root,
		exprs: {
			[root]: {
				id: root,
				kind: "op",
				op: definedOpOf("int8ge"),
				args: [value, zero],
				type: scalarTypes.bool,
				nonNull: "strict",
				volatility: "immutable",
				deps: { params: [], nodes: [] }
			},
			[value]: {
				id: value,
				kind: "value",
				args: [],
				type: scalarTypes.int8,
				nonNull: "storage",
				volatility: "immutable",
				deps: { params: [], nodes: [] }
			},
			[zero]: {
				id: zero,
				kind: "literal",
				value: { kind: "int", value: 0n },
				args: [],
				type: scalarTypes.int8,
				nonNull: "literal",
				volatility: "immutable",
				deps: { params: [], nodes: [] }
			}
		}
	}
}

type NormalFeature = "several roots" | "a shared input"

describe("normalizeDag", () => {
	it.effect(
		"renames positionally, ignores label spelling, and gives a table the re-reader accepts",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "the normal form is positional, the same however the DAG's labels are spelled"
						},
						suite: "unit/ir/dag-normal-form",
						literal: Formatter.format,
						draw: drawn(
							(source) =>
								[
									source.draw(
										weighted([
											[1, constant(dag)],
											[4, generatedDags]
										])
									),
									source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 3 }))
								] as const
						),
						runs: 100,
						shrink: completeShrink,
						coverage: required<NormalFeature>(["several roots", "a shared input"], {
							cases: 100,
							sense: notesOnly
						}),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([d, salt], c) =>
						Effect.sync(() => {
							if (new Set(d.roots).size > 1) {
								c.note("several roots")
							}
							const inputs = Arr.flatMap(topoOrder(d), (node) => inputsOf(node))
							if (new Set(inputs).size < inputs.length) {
								c.note("a shared input")
							}
							const normal = succeeded(normalizeDag(d))
							validateTable(normal)
							unorderedEqual<string>(
								Rec.keys(normal.nodes),
								positional("n", Rec.size(normal.nodes))
							)
							unorderedEqual<string>(
								Rec.keys(normal.exprs),
								positional("e", Rec.size(normal.exprs))
							)
							assert.equal(normal.roots[0], NodeId("n#0"))
							const other = succeeded(normalizeDag(respelled(d, (label) => `${salt}~${label}`)))
							assert.equal(
								succeeded(encode(other, everyProperty)),
								succeeded(encode(normal, everyProperty))
							)
						})
				)
			)
	)

	it.effect(
		"ignores the allocation order of a region's variables, and finds them free in the child that reads them",
		(ctx) => {
			/**
			 * Planted: no generator allocates both variables a child is correlated to in either order; both allocation
			 * orders give one digest and one normal form, and the child's scope names both of the region's variables.
			 */
			const reference = build(false).dag
			return searched(
				ctx,
				exhaust(
					{
						box: "both allocation orders of a region's two variables, read by a child correlated to both",
						oracle: {
							kind: "universal",
							name: "allocation order is no part of the digest or the normal form, and the child's free variables are the region's"
						},
						suite: "unit/ir/dag-free-vars",
						literal: Formatter.format,
						generator: boolean,
						limit: 2,
						coverage: requiredInSpace<"y allocated first">(["y allocated first"]),
						caseHang
					},
					(yFirst, c) =>
						Effect.sync(() => {
							if (yFirst) {
								c.note("y allocated first")
							}
							const { dag: d, child, vars } = build(yFirst)
							assert.equal(succeeded(dagDigest(d, "dag")), succeeded(dagDigest(reference, "dag")))
							assert.equal(
								succeeded(encode(succeeded(normalizeDag(d)), everyProperty)),
								succeeded(encode(succeeded(normalizeDag(reference)), everyProperty))
							)
							unorderedEqual(nodeScopes(d).of(child).freeVars, vars)
							assert.equal(nodeScopes(d).of(defined(d.roots[0])).outer.size, 0)
						})
				)
			)
		}
	)

	it.effect(
		"gives one digest to DAGs whose contract predicates were allocated differently",
		(ctx) => {
			const build = (type: ScalarType, supply: IdSupply) => {
				const b = new DagBuilder(supply)
				const base = b.node({
					kind: "Base",
					relation: "Price",
					occurrence: b.ids.occurrence(),
					primaryKey: ["amount"],
					keys: [],
					relationKind: "relation",
					heading: heading(["amount", type]),
					loc: undefined,
					meta: conservativeMeta
				})
				return b.build([base])
			}
			/**
			 * Planted: no generator draws a contract type. Every spelling of the three entries from a pool of identifiers, and a
			 * supply advanced by any amount, give one digest once normalized; still spelled by allocation, the predicate is
			 * refused where a type no registry built enters, the decoder, so it can never reach a fingerprint.
			 */
			const reference = succeeded(
				dagDigest(
					build(cents(succeeded(normalizeExprTable(predicate("e3", "e1", "e2")))), makeIdSupply()),
					"dag"
				)
			)
			const pool = ["e1", "e2", "e3", "e12", "e77", "e90"] as const
			/** Three distinct identifiers, drawn in order, as the predicate's root, value and zero. */
			const spellingOf = (
				spelling: ReadonlyArray<string>
			): readonly [root: string, value: string, zero: string] => [
				defined(spelling[0], "a root's spelling"),
				defined(spelling[1], "a value's spelling"),
				defined(spelling[2], "a zero's spelling")
			]
			return searched(
				ctx,
				exhaust(
					{
						box: "every spelling of the predicate's three entries by distinct identifiers of the pool, under a supply advanced 0 to 3 steps",
						oracle: {
							kind: "universal",
							name: "a predicate's digest is its normal form's, and a spelling not in normal form is refused at decode"
						},
						suite: "unit/ir/dag-contract-allocation",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(
									map(shuffled(pool, { min: 3, max: 3 }), (spelling) => spellingOf(spelling))
								),
								source.draw(int(0, 3))
							] as const,
						limit: pool.length * (pool.length - 1) * (pool.length - 2) * 4,
						coverage: requiredInSpace<"an advanced supply" | "a spelling not in normal form">([
							"an advanced supply",
							"a spelling not in normal form"
						]),
						caseHang
					},
					([[root, value, zero], advance], c) =>
						Effect.sync(() => {
							const spelled = predicate(root, value, zero)
							const supply = makeIdSupply()
							for (let i = 0; i < advance * 3; i++) {
								supply.expr()
							}
							if (advance > 0) {
								c.note("an advanced supply")
							}
							assert.equal(
								succeeded(
									dagDigest(build(cents(succeeded(normalizeExprTable(spelled))), supply), "dag")
								),
								reference
							)
							const normal = succeeded(normalizeExprTable(spelled))
							if (
								normal.root !== spelled.root ||
								Arr.some(Rec.keys(normal.exprs), (id) => !Rec.has(spelled.exprs, id))
							) {
								c.note("a spelling not in normal form")
								assert.equal(
									fail(
										decodeScalarType({
											...scalarTypes.cents,
											contract: { ...defined(contractOf(scalarTypes.cents)), predicate: spelled }
										})
									).reason._tag,
									"MalformedDescription"
								)
							}
						})
				)
			)
		}
	)
})
