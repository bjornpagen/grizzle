import { combine, compareStrings, mapInput } from "#compiler/core/order.ts"
import type { ManifestStatement } from "#compiler/deploy/admission/manifest.ts"
import { databaseDefaults } from "#compiler/physical/ddl/isolation.ts"
import type {
	AlterDefaultPrivileges,
	CreatePolicy,
	GrantObjects,
	Grantee,
	Privilege
} from "#compiler/sql/ast.ts"
import {
	printFunctionSignature,
	printObjectName,
	quoteIdent,
	storedSettingValue
} from "#compiler/sql/print.ts"

/** The object families a privilege is held on: a column's is a privilege held on it beyond its table's. */
export const privilegeFamilyNames = [
	"schema",
	"table",
	"column",
	"sequence",
	"type",
	"function"
] as const
export type PrivilegeFamily = (typeof privilegeFamilyNames)[number]

/** Each family's privilege types, as PostgreSQL defines them on it. */
export const privilegeFamilies: Readonly<Record<PrivilegeFamily, ReadonlyArray<string>>> = {
	schema: ["USAGE", "CREATE"],
	table: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"],
	column: ["SELECT", "INSERT", "UPDATE", "REFERENCES"],
	sequence: ["USAGE", "SELECT", "UPDATE"],
	type: ["USAGE"],
	function: ["EXECUTE"]
}

/** A privilege the role must hold: its family, its object as SQL text PostgreSQL resolves, where the catalog holds the
 * object (its schema and its name; a schema's own name twice), the column of a column privilege (empty for every other
 * family), and its type. Admission reads a role's privileges as its login, which holds no USAGE on the role's schema,
 * where PostgreSQL refuses a lookup by qualified name, so a relation is found through the catalog by schema and name. */
export interface ExpectedPrivilege {
	readonly family: PrivilegeFamily
	readonly object: string
	readonly schema: string
	readonly name: string
	readonly column: string
	readonly privilege: string
}

/** An object a grant names: as SQL text, and where the catalog holds it. */
interface GrantedObject {
	readonly object: string
	readonly schema: string
	readonly name: string
}

/** A policy naming a role: its table's name in the installed schema and its own. */
export interface ExpectedPolicy {
	readonly table: string
	readonly name: string
}

/** What admission requires of one login or role, and of the database's settings, as the target snapshot installs them.
 * Both admissions read these, from the manifest's statements: Db.open's of the opened role and its login, and the drift
 * check after `grizzle migrate` of every login and role the snapshot creates.
 * - Settings, each a map from parameter to the value PostgreSQL stores (storedSettingValue): a login's or role's own
 *   exactly (every ALTER ROLE <role> SET the manifest holds: a login's defaults, its search_path pin among them, a
 *   theory role's none), none for it in this database alone (ALTER ROLE ... IN DATABASE ... SET, which takes
 *   precedence over its own at login), and the database's own defaults the installation's databaseDefault object sets
 *   (ALTER DATABASE ... SET) among whatever others the database's owner sets. grizzle never issues a session-level SET.
 * - Privileges, as PostgreSQL itself judges them: what the role may do to each object of the installed schema and of
 *   every role's schema, and to each other schema the snapshot grants on, through its own grants, PUBLIC's and every
 *   role it inherits from (has_*_privilege), is exactly what the manifest grants it, a column-level privilege
 *   (GRANT ... (<columns>)) judged on each column beyond what the role holds on the whole table. An expected privilege
 *   names its object in the SQL the GRANT names it with, which PostgreSQL resolves to the object's OID (to_regclass and
 *   its kin), so the comparison is by catalog identity, never by a spelling of a name.
 * - Attributes: a login logs in and inherits nothing; a theory role does not log in; neither is a superuser, creates
 *   databases or roles, replicates or bypasses row security.
 * - Memberships, judged over every grant of a pair (one per grantor): the roles a login is granted, each WITH INHERIT
 *   FALSE, SET TRUE and no ADMIN, exactly; a theory role is granted none. A role granted beyond them is tolerated only
 *   WITH SET FALSE and no ADMIN, so it opens no SET ROLE path; what it passes on by inheritance is the privileges'
 *   business, which judge what the role can do, its own grants and every role it inherits from alike.
 * - Members: the roles granted this one: a theory role's exactly its login, WITH INHERIT FALSE, SET TRUE and no ADMIN;
 *   a login's none. A member beyond them is tolerated only WITH INHERIT FALSE, SET FALSE and no ADMIN, so nothing acts
 *   through the role but its login.
 * - Policies: the policies naming the role, on the installed schema's tables, exactly, by table and name; and row
 *   security, enabled and not forced, on every table the role writes through a query entry (the tables of its policies
 *   that filter rows, every one but a whole entry's `true`, that the manifest enables row security on).
 * The policies' predicates and the views' definitions are the drift check's, which compares them as PostgreSQL deparses
 * them. */
