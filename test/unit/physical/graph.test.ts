import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Number as Num, Option, Order } from "effect"
import { compareIdentities, type Identity, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import {
	type DeployPhase,
	type PhysicalKind,
	type PhysicalReason,
	physicalKinds
} from "#compiler/ir/products.ts"

import {
	identText,
	type Node,
	type NodeIdent,
	ObligationGraph,
	phaseOrder
} from "#compiler/physical/obligations/graph.ts"
import { assert, defined } from "#test/support/assert.ts"
import { parsedName, parsedSchemaName, wild } from "#test/support/kernel/naming.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"

/** The obligation graph. Its install order keeps every edge, refined by the phase order,
 * ties broken by the kinds' rank and then by the identity each object's name was minted from, never by the name: of
 * every order of the objects that keeps each edge, the least by (phase, kind rank, identity) position by position,
 * whatever order the objects arrived in, and one order for two installations of one graph, whose hashed names differ by
 * their digests. The oracle enumerates every order of at most six objects. An object's reasons, its own then each it
 * is given later, are kept each once, in the order first given. */
const kinds = [
	"schema",
	"enum",
	"table",
	"foreignKey",
	"index",
	"role"
] as const satisfies ReadonlyArray<PhysicalKind>

const phases = [
	"setup",
	"structure",
	"indexes",
	"validate",
	"publish"
] as const satisfies ReadonlyArray<DeployPhase>

interface GraphSketch {
	readonly objects: ReadonlyArray<{ readonly kind: PhysicalKind; readonly phase: DeployPhase }>
	readonly edges: ReadonlyArray<readonly [number, number]>
	/** A key per object; the objects are added in the order of their keys, each once the objects it follows are. */
	readonly arrival: ReadonlyArray<number>
	/** Planted in an unbroken graph: the second object of the first's phase and kind, and before it by an edge, so the
	 * dependency runs against identity order. */
	readonly tie: boolean
}

const graphGen: Gen<GraphSketch> = (source) => ({
	objects: source.draw(
		array(
			(source) => ({ kind: source.draw(element(kinds)), phase: source.draw(element(phases)) }),
			{
				min: 2,
				max: 6
			}
		)
	),
	edges: source.draw(
		array((source) => [source.draw(pickGen), source.draw(pickGen)] as const, { min: 0, max: 8 })
	),
	arrival: source.draw(array(int(0, 2 ** 31 - 1), { min: 6, max: 6 })),
	tie: source.draw(boolean)
})

/** An object of a drawn graph before its installation: its declared name, kind and phase. */
interface Shape {
	readonly name: string
	readonly kind: PhysicalKind
	readonly phase: DeployPhase
}

/** An object of a drawn graph: its shape, its name as a filter function of one role of the installation (a hashed
 * name, whose digest differs between installations), and its graph identity, that function's. */
interface Spec extends Shape {
	readonly named: Identity<"filter">
	readonly ident: NodeIdent
}

/** An added object with its phase, which names the phases of the objects it may follow. */
type Placed = {
	readonly [P in DeployPhase]: { readonly phase: P; readonly node: Node<P> }
}[DeployPhase]

/** Adds `spec` to `g` after each of `after`, every one of its phase or an earlier one. */
const place = (g: ObligationGraph, spec: Spec, after: ReadonlyArray<Placed>): Placed => {
	const object = { kind: spec.kind, ident: spec.ident, ddl: [], reasons: [] }
	switch (spec.phase) {
		case "setup":
			return {
				phase: spec.phase,
				node: g.add(
					{ ...object, phase: spec.phase },
					Arr.flatMap(after, (a) => (a.phase === "setup" ? [a.node] : []))
				)
			}
		case "structure":
			return {
				phase: spec.phase,
				node: g.add(
					{ ...object, phase: spec.phase },
					Arr.flatMap(after, (a) =>
						a.phase === "setup" || a.phase === "structure" ? [a.node] : []
					)
				)
			}
		case "indexes":
			return {
				phase: spec.phase,
				node: g.add(
					{ ...object, phase: spec.phase },
					Arr.flatMap(after, (a) =>
						a.phase === "validate" || a.phase === "publish" ? [] : [a.node]
					)
				)
			}
		case "validate":
			return {
				phase: spec.phase,
				node: g.add(
					{ ...object, phase: spec.phase },
					Arr.flatMap(after, (a) => (a.phase === "publish" ? [] : [a.node]))
				)
			}
		case "publish":
			return {
				phase: spec.phase,
				node: g.add(
					{ ...object, phase: spec.phase },
					Arr.map(after, (a) => a.node)
				)
			}
	}
}

/** The two installations each drawn graph is built under. */
const installations = [
	identity.schema(parsedSchemaName("graph_order")),
	identity.schema(parsedSchemaName("graph_order_again"))
] as const

/** Every order of `items`. */
const permutations = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
	items.length === 0
		? [[]]
		: Arr.flatMap(items, (item, i) =>
				Arr.map(permutations([...items.slice(0, i), ...items.slice(i + 1)]), (rest) => [
					item,
					...rest
				])
			)

/** Two specs by phase, then by kind, then by identity. */
const compareKeys = (a: Spec, b: Spec): number => {
	const byPhase = phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase)
	if (byPhase !== 0) {
		return byPhase
	}
	const byKind = physicalKinds.indexOf(a.kind) - physicalKinds.indexOf(b.kind)
	return byKind !== 0 ? byKind : compareIdentities(a.named, b.named)
}

