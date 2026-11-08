/**
 * Adding a family to stored relations (rows-first §6), generated: the drafted migration's backfill data step draws every
 * value the family holds over the stored rows, after every column's ADD COLUMN under its placeholder default and before
 * any constraint reads them, and VALIDATE then proves it.
 *
 * - **The cases:** a counted family, an ordered one keyed by its member key or by its owner and index, a tree, a concat
 *   fold over an ordered family, and a family whose members the migration creates; over one to three owners and the
 *   members drawn for them, keyed apart, stored in a drawn order, their steps across negatives, zero and positives, so
 *   the backfill meets empty families, families of one and longer predecessor chains; forests of one or more trees whose
 *   children are keyed apart from the order they were stored and drawn in; pieces of text beyond ASCII and empty ones.
 * - **Counted and ordered:** each member's hidden index, ‹i› = row_number() OVER (PARTITION BY g ORDER BY its key) − 1,
 *   its copy of the count, and a sum fold's before and after as running sums in ‹i› order; the owner's count and end;
 *   each copy an axis carries its target's value: an owner's, a predecessor's (the base at the first slot), a last
 *   member's (the base for an empty family).
 * - **Tree:** each row's slot by its key among its siblings, its count, its parent's count and start, and its pre-order
 *   interval; a count fold over each row's siblings; a parent row's copy (the root its own), a copy of a copy after the
 *   copy it reads.
 * - **Concat:** each member's running text over its family in slot order, its before its predecessor's after, the empty
 *   text at slot 0, the owner's end its last member's after.
 * - **Reversals:** removing a family drops its law columns and natives, and its fields as declared, keeping every row; a
 *   field its caller wrote that the target draws is drawn anew over the caller's values; one the target leaves to its
 *   caller keeps its drawn values.
 * - **Reshaped:** a family drawn over stored rows that a later migration renames, declared: its owner relation, its count
 *   or both, which name its law columns (counted; ordered over hidden accumulators; ordered over named ones); or whose
 *   kind it changes, counted to ordered over a new drawn index, or ordered to counted, its index left to its caller
 *   with the values drawn; or whose fold over named accumulators it moves into a new owner field, the old end dropped or
 *   left to its caller. Every value the family holds after it is the reference's over the stored rows in key order, as
 *   it was drawn.
 *
 * - **The judge:** the catalog model of PostgreSQL (test/support/migrate/interpret.ts) runs the drafted migration
 *   statement by statement over the stored rows, and its catalog afterwards must be the target's installed from
 *   nothing; NP's reference fold (test/support/families/fold.ts) of each owner's members in key order, NP's pre-order
 *   numbering of each tree (test/support/families/tree.ts) with each node's children in key order, and a naive left
 *   fold of each owner's pieces state every drawn value.
 */
