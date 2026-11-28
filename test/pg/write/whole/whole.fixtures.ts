/** What the properties of whole.test.ts read: its spaces, models and helpers. */

import {
	accepted,
	type Machine,
	type Program,
	program,
	refused,
	type Verdict
} from "@bjornpagen/testing/commands"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { swarm } from "@bjornpagen/testing/swarm"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { accumulated, drawn as drawnField, natural, int8 } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema,
	tree,
	unit
} from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"

/**
 * Deleting a group whole, and replacing it in one ChangeSet, against a pure model of the relations as sets.
 *
 * The world holds every kind of group: a tree, Node, keyed by its root `doc` and its drawn start, each node owning a
 * counted family of Attr whose values sum into the node's `weight`, each Attr owning an ordered family of Tok; an owner
 * of two families, Shelf, its ordered Books summing their words into its `pages` with running values, and its counted
 * Tags; and qti-pie's crossing shape, a Test owning a counted family of Inst, a tree whose nodes are its members, each
 * Inst owning a counted family of Place, every Place also a member of an Asm's counted family. Every relation is open,
 * mutable inside the unit its key leads with, as a content a package replaces must be: a tree's rows by its doc, a
 * shelf's by its id and its members' by their shelf, a test's, its instances' and its placements' by its t, and an
 * assembly's by its a.
 *
 * A program is ChangeSets over that world. Each `write` names, per key of a small pool, a unit (a tree by its root, a
 * shelf, a test or an assembly by its id) and what the ChangeSet does to it: deletes it; inserts it; or replaces it, a
 * delete and an insert at the same key in one stratum, its new value identical to the stored one or differing from it;
 * a delete names its units by an array or by a query per key. A unit inserted at a stored key it does not delete is the
 * stored one again (a differing one there is the insert protocol's, drawn by test/pg/write G4's properties). Tests and
 * assemblies are drawn by the components their placements link, each left alone, deleted whole, replaced whole
 * identically or edited, or split, each of its units drawn on its own; a test is inserted only at a key no test holds
 * or after its delete, its placements naming only assemblies the ChangeSet inserts (an append to a stored owner is the
 * insert protocol's), and a ChangeSet that deletes either deletes both relations, as qti-pie's replace `delete(T, q1)`,
 * `delete(A, q2)`, `insertAll(rows)` does, its deletes of one of them possibly naming no row. A test or an assembly
 * named by an array is named by its own fact, the one its insert states, so a replace that keeps its note deletes and
 * inserts one root fact: the unit goes whole all the same, but for the rows the stratum adds again unchanged, never
 * netted away as one fact both deleted and inserted would be. The named invalid ChangeSets are refused before any SQL:
 * a sequence's member deleted alone by a key that holds a drawn field, a tree's node named by its key in place of its
 * root value, and a delete of a test or an assembly in a stratum that deletes no row of the other, whose placements'
 * other groups it would leave partial. An owner without its members is no ChangeSet at all: a delete of an owner takes
 * its groups.
 *
 * The model holds each unit as a value (a tree of labelled nodes, each with its attrs and their tokens; a shelf with its
 * books in order and its set of tags; a test with its tree of labelled instances, each with the set of assemblies it
 * places; an assembly with its note) and renders every relation's rows from the units, every drawn and accumulated
 * field as the README states it: a node's pre-order interval, its index among its siblings, its parent's start (the
 * root its own, 0), its count of children and of attrs and its sum of their values; an ordered member's index and
 * running sum; a test's count of instances, an instance's and an assembly's of placements. Its verdict for a write is
 * the next state, the stored units less the deleted plus the inserted; or the refusal of a unit inserted at a stored key
 * it does not delete and differs from; or, where its deletes name rows that leave a crossing group partial, a stored
 * placement whose test it deletes and whose assembly it keeps or the other way about, that group's refusal at commit.
 * The oracles, for every ChangeSet:
 * - every relation stores exactly the model's rows after it, and after a refused one the rows before it;
 * - the outcome is the model's: `no-change` where the rendered state is unchanged, `accepted` with each relation's
 *   counts the difference of the two states otherwise, `invariant-rejected` naming only laws of the units' relations,
 *   and a crossing group left partial naming only the law of each family it leaves partial: the assembly's placements
 *   where a test goes without its assemblies, the instance's where an assembly goes without its tests;
 * - PostgreSQL commits every accepted one, so every law holds at commit; a refusal the model names comes before any SQL,
 *   but a crossing group left partial, which the ChangeSet's rows decide and its family's own law refuses;
 * - a stored unit the ChangeSet adds again unchanged, by a replace or an insert, is never written: each of its rows keeps
 *   its tuple and the transaction that wrote it, as PostgreSQL's ctid and xmin show; so is a crossing component whose
 *   every test and assembly the ChangeSet replaces identically, its assemblies placed exactly as before.
 */

export const Node = relation(
	"Node",
	{
		doc: int8,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		label: int8,
		attrs: drawnField(natural),
		weight: accumulated(int8, 0n)
	},
	["doc", "start"]
)

export const Attr = relation(
	"Attr",
	{ doc: int8, start: natural, name: int8, v: int8, toks: drawnField(natural) },
	["doc", "start", "name"]
)

const Tok = relation(
	"Tok",
	{ doc: int8, start: natural, name: int8, at: drawnField(natural), t: int8 },
	["doc", "start", "name", "at"]
)

export const Shelf = relation(
	"Shelf",
	{
		id: int8,
		note: int8,
		books: drawnField(natural),
		tags: drawnField(natural),
		pages: accumulated(int8, 0n)
	},
	["id"]
)

const Book = relation(
	"Book",
	{
		shelf: int8,
		at: drawnField(natural),
		words: int8,
		before: accumulated(int8, 0n),
		after: accumulated(int8, 0n)
	},
	["shelf", "at"]
)

export const Tag = relation("Tag", { shelf: int8, label: int8 }, ["shelf", "label"])

export const nodes = tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["doc"] })

export const attrs = counted(on(Attr, "doc", "start"), fin(Node, "attrs"))

