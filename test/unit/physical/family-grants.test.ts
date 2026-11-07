/**
 * What a role that writes a family's member holds on the family's owner O (physical/ddl/roles.ts, rows-first), over
 * generated worlds: two roles, each writing each relation whole, through a query entry that holds every row, through
 * one narrowed by a literal or by a join, or not at all, over a counted family with a fold and a copy and an ordered
 * one, each owner mutable or not, and a serial field on the owner and on a relation of its own.
 *
 * - **Exact grants:** a role's grants on an owner are exactly its grants there with no member written (the control:
 *   the same world, every member write dropped) together with the rule: column SELECT on O's key, count, ends and
 *   copies, exactly what the family's read flight reads, and, when O is mutable, column UPDATE on its count and ends,
 *   exactly what its count statement sets; nothing when the role writes O whole, and no INSERT, DELETE or UPDATE on any
 *   other field of O.
 * - **The owner rows a member writer reaches:** for a role that writes a member and not its owner, the owner rows its
 *   policy on O admits (every row where O has no row security) are exactly those whose groups its policy on the member
 *   admits: evaluated on the host, each owner row against the member row it is the owner of, which agrees with it at
 *   the group and every copy. A role that also writes O admits at least those. Row security stands on exactly the
 *   tables some writer narrows, a member writer's translated membership among O's writers, one policy per role there.
 * - **Refusals:** a world is refused exactly when a role writes a member, not its owner whole, through a filter reading
 *   a field that is neither its group nor a copy, or writes the owner through a narrowed entry whose filter is not the
 *   members' translated; the refusal names the role and the family.
 * - **The audit naming rule:** every installed statement, a translated policy's included, passes the SQL audit.
 * - **The advance closure:** every role that holds INSERT on a table with a serial field holds EXECUTE on the field's
 *   advance function, and no other role does: a member writer, holding SELECT and UPDATE on its owner, holds none.
 *
 * Oracles: the rule restated over the case, the control installation for the grants the role's own entries make, and a
 * host evaluator of the policies' predicates over literal rows that shares no code with the installer's rendering.
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { isNonEmpty } from "#compiler/core/nonempty.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn as drawnField, natural, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	counted,
	fin,
	fold,
	login,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf, role } from "#compiler/schema/world.ts"
import type { Expr, SqlStatement } from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkedStatements } from "#test/support/oracle/verify/index.ts"
import { owning } from "#test/support/policy.ts"

/** A text field over lowercase words, every literal of the world one. */
const word = str.regex("^[a-z]{1,8}$")

const U1 = "00000000-0000-4000-8000-000000000001"
const U2 = "00000000-0000-4000-8000-000000000002"

const Store = relation(
	"Store",
	{
		id: uuid,
		region: word,
		label: word,
		seq: pg.bigserial,
		items: drawnField(natural),
		stock: accumulated(pg.bigint, 0n)
	},
	["id"]
)
const Item = relation("Item", { id: uuid, store: uuid, region: word, qty: pg.bigint }, ["id"])
const Open = relation("Open", { store: uuid }, ["store"])
const Shelf = relation("Shelf", { id: uuid, tag: word, slots: drawnField(natural) }, ["id"])
const Slot = relation("Slot", { shelf: uuid, at: drawnField(natural), what: word }, ["shelf", "at"])
const Ticket = relation("Ticket", { no: pg.bigserial, note: word }, ["no"])
const items = counted(on(Item, "store"), fin(Store, "items"))
const slots = ordered(on(Slot, "shelf", "at"), fin(Shelf, "slots"))

const relations = { Store, Item, Open, Shelf, Slot, Ticket }

/** The world's schema: the counted family of Items with a sum into Store's stock and Store's region copied into each
 * Item, the ordered family of Slots, and each owner mutable when `mutability` says so. */