import { describe, it } from "@effect/vitest"
import { drawn as generated, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	constant,
	element,
	type Gen,
	int as between,
	map,
	oneOf,
	shuffled,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import type { Declarations, Rename, Step as PlanStep } from "#compiler/deploy/diff/plan.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { SlotsDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	contained,
	counted,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	pred,
	relation,
	schema,
	select,
	tree
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { type FoldMonoid, foldStoredOf } from "#test/support/families/fold.ts"
import { type Node, numbered } from "#test/support/families/tree.ts"
import * as Desc from "#test/support/fixtures/ir/desc.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type Cell,
	catalogOf,
	installState,
	interpret,
	load,
	type State
} from "#test/support/migrate/interpret.ts"
import {
	asDrafted,
	compile,
	type DeploySubject,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { plainPlan } from "#test/support/migrate/review.ts"

/** A migration from `before` to `after`: both installations, compiled as `grizzle generate` drafts them, and both
 * drafts, the first from nothing, or, for a successor (successorOf), from the migration before it. */
interface Migration {
	readonly before: DeploySubject
	readonly after: DeploySubject
	readonly first: Installation
	readonly firstDraft: GenerateResult
	readonly second: Installation
	readonly secondDraft: GenerateResult
}

const migrationOf = (before: DeploySubject, after: DeploySubject): Migration => {
	const first = compile(before, asDrafted)
	const firstDraft = succeeded(
		generate({
			installation: first,
			timestamp: draftedAt(1),
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations,
			name: "first"
		})
	)
	const second = compile(after, asDrafted)
	const secondDraft = succeeded(
		generate({
			installation: second,
			timestamp: draftedAt(2),
			previous: fromSnapshot(firstDraft.snapshot),
			workload: noWorkload,
			declared: noDeclarations,
			name: "second"
		})
	)
	return { before, after, first, firstDraft, second, secondDraft }
}

/** The migration that takes `m`'s target to `to` under `declared`, drafted from the snapshot `m` leaves. */
const successorOf = (m: Migration, to: DeploySubject, declared: Declarations): Migration => {
	const second = compile(to, asDrafted)
	return {
		before: m.after,
		after: to,
		first: m.second,
		firstDraft: m.secondDraft,
		second,
		secondDraft: succeeded(
			generate({
				installation: second,
				timestamp: draftedAt(3),
				previous: fromSnapshot(m.secondDraft.snapshot),
				workload: noWorkload,
				declared,
				name: "third"
			})
		)
	}
}

/** The declarations of dropping `drops`, each a relation and a field of it. */
const droppedFields = (drops: ReadonlyArray<readonly [string, string]>): Declarations => ({
	renames: [],
	drops: Arr.map(drops, ([relation, field]) => ({
		kind: "field",
		relation: parsedName(relation),
		field: parsedName(field)
	}))
})

/** The table a stored relation of an installation is installed as. */
const tableOf = (i: Installation, relation: string): string => {
	const r = i.laws.theory.relations[relation]
	assert.ok(r?.kind === "relation", `${relation} is a stored relation`)
	return r.ident
}

/** The column a field of a relation is installed as. */
const fieldColumn = (i: Installation, relation: string, field: string): string => {
	const r = i.laws.theory.relations[relation]
	return defined(Option.getOrUndefined(Arr.findFirst(r?.fields ?? [], (f) => f.name === field)))
		.column
}

/** The installed column of a family's native column. */
const columnOf = (c: NativeColumn): string => (c.kind === "field" ? c.field.column : c.column)

const int = (value: number): TypedLiteral => ({ kind: "int", value: BigInt(value) })

/** The model state of a snapshot's objects installed from nothing. */
const freshState = (schemaName: string, draft: GenerateResult): State => {
	const state = installState(
		schemaName,
		Arr.flatMap(draft.snapshot.manifest.objects, (o) => o.ddl)
	)
	assert.ok(Result.isSuccess(state), "the snapshot installs on the model")
	return state.success
}

/** Stored rows of a relation of the first schema, each a value per field. */
interface Rows {
	readonly relation: string
	readonly rows: ReadonlyArray<Readonly<Record<string, number>>>
}

/** What `m`'s second draft leaves on the model when it runs over `state`. */
const continued = (m: Migration, state: State): State => {
	const run = interpret(m.second.names.schema, state, plainPlan(m.secondDraft), (p) => {
		throw new Error(`the migration asks no placeholder, but drafted a ${p.kind}`)
	})
	if (Result.isFailure(run)) {
		throw new Error(
			`the migration fails on the model: ${run.failure.file} #${run.failure.action}, ${run.failure.reason}`
		)
	}
	return run.success
}

/** What the second draft leaves on the model after the first is installed and `stored` loaded in order. */
const migrated = (m: Migration, stored: ReadonlyArray<Rows>): State =>
	continued(
		m,
		Arr.reduce(stored, freshState(m.first.names.schema, m.firstDraft), (state, r) =>
			load(
				state,
				tableOf(m.first, r.relation),
				Arr.map(
					r.rows,
					(row) =>
						new Map(
							Arr.map(
								Rec.toEntries(row),
								([field, value]) => [fieldColumn(m.first, r.relation, field), int(value)] as const
							)
						)
				)
			)
		)
	)

/** An integer cell of a model row, by column. */
const intCell = (row: ReadonlyMap<string, Cell>, column: string): bigint => {
	const cell = row.get(column)
	assert.ok(cell?.kind === "value" && cell.value.kind === "int", `${column} holds an integer`)
	return cell.value.value
}

/** Each row of a relation the model holds, as `text` reads it, sorted. */
const rowsOf = (
	m: Migration,
	state: State,
	relation: string,
	text: (cell: (column: string) => bigint) => string
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(defined(state.tables.get(tableOf(m.second, relation))).rows, (row) =>
			text((column) => intCell(row, column))
		),
		Order.String
	)

const SUM: FoldMonoid = { name: "sum", least: 0n }

/** The text a folded member reads as: its key, slot, copy, before and after. */
const memberText = (
	member: bigint | number,
	at: bigint | number,
	copy: bigint | number,
	before: bigint,
	after: bigint
): string => `${member}@${at}/${copy} ${before}→${after}`

/** One stored member: its key, its owner and its step. */
interface Stored {
	readonly key: number
	readonly owner: number
	readonly x: number
}

/** Each stored owner's tag, which a copy along the owner axis carries onto its members. */
const tagOf = (owner: number): number => 100 + owner

/** The stored members of `owner` in key order. */
const ownedBy = (stored: ReadonlyArray<Stored>, owner: number): ReadonlyArray<Stored> =>
	Arr.sort(
		Arr.filter(stored, (m) => m.owner === owner),
		Order.mapInput(Order.Number, (m: Stored) => m.key)
	)

/** The stored member keyed `key`. */
const memberOf = (stored: ReadonlyArray<Stored>, key: number): Stored =>
	defined(Option.getOrUndefined(Arr.findFirst(stored, (m) => m.key === key)))

/**
 * A copy a fold case's family carries, and the value the reference says it holds (rows-first §6 as amended): its
 * axis target's value, or its base where the axis names no row. `on` is the relation it fills, a member by its key or
 * an owner by its id.
 */
interface CopyCheck {
	readonly on: "member" | "owner"
	readonly field: string
	readonly value: (stored: ReadonlyArray<Stored>, row: number) => number
}

/** The text a copy reads as on one row. */
const copyText = (field: string, row: bigint | number, value: bigint | number): string =>
	`${field}(${row})=${value}`

/** What the reference says a fold case's copies hold, on every stored member and owner. */
const copiesExpected = (
	c: FoldCase,
	owners: ReadonlyArray<number>,
	stored: ReadonlyArray<Stored>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(c.copies, (k) =>
			Arr.map(k.on === "member" ? Arr.map(stored, (m) => m.key) : owners, (row) =>
				copyText(k.field, row, k.value(stored, row))
			)
		),
		Order.String
	)

/** What the migrated model holds of a fold case's copies. */
const copiesObserved = (c: FoldCase, state: State): ReadonlyArray<string> => {
	const second = c.migration.second
	return Arr.sort(
		Arr.flatMap(c.copies, (k) => {
			const relation = k.on === "member" ? c.member : c.owner
			const key = k.on === "member" ? c.key : "id"
			return rowsOf(c.migration, state, relation, (cell) =>
				copyText(
					k.field,
					cell(fieldColumn(second, relation, key)),
					cell(fieldColumn(second, relation, k.field))
				)
			)
		}),
		Order.String
	)
}

/** What the reference fold says a fold family leaves: each owner's members in key order, folded from the identity. */
const foldExpected = (owners: ReadonlyArray<number>, stored: ReadonlyArray<Stored>) => {
	const reference = foldStoredOf(
		SUM,
		Arr.map(owners, (owner) => ({
			owner,
			members: Arr.map(
				Arr.sort(
					Arr.filter(stored, (m) => m.owner === owner),
					Order.mapInput(Order.Number, (m: Stored) => m.key)
				),
				(m) => ({ member: m.key, x: BigInt(m.x), selected: true })
			)
		}))
	)
	return {
		members: Arr.sort(
			Arr.map(reference.rows, (r) =>
				memberText(r.member, r.at, r.copy, Arr.headNonEmpty(r.before), Arr.headNonEmpty(r.after))
			),
			Order.String
		),
		owners: Arr.sort(
			Arr.map(reference.owners, (o) => `${o.owner}: ${o.count} ${Arr.headNonEmpty(o.end)}`),
			Order.String
		)
	}
}

/** A fold family's schemas and how its rows are named: the owner relation and its key, the member relation, its
 * key, its group and its step. */
interface FoldCase {
	readonly migration: Migration
	readonly owner: string
	readonly member: string
	readonly key: string
	readonly group: string
	readonly step: string
	readonly copies: ReadonlyArray<CopyCheck>
}

/** The stored rows of a fold case: every owner, then its members in `stored`'s order. */
const foldRows = (
	c: FoldCase,
	owners: ReadonlyArray<number>,
	stored: ReadonlyArray<Stored>
): ReadonlyArray<Rows> => [
	{ relation: c.owner, rows: Arr.map(owners, (id) => ({ id, tag: tagOf(id) })) },
	{
		relation: c.member,
		rows: Arr.map(stored, (m) => ({ [c.key]: m.key, [c.group]: m.owner, [c.step]: m.x }))
	}
]

/** What the migrated model holds of a fold family: each member's drawn values, each owner's count and end. */
const foldObserved = (c: FoldCase, state: State) => {
	const second = c.migration.second
	const family: Family = defined(second.laws.families[0])
	const plane = defined(defined(family.folds[0]).planes[0])
	return {
		members: rowsOf(c.migration, state, c.member, (cell) =>
			memberText(
				cell(fieldColumn(second, c.member, c.key)),
				cell(columnOf(family.index)),
				cell(family.copy),
				cell(columnOf(plane.before)),
				cell(columnOf(plane.after))
			)
		),
		owners: rowsOf(
			c.migration,
			state,
			c.owner,
			(cell) =>
				`${cell(fieldColumn(second, c.owner, "id"))}: ${cell(family.count.column)} ${cell(plane.end.column)}`
		)
	}
}

/** The counted case's schemas: before, an owner with its tag and members naming it; after, the members counted per
 * owner in n, their x summed into its end, and its tag copied onto each member along the owner axis. */
const countedBefore = schema(
	"Backfill",
	{
		Owner: relation("Owner", { id: pg.int4, tag: pg.int4 }, ["id"]),
		Member: relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
	},
	[]
)
const countedAfter = (() => {
	const Owner = relation(
		"Owner",
		{ id: pg.int4, tag: pg.int4, n: drawn(natural), end: accumulated(pg.int4, 0) },
		["id"]
	)
	const Member = relation(
		"Member",
		{ member: pg.int4, g: pg.int4, x: pg.int4, ownerTag: accumulated(pg.int4, 0) },
		["member"]
	)
	const family = counted(on(Member, "g"), fin(Owner, "n"))
	return schema("Backfill", { Owner, Member }, [
		family,
		fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end")),
		contained(on(Member, "g", "ownerTag"), on(Owner, "id", "tag"))
	])
})()

/** How the counted case's rows are named, and its one copy: each member's owner's tag. */
const countedNames: Omit<FoldCase, "migration"> = {
	owner: "Owner",
	member: "Member",
	key: "member",
	group: "g",
	step: "x",
	copies: [
		{ on: "member", field: "ownerTag", value: (stored, key) => tagOf(memberOf(stored, key).owner) }
	]
}

/** A counted family of Member per Owner, its x summed into the owner's end, its tag copied onto each member. */
const countedCase: FoldCase = {
	migration: migrationOf(countedBefore, countedAfter),
	...countedNames
}

/** The counted case's relations with every field its family draws, accumulates or copies left to its caller, each of
 * the type it was drawn as. */
const countedWritten = schema(
	"Backfill",
	{
		Owner: relation("Owner", { id: pg.int4, tag: pg.int4, n: natural, end: pg.int4 }, ["id"]),
		Member: relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4, ownerTag: pg.int4 }, [
			"member"
		])
	},
	[]
)

/** How an ordered case's lines are keyed after the migration: by line, as they were, or by their order and index. */
type LineKey = "line" | "order and index"

/** The counted case's family over members the migration creates, its owners stored before it. */
const newMembers: Migration = (() => {
	const name = "Backfill"
	const Owner = relation(
		"Owner",
		{ id: pg.int4, n: drawn(natural), end: accumulated(pg.int4, 0) },
		["id"]
	)
	const Member = relation("Member", { member: pg.int4, g: pg.int4, x: pg.int4 }, ["member"])
	const family = counted(on(Member, "g"), fin(Owner, "n"))
	return migrationOf(
		schema(name, { Owner: relation("Owner", { id: pg.int4 }, ["id"]) }, []),
		schema(name, { Owner, Member }, [
			family,
			fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end"))
		])
	)
})()

