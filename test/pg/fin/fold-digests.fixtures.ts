/** What the properties of fold-digests.test.ts read: its spaces, models and helpers. */
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, Record as Rec, String as Str } from "effect"
import { Digest } from "effect/crypto"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Crypto } from "#compiler/public/compute.ts"
import {
	accumulated,
	drawn as drawnField,
	generated,
	natural,
	pg,
	sha256
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	fin,
	fold,
	Monoid,
	on,
	ordered,
	relation,
	schema,
	select,
	tree
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { btreeMaxItemSize } from "#compiler/schema/representability.ts"
import { Id } from "#test/support/ids.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"
import { uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** A text of no bound: every running text and piece, so a running text outgrows PostgreSQL's B-tree entry. */
const Text = str.regex("^.*$", "su")

/** Crypto.sha256's value, the 32-byte digest carrier. */
const DigestBytes = sha256

/** A document: its lines' count and their concatenation, carried by its digest. */
const Doc = relation.generated(
	"Doc",
	{ id: Id, n: drawnField(natural), text: accumulated(Text, "") },
	["id"],
	(row) => ({ textDigest: generated(DigestBytes, Crypto.sha256(row.text)) })
)

/** A document's line: its piece, and the running text before and after it, each carried by its digest. */
const Line = relation.generated(
	"Line",
	{
		doc: Id,
		at: drawnField(natural),
		piece: Text,
		before: accumulated(Text, ""),
		after: accumulated(Text, "")
	},
	["doc", "at"],
	(row) => ({
		beforeDigest: generated(DigestBytes, Crypto.sha256(row.before)),
		afterDigest: generated(DigestBytes, Crypto.sha256(row.after))
	})
)

/**
 * A node of a document's tree: its piece, stepped where `stepped` holds, the running text of its parent's stepped
 * children before and after it, and its own children's, each carried by its digest: the shape of a string value's fold.
 */
const Node = relation.generated(
	"Node",
	{
		doc: Id,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		piece: Text,
		stepped: pg.boolean,
		before: accumulated(Text, ""),
		after: accumulated(Text, ""),
		text: accumulated(Text, "")
	},
	["doc", "start"],
	(row) => ({
		beforeDigest: generated(DigestBytes, Crypto.sha256(row.before)),
		afterDigest: generated(DigestBytes, Crypto.sha256(row.after)),
		textDigest: generated(DigestBytes, Crypto.sha256(row.text))
	})
)

const lines = ordered(on(Line, "doc", "at"), fin(Doc, "n"))

const nodes = tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["doc"] })

/** The two concat folds, each naming its running texts by their digests: the axes carry the digests. */
export const Digests = schema(
	"Digests",
	[Doc, Line, Node],
	[
		lines,
		fold(
			lines,
			Monoid.concat,
			on(Line, "doc", "piece", "beforeDigest", "afterDigest"),
			on(Doc, "id", "textDigest")
		),
		nodes,
		fold(
			nodes,
			Monoid.concat,
			on(
				select(Node, (n) => n.eq(n.stepped, true)),
				"doc",
				"parent",
				"piece",
				"beforeDigest",
				"afterDigest"
			),
			on(Node, "doc", "start", "textDigest")
		)
	]
)

const program = Object.freeze({
	insertDocs: ChangeSet.empty(Digests).insert(Doc, []),
	insertNodes: ChangeSet.empty(Digests).insert(Node, []),
	docs: query(Digests).rule((r) => {
		const d = v(Doc, "doc")
		return r.match(Doc, d).find(d)
	}),
	lines: query(Digests).rule((r) => {
		const l = v(Line, "line")
		return r.match(Line, l).find(l)
	}),
	nodes: query(Digests).rule((r) => {
		const n = v(Node, "node")
		return r.match(Node, n).find(n)
	})
})

export const digestsInstall = Object.freeze({ label: "folddigests", programs: program })

/** The schema installed as `grizzle generate` drafts it, once per member: the template its cases' seats clone. */
export const digestsTemplate = fixtureTemplate(import.meta, Digests, digestsInstall)