const schemaOf = (mutability: Mutability) =>
	schema("Shops", relations, [
		items,
		fold(items, Monoid.sum, on(Item, "store", "qty"), on(Store, "id", "stock")),
		contained(on(Item, "store", "region"), on(Store, "id", "region")),
		slots,
		...(mutability.Store ? [mutable(Store)] : []),
		...(mutability.Shelf ? [mutable(Shelf)] : [])
	])

type Owner = "Store" | "Shelf"
type Member = "Item" | "Slot"
type Written = Owner | Member | "Ticket"

const owners: readonly [Owner, Owner] = ["Store", "Shelf"]
const memberOf: { readonly [O in Owner]: Member } = { Store: "Item", Shelf: "Slot" }
const familyOf: { readonly [O in Owner]: string } = { Store: "Store.items", Shelf: "Shelf.slots" }

/**
 * The rule restated per owner, by field: what the read flight reads (the key, the count, the ends and the copies) and
 * what the count statement sets (the count and the ends). Store's label and seq are written fields no member writer
 * reaches.
 */
const readFlight: { readonly [O in Owner]: ReadonlyArray<string> } = {
	Store: ["id", "region", "items", "stock"],
	Shelf: ["id", "slots"]
}
const countSets: { readonly [O in Owner]: ReadonlyArray<string> } = {
	Store: ["items", "stock"],
	Shelf: ["slots"]
}

/** How a role writes each relation: `none`, `whole`, `all` (a query entry holding every row), or a narrowing query
 * entry: by the group (`group`), by a copy (`copy`), through a join (`joined`), or by another field (`other`). */
const writesOf = {
	Store: ["none", "whole", "all", "copy"],
	Item: ["none", "whole", "all", "group", "copy", "joined", "other"],
	Shelf: ["none", "whole", "all", "other"],
	Slot: ["none", "whole", "all", "group", "other"],
	Ticket: ["none", "whole", "all"]
} as const

type WriteOf<T extends Written> = (typeof writesOf)[T][number]
type Writes = { readonly [T in Written]: WriteOf<T> }
type Mutability = { readonly [O in Owner]: boolean }

const roleNames = ["clerk", "keeper"] as const
type RoleName = (typeof roleNames)[number]

/** A point: how each role writes each relation, and each owner's mutability. */
interface World {
	readonly writes: { readonly [R in RoleName]: Writes }
	readonly mutability: Mutability
}

const writesGen: Gen<Writes> = (source) => ({
	Store: source.draw(element(writesOf.Store)),
	Item: source.draw(element(writesOf.Item)),
	Shelf: source.draw(element(writesOf.Shelf)),
	Slot: source.draw(element(writesOf.Slot)),
	Ticket: source.draw(element(writesOf.Ticket))
})

const worldGen: Gen<World> = (source) => ({
	writes: { clerk: source.draw(writesGen), keeper: source.draw(writesGen) },
	mutability: { Store: source.draw(boolean), Shelf: source.draw(boolean) }
})

