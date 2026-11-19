import { defined } from "@bjornpagen/testing/assert"
/** What the properties of tree-keyed.test.ts read: its spaces, models and helpers. */
import {
	constant,
	element,
	type Gen,
	int,
	parents,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	fin,
	fold,
	Monoid,
	on,
	relation,
	schema,
	select,
	tree
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { seatTemplate } from "#test/pg/fin/installed.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import {
	type Forest,
	type KeyedRow,
	type Node,
	numbered,
	treeOfParents
} from "#test/support/families/tree.ts"
import { Id } from "#test/support/ids.ts"
import { upTo } from "#test/support/up-to.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/** A root field's text: a and b to the width a case draws, bounded so every key's index entry fits. */
const RootText = str.bytes(16, str.regex("^[ab]*$"))

const One = relation(
	"Node",
	{
		doc: RootText,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		kind: pg.integer,
		parentKind: accumulated(pg.integer, 0),
		total: accumulated(pg.integer, 0)
	},
	["doc", "start"]
)

const oneTree = tree(on(One, "parent", "at"), fin(One, "children"), { root: ["doc"] })

export const OneRoot = schema(
	"KeyedOne",
	[One],
	[
		oneTree,
		fold(oneTree, Monoid.sum, on(One, "doc", "parent", "kind"), on(One, "doc", "start", "total")),
		contained(
			on(
				select(One, (n) => n.gt(n.start, 0n)),
				"doc",
				"parent",
				"parentKind"
			),
			on(One, "doc", "start", "kind")
		)
	]
)

const Two = relation(
	"Node",
	{
		site: pg.integer,
		page: RootText,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		kind: pg.integer,
		parentKind: accumulated(pg.integer, 0),
		total: accumulated(pg.integer, 0)
	},
	["site", "page", "start"]
)

const twoTree = tree(on(Two, "parent", "at"), fin(Two, "children"), { root: ["site", "page"] })

export const TwoRoots = schema(
	"KeyedTwo",
	[Two],
	[
		twoTree,
		fold(
			twoTree,
			Monoid.sum,
			on(Two, "site", "page", "parent", "kind"),
			on(Two, "site", "page", "start", "total")
		),
		contained(
			on(
				select(Two, (n) => n.gt(n.start, 0n)),
				"site",
				"page",
				"parent",
				"parentKind"
			),
			on(Two, "site", "page", "start", "kind")
		)
	]
)

const Three = relation(
	"Node",
	{
		a: Id,
		b: RootText,
		c: pg.integer,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		kind: pg.integer,
		parentKind: accumulated(pg.integer, 0),
		total: accumulated(pg.integer, 0)
	},
	["a", "b", "c", "start"]
)

const threeTree = tree(on(Three, "parent", "at"), fin(Three, "children"), {
	root: ["a", "b", "c"]
})

export const ThreeRoots = schema(
	"KeyedThree",
	[Three],
	[
		threeTree,
		fold(
			threeTree,
			Monoid.sum,
			on(Three, "a", "b", "c", "parent", "kind"),
			on(Three, "a", "b", "c", "start", "total")
		),
		contained(
			on(
				select(Three, (n) => n.gt(n.start, 0n)),
				"a",
				"b",
				"c",
				"parent",
				"parentKind"
			),
			on(Three, "a", "b", "c", "start", "kind")
		)
	]
)

const oneProgram = Object.freeze({
	insertNodes: ChangeSet.empty(OneRoot).insert(One, []),
	nodes: query(OneRoot).rule((r) => {
		const n = v(One, "node")
		return r.match(One, n).find(n)
	})
})

const twoProgram = Object.freeze({
	insertNodes: ChangeSet.empty(TwoRoots).insert(Two, []),
	nodes: query(TwoRoots).rule((r) => {
		const n = v(Two, "node")
		return r.match(Two, n).find(n)
	})
})

