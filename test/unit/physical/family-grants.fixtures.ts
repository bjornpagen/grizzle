/** What the properties of family-grants.test.ts read: its spaces, models and helpers. */

import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn as drawnField, natural, pg } from "#compiler/public/fields.ts"
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
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf, roleBuilder as role } from "#compiler/schema/world.ts"
import type { Expr, SqlStatement } from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { Id } from "#test/support/ids.ts"
import { owning } from "#test/support/policy.ts"

/** A text field over lowercase words, every literal of the world one. */
const word = str.regex("^[a-z]{1,8}$")

const U1 = "00000000-0000-4000-8000-000000000001"

const U2 = "00000000-0000-4000-8000-000000000002"

const Store = relation(
	"Store",
	{
		id: Id,
		region: word,
		label: word,
		items: drawnField(natural),
		stock: accumulated(pg.bigint, 0n)
	},
	["id"]
)

const Item = relation("Item", { id: Id, store: Id, region: word, qty: pg.bigint }, ["id"])

const Open = relation("Open", { store: Id }, ["store"])

const Shelf = relation("Shelf", { id: Id, tag: word, slots: drawnField(natural) }, ["id"])

const Slot = relation("Slot", { shelf: Id, at: drawnField(natural), what: word }, ["shelf", "at"])

const items = counted(on(Item, "store"), fin(Store, "items"))

const slots = ordered(on(Slot, "shelf", "at"), fin(Shelf, "slots"))

const relations = Object.freeze({ Store, Item, Open, Shelf, Slot })

/** The world's schema: the counted family of Items with a sum into Store's stock and Store's region copied into each
 * Item, the ordered family of Slots, and each owner mutable, inside the unit of its id, when `mutability` says so. */
export const schemaOf = (mutability: Mutability) =>
	schema("Shops", Rec.values(relations), [
		items,
		fold(items, Monoid.sum, on(Item, "store", "qty"), on(Store, "id", "stock")),
		contained(on(Item, "store", "region"), on(Store, "id", "region")),
		slots,
		unit("Row", { id: Id }),
		...(mutability.Store ? [mutable(Store)] : []),
		...(mutability.Shelf ? [mutable(Shelf)] : [])
	])

type Owner = "Store" | "Shelf"

type Member = "Item" | "Slot"

type Written = Owner | Member

export const owners: readonly [Owner, Owner] = ["Store", "Shelf"]

export const memberOf: { readonly [O in Owner]: Member } = { Store: "Item", Shelf: "Slot" }

const familyOf: { readonly [O in Owner]: string } = { Store: "Store.items", Shelf: "Shelf.slots" }

/**
 * The rule restated per owner, by field: what a member's writer selects (the key, the count, the ends and the copies)
 * and what its recount sets (the count and the ends). Store's label is a written field no member writer reaches.
 */
export const readFlight: { readonly [O in Owner]: ReadonlyArray<string> } = {
	Store: ["id", "region", "items", "stock"],
	Shelf: ["id", "slots"]
}

export const countSets: { readonly [O in Owner]: ReadonlyArray<string> } = {
	Store: ["items", "stock"],
	Shelf: ["slots"]
}

/** How a role writes each relation: `none`, `whole`, `all` (a query entry holding every row), or a narrowing query
 * entry: by the group (`group`), by a copy (`copy`), through a join (`joined`), or by another field (`other`). */
const writesOf = {
	Store: ["none", "whole", "all", "copy"],
	Item: ["none", "whole", "all", "group", "copy", "joined", "other"],
	Shelf: ["none", "whole", "all", "other"],
	Slot: ["none", "whole", "all", "group", "other"]
} as const

type WriteOf<T extends Written> = (typeof writesOf)[T][number]

type Writes = { readonly [T in Written]: WriteOf<T> }

type Mutability = { readonly [O in Owner]: boolean }

export const roleNames = ["clerk", "keeper"] as const

type RoleName = (typeof roleNames)[number]

/** A point: how each role writes each relation, and each owner's mutability. */
interface World {
	readonly writes: { readonly [R in RoleName]: Writes }
	readonly mutability: Mutability
}

/** A role and how it writes each relation. */
export interface Writer {
	readonly name: RoleName
	readonly writes: Writes
}

const writesGen: Gen<Writes> = (source) => ({
	Store: source.draw(element(writesOf.Store)),
	Item: source.draw(element(writesOf.Item)),
	Shelf: source.draw(element(writesOf.Shelf)),
	Slot: source.draw(element(writesOf.Slot))
})

