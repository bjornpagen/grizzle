/** What the property of insert-all-computed.test.ts reads: its schema, its programs, its space and its model. */

import type { Reached } from "@bjornpagen/testing/features"
import { array, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg, place } from "#compiler/public/fields.ts"
import { param } from "#compiler/public/query.ts"
import {
	check,
	contained,
	counted,
	fin,
	fold,
	Monoid,
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

/**
 * A tree of cells per package and root, every node nested under its root, as pantry's Node: each node's counted Marks,
 * facts of their own naming it by its package, its root and its `start`, which the walk draws, fold their values into
 * its `weight`, as an element's attributes fold their slots into Node.attrs (AL2), and Marked holds every node to a
 * mark, as AL3 holds an element to the attributes its governor requires.
 */
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
		leaf: PackageName,
		marks: drawn(natural),
		weight: accumulated(pg.bigint, 0n)
	},
	["package", "root", "start"]
)

/** A mark of a cell, a counted member naming its node, as pantry's Attribute names its Node. */
const Mark = relation(
	"Mark",
	{ package: PackageName, root: natural, start: natural, name: PackageName, v: pg.bigint },
	["package", "root", "start", "name"]
)

const cellMarks = counted(on(Mark, "package", "root", "start"), fin(Cell, "marks"))

/**
 * A note of a package, one a call to its group (package, id), at the place its insert stamps, which no host value
 * holds; Weighed holds its weight to 1, so a refused note is witnessed by its key with its place named as drawn.
 */
const Note = relation("Note", { package: PackageName, id: natural, n: place, weight: pg.bigint }, [
	"package",
	"id",
	"n"
])

/** A plain relation of a package. */
const Ref = relation("Ref", { package: PackageName, id: natural, target: natural }, [
	"package",
	"id"
])

export const Publish = schema(
	"Publish",
	[Doc, Token, Attr, Cell, Mark, Note, Ref],
	[
		ordered(on(Token, "package", "id", "at"), fin(Doc, "tokens")),
		counted(on(Attr, "package", "id"), fin(Doc, "attrs")),
		contained(on(Attr, "package", "id", "title"), on(Doc, "package", "id", "title")),
		tree(on(Cell, "parent", "at"), fin(Cell, "children"), { root: ["package", "root"] }),
		cellMarks,
		fold(
			cellMarks,
			Monoid.sum,
			on(Mark, "package", "root", "start", "v"),
			on(Cell, "package", "root", "start", "weight")
		),
		check("Marked", Cell, (c) => c.ge(c.weight, 1n)),
		check("Weighed", Note, (n) => n.ge(n.weight, 1n))
	]
)

/**
 * The two publishes of a package: `computed`, pantry's, every relation's `package` computed from the call's one
 * parameter, its rows leaving it out; and `stated`, insertAll's, every row stating it, the oracle.
 */
const programs = Object.freeze({
	computed: ChangeSet.empty(Publish).insertAllComputed(
		{ Doc: [], Attr: [], Cell: [], Mark: [], Note: [], Ref: [] },
		{ package: param("package", PackageName) }
	),
	stated: ChangeSet.empty(Publish).insertAll({
		Doc: [],
		Attr: [],
		Cell: [],
		Mark: [],
		Note: [],
		Ref: []
	})
})

export const publishInstall = Object.freeze({ label: "publish", programs })

/** Publish installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const publishTemplate = fixtureTemplate(import.meta, Publish, publishInstall)

/** A node of a cell tree: its leaf's letter and its children. */
export interface CellNode {
	readonly leaf: string
	readonly children: ReadonlyArray<CellNode>
}

/**
 * A package's content: its documents, each with its tokens and its attributes' names, its cell trees, every node marked
 * once, its notes' weights, one note to each id, and its refs; `unmarked`, whether its last tree's last node lacks its
 * mark, as qti-pie's choice package with one item's required title removed, which Marked refuses; a note of weight 0
 * Weighed refuses.
 */
export interface Content {
	readonly docs: ReadonlyArray<{
		readonly tokens: ReadonlyArray<string>
		readonly attrs: ReadonlyArray<string>
	}>
	readonly trees: ReadonlyArray<CellNode>
	readonly refs: ReadonlyArray<number>
	readonly notes: ReadonlyArray<bigint>
	readonly unmarked: boolean
}

/** A letter of a few, so tokens, leaves and names repeat. */
const letter: Gen<string> = element(["a", "b", "c"] as const)

const cellGen =
	(depth: number): Gen<CellNode> =>
	(source) => ({
		leaf: source.draw(letter),
		children: depth === 0 ? [] : source.draw(array(cellGen(depth - 1), { min: 0, max: 2 }))
	})

