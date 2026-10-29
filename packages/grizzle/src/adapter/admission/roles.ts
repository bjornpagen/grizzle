import { Array as Arr, Option, pipe, String as Str } from "effect"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import {
	databaseSettings,
	type DefaultGrant,
	type DefaultPrivilegesExpectation,
	type ExpectedPolicy,
	type PrivilegeFamily,
	privilegeFamilies,
	privilegeFamilyNames,
	type RoleExpectation
} from "#compiler/deploy/admission/roles.ts"

/**
 * The settings, privileges, attributes, memberships, members, policies and row security statements both admissions
 * run, and their comparison with what the target snapshot installs (compiler/deploy/admission/roles.ts): Db.open's for
 * the opened role and its login, the drift check's for every login and role the snapshot creates.
 *
 * Every statement is a catalog read whose cells are never NULL. The privileges statement takes the expected
 * privileges as four parallel text[] parameters (family, object, column, type) and answers only the differences:
 * PostgreSQL resolves each expected object to its OID, and a column to its number, judges what the role holds on every
 * object of the judged schemas through has_*_privilege (its own grants, PUBLIC's and every role it inherits from), a
 * column's privilege beside its table's as has_column_privilege where the table's has_table_privilege does not already
 * hold, and the two sets meet by OID. An expected object that does not resolve is a privilege the role does not hold.
 *
 * A PostgreSQL text[] literal of `values`, each element double-quoted with its backslashes and quotes escaped, so any
 * text, an identifier among them, is one element: the adapter's one text[] encoder.
 */
export const textArray = (values: Iterable<string>): string =>
	`{${Arr.join(
		Arr.map(
			[...values],
			(v) => `"${pipe(Str.replaceAll("\\", "\\\\")(v), Str.replaceAll('"', '\\"'))}"`
		),
		","
	)}}`

/** Where a stored setting applies: the database's own default, the role's own, or the role's in this database alone. */
const settingScopes = ["database", "role", "roleInDatabase"] as const
export type SettingScope = (typeof settingScopes)[number]

interface StoredSetting {
	readonly scope: SettingScope
	readonly parameter: string
	readonly value: string
}

const currentDatabase =
	"(SELECT b.oid FROM pg_catalog.pg_database AS b WHERE b.datname = pg_catalog.current_database())"

/** The stored settings `which` selects, one `name=value` per row with its scope. */
const storedSettings = (which: string): CatalogQuery<StoredSetting> => ({
	sql:
		"SELECT CASE WHEN d.setrole = 0::oid THEN 'database'::text WHEN d.setdatabase = 0::oid THEN 'role'::text " +
		"ELSE 'roleInDatabase'::text END AS c0, s.setting::text AS c1 " +
		"FROM pg_catalog.pg_db_role_setting AS d CROSS JOIN LATERAL pg_catalog.unnest(d.setconfig) AS s(setting) " +
		`WHERE ${which}`,
	what: "a setting's scope and its name=value",
	row: ([scopeText, setting]) => {
		const scope = Arr.findFirst(settingScopes, (s) => s === scopeText)
		if (Option.isNone(scope) || setting === undefined) {
			return undefined
		}
		const at = Str.indexOf("=")(setting)
		return Option.isSome(at) && at.value > 0
			? {
					scope: scope.value,
					parameter: Str.slice(0, at.value)(setting),
					value: Str.slice(at.value + 1)(setting)
				}
			: undefined
	}
})

const ofDatabase = `(d.setrole = 0::oid AND d.setdatabase = ${currentDatabase})`

/** The stored settings of the current database. */
export const databaseSettingsQuery: CatalogQuery<StoredSetting> = storedSettings(ofDatabase)

/** The stored settings of the current database and of the role $1. */
export const settingsQuery: CatalogQuery<StoredSetting> = storedSettings(
	`${ofDatabase} OR (d.setrole = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text) ` +
		`AND d.setdatabase IN (0::oid, ${currentDatabase}))`
)

/**
 * A stored setting against the expected ones of its scope: one the scope requires and lacks, one it holds and does
 * not require, or one it holds at another value.
 */
