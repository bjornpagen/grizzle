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
import type { WriteMode } from "#compiler/ir/desc.ts"
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
import type { CteBody, Insert, SqlStatement, TableName, Update } from "#compiler/sql/ast.ts"
import { type Assignments, assignments, ungenerated } from "#compiler/sql/generation.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"
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

/** The relations a world declares open or closed: the owners and the counted member. */
type Drawn = Owner | "Item"

export type Mutability = { readonly [D in Drawn]: boolean }

/** The world's schema: Items counted under Stores, summed into their stock and copying their region, Slots ordered
 * under Shelves, each owner and Item mutable, inside the unit of its id, when `mutability` says so, and Ticket mutable
 * inside the unit of its number, the open relation outside every family a program puts and deletes; Slot is closed. */
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
		...(mutability.Item ? [mutable(Item)] : []),
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

export const isOwner = (t: Written): t is Owner => t === "Store" || t === "Shelf"

/** Whether `t` is mutable in a world of `mutability`: an owner and Item as it says, Ticket always, Slot never. */
export const mutableIn = (mutability: Mutability, t: Written): boolean =>
	t === "Ticket" ? true : t === "Slot" ? false : mutability[t]

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

/** The list each relation is named under where a role writes it (ir/desc.ts WriteMode). */
type Modes = { readonly [T in Written]: WriteMode }

export const roleNames = ["clerk", "keeper"] as const

export type RoleName = (typeof roleNames)[number]