export const weights = fold(
	attrs,
	Monoid.sum,
	on(Attr, "doc", "start", "v"),
	on(Node, "doc", "start", "weight")
)

export const toks = ordered(on(Tok, "doc", "start", "name", "at"), fin(Attr, "toks"))

export const books = ordered(on(Book, "shelf", "at"), fin(Shelf, "books"))

export const pages = fold(
	books,
	Monoid.sum,
	on(Book, "shelf", "words", "before", "after"),
	on(Shelf, "id", "pages")
)

export const tags = counted(on(Tag, "shelf"), fin(Shelf, "tags"))

export const Test = relation("Test", { t: int8, note: int8, insts: drawnField(natural) }, ["t"])

export const Inst = relation(
	"Inst",
	{
		t: int8,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		label: int8,
		places: drawnField(natural)
	},
	["t", "start"]
)

export const Asm = relation("Asm", { a: int8, note: int8, places: drawnField(natural) }, ["a"])

export const Place = relation("Place", { t: int8, start: natural, a: int8 }, ["t", "start", "a"])

const instances = tree(on(Inst, "parent", "at"), fin(Inst, "children"), { root: ["t"] })

const testInsts = counted(on(Inst, "t"), fin(Test, "insts"))

export const instPlaces = counted(on(Place, "t", "start"), fin(Inst, "places"))

export const asmPlaces = counted(on(Place, "a"), fin(Asm, "places"))

export const relations = { Node, Attr, Tok, Shelf, Book, Tag, Test, Inst, Asm, Place } as const

const statements = [
	nodes,
	attrs,
	weights,
	toks,
	books,
	pages,
	tags,
	instances,
	testInsts,
	instPlaces,
	asmPlaces
] as const

/** The world under `name`: the one schema every case's ChangeSets are over. */
export const worldOf = (name: string) =>
	schema(name, Rec.values(relations), [
		...statements,
		...Arr.map(Rec.values(relations), (r) => mutable(r)),
		unit("Document", { doc: int8 }),
		unit("Shelved", { id: int8 }),
		unit("Racked", { shelf: int8 }),
		unit("Exam", { t: int8 }),
		unit("Assembly", { a: int8 })
	])

export type RelationName = keyof typeof relations

export const relationNames: Arr.NonEmptyReadonlyArray<RelationName> = [
	"Node",
	"Attr",
	"Tok",
	"Shelf",
	"Book",
	"Tag",
	"Test",
	"Inst",
	"Asm",
	"Place"
]

/** An attr of a node: its name, distinct among its node's, its value, and its tokens in order. */
interface AttrValue {
	readonly name: bigint
	readonly v: bigint
	readonly toks: ReadonlyArray<bigint>
}

/** A node of a tree: its label, its attrs, and its children in order. */
interface NodeValue {
	readonly label: bigint
	readonly attrs: ReadonlyArray<AttrValue>
	readonly children: ReadonlyArray<NodeValue>
}

/** A shelf: its note, its books' words in order, and its tags, a set. */
interface ShelfValue {
	readonly note: bigint
	readonly books: ReadonlyArray<bigint>
	readonly tags: ReadonlyArray<bigint>
}

/** An instance of a test's tree: its label, the assemblies it places, a set of their ids, and its children in order. */
interface InstValue {
	readonly label: bigint
	readonly places: ReadonlyArray<bigint>
	readonly children: ReadonlyArray<InstValue>
}

/** A test: its note and its tree of instances. */
interface TestValue {
	readonly note: bigint
	readonly root: InstValue
}

/** The stored units: each tree by its root `doc`, each shelf and each test by its id, and each assembly's note by its id,
 * its placements the tests' (`placementsOf`), in key order. */
export interface Model {
	readonly trees: ReadonlyArray<readonly [bigint, NodeValue]>
	readonly shelves: ReadonlyArray<readonly [bigint, ShelfValue]>
	readonly tests: ReadonlyArray<readonly [bigint, TestValue]>
	readonly asms: ReadonlyArray<readonly [bigint, bigint]>
}

const empty: Model = { trees: [], shelves: [], tests: [], asms: [] }

/** A fact as a ChangeSet states it. */
type Fact = Readonly<Record<string, unknown>>

/** A rendered row: each field's value. */
type Row = Readonly<Record<string, bigint>>

/** Every relation's rows, rendered from the units. */
type Rendered = { readonly [R in RelationName]: ReadonlyArray<Row> }

const sum = (xs: ReadonlyArray<bigint>): bigint => Arr.reduce(xs, 0n, (a, b) => a + b)

/** A node of a tree as the README draws it: the node, its interval [start, end), its parent's start (none at the root)
 * and its index among its siblings (the root 0). */
interface Placed<N> {
	readonly node: N
	readonly start: bigint
	readonly end: bigint
	readonly parent: bigint | undefined
	readonly at: bigint
}

/** Every node of the tree under `root`, in pre-order. */
const preOrder = <N extends { readonly children: ReadonlyArray<N> }>(
	root: N
): ReadonlyArray<Placed<N>> => {
	const from = (
		node: N,
		start: bigint,
		parent: bigint | undefined,
		at: bigint
	): ReadonlyArray<Placed<N>> => {
		const below: Array<Placed<N>> = []
		for (const [i, child] of node.children.entries()) {
			for (const placed of from(child, start + 1n + BigInt(below.length), start, BigInt(i))) {
				below.push(placed)
			}
		}
		return [{ node, start, end: start + 1n + BigInt(below.length), parent, at }, ...below]
	}
	return from(root, 0n, undefined, 0n)
}

/** A tree's rows: each node with its interval, its parent's start (the root its own), its index among its siblings, its
 * counts and its attrs' sum; each attr and each of its tokens in order. */