/** An ordered family of Line per Order, its qty summed into the order's total; keyed as `key` says after the
 * migration, the stored lines keyed by line before it. */
const orderedCase = (key: LineKey): FoldCase => {
	const name = "Ordering"
	const Order_ = relation(
		"Order",
		{
			id: pg.int4,
			tag: pg.int4,
			n: drawn(natural),
			total: accumulated(pg.int4, 0),
			lastQty: accumulated(pg.int4, -1)
		},
		["id"]
	)
	const fields = {
		line: pg.int4,
		order: pg.int4,
		at: drawn(natural),
		qty: pg.int4,
		orderTag: accumulated(pg.int4, 0),
		prevQty: accumulated(pg.int4, -1)
	}
	const Line =
		key === "line" ? relation("Line", fields, ["line"]) : relation("Line", fields, ["order", "at"])
	const family = ordered(on(Line, "order", "at"), fin(Order_, "n"))
	return {
		migration: migrationOf(
			schema(
				name,
				{
					Order: relation("Order", { id: pg.int4, tag: pg.int4 }, ["id"]),
					Line: relation("Line", { line: pg.int4, order: pg.int4, qty: pg.int4 }, ["line"])
				},
				[]
			),
			schema(name, { Order: Order_, Line }, [
				family,
				fold(family, Monoid.sum, on(Line, "order", "qty"), on(Order_, "id", "total")),
				contained(on(Line, "order", "orderTag"), on(Order_, "id", "tag")),
				contained(on(Line, "order", pred("at"), "prevQty"), on(Line, "order", "at", "qty")),
				contained(on(Order_, "id", pred("n"), "lastQty"), on(Line, "order", "at", "qty"))
			])
		),
		owner: "Order",
		member: "Line",
		key: "line",
		group: "order",
		step: "qty",
		copies: [
			{
				on: "member",
				field: "orderTag",
				value: (stored, line) => tagOf(memberOf(stored, line).owner)
			},
			{
				on: "member",
				field: "prevQty",
				value: (stored, line) => {
					const lines = ownedBy(stored, memberOf(stored, line).owner)
					const at = Arr.findFirstIndex(lines, (m) => m.key === line)
					return Option.match(at, {
						onNone: () => -1,
						onSome: (i) => (i === 0 ? -1 : Arr.getUnsafe(lines, i - 1).x)
					})
				}
			},
			{
				on: "owner",
				field: "lastQty",
				value: (stored, order) =>
					Option.match(Arr.last(ownedBy(stored, order)), {
						onNone: () => -1,
						onSome: (m) => m.x
					})
			}
		]
	}
}

/**
 * A tree of Node over its parent, one per doc, as NP's fold suite holds it (test/pg/fin/fold.test.ts FoldedTree):
 * folded by count over each node's children, its accumulators named; with each node's parent's kind copied along the
 * owner axis, and that copy copied again one level down, a copy of a copy; each node's previous sibling's kind along
 * the predecessor axis, and its last child's along the last, each -1 where its axis names no row.
 */
const treeMigration: Migration = (() => {
	const name = "Forest"
	const Node_ = relation(
		"Node",
		{
			id: pg.int4,
			parent: pg.int4,
			at: drawn(natural),
			children: drawn(natural),
			start: drawn(natural),
			end: drawn(natural),
			doc: pg.int4,
			kind: pg.int4,
			parentKind: accumulated(pg.int4, 0),
			grandKind: accumulated(pg.int4, 0),
			prevKind: accumulated(pg.int4, -1),
			lastKind: accumulated(pg.int4, -1),
			before: accumulated(natural, 0n),
			after: accumulated(natural, 0n),
			total: accumulated(natural, 0n)
		},
		["id"]
	)
	const members = select(Node_, (n) => n.gt(n.start, 0n))
	const t = tree(on(Node_, "parent", "at"), fin(Node_, "children"), { root: "doc" })
	return migrationOf(
		schema(
			name,
			{
				Node: relation("Node", { id: pg.int4, parent: pg.int4, doc: pg.int4, kind: pg.int4 }, [
					"id"
				])
			},
			[]
		),
		schema(name, { Node: Node_ }, [
			t,
			fold(t, Monoid.count, on(Node_, "parent", "before", "after"), on(Node_, "id", "total")),
			contained(on(members, "parent", "parentKind"), on(Node_, "id", "kind")),
			contained(on(members, "parent", "grandKind"), on(Node_, "id", "parentKind")),
			contained(on(members, "parent", pred("at"), "prevKind"), on(members, "parent", "at", "kind")),
			contained(on(Node_, "id", pred("children"), "lastKind"), on(members, "parent", "at", "kind"))
		])
	)
})()

/** A stored forest: each node's key, its parent's (a root's its own), its tree's root key as its doc, and its kind. */
type StoredNode = {
	readonly id: number
	readonly parent: number
	readonly doc: number
	readonly kind: number
}

/** The text a tree row reads as: its key, slot, count, interval, parent's count and start, its parent's kind and its
 * parent's parent kind, and its count fold's before, after and total. */
const treeText = (row: ReadonlyArray<bigint | number>): string =>
	Arr.join(Arr.map(row, String), " ")

/**
 * What the references say a stored forest's backfill leaves: NP's numbering, each node's children in key order; each
 * copy its parent row's value, the root its own; and NP's lawful count fold, `before = at, after = at + 1, total =
 * children`, the root's the one state its pins admit.
 */
const treeExpected = (stored: ReadonlyArray<StoredNode>): ReadonlyArray<string> => {
	const nodeOf = (id: number): Node => ({
		id,
		children: Arr.map(
			Arr.sort(
				Arr.filter(stored, (n) => n.parent === id && n.id !== id),
				Order.mapInput(Order.Number, (n: StoredNode) => n.id)
			),
			(n) => nodeOf(n.id)
		)
	})
	const byId = (id: number): StoredNode =>
		defined(Option.getOrUndefined(Arr.findFirst(stored, (n) => n.id === id)))
	const parentKind = (id: number): number => byId(byId(id).parent).kind
	/** A node's children in key order: its slot order. */
	const childrenOf = (id: number): ReadonlyArray<StoredNode> =>
		Arr.sort(
			Arr.filter(stored, (n) => n.parent === id && n.id !== id),
			Order.mapInput(Order.Number, (n: StoredNode) => n.id)
		)
	const prevKind = (id: number): number => {
		const n = byId(id)
		const siblings = n.parent === n.id ? [] : childrenOf(n.parent)
		const at = Arr.findFirstIndex(siblings, (x) => x.id === id)
		return Option.match(at, {
			onNone: () => -1,
			onSome: (i) => (i === 0 ? -1 : Arr.getUnsafe(siblings, i - 1).kind)
		})
	}
	const lastKind = (id: number): number =>
		Option.match(Arr.last(childrenOf(id)), { onNone: () => -1, onSome: (c) => c.kind })
	const roots = Arr.sort(
		Arr.filter(stored, (n) => n.parent === n.id),
		Order.mapInput(Order.Number, (n: StoredNode) => n.doc)
	)
	return Arr.sort(
		Arr.map(numbered(Arr.map(roots, (r) => ({ root: r.doc, tree: nodeOf(r.id) }))), (r) =>
			treeText([
				r.id,
				r.at,
				r.children,
				r.start,
				r.end,
				r.copy,
				r.parentStart,
				parentKind(r.id),
				parentKind(byId(r.id).parent),
				prevKind(r.id),
				lastKind(r.id),
				r.at,
				r.at + 1,
				r.children
			])
		),
		Order.String
	)
}

/** What the migrated model holds of the tree. */
const treeObserved = (state: State): ReadonlyArray<string> => {
	const second = treeMigration.second
	const family: Family = defined(second.laws.families[0])
	assert.ok(family.members.kind === "tree", "the family is a tree")
	const shape = family.members
	const field = (name: string): string => fieldColumn(second, "Node", name)
	return rowsOf(treeMigration, state, "Node", (cell) =>
		treeText([
			cell(field("id")),
			cell(columnOf(family.index)),
			cell(family.count.column),
			cell(shape.start.column),
			cell(shape.end.column),
			cell(family.copy),
			cell(shape.parentStart),
			cell(field("parentKind")),
			cell(field("grandKind")),
			cell(field("prevKind")),
			cell(field("lastKind")),
			cell(field("before")),
			cell(field("after")),
			cell(field("total"))
		])
	)
}