export interface RoleExpectation {
	readonly role: string
	/** Whether it may log in: a login, or a theory role. */
	readonly login: boolean
	/** Its own defaults, by parameter. */
	readonly settings: ReadonlyMap<string, string>
	/** Each privilege once, by family, object, column and type. */
	readonly privileges: ReadonlyArray<ExpectedPrivilege>
	/** The schemas whose objects' privileges are judged: the installed schema and every role's schema. */
	readonly schemas: ReadonlyArray<string>
	/** The other schemas its privileges name, whose own privileges are read. */
	readonly otherSchemas: ReadonlyArray<string>
	/** The roles it is granted, sorted. */
	readonly memberships: ReadonlyArray<string>
	/** The roles granted it, sorted: a theory role's login. */
	readonly members: ReadonlyArray<string>
	/** The policies naming it, sorted by table and name. */
	readonly policies: ReadonlyArray<ExpectedPolicy>
	/** The tables of the installed schema it writes through a query entry, whose row security must stand, sorted. */
	readonly secured: ReadonlyArray<string>
}

/** The database's own defaults, by parameter: the installation's one source of them. */
export const databaseSettings: ReadonlyMap<string, string> = new Map(
	databaseDefaults.map((d) => [d.parameter, d.value] as const)
)

const familyOf = (on: GrantObjects): PrivilegeFamily => {
	switch (on.kind) {
		case "SCHEMA":
			return "schema"
		case "TABLE":
			return "table"
		case "SEQUENCE":
			return "sequence"
		case "TYPE":
		case "DOMAIN":
			return "type"
		case "FUNCTION":
			return "function"
	}
}

/** Each object a grant names, as SQL text PostgreSQL resolves (a schema by its quoted name, a relation or a type by
 * its qualified name, a function by its signature) and by its schema and name. */
const objectsOf = (on: GrantObjects): ReadonlyArray<GrantedObject> => {
	switch (on.kind) {
		case "SCHEMA":
			return on.names.map((n) => ({ object: quoteIdent(n), schema: n, name: n }))
		case "TABLE":
		case "SEQUENCE":
		case "TYPE":
		case "DOMAIN":
			return on.names.map((n) => ({ object: printObjectName(n), schema: n.schema, name: n.name }))
		case "FUNCTION":
			return on.names.map((n) => ({
				object: printFunctionSignature(n),
				schema: n.schema,
				name: n.name
			}))
	}
}

/** The privilege types a grant of `privilege` gives on an object of `family`: ALL is every type the family has. */
const typesOf = (family: PrivilegeFamily, privilege: Privilege): ReadonlyArray<string> =>
	privilege === "ALL" ? privilegeFamilies[family] : [privilege]

const privilegeKey = (p: ExpectedPrivilege): string =>
	`${p.family}\u0000${p.object}\u0000${p.column}\u0000${p.privilege}`

/** The schemas whose objects every role's privileges are judged on: the installed schema and every role's schema the
 * manifest creates, in its order. */
export const judgedSchemas = (
	statements: ReadonlyArray<ManifestStatement>,
	schema: string
): ReadonlyArray<string> => [
	schema,
	...statements.flatMap((s) => (s.kind === "createSchema" && s.name !== schema ? [s.name] : []))
]

const namesRole = (grantees: ReadonlyArray<Grantee>, role: string): boolean =>
	grantees.some((g) => g.kind === "role" && g.name === role)

/** The privileges a grant or a revocation of `privileges` on `on` names: each object's, each privilege's types. */
const privilegesOn = (
	on: GrantObjects,
	privileges: ReadonlyArray<Privilege>
): ReadonlyArray<ExpectedPrivilege> => {
	const family = familyOf(on)
	return objectsOf(on).flatMap((o) =>
		privileges.flatMap((privilege) =>
			typesOf(family, privilege).map((type) => ({ family, ...o, column: "", privilege: type }))
		)
	)
}