/** The query entry of each narrowing or every-row write, by its name in the role. */
const queryEntry = (
	s: ReturnType<typeof schemaOf>,
	t: Written,
	w: string
): readonly [string, EntryValue] => {
	const q = query(s)
	switch (`${t}:${w}`) {
		case "Store:all":
			return [
				"AllStores",
				q.rule((r) => {
					const { id, region, label, seq, items: n, stock } = v(Store, "store")
					return r
						.match(Store, { id, region, label, seq, items: n, stock })
						.find({ id, region, label, seq, items: n, stock })
				})
			]
		case "Store:copy":
			return [
				"NorthStores",
				q.rule((r) => {
					const { id, label, seq, items: n, stock } = v(Store, "store")
					return r
						.match(Store, { id, region: "north", label, seq, items: n, stock })
						.find({ id, label, seq, items: n, stock })
				})
			]
		case "Item:all":
			return [
				"AllItems",
				q.rule((r) => {
					const { id, store, region, qty } = v(Item, "item")
					return r.match(Item, { id, store, region, qty }).find({ id, store, region, qty })
				})
			]
		case "Item:group":
			return [
				"FirstStoreItems",
				q.rule((r) => {
					const { id, region, qty } = v(Item, "item")
					return r.match(Item, { id, store: U1, region, qty }).find({ id, region, qty })
				})
			]
		case "Item:copy":
			return [
				"NorthItems",
				q.rule((r) => {
					const { id, store, qty } = v(Item, "item")
					return r.match(Item, { id, store, region: "north", qty }).find({ id, store, qty })
				})
			]
		case "Item:joined":
			return [
				"OpenItems",
				q.rule((r) => {
					const { id, store, region, qty } = v(Item, "item")
					return r
						.match(Item, { id, store, region, qty })
						.match(Open, { store })
						.find({ id, store, region, qty })
				})
			]
		case "Item:other":
			return [
				"OneItems",
				q.rule((r) => {
					const { id, store, region } = v(Item, "item")
					return r.match(Item, { id, store, region, qty: 1n }).find({ id, store, region })
				})
			]
		case "Shelf:all":
			return [
				"AllShelves",
				q.rule((r) => {
					const { id, tag, slots: n } = v(Shelf, "shelf")
					return r.match(Shelf, { id, tag, slots: n }).find({ id, tag, slots: n })
				})
			]
		case "Shelf:other":
			return [
				"TaggedShelves",
				q.rule((r) => {
					const { id, slots: n } = v(Shelf, "shelf")
					return r.match(Shelf, { id, tag: "a", slots: n }).find({ id, slots: n })
				})
			]
		case "Slot:all":
			return [
				"AllSlots",
				q.rule((r) => {
					const { shelf, at, what } = v(Slot, "slot")
					return r.match(Slot, { shelf, at, what }).find({ shelf, at, what })
				})
			]
		case "Slot:group":
			return [
				"FirstShelfSlots",
				q.rule((r) => {
					const { at, what } = v(Slot, "slot")
					return r.match(Slot, { shelf: U1, at, what }).find({ at, what })
				})
			]
		case "Slot:other":
			return [
				"XSlots",
				q.rule((r) => {
					const { shelf, at } = v(Slot, "slot")
					return r.match(Slot, { shelf, at, what: "x" }).find({ shelf, at })
				})
			]
		case "Ticket:all":
			return [
				"AllTickets",
				q.rule((r) => {
					const { no, note } = v(Ticket, "ticket")
					return r.match(Ticket, { no, note }).find({ no, note })
				})
			]
	}
	return assert.fail(`no query entry for ${t}:${w}`)
}

const written: ReadonlyArray<Written> = ["Store", "Item", "Shelf", "Slot", "Ticket"]

/** A role: Open read whole, and each relation it writes by the entry its write names. */
const roleOf = (s: ReturnType<typeof schemaOf>, name: RoleName, w: Writes) => {
	const entries: Record<string, EntryValue> = { Open: s.relations.Open }
	const names: Array<string> = []
	for (const t of written) {
		const write: string = w[t]
		if (write === "none") {
			continue
		}
		if (write === "whole") {
			entries[t] = s.relations[t]
			names.push(t)
			continue
		}
		const [entry, value] = queryEntry(s, t, write)
		entries[entry] = value
		names.push(entry)
	}
	return role(s, name, entries, { write: names, refresh: [] })
}

/** The world with every member write dropped: the control a role's own entries' grants are read from. */
const withoutMembers = (w: World): World => ({
	...w,
	writes: {
		clerk: { ...w.writes.clerk, Item: "none", Slot: "none" },
		keeper: { ...w.writes.keeper, Item: "none", Slot: "none" }
	}
})

const compiled = (w: World) => {
	const s = schemaOf(w.mutability)
	const owned = owning(s)
	const logins = [
		login(s, "desk", [roleOf(s, "clerk", w.writes.clerk), roleOf(s, "keeper", w.writes.keeper)])
	]
	return compileInstallation(
		owned,
		completeInstallOptions(
			owned,
			owned.installation,
			Arr.map(logins, (l) => {
				const own = ownLogin(defined(loginDescOf(l), "a login built by login(...)"))
				return own.ok ? own.value : assert.fail(own.error.message)
			}),
			[],
			firstCodebook(rostersOf(owned))
		)
	)
}