export type SettingDifference =
	| {
			readonly kind: "missing"
			readonly scope: SettingScope
			readonly parameter: string
			readonly value: string
	  }
	| {
			readonly kind: "unexpected"
			readonly scope: SettingScope
			readonly parameter: string
			readonly value: string
	  }
	| {
			readonly kind: "differs"
			readonly scope: SettingScope
			readonly parameter: string
			readonly expected: string
			readonly observed: string
	  }

/** What a scope requires: its settings, and whether it holds exactly those or holds them among others. */
interface ScopeRequirement {
	readonly settings: ReadonlyMap<string, string>
	readonly holds: "exactly" | "among others"
}

/**
 * Every difference between the stored settings of `scope` and what it requires: a required setting missing or at
 * another value, and in a scope that holds exactly its settings, any other one.
 */
const scopeDifferences = (
	stored: ReadonlyArray<StoredSetting>,
	scope: SettingScope,
	want: ScopeRequirement
): ReadonlyArray<SettingDifference> => {
	const out: Array<SettingDifference> = []
	const have = new Map(
		Arr.map(
			Arr.filter(stored, (s) => s.scope === scope),
			(s) => [s.parameter, s.value]
		)
	)
	for (const [parameter, value] of want.settings) {
		const observed = have.get(parameter)
		if (observed === undefined) {
			out.push({ kind: "missing", scope, parameter, value })
		} else if (observed !== value) {
			out.push({ kind: "differs", scope, parameter, expected: value, observed })
		}
	}
	if (want.holds === "exactly") {
		for (const [parameter, value] of have) {
			if (!want.settings.has(parameter)) {
				out.push({ kind: "unexpected", scope, parameter, value })
			}
		}
	}
	return out
}

/**
 * The database holds the installation's defaults among others: its other defaults, a deadlock_timeout or a
 * statement_timeout, are the database owner's, which neither check judges. A fact of the database, judged once
 * whatever roles the snapshot creates.
 */
export const databaseDifferences = (
	stored: ReadonlyArray<StoredSetting>
): ReadonlyArray<SettingDifference> =>
	scopeDifferences(stored, "database", { settings: databaseSettings, holds: "among others" })

/**
 * The role's own defaults are exactly the snapshot's, and the role holds none in this database alone, which would take
 * precedence over its own at login.
 */
export const roleDifferences = (
	stored: ReadonlyArray<StoredSetting>,
	expectation: RoleExpectation
): ReadonlyArray<SettingDifference> => [
	...scopeDifferences(stored, "role", { settings: expectation.settings, holds: "exactly" }),
	...scopeDifferences(stored, "roleInDatabase", { settings: new Map(), holds: "exactly" })
]

/** Every difference in every scope Db.open judges for `expectation`'s role: the database's and the role's. */
export const settingDifferences = (
	stored: ReadonlyArray<StoredSetting>,
	expectation: RoleExpectation
): ReadonlyArray<SettingDifference> => [
	...databaseDifferences(stored),
	...roleDifferences(stored, expectation)
]

/** A privilege the role should hold and does not, or holds and should not. */
export interface PrivilegeDifference {
	readonly kind: "missing" | "unexpected"
	readonly family: PrivilegeFamily
	/**
	 * The object as the expectation names it (missing) or as PostgreSQL names it (unexpected), with a column
	 * privilege's column after a dot.
	 */
	readonly object: string
	readonly privilege: string
}

/** The privilege types PostgreSQL defines on a family, as a text[] constructor. */
const typesArray = (family: PrivilegeFamily): string =>
	`ARRAY[${Arr.join(
		Arr.map(privilegeFamilies[family], (t) => `'${t}'::text`),
		", "
	)}]`

const inJudged = (namespace: string) =>
	`${namespace} IN (SELECT s.oid FROM pg_catalog.pg_namespace AS s WHERE s.nspname = ANY ($2::text[]))`

/**
 * Every privilege the role holds on the judged schemas $2, the other schemas $3, and each object of the judged schemas
 * of a family, as `(family, oid, column, type)`, the column empty but for a column's privilege.
 */