/**
 * A text's SHA-256 digest, its 32 bytes in hex, the digest of its UTF-8 by effect's WebCrypto digest, a second
 * implementation of grizzle's and PostgreSQL's, read as a stored digest's hex is (Hex.encode).
 */
const digestOf = (text: string): Effect.Effect<string, never, Digest.Digest> =>
	Effect.flatMap(Digest.Digest, (d) => d.digestHex(Digest.sha256, new TextEncoder().encode(text)))

/** A tree node as a case draws it: its piece, whether the fold steps it, and its children in slot order. */
export interface TreeNode {
	readonly piece: string
	readonly stepped: boolean
	readonly children: ReadonlyArray<TreeNode>
}

/**
 * A direct writer's copy of a stored document and its lines under a fresh id, with one junk text or none, in a
 * transaction checked as its commit would check it and rolled back.
 */
export type Junk =
	| { readonly kind: "none" }
	| { readonly kind: "a member's running texts off its predecessor's"; readonly slot: number }
	| { readonly kind: "a first member's before off the empty text" }
	| { readonly kind: "an owner's end off its last member's after" }
	| { readonly kind: "an empty owner's end off the empty text" }

/** A case: documents of lines, trees of nodes, and the direct writer's copy of one document. */
export interface Sketch {
	readonly docs: ReadonlyArray<ReadonlyArray<string>>
	readonly trees: ReadonlyArray<TreeNode>
	readonly copied: { readonly doc: number; readonly junk: Junk }
}

/**
 * The longest piece, in code points: a few thousand, so a document of two long pieces outgrows PostgreSQL's 2,704-byte
 * B-tree entry well within the case.
 */
const longest = 3000

/**
 * A piece: empty, a few letters of one, two, three and four UTF-8 bytes, or a run of one of them a thousand to
 * `longest` code points long.
 */
const pieceGen: Gen<string> = weighted([
	[1, constant("")],
	[4, map(array(element(["a", "b", "é", "€", "𝄞"]), { min: 1, max: 4 }), Arr.join(""))],
	[2, (source) => Str.repeat(int(1000, longest)(source))(element(["x", "é", "€", "𝄞"])(source))]
])

/** A tree of at most `depth` levels below its root, each node of at most three children. */
const treeGen =
	(depth: number): Gen<TreeNode> =>
	(source) => ({
		piece: pieceGen(source),
		stepped: boolean(source),
		children: depth === 0 ? [] : array(treeGen(depth - 1), { min: 0, max: 3 })(source)
	})

const junkGen =
	(pieces: ReadonlyArray<string>): Gen<Junk> =>
	(source) => {
		const kinds: Arr.NonEmptyReadonlyArray<Junk> =
			pieces.length === 0
				? [{ kind: "none" }, { kind: "an empty owner's end off the empty text" }]
				: [
						{ kind: "none" },
						{ kind: "a first member's before off the empty text" },
						{ kind: "an owner's end off its last member's after" },
						...(pieces.length > 1
							? [
									{
										kind: "a member's running texts off its predecessor's",
										slot: int(1, pieces.length - 1)(source)
									} as const
								]
							: [])
					]
		return element(kinds)(source)
	}

export const sketchGen: Gen<Sketch> = (source) => {
	const docs = array(array(pieceGen, { min: 0, max: 4 }), { min: 1, max: 3 })(source)
	const doc = int(0, docs.length - 1)(source)
	return {
		docs,
		trees: array(treeGen(2), { min: 0, max: 2 })(source),
		copied: { doc, junk: junkGen(Arr.getUnsafe(docs, doc))(source) }
	}
}

/** A document's id: the case's documents in order. */
export const docId = (i: number) => uuidOf(i + 1)

/** The fresh id the direct writer copies a document under. */
export const copyId = uuidOf(1000)

/** A tree's root id, after every document's. */
export const treeId = (i: number) => uuidOf(100 + i)

/** A document as its write nests it: its lines under its count. */
export const docFact = (pieces: ReadonlyArray<string>, i: number) => ({
	id: docId(i),
	n: Arr.map(pieces, (piece) => ({ piece }))
})

/** A tree node as its write nests it: its piece, its step flag and its children under its count. */
type NestedNode = {
	readonly piece: string
	readonly stepped: boolean
	readonly children: ReadonlyArray<NestedNode>
}

