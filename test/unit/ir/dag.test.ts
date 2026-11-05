import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	filter,
	int,
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
	cellFold,
	dagDigest,
	finishCells,
	mergeDags,
	nodeScopes,
	normalizeDag,
	rebuildDag,
	relNode,
	toTable,
	topoOrder,
	unchangedEdges
} from "#compiler/ir/dag.ts"

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
	type NodeSpec,
	type RelNode,
	type SpecRefs,
	type ValidDag,
	type ValueRefs,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { decodeScalarType } from "#compiler/ir/scalar-shape.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { decodeWith } from "#compiler/ir/shape.ts"
import { contractType } from "#compiler/scalar/registry.ts"
import {
	assert,
	containsText,
	defined,
	refusalLoc,
	succeeded,
	throwsDefect,
	unorderedEqual
} from "#test/support/assert.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { normalizeExprTable, scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { dagTableShape, validateDag, validateTable } from "#test/support/oracle/dag-validate.ts"
import { definedOpOf } from "#test/support/oracle/gen/ops.ts"
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

describe("traversals of generated DAGs", () => {
	it.effect(
		"order every reachable node after its inputs, and close expressions over their arguments",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/traversals",
						literal: Formatter.format,
						draw: drawn(generatedDags),
						runs: 300,
						shrink: completeShrink,
						coverage: required<"a shared input" | "a deep closure">(
							["a shared input", "a deep closure"],
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
								if (expected.size > 2) {
									c.note("a deep closure")
								}
							}
						})
				)
			)
	)

	it("handle a chain far deeper than the call stack, at every entry point", () => {
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
		for (let i = 0; i < 50_000; i++) {
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
		assert.equal(topoOrder(built).length, 50_001)
		assert.deepEqual(last.meta.paramDeps, [ParamId("p")])
		validateDag(built)
		const normal = succeeded(normalizeDag(built))
		assert.equal(Rec.size(normal.nodes), 50_001)
		succeeded(dagDigest(built, "dag"))
		const depth = new Fold<RelNode, number>(function* (node) {
			let deepest = 0
			for (const input of inputsOf(node)) {
				const below: number = yield input
				deepest = Math.max(deepest, below + 1)
			}
			return deepest
		})
		assert.equal(depth.of(last), 50_000)
		assert.equal(nodeScopes(built).of(last).outer.size, 0)
		const cells: Array<Cell> = []
		const cellOf = cellFold((cell) => cells.push(cell))
		const finished = succeeded(finishCells(built.roots, (root) => cellOf.of(root)))
		assert.equal(cells.length, 50_001)
		assert.equal(succeeded(dagDigest(finished.dag, "dag")), succeeded(dagDigest(built, "dag")))
		assert.equal(topoOrder(mergeDags(built, built).dag).length, 100_002)
	}, 120_000)
})

/**
 * A builder's defect against the IR's shape, planted in the take of a two-node DAG, and the path of the value it breaks.
 */
type Planted =
	| "an empty column name"
	| "a repeated column name"
	| "a property no node holds"
	| "a bound of zero"

const plantedTake = (input: RelNode, planted: Planted): NodeSpec => {
	const take: NodeSpec = {
		kind: "Take",
		input,
		order: { keys: [{ column: "a", dir: "asc" }] },
		bound: { kind: "literal", k: planted === "a bound of zero" ? 0n : 1n },
		correlation: [],
		heading: heading(["a", scalarTypes.int8]),
		loc: undefined,
		meta: conservativeMeta
	}
	switch (planted) {
		case "an empty column name":
			return { ...take, heading: heading(["", scalarTypes.int8]) }
		case "a repeated column name":
			return { ...take, heading: heading(["a", scalarTypes.int8], ["a", scalarTypes.int8]) }
		case "a property no node holds": {
			/** Spread from a wider value, which no excess property check sees. */
			const wider = { ...take, extra: 1 }
			return wider
		}
		case "a bound of zero":
			return take
	}
}

