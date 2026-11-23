/** What the properties of insert-grants.test.ts read: its spaces, models and helpers. */

import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec, Result } from "effect"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { RoleDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { namedIdent } from "#compiler/physical/obligations/graph.ts"
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
import { installationsOf, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf, roleBuilder as role } from "#compiler/schema/world.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { changeSetOver, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { Id } from "#test/support/ids.ts"
import { owning } from "#test/support/policy.ts"
import type { BuiltRole } from "#test/support/worlds/execute/build.ts"
import { offlineCompile, parsedChange } from "#test/support/worlds/execute/offline.ts"

/** A text field over lowercase words. */
const word = str.regex("^[a-z]{1,8}$")

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

const Ticket = relation("Ticket", { no: pg.bigint, note: word }, ["no"])

const items = counted(on(Item, "store"), fin(Store, "items"))

const slots = ordered(on(Slot, "shelf", "at"), fin(Shelf, "slots"))

const relations = Object.freeze({ Store, Item, Open, Shelf, Slot, Ticket })

type Owner = "Store" | "Shelf"

type Member = "Item" | "Slot"

type Written = Owner | Member | "Ticket"

type Mutability = { readonly [O in Owner]: boolean }

/** The world's schema: Items counted under Stores, summed into their stock and copying their region, Slots ordered
 * under Shelves, each owner mutable, inside the unit of its id, when `mutability` says so, and Ticket mutable inside the
 * unit of its number, the open relation outside every family a program puts and deletes. */
export const schemaOf = (mutability: Mutability) =>
	schema("Shops", Rec.values(relations), [
		items,
		fold(items, Monoid.sum, on(Item, "store", "qty"), on(Store, "id", "stock")),
		contained(on(Item, "store", "region"), on(Store, "id", "region")),
		slots,
		unit("Row", { id: Id }),
		unit("Tickets", { no: pg.bigint }),
		mutable(Ticket),
		...(mutability.Store ? [mutable(Store)] : []),
		...(mutability.Shelf ? [mutable(Shelf)] : [])
	])

type Shops = ReturnType<typeof schemaOf>

export const written: Arr.NonEmptyReadonlyArray<Written> = [
	"Store",
	"Item",
	"Shelf",
	"Slot",
	"Ticket"
]

export const memberOf: { readonly [O in Owner]: Member } = { Store: "Item", Shelf: "Slot" }

const ownerOf: { readonly [M in Member]: Owner } = { Item: "Store", Slot: "Shelf" }

export const isOwner = (t: Written): t is Owner => t === "Store" || t === "Shelf"

const isMember = (t: Written): t is Member => t === "Item" || t === "Slot"

/** Whether `t` is mutable in a world of `mutability`: an owner as it says, Ticket always, a member never. */
export const mutableIn = (mutability: Mutability, t: Written): boolean =>
	isOwner(t) ? mutability[t] : t === "Ticket"

/** How a role writes each relation: not at all, whole, or through a query entry holding every row. A Slot's key holds
 * its drawn index, which no fact through a query entry states, so Slot is written whole or not at all. */
const writesOf = {
	Store: ["none", "whole", "all"],
	Item: ["none", "whole", "all"],
	Shelf: ["none", "whole", "all"],
	Slot: ["none", "whole"],
	Ticket: ["none", "whole", "all"]
} as const

type WriteOf<T extends Written> = (typeof writesOf)[T][number]

type Writes = { readonly [T in Written]: WriteOf<T> }

/** The key a role states its list under: `write`, `insert`, or both, which a JavaScript caller may pass. */
type Stated = "write" | "insert" | "both"

export const roleNames = ["clerk", "keeper"] as const

export type RoleName = (typeof roleNames)[number]

/** One role of a case: how it writes each relation, and the key it states. */
interface RoleCase {
	readonly writes: Writes
	readonly stated: Stated
}

type Op = "insert" | "delete" | "put"

/** One member of the ChangeSet: its operation and the relation it writes, among those its role writes. */
export interface MemberCase {
	readonly op: Op
	readonly relation: Written
}

/** A point: the roles, each owner's mutability, and the ChangeSet over one role. */
export interface InsertWorld {
	readonly roles: { readonly [R in RoleName]: RoleCase }
	readonly mutability: Mutability
	readonly program: { readonly role: RoleName; readonly members: ReadonlyArray<MemberCase> }
}

const writesGen: Gen<Writes> = (source) => ({
	Store: source.draw(element(writesOf.Store)),
	Item: source.draw(element(writesOf.Item)),
	Shelf: source.draw(element(writesOf.Shelf)),
	Slot: source.draw(element(writesOf.Slot)),
	Ticket: source.draw(element(writesOf.Ticket))
})

const statedGen: Gen<Stated> = weighted<Stated>([
	[4, constant<Stated>("write")],
	[5, constant<Stated>("insert")],
	[1, constant<Stated>("both")]
])

const roleCaseGen: Gen<RoleCase> = (source) => ({
	writes: source.draw(writesGen),
	stated: source.draw(statedGen)
})

const memberGen: Gen<MemberCase> = (source) => ({
	op: source.draw(
		weighted([
			[2, constant("insert" as const)],
			[1, constant("delete" as const)],
			[1, constant("put" as const)]
		])
	),
	relation: source.draw(element(written))
})

const worldGen: Gen<InsertWorld> = (source) => ({
	roles: { clerk: source.draw(roleCaseGen), keeper: source.draw(roleCaseGen) },
	mutability: { Store: source.draw(boolean), Shelf: source.draw(boolean) },
	program: {
		role: source.draw(element(roleNames)),
		members: source.draw(array(memberGen, { min: 1, max: 3 }))
	}
})

/** A world with `role` declared as `rc` in place of its drawn declaration. */
const declaring = (w: InsertWorld, role: RoleName, rc: RoleCase): InsertWorld => ({
	...w,
	roles: role === "clerk" ? { ...w.roles, clerk: rc } : { ...w.roles, keeper: rc }
})

/** A drawn world one of whose roles states an insert list naming nothing, which the declaration refuses. */
const emptyInsertGen: Gen<InsertWorld> = (source) =>
	declaring(source.draw(worldGen), source.draw(element(roleNames)), {
		writes: { Store: "none", Item: "none", Shelf: "none", Slot: "none", Ticket: "none" },
		stated: "insert"
	})

/**
 * A drawn world whose program's role states insert and writes a member of a mutable owner's family whole, and whose
 * program inserts that member first: an insertion that recounts its owner, beyond insert.
 */
const recountGen: Gen<InsertWorld> = (source) => {
	const w = source.draw(worldGen)
	const role = w.program.role
	const writes = w.roles[role].writes
	const store = source.draw(boolean)
	const member: Member = store ? "Item" : "Slot"
	return {
		...declaring(w, role, {
			writes: store ? { ...writes, Item: "whole" } : { ...writes, Slot: "whole" },
			stated: "insert"
		}),
		mutability: store ? { ...w.mutability, Store: true } : { ...w.mutability, Shelf: true },
		program: { role, members: [{ op: "insert", relation: member }, ...w.program.members] }
	}
}

/** The worlds, aimed at an empty insert list and at a recount, which a drawn world meets rarely. */
export const worldSpace: Aimed<InsertWorld, InsertFeature> = aimed(worldGen, [
	["an empty insert list refused", emptyInsertGen],
	["a recount refused", recountGen]
])

/** The query entry holding every row of `t`, by its name in the role. */
const allEntry = (s: Shops, t: Exclude<Written, "Slot">): readonly [string, EntryValue] => {
	const q = query(s)
	switch (t) {
		case "Store":
			return [
				"AllStores",
				q.rule((r) => {
					const { id, region, label, items: n, stock } = v(Store, "store")
					return r
						.match(Store, { id, region, label, items: n, stock })
						.find({ id, region, label, items: n, stock })
				})
			]
		case "Item":
			return [
				"AllItems",
				q.rule((r) => {
					const { id, store, region, qty } = v(Item, "item")
					return r.match(Item, { id, store, region, qty }).find({ id, store, region, qty })
				})
			]
		case "Shelf":
			return [
				"AllShelves",
				q.rule((r) => {
					const { id, tag, slots: n } = v(Shelf, "shelf")
					return r.match(Shelf, { id, tag, slots: n }).find({ id, tag, slots: n })
				})
			]
		case "Ticket":
			return [
				"AllTickets",
				q.rule((r) => {
					const { no, note } = v(Ticket, "ticket")
					return r.match(Ticket, { no, note }).find({ no, note })
				})
			]
	}
}

/** The entries of a role writing as `w`, Open read whole, with the entry name each written relation is written by. */
export const entriesOf = (
	s: Shops,
	w: Writes
): {
	readonly entries: Readonly<Record<string, EntryValue>>
	readonly names: ReadonlyArray<readonly [Written, string]>
} => {
	const entries: Record<string, EntryValue> = { Open: s.relations.Open }
	const names: Array<readonly [Written, string]> = []
	for (const t of written) {
		const way: string = w[t]
		if (way === "whole") {
			entries[t] = s.relations[t]
			names.push([t, t])
		} else if (way === "all" && t !== "Slot") {
			const [entry, value] = allEntry(s, t)
			entries[entry] = value
			names.push([t, entry])
		}
	}
	return { entries, names }
}

/** The options a role states, as a JavaScript caller passes them: its list under `write`, `insert` or both. */
interface StatedOptions {
	readonly write?: ReadonlyArray<string>
	readonly insert?: ReadonlyArray<string>
	readonly refresh?: ReadonlyArray<string>
}

const optionsOf = (stated: Stated, list: ReadonlyArray<string>): StatedOptions => {
	switch (stated) {
		case "write":
			return { write: list, refresh: [] }
		case "insert":
			return { insert: list, refresh: [] }
		case "both":
			return { write: list, insert: list, refresh: [] }
	}
}

/** role(...) as a JavaScript caller sees it, its options any record of lists. */
interface RoleTaking {
	role(
		base: AnySchema,
		name: string,
		entries: Readonly<Record<string, EntryValue>>,
		...rest:
			| readonly []
			| readonly [StatedOptions]
			| readonly [StatedOptions, unknown, ...ReadonlyArray<unknown>]
	): BuiltRole
}

const roleTaking: RoleTaking = { role }

/** The role `name` writing as `w`, stating its list under `stated`. */
export const roleOf = (s: Shops, name: RoleName, w: Writes, stated: Stated): BuiltRole => {
	const { entries, names } = entriesOf(s, w)
	return roleTaking.role(
		s,
		name,
		entries,
		optionsOf(
			stated,
			Arr.map(names, ([, entry]) => entry)
		)
	)
}

/** The refusal the declaration rule expects of a role, if any: both keys stated, or an empty insert list. */
export const declarationRefusal = (rc: RoleCase): "writeAndInsert" | "emptyInsert" | undefined => {
	if (rc.stated === "both") {
		return "writeAndInsert"
	}
	const writesAny = Arr.some(written, (t) => rc.writes[t] !== "none")
	return rc.stated === "insert" && !writesAny ? "emptyInsert" : undefined
}

/** A declared role of a case: its name, how it writes, and the key it stated, `write` or `insert`. */
export interface InsertDeclared {
	readonly name: RoleName
	readonly writes: Writes
	readonly stated: "write" | "insert"
}

/** The installation of the declared roles, held by one login, or by none when no role is declared. */
export const compiled = (s: Shops, declared: ReadonlyArray<InsertDeclared>) => {
	const owned = owning(s)
	const base: AnySchema = s
	const roles = Arr.map(declared, (d) => roleOf(s, d.name, d.writes, d.stated))
	const logins = isNonEmpty(roles) ? [login(base, "desk", roles)] : []
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

/** Whether `i` installs the guard trigger of `t`'s table. */
export const guarded = (i: Installation, t: Written | "Open"): boolean => {
	const table = i.names.relation(t)
	return Arr.some(
		i.manifest.objects,
		(o) =>
			o.kind === "isolationTrigger" &&
			Arr.some(
				o.ddl,
				(d) =>
					d.kind === "createGuardTrigger" &&
					d.table.schema === table.schema &&
					d.table.name === table.name
			)
	)
}

/** The rule restated: whether `t`'s table takes no guard, some declared role writing it and each that does certified
 * READ COMMITTED and holding only INSERT and SELECT there. */
export const relaxedByRule = (
	declared: ReadonlyArray<InsertDeclared>,
	mutability: Mutability,
	levels: (r: RoleName) => Isolation,
	t: Written | "Open"
): boolean => {
	const writers = Arr.filter(declared, (d) =>
		Arr.some(rulePrivileges(d, mutability, t), (p) => p !== "SELECT")
	)
	return (
		isNonEmpty(writers) &&
		Arr.every(
			writers,
			(d) =>
				levels(d.name) === "readCommitted" &&
				Arr.every(rulePrivileges(d, mutability, t), (p) => p === "SELECT" || p === "INSERT")
		)
	)
}

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

/** Whether the installation's statements grant `role` `privilege` on `table`, at the table or on any column of it. */
export const holds = (
	statements: ReadonlyArray<SqlStatement>,
	role: string,
	table: { readonly schema: string; readonly name: string },
	privilege: TablePrivilege
): boolean =>
	Arr.some(
		statements,
		(s) =>
			(s.kind === "grant" &&
				s.on.kind === "TABLE" &&
				Arr.some(s.on.names, (n) => n.schema === table.schema && n.name === table.name) &&
				Arr.some(s.to, (g) => g.kind === "role" && g.name === role) &&
				Arr.some(s.privileges, (p) => p === privilege || p === "ALL")) ||
			(s.kind === "grantColumns" &&
				s.table.schema === table.schema &&
				s.table.name === table.name &&
				s.to === role &&
				s.privilege === privilege)
	)

/** The table privileges, in the order a GRANT names them. */
export const tablePrivileges: ReadonlyArray<TablePrivilege> = [
	"SELECT",
	"INSERT",
	"UPDATE",
	"DELETE"
]

export const sortedPrivileges = (xs: Iterable<TablePrivilege>): ReadonlyArray<TablePrivilege> =>
	Arr.filter(tablePrivileges, (p) => Arr.some([...xs], (x) => x === p))

/** The rule restated: the table privileges a declared role holds on `t`. */
export const rulePrivileges = (
	d: InsertDeclared,
	mutability: Mutability,
	t: Written | "Open"
): ReadonlyArray<TablePrivilege> => {
	const out = new Set<TablePrivilege>()
	const byWrite = d.stated === "write"
	if (t !== "Open" && d.writes[t] !== "none") {
		out.add("SELECT")
		out.add("INSERT")
		if (byWrite && mutableIn(mutability, t)) {
			out.add("UPDATE")
			out.add("DELETE")
		}
	}
	if (t !== "Open" && isOwner(t) && d.writes[memberOf[t]] !== "none" && d.writes[t] !== "whole") {
		out.add("SELECT")
		if (byWrite && mutability[t]) {
			out.add("UPDATE")
		}
	}
	return sortedPrivileges(out)
}

/** The relations a member writing `t` may update or delete beyond its insert: its own, its family's members and owner. */
export const reached = (t: Written): ReadonlyArray<string> =>
	isOwner(t) ? [t, memberOf[t]] : isMember(t) ? [t, ownerOf[t]] : [t]

/** Whether the rule calls a member beyond insert: a deletion, a put, or an insert of a mutable owner's member. */
export const beyondInsert = (m: MemberCase, mutability: Mutability): boolean =>
	m.op !== "insert" || (isMember(m.relation) && mutability[ownerOf[m.relation]])

export type InsertFeature =
	| "a role stating write"
	| "a role stating insert"
	| "both keys refused"
	| "an empty insert list refused"
	| "an insert role holding a family owner's columns"
	| "an insert role over a mutable table"
	| "an admitted insert program"
	| "a deletion refused"
	| "a put refused"
	| "a recount refused"
	| "an insert program the control refuses"
	| "a table without a guard"
	| "a table no role writes keeps its guard"
	| "a guarded table an insert role writes"

export const features: Arr.NonEmptyReadonlyArray<InsertFeature> = [
	"a role stating write",
	"a role stating insert",
	"both keys refused",
	"an empty insert list refused",
	"an insert role holding a family owner's columns",
	"an insert role over a mutable table",
	"an admitted insert program",
	"a deletion refused",
	"a put refused",
	"a recount refused",
	"an insert program the control refuses",
	"a table no role writes keeps its guard",
	"a guarded table an insert role writes"
]

/** The objects, edges, revokes, defaults and comments of an installation, the privileges objects of `excluded` and the
 * edges naming them left out. */
export const comparable = (i: Installation, excluded: ReadonlySet<string>) => {
	const kept = (ident: string): boolean => !excluded.has(ident)
	return {
		objects: Arr.filter(i.manifest.objects, (o) => kept(o.ident)),
		edges: Arr.filter(i.manifest.edges, (e) => kept(e.from) && kept(e.to)),
		roleDefaults: i.manifest.roleDefaults,
		publicRevokes: i.manifest.publicRevokes,
		comments: i.manifest.comments
	}
}

/** A role's Description's key and list. */
export const keyed = (
	desc: RoleDesc
): { readonly key: "write" | "insert"; readonly list: ReadonlyArray<string> } =>
	"insert" in desc ? { key: "insert", list: desc.insert } : { key: "write", list: desc.write }

/** A role's Description but its key and list. */
export const unkeyed = (desc: RoleDesc) => ({
	name: desc.name,
	base: desc.base,
	relations: desc.relations,
	refresh: desc.refresh,
	loc: desc.loc
})

/** The manifest identity of a role's privileges object, which the installation holds. */
export const privilegesIdent = (i: Installation, r: RoleName): string => {
	const ident = namedIdent("privileges", roleIn(i, r))
	assert.ok(
		Arr.some(i.manifest.objects, (o) => o.kind === "privileges" && o.ident === ident),
		`the privileges object of ${r}`
	)
	return ident
}

/** The program of the ChangeSet of `members` over `value`, each member an array of facts the call supplies, into the
 * entry `entryOf` names, as a Db of the role compiles it. */
const programOver = (value: BuiltRole, members: ReadonlyArray<readonly [MemberCase, string]>) =>
	offlineCompile(
		value,
		parsedChange(
			Arr.reduce(members, changeSetOver.empty(value), (cs: ChangeSetValue, [m, entry]) =>
				cs[m.op](defined(value.relations[entry], `the role relation ${entry}`), [])
			)
		),
		new Set()
	)

/** The program of `targeted` over `value` (`programOver`), which compiles or is refused with a CompileError: a throw
 * is a defect, which fails the case. */
export const compiledOrRefused = (
	value: BuiltRole,
	targeted: ReadonlyArray<readonly [MemberCase, string]>
): ReturnType<typeof programOver> => {
	const outcome = Result.try({ try: () => programOver(value, targeted), catch: (e) => e })
	return Result.isSuccess(outcome)
		? outcome.success
		: assert.fail(
				`a program of a role compiles or is refused, never throws: ${String(outcome.failure)}`
			)
}

/** The statements of a compiled write program, as it sends them. */
export const statementsOf = (program: {
	readonly artifact: { readonly statements: ReadonlyArray<{ readonly ast: SqlStatement }> }
}) => Arr.map(program.artifact.statements, (st) => st.ast)
