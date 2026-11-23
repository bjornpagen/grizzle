/**
 * What the property of owner-copies.test.ts reads: its box, the schema, the ChangeSet and the call of each case, and
 * its features.
 */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import { param } from "#compiler/public/query.ts"
import { schema, type Statement } from "#compiler/public/schema.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import {
	containedBuilder,
	countedBuilder,
	finBuilder,
	onBuilder,
	orderedBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"

/** Every value of the box but a place: an integer, which a parameter binds as its field's type with no domain of its
 * own (pantry's package and path are texts; the stamps and the host's groups read no type). */
const Key = pg.integer

/** The owner's shape: a tree whose root fields are (pkg, path), each node keyed (pkg, path, start) by its place in its
 * tree; or a plain relation keyed (pkg, path, start), its start stated. */
type Shape = "tree" | "plain"

/** The field the owner's insert computes from the call's parameter (ChangeSet.insertAllComputed): `pkg`, a field of its
 * key, a tree's root field, which every member carries in its group; `note`, a payload field; or none, an insert. */
type Computes = "key" | "payload" | "nothing"

/** How the members are written: an insert of their own computing `pkg`, one stating it, or nested under the owner two
 * deep, each member of a sequence of the owner's sequence members as well as of the owner's counted family. */
type Members = "computed" | "stated" | "nested"

export interface CopyCase {
	readonly shape: Shape
	readonly computes: Computes
	readonly members: Members
	/** Whether each member copies the owner's `tag` (a containment of the member's group and `tag` in the owner's key
	 * and `tag`, the member's `tag` accumulated). */
	readonly copies: boolean
}

export type CopyFeature =
	| "a tree owner"
	| "a plain owner"
	| "a key field computed"
	| "a payload field computed"
	| "nothing computed"
	| "members computing their group field"
	| "members stating it"
	| "members nested under the owner"
	| "a copy held"
	| "a copy drawn"
	| "no copy"
	| "a write refused"

export const copyGen: Gen<CopyCase> = (source) => ({
	shape: source.draw(element(["tree", "plain"] as const)),
	computes: source.draw(element(["key", "payload", "nothing"] as const)),
	members: source.draw(element(["computed", "stated", "nested"] as const)),
	copies: source.draw(element([true, false] as const))
})

export const copyFeatures = (c: CopyCase): ReadonlyArray<CopyFeature> => [
	c.shape === "tree" ? "a tree owner" : "a plain owner",
	c.computes === "key"
		? "a key field computed"
		: c.computes === "payload"
			? "a payload field computed"
			: "nothing computed",
	c.members === "computed"
		? "members computing their group field"
		: c.members === "stated"
			? "members stating it"
			: "members nested under the owner",
	...(c.copies ? [] : ["no copy" as const])
]

/**
 * What the rule says of a case's write: it binds; or it is refused where it compiles (UnsupportedOperation), its members
 * written apart holding a group field `pkg` that is not one value of the call with their owner's, one side computing it
 * and the other stating it, so the host could not tell which owner a member names. A nested member carries its owner's
 * stamp, and members and owner computing `pkg` compute it by one term, the parameter `pkg`.
 */
export const verdictOf = (c: CopyCase): "bound" | "refused" =>
	c.members !== "nested" && (c.computes === "key") !== (c.members === "computed")
		? "refused"
		: "bound"

/** Every case of the box, in its generator's order. */
const everyCase: ReadonlyArray<CopyCase> = Arr.flatMap(["tree", "plain"] as const, (shape) =>
	Arr.flatMap(["key", "payload", "nothing"] as const, (computes) =>
		Arr.flatMap(["computed", "stated", "nested"] as const, (members) =>
			Arr.map([true, false] as const, (copies): CopyCase => ({ shape, computes, members, copies }))
		)
	)
)

/** The cases whose write binds (`verdictOf`), the ones a call runs. */
export const boundGen: Gen<CopyCase> = element(
	nonEmpty(
		Arr.filter(everyCase, (c) => verdictOf(c) === "bound"),
		"the box's cases whose write binds"
	)
)

/** The call's parameters, the computed fields' values. */
export const callParams = { pkg: 1, note: 5 } as const

/** Every node's path. */
export const path = 2

/** Where a write's facts are: stated in its ChangeSet, which the call's members carry as they are; or the call's, its
 * ChangeSet's members none, served as a login's workload calls it (`CopyWrite` facts). */
type FactsIn = "changeSet" | "call"

/** A case's relations, schema and write (`copyingOf`). */
export interface CopyWrite {
	readonly schema: AnySchema
	readonly Node: AnyRelation
	readonly Attr: AnyRelation
	readonly P: AnyRelation
	readonly changeSet: (facts: FactsIn) => unknown
	/** The call's facts by relation, as a served call states them: the nodes, and the Attrs written apart. */
	readonly facts: { readonly insert: Readonly<Record<string, ReadonlyArray<unknown>>> }
	/** The call's parameters, each one its write declares: `pkg` where an insert computes it, `note` where the nodes'
	 * insert does (`callParams`). */
	readonly params: Readonly<Record<string, number>>
}

/** A tree's two nodes or a plain relation's one row, by start: each node's `tag`, which its Attrs copy. */
export const nodesOf = (
	c: CopyCase
): ReadonlyArray<{ readonly start: bigint; readonly tag: number }> =>
	c.shape === "tree"
		? [
				{ start: 0n, tag: 3 },
				{ start: 1n, tag: 4 }
			]
		: [{ start: 0n, tag: 3 }]