describe("DagBuilder.build", () => {
	it.effect(
		"builds a DAG whose shape defect the re-reader raises where the decode of its table refuses it",
		(ctx) => {
			const planted: Arr.NonEmptyReadonlyArray<Planted> = [
				"an empty column name",
				"a repeated column name",
				"a property no node holds",
				"a bound of zero"
			]
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/dag-planted",
						literal: Formatter.format,
						generator: element(planted),
						limit: planted.length,
						coverage: requiredInSpace<Planted>(planted),
						caseHang
					},
					(p, c) =>
						Effect.sync(() => {
							c.note(p)
							const b = new DagBuilder(makeIdSupply())
							const input = b.node({
								kind: "InputSet",
								input: { kind: "declared", param: ParamId("p") },
								heading: heading(["a", scalarTypes.int8]),
								loc: undefined,
								meta: conservativeMeta
							})
							const take = b.node(plantedTake(input, p))
							const built = b.build([take])
							const outside: unknown = succeeded(toTable(built))
							const refusal = fail(decodeWith(dagTableShape, outside, "relational DAG"))
							assert.equal(refusal.reason._tag, "MalformedDescription")
							assert.deepEqual(refusalLoc(refusal).path.slice(0, 2), ["nodes", take.id])
							containsText(
								throwsDefect(() => validateDag(built)),
								refusal.message
							)
						})
				)
			)
		}
	)
})

describe("dagDigest", () => {
	const digest = succeeded(dagDigest(dag, "dag"))

	it.effect(
		"ignores allocation order: a supply advanced by any amount builds the same digest",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/dag-182",
						literal: Formatter.format,
						draw: drawn(
							array(element(["node", "expr", "var", "occurrence", "scope"] as const), {
								min: 0,
								max: 40
							})
						),
						runs: 50,
						shrink: completeShrink,
						coverage: noCoverage,
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(burn) =>
						Effect.sync(() => {
							const supply = makeIdSupply()
							for (const kind of burn) {
								supply[kind]()
							}
							const other = everyKind(supply).dag
							assert.equal(succeeded(dagDigest(other, "dag")), digest)
						})
				)
			)
	)

	it.effect("ignores label spelling", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/ir/dag-57",
					literal: Formatter.format,
					draw: drawn(string(codePoint(0x20, 0x7e), { min: 0, max: 4 })),
					runs: 50,
					shrink: completeShrink,
					coverage: noCoverage,
					kept: [],
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(salt) =>
					Effect.sync(() => {
						const other = respelled(
							dag,
							(label) => `x${salt}${Arr.join(Arr.reverse(Str.split(label, "")), "")}`
						)
						validateDag(other)
						assert.equal(succeeded(dagDigest(other, "dag")), digest)
					})
			)
		)
	)

	/**
	 * A DAG the digest is taken of: the every-kind fixture, which holds every kind of node and expression, or a
	 * generated one.
	 */
	const dags = weighted([
		[1, constant(dag)],
		[4, generatedDags]
	])

	it.effect("ignores source locations", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/ir/dag-digest-invariance",
					literal: Formatter.format,
					draw: drawn(dags),
					runs: 100,
					shrink: completeShrink,
					coverage: required<"a moved location">(["a moved location"], {
						cases: 100,
						sense: notesOnly
					}),
					kept: [],
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(d, c) =>
					Effect.sync(() => {
						const nodes = topoOrder(d)
						assert.ok(Arr.isReadonlyArrayNonEmpty(nodes), "a DAG has a node")
						const moved = c.draw(element(nodes))
						const withLoc = replacedNode(
							d,
							moved,
							relNode(moved.id, { ...moved, loc: SourceLoc("moved", ["a"]) })
						)
						c.note("a moved location")
						assert.equal(succeeded(dagDigest(withLoc, "dag")), succeeded(dagDigest(d, "dag")))
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
					suite: "unit/ir/dag-digest-sensitivity",
					literal: Formatter.format,
					draw: drawn(dags),
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

describe("normalizeDag", () => {
	it.effect(
		"renames positionally, ignores label spelling, and gives a table the re-reader accepts",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
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
						coverage: noCoverage,
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([d, salt]) =>
						Effect.sync(() => {
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
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/dag-contract-allocation",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(
									filter(
										(spelling) =>
											[
												spelling.draw(element(pool)),
												spelling.draw(element(pool)),
												spelling.draw(element(pool))
											] as const,
										([r, v, z]) => new Set([r, v, z]).size === 3,
										1
									)
								),
								source.draw(int(0, 3))
							] as const,
						limit: 600,
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
