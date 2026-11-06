/**
 * Adding a family to populated relations (rows-first §6): the drafted migration's backfill data step draws every value
 * the family holds over the stored rows, after every column's ADD COLUMN under its placeholder default and before any
 * constraint reads them, and VALIDATE then proves it.
 *
 * - **Counted:** each member's hidden index, ‹i› = row_number() OVER (PARTITION BY g ORDER BY its key) − 1, its copy of
 *   the count, and a sum fold's before and after as running sums in ‹i› order; the owner's count and end.
 * - **Ordered:** the drawn index by the member key the same, its folds the same; under a primary key that holds the
 *   index, by the key the stored rows had.
 * - **Tree:** each row's slot by its key among its siblings, its count, its parent's count and start, and its
 *   pre-order interval, by the one recursive step: the closure of the parent relation; a fold over each row's siblings
 *   in slot order, the root alone at slot 0 in the one state NP's fold suite admits it.
 * - **Copies:** each copy an axis carries is its target's value: an owner's, a predecessor's (the base at the first
 *   slot), a last member's (the base for an empty family), a tree's parent row's (the root its own), a copy of a copy
 *   after the copy it reads.
 * - **A field whose kind changes:** one its caller wrote that the target draws is drawn anew over the caller's values;
 *   one the target leaves to its caller keeps its drawn values, its family's law columns and natives gone.
 *
 * - **The judge:** the catalog model of PostgreSQL (test/support/migrate/interpret.ts) runs the drafted migration
 *   statement by statement over the stored rows, its windows, groups and recursion as the SQL standard defines them,
 *   and its catalog afterwards must be the target's installed from nothing.
 * - **A second implementation:** NP's reference fold (test/support/families/fold.ts) of each owner's members in key
 *   order, and NP's pre-order numbering of each tree (test/support/families/tree.ts) with each node's children in key
 *   order, state every drawn value; what the migration leaves must be exactly that.
 * - **Concat:** a concat fold over an ordered family, its running text string_agg(x, '') over the family's window in slot
 *   order, ROWS from the first slot to the current one; each member's before its predecessor's after, the empty text
 *   at slot 0, and the owner's end its last member's after, the empty text for an empty family.
 * - **The box:** owners with 0, 1 and 3 existing members, so the backfill meets an empty family (its owner keeps the
 *   placeholder, which is the empty family's value), a family of one (its first slot its last), and one whose
 *   predecessor chain the running sum must close; every order the member rows are stored in, since the backfill orders
 *   by key and never by storage; steps over a negative, a zero and positives; and forests of a lone root, a chain, and
 *   a root whose children and grandchildren are keyed out of their order.
 */
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Option, Order, Record as Rec, Result } from "effect"
import type { Step as PlanStep } from "#compiler/deploy/diff/plan.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
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
import type { AnySchema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { FunctionCall, OperandSelect, SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformOperand } from "#compiler/sql/transform.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { type FoldMonoid, foldStoredOf } from "#test/support/families/fold.ts"
import { type Node, numbered } from "#test/support/families/tree.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
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
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { plainPlan } from "#test/support/migrate/review.ts"

/** A migration from `before` to `after`: both installations, compiled as `grizzle generate` drafts them, and both
 * drafts, the first from nothing. */
interface Migration {
	readonly before: AnySchema
	readonly first: Installation
	readonly firstDraft: GenerateResult
	readonly second: Installation
	readonly secondDraft: GenerateResult
}

const migrationOf = (before: AnySchema, after: AnySchema): Migration => {
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
	return { before, first, firstDraft, second, secondDraft }
}

/** The draft that takes `m`'s target to `to`, dropping `drops`, each a relation and a field of it, as declared. */
const removalOf = (
	m: Migration,
	to: AnySchema,
	drops: ReadonlyArray<readonly [string, string]>
): GenerateResult =>
	succeeded(
		generate({
			installation: compile(to, asDrafted),
			timestamp: draftedAt(3),
			previous: fromSnapshot(m.secondDraft.snapshot),
			workload: noWorkload,
			declared: {
				renames: [],
				drops: Arr.map(drops, ([relation, field]) => ({
					kind: "field",
					relation: parsedName(relation),
					field: parsedName(field)
				}))
			},
			name: "third"
		})
	)

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

/** What the second draft leaves on the model after the first is installed and `stored` loaded in order. */
const migrated = (m: Migration, stored: ReadonlyArray<Rows>): State => {
	const schemaName = m.second.names.schema
	const loaded = Arr.reduce(stored, freshState(schemaName, m.firstDraft), (state, r) =>
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
	const run = interpret(schemaName, loaded, plainPlan(m.secondDraft), (p) => {
		throw new Error(`the backfill leaves no placeholder, but drafted a ${p.kind}`)
	})
	if (Result.isFailure(run)) {
		throw new Error(
			`the migration fails on the model: ${run.failure.file} #${run.failure.action}, ${run.failure.reason}`
		)
	}
	return run.success
}

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

/** Every order of a list. */
const permutations = <A>(xs: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
	xs.length === 0
		? [[]]
		: Arr.flatMap(xs, (x, i) =>
				Arr.map(permutations([...xs.slice(0, i), ...xs.slice(i + 1)]), (rest) => [x, ...rest])
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

/** Owner 0 with no member, owner 1 with one, owner 2 with three, keyed out of their order. */
const OWNERS = [0, 1, 2] as const
const members = (xs: readonly [number, number, number, number]): ReadonlyArray<Stored> => [
	{ key: 10, owner: 1, x: xs[0] },
	{ key: 22, owner: 2, x: xs[1] },
	{ key: 20, owner: 2, x: xs[2] },
	{ key: 21, owner: 2, x: xs[3] }
]

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
const copiesExpected = (c: FoldCase, stored: ReadonlyArray<Stored>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(c.copies, (k) =>
			Arr.map(k.on === "member" ? Arr.map(stored, (m) => m.key) : OWNERS, (row) =>
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
const foldExpected = (stored: ReadonlyArray<Stored>) => {
	const reference = foldStoredOf(
		SUM,
		Arr.map(OWNERS, (owner) => ({
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
const foldRows = (c: FoldCase, stored: ReadonlyArray<Stored>): ReadonlyArray<Rows> => [
	{ relation: c.owner, rows: Arr.map(OWNERS, (id) => ({ id, tag: tagOf(id) })) },
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

/** A stored node, its kind drawn from its key. */
const node = (id: number, parent: number, doc: number): StoredNode => ({
	id,
	parent,
	doc,
	kind: (id * 5) % 7
})

/** The forests of the box, each node keyed apart from its siblings' order. */
const FORESTS: ReadonlyArray<ReadonlyArray<StoredNode>> = [
	[node(1, 1, 1)],
	[node(5, 5, 5), node(3, 5, 5), node(9, 3, 5)],
	[
		node(1, 1, 1),
		node(6, 1, 1),
		node(2, 1, 1),
		node(4, 1, 1),
		node(9, 2, 1),
		node(7, 2, 1),
		node(8, 4, 1),
		node(11, 7, 1),
		node(30, 30, 30),
		node(31, 30, 30)
	]
]

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

/** Every window function a query calls, its derived tables' included. */
const windowCalls = (q: OperandSelect): ReadonlyArray<FunctionCall> => {
	const found: Array<FunctionCall> = []
	transformOperand(q, {
		...identityHooks,
		expr: (e) => {
			if (e.kind === "call" && e.over !== undefined) {
				found.push(e)
			}
			return e
		}
	})
	return found
}

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
 * of the reviewer, the `updates` UPDATEs and every DROP DEFAULT in structure.backfill, and every constraint after. */
const assertBackfillOrder = (
	m: Migration,
	columns: ReadonlyArray<string>,
	updates: number
): void => {
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
	assert.deepEqual(
		slotsOf(steps, (s) => s.kind === "update"),
		Arr.makeBy(updates, () => "structure.backfill"),
		"the backfill's UPDATEs"
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

describe("backfilling a family added to populated relations", () => {
	it.effect(
		"a counted family draws the reference fold of every owner's members in key order, however its rows are stored",
		() =>
			Effect.sync(() => {
				let cases = 0
				for (const xs of [
					[5, 1, 2, 3],
					[0, -4, 7, 0]
				] as const) {
					for (const stored of permutations(members(xs))) {
						const state = migrated(countedCase.migration, foldRows(countedCase, stored))
						const order = `stored in the order ${Arr.join(
							Arr.map(stored, (m) => String(m.key)),
							", "
						)}`
						assert.deepEqual(foldObserved(countedCase, state), foldExpected(stored), order)
						assert.deepEqual(
							copiesObserved(countedCase, state),
							copiesExpected(countedCase, stored),
							order
						)
						cases += 1
					}
				}
				assert.equal(cases, 48, "every order of both step vectors")
			})
	)

	it.effect(
		"an ordered family draws its index by the member key, or by the stored rows' key when the new key holds the index",
		() =>
			Effect.sync(() => {
				for (const key of ["line", "order and index"] as const) {
					const c = orderedCase(key)
					for (const stored of permutations(members([3, 1, 4, 1]))) {
						const state = migrated(c.migration, foldRows(c, stored))
						assert.deepEqual(foldObserved(c, state), foldExpected(stored), `keyed by ${key}`)
						assert.deepEqual(copiesObserved(c, state), copiesExpected(c, stored), `keyed by ${key}`)
					}
				}
			})
	)

	it.effect(
		"a tree draws NP's pre-order numbering, its count fold over each node's siblings, and each parent copy, a copy of a copy after the copy it reads",
		() =>
			Effect.sync(() => {
				for (const forest of FORESTS) {
					for (const stored of [forest, Arr.reverse(forest)]) {
						const state = migrated(treeMigration, [{ relation: "Node", rows: stored }])
						assert.deepEqual(treeObserved(state), treeExpected(stored))
					}
				}
			})
	)

	it.effect(
		"a family whose members the migration creates draws nothing: every stored owner keeps the empty family's values",
		() =>
			Effect.sync(() => {
				const m = newMembers
				const state = migrated(m, [{ relation: "Owner", rows: Arr.map(OWNERS, (id) => ({ id })) }])
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
					["0: 0 0", "1: 0 0", "2: 0 0"]
				)
				assert.ok(
					!Arr.some(statementsOf(m.secondDraft.plan.steps), (s) => s.kind === "update"),
					"no UPDATE over a table the migration creates"
				)
				assert.deepEqual(
					defaultColumns(m.secondDraft.plan.steps, "dropDefault"),
					Arr.sort([family.count.column, plane.end.column], Order.String),
					"the owner's placeholders are dropped"
				)
				assert.deepEqual(
					catalogOf(state),
					catalogOf(freshState(m.second.names.schema, m.secondDraft))
				)
			})
	)

	it.effect(
		"every migration ends with the catalog its target installs from nothing, every constraint validated",
		() =>
			Effect.sync(() => {
				for (const [m, stored] of [
					[countedCase.migration, foldRows(countedCase, members([5, 1, 2, 3]))],
					[orderedCase("line").migration, foldRows(orderedCase("line"), members([5, 1, 2, 3]))],
					[treeMigration, [{ relation: "Node", rows: Arr.getUnsafe(FORESTS, 2) }]]
				] as const) {
					assert.deepEqual(
						catalogOf(migrated(m, stored)),
						catalogOf(freshState(m.second.names.schema, m.secondDraft))
					)
				}
			})
	)

	it.effect(
		"removing a family drops its law columns and natives, and its fields as declared, keeping every row",
		() =>
			Effect.sync(() => {
				for (const [m, stored, drops] of [
					[
						countedCase.migration,
						foldRows(countedCase, members([5, 1, 2, 3])),
						[
							["Owner", "n"],
							["Owner", "end"],
							["Member", "ownerTag"]
						]
					],
					[
						treeMigration,
						[{ relation: "Node", rows: Arr.getUnsafe(FORESTS, 2) }],
						Arr.map(
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
					]
				] as const) {
					const removal = removalOf(m, m.before, drops)
					const schemaName = m.first.names.schema
					const run = interpret(schemaName, migrated(m, stored), plainPlan(removal), (p) => {
						throw new Error(`a removal asks no placeholder, but drafted a ${p.kind}`)
					})
					assert.ok(Result.isSuccess(run), "the removal runs on the model")
					assert.deepEqual(catalogOf(run.success), catalogOf(freshState(schemaName, m.firstDraft)))
					for (const r of stored) {
						assert.deepEqual(
							rowsOf(m, run.success, r.relation, (cell) =>
								Arr.join(
									Arr.map(Rec.keys(Arr.getUnsafe(r.rows, 0)), (f) =>
										String(cell(fieldColumn(m.first, r.relation, f)))
									),
									","
								)
							),
							Arr.sort(
								Arr.map(r.rows, (row) => Arr.join(Arr.map(Rec.values(row), String), ",")),
								Order.String
							),
							`${r.relation} keeps its stored rows`
						)
					}
				}
			})
	)

	it.effect(
		"a field its caller wrote that the target draws is drawn anew over the caller's values; one the target leaves to its caller keeps its drawn values",
		() =>
			Effect.sync(() => {
				const stored = members([5, 1, 2, 3])
				const toDrawn = migrationOf(countedWritten, countedAfter)
				const schemaName = toDrawn.second.names.schema
				const junk: ReadonlyArray<Rows> = [
					{
						relation: "Owner",
						rows: Arr.map(OWNERS, (id) => ({ id, tag: tagOf(id), n: 7, end: 99 }))
					},
					{
						relation: "Member",
						rows: Arr.map(stored, (m) => ({ member: m.key, g: m.owner, x: m.x, ownerTag: 55 }))
					}
				]
				const drawnState = migrated(toDrawn, junk)
				const drawnCase: FoldCase = { migration: toDrawn, ...countedNames }
				assert.deepEqual(foldObserved(drawnCase, drawnState), foldExpected(stored))
				assert.deepEqual(copiesObserved(drawnCase, drawnState), copiesExpected(drawnCase, stored))
				assert.deepEqual(
					catalogOf(drawnState),
					catalogOf(freshState(schemaName, toDrawn.secondDraft))
				)
				const redrawn = Arr.map(
					[
						["Owner", "n"],
						["Owner", "end"],
						["Member", "ownerTag"]
					] as const,
					([relation, field]) => fieldColumn(toDrawn.second, relation, field)
				)
				const steps = toDrawn.secondDraft.plan.steps
				for (const column of redrawn) {
					assert.ok(
						Arr.contains(defaultColumns(steps, "addColumnDefault"), column),
						`${column} is added again under its placeholder`
					)
					assert.ok(
						Arr.some(
							slotsOf(
								steps,
								(s) =>
									s.kind === "alterTable" &&
									Arr.some(s.actions, (a) => a.kind === "dropColumn" && a.column === column)
							),
							(slot) => slot === "structure.drop"
						),
						`${column}'s caller-written column is dropped first`
					)
				}

				const before = migrated(countedCase.migration, foldRows(countedCase, stored))
				const toWritten = removalOf(countedCase.migration, countedWritten, [])
				const run = interpret(schemaName, before, plainPlan(toWritten), (p) => {
					throw new Error(
						`leaving a field to its caller asks no placeholder, but drafted a ${p.kind}`
					)
				})
				assert.ok(Result.isSuccess(run), "the migration runs on the model")
				assert.ok(
					!Arr.some(statementsOf(toWritten.plan.steps), (s) => s.kind === "update"),
					"no field the caller now writes is drawn"
				)
				assert.deepEqual(
					catalogOf(run.success),
					catalogOf(freshState(schemaName, migrationOf(countedWritten, countedWritten).firstDraft)),
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
						read(run.success),
						read(before),
						`${relation} keeps its drawn values as the caller's`
					)
				}
			})
	)

	it.effect(
		"adds every drawn column under a placeholder default, draws it, drops the default, then adds the constraints",
		() =>
			Effect.sync(() => {
				assertBackfillOrder(countedCase.migration, foldColumns(countedCase), 3)
				assertBackfillOrder(orderedCase("line").migration, foldColumns(orderedCase("line")), 5)
				const second = treeMigration.second
				const family: Family = defined(second.laws.families[0])
				assert.ok(family.members.kind === "tree", "the family is a tree")
				assertBackfillOrder(
					treeMigration,
					Arr.sort(
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
					),
					6
				)
			})
	)

	it.effect(
		"numbers members by their key and accumulates over ROWS from the partition's first row, never RANGE",
		() =>
			Effect.sync(() => {
				const second = countedCase.migration.second
				const calls = Arr.flatMap(statementsOf(countedCase.migration.secondDraft.plan.steps), (s) =>
					s.kind === "update"
						? Arr.flatMap(s.from, (item) =>
								item.kind === "derived" ? windowCalls(item.query) : []
							)
						: []
				)
				const nameOf = (c: FunctionCall): string => c.fn.name
				assert.deepEqual(
					Arr.sort(Arr.map(calls, nameOf), Order.String),
					["count", "lag", "row_number", "sum"],
					"the index, the count, the running sum and the before"
				)
				const g = fieldColumn(second, "Member", "g")
				for (const c of calls) {
					assert.deepEqual(
						c.over?.partitionBy,
						[{ kind: "column", table: undefined, column: g }],
						`${nameOf(c)} partitions by the group`
					)
					switch (nameOf(c)) {
						case "row_number":
							assert.deepEqual(
								c.over?.orderBy,
								[
									{
										expr: {
											kind: "column",
											table: undefined,
											column: fieldColumn(second, "Member", "member")
										},
										direction: "ASC"
									}
								],
								"the index orders by the member key"
							)
							break
						case "sum":
							assert.deepEqual(
								c.over?.frame,
								{ start: { kind: "unboundedPreceding" }, end: { kind: "currentRow" } },
								"a running aggregate's frame is ROWS from the first row to the current one"
							)
							break
						default:
							assert.equal(c.over?.frame, undefined, `${nameOf(c)} reads no frame`)
					}
				}
			})
	)

	/** Owner 0 with no token, owner 1 with one, owner 2 with three keyed out of their order, pieces beyond ASCII. */
	const tokens: ReadonlyArray<{
		readonly token: number
		readonly attr: number
		readonly piece: string
	}> = [
		{ token: 10, attr: 1, piece: "\u{1F600}" },
		{ token: 22, attr: 2, piece: " c" },
		{ token: 20, attr: 2, piece: "a" },
		{ token: 21, attr: 2, piece: "" }
	]

	it.effect(
		"a concat fold over an ordered family draws each member's running text in key order, however its rows are stored",
		() =>
			Effect.sync(() => {
				const name = "Joining"
				/** Bounded, so the family's axes, which carry each running text, key it within a B-tree entry. */
				const text = str.regex("^.{0,64}$", "su")
				const Attr = relation(
					"Attr",
					{ id: pg.int4, n: drawn(natural), joined: accumulated(text, "") },
					["id"]
				)
				const Token = relation(
					"Token",
					{
						token: pg.int4,
						attr: pg.int4,
						at: drawn(natural),
						piece: text,
						before: accumulated(text, ""),
						after: accumulated(text, "")
					},
					["token"]
				)
				const family = ordered(on(Token, "attr", "at"), fin(Attr, "n"))
				const m = migrationOf(
					schema(
						name,
						{
							Attr: relation("Attr", { id: pg.int4 }, ["id"]),
							Token: relation("Token", { token: pg.int4, attr: pg.int4, piece: text }, ["token"])
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
				)
				/** The naive left fold of each owner's pieces in key order, from the empty text. */
				const expectedTokens: Array<string> = []
				const expectedAttrs: Array<string> = []
				for (const attr of OWNERS) {
					const mine = Arr.sort(
						Arr.filter(tokens, (t) => t.attr === attr),
						Order.mapInput(Order.Number, (t: { readonly token: number }) => t.token)
					)
					let running = ""
					for (const [at, t] of mine.entries()) {
						expectedTokens.push(`${t.token}@${at} ${running}→${running}${t.piece}`)
						running = `${running}${t.piece}`
					}
					expectedAttrs.push(`${attr}: ${mine.length} ${running}`)
				}
				const textOf = (value: string): TypedLiteral => ({ kind: "text", value })
				for (const stored of permutations(tokens)) {
					const schemaName = m.second.names.schema
					const owners = load(
						freshState(schemaName, m.firstDraft),
						tableOf(m.first, "Attr"),
						Arr.map(OWNERS, (id) => new Map([[fieldColumn(m.first, "Attr", "id"), int(id)]]))
					)
					const loaded = load(
						owners,
						tableOf(m.first, "Token"),
						Arr.map(
							stored,
							(t) =>
								new Map([
									[fieldColumn(m.first, "Token", "token"), int(t.token)],
									[fieldColumn(m.first, "Token", "attr"), int(t.attr)],
									[fieldColumn(m.first, "Token", "piece"), textOf(t.piece)]
								])
						)
					)
					const run = interpret(schemaName, loaded, plainPlan(m.secondDraft), (p) => {
						throw new Error(`the backfill leaves no placeholder, but drafted a ${p.kind}`)
					})
					if (Result.isFailure(run)) {
						throw new Error(`the migration fails on the model: ${run.failure.reason}`)
					}
					const second = m.second
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
					const fam: Family = defined(second.laws.families[0])
					const plane = defined(defined(fam.folds[0]).planes[0])
					const observedTokens = Arr.sort(
						Arr.map(
							defined(run.success.tables.get(tableOf(second, "Token"))).rows,
							(row) =>
								`${cellText(row, fieldColumn(second, "Token", "token"))}@${cellText(row, columnOf(fam.index))} ${cellText(row, columnOf(plane.before))}→${cellText(row, columnOf(plane.after))}`
						),
						Order.String
					)
					const observedAttrs = Arr.sort(
						Arr.map(
							defined(run.success.tables.get(tableOf(second, "Attr"))).rows,
							(row) =>
								`${cellText(row, fieldColumn(second, "Attr", "id"))}: ${cellText(row, fam.count.column)} ${cellText(row, plane.end.column)}`
						),
						Order.String
					)
					const order = Arr.join(
						Arr.map(stored, (t) => `${t.token}`),
						","
					)
					assert.deepEqual(
						observedTokens,
						Arr.sort(expectedTokens, Order.String),
						`stored as ${order}`
					)
					assert.deepEqual(
						observedAttrs,
						Arr.sort(expectedAttrs, Order.String),
						`stored as ${order}`
					)
				}
			})
	)
})
