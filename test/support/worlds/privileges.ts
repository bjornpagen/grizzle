import { Array as Arr, Effect, Option, Order, Record } from "effect"
import { indices } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { ledgerTable } from "#compiler/deploy/ledger/ledger.ts"
import { snapshotGuardName } from "#compiler/physical/ddl/ledger.ts"
import { roleIdentity } from "#compiler/physical/ddl/names.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import { refusalFunctionName } from "#compiler/write/refusal.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { termHeadDomain } from "#test/support/worlds/model/host.ts"
import { roleContexts } from "#test/support/worlds/model/session/state.ts"
import { filterReadsStored, keysOf, writtenOf } from "#test/support/worlds/model/session/writes.ts"

import type {
	BaseSpec,
	EntrySpec,
	FieldDomain,
	InstalledNames,
	InstallSpec,
	RoleSpec,
	Rule,
	WorldFunction
} from "#test/support/worlds/model/types.ts"

/**
 * Least privilege, checked from above: every privilege, membership, role attribute and row-security flag an
 * installation's PostgreSQL roles hold, derived from README "Security model" and the InstallSpec alone
 * (expectedPrivileges), and read from the catalog as PostgreSQL judges it (installedPrivileges). A suite compares the
 * two as sets: nothing more is held, and nothing less.
 */

/** Who holds a privilege: a login or role of the installation by its declared name, PUBLIC, or a stranger. */
export type Grantee =
	| { readonly kind: "login"; readonly name: string }
	| { readonly kind: "role"; readonly name: string }
	| { readonly kind: "public" }
	| { readonly kind: "stranger"; readonly role: string }

/** The kinds of object a privilege is held on, as the catalog keeps them. */
export type PrivilegedObjectKind =
	| "schema"
	| "table"
	| "view"
	| "materialized-view"
	| "sequence"
	| "function"
	| "column"
	| "type"
	| "type-of-column"

/**
 * An object of the installation, where the catalog holds it. A type is named by a column it types (`type-of-column`):
 * a structural text domain's name derives from its pattern by the text package's rule, which no suite restates, so a
 * type that types a column of a table, a materialized view or a role's view is held through each column it types, and
 * only a type that types none (a roster's domain no field names, a pattern only a context reads) is held by its name.
 */
export type PrivilegeObject =
	| { readonly kind: "schema"; readonly schema: string }
	| {
			readonly kind: "table" | "view" | "materialized-view" | "sequence" | "function" | "type"
			readonly schema: string
			readonly name: string
	  }
	| {
			readonly kind: "column" | "type-of-column"
			readonly schema: string
			readonly relation: string
			readonly column: string
	  }

/** Every privilege type PostgreSQL defines on each kind of object. */
const privilegeTypes = {
	schema: ["USAGE", "CREATE"],
	table: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"],
	view: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"],
	"materialized-view": [
		"SELECT",
		"INSERT",
		"UPDATE",
		"DELETE",
		"TRUNCATE",
		"REFERENCES",
		"TRIGGER",
		"MAINTAIN"
	],
	sequence: ["USAGE", "SELECT", "UPDATE"],
	function: ["EXECUTE"],
	column: ["SELECT", "INSERT", "UPDATE", "REFERENCES"],
	type: ["USAGE"],
	"type-of-column": ["USAGE"]
} as const satisfies Readonly<Record<PrivilegedObjectKind, Arr.NonEmptyReadonlyArray<string>>>

export type PrivilegeType = (typeof privilegeTypes)[PrivilegedObjectKind][number]

/** A role attribute PostgreSQL keeps in pg_roles, held or not. */
export type RoleAttribute =
	| "LOGIN"
	| "INHERIT"
	| "SUPERUSER"
	| "CREATEDB"
	| "CREATEROLE"
	| "REPLICATION"
	| "BYPASSRLS"

/** A membership's options: the edge itself, and each of INHERIT, SET and ADMIN it holds over any grantor's row. */
export type MembershipOption = "member" | "inherit" | "set" | "admin"

/**
 * One thing a role holds: a privilege on an object (with or without its grant option), a membership option, a role
 * attribute, or a row-security flag of a table of the base schema.
 */
export type PrivilegeFact =
	| {
			readonly kind: "privilege"
			readonly grantee: Grantee
			readonly object: PrivilegeObject
			readonly privilege: PrivilegeType
			readonly grantable: boolean
	  }
	| {
			readonly kind: "membership"
			readonly member: Grantee
			readonly role: Grantee
			readonly option: MembershipOption
	  }
	| { readonly kind: "attribute"; readonly grantee: Grantee; readonly attribute: RoleAttribute }
	| { readonly kind: "row-security"; readonly table: string; readonly state: "enabled" | "forced" }

/** Every fact an installation holds, by its canonical text (factText): two sets compare by their keys. */
export type PrivilegeSet = ReadonlyMap<string, PrivilegeFact>

const granteeText = (g: Grantee): string => {
	switch (g.kind) {
		case "login":
			return `login ${g.name}`
		case "role":
			return `role ${g.name}`
		case "public":
			return "PUBLIC"
		case "stranger":
			return `stranger ${g.role}`
	}
}

const objectText = (o: PrivilegeObject): string => {
	switch (o.kind) {
		case "schema":
			return `schema ${o.schema}`
		case "table":
		case "view":
		case "materialized-view":
		case "sequence":
		case "function":
		case "type":
			return `${o.kind} ${o.schema}.${o.name}`
		case "column":
		case "type-of-column":
			return `${o.kind} ${o.schema}.${o.relation}.${o.column}`
	}
}