const nestedOf = (node: TreeNode): NestedNode => ({
	piece: node.piece,
	stepped: node.stepped,
	children: Arr.map(node.children, nestedOf)
})

export const treeFact = (root: TreeNode, i: number) => ({ doc: treeId(i), ...nestedOf(root) })

/** A document's fold as the model states it: its count and its end. */
export type DocModel = { readonly id: string; readonly n: string; readonly text: string }

/** A line as the model states it: its piece and its running texts. */
export type LineModel = {
	readonly doc: string
	readonly at: string
	readonly piece: string
	readonly before: string
	readonly after: string
}

/** A tree node as the model states it: its piece, its step flag, its running texts and its children's concatenation. */
export type NodeModel = {
	readonly doc: string
	readonly start: string
	readonly piece: string
	readonly stepped: string
	readonly before: string
	readonly after: string
	readonly text: string
}

/** A document's rows: its end, and each line's running texts, the README's concat fold of its pieces. */
export const docRows = (
	pieces: ReadonlyArray<string>,
	id: string
): { readonly doc: DocModel; readonly lines: ReadonlyArray<LineModel> } => {
	const lines: Array<LineModel> = []
	let before = ""
	for (const [at, piece] of pieces.entries()) {
		const after = `${before}${piece}`
		lines.push({ doc: id, at: String(at), piece, before, after })
		before = after
	}
	return { doc: { id, n: String(pieces.length), text: before }, lines }
}

/**
 * A tree's rows in pre-order, each node's start its place there: its running texts among its siblings, from the empty
 * text at slot 0, its after its before and its piece where the fold steps it, and its children's concatenation, their
 * last after. The root's before is the empty text, and its after its piece where it is stepped, as a slot-0 member's.
 */
export const treeRows = (root: TreeNode, doc: string): ReadonlyArray<NodeModel> => {
	const visit = (
		node: TreeNode,
		before: string,
		start: number
	): Arr.NonEmptyReadonlyArray<NodeModel> => {
		const below: Array<NodeModel> = []
		let text = ""
		for (const child of node.children) {
			const rows = visit(child, text, start + 1 + below.length)
			text = Arr.headNonEmpty(rows).after
			for (const row of rows) {
				below.push(row)
			}
		}
		return [
			{
				doc,
				start: String(start),
				piece: node.piece,
				stepped: String(node.stepped),
				before,
				after: node.stepped ? `${before}${node.piece}` : before,
				text
			},
			...below
		]
	}
	return visit(root, "", 0)
}

/** A document's end with its digest. */
export const docDigested = (d: DocModel) =>
	Effect.map(digestOf(d.text), (textDigest) => ({ ...d, textDigest }))

/** A line's running texts with their digests. */
export const lineDigested = (l: LineModel) =>
	Effect.map(
		Effect.all({ beforeDigest: digestOf(l.before), afterDigest: digestOf(l.after) }),
		(digests) => ({ ...l, ...digests })
	)

/** A node's running texts and string value with their digests. */
export const nodeDigested = (n: NodeModel) =>
	Effect.map(
		Effect.all({
			beforeDigest: digestOf(n.before),
			afterDigest: digestOf(n.after),
			textDigest: digestOf(n.text)
		}),
		(digests) => ({ ...n, ...digests })
	)

/** Rows as a set: each row's fields as text, in field-name order, the rows sorted. */
export const rowSet = (
	rows: ReadonlyArray<Readonly<Record<string, string>>>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (r) =>
			Arr.join(
				Arr.map(Arr.sort(Rec.keys(r), Order.String), (k) => `${k}=${r[k] ?? ""}`),
				"\u001f"
			)
		),
		Order.String
	)

export type Feature =
	| "a running text past the B-tree entry"
	| "an owner's end past the B-tree entry"
	| "a tree node's string value past the B-tree entry"
	| "an unstepped node"
	| "an empty family"
	| Junk["kind"]

/** Whether a text outgrows PostgreSQL's B-tree entry, BTMaxItemSize, as itself. */
export const pastEntry = (text: string): boolean =>
	new TextEncoder().encode(text).length > btreeMaxItemSize
