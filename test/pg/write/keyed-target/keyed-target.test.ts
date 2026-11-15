/**
 * A write statement reads the relations it writes only through a key it binds, on PostgreSQL 19rc2: every stored row a
 * generated write statement reads of a table it inserts into, updates or deletes from is reached at an index condition
 * from values the statement holds, its call's facts and parameters and the rows it found from them, never by a
 * condition over every row of the table. Such a read is a whole-table read per call however few rows the call names, a
 * cost that grows with every package stored beside the one rewritten, and a relation SIRead lock under SERIALIZABLE,
 * which fails every overlapping writer of the relation with 40001.
 *
 * - **PostgreSQL as the judge:** each statement a served ChangeSet member sends is explained in its place (its member's
 *   `explain`) by the login's sessions, whose role plans with sequential, index and index-only scans disabled, over
 *   relations left unanalyzed (test/support/plans.ts judgedSettings, unanalyzed), so no data size moves the verdict: a
 *   disabled node outranks every cost, and a sequential scan that survives is a read no index serves. No node of any
 *   statement's plan reads a relation the same statement modifies (a ModifyTable node's relation) by a sequential scan.
 *
 * The world is test/pg/write/whole's, every kind of unit a delete removes whole (write/delete/unit.ts): a tree, Node,
 * by its root `doc`, its counted Attrs and their ordered Toks; a shelf, owner of an ordered and a counted family; and
 * qti-pie's and edullm's crossing shape, a Test owning a counted tree of Inst, each Inst owning a counted family of
 * Place, every Place also a member of an Asm's counted family: a member of two families, whose doomed rows are reached
 * from either owner. Beside them a ledger, Pub, rows of a unit's key and an item, which a call rewrites for one unit:
 * pruned of the items a relation parameter no longer names, a described delete its target plays (write/delete/anchor.ts);
 * or republished, every item of the unit deleted by a query and its new items inserted in one stratum, so the delete
 * removes only what the unit no longer has (write/delete/exact.ts, its input the deleted less the inserted): edullm's
 * published pools and tests. And Lead, rows of an id, a unit's key and whether the row leads it, at most one lead a
 * unit: a key over a selected side, a UNIQUE over the unit key's law column, NULL where the row does not lead, the one
 * index that holds the unit key, which an insert meets its stored rows at by binding that column
 * (laws/model/uniques.ts GuardedReach), as the UNIQUE of a tree's siblings, over its parent's law column, is met.
 *
 * The box: an instance of one or two units of each kind, each tree, shelf and test of one or two nodes, books, tags and
 * instances, each test placing its own assembly, and each unit's ledger of one or two items; and a call at one unit of
 * each kind: its units deleted whole, replaced by the same value, or replaced by a changed one, each named by its facts
 * or by a query of its key (edullm's publisher replaces a package by a query); or its ledger pruned, or republished,
 * to its first item; or a lead inserted for it.
 *
 * Features, each required: each program at each fate its units meet.
 *
 * @plant test/plants/pg/write/keyed-target/unit-or-exists.patch the unit delete's doomed keys of a member of several families read as one condition over every stored row, an OR of an EXISTS per owner (write/delete/unit.ts before this law)
 * @plant test/plants/pg/write/keyed-target/delete-target-unbound.patch an exact delete binds its target to its source rows by a row comparison cast to text, which no index of the target serves
 * @plant test/plants/pg/write/keyed-target/guarded-by-fields.patch a key over a selected side is met at its fields with its selection over the stored row, never at its UNIQUE's own law column, so no index serves the read
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Data, Effect, Formatter, Layer } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { Plan } from "#adapter/types/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	key,
	relation,
	schema,
	select,
	tree
} from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { installed } from "#test/pg/reads/support.ts"
import { caseHang } from "#test/support/limits.ts"
import { judgedSettings, unanalyzed } from "#test/support/plans.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
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

const World = schema(
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

const RELATIONS: Arr.NonEmptyReadonlyArray<string> = [
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
interface Sketch {
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

const sketchGen: Gen<Sketch> = (source) => {
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

type Feature = `${Program} with its units ${Fate}`

const featureOf = (s: Sketch): Feature => `${s.program} with its units ${s.fate}`

const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
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
const unitFacts = (units: ReadonlyArray<Unit>) => ({
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

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The relations a plan's nodes modify. */
const modified = (plan: Plan): ReadonlyArray<string> => [
	...(plan.node === "ModifyTable" && plan.on.kind === "relation" ? [plan.on.relation] : []),
	...Arr.flatMap(plan.children, modified)
]

/** Every relation among `written` a node of `plan` reads by a sequential scan. */
const seqScans = (plan: Plan, written: ReadonlySet<string>): ReadonlyArray<string> => [
	...(plan.node === "Seq Scan" && plan.on.kind === "relation" && written.has(plan.on.relation)
		? [plan.on.relation]
		: []),
	...Arr.flatMap(plan.children, (child) => seqScans(child, written))
]