const heldSql = Arr.join(
	[
		`SELECT 'schema'::text, n.oid, ''::text, p.t FROM pg_catalog.pg_namespace AS n CROSS JOIN pg_catalog.unnest(${typesArray("schema")}) AS p(t) ` +
			"WHERE (n.nspname = ANY ($2::text[]) OR n.nspname = ANY ($3::text[])) " +
			"AND pg_catalog.has_schema_privilege((SELECT r.oid FROM grantee AS r), n.oid, p.t)",
		`SELECT 'table'::text, c.oid, ''::text, p.t FROM pg_catalog.pg_class AS c CROSS JOIN pg_catalog.unnest(${typesArray("table")}) AS p(t) ` +
			`WHERE ${inJudged("c.relnamespace")} ` +
			"AND c.relkind IN ('r'::\"char\", 'p'::\"char\", 'm'::\"char\", 'v'::\"char\", 'f'::\"char\") " +
			"AND pg_catalog.has_table_privilege((SELECT r.oid FROM grantee AS r), c.oid, p.t)",
		`SELECT 'column'::text, c.oid, a.attname::text, p.t FROM pg_catalog.pg_class AS c ` +
			"JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0::int2 AND NOT a.attisdropped " +
			`CROSS JOIN pg_catalog.unnest(${typesArray("column")}) AS p(t) ` +
			`WHERE ${inJudged("c.relnamespace")} ` +
			"AND c.relkind IN ('r'::\"char\", 'p'::\"char\", 'm'::\"char\", 'v'::\"char\", 'f'::\"char\") " +
			"AND pg_catalog.has_column_privilege((SELECT r.oid FROM grantee AS r), c.oid, a.attnum, p.t) " +
			"AND NOT pg_catalog.has_table_privilege((SELECT r.oid FROM grantee AS r), c.oid, p.t)",
		`SELECT 'sequence'::text, c.oid, ''::text, p.t FROM pg_catalog.pg_class AS c CROSS JOIN pg_catalog.unnest(${typesArray("sequence")}) AS p(t) ` +
			`WHERE ${inJudged("c.relnamespace")} ` +
			"AND c.relkind = 'S'::\"char\" AND pg_catalog.has_sequence_privilege((SELECT r.oid FROM grantee AS r), c.oid, p.t)",
		`SELECT 'type'::text, t.oid, ''::text, p.t FROM pg_catalog.pg_type AS t CROSS JOIN pg_catalog.unnest(${typesArray("type")}) AS p(t) ` +
			`WHERE ${inJudged("t.typnamespace")} ` +
			"AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS k WHERE k.oid = t.typrelid AND k.relkind <> 'c'::\"char\") " +
			"AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type AS e WHERE e.typarray = t.oid) " +
			"AND pg_catalog.has_type_privilege((SELECT r.oid FROM grantee AS r), t.oid, p.t)",
		`SELECT 'function'::text, f.oid, ''::text, p.t FROM pg_catalog.pg_proc AS f CROSS JOIN pg_catalog.unnest(${typesArray("function")}) AS p(t) ` +
			`WHERE ${inJudged("f.pronamespace")} ` +
			"AND pg_catalog.has_function_privilege((SELECT r.oid FROM grantee AS r), f.oid, p.t)"
	],
	" UNION ALL "
)

/**
 * The relation of an expected privilege, found through the catalog by its schema and name: admission reads a role's
 * privileges as its login, which holds no USAGE on the role's schema, where a lookup by qualified name is refused.
 */
const relationOid =
	"(SELECT c.oid FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
	"WHERE n.nspname = e.schema AND c.relname = e.name)"

/**
 * The object an expected privilege names; NULL when nothing of that name exists. A schema, a type of the installed
 * schema and a function of it resolve by name, which needs no USAGE on a role's schema.
 */
const resolvedOid =
	"CASE e.family WHEN 'schema'::text THEN pg_catalog.to_regnamespace(e.object)::oid " +
	`WHEN 'table'::text THEN ${relationOid} ` +
	`WHEN 'column'::text THEN ${relationOid} ` +
	`WHEN 'sequence'::text THEN ${relationOid} ` +
	"WHEN 'type'::text THEN pg_catalog.to_regtype(e.object)::oid " +
	"WHEN 'function'::text THEN pg_catalog.to_regprocedure(e.object)::oid END"