export const worldGen: Gen<World> = (source) => ({
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
					const { id, region, label, items: n, stock } = v(Store, "store")
					return r
						.match(Store, { id, region, label, items: n, stock })
						.find({ id, region, label, items: n, stock })
				})
			]
		case "Store:copy":
			return [
				"NorthStores",
				q.rule((r) => {
					const { id, label, items: n, stock } = v(Store, "store")
					return r
						.match(Store, { id, region: "north", label, items: n, stock })
						.find({ id, label, items: n, stock })
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
	}
	return assert.fail(`no query entry for ${t}:${w}`)
}

const written: ReadonlyArray<Written> = ["Store", "Item", "Shelf", "Slot"]

/** A role: Open read whole, and each relation it writes by the entry its write names. */
export const roleOf = (s: ReturnType<typeof schemaOf>, name: RoleName, w: Writes) => {
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
	return role(s, name, entries, { write: names })
}

/** A role with every member write dropped: the control its own entries' grants are read from. */
export const withoutMembers = (w: Writer): Writer => ({
	...w,
	writes: { ...w.writes, Item: "none", Slot: "none" }
})

/** The installation of the declared roles `writers`, held by one login, or by none when no role is declared. */
export const compiled = (mutability: Mutability, writers: ReadonlyArray<Writer>) => {
	const s = schemaOf(mutability)
	const owned = owning(s)
	const roles: ReadonlyArray<ReturnType<typeof roleOf>> = Arr.map(writers, (w) =>
		roleOf(s, w.name, w.writes)
	)
	const logins = isNonEmpty(roles) ? [login(s, "desk", roles)] : []
	return compileInstallation(
		owned,
		completeInstallOptions(
			owned,
			installationsOf(owned),
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
export const narrows = (w: string): boolean => w !== "none" && w !== "whole" && w !== "all"

/** The refusal the rule expects, the role and family it names: a member writer that does not write the owner whole,
 * whose member filter reads neither its group nor a copy, or whose owner entry is narrowed by any filter but the
 * members' translated one (only NorthStores with NorthItems agree). */
export const expectedRefusals = (
	writers: ReadonlyArray<Writer>
): ReadonlyArray<{ readonly role: RoleName; readonly family: string }> =>
	Arr.flatMap(writers, ({ name: r, writes: ws }) =>
		Arr.flatMap(owners, (o) => {
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
export const roleIn = (i: Installation, r: RoleName): string =>
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

export const tablePrivileges: ReadonlyArray<TablePrivilege> = [
	"SELECT",
	"INSERT",
	"UPDATE",
	"DELETE"
]

/** The columns of `table` the role holds `privilege` on, a table-level grant holding every one of `all`. */
export const held = (
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
export const columnsOf = (i: Installation, relation: string): ReadonlyArray<string> => {
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

export const sorted = (xs: Iterable<string>): ReadonlyArray<string> => Arr.sort(xs, Order.String)

/** The refusal a role meets when it is declared: the query entry it writes and the field of a key its family draws. */
interface DeclarationRefusal {
	readonly role: RoleName
	readonly rule: {
		readonly kind: "writeUnwritable"
		readonly entry: string
		readonly why: { readonly kind: "keyHoldsFamily"; readonly field: string }
	}
}

/** The first field of a relation's primary key, in text order, whose declaration states that its family draws it. */
const familyKeyField = (r: {
	readonly fields: Readonly<Record<string, object>>
	readonly primaryKey: ReadonlyArray<string>
}): Option.Option<string> =>
	Arr.findFirst(sorted(r.primaryKey), (f) => {
		const field = r.fields[f]
		return (
			field !== undefined &&
			"writing" in field &&
			(field.writing === "drawn" || field.writing === "accumulated")
		)
	})

/**
 * The refusal `w` meets when it is declared, as the writable-entry rule judges its writes from the schema's
 * declarations: its first query entry, in write order, over a relation whose key holds a field the relation's family
 * draws, which no fact through the entry states. No key but a primary one is declared, and no entry's filter reads a
 * count or an end, so no other clause of the rule refuses a role of this world.
 */
export const declarationRefusal = (
	s: ReturnType<typeof schemaOf>,
	w: Writer
): DeclarationRefusal | undefined => {
	for (const t of written) {
		const write: string = w.writes[t]
		if (write === "none" || write === "whole") {
			continue
		}
		const field = familyKeyField(s.relations[t])
		if (Option.isSome(field)) {
			const [entry] = queryEntry(s, t, write)
			return {
				role: w.name,
				rule: {
					kind: "writeUnwritable",
					entry,
					why: { kind: "keyHoldsFamily", field: field.value }
				}
			}
		}
	}
	return undefined
}

/** The policies on each table, by role, and the tables with row security. */
export const security = (
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
export const evaluate = (filter: Expr, table: string, row: HostRow): string => {
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
export const ownerRows = (
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
	| "a writable entry whose key holds a drawn index refused when declared"

export const features: Arr.NonEmptyReadonlyArray<GrantsFeature> = [
	"a member writer of a mutable owner",
	"a member writer of an immutable owner",
	"a member writer under its owner's row security",
	"a member writer whose filter is translated",
	"a member writer whose filter function is translated",
	"an untranslatable member filter refused",
	"a narrowed owner entry refused",
	"a narrowed owner entry the members' filter agrees with",
	"a writable entry whose key holds a drawn index refused when declared"
]

/** The features the declared roles `writers` reach, each owner mutable as `mutability` says. */
export const noteWriters = (
	writers: ReadonlyArray<Writer>,
	mutability: Mutability,
	c: Case<GrantsFeature>
): void => {
	for (const { writes: ws } of writers) {
		for (const o of owners) {
			const member: string = ws[memberOf[o]]
			const own: string = ws[o]
			if (member === "none" || own === "whole") {
				continue
			}
			c.note(
				mutability[o]
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
	}
}
