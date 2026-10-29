import { Array as Arr, Effect, Order, pipe, Result, Schema, String as Str } from "effect"
import {
	attributeDifferences,
	attributesQuery,
	databaseDifferences,
	databaseSettingsQuery,
	defaultPrivilegeDifferences,
	defaultPrivilegesParams,
	defaultPrivilegesQuery,
	type MembershipDifference,
	memberDifferences,
	membershipDifferences,
	membershipsQuery,
	membersQuery,
	type PrivilegeDifference,
	policiesQuery,
	policyDifferences,
	privilegesParams,
	privilegesQuery,
	roleDifferences,
	type SettingDifference,
	settingsQuery
} from "#adapter/admission/roles.ts"
import { toResult } from "#adapter/engine.ts"
import type { CatalogRowRefused } from "#adapter/errors/failures.ts"
import type { BatchOutcome, BatchStatement, Flight, Transaction } from "#adapter/wire/batch.ts"
import { type CatalogQuery, catalogRow, catalogRows, outcomeRows } from "#adapter/wire/statement.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { type ManifestStatement, manifestStatements } from "#compiler/deploy/admission/manifest.ts"
import {
	defaultPrivilegesExpectations,
	judgedSchemas,
	manifestRoles,
	roleExpectation
} from "#compiler/deploy/admission/roles.ts"
import type { LedgerState } from "#compiler/deploy/ledger/ledger.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { emit, unmetered } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	type AstHooks,
	identityHooks,
	transformCreateIndex,
	transformStatement
} from "#compiler/sql/transform.ts"

/**
 * The drift check: the installed schema against the target snapshot, judged by PostgreSQL, after `grizzle migrate`.
 *
 * A hand-edited migration may change how a state is reached, never the state: edits are allowed, drift is not. The
 * apply runner runs this check after every apply, also when nothing was pending, so `grizzle migrate` on an up-to-date
 * database is the drift check of a deployed one.
 *
 * What an object is, PostgreSQL alone spells. In one transaction that the runner rolls back (driftTransaction), the
 * check creates a scratch schema for the installed schema and for each role's schema, replays into them the manifest's
 * object statements with each installed schema renamed to its scratch one (no role, membership, grant, default
 * privilege, database default, extension or query runs there; a policy names its installed role), and reads each pair
 * of schemas through one description statement: every relation, column, constraint, domain constraint, type, enum
 * label list, function, trigger, statistics object, row security policy and rewrite rule, each keyed by its kind and
 * its names (quote_ident, so a key is injective) and described by PostgreSQL's own deparse (pg_get_constraintdef,
 * pg_get_indexdef, pg_get_functiondef, pg_get_triggerdef, pg_get_viewdef, pg_get_statisticsobjdef, pg_get_expr and
 * format_type) with its owner and its state: an index not valid, a trigger not enabled, row security on a table. The
 * two descriptions are compared key by key: a key only the snapshot's has is missing, one only the installed schema's
 * has is unexpected, and a key both have with two definitions is both. Deparsed text is compared only with deparsed
 * text from the same server, so no model of PostgreSQL's deparser exists anywhere. A column, a statistics object's
 * column list and a set of enum labels in their sort order are read so that the attribute order a migrated table
 * differs from a fresh one by never enters a description: columns are keyed by name, and statistics columns listed by
 * name.
 *
 * The scratch name is `grizzle_admission_` and 24 hex digits of the schema name's SHA-256: lower case, no keyword, so
 * PostgreSQL never quotes it, and a description of the scratch schema reads as the installed schema's once each
 * occurrence of the scratch name is replaced by the installed name as PostgreSQL prints it (quote_ident), and each
 * occurrence quoted, as grizzle's printer writes every identifier into a function body, by the quoted installed name.
 * Nothing of the scratch schema ever commits, and nothing in it refers to the installed schema, so it takes no lock on
 * an installed object. The migration identity may create a schema, since its first migration creates the installed
 * one.
 *
 * Beside the objects: the database holds the defaults the snapshot sets, the owner's default privileges grant no one
 * but the owner anything beyond PostgreSQL's own defaults the snapshot's revokes leave, everywhere and in each schema
 * the installation holds (a default privilege of the owner's is a privilege on whatever a later migration creates; the
 * empty snapshot alters none and owns nothing, so it judges no one's), every login and role the snapshot creates
 * exists with its attributes (a login LOGIN NOINHERIT, a role NOLOGIN, neither SUPERUSER, CREATEDB, CREATEROLE,
 * REPLICATION or BYPASSRLS), each one's settings, privileges, memberships, members and policies are exactly the
 * snapshot's (roles.ts, the statements Db.open runs for its own login and role), every extension the snapshot creates
 * lives in the schema it names, and the ledger's latest complete target is the snapshot's with no folder partial
 * (ledgerMismatches). A grant to a role the snapshot does not create is not drift, unless it makes that role a member
 * of a login or theory role beyond what the snapshot grants: then something besides the login acts through it.
 *
 * Every value read is text and never NULL: a description's parts are joined by concat_ws, which leaves out a part the
 * object lacks and returns text in any case.
 *
 * A fact the snapshot requires and the database lacks (`missing`), or one the database holds and the snapshot does
 * not (`unexpected`).
 */
