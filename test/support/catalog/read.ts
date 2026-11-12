import { Array as Arr, Effect, Option, String as Str } from "effect"
import type {
	ColumnIdent,
	ConstraintName,
	DomainName,
	IndexName,
	RelationIdent
} from "#compiler/core/ids.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

/**
 * PostgreSQL's catalog codes, as its catalog spells them. pg_class.relkind: a table, an index, a sequence, a TOAST
 * table, a view, a materialized view, a composite type, a foreign table, a partitioned table or a partitioned index.
 */
type RelKind = "r" | "i" | "S" | "t" | "v" | "m" | "c" | "f" | "p" | "I"
/**
 * pg_constraint.contype: a check, a foreign key, a not-null, a primary key, a unique, a constraint trigger's or an
 * exclusion constraint.
 */
type ConType = "c" | "f" | "n" | "p" | "u" | "t" | "x"
/** pg_trigger.tgenabled: enabled in origin and local mode, disabled, enabled in replica mode only, or always. */
type TgEnabled = "O" | "D" | "R" | "A"
/** pg_proc.provolatile: immutable, stable or volatile. */
type Volatility = "i" | "s" | "v"

export interface CatalogGrant {
	/** A role name, or PUBLIC. */
	readonly grantee: string
	readonly privilege: string
}

export interface CatalogType {
	readonly schema: string
	readonly name: string
	/** atttypmod or typtypmod, -1 when none. */
	readonly typmod: number
	/** format_type(), for diagnostics. */
	readonly formatted: string
}

/**
 * How a column's value is made: given by the writer, with the default pg_get_expr prints when it has one; drawn from
 * its identity sequence (`schema.name`), GENERATED ALWAYS or BY DEFAULT AS IDENTITY; or computed, GENERATED ALWAYS AS
 * an expression pg_get_expr prints, STORED or VIRTUAL.
 */
export type CatalogGeneration =
	| { readonly kind: "given"; readonly default: Option.Option<string> }
	| { readonly kind: "identity"; readonly always: boolean; readonly sequence: string }
	| { readonly kind: "computed"; readonly stored: boolean; readonly expression: string }

export interface CatalogColumn {
	readonly name: ColumnIdent
	readonly type: CatalogType
	readonly notNull: boolean
	/** `schema.name` of the column's collation, none when the type is not collatable. */
	readonly collation: Option.Option<string>
	readonly generation: CatalogGeneration
}

interface CatalogConstraint {
	readonly name: ConstraintName
	/** pg_constraint.contype: p, u, f, c, x, n, t. */
	readonly type: ConType
	readonly columns: ReadonlyArray<string>
	readonly withoutOverlaps: boolean
	readonly period: boolean
	/** The table a foreign key references, none for any other constraint. */
	readonly references: Option.Option<string>
	readonly referencedColumns: ReadonlyArray<string>
	readonly deferrable: boolean
	readonly deferred: boolean
	readonly validated: boolean
	readonly definition: string
}

interface CatalogIndex {
	readonly name: ConstraintName | IndexName
	readonly table: string
	readonly unique: boolean
	readonly method: string
	readonly columns: ReadonlyArray<string>
	/** pg_get_expr of the partial predicate, none for a total index. */
	readonly predicate: Option.Option<string>
	readonly valid: boolean
	/** The constraint the index backs, none when it backs none. */
	readonly constraint: Option.Option<string>
	readonly definition: string
}

/** A column-level privilege (pg_attribute.attacl). */
interface CatalogColumnGrant extends CatalogGrant {
	readonly column: string
}

interface CatalogTable {
	readonly name: RelationIdent
	/** pg_class.relkind. */
	readonly kind: RelKind
	readonly owner: string
	readonly columns: ReadonlyArray<CatalogColumn>
	readonly constraints: ReadonlyArray<CatalogConstraint>
	readonly rowSecurity: boolean
	readonly forceRowSecurity: boolean
	readonly grants: ReadonlyArray<CatalogGrant>
	readonly columnGrants: ReadonlyArray<CatalogColumnGrant>
}

/** A row-security policy of a table of the schema. */
export interface CatalogPolicy {
	readonly table: string
	readonly name: string
	/** pg_policy.polcmd: * for ALL, r, a, w, d. */
	readonly command: string
	readonly permissive: boolean
	readonly roles: ReadonlyArray<string>
	/** pg_get_expr of USING and WITH CHECK, none when absent. */
	readonly using: Option.Option<string>
	readonly check: Option.Option<string>
}

/** A relation of a world's schema: its kind, owner, options (reloptions, `name=value`), grants and typed columns. */
interface CatalogWorldRelation {
	readonly name: string
	readonly kind: RelKind
	readonly owner: string
	readonly options: ReadonlyArray<string>
	readonly grants: ReadonlyArray<CatalogGrant>
	readonly columns: ReadonlyArray<{ readonly name: string; readonly type: CatalogType }>
	/** The functions of the base schema the view's rule calls, as pg_depend records them (a decoded column's names
	 * constant). */
	readonly calls: ReadonlyArray<string>
}