const treeRows = (doc: bigint, root: NodeValue) => {
	const placed = preOrder(root)
	return {
		node: Arr.map(placed, (p): Row => ({
			doc,
			parent: p.parent ?? p.start,
			at: p.at,
			children: BigInt(p.node.children.length),
			start: p.start,
			end: p.end,
			label: p.node.label,
			attrs: BigInt(p.node.attrs.length),
			weight: sum(Arr.map(p.node.attrs, (a) => a.v))
		})),
		attr: Arr.flatMap(placed, (p) =>
			Arr.map(p.node.attrs, (a): Row => ({
				doc,
				start: p.start,
				name: a.name,
				v: a.v,
				toks: BigInt(a.toks.length)
			}))
		),
		tok: Arr.flatMap(placed, (p) =>
			Arr.flatMap(p.node.attrs, (a) =>
				Arr.map(a.toks, (t, i): Row => ({ doc, start: p.start, name: a.name, at: BigInt(i), t }))
			)
		)
	}
}

/** A placement: the instance at `start` of the test `t` places the assembly `a`. */
interface Placement {
	readonly t: bigint
	readonly start: bigint
	readonly a: bigint
}

/** A test's placements, each at its instance's start. */
export const testPlacements = (t: bigint, test: TestValue): ReadonlyArray<Placement> =>
	Arr.flatMap(preOrder(test.root), (p) => Arr.map(p.node.places, (a) => ({ t, start: p.start, a })))

/** A test's rows: the test with its count of instances, each instance as a tree's node with its count of placements. */
const testRows = (t: bigint, test: TestValue) => {
	const placed = preOrder(test.root)
	return {
		test: [{ t, note: test.note, insts: BigInt(placed.length) }],
		inst: Arr.map(placed, (p): Row => ({
			t,
			parent: p.parent ?? p.start,
			at: p.at,
			children: BigInt(p.node.children.length),
			start: p.start,
			end: p.end,
			label: p.node.label,
			places: BigInt(p.node.places.length)
		}))
	}
}

/** A placement's row. */
export const placementRow = (p: Placement): Row => ({ t: p.t, start: p.start, a: p.a })

/** Every stored placement, in the tests' key order. */
const placementsOf = (m: Model): ReadonlyArray<Placement> =>
	Arr.flatMap(m.tests, ([t, test]) => testPlacements(t, test))

/** A shelf's rows: the shelf with its counts and its books' sum, each book with its running sum, each tag. */
const shelfRows = (id: bigint, s: ShelfValue) => {
	const book: Array<Row> = []
	let running = 0n
	for (const [i, words] of s.books.entries()) {
		book.push({ shelf: id, at: BigInt(i), words, before: running, after: running + words })
		running += words
	}
	return {
		shelf: [
			{
				id,
				note: s.note,
				books: BigInt(s.books.length),
				tags: BigInt(s.tags.length),
				pages: running
			}
		],
		book,
		tag: Arr.map(s.tags, (label) => ({ shelf: id, label }))
	}
}

export const render = (m: Model): Rendered => {
	const trees = Arr.map(m.trees, ([doc, root]) => treeRows(doc, root))
	const shelves = Arr.map(m.shelves, ([id, s]) => shelfRows(id, s))
	const tests = Arr.map(m.tests, ([t, test]) => testRows(t, test))
	const placements = placementsOf(m)
	return {
		Node: Arr.flatMap(trees, (t) => t.node),
		Attr: Arr.flatMap(trees, (t) => t.attr),
		Tok: Arr.flatMap(trees, (t) => t.tok),
		Shelf: Arr.flatMap(shelves, (s) => s.shelf),
		Book: Arr.flatMap(shelves, (s) => s.book),
		Tag: Arr.flatMap(shelves, (s) => s.tag),
		Test: Arr.flatMap(tests, (t) => t.test),
		Inst: Arr.flatMap(tests, (t) => t.inst),
		Asm: Arr.map(m.asms, ([a, note]) => ({
			a,
			note,
			places: BigInt(Arr.filter(placements, (p) => p.a === a).length)
		})),
		Place: Arr.map(placements, placementRow)
	}
}

/** A row's identity as text: its fields in name order, each value's text. */
const rowText = (row: Row): string =>
	Arr.join(
		Arr.map(
			Arr.sort(
				Rec.toEntries(row),
				Order.mapInput(Order.String, ([k]: readonly [string, bigint]) => k)
			),
			([k, x]) => `${k}=${String(x)}`
		),
		","
	)

/** The rows of `a` not in `b`, as a set. */
export const minus = (a: ReadonlyArray<Row>, b: ReadonlyArray<Row>): number => {
	const there = new Set(Arr.map(b, rowText))
	return Arr.filter(a, (r) => !there.has(rowText(r))).length
}

export const sameRows = (a: ReadonlyArray<Row>, b: ReadonlyArray<Row>): boolean =>
	minus(a, b) === 0 && minus(b, a) === 0

/** A ChangeSet's work on one unit: delete it, insert it, or replace it (both, at the same key, in one stratum). */
type UnitOp<V> =
	| { readonly kind: "delete" }
	| { readonly kind: "insert"; readonly value: V }
	| { readonly kind: "replace"; readonly value: V }

/** A write: its work on trees, shelves, tests and assemblies, each key once, and how its deletes name their units. */
interface Write {
	readonly trees: ReadonlyArray<{ readonly doc: bigint; readonly op: UnitOp<NodeValue> }>
	readonly shelves: ReadonlyArray<{ readonly id: bigint; readonly op: UnitOp<ShelfValue> }>
	readonly tests: ReadonlyArray<{ readonly t: bigint; readonly op: UnitOp<TestValue> }>
	readonly asms: ReadonlyArray<{ readonly a: bigint; readonly op: UnitOp<bigint> }>
	readonly by: "array" | "query"
}

/** A sequence's member deleted alone, a Tok or a Book, by its key, which holds a drawn field. */
interface PartialGroup {
	readonly relation: "Tok" | "Book"
	readonly fact: Fact
}

/** A tree's node named by its key, its root value and its start, in place of its root value. */
interface NodeByKey {
	readonly doc: bigint
	readonly start: bigint
}

/** A delete of tests or of assemblies in a stratum that deletes no row of the other, beside another unit's delete or
 * alone. */
interface CrossingAlone {
	readonly relation: "Test" | "Asm"
	readonly beside: "nothing" | "Node" | "Shelf"
}

