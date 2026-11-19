/** What the properties of graph.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { compareIdentities, type Identity, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import {
	type DeployPhase,
	type PhysicalKind,
	physicalKinds,
	type PhysicalReason
} from "#compiler/ir/products.ts"
import {
	identText,
	type Node,
	type NodeIdent,
	ObligationGraph,
	phaseOrder
} from "#compiler/physical/obligations/graph.ts"
import { parsedSchemaName, wild } from "#test/support/kernel/naming.ts"
import { pickGen } from "#test/support/pick.ts"

const kinds = [
	"schema",
	"constant",
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
	/** Every object's name a word longer than a hashed name's stem holds, then its index, so no stem holds a name and
	 * every stem ties: the objects' hashed names differ by their digests alone. */
	readonly longNames: boolean
}

export const graphGen: Gen<GraphSketch> = (source) => ({
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
	tie: source.draw(boolean),
	longNames: source.draw(boolean)
})

/** A word no hashed name's stem holds whole: as long as an identifier. */
export const unstemmed = Str.repeat(63)("o")

/** An object of a drawn graph before its installation: its declared name, kind and phase. */
export interface Shape {
	readonly name: string
	readonly kind: PhysicalKind
	readonly phase: DeployPhase
}

/** An object of a drawn graph: its shape, its name as a filter function of one role of the installation (a hashed
 * name, whose digest differs between installations), and its graph identity, that function's. */
export interface Spec extends Shape {
	readonly named: Identity<"filter">
	readonly ident: NodeIdent
}

/** An added object with its phase, which names the phases of the objects it may follow. */
export type Placed = {
	readonly [P in DeployPhase]: { readonly phase: P; readonly node: Node<P> }
}[DeployPhase]

/** Adds `spec` to `g` after each of `after`, every one of its phase or an earlier one. */
export const place = (g: ObligationGraph, spec: Spec, after: ReadonlyArray<Placed>): Placed => {
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
export const installations = [
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
export const leastOrder = (
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

export type OrderFeature =
	| "an order of several phases"
	| "a dependency against identity order"
	| "hashed names whose stems tie"

/** A reason of the pool an addition draws from: two laws, the workload's access, an enforcement. */
const lawA: LawId = wild.lawId("a")

const lawB: LawId = wild.lawId("b")

export const reasonPool: Arr.NonEmptyReadonlyArray<PhysicalReason> = [
	{ kind: "law", law: lawA },
	{ kind: "law", law: lawB },
	{ kind: "access" },
	{ kind: "enforcement", of: "the relation" }
]

export const sameReason = (a: PhysicalReason, b: PhysicalReason): boolean => {
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