/** Whether `w` writes `t` narrowed: through a query entry with a filter. */
const narrows = (w: string): boolean => w !== "none" && w !== "whole" && w !== "all"

/** The refusal the rule expects, the role and family it names: a member writer that does not write the owner whole,
 * whose member filter reads neither its group nor a copy, or whose owner entry is narrowed by any filter but the
 * members' translated one (only NorthStores with NorthItems agree). */
const expectedRefusals = (
	w: World
): ReadonlyArray<{ readonly role: RoleName; readonly family: string }> =>
	Arr.flatMap(roleNames, (r) =>
		Arr.flatMap(owners, (o) => {
			const ws = w.writes[r]
			const member: string = ws[memberOf[o]]
			const own: string = ws[o]
			if (member === "none" || own === "whole") {
				return []
			}
			const untranslatable = member === "other"
			const agrees = o === "Store" && own === "copy" && member === "copy"
			const uncovered = narrows(own) && !agrees
			return untranslatable || uncovered ? [{ role: r, family: familyOf[o] }] : []
		})
	)

/** A role's PostgreSQL name in the installation. */
const roleIn = (i: Installation, r: RoleName): string =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(
				Arr.flatMap(i.worlds, (l) => l.roles),
				(x) => x.name === r
			)
		),
		`the role ${r}`
	).role

type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE"
const tablePrivileges: ReadonlyArray<TablePrivilege> = ["SELECT", "INSERT", "UPDATE", "DELETE"]

/** The columns of `table` the role holds `privilege` on, a table-level grant holding every one of `all`. */
const held = (
	statements: ReadonlyArray<SqlStatement>,
	role: string,
	table: string,
	privilege: TablePrivilege,
	all: ReadonlyArray<string>
): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const s of statements) {
		if (
			s.kind === "grant" &&
			s.on.kind === "TABLE" &&
			Arr.some(s.on.names, (n) => n.name === table) &&
			Arr.some(s.to, (g) => g.kind === "role" && g.name === role) &&
			Arr.some(s.privileges, (p) => p === privilege || p === "ALL")
		) {
			for (const c of all) {
				out.add(c)
			}
		}
		if (
			s.kind === "grantColumns" &&
			s.table.name === table &&
			s.to === role &&
			s.privilege === privilege
		) {
			for (const c of s.columns) {
				out.add(c)
			}
		}
	}
	return out
}

/** Every column of `relation`'s table: its CREATE TABLE's and every law column added to it. */
const columnsOf = (i: Installation, relation: string): ReadonlyArray<string> => {
	const table = i.names.relation(relation).name
	return Arr.flatMap(i.statements, (s) => {
		if (s.kind === "createTable" && s.table.name === table) {
			return Arr.map(s.columns, (c) => c.name)
		}
		if (s.kind === "alterTable" && s.table.name === table) {
			return Arr.flatMap(s.actions, (a) => (a.kind === "addColumn" ? [a.column.name] : []))
		}
		return []
	})
}

const sorted = (xs: Iterable<string>): ReadonlyArray<string> => Arr.sort(xs, Order.String)

/** The policies on each table, by role, and the tables with row security. */
const security = (
	i: Installation
): {
	readonly secured: ReadonlySet<string>
	readonly policies: ReadonlyArray<{
		readonly table: string
		readonly role: string
		readonly filter: Expr
	}>
} => {
	const secured = new Set<string>()
	const policies: Array<{ readonly table: string; readonly role: string; readonly filter: Expr }> =
		[]
	for (const s of i.statements) {
		if (s.kind === "createPolicy") {
			policies.push({ table: s.table.name, role: s.role, filter: s.filter })
		}
		if (s.kind === "alterTable" && Arr.some(s.actions, (a) => a.kind === "enableRowSecurity")) {
			secured.add(s.table.name)
		}
	}
	return { secured, policies }
}

