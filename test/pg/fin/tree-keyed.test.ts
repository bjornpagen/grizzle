/**
 * A tree keyed by its root fields then its drawn start, on PostgreSQL 19rc1, written whole through grizzle's own write
 * and read back: three relations of root arity 1, 2 and 3 over text, integer and uuid root fields, each folded by the
 * sum of its children's kinds and each row copying its parent's kind down the parent axis.
 *
 * - **A second implementation:** the direct pre-order numbering of each tree under its root value
 *   (test/support/families/tree.ts numbered): every row's parent (its parent's start in its own tree, a root's its own,
 *   0), slot, count, interval, its parent's kind (a root's its own) and the sum of its children's kinds. What a write of
 *   a forest leaves must be exactly that, and nothing else.
 * - **PostgreSQL as the judge:** every lawful forest commits, trees that share every position under different roots
 *   among them; the same forest written again changes nothing (`unchanged`); and a tree that differs from the one stored
 *   under its root value is refused on the relation's primary key (root…, start), the key law, witnessed by the stored
 *   root's key, its root value at start 0.
 *
 * The space, generated: a relation of one to three root fields, its text root fields' values over a and b to a width
 * drawn per case, so two roots share a prefix or a field; one to three trees of one to six nodes under distinct root
 * values, each tree's shape drawn by its parents and each node's kind; and the change that makes a differing tree, the
 * root's kind or a leaf added under it.
 *
 * Features: a root of 2 and of 3 fields, two trees sharing their positions under different roots, a copy along parent
 * a node's kind differs from, a fold over a node's children, the same forest written again, a differing tree refused
 * on the key with its witness.
 *
 * A second property writes the same kind of forest by a direct SQL writer, the owner, each row's every column the
 * numbering's or one named mutation of it (a field one past, or a row moved under another tree's root value), and
 * PostgreSQL must commit exactly the states the theorem as a checker calls lawful (test/support/families/tree.ts
 * lawful): the numbering of the forest the state's keys and parent links describe.
 *
 * Plants (~/.cache/grizzle-release/TREEKEY/plants): tree-parent-fk-rootless (the owner axis keyed by parent and start
 * alone), tree-family-key-rootless (the family's key, UNIQUE (‹parent₀›, at), without the root), tree-count-rootless
 * (the last axis, a parent's last child by its count, keyed without the root), tree-root-pin-dropped (a root admitted
 * off slot 0).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, int, parents, shuffled, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Order, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn as drawnField, natural, pg, uuid } from "#compiler/public/fields.ts"
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
import { seatOf } from "#test/pg/fin/installed.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, deepEquals, defined } from "#test/support/assert.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import {
	canonicalRows,
	type Forest,
	type KeyedRow,
	lawful,
	type Node,
	numbered,
	treeOfParents
} from "#test/support/families/tree.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { attemptChecked, refusalText } from "#test/support/substrate.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
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
		kind: pg.int4,
		parentKind: accumulated(pg.int4, 0),
		total: accumulated(pg.int4, 0)
	},
	["doc", "start"]
)
const oneTree = tree(on(One, "parent", "at"), fin(One, "children"), { root: ["doc"] })
const OneRoot = schema(
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
		site: pg.int4,
		page: RootText,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		kind: pg.int4,
		parentKind: accumulated(pg.int4, 0),
		total: accumulated(pg.int4, 0)
	},
	["site", "page", "start"]
)
const twoTree = tree(on(Two, "parent", "at"), fin(Two, "children"), { root: ["site", "page"] })
const TwoRoots = schema(
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
		a: uuid,
		b: RootText,
		c: pg.int4,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		kind: pg.int4,
		parentKind: accumulated(pg.int4, 0),
		total: accumulated(pg.int4, 0)
	},
	["a", "b", "c", "start"]
)
const threeTree = tree(on(Three, "parent", "at"), fin(Three, "children"), {
	root: ["a", "b", "c"]
})
const ThreeRoots = schema(
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

const nestedOf = (node: Node): Nested => ({
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
const rootText = (text: string | undefined): RootLetters => {
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
const rootUuid = (text: string | undefined) =>
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

const caseGen: Gen<KeyedCase> = (source) => {
	const arity = source.draw(element([1, 2, 3] as const))
	const width = source.draw(int(0, 3))
	return {
		arity,
		forest: source.draw(forestGen(arity, width, source.draw(int(1, 3)))),
		change: source.draw(element(["the root's kind", "a leaf under the root"] as const))
	}
}

/** A row as this suite reads it back: every field a read returns, the drawn ‹n› aside, which no read sees. */
type Read = Omit<KeyedRow, "copy">