const threeProgram = Object.freeze({
	insertNodes: ChangeSet.empty(ThreeRoots).insert(Three, []),
	nodes: query(ThreeRoots).rule((r) => {
		const n = v(Three, "node")
		return r.match(Three, n).find(n)
	})
})

/** A node as a write nests it: its kind and its children in slot order, each nested the same way. */
interface Nested {
	readonly kind: number
	readonly children: ReadonlyArray<Nested>
}

export const nestedOf = (node: Node): Nested => ({
	kind: node.kind,
	children: Arr.map(node.children, nestedOf)
})

/** How a case makes a tree that differs from the one stored under its root value. */
type Change = "the root's kind" | "a leaf under the root"

/** A case: the root arity, the width of its text root values, its forest, and the change that makes a differing tree. */
interface KeyedCase {
	readonly arity: 1 | 2 | 3
	readonly forest: Forest
	readonly change: Change
}

/** A root field's text as its pattern types it, spelled over a and b: the empty text, or a letter and the rest. */
type RootLetters = "" | `a${string}` | `b${string}`

/** A drawn root text as its field's pattern types it: every root text a case draws is over a and b. */
export const rootText = (text: string | undefined): RootLetters => {
	const spelled = defined(text, "a root's text")
	const rest = Str.slice(1)(spelled)
	return spelled === "" ? "" : Str.startsWith("a")(spelled) ? `a${rest}` : `b${rest}`
}

/** A text root value of at most `width` letters over a and b. */
const textsUpTo = (width: number): Arr.NonEmptyReadonlyArray<string> =>
	Arr.prepend(
		Arr.flatMap(
			upTo(width, (n) => n + 1),
			(n) =>
				Arr.map(
					upTo(2 ** n, (i) => i),
					(i) =>
						Arr.join(
							upTo(n, (bit) => (((i >> bit) & 1) === 1 ? "b" : "a")),
							""
						)
				)
		),
		""
	)

/** The two uuids a root's uuid field takes. */
const rootUuids = [uuidOf(0), uuidOf(1)] as const

/** The uuid a root value's text spells, one of rootUuids. */
export const rootUuid = (text: string | undefined) =>
	defined(Arr.findFirst(rootUuids, (u) => u === text).pipe(Option.getOrUndefined), "a root's uuid")

/** Every root value of an arity, its fields each a text: the text values to `width`, integers 0 to 2, two uuids. */
const rootsOf = (arity: 1 | 2 | 3, width: number): ReadonlyArray<ReadonlyArray<string>> => {
	const texts = textsUpTo(width)
	const ints = ["0", "1", "2"]
	switch (arity) {
		case 1:
			return Arr.map(texts, (t) => [t])
		case 2:
			return Arr.flatMap(ints, (i) => Arr.map(texts, (t) => [i, t]))
		case 3:
			return Arr.flatMap(rootUuids, (u) =>
				Arr.flatMap(texts, (t) => Arr.map(ints, (i) => [u, t, i]))
			)
	}
}

/**
 * A forest of `trees` trees of one to six nodes, under distinct root values drawn among an arity's, each node's kind 0 to
 * 3; the root values distinct by construction, drawn apart from every candidate of the case's width.
 */
const forestGen =
	(arity: 1 | 2 | 3, width: number, trees: number): Gen<Forest> =>
	(source) => {
		const candidates = rootsOf(arity, width)
		const roots = source.draw(
			shuffled(candidates, {
				min: Math.min(trees, candidates.length),
				max: Math.min(trees, candidates.length)
			})
		)
		return Arr.map(roots, (root) => {
			const shape = source.draw(parents({ min: 1, max: 6 }))
			return {
				root,
				tree: treeOfParents(
					shape,
					upTo(shape.length + 1, () => source.draw(int(0, 3)))
				)
			}
		})
	}

export const caseGen: Gen<KeyedCase> = (source) => {
	const arity = source.draw(element([1, 2, 3] as const))
	const width = source.draw(int(0, 3))
	return {
		arity,
		forest: source.draw(forestGen(arity, width, source.draw(int(1, 3)))),
		change: source.draw(element(["the root's kind", "a leaf under the root"] as const))
	}
}