/** A held object as PostgreSQL names it, a column's after its relation's and a dot. */
const heldName =
	"CASE h.family WHEN 'schema'::text THEN h.oid::regnamespace::text " +
	"WHEN 'type'::text THEN h.oid::regtype::text WHEN 'function'::text THEN h.oid::regprocedure::text " +
	"WHEN 'column'::text THEN h.oid::regclass::text || '.'::text || pg_catalog.quote_ident(h.attname) " +
	"ELSE h.oid::regclass::text END"

/**
 * The privileges of the role $1 on the judged schemas $2 and the other schemas $3 against the expected ones ($4
 * families, $5 objects, $6 columns, $7 types, $8 schemas, $9 names): every difference, none when they agree.
 */
export const privilegesQuery: CatalogQuery<PrivilegeDifference> = {
	sql:
		"WITH grantee AS (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text), " +
		`held(family, oid, attname, privilege) AS (${heldSql}), ` +
		"expected(family, object, attname, privilege, schema, name) AS (SELECT u.f, u.o, u.c, u.p, u.s, u.n " +
		"FROM ROWS FROM (pg_catalog.unnest($4::text[]), pg_catalog.unnest($5::text[]), pg_catalog.unnest($6::text[]), " +
		"pg_catalog.unnest($7::text[]), pg_catalog.unnest($8::text[]), pg_catalog.unnest($9::text[])) AS u(f, o, c, p, s, n)), " +
		`resolved AS (SELECT e.family, e.object, e.attname, e.privilege, ${resolvedOid} AS oid FROM expected AS e) ` +
		"SELECT 'missing'::text AS c0, x.family AS c1, " +
		"CASE x.family WHEN 'column'::text THEN x.object || '.'::text || pg_catalog.quote_ident(x.attname) ELSE x.object END AS c2, " +
		"x.privilege AS c3 FROM resolved AS x " +
		"WHERE NOT EXISTS (SELECT 1 FROM held AS h WHERE h.family = x.family AND h.oid = x.oid AND h.attname = x.attname " +
		"AND h.privilege = x.privilege) " +
		`UNION ALL SELECT 'unexpected'::text, h.family, ${heldName}, h.privilege FROM held AS h ` +
		"WHERE NOT EXISTS (SELECT 1 FROM resolved AS x WHERE x.family = h.family AND x.oid = h.oid AND x.attname = h.attname " +
		"AND x.privilege = h.privilege)",
	what: "a privilege difference",
	row: ([kindText, familyText, object, privilege]) => {
		const kind =
			kindText === "missing" ? "missing" : kindText === "unexpected" ? "unexpected" : undefined
		const family = Arr.findFirst(privilegeFamilyNames, (f) => f === familyText)
		return kind === undefined ||
			Option.isNone(family) ||
			object === undefined ||
			privilege === undefined
			? undefined
			: { kind, family: family.value, object, privilege }
	}
}

/** The privileges statement's parameters for `expectation`'s role. */
export const privilegesParams = (expectation: RoleExpectation): ReadonlyArray<string> => [
	expectation.role,
	textArray(expectation.schemas),
	textArray(expectation.otherSchemas),
	textArray(Arr.map(expectation.privileges, (p) => p.family)),
	textArray(Arr.map(expectation.privileges, (p) => p.object)),
	textArray(Arr.map(expectation.privileges, (p) => p.column)),
	textArray(Arr.map(expectation.privileges, (p) => p.privilege)),
	textArray(Arr.map(expectation.privileges, (p) => p.schema)),
	textArray(Arr.map(expectation.privileges, (p) => p.name))
]

/**
 * One side of a membership, over every pg_auth_members row of the pair (PostgreSQL keeps one per grantor, so a second
 * grant can add an option the first lacks): the other role, and whether any row inherits, lets the member SET ROLE, or
 * grants ADMIN.
 */
interface HeldGrant {
	readonly role: string
	readonly inherit: boolean
	readonly set: boolean
	readonly admin: boolean
}