/** The slots of the plan's steps whose statement `matches`, in plan order. */
const slotsOf = (
	steps: ReadonlyArray<PlanStep>,
	matches: (s: SqlStatement) => boolean
): ReadonlyArray<string> =>
	Arr.flatMap(steps, (s) =>
		s.draft.kind === "statement" && matches(s.draft.statement) ? [s.slot] : []
	)

const addsDefault = (s: SqlStatement): boolean =>
	s.kind === "alterTable" && Arr.some(s.actions, (a) => a.kind === "addColumnDefault")
const dropsDefault = (s: SqlStatement): boolean =>
	s.kind === "alterTable" && Arr.some(s.actions, (a) => a.kind === "dropDefault")
const addsConstraint = (s: SqlStatement): boolean =>
	s.kind === "alterTable" && Arr.some(s.actions, (a) => a.kind === "addConstraint")

/** The statements of the plan's steps, in plan order. */
const statementsOf = (steps: ReadonlyArray<PlanStep>): ReadonlyArray<SqlStatement> =>
	Arr.flatMap(steps, (s) => (s.draft.kind === "statement" ? [s.draft.statement] : []))

/** The columns the plan adds under a placeholder default, or drops the default of, sorted. */
const defaultColumns = (
	steps: ReadonlyArray<PlanStep>,
	kind: "addColumnDefault" | "dropDefault"
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(statementsOf(steps), (s) =>
			s.kind === "alterTable"
				? Arr.flatMap(s.actions, (a) =>
						a.kind === "addColumnDefault" && kind === "addColumnDefault"
							? [a.column.name]
							: a.kind === "dropDefault" && kind === "dropDefault"
								? [a.column]
								: []
					)
				: []
		),
		Order.String
	)

/** The drawn columns of a fold family: its index, copy, count, its plane's before, after and end, and its copies. */
const foldColumns = (c: FoldCase): ReadonlyArray<string> => {
	const second = c.migration.second
	const family: Family = defined(second.laws.families[0])
	const plane = defined(defined(family.folds[0]).planes[0])
	return Arr.sort(
		[
			columnOf(family.index),
			family.copy,
			columnOf(plane.before),
			columnOf(plane.after),
			family.count.column,
			plane.end.column,
			...Arr.map(c.copies, (k) =>
				fieldColumn(second, k.on === "member" ? c.member : c.owner, k.field)
			)
		],
		Order.String
	)
}

/** The plan's order of a backfill: every drawn column added under its placeholder in Structure, no placeholder asked
 * of the reviewer, every UPDATE and every DROP DEFAULT in structure.backfill, and every constraint after. */
const assertBackfillOrder = (m: Migration, columns: ReadonlyArray<string>): void => {
	const steps = m.secondDraft.plan.steps
	assert.ok(
		!Arr.some(steps, (s) => s.draft.kind === "placeholderColumn"),
		"no drawn or accumulated field asks the reviewer for a value"
	)
	assert.deepEqual(
		defaultColumns(steps, "addColumnDefault"),
		columns,
		"each drawn column is added under its placeholder"
	)
	assert.deepEqual(
		defaultColumns(steps, "dropDefault"),
		columns,
		"each placeholder default is dropped"
	)
	assert.ok(Arr.every(slotsOf(steps, addsDefault), (slot) => slot === "structure"))
	assert.ok(
		Arr.every(
			slotsOf(steps, (s) => s.kind === "update"),
			(slot) => slot === "structure.backfill"
		),
		"the backfill's UPDATEs run in its own slot"
	)
	assert.ok(
		Arr.every(slotsOf(steps, dropsDefault), (slot) => slot === "structure.backfill"),
		"each default is dropped once its column is drawn"
	)
	const order: ReadonlyArray<string> = Arr.map(steps, (s) => s.slot)
	assert.ok(
		order.lastIndexOf("structure") < order.indexOf("structure.backfill") &&
			order.lastIndexOf("structure.backfill") < order.indexOf("structure.constraints"),
		"the backfill runs after every ADD COLUMN and before every constraint"
	)
	assert.ok(
		Arr.every(slotsOf(steps, addsConstraint), (slot) => slot !== "structure"),
		"no constraint is added before the backfill"
	)
}

/** The ordered families, by how their lines are keyed after the migration. */
const orderedByLine = orderedCase("line")
const orderedByIndex = orderedCase("order and index")

/** The tree's drawn columns: its index, count, copy, interval, parent's start, and every accumulated or copied field. */
const treeColumns = (): ReadonlyArray<string> => {
	const second = treeMigration.second
	const family: Family = defined(second.laws.families[0])
	assert.ok(family.members.kind === "tree", "the family is a tree")
	return Arr.sort(
		[
			columnOf(family.index),
			family.count.column,
			family.copy,
			family.members.start.column,
			family.members.end.column,
			family.members.parentStart,
			...Arr.map(
				["parentKind", "grandKind", "prevKind", "lastKind", "before", "after", "total"],
				(f) => fieldColumn(second, "Node", f)
			)
		],
		Order.String
	)
}

/** Bounded, so the family's axes, which carry each running text, key it within a B-tree entry. */
const joinedText = str.regex("^.{0,64}$", "su")

/** A concat fold over an ordered family of Token per Attr, its pieces' running text in each token's before and after. */
const concatCase: FoldCase = (() => {
	const name = "Joining"
	const Attr = relation(
		"Attr",
		{ id: pg.int4, n: drawn(natural), joined: accumulated(joinedText, "") },
		["id"]
	)
	const Token = relation(
		"Token",
		{
			token: pg.int4,
			attr: pg.int4,
			at: drawn(natural),
			piece: joinedText,
			before: accumulated(joinedText, ""),
			after: accumulated(joinedText, "")
		},
		["token"]
	)
	const family = ordered(on(Token, "attr", "at"), fin(Attr, "n"))
	return {
		migration: migrationOf(
			schema(
				name,
				{
					Attr: relation("Attr", { id: pg.int4 }, ["id"]),
					Token: relation("Token", { token: pg.int4, attr: pg.int4, piece: joinedText }, ["token"])
				},
				[]
			),
			schema(name, { Attr, Token }, [
				family,
				fold(
					family,
					Monoid.concat,
					on(Token, "attr", "piece", "before", "after"),
					on(Attr, "id", "joined")
				)
			])
		),
		owner: "Attr",
		member: "Token",
		key: "token",
		group: "attr",
		step: "piece",
		copies: []
	}
})()

/** A stored token: its key, its owner and its piece. */
interface StoredToken {
	readonly token: number
	readonly attr: number
	readonly piece: string
}

/** A text cell of the model's row, an integer's as its digits. */
const cellText = (row: ReadonlyMap<string, Cell>, column: string): string => {
	const cell = row.get(column)
	if (cell?.kind !== "value") {
		return assert.fail(`${column} holds a value`)
	}
	const v = cell.value
	return v.kind === "text" || v.kind === "int"
		? String(v.value)
		: assert.fail(`${column} holds ${v.kind}`)
}

/** What the naive left fold of each owner's pieces in key order, from the empty text, says the concat leaves. */
const concatExpected = (owners: ReadonlyArray<number>, tokens: ReadonlyArray<StoredToken>) => {
	const rows = Arr.map(owners, (attr) => {
		const mine = Arr.sort(
			Arr.filter(tokens, (t) => t.attr === attr),
			Order.mapInput(Order.Number, (t: StoredToken) => t.token)
		)
		const texts: Array<string> = []
		let end = ""
		for (const [at, t] of mine.entries()) {
			texts.push(`${t.token}@${at} ${end}→${end}${t.piece}`)
			end = `${end}${t.piece}`
		}
		return { tokens: texts, attr: `${attr}: ${mine.length} ${end}` }
	})
	return {
		tokens: Arr.sort(
			Arr.flatMap(rows, (r) => r.tokens),
			Order.String
		),
		attrs: Arr.sort(
			Arr.map(rows, (r) => r.attr),
			Order.String
		)
	}
}