/** The least order of `specs` keeping every edge, compared position by position. */
const leastOrder = (
	specs: ReadonlyArray<Spec>,
	edges: ReadonlyArray<readonly [string, string]>
): ReadonlyArray<string> => {
	const keeps = (order: ReadonlyArray<Spec>) => {
		const at = new Map(Arr.map(order, (s, i) => [identText(s.ident), i]))
		return Arr.every(edges, ([from, to]) => defined(at.get(from)) < defined(at.get(to)))
	}
	const lexical = (a: ReadonlyArray<Spec>, b: ReadonlyArray<Spec>): number => {
		for (const [i, s] of a.entries()) {
			const d = compareKeys(s, defined(b[i]))
			if (d !== 0) {
				return d
			}
		}
		return 0
	}
	const [first, ...rest] = Arr.filter(permutations(specs), keeps)
	return Arr.map(
		Arr.reduce(rest, defined(first), (least, order) => (lexical(order, least) < 0 ? order : least)),
		(s) => identText(s.ident)
	)
}

type OrderFeature = "an order of several phases" | "a dependency against identity order"

/** A reason of the pool an addition draws from: two laws, the workload's access, an enforcement. */
const lawA: LawId = wild.lawId("a")
const lawB: LawId = wild.lawId("b")
const reasonPool: Arr.NonEmptyReadonlyArray<PhysicalReason> = [
	{ kind: "law", law: lawA },
	{ kind: "law", law: lawB },
	{ kind: "access" },
	{ kind: "enforcement", of: "the relation" }
]

const sameReason = (a: PhysicalReason, b: PhysicalReason): boolean => {
	switch (a.kind) {
		case "law":
			return b.kind === "law" && a.law === b.law
		case "access":
			return b.kind === "access"
		case "enforcement":
			return b.kind === "enforcement" && a.of === b.of
		case "proof":
			return (
				b.kind === "proof" &&
				a.premises.length === b.premises.length &&
				Arr.every(a.premises, (law, i) => b.premises[i] === law)
			)
	}
}

