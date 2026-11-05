/**
 * The columns and references a family installs (physical/ddl/tables.ts), against the law model's natives, a second
 * representation of what the installation must hold:
 *
 * - every law column, drawn or generated, is its own object of one `ALTER TABLE ... ADD COLUMN` after its table, a drawn
 *   one a plain column with no generation, so NOT NULL like every column, typed by its field's base, and every role
 *   that writes its table through column grants holds INSERT on it (D13, D14); a generated field holds no INSERT or
 *   UPDATE grant; a CHECK that reads a law column is its own `ALTER TABLE ... ADD CONSTRAINT` after it;
 * - a counted family's first migration drafts, and so does a second that adds a counted family to relations that
 *   stand, its drawn columns each an ADD COLUMN of the draft;
 * - every foreign key is installed ON UPDATE CASCADE exactly where its native cascades (a family's owner axis), and
 *   DEFERRABLE INITIALLY DEFERRED exactly where its native defers; a PERIOD foreign key takes its native's deferral and
 *   never an action.
 *
 * The schemas: an ordered family with folds and a generated field, a counted family with folds, and a tree, each over
 * one roster and a set over it, written whole by one role and through a query entry by another.
 */
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { NativeOf } from "#compiler/ir/law.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import {
	accumulated,
	Bits,
	bits,
	closedId,
	drawn,
	generated,
	natural,
	pg,
	uuid
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	counted,
	fin,
	fold,
	login,
	Monoid,
	on,
	ordered,
	relation,
	schema,
	tree
} from "#compiler/public/schema.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf, role } from "#compiler/schema/world.ts"
import type { SqlStatement, TableConstraint } from "#compiler/sql/ast.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	asDrafted,
	compile,
	type DeploySubject,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import { planStatements } from "#test/support/migrate/review.ts"
import { checkedStatements } from "#test/support/oracle/verify/index.ts"
import { owning } from "#test/support/policy.ts"

const Flag = closed("Flag", ["on", "off"])

const Order = relation(
	"Order",
	{
		id: uuid,
		n: drawn(natural),
		total: accumulated(pg.bigint, 0n),
		seen: accumulated(bits(Flag), Bits.of(Flag, []))
	},
	["id"]
)
const Line = relation.generated(
	"Line",
	{
		order: uuid,
		at: drawn(natural),
		qty: pg.bigint,
		flags: bits(Flag),
		before: accumulated(pg.bigint, 0n),
		after: accumulated(pg.bigint, 0n)
	},
	["order", "at"],
	(r) => ({ more: generated(pg.bigint, Compute.greatest(r.qty, Compute.literal(pg.bigint, 0n))) })
)
const lines = ordered(on(Line, "order", "at"), fin(Order, "n"))

const Bag = relation("Bag", { id: uuid, k: drawn(natural), size: accumulated(natural, 0n) }, ["id"])
const Item = relation("Item", { id: uuid, bag: uuid, kind: closedId(Flag) }, ["id"])
const items = counted(on(Item, "bag"), fin(Bag, "k"))

const Node = relation(
	"Node",
	{
		id: uuid,
		parent: uuid,
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		doc: uuid
	},
	["id"]
)
const nodes = tree(on(Node, "parent", "at"), fin(Node, "children"), { root: "doc" })

const Families = schema("Families", { Flag, Order, Line, Bag, Item, Node }, [
	lines,
	fold(lines, Monoid.sum, on(Line, "order", "qty", "before", "after"), on(Order, "id", "total")),
	fold(lines, Monoid.or, on(Line, "order", "flags"), on(Order, "id", "seen")),
	items,
	fold(items, Monoid.count, on(Item, "bag"), on(Bag, "id", "size")),
	nodes
])

const owned = owning(Families)