/** What the migrated model holds of the concat family: each token's slot and running texts, each owner's count and end. */
const concatObserved = (state: State) => {
	const second = concatCase.migration.second
	const fam: Family = defined(second.laws.families[0])
	const plane = defined(defined(fam.folds[0]).planes[0])
	const rows = (relation: string) => defined(state.tables.get(tableOf(second, relation))).rows
	return {
		tokens: Arr.sort(
			Arr.map(
				rows("Token"),
				(row) =>
					`${cellText(row, fieldColumn(second, "Token", "token"))}@${cellText(row, columnOf(fam.index))} ${cellText(row, columnOf(plane.before))}→${cellText(row, columnOf(plane.after))}`
			),
			Order.String
		),
		attrs: Arr.sort(
			Arr.map(
				rows("Attr"),
				(row) =>
					`${cellText(row, fieldColumn(second, "Attr", "id"))}: ${cellText(row, fam.count.column)} ${cellText(row, plane.end.column)}`
			),
			Order.String
		)
	}
}

/** The concat case's tokens loaded over its owners, and migrated on the model. */
const concatMigrated = (
	owners: ReadonlyArray<number>,
	tokens: ReadonlyArray<StoredToken>
): State => {
	const m = concatCase.migration
	const textOf = (value: string): TypedLiteral => ({ kind: "text", value })
	return continued(
		m,
		load(
			load(
				freshState(m.first.names.schema, m.firstDraft),
				tableOf(m.first, "Attr"),
				Arr.map(owners, (id) => new Map([[fieldColumn(m.first, "Attr", "id"), int(id)]]))
			),
			tableOf(m.first, "Token"),
			Arr.map(
				tokens,
				(t) =>
					new Map([
						[fieldColumn(m.first, "Token", "token"), int(t.token)],
						[fieldColumn(m.first, "Token", "attr"), int(t.attr)],
						[fieldColumn(m.first, "Token", "piece"), textOf(t.piece)]
					])
			)
		)
	)
}

/** How a version of the reshaped schema declares its family: counted, its index hidden; ordered over the drawn field
 * at; or counted beside at, a field its caller writes, as an ordered family turned counted leaves it. */
type FamilyForm = "counted" | "ordered" | "counted beside at"

/** How a reshaped family folds each member's x into its owner's end, by sum: not at all, over hidden accumulators, or
 * over Member's named before and after, which only an ordered family may name. */
type Accumulators = "none" | "hidden" | "named"

/** The names a reshaped family is declared under: its owner relation's and its count's. */
interface Naming {
	readonly owner: string
	readonly count: string
}

/** The owner's field a reshaped family's fold ends in, and the owner's fields beside it and its count. */
interface Ending {
	readonly end: string
	readonly beside: Readonly<Record<string, Desc.FixtureField>>
}

const reshaping = "Reshaping"
const sumAccumulator = Desc.f.accumulated(Desc.f.integer, 0)

/** Owner and Member before any family: each owner's id and tag, each member's key, its owner g and its step x. */
const unreshaped: Desc.SchemaDesc = {
	name: reshaping,
	relations: [
		Desc.relation("Owner", { id: Desc.f.integer, tag: Desc.f.integer }, ["id"]),
		Desc.relation("Member", { member: Desc.f.integer, g: Desc.f.integer, x: Desc.f.integer }, [
			"member"
		])
	],
	statements: [],
	extends: undefined
}

const indexFields: { readonly [F in FamilyForm]: Readonly<Record<string, Desc.FixtureField>> } = {
	counted: {},
	ordered: { at: Desc.f.drawn },
	"counted beside at": { at: Desc.f.natural }
}

const accumulatorFields: {
	readonly [A in Accumulators]: Readonly<Record<string, Desc.FixtureField>>
} = {
	none: {},
	hidden: {},
	named: { before: sumAccumulator, after: sumAccumulator }
}

/** The family statement of a form over `slots`. */
const familyStatement = (form: FamilyForm, slots: SlotsDesc): Desc.AuthoredStatementDesc =>
	form === "ordered"
		? Desc.ordered(Desc.on("Member", ["g", "at"]), slots)
		: Desc.counted(Desc.on("Member", ["g"]), slots)

/** The sum fold of a reshaped family into its owner's end, as `accumulators` keeps it: its statements, and the end
 * field it adds to the owner. */
const sumFold = (
	accumulators: Accumulators,
	slots: SlotsDesc,
	owner: string,
	end: string
): {
	readonly statements: ReadonlyArray<Desc.AuthoredStatementDesc>
	readonly ends: Readonly<Record<string, Desc.FixtureField>>
} => {
	const into = Desc.on(owner, ["id", end])
	switch (accumulators) {
		case "none":
			return { statements: [], ends: {} }
		case "hidden":
			return {
				statements: [Desc.fold(slots, "sum", Desc.on("Member", ["g", "x"]), into)],
				ends: { [end]: sumAccumulator }
			}
		case "named":
			return {
				statements: [
					Desc.fold(slots, "sum", Desc.on("Member", ["g", "x", "before", "after"]), into)
				],
				ends: { [end]: sumAccumulator }
			}
	}
}

/** The reshaped schema: its family of Member per owner in `form`, folded as `accumulators` says into the owner's end as
 * `ending` places it, its owner relation and its count named as `naming` says. */
const reshapedSchema = (
	form: FamilyForm,
	accumulators: Accumulators,
	naming: Naming,
	ending: Ending
): Desc.SchemaDesc => {
	const slots = Desc.fin(naming.owner, naming.count)
	const folded = sumFold(accumulators, slots, naming.owner, ending.end)
	return {
		name: reshaping,
		relations: [
			Desc.relation(
				naming.owner,
				{
					id: Desc.f.integer,
					tag: Desc.f.integer,
					[naming.count]: Desc.f.drawn,
					...folded.ends,
					...ending.beside
				},
				["id"]
			),
			Desc.relation(
				"Member",
				{
					member: Desc.f.integer,
					g: Desc.f.integer,
					x: Desc.f.integer,
					...indexFields[form],
					...accumulatorFields[accumulators]
				},
				["member"]
			)
		],
		statements: [familyStatement(form, slots), ...folded.statements],
		extends: undefined
	}
}

/** The fold case of a reshaped schema's migration, its owner relation named `owner`. */
const reshapedCase = (migration: Migration, owner: string): FoldCase => ({
	migration,
	owner,
	member: "Member",
	key: "member",
	group: "g",
	step: "x",
	copies: []
})

/** A family drawn over stored rows by one migration and reshaped by the next. */
interface Reshaped {
	readonly drawn: FoldCase
	readonly reshaped: FoldCase
}

/** The families a later migration renames: counted, its accumulators hidden as they must be; ordered over hidden
 * accumulators; and ordered over named ones. */
const renamedFamilies = ["counted", "ordered", "ordered with named accumulators"] as const
type RenamedFamily = (typeof renamedFamilies)[number]

const renamedForms: {
	readonly [R in RenamedFamily]: readonly [FamilyForm, Accumulators]
} = {
	counted: ["counted", "hidden"],
	ordered: ["ordered", "hidden"],
	"ordered with named accumulators": ["ordered", "named"]
}

/** What of a family a later migration renames, declared. */
const renamings = ["its owner", "its count", "its owner and its count"] as const
type Renaming = (typeof renamings)[number]

const declaredNaming: Naming = { owner: "Owner", count: "n" }
const declaredEnding: Ending = { end: "end", beside: {} }

const ownerRenamed: Rename = {
	from: { kind: "relation", relation: parsedName("Owner") },
	to: { kind: "relation", relation: parsedName("Holder") }
}

/** n renamed to size, on the owner relation under its name `owner` after the migration. */
const countRenamed = (owner: string): Rename => ({
	from: { kind: "field", relation: parsedName("Owner"), field: parsedName("n") },
	to: { kind: "field", relation: parsedName(owner), field: parsedName("size") }
})

const renamingsOf: {
	readonly [R in Renaming]: { readonly naming: Naming; readonly renames: ReadonlyArray<Rename> }
} = {
	"its owner": { naming: { owner: "Holder", count: "n" }, renames: [ownerRenamed] },
	"its count": { naming: { owner: "Owner", count: "size" }, renames: [countRenamed("Owner")] },
	"its owner and its count": {
		naming: { owner: "Holder", count: "size" },
		renames: [ownerRenamed, countRenamed("Holder")]
	}
}