/** A schema `<schema>__<name>`: a role's world, its views over the schema. */
export interface CatalogWorld {
	readonly name: string
	readonly owner: string
	readonly grants: ReadonlyArray<CatalogGrant>
	readonly relations: ReadonlyArray<CatalogWorldRelation>
	/** Every function and every type the schema holds besides its relations' row types. */
	readonly functions: ReadonlyArray<string>
	readonly types: ReadonlyArray<string>
}

interface CatalogDomain {
	readonly name: DomainName
	readonly base: CatalogType
	readonly notNull: boolean
	/** `schema.name` of the domain's collation, none when its base is not collatable. */
	readonly collation: Option.Option<string>
	readonly constraints: ReadonlyArray<{
		readonly name: ConstraintName
		readonly definition: string
		readonly validated: boolean
		/** The functions of the schema the CHECK calls, as pg_depend records them: a roster's names constant, a set's live
		 * constant. */
		readonly calls: ReadonlyArray<string>
	}>
	readonly grants: ReadonlyArray<CatalogGrant>
}

interface CatalogSequence {
	readonly name: string
	/** `table.column` of the owning identity column. */
	readonly ownedBy: string
	readonly grants: ReadonlyArray<CatalogGrant>
}

interface CatalogFunction {
	readonly name: string
	/** pg_get_function_identity_arguments, which names the function in an ALTER FUNCTION. */
	readonly args: string
	readonly owner: string
	readonly securityDefiner: boolean
	readonly volatility: Volatility
	readonly config: ReadonlyArray<string>
	readonly grants: ReadonlyArray<CatalogGrant>
	/** pg_get_functiondef's CREATE OR REPLACE statement. */
	readonly definition: string
	/** The functions of the schema its body calls, as pg_depend records a SQL-standard body's: a live constant's names
	 * constant. */
	readonly calls: ReadonlyArray<string>
}

interface CatalogTrigger {
	readonly table: string
	/** The isolation guard's or PostgreSQL's internal foreign-key trigger's: no law trigger exists. */
	readonly name: string
	readonly internal: boolean
	/** pg_trigger.tgenabled: O, D, R, A. */
	readonly enabled: TgEnabled
	readonly function: string
	/**
	 * pg_trigger.tgtype: its level (1, a row trigger), timing (2, BEFORE; 64, INSTEAD OF) and events (4 INSERT, 8
	 * DELETE, 16 UPDATE, 32 TRUNCATE) as bits.
	 */
	readonly type: number
	readonly constraint: boolean
	readonly deferrable: boolean
	readonly deferred: boolean
	/** pg_get_triggerdef's CREATE TRIGGER statement. */
	readonly definition: string
}

/** An extended statistics object. */
interface CatalogStatistics {
	readonly name: string
	readonly table: string
	/**
	 * Its columns by name: PostgreSQL keeps them in column order (stxkeys), which differs between a migrated table,
	 * whose retyped column was added last, and a fresh one.
	 */
	readonly columns: ReadonlyArray<string>
	/** pg_statistic_ext.stxkind: d, f, m, e. */
	readonly kinds: ReadonlyArray<string>
	/**
	 * A CREATE STATISTICS statement that makes it: its kinds always listed, its columns by name, then its expressions,
	 * where pg_get_statisticsobjdef prints the columns in column order.
	 */
	readonly definition: string
}

/**
 * One side of a membership (pg_auth_members) over every row of the pair, one per grantor: the other role, and whether
 * any row inherits, lets the member SET ROLE, or grants ADMIN.
 */
export interface CatalogMembership {
	readonly role: string
	readonly inherit: boolean
	readonly set: boolean
	readonly admin: boolean
}

interface CatalogRole {
	readonly name: string
	readonly login: boolean
	readonly inherit: boolean
	readonly superuser: boolean
	readonly createRole: boolean
	readonly createDb: boolean
	readonly replication: boolean
	readonly bypassRls: boolean
	/** pg_db_role_setting for every database, `name=value`, sorted. */
	readonly config: ReadonlyArray<string>
	/** pg_db_role_setting for this database alone, `name=value`, sorted. */
	readonly databaseConfig: ReadonlyArray<string>
	readonly memberOf: ReadonlyArray<CatalogMembership>
	/**
	 * The roles granted this one, whatever their names, but the schema's owner: PostgreSQL grants a role to the
	 * non-superuser that creates it WITH ADMIN (and with INHERIT and SET as createrole_self_grant says), and the owner
	 * owns every object of the installation already, as admission reads it (adapter/admission/roles.ts membersQuery).
	 */
	readonly members: ReadonlyArray<CatalogMembership>
	/**
	 * Every role whose privileges this one holds by inheritance, through any chain of memberships WITH INHERIT TRUE,
	 * itself aside, sorted.
	 */
	readonly inherits: ReadonlyArray<string>
}

/**
 * A privilege a role of the schema holds on a schema outside the installation: neither the base schema nor a world's.
 */
interface CatalogForeignGrant extends CatalogGrant {
	readonly schema: string
}