/** A package of no row, which its publish leaves unchanged. */
const nothing: Content = { docs: [], trees: [], refs: [], notes: [], unmarked: false }

/** A package's content of each kind drawn apart, any of them empty. */
const someContent: Gen<Content> = (source) => ({
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
	refs: source.draw(array(int(0, 9), { min: 0, max: 3 })),
	notes: source.draw(array(element([1n, 0n] as const), { min: 0, max: 2 })),
	unmarked: source.draw(element([false, true] as const))
})

/**
 * A package's content: one of no row at a weight of its own, since four kinds each empty at once are drawn too seldom
 * to reach the empty publish, and otherwise each kind drawn apart.
 */
export const contentGen: Gen<Content> = weighted<Content>([
	[1, constant(nothing)],
	[4, someContent]
])

export type ContentFeature =
	| "a document nesting tokens"
	| "a document of no token"
	| "a document with attributes"
	| "a cell tree two deep"
	| "a ref"
	| "nothing at all"
	| "a node of no mark"
	| "a note of no weight"

/** Whether a package's content holds no row: no document, no cell tree and no ref. */
export const isEmpty = (c: Content): boolean =>
	c.docs.length === 0 && c.trees.length === 0 && c.refs.length === 0 && c.notes.length === 0

/** Whether a package's content holds a note Weighed refuses, of weight 0. */
export const isUnweighed = (c: Content): boolean => c.notes.includes(0n)

/** How many nodes a cell tree holds: its root and every node below it, its starts 0 to that less one in pre-order. */
const nodesOf = (n: CellNode): number => 1 + Arr.reduce(n.children, 0, (sum, k) => sum + nodesOf(k))

/**
 * The node a package's content leaves without its mark, which Marked refuses, by its tree's root and its start: its last
 * tree's last node in pre-order; none where it marks every node, or holds no tree.
 */
export const unmarkedOf = (
	c: Content
): { readonly root: bigint; readonly start: bigint } | undefined => {
	const last = Arr.last(c.trees)
	return !c.unmarked || Option.isNone(last)
		? undefined
		: { root: BigInt(c.trees.length - 1), start: BigInt(nodesOf(last.value) - 1) }
}

export const contentFeatures = (c: Content): ReadonlyArray<ContentFeature> => [
	...(Arr.some(c.docs, (d) => d.tokens.length > 0) ? (["a document nesting tokens"] as const) : []),
	...(Arr.some(c.docs, (d) => d.tokens.length === 0) ? (["a document of no token"] as const) : []),
	...(Arr.some(c.docs, (d) => d.attrs.length > 0) ? (["a document with attributes"] as const) : []),
	...(Arr.some(c.trees, (t) => Arr.some(t.children, (k) => k.children.length > 0))
		? (["a cell tree two deep"] as const)
		: []),
	...(c.refs.length > 0 ? (["a ref"] as const) : []),
	...(isEmpty(c) ? (["nothing at all"] as const) : []),
	...(unmarkedOf(c) === undefined ? [] : (["a node of no mark"] as const)),
	...(isUnweighed(c) ? (["a note of no weight"] as const) : [])
]

export const situations = [
	"a document nesting tokens",
	"a document of no token",
	"a document with attributes",
	"a cell tree two deep",
	"a ref",
	"nothing at all",
	"a node of no mark",
	"a note of no weight"
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
	Mark: Arr.flatMap(c.trees, (t, root) =>
		Arr.flatMap(
			Array.from({ length: nodesOf(t) }, (_, start) => ({
				root: BigInt(root),
				start: BigInt(start)
			})),
			(at) => {
				const unmarked = unmarkedOf(c)
				return unmarked !== undefined && unmarked.root === at.root && unmarked.start === at.start
					? []
					: [{ ...stated, ...at, name: "m", v: 1n }]
			}
		)
	),
	Note: Arr.map(c.notes, (weight, id) => ({ ...stated, id: BigInt(id), weight })),
	Ref: Arr.map(c.refs, (target, id) => ({ ...stated, id: BigInt(id), target: BigInt(target) }))
})

/** The fields each table is read back by, `package` first. */
export const fieldsOf: Readonly<Record<string, ReadonlyArray<string>>> = {
	Doc: ["package", "id", "title", "tokens", "attrs"],
	Token: ["package", "id", "at", "text"],
	Attr: ["package", "id", "name", "title"],
	Cell: ["package", "root", "start", "end", "parent", "at", "children", "leaf", "marks", "weight"],
	Mark: ["package", "root", "start", "name", "v"],
	Note: ["package", "id", "n", "weight"],
	Ref: ["package", "id", "target"]
}