/** A fact's canonical text: what it is, spelled once, the key a set holds it under and the line a diff prints. */
export const factText = (f: PrivilegeFact): string => {
	switch (f.kind) {
		case "privilege":
			return `${granteeText(f.grantee)} holds ${f.privilege}${f.grantable ? " WITH GRANT OPTION" : ""} on ${objectText(f.object)}`
		case "membership":
			return `${granteeText(f.member)} is a member of ${granteeText(f.role)}: ${f.option}`
		case "attribute":
			return `${granteeText(f.grantee)} is ${f.attribute}`
		case "row-security":
			return `table ${f.table} has row security ${f.state}`
	}
}

const privilegeSetOf = (facts: Iterable<PrivilegeFact>): PrivilegeSet =>
	new Map(Arr.map(Arr.fromIterable(facts), (f) => [factText(f), f] as const))

/** What one set holds that the other does not, each side's facts by canonical text, sorted. */
export interface PrivilegeDiff {
	readonly missing: ReadonlyArray<string>
	readonly extra: ReadonlyArray<string>
}

export const privilegeDiff = (expected: PrivilegeSet, installed: PrivilegeSet): PrivilegeDiff => ({
	missing: Arr.sort(
		Arr.filter(Arr.fromIterable(expected.keys()), (k) => !installed.has(k)),
		Order.String
	),
	extra: Arr.sort(
		Arr.filter(Arr.fromIterable(installed.keys()), (k) => !expected.has(k)),
		Order.String
	)
})

/** A name the installation must hold, or the defect of whoever named what it lacks. */
const required = <A>(name: Option.Option<A>, what: string): A =>
	Option.getOrThrowWith(name, () => new Error(`the installation's names lack ${what}`))

const tableOf = (names: InstalledNames, relation: string): ObjectName =>
	required(Record.get(names.tables, relation), `the table of ${relation}`)

const columnOf = (names: InstalledNames, relation: string, field: string): string =>
	required(
		Option.flatMap(Record.get(names.columns, relation), (c) => Record.get(c, field)),
		`the column of ${relation}.${field}`
	)

/**
 * The installation type a value of a domain is stored at, by a key that names it: a text field's structural domain by
 * its pattern and flags, a handle's roster domain by its roster; a base type (uuid, the integers, serial, boolean, a span's
 * range) is no installation type. Two patterns of one language share one domain, which these keys would split: the
 * bases spell each language once.
 */
const typeKeyOf = (domain: FieldDomain): Option.Option<string> => {
	switch (domain.kind) {
		case "text":
			return Option.some(`text /${domain.pattern}/${domain.flags}`)
		case "handle":
			return Option.some(`roster ${domain.closed}`)
		case "contract":
			return Option.some(`contract ${domain.name}`)
		case "uuid":
		case "integer":
		case "serial":
		case "boolean":
		case "span":
			return Option.none()
	}
}

/** One column of a relation of the installation: a table's, a materialized view's or a role's view's. */
interface InstalledColumn {
	readonly schema: string
	readonly relation: string
	readonly column: string
	readonly type: Option.Option<string>
}

/**
 * A rule set's head fields, each with the domain the arms that deliver it by a term give it (host.ts termHeadDomain),
 * which every literal of the field takes (README "Queries"): a literal is typed by its union's term-typed arms, so a
 * column one arm fills with a literal and another with a field of a domain is typed by that domain. A field only
 * literals fill has none: its literals are typed by their JavaScript values, as base types.
 */
const headDomains = (
	base: BaseSpec,
	rules: Arr.NonEmptyReadonlyArray<Rule>
): ReadonlyArray<readonly [string, Option.Option<FieldDomain>]> =>
	Arr.map(
		Record.keys(rules[0].head),
		(field) => [field, Option.fromUndefinedOr(termHeadDomain(base, rules, field))] as const
	)

/** The fields of a stored relation (an ordinary relation's, or a derived relation's head over its rules) with their domains. */
const storedFields = (
	base: BaseSpec,
	relation: string
): ReadonlyArray<readonly [string, Option.Option<FieldDomain>]> => {
	const ordinary = Arr.findFirst(base.relations, (r) => r.name === relation)
	if (Option.isSome(ordinary)) {
		return Arr.map(ordinary.value.fields, (f) => [f.name, Option.some(f.domain)] as const)
	}
	return Option.match(
		Arr.findFirst(base.derived, (d) => d.name === relation),
		{ onNone: () => [], onSome: (d) => headDomains(base, d.rules) }
	)
}

const isStored = (base: BaseSpec, relation: string): boolean =>
	Arr.some(base.relations, (r) => r.name === relation) ||
	Arr.some(base.derived, (d) => d.name === relation)

/**
 * A role's view of one of its entries: a whole entry over a table or a materialized view is named as that relation and
 * has its columns; a query entry is named by its name's conversion and has its head over its rules as columns, named by
 * theirs; a whole entry over a roster has no view, since every query reads a roster's facts as literals.
 */