/** A row as this suite reads it back: every field a read returns, the drawn ‹n› aside, which no read sees. */
export type Read = Omit<KeyedRow, "copy">

export const readOf = (r: KeyedRow): Read => ({
	root: r.root,
	parent: r.parent,
	at: r.at,
	children: r.children,
	start: r.start,
	end: r.end,
	kind: r.kind,
	parentKind: r.parentKind,
	total: r.total
})

/** Rows read back in key order: by root value, then start. */
export const sortedReads = (rows: ReadonlyArray<Read>): ReadonlyArray<Read> =>
	Arr.sort(
		rows,
		Order.combine(
			Order.mapInput(Arr.makeOrder(Order.String), (r: Read) => r.root),
			Order.mapInput(Order.Number, (r: Read) => r.start)
		)
	)

/** The tree that differs from `rooted`'s under its root value by `change`. */
export const changed = (node: Node, change: Change): Node =>
	change === "the root's kind"
		? { ...node, kind: node.kind + 1 }
		: { ...node, children: [...node.children, { kind: 0, children: [] }] }

export type KeyedFeature =
	| "a root of 2"
	| "a root of 3"
	| "two trees sharing their positions under different roots"
	| "a copy along parent its node's kind differs from"
	| "a fold over a node's children"
	| "the same forest written again"
	| "a differing tree refused on the key"
	| "the refusal witnessed by the stored root's key"

/** What a forest reaches of the features its rows show. */
export const forestFeatures = (
	c: KeyedCase,
	rows: ReadonlyArray<KeyedRow>
): ReadonlyArray<KeyedFeature> => [
	...(c.arity === 2 ? ["a root of 2" as const] : []),
	...(c.arity === 3 ? ["a root of 3" as const] : []),
	...(c.forest.length > 1
		? ["two trees sharing their positions under different roots" as const]
		: []),
	...(Arr.some(rows, (r) => r.start > 0 && r.parentKind !== r.kind)
		? ["a copy along parent its node's kind differs from" as const]
		: []),
	...(Arr.some(rows, (r) => r.total > 0) ? ["a fold over a node's children" as const] : [])
]

/** The direct writer's tree: keyed by (site, page, start), its parent's kind copied down, folded by nothing. */
const Copied = relation(
	"Node",
	{
		site: pg.integer,
		page: RootText,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		kind: pg.integer,
		parentKind: accumulated(pg.integer, 0)
	},
	["site", "page", "start"]
)

const CopiedRoots = schema(
	"KeyedCopied",
	[Copied],
	[
		tree(on(Copied, "parent", "at"), fin(Copied, "children"), { root: ["site", "page"] }),
		contained(
			on(
				select(Copied, (n) => n.gt(n.start, 0n)),
				"site",
				"page",
				"parent",
				"parentKind"
			),
			on(Copied, "site", "page", "start", "kind")
		)
	]
)

/** A field of a stored row a direct writer may write wrong, by its role on the installed table. */
type Written = "parent" | "at" | "children" | "start" | "end" | "‹n›" | "parentKind"

export const writtenFields: Arr.NonEmptyReadonlyArray<Written> = [
	"parent",
	"at",
	"children",
	"start",
	"end",
	"‹n›",
	"parentKind"
]

/**
 * What a direct writer does to a lawful forest's rows before it writes them, each a named choice (doctrine rule 3):
 * nothing; one row's field one past its numbering's, the first tree's root's slot among them, which only the root pin
 * refuses; or one row moved under another tree's root value.
 */
type Mutation =
	| { readonly kind: "none" }
	| { readonly kind: "field"; readonly row: number; readonly field: Written }
	| { readonly kind: "root"; readonly row: number; readonly tree: number }

