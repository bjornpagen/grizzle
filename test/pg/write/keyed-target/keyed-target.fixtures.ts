/** What the properties of keyed-target.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Data } from "effect"
import type { Plan } from "#adapter/types/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	counted,
	fin,
	fold,
	key,
	Monoid,
	on,
	ordered,
	relation,
	schema,
	select,
	tree
} from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { upTo } from "#test/support/up-to.ts"

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

const Pub = relation("Pub", { pkg: pg.bigint, item: pg.bigint }, ["pkg", "item"])

const Lead = relation("Lead", { id: pg.bigint, pkg: pg.bigint, leads: pg.boolean }, ["id"])

const attrs = counted(on(Attr, "doc", "start"), fin(Node, "attrs"))

const books = ordered(on(Book, "shelf", "at"), fin(Shelf, "books"))

export const World = schema(
	"keyed_target",
	[Node, Attr, Tok, Shelf, Book, Tag, Test, Inst, Asm, Place, Pub, Lead],
	[
		tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["doc"] }),
		attrs,
		fold(attrs, Monoid.sum, on(Attr, "doc", "start", "v"), on(Node, "doc", "start", "weight")),
		ordered(on(Tok, "doc", "start", "name", "at"), fin(Attr, "toks")),
		books,
		fold(
			books,
			Monoid.sum,
			on(Book, "shelf", "words", "before", "after"),
			on(Shelf, "id", "pages")
		),
		counted(on(Tag, "shelf"), fin(Shelf, "tags")),
		tree(on(Inst, "parent", "at"), fin(Inst, "children"), { root: ["t"] }),
		counted(on(Inst, "t"), fin(Test, "insts")),
		counted(on(Place, "t", "start"), fin(Inst, "places")),
		counted(on(Place, "a"), fin(Asm, "places")),
		key(
			on(
				select(Lead, (x) => x.eq(x.leads, true)),
				"pkg"
			)
		)
	]
)

export const RELATIONS: Arr.NonEmptyReadonlyArray<string> = [
	"Node",
	"Attr",
	"Tok",
	"Shelf",
	"Book",
	"Tag",
	"Test",
	"Inst",
	"Asm",
	"Place",
	"Pub",
	"Lead"
]

/** Each unit root's delete by a query of its key, the key a parameter of the call. */
const byQuery = ChangeSet.empty(World)
	.delete(
		Node,
		query(World).rule((r) => {
			const { doc } = v(Node, "node")
			return r
				.match(Node, { doc, start: 0n })
				.where(r.eq(doc, r.param("doc", pg.bigint)))
				.find({ doc })
		})
	)
	.delete(
		Shelf,
		query(World).rule((r) => {
			const { id, note } = v(Shelf, "shelf")
			return r
				.match(Shelf, { id, note })
				.where(r.eq(id, r.param("shelf", pg.bigint)))
				.find({ id, note })
		})
	)
	.delete(
		Test,
		query(World).rule((r) => {
			const { t, note } = v(Test, "test")
			return r
				.match(Test, { t, note })
				.where(r.eq(t, r.param("test", pg.bigint)))
				.find({ t, note })
		})
	)
	.delete(
		Asm,
		query(World).rule((r) => {
			const { a, note } = v(Asm, "asm")
			return r
				.match(Asm, { a, note })
				.where(r.eq(a, r.param("asm", pg.bigint)))
				.find({ a, note })
		})
	)

const programs = Object.freeze({
	load: ChangeSet.empty(World)
		.insert(Node, [])
		.insert(Attr, [])
		.insert(Shelf, [])
		.insert(Tag, [])
		.insert(Test, [])
		.insert(Inst, [])
		.insert(Asm, [])
		.insert(Place, [])
		.insert(Pub, []),
	replace: ChangeSet.empty(World)
		.delete(Node, [])
		.delete(Shelf, [])
		.delete(Test, [])
		.delete(Asm, [])
		.insert(Node, [])
		.insert(Attr, [])
		.insert(Shelf, [])
		.insert(Tag, [])
		.insert(Test, [])
		.insert(Inst, [])
		.insert(Asm, [])
		.insert(Place, []),
	replaceByQuery: byQuery
		.insert(Node, [])
		.insert(Attr, [])
		.insert(Shelf, [])
		.insert(Tag, [])
		.insert(Test, [])
		.insert(Inst, [])
		.insert(Asm, [])
		.insert(Place, []),
	prune: ChangeSet.empty(World).delete(
		Pub,
		query(World).rule((r) => {
			const kept = r.relation("kept", { item: Pub.fields.item })
			const { pkg, item } = v(Pub, "pub")
			return r
				.match(Pub, { pkg, item })
				.where(r.eq(pkg, r.param("pkg", pg.bigint)))
				.where(r.not(kept, { item }))
				.find({ pkg, item })
		})
	),
	republish: ChangeSet.empty(World)
		.delete(
			Pub,
			query(World).rule((r) => {
				const { pkg, item } = v(Pub, "pub")
				return r
					.match(Pub, { pkg, item })
					.where(r.eq(pkg, r.param("pkg", pg.bigint)))
					.find({ pkg, item })
			})
		)
		.insert(Pub, []),
	lead: ChangeSet.empty(World).insert(Lead, [])
})