export const DriftMismatch = Schema.Struct({
	kind: Schema.Literals(["missing", "unexpected"]),
	fact: Schema.String
})
export type DriftMismatch = typeof DriftMismatch.Type

/** The drift check's transaction: one snapshot for every read, the scratch installation beside them, rolled back. */
export const driftTransaction: Transaction = { access: "readWrite", end: "ROLLBACK" }

/** The scratch schema a schema's expected objects are deparsed in. */
const scratchSchema = (schema: string): string =>
	`grizzle_admission_${pipe(sha256Hex(schema), Str.slice(0, 24))}`

const notExtensionMember = (catalog: string, oid: string) =>
	`NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS x WHERE x.classid = '${catalog}'::regclass AND x.objid = ${oid} AND x.deptype = 'e'::"char")`

const owner = (oid: string) => `'owner '::text || pg_catalog.pg_get_userbyid(${oid})::text`

/** A collation as `<schema>.<name>`; no row, and so no part of the description, for none. */
const collationOf = (oid: string) =>
	"(SELECT 'collation '::text || pg_catalog.quote_ident(cn.nspname::text) || '.'::text || pg_catalog.quote_ident(co.collname::text) " +
	`FROM pg_catalog.pg_collation AS co JOIN pg_catalog.pg_namespace AS cn ON cn.oid = co.collnamespace WHERE co.oid = ${oid})`

/** The parts of a description joined by `; `; concat_ws leaves out a part that is absent. */
const parts = (...items: ReadonlyArray<string>) =>
	`pg_catalog.concat_ws('; '::text, ${Arr.join(items, ", ")})`

/** A key's names after its kind: the schema the keys spell ($2) and each name, quoted as PostgreSQL quotes it. */
const keyOf = (kind: string, ...names: ReadonlyArray<string>) =>
	`'${kind} '::text || pg_catalog.quote_ident($2::text) || ${Arr.join(
		Arr.map(names, (n) => `'.'::text || pg_catalog.quote_ident(${n}::text)`),
		" || "
	)}`

const inSchema = "n.nspname = $1::text"

/**
 * Each object of a schema with its description, two text columns: $1 the schema read, $2 the schema the keys spell.
 *
 * A view's or materialized view's own _RETURN rule is its definition, described with the view.
 *
 * A NOT NULL constraint is its column's `not null`, whatever its name, which a renamed table keeps from before.
 *
 * A statistics object's columns by name: PostgreSQL keeps them in column order (stxkeys), which differs between a
 * migrated table, whose retyped column was added last, and a fresh one.
 */