const viewOf = (
	install: InstallSpec,
	names: InstalledNames,
	role: string,
	name: string,
	entry: EntrySpec
): Option.Option<{ readonly name: string; readonly columns: ReadonlyArray<InstalledColumn> }> => {
	const base = install.base
	const schema = roleSchemaOf(names, role)
	const view = identifierOf(identity.roleView(theoryRoleOf(names, role), parsedName(name)))
	if (entry.kind === "whole") {
		if (!isStored(base, entry.relation)) {
			return Option.none()
		}
		return Option.some({
			name: view,
			columns: Arr.map(storedFields(base, entry.relation), ([field, domain]) => ({
				schema,
				relation: view,
				column: columnOf(names, entry.relation, field),
				type: Option.flatMap(domain, typeKeyOf)
			}))
		})
	}
	return Option.some({
		name: view,
		columns: Arr.map(headDomains(base, entry.rules), ([field, domain]) => ({
			schema,
			relation: view,
			column: identifierOf(identity.column(parsedName(field))),
			type: Option.flatMap(domain, typeKeyOf)
		}))
	})
}

/** Every column of the installation: each stored relation's, and each role's views'. */
const installedColumns = (
	install: InstallSpec,
	names: InstalledNames
): ReadonlyArray<InstalledColumn> => {
	const base = install.base
	const stored = Arr.flatMap(
		[...Arr.map(base.relations, (r) => r.name), ...Arr.map(base.derived, (d) => d.name)],
		(relation) => {
			const table = tableOf(names, relation)
			return Arr.map(storedFields(base, relation), ([field, domain]) => ({
				schema: table.schema,
				relation: table.name,
				column: columnOf(names, relation, field),
				type: Option.flatMap(domain, typeKeyOf)
			}))
		}
	)
	const views = Arr.flatMap(install.roles, (role) =>
		Arr.flatMap(Record.toEntries(role.entries), ([name, entry]) =>
			Option.match(viewOf(install, names, role.name, name, entry), {
				onNone: () => [],
				onSome: (v) => v.columns
			})
		)
	)
	return [...stored, ...views]
}

/** A role's identity at the naming door, under the installation's (core/identity.ts). */
const theoryRoleOf = (names: InstalledNames, role: string) =>
	roleIdentity(names.installation, parsedName(role), SourceLoc(`role ${role}`, []))

/** A role's own schema of views, which the naming door mints from the role's identity. */
const roleSchemaOf = (names: InstalledNames, role: string): string =>
	identifierOf(identity.roleSchema(theoryRoleOf(names, role)))

const serialFields = (base: BaseSpec, relation: string): ReadonlyArray<string> =>
	Arr.flatMap(base.relations, (r) =>
		r.name === relation
			? Arr.flatMap(r.fields, (f) => (f.domain.kind === "serial" ? [f.name] : []))
			: []
	)

/**
 * The functions an installation defines for its worlds and writers, which a perturbation may redefine (a law's are the
 * laws' own): for each query entry a role writes, a key probe of each key of its target (the model's keysOf order, the
 * index a WorldFunction names), and its filter function when its membership reads a stored relation besides its
 * target's row (filterReadsStored); and the advance function of each serial field.
 */
export const definedWorldFunctions = (install: InstallSpec): ReadonlyArray<WorldFunction> => {
	const base = install.base
	return [
		...Arr.flatMap(install.roles, (role) =>
			Arr.flatMap(writtenOf(base, role), (w): ReadonlyArray<WorldFunction> =>
				w.kind === "whole"
					? []
					: [
							...Arr.map(indices(keysOf(base, w.target).length), (key): WorldFunction => ({
								kind: "key-probe",
								role: role.name,
								entry: w.entry,
								key
							})),
							...(filterReadsStored(w.rules)
								? [{ kind: "filter" as const, role: role.name, entry: w.entry }]
								: [])
						]
			)
		),
		...Arr.flatMap(base.relations, (r) =>
			Arr.map(serialFields(base, r.name), (field): WorldFunction => ({
				kind: "advance",
				relation: r.name,
				field
			}))
		)
	]
}

const isMutable = (base: BaseSpec, relation: string): boolean =>
	Arr.some(base.relations, (r) => r.name === relation && r.mutability === "mutable")

const privilege = (
	grantee: Grantee,
	object: PrivilegeObject,
	privilegeType: PrivilegeType
): PrivilegeFact => ({
	kind: "privilege",
	grantee,
	object,
	privilege: privilegeType,
	grantable: false
})

/**
 * What one role holds, from README "Security model" and, where it is silent, the installation's statement of it
 * (physical/ddl/roles.ts):
 * - USAGE on the base schema, whose tables it writes and whose functions it calls, and on its own schema, which holds
 *   its views: reads go through views in the role's own schema;
 * - SELECT on each of its views, and nothing else on a view;
 * - for each entry it writes over a table T (a role holds no privilege on a table it does not write): a whole entry
 *   SELECT, INSERT and DELETE on T, and UPDATE when T is mutable (immutable relations: no role holds UPDATE on them);
 *   a writable query entry SELECT and INSERT on every column of T, UPDATE on each column of a mutable T a free head
 *   field writes (HeadField: outside every key, and not bound by a positive context match, whose claim fixes its value
 *   in every fact of the world), and DELETE on T; and EXECUTE on the advance function of each serial field of T (a
 *   serial column draws its identity default with no sequence privilege, and the advance function is the one way past
 *   an explicit value). TRUNCATE is granted to no one;
 * - for each writable query entry, EXECUTE on its key probes, one per key of T, and on its filter function when its
 *   membership reads a stored relation besides T's row; and EXECUTE on the refusal function when it writes or reads a context
 *   (a context source refuses an unreadable claims setting through it);
 * - MAINTAIN on the materialized view of each derived relation its refresh list names;
 * - USAGE on every installation type its views' columns and its written tables' columns are typed by;
 * - the attribute INHERIT, PostgreSQL's default, which passes nothing on since it is granted no role.
 */