describe("the obligation graph", () => {
	it.effect("orders by phase, then by dependency, then by kind and identity", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/physical/obligation-order",
					draw: drawn(graphGen),
					literal: Formatter.format,
					coverage: required<OrderFeature>(
						["an order of several phases", "a dependency against identity order"],
						{ cases: 300, sense: notesOnly }
					),
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(sketch, c) =>
					Effect.sync(() => {
						const planted = Arr.map(sketch.objects, (o, i): Shape => ({
							name: `o${i}`,
							kind: o.kind,
							phase: o.phase
						}))
						const tie = sketch.tie
						const shapes = Arr.map(planted, (s, i): Shape =>
							tie && i === 1
								? { ...s, phase: defined(planted[0]).phase, kind: defined(planted[0]).kind }
								: s
						)
						/** The drawn edges oriented by (phase, arrival key, position), so they keep the phase order, form no cycle, and
						 * may run against identity order inside a phase. */
						const position = (i: number) =>
							[
								phaseOrder.indexOf(defined(shapes[i]).phase),
								tie && i === 1 ? -1 : defined(sketch.arrival[i]),
								i
							] as const
						const before = (i: number, j: number) => {
							const [pi, ki, ii] = position(i)
							const [pj, kj, ij] = position(j)
							return pi < pj || (pi === pj && (ki < kj || (ki === kj && ii < ij)))
						}
						const valid = Arr.flatMap(
							sketch.edges,
							([a, b]): ReadonlyArray<readonly [number, number]> => {
								const i = pickIndex(a, shapes.length)
								const j = pickIndex(b, shapes.length)
								if (i === j) {
									return []
								}
								return before(i, j) ? [[i, j]] : [[j, i]]
							}
						)
						const indexEdges: ReadonlyArray<readonly [number, number]> = [
							...valid,
							...(tie ? [[1, 0] as const] : [])
						]
						/** The graph under one installation: its objects and its edges by graph identity. */
						const under = (installation: Identity<"schema">) => {
							const specs = Arr.map(shapes, (shape): Spec => {
								const named = identity.filter(
									identity.role(installation, parsedName("writer")),
									shape.name
								)
								return {
									...shape,
									named,
									ident: { kind: "function", schema: installation, name: named }
								}
							})
							const ident = (i: number) => identText(defined(specs[i]).ident)
							const edges: ReadonlyArray<readonly [string, string]> = Arr.map(
								indexEdges,
								([i, j]) => [ident(i), ident(j)] as const
							)
							const g = new ObligationGraph()
							/** The objects by arrival key, each added once every object it follows is. */
							const arrival = Arr.map(
								Arr.sort(
									Arr.map(specs, (_, i) => ({ i, key: defined(sketch.arrival[i]) })),
									Order.mapInput(Order.Number, (x: { readonly key: number }) => x.key)
								),
								({ i }) => i
							)
							const placed = new Map<number, Placed>()
							while (placed.size < specs.length) {
								const i = Option.getOrThrow(
									Arr.findFirst(
										arrival,
										(k) =>
											!placed.has(k) &&
											Arr.every(indexEdges, ([from, to]) => to !== k || placed.has(from))
									)
								)
								const after = Arr.flatMap(indexEdges, ([from, to]) => {
									const p = placed.get(from)
									return to === i && p !== undefined ? [p] : []
								})
								placed.set(i, place(g, defined(specs[i]), after))
							}
							return { specs, edges, g }
						}
						const graphs = Arr.map(installations, under)
						/** Each installation's order, by declared name: the least order by identity, and one order for both. */
						const orders = Arr.map(graphs, ({ specs, edges, g }) => {
							const nameOf = new Map(Arr.map(specs, (s) => [identText(s.ident), s.name]))
							const named = (ident: string): string => defined(nameOf.get(ident))
							const expected = leastOrder(specs, edges)
							assert.deepEqual<ReadonlyArray<string>>(
								Arr.map(g.order(), (o) => o.ident),
								expected
							)
							/** The manifest holds the objects in that order, and every edge once, by its two ends' identities. */
							const manifest = g.manifest({ roleDefaults: [], publicRevokes: [] })
							assert.deepEqual<ReadonlyArray<string>>(
								Arr.map(manifest.objects, (o) => o.ident),
								expected
							)
							const identityOf = new Map(Arr.map(specs, (s) => [identText(s.ident), s.named]))
							type Edge = { readonly from: string; readonly to: string }
							const byIdentity: Order.Order<string> = (x, y) =>
								Num.sign(compareIdentities(defined(identityOf.get(x)), defined(identityOf.get(y))))
							const distinct = [
								...new Map(Arr.map(edges, ([from, to]) => [`${from} ${to}`, { from, to }])).values()
							]
							assert.deepEqual(
								manifest.edges,
								Arr.sort(
									distinct,
									Order.combine(
										Order.mapInput(byIdentity, (e: Edge) => e.from),
										Order.mapInput(byIdentity, (e: Edge) => e.to)
									)
								)
							)
							return {
								objects: Arr.map(expected, named),
								edges: Arr.map(manifest.edges, (e) => [named(e.from), named(e.to)])
							}
						})
						assert.deepEqual(
							orders[1],
							orders[0],
							"two installations of one graph order its objects alike"
						)
						const { specs, edges } = defined(graphs[0])
						if (new Set(Arr.map(specs, (s) => s.phase)).size > 1) {
							c.note("an order of several phases")
						}
						const bySpec = new Map(Arr.map(specs, (s) => [identText(s.ident), s]))
						if (
							Arr.some(edges, ([from, to]) => {
								const a = defined(bySpec.get(from))
								const b = defined(bySpec.get(to))
								return (
									a.phase === b.phase &&
									a.kind === b.kind &&
									compareIdentities(a.named, b.named) > 0
								)
							})
						) {
							c.note("a dependency against identity order")
						}
					})
			)
		)
	)

	it.effect("keeps an object's reasons, its own then each given later, once each", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/physical/obligation-reasons",
					draw: drawn((source) => ({
						own: source.draw(array(element(reasonPool), { min: 0, max: 3 })),
						later: source.draw(
							array(array(element(reasonPool), { min: 0, max: 3 }), { min: 0, max: 3 })
						)
					})),
					literal: Formatter.format,
					coverage: required<"a reason given twice" | "reasons added to the object">(
						["a reason given twice", "reasons added to the object"],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				({ own, later }, c) =>
					Effect.sync(() => {
						const g = new ObligationGraph()
						const node = g.add(
							{
								kind: "index",
								ident: { kind: "text", text: "index:s.i" },
								ddl: [],
								reasons: own,
								phase: "indexes"
							},
							[]
						)
						for (const reasons of later) {
							g.addReasons(node, reasons)
						}
						if (Arr.some(later, (reasons) => reasons.length > 0)) {
							c.note("reasons added to the object")
						}
						const given = [...own, ...Arr.flatten(later)]
						const expected = Arr.dedupeWith(given, sameReason)
						if (expected.length < given.length) {
							c.note("a reason given twice")
						}
						const [object] = g.order()
						assert.deepEqual(defined(object).reasons, expected)
						assert.equal(defined(object).state, "needed")
					})
			)
		)
	)
})
