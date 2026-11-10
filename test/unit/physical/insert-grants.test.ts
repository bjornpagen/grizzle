/**
 * Roles that write by an insert list, `role(base, name, entries, { insert })` (schema/world.ts admitRole,
 * physical/ddl/roles.ts grantedPrivileges, write/program/insert-only.ts), over generated worlds: two roles, each
 * writing each relation whole, through a query entry holding every row, or not at all, by its write list or its insert
 * list, over a counted family with a fold and an ordered one, each owner mutable or not, and a ChangeSet of drawn members
 * over one of the roles.
 *
 * - **The declaration:** a role states `write` or `insert`, and an insert list names at least one entry: a role stating
 *   both is `RoleRefused` (`writeAndInsert`), an empty insert list a MalformedDescription. A role's Description holds the
 *   key it stated and its list, and the same entries stated under the other key differ in that key alone.
 * - **The grants are the declaration's:** each role's table privileges on each table, a column privilege counting as its
 *   table's, are the rule restated: on a table it writes SELECT and INSERT, and by its write list DELETE and, on a
 *   mutable table, UPDATE; on the owner of a family whose member it writes, and which it does not write whole, SELECT,
 *   and UPDATE on a mutable owner by its write list. grantedPrivileges, what certification reads, is exactly the
 *   installed set.
 * - **A role stating `write` comes out byte-identical:** the installation with every insert role stated as a write role
 *   (the control) and the drawn one hold the same objects in the same order with the same DDL, the same edges, revokes,
 *   defaults and comments, save each insert role's own privileges object and the edges that name it.
 * - **A program beyond insert is refused when it compiles:** the ChangeSet compiled for the role is the control's
 *   compilation, the same role stated with `write`, wherever the control is refused, and wherever no member deletes,
 *   puts, or inserts a member of a mutable owner's family, whose count and fold the insert updates; otherwise it is
 *   `OutsideRole` at the role, naming an UPDATE or a DELETE of a relation the member reaches: its own, a member of its
 *   families or its owner. An admitted program is the control's, statement for statement.
 * - **Never a defect:** every drawn program of a role compiles or is refused with a CompileError, and never throws. The
 *   kept case is the one that found familyProgram reading a family owner from the role's own schema (CLOSED-B-00b): a
 *   role writing a mutable owner through a query entry, whose ChangeSet inserts another owner and puts the entry in one
 *   stratum.
 *
 * Oracles: the rule restated over the case, the control installation and the control compilation.
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, constant, element, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import { isNonEmpty } from "#compiler/core/nonempty.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { RoleDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { grantedPrivileges } from "#compiler/physical/ddl/roles.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { namedIdent } from "#compiler/physical/obligations/graph.ts"
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
import { installationsOf, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf, role, roleDescOf } from "#compiler/schema/world.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { changeSetOver, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import type { BuiltRole } from "#test/support/worlds/execute/build.ts"
import { offlineCompile, parsedChange } from "#test/support/worlds/execute/offline.ts"

/** A text field over lowercase words. */
const word = str.regex("^[a-z]{1,8}$")