const roleFacts = (
	install: InstallSpec,
	names: InstalledNames,
	role: RoleSpec
): ReadonlyArray<PrivilegeFact> => {
	const base = install.base
	const grantee: Grantee = { kind: "role", name: role.name }
	const own = roleSchemaOf(names, role.name)
	const schemas = [
		...Arr.map(names.levels, (schema) => privilege(grantee, { kind: "schema", schema }, "USAGE")),
		privilege(grantee, { kind: "schema", schema: own }, "USAGE")
	]
	const views = Arr.flatMap(Record.toEntries(role.entries), ([name, entry]) =>
		Option.match(viewOf(install, names, role.name, name, entry), {
			onNone: () => [],
			onSome: (v) => [privilege(grantee, { kind: "view", schema: own, name: v.name }, "SELECT")]
		})
	)
	const writes = Arr.flatMap(writtenOf(base, role), (w) => {
		const relation = w.target
		const table = tableOf(names, relation)
		const at: PrivilegeObject = { kind: "table", schema: table.schema, name: table.name }
		const fields = Arr.map(storedFields(base, relation), ([field]) => field)
		const column = (field: string): PrivilegeObject => ({
			kind: "column",
			schema: table.schema,
			relation: table.name,
			column: columnOf(names, relation, field)
		})
		const advances = Arr.map(serialFields(base, relation), (field) =>
			privilege(
				grantee,
				{
					kind: "function",
					schema: table.schema,
					name: identifierOf(identity.advance(relation, field))
				},
				"EXECUTE"
			)
		)
		if (w.kind === "whole") {
			return [
				...Arr.map(
					isMutable(base, relation)
						? (["SELECT", "INSERT", "UPDATE", "DELETE"] as const)
						: (["SELECT", "INSERT", "DELETE"] as const),
					(p) => privilege(grantee, at, p)
				),
				...advances
			]
		}
		const updatable = isMutable(base, relation)
			? Arr.flatMap(Record.values(w.head), (h) => (h.kind === "free" ? [h.field] : []))
			: []
		const fn = (fnName: string): PrivilegeFact =>
			privilege(grantee, { kind: "function", schema: names.schema, name: fnName }, "EXECUTE")
		return [
			...Arr.flatMap(fields, (field) => [
				privilege(grantee, column(field), "SELECT"),
				privilege(grantee, column(field), "INSERT")
			]),
			...Arr.map(updatable, (field) => privilege(grantee, column(field), "UPDATE")),
			privilege(grantee, at, "DELETE"),
			...advances,
			...Arr.map(keysOf(base, relation), (key) =>
				fn(identifierOf(identity.keyProbe(theoryRoleOf(names, role.name), w.entry, key)))
			),
			...(filterReadsStored(w.rules)
				? [fn(identifierOf(identity.filter(theoryRoleOf(names, role.name), w.entry)))]
				: [])
		]
	})
	const refusal =
		role.write.length > 0 || roleContexts(role).size > 0
			? [
					privilege(
						grantee,
						{ kind: "function", schema: names.schema, name: refusalFunctionName },
						"EXECUTE"
					)
				]
			: []
	const refreshes = Arr.map(role.refresh, (relation) => {
		const view = tableOf(names, relation)
		return privilege(
			grantee,
			{ kind: "materialized-view", schema: view.schema, name: view.name },
			"MAINTAIN"
		)
	})
	return [
		...schemas,
		...views,
		...writes,
		...refusal,
		...refreshes,
		{ kind: "attribute", grantee, attribute: "INHERIT" }
	]
}

/** The installation types a role names: its views' columns' and its written tables' columns'. */
const typesUsedBy = (
	install: InstallSpec,
	names: InstalledNames,
	role: RoleSpec
): ReadonlySet<string> => {
	const base = install.base
	const viewed = Arr.flatMap(
		Record.toEntries(role.entries),
		([name, entry]): ReadonlyArray<string> => {
			if (entry.kind === "whole" && Arr.some(base.closed, (c) => c.name === entry.relation)) {
				return [`roster ${entry.relation}`]
			}
			return Option.match(viewOf(install, names, role.name, name, entry), {
				onNone: () => [],
				onSome: (v) => Arr.getSomes(Arr.map(v.columns, (c) => c.type))
			})
		}
	)
	const written = Arr.flatMap(writtenOf(base, role), (w) =>
		Arr.getSomes(
			Arr.map(storedFields(base, w.target), ([, domain]) => Option.flatMap(domain, typeKeyOf))
		)
	)
	return new Set([...viewed, ...written])
}

/** A roster's names constant, as the installation names it. */
const namesConstantOf = (names: InstalledNames, roster: string): string =>
	required(Record.get(names.rosterConstants, roster), `the names constant of roster ${roster}`)

/**
 * Each role's USAGE on the installation types it names: through each column of the installation a type it names
 * types, and by name for a roster's domain no column is typed by; and EXECUTE on each names constant of a roster it
 * uses, which that domain's CHECK and its views' decoded columns call as the invoker.
 */
