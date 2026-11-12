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
import { memberOps } from "#adapter/db/handles.ts"
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
import { appliedWith, type CallFacts, member, openServedDb } from "#test/support/served-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Deleting a group whole, and replacing it in one ChangeSet, against a pure model of the relations as sets.
 *
 * The world holds every kind of group: a tree, Node, keyed by its root `doc` and its drawn start, each node owning a
 * counted family of Attr whose values sum into the node's `weight`, each Attr owning an ordered family of Tok; and an
 * owner of two families, Shelf, its ordered Books summing their words into its `pages` with running values, and its
 * counted Tags. Every owner is immutable, as qti-pie's content is, so a group changes only through its owner.
 *
 * A program is ChangeSets over that world. Each `write` names, per key of a small pool, a unit (a tree by its root, a
 * shelf by its id) and what the ChangeSet does to it: deletes it; inserts it; or replaces it, a delete and an insert at
 * the same key in one stratum, its new value identical to the stored one or differing from it; a delete names its units
 * by an array or by a query per key. A unit inserted at a stored key it does not delete is the stored one again (a
 * differing one there is the insert protocol's, drawn by test/pg/write G4's properties). The named invalid ChangeSets
 * are refused before any SQL: a partial group (a member of an immutable owner's family deleted alone, by a key that
 * holds a drawn field or by its facts), a member appended to an owner the ChangeSet deletes and does not insert again,
 * and a tree's node named by its key in place of its root value. An owner without its members is no ChangeSet at all: a delete of an owner takes its groups.
 *
 * The model holds each unit as a value (a tree of labelled nodes, each with its attrs and their tokens; a shelf with its
 * books in order and its set of tags) and renders every relation's rows from the units, every drawn and accumulated
 * field as the README states it: a node's pre-order interval, its index among its siblings, its parent's start (the
 * root its own, 0), its count of children and of attrs and its sum of their values; an ordered member's index and
 * running sum. Its verdict for a write is the next state, the stored units less the deleted plus the inserted, or the
 * refusal of a unit inserted at a stored key it does not delete and differs from. The oracles, for every ChangeSet:
 * - every relation stores exactly the model's rows after it, and after a refused one the rows before it;
 * - the outcome is the model's: `no-change` where the rendered state is unchanged, `accepted` with each relation's
 *   counts the difference of the two states otherwise, `invariant-rejected` naming only laws of the units' relations;
 * - PostgreSQL commits every accepted one, so every law holds at commit; a refusal the model names comes before any SQL;
 * - a stored unit the ChangeSet adds again unchanged, by a replace or an insert, is never written: each of its rows keeps
 *   its tuple and the transaction that wrote it, as PostgreSQL's ctid and xmin show.
 *
 * Plants (~/.cache/grizzle-release/WHOLEDEL/plants/), each caught by this property (plants-run.sh there):
 * one-member-left-behind.patch, the unit delete skipping the last relation below its root, refused by the family's law
 * where the model accepts; delete-after-insert.patch, the unit removal after every other write of its stratum, a replace
 * refused at its key; partial-group-refusal-removed.patch, a delete of an immutable owner's member compiled;
 * fold-end-not-recounted.patch, the kept rule comparing an owner without its accumulated ends, which keeps it with a
 * stale end, refused by the fold's law; kept-rule-dropped.patch, every doomed row deleted, an unchanged unit's rows
 * rewritten.
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

const relations = { Node, Attr, Tok, Shelf, Book, Tag } as const
const statements = [nodes, attrs, weights, toks, books, pages, tags] as const

/** The world under `name`: the one schema every case's ChangeSets are over. */
const worldOf = (name: string) => schema(name, relations, statements)