const Store = relation(
	"Store",
	{
		id: uuid,
		region: word,
		label: word,
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

type Owner = "Store" | "Shelf"
type Member = "Item" | "Slot"
type Written = Owner | Member | "Ticket"
type Mutability = { readonly [O in Owner]: boolean }

/** The world's schema: Items counted under Stores, summed into their stock and copying their region, Slots ordered
 * under Shelves, each owner mutable when `mutability` says so. */
const schemaOf = (mutability: Mutability) =>
	schema("Shops", relations, [
		items,
		fold(items, Monoid.sum, on(Item, "store", "qty"), on(Store, "id", "stock")),
		contained(on(Item, "store", "region"), on(Store, "id", "region")),
		slots,
		...(mutability.Store ? [mutable(Store)] : []),
		...(mutability.Shelf ? [mutable(Shelf)] : [])
	])

type Shops = ReturnType<typeof schemaOf>

const written: Arr.NonEmptyReadonlyArray<Written> = ["Store", "Item", "Shelf", "Slot", "Ticket"]
const memberOf: { readonly [O in Owner]: Member } = { Store: "Item", Shelf: "Slot" }
const ownerOf: { readonly [M in Member]: Owner } = { Item: "Store", Slot: "Shelf" }

const isOwner = (t: Written): t is Owner => t === "Store" || t === "Shelf"
const isMember = (t: Written): t is Member => t === "Item" || t === "Slot"

/** Whether `t` is mutable in a world of `mutability`: an owner as it says, every other relation never. */
const mutableIn = (mutability: Mutability, t: Written): boolean =>
	isOwner(t) ? mutability[t] : false

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

const roleNames = ["clerk", "keeper"] as const
type RoleName = (typeof roleNames)[number]

/** One role of a case: how it writes each relation, and the key it states. */
interface RoleCase {
	readonly writes: Writes
	readonly stated: Stated
}

type Op = "insert" | "delete" | "put"

/** One member of the ChangeSet: its operation and the relation it writes, among those its role writes. */
interface MemberCase {
	readonly op: Op
	readonly relation: Written
}

/** A point: the roles, each owner's mutability, and the ChangeSet over one role. */
interface World {
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
	op: source.draw(element(["insert", "insert", "delete", "put"] as const)),
	relation: source.draw(element(written))
})

const worldGen: Gen<World> = (source) => ({
	roles: { clerk: source.draw(roleCaseGen), keeper: source.draw(roleCaseGen) },
	mutability: { Store: source.draw(boolean), Shelf: source.draw(boolean) },
	program: {
		role: source.draw(element(roleNames)),
		members: source.draw(array(memberGen, { min: 1, max: 3 }))
	}
})

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
const entriesOf = (
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
const roleOf = (s: Shops, name: RoleName, w: Writes, stated: Stated): BuiltRole => {
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
const declarationRefusal = (rc: RoleCase): "writeAndInsert" | "emptyInsert" | undefined => {
	if (rc.stated === "both") {
		return "writeAndInsert"
	}
	const writesAny = Arr.some(written, (t) => rc.writes[t] !== "none")
	return rc.stated === "insert" && !writesAny ? "emptyInsert" : undefined
}

/** A declared role of a case: its name, how it writes, and the key it stated, `write` or `insert`. */
interface Declared {
	readonly name: RoleName
	readonly writes: Writes
	readonly stated: "write" | "insert"
}

/** The installation of the declared roles, held by one login, or by none when no role is declared. */
const compiled = (s: Shops, declared: ReadonlyArray<Declared>) => {
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

/** Whether the installation's statements grant `role` `privilege` on `table`, at the table or on any column of it. */
const holds = (
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
const tablePrivileges: ReadonlyArray<TablePrivilege> = ["SELECT", "INSERT", "UPDATE", "DELETE"]

const sortedPrivileges = (xs: Iterable<TablePrivilege>): ReadonlyArray<TablePrivilege> =>
	Arr.filter(tablePrivileges, (p) => Arr.some([...xs], (x) => x === p))

/** The rule restated: the table privileges a declared role holds on `t`. */
const rulePrivileges = (
	d: Declared,
	mutability: Mutability,
	t: Written | "Open"
): ReadonlyArray<TablePrivilege> => {
	const out = new Set<TablePrivilege>()
	const byWrite = d.stated === "write"
	if (t !== "Open" && d.writes[t] !== "none") {
		out.add("SELECT")
		out.add("INSERT")
		if (byWrite) {
			out.add("DELETE")
			if (mutableIn(mutability, t)) {
				out.add("UPDATE")
			}
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
const reached = (t: Written): ReadonlyArray<string> =>
	isOwner(t) ? [t, memberOf[t]] : isMember(t) ? [t, ownerOf[t]] : [t]

/** Whether the rule calls a member beyond insert: a deletion, a put, or an insert of a mutable owner's member. */
const beyondInsert = (m: MemberCase, mutability: Mutability): boolean =>
	m.op !== "insert" || (isMember(m.relation) && mutability[ownerOf[m.relation]])

type InsertFeature =
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

const features: Arr.NonEmptyReadonlyArray<InsertFeature> = [
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
	"an insert program the control refuses"
]

/** The objects, edges, revokes, defaults and comments of an installation, the privileges objects of `excluded` and the
 * edges naming them left out. */
const comparable = (i: Installation, excluded: ReadonlySet<string>) => {
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
const keyed = (
	desc: RoleDesc
): { readonly key: "write" | "insert"; readonly list: ReadonlyArray<string> } =>
	"insert" in desc ? { key: "insert", list: desc.insert } : { key: "write", list: desc.write }

/** A role's Description but its key and list. */
const unkeyed = (desc: RoleDesc) => ({
	name: desc.name,
	base: desc.base,
	relations: desc.relations,
	refresh: desc.refresh,
	loc: desc.loc
})

/** The manifest identity of a role's privileges object, which the installation holds. */
const privilegesIdent = (i: Installation, r: RoleName): string => {
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
const compiledOrRefused = (
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

/** The case that found familyProgram reading a family owner from the role's own schema: clerk writes Store through
 * AllStores, a query entry over the mutable owner, and Shelf and Slot whole, and puts AllStores and inserts Shelf in one
 * stratum. */
const ownerThroughEntry: World = {
	roles: {
		clerk: {
			writes: { Store: "all", Item: "none", Shelf: "whole", Slot: "whole", Ticket: "none" },
			stated: "write"
		},
		keeper: {
			writes: { Store: "none", Item: "none", Shelf: "none", Slot: "none", Ticket: "none" },
			stated: "write"
		}
	},
	mutability: { Store: true, Shelf: false },
	program: {
		role: "clerk",
		members: [
			{ op: "insert", relation: "Shelf" },
			{ op: "put", relation: "Store" }
		]
	}
}

/** The statements of a compiled write program, as it sends them. */
const statementsOf = (program: {
	readonly artifact: { readonly statements: ReadonlyArray<{ readonly ast: SqlStatement }> }
}) => Arr.map(program.artifact.statements, (st) => st.ast)

describe("roles that write by an insert list", () => {
	it.effect(
		"the declaration, its grants, byte-identical write roles and the refusal of programs beyond insert",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/physical/insert-grants",
						draw: drawn(worldGen),
						literal: Formatter.format,
						coverage: required(features, { cases: 160, sense: notesOnly }),
						kept: [
							{
								note: "a put through a query entry over a mutable family owner, beside an owner's insertion",
								sketch: ownerThroughEntry,
								draws: "",
								reaches: ["a role stating write"]
							}
						],
						runs: 160,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(w: World, c: Case<InsertFeature>) =>
						Effect.sync(() => {
							const s = schemaOf(w.mutability)
							const declared = Arr.flatMap(roleNames, (name): ReadonlyArray<Declared> => {
								const rc = w.roles[name]
								const outcome = Result.try({
									try: () => roleOf(s, name, rc.writes, rc.stated),
									catch: (e) => e
								})
								const refusal = declarationRefusal(rc)
								if (Result.isFailure(outcome)) {
									const error = outcome.failure
									assert.ok(error instanceof CompileError, String(error))
									if (refusal === "writeAndInsert") {
										c.note("both keys refused")
										assert.deepEqual(
											error.reason._tag === "RoleRefused" ? error.reason.rule : error.reason,
											{ kind: "writeAndInsert" },
											error.message
										)
									} else {
										c.note("an empty insert list refused")
										assert.equal(refusal, "emptyInsert", error.message)
										assert.equal(error.reason._tag, "MalformedDescription", error.message)
									}
									return []
								}
								assert.equal(refusal, undefined, `${name} is declared, which the rule refuses`)
								const stated = rc.stated === "insert" ? "insert" : "write"
								c.note(stated === "insert" ? "a role stating insert" : "a role stating write")
								const listed = Arr.map(entriesOf(s, rc.writes).names, ([, entry]) => entry)
								const desc = defined(roleDescOf(outcome.success), "a role built by role(...)")
								assert.deepEqual(
									keyed(desc),
									{ key: stated, list: listed },
									`${name}'s Description holds the key it stated and its list`
								)
								if (isNonEmpty(listed)) {
									const other = defined(
										roleDescOf(
											roleOf(s, name, rc.writes, stated === "insert" ? "write" : "insert")
										),
										"the role under the other key"
									)
									assert.deepEqual(
										keyed(other),
										{ key: stated === "insert" ? "write" : "insert", list: listed },
										`${name} under the other key holds that key and the same list`
									)
									assert.deepEqual(
										unkeyed(desc),
										unkeyed(other),
										`${name} under the other key differs in its key alone`
									)
								}
								return [{ name, writes: rc.writes, stated }]
							})
							const result = compiled(s, declared)
							assert.ok(result.ok, result.ok ? "" : result.error.message)
							const i = result.value
							const control = compiled(
								s,
								Arr.map(declared, (d) => ({ ...d, stated: "write" as const }))
							)
							assert.ok(control.ok, control.ok ? "" : control.error.message)
							const ci = control.value
							for (const d of declared) {
								const theory = roleIn(i, d.name)
								const checked = defined(
									Option.getOrUndefined(
										Arr.findFirst(
											Arr.flatMap(i.logins, (l) => l.roles),
											(r) => r.checked.world.role.name === d.name
										)
									),
									`the checked role ${d.name}`
								).checked
								const granted = grantedPrivileges(i.laws, checked)
								for (const t of [...written, "Open"] as const) {
									const table = i.names.relation(t)
									const installed: ReadonlyArray<TablePrivilege> = Arr.filter(
										tablePrivileges,
										(p) => holds(i.statements, theory, table, p)
									)
									assert.deepEqual(
										installed,
										rulePrivileges(d, w.mutability, t),
										`${d.name}'s privileges on ${t} are the rule's`
									)
									assert.deepEqual(
										sortedPrivileges(granted.get(t) ?? []),
										installed,
										`grantedPrivileges of ${d.name} on ${t} is what is installed`
									)
									if (d.stated === "insert" && t !== "Open") {
										if (isOwner(t) && d.writes[memberOf[t]] !== "none" && d.writes[t] !== "whole") {
											c.note("an insert role holding a family owner's columns")
										}
										if (d.writes[t] !== "none" && mutableIn(w.mutability, t)) {
											c.note("an insert role over a mutable table")
										}
									}
								}
								assert.ok(
									Arr.every([...granted.keys()], (k) => k !== "Open"),
									`${d.name} holds no table privilege on what it only reads`
								)
							}
							const flipped = new Set(
								Arr.flatMap(declared, (d) =>
									d.stated === "insert" ? [privilegesIdent(i, d.name)] : []
								)
							)
							assert.deepEqual(
								comparable(i, flipped),
								comparable(ci, flipped),
								"the installation is the control's but for each insert role's privileges"
							)
							const programmed = Arr.findFirst(declared, (d) => d.name === w.program.role)
							if (Option.isNone(programmed)) {
								return
							}
							const d = programmed.value
							const { names } = entriesOf(s, d.writes)
							const targeted: Array<readonly [MemberCase, string]> = []
							for (const m of w.program.members) {
								const at = Arr.findFirst(names, ([t]) => t === m.relation)
								const repeated = Arr.some(
									targeted,
									([x]) => x.op === m.op && x.relation === m.relation
								)
								if (Option.isSome(at) && !repeated) {
									targeted.push([m, at.value[1]])
								}
							}
							if (!isNonEmpty(targeted)) {
								return
							}
							const members = Arr.map(targeted, ([m]) => m)
							const value = roleOf(s, d.name, d.writes, d.stated)
							const program = compiledOrRefused(value, targeted)
							const controlProgram = compiledOrRefused(
								roleOf(s, d.name, d.writes, "write"),
								targeted
							)
							if (d.stated === "write") {
								assert.deepEqual(
									program.ok ? { ok: true } : { ok: false, reason: program.error.reason },
									controlProgram.ok
										? { ok: true }
										: { ok: false, reason: controlProgram.error.reason },
									"a write role's program is its own"
								)
								return
							}
							if (!controlProgram.ok) {
								c.note("an insert program the control refuses")
								assert.ok(!program.ok, "the control's refusal stands")
								assert.deepEqual(
									program.error.reason,
									controlProgram.error.reason,
									"the control's refusal stands"
								)
								return
							}
							const beyond = Arr.filter(members, (m) => beyondInsert(m, w.mutability))
							if (!isNonEmpty(beyond)) {
								c.note("an admitted insert program")
								assert.ok(program.ok, program.ok ? "" : program.error.message)
								assert.deepEqual(
									statementsOf(program.value),
									statementsOf(controlProgram.value),
									"an admitted insert program is the control's"
								)
								return
							}
							for (const m of beyond) {
								c.note(
									m.op === "delete"
										? "a deletion refused"
										: m.op === "put"
											? "a put refused"
											: "a recount refused"
								)
							}
							assert.ok(!program.ok, `refused: ${Formatter.format(beyond)}`)
							const reason = program.error.reason
							assert.equal(reason._tag, "OutsideRole", program.error.message)
							if (reason._tag !== "OutsideRole") {
								return
							}
							assert.equal(reason.role, d.name)
							assert.equal(reason.access.kind, "insert", program.error.message)
							if (reason.access.kind !== "insert") {
								return
							}
							const access = reason.access
							assert.ok(
								Arr.some(beyond, (m) =>
									Arr.some(reached(m.relation), (r) => r === access.relation)
								),
								`${access.operation} of ${access.relation} is reached by a member beyond insert`
							)
						})
				)
			)
	)
})