const flag = (text: string | undefined): boolean | undefined =>
	text === "true" ? true : text === "false" ? false : undefined

const grantRow = ([role, inherit, set, admin]: ReadonlyArray<string>): HeldGrant | undefined => {
	const i = flag(inherit)
	const st = flag(set)
	const a = flag(admin)
	return role === undefined || i === undefined || st === undefined || a === undefined
		? undefined
		: { role, inherit: i, set: st, admin: a }
}

/** The options of a pair's every row, aggregated. */
const anyOption =
	"pg_catalog.bool_or(m.inherit_option)::text AS c1, pg_catalog.bool_or(m.set_option)::text AS c2, " +
	"pg_catalog.bool_or(m.admin_option)::text AS c3 "

/** The roles the role $1 is granted, each with its options over every grant. */
export const membershipsQuery: CatalogQuery<HeldGrant> = {
	sql:
		`SELECT g.rolname::text AS c0, ${anyOption}` +
		"FROM pg_catalog.pg_auth_members AS m JOIN pg_catalog.pg_roles AS g ON g.oid = m.roleid " +
		"WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text) GROUP BY g.rolname",
	what: "a granted role and its options over every grant",
	row: grantRow
}

/**
 * The roles granted the role $1, each with its options over every grant, the owner of the schema $2 aside: when a
 * non-superuser creates a role, PostgreSQL grants the role to its creator WITH ADMIN (and with INHERIT and SET as
 * createrole_self_grant says), and the migration identity that created every login and role of the installation owns
 * every object of it already, so its membership opens nothing.
 */
export const membersQuery: CatalogQuery<HeldGrant> = {
	sql:
		`SELECT u.rolname::text AS c0, ${anyOption}` +
		"FROM pg_catalog.pg_auth_members AS m JOIN pg_catalog.pg_roles AS u ON u.oid = m.member " +
		"WHERE m.roleid = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text) " +
		"AND m.member IS DISTINCT FROM (SELECT n.nspowner FROM pg_catalog.pg_namespace AS n WHERE n.nspname = $2::text) " +
		"GROUP BY u.rolname",
	what: "a member and its options over every grant",
	row: grantRow
}

/** A membership or a member the role should have and lacks, holds with other options, or holds and should not. */
export interface MembershipDifference {
	readonly kind: "missing" | "options" | "unexpected"
	readonly role: string
}

/** Whether a grant is held exactly WITH INHERIT FALSE, SET TRUE and no ADMIN, as a login holds its roles. */
const exact = (g: HeldGrant): boolean => !g.inherit && g.set && !g.admin

const grantDifferences = (
	held: ReadonlyArray<HeldGrant>,
	expected: ReadonlyArray<string>,
	tolerated: (g: HeldGrant) => boolean
): ReadonlyArray<MembershipDifference> => {
	const out: Array<MembershipDifference> = []
	for (const role of expected) {
		const found = Arr.findFirst(held, (h) => h.role === role)
		if (Option.isNone(found)) {
			out.push({ kind: "missing", role })
		} else if (!exact(found.value)) {
			out.push({ kind: "options", role })
		}
	}
	for (const h of held) {
		if (!expected.includes(h.role) && !tolerated(h)) {
			out.push({ kind: "unexpected", role: h.role })
		}
	}
	return out
}

/**
 * The role's memberships against the expected ones (compiler/deploy/admission/roles.ts). A role granted beyond them is
 * tolerated WITH SET FALSE and no ADMIN, which opens no SET ROLE path: what it passes on by inheritance the privileges
 * judge, so a role holding nothing in the installation, as the `rds_iam` an RDS IAM login authenticates by, may be
 * inherited, and one passing on any privilege or ownership there is refused by them.
 */
export const membershipDifferences = (
	held: ReadonlyArray<HeldGrant>,
	expectation: RoleExpectation
): ReadonlyArray<MembershipDifference> =>
	grantDifferences(held, expectation.memberships, (g) => !g.set && !g.admin)

