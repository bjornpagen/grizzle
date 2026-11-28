/** What the properties of dag.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/testing/assert"
import { constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import {
	ExprId,
	type IdSupply,
	makeIdSupply,
	NodeId,
	OccurrenceId,
	ScopeId,
	VarId
} from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import { dagDigest, relNode, topoOrder, unchangedEdges } from "#compiler/ir/dag.ts"
import {
	builtExpr,
	exprClosure,
	type ExprSpec,
	type ExprTable,
	type LiveArgs,
	mapArgs,
	sameArgs,
	type ScalarExpr
} from "#compiler/ir/expr.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import {
	conservativeMeta,
	exprsOf,
	headingOrder,
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
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { contractType } from "#compiler/scalar/registry.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { rebuildDag } from "#test/support/dag.ts"
import { f } from "#test/support/fixtures/ir/desc.ts"
import { normalizeExprTable, scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { definedOpOf } from "#test/support/oracle/gen/ops.ts"
import { everyKind, Exprs, heading, scalarTypes } from "#test/support/unit/ir/fixture.ts"
import { generatedDags } from "#test/support/unit/ir/population.ts"

export const { dag } = everyKind(makeIdSupply())

/** Every vertex `from` reaches along `edges`, `from` included, by breadth-first search. */
export const reach = <A>(
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
export const exprsIn = (d: ValidDag): ReadonlyArray<ScalarExpr> =>
	exprClosure(Arr.flatMap(topoOrder(d), (node) => exprsOf(node)))

/**
 * The DAG with `target` standing for itself as `replacement`: every node above it rebuilt by the one constructor over
 * its rebuilt inputs, every other node kept.
 */
export const replacedNode = (d: ValidDag, target: RelNode, replacement: RelNode): ValidDag =>
	rebuildDag(d, (node, inputs) =>
		node === target ? replacement : unchangedEdges(node, inputs) ? node : relNode(node.id, inputs)
	)

/**
 * The DAG with the expression `target` replaced by `replacement` wherever it is read: every expression and node above
 * it rebuilt under its own label, every other one kept.
 */
export const replacedExpr = (
	d: ValidDag,
	target: ScalarExpr,
	replacement: ScalarExpr
): ValidDag => {
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
export const respelled = (d: ValidDag, spell: (label: string) => string): ValidDag => {
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
export const changedLiteral = (e: ScalarExpr): Option.Option<ScalarExpr> => {
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
export const smallStackRecursion = 1_000

/**
 * A chain's depth: within the levels a recursion holds on the small stack, or past them up to 60,000 levels; a deeper
 * chain costs its depth at every entry point, so the deepest are drawn the least.
 */
export const chainDepth: Gen<number> = weighted([
	[3, int(0, smallStackRecursion)],
	[2, int(smallStackRecursion + 1, 20_000)],
	[1, int(20_001, 60_000)]
])

/** A chain's depth against a small stack: one a recursion holds, or one past it. */
export type ChainFeature = "a chain a recursion holds" | "a chain past a small stack's recursion"

/**
 * A DAG the label tests take: the every-kind fixture, which holds every kind of node and expression, or a generated
 * one.
 */
export const labelled = weighted([
	[1, constant(dag)],
	[4, generatedDags]
])

/**
 * Which labels a clash repeats: two distinct nodes', or two distinct expressions'; a DAG holding no two of either kind
 * has no clash to plant, and is noted as such.
 */
export type Clash = "two nodes" | "two expressions" | "a DAG holding no two of a kind"

/** The digest of the fixture DAG. */
export const digest = succeeded(dagDigest(dag, "dag", new DagTemplates("derivation")))

/** A rewrite the digest must not see: the fixture built from an advanced supply, its labels respelled, a location moved. */
export type Invariance = "a supply advanced" | "labels respelled" | "a location moved"

/** Every rewrite the digest must not see. */
export const invariances: Arr.NonEmptyReadonlyArray<Invariance> = [
	"a supply advanced",
	"labels respelled",
	"a location moved"
]

/** A changed literal, another domain, or the roots in another order is another DAG. */
export type Change = "a literal changed" | "another domain" | "the roots reversed"

/**
 * A DAG of a region over Base with its two variables x and y, allocated y first or x first, and a child correlated to
 * both.
 */
export const build = (yFirst: boolean) => {
	const b = new DagBuilder(makeIdSupply())
	const x = new Exprs(b)
	const base = b.node({
		kind: "Base",
		relation: "P",
		occurrence: b.ids.occurrence(),
		primaryKey: ["x", "y"],
		keys: [],
		relationKind: "relation",
		generated: [],
		unit: [],
		determined: [],
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
		orders: [
			{
				keys: [
					{ column: "x", dir: "asc" },
					{ column: "y", dir: "asc" }
				]
			}
		],
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
export const cents = (table: ExprTable): ScalarType =>
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
export const positional = (prefix: string, count: number) =>
	Arr.map(indices(count), (i) => `${prefix}#${i}`)

/** The predicate VALUE >= 0 as a table, its root, value and zero spelled as given. */
export const predicate = (
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

/** What a normalized DAG held: several roots, and an input two nodes share. */
export type NormalFeature = "several roots" | "a shared input"

/**
 * Planted: no generator allocates both variables a child is correlated to in either order; both allocation
 * orders give one digest and one normal form, and the child's scope names both of the region's variables.
 */
export const reference = build(false).dag

/** The identifiers a predicate's entries are spelled with. */
export const pool = ["e1", "e2", "e3", "e12", "e77", "e90"] as const

/** Three distinct identifiers, drawn in order, as the predicate's root, value and zero. */
export const spellingOf = (
	spelling: ReadonlyArray<string>
): readonly [root: string, value: string, zero: string] => [
	defined(spelling[0], "a root's spelling"),
	defined(spelling[1], "a value's spelling"),
	defined(spelling[2], "a zero's spelling")
]

/** What the search built once before its cases (build, reference), now once per worker: every case on it reads them. */
export const buildNeed = {
	key: "test/support/unit/ir/dag.fixtures.ts buildNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const build = (type: ScalarType, supply: IdSupply) => {
			const b = new DagBuilder(supply)
			const base = b.node({
				kind: "Base",
				relation: "Price",
				occurrence: b.ids.occurrence(),
				primaryKey: ["amount"],
				keys: [],
				relationKind: "relation",
				generated: [],
				unit: [],
				determined: [],
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
				"dag",
				new DagTemplates("derivation")
			)
		)
		return Effect.succeed({ build, reference })
	})
} as const satisfies Need<unknown>