const descriptionSql = Arr.join(
	[
		`SELECT 'schema '::text || pg_catalog.quote_ident($2::text), ${parts(owner("n.nspowner"))} ` +
			`FROM pg_catalog.pg_namespace AS n WHERE ${inSchema}`,
		`SELECT ${keyOf("relation", "c.relname")}, ${parts(
			"'kind '::text || c.relkind::text",
			owner("c.relowner"),
			"CASE c.relpersistence WHEN 'u'::\"char\" THEN 'unlogged'::text WHEN 't'::\"char\" THEN 'temporary'::text END",
			"'options '::text || c.reloptions::text",
			"CASE WHEN c.relrowsecurity THEN 'row security'::text END",
			"CASE WHEN c.relforcerowsecurity THEN 'forced row security'::text END",
			"CASE WHEN c.relkind IN ('m'::\"char\", 'v'::\"char\") THEN 'as '::text || pg_catalog.pg_get_viewdef(c.oid, false) " +
				"WHEN c.relkind IN ('i'::\"char\", 'I'::\"char\") THEN pg_catalog.pg_get_indexdef(c.oid) END",
			"(SELECT 'not valid'::text FROM pg_catalog.pg_index AS i WHERE i.indexrelid = c.oid " +
				"AND NOT (i.indisvalid AND i.indisready AND i.indislive))",
			"(SELECT 'as '::text || pg_catalog.format_type(q.seqtypid, -1) || ' increment '::text || q.seqincrement::text " +
				"|| ' minimum '::text || q.seqmin::text || ' maximum '::text || q.seqmax::text || ' cache '::text " +
				"|| q.seqcache::text || CASE WHEN q.seqcycle THEN ' cycle'::text ELSE ''::text END " +
				"FROM pg_catalog.pg_sequence AS q WHERE q.seqrelid = c.oid)",
			"(SELECT 'owned by '::text || pg_catalog.quote_ident(o.relname::text) || '.'::text || pg_catalog.quote_ident(a.attname::text) " +
				"FROM pg_catalog.pg_depend AS d JOIN pg_catalog.pg_class AS o ON o.oid = d.refobjid " +
				"JOIN pg_catalog.pg_attribute AS a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid " +
				"WHERE c.relkind = 'S'::\"char\" AND d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid " +
				"AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a'::\"char\", 'i'::\"char\") " +
				"ORDER BY o.relname, a.attname LIMIT 1)"
		)} FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace ` +
			`WHERE ${inSchema} AND c.relkind IN ('r'::"char", 'p'::"char", 'm'::"char", 'v'::"char", 'S'::"char", 'f'::"char", 'c'::"char", 'i'::"char", 'I'::"char") ` +
			`AND ${notExtensionMember("pg_catalog.pg_class", "c.oid")}`,
		`SELECT ${keyOf("column", "c.relname", "a.attname")}, ${parts(
			"pg_catalog.format_type(a.atttypid, a.atttypmod)",
			collationOf("a.attcollation"),
			"CASE WHEN a.attnotnull THEN 'not null'::text END",
			"CASE a.attidentity WHEN 'a'::\"char\" THEN 'generated always as identity'::text " +
				"WHEN 'd'::\"char\" THEN 'generated by default as identity'::text END",
			"(SELECT CASE a.attgenerated WHEN 's'::\"char\" THEN 'generated stored as '::text " +
				"WHEN 'v'::\"char\" THEN 'generated virtual as '::text ELSE 'default '::text END " +
				"|| pg_catalog.pg_get_expr(d.adbin, d.adrelid) FROM pg_catalog.pg_attrdef AS d " +
				"WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum)"
		)} FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid ` +
			`JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace ` +
			`WHERE ${inSchema} AND c.relkind IN ('r'::"char", 'p'::"char", 'f'::"char") AND a.attnum > 0::int2 ` +
			`AND NOT a.attisdropped AND ${notExtensionMember("pg_catalog.pg_class", "c.oid")}`,
		`SELECT ${keyOf("constraint", "c.relname", "k.conname")}, pg_catalog.pg_get_constraintdef(k.oid) ` +
			"FROM pg_catalog.pg_constraint AS k JOIN pg_catalog.pg_class AS c ON c.oid = k.conrelid " +
			"JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
			`WHERE ${inSchema} AND k.contype NOT IN ('n'::"char", 't'::"char") ` +
			`AND ${notExtensionMember("pg_catalog.pg_class", "c.oid")}`,
		`SELECT ${keyOf("domain constraint", "t.typname", "k.conname")}, pg_catalog.pg_get_constraintdef(k.oid) ` +
			"FROM pg_catalog.pg_constraint AS k JOIN pg_catalog.pg_type AS t ON t.oid = k.contypid " +
			"JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace " +
			`WHERE ${inSchema} AND ${notExtensionMember("pg_catalog.pg_type", "t.oid")}`,
		`SELECT ${keyOf("type", "t.typname")}, ${parts(
			"'kind '::text || t.typtype::text",
			owner("t.typowner"),
			"CASE WHEN t.typtype = 'd'::\"char\" THEN 'over '::text || pg_catalog.format_type(t.typbasetype, t.typtypmod) END",
			collationOf("t.typcollation"),
			"CASE WHEN t.typnotnull THEN 'not null'::text END",
			"'default '::text || pg_catalog.pg_get_expr(t.typdefaultbin, 0::oid)",
			"(SELECT 'labels '::text || pg_catalog.array_agg(e.enumlabel ORDER BY e.enumsortorder)::text " +
				"FROM pg_catalog.pg_enum AS e WHERE e.enumtypid = t.oid HAVING pg_catalog.count(*) > 0)"
		)} FROM pg_catalog.pg_type AS t JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace ` +
			`WHERE ${inSchema} ` +
			`AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS r WHERE r.oid = t.typrelid AND r.relkind <> 'c'::"char") ` +
			`AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type AS e WHERE e.typarray = t.oid) ` +
			`AND ${notExtensionMember("pg_catalog.pg_type", "t.oid")}`,
		`SELECT ${keyOf("function", "p.proname")} || '('::text || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'::text, ${parts(
			owner("p.proowner"),
			"CASE WHEN p.prokind IN ('f'::\"char\", 'p'::\"char\") THEN pg_catalog.pg_get_functiondef(p.oid) " +
				"ELSE 'kind '::text || p.prokind::text END"
		)} FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace ` +
			`WHERE ${inSchema} AND ${notExtensionMember("pg_catalog.pg_proc", "p.oid")}`,
		`SELECT ${keyOf("trigger", "c.relname", "g.tgname")}, ${parts(
			"pg_catalog.pg_get_triggerdef(g.oid, false)",
			"CASE WHEN g.tgenabled <> 'O'::\"char\" THEN 'enabled '::text || g.tgenabled::text END"
		)} FROM pg_catalog.pg_trigger AS g JOIN pg_catalog.pg_class AS c ON c.oid = g.tgrelid ` +
			`JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace ` +
			`WHERE ${inSchema} AND NOT g.tgisinternal`,
		`SELECT ${keyOf("statistics", "x.stxname")}, ${parts(
			owner("x.stxowner"),
			"'kinds '::text || x.stxkind::text",
			"(SELECT 'on '::text || pg_catalog.string_agg(pg_catalog.quote_ident(a.attname::text), ', '::text ORDER BY a.attname::text COLLATE \"C\") " +
				"FROM pg_catalog.unnest(x.stxkeys) AS u(n) JOIN pg_catalog.pg_attribute AS a ON a.attrelid = x.stxrelid AND a.attnum = u.n)",
			"'expressions '::text || pg_catalog.pg_get_statisticsobjdef_expressions(x.oid)::text",
			"(SELECT 'from '::text || pg_catalog.quote_ident(r.relname::text) FROM pg_catalog.pg_class AS r WHERE r.oid = x.stxrelid)"
		)} FROM pg_catalog.pg_statistic_ext AS x JOIN pg_catalog.pg_namespace AS n ON n.oid = x.stxnamespace ` +
			`WHERE ${inSchema}`,
		`SELECT ${keyOf("policy", "c.relname", "p.polname")}, ${parts(
			"'command '::text || p.polcmd::text",
			"CASE WHEN p.polpermissive THEN 'permissive'::text ELSE 'restrictive'::text END",
			"'using '::text || pg_catalog.pg_get_expr(p.polqual, p.polrelid)",
			"'check '::text || pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)",
			"(SELECT 'to '::text || pg_catalog.string_agg(pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(o.role)::text), ', '::text " +
				'ORDER BY pg_catalog.pg_get_userbyid(o.role)::text COLLATE "C") FROM pg_catalog.unnest(p.polroles) AS o(role))'
		)} FROM pg_catalog.pg_policy AS p JOIN pg_catalog.pg_class AS c ON c.oid = p.polrelid ` +
			`JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE ${inSchema}`,
		`SELECT ${keyOf("rule", "c.relname", "r.rulename")}, pg_catalog.pg_get_ruledef(r.oid, false) ` +
			"FROM pg_catalog.pg_rewrite AS r JOIN pg_catalog.pg_class AS c ON c.oid = r.ev_class " +
			"JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
			`WHERE ${inSchema} AND r.rulename <> '_RETURN'::name AND ${notExtensionMember("pg_catalog.pg_class", "c.oid")}`
	],
	" UNION ALL "
)