const installation = (): Installation => {
	const writer = role(Families, "writer", Families.relations, {
		write: ["Order", "Line", "Bag", "Item", "Node"],
		refresh: []
	})
	/** A role that writes Line through a query entry, so its writes are column grants. */
	const clerk = role(
		Families,
		"clerk",
		{
			Order: Families.relations.Order,
			Lines: query(Families).rule((r) => {
				const { order, at, qty, flags, before, after, more } = v(Line, "line")
				return r
					.match(Line, { order, at, qty, flags, before, after, more })
					.find({ order, at, qty, flags, before, after, more })
			})
		},
		{ write: ["Lines"], refresh: [] }
	)
	/** A role reading Item through a query entry, a closed id among its outputs, so its view decodes it. */
	const viewer = role(
		Families,
		"viewer",
		{
			Kinds: query(Families).rule((r) => {
				const { id, bag, kind } = v(Item, "item")
				return r.match(Item, { id, bag, kind }).find({ id, kind })
			})
		},
		{ write: [], refresh: [] }
	)
	const logins = [login(Families, "desk", [writer, clerk, viewer])]
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				owned.installation,
				Arr.map(logins, (l) =>
					succeeded(ownLogin(defined(loginDescOf(l), "a login built by login(...)")))
				),
				[],
				firstCodebook(rostersOf(owned))
			)
		)
	)
}

type CreateTable = Extract<SqlStatement, { readonly kind: "createTable" }>

const tableOf = (i: Installation, relation: string): CreateTable =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				i.statements,
				(s): s is CreateTable =>
					s.kind === "createTable" && s.table.name === i.names.relation(relation).name
			)
		),
		`the table of ${relation}`
	)

/** Every foreign key the installation adds, by its constraint's name. */
const foreignKeysOf = (
	i: Installation
): ReadonlyMap<string, Extract<TableConstraint, { readonly kind: "foreignKey" }>> =>
	new Map(
		Arr.flatMap(i.statements, (s) =>
			s.kind === "alterTable"
				? Arr.flatMap(s.actions, (a) =>
						a.kind === "addConstraint" && a.constraint.kind === "foreignKey"
							? [[a.constraint.name, a.constraint] as const]
							: []
					)
				: []
		)
	)

/** NP's repro: one counted family over an owner's drawn count. */
const Owner = relation("Owner", { id: pg.int4, n: drawn(natural) }, ["id"])
const Member = relation("Member", { id: pg.int4, g: pg.int4 }, ["id"])
const counting = schema("repro", { Owner, Member }, [counted(on(Member, "g"), fin(Owner, "n"))])
/** The same relations before the family: an owner with no count, a member with its group. */
const Bare = relation("Owner", { id: pg.int4 }, ["id"])
const before = schema("repro", { Owner: Bare, Member }, [])

/** The draft of `subject` after `previous`, as `grizzle generate` drafts it. */
const drafted = (subject: DeploySubject, previous: Previous, ordinal: number) =>
	succeeded(
		generate({
			installation: compile(subject, asDrafted),
			timestamp: draftedAt(ordinal),
			previous,
			workload: noWorkload,
			declared: noDeclarations,
			name: `step_${ordinal}`
		})
	)