/** The privileges `s` grants `role`: a table-wide grant's, or a column grant's on each of its columns. */
const grantedTo = (s: ManifestStatement, role: string): ReadonlyArray<ExpectedPrivilege> => {
	if (s.kind === "grant") {
		return namesRole(s.to, role) ? privilegesOn(s.on, s.privileges) : []
	}
	if (s.kind !== "grantColumns" || s.to !== role) {
		return []
	}
	return s.columns.map((column): ExpectedPrivilege => ({
		family: "column",
		object: printObjectName(s.table),
		schema: s.table.schema,
		name: s.table.name,
		column,
		privilege: s.privilege
	}))
}

/** The privileges `s` revokes from `role`. */
const revokedFrom = (s: ManifestStatement, role: string): ReadonlyArray<ExpectedPrivilege> =>
	s.kind === "revoke" && namesRole(s.from, role) ? privilegesOn(s.on, s.privileges) : []

/** The privileges the manifest's statements leave `role`, in order: a grant adds its privileges, a revocation removes
 * them. */
const privilegesOf = (
	statements: ReadonlyArray<ManifestStatement>,
	role: string
): ReadonlyArray<ExpectedPrivilege> => {
	const privileges = new Map<string, ExpectedPrivilege>()
	for (const s of statements) {
		for (const p of grantedTo(s, role)) {
			privileges.set(privilegeKey(p), p)
		}
		for (const p of revokedFrom(s, role)) {
			privileges.delete(privilegeKey(p))
		}
	}
	return [...privileges.values()]
}

/** Whether a policy's filter admits every row (`true`), as a whole entry's does: row security is a query entry's to
 * need. */
const admitsEveryRow = (p: CreatePolicy): boolean =>
	p.filter.kind === "literal" && p.filter.value.kind === "bool" && p.filter.value.value

/** The expectation of `role` in the installed schema `schema`, from the manifest's statements in order: a grant to the
 * role adds its privileges, a revoke from it removes them, a membership granted to it is one of its memberships, a
 * policy naming it one of its policies, and a stored default of the role one of its settings. The manifest grants
 * PUBLIC nothing, so no grant to PUBLIC adds to a role's. */
export const roleExpectation = (
	statements: ReadonlyArray<ManifestStatement>,
	schema: string,
	role: string
): RoleExpectation => {
	const schemas = judgedSchemas(statements, schema)
	const otherSchemas = new Set(
		statements.flatMap((s) =>
			s.kind === "grant" && s.on.kind === "SCHEMA" && namesRole(s.to, role)
				? s.on.names.filter((n) => !schemas.includes(n))
				: []
		)
	)
	const memberships = new Set(
		statements.flatMap((s) => (s.kind === "grantRole" && s.to === role ? [s.role] : []))
	)
	const members = new Set(
		statements.flatMap((s) => (s.kind === "grantRole" && s.role === role ? [s.to] : []))
	)
	const namingPolicies = statements.flatMap((s) =>
		s.kind === "createPolicy" && s.role === role ? [s] : []
	)
	const filtered = new Set(
		namingPolicies.filter((p) => !admitsEveryRow(p)).map((p) => p.table.name)
	)
	const rowSecure = new Set(
		statements.flatMap((s) =>
			s.kind === "alterTable" &&
			s.actions.some((a) => a.kind === "enableRowSecurity") &&
			s.table.schema === schema
				? [s.table.name]
				: []
		)
	)
	const logins = statements.flatMap((s) =>
		s.kind === "createRole" && s.name === role ? [s.login] : []
	)
	return {
		role,
		/** A role the manifest does not create logs in nowhere. */
		login: logins.at(-1) === true,
		settings: new Map(
			statements.flatMap((s) =>
				s.kind === "alterRole" && s.name === role
					? [[s.action.setting.parameter, storedSettingValue(s.action.setting)] as const]
					: []
			)
		),
		privileges: privilegesOf(statements, role),
		schemas,
		otherSchemas: [...otherSchemas].toSorted(compareStrings),
		memberships: [...memberships].toSorted(compareStrings),
		members: [...members].toSorted(compareStrings),
		policies: namingPolicies
			.map((p) => ({ table: p.table.name, name: p.name }))
			.toSorted(
				combine(
					mapInput(
						compareStrings,
						(p: { readonly table: string; readonly name: string }) => p.table
					),
					mapInput(compareStrings, (p: { readonly table: string; readonly name: string }) => p.name)
				)
			),
		secured: [...filtered].filter((t) => rowSecure.has(t)).toSorted(compareStrings)
	}
}

