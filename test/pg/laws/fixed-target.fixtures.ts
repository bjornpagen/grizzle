/** What the properties of fixed-target.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Data } from "effect"
import { closedId, natural, pg } from "#compiler/public/fields.ts"
import {
	closed,
	contained,
	mutable,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"

export const NodeKind = closed.ordered("NodeKind", ["document", "element"])

const Node = relation(
	"Node",
	{ id: pg.integer, kind: closedId(NodeKind), document: pg.integer, depth: natural },
	["id"]
)

const Document = relation("Document", { node: pg.integer }, ["node"])

/**
 * The box's schema, both relations mutable: a containment between immutable relations that joins within one unit is
 * judged whole at COMMIT and installs no foreign key (laws/model/plan.ts containmentDischarge, since bb62f0fa1), and
 * this box reads the fixed target's native lowering, its foreign key into the shared target.
 */
export const FixedTarget = schema(
	"fixed_target",
	[NodeKind, Node, Document],
	[
		contained(
			on(Document, "node"),
			on(
				select(Node, (n) =>
					n.and(n.eq(n.kind, "document"), n.eq(n.document, n.id), n.eq(n.depth, 0n))
				),
				"id"
			)
		),
		mutable(Node),
		mutable(Document)
	]
)

export const RELATIONS = ["Node", "Document"] as const

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

export type Kind = "document" | "element"

/** A node row of the box: its kind, its document and its depth. */
interface NodeRow {
	readonly kind: Kind
	readonly document: number
	readonly depth: number
}

/** A case: nodes 0 and 1 each absent or a row, and the document rows among their ids. */
interface Sketch {
	readonly nodes: ReadonlyArray<NodeRow | undefined>
	readonly documents: ReadonlyArray<number>
}

const IDS = [0, 1] as const

const SUBSETS: Arr.NonEmptyReadonlyArray<ReadonlyArray<number>> = [[], [0], [1], [0, 1]]

const nodeGen: Gen<NodeRow | undefined> = (source) =>
	source.draw(element([false, true]))
		? {
				kind: source.draw(element<Kind>(["document", "element"])),
				document: source.draw(element([0, 1])),
				depth: source.draw(element([0, 1]))
			}
		: undefined

export const sketchGen: Gen<Sketch> = (source) => ({
	nodes: Arr.map(IDS, () => source.draw(nodeGen)),
	documents: source.draw(element(SUBSETS))
})

/** What keeps a document row's node from meeting it: no node, or a node off one of the three fields the target fixes. */
type Missed = "no node" | "a node of another kind" | "a node of another document" | "a node deeper"

/** Why the document row `id` meets no node, by the containment's meaning; none where it meets its node. */
export const missedOf = (s: Sketch, id: number): ReadonlyArray<Missed> => {
	const node = s.nodes[id]
	if (node === undefined) {
		return ["no node"]
	}
	return [
		...(node.kind === "document" ? [] : ["a node of another kind" as const]),
		...(node.document === id ? [] : ["a node of another document" as const]),
		...(node.depth === 0 ? [] : ["a node deeper" as const])
	]
}

export type FixedTargetFeature = "committed" | "committed a document" | `refused for ${Missed}`
