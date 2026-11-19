/**
 * The obligation graph (physical/obligations/graph.ts):
 *
 * - **Install order:** its order keeps every edge, refined by the phase order, ties broken by the kinds' rank and then
 *   by the identity each object's name was minted from, never by the name: of every order of the objects that keeps
 *   each edge, the least by (phase, kind rank, identity) position by position, whatever order the objects arrived in;
 *   the manifest holds the objects in that order and every edge once, by its two ends' identities; and two
 *   installations of one graph, whose hashed names differ by their digests, order it alike. Half the graphs name every
 *   object by a word longer than a stem holds, so every stem ties and the names differ by their digests alone.
 * - **Reasons:** an object's reasons, its own then each it is given later, are kept each once, in the order first given.
 *
 * Oracles: a second implementation of the order, enumerating every order of at most six objects and taking the least;
 * the reasons given, deduplicated in order.
 *
 * Features: an order of several phases, a dependency against identity order, hashed names whose stems tie; a reason
 * given twice, reasons added later.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Number as Num, Option, Order } from "effect"
import { compareIdentities, type Identity, identity } from "#compiler/core/identity.ts"
import { identText, ObligationGraph, phaseOrder } from "#compiler/physical/obligations/graph.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { pickIndex } from "#test/support/pick.ts"
import {
	graphGen,
	installations,
	leastOrder,
	type OrderFeature,
	place,
	type Placed,
	reasonPool,
	sameReason,
	type Shape,
	type Spec,
	unstemmed
} from "#test/unit/physical/graph.fixtures.ts"

/** The obligation graph orders by phase, then by dependency, then by kind and identity. Its budget is its suite's before it was a property (test/unit/physical/graph.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const theObligationGraphOrdersByPhaseThenByDependencyThenByKindAndIdentity =
	property.explore(graphGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"an order of several phases",
			"a dependency against identity order",
			"hashed names whose stems tie"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check: (_2, c: Case<OrderFeature>) => (sketch) =>
			Effect.sync(() => {
				const planted = Arr.map(sketch.objects, (o, i): Shape => ({
					name: sketch.longNames ? `${unstemmed}${i}` : `o${i}`,
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
				if (new Set(Arr.map(specs, (s) => s.named.stem)).size < specs.length) {
					c.note("hashed names whose stems tie")
				}
				const bySpec = new Map(Arr.map(specs, (s) => [identText(s.ident), s]))
				if (
					Arr.some(edges, ([from, to]) => {
						const a = defined(bySpec.get(from))
						const b = defined(bySpec.get(to))
						return (
							a.phase === b.phase && a.kind === b.kind && compareIdentities(a.named, b.named) > 0
						)
					})
				) {
					c.note("a dependency against identity order")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "every order of the objects that keeps each edge, the least by phase, kind rank and identity"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/obligations/graph.ts",
				original: "\t\t\t? compareIdentities(a.identity, b.identity)",
				replacement: "\t\t\t? compareStrings(identifierOf(a.identity), identifierOf(b.identity))",
				why: "Hashed names tie by their digests' text, not by the identity they were minted from."
			}
		]
	})

/** The obligation graph keeps an object's reasons, its own then each given later, once each. Its budget is its suite's before it was a property (test/unit/physical/graph.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const theObligationGraphKeepsAnObjectsReasonsItsOwnThenEachGivenLaterOnceEach =
	property.explore(
		(source) => ({
			own: source.draw(array(element(reasonPool), { min: 0, max: 3 })),
			later: source.draw(array(array(element(reasonPool), { min: 0, max: 3 }), { min: 0, max: 3 }))
		}),
		{
			needs: {},
			budget: { runs: 200, steered: 200 },
			situations: ["a reason given twice", "reasons added to the object"] satisfies ReadonlyArray<
				Reached<"a reason given twice" | "reasons added to the object">
			>,
			check:
				(_, c: Case<"a reason given twice" | "reasons added to the object">) =>
				({ own, later }) =>
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
					}),
			oracle: {
				kind: "specification",
				name: "the reasons given, each once, in the order first given"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/physical/obligations/graph.ts",
					original:
						"\t\t\treasons: distinct([...node.reasons, ...(this.#reasons.get(node) ?? [])]),",
					replacement:
						"\t\t\treasons: distinct([...(this.#reasons.get(node) ?? []), ...node.reasons]),",
					why: "Reasons given later come before an object's own."
				}
			]
		}
	)
