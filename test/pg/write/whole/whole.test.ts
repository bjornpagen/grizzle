import { layer } from "@effect/vitest"
import {
	accepted,
	type Machine,
	type Program,
	program,
	type Real,
	refused,
	runProgram,
	took,
	type Verdict
} from "@grizzle/testing/commands"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { swarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import { OpenError } from "#adapter/errors/execution.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { accumulated, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
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
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { applicationOf, member, openServedDb } from "#test/support/served-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Deleting a group whole, and replacing it in one ChangeSet, against a pure model of the relations as sets.
 *
 * The world holds every kind of group: a tree, Node, keyed by its root `doc` and its drawn start, each node owning a
 * counted family of Attr whose values sum into the node's `weight`, each Attr owning an ordered family of Tok; an owner
 * of two families, Shelf, its ordered Books summing their words into its `pages` with running values, and its counted
 * Tags; and qti-pie's crossing shape, a Test owning a counted family of Inst, a tree whose nodes are its members, each
 * Inst owning a counted family of Place, every Place also a member of an Asm's counted family. Every owner is
 * immutable, as qti-pie's content is, so a group changes only through its owner.
 *
 * A program is ChangeSets over that world. Each `write` names, per key of a small pool, a unit (a tree by its root, a
 * shelf, a test or an assembly by its id) and what the ChangeSet does to it: deletes it; inserts it; or replaces it, a
 * delete and an insert at the same key in one stratum, its new value identical to the stored one or differing from it;
 * a delete names its units by an array or by a query per key. A unit inserted at a stored key it does not delete is the
 * stored one again (a differing one there is the insert protocol's, drawn by test/pg/write G4's properties). Tests and
 * assemblies are drawn by the components their placements link, each left alone, deleted whole, replaced whole
 * identically or edited, or split, each of its units drawn on its own; a test is inserted only at a key no test holds
 * or after its delete, its placements naming only assemblies the ChangeSet inserts (an append to a stored immutable
 * owner is the insert protocol's), and a ChangeSet that deletes either deletes both relations, as qti-pie's replace
 * `delete(T, q1)`, `delete(A, q2)`, `insertAll(rows)` does, its deletes of one of them possibly naming no row. A test or
 * an assembly named by an array is named by its own fact, the one its insert states, so a replace that keeps its note
 * deletes and inserts one root fact: the unit goes whole all the same, but for the rows the stratum adds again unchanged,
 * never netted away as one fact both deleted and inserted would be. The named
 * invalid ChangeSets are refused before any SQL: a partial group (a member of an immutable owner's family deleted
 * alone, by a key that holds a drawn field or by its facts), a member appended to an owner the ChangeSet deletes and
 * does not insert again, a tree's node named by its key in place of its root value, and a delete of a test or an
 * assembly in a stratum that deletes no row of the other, whose placements' other groups it would leave partial. An
 * owner without its members is no ChangeSet at all: a delete of an owner takes its groups.
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
 *
 * Plants (~/.cache/grizzle-release/WHOLEDEL/plants/), each caught by this property (plants-run.sh there):
 * one-member-left-behind.patch, the unit delete skipping the last relation below its root, refused by the family's law
 * where the model accepts; delete-after-insert.patch, the unit removal after every other write of its stratum, a replace
 * refused at its key; partial-group-refusal-removed.patch, a delete of an immutable owner's member compiled;
 * fold-end-not-recounted.patch, the kept rule comparing an owner without its accumulated ends, which keeps it with a
 * stale end, refused by the fold's law; kept-rule-dropped.patch, every doomed row deleted, an unchanged unit's rows
 * rewritten. ~/.cache/grizzle-release/REPLACEPROP/plants/: per-delete-check-restored.patch, 73c7406e reverted, each unit
 * delete judged alone, refuses every crossing delete when it compiles; units-netted.patch, a unit delete's facts netted
 * against the equal root fact its stratum inserts, so the unit is never removed and a replace that changes a nested row
 * is refused on that row's key.
 */

const Node = relation(
	"Node",
	{
		doc: pg.bigint,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		label: pg.bigint,
		attrs: drawnField(natural),
		weight: accumulated(pg.bigint, 0n)
	},
	["doc", "start"]
)
const Attr = relation(
	"Attr",
	{ doc: pg.bigint, start: natural, name: pg.bigint, v: pg.bigint, toks: drawnField(natural) },
	["doc", "start", "name"]
)
const Tok = relation(
	"Tok",
	{ doc: pg.bigint, start: natural, name: pg.bigint, at: drawnField(natural), t: pg.bigint },
	["doc", "start", "name", "at"]
)
const Shelf = relation(
	"Shelf",
	{
		id: pg.bigint,
		note: pg.bigint,
		books: drawnField(natural),
		tags: drawnField(natural),
		pages: accumulated(pg.bigint, 0n)
	},
	["id"]
)
const Book = relation(
	"Book",
	{
		shelf: pg.bigint,
		at: drawnField(natural),
		words: pg.bigint,
		before: accumulated(pg.bigint, 0n),
		after: accumulated(pg.bigint, 0n)
	},
	["shelf", "at"]
)
const Tag = relation("Tag", { shelf: pg.bigint, label: pg.bigint }, ["shelf", "label"])

const nodes = tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["doc"] })
const attrs = counted(on(Attr, "doc", "start"), fin(Node, "attrs"))
const weights = fold(
	attrs,
	Monoid.sum,
	on(Attr, "doc", "start", "v"),
	on(Node, "doc", "start", "weight")
)
const toks = ordered(on(Tok, "doc", "start", "name", "at"), fin(Attr, "toks"))
const books = ordered(on(Book, "shelf", "at"), fin(Shelf, "books"))
const pages = fold(
	books,
	Monoid.sum,
	on(Book, "shelf", "words", "before", "after"),
	on(Shelf, "id", "pages")
)
const tags = counted(on(Tag, "shelf"), fin(Shelf, "tags"))
const Test = relation("Test", { t: pg.bigint, note: pg.bigint, insts: drawnField(natural) }, ["t"])
const Inst = relation(
	"Inst",
	{
		t: pg.bigint,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		label: pg.bigint,
		places: drawnField(natural)
	},
	["t", "start"]
)
const Asm = relation("Asm", { a: pg.bigint, note: pg.bigint, places: drawnField(natural) }, ["a"])
const Place = relation("Place", { t: pg.bigint, start: natural, a: pg.bigint }, ["t", "start", "a"])