const typeFacts = (install: InstallSpec, names: InstalledNames): ReadonlyArray<PrivilegeFact> => {
	const columns = installedColumns(install, names)
	const typed = new Set(Arr.getSomes(Arr.map(columns, (c) => c.type)))
	return Arr.flatMap(install.roles, (role) => {
		const grantee: Grantee = { kind: "role", name: role.name }
		const used = typesUsedBy(install, names, role)
		const throughColumns = Arr.flatMap(columns, (c) =>
			Option.exists(c.type, (t) => used.has(t))
				? [
						privilege(
							grantee,
							{ kind: "type-of-column", schema: c.schema, relation: c.relation, column: c.column },
							"USAGE"
						)
					]
				: []
		)
		const byName = Arr.flatMap(install.base.closed, (closed) =>
			used.has(`roster ${closed.name}`) && !typed.has(`roster ${closed.name}`)
				? [
						privilege(
							grantee,
							{
								kind: "type",
								schema: names.schema,
								name: identifierOf(identity.rosterDomain(parsedName(closed.name)))
							},
							"USAGE"
						)
					]
				: []
		)
		/** EXECUTE on the names constant of each roster it uses: its domain's CHECK and its views' decoded columns call it
		 * as the invoker (§3.12, "Role views"). */
		const executes = Arr.flatMap(install.base.closed, (closed) =>
			used.has(`roster ${closed.name}`)
				? [
						privilege(
							grantee,
							{ kind: "function", schema: names.schema, name: namesConstantOf(names, closed.name) },
							"EXECUTE"
						)
					]
				: []
		)
		return [...throughColumns, ...byName, ...executes]
	})
}

/**
 * Every privilege, membership, attribute and row-security flag the installation of `install` holds, under `names`,
 * derived from README "Security model" independently of grizzle's source:
 * - a login logs in and inherits nothing (LOGIN NOINHERIT); it holds USAGE on the base schema, SELECT on the ledger and
 *   EXECUTE on the snapshot guard, the lock and the check Db.open and every transaction of a Db take as the login, and
 *   nothing else: whoever holds its password reaches its roles only through SET ROLE;
 * - each role of a login has the login as its one member, WITH SET and neither INHERIT nor ADMIN: the login acts as
 *   the role only after SET ROLE, and never holds the role's privileges as its own; a role is a member of nothing;
 * - each role holds what roleFacts and typeFacts list, and nothing else;
 * - PUBLIC holds nothing on any object of the installation;
 * - row security is enabled, and never forced, on exactly the tables some role writes through a query entry.
 * The migration identity owns every object and is no grantee here; its membership in each role it created is its own.
 */
export const expectedPrivileges = (install: InstallSpec, names: InstalledNames): PrivilegeSet => {
	const base = install.base
	const ledger = ledgerTable(names.schema).table.name
	const logins = Arr.flatMap(install.logins, (login): ReadonlyArray<PrivilegeFact> => {
		const grantee: Grantee = { kind: "login", name: login.name }
		return [
			{ kind: "attribute", grantee, attribute: "LOGIN" },
			privilege(grantee, { kind: "schema", schema: names.schema }, "USAGE"),
			privilege(grantee, { kind: "table", schema: names.schema, name: ledger }, "SELECT"),
			privilege(
				grantee,
				{ kind: "function", schema: names.schema, name: snapshotGuardName },
				"EXECUTE"
			),
			...Arr.flatMap(login.roles, (role): ReadonlyArray<PrivilegeFact> => [
				{
					kind: "membership",
					member: grantee,
					role: { kind: "role", name: role },
					option: "member"
				},
				{ kind: "membership", member: grantee, role: { kind: "role", name: role }, option: "set" }
			])
		]
	})
	const roles = Arr.flatMap(install.roles, (role) => roleFacts(install, names, role))
	const secured = Arr.dedupe(
		Arr.flatMap(install.roles, (role) =>
			Arr.flatMap(writtenOf(base, role), (w) => (w.kind === "query" ? [w.target] : []))
		)
	)
	const rowSecurity = Arr.map(secured, (relation): PrivilegeFact => ({
		kind: "row-security",
		table: tableOf(names, relation).name,
		state: "enabled"
	}))
	return privilegeSetOf([...logins, ...roles, ...typeFacts(install, names), ...rowSecurity])
}

/** The rows of the privilege queries: grantee, object kind, schema, relation or name, column or "", privilege, grant option. */
type PrivilegeRows = ReadonlyArray<
	readonly [
		grantee: string,
		kind: string,
		schema: string,
		name: string,
		column: string,
		privilege: string,
		grantable: boolean
	]
>

/** The rows of the membership query: member, role, and its INHERIT, SET and ADMIN options. */
type MemberRows = ReadonlyArray<
	readonly [member: string, role: string, inherit: boolean, set: boolean, admin: boolean]
>

/** The rows of the attribute query: a role, and whether it holds each attribute, in attributeOrder. */
type AttributeRows = ReadonlyArray<
	readonly [
		role: string,
		login: boolean,
		inherit: boolean,
		superuser: boolean,
		createDb: boolean,
		createRole: boolean,
		replication: boolean,
		bypassRls: boolean
	]
>

/** The rows of the row-security query: a table, and whether row security is enabled and forced on it. */
type FlagRows = ReadonlyArray<readonly [table: string, enabled: boolean, forced: boolean]>

