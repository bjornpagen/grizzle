/**
 * What the property of owner-copies.test.ts reads: its box, the schema, the ChangeSet and the call of each case, and
 * its features.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { accumulated, drawn, natural } from "#compiler/public/fields.ts"
import { param } from "#compiler/public/query.ts"
import { schema, type Statement } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { relationBuilder as relation } from "#compiler/schema/relation.ts"
import {
	containedBuilder,
	countedBuilder,
	finBuilder,
	onBuilder,
	orderedBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"

/** Every text of the box: up to eight letters, as pantry's package and path keys. */
const Key = str.regex("^[a-z]{1,8}$")

/** The owner's shape: a tree whose root fields are (pkg, path), each node keyed (pkg, path, start) by its place in its
 * tree; or a plain relation keyed (pkg, path, start), its start stated. */
type Shape = "tree" | "plain"

/** The field the owner's insert computes from the call's parameter (ChangeSet.insertComputed): `pkg`, a field of its
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

/** The call's parameters, the computed fields' values. */
const callParams = { pkg: "p", note: "n" } as const

/**
 * The case's schema and its write, with the call's facts: Node(pkg, path, start, tag, note), a tree's nodes or a plain
 * relation's rows, the owner of a counted family of Attr, each Attr carrying its node's key (pkg, path, start) and, where
 * the case copies, the node's `tag`. Written apart, Attr(pkg, path, start, name) is inserted beside the nodes, an Attr at
 * each node; nested, each node nests one P(pkg, path, start, at, v), a member of its sequence `ps`, nesting one
 * Attr(pkg, path, start, pat, at), a member of P's sequence `ms`, so Attr's rows are the nesting's and its statement
 * Node's. The owner's insert computes its case's field from the parameter of its name, and the members' insert
 * computing `pkg` from `pkg`, so every row holds the call's one value of each.
 */
export const copyingOf = (
	c: CopyCase
): { readonly schema: AnySchema; readonly changeSet: () => unknown } => {
	const tag = c.copies ? { tag: accumulated(Key, "a") } : {}
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
	const S = schema("Copies", nested ? [Node, P, Attr] : [Node, Attr], laws)
	/** A node's own fields as its facts state them: every one but the computed field, and a tree's root fields at its
	 * root alone. */
	const own = (root: boolean, start: bigint) => ({
		...(root && c.computes !== "key" ? { pkg: callParams.pkg } : {}),
		...(root ? { path: "a" } : {}),
		...(c.shape === "plain" ? { start } : {}),
		tag: root ? "t" : "u",
		...(c.computes === "payload" ? {} : { note: callParams.note }),
		...(nested ? { ps: [{ v: "v", ms: [{}] }] } : {})
	})
	/** The nodes: a tree's root with one child, at starts 0 and 1; or a plain relation's one row at start 0. */
	const nodes =
		c.shape === "tree"
			? [{ ...own(true, 0n), children: [{ ...own(false, 1n), children: [] }] }]
			: [own(true, 0n)]
	const starts = c.shape === "tree" ? [0n, 1n] : [0n]
	/** An Attr at each node, its group the node's key. */
	const attrs = Arr.map(starts, (start) => ({
		...(c.members === "stated" ? { pkg: callParams.pkg } : {}),
		path: "a",
		start,
		name: "x"
	}))
	return {
		schema: S,
		changeSet: () => {
			const withNodes = (() => {
				switch (c.computes) {
					case "key":
						return ChangeSet.empty(S).insertComputed(Node, nodes, { pkg: param("pkg", Key) })
					case "payload":
						return ChangeSet.empty(S).insertComputed(Node, nodes, { note: param("note", Key) })
					case "nothing":
						return ChangeSet.empty(S).insert(Node, nodes)
				}
			})()
			switch (c.members) {
				case "nested":
					return withNodes
				case "stated":
					return withNodes.insert(Attr, attrs)
				case "computed":
					return withNodes.insertComputed(Attr, attrs, { pkg: param("pkg", Key) })
			}
		}
	}
}