interface CatalogDefaultAcl {
	readonly role: string
	/** The schema of a per-schema entry, none for the global (every-schema) entry. */
	readonly schema: Option.Option<string>
	/** pg_default_acl.defaclobjtype: r, S, f, T, n. */
	readonly objectType: string
	readonly grants: ReadonlyArray<CatalogGrant>
}

export interface Catalog {
	readonly schema: string
	/** The installation's level schemas, the root's, `schema`, first. */
	readonly levels: ReadonlyArray<string>
	readonly owner: string
	readonly schemaGrants: ReadonlyArray<CatalogGrant>
	readonly tables: ReadonlyArray<CatalogTable>
	readonly indexes: ReadonlyArray<CatalogIndex>
	/** The pg_enum rows of the schema's types: none, since a roster is a smallint domain and no enum is installed. */
	readonly enumLabels: number
	readonly domains: ReadonlyArray<CatalogDomain>
	readonly sequences: ReadonlyArray<CatalogSequence>
	readonly functions: ReadonlyArray<CatalogFunction>
	readonly triggers: ReadonlyArray<CatalogTrigger>
	readonly statistics: ReadonlyArray<CatalogStatistics>
	readonly policies: ReadonlyArray<CatalogPolicy>
	/** Every role whose name starts with `<schema>__`: the logins and the worlds' roles. */
	readonly roles: ReadonlyArray<CatalogRole>
	/** Every schema whose name starts with `<schema>__`: the worlds' schemas. */
	readonly worlds: ReadonlyArray<CatalogWorld>
	/**
	 * Every privilege those roles hold on a schema neither the base nor a world's, the vector extension's among them.
	 */
	readonly foreignGrants: ReadonlyArray<CatalogForeignGrant>
	readonly defaultAcls: ReadonlyArray<CatalogDefaultAcl>
	/** Every other type the schema holds (composite row types of tables excluded). */
	readonly otherTypes: ReadonlyArray<string>
	/** The database's own settings, for every role (pg_db_role_setting with setrole 0), each `name=value`. */
	readonly databaseSettings: ReadonlyArray<string>
	/**
	 * Every table of the level schemas a publication of the database publishes, with that publication, as
	 * pg_publication_tables names it: a publication of all tables or of a schema's tables names each of them too.
	 */
	readonly publishedTables: ReadonlyArray<CatalogPublishedTable>
}

/** A table of the installation a publication publishes. */
export interface CatalogPublishedTable {
	readonly publication: string
	readonly schema: string
	readonly table: string
}

/**
 * The catalog of one schema, or the schema's absence: a schema the database does not hold is a state, never a defect.
 */
export type InstalledCatalog =
	| { readonly kind: "absent"; readonly schema: string }
	| { readonly kind: "present"; readonly catalog: Catalog }

/** The grants of an ACL column with its catalog kind and owner, NULL read as acldefault. */
const grants = (acl: string, kind: string, owner: string) =>
	`(SELECT COALESCE(json_agg(json_build_object('grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, 'privilege', a.privilege_type) ORDER BY 1, a.privilege_type), '[]'::json) FROM pg_catalog.aclexplode(COALESCE(${acl}, pg_catalog.acldefault('${kind}', ${owner}))) AS a)`

const typeJson = (oid: string, typmod: string) =>
	`(SELECT json_build_object('schema', tn.nspname::text, 'name', ty.typname::text, 'typmod', ${typmod}, 'formatted', pg_catalog.format_type(ty.oid, ${typmod})) FROM pg_catalog.pg_type ty JOIN pg_catalog.pg_namespace tn ON tn.oid = ty.typnamespace WHERE ty.oid = ${oid})`

/** A collation as `schema.name`, NULL for none. */
const collationText = (oid: string) =>
	`(SELECT cn.nspname::text || '.' || c.collname::text FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace cn ON cn.oid = c.collnamespace WHERE c.oid = ${oid})`

/**
 * The functions of the schema, `$1`, that the object `objid` of the catalog `classid` depends on, as pg_depend records
 * it (recordDependencyOnExpr): a CHECK's, a view rule's or a SQL-standard body's calls, by name.
 */
const callsOf = (classid: string, objid: string) =>
	`(SELECT COALESCE(json_agg(DISTINCT dp.proname::text), '[]'::json) FROM pg_catalog.pg_depend dd JOIN pg_catalog.pg_proc dp ON dp.oid = dd.refobjid JOIN pg_catalog.pg_namespace dn ON dn.oid = dp.pronamespace WHERE dd.classid = ${classid} AND dd.objid = ${objid} AND dd.refclassid = 'pg_catalog.pg_proc'::regclass AND dd.objid <> dd.refobjid AND dn.nspname = ANY($1::text[]))`

/**
 * The queries of one installation's level schemas, `$1` (text[], its root's first). The naming door mints every login,
 * role and role schema of a level under it, `<level>__<name>` (core/identity.ts), and no converted declared name holds
 * `__`, so a level's name and `__` is the prefix the installation's own roles and role schemas start with, and no other
 * installation's.
 */