layer(Substrate.layer, { excludeTestServices: true })(
	"a write statement reads the relations it writes only through a key it binds, on PostgreSQL 19rc2",
	(it) => {
		it.effect(
			"plan no statement of a unit's replace or delete or of its ledger's rewrite with a sequential scan of a relation it modifies",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const o = yield* installed(World, {}, { label: "keyed_target", programs })
						const seat = yield* seatOfInstalled(o.installed, RELATIONS, "keyed_target")
						const login = quoteIdent(o.installed.as(o.server).role)
						for (const setting of judgedSettings) {
							yield* substrate.superuser(
								`ALTER ROLE ${login} IN DATABASE ${quoteIdent(substrate.database)} SET ${setting.parameter} = ${setting.value}`
							)
						}
						yield* unanalyzed(
							substrate.admin,
							Arr.map(RELATIONS, (r) => o.installed.names.relation(r))
						)
						const body = Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							const stored = (s: Sketch): ReadonlyArray<Unit> =>
								upTo(s.units, (i) => ({ key: BigInt(i), label: BigInt(10 * i + 1), size: s.size }))
							/** The instance of `s` over emptied tables. */
							const loaded = (s: Sketch) =>
								Effect.gen(function* () {
									yield* cleared(seat, RELATIONS)
									const units = stored(s)
									yield* db.workload.load.once({
										params: {},
										facts: {
											insert: {
												...unitFacts(units),
												Pub: Arr.flatMap(units, (u) =>
													Arr.map(
														upTo(u.size, (j) => j),
														(j) => ({ pkg: u.key, item: BigInt(j) })
													)
												)
											}
										}
									})
								})
							const plansOf = (s: Sketch) => {
								const unit = Arr.filter(stored(s), (u) => u.key === BigInt(s.at))
								const added = unitFacts(
									s.fate === "deleted"
										? []
										: s.fate === "replaced unchanged"
											? unit
											: Arr.map(unit, (u) => ({ ...u, label: u.label + 1n, size: u.size + 1 }))
								)
								const at = BigInt(s.at)
								switch (s.program) {
									case "replace":
										return db.workload.replace.explain({
											params: {},
											facts: {
												delete: {
													Node: [{ doc: at }],
													Shelf: Arr.map(unit, (u) => ({ id: u.key, note: u.label })),
													Test: Arr.map(unit, (u) => ({ t: u.key, note: u.label })),
													Asm: Arr.map(unit, (u) => ({ a: u.key, note: u.label }))
												},
												insert: added
											}
										})
									case "replace by query":
										return db.workload.replaceByQuery.explain({
											params: { doc: at, shelf: at, test: at, asm: at },
											facts: { insert: added }
										})
									case "prune":
										return db.workload.prune.explain({
											params: { pkg: at, kept: [{ item: 0n }] },
											facts: {}
										})
									case "republish":
										return db.workload.republish.explain({
											params: { pkg: at },
											facts: { insert: { Pub: [{ pkg: at, item: 0n }] } }
										})
									case "lead":
										return db.workload.lead.explain({
											params: {},
											facts: { insert: { Lead: [{ id: at, pkg: at, leads: true }] } }
										})
								}
							}
							return yield* exhaust(
								{
									suite: "pg/write/keyed-target",
									generator: sketchGen,
									literal: Formatter.format,
									box: "one or two units of each kind, each of one or two nodes, books, tags, instances and ledger items, and a call at one of them: its units deleted, replaced unchanged or replaced changed, named by facts or by a query, or its ledger pruned or republished, or a lead inserted",
									oracle: {
										kind: "postgresql",
										name: "EXPLAIN of each statement the member sends, sequential, index and index-only scans disabled over unanalyzed relations: no sequential scan of a relation the statement modifies"
									},
									coverage: requiredInSpace<Feature>(FEATURES),
									caseHang,
									concurrency: 1
								},
								(s, c) =>
									Effect.gen(function* () {
										yield* loaded(s)
										const plans = yield* plansOf(s)
										const scans = Arr.flatMap(plans, (p) =>
											Arr.map(
												seqScans(p.plan, new Set(modified(p.plan))),
												(relation) => `${p.statement}: ${relation}`
											)
										)
										if (scans.length > 0) {
											return yield* new Disagreed({
												message: `${featureOf(s)} reads a relation it writes by a sequential scan: ${Arr.join(scans, "; ")}: ${Formatter.format(s)}`
											})
										}
										c.note(featureOf(s))
									})
							)
						})
						return yield* Effect.flatMap(Layer.build(o.served.layer), (context) =>
							Effect.provideContext(body, context)
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