export interface Params {
	readonly write: Write
	readonly "partial group": PartialGroup
	readonly "node by key": NodeByKey
	readonly "crossing alone": CrossingAlone
}

export type Refusal =
	| "a differing unit at a stored key"
	| "a crossing group left partial"
	| "a sequence member named by a drawn key"
	| "a tree's node named by its key"
	| "a crossing delete without the other relation's"

const docs: Arr.NonEmptyReadonlyArray<bigint> = [1n, 2n, 3n]

const ids: Arr.NonEmptyReadonlyArray<bigint> = [1n, 2n, 3n]

const testIds: Arr.NonEmptyReadonlyArray<bigint> = [1n, 2n]

const asmIds: Arr.NonEmptyReadonlyArray<bigint> = [1n, 2n]

const small: Arr.NonEmptyReadonlyArray<bigint> = [0n, 1n, 2n]

const attrGen: Gen<ReadonlyArray<AttrValue>> = (source) => {
	const names = Arr.filter(small, () => source.draw(boolean))
	return Arr.map(names, (name) => ({
		name,
		v: source.draw(element([-1n, 0n, 1n, 2n] as const)),
		toks: source.draw(array(element(small), { min: 0, max: 2 }))
	}))
}

const nodeGen =
	(depth: number): Gen<NodeValue> =>
	(source) => ({
		label: source.draw(element(small)),
		attrs: source.draw(attrGen),
		children: depth === 0 ? [] : source.draw(array(nodeGen(depth - 1), { min: 0, max: 2 }))
	})

const shelfGen: Gen<ShelfValue> = (source) => ({
	note: source.draw(element([0n, 1n] as const)),
	books: source.draw(array(element([0n, 1n, 3n] as const), { min: 0, max: 3 })),
	tags: Arr.filter(small, () => source.draw(boolean))
})

/** A value differing from `value` or not, as the draw falls: one small edit of it, or a fresh one. */
const editedTree =
	(value: NodeValue): Gen<NodeValue> =>
	(source) =>
		source.draw(
			element([
				{ ...value, label: (value.label + 1n) % 3n },
				{ ...value, attrs: source.draw(attrGen) },
				{ ...value, children: [...value.children, source.draw(nodeGen(0))] },
				{ ...value, children: value.children.slice(1) },
				source.draw(nodeGen(2))
			] as const)
		)

const editedShelf =
	(value: ShelfValue): Gen<ShelfValue> =>
	(source) =>
		source.draw(
			element([
				{ ...value, note: 1n - value.note },
				{ ...value, books: [...value.books, 1n] },
				{ ...value, books: value.books.slice(1) },
				{ ...value, tags: Arr.filter(small, () => source.draw(boolean)) },
				source.draw(shelfGen)
			] as const)
		)

export const storedAt = <V>(
	units: ReadonlyArray<readonly [bigint, V]>,
	key: bigint
): V | undefined =>
	Option.getOrUndefined(
		Option.map(
			Arr.findFirst(units, ([k]) => k === key),
			([, value]) => value
		)
	)

/** A unit's work in a state: none, a delete, an insert (a fresh value, or the stored one again), or a replace (the stored
 * value again, an edit of it, or a fresh one). A differing unit inserted at a stored key it does not delete is the insert
 * protocol's (KEYSTRESS's G4), not drawn here. */
const opGen =
	<V>(
		stored: V | undefined,
		fresh: Gen<V>,
		edited: (value: V) => Gen<V>
	): Gen<UnitOp<V> | undefined> =>
	(source) => {
		const kind = source.draw(element(["none", "delete", "insert", "replace"] as const))
		switch (kind) {
			case "none":
				return undefined
			case "delete":
				return { kind: "delete" }
			case "insert":
				return { kind: "insert", value: stored ?? source.draw(fresh) }
			case "replace":
				return {
					kind: "replace",
					value:
						stored === undefined
							? source.draw(fresh)
							: source.draw(element(["same", "edited"] as const)) === "same"
								? stored
								: source.draw(edited(stored))
				}
		}
	}

/** Some of the assemblies `pool` holds, a set. */
const subsetOf =
	(pool: ReadonlyArray<bigint>): Gen<ReadonlyArray<bigint>> =>
	(source) =>
		Arr.filter(pool, () => source.draw(boolean))

/** A tree of instances to `depth` levels below its root, each placing some of the assemblies of `pool`. */
const instGen =
	(depth: number, pool: ReadonlyArray<bigint>): Gen<InstValue> =>
	(source) => ({
		label: source.draw(element(small)),
		places: source.draw(subsetOf(pool)),
		children: depth === 0 ? [] : source.draw(array(instGen(depth - 1, pool), { min: 0, max: 2 }))
	})

/** A fresh test, its instances placing assemblies of `pool`. */
const testGen =
	(pool: ReadonlyArray<bigint>): Gen<TestValue> =>
	(source) => ({
		note: source.draw(element([0n, 1n] as const)),
		root: source.draw(instGen(1, pool))
	})

/** `root` with each instance placing only the assemblies of `pool`. */
const placingWithin = (root: InstValue, pool: ReadonlyArray<bigint>): InstValue => ({
	...root,
	places: Arr.filter(root.places, (a) => pool.includes(a)),
	children: Arr.map(root.children, (child) => placingWithin(child, pool))
})

/** Whether every instance of `root` places only assemblies of `pool`. */
const placesWithin = (root: InstValue, pool: ReadonlyArray<bigint>): boolean =>
	Arr.every(root.places, (a) => pool.includes(a)) &&
	Arr.every(root.children, (child) => placesWithin(child, pool))

/** A test differing from `value` or not, as the draw falls, placing only assemblies of `pool`: one small edit of it, or a
 * fresh one. */