/** Each renamed family drawn over stored rows, then renamed each way. */
const renamedCases: {
	readonly [F in RenamedFamily]: { readonly [R in Renaming]: Reshaped }
} = Rec.map(renamedForms, ([form, accumulators]) => {
	const drawnMigration = migrationOf(
		unreshaped,
		reshapedSchema(form, accumulators, declaredNaming, declaredEnding)
	)
	return Rec.map(renamingsOf, ({ naming, renames }) => ({
		drawn: reshapedCase(drawnMigration, declaredNaming.owner),
		reshaped: reshapedCase(
			successorOf(drawnMigration, reshapedSchema(form, accumulators, naming, declaredEnding), {
				renames,
				drops: []
			}),
			naming.owner
		)
	}))
})

/** A family's kind changed by a later migration: counted to ordered over a new drawn index, or ordered to counted, its
 * index left to its caller. A fold over either keeps accumulators the new index would reorder, which the backfill
 * refuses, so these families fold nothing. */
const kindChanges = ["counted to ordered", "ordered to counted"] as const
type KindChange = (typeof kindChanges)[number]

const kindChangeForms: { readonly [K in KindChange]: readonly [FamilyForm, FamilyForm] } = {
	"counted to ordered": ["counted", "ordered"],
	"ordered to counted": ["ordered", "counted beside at"]
}

const kindChanged: { readonly [K in KindChange]: Reshaped } = Rec.map(
	kindChangeForms,
	([from, to]) => {
		const drawnMigration = migrationOf(
			unreshaped,
			reshapedSchema(from, "none", declaredNaming, declaredEnding)
		)
		return {
			drawn: reshapedCase(drawnMigration, declaredNaming.owner),
			reshaped: reshapedCase(
				successorOf(
					drawnMigration,
					reshapedSchema(to, "none", declaredNaming, declaredEnding),
					noDeclarations
				),
				declaredNaming.owner
			)
		}
	}
)

/** Where a later migration moves the end of an ordered family's fold over named accumulators: into the owner's new
 * field total, its old end dropped, declared, or left to its caller with the sums folded into it. */
const endMoves = ["the old end dropped", "the old end left to its caller"] as const
type EndMove = (typeof endMoves)[number]

const endMovesOf: {
	readonly [M in EndMove]: { readonly ending: Ending; readonly declared: Declarations }
} = {
	"the old end dropped": {
		ending: { end: "total", beside: {} },
		declared: droppedFields([["Owner", "end"]])
	},
	"the old end left to its caller": {
		ending: { end: "total", beside: { end: Desc.f.integer } },
		declared: noDeclarations
	}
}

const endMoved: { readonly [M in EndMove]: Reshaped } = (() => {
	const drawnMigration = migrationOf(
		unreshaped,
		reshapedSchema("ordered", "named", declaredNaming, declaredEnding)
	)
	return Rec.map(endMovesOf, ({ ending, declared }) => ({
		drawn: reshapedCase(drawnMigration, declaredNaming.owner),
		reshaped: reshapedCase(
			successorOf(
				drawnMigration,
				reshapedSchema("ordered", "named", declaredNaming, ending),
				declared
			),
			declaredNaming.owner
		)
	}))
})()

/** The text a member of a family with no fold reads as: its key, its slot and its copy of the count. */
const slotText = (member: bigint | number, at: bigint | number, copy: bigint | number): string =>
	`${member}@${at}/${copy}`

/** What a family with no fold holds over the stored rows: each owner's members in key order, numbered from 0, each
 * with its owner's count, and each owner's count. */
const slotsExpected = (owners: ReadonlyArray<number>, stored: ReadonlyArray<Stored>) => ({
	members: Arr.sort(
		Arr.flatMap(owners, (owner) => {
			const mine = ownedBy(stored, owner)
			return Arr.map(mine, (m, at) => slotText(m.key, at, mine.length))
		}),
		Order.String
	),
	owners: Arr.sort(
		Arr.map(owners, (owner) => `${owner}: ${ownedBy(stored, owner).length}`),
		Order.String
	)
})

/** What the migrated model holds of a family with no fold: each member's slot and copy, each owner's count. */
const slotsObserved = (c: FoldCase, state: State) => {
	const target = c.migration.second
	const family: Family = defined(target.laws.families[0])
	return {
		members: rowsOf(c.migration, state, c.member, (cell) =>
			slotText(
				cell(fieldColumn(target, c.member, c.key)),
				cell(columnOf(family.index)),
				cell(family.copy)
			)
		),
		owners: rowsOf(
			c.migration,
			state,
			c.owner,
			(cell) => `${cell(fieldColumn(target, c.owner, "id"))}: ${cell(family.count.column)}`
		)
	}
}

/** Each stored member's key and the value its field at holds after `c`'s migration, the caller's now. */
const callerIndexObserved = (c: FoldCase, state: State): ReadonlyArray<string> =>
	rowsOf(
		c.migration,
		state,
		c.member,
		(cell) =>
			`${cell(fieldColumn(c.migration.second, c.member, c.key))}@${cell(fieldColumn(c.migration.second, c.member, "at"))}`
	)

/** Each stored member's key and its slot among its owner's members in key order, as the family drew it. */
const keyOrderSlots = (
	owners: ReadonlyArray<number>,
	stored: ReadonlyArray<Stored>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(owners, (owner) => Arr.map(ownedBy(stored, owner), (m, at) => `${m.key}@${at}`)),
		Order.String
	)
type Backfill =
	| {
			readonly kind: "fold"
			readonly family: "counted" | "ordered by line" | "ordered by order and index"
			readonly owners: number
			readonly stored: ReadonlyArray<Stored>
	  }
	| { readonly kind: "tree"; readonly stored: ReadonlyArray<StoredNode> }
	| {
			readonly kind: "concat"
			readonly owners: number
			readonly tokens: ReadonlyArray<StoredToken>
	  }
	| { readonly kind: "new members"; readonly owners: number }
	| {
			readonly kind: "renamed"
			readonly family: RenamedFamily
			readonly renaming: Renaming
			readonly owners: number
			readonly stored: ReadonlyArray<Stored>
	  }
	| {
			readonly kind: "kind changed"
			readonly change: KindChange
			readonly owners: number
			readonly stored: ReadonlyArray<Stored>
	  }
	| {
			readonly kind: "end moved"
			readonly move: EndMove
			readonly owners: number
			readonly stored: ReadonlyArray<Stored>
	  }

/** The owners' ids: 0 to `count - 1`, at least one. */
const ownersOf = (count: number): ReadonlyArray<number> => Arr.makeBy(count, (i) => i)

/** Distinct keys in the order the rows are stored: shuffled, so storage never follows key order. */
const keysGen = (size: {
	readonly min: number
	readonly max: number
}): Gen<ReadonlyArray<number>> =>
	shuffled(
		Arr.makeBy(30, (i) => i + 1),
		size
	)

/** Members of `owners` owners, keyed apart and stored in a drawn order, their steps across negatives, zero and positives. */
const membersGen =
	(owners: number): Gen<ReadonlyArray<Stored>> =>
	(source) =>
		Arr.map(source.draw(keysGen({ min: 0, max: 6 })), (key) => ({
			key,
			owner: source.draw(between(0, owners - 1)),
			x: source.draw(
				weighted([
					[1, element([-3, 0, 1])],
					[2, between(-5, 9)]
				])
			)
		}))

/**
 * A forest: each node a root of its own tree, or a child of a node drawn before it, keyed apart from the order its
 * children were drawn in, and stored in a drawn order; a root's parent and doc are its own key, a child's doc its root's.
 */
const forestGen: Gen<ReadonlyArray<StoredNode>> = (source) => {
	const keys = source.draw(keysGen({ min: 1, max: 8 }))
	const none: ReadonlyArray<StoredNode> = []
	const nodes = Arr.reduce(keys, none, (built, id) => {
		const root =
			built.length === 0 ||
			source.draw(
				weighted([
					[1, constant(true)],
					[3, constant(false)]
				])
			)
		if (root) {
			return [...built, { id, parent: id, doc: id, kind: (id * 5) % 7 }]
		}
		const parent = defined(
			built[source.draw(between(0, built.length - 1))],
			"a parent drawn before"
		)
		return [...built, { id, parent: parent.id, doc: parent.doc, kind: (id * 5) % 7 }]
	})
	return source.draw(shuffled(nodes, { min: nodes.length, max: nodes.length }))
}

const pieces = ["", "a", " c", "\u{1F600}", "é"] as const