/** A literal row: each column's value as a literal, text or integer. */
type HostRow = ReadonlyMap<string, Expr>

const text = (value: string): Expr => lit.text(value, types.text)
const int = (value: bigint): Expr => lit.int(value, types.bigint)

/** A literal's value as text, for comparison: a cast is transparent, every other node none. */
const literalOf = (e: Expr): string | undefined => {
	if (e.kind === "cast") {
		return literalOf(e.expr)
	}
	if (e.kind !== "literal") {
		return undefined
	}
	switch (e.value.kind) {
		case "bool":
			return e.value.value ? "bool:true" : "bool:false"
		case "int":
			return `num:${e.value.value}`
		case "decimal":
			return `num:${e.value.value}`
		case "text":
			return `text:${Str.toLowerCase(e.value.value)}`
		case "bits":
		case "float":
		case "floatSpecial":
			return undefined
	}
}

/**
 * A policy's predicate over one row, evaluated on the host: each column of `table` replaced by the row's literal, then
 * folded where its operands are literals (`=`, `<>`, IS TRUE, AND, OR, NOT, casts), any other node kept and printed.
 * Two predicates over two rows agree when their folds print alike: a call, a filter function's, agrees only with itself
 * over equal arguments.
 */
const evaluate = (filter: Expr, table: string, row: HostRow): string => {
	const substituted = transformExpr(filter, {
		...identityHooks,
		expr: (e) => {
			if (e.kind !== "column" || e.table !== table) {
				return e
			}
			return defined(row.get(e.column), `the host row's ${e.column}`)
		}
	})
	const fold = (e: Expr): Expr => {
		const bool = lit.bool
		const truth = (x: Expr): boolean | undefined => {
			const l = literalOf(x)
			return l === "bool:true" ? true : l === "bool:false" ? false : undefined
		}
		if (e.kind === "cast") {
			const inner = fold(e.expr)
			return literalOf(inner) === undefined ? { ...e, expr: inner } : inner
		}
		if (e.kind === "binary") {
			const left = fold(e.left)
			const right = fold(e.right)
			const l = literalOf(left)
			const r = literalOf(right)
			if ((e.op === "=" || e.op === "<>") && l !== undefined && r !== undefined) {
				return bool(e.op === "=" ? l === r : l !== r)
			}
			return { ...e, left, right }
		}
		if (e.kind === "isTrue" || e.kind === "not") {
			const inner = fold(e.expr)
			const t = truth(inner)
			if (t === undefined) {
				return { ...e, expr: inner }
			}
			return bool(e.kind === "isTrue" ? t : !t)
		}
		if (e.kind === "and" || e.kind === "or") {
			const args = Arr.map(e.args, fold)
			const truths = Arr.map(args, truth)
			const absorbing = e.kind !== "and"
			if (Arr.some(truths, (t) => t === absorbing)) {
				return bool(absorbing)
			}
			if (Arr.every(truths, (t) => t !== undefined)) {
				return bool(!absorbing)
			}
			return { ...e, args: defined(isNonEmpty(args) ? args : undefined) }
		}
		return e
	}
	return printExpr(fold(substituted))
}

/** The owner rows each family's owner is drawn over, and the member row each owns: equal at the group and every copy,
 * every other field fixed. */
const ownerRows = (
	i: Installation,
	o: Owner
): ReadonlyArray<{ readonly owner: HostRow; readonly member: HostRow }> => {
	const oc = (f: string) => i.names.column(o, f)
	const mc = (f: string) => i.names.column(memberOf[o], f)
	return Arr.flatMap([U1, U2], (id) =>
		o === "Store"
			? Arr.map(["north", "south"], (region) => ({
					owner: new Map([
						[oc("id"), text(id)],
						[oc("region"), text(region)],
						[oc("label"), text("l")],
						[oc("seq"), int(1n)],
						[oc("items"), int(1n)],
						[oc("stock"), int(7n)]
					]),
					member: new Map([
						[mc("id"), text(U2)],
						[mc("store"), text(id)],
						[mc("region"), text(region)],
						[mc("qty"), int(7n)]
					])
				}))
			: Arr.map(["a", "b"], (tag) => ({
					owner: new Map([
						[oc("id"), text(id)],
						[oc("tag"), text(tag)],
						[oc("slots"), int(1n)]
					]),
					member: new Map([
						[mc("shelf"), text(id)],
						[mc("at"), int(0n)],
						[mc("what"), text("y")]
					])
				}))
	)
}