const descriptions: CatalogQuery<readonly [string, string]> = {
	sql: descriptionSql,
	what: "an object's key and its description",
	row: ([key, description]) =>
		key === undefined || description === undefined ? undefined : [key, description]
}

/** A name as PostgreSQL prints it. */
const quotedIdent: CatalogQuery<string> = {
	sql: "SELECT pg_catalog.quote_ident($1::text)",
	what: "a quoted name",
	row: ([quoted]) => quoted
}

/** The schema an extension lives in: one row, none when it is not installed. */
const extensionSchema: CatalogQuery<string> = {
	sql:
		"SELECT n.nspname::text FROM pg_catalog.pg_extension AS e " +
		"JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace WHERE e.extname = $1::text",
	what: "a schema name",
	row: ([schema]) => schema
}

/**
 * The hooks that move every name qualified by an installed schema to its scratch schema (sql/transform.ts): an object
 * name, a named type, a qualified function, an extension operator and an extension's schema. A collation is
 * pg_catalog's, which is never a grizzle schema (PostgreSQL reserves the pg_ prefix).
 */
const scratchHooks = (scratchOf: ReadonlyMap<string, string>): AstHooks => {
	const moved = (schema: string): string => scratchOf.get(schema) ?? schema
	return {
		...identityHooks,
		objectName: (n) => ({ ...n, schema: moved(n.schema) }),
		typeRef: (t) => (t.kind === "named" ? { ...t, schema: moved(t.schema) } : t),
		functionRef: (f) => ({ ...f, schema: moved(f.schema) }),
		expr: (e) =>
			e.kind === "binary" && e.schema !== undefined ? { ...e, schema: moved(e.schema) } : e,
		extension: (x) => ({ ...x, schema: moved(x.schema) })
	}
}