type Program = "replace" | "replace by query" | "prune" | "republish" | "lead"

type Fate = "deleted" | "replaced unchanged" | "replaced changed"

/**
 * A case: the instance, `units` units of each kind, each of `size` nodes, books, tags, instances and ledger items; and
 * a call of `program` at unit `at` of each kind, its units meeting `fate` (a prune meets none).
 */
export interface Sketch {
	readonly program: Program
	readonly fate: Fate
	readonly units: number
	readonly size: number
	readonly at: number
}

const PROGRAMS: Arr.NonEmptyReadonlyArray<Program> = [
	"replace",
	"replace by query",
	"prune",
	"republish",
	"lead"
]

const FATES: Arr.NonEmptyReadonlyArray<Fate> = ["deleted", "replaced unchanged", "replaced changed"]

export const sketchGen: Gen<Sketch> = (source) => {
	const units = source.draw(int(1, 2))
	const program = source.draw(element(PROGRAMS))
	return {
		program,
		fate:
			program === "replace" || program === "replace by query"
				? source.draw(element(FATES))
				: "deleted",
		units,
		size: source.draw(int(1, 2)),
		at: source.draw(int(0, units - 1))
	}
}

export type Feature = `${Program} with its units ${Fate}`

export const featureOf = (s: Sketch): Feature => `${s.program} with its units ${s.fate}`

export const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	...Arr.flatMap(["replace", "replace by query"] as const, (p) =>
		Arr.map(FATES, (f): Feature => `${p} with its units ${f}`)
	),
	"prune with its units deleted",
	"republish with its units deleted",
	"lead with its units deleted"
]

/** A unit's value: the label every node, book, tag and instance of it carries, `size` of each. */
interface Unit {
	readonly key: bigint
	readonly label: bigint
	readonly size: number
}

/** A tree's node as its nested fact states it: its label and its children in order. */
interface Chain {
	readonly label: bigint
	readonly children: ReadonlyArray<Chain>
}

/** A tree of `size` nodes as its nested fact states it: the root and, below it, a chain of the rest. */
const nestedChain = (label: bigint, size: number): Chain => ({
	label,
	children: size <= 1 ? [] : [nestedChain(label, size - 1)]
})

/** The facts every relation of the world inserts for `units`, each unit's tree a chain of its nodes. */
export const unitFacts = (units: ReadonlyArray<Unit>) => ({
	Node: Arr.map(units, (u) => ({ doc: u.key, ...nestedChain(u.label, u.size) })),
	Attr: Arr.flatMap(units, (u) =>
		Arr.map(
			upTo(u.size, (i) => i),
			(i) => ({
				doc: u.key,
				start: BigInt(i),
				name: 0n,
				v: u.label,
				toks: Arr.map(
					upTo(u.size, (j) => j),
					(j) => ({ t: u.label + BigInt(j) })
				)
			})
		)
	),
	Shelf: Arr.map(units, (u) => ({
		id: u.key,
		note: u.label,
		books: Arr.map(
			upTo(u.size, (j) => j),
			(j) => ({ words: u.label + BigInt(j) })
		)
	})),
	Tag: Arr.flatMap(units, (u) =>
		Arr.map(
			upTo(u.size, (j) => j),
			(j) => ({ shelf: u.key, label: u.label + BigInt(j) })
		)
	),
	Test: Arr.map(units, (u) => ({ t: u.key, note: u.label })),
	Inst: Arr.map(units, (u) => ({ t: u.key, ...nestedChain(u.label, u.size) })),
	Asm: Arr.map(units, (u) => ({ a: u.key, note: u.label })),
	Place: Arr.flatMap(units, (u) =>
		Arr.map(
			upTo(u.size, (i) => i),
			(i) => ({ t: u.key, start: BigInt(i), a: u.key })
		)
	)
})

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The relations a plan's nodes modify. */
export const modified = (plan: Plan): ReadonlyArray<string> => [
	...(plan.node === "ModifyTable" && plan.on.kind === "relation" ? [plan.on.relation] : []),
	...Arr.flatMap(plan.children, modified)
]

/** Every relation among `written` a node of `plan` reads by a sequential scan. */
export const seqScans = (plan: Plan, written: ReadonlySet<string>): ReadonlyArray<string> => [
	...(plan.node === "Seq Scan" && plan.on.kind === "relation" && written.has(plan.on.relation)
		? [plan.on.relation]
		: []),
	...Arr.flatMap(plan.children, (child) => seqScans(child, written))
]

export const stored = (s: Sketch): ReadonlyArray<Unit> =>
	upTo(s.units, (i) => ({ key: BigInt(i), label: BigInt(10 * i + 1), size: s.size }))

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const worldInstall = Object.freeze({ label: "keyed_target", programs })

/** World installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const worldTemplate = fixtureTemplate(import.meta, World, worldInstall)