type GrantsFeature =
	| "a member writer of a mutable owner"
	| "a member writer of an immutable owner"
	| "a member writer under its owner's row security"
	| "a member writer whose filter is translated"
	| "a member writer whose filter function is translated"
	| "an untranslatable member filter refused"
	| "a narrowed owner entry refused"
	| "a narrowed owner entry the members' filter agrees with"
	| "a serial written through a query entry"
	| "a serial written whole"

const features: Arr.NonEmptyReadonlyArray<GrantsFeature> = [
	"a member writer of a mutable owner",
	"a member writer of an immutable owner",
	"a member writer under its owner's row security",
	"a member writer whose filter is translated",
	"a member writer whose filter function is translated",
	"an untranslatable member filter refused",
	"a narrowed owner entry refused",
	"a narrowed owner entry the members' filter agrees with",
	"a serial written through a query entry",
	"a serial written whole"
]

const noteWorld = (w: World, c: Case<GrantsFeature>): void => {
	for (const r of roleNames) {
		const ws = w.writes[r]
		for (const o of owners) {
			const member: string = ws[memberOf[o]]
			const own: string = ws[o]
			if (member === "none" || own === "whole") {
				continue
			}
			c.note(
				w.mutability[o]
					? "a member writer of a mutable owner"
					: "a member writer of an immutable owner"
			)
			if (member === "other") {
				c.note("an untranslatable member filter refused")
			} else if (narrows(own)) {
				c.note(
					o === "Store" && own === "copy" && member === "copy"
						? "a narrowed owner entry the members' filter agrees with"
						: "a narrowed owner entry refused"
				)
			} else if (member === "joined") {
				c.note("a member writer whose filter function is translated")
			} else if (narrows(member)) {
				c.note("a member writer whose filter is translated")
			}
		}
		const store: string = ws.Store
		const ticket: string = ws.Ticket
		if (ticket === "all" || store === "all" || store === "copy") {
			c.note("a serial written through a query entry")
		}
		if (ticket === "whole" || store === "whole") {
			c.note("a serial written whole")
		}
	}
}