/** The rows of the grantee query: a role's name. */
type NameRows = ReadonlyArray<readonly [name: string]>

/**
 * Whether a namespace (aliased `alias`) is the installation's: a level's schema ($1, the root's first), or a schema
 * under a level's prefix, such as a role's.
 */
const ours = (alias: string): string =>
	`(${alias}.nspname = ANY($1::text[]) OR EXISTS (SELECT FROM unnest($1::text[]) AS l(s) WHERE starts_with(${alias}.nspname::text, l.s || '__')))`

/**
 * The privilege types of a kind crossed with the grant option, as a FROM item `p(priv, grantable)`, and the
 * has_*_privilege argument that asks for each.
 */
const privilegesOf = (kind: PrivilegedObjectKind): string =>
	`unnest(ARRAY[${Arr.join(
		Arr.map(privilegeTypes[kind], (p) => `'${p}'`),
		", "
	)}]) AS p(priv) CROSS JOIN (VALUES (false), (true)) AS o(grantable)`
const asked = "CASE WHEN o.grantable THEN p.priv || ' WITH GRANT OPTION' ELSE p.priv END"

/**
 * One privilege query: every grantee ($2) crossed with every object `objects` lists (columns oid, kind, schema, name,
 * column) and every privilege type of `kind`, kept where `check` (a has_*_privilege over g.name, x.oid and the asked
 * privilege) holds. The objects are materialized first, so no check runs on a row outside the installation.
 */
const privilegeQuery = (objects: string, kind: PrivilegedObjectKind, check: string): string =>
	`WITH x AS MATERIALIZED (${objects})
	SELECT g.name, x.kind, x.schema, x.name, x.col, p.priv, o.grantable
	FROM unnest($2::text[]) AS g(name) CROSS JOIN x CROSS JOIN ${privilegesOf(kind)}
	WHERE ${check}`

const relationsIn = `SELECT c.oid, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized-view' ELSE 'table' END AS kind, n.nspname::text AS schema, c.relname::text AS name, '' AS col
	FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${ours("n")} AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`

const columnsIn = `SELECT c.oid, a.attnum, 'column' AS kind, n.nspname::text AS schema, c.relname::text AS name, a.attname::text AS col
	FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
	WHERE ${ours("n")} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped`

/**
 * The installation's enums and domains: each through every column of the installation it types, and by its name when
 * it types none. A stored generated column, a law's column (physical/ddl/tables.ts lawColumn), is no column a role
 * names or writes: no view shows it and no grant reaches it, so it names no type.
 */
const typesIn = `WITH t AS (SELECT ty.oid, n.nspname::text AS schema, ty.typname::text AS name FROM pg_catalog.pg_type ty JOIN pg_catalog.pg_namespace n ON n.oid = ty.typnamespace WHERE ${ours("n")} AND ty.typtype IN ('e', 'd')),
	u AS (SELECT t.oid, n.nspname::text AS schema, c.relname::text AS name, a.attname::text AS col FROM t JOIN pg_catalog.pg_attribute a ON a.atttypid = t.oid AND a.attnum > 0 AND NOT a.attisdropped JOIN pg_catalog.pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r', 'p', 'v', 'm', 'f') JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${ours("n")}
 AND a.attgenerated <> 's')
	SELECT u.oid, 'type-of-column' AS kind, u.schema, u.name, u.col FROM u
	UNION ALL SELECT t.oid, 'type', t.schema, t.name, '' FROM t WHERE NOT EXISTS (SELECT 1 FROM u WHERE u.oid = t.oid)`

/**
 * The catalog queries, each over the installation's level schemas ($1, the root's first) and its grantees ($2: PostgreSQL role names and
 * `public`). Every privilege is PostgreSQL's own judgement (has_*_privilege): a role's grants, PUBLIC's and every role
 * it inherits from. A column privilege is read where the role holds it beyond the whole table. Hand-written
 * introspection: test support, not emitted grizzle SQL.
 */
const queries = {
	grantees: `SELECT r.rolname::text FROM pg_catalog.pg_roles r WHERE EXISTS (SELECT FROM unnest($1::text[]) AS l(s) WHERE starts_with(r.rolname::text, l.s || '__')) OR r.rolname = ANY($2::text[])`,
	schemas: privilegeQuery(
		`SELECT n.oid, 'schema' AS kind, n.nspname::text AS schema, '' AS name, '' AS col FROM pg_catalog.pg_namespace n WHERE ${ours("n")}`,
		"schema",
		`pg_catalog.has_schema_privilege(g.name, x.oid, ${asked})`
	),
	relations: privilegeQuery(
		relationsIn,
		"table",
		`pg_catalog.has_table_privilege(g.name, x.oid, ${asked})`
	),
	columns: `WITH x AS MATERIALIZED (${columnsIn})
	SELECT g.name, x.kind, x.schema, x.name, x.col, p.priv, o.grantable
	FROM unnest($2::text[]) AS g(name) CROSS JOIN x CROSS JOIN ${privilegesOf("column")}
	WHERE pg_catalog.has_column_privilege(g.name, x.oid, x.attnum, ${asked}) AND NOT pg_catalog.has_table_privilege(g.name, x.oid, ${asked})`,
	sequences: privilegeQuery(
		`SELECT c.oid, 'sequence' AS kind, n.nspname::text AS schema, c.relname::text AS name, '' AS col FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${ours("n")} AND c.relkind = 'S'`,
		"sequence",
		`pg_catalog.has_sequence_privilege(g.name, x.oid, ${asked})`
	),
	functions: privilegeQuery(
		`SELECT f.oid, 'function' AS kind, n.nspname::text AS schema, f.proname::text AS name, '' AS col FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid = f.pronamespace WHERE ${ours("n")}`,
		"function",
		`pg_catalog.has_function_privilege(g.name, x.oid, ${asked})`
	),
	types: privilegeQuery(typesIn, "type", `pg_catalog.has_type_privilege(g.name, x.oid, ${asked})`),
	members: `WITH r AS MATERIALIZED (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY($2::text[])), owner AS (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname = ($1::text[])[1])
	SELECT u.rolname::text, g.rolname::text, bool_or(m.inherit_option), bool_or(m.set_option), bool_or(m.admin_option)
	FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles u ON u.oid = m.member JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
	WHERE (m.member IN (SELECT oid FROM r) OR m.roleid IN (SELECT oid FROM r)) AND m.member NOT IN (SELECT nspowner FROM owner)
	GROUP BY u.rolname, g.rolname`,
	attributes: `SELECT r.rolname::text, r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
	FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($2::text[]) AND $1::text[] IS NOT NULL`,
	rowSecurity: `SELECT c.relname::text, c.relrowsecurity, c.relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
	WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p') AND $2::text[] IS NOT NULL`
} as const