/**
 * What a manifest statement runs in the scratch schemas: an object of an installed schema, built in its scratch one,
 * each installed schema created as its scratch one and an index built in the transaction, never concurrently; nothing
 * for a role, a membership, a grant, a default privilege, a database default, an extension, a comment or a query.
 */
const inScratch = (
	s: ManifestStatement,
	scratchOf: ReadonlyMap<string, string>
): ReadonlyArray<SqlStatement> => {
	const hooks = scratchHooks(scratchOf)
	switch (s.kind) {
		case "createSchema":
			return [{ ...s, name: scratchOf.get(s.name) ?? s.name }]
		case "createIndex":
			return [{ ...transformCreateIndex(s, hooks), concurrently: false }]
		case "createTable":
		case "alterTable":
		case "createDomain":
		case "createEnum":
		case "createMaterializedView":
		case "createView":
		case "createPolicy":
		case "createFunction":
		case "createConstraintTrigger":
		case "createGuardTrigger":
		case "createStatistics":
			return [transformStatement(s, hooks)]
		case "alterDatabaseDefault":
		case "createRole":
		case "alterRole":
		case "grantRole":
		case "grant":
		case "grantColumns":
		case "revoke":
		case "alterDefaultPrivileges":
		case "createExtension":
		case "comment":
		case "select":
			return []
	}
}