const editedTest =
	(value: TestValue, pool: ReadonlyArray<bigint>): Gen<TestValue> =>
	(source) => {
		const edited = source.draw(
			element([
				{ ...value, note: 1n - value.note },
				{ ...value, root: { ...value.root, label: (value.root.label + 1n) % 3n } },
				{ ...value, root: { ...value.root, places: source.draw(subsetOf(pool)) } },
				{
					...value,
					root: { ...value.root, children: [...value.root.children, source.draw(instGen(0, pool))] }
				},
				{ ...value, root: { ...value.root, children: value.root.children.slice(1) } },
				source.draw(testGen(pool))
			] as const)
		)
		return { ...edited, root: placingWithin(edited.root, pool) }
	}

/** The stored tests and assemblies placements link, transitively: a delete of one of them leaves a group of each
 * placement it takes partial unless the placement's other owner goes too. An assembly no test places is one alone. */
interface Component {
	readonly tests: ReadonlyArray<readonly [bigint, TestValue]>
	readonly asms: ReadonlyArray<readonly [bigint, bigint]>
}

const componentsOf = (m: Model): ReadonlyArray<Component> => {
	const placements = placementsOf(m)
	const linked = new Set<bigint>()
	const placed = new Set<bigint>()
	const components: Array<Component> = []
	for (const [t] of m.tests) {
		if (linked.has(t)) {
			continue
		}
		const tests: Array<bigint> = [t]
		const asms: Array<bigint> = []
		for (const test of tests) {
			for (const p of placements) {
				if (p.t === test && !asms.includes(p.a)) {
					asms.push(p.a)
					for (const q of placements) {
						if (q.a === p.a && !tests.includes(q.t)) {
							tests.push(q.t)
						}
					}
				}
			}
		}
		for (const x of tests) {
			linked.add(x)
		}
		for (const a of asms) {
			placed.add(a)
		}
		components.push({
			tests: Arr.filter(m.tests, ([x]) => tests.includes(x)),
			asms: Arr.filter(m.asms, ([a]) => asms.includes(a))
		})
	}
	return [
		...components,
		...Arr.map(
			Arr.filter(m.asms, ([a]) => !placed.has(a)),
			(asm) => ({ tests: [], asms: [asm] })
		)
	]
}

/** A component's work: left alone, deleted whole, replaced whole identically, edited, split into its units, or its tests
 * alone or its assemblies alone deleted or replaced, the others kept, a crossing group then partial where they share a
 * placement. */
type ComponentWork =
	| "none"
	| "delete"
	| "same"
	| "edited"
	| "split"
	| "tests alone"
	| "assemblies alone"

const componentWorks: Arr.NonEmptyReadonlyArray<ComponentWork> = [
	"none",
	"delete",
	"same",
	"edited",
	"split",
	"tests alone",
	"assemblies alone"
]

/** The kind of work one unit of a component, a test or an assembly, meets: drawn on its own where the component is split
 * or where its own kind alone is changed. */
const unitKindOf =
	(work: ComponentWork, unit: "test" | "asm"): Gen<"none" | "delete" | "replace"> =>
	(source) => {
		switch (work) {
			case "none":
			case "delete":
				return work
			case "same":
			case "edited":
				return "replace"
			case "split":
				return source.draw(element(["none", "delete", "replace"] as const))
			case "tests alone":
				return unit === "test" ? source.draw(element(["delete", "replace"] as const)) : "none"
			case "assemblies alone":
				return unit === "asm" ? source.draw(element(["delete", "replace"] as const)) : "none"
		}
	}

/**
 * The tests' and assemblies' work in a state, by component: each left alone, deleted whole, replaced whole identically,
 * edited (each of its units replaced, an assembly's note kept or flipped, a test edited), split (each of its units left
 * alone, deleted, or replaced, identically or not, on its own), or its tests alone or its assemblies alone deleted or
 * replaced; and each key no unit holds left alone, deleted (no row), inserted or replaced fresh. Each test the write
 * inserts places only assemblies it inserts, a fresh one, as the draw falls, any of them or only those no unit held.
 */
const crossingGen =
	(m: Model): Gen<Pick<Write, "tests" | "asms">> =>
	(source) => {
		const works = Arr.map(componentsOf(m), (component) => ({
			component,
			work: source.draw(element(componentWorks))
		}))
		const asms: Array<{ readonly a: bigint; readonly op: UnitOp<bigint> }> = []
		for (const { component, work } of works) {
			for (const [a, note] of component.asms) {
				const kind = source.draw(unitKindOf(work, "asm"))
				if (kind === "delete") {
					asms.push({ a, op: { kind } })
				} else if (kind === "replace") {
					asms.push({
						a,
						op: {
							kind,
							value: work === "same" ? note : source.draw(element([note, 1n - note] as const))
						}
					})
				}
			}
		}
		for (const a of asmIds) {
			if (storedAt(m.asms, a) === undefined) {
				const kind = source.draw(element(["none", "delete", "insert", "replace"] as const))
				if (kind === "delete") {
					asms.push({ a, op: { kind } })
				} else if (kind !== "none") {
					asms.push({ a, op: { kind, value: source.draw(element([0n, 1n] as const)) } })
				}
			}
		}
		const pool = Arr.flatMap(asms, (x) => (x.op.kind === "delete" ? [] : [x.a]))
		const freshPool = source.draw(
			element([pool, Arr.filter(pool, (a) => storedAt(m.asms, a) === undefined)] as const)
		)
		const tests: Array<{ readonly t: bigint; readonly op: UnitOp<TestValue> }> = []
		for (const { component, work } of works) {
			for (const [t, value] of component.tests) {
				const kind = source.draw(unitKindOf(work, "test"))
				if (kind === "delete") {
					tests.push({ t, op: { kind } })
				} else if (kind === "replace") {
					const same =
						work === "same" ||
						(work !== "edited" &&
							placesWithin(value.root, pool) &&
							source.draw(element(["same", "edited"] as const)) === "same")
					tests.push({
						t,
						op: { kind, value: same ? value : source.draw(editedTest(value, pool)) }
					})
				}
			}
		}
		for (const t of testIds) {
			if (storedAt(m.tests, t) === undefined) {
				const kind = source.draw(element(["none", "delete", "insert", "replace"] as const))
				if (kind === "delete") {
					tests.push({ t, op: { kind } })
				} else if (kind !== "none") {
					tests.push({ t, op: { kind, value: source.draw(testGen(freshPool)) } })
				}
			}
		}
		return { tests, asms }
	}