const queries = {
	schema: `SELECT COALESCE((SELECT json_build_object('kind', 'present', 'owner', pg_catalog.pg_get_userbyid(n.nspowner)::text, 'grants', ${grants("n.nspacl", "n", "n.nspowner")}) FROM pg_catalog.pg_namespace n WHERE n.nspname = ($1::text[])[1]), json_build_object('kind', 'absent'))::text`,
	tables: `SELECT COALESCE(json_agg(json_build_object(
		'name', c.relname::text, 'kind', c.relkind::text, 'owner', pg_catalog.pg_get_userbyid(c.relowner)::text,
		'rowSecurity', c.relrowsecurity, 'forceRowSecurity', c.relforcerowsecurity,
		'grants', ${grants("c.relacl", "r", "c.relowner")},
		'columns', (SELECT COALESCE(json_agg(json_build_object(
			'name', a.attname::text, 'type', ${typeJson("a.atttypid", "a.atttypmod")}, 'notNull', a.attnotnull,
			'collation', ${collationText("a.attcollation")}, 'identity', a.attidentity::text, 'generated', a.attgenerated::text,
			'expression', (SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) FROM pg_catalog.pg_attrdef d WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum),
			'sequence', (SELECT sn.nspname::text || '.' || s.relname::text FROM pg_catalog.pg_depend dep JOIN pg_catalog.pg_class s ON s.oid = dep.objid JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace WHERE dep.refobjid = c.oid AND dep.refobjsubid = a.attnum AND dep.classid = 'pg_catalog.pg_class'::regclass AND s.relkind = 'S' AND dep.deptype = 'i')
		) ORDER BY a.attnum), '[]'::json) FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
		'constraints', (SELECT COALESCE(json_agg(json_build_object(
			'name', k.conname::text, 'type', k.contype::text,
			'columns', (SELECT COALESCE(json_agg(a.attname::text ORDER BY u.ord), '[]'::json) FROM unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum),
			'withoutOverlaps', k.conperiod AND k.contype IN ('p', 'u'), 'period', k.conperiod AND k.contype = 'f',
			'references', (SELECT r.relname::text FROM pg_catalog.pg_class r WHERE r.oid = k.confrelid),
			'referencedColumns', (SELECT COALESCE(json_agg(a.attname::text ORDER BY u.ord), '[]'::json) FROM unnest(k.confkey) WITH ORDINALITY AS u(attnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum),
			'deferrable', k.condeferrable, 'deferred', k.condeferred, 'validated', k.convalidated,
			'definition', pg_catalog.pg_get_constraintdef(k.oid)
		) ORDER BY k.conname), '[]'::json) FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid AND k.contype <> 'n'),
		'columnGrants', (SELECT COALESCE(json_agg(json_build_object(
			'column', a.attname::text,
			'grantee', CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(g.grantee)::text END,
			'privilege', g.privilege_type
		) ORDER BY a.attname::text, CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(g.grantee)::text END, g.privilege_type), '[]'::json)
		FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS g
		WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
	) ORDER BY c.relname), '[]'::json)::text
	FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
	WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
	indexes: `SELECT COALESCE(json_agg(json_build_object(
		'name', ic.relname::text, 'table', tc.relname::text, 'unique', i.indisunique, 'method', am.amname::text,
		'columns', (SELECT COALESCE(json_agg(COALESCE(a.attname::text, '') ORDER BY u.ord), '[]'::json) FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS u(attnum, ord) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum),
		'predicate', pg_catalog.pg_get_expr(i.indpred, i.indrelid), 'valid', i.indisvalid,
		'constraint', (SELECT k.conname::text FROM pg_catalog.pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid LIMIT 1),
		'definition', pg_catalog.pg_get_indexdef(i.indexrelid)
	) ORDER BY ic.relname), '[]'::json)::text
	FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
	JOIN pg_catalog.pg_am am ON am.oid = ic.relam JOIN pg_catalog.pg_namespace n ON n.oid = ic.relnamespace
	WHERE n.nspname = ANY($1::text[])`,
	enumLabels: `SELECT count(*)::text FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ANY($1::text[])`,
	domains: `SELECT COALESCE(json_agg(json_build_object(
		'name', t.typname::text, 'base', ${typeJson("t.typbasetype", "t.typtypmod")}, 'notNull', t.typnotnull,
		'collation', ${collationText("t.typcollation")},
		'constraints', (SELECT COALESCE(json_agg(json_build_object('name', k.conname::text, 'definition', pg_catalog.pg_get_constraintdef(k.oid), 'validated', k.convalidated, 'calls', ${callsOf("'pg_catalog.pg_constraint'::regclass", "k.oid")}) ORDER BY k.conname), '[]'::json) FROM pg_catalog.pg_constraint k WHERE k.contypid = t.oid AND k.contype = 'c'),
		'grants', ${grants("t.typacl", "T", "t.typowner")}
	) ORDER BY t.typname), '[]'::json)::text
	FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ANY($1::text[]) AND t.typtype = 'd'`,
	sequences: `SELECT COALESCE(json_agg(json_build_object(
		'name', c.relname::text,
		'ownedBy', COALESCE((SELECT tc.relname::text || '.' || a.attname::text FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid WHERE d.objid = c.oid AND d.classid = 'pg_catalog.pg_class'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i')), ''),
		'grants', ${grants("c.relacl", "s", "c.relowner")}
	) ORDER BY c.relname), '[]'::json)::text
	FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'S'`,
	functions: `SELECT COALESCE(json_agg(json_build_object(
		'name', p.proname::text, 'args', pg_catalog.pg_get_function_identity_arguments(p.oid),
		'owner', pg_catalog.pg_get_userbyid(p.proowner)::text, 'securityDefiner', p.prosecdef,
		'volatility', p.provolatile::text, 'config', COALESCE(to_json(p.proconfig), '[]'::json),
		'grants', ${grants("p.proacl", "f", "p.proowner")}, 'definition', pg_catalog.pg_get_functiondef(p.oid),
		'calls', ${callsOf("'pg_catalog.pg_proc'::regclass", "p.oid")}
	) ORDER BY p.proname), '[]'::json)::text
	FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ANY($1::text[])`,
	triggers: `SELECT COALESCE(json_agg(json_build_object(
		'table', c.relname::text, 'name', g.tgname::text, 'internal', g.tgisinternal, 'enabled', g.tgenabled::text,
		'function', p.proname::text, 'type', g.tgtype, 'constraint', g.tgconstraint <> 0, 'deferrable', g.tgdeferrable, 'deferred', g.tginitdeferred,
		'definition', pg_catalog.pg_get_triggerdef(g.oid)
	) ORDER BY c.relname, g.tgname), '[]'::json)::text
	FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
	JOIN pg_catalog.pg_proc p ON p.oid = g.tgfoid WHERE n.nspname = ANY($1::text[])`,
	statistics: `SELECT COALESCE(json_agg(json_build_object(
		'name', s.stxname::text, 'table', c.relname::text,
		'columns', (SELECT COALESCE(json_agg(a.attname::text ORDER BY a.attname::text COLLATE "C"), '[]'::json) FROM unnest(s.stxkeys::int2[]) AS k(attnum) JOIN pg_catalog.pg_attribute a ON a.attrelid = s.stxrelid AND a.attnum = k.attnum),
		'kinds', (SELECT COALESCE(json_agg(x::text ORDER BY x::text), '[]'::json) FROM unnest(s.stxkind) AS x),
		'definition', pg_catalog.concat_ws(' ', 'CREATE STATISTICS', pg_catalog.quote_ident(n.nspname::text) || '.' || pg_catalog.quote_ident(s.stxname::text),
			'(' || (SELECT string_agg(CASE x::text WHEN 'd' THEN 'ndistinct' WHEN 'f' THEN 'dependencies' ELSE 'mcv' END, ', ' ORDER BY x::text) FROM unnest(s.stxkind) AS x WHERE x::text <> 'e') || ')',
			'ON', (SELECT string_agg(p.t, ', ' ORDER BY p.o, p.t COLLATE "C") FROM (
				SELECT 0 AS o, pg_catalog.quote_ident(a.attname::text) AS t FROM unnest(s.stxkeys::int2[]) AS k(attnum) JOIN pg_catalog.pg_attribute a ON a.attrelid = s.stxrelid AND a.attnum = k.attnum
				UNION ALL SELECT 1, '(' || e || ')' FROM unnest(pg_catalog.pg_get_statisticsobjdef_expressions(s.oid)) AS e) AS p),
			'FROM', pg_catalog.quote_ident(n.nspname::text) || '.' || pg_catalog.quote_ident(c.relname::text))
	) ORDER BY s.stxname), '[]'::json)::text
	FROM pg_catalog.pg_statistic_ext s JOIN pg_catalog.pg_class c ON c.oid = s.stxrelid JOIN pg_catalog.pg_namespace n ON n.oid = s.stxnamespace
	WHERE n.nspname = ANY($1::text[])`,
	policies: `SELECT COALESCE(json_agg(json_build_object(
		'table', c.relname::text, 'name', pol.polname::text, 'command', pol.polcmd::text, 'permissive', pol.polpermissive,
		'roles', (SELECT COALESCE(json_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(r)::text END ORDER BY CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(r)::text END), '[]'::json) FROM unnest(pol.polroles) AS r),
		'using', pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
		'check', pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid)
	) ORDER BY c.relname, pol.polname), '[]'::json)::text
	FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ANY($1::text[])`,
	roles: `SELECT COALESCE(json_agg(json_build_object(
		'name', r.rolname::text, 'login', r.rolcanlogin, 'inherit', r.rolinherit, 'superuser', r.rolsuper, 'createRole', r.rolcreaterole,
		'createDb', r.rolcreatedb, 'replication', r.rolreplication, 'bypassRls', r.rolbypassrls,
		'config', (SELECT COALESCE(json_agg(x ORDER BY x), '[]'::json) FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS x WHERE s.setrole = r.oid AND s.setdatabase = 0),
		'databaseConfig', (SELECT COALESCE(json_agg(x ORDER BY x), '[]'::json) FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS x WHERE s.setrole = r.oid AND s.setdatabase = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())),
		'memberOf', (SELECT COALESCE(json_agg(json_build_object('role', x.role, 'inherit', x.inherit, 'set', x.set, 'admin', x.admin) ORDER BY x.role COLLATE "C"), '[]'::json) FROM (SELECT g.rolname::text AS role, bool_or(m.inherit_option) AS inherit, bool_or(m.set_option) AS set, bool_or(m.admin_option) AS admin FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid GROUP BY g.rolname) AS x),
		'members', (SELECT COALESCE(json_agg(json_build_object('role', x.role, 'inherit', x.inherit, 'set', x.set, 'admin', x.admin) ORDER BY x.role COLLATE "C"), '[]'::json) FROM (SELECT u.rolname::text AS role, bool_or(m.inherit_option) AS inherit, bool_or(m.set_option) AS set, bool_or(m.admin_option) AS admin FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles u ON u.oid = m.member WHERE m.roleid = r.oid AND m.member IS DISTINCT FROM (SELECT n.nspowner FROM pg_catalog.pg_namespace AS n WHERE n.nspname = ($1::text[])[1]) GROUP BY u.rolname) AS x),
		'inherits', (WITH RECURSIVE h(oid) AS (SELECT m.roleid FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.inherit_option UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN h ON m.member = h.oid WHERE m.inherit_option) SELECT COALESCE(json_agg(pg_catalog.pg_get_userbyid(h.oid)::text ORDER BY pg_catalog.pg_get_userbyid(h.oid)::text COLLATE "C"), '[]'::json) FROM h WHERE h.oid <> r.oid)
	) ORDER BY r.rolname), '[]'::json)::text
	FROM pg_catalog.pg_roles r WHERE EXISTS (SELECT FROM unnest($1::text[]) AS l(s) WHERE starts_with(r.rolname::text, l.s || '__'))`,
	worlds: `SELECT COALESCE(json_agg(json_build_object(
		'name', n.nspname::text, 'owner', pg_catalog.pg_get_userbyid(n.nspowner)::text,
		'grants', ${grants("n.nspacl", "n", "n.nspowner")},
		'relations', (SELECT COALESCE(json_agg(json_build_object(
			'name', c.relname::text, 'kind', c.relkind::text, 'owner', pg_catalog.pg_get_userbyid(c.relowner)::text,
			'options', COALESCE(to_json(c.reloptions), '[]'::json), 'grants', ${grants("c.relacl", "r", "c.relowner")},
			'columns', (SELECT COALESCE(json_agg(json_build_object('name', a.attname::text, 'type', ${typeJson("a.atttypid", "a.atttypmod")}) ORDER BY a.attnum), '[]'::json) FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
			'calls', (SELECT COALESCE(json_agg(DISTINCT p.proname::text), '[]'::json) FROM pg_catalog.pg_rewrite w JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = w.oid AND d.refclassid = 'pg_catalog.pg_proc'::regclass JOIN pg_catalog.pg_proc p ON p.oid = d.refobjid JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace WHERE w.ev_class = c.oid AND pn.nspname = ANY($1::text[]))
		) ORDER BY c.relname), '[]'::json) FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid),
		'functions', (SELECT COALESCE(json_agg(p.proname::text ORDER BY p.proname), '[]'::json) FROM pg_catalog.pg_proc p WHERE p.pronamespace = n.oid),
		'types', (SELECT COALESCE(json_agg(t.typname::text ORDER BY t.typname), '[]'::json) FROM pg_catalog.pg_type t WHERE t.typnamespace = n.oid AND NOT (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_catalog.pg_class k WHERE k.oid = t.typrelid AND k.relkind <> 'c')) AND t.typtype <> 'b')
	) ORDER BY n.nspname), '[]'::json)::text
	FROM pg_catalog.pg_namespace n WHERE EXISTS (SELECT FROM unnest($1::text[]) AS l(s) WHERE starts_with(n.nspname::text, l.s || '__'))`,
	foreignGrants: `SELECT COALESCE(json_agg(json_build_object('schema', n.nspname::text, 'grantee', r.rolname::text, 'privilege', a.privilege_type) ORDER BY n.nspname, r.rolname, a.privilege_type), '[]'::json)::text
	FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) AS a
	JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
	WHERE EXISTS (SELECT FROM unnest($1::text[]) AS l(s) WHERE starts_with(r.rolname::text, l.s || '__')) AND NOT (n.nspname = ANY($1::text[])) AND NOT EXISTS (SELECT FROM unnest($1::text[]) AS l(s) WHERE starts_with(n.nspname::text, l.s || '__'))`,
	defaultAcls: `SELECT COALESCE(json_agg(json_build_object(
		'role', pg_catalog.pg_get_userbyid(d.defaclrole)::text, 'schema', n.nspname::text, 'objectType', d.defaclobjtype::text,
		'grants', (SELECT COALESCE(json_agg(json_build_object('grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, 'privilege', a.privilege_type) ORDER BY 1, a.privilege_type), '[]'::json) FROM pg_catalog.aclexplode(d.defaclacl) AS a)
	) ORDER BY pg_catalog.pg_get_userbyid(d.defaclrole)::text, COALESCE(n.nspname::text, ''), d.defaclobjtype), '[]'::json)::text
	FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
	WHERE d.defaclnamespace = 0 OR n.nspname = ANY($1::text[])`,
	otherTypes: `SELECT COALESCE(json_agg(t.typname::text ORDER BY t.typname), '[]'::json)::text
	FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
	WHERE n.nspname = ANY($1::text[]) AND t.typtype NOT IN ('e', 'd') AND t.typtype <> 'b'
	AND NOT (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c'))`,
	/**
	 * The database's settings, whatever the schema: $1 is read only so the query takes the parameter every query takes.
	 */
	databaseSettings: `SELECT COALESCE(json_agg(x ORDER BY x), '[]'::json)::text
	FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) AS x
	WHERE s.setrole = 0 AND s.setdatabase = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
	AND $1::text[] IS NOT NULL`,
	publishedTables: `SELECT COALESCE(json_agg(json_build_object(
		'publication', t.pubname::text, 'schema', t.schemaname::text, 'table', t.tablename::text
	) ORDER BY t.pubname, t.schemaname, t.tablename), '[]'::json)::text
	FROM pg_catalog.pg_publication_tables t WHERE t.schemaname::text = ANY($1::text[])`
} as const

/** A catalog record as its JSON document spells it: what may be none is PostgreSQL's NULL there, an Option here. */
type Document<T> = {
	readonly [K in keyof T]: T[K] extends Option.Option<infer A> ? A | null : T[K]
}

/**
 * A column as the catalog document holds it: pg_attribute.attidentity ("a" ALWAYS, "d" BY DEFAULT, "" none) and
 * attgenerated ("s" STORED, "v" VIRTUAL, "" none), the default or generation expression, and the identity sequence.
 */
interface ColumnDocument {
	readonly name: ColumnIdent
	readonly type: CatalogType
	readonly notNull: boolean
	readonly collation: string | null
	readonly identity: "" | "a" | "d"
	readonly generated: "" | "s" | "v"
	readonly expression: string | null
	readonly sequence: string | null
}

/** A column's generation; an identity column owning no sequence, or a generated one no expression, is a defect. */
const generationOf = (raw: ColumnDocument): CatalogGeneration => {
	if (raw.identity !== "") {
		return {
			kind: "identity",
			always: raw.identity === "a",
			sequence: Option.getOrThrowWith(
				Option.fromNullOr(raw.sequence),
				() => new Error(`catalog: identity column ${raw.name} owns no sequence`)
			)
		}
	}
	if (raw.generated !== "") {
		return {
			kind: "computed",
			stored: raw.generated === "s",
			expression: Option.getOrThrowWith(
				Option.fromNullOr(raw.expression),
				() => new Error(`catalog: generated column ${raw.name} has no expression`)
			)
		}
	}
	return { kind: "given", default: Option.fromNullOr(raw.expression) }
}

const columnOf = (raw: ColumnDocument): CatalogColumn => ({
	name: raw.name,
	type: raw.type,
	notNull: raw.notNull,
	collation: Option.fromNullOr(raw.collation),
	generation: generationOf(raw)
})

const constraintOf = (raw: Document<CatalogConstraint>): CatalogConstraint => ({
	...raw,
	references: Option.fromNullOr(raw.references)
})

/** A table as the catalog document holds it, its columns and constraints as their documents. */
type TableDocument = Omit<CatalogTable, "columns" | "constraints"> & {
	readonly columns: ReadonlyArray<ColumnDocument>
	readonly constraints: ReadonlyArray<Document<CatalogConstraint>>
}

const tableOf = (raw: TableDocument): CatalogTable => ({
	...raw,
	columns: Arr.map(raw.columns, columnOf),
	constraints: Arr.map(raw.constraints, constraintOf)
})

/**
 * An index, named as a constraint when it backs one or is unique (a key's, a partial unique law's), and as an access
 * index otherwise.
 */
const indexOf = (raw: Document<CatalogIndex>): CatalogIndex => ({
	...raw,
	predicate: Option.fromNullOr(raw.predicate),
	constraint: Option.fromNullOr(raw.constraint)
})

const policyOf = (raw: Document<CatalogPolicy>): CatalogPolicy => ({
	...raw,
	using: Option.fromNullOr(raw.using),
	check: Option.fromNullOr(raw.check)
})

const domainOf = (raw: Document<CatalogDomain>): CatalogDomain => ({
	...raw,
	collation: Option.fromNullOr(raw.collation)
})

const defaultAclOf = (raw: Document<CatalogDefaultAcl>): CatalogDefaultAcl => ({
	...raw,
	schema: Option.fromNullOr(raw.schema)
})

/** The schema's head: its owner and grants, or its absence (queries.schema returns one document either way). */
type SchemaHead =
	| { readonly kind: "absent" }
	| {
			readonly kind: "present"
			readonly owner: string
			readonly grants: ReadonlyArray<CatalogGrant>
	  }

/**
 * What runs one catalog statement with its parameters and returns its rows positionally: an owner connection
 * (readCatalog), or the migration session after an apply (test/pg/migrate/support.ts checkedAdmission).
 */
export type CatalogStatement<E> = (
	sql: string,
	params: ReadonlyArray<ReadonlyArray<string>>
) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>

/**
 * The one JSON text document `sql` returns over `schema`; a missing one is a defect of this support code: every query
 * is an aggregate or a COALESCE of a scalar subquery.
 */
const documentText =
	<E>(run: CatalogStatement<E>, schemas: Arr.NonEmptyReadonlyArray<string>) =>
	(sql: string): Effect.Effect<string, E> =>
		Effect.flatMap(run(sql, [schemas]), (rows) => {
			const text = rows[0]?.[0]
			return typeof text === "string"
				? Effect.succeed(text)
				: Effect.die(new Error(`catalog: no JSON document from ${Str.slice(0, 60)(sql)}`))
		})

/**
 * Reads the installed catalog of one schema, its worlds' schemas and its roles as plain, comparable data.
 *
 * Every query returns one JSON text document, so the result does not depend on the driver's binary decoding of arrays
 * or OIDs. Privileges are read with acldefault() standing in for a NULL ACL, so PostgreSQL's built-in defaults (PUBLIC
 * USAGE on types, PUBLIC EXECUTE on functions) show up as the grants they are. This is test support: its SQL is
 * hand-written introspection, not emitted grizzle SQL.
 *
 * The catalog of `schema` as the statements `run` runs see it, the owner's, or the schema's absence.
 */
export const readCatalogWith = <E>(
	run: CatalogStatement<E>,
	schemas: Arr.NonEmptyReadonlyArray<string>
): Effect.Effect<InstalledCatalog, E> =>
	Effect.gen(function* () {
		const schema = schemas[0]
		const read = documentText(run, schemas)
		const headText = yield* read(queries.schema)
		const head = trustedJson<SchemaHead>(headText)
		if (head.kind === "absent") {
			return { kind: "absent", schema }
		}
		const texts = yield* Effect.all({
			tables: read(queries.tables),
			indexes: read(queries.indexes),
			enumLabels: read(queries.enumLabels),
			domains: read(queries.domains),
			sequences: read(queries.sequences),
			functions: read(queries.functions),
			triggers: read(queries.triggers),
			statistics: read(queries.statistics),
			policies: read(queries.policies),
			roles: read(queries.roles),
			worlds: read(queries.worlds),
			foreignGrants: read(queries.foreignGrants),
			defaultAcls: read(queries.defaultAcls),
			otherTypes: read(queries.otherTypes),
			databaseSettings: read(queries.databaseSettings),
			publishedTables: read(queries.publishedTables)
		})
		return {
			kind: "present",
			catalog: {
				schema,
				levels: schemas,
				owner: head.owner,
				schemaGrants: head.grants,
				tables: Arr.map(trustedJson<ReadonlyArray<TableDocument>>(texts.tables), tableOf),
				indexes: Arr.map(
					trustedJson<ReadonlyArray<Document<CatalogIndex>>>(texts.indexes),
					indexOf
				),
				enumLabels: Number(texts.enumLabels),
				domains: Arr.map(
					trustedJson<ReadonlyArray<Document<CatalogDomain>>>(texts.domains),
					domainOf
				),
				sequences: trustedJson<ReadonlyArray<CatalogSequence>>(texts.sequences),
				functions: trustedJson<ReadonlyArray<CatalogFunction>>(texts.functions),
				triggers: trustedJson<ReadonlyArray<CatalogTrigger>>(texts.triggers),
				statistics: trustedJson<ReadonlyArray<CatalogStatistics>>(texts.statistics),
				policies: Arr.map(
					trustedJson<ReadonlyArray<Document<CatalogPolicy>>>(texts.policies),
					policyOf
				),
				roles: trustedJson<ReadonlyArray<CatalogRole>>(texts.roles),
				worlds: trustedJson<ReadonlyArray<CatalogWorld>>(texts.worlds),
				foreignGrants: trustedJson<ReadonlyArray<CatalogForeignGrant>>(texts.foreignGrants),
				defaultAcls: Arr.map(
					trustedJson<ReadonlyArray<Document<CatalogDefaultAcl>>>(texts.defaultAcls),
					defaultAclOf
				),
				otherTypes: trustedJson<ReadonlyArray<string>>(texts.otherTypes),
				databaseSettings: trustedJson<ReadonlyArray<string>>(texts.databaseSettings),
				publishedTables: trustedJson<ReadonlyArray<CatalogPublishedTable>>(texts.publishedTables)
			}
		}
	})

/** The catalog of an installation's level schemas `schemas`, its root's first, as `connection` (the owner) sees it, or
 * the root schema's absence. */
export const readCatalog = (
	connection: PgConnection,
	schemas: Arr.NonEmptyReadonlyArray<string>
): Effect.Effect<InstalledCatalog, SqlError> =>
	readCatalogWith((sql, params) => connection.queryValues(sql, params), schemas)