/** The texts that build the snapshot's objects in the scratch schemas, in the manifest's order. */
const scratchStatements = (
	statements: ReadonlyArray<ManifestStatement>,
	scratchOf: ReadonlyMap<string, string>
): Result.Result<ReadonlyArray<string>, CompileError> => {
	const texts: Array<string> = []
	for (const d of Arr.flatMap(statements, (s) => inScratch(s, scratchOf))) {
		const e = emit(d, emptyNameMap, unmetered)
		if (!e.ok) {
			return Result.fail(e.error)
		}
		texts.push(e.value.text)
	}
	return Result.succeed(texts)
}

/**
 * A text deparsed in the scratch schemas as it reads in the installed ones: each scratch name quoted, as grizzle's
 * printer writes it into a function body, becomes the quoted installed name, and each scratch name bare, as PostgreSQL
 * prints it, becomes the installed name as PostgreSQL prints it (`printed`, from quote_ident). A scratch name is
 * `grizzle_admission_` and a digest, so no scratch name holds another.
 */
const fromScratch =
	(
		names: ReadonlyArray<{
			readonly scratch: string
			readonly schema: string
			readonly printed: string
		}>
	) =>
	(text: string): string =>
		Arr.reduce(names, text, (t, n) =>
			pipe(
				t,
				Str.replaceAll(quoteIdent(n.scratch), quoteIdent(n.schema)),
				Str.replaceAll(n.scratch, n.printed)
			)
		)

/**
 * The installed descriptions against the snapshot's: each key only one side has, and each key whose descriptions
 * differ, as the snapshot's missing and the installed one unexpected.
 */
const compareDescriptions = (
	expected: ReadonlyMap<string, string>,
	installed: ReadonlyMap<string, string>
): ReadonlyArray<DriftMismatch> => {
	const out: Array<DriftMismatch> = []
	const fact = (key: string, description: string) => `${key} as ${description}`
	for (const [key, want] of expected) {
		const have = installed.get(key)
		if (have === want) {
			continue
		}
		out.push({ kind: "missing", fact: fact(key, want) })
		if (have !== undefined) {
			out.push({ kind: "unexpected", fact: fact(key, have) })
		}
	}
	for (const [key, have] of installed) {
		if (!expected.has(key)) {
			out.push({ kind: "unexpected", fact: fact(key, have) })
		}
	}
	return out
}

/** A setting difference as facts, `at` where it applies. */
const settingFacts = (d: SettingDifference, at: string): ReadonlyArray<DriftMismatch> => {
	const fact = (value: string) => `${at} setting ${d.parameter}=${value}`
	switch (d.kind) {
		case "missing":
			return [{ kind: "missing", fact: fact(d.value) }]
		case "unexpected":
			return [{ kind: "unexpected", fact: fact(d.value) }]
		case "differs":
			return [
				{ kind: "missing", fact: fact(d.expected) },
				{ kind: "unexpected", fact: fact(d.observed) }
			]
	}
}

const privilegeFact = (d: PrivilegeDifference, role: string): DriftMismatch => ({
	kind: d.kind,
	fact: `role ${role} privilege ${d.privilege} on ${d.family} ${d.object}`
})

/**
 * A membership's or a member's facts, `what` naming the pair: one the snapshot grants is held exactly WITH INHERIT FALSE,
 * SET TRUE and no ADMIN; one beyond it is reported for what it opens (roles.ts membershipDifferences,
 * memberDifferences).
 */
const membershipFacts = (d: MembershipDifference, what: string): ReadonlyArray<DriftMismatch> => {
	switch (d.kind) {
		case "missing":
			return [{ kind: "missing", fact: `${what} with inherit false, set true` }]
		case "options":
			return [
				{ kind: "missing", fact: `${what} with inherit false, set true` },
				{ kind: "unexpected", fact: `${what} with other options` }
			]
		case "unexpected":
			return [{ kind: "unexpected", fact: what }]
	}
}

const command = (sql: string): BatchStatement => ({ sql, params: [] })