type RelationName = keyof typeof relations
const relationNames: Arr.NonEmptyReadonlyArray<RelationName> = [
	"Node",
	"Attr",
	"Tok",
	"Shelf",
	"Book",
	"Tag"
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

/** The stored units: each tree by its root `doc`, each shelf by its id, in key order. */
interface Model {
	readonly trees: ReadonlyArray<readonly [bigint, NodeValue]>
	readonly shelves: ReadonlyArray<readonly [bigint, ShelfValue]>
}

const empty: Model = { trees: [], shelves: [] }

/** A fact as a ChangeSet states it. */
type Fact = Readonly<Record<string, unknown>>

/** A rendered row: each field's value. */
type Row = Readonly<Record<string, bigint>>

/** Every relation's rows, rendered from the units. */
type Rendered = { readonly [R in RelationName]: ReadonlyArray<Row> }

const sum = (xs: ReadonlyArray<bigint>): bigint => Arr.reduce(xs, 0n, (a, b) => a + b)

/** A tree's rows: each node in pre-order, its interval [start, end), its parent's start (the root its own, 0), its index
 * among its siblings (the root 0), its counts and its attrs' sum; each attr and each of its tokens in order. */
const treeRows = (doc: bigint, root: NodeValue) => {
	const node: Array<Row> = []
	const attr: Array<Row> = []
	const tok: Array<Row> = []
	let next = 0n
	const walk = (n: NodeValue, parent: bigint | undefined, at: bigint): void => {
		const start = next
		next += 1n
		for (const [i, child] of n.children.entries()) {
			walk(child, start, BigInt(i))
		}
		node.push({
			doc,
			parent: parent ?? start,
			at,
			children: BigInt(n.children.length),
			start,
			end: next,
			label: n.label,
			attrs: BigInt(n.attrs.length),
			weight: sum(Arr.map(n.attrs, (a) => a.v))
		})
		for (const a of n.attrs) {
			attr.push({ doc, start, name: a.name, v: a.v, toks: BigInt(a.toks.length) })
			for (const [i, t] of a.toks.entries()) {
				tok.push({ doc, start, name: a.name, at: BigInt(i), t })
			}
		}
	}
	walk(root, undefined, 0n)
	return { node, attr, tok }
}

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
	return {
		Node: Arr.flatMap(trees, (t) => t.node),
		Attr: Arr.flatMap(trees, (t) => t.attr),
		Tok: Arr.flatMap(trees, (t) => t.tok),
		Shelf: Arr.flatMap(shelves, (s) => s.shelf),
		Book: Arr.flatMap(shelves, (s) => s.book),
		Tag: Arr.flatMap(shelves, (s) => s.tag)
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

/** A write: its work on trees and shelves, each key once, and how its deletes name their units. */
interface Write {
	readonly trees: ReadonlyArray<{ readonly doc: bigint; readonly op: UnitOp<NodeValue> }>
	readonly shelves: ReadonlyArray<{ readonly id: bigint; readonly op: UnitOp<ShelfValue> }>
	readonly by: "array" | "query"
}

/** A member of an immutable owner's family deleted alone: an Attr or a Tag by its facts, a Tok or a Book by its key. */
interface PartialGroup {
	readonly relation: "Attr" | "Tag" | "Tok" | "Book"
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

interface Params {
	readonly write: Write
	readonly "partial group": PartialGroup
	readonly "orphan append": OrphanAppend
	readonly "node by key": NodeByKey
}

type Refusal =
	| "a differing unit at a stored key"
	| "a fixed family's member deleted alone"
	| "a sequence member named by a drawn key"
	| "an append to an owner the stratum does not insert"
	| "a tree's node named by its key"

const docs: Arr.NonEmptyReadonlyArray<bigint> = [1n, 2n, 3n]
const ids: Arr.NonEmptyReadonlyArray<bigint> = [1n, 2n, 3n]
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
		const forced =
			trees.length + shelves.length === 0
				? [{ doc: source.draw(element(docs)), op: { kind: "delete" } as const }]
				: []
		return {
			trees: [...trees, ...forced],
			shelves,
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
	return accepted({ trees: byKey(trees), shelves: byKey(shelves) })
}

/** The facts each stored member of an immutable owner's family is named by alone: an Attr's and a Tag's, and a Tok's and
 * a Book's, which hold no drawn key field. */
const memberFacts = (
	m: Model
): { readonly [R in PartialGroup["relation"]]: ReadonlyArray<Fact> } => {
	const attr: Array<Fact> = []
	const tok: Array<Fact> = []
	for (const [doc, root] of m.trees) {
		let next = 0n
		const walk = (n: NodeValue): void => {
			const start = next
			next += 1n
			for (const a of n.attrs) {
				attr.push({ doc, start, name: a.name, v: a.v })
				for (const t of a.toks) {
					tok.push({ doc, start, name: a.name, t })
				}
			}
			for (const child of n.children) {
				walk(child)
			}
		}
		walk(root)
	}
	return {
		Attr: attr,
		Tok: tok,
		Tag: Arr.flatMap(m.shelves, ([shelf, s]) => Arr.map(s.tags, (label) => ({ shelf, label }))),
		Book: Arr.flatMap(m.shelves, ([shelf, s]) => Arr.map(s.books, (words) => ({ shelf, words })))
	}
}

/** The fact of a member at a key no unit stores, of each relation. */
const absentMember: { readonly [R in PartialGroup["relation"]]: Fact } = {
	Attr: { doc: 1n, start: 0n, name: 0n, v: 0n },
	Tok: { doc: 1n, start: 0n, name: 0n, t: 0n },
	Tag: { shelf: 1n, label: 0n },
	Book: { shelf: 1n, words: 0n }
}

/** A stored member to name, or one at a key no unit stores. */
const partialGen =
	(m: Model): Gen<PartialGroup> =>
	(source) => {
		const relationOf = source.draw(element(["Attr", "Tag", "Tok", "Book"] as const))
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
	"a tree's node named by its key refused"
]

const commandNames: Arr.NonEmptyReadonlyArray<keyof Params> = [
	"write",
	"partial group",
	"orphan append",
	"node by key"
]

/** A program of up to six ChangeSets over its own swarm of commands. */
const programGen: Gen<Program<Params>> = (source) =>
	source.draw(program(machine, { min: 1, max: 6 }, source.draw(swarm(commandNames))))

/** A tree's nested fact: its root names its root value; no node names its parent, which grizzle draws. */
const nestedNode = (n: NodeValue): Fact => ({
	label: n.label,
	children: Arr.map(n.children, nestedNode)
})

/** The Attr facts of a tree, each at its node's start, its tokens nested in order. */
const attrFacts = (doc: bigint, root: NodeValue): ReadonlyArray<unknown> => {
	const facts: Array<unknown> = []
	let next = 0n
	const walk = (n: NodeValue): void => {
		const start = next
		next += 1n
		for (const a of n.attrs) {
			facts.push({ doc, start, name: a.name, v: a.v, toks: Arr.map(a.toks, (t) => ({ t })) })
		}
		for (const child of n.children) {
			walk(child)
		}
	}
	walk(root)
	return facts
}

layer(Substrate.layer, { excludeTestServices: true })(
	"deleting a group whole and replacing it, on PostgreSQL 19rc1",
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
						const unitLaws = {
							tree: new Set<LawId>([
								lawNames.primaryKeyLaw({ name: "Node" }),
								lawNames.primaryKeyLaw({ name: "Attr" }),
								lawNames.primaryKeyLaw({ name: "Tok" }),
								lawNames.lawOf(nodes),
								lawNames.lawOf(attrs),
								lawNames.lawOf(weights),
								lawNames.lawOf(toks)
							]),
							shelf: new Set<LawId>([
								lawNames.primaryKeyLaw({ name: "Shelf" }),
								lawNames.primaryKeyLaw({ name: "Book" }),
								lawNames.primaryKeyLaw({ name: "Tag" }),
								lawNames.lawOf(books),
								lawNames.lawOf(pages),
								lawNames.lawOf(tags)
							])
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
							const versionsOf = (unit: "tree" | "shelf", key: bigint) =>
								Effect.gen(function* () {
									const parts =
										unit === "tree"
											? ([
													[Node, "doc"],
													[Attr, "doc"],
													[Tok, "doc"]
												] as const)
											: ([
													[Shelf, "id"],
													[Book, "shelf"],
													[Tag, "shelf"]
												] as const)
									const texts: Array<string> = []
									for (const [r, field] of parts) {
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
									return Result.succeed(memberOps(db.ctx, member(loaded.success, "step")))
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
																known.push(...rows)
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
														/** The stored units the write adds again unchanged, each with its rows' versions before it. */
														const repeated = [
															...Arr.flatMap(w.trees, (t) => {
																const stored = storedAt(before.trees, t.doc)
																return t.op.kind !== "delete" &&
																	stored !== undefined &&
																	sameTree(stored, t.op.value)
																	? [{ unit: "tree" as const, key: t.doc }]
																	: []
															}),
															...Arr.flatMap(w.shelves, (sh) => {
																const stored = storedAt(before.shelves, sh.id)
																return sh.op.kind !== "delete" &&
																	stored !== undefined &&
																	sameShelf(stored, sh.op.value)
																	? [{ unit: "shelf" as const, key: sh.id }]
																	: []
															})
														]
														const versions: Array<{
															readonly unit: "tree" | "shelf"
															readonly key: bigint
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
														const outcome = yield* Effect.orDie(
															appliedWith(loaded.success, facts satisfies CallFacts, params)
														)
														const was = render(before)
														if (verdict.kind === "refused") {
															assert.equal(
																outcome.kind,
																"invariant-rejected",
																`${label}: a unit differs at a stored key`
															)
															if (outcome.kind === "invariant-rejected") {
																const named = Arr.map(outcome.refused.laws, (law) =>
																	names.reported(law)
																)
																const allowed = (law: LawId) =>
																	unitLaws.tree.has(law) || unitLaws.shelf.has(law)
																assert.ok(
																	outcome.refused.kind === "every"
																		? Arr.every(named, allowed)
																		: Arr.some(named, allowed),
																	`${label}: refused by ${Formatter.format(named)}, no law of the units' relations`
																)
															}
															yield* storesExactly(before, `the refused ${label}`)
															return refused("a differing unit at a stored key")
														}
														const next = render(after)
														const unchanged = Arr.every(relationNames, (n) =>
															sameRows(was[n], next[n])
														)
														assert.equal(
															outcome.kind,
															unchanged ? "no-change" : "accepted",
															`${label}: the outcome`
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
															c.note("a unit added again unchanged left untouched")
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
															appliedWith(
																loaded.success,
																{ delete: { Node: [{ doc: p.doc, start: p.start }] } },
																{}
															)
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
}