const backfillGen: Gen<Backfill> = oneOf<Backfill>([
	(source) => {
		const owners = source.draw(between(1, 3))
		return {
			kind: "fold",
			family: source.draw(
				element(["counted", "ordered by line", "ordered by order and index"] as const)
			),
			owners,
			stored: source.draw(membersGen(owners))
		}
	},
	map(forestGen, (stored) => ({ kind: "tree", stored })),
	(source) => {
		const owners = source.draw(between(1, 3))
		return {
			kind: "concat",
			owners,
			tokens: Arr.map(source.draw(keysGen({ min: 0, max: 5 })), (token) => ({
				token,
				attr: source.draw(between(0, owners - 1)),
				piece: source.draw(element(pieces))
			}))
		}
	},
	map(between(1, 3), (owners) => ({ kind: "new members", owners })),
	(source) => {
		const owners = source.draw(between(1, 3))
		return {
			kind: "renamed",
			family: source.draw(element(renamedFamilies)),
			renaming: source.draw(element(renamings)),
			owners,
			stored: source.draw(membersGen(owners))
		}
	},
	(source) => {
		const owners = source.draw(between(1, 3))
		return {
			kind: "kind changed",
			change: source.draw(element(kindChanges)),
			owners,
			stored: source.draw(membersGen(owners))
		}
	},
	(source) => {
		const owners = source.draw(between(1, 3))
		return {
			kind: "end moved",
			move: source.draw(element(endMoves)),
			owners,
			stored: source.draw(membersGen(owners))
		}
	}
])

type BackfillFeature =
	| "counted"
	| "ordered by line"
	| "ordered by order and index"
	| "tree"
	| "concat"
	| "new members"
	| "an owner with no member"
	| "an owner of three members"
	| "members stored out of key order"
	| "a negative step"
	| "a forest of two trees"
	| "a grandchild"
	| "siblings stored out of key order"
	| "a piece beyond ASCII"
	| "an empty piece"
	| `renamed: ${RenamedFamily}`
	| `renamed: ${Renaming}`
	| KindChange
	| `end moved: ${EndMove}`

const notesOf = (b: Backfill): ReadonlyArray<BackfillFeature> => {
	const unsorted = (keys: ReadonlyArray<number>) =>
		Arr.some(keys, (k, i) => i > 0 && k < defined(keys[i - 1], "the key before"))
	const counts = (owners: number, ownerOf: ReadonlyArray<number>) =>
		Arr.map(ownersOf(owners), (o) => Arr.filter(ownerOf, (x) => x === o).length)
	const owned = (
		owners: number,
		ownerOf: ReadonlyArray<number>
	): ReadonlyArray<BackfillFeature> => [
		...(Arr.contains(counts(owners, ownerOf), 0) ? (["an owner with no member"] as const) : []),
		...(Arr.some(counts(owners, ownerOf), (n) => n >= 3)
			? (["an owner of three members"] as const)
			: [])
	]
	const members = (
		owners: number,
		stored: ReadonlyArray<Stored>
	): ReadonlyArray<BackfillFeature> => [
		...owned(
			owners,
			Arr.map(stored, (m) => m.owner)
		),
		...(unsorted(Arr.map(stored, (m) => m.key))
			? (["members stored out of key order"] as const)
			: []),
		...(Arr.some(stored, (m) => m.x < 0) ? (["a negative step"] as const) : [])
	]
	switch (b.kind) {
		case "fold":
			return [b.family, ...members(b.owners, b.stored)]
		case "tree": {
			const byId = (id: number) => Arr.findFirst(b.stored, (n) => n.id === id)
			return [
				"tree",
				...(Arr.filter(b.stored, (n) => n.parent === n.id).length >= 2
					? (["a forest of two trees"] as const)
					: []),
				...(Arr.some(b.stored, (n) => Option.exists(byId(n.parent), (p) => p.parent !== p.id))
					? (["a grandchild"] as const)
					: []),
				...(Arr.some(b.stored, (n) =>
					unsorted(
						Arr.map(
							Arr.filter(b.stored, (x) => x.parent === n.id && x.id !== n.id),
							(x) => x.id
						)
					)
				)
					? (["siblings stored out of key order"] as const)
					: [])
			]
		}
		case "concat":
			return [
				"concat",
				...owned(
					b.owners,
					Arr.map(b.tokens, (t) => t.attr)
				),
				...(Arr.some(b.tokens, (t) => t.piece === "\u{1F600}" || t.piece === "é")
					? (["a piece beyond ASCII"] as const)
					: []),
				...(Arr.some(b.tokens, (t) => t.piece === "") ? (["an empty piece"] as const) : [])
			]
		case "new members":
			return ["new members"]
		case "renamed":
			return [`renamed: ${b.family}`, `renamed: ${b.renaming}`, ...members(b.owners, b.stored)]
		case "kind changed":
			return [b.change, ...members(b.owners, b.stored)]
		case "end moved":
			return [`end moved: ${b.move}`, ...members(b.owners, b.stored)]
	}
}

/** The fold case a fold family names. */
const foldCaseOf = (family: Extract<Backfill, { readonly kind: "fold" }>["family"]): FoldCase => {
	switch (family) {
		case "counted":
			return countedCase
		case "ordered by line":
			return orderedByLine
		case "ordered by order and index":
			return orderedByIndex
	}
}

/** The catalog a migration leaves is the one its target installs from nothing, every constraint validated. */
const assertFresh = (m: Migration, state: State): void =>
	assert.deepEqual(catalogOf(state), catalogOf(freshState(m.second.names.schema, m.secondDraft)))

/** What a folded family drawn over `stored` and then reshaped must hold: the reference fold's values over the stored
 * rows in key order, and the catalog its reshaped target installs from nothing. */
const judgeReshapedFold = (r: Reshaped, owners: number, stored: ReadonlyArray<Stored>): void => {
	const ids = ownersOf(owners)
	const state = continued(
		r.reshaped.migration,
		migrated(r.drawn.migration, foldRows(r.drawn, ids, stored))
	)
	assert.deepEqual(foldObserved(r.reshaped, state), foldExpected(ids, stored))
	assertFresh(r.reshaped.migration, state)
}

/** What a family's backfill must leave, judged against its references, its catalog and its plan's order. */
const judgeBackfill = (b: Backfill): void => {
	switch (b.kind) {
		case "fold": {
			const c = foldCaseOf(b.family)
			const owners = ownersOf(b.owners)
			const state = migrated(c.migration, foldRows(c, owners, b.stored))
			assert.deepEqual(foldObserved(c, state), foldExpected(owners, b.stored))
			assert.deepEqual(copiesObserved(c, state), copiesExpected(c, owners, b.stored))
			assertFresh(c.migration, state)
			assertBackfillOrder(c.migration, foldColumns(c))
			return
		}
		case "tree": {
			const state = migrated(treeMigration, [{ relation: "Node", rows: b.stored }])
			assert.deepEqual(treeObserved(state), treeExpected(b.stored))
			assertFresh(treeMigration, state)
			assertBackfillOrder(treeMigration, treeColumns())
			return
		}
		case "concat": {
			const state = concatMigrated(ownersOf(b.owners), b.tokens)
			assert.deepEqual(concatObserved(state), concatExpected(ownersOf(b.owners), b.tokens))
			assertFresh(concatCase.migration, state)
			assertBackfillOrder(concatCase.migration, foldColumns(concatCase))
			return
		}
		case "new members": {
			const m = newMembers
			const owners = ownersOf(b.owners)
			const state = migrated(m, [{ relation: "Owner", rows: Arr.map(owners, (id) => ({ id })) }])
			const family: Family = defined(m.second.laws.families[0])
			const plane = defined(defined(family.folds[0]).planes[0])
			assert.deepEqual(
				rowsOf(
					m,
					state,
					"Owner",
					(cell) =>
						`${cell(fieldColumn(m.second, "Owner", "id"))}: ${cell(family.count.column)} ${cell(plane.end.column)}`
				),
				Arr.sort(
					Arr.map(owners, (id) => `${id}: 0 0`),
					Order.String
				),
				"every owner keeps the empty family's values"
			)
			assertFresh(m, state)
			return
		}
		case "renamed":
			return judgeReshapedFold(renamedCases[b.family][b.renaming], b.owners, b.stored)
		case "end moved":
			return judgeReshapedFold(endMoved[b.move], b.owners, b.stored)
		case "kind changed": {
			const k = kindChanged[b.change]
			const owners = ownersOf(b.owners)
			const state = continued(
				k.reshaped.migration,
				migrated(k.drawn.migration, foldRows(k.drawn, owners, b.stored))
			)
			assert.deepEqual(slotsObserved(k.reshaped, state), slotsExpected(owners, b.stored))
			if (b.change === "ordered to counted") {
				assert.deepEqual(
					callerIndexObserved(k.reshaped, state),
					keyOrderSlots(owners, b.stored),
					"the index its caller now writes keeps the values the family drew"
				)
			}
			assertFresh(k.reshaped.migration, state)
		}
	}
}