const writeGen =
	(m: Model): Gen<Write> =>
	(source) => {
		const trees = Arr.flatMap(docs, (doc) => {
			const op = source.draw(opGen(storedAt(m.trees, doc), nodeGen(2), editedTree))
			return op === undefined ? [] : [{ doc, op }]
		})
		const shelves = Arr.flatMap(ids, (id) => {
			const op = source.draw(opGen(storedAt(m.shelves, id), shelfGen, editedShelf))
			return op === undefined ? [] : [{ id, op }]
		})
		const crossing = source.draw(crossingGen(m))
		const forced =
			trees.length + shelves.length + crossing.tests.length + crossing.asms.length === 0
				? [{ doc: source.draw(element(docs)), op: { kind: "delete" } as const }]
				: []
		return {
			trees: [...trees, ...forced],
			shelves,
			...crossing,
			by: source.draw(element(["array", "query"] as const))
		}
	}

/** Applies `op` at `key` to `units`, or answers the refusal of a unit inserted at a stored key it differs from. */
const applyOp = <V>(
	units: ReadonlyArray<readonly [bigint, V]>,
	key: bigint,
	op: UnitOp<V>,
	same: (a: V, b: V) => boolean
): ReadonlyArray<readonly [bigint, V]> | "conflict" => {
	const rest = Arr.filter(units, ([k]) => k !== key)
	const stored = storedAt(units, key)
	switch (op.kind) {
		case "delete":
			return rest
		case "replace":
			return [...rest, [key, op.value]]
		case "insert":
			return stored === undefined
				? [...rest, [key, op.value]]
				: same(stored, op.value)
					? units
					: "conflict"
	}
}

const byKey = <V>(units: ReadonlyArray<readonly [bigint, V]>) =>
	Arr.sort(
		units,
		Order.mapInput(Order.BigInt, ([k]: readonly [bigint, V]) => k)
	)

export const sameTree = (a: NodeValue, b: NodeValue): boolean => {
	const x = treeRows(0n, a)
	const y = treeRows(0n, b)
	return sameRows(x.node, y.node) && sameRows(x.attr, y.attr) && sameRows(x.tok, y.tok)
}

export const sameShelf = (a: ShelfValue, b: ShelfValue): boolean => {
	const x = shelfRows(0n, a)
	const y = shelfRows(0n, b)
	return sameRows(x.shelf, y.shelf) && sameRows(x.book, y.book) && sameRows(x.tag, y.tag)
}

const sameTest = (a: TestValue, b: TestValue): boolean => {
	const x = testRows(0n, a)
	const y = testRows(0n, b)
	const placed = (v: TestValue) => Arr.map(testPlacements(0n, v), placementRow)
	return sameRows(x.test, y.test) && sameRows(x.inst, y.inst) && sameRows(placed(a), placed(b))
}

/** Whether the write deletes the test `t`, by a delete or a replace. */
const deletesTest = (w: Write, t: bigint): boolean =>
	Arr.some(w.tests, (x) => x.t === t && x.op.kind !== "insert")

/** Whether the write deletes the assembly `a`, by a delete or a replace. */
const deletesAsm = (w: Write, a: bigint): boolean =>
	Arr.some(w.asms, (x) => x.a === a && x.op.kind !== "insert")

/**
 * The stored placements whose groups a write's deletes leave partial: each goes with either of its owners, so one whose
 * test the write deletes and whose assembly it keeps leaves the assembly's group partial (`asm`), and one whose
 * assembly it deletes and whose test it keeps leaves the instance's (`inst`). The write inserts placements only for
 * assemblies it inserts, so none of them is placed again.
 */
export const partialOf = (m: Model, w: Write) => {
	const placements = placementsOf(m)
	return {
		asm: Arr.filter(placements, (p) => deletesTest(w, p.t) && !deletesAsm(w, p.a)),
		inst: Arr.filter(placements, (p) => deletesAsm(w, p.a) && !deletesTest(w, p.t))
	}
}

/** A row's key as a refusal's witness names it: its relation and its primary key's values. */
interface KeyedRow {
	readonly relation: string
	readonly values: Readonly<Record<string, bigint>>
}

/**
 * The stored rows a write leaves partial groups of, by the family the group is of (partialOf): of an assembly's
 * placements, each assembly whose group it leaves partial and each placement of it the write keeps; of an instance's,
 * each such instance and each placement of it the write keeps. The family's deferred foreign keys leave one of them
 * unmatched, a kept member whose predecessor went or an owner whose last member went, and its refusal at COMMIT is
 * witnessed by that row's key (docs/errors-and-concurrency.md "Errors and outcomes", Witness).
 */
export const partialRows = (m: Model, w: Write) => {
	const placements = placementsOf(m)
	const partial = partialOf(m, w)
	const asms = Arr.dedupe(Arr.map(partial.asm, (p) => p.a))
	/** An instance by its key. */
	type InstKey = Readonly<Record<"t" | "start", bigint>>
	const insts = Arr.dedupeWith(
		Arr.map(partial.inst, (p): InstKey => ({ t: p.t, start: p.start })),
		(x: InstKey, y: InstKey) => x.t === y.t && x.start === y.start
	)
	const place = (p: Placement): KeyedRow => ({
		relation: "Place",
		values: { t: p.t, start: p.start, a: p.a }
	})
	return {
		asm: [
			...Arr.map(asms, (a): KeyedRow => ({ relation: "Asm", values: { a } })),
			...Arr.map(
				Arr.filter(placements, (p) => asms.includes(p.a) && !deletesTest(w, p.t)),
				place
			)
		],
		inst: [
			...Arr.map(insts, (i): KeyedRow => ({ relation: "Inst", values: i })),
			...Arr.map(
				Arr.filter(
					placements,
					(p) => Arr.some(insts, (i) => i.t === p.t && i.start === p.start) && !deletesAsm(w, p.a)
				),
				place
			)
		]
	}
}