/** One role of a case: how it writes each relation, and under which list. */
export interface RoleCase {
	readonly writes: Writes
	readonly modes: Modes
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

const modeGen: Gen<WriteMode> = weighted<WriteMode>([
	[2, constant<WriteMode>("insert")],
	[1, constant<WriteMode>("write")]
])

const modesGen: Gen<Modes> = (source) => ({
	Store: source.draw(modeGen),
	Item: source.draw(modeGen),
	Shelf: source.draw(modeGen),
	Slot: source.draw(modeGen),
	Ticket: source.draw(modeGen)
})

export const roleCaseGen: Gen<RoleCase> = (source) => ({
	writes: source.draw(writesGen),
	modes: source.draw(modesGen)
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

/** Whether each owner and Item is open. */
export const mutabilityGen: Gen<Mutability> = (source) => ({
	Store: source.draw(boolean),
	Item: source.draw(boolean),
	Shelf: source.draw(boolean)
})

const worldGen: Gen<InsertWorld> = (source) => ({
	roles: { clerk: source.draw(roleCaseGen), keeper: source.draw(roleCaseGen) },
	mutability: source.draw(mutabilityGen),
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

/**
 * A drawn world whose program's role inserts into the open Item by its insert list, writing it whole beside a mutable
 * Store, and whose program inserts an Item first: an insertion that recounts its owner, which the role, adding Items
 * alone, holds no UPDATE on.
 */
const recountGen: Gen<InsertWorld> = (source) => {
	const w = source.draw(worldGen)
	const role = w.program.role
	const { writes, modes } = w.roles[role]
	return {
		...declaring(w, role, {
			writes: { ...writes, Item: "whole", Store: "none" },
			modes: { ...modes, Item: "insert" }
		}),
		mutability: { ...w.mutability, Store: true, Item: true },
		program: { role, members: [{ op: "insert", relation: "Item" }, ...w.program.members] }
	}
}

/**
 * A drawn world whose program's role writes the open Item whole by its write list, beside a mutable Store, and whose
 * program inserts an Item first: an insertion that recounts its owner, which the role holds UPDATE on, as the writer of
 * the family's member by its write list.
 */
const grantedRecountGen: Gen<InsertWorld> = (source) => {
	const w = source.draw(worldGen)
	const role = w.program.role
	const { writes, modes } = w.roles[role]
	return {
		...declaring(w, role, {
			writes: { ...writes, Item: "whole", Store: "none" },
			modes: { ...modes, Item: "write" }
		}),
		mutability: { ...w.mutability, Store: true, Item: true },
		program: { role, members: [{ op: "insert", relation: "Item" }, ...w.program.members] }
	}
}

/** The worlds, aimed at a recount refused and one granted, which a drawn world meets rarely. */
export const worldSpace: Aimed<InsertWorld, InsertFeature> = aimed(worldGen, [
	["a recount refused", recountGen],
	["an owner's recount granted", grantedRecountGen]
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

/** The options a role states, as a JavaScript caller passes them: its insert and write lists. */
interface StatedOptions {
	readonly insert: ReadonlyArray<string>
	readonly write: ReadonlyArray<string>
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

/** The role `name` writing as `rc` says, each written relation's entry under its mode's list. */
export const roleOf = (s: Shops, name: RoleName, rc: RoleCase): BuiltRole => {
	const { entries, names } = entriesOf(s, rc.writes)
	const under = (mode: WriteMode): ReadonlyArray<string> =>
		Arr.flatMap(names, ([t, entry]) => (rc.modes[t] === mode ? [entry] : []))
	return roleTaking.role(s, name, entries, { insert: under("insert"), write: under("write") })
}

/** The relation the declaration rule refuses a role for, if any: a closed relation it writes by its write list. */
export const declarationRefusal = (rc: RoleCase, mutability: Mutability): Written | undefined =>
	Arr.findFirst(
		written,
		(t) => rc.writes[t] !== "none" && rc.modes[t] === "write" && !mutableIn(mutability, t)
	).pipe(Option.getOrUndefined)

/**
 * The control of a role: the same entries, each open relation it writes by its write list and each closed one by its
 * insert list, the most a declaration may hold.
 */
export const controlOf = (rc: RoleCase, mutability: Mutability): RoleCase => ({
	writes: rc.writes,
	modes: {
		Store: mutableIn(mutability, "Store") ? "write" : "insert",
		Item: mutableIn(mutability, "Item") ? "write" : "insert",
		Shelf: mutableIn(mutability, "Shelf") ? "write" : "insert",
		Slot: mutableIn(mutability, "Slot") ? "write" : "insert",
		Ticket: mutableIn(mutability, "Ticket") ? "write" : "insert"
	}
})

/** A declared role of a case: its name and how it writes. */
export interface InsertDeclared {
	readonly name: RoleName
	readonly role: RoleCase
}

/** The installation of the declared roles, held by one login, or by none when no role is declared. */
export const compiled = (s: Shops, declared: ReadonlyArray<InsertDeclared>) => {
	const owned = owning(s)
	const base: AnySchema = s
	const roles = Arr.map(declared, (d) => roleOf(s, d.name, d.role))
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

/**
 * The rule restated: the table privileges a declared role holds on `t`. On a relation it writes, SELECT and INSERT, and
 * by its write list UPDATE and DELETE; on the owner of a family whose member it writes and which it does not write
 * whole by its write list, SELECT, and UPDATE where the owner is mutable and it writes the member in full: a closed
 * member by its insert list, the one way it is written, an open one by its write list.
 */
export const rulePrivileges = (
	d: InsertDeclared,
	mutability: Mutability,
	t: Written | "Open"
): ReadonlyArray<TablePrivilege> => {
	const out = new Set<TablePrivilege>()
	const { writes, modes } = d.role
	if (t !== "Open" && writes[t] !== "none") {
		out.add("SELECT")
		out.add("INSERT")
		if (modes[t] === "write") {
			out.add("UPDATE")
			out.add("DELETE")
		}
	}
	if (
		t !== "Open" &&
		isOwner(t) &&
		writes[memberOf[t]] !== "none" &&
		(writes[t] !== "whole" || modes[t] === "insert")
	) {
		out.add("SELECT")
		const member = memberOf[t]
		if (mutability[t] && (modes[member] === "write" || !mutableIn(mutability, member))) {
			out.add("UPDATE")
		}
	}
	return sortedPrivileges(out)
}

/** An UPDATE or a DELETE a statement makes of a stored table, by the table's name. */
export interface Modification {
	readonly table: string
	readonly operation: "UPDATE" | "DELETE"
}

/** What one data-modifying statement updates or deletes of a stored table: an UPDATE's and a DELETE's target, an
 * INSERT's under ON CONFLICT DO UPDATE, and a MERGE's target by each WHEN that updates or deletes. */
const modifiedBy = (body: CteBody): ReadonlyArray<Modification> => {
	const stored = (table: TableName, operation: Modification["operation"]) =>
		typeof table === "string" ? [] : [{ table: table.name, operation }]
	switch (body.kind) {
		case "select":
			return []
		case "insert":
			return body.onConflict?.action.kind === "doUpdate" ? stored(body.table, "UPDATE") : []
		case "update":
			return stored(body.table, "UPDATE")
		case "delete":
			return stored(body.table, "DELETE")
		case "merge":
			return Arr.flatMap(body.whens, (w) =>
				w.action.kind === "update"
					? stored(body.table, "UPDATE")
					: w.action.kind === "delete"
						? stored(body.table, "DELETE")
						: []
			)
	}
}

/** Every UPDATE and DELETE the statements make of a stored table, a WITH's CTEs among them. */
export const modificationsOf = (
	statements: ReadonlyArray<SqlStatement>
): ReadonlyArray<Modification> =>
	Arr.flatMap(statements, (st) =>
		st.kind === "select" ||
		st.kind === "insert" ||
		st.kind === "update" ||
		st.kind === "delete" ||
		st.kind === "merge"
			? Arr.flatMap([st, ...Arr.map(st.with?.ctes ?? [], (c) => c.query)], modifiedBy)
			: []
	)

export type InsertFeature =
	| "a role inserting alone"
	| "a role writing an open relation"
	| "a closed relation under write refused"
	| "an inserting role holding a family owner's columns"
	| "an open relation inserted into alone"
	| "an owner's recount granted"
	| "an admitted program"
	| "an UPDATE refused"
	| "a DELETE refused"
	| "a recount refused"
	| "a program the control refuses"
	| "a table without a guard"
	| "a table no role writes keeps its guard"
	| "a guarded table an inserting role writes"

export const features: Arr.NonEmptyReadonlyArray<InsertFeature> = [
	"a role inserting alone",
	"a role writing an open relation",
	"a closed relation under write refused",
	"an inserting role holding a family owner's columns",
	"an open relation inserted into alone",
	"an owner's recount granted",
	"an admitted program",
	"an UPDATE refused",
	"a DELETE refused",
	"a recount refused",
	"a program the control refuses",
	"a table no role writes keeps its guard",
	"a guarded table an inserting role writes"
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

/** `set` with its anchor taken out: an assignment of a column to its own value at `target`, `"c" = "<target>"."c"`. */
const withoutAnchor = (set: Assignments, target: string): Assignments => {
	const kept = Arr.filter(
		set,
		(a) => !(a.value.kind === "column" && a.value.table === target && a.value.column === a.column)
	)
	return assignments(ungenerated, target, isNonEmpty(kept) ? kept : set)
}

/**
 * A statement with every UPDATE's anchor taken out of its SET list (sql/generation.ts assignments): the column an UPDATE
 * that feeds no stored generated column assigns to itself, `"c" = "<target>"."c"`, so PostgreSQL keeps its generation
 * expressions built, chosen among the columns its updater may assign, so a role's grants decide it and grizzle widens
 * none for it. It changes no row, so two programs that differ by it alone are one program; any other assignment, one
 * that assigns another value, stays.
 */
class Anchorless extends Transform {
	constructor() {
		super(identityHooks)
	}

	override update(u: Update): Update {
		const rebuilt = super.update(u)
		return { ...rebuilt, set: withoutAnchor(rebuilt.set, rebuilt.alias) }
	}

	override insert(i: Insert): Insert {
		const rebuilt = super.insert(i)
		const conflict = rebuilt.onConflict
		const alias = rebuilt.alias
		return alias !== undefined &&
			conflict?.kind === "columns" &&
			conflict.action.kind === "doUpdate"
			? {
					...rebuilt,
					onConflict: {
						...conflict,
						action: { ...conflict.action, set: withoutAnchor(conflict.action.set, alias) }
					}
				}
			: rebuilt
	}
}

/** A program's statements as `statementsOf` reads them, each UPDATE's anchor taken out (`Anchorless`): what two roles'
 * compilations of one program share, whatever columns each may assign. */
export const anchorlessStatementsOf = (
	program: Parameters<typeof statementsOf>[0]
): ReadonlyArray<SqlStatement> =>
	Arr.map(statementsOf(program), (st) => new Anchorless().statement(st))