/** The fields a removal drops, as declared: the counted family's drawn and copied ones, or every one the tree draws. */
const countedDrops: ReadonlyArray<readonly [string, string]> = [
	["Owner", "n"],
	["Owner", "end"],
	["Member", "ownerTag"]
]
const treeDrops: ReadonlyArray<readonly [string, string]> = Arr.map(
	[
		"at",
		"children",
		"start",
		"end",
		"parentKind",
		"grandKind",
		"prevKind",
		"lastKind",
		"before",
		"after",
		"total"
	],
	(f) => ["Node", f] as const
)

/** The counted family's relations drawn over a caller's values: each drawn field written first, then drawn anew. */
const toDrawn = migrationOf(countedWritten, countedAfter)

/** What becomes of a family once its rows are drawn: removed, its fields left to the caller, or drawn anew. */
type Reversal =
	| {
			readonly kind: "a counted family removed"
			readonly owners: number
			readonly stored: ReadonlyArray<Stored>
	  }
	| { readonly kind: "a tree removed"; readonly stored: ReadonlyArray<StoredNode> }
	| {
			readonly kind: "left to its caller"
			readonly owners: number
			readonly stored: ReadonlyArray<Stored>
	  }
	| {
			readonly kind: "drawn anew over the caller's values"
			readonly owners: number
			readonly stored: ReadonlyArray<Stored>
			/** The caller's values: each owner's n and end, each member's ownerTag. */
			readonly junk: readonly [n: number, end: number, ownerTag: number]
	  }

const reversalGen: Gen<Reversal> = oneOf<Reversal>([
	(source) => {
		const owners = source.draw(between(1, 3))
		return { kind: "a counted family removed", owners, stored: source.draw(membersGen(owners)) }
	},
	map(forestGen, (stored) => ({ kind: "a tree removed", stored })),
	(source) => {
		const owners = source.draw(between(1, 3))
		return { kind: "left to its caller", owners, stored: source.draw(membersGen(owners)) }
	},
	(source) => {
		const owners = source.draw(between(1, 3))
		return {
			kind: "drawn anew over the caller's values",
			owners,
			stored: source.draw(membersGen(owners)),
			junk: [
				source.draw(between(0, 99)),
				source.draw(between(-9, 99)),
				source.draw(between(-9, 99))
			]
		}
	}
])

/** Each stored row of `rows`'s relation as `fields` read it on the model's state. */
const valuesOf = (m: Migration, state: State, relation: string, fields: ReadonlyArray<string>) =>
	rowsOf(m, state, relation, (cell) =>
		Arr.join(
			Arr.map(fields, (f) => String(cell(fieldColumn(m.first, relation, f)))),
			","
		)
	)

/** A removal run on the model over a migrated state: the catalog the first schema installs, every stored row kept. */
const assertRemoved = (
	m: Migration,
	stored: ReadonlyArray<Rows>,
	drops: ReadonlyArray<readonly [string, string]>
): void => {
	const removed = continued(successorOf(m, m.before, droppedFields(drops)), migrated(m, stored))
	assert.deepEqual(catalogOf(removed), catalogOf(freshState(m.first.names.schema, m.firstDraft)))
	for (const r of stored) {
		const fields = Arr.flatMap(r.rows, (row) => Rec.keys(row))
		const heading = Arr.dedupe(fields)
		assert.deepEqual(
			valuesOf(m, removed, r.relation, heading),
			Arr.sort(
				Arr.map(r.rows, (row) =>
					Arr.join(
						Arr.map(heading, (f) => String(row[f])),
						","
					)
				),
				Order.String
			),
			`${r.relation} keeps its stored rows`
		)
	}
}

const judgeReversal = (r: Reversal): void => {
	switch (r.kind) {
		case "a counted family removed":
			return assertRemoved(
				countedCase.migration,
				foldRows(countedCase, ownersOf(r.owners), r.stored),
				countedDrops
			)
		case "a tree removed":
			return assertRemoved(treeMigration, [{ relation: "Node", rows: r.stored }], treeDrops)
		case "left to its caller": {
			const owners = ownersOf(r.owners)
			const before = migrated(countedCase.migration, foldRows(countedCase, owners, r.stored))
			const left = continued(
				successorOf(countedCase.migration, countedWritten, noDeclarations),
				before
			)
			assert.deepEqual(
				catalogOf(left),
				catalogOf(
					freshState(
						countedCase.migration.second.names.schema,
						migrationOf(countedWritten, countedWritten).firstDraft
					)
				),
				"the family's law columns and natives are gone"
			)
			for (const [relation, fields] of [
				["Owner", ["id", "n", "end"]],
				["Member", ["member", "ownerTag"]]
			] as const) {
				const read = (state: State) =>
					rowsOf(countedCase.migration, state, relation, (cell) =>
						Arr.join(
							Arr.map(fields, (f) =>
								String(cell(fieldColumn(countedCase.migration.second, relation, f)))
							),
							","
						)
					)
				assert.deepEqual(
					read(left),
					read(before),
					`${relation} keeps its drawn values as the caller's`
				)
			}
			return
		}
		case "drawn anew over the caller's values": {
			const owners = ownersOf(r.owners)
			const [n, end, ownerTag] = r.junk
			const state = migrated(toDrawn, [
				{ relation: "Owner", rows: Arr.map(owners, (id) => ({ id, tag: tagOf(id), n, end })) },
				{
					relation: "Member",
					rows: Arr.map(r.stored, (m) => ({ member: m.key, g: m.owner, x: m.x, ownerTag }))
				}
			])
			const drawnCase: FoldCase = { migration: toDrawn, ...countedNames }
			assert.deepEqual(foldObserved(drawnCase, state), foldExpected(owners, r.stored))
			assert.deepEqual(
				copiesObserved(drawnCase, state),
				copiesExpected(drawnCase, owners, r.stored)
			)
			assertFresh(toDrawn, state)
		}
	}
}

describe("backfilling a family added to stored rows, generated", () => {
	it.effect(
		"draws every value its references state over any stored rows in any storage order, ends at the catalog its target installs from nothing, and adds its constraints after the backfill",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/backfill",
						draw: generated(backfillGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "NP's reference fold and pre-order numbering and a naive left fold over the stored rows in key order, run against the catalog model of PostgreSQL executing the drafted migration"
						},
						coverage: required<BackfillFeature>(
							[
								"counted",
								"ordered by line",
								"ordered by order and index",
								"tree",
								"concat",
								"new members",
								"an owner with no member",
								"an owner of three members",
								"members stored out of key order",
								"a negative step",
								"a forest of two trees",
								"a grandchild",
								"siblings stored out of key order",
								"a piece beyond ASCII",
								"an empty piece",
								...Arr.map(renamedFamilies, (f) => `renamed: ${f}` as const),
								...Arr.map(renamings, (r) => `renamed: ${r}` as const),
								...kindChanges,
								...Arr.map(endMoves, (m) => `end moved: ${m}` as const)
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(b, c) =>
						Effect.sync(() => {
							c.noteAll(notesOf(b))
							judgeBackfill(b)
						})
				)
			)
	)

	it.effect(
		"removing a family keeps every row and drops its columns, leaving its fields to the caller keeps their values, and drawing over a caller's values draws them anew",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deploy/backfill-reversal",
						draw: generated(reversalGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the catalog model of PostgreSQL running each migration, against the first schema's fresh catalog and the stored rows"
						},
						coverage: required<Reversal["kind"]>(
							[
								"a counted family removed",
								"a tree removed",
								"left to its caller",
								"drawn anew over the caller's values"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(r, c) =>
						Effect.sync(() => {
							c.note(r.kind)
							judgeReversal(r)
						})
				)
			)
	)
})