/** A catalog statement's place in a flight: its rows read back from the flight's outcomes, at the position it was sent
 * at, captured when it was sent (Sending), so no reader counts positions. */
interface Slot<Row> {
	readonly rows: (
		outcomes: ReadonlyArray<BatchOutcome>
	) => Result.Result<ReadonlyArray<Row>, CatalogRowRefused>
	readonly row: (outcomes: ReadonlyArray<BatchOutcome>) => Result.Result<Row, CatalogRowRefused>
}

/** A flight's statements as they are sent, in order: a command, whose outcome nothing reads, or a catalog query, read
 * through the slot it is sent into. */
interface Sending {
	readonly statements: ReadonlyArray<BatchStatement>
	readonly command: (sql: string) => void
	readonly query: <Row>(query: CatalogQuery<Row>, params: ReadonlyArray<string>) => Slot<Row>
}

const sending = (): Sending => {
	const statements: Array<BatchStatement> = []
	const sent = (statement: BatchStatement): number => statements.push(statement) - 1
	return {
		statements,
		command: (sql) => {
			sent(command(sql))
		},
		query: (query, params) => {
			const at = sent({ sql: query.sql, params })
			return {
				rows: (outcomes) => catalogRows(query, outcomeRows(outcomes, at)),
				row: (outcomes) => catalogRow(query, outcomeRows(outcomes, at))
			}
		}
	}
}

/**
 * The mismatches of a flight by fact. Each is found once: a description by its key, the database's settings once, and
 * every other fact by its role or extension.
 */
const sorted = (mismatches: ReadonlyArray<DriftMismatch>): ReadonlyArray<DriftMismatch> =>
	Arr.sort(mismatches, Order.Struct({ fact: Order.String, kind: Order.String }))

/**
 * The drift check of `snapshot`'s schema as statements of driftTransaction, in order, each read through the slot it is
 * sent into (Sending): each installed schema's name as PostgreSQL prints it, the installed schema's first and then each
 * role's; the installed schema's scratch schema first on the search path, so names the replay leaves unqualified land
 * in it; the replay; the search path without any of them, since the reads qualify every name; each schema's installed
 * and scratch descriptions; then each extension's schema, the database's settings, the owner's default privileges (none
 * for the empty snapshot, which alters no default), and each login's and role's login, settings, privileges,
 * memberships and policies.
 */