/** A direct writer's case: a forest of the Copied relation's root values and what is done to its rows. */
interface DirectCase {
	readonly forest: Forest
	readonly mutation: Mutation
}

export const directGen: Gen<DirectCase> = (source) => {
	const forest = source.draw(forestGen(2, source.draw(int(0, 2)), source.draw(int(1, 2))))
	const rows = numbered(forest).length
	const row = source.draw(int(0, rows - 1))
	const mutation = source.draw(
		weighted<Mutation>([
			[2, constant({ kind: "none" })],
			[5, (s) => ({ kind: "field", row, field: s.draw(element(writtenFields)) })],
			[1, constant({ kind: "field", row: 0, field: "at" })],
			[
				2,
				(s) =>
					forest.length > 1
						? { kind: "root", row, tree: s.draw(int(0, forest.length - 1)) }
						: { kind: "none" }
			]
		])
	)
	return { forest, mutation }
}

/** A forest's numbered rows with its mutation applied. */
export const mutatedRows = (c: DirectCase): ReadonlyArray<KeyedRow> =>
	Arr.map(numbered(c.forest), (r, i): KeyedRow => {
		const m = c.mutation
		if (m.kind === "none" || m.row !== i) {
			return r
		}
		if (m.kind === "root") {
			return { ...r, root: defined(c.forest[m.tree], "a tree of the forest").root }
		}
		switch (m.field) {
			case "parent":
				return { ...r, parent: r.parent + 1 }
			case "at":
				return { ...r, at: r.at + 1 }
			case "children":
				return { ...r, children: r.children + 1 }
			case "start":
				return { ...r, start: r.start + 1 }
			case "end":
				return { ...r, end: r.end + 1 }
			case "‹n›":
				return { ...r, copy: r.copy + 1 }
			case "parentKind":
				return { ...r, parentKind: r.parentKind + 1 }
		}
	})

/** A row as the Copied relation holds it: every field of KeyedRow but the fold's total, which it does not state. */
export const copiedView = (r: KeyedRow): Omit<KeyedRow, "total"> => ({
	root: r.root,
	parent: r.parent,
	at: r.at,
	children: r.children,
	start: r.start,
	end: r.end,
	copy: r.copy,
	kind: r.kind,
	parentKind: r.parentKind
})

export type DirectFeature =
	| "a lawful forest committed"
	| "an unlawful state refused"
	| `a wrong ${Written} refused`
	| "a row under another tree's root refused"
	| "a root off slot 0 refused"

export const columns = [
	"site",
	"page",
	"parent",
	"at",
	"children",
	"start",
	"end",
	"‹n›",
	"kind",
	"parentKind"
] as const

export const valuesOf = (r: KeyedRow): ReadonlyArray<string> => [
	defined(r.root[0], "a site"),
	`'${defined(r.root[1], "a page")}'`,
	String(r.parent),
	String(r.at),
	String(r.children),
	String(r.start),
	String(r.end),
	String(r.copy),
	String(r.kind),
	String(r.parentKind)
]

/** How each keyed tree is installed: its label and the programs its login's workload holds. */
export const oneRootInstall = Object.freeze({ label: "keyedone", programs: oneProgram })
export const twoRootsInstall = Object.freeze({ label: "keyedtwo", programs: twoProgram })
export const threeRootsInstall = Object.freeze({ label: "keyedthree", programs: threeProgram })

/** Each keyed tree installed as `grizzle generate` drafts it, once per member: the templates its cases' seats clone. */
export const oneRootTemplate = fixtureTemplate(import.meta, OneRoot, oneRootInstall)
export const twoRootsTemplate = fixtureTemplate(import.meta, TwoRoots, twoRootsInstall)
export const threeRootsTemplate = fixtureTemplate(import.meta, ThreeRoots, threeRootsInstall)

/** The copied-roots tree installed once per member (installed.ts seatTemplate): the template the direct writer's seats clone. */
export const directTemplate = seatTemplate(import.meta, CopiedRoots, "keyed direct")