const instances = tree(on(Inst, "parent", "at"), fin(Inst, "children"), { root: ["t"] })
const testInsts = counted(on(Inst, "t"), fin(Test, "insts"))
const instPlaces = counted(on(Place, "t", "start"), fin(Inst, "places"))
const asmPlaces = counted(on(Place, "a"), fin(Asm, "places"))

const relations = { Node, Attr, Tok, Shelf, Book, Tag, Test, Inst, Asm, Place } as const
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
const worldOf = (name: string) => schema(name, Rec.values(relations), statements)

type RelationName = keyof typeof relations
const relationNames: Arr.NonEmptyReadonlyArray<RelationName> = [
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
interface Model {
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
const testPlacements = (t: bigint, test: TestValue): ReadonlyArray<Placement> =>
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
const placementRow = (p: Placement): Row => ({ t: p.t, start: p.start, a: p.a })

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

const render = (m: Model): Rendered => {
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
const minus = (a: ReadonlyArray<Row>, b: ReadonlyArray<Row>): number => {
	const there = new Set(Arr.map(b, rowText))
	return Arr.filter(a, (r) => !there.has(rowText(r))).length
}

const sameRows = (a: ReadonlyArray<Row>, b: ReadonlyArray<Row>): boolean =>
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

/** A member of an immutable owner's family deleted alone: an Attr, a Tag or a Place by its facts, a Tok or a Book by its
 * key. */
interface PartialGroup {
	readonly relation: "Attr" | "Tag" | "Place" | "Tok" | "Book"
	readonly fact: Fact
}

/** A shelf deleted and a tag appended to it, the shelf not inserted again. */
interface OrphanAppend {
	readonly id: bigint
	readonly note: bigint
	readonly label: bigint
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

interface Params {
	readonly write: Write
	readonly "partial group": PartialGroup
	readonly "orphan append": OrphanAppend
	readonly "node by key": NodeByKey
	readonly "crossing alone": CrossingAlone
}

type Refusal =
	| "a differing unit at a stored key"
	| "a crossing group left partial"
	| "a fixed family's member deleted alone"
	| "a sequence member named by a drawn key"
	| "an append to an owner the stratum does not insert"
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

const storedAt = <V>(units: ReadonlyArray<readonly [bigint, V]>, key: bigint): V | undefined =>
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

const sameTree = (a: NodeValue, b: NodeValue): boolean => {
	const x = treeRows(0n, a)
	const y = treeRows(0n, b)
	return sameRows(x.node, y.node) && sameRows(x.attr, y.attr) && sameRows(x.tok, y.tok)
}

const sameShelf = (a: ShelfValue, b: ShelfValue): boolean => {
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
const partialOf = (m: Model, w: Write) => {
	const placements = placementsOf(m)
	return {
		asm: Arr.filter(placements, (p) => deletesTest(w, p.t) && !deletesAsm(w, p.a)),
		inst: Arr.filter(placements, (p) => deletesAsm(w, p.a) && !deletesTest(w, p.t))
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

/** The facts each stored member of an immutable owner's family is named by alone: an Attr's, a Tag's and a Place's, and
 * a Tok's and a Book's, which hold no drawn key field. */
const memberFacts = (
	m: Model
): { readonly [R in PartialGroup["relation"]]: ReadonlyArray<Fact> } => {
	const placedAttrs = Arr.flatMap(m.trees, ([doc, root]) =>
		Arr.flatMap(preOrder(root), (p) => Arr.map(p.node.attrs, (a) => ({ doc, start: p.start, a })))
	)
	return {
		Attr: Arr.map(placedAttrs, ({ doc, start, a }) => ({ doc, start, name: a.name, v: a.v })),
		Tok: Arr.flatMap(placedAttrs, ({ doc, start, a }) =>
			Arr.map(a.toks, (t) => ({ doc, start, name: a.name, t }))
		),
		Tag: Arr.flatMap(m.shelves, ([shelf, s]) => Arr.map(s.tags, (label) => ({ shelf, label }))),
		Book: Arr.flatMap(m.shelves, ([shelf, s]) => Arr.map(s.books, (words) => ({ shelf, words }))),
		Place: Arr.map(placementsOf(m), placementRow)
	}
}

/** The fact of a member at a key no unit stores, of each relation. */
const absentMember: { readonly [R in PartialGroup["relation"]]: Fact } = {
	Attr: { doc: 1n, start: 0n, name: 0n, v: 0n },
	Tok: { doc: 1n, start: 0n, name: 0n, t: 0n },
	Tag: { shelf: 1n, label: 0n },
	Book: { shelf: 1n, words: 0n },
	Place: { t: 1n, start: 0n, a: 1n }
}

/** The members a partial group names, by the refusal it meets: a fixed family's by its facts, or a sequence's by a key
 * that holds a drawn field, each refusal drawn as often. */
const partialMembers = [
	["Attr", "Tag", "Place"],
	["Tok", "Book"]
] as const

/** A stored member to name, or one at a key no unit stores. */
const partialGen =
	(m: Model): Gen<PartialGroup> =>
	(source) => {
		const relationOf = source.draw(element(source.draw(element(partialMembers))))
		const stored = memberFacts(m)[relationOf]
		return {
			relation: relationOf,
			fact: Arr.isReadonlyArrayNonEmpty(stored)
				? source.draw(element(stored))
				: absentMember[relationOf]
		}
	}

const machine: Machine<Model, Params, Refusal> = {
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
			judge: (_, p) =>
				refused(
					p.relation === "Tok" || p.relation === "Book"
						? "a sequence member named by a drawn key"
						: "a fixed family's member deleted alone"
				)
		},
		"orphan append": {
			weight: 1,
			applies: () => true,
			parameters: (m) => (source) => {
				const shelf = Arr.isReadonlyArrayNonEmpty(m.shelves)
					? source.draw(element(m.shelves))
					: undefined
				return {
					id: shelf === undefined ? source.draw(element(ids)) : shelf[0],
					note: shelf === undefined ? 0n : shelf[1].note,
					label: source.draw(element(small))
				}
			},
			judge: () => refused("an append to an owner the stratum does not insert")
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

type Feature =
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
	| "a fixed family's member deleted alone refused"
	| "a sequence member named by a drawn key refused"
	| "an append to an owner the stratum does not insert refused"
	| "a tree's node named by its key refused"
	| "crossing groups deleted whole by a test's and an assembly's deletes"
	| "a crossing component replaced with other rows"
	| "a crossing component replaced identically left untouched"
	| "a crossing group left partial by a test's delete refused"
	| "a crossing group left partial by an assembly's delete refused"
	| "a crossing delete without the other relation's refused"
	| "a root named by an array replaced by its own fact, identically, left untouched"
	| "a root named by an array replaced by its own fact over changed nested rows"

const features: Arr.NonEmptyReadonlyArray<Feature> = [
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
	"a fixed family's member deleted alone refused",
	"a sequence member named by a drawn key refused",
	"an append to an owner the stratum does not insert refused",
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
	"orphan append",
	"node by key",
	"crossing alone"
]

/** A program of up to six ChangeSets over its own swarm of commands. */
const programGen: Gen<Program<Params>> = (source) =>
	source.draw(program(machine, { min: 1, max: 6 }, source.draw(swarm(commandNames))))

/** A node of a tree as its nested fact states it: its label and its children in order. */
interface Labelled {
	readonly label: bigint
	readonly children: ReadonlyArray<Labelled>
}

/** A tree's nested fact: its root names its root value; no node names its parent, which grizzle draws. */
const nestedNode = (n: Labelled): Fact => ({
	label: n.label,
	children: Arr.map(n.children, nestedNode)
})

/** The Attr facts of a tree, each at its node's start, its tokens nested in order. */
const attrFacts = (doc: bigint, root: NodeValue): ReadonlyArray<unknown> =>
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
const unitParts = {
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

type UnitKind = keyof typeof unitParts

const untouchedUnit: Feature = "a unit added again unchanged left untouched"

/**
 * The stored components a write adds again unchanged, whose rows it never writes: it replaces each of their tests and
 * assemblies with its stored value, and leaves their assemblies placed exactly as before, so every row of them is added
 * again equal, every owner of it is kept, and every counted group of it is the same set.
 */
const untouchedComponents = (before: Model, after: Model, w: Write): ReadonlyArray<Component> =>
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

layer(Substrate.layer, { excludeTestServices: true })(
	"deleting a group whole and replacing it, on PostgreSQL 19rc2",
	(it) => {
		it.effect(
			"every ChangeSet stores the model's rows and answers its outcome, counts and refusals",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const declared = worldOf("Whole")
						const done = yield* installMigrated(declared, {
							ambient: ordinarySession,
							label: "whole",
							logins: [fullWorld(declared, {}).server],
							extensions: []
						})
						const world = worldOf(done.schema)
						const names = namesOf(done)
						const lawNames = lawNamesOf(world)
						/** The laws of the trees' and the shelves' relations, which a unit differing at a stored key breaks. */
						const unitLaws: ReadonlyArray<LawId> = [
							lawNames.primaryKeyLaw({ name: "Node" }),
							lawNames.primaryKeyLaw({ name: "Attr" }),
							lawNames.primaryKeyLaw({ name: "Tok" }),
							lawNames.lawOf(nodes),
							lawNames.lawOf(attrs),
							lawNames.lawOf(weights),
							lawNames.lawOf(toks),
							lawNames.primaryKeyLaw({ name: "Shelf" }),
							lawNames.primaryKeyLaw({ name: "Book" }),
							lawNames.primaryKeyLaw({ name: "Tag" }),
							lawNames.lawOf(books),
							lawNames.lawOf(pages),
							lawNames.lawOf(tags)
						]
						/** The law of each family a crossing group belongs to: an assembly's placements, an instance's. */
						const crossingLaws = {
							asm: lawNames.lawOf(asmPlaces),
							inst: lawNames.lawOf(instPlaces)
						}
						const group = installationGroup(names)
						const served = fullWorld(world, {})
						return yield* Effect.gen(function* () {
							const db = yield* openServedDb(done, served.server.roles.app, {})
							/** Every relation's stored rows equal the model's. */
							const storesExactly = (m: Model, what: string) =>
								Effect.gen(function* () {
									const expected = render(m)
									for (const name of relationNames) {
										const stored = yield* tableState(done, relations[name])
										unorderedEqual(stored, expected[name], `${name}'s rows after ${what}`)
									}
								})
							/**
							 * A unit's rows as PostgreSQL stores them, each by its tuple's place and the transaction that wrote it, in its
							 * relations' order: the same text after a write exactly where the write rewrote none of them.
							 */
							const versionsOf = (unit: UnitKind, key: bigint) =>
								Effect.gen(function* () {
									const texts: Array<string> = []
									for (const [r, field] of unitParts[unit]) {
										const rows = yield* s.admin.queryValues(
											`SELECT ctid::text || '@' || xmin::text FROM ${printObjectName(done.names.relation(r.name))} WHERE ${quoteIdent(done.names.column(r.name, field))} = ${String(key)} ORDER BY ctid`,
											[]
										)
										texts.push(
											`${r.name}: ${Arr.join(
												Arr.map(rows, (row) => String(row[0])),
												" "
											)}`
										)
									}
									return Arr.join(texts, "; ")
								})
							/** A ChangeSet loaded as the one member of a workload, or its refusal when it compiles. */
							const load = (changes: unknown) =>
								Effect.gen(function* () {
									const loaded = yield* Effect.result(db.load({ step: changes }))
									if (Result.isFailure(loaded)) {
										const refusal = loaded.failure
										if (refusal instanceof OpenError) {
											return yield* Effect.die(refusal)
										}
										const error = refusal.error
										if (!isCompileError(error)) {
											return yield* Effect.die(new Error(Formatter.format(error)))
										}
										return Result.fail(error.reason)
									}
									return Result.succeed(applicationOf(db.ctx, member(loaded.success, "step")))
								})
							return yield* explore(
								{
									suite: "pg/write/whole",
									draw: drawn(programGen),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "a model of the relations as sets of units: the stored units less the deleted plus the inserted, each relation's rows rendered as the README draws them"
									},
									coverage: required<Feature>(features, { cases: 96, sense: notesOnly }),
									kept: [],
									runs: 24,
									shrink: boundedShrink(80),
									concurrency: 1,
									steerEvery: 8,
									caseHang
								},
								(steps, c) =>
									Effect.gen(function* () {
										yield* replaceRows(s.admin, group, [])
										const reals: Real<Model, Params, Refusal, never, Substrate> = {
											write: (w, before, after, verdict) =>
												Effect.orDie(
													Effect.gen(function* () {
														const label = `${Formatter.format(w)} over ${Formatter.format(before)}`
														let changes = ChangeSet.empty(world)
														const facts: Record<string, Record<string, Array<unknown>>> = {}
														const params: Record<string, bigint> = {}
														const add = (
															op: "delete" | "insert",
															target: (typeof relations)[RelationName],
															rows: ReadonlyArray<unknown>
														) => {
															const at = facts[op] ?? {}
															const known = at[target.name]
															if (known === undefined) {
																at[target.name] = [...rows]
																changes =
																	op === "delete"
																		? changes.delete(target, [])
																		: changes.insert(target, [])
															} else {
																for (const row of rows) {
																	known.push(row)
																}
															}
															facts[op] = at
														}
														for (const t of w.trees) {
															if (t.op.kind !== "insert") {
																if (w.by === "query") {
																	const param = `doc${String(t.doc)}`
																	params[param] = t.doc
																	changes = changes.delete(
																		Node,
																		query(world).rule((r) => {
																			const { doc } = v(Node, "node")
																			return r
																				.match(Node, { doc, start: 0n })
																				.where(r.eq(doc, r.param(param, pg.bigint)))
																				.find({ doc })
																		})
																	)
																	c.note("a unit deleted by a query")
																} else {
																	add("delete", Node, [{ doc: t.doc }])
																}
															}
															if (t.op.kind !== "delete") {
																add("insert", Node, [{ doc: t.doc, ...nestedNode(t.op.value) }])
																add("insert", Attr, attrFacts(t.doc, t.op.value))
															}
														}
														for (const sh of w.shelves) {
															const stored = storedAt(before.shelves, sh.id)
															if (sh.op.kind !== "insert") {
																if (w.by === "query") {
																	const param = `shelf${String(sh.id)}`
																	params[param] = sh.id
																	changes = changes.delete(
																		Shelf,
																		query(world).rule((r) => {
																			const { id, note } = v(Shelf, "shelf")
																			return r
																				.match(Shelf, { id, note })
																				.where(r.eq(id, r.param(param, pg.bigint)))
																				.find({ id, note })
																		})
																	)
																	c.note("a unit deleted by a query")
																} else {
																	add("delete", Shelf, [{ id: sh.id, note: stored?.note ?? 0n }])
																}
															}
															if (sh.op.kind !== "delete") {
																add("insert", Shelf, [
																	{
																		id: sh.id,
																		note: sh.op.value.note,
																		books: Arr.map(sh.op.value.books, (words) => ({ words }))
																	}
																])
																add(
																	"insert",
																	Tag,
																	Arr.map(sh.op.value.tags, (label) => ({ shelf: sh.id, label }))
																)
															}
														}
														const queried = new Set<RelationName>()
														for (const te of w.tests) {
															if (te.op.kind !== "insert") {
																if (w.by === "query") {
																	const param = `test${String(te.t)}`
																	params[param] = te.t
																	changes = changes.delete(
																		Test,
																		query(world).rule((r) => {
																			const { t, note } = v(Test, "test")
																			return r
																				.match(Test, { t, note })
																				.where(r.eq(t, r.param(param, pg.bigint)))
																				.find({ t, note })
																		})
																	)
																	queried.add("Test")
																	c.note("a unit deleted by a query")
																} else {
																	add("delete", Test, [
																		{ t: te.t, note: storedAt(before.tests, te.t)?.note ?? 0n }
																	])
																}
															}
															if (te.op.kind !== "delete") {
																add("insert", Test, [{ t: te.t, note: te.op.value.note }])
																add("insert", Inst, [{ t: te.t, ...nestedNode(te.op.value.root) }])
																const placed = Arr.map(
																	testPlacements(te.t, te.op.value),
																	placementRow
																)
																if (Arr.isReadonlyArrayNonEmpty(placed)) {
																	add("insert", Place, placed)
																}
															}
														}
														for (const asm of w.asms) {
															if (asm.op.kind !== "insert") {
																if (w.by === "query") {
																	const param = `asm${String(asm.a)}`
																	params[param] = asm.a
																	changes = changes.delete(
																		Asm,
																		query(world).rule((r) => {
																			const { a, note } = v(Asm, "asm")
																			return r
																				.match(Asm, { a, note })
																				.where(r.eq(a, r.param(param, pg.bigint)))
																				.find({ a, note })
																		})
																	)
																	queried.add("Asm")
																	c.note("a unit deleted by a query")
																} else {
																	add("delete", Asm, [
																		{ a: asm.a, note: storedAt(before.asms, asm.a) ?? 0n }
																	])
																}
															}
															if (asm.op.kind !== "delete") {
																add("insert", Asm, [{ a: asm.a, note: asm.op.value }])
															}
														}
														if (
															Arr.some(w.tests, (x) => x.op.kind !== "insert") ||
															Arr.some(w.asms, (x) => x.op.kind !== "insert")
														) {
															for (const r of [Test, Asm]) {
																if (
																	!queried.has(r.name) &&
																	facts["delete"]?.[r.name] === undefined
																) {
																	add("delete", r, [])
																}
															}
														}
														/** The stored units the write adds again unchanged, each with its rows' versions before it. */
														const repeated = [
															...Arr.flatMap(w.trees, (t) => {
																const stored = storedAt(before.trees, t.doc)
																return t.op.kind !== "delete" &&
																	stored !== undefined &&
																	sameTree(stored, t.op.value)
																	? [{ unit: "tree" as const, key: t.doc, feature: untouchedUnit }]
																	: []
															}),
															...Arr.flatMap(w.shelves, (sh) => {
																const stored = storedAt(before.shelves, sh.id)
																return sh.op.kind !== "delete" &&
																	stored !== undefined &&
																	sameShelf(stored, sh.op.value)
																	? [{ unit: "shelf" as const, key: sh.id, feature: untouchedUnit }]
																	: []
															}),
															...Arr.flatMap(untouchedComponents(before, after, w), (component) => {
																const feature: Feature = Arr.some(component.tests, ([t, value]) =>
																	Arr.isReadonlyArrayNonEmpty(testPlacements(t, value))
																)
																	? "a crossing component replaced identically left untouched"
																	: untouchedUnit
																return [
																	...Arr.map(component.tests, ([t]) => ({
																		unit: "test" as const,
																		key: t,
																		feature
																	})),
																	...Arr.map(component.asms, ([a]) => ({
																		unit: "asm" as const,
																		key: a,
																		feature
																	}))
																]
															})
														]
														const versions: Array<{
															readonly unit: UnitKind
															readonly key: bigint
															readonly feature: Feature
															readonly before: string
														}> = []
														for (const u of repeated) {
															const found = yield* versionsOf(u.unit, u.key)
															versions.push({ ...u, before: found })
														}
														const loaded = yield* load(changes)
														if (Result.isFailure(loaded)) {
															return assert.fail(
																`${label}: refused when it compiles, ${Formatter.format(loaded.failure)}`
															)
														}
														const outcome = yield* Effect.orDie(loaded.success({ params, facts }))
														const was = render(before)
														if (verdict.kind === "refused") {
															const partial = partialOf(before, w)
															const allowed = new Set<LawId>([
																...(verdict.refusal === "a differing unit at a stored key"
																	? unitLaws
																	: []),
																...(partial.asm.length > 0 ? [crossingLaws.asm] : []),
																...(partial.inst.length > 0 ? [crossingLaws.inst] : [])
															])
															assert.equal(
																outcome.kind,
																"invariant-rejected",
																`${label}: ${verdict.refusal}`
															)
															if (outcome.kind === "invariant-rejected") {
																const named = Arr.map(outcome.refused.laws, (law) =>
																	names.reported(law)
																)
																const among = (law: LawId) => allowed.has(law)
																assert.ok(
																	outcome.refused.kind === "every"
																		? Arr.every(named, among)
																		: Arr.some(named, among),
																	`${label}: refused by ${Formatter.format(named)}, none of ${Formatter.format([...allowed])}`
																)
															}
															yield* storesExactly(before, `the refused ${label}`)
															if (verdict.refusal === "a crossing group left partial") {
																if (partial.inst.length === 0) {
																	c.note("a crossing group left partial by a test's delete refused")
																}
																if (partial.asm.length === 0) {
																	c.note(
																		"a crossing group left partial by an assembly's delete refused"
																	)
																}
															}
															return refused(verdict.refusal)
														}
														const next = render(after)
														const unchanged = Arr.every(relationNames, (n) =>
															sameRows(was[n], next[n])
														)
														assert.equal(
															outcome.kind,
															unchanged ? "no-change" : "accepted",
															`${label}: the outcome, ${Formatter.format(outcome)}`
														)
														if (outcome.kind === "accepted") {
															for (const name of relationNames) {
																const counted_ = Option.getOrUndefined(
																	Arr.findFirst(outcome.counts, (x) => x.relation === name)
																)
																const added = BigInt(minus(next[name], was[name]))
																const deleted = BigInt(minus(was[name], next[name]))
																assert.deepEqual(
																	{
																		added: counted_?.added ?? 0n,
																		deleted: counted_?.deleted ?? 0n,
																		put: counted_?.put ?? 0n
																	},
																	{ added, deleted, put: 0n },
																	`${label}: ${name}'s counts, the difference of the two states`
																)
															}
														}
														yield* storesExactly(after, label)
														for (const u of versions) {
															const now = yield* versionsOf(u.unit, u.key)
															assert.equal(
																now,
																u.before,
																`${label}: the ${u.unit} at ${String(u.key)}, added again unchanged, is never written`
															)
															c.note(u.feature)
															if (w.by === "array" && (u.unit === "test" || u.unit === "asm")) {
																c.note(
																	"a root named by an array replaced by its own fact, identically, left untouched"
																)
															}
														}
														notesOf(w, before, c.note)
														return took
													})
												),
											"partial group": (p) =>
												Effect.orDie(
													Effect.gen(function* () {
														const name = p.relation
														const loaded = yield* load(
															ChangeSet.empty(world).delete(relations[name], [p.fact])
														)
														assert.ok(
															Result.isFailure(loaded),
															`a delete of ${name} alone is refused when it compiles`
														)
														if (Result.isFailure(loaded)) {
															const tag = loaded.failure._tag
															if (name === "Tok" || name === "Book") {
																assert.equal(tag, "UnstatedKey", `a delete of ${name}`)
																c.note("a sequence member named by a drawn key refused")
																return refused("a sequence member named by a drawn key")
															}
															assert.equal(tag, "UnsupportedOperation", `a delete of ${name}`)
															c.note("a fixed family's member deleted alone refused")
															return refused("a fixed family's member deleted alone")
														}
														return took
													})
												),
											"orphan append": (p) =>
												Effect.orDie(
													Effect.gen(function* () {
														const loaded = yield* load(
															ChangeSet.empty(world)
																.delete(Shelf, [{ id: p.id, note: p.note }])
																.insert(Tag, [{ shelf: p.id, label: p.label }])
														)
														assert.ok(
															Result.isFailure(loaded),
															"an append to a deleted owner is refused when it compiles"
														)
														if (Result.isFailure(loaded)) {
															assert.equal(
																loaded.failure._tag,
																"UnsupportedOperation",
																"an append to a deleted owner"
															)
															c.note("an append to an owner the stratum does not insert refused")
															return refused("an append to an owner the stratum does not insert")
														}
														return took
													})
												),
											"node by key": (p, before) =>
												Effect.orDie(
													Effect.gen(function* () {
														const loaded = yield* load(ChangeSet.empty(world).delete(Node, []))
														if (Result.isFailure(loaded)) {
															return assert.fail(
																`a delete of Node's trees is refused when it compiles: ${Formatter.format(loaded.failure)}`
															)
														}
														const applied = yield* Effect.result(
															loaded.success({
																params: {},
																facts: { delete: { Node: [{ doc: p.doc, start: p.start }] } }
															})
														)
														assert.ok(
															Result.isFailure(applied),
															"a node named by its key is refused before any SQL"
														)
														if (Result.isFailure(applied)) {
															assert.equal(
																applied.failure._tag,
																"EncodingFailure",
																"a node named by its key"
															)
														}
														yield* storesExactly(before, "a node named by its key")
														c.note("a tree's node named by its key refused")
														return refused("a tree's node named by its key")
													})
												),
											"crossing alone": (p) =>
												Effect.orDie(
													Effect.gen(function* () {
														const alone = ChangeSet.empty(world).delete(relations[p.relation], [])
														const loaded = yield* load(
															p.beside === "nothing" ? alone : alone.delete(relations[p.beside], [])
														)
														assert.ok(
															Result.isFailure(loaded),
															`a delete of ${p.relation} beside ${p.beside}, deleting no row of the other, is refused when it compiles`
														)
														if (Result.isFailure(loaded)) {
															assert.equal(
																loaded.failure._tag,
																"UnsupportedOperation",
																`a delete of ${p.relation} beside ${p.beside}`
															)
															c.note("a crossing delete without the other relation's refused")
															return refused("a crossing delete without the other relation's")
														}
														return took
													})
												)
										}
										yield* runProgram(machine, reals, steps)
									})
							)
						}).pipe(Effect.scoped)
					}).pipe(Effect.scoped)
				)
		)
	}
)

/** The features a write accepted over `before` reaches. */
const notesOf = (w: Write, before: Model, note: (feature: Feature) => void): void => {
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