/**
 * The role's members against the expected ones: a theory role's login, a login's none. A member beyond them is
 * tolerated WITH INHERIT FALSE, SET FALSE and no ADMIN, so nothing but the login acts through the role; the migration
 * identity's membership is not read (membersQuery).
 */
export const memberDifferences = (
	held: ReadonlyArray<HeldGrant>,
	expectation: RoleExpectation
): ReadonlyArray<MembershipDifference> =>
	grantDifferences(held, expectation.members, (g) => !g.inherit && !g.set && !g.admin)

/** A role's attributes as pg_roles holds them. */
interface RoleAttributes {
	readonly login: boolean
	readonly inherit: boolean
	readonly superuser: boolean
	readonly createDb: boolean
	readonly createRole: boolean
	readonly replication: boolean
	readonly bypassRls: boolean
}

/** The attributes of the role $1: one row, none when it does not exist. */
export const attributesQuery: CatalogQuery<RoleAttributes> = {
	sql:
		"SELECT r.rolcanlogin::text AS c0, r.rolinherit::text AS c1, r.rolsuper::text AS c2, r.rolcreatedb::text AS c3, " +
		"r.rolcreaterole::text AS c4, r.rolreplication::text AS c5, r.rolbypassrls::text AS c6 " +
		"FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text",
	what: "a role's attributes",
	row: (cells) => {
		const [login, inherit, superuser, createDb, createRole, replication, bypassRls] = Arr.map(
			cells,
			flag
		)
		return login === undefined ||
			inherit === undefined ||
			superuser === undefined ||
			createDb === undefined ||
			createRole === undefined ||
			replication === undefined ||
			bypassRls === undefined
			? undefined
			: { login, inherit, superuser, createDb, createRole, replication, bypassRls }
	}
}

/**
 * An attribute the role holds otherwise than the snapshot installs it, by its CREATE ROLE spelling: a login is LOGIN
 * NOINHERIT, a theory role NOLOGIN, and neither is SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS.
 */
export interface AttributeDifference {
	readonly attribute: string
	readonly expected: string
	readonly observed: string
}

export const attributeDifferences = (
	held: ReadonlyArray<RoleAttributes>,
	expectation: RoleExpectation
): ReadonlyArray<AttributeDifference> => {
	const [a] = held
	if (a === undefined) {
		return [{ attribute: "existence", expected: "the role exists", observed: "no such role" }]
	}
	const out: Array<AttributeDifference> = []
	const want = (attribute: string, value: boolean, expected: boolean) => {
		if (value !== expected) {
			out.push({
				attribute,
				expected: expected ? attribute : `NO${attribute}`,
				observed: value ? attribute : `NO${attribute}`
			})
		}
	}
	want("LOGIN", a.login, expectation.login)
	if (expectation.login) {
		want("INHERIT", a.inherit, false)
	}
	want("SUPERUSER", a.superuser, false)
	want("CREATEDB", a.createDb, false)
	want("CREATEROLE", a.createRole, false)
	want("REPLICATION", a.replication, false)
	want("BYPASSRLS", a.bypassRls, false)
	return out
}

/**
 * Row security of the tables $2 of the installed schema $1: each table that exists, whether row security is enabled
 * and whether it is forced.
 */
interface TableSecurity {
	readonly table: string
	readonly enabled: boolean
	readonly forced: boolean
}

export const rowSecurityQuery: CatalogQuery<TableSecurity> = {
	sql:
		"SELECT c.relname::text AS c0, c.relrowsecurity::text AS c1, c.relforcerowsecurity::text AS c2 " +
		"FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
		"WHERE n.nspname = $1::text AND c.relname = ANY ($2::text[])",
	what: "a table's row security",
	row: ([table, enabled, forced]) => {
		const e = flag(enabled)
		const f = flag(forced)
		return table === undefined || e === undefined || f === undefined
			? undefined
			: { table, enabled: e, forced: f }
	}
}

/**
 * Each table the role writes through a query entry whose row security is not enabled, or forced, or that is missing.
 */
