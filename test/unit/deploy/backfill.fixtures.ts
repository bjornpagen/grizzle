/** What the properties of backfill.test.ts read: its spaces, models and helpers. */

import { ChunkView } from "@bjornpagen/grizzle-text/chunks"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	array,
	int as between,
	constant,
	element,
	type Gen,
	map,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec, Result } from "effect"
import {
	alterationStatement,
	type Declarations,
	type Step as PlanStep,
	type Rename
} from "#compiler/deploy/diff/plan.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { splitStatements, statementTokens } from "#compiler/deploy/render/markers.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { SlotsDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn, instant, natural, pg, place } from "#compiler/public/fields.ts"
import {
	contained,
	counted,
	fin,
	fold,
	key,
	Monoid,
	on,
	ordered,
	pred,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { type FoldMonoid, foldStoredOf } from "#test/support/families/fold.ts"
import * as Desc from "#test/support/fixtures/ir/desc.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	catalogOf,
	type Cell,
	installState,
	interpret,
	load,
	modelInstant,
	type State
} from "#test/support/migrate/interpret.ts"
import { docTree, keyedTreeOf } from "#test/support/migrate/keyed-tree.ts"
import {
	asDrafted,
	compile,
	type DeploySubject,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	installedStatements,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import {
	missingKeyChecks,
	owedKeyChecks,
	perRowReads,
	recursions,
	rederived,
	rewrittenTables
} from "#test/support/migrate/probes.ts"
import { plainPlan } from "#test/support/migrate/review.ts"
import { upTo } from "#test/support/up-to.ts"

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

const migrationOf = (before: DeploySubject, after: DeploySubject): Migration =>
	declaredMigrationOf(before, after, noDeclarations)

/** The migration from `before` to `after` whose second draft declares `declared`. */
const declaredMigrationOf = (
	before: DeploySubject,
	after: DeploySubject,
	declared: Declarations
): Migration => {
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
			declared,
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

/** The model state of an installation's objects installed from nothing. */
const freshState = (schemaName: string, installation: Installation): State => {
	const state = installState(schemaName, installedStatements(installation))
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
		Arr.reduce(stored, freshState(m.first.names.schema, m.first), (state, r) =>
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

/** The text a folded member reads as: its key, slot, successor, before and after. */
const memberText = (
	member: bigint | number,
	at: bigint | number,
	next: bigint | number,
	before: bigint,
	after: bigint
): string => `${member}@${at}/${next} ${before}→${after}`

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

/**
 * What a fold steps each member by, of the stored members in key order: its own stored step, or its copy of the step of
 * the member before it, the copy's start, -1, at the first (orderedCase's prevQty).
 */
type Stepped = "its own" | "the one before's"

/** What the reference fold says a fold family leaves: each owner's members in key order, folded from the identity by
 * what `stepped` says each steps by. */
const foldExpected = (
	owners: ReadonlyArray<number>,
	stored: ReadonlyArray<Stored>,
	stepped: Stepped
) => foldExpectedBy(owners, stored, (m) => m.key, stepped)

/** foldExpected, each member read by what `readBy` says the field it is read by holds of it. */
const foldExpectedBy = (
	owners: ReadonlyArray<number>,
	stored: ReadonlyArray<Stored>,
	readBy: (m: Stored) => number,
	stepped: Stepped
) => {
	const reference = foldStoredOf(
		SUM,
		Arr.map(owners, (owner) => {
			const members = Arr.sort(
				Arr.filter(stored, (m) => m.owner === owner),
				Order.mapInput(Order.Number, (m: Stored) => m.key)
			)
			return {
				owner,
				members: Arr.map(members, (m, i) => {
					const before = members[i - 1]
					const x = stepped === "its own" ? m.x : before === undefined ? -1 : before.x
					return { member: m.key, x: BigInt(x), selected: true }
				})
			}
		})
	)
	const byKey = new Map(Arr.map(stored, (m) => [m.key, m] as const))
	return {
		members: Arr.sort(
			Arr.map(reference.rows, (r) =>
				memberText(
					readBy(defined(byKey.get(r.member), "a stored member")),
					r.at,
					r.next,
					Arr.headNonEmpty(r.before),
					Arr.headNonEmpty(r.after)
				)
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
 * key, its group and its step, the caller's field its stored rows hold, and what its fold steps each member by. */
interface FoldCase {
	readonly migration: Migration
	readonly owner: string
	readonly member: string
	readonly key: string
	readonly group: string
	readonly step: string
	readonly stepped: Stepped
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
				cell(columnOf(family.shape.index)),
				cell(family.next),
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
	[
		relation("Owner", { id: pg.integer, tag: pg.integer }, ["id"]),
		relation("Member", { member: pg.integer, g: pg.integer, x: pg.integer }, ["member"])
	],
	[]
)

const countedAfter = (() => {
	const Owner = relation(
		"Owner",
		{ id: pg.integer, tag: pg.integer, n: drawn(natural), end: accumulated(pg.integer, 0) },
		["id"]
	)
	const Member = relation(
		"Member",
		{ member: pg.integer, g: pg.integer, x: pg.integer, ownerTag: accumulated(pg.integer, 0) },
		["member"]
	)
	const family = counted(on(Member, "g"), fin(Owner, "n"))
	return schema(
		"Backfill",
		[Owner, Member],
		[
			family,
			fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end")),
			contained(on(Member, "g", "ownerTag"), on(Owner, "id", "tag"))
		]
	)
})()

/** How the counted case's rows are named, and its one copy: each member's owner's tag. */
const countedNames: Omit<FoldCase, "migration"> = {
	owner: "Owner",
	member: "Member",
	key: "member",
	group: "g",
	step: "x",
	stepped: "its own",
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
	[
		relation("Owner", { id: pg.integer, tag: pg.integer, n: natural, end: pg.integer }, ["id"]),
		relation("Member", { member: pg.integer, g: pg.integer, x: pg.integer, ownerTag: pg.integer }, [
			"member"
		])
	],
	[]
)

/** How an ordered case's lines are keyed after the migration: by line, as they were, or by their order and index. */
type LineKey = "line" | "order and index"

/** The counted case's family over members the migration creates, its owners stored before it. */
const newMembers: Migration = (() => {
	const name = "Backfill"
	const Owner = relation(
		"Owner",
		{ id: pg.integer, n: drawn(natural), end: accumulated(pg.integer, 0) },
		["id"]
	)
	const Member = relation("Member", { member: pg.integer, g: pg.integer, x: pg.integer }, [
		"member"
	])
	const family = counted(on(Member, "g"), fin(Owner, "n"))
	return migrationOf(
		schema(name, [relation("Owner", { id: pg.integer }, ["id"])], []),
		schema(
			name,
			[Owner, Member],
			[family, fold(family, Monoid.sum, on(Member, "g", "x"), on(Owner, "id", "end"))]
		)
	)
})()

/** An ordered family of Line per Order, its qty, or each line's copy of the qty of the line before it (prevQty), as
 * `stepped` says, summed into the order's total; keyed as `key` says after the migration, the stored lines keyed by
 * line before it. */
const orderedCase = (key: LineKey, stepped: Stepped): FoldCase => {
	const name = "Ordering"
	const Order_ = relation(
		"Order",
		{
			id: pg.integer,
			tag: pg.integer,
			n: drawn(natural),
			total: accumulated(pg.integer, 0),
			lastQty: accumulated(pg.integer, -1)
		},
		["id"]
	)
	const fields = {
		line: pg.integer,
		order: pg.integer,
		at: drawn(natural),
		qty: pg.integer,
		orderTag: accumulated(pg.integer, 0),
		prevQty: accumulated(pg.integer, -1)
	}
	const Line =
		key === "line" ? relation("Line", fields, ["line"]) : relation("Line", fields, ["order", "at"])
	const family = ordered(on(Line, "order", "at"), fin(Order_, "n"))
	return {
		migration: migrationOf(
			schema(
				name,
				[
					relation("Order", { id: pg.integer, tag: pg.integer }, ["id"]),
					relation("Line", { line: pg.integer, order: pg.integer, qty: pg.integer }, ["line"])
				],
				[]
			),
			schema(
				name,
				[Order_, Line],
				[
					family,
					fold(
						family,
						Monoid.sum,
						on(Line, "order", stepped === "its own" ? "qty" : "prevQty"),
						on(Order_, "id", "total")
					),
					contained(on(Line, "order", "orderTag"), on(Order_, "id", "tag")),
					contained(on(Line, "order", pred("at"), "prevQty"), on(Line, "order", "at", "qty")),
					contained(on(Order_, "id", pred("n"), "lastQty"), on(Line, "order", "at", "qty"))
				]
			)
		),
		owner: "Order",
		member: "Line",
		key: "line",
		group: "order",
		step: "qty",
		stepped,
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

/** The statements a step runs: a statement's own, and a table alteration's one ALTER TABLE. */
const stepStatements = (s: PlanStep): ReadonlyArray<SqlStatement> =>
	s.draft.kind === "statement"
		? [s.draft.statement]
		: s.draft.kind === "alteration"
			? [alterationStatement(s.draft.table, s.draft.actions)]
			: []

/** The slots of the plan's steps whose statement `matches`, in plan order. */
const slotsOf = (
	steps: ReadonlyArray<PlanStep>,
	matches: (s: SqlStatement) => boolean
): ReadonlyArray<string> =>
	Arr.flatMap(steps, (s) => (Arr.some(stepStatements(s), matches) ? [s.slot] : []))

const addsDefault = (s: SqlStatement): boolean =>
	s.kind === "alterTable" && Arr.some(s.actions, (a) => a.kind === "addColumnDefault")

const dropsDefault = (s: SqlStatement): boolean =>
	s.kind === "alterTable" && Arr.some(s.actions, (a) => a.kind === "dropDefault")

const addsConstraint = (s: SqlStatement): boolean =>
	s.kind === "alterTable" && Arr.some(s.actions, (a) => a.kind === "addConstraint")

/** The statements of the plan's steps, in plan order. */
const statementsOf = (steps: ReadonlyArray<PlanStep>): ReadonlyArray<SqlStatement> =>
	Arr.flatMap(steps, stepStatements)

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

/** The drawn columns of a fold family: its index, successor, count, its plane's before, after and end, and its copies. */
const foldColumns = (c: FoldCase): ReadonlyArray<string> => {
	const second = c.migration.second
	const family: Family = defined(second.laws.families[0])
	const plane = defined(defined(family.folds[0]).planes[0])
	return Arr.sort(
		[
			columnOf(family.shape.index),
			family.next,
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
		!Arr.some(
			steps,
			(s) =>
				s.draft.kind === "alteration" &&
				Arr.some(s.draft.actions, (a) => a.kind === "addColumnPlaceholder")
		),
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
	assert.deepEqual(perRowReads(steps), [], "no backfill statement reads a row once per row")
	assert.deepEqual(recursions(steps), [], "no backfill statement recurs")
	assert.deepEqual(
		missingKeyChecks(m.second, m.firstDraft.snapshot.theory, steps),
		[],
		"the backfill checks every key its derivations rely on before any of them runs"
	)
	assert.deepEqual(
		rewrittenTables(steps),
		[],
		"the backfill writes each table's rows by one UPDATE"
	)
}

/** The ordered families, by how their lines are keyed after the migration. */
const orderedByLine = orderedCase("line", "its own")

const orderedByIndex = orderedCase("order and index", "its own")

const orderedOverCopies = orderedCase("line", "the one before's")

/**
 * What a migration that keys the lines by their order and a new drawn index does to the key the lines were stored by,
 * which its backfill orders and joins the stored lines by (deploy/diff/backfill.ts memberKey): declares it renamed to a
 * fresh name, swapped with qty, renamed along a chain qty moves down too, or dropped.
 */
export const storedKeyFates = [
	"renamed to a fresh name",
	"swapped with qty",
	"renamed along a chain",
	"dropped"
] as const

type StoredKeyFate = (typeof storedKeyFates)[number]

/** Line's field `from` renamed to `to`, declared. */
const lineFieldRenamed = (from: string, to: string): Rename => ({
	from: { kind: "field", relation: parsedName("Line"), field: parsedName(from) },
	to: { kind: "field", relation: parsedName("Line"), field: parsedName(to) }
})

/** The lines before the migration, keyed by line, and their orders. */
const storedLines = schema(
	"StoredKey",
	[
		relation("Order", { id: pg.integer, tag: pg.integer }, ["id"]),
		relation("Line", { line: pg.integer, order: pg.integer, qty: pg.integer }, ["line"])
	],
	[]
)

/** The orders after the migration: each counts its lines and sums their qty. */
const countedOrder = relation(
	"Order",
	{ id: pg.integer, tag: pg.integer, n: drawn(natural), total: accumulated(pg.integer, 0) },
	["id"]
)

/**
 * A stored key's fate as the migration that adds the family states it: the stored lines' fold case under the names
 * they were stored by, its case under the names the migration leaves, and what the field a migrated line is read by
 * holds of its stored member: the stored key where the key stays, renamed or not, and its order where it is dropped.
 */
interface StoredKeyCase {
	readonly stored: FoldCase
	readonly after: FoldCase
	readonly readBy: (m: Stored) => number
}

/** The fold case of the stored lines under the names they were stored by. */
const storedNames = (migration: Migration): FoldCase => ({
	migration,
	owner: "Order",
	member: "Line",
	key: "line",
	group: "order",
	step: "qty",
	stepped: "its own",
	copies: []
})

/** A renamed stored key's case: the migration to `after` under `renames`, its stored key and qty named `key` and
 * `step` after it. */
const renamedKeyCase = (
	after: DeploySubject,
	renames: ReadonlyArray<Rename>,
	key: string,
	step: string
): StoredKeyCase => {
	const stored = storedNames(declaredMigrationOf(storedLines, after, { renames, drops: [] }))
	return { stored, after: { ...stored, key, step }, readBy: (m) => m.key }
}

/** A dropped stored key's case: the migration to `after` dropping line, declared, a migrated line read by its order. */
const droppedKeyCase = (after: DeploySubject): StoredKeyCase => {
	const stored = storedNames(
		declaredMigrationOf(storedLines, after, droppedFields([["Line", "line"]]))
	)
	return { stored, after: { ...stored, key: "order" }, readBy: (m) => m.owner }
}

/** The lines after a migration that renames their stored key to a fresh name: lineNo, keyed by order and index. */
const freshKeyed = (() => {
	const Line = relation(
		"Line",
		{ lineNo: pg.integer, order: pg.integer, at: drawn(natural), qty: pg.integer },
		["order", "at"]
	)
	const family = ordered(on(Line, "order", "at"), fin(countedOrder, "n"))
	return schema(
		"StoredKey",
		[countedOrder, Line],
		[family, fold(family, Monoid.sum, on(Line, "order", "qty"), on(countedOrder, "id", "total"))]
	)
})()

/** The lines after a migration that swaps their stored key with qty: qty holds the stored key, line the qty. */
const swappedKeyed = (() => {
	const Line = relation(
		"Line",
		{ qty: pg.integer, order: pg.integer, at: drawn(natural), line: pg.integer },
		["order", "at"]
	)
	const family = ordered(on(Line, "order", "at"), fin(countedOrder, "n"))
	return schema(
		"StoredKey",
		[countedOrder, Line],
		[family, fold(family, Monoid.sum, on(Line, "order", "line"), on(countedOrder, "id", "total"))]
	)
})()

/** The lines after a migration that renames their stored key along a chain: line to qty, qty to amount. */
const chainedKeyed = (() => {
	const Line = relation(
		"Line",
		{ qty: pg.integer, order: pg.integer, at: drawn(natural), amount: pg.integer },
		["order", "at"]
	)
	const family = ordered(on(Line, "order", "at"), fin(countedOrder, "n"))
	return schema(
		"StoredKey",
		[countedOrder, Line],
		[family, fold(family, Monoid.sum, on(Line, "order", "amount"), on(countedOrder, "id", "total"))]
	)
})()

/** The lines after a migration that drops their stored key. */
const droppedKeyed = (() => {
	const Line = relation("Line", { order: pg.integer, at: drawn(natural), qty: pg.integer }, [
		"order",
		"at"
	])
	const family = ordered(on(Line, "order", "at"), fin(countedOrder, "n"))
	return schema(
		"StoredKey",
		[countedOrder, Line],
		[family, fold(family, Monoid.sum, on(Line, "order", "qty"), on(countedOrder, "id", "total"))]
	)
})()

const storedKeyCases: { readonly [F in StoredKeyFate]: StoredKeyCase } = {
	"renamed to a fresh name": renamedKeyCase(
		freshKeyed,
		[lineFieldRenamed("line", "lineNo")],
		"lineNo",
		"qty"
	),
	"swapped with qty": renamedKeyCase(
		swappedKeyed,
		[lineFieldRenamed("line", "qty"), lineFieldRenamed("qty", "line")],
		"qty",
		"line"
	),
	"renamed along a chain": renamedKeyCase(
		chainedKeyed,
		[lineFieldRenamed("line", "qty"), lineFieldRenamed("qty", "amount")],
		"qty",
		"amount"
	),
	dropped: droppedKeyCase(droppedKeyed)
}

/**
 * What a stored key's fate must leave: whether the migration renames the key the lines were stored by, swapped or
 * chained included, or drops it, which stands until the migration's removals, its backfill draws every value the
 * reference fold states over the stored lines in that key's order, ending at the catalog its target installs from
 * nothing, with every drawn column added and its default dropped around the backfill.
 */
const judgeStoredKey = (
	fate: StoredKeyFate,
	owners: number,
	stored: ReadonlyArray<Stored>
): void => {
	const k = storedKeyCases[fate]
	const ids = ownersOf(owners)
	const state = migrated(k.stored.migration, foldRows(k.stored, ids, stored))
	assert.deepEqual(
		foldObserved(k.after, state),
		foldExpectedBy(ids, stored, k.readBy, k.after.stepped)
	)
	assertFresh(k.after.migration, state)
	assertBackfillOrder(k.after.migration, foldColumns(k.after))
}

/** Bounded, so the family's axes, which carry each running text, key it within a B-tree entry. */
const joinedText = str.regex("^.{0,64}$", "su")

/** A concat fold over an ordered family of Token per Attr, its pieces' running text in each token's before and after. */
const concatCase: FoldCase = (() => {
	const name = "Joining"
	const Attr = relation(
		"Attr",
		{ id: pg.integer, n: drawn(natural), joined: accumulated(joinedText, "") },
		["id"]
	)
	const Token = relation(
		"Token",
		{
			token: pg.integer,
			attr: pg.integer,
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
				[
					relation("Attr", { id: pg.integer }, ["id"]),
					relation("Token", { token: pg.integer, attr: pg.integer, piece: joinedText }, ["token"])
				],
				[]
			),
			schema(
				name,
				[Attr, Token],
				[
					family,
					fold(
						family,
						Monoid.concat,
						on(Token, "attr", "piece", "before", "after"),
						on(Attr, "id", "joined")
					)
				]
			)
		),
		owner: "Attr",
		member: "Token",
		key: "token",
		group: "attr",
		step: "piece",
		stepped: "its own",
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
					`${cellText(row, fieldColumn(second, "Token", "token"))}@${cellText(row, columnOf(fam.shape.index))} ${cellText(row, columnOf(plane.before))}→${cellText(row, columnOf(plane.after))}`
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
				freshState(m.first.names.schema, m.first),
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
	bases: []
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
		bases: []
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
	stepped: "its own",
	copies: []
})

/** A family drawn over stored rows by one migration and reshaped by the next. */
interface Reshaped {
	readonly drawn: FoldCase
	readonly reshaped: FoldCase
}

/** The families a later migration renames: counted, its accumulators hidden as they must be; ordered over hidden
 * accumulators; and ordered over named ones. */
export const renamedFamilies = ["counted", "ordered", "ordered with named accumulators"] as const

type RenamedFamily = (typeof renamedFamilies)[number]

const renamedForms: {
	readonly [R in RenamedFamily]: readonly [FamilyForm, Accumulators]
} = {
	counted: ["counted", "hidden"],
	ordered: ["ordered", "hidden"],
	"ordered with named accumulators": ["ordered", "named"]
}

/** What of a family a later migration renames, declared. */
export const renamings = ["its owner", "its count", "its owner and its count"] as const

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
export const kindChanges = ["counted to ordered", "ordered to counted"] as const

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
export const endMoves = ["the old end dropped", "the old end left to its caller"] as const

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

/** The text a member of a family with no fold reads as: its key, its slot and its successor. */
const slotText = (member: bigint | number, at: bigint | number, next: bigint | number): string =>
	`${member}@${at}/${next}`

/** What a family with no fold holds over the stored rows: each owner's members in key order, numbered from 0, each
 * with its successor, the slot after it below the count and its own slot at the last, and each owner's count. */
const slotsExpected = (owners: ReadonlyArray<number>, stored: ReadonlyArray<Stored>) => ({
	members: Arr.sort(
		Arr.flatMap(owners, (owner) => {
			const mine = ownedBy(stored, owner)
			return Arr.map(mine, (m, at) => slotText(m.key, at, at + 1 < mine.length ? at + 1 : at))
		}),
		Order.String
	),
	owners: Arr.sort(
		Arr.map(owners, (owner) => `${owner}: ${ownedBy(stored, owner).length}`),
		Order.String
	)
})

/** What the migrated model holds of a family with no fold: each member's slot and successor, each owner's count. */
const slotsObserved = (c: FoldCase, state: State) => {
	const target = c.migration.second
	const family: Family = defined(target.laws.families[0])
	return {
		members: rowsOf(c.migration, state, c.member, (cell) =>
			slotText(
				cell(fieldColumn(target, c.member, c.key)),
				cell(columnOf(family.shape.index)),
				cell(family.next)
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

/**
 * The keyed tree drafted from the stored tree rooted at its document (test/support/migrate/keyed-tree.ts docTree): its
 * root replaced, so its parent is drawn anew from the kept intervals, its copies and folds drawn after it, its document
 * dropped. Its derivations meet Node's rows at Node's new primary key, (package, path, start), whose
 * law the previous snapshot does not record and none of whose columns the backfill draws: the one draft of the box that owes
 * a key check.
 */
const keyedTree = (() => {
	const tree = docTree()
	const installation = compile(keyedTreeOf(), asDrafted)
	return Object.freeze({
		previous: tree.snapshot.theory,
		installation,
		draft: succeeded(
			generate({
				previous: fromSnapshot(tree.snapshot),
				installation,
				name: "keyed",
				timestamp: draftedAt(1),
				workload: noWorkload,
				declared: {
					renames: [],
					drops: [{ kind: "field", relation: parsedName("Node"), field: parsedName("doc") }]
				}
			}),
			"the keyed tree drafts from the stored tree"
		)
	})
})()

/** The fold families a fold case draws over stored rows (foldCaseOf). */
export const foldFamilies = [
	"counted",
	"ordered by line",
	"ordered by order and index",
	"ordered by line, folding a predecessor copy"
] as const

type Backfill =
	| {
			readonly kind: "fold"
			readonly family: (typeof foldFamilies)[number]
			readonly owners: number
			readonly stored: ReadonlyArray<Stored>
	  }
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
	| {
			readonly kind: "stored key"
			readonly fate: StoredKeyFate
			readonly owners: number
			readonly stored: ReadonlyArray<Stored>
	  }
	| { readonly kind: "keyed tree" }
	| {
			readonly kind: "place"
			readonly stored: ReadonlyArray<Placed>
			readonly attempts: ReadonlyArray<PlacedAttempt>
	  }
	| { readonly kind: "place over a level" }

/** A stored session of the place case, by its child, its item and its stage. */
interface Placed {
	readonly child: number
	readonly item: number
	readonly stage: number
}

/** A stored attempt of a session of the place case, at its instant, with as many values as `values`. */
interface PlacedAttempt {
	readonly session: Placed
	readonly at: number
	readonly values: number
}

/** Every session the place case may store: two children, two items, six stages. */
const placeable: ReadonlyArray<Placed> = Arr.flatMap(
	upTo(2, (child) => child),
	(child) =>
		Arr.flatMap(
			upTo(2, (item) => item),
			(item) => upTo(6, (stage) => ({ child, item, stage }))
		)
)

/** The place case over a level, whose draft the model of PostgreSQL, one schema's, does not run: its UPDATEs' tables. */
export const placedGen: Gen<Backfill> = weighted<Backfill>([
	[9, (source) => placedRowsGen(source)],
	[1, constant<Backfill>({ kind: "place over a level" })]
])

/** The place case's stored rows: sessions stored in a drawn order, each with up to two attempts, each attempt with up
 * to two values. */
const placedRowsGen: Gen<Backfill> = (source) => {
	const stored = source.draw(shuffled(placeable, { min: 0, max: 8 }))
	const attempts = Arr.flatMap(stored, (session) =>
		upTo(source.draw(between(0, 2)), (at) => ({
			session,
			at,
			values: source.draw(between(0, 2))
		}))
	)
	return { kind: "place", stored, attempts }
}

/** The schema the place case's relations extend where they are a level of their own. */
const placedBase = schema("Backfill", [relation("Root", { id: pg.integer }, ["id"])], [])

/** The place case's declared drops: the attempts' and the values' stages. */
const placedDrops = droppedFields([
	["Attempt", "stage"],
	["Value", "stage"]
])

/**
 * Sessions keyed by child, item and stage, each attempt of one by its stage and its instant, and each value of an
 * attempt by its attempt and its own: what a migration re-keys by a place within each child's item, by stage.
 */
const placedBeforeIn = (level: boolean) => {
	const Session = relation("Session", { child: pg.integer, item: pg.integer, stage: pg.integer }, [
		"child",
		"item",
		"stage"
	])
	const Attempt = relation(
		"Attempt",
		{ child: pg.integer, item: pg.integer, stage: pg.integer, at: pg.integer },
		["child", "item", "stage", "at"]
	)
	const Value = relation(
		"Value",
		{ child: pg.integer, item: pg.integer, stage: pg.integer, at: pg.integer, v: pg.integer },
		["child", "item", "stage", "at", "v"]
	)
	const laws = [
		contained(on(Attempt, "child", "item", "stage"), on(Session, "child", "item", "stage")),
		contained(
			on(Value, "child", "item", "stage", "at"),
			on(Attempt, "child", "item", "stage", "at")
		)
	]
	return level
		? schema.extend([placedBase], "Placed", [Session, Attempt, Value], laws)
		: schema("Backfill", [Session, Attempt, Value], laws)
}

/**
 * The sessions keyed by their place n within each child's item, which a migration numbers by stage, their old key a key
 * still; each attempt keyed by its session's place and its instant, its stage dropped, and each value by its attempt's
 * place, its stage dropped: each place an attempt or a value holds is the one its containment carries.
 */
const placedAfterIn = (level: boolean) => {
	const Session = relation(
		"Session",
		{ child: pg.integer, item: pg.integer, n: place.by("stage"), stage: pg.integer },
		["child", "item", "n"]
	)
	const Attempt = relation(
		"Attempt",
		{ child: pg.integer, item: pg.integer, n: natural, at: pg.integer },
		["child", "item", "n", "at"]
	)
	const Value = relation(
		"Value",
		{ child: pg.integer, item: pg.integer, n: natural, at: pg.integer, v: pg.integer },
		["child", "item", "n", "at", "v"]
	)
	const laws = [
		key(on(Session, "child", "item", "stage")),
		contained(on(Attempt, "child", "item", "n"), on(Session, "child", "item", "n")),
		contained(on(Value, "child", "item", "n", "at"), on(Attempt, "child", "item", "n", "at"))
	]
	return level
		? schema.extend([placedBase], "Placed", [Session, Attempt, Value], laws)
		: schema("Backfill", [Session, Attempt, Value], laws)
}

/** The place case's migration: each stored session numbered within its child's item by its stage, and each attempt
 * and value re-keyed by the place its containment carries, their stages dropped as declared. */
const placedMigration = declaredMigrationOf(
	placedBeforeIn(false),
	placedAfterIn(false),
	placedDrops
)

/**
 * The tables each UPDATE of the backfill of the place case's migration over a level writes, by schema and name: the
 * relations an extension of a base schema declares, installed in the level's own PostgreSQL schema, which every table
 * a derivation draws on is named in.
 */
const placedLevelUpdates = (): ReadonlyArray<string> => {
	const m = declaredMigrationOf(placedBeforeIn(true), placedAfterIn(true), placedDrops)
	return Arr.flatMap(m.secondDraft.plan.steps, (step) =>
		step.slot === "structure.backfill" &&
		step.draft.kind === "statement" &&
		step.draft.statement.kind === "update"
			? [`${step.draft.statement.table.schema}.${step.draft.statement.table.name}`]
			: []
	)
}

/** What the place case's migration must leave: each session's place, the count of its group's sessions of an earlier
 * stage; each attempt's and each value's, its session's; and the catalog its target installs from nothing. */
const judgePlaces = (
	stored: ReadonlyArray<Placed>,
	attempts: ReadonlyArray<PlacedAttempt>
): void => {
	const m = placedMigration
	const state = migrated(m, [
		{
			relation: "Session",
			rows: Arr.map(stored, (s) => ({ child: s.child, item: s.item, stage: s.stage }))
		},
		{
			relation: "Attempt",
			rows: Arr.map(attempts, (a) => ({
				child: a.session.child,
				item: a.session.item,
				stage: a.session.stage,
				at: a.at
			}))
		},
		{
			relation: "Value",
			rows: Arr.flatMap(attempts, (a) =>
				upTo(a.values, (v) => ({
					child: a.session.child,
					item: a.session.item,
					stage: a.session.stage,
					at: a.at,
					v
				}))
			)
		}
	])
	const placeOf = (s: Placed): number =>
		Arr.filter(stored, (o) => o.child === s.child && o.item === s.item && o.stage < s.stage).length
	const column = (relation: string, field: string) => fieldColumn(m.second, relation, field)
	const read = (relation: string, fields: ReadonlyArray<string>) =>
		rowsOf(m, state, relation, (cell) =>
			Arr.join(
				Arr.map(fields, (f) => `${cell(column(relation, f))}`),
				" "
			)
		)
	assert.deepEqual(
		read("Session", ["child", "item", "stage", "n"]),
		Arr.sort(
			Arr.map(stored, (s) => `${s.child} ${s.item} ${s.stage} ${placeOf(s)}`),
			Order.String
		),
		"each session's place is the count of its child's sessions of its item at an earlier stage"
	)
	assert.deepEqual(
		read("Attempt", ["child", "item", "n", "at"]),
		Arr.sort(
			Arr.map(
				attempts,
				(a) => `${a.session.child} ${a.session.item} ${placeOf(a.session)} ${a.at}`
			),
			Order.String
		),
		"each attempt holds its session's place, which its containment carries"
	)
	assert.deepEqual(
		read("Value", ["child", "item", "n", "at", "v"]),
		Arr.sort(
			Arr.flatMap(attempts, (a) =>
				upTo(
					a.values,
					(v) => `${a.session.child} ${a.session.item} ${placeOf(a.session)} ${a.at} ${v}`
				)
			),
			Order.String
		),
		"each value holds its attempt's place, which its containment carries"
	)
	assert.deepEqual(
		rederived(m.secondDraft.plan.steps),
		[],
		"each place and each carried column is drawn by one statement of the migration, every later UPDATE reading it as stored"
	)
	assertFresh(m, state)
}

/** The owners' ids: 0 to `count - 1`, at least one. */
const ownersOf = (count: number): ReadonlyArray<number> => upTo(count, (i) => i)

/** Distinct keys in the order the rows are stored: shuffled, so storage never follows key order. */
const keysGen = (size: {
	readonly min: number
	readonly max: number
}): Gen<ReadonlyArray<number>> =>
	shuffled(
		Arr.makeBy(30, (i) => i + 1),
		size
	)

/**
 * A stamped head a migration adds to stored rows (deploy/diff/diff.ts stampedColumn), a clock or an unordered place:
 * sign-ins, by user and an email each, keyed by user, stored in a drawn order, re-keyed by user and the head; or keyed
 * by user and email, which the new key (user, head) does not hold, so the migration is refused.
 */
export type Clocked = {
	readonly head: StampedHead
} & (
	| { readonly kind: "held"; readonly users: ReadonlyArray<number> }
	| { readonly kind: "not held" }
)

/** The head a stamped case adds: a clock, `at`, or an unordered place, `n`. */
type StampedHead = "clock" | "place"

export type ClockedFeature =
	| `a ${StampedHead} added over stored rows`
	| "over no row"
	| `refused: the old key not held under a ${StampedHead}`

/** The stamped case's head and its stored users, distinct, stored in a drawn order, or the refused case. */
export const clockedGen: Gen<Clocked> = (source) => {
	const head = source.draw(map(between(0, 1), (i): StampedHead => (i === 0 ? "clock" : "place")))
	return source.draw(
		weighted<Clocked>([
			[3, map(keysGen({ min: 0, max: 6 }), (users): Clocked => ({ head, kind: "held", users }))],
			[1, constant<Clocked>({ head, kind: "not held" })]
		])
	)
}

export const clockedNotes = (c: Clocked): ReadonlyArray<ClockedFeature> =>
	c.kind === "not held"
		? [`refused: the old key not held under a ${c.head}`]
		: [
				`a ${c.head} added over stored rows`,
				...(c.users.length === 0 ? (["over no row"] as const) : [])
			]

/** Sign-ins keyed as `key` names, each by its user and an email. */
const signedBefore = (key: "user" | "user and email") =>
	schema(
		"Backfill",
		[
			relation(
				"SignIn",
				{ user: pg.integer, email: pg.integer },
				key === "user" ? ["user"] : ["user", "email"]
			)
		],
		[]
	)

/** The sign-ins keyed by user and `head`: the instant each was recorded at, a clock of child user, or its unordered
 * place among its user's. */
const signedAfter = (head: StampedHead) =>
	schema(
		"Backfill",
		[
			head === "clock"
				? relation("SignIn", { user: pg.integer, at: instant, email: pg.integer }, ["user", "at"])
				: relation("SignIn", { user: pg.integer, n: place, email: pg.integer }, ["user", "n"])
		],
		[]
	)

/** The field a stamped case's head is. */
const headField = (head: StampedHead): string => (head === "clock" ? "at" : "n")

/**
 * What the stamped case's migration must do: where the new key holds the old one, every stored sign-in takes one value,
 * a clock's the migration's instant, the model's (modelInstant), and an unordered place's 0, and the catalog is the one
 * its target installs from nothing; where it does not, the draft is refused as InstantRefused or PlaceRefused
 * addedOverRows at the head, naming both keys.
 */
export const judgeClocked = (c: Clocked): void => {
	const field = headField(c.head)
	if (c.kind === "not held") {
		const first = succeeded(
			generate({
				installation: compile(signedBefore("user and email"), asDrafted),
				timestamp: draftedAt(1),
				previous: fromEmpty,
				workload: noWorkload,
				declared: noDeclarations,
				name: "first"
			})
		)
		const drafted = generate({
			installation: compile(signedAfter(c.head), asDrafted),
			timestamp: draftedAt(2),
			previous: fromSnapshot(first.snapshot),
			workload: noWorkload,
			declared: noDeclarations,
			name: "second"
		})
		const reason =
			c.head === "clock"
				? refused(
						drafted,
						"InstantRefused",
						"a clock added over rows its new key would not keep apart"
					).reason
				: refused(
						drafted,
						"PlaceRefused",
						"a place added over rows its new key would not keep apart"
					).reason
		assert.deepEqual(
			reason._tag === "InstantRefused" || reason._tag === "PlaceRefused"
				? { relation: reason.relation, field: reason.field, rule: reason.rule }
				: reason,
			{
				relation: "SignIn",
				field,
				rule: { kind: "addedOverRows", key: ["user", field], held: ["user", "email"] }
			},
			"the refusal names the head, the new key and the old one"
		)
		return
	}
	const m = migrationOf(signedBefore("user"), signedAfter(c.head))
	const state = migrated(m, [
		{ relation: "SignIn", rows: Arr.map(c.users, (user) => ({ user, email: user + 100 })) }
	])
	const column = (name: string) => fieldColumn(m.second, "SignIn", name)
	const value = c.head === "clock" ? `${modelInstant.micros}` : "0"
	assert.deepEqual(
		rowsOf(m, state, "SignIn", (cell) => `${cell(column("user"))} ${cell(column(field))}`),
		Arr.sort(
			Arr.map(c.users, (user) => `${user} ${value}`),
			Order.String
		),
		"every stored sign-in takes the migration's one value of its head"
	)
	assertFresh(m, state)
}

/**
 * A clock that joins a unit's scope over stored rows (deploy/diff/diff.ts headJoined): the unit User over Visit, whose
 * clock its head already counts on, and SignIn, keyed by user, which the migration re-keys by user and a clock, so its
 * every stored row takes the migration's instant, a clock of User's scope. `signIns` are the users with a stored
 * sign-in, `visits` the stored visits, each at an instant around the migration's.
 */
export interface Joined {
	readonly signIns: ReadonlyArray<number>
	readonly visits: ReadonlyArray<{ readonly user: number; readonly at: number }>
}

export type JoinedFeature =
	| "a clock joining its unit's head over stored rows"
	| "a visit past the migration's instant"
	| "a user of visits alone"
	| "over no row"

/** The migration's instant, as the model's every transaction reads it, in microseconds. */
const migrationMicros = Number(modelInstant.micros)

/** Stored sign-ins and visits, distinct by their keys, each visit's instant up to three microseconds either side of
 * the migration's. */
export const joinedGen: Gen<Joined> = (source) => ({
	signIns: source.draw(keysGen({ min: 0, max: 4 })),
	visits: Arr.dedupeWith(
		source.draw(
			array(
				(s) => ({ user: s.draw(between(1, 6)), at: migrationMicros + s.draw(between(-3, 3)) }),
				{ min: 0, max: 5 }
			)
		),
		(a, b) => a.user === b.user && a.at === b.at
	)
})

export const joinedNotes = (j: Joined): ReadonlyArray<JoinedFeature> => [
	...(j.signIns.length > 0 ? (["a clock joining its unit's head over stored rows"] as const) : []),
	...(Arr.some(j.visits, (v) => v.at > migrationMicros)
		? (["a visit past the migration's instant"] as const)
		: []),
	...(Arr.some(j.visits, (v) => !j.signIns.includes(v.user))
		? (["a user of visits alone"] as const)
		: []),
	...(j.signIns.length === 0 && j.visits.length === 0 ? (["over no row"] as const) : [])
]

/** The unit User over Visit, a clock of child user, and SignIn, keyed by user, or by user and its own clock once
 * `clocked`. */
const usersOf = (clocked: boolean) =>
	schema(
		"Backfill",
		[
			relation("Visit", { user: pg.integer, at: instant }, ["user", "at"]),
			clocked
				? relation("SignIn", { user: pg.integer, at: instant, email: pg.integer }, ["user", "at"])
				: relation("SignIn", { user: pg.integer, email: pg.integer }, ["user"])
		],
		[unit("User", { user: pg.integer })]
	)

/**
 * What the joined case's migration must do: every stored sign-in takes the migration's instant (modelInstant), and the
 * unit's head stands, at each user, at the greatest instant the unit holds there, of its visits and its sign-ins
 * alike, so every later stamp of the unit is above every row it holds (README "Instants"); and the catalog is the one
 * the target installs from nothing.
 */
export const judgeJoined = (j: Joined): void => {
	const m = migrationOf(usersOf(false), usersOf(true))
	const state = migrated(m, [
		{ relation: "SignIn", rows: Arr.map(j.signIns, (user) => ({ user, email: user + 100 })) },
		{ relation: "Visit", rows: j.visits }
	])
	const user = fieldColumn(m.second, "SignIn", "user")
	const head = m.second.names.head({ kind: "unit", unit: "User" })
	const greatest = new Map<number, number>()
	for (const { user: u, at } of [
		...Arr.map(j.signIns, (u) => ({ user: u, at: migrationMicros })),
		...j.visits
	]) {
		greatest.set(u, Math.max(greatest.get(u) ?? at, at))
	}
	assert.deepEqual(
		Arr.sort(
			Arr.map(
				defined(state.tables.get(head.name), "the unit's head table").rows,
				(row) => `${intCell(row, user)} ${intCell(row, "__instant")}`
			),
			Order.String
		),
		Arr.sort(
			Arr.map([...greatest], ([u, at]) => `${u} ${at}`),
			Order.String
		),
		"the unit's head stands at each user's greatest instant, of its visits and its sign-ins alike"
	)
	assertFresh(m, state)
}

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

const pieces = ["", "a", " c", "\u{1F600}", "é"] as const

export const backfillGen: Gen<Backfill> = weighted<Backfill>([
	[
		1,
		(source) => {
			const owners = source.draw(between(1, 3))
			return {
				kind: "fold",
				family: source.draw(element(foldFamilies)),
				owners,
				stored: source.draw(membersGen(owners))
			}
		}
	],
	[
		1,
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
		}
	],
	[1, map(between(1, 3), (owners) => ({ kind: "new members", owners }))],
	[
		1,
		(source) => {
			const owners = source.draw(between(1, 3))
			return {
				kind: "renamed",
				family: source.draw(element(renamedFamilies)),
				renaming: source.draw(element(renamings)),
				owners,
				stored: source.draw(membersGen(owners))
			}
		}
	],
	[
		1,
		(source) => {
			const owners = source.draw(between(1, 3))
			return {
				kind: "kind changed",
				change: source.draw(element(kindChanges)),
				owners,
				stored: source.draw(membersGen(owners))
			}
		}
	],
	[
		1,
		(source) => {
			const owners = source.draw(between(1, 3))
			return {
				kind: "end moved",
				move: source.draw(element(endMoves)),
				owners,
				stored: source.draw(membersGen(owners))
			}
		}
	],
	[
		1,
		(source) => {
			const owners = source.draw(between(1, 3))
			return {
				kind: "stored key",
				fate: source.draw(element(storedKeyFates)),
				owners,
				stored: source.draw(membersGen(owners))
			}
		}
	],
	[1, () => ({ kind: "keyed tree" })]
])

export type BackfillFeature =
	| (typeof foldFamilies)[number]
	| "concat"
	| "new members"
	| "an owner with no member"
	| "an owner of three members"
	| "members stored out of key order"
	| "a negative step"
	| "a piece beyond ASCII"
	| "an empty piece"
	| `renamed: ${RenamedFamily}`
	| `renamed: ${Renaming}`
	| KindChange
	| `end moved: ${EndMove}`
	| `stored key ${StoredKeyFate}`
	| "a keyed tree owing a key check"
	| "a place over stored rows"
	| "a place over a level"
	| "a place carried into attempts and their values"
	| "a group of three places"
	| "places stored out of their order"

export const notesOf = (b: Backfill): ReadonlyArray<BackfillFeature> => {
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
		case "stored key":
			return [`stored key ${b.fate}`, ...members(b.owners, b.stored)]
		case "keyed tree":
			return ["a keyed tree owing a key check"]
		case "place over a level":
			return ["a place over a level"]
		case "place": {
			const groups = Arr.flatMap(
				upTo(2, (child) => child),
				(child) =>
					upTo(2, (item) => Arr.filter(b.stored, (s) => s.child === child && s.item === item))
			)
			return [
				"a place over stored rows",
				...(Arr.some(b.attempts, (a) => a.values > 0)
					? (["a place carried into attempts and their values"] as const)
					: []),
				...(Arr.some(groups, (g) => g.length >= 3) ? (["a group of three places"] as const) : []),
				...(Arr.some(groups, (g) => unsorted(Arr.map(g, (s) => s.stage)))
					? (["places stored out of their order"] as const)
					: [])
			]
		}
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
		case "ordered by line, folding a predecessor copy":
			return orderedOverCopies
	}
}

/** The columns a draft's SQL adds to each table, by its name, read off the text its files hold as PostgreSQL's scanner
 * reads it: each ADD COLUMN of an ALTER TABLE "<schema>"."<table>", each taking the table's next attribute number. A
 * statement the file holds commented, a loss undecided, is no statement. */
const spelledAdds = (draft: GenerateResult): ReadonlyMap<string, number> => {
	const out = new Map<string, number>()
	for (const file of draft.folder.files) {
		for (const statement of splitStatements(new ChunkView(file.text))) {
			const tokens = statementTokens(statement)
			const [alter, table, , dot, name] = tokens
			const word = (i: number, upper: string): boolean => {
				const t = tokens[i]
				return t?.kind === "word" && t.upper === upper
			}
			if (
				alter?.kind !== "word" ||
				alter.upper !== "ALTER" ||
				table?.kind !== "word" ||
				table.upper !== "TABLE" ||
				dot?.kind !== "punct" ||
				name?.kind !== "quotedIdent"
			) {
				continue
			}
			const adds = Arr.filter(tokens, (_, i) => word(i, "ADD") && word(i + 1, "COLUMN"))
			out.set(name.text, (out.get(name.text) ?? 0) + adds.length)
		}
	}
	return out
}

/** The catalog a migration leaves is the one its target installs from nothing, every constraint validated; and each
 * table both drafts install records the attribute numbers its migrations spent: the first draft's, then one per column
 * the second draft's SQL adds to it (spelledAdds), whatever value it adds it under, since PostgreSQL never reuses one. */
const assertFresh = (m: Migration, state: State): void => {
	assert.deepEqual(catalogOf(state), catalogOf(freshState(m.second.names.schema, m.second)))
	const adds = spelledAdds(m.secondDraft)
	for (const [name, r] of Rec.toEntries(m.secondDraft.snapshot.theory.relations)) {
		const was = m.firstDraft.snapshot.theory.relations[name]
		if (r.kind === "relation" && was?.kind === "relation" && was.ident === r.ident) {
			assert.equal(
				r.attnums,
				was.attnums + (adds.get(r.ident) ?? 0),
				`${name}: the attribute numbers its first draft recorded, and one per column the second's SQL adds`
			)
		}
	}
}

/** What a folded family drawn over `stored` and then reshaped must hold: the reference fold's values over the stored
 * rows in key order, and the catalog its reshaped target installs from nothing. */
const judgeReshapedFold = (r: Reshaped, owners: number, stored: ReadonlyArray<Stored>): void => {
	const ids = ownersOf(owners)
	const state = continued(
		r.reshaped.migration,
		migrated(r.drawn.migration, foldRows(r.drawn, ids, stored))
	)
	assert.deepEqual(foldObserved(r.reshaped, state), foldExpected(ids, stored, r.reshaped.stepped))
	assertFresh(r.reshaped.migration, state)
}

/** What a family's backfill must leave, judged against its references, its catalog and its plan's order. */
export const judgeBackfill = (b: Backfill): void => {
	switch (b.kind) {
		case "fold": {
			const c = foldCaseOf(b.family)
			const owners = ownersOf(b.owners)
			const state = migrated(c.migration, foldRows(c, owners, b.stored))
			assert.deepEqual(foldObserved(c, state), foldExpected(owners, b.stored, c.stepped))
			assert.deepEqual(copiesObserved(c, state), copiesExpected(c, owners, b.stored))
			assertFresh(c.migration, state)
			assertBackfillOrder(c.migration, foldColumns(c))
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
		case "stored key":
			return judgeStoredKey(b.fate, b.owners, b.stored)
		case "keyed tree": {
			const steps = keyedTree.draft.plan.steps
			assert.notDeepEqual(
				owedKeyChecks(keyedTree.installation, keyedTree.previous, steps),
				[],
				"the keyed tree's backfill owes a check of the key its derivations meet Node's rows at"
			)
			assert.deepEqual(
				missingKeyChecks(keyedTree.installation, keyedTree.previous, steps),
				[],
				"the keyed tree's backfill checks every key its derivations rely on before any of them runs"
			)
			assert.deepEqual(perRowReads(steps), [], "no backfill statement reads a row once per row")
			assert.deepEqual(recursions(steps), [], "no backfill statement recurs")
			assert.deepEqual(
				rewrittenTables(steps),
				[],
				"the backfill writes each table's rows by one UPDATE"
			)
			return
		}
		case "place":
			return judgePlaces(b.stored, b.attempts)
		case "place over a level":
			assert.deepEqual(
				Arr.sort(placedLevelUpdates(), Order.String),
				["placed.attempt", "placed.session", "placed.value"],
				"each of the level's tables the backfill draws on is written by one UPDATE in the level's schema"
			)
			return
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

/** The fields a removal drops, as declared: the counted family's drawn and copied ones. */
const countedDrops: ReadonlyArray<readonly [string, string]> = [
	["Owner", "n"],
	["Owner", "end"],
	["Member", "ownerTag"]
]

/** The counted family's relations drawn over a caller's values: each drawn field written first, then drawn anew. */
const toDrawn = migrationOf(countedWritten, countedAfter)

/** What becomes of a family once its rows are drawn: removed, its fields left to the caller, or drawn anew. */
export type Reversal =
	| {
			readonly kind: "a counted family removed"
			readonly owners: number
			readonly stored: ReadonlyArray<Stored>
	  }
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

export const reversalGen: Gen<Reversal> = weighted<Reversal>([
	[
		1,
		(source) => {
			const owners = source.draw(between(1, 3))
			return { kind: "a counted family removed", owners, stored: source.draw(membersGen(owners)) }
		}
	],
	[
		1,
		(source) => {
			const owners = source.draw(between(1, 3))
			return { kind: "left to its caller", owners, stored: source.draw(membersGen(owners)) }
		}
	],
	[
		1,
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
	]
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
	assert.deepEqual(catalogOf(removed), catalogOf(freshState(m.first.names.schema, m.first)))
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

export const judgeReversal = (r: Reversal): void => {
	switch (r.kind) {
		case "a counted family removed":
			return assertRemoved(
				countedCase.migration,
				foldRows(countedCase, ownersOf(r.owners), r.stored),
				countedDrops
			)
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
						migrationOf(countedWritten, countedWritten).first
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
			assert.deepEqual(
				foldObserved(drawnCase, state),
				foldExpected(owners, r.stored, drawnCase.stepped)
			)
			assert.deepEqual(
				copiesObserved(drawnCase, state),
				copiesExpected(drawnCase, owners, r.stored)
			)
			assertFresh(toDrawn, state)
		}
	}
}