describe("a member writer's hold on its family's owner", () => {
	it.effect(
		"exact column grants, the owner rows its policy admits, translation refusals and the advance closure",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/physical/family-grants",
						draw: drawn(worldGen),
						literal: Formatter.format,
						coverage: required(features, { cases: 160, sense: notesOnly }),
						kept: [],
						runs: 160,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(w, c) =>
						Effect.sync(() => {
							noteWorld(w, c)
							const result = compiled(w)
							const refusals = expectedRefusals(w)
							if (!result.ok) {
								assert.equal(result.error.reason._tag, "UnsupportedOperation", result.error.message)
								assert.ok(
									Arr.some(
										refusals,
										(x) =>
											Str.includes(`role ${x.role} `)(result.error.message) &&
											Str.includes(x.family)(result.error.message)
									),
									`refused as the rule refuses ${Formatter.format(refusals)}: ${result.error.message}`
								)
								return
							}
							assert.deepEqual(refusals, [], "a world the rule refuses is refused")
							const i = result.value
							checkedStatements(i.statements, "installation statement")
							const control = compiled(withoutMembers(w))
							assert.ok(control.ok, "the control with no member written installs")
							const ci = control.value
							for (const r of roleNames) {
								const ws = w.writes[r]
								const theory = roleIn(i, r)
								for (const o of owners) {
									const table = i.names.relation(o).name
									const all = columnsOf(i, o)
									const member: string = ws[memberOf[o]]
									const own: string = ws[o]
									const holds = member !== "none" && own !== "whole"
									for (const p of tablePrivileges) {
										const rule = new Set(
											holds
												? Arr.map(
														p === "SELECT"
															? readFlight[o]
															: p === "UPDATE" && w.mutability[o]
																? countSets[o]
																: [],
														(f) => i.names.column(o, f)
													)
												: []
										)
										const expected = new Set([
											...held(
												ci.statements,
												roleIn(ci, r),
												ci.names.relation(o).name,
												p,
												columnsOf(ci, o)
											),
											...rule
										])
										assert.deepEqual(
											sorted(held(i.statements, theory, table, p, all)),
											sorted(expected),
											`${r}'s ${p} on ${o} is its own entries' and the family rule's`
										)
									}
								}
								for (const [t, f] of [
									["Store", "seq"],
									["Ticket", "no"]
								] as const) {
									const advance = i.names.advance(t, f)
									const inserts =
										held(i.statements, theory, i.names.relation(t).name, "INSERT", columnsOf(i, t))
											.size > 0
									const executes = Arr.some(
										i.statements,
										(s) =>
											s.kind === "grant" &&
											s.on.kind === "FUNCTION" &&
											Arr.some(
												s.on.names,
												(n) => n.schema === advance.schema && n.name === advance.name
											) &&
											Arr.some(s.to, (g) => g.kind === "role" && g.name === theory)
									)
									assert.equal(
										executes,
										inserts,
										`${r} holds EXECUTE on ${t}.${f}'s advance exactly when it inserts into ${t}`
									)
								}
							}
							const { secured, policies } = security(i)
							const policyOf = (table: string, role: string): Expr | undefined => {
								const on = Arr.filter(policies, (p) => p.table === table && p.role === role)
								assert.ok(on.length <= 1, `at most one policy of ${role} on ${table}`)
								return on[0]?.filter
							}
							for (const o of owners) {
								const ownerTable = i.names.relation(o).name
								const memberTable = i.names.relation(memberOf[o]).name
								const familyNarrows = Arr.some(roleNames, (r) => {
									const member: string = w.writes[r][memberOf[o]]
									const own: string = w.writes[r][o]
									return own === "none" && narrows(member)
								})
								const ownNarrows = Arr.some(roleNames, (r) => narrows(w.writes[r][o]))
								assert.equal(
									secured.has(ownerTable),
									familyNarrows || ownNarrows,
									`${o} has row security exactly when an entry or a member writer narrows it`
								)
								assert.equal(
									secured.has(memberTable),
									Arr.some(roleNames, (r) => narrows(w.writes[r][memberOf[o]])),
									`${memberOf[o]} has row security exactly when a writer narrows it`
								)
								if (secured.has(ownerTable)) {
									c.note("a member writer under its owner's row security")
								}
								for (const r of roleNames) {
									const member: string = w.writes[r][memberOf[o]]
									const own: string = w.writes[r][o]
									if (member === "none" || own === "whole") {
										continue
									}
									const theory = roleIn(i, r)
									const truth = lit.bool(true)
									const ownerPolicy = secured.has(ownerTable)
										? defined(policyOf(ownerTable, theory), `${r}'s policy on ${o}`)
										: truth
									const memberPolicy = secured.has(memberTable)
										? defined(policyOf(memberTable, theory), `${r}'s policy on ${memberOf[o]}`)
										: truth
									for (const row of ownerRows(i, o)) {
										const owner = evaluate(ownerPolicy, ownerTable, row.owner)
										const admitted = evaluate(memberPolicy, memberTable, row.member)
										if (own === "none") {
											assert.equal(
												owner,
												admitted,
												`${r} reaches exactly the ${o} rows whose groups its ${memberOf[o]} policy admits`
											)
										} else {
											assert.ok(
												owner === admitted || owner === "true",
												`${r}'s own entry on ${o} admits every owner its members name: ${owner} for ${admitted}`
											)
										}
									}
								}
							}
						})
				)
			)
	)
})