export const rowSecurityDifferences = (
	held: ReadonlyArray<TableSecurity>,
	expectation: RoleExpectation
): ReadonlyArray<{ readonly table: string; readonly observed: string }> =>
	Arr.flatMap(expectation.secured, (table) => {
		const t = Arr.findFirst(held, (h) => h.table === table)
		const observed = Option.isNone(t)
			? Option.some("no such table")
			: !t.value.enabled
				? Option.some("disabled")
				: t.value.forced
					? Option.some("forced")
					: Option.none()
		return Option.isNone(observed) ? [] : [{ table, observed: observed.value }]
	})

/** The policies naming the role $1 on the tables of the installed schema $2, each by its table and name. */
export const policiesQuery: CatalogQuery<ExpectedPolicy> = {
	sql:
		"SELECT c.relname::text AS c0, p.polname::text AS c1 FROM pg_catalog.pg_policy AS p " +
		"JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
		"WHERE n.nspname = $2::text " +
		"AND (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text) = ANY (p.polroles)",
	what: "a policy's table and name",
	row: ([table, name]) => (table === undefined || name === undefined ? undefined : { table, name })
}

/** A policy naming the role that the snapshot installs and the database lacks, or holds and the snapshot does not. */
export interface PolicyDifference {
	readonly kind: "missing" | "unexpected"
	readonly policy: ExpectedPolicy
}

const samePolicy = (a: ExpectedPolicy, b: ExpectedPolicy): boolean =>
	a.table === b.table && a.name === b.name

export const policyDifferences = (
	held: ReadonlyArray<ExpectedPolicy>,
	expectation: RoleExpectation
): ReadonlyArray<PolicyDifference> => [
	...Arr.map(
		Arr.filter(expectation.policies, (p) => !Arr.some(held, (h) => samePolicy(h, p))),
		(policy): PolicyDifference => ({ kind: "missing", policy })
	),
	...Arr.map(
		Arr.filter(held, (h) => !Arr.some(expectation.policies, (p) => samePolicy(h, p))),
		(policy): PolicyDifference => ({ kind: "unexpected", policy })
	)
]

/** pg_default_acl's letter of each kind of object a default privilege applies to. */
const defaultObjectLetters = ["r", "S", "f", "T", "n", "L"] as const

type DefaultObjects = (typeof defaultObjectLetters)[number]

/** Each kind's name in a drift fact. */
const defaultObjects: Readonly<Record<DefaultObjects, string>> = {
	r: "tables",
	S: "sequences",
	f: "functions",
	T: "types",
	n: "schemas",
	L: "large objects"
}

/** A default privilege of the owner's future objects, as the catalog holds it: its scope, kind, grantee and privilege. */
export interface StoredDefaultGrant {
	readonly scope: DefaultGrant["scope"]
	readonly objects: DefaultObjects
	/** `PUBLIC`, or the grantee's name. */
	readonly grantee: string
	readonly privilege: string
}

/** pg_default_acl's letter of each kind ALTER DEFAULT PRIVILEGES names. */
const defaultObjectLetter: Readonly<Record<DefaultGrant["on"], DefaultObjects>> = {
	TABLES: "r",
	SEQUENCES: "S",
	FUNCTIONS: "f",
	TYPES: "T"
}

/**
 * The owner's default privileges granted to anyone but the owner, the installation's schemas the last parameter (as
 * text[]) and the owner, when the snapshot names one, the first: in every schema, its global entry of each kind or,
 * for functions and types, PostgreSQL's own defaults where it has none (acldefault; the other kinds' grant nobody else
 * anything); in each schema, the entries that add to those.
 */