/** The logins and roles the manifest creates, in its order. */
export const manifestRoles = (
	statements: ReadonlyArray<ManifestStatement>
): ReadonlyArray<string> => statements.flatMap((s) => (s.kind === "createRole" ? [s.name] : []))

/** Where a default privilege applies: to the owner's future objects in every schema, or in one. */
export type DefaultScope =
	| { readonly kind: "everywhere" }
	| { readonly kind: "schema"; readonly schema: string }

/** One privilege the owner's future objects of a kind get by default, granted to someone other than the owner. */
export interface DefaultGrant {
	readonly scope: DefaultScope
	readonly on: AlterDefaultPrivileges["on"]
	readonly grantee: Grantee
	readonly privilege: Privilege
}

/** Whose future objects default privileges are judged for: the owner the snapshot's revokes name, or the role running them. */
export type DefaultOwner =
	| { readonly kind: "named"; readonly role: string }
	| { readonly kind: "current" }

/**
 * The default privileges the drift check judges: of the owner's future objects, everywhere and in each schema the
 * installation holds, those granted to anyone but the owner. The owner creates every object of the installation, so a
 * default privilege of its is a privilege on whatever a later migration creates: PUBLIC holds none, so the snapshot's
 * revokes leave exactly PostgreSQL's own defaults they do not take away (`left`), and every other one is drift.
 */
export interface DefaultPrivilegesExpectation {
	readonly owner: DefaultOwner
	readonly schemas: ReadonlyArray<string>
	readonly left: ReadonlyArray<DefaultGrant>
}

const everywhere: DefaultScope = { kind: "everywhere" }

/** PostgreSQL's own default privileges beyond an object's owner (acldefault): EXECUTE on a function, USAGE on a type. */
const builtinDefaults: ReadonlyArray<DefaultGrant> = [
	{ scope: everywhere, on: "FUNCTIONS", grantee: { kind: "PUBLIC" }, privilege: "EXECUTE" },
	{ scope: everywhere, on: "TYPES", grantee: { kind: "PUBLIC" }, privilege: "USAGE" }
]

const sameGrantee = (a: Grantee, b: Grantee): boolean =>
	a.kind === "PUBLIC" ? b.kind === "PUBLIC" : b.kind === "role" && a.name === b.name

/**
 * The default privileges `statements` leave (DefaultPrivilegesExpectation), as the list the drift check reads each of:
 * PostgreSQL's own, but each a global ALTER DEFAULT PRIVILEGES ... REVOKE takes away (one in a schema only adds to the
 * global ones, so it takes nothing away), for the owner its revokes name, judged in the installation's schemas
 * (judgedSchemas). None for statements that alter no default privilege, the empty snapshot's: an installation of
 * nothing has no owner whose future objects it speaks for, and an owner's global defaults outlive its installations, so
 * another installation of the same owner (or a database's own hardening) is no drift of it.
 */
export const defaultPrivilegesExpectations = (
	statements: ReadonlyArray<ManifestStatement>,
	schema: string
): ReadonlyArray<DefaultPrivilegesExpectation> => {
	const revokes = statements.flatMap((s) => (s.kind === "alterDefaultPrivileges" ? [s] : []))
	if (revokes.length === 0) {
		return []
	}
	const named = revokes.find((r) => r.forRole !== undefined)?.forRole
	return [
		{
			owner: named === undefined ? { kind: "current" } : { kind: "named", role: named },
			schemas: judgedSchemas(statements, schema),
			left: builtinDefaults.filter(
				(g) =>
					!revokes.some(
						(r) =>
							r.inSchema === undefined &&
							r.on === g.on &&
							r.from.some((f) => sameGrantee(f, g.grantee)) &&
							(r.privileges.includes("ALL") || r.privileges.includes(g.privilege))
					)
			)
		}
	]
}
