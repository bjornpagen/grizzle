/** What the property of insert-all-computed.test.ts reads: its schema, its programs, its space and its model. */

import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural } from "#compiler/public/fields.ts"
import { param } from "#compiler/public/query.ts"
import {
	contained,
	counted,
	fin,
	on,
	ordered,
	relation,
	schema,
	tree
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"

/** A package's name, and every text of the schema, as pantry's: up to eight letters. */
const PackageName = str.regex("^[a-z]{1,8}$")

/** A document of a package, nesting its tokens in order at `tokens`, its counted attributes at `attrs`. */
const Doc = relation(
	"Doc",
	{
		package: PackageName,
		id: natural,
		title: PackageName,
		tokens: drawn(natural),
		attrs: drawn(natural)
	},
	["package", "id"]
)

/** A token of a document, an ordered family's member, written only nested under its document. */
const Token = relation(
	"Token",
	{ package: PackageName, id: natural, at: drawn(natural), text: PackageName },
	["package", "id", "at"]
)

/** A counted attribute of a document, copying its document's title, as pantry's Attribute copies its Node's. */
const Attr = relation(
	"Attr",
	{ package: PackageName, id: natural, name: PackageName, title: accumulated(PackageName, "a") },
	["package", "id", "name"]
)

/** A tree of cells per package and root, every node nested under its root, as pantry's CellLeaf's leaves. */
const Cell = relation(
	"Cell",
	{
		package: PackageName,
		root: natural,
		start: drawn(natural),
		end: drawn(natural),
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		leaf: PackageName
	},
	["package", "root", "start"]
)

/** A plain relation of a package. */
const Ref = relation("Ref", { package: PackageName, id: natural, target: natural }, [
	"package",
	"id"
])

export const Publish = schema(
	"Publish",
	[Doc, Token, Attr, Cell, Ref],
	[
		ordered(on(Token, "package", "id", "at"), fin(Doc, "tokens")),
		counted(on(Attr, "package", "id"), fin(Doc, "attrs")),
		contained(on(Attr, "package", "id", "title"), on(Doc, "package", "id", "title")),
		tree(on(Cell, "parent", "at"), fin(Cell, "children"), { root: ["package", "root"] })
	]
)

/**
 * The two publishes of a package: `computed`, pantry's, every relation's `package` computed from the call's one
 * parameter, its rows leaving it out; and `stated`, insertAll's, every row stating it, the oracle.
 */
const programs = Object.freeze({
	computed: ChangeSet.empty(Publish).insertAllComputed(
		{ Doc: [], Attr: [], Cell: [], Ref: [] },
		{ package: param("package", PackageName) }
	),
	stated: ChangeSet.empty(Publish).insertAll({ Doc: [], Attr: [], Cell: [], Ref: [] })
})

export const publishInstall = Object.freeze({ label: "publish", programs })

/** Publish installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const publishTemplate = fixtureTemplate(import.meta, Publish, publishInstall)

/** A node of a cell tree: its leaf's letter and its children. */
export interface CellNode {
	readonly leaf: string
	readonly children: ReadonlyArray<CellNode>
}

/** A package's content: its documents, each with its tokens and its attributes' names, its cell trees and its refs. */
export interface Content {
	readonly docs: ReadonlyArray<{
		readonly tokens: ReadonlyArray<string>
		readonly attrs: ReadonlyArray<string>
	}>
	readonly trees: ReadonlyArray<CellNode>
	readonly refs: ReadonlyArray<number>
}

/** A letter of a few, so tokens, leaves and names repeat. */
const letter: Gen<string> = element(["a", "b", "c"] as const)

const cellGen =
	(depth: number): Gen<CellNode> =>
	(source) => ({
		leaf: source.draw(letter),
		children: depth === 0 ? [] : source.draw(array(cellGen(depth - 1), { min: 0, max: 2 }))
	})

export const contentGen: Gen<Content> = (source) => ({
	docs: source.draw(
		array(
			(s) => ({
				tokens: s.draw(array(letter, { min: 0, max: 3 })),
				attrs: Arr.dedupe(s.draw(array(letter, { min: 0, max: 3 })))
			}),
			{ min: 0, max: 3 }
		)
	),
	trees: source.draw(array(cellGen(2), { min: 0, max: 2 })),
	refs: source.draw(array(int(0, 9), { min: 0, max: 3 }))
})

export type ContentFeature =
	| "a document nesting tokens"
	| "a document of no token"
	| "a document with attributes"
	| "a cell tree two deep"
	| "a ref"
	| "nothing at all"

/** Whether a package's content holds no row: no document, no cell tree and no ref. */
export const isEmpty = (c: Content): boolean =>
	c.docs.length === 0 && c.trees.length === 0 && c.refs.length === 0

export const contentFeatures = (c: Content): ReadonlyArray<ContentFeature> => [
	...(Arr.some(c.docs, (d) => d.tokens.length > 0) ? (["a document nesting tokens"] as const) : []),
	...(Arr.some(c.docs, (d) => d.tokens.length === 0) ? (["a document of no token"] as const) : []),
	...(Arr.some(c.docs, (d) => d.attrs.length > 0) ? (["a document with attributes"] as const) : []),
	...(Arr.some(c.trees, (t) => Arr.some(t.children, (k) => k.children.length > 0))
		? (["a cell tree two deep"] as const)
		: []),
	...(c.refs.length > 0 ? (["a ref"] as const) : []),
	...(isEmpty(c) ? (["nothing at all"] as const) : [])
]

export const situations = [
	"a document nesting tokens",
	"a document of no token",
	"a document with attributes",
	"a cell tree two deep",
	"a ref",
	"nothing at all"
] as const satisfies ReadonlyArray<Reached<ContentFeature>>

/** A cell below its root as its tree's facts nest it: its leaf and its children. */
interface CellFact {
	readonly leaf: string
	readonly children: ReadonlyArray<CellFact>
}

/** A cell tree as its facts nest it, below its root. */
const nestedCell = (n: CellNode): CellFact => ({
	leaf: n.leaf,
	children: Arr.map(n.children, nestedCell)
})

/**
 * A package's rows as a publish states them, each relation's under its name, every top row stating `package` where
 * `stated` names it and none where the call computes it: each document `id` its place, its title its first token or
 * `t`, its tokens nested in order; each attribute naming its document; each cell tree's root `root` its place, its
 * nodes nested; each ref `id` its place.
 */
export const factsOf = <const P extends object>(c: Content, stated: P) => ({
	Doc: Arr.map(c.docs, (d, id) => ({
		...stated,
		id: BigInt(id),
		title: d.tokens[0] ?? "t",
		tokens: Arr.map(d.tokens, (text) => ({ text }))
	})),
	Attr: Arr.flatMap(c.docs, (d, id) =>
		Arr.map(d.attrs, (name) => ({ ...stated, id: BigInt(id), name }))
	),
	Cell: Arr.map(c.trees, (t, root) => ({
		...stated,
		root: BigInt(root),
		leaf: t.leaf,
		children: Arr.map(t.children, nestedCell)
	})),
	Ref: Arr.map(c.refs, (target, id) => ({ ...stated, id: BigInt(id), target: BigInt(target) }))
})

/** The fields each table is read back by, `package` first. */
export const fieldsOf: Readonly<Record<string, ReadonlyArray<string>>> = {
	Doc: ["package", "id", "title", "tokens", "attrs"],
	Token: ["package", "id", "at", "text"],
	Attr: ["package", "id", "name", "title"],
	Cell: ["package", "root", "start", "end", "parent", "at", "children", "leaf"],
	Ref: ["package", "id", "target"]
}