const judgeWrite = (m: Model, w: Write): Verdict<Model, Refusal> => {
	let trees = m.trees
	for (const t of w.trees) {
		const next = applyOp(trees, t.doc, t.op, sameTree)
		if (next === "conflict") {
			return refused("a differing unit at a stored key")
		}
		trees = next
	}
	let shelves = m.shelves
	for (const s of w.shelves) {
		const next = applyOp(shelves, s.id, s.op, sameShelf)
		if (next === "conflict") {
			return refused("a differing unit at a stored key")
		}
		shelves = next
	}
	const partial = partialOf(m, w)
	if (partial.asm.length + partial.inst.length > 0) {
		return refused("a crossing group left partial")
	}
	let tests = m.tests
	for (const t of w.tests) {
		const next = applyOp(tests, t.t, t.op, sameTest)
		if (next === "conflict") {
			return refused("a differing unit at a stored key")
		}
		tests = next
	}
	let asms = m.asms
	for (const a of w.asms) {
		const next = applyOp(asms, a.a, a.op, (x, y) => x === y)
		if (next === "conflict") {
			return refused("a differing unit at a stored key")
		}
		asms = next
	}
	return accepted({
		trees: byKey(trees),
		shelves: byKey(shelves),
		tests: byKey(tests),
		asms: byKey(asms)
	})
}

/** The facts each stored member of a sequence is named by alone, a Tok's and a Book's, which hold no drawn key field. */
const memberFacts = (
	m: Model
): { readonly [R in PartialGroup["relation"]]: ReadonlyArray<Fact> } => {
	const placedAttrs = Arr.flatMap(m.trees, ([doc, root]) =>
		Arr.flatMap(preOrder(root), (p) => Arr.map(p.node.attrs, (a) => ({ doc, start: p.start, a })))
	)
	return {
		Tok: Arr.flatMap(placedAttrs, ({ doc, start, a }) =>
			Arr.map(a.toks, (t) => ({ doc, start, name: a.name, t }))
		),
		Book: Arr.flatMap(m.shelves, ([shelf, s]) => Arr.map(s.books, (words) => ({ shelf, words })))
	}
}

/** The fact of a member at a key no unit stores, of each relation. */
const absentMember: { readonly [R in PartialGroup["relation"]]: Fact } = {
	Tok: { doc: 1n, start: 0n, name: 0n, t: 0n },
	Book: { shelf: 1n, words: 0n }
}

/** A stored member to name, or one at a key no unit stores. */
const partialGen =
	(m: Model): Gen<PartialGroup> =>
	(source) => {
		const relationOf = source.draw(element(["Tok", "Book"] as const))
		const stored = memberFacts(m)[relationOf]
		return {
			relation: relationOf,
			fact: Arr.isReadonlyArrayNonEmpty(stored)
				? source.draw(element(stored))
				: absentMember[relationOf]
		}
	}

export const machine: Machine<Model, Params, Refusal> = {
	initial: empty,
	commands: {
		write: {
			weight: 8,
			applies: () => true,
			parameters: writeGen,
			judge: judgeWrite
		},
		"partial group": {
			weight: 1,
			applies: () => true,
			parameters: partialGen,
			judge: () => refused("a sequence member named by a drawn key")
		},
		"node by key": {
			weight: 1,
			applies: () => true,
			parameters: () => (source) => ({
				doc: source.draw(element(docs)),
				start: BigInt(source.draw(int(0, 3)))
			}),
			judge: () => refused("a tree's node named by its key")
		},
		"crossing alone": {
			weight: 1,
			applies: () => true,
			parameters: () => (source) => ({
				relation: source.draw(element(["Test", "Asm"] as const)),
				beside: source.draw(element(["nothing", "Node", "Shelf"] as const))
			}),
			judge: () => refused("a crossing delete without the other relation's")
		}
	}
}

export type Feature =
	| "a tree replaced identically, no change"
	| "a tree replaced with other rows"
	| "a tree deleted whole"
	| "a shelf deleted with books and tags"
	| "a shelf replaced identically, no change"
	| "a shelf replaced with other rows"
	| "a unit deleted by a query"
	| "a unit inserted again identically, no change"
	| "a unit added again unchanged left untouched"
	| "an attr's tokens replaced"
	| "units of both kinds replaced in one ChangeSet"
	| "a sequence member named by a drawn key refused"
	| "a tree's node named by its key refused"
	| "crossing groups deleted whole by a test's and an assembly's deletes"
	| "a crossing component replaced with other rows"
	| "a crossing component replaced identically left untouched"
	| "a crossing group left partial by a test's delete refused"
	| "a crossing group left partial by an assembly's delete refused"
	| "a crossing delete without the other relation's refused"
	| "a root named by an array replaced by its own fact, identically, left untouched"
	| "a root named by an array replaced by its own fact over changed nested rows"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"a tree replaced identically, no change",
	"a tree replaced with other rows",
	"a tree deleted whole",
	"a shelf deleted with books and tags",
	"a shelf replaced identically, no change",
	"a shelf replaced with other rows",
	"a unit deleted by a query",
	"a unit inserted again identically, no change",
	"a unit added again unchanged left untouched",
	"an attr's tokens replaced",
	"units of both kinds replaced in one ChangeSet",
	"a sequence member named by a drawn key refused",
	"a tree's node named by its key refused",
	"crossing groups deleted whole by a test's and an assembly's deletes",
	"a crossing component replaced with other rows",
	"a crossing component replaced identically left untouched",
	"a crossing group left partial by a test's delete refused",
	"a crossing group left partial by an assembly's delete refused",
	"a crossing delete without the other relation's refused",
	"a root named by an array replaced by its own fact, identically, left untouched",
	"a root named by an array replaced by its own fact over changed nested rows"
]

const commandNames: Arr.NonEmptyReadonlyArray<keyof Params> = [
	"write",
	"partial group",
	"node by key",
	"crossing alone"
]

/** A program of up to six ChangeSets over its own swarm of commands. */
export const programGen: Gen<Program<Params>> = (source) =>
	source.draw(program(machine, { min: 1, max: 6 }, source.draw(swarm(commandNames))))