/**
 * The case's schema, named `name`, and its write: Node(pkg, path, start, tag, note), a tree's nodes or a plain
 * relation's rows, the owner of a counted family of Attr, each Attr carrying its node's key (pkg, path, start) and,
 * where the case copies, the node's `tag`. Written apart, Attr(pkg, path, start, name) is inserted beside the nodes, an
 * Attr `x` at each node; nested, each node nests one P(pkg, path, start, at, v), a member of its sequence `ps`, nesting
 * one Attr(pkg, path, start, pat, at), a member of P's sequence `ms`, so Attr's rows are the nesting's and its statement
 * Node's. The owner's insert computes its case's field from the parameter of its name, and the members' insert
 * computing `pkg` from `pkg`, so every row holds the call's one value of each (`callParams`): pkg 1, note 5; every
 * node at path 2, its tag 3 at the root and 4 at its child, every Attr named 6 and every P valued 7.
 */
export const copyingOf = (c: CopyCase, name: string): CopyWrite => {
	const tag = c.copies ? { tag: accumulated(Key, 0) } : {}
	const nested = c.members === "nested"
	const place = c.shape === "tree" ? drawn(natural) : natural
	const Node = relation(
		"Node",
		{
			pkg: Key,
			path: Key,
			start: place,
			attributes: drawn(natural),
			tag: Key,
			note: Key,
			...(c.shape === "tree"
				? {
						end: drawn(natural),
						parent: drawn(natural),
						at: drawn(natural),
						children: drawn(natural)
					}
				: {}),
			...(nested ? { ps: drawn(natural) } : {})
		},
		["pkg", "path", "start"],
		[]
	)
	const P = relation(
		"P",
		{ pkg: Key, path: Key, start: natural, at: drawn(natural), ms: drawn(natural), v: Key },
		["pkg", "path", "start", "at"],
		[]
	)
	const Attr = nested
		? relation(
				"Attr",
				{ pkg: Key, path: Key, start: natural, pat: natural, at: drawn(natural), ...tag },
				["pkg", "path", "start", "pat", "at"],
				[]
			)
		: relation(
				"Attr",
				{ pkg: Key, path: Key, start: natural, name: Key, ...tag },
				["pkg", "path", "start", "name"],
				[]
			)
	const laws: ReadonlyArray<Statement> = [
		...(c.shape === "tree"
			? [
					treeBuilder(onBuilder(Node, ["parent", "at"]), finBuilder(Node, "children"), {
						root: ["pkg", "path"]
					})
				]
			: []),
		...(nested
			? [
					orderedBuilder(onBuilder(P, ["pkg", "path", "start", "at"]), finBuilder(Node, "ps")),
					orderedBuilder(
						onBuilder(Attr, ["pkg", "path", "start", "pat", "at"]),
						finBuilder(P, "ms")
					)
				]
			: []),
		countedBuilder(onBuilder(Attr, ["pkg", "path", "start"]), finBuilder(Node, "attributes")),
		...(c.copies
			? [
					containedBuilder(
						onBuilder(Attr, ["pkg", "path", "start", "tag"]),
						onBuilder(Node, ["pkg", "path", "start", "tag"])
					)
				]
			: [])
	]
	const S = schema(name, nested ? [Node, P, Attr] : [Node, Attr], laws)
	/** A node's own fields as its facts state them: every one but the computed field, and a tree's root fields at its
	 * root alone. */
	const own = (root: boolean, start: bigint) => ({
		...(root && c.computes !== "key" ? { pkg: callParams.pkg } : {}),
		...(root ? { path } : {}),
		...(c.shape === "plain" ? { start } : {}),
		tag: root ? 3 : 4,
		...(c.computes === "payload" ? {} : { note: callParams.note }),
		...(nested ? { ps: [{ v: 7, ms: [{}] }] } : {})
	})
	/** The nodes: a tree's root with one child, at starts 0 and 1; or a plain relation's one row at start 0
	 * (`nodesOf`). */
	const nodes =
		c.shape === "tree"
			? [{ ...own(true, 0n), children: [{ ...own(false, 1n), children: [] }] }]
			: [own(true, 0n)]
	/** An Attr at each node, its group the node's key. */
	const attrs = Arr.map(nodesOf(c), ({ start }) => ({
		...(c.members === "stated" ? { pkg: callParams.pkg } : {}),
		path,
		start,
		name: 6
	}))
	return {
		schema: S,
		Node,
		Attr,
		P,
		changeSet: (facts) => {
			const nodeFacts = facts === "changeSet" ? nodes : []
			const attrFacts = facts === "changeSet" ? attrs : []
			const withNodes = (() => {
				switch (c.computes) {
					case "key":
						return ChangeSet.empty(S).insertAllComputed(
							{ Node: nodeFacts },
							{ pkg: param("pkg", Key) }
						)
					case "payload":
						return ChangeSet.empty(S).insertAllComputed(
							{ Node: nodeFacts },
							{ note: param("note", Key) }
						)
					case "nothing":
						return ChangeSet.empty(S).insert(Node, nodeFacts)
				}
			})()
			switch (c.members) {
				case "nested":
					return withNodes
				case "stated":
					return withNodes.insert(Attr, attrFacts)
				case "computed":
					return withNodes.insertAllComputed({ Attr: attrFacts }, { pkg: param("pkg", Key) })
			}
		},
		facts: { insert: c.members === "nested" ? { Node: nodes } : { Node: nodes, Attr: attrs } },
		params: {
			...(c.computes === "key" || c.members === "computed" ? { pkg: callParams.pkg } : {}),
			...(c.computes === "payload" ? { note: callParams.note } : {})
		}
	}
}