const objectKinds: Arr.NonEmptyReadonlyArray<PrivilegedObjectKind> = [
	"schema",
	"table",
	"view",
	"materialized-view",
	"sequence",
	"function",
	"column",
	"type",
	"type-of-column"
]

const attributeOrder: Arr.NonEmptyReadonlyArray<RoleAttribute> = [
	"LOGIN",
	"INHERIT",
	"SUPERUSER",
	"CREATEDB",
	"CREATEROLE",
	"REPLICATION",
	"BYPASSRLS"
]

/** The object a privilege row names, by its kind; a kind no query returns is a defect of this support code. */
const objectOf = (
	kind: string,
	schema: string,
	name: string,
	column: string
): [PrivilegedObjectKind, PrivilegeObject] => {
	const k = Option.getOrThrowWith(
		Arr.findFirst(objectKinds, (o) => o === kind),
		() => new Error(`privileges: a catalog row of kind ${kind}`)
	)
	switch (k) {
		case "schema":
			return [k, { kind: k, schema }]
		case "table":
		case "view":
		case "materialized-view":
		case "sequence":
		case "function":
		case "type":
			return [k, { kind: k, schema, name }]
		case "column":
		case "type-of-column":
			return [k, { kind: k, schema, relation: name, column }]
	}
}

/**
 * The privileges, memberships, attributes and row-security flags the installation named by `names` holds, as
 * PostgreSQL judges them, read by the substrate's owner: over every role of the installation (its logins, its roles,
 * and any other role under its prefix, a stranger), PUBLIC, and every object of its schemas. A membership is read
 * wherever one side is such a role and the other is any role but the schema's owner, whose membership in each role it
 * created is its own.
 */
export const installedPrivileges = (
	names: InstalledNames
): Effect.Effect<PrivilegeSet, SqlError, Substrate> =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const read = (sql: string, grantees: ReadonlyArray<string>) =>
			admin.queryValues(sql, [names.levels, grantees])
		const known = [...Record.values(names.logins), ...Record.values(names.roles)]
		const granteeRead = yield* read(queries.grantees, known)
		const granteeRows = trusted<NameRows>(granteeRead)
		const roles = Arr.map(granteeRows, ([name]) => name)
		const grantees = [...roles, "public"]
		const byRole = new Map<string, Grantee>([
			...Arr.map(Record.toEntries(names.logins), ([name, role]): readonly [string, Grantee] => [
				role,
				{ kind: "login", name }
			]),
			...Arr.map(Record.toEntries(names.roles), ([name, role]): readonly [string, Grantee] => [
				role,
				{ kind: "role", name }
			])
		])
		const granteeOf = (role: string): Grantee =>
			role === "public" ? { kind: "public" } : (byRole.get(role) ?? { kind: "stranger", role })
		const privilegesFrom = (sql: string) =>
			Effect.map(read(sql, grantees), (rows) =>
				Arr.map(
					trusted<PrivilegeRows>(rows),
					([g, kind, schema, name, column, named, grantable]): PrivilegeFact => {
						const [k, object] = objectOf(kind, schema, name, column)
						const privilegeType = Option.getOrThrowWith(
							Arr.findFirst(privilegeTypes[k], (p: PrivilegeType) => p === named),
							() => new Error(`privileges: a catalog row's privilege ${named} on a ${k}`)
						)
						return {
							kind: "privilege",
							grantee: granteeOf(g),
							object,
							privilege: privilegeType,
							grantable
						}
					}
				)
			)
		const privileges = yield* Effect.forEach(
			[
				queries.schemas,
				queries.relations,
				queries.columns,
				queries.sequences,
				queries.functions,
				queries.types
			],
			privilegesFrom
		)
		const memberRead = yield* read(queries.members, roles)
		const memberRows = trusted<MemberRows>(memberRead)
		const members = Arr.flatMap(memberRows, ([member, role, inherit, set, adminOption]) => {
			const edge = (option: MembershipOption): PrivilegeFact => ({
				kind: "membership",
				member: granteeOf(member),
				role: granteeOf(role),
				option
			})
			return [
				edge("member"),
				...(inherit ? [edge("inherit")] : []),
				...(set ? [edge("set")] : []),
				...(adminOption ? [edge("admin")] : [])
			]
		})
		const attributeRead = yield* read(queries.attributes, roles)
		const attributeRows = trusted<AttributeRows>(attributeRead)
		const attributes = Arr.flatMap(attributeRows, ([role, ...held]) =>
			Arr.flatMap(Arr.zip(attributeOrder, held), ([attribute, on]): ReadonlyArray<PrivilegeFact> =>
				on ? [{ kind: "attribute", grantee: granteeOf(role), attribute }] : []
			)
		)
		const rowSecurityRead = yield* read(queries.rowSecurity, roles)
		const rowSecurityRows = trusted<FlagRows>(rowSecurityRead)
		const rowSecurity = Arr.flatMap(
			rowSecurityRows,
			([table, enabled, forced]): ReadonlyArray<PrivilegeFact> => [
				...(enabled ? [{ kind: "row-security", table, state: "enabled" } as const] : []),
				...(forced ? [{ kind: "row-security", table, state: "forced" } as const] : [])
			]
		)
		return privilegeSetOf([...Arr.flatten(privileges), ...members, ...attributes, ...rowSecurity])
	})