const readOf = (r: KeyedRow): Read => ({
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
const sortedReads = (rows: ReadonlyArray<Read>): ReadonlyArray<Read> =>
	Arr.sort(
		rows,
		Order.combine(
			Order.mapInput(Arr.makeOrder(Order.String), (r: Read) => r.root),
			Order.mapInput(Order.Number, (r: Read) => r.start)
		)
	)

/** The tree that differs from `rooted`'s under its root value by `change`. */
const changed = (node: Node, change: Change): Node =>
	change === "the root's kind"
		? { ...node, kind: node.kind + 1 }
		: { ...node, children: [...node.children, { kind: 0, children: [] }] }

type KeyedFeature =
	| "a root of 2"
	| "a root of 3"
	| "two trees sharing their positions under different roots"
	| "a copy along parent its node's kind differs from"
	| "a fold over a node's children"
	| "the same forest written again"
	| "a differing tree refused on the key"
	| "the refusal witnessed by the stored root's key"

/** What a forest reaches of the features its rows show. */
const forestFeatures = (
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
		site: pg.int4,
		page: RootText,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		kind: pg.int4,
		parentKind: accumulated(pg.int4, 0)
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

const writtenFields: Arr.NonEmptyReadonlyArray<Written> = [
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

const directGen: Gen<DirectCase> = (source) => {
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
const mutatedRows = (c: DirectCase): ReadonlyArray<KeyedRow> =>
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
const copiedView = (r: KeyedRow): Omit<KeyedRow, "total"> => ({
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

type DirectFeature =
	| "a lawful forest committed"
	| "an unlawful state refused"
	| `a wrong ${Written} refused`
	| "a row under another tree's root refused"
	| "a root off slot 0 refused"

layer(Substrate.layer, { excludeTestServices: true })(
	"a tree keyed by its root fields then its start",
	(it) => {
		it.effect(
			"writes every lawful forest whole as the direct pre-order numbering of each tree under its root, writes it again as no change, and refuses a differing tree under a stored root on the key",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const one = yield* installed(
							OneRoot,
							{},
							{
								label: "keyedone",
								programs: oneProgram
							}
						)
						const two = yield* installed(
							TwoRoots,
							{},
							{
								label: "keyedtwo",
								programs: twoProgram
							}
						)
						const three = yield* installed(
							ThreeRoots,
							{},
							{
								label: "keyedthree",
								programs: threeProgram
							}
						)
						const layers = Layer.mergeAll(one.served.layer, two.served.layer, three.served.layer)
						return yield* Effect.gen(function* () {
							const dbOne = yield* Db.open(one.served.login.roles.app, {})
							const dbTwo = yield* Db.open(two.served.login.roles.app, {})
							const dbThree = yield* Db.open(three.served.login.roles.app, {})
							/** A seat's write of a forest's trees, nested from each root, and its read of every row. */
							const seats = {
								1: {
									installed: one.installed,
									write: (forest: Forest) =>
										answered(
											dbOne.workload.insertNodes.once({
												params: {},
												facts: {
													insert: {
														Node: Arr.map(forest, ({ root, tree: t }) => ({
															doc: rootText(root[0]),
															...nestedOf(t)
														}))
													}
												}
											})
										),
									read: rowsOf(dbOne.workload.nodes.once({ params: {}, facts: {} })).pipe(
										Effect.map(
											Arr.map((n): Read => ({
												root: [n.doc],
												parent: Number(n.parent),
												at: Number(n.at),
												children: Number(n.children),
												start: Number(n.start),
												end: Number(n.end),
												kind: n.kind,
												parentKind: n.parentKind,
												total: n.total
											}))
										)
									),
									keyFields: ["doc", "start"],
									key: (root: ReadonlyArray<string>) => ({
										doc: rootText(root[0]),
										start: 0n
									})
								},
								2: {
									installed: two.installed,
									write: (forest: Forest) =>
										answered(
											dbTwo.workload.insertNodes.once({
												params: {},
												facts: {
													insert: {
														Node: Arr.map(forest, ({ root, tree: t }) => ({
															site: Number(defined(root[0], "a site")),
															page: rootText(root[1]),
															...nestedOf(t)
														}))
													}
												}
											})
										),
									read: rowsOf(dbTwo.workload.nodes.once({ params: {}, facts: {} })).pipe(
										Effect.map(
											Arr.map((n): Read => ({
												root: [String(n.site), n.page],
												parent: Number(n.parent),
												at: Number(n.at),
												children: Number(n.children),
												start: Number(n.start),
												end: Number(n.end),
												kind: n.kind,
												parentKind: n.parentKind,
												total: n.total
											}))
										)
									),
									keyFields: ["site", "page", "start"],
									key: (root: ReadonlyArray<string>) => ({
										site: Number(defined(root[0], "a site")),
										page: rootText(root[1]),
										start: 0n
									})
								},
								3: {
									installed: three.installed,
									write: (forest: Forest) =>
										answered(
											dbThree.workload.insertNodes.once({
												params: {},
												facts: {
													insert: {
														Node: Arr.map(forest, ({ root, tree: t }) => ({
															a: rootUuid(root[0]),
															b: rootText(root[1]),
															c: Number(defined(root[2], "a c")),
															...nestedOf(t)
														}))
													}
												}
											})
										),
									read: rowsOf(dbThree.workload.nodes.once({ params: {}, facts: {} })).pipe(
										Effect.map(
											Arr.map((n): Read => ({
												root: [n.a, n.b, String(n.c)],
												parent: Number(n.parent),
												at: Number(n.at),
												children: Number(n.children),
												start: Number(n.start),
												end: Number(n.end),
												kind: n.kind,
												parentKind: n.parentKind,
												total: n.total
											}))
										)
									),
									keyFields: ["a", "b", "c", "start"],
									key: (root: ReadonlyArray<string>) => ({
										a: rootUuid(root[0]),
										b: rootText(root[1]),
										c: Number(defined(root[2], "a c")),
										start: 0n
									})
								}
							} as const
							return yield* explore(
								{
									suite: "pg/fin/tree-keyed",
									draw: drawn(caseGen),
									literal: Formatter.format,
									oracle: {
										kind: "second-implementation",
										name: "the direct pre-order numbering of each tree under its root value, its copies and its fold, and PostgreSQL's verdict on each write"
									},
									coverage: required<KeyedFeature>(
										[
											"a root of 2",
											"a root of 3",
											"two trees sharing their positions under different roots",
											"a copy along parent its node's kind differs from",
											"a fold over a node's children",
											"the same forest written again",
											"a differing tree refused on the key",
											"the refusal witnessed by the stored root's key"
										],
										{ cases: 16, sense: notesOnly }
									),
									kept: [],
									runs: 8,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 4,
									caseHang
								},
								(c, cx) =>
									Effect.gen(function* () {
										const seat = seats[c.arity]
										yield* replaceRows(s.admin, installationGroup(namesOf(seat.installed)), [])
										const expected = numbered(c.forest)
										cx.noteAll(forestFeatures(c, expected))
										const first = yield* seat.write(c.forest)
										if (first.kind !== "accepted") {
											return assert.fail(
												`a lawful forest is accepted, not ${first.kind}: ${Formatter.format(first)}`
											)
										}
										const stored = yield* seat.read
										assert.ok(
											deepEquals(
												sortedReads(stored),
												sortedReads(Arr.map(canonicalRows(expected), readOf))
											),
											`the forest reads back as its numbering: ${Formatter.format(sortedReads(stored))}`
										)
										const again = yield* seat.write(c.forest)
										assert.equal(
											again.kind,
											"unchanged",
											"the same forest written again changes nothing"
										)
										cx.note("the same forest written again")
										const [head] = c.forest
										const differing = defined(head, "a forest's first tree")
										const refused = yield* seat.write([
											{ root: differing.root, tree: changed(differing.tree, c.change) }
										])
										if (refused.kind !== "refused") {
											return assert.fail(
												`a differing tree under a stored root is refused, not ${refused.kind}`
											)
										}
										assert.ok(
											Arr.some(
												refusedLaws(refused.refused),
												(law) =>
													law.kind === "primaryKey" &&
													law.relation === "Node" &&
													deepEquals<ReadonlyArray<string>>(law.fields, seat.keyFields)
											),
											`a differing tree is refused on the key, not ${Formatter.format(refused.refused)}`
										)
										cx.note("a differing tree refused on the key")
										if (refused.witness.kind === "key") {
											assert.ok(
												refused.witness.relation === "Node" &&
													deepEquals(refused.witness.values, seat.key(differing.root)),
												`the refusal is witnessed by the stored root's key, not ${Formatter.format(refused.witness)}`
											)
											cx.note("the refusal witnessed by the stored root's key")
										}
										const after = yield* seat.read
										assert.ok(
											deepEquals(sortedReads(after), sortedReads(stored)),
											"a refused write leaves the stored forest as it was"
										)
									})
							)
						}).pipe((body) =>
							Effect.flatMap(Layer.build(layers), (context) => Effect.provideContext(body, context))
						)
					}).pipe(Effect.scoped)
				)
		)
		it.effect(
			"commits exactly the lawful states a direct writer writes, each root value's rows one tree with its parent's start, slots, intervals and copies",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const seat = yield* seatOf(CopiedRoots, ["Node"], "keyed direct")
						const columns = [
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
						const valuesOf = (r: KeyedRow): ReadonlyArray<string> => [
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
						return yield* explore(
							{
								suite: "pg/fin/tree-keyed-direct",
								draw: drawn(directGen),
								literal: Formatter.format,
								oracle: {
									kind: "specification",
									name: "the theorem as a checker: a state is lawful exactly when it is the direct pre-order numbering of the forest its keys and parent links describe (test/support/families/tree.ts lawful)"
								},
								coverage: required<DirectFeature>(
									[
										"a lawful forest committed",
										"an unlawful state refused",
										...Arr.map(writtenFields, (f): DirectFeature => `a wrong ${f} refused`),
										"a row under another tree's root refused",
										"a root off slot 0 refused"
									],
									{ cases: 64, sense: notesOnly }
								),
								kept: [],
								runs: 32,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 8,
								caseHang
							},
							(c, cx) =>
								Effect.gen(function* () {
									const rows = mutatedRows(c)
									const isLawful = lawful(rows, copiedView)
									const [first, ...rest] = rows
									if (first === undefined) {
										return assert.fail("a forest holds a row")
									}
									const insert = `INSERT INTO ${seat.table("Node")} (${Arr.join(
										Arr.map(columns, (role) => seat.column("Node", role)),
										", "
									)}) VALUES ${Arr.join(
										Arr.map([first, ...rest], (r) => `(${Arr.join(valuesOf(r), ", ")})`),
										", "
									)}`
									const real = yield* attemptChecked(seat.session, [insert], Effect.void)
									if ((real.kind === "committed") !== isLawful) {
										return assert.fail(
											`PostgreSQL ${real.kind === "committed" ? "committed" : `refused (${refusalText(real.fields)})`} a state the theorem calls ${isLawful ? "lawful" : "unlawful"}: ${Formatter.format(rows)}`
										)
									}
									const m = c.mutation
									if (isLawful) {
										cx.note("a lawful forest committed")
										return
									}
									cx.note("an unlawful state refused")
									if (m.kind === "field") {
										cx.note(`a wrong ${m.field} refused`)
										if (m.field === "at" && defined(rows[m.row], "the mutated row").start === 0) {
											cx.note("a root off slot 0 refused")
										}
									}
									if (m.kind === "root") {
										cx.note("a row under another tree's root refused")
									}
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