export const driftFlight = (
	snapshot: DeploySnapshot
): Result.Result<Flight<ReadonlyArray<DriftMismatch>, CatalogRowRefused>, CompileError> =>
	Result.gen(function* () {
		const schema = snapshot.schema
		const statements = yield* toResult(manifestStatements(snapshot))
		const schemas = judgedSchemas(statements, schema)
		const scratchOf = new Map(Arr.map(schemas, (s) => [s, scratchSchema(s)] as const))
		const replay = yield* scratchStatements(statements, scratchOf)
		const extensions = Arr.flatMap(statements, (s) => (s.kind === "createExtension" ? [s] : []))
		const roles = Arr.map(manifestRoles(statements), (role) =>
			roleExpectation(statements, schema, role)
		)
		const flight = sending()
		const printed = Arr.map(schemas, (s) => ({ schema: s, slot: flight.query(quotedIdent, [s]) }))
		flight.command(
			`SET LOCAL search_path TO ${quoteIdent(scratchSchema(schema))}, pg_catalog, pg_temp`
		)
		for (const s of replay) {
			flight.command(s)
		}
		flight.command("SET LOCAL search_path TO pg_catalog, pg_temp")
		const described = Arr.map(schemas, (s) => ({
			installed: flight.query(descriptions, [s, s]),
			expected: flight.query(descriptions, [scratchSchema(s), s])
		}))
		const extensionSchemas = Arr.map(extensions, (x) => ({
			extension: x,
			slot: flight.query(extensionSchema, [x.name])
		}))
		const database = flight.query(databaseSettingsQuery, [])
		const defaults = Arr.map(defaultPrivilegesExpectations(statements, schema), (expectation) => ({
			expectation,
			slot: flight.query(defaultPrivilegesQuery(expectation), defaultPrivilegesParams(expectation))
		}))
		const roleReads = Arr.map(roles, (r) => ({
			expectation: r,
			attributes: flight.query(attributesQuery, [r.role]),
			settings: flight.query(settingsQuery, [r.role]),
			privileges: flight.query(privilegesQuery, privilegesParams(r)),
			memberships: flight.query(membershipsQuery, [r.role]),
			members: flight.query(membersQuery, [r.role, schema]),
			policies: flight.query(policiesQuery, [r.role, schema])
		}))
		return {
			statements: flight.statements,
			read: (outcomes) =>
				Effect.fromResult(
					Result.gen(function* () {
						const names: Array<{ scratch: string; schema: string; printed: string }> = []
						for (const p of printed) {
							names.push({
								scratch: scratchSchema(p.schema),
								schema: p.schema,
								printed: yield* p.slot.row(outcomes)
							})
						}
						const rename = fromScratch(names)
						const out: Array<DriftMismatch> = []
						for (const d of described) {
							const installed = yield* d.installed.rows(outcomes)
							const expected = yield* d.expected.rows(outcomes)
							out.push(
								...compareDescriptions(
									new Map(Arr.map(expected, ([k, e]) => [rename(k), rename(e)])),
									new Map(installed)
								)
							)
						}
						for (const { extension: x, slot } of extensionSchemas) {
							const at = yield* slot.rows(outcomes)
							if (!at.includes(x.schema)) {
								out.push({ kind: "missing", fact: `extension ${x.name} in schema ${x.schema}` })
							}
						}
						for (const d of databaseDifferences(yield* database.rows(outcomes))) {
							out.push(...settingFacts(d, "database"))
						}
						for (const { expectation, slot } of defaults) {
							const owned = yield* slot.rows(outcomes)
							for (const d of defaultPrivilegeDifferences(owned, expectation)) {
								out.push({ kind: d.kind, fact: `default privilege ${d.grant}` })
							}
						}
						for (const read of roleReads) {
							const r = read.expectation
							for (const d of attributeDifferences(yield* read.attributes.rows(outcomes), r)) {
								out.push({ kind: "missing", fact: `role ${r.role} ${d.expected}` })
								if (d.attribute !== "existence") {
									out.push({ kind: "unexpected", fact: `role ${r.role} ${d.observed}` })
								}
							}
							for (const d of roleDifferences(yield* read.settings.rows(outcomes), r)) {
								out.push(
									...settingFacts(
										d,
										d.scope === "roleInDatabase" ? `role ${r.role} in database` : `role ${r.role}`
									)
								)
							}
							for (const d of yield* read.privileges.rows(outcomes)) {
								out.push(privilegeFact(d, r.role))
							}
							for (const d of membershipDifferences(yield* read.memberships.rows(outcomes), r)) {
								out.push(...membershipFacts(d, `role ${r.role} membership in ${d.role}`))
							}
							for (const d of memberDifferences(yield* read.members.rows(outcomes), r)) {
								out.push(...membershipFacts(d, `role ${r.role} member ${d.role}`))
							}
							for (const d of policyDifferences(yield* read.policies.rows(outcomes), r)) {
								out.push({
									kind: d.kind,
									fact: `policy ${d.policy.name} on ${d.policy.table} naming role ${r.role}`
								})
							}
						}
						return sorted(out)
					})
				)
		}
	})

/** The ledger's facts: its latest complete target is the snapshot's, and no folder is partial. */
export const ledgerMismatches = (
	snapshot: DeploySnapshot,
	state: LedgerState
): ReadonlyArray<DriftMismatch> => {
	const out: Array<DriftMismatch> = []
	if (state.latest !== snapshot.fingerprint) {
		out.push({ kind: "missing", fact: `ledger latest ${snapshot.fingerprint}` })
		out.push({ kind: "unexpected", fact: `ledger latest ${state.latest}` })
	}
	if (state.partial !== undefined) {
		out.push({ kind: "unexpected", fact: `ledger partial ${state.partial.folder}` })
	}
	return out
}