describe("a family's columns and references", () => {
	it.effect("a family's first migration drafts", () =>
		Effect.sync(() => {
			const first = drafted(counting, fromEmpty, 1)
			assert.ok(first.snapshot.fingerprint.length > 0, "the draft records a snapshot")
			const families = drafted(Families, fromEmpty, 1)
			assert.ok(
				families.snapshot.fingerprint.length > 0,
				"an ordered family with folds, a counted one and a tree draft too"
			)
		})
	)

	it.effect("a counted family added to relations that stand drafts, each drawn column added", () =>
		Effect.sync(() => {
			const first = drafted(before, fromEmpty, 1)
			const second = drafted(counting, fromSnapshot(first.snapshot), 2)
			const installation = compile(counting, asDrafted)
			const memberColumns = Arr.flatMap(installation.laws.natives, (n) =>
				n.object.kind === "LawColumn" &&
				n.object.value.kind === "drawn" &&
				n.object.relation.name === "Member"
					? [n.object.column]
					: []
			)
			assert.ok(memberColumns.length > 0, "the counted family draws columns on Member")
			const addedColumns = Arr.flatMap(planStatements(second.plan), (s) =>
				s.kind === "alterTable"
					? Arr.flatMap(s.actions, (a) =>
							a.kind === "addColumn" ||
							a.kind === "addColumnPlaceholder" ||
							a.kind === "addColumnDefault"
								? [a.column.name]
								: []
						)
					: []
			)
			for (const column of memberColumns) {
				assert.ok(Arr.contains(addedColumns, column), `the draft adds ${column}`)
			}
		})
	)

	it.effect(
		"every statement keeps the emission discipline, a decoding query entry's view included",
		() =>
			Effect.sync(() => {
				const i = installation()
				const decoded = `${i.names.column("Item", "kind")}_name`
				const decoding = Arr.filter(
					i.statements,
					(s) => s.kind === "createView" && Arr.contains(s.columns, decoded)
				)
				assert.ok(decoding.length > 0, "a view decodes Item's closed id")
				checkedStatements(i.statements, "installation statement")
			})
	)

	it.effect(
		"drawn law columns, generated fields and foreign key actions follow their natives",
		() =>
			Effect.sync(() => {
				const i = installation()
				const natives = i.laws.natives
				const drawnColumns = Arr.flatMap(natives, (n) =>
					n.object.kind === "LawColumn" && n.object.value.kind === "drawn" ? [n.object] : []
				)
				assert.ok(drawnColumns.length > 0, "the families draw law columns")
				const columnGrants = Arr.filter(
					i.statements,
					(s): s is Extract<SqlStatement, { readonly kind: "grantColumns" }> =>
						s.kind === "grantColumns" && s.privilege === "INSERT"
				)
				for (const o of drawnColumns) {
					const table = tableOf(i, o.relation.name)
					assert.ok(
						!Arr.some(table.columns, (c) => c.name === o.column),
						`${o.column} is no column of ${o.relation.name}'s CREATE TABLE`
					)
					const object = defined(
						Option.getOrUndefined(
							Arr.findFirst(
								i.manifest.objects,
								(m) => m.kind === "lawColumn" && Str.endsWith(`.${o.column}`)(m.ident)
							)
						),
						`the law column object of ${o.column}`
					)
					const [statement, ...more] = object.ddl
					assert.equal(more.length, 0, `${o.column}'s object is one statement`)
					const added =
						statement?.kind === "alterTable" && statement.actions.length === 1
							? statement.actions[0]
							: undefined
					assert.ok(
						added?.kind === "addColumn" && added.column.name === o.column,
						`${o.column}'s object is its ALTER TABLE ... ADD COLUMN`
					)
					assert.equal(added.column.generated, undefined, `${o.column} is no generated column`)
					for (const g of Arr.filter(columnGrants, (g) => g.table.name === table.table.name)) {
						assert.ok(Arr.contains(g.columns, o.column), `${g.to} may insert ${o.column}`)
					}
				}
				const line = tableOf(i, "Line")
				const more = defined(
					Option.getOrUndefined(
						Arr.findFirst(line.columns, (c) => c.name === i.names.column("Line", "more"))
					)
				)
				assert.equal(
					more.generated?.kind,
					"stored",
					"a generated field is GENERATED ALWAYS AS (e) STORED"
				)
				const lineGrants = Arr.filter(columnGrants, (g) => g.table.name === line.table.name)
				assert.ok(lineGrants.length > 0, "a role writes Line through column grants")
				for (const g of lineGrants) {
					assert.ok(!Arr.contains(g.columns, more.name), "no role inserts a generated field")
				}

				const installed = foreignKeysOf(i)
				for (const n of natives) {
					if (n.namespace !== "constraint") {
						continue
					}
					const o = n.object
					if (o.kind !== "ForeignKey" && o.kind !== "PeriodForeignKey") {
						continue
					}
					const fk = defined(
						installed.get(identifierOf(n.named)),
						`the foreign key ${identifierOf(n.named)}`
					)
					assert.equal(
						fk.deferrable,
						o.deferrable ? "INITIALLY DEFERRED" : undefined,
						`${fk.name} defers exactly where its native does`
					)
					const action: NativeOf<"ForeignKey">["onUpdate"] =
						o.kind === "ForeignKey" ? o.onUpdate : "noAction"
					assert.equal(
						fk.onUpdate,
						action === "cascade" ? "CASCADE" : undefined,
						`${fk.name} cascades exactly where its native does`
					)
				}
			})
	)
})