export const defaultPrivilegesQuery = (
	expectation: DefaultPrivilegesExpectation
): CatalogQuery<StoredDefaultGrant> => {
	const [owner, schemas] =
		expectation.owner.kind === "named"
			? (["r.rolname = $1::text", "$2::text[]"] as const)
			: (["r.rolname = CURRENT_USER", "$1::text[]"] as const)
	return {
		sql:
			`WITH o AS (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE ${owner}), ` +
			"acls AS (" +
			"SELECT ''::text AS scope, t.k AS objects, COALESCE((SELECT d.defaclacl FROM pg_catalog.pg_default_acl AS d " +
			"WHERE d.defaclrole = o.oid AND d.defaclnamespace = 0::oid AND d.defaclobjtype = t.k), pg_catalog.acldefault(t.k, o.oid)) AS acl " +
			"FROM o CROSS JOIN (VALUES ('f'::\"char\"), ('T'::\"char\")) AS t(k) " +
			"UNION ALL SELECT ''::text, d.defaclobjtype, d.defaclacl FROM pg_catalog.pg_default_acl AS d JOIN o ON d.defaclrole = o.oid " +
			"WHERE d.defaclnamespace = 0::oid AND d.defaclobjtype NOT IN ('f'::\"char\", 'T'::\"char\") " +
			"UNION ALL SELECT n.nspname::text, d.defaclobjtype, d.defaclacl FROM pg_catalog.pg_default_acl AS d JOIN o ON d.defaclrole = o.oid " +
			`JOIN pg_catalog.pg_namespace AS n ON n.oid = d.defaclnamespace WHERE n.nspname::text = ANY (${schemas})) ` +
			"SELECT a.scope AS c0, a.objects::text AS c1, " +
			"CASE WHEN x.grantee = 0::oid THEN 'PUBLIC'::text ELSE pg_catalog.pg_get_userbyid(x.grantee)::text END AS c2, " +
			"x.privilege_type::text AS c3 " +
			"FROM acls AS a CROSS JOIN LATERAL pg_catalog.aclexplode(a.acl) AS x CROSS JOIN o WHERE x.grantee <> o.oid",
		what: "a default privilege's scope, kind, grantee and privilege",
		row: ([scope, letter, grantee, privilege]) => {
			if (
				scope === undefined ||
				letter === undefined ||
				grantee === undefined ||
				privilege === undefined
			) {
				return undefined
			}
			const objects = Arr.findFirst(defaultObjectLetters, (k) => k === letter)
			return Option.isSome(objects)
				? {
						scope: scope === "" ? { kind: "everywhere" } : { kind: "schema", schema: scope },
						objects: objects.value,
						grantee,
						privilege
					}
				: undefined
		}
	}
}

/** The default privileges statement's parameters: the owner the snapshot names, if any, then the schemas. */
export const defaultPrivilegesParams = (
	expectation: DefaultPrivilegesExpectation
): ReadonlyArray<string> => [
	...(expectation.owner.kind === "named" ? [expectation.owner.role] : []),
	textArray(expectation.schemas)
]

/** A default privilege the snapshot leaves and the catalog lacks, or one the catalog holds that it does not leave. */
export interface DefaultPrivilegeDifference {
	readonly kind: "missing" | "unexpected"
	/** The grant as a drift fact names it: `<privilege> on <kind> to <grantee> in <scope>`. */
	readonly grant: string
}

const storedOf = (g: DefaultGrant): StoredDefaultGrant => ({
	scope: g.scope,
	objects: defaultObjectLetter[g.on],
	grantee: g.grantee.kind === "PUBLIC" ? "PUBLIC" : g.grantee.name,
	privilege: g.privilege
})

const grantText = (g: StoredDefaultGrant): string =>
	`${g.privilege} on ${defaultObjects[g.objects]} to ${g.grantee} ${g.scope.kind === "everywhere" ? "in every schema" : `in schema ${g.scope.schema}`}`

/** The owner's stored default privileges against those the snapshot leaves (DefaultPrivilegesExpectation.left). */
export const defaultPrivilegeDifferences = (
	stored: ReadonlyArray<StoredDefaultGrant>,
	expectation: DefaultPrivilegesExpectation
): ReadonlyArray<DefaultPrivilegeDifference> => {
	const held = new Set(Arr.map(stored, grantText))
	const left = new Set(Arr.map(expectation.left, (g) => grantText(storedOf(g))))
	return [
		...Arr.flatMap([...left], (g): ReadonlyArray<DefaultPrivilegeDifference> =>
			held.has(g) ? [] : [{ kind: "missing", grant: g }]
		),
		...Arr.flatMap([...held], (g): ReadonlyArray<DefaultPrivilegeDifference> =>
			left.has(g) ? [] : [{ kind: "unexpected", grant: g }]
		)
	]
}