/** A node of a tree as its nested fact states it: its label and its children in order. */
interface Labelled {
	readonly label: bigint
	readonly children: ReadonlyArray<Labelled>
}

/** A tree's nested fact: its root names its root value; no node names its parent, which grizzle draws. */
export const nestedNode = (n: Labelled): Fact => ({
	label: n.label,
	children: Arr.map(n.children, nestedNode)
})

/** The Attr facts of a tree, each at its node's start, its tokens nested in order. */
export const attrFacts = (doc: bigint, root: NodeValue): ReadonlyArray<unknown> =>
	Arr.flatMap(preOrder(root), (p) =>
		Arr.map(p.node.attrs, (a) => ({
			doc,
			start: p.start,
			name: a.name,
			v: a.v,
			toks: Arr.map(a.toks, (t) => ({ t }))
		}))
	)

/** The relations and key fields a unit's rows are found by: a tree's, a shelf's, a test's and an assembly's. */
export const unitParts = {
	tree: [
		[Node, "doc"],
		[Attr, "doc"],
		[Tok, "doc"]
	],
	shelf: [
		[Shelf, "id"],
		[Book, "shelf"],
		[Tag, "shelf"]
	],
	test: [
		[Test, "t"],
		[Inst, "t"],
		[Place, "t"]
	],
	asm: [
		[Asm, "a"],
		[Place, "a"]
	]
} as const

export type UnitKind = keyof typeof unitParts

export const untouchedUnit: Feature = "a unit added again unchanged left untouched"

/**
 * The stored components a write adds again unchanged, whose rows it never writes: it replaces each of their tests and
 * assemblies with its stored value, and leaves their assemblies placed exactly as before, so every row of them is added
 * again equal, every owner of it is kept, and every counted group of it is the same set.
 */
export const untouchedComponents = (
	before: Model,
	after: Model,
	w: Write
): ReadonlyArray<Component> =>
	Arr.filter(componentsOf(before), (component) => {
		const keys = Arr.map(component.asms, ([a]) => a)
		const placed = (m: Model) =>
			Arr.map(
				Arr.filter(placementsOf(m), (p) => keys.includes(p.a)),
				placementRow
			)
		return (
			Arr.every(component.tests, ([t, value]) =>
				Arr.some(
					w.tests,
					(x) => x.t === t && x.op.kind === "replace" && sameTest(value, x.op.value)
				)
			) &&
			Arr.every(component.asms, ([a, note]) =>
				Arr.some(w.asms, (x) => x.a === a && x.op.kind === "replace" && x.op.value === note)
			) &&
			sameRows(placed(before), placed(after))
		)
	})

/** The features a write accepted over `before` reaches. */
export const notesOf = (w: Write, before: Model, note: (feature: Feature) => void): void => {
	for (const t of w.trees) {
		const stored = storedAt(before.trees, t.doc)
		if (stored === undefined) {
			continue
		}
		if (t.op.kind === "delete" && stored.children.length > 0) {
			note("a tree deleted whole")
		}
		if (t.op.kind === "replace") {
			note(
				sameTree(stored, t.op.value)
					? "a tree replaced identically, no change"
					: "a tree replaced with other rows"
			)
			if (Arr.some(stored.attrs, (a) => a.toks.length > 0) && !sameTree(stored, t.op.value)) {
				note("an attr's tokens replaced")
			}
		}
		if (t.op.kind === "insert" && sameTree(stored, t.op.value)) {
			note("a unit inserted again identically, no change")
		}
	}
	for (const s of w.shelves) {
		const stored = storedAt(before.shelves, s.id)
		if (stored === undefined) {
			continue
		}
		if (s.op.kind !== "insert" && stored.books.length > 0 && stored.tags.length > 0) {
			note("a shelf deleted with books and tags")
		}
		if (s.op.kind === "replace") {
			note(
				sameShelf(stored, s.op.value)
					? "a shelf replaced identically, no change"
					: "a shelf replaced with other rows"
			)
		}
		if (s.op.kind === "insert" && sameShelf(stored, s.op.value)) {
			note("a unit inserted again identically, no change")
		}
	}
	if (
		Arr.some(
			w.trees,
			(t) => t.op.kind === "replace" && storedAt(before.trees, t.doc) !== undefined
		) &&
		Arr.some(
			w.shelves,
			(s) => s.op.kind === "replace" && storedAt(before.shelves, s.id) !== undefined
		)
	) {
		note("units of both kinds replaced in one ChangeSet")
	}
	const whole = Arr.filter(placementsOf(before), (p) => deletesTest(w, p.t) && deletesAsm(w, p.a))
	if (Arr.isReadonlyArrayNonEmpty(whole)) {
		note("crossing groups deleted whole by a test's and an assembly's deletes")
	}
	const replacedTest = Arr.some(w.tests, (x) => {
		const stored = storedAt(before.tests, x.t)
		return (
			x.op.kind === "replace" &&
			stored !== undefined &&
			!sameTest(stored, x.op.value) &&
			Arr.some(whole, (p) => p.t === x.t)
		)
	})
	const replacedAsm = Arr.some(
		w.asms,
		(x) => x.op.kind === "replace" && Arr.some(whole, (p) => p.a === x.a)
	)
	if (replacedTest && replacedAsm) {
		note("a crossing component replaced with other rows")
	}
	if (
		w.by === "array" &&
		Arr.some(w.tests, (x) => {
			const stored = storedAt(before.tests, x.t)
			return (
				x.op.kind === "replace" &&
				stored !== undefined &&
				stored.note === x.op.value.note &&
				!sameTest(stored, x.op.value)
			)
		})
	) {
		note("a root named by an array replaced by its own fact over changed nested rows")
	}
}

const declared = worldOf("Whole")

/** Whole installed once per member with its full world's login (install-migrate.ts installedTemplate). */
export const wholeTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "whole",
	fixture: declared,
	programs: {},
	contexts: [],
	label: "whole",
	ambient: ordinarySession
})