/**
 * An object of the installation as a statement names it: the object, the SQL name a statement acts on (a relation's,
 * a sequence's, a function's or a type's, quoted and qualified; for a schema, a relation in it, when it holds one; for
 * a type that types a column, the type's), the columns a statement can name (each of a relation's, or the column
 * itself), a function's arity, and whether it returns trigger, so no statement can call it.
 */
export interface InstalledObject {
	readonly object: PrivilegeObject
	readonly target: Option.Option<string>
	readonly columns: ReadonlyArray<string>
	readonly arity: number
	readonly trigger: boolean
}

/** The rows of objectsQuery: kind, schema, name, column or "", target or "", columns, arity, and whether it returns trigger. */
type ObjectRows = ReadonlyArray<
	readonly [
		kind: string,
		schema: string,
		name: string,
		column: string,
		target: string,
		columns: ReadonlyArray<string>,
		arity: number,
		trigger: boolean
	]
>

/**
 * Every object of the installation's schemas a privilege is held on, as installedObjects reads them, in one order, so
 * a run seed draws the same attempts. A type is each object typesIn reads it through, and no other: a stored generated
 * column types nothing a role holds, so an attempt through it would ask a role that holds the type.
 */
const objectsQuery = `WITH rel AS (SELECT c.oid, c.relkind, n.nspname::text AS schema, c.relname::text AS name, pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) AS target
		FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${ours("n")} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')),
	att AS (SELECT r.oid, r.schema, r.name, a.attnum, a.attname::text AS col, a.atttypid FROM rel r JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE r.relkind <> 'S'),
	typ AS (SELECT y.kind, y.schema, y.name, y.col, pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(t.typname) AS target
		FROM (${typesIn}) y JOIN pg_catalog.pg_type t ON t.oid = y.oid JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace)
	SELECT 'schema', n.nspname::text, '', '', COALESCE((SELECT r.target FROM rel r WHERE r.schema = n.nspname AND r.relkind <> 'S' ORDER BY r.name LIMIT 1), ''), '{}'::text[], 0, false
		FROM pg_catalog.pg_namespace n WHERE ${ours("n")}
	UNION ALL SELECT CASE r.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized-view' WHEN 'S' THEN 'sequence' ELSE 'table' END, r.schema, r.name, '', r.target,
		COALESCE((SELECT pg_catalog.array_agg(pg_catalog.quote_ident(a.col) ORDER BY a.attnum) FROM att a WHERE a.oid = r.oid), '{}'::text[]), 0, false FROM rel r
	UNION ALL SELECT 'column', a.schema, a.name, a.col, (SELECT r.target FROM rel r WHERE r.oid = a.oid), ARRAY[pg_catalog.quote_ident(a.col)], 0, false FROM att a
	UNION ALL SELECT t.kind, t.schema, t.name, t.col, t.target, CASE t.kind WHEN 'type-of-column' THEN ARRAY[pg_catalog.quote_ident(t.col)] ELSE '{}'::text[] END, 0, false FROM typ t
	UNION ALL SELECT 'function', n.nspname::text, f.proname::text, '', pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(f.proname), '{}'::text[], f.pronargs::int4, f.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
		FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid = f.pronamespace WHERE ${ours("n")} AND $2::text[] IS NOT NULL
	ORDER BY 1, 2, 3, 4, 7`

const present = (text: string): Option.Option<string> =>
	text === "" ? Option.none() : Option.some(text)

/** Every object of the installation named by `names` a privilege can be held on, read by the substrate's owner. */
export const installedObjects = (
	names: InstalledNames
): Effect.Effect<ReadonlyArray<InstalledObject>, SqlError, Substrate> =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const rows = yield* admin.queryValues(objectsQuery, [names.levels, []])
		return Arr.map(
			trusted<ObjectRows>(rows),
			([kind, schema, name, column, target, columns, arity, trigger]): InstalledObject => ({
				object: objectOf(kind, schema, name, column)[1],
				target: present(target),
				columns,
				arity,
				trigger
			})
		)
	})
