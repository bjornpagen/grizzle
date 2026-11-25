import {
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { isAsciiDigits } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { maxStringLength, unwrap } from "#compiler/core/canonical.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import type { ClockUnit } from "#compiler/core/clock.ts"
import { resourceBound } from "#compiler/core/errors.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import {
	BlockLines,
	CommentedLines,
	chunkedTextOf,
	inlineText,
	type Lines,
	textOf
} from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { blockSize } from "#compiler/core/page.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { messageMaxBytes } from "#compiler/core/wire.ts"
import {
	type AlterDomainAction,
	type AlterRoleAction,
	type AlterTableAction,
	type ArrayColumn,
	type ArraysSource,
	type CarriedColumn,
	type ClockInstant,
	type CatalogTypeName,
	catalogSpelling,
	closedSearchPath,
	type ColumnDef,
	type ColumnDefinition,
	type CreateCarrier,
	type DeclareStatistics,
	type DeclaredDistinct,
	type StoredGeneration,
	type CommentTarget,
	type ContextSource,
	type CreateDeclaredFunction,
	type CreateConstant,
	type CreateFunction,
	type Cte,
	type CteBody,
	type Delete,
	type DomainConstraint,
	type Expr,
	type ForeignKeyColumn,
	type FrameBound,
	type FromItem,
	type FunctionCall,
	type FunctionName,
	type FunctionParam,
	type FunctionRef,
	type Grantee,
	type GrantObjects,
	type HandOverFunction,
	type IndexKey,
	type Insert,
	type JoinStep,
	type KeyColumn,
	type LiteralValue,
	type Merge,
	type MergeWhen,
	type NamedGrantObjects,
	type ObjectName,
	type OnConflict,
	type OrderItem,
	type PackConstant,
	type PackLayout,
	type PerformQuery,
	type PlBlock,
	type PlDeclaration,
	type PlFunction,
	type PlStatement,
	type SessionTableStorage,
	type PublishedTable,
	type DrivenColumn,
	type MetKey,
	type ProbeBy,
	type ProbeColumn,
	type QualifiedFunctionRef,
	type RoleSetting,
	type OperandBody,
	type OperandSelect,
	type SelectCore,
	type SqlStatement,
	type StubConstant,
	type TableConstraint,
	type TableName,
	type Target,
	type TransitionEvent,
	type TriggerEvent,
	type TypeRef,
	tableConstraints,
	transitionTables,
	type Update,
	type Using,
	type WindowSpec,
	type With
} from "#compiler/sql/ast.ts"
import {
	and,
	call as builtinCall,
	cast,
	col,
	conjunction,
	core as operandCore,
	cUtf8Collation,
	eq,
	exists,
	gt,
	isIn,
	lit,
	not,
	objectName,
	or,
	provedCore,
	qualifiedCall,
	select as selectOf,
	simpleSelect,
	types
} from "#compiler/sql/build.ts"
import {
	type CatalogCall,
	type CatalogCast,
	type CatalogCore,
	type CatalogExpr,
	type CatalogFrom,
	type CatalogSelect,
	type CatalogStatement,
	type DoBlock,
	type DoStatement,
	databaseResetBlock,
	databaseLock
} from "#compiler/sql/catalog.ts"
import { lineFeedsEscaped } from "#compiler/sql/escape.ts"
import type { CarrierName } from "#compiler/sql/naming.ts"
import { printedFunction, printedOnce } from "#compiler/sql/print-once.ts"
import { identityHooks, statementParams, Transform } from "#compiler/sql/transform.ts"

/**
 * The most entries one select list holds, a SELECT's target list or a RETURNING list, each refused as ResourceBound
 * (selectList) where it is printed, since PostgreSQL refuses a longer one with 54011, "target lists can have at most
 * 1664 entries" (src/backend/parser/parse_node.c free_parsestate).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit entries
 * @scope one target list of one query level
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/access/htup_details.h#L34
 * @quote #define MaxTupleAttributeNumber 1664
 * @verified 2026-11-20
 */
export const selectMaxEntries = 1_664

/**
 * The most placeholders one statement binds: a Bind message counts its parameter values in an unsigned 16-bit field,
 * `numParams = pq_getmsgint(input_message, 2);`
 * (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/tcop/postgres.c#L1734), and the count must be the
 * statement's highest `$n` ("bind message supplies %d parameters, but prepared statement \"%s\" requires %d"), so a
 * statement of more is refused as ResourceBound (statementParams) when it is printed.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's frontend/backend protocol
 * @unit placeholders
 * @scope one statement
 * @constraint protocol constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/doc/src/sgml/limits.sgml#L115-L116
 * @quote <entry>query parameters</entry> <entry>65,535</entry>
 * @verified 2026-11-20
 */
export const statementMaxParams = 2 ** 16 - 1

/** An integer literal of PostgreSQL's integer type, which prints bare. */
const sqlUnit = "  "

/** Where a statement's text is refused: as ResourceBound, for a bound PostgreSQL or V8 sets on it. */
const statementTextLoc = SourceLoc("SQL statement text", [])

/**
 * The deterministic SQL printer.
 *
 * One AST prints to one text, byte for byte, in every process: the printer reads nothing but its input and uses no
 * locale-sensitive formatting. It quotes every identifier, prints every parameter as `$n::type` and
 * every literal typed, wraps a table's CHECK as `CHECK ((<predicate>) IS TRUE)` and a domain's as
 * `CHECK (VALUE IS NULL OR (<predicate>) IS TRUE)`, and parenthesizes by PostgreSQL's operator precedence so the
 * printed text parses back to the tree it came from.
 *
 * Layout. The insert protocol (write/insert/protocol.ts) is the reference, and the printer reproduces its layout:
 * - a statement's own clauses go on separate lines: the outermost SELECT's FROM, WHERE, GROUP BY, HAVING, ORDER BY,
 *   LIMIT and OFFSET, and each clause of a DML statement;
 * - each CTE of the statement's WITH is a block, `name(cols) AS (` ... `)`, its body indented two spaces;
 * - a query nested anywhere else, a CTE body included, prints on one line;
 * - PL/pgSQL nests by two spaces.
 * Every block is written once into one line sink (core/lines.ts) whose views carry their indentation.
 * Every type, function and relation name is printed by its schema, quoted (printObjectName), so a text means one thing
 * under every search_path: a keyword type is the grammar's, which resolves into pg_catalog itself (sql/ast.ts
 * catalogSpelling), and a configuration name is PostgreSQL's own spelling. Operators alone print bare (sql/ast.ts Ddl).
 *
 * Every identifier is quoted, so case and reserved words never matter.
 */

/**
 * A role of the installation where a statement names it: psql's identifier variable `:"<stem>"`, the role's stem, which
 * `grizzle generate` commits, the one way a statement names an installation's role. Migrate fills it with the role the
 * installation's role space installs (deploy/render/variables.ts resolveVariables), so one drafted file installs under every
 * role space, and one never filled is a syntax error, never another role.
 */
const printRole = (stem: string): string => `:${quoteIdent(stem)}`

/**
 * A role of the installation where a statement reads its name as a value: psql's literal variable `:'<stem>'`, which
 * migrate fills with the quoted literal of the name the installation's role space installs (deploy/render/variables.ts
 * resolveVariables), as it fills printRole's identifier.
 */
const printRoleName = (stem: string): string => `:${quoteString(stem)}`

/** The name of the variable that stands for the current database, psql's own: a name of no role stem, all of which
 * hold `__`. */
export const databaseVariable = "DBNAME"

/** The current database where a GRANT or REVOKE on it names it, `:"DBNAME"`: an installation's statements name no
 * database, and migrate fills it with its connection's (deploy/render/variables.ts resolveVariables). */
const printDatabase = (): string => `:${quoteIdent(databaseVariable)}`

export const printObjectName = (name: ObjectName): string =>
	`${quoteIdent(name.schema)}.${quoteIdent(name.name)}`

/** Each isolation level as BEGIN ISOLATION LEVEL spells it. */
const isolationLevels: { readonly [I in Isolation]: string } = {
	serializable: "SERIALIZABLE",
	readCommitted: "READ COMMITTED"
}

/** A constraint trigger's row event as CREATE CONSTRAINT TRIGGER spells it. */
/** A transition trigger's event as CREATE TRIGGER spells it. */
const transitionEventText: Readonly<Record<TransitionEvent, string>> = {
	insert: "INSERT",
	update: "UPDATE",
	delete: "DELETE"
}

/** A transition trigger's REFERENCING clause: the transition tables its event holds, each by its name. */
const transitionReferences: Readonly<Record<TransitionEvent, string>> = {
	insert: `NEW TABLE AS ${quoteIdent(transitionTables.news)}`,
	update: `OLD TABLE AS ${quoteIdent(transitionTables.olds)} NEW TABLE AS ${quoteIdent(transitionTables.news)}`,
	delete: `OLD TABLE AS ${quoteIdent(transitionTables.olds)}`
}

const triggerEventText = (event: TriggerEvent): string => {
	switch (event.kind) {
		case "insert":
			return "INSERT"
		case "delete":
			return "DELETE"
		case "update":
			return `UPDATE OF ${event.columns.map(quoteIdent).join(", ")}`
	}
}

/** A name of pg_catalog's, qualified by it. */
const inCatalog = (name: string): string => printObjectName({ schema: "pg_catalog", name })

/** A pg_catalog type as it names pg_catalog's type under every search_path (sql/ast.ts catalogSpelling). */
const printCatalogType = (name: CatalogTypeName): string => {
	switch (catalogSpelling[name]) {
		case "keyword":
			return name
		case "qualified":
			return inCatalog(name)
	}
}

/**
 * The longest wait for one session's end (writeEndHolders): pg_terminate_backend reads its timeout, an int8 of
 * milliseconds, into a C int, so this, the greatest C int, is the longest wait it holds, and a larger one wraps
 * (9223372036854775807 reads as -1, refused 22003). The end waits for a backend's exit as a migration waits for a lock,
 * with no deadline of grizzle's (adapter/migrate/session.ts): interrupting the migration cancels it, pg_terminate_backend
 * checking for interrupts every 100 ms of its wait (pg_wait_until_termination).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's pg_terminate_backend (src/backend/storage/ipc/signalfuncs.c)
 * @unit milliseconds
 * @scope the wait for one backend's exit in one statement that ends the sessions holding a dropped role's temporary
 *   objects
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/storage/ipc/signalfuncs.c#L239
 * @quote int timeout; (milliseconds), then timeout = PG_GETARG_INT64(1);
 * @verified 2026-11-23
 */
const terminationWaitMaxMillis = 2 ** 31 - 1

/**
 * The end of every session that holds a temporary object of a role among `names`, each the SQL text of a role's name
 * (sql/ast.ts EndHolders, sql/catalog.ts UninstallStatement), one statement:
 *
 *   SELECT pg_terminate_backend(pg_stat_get_backend_pid(b.proc), <terminationWaitMaxMillis>)
 *   FROM pg_database AS d, pg_stat_get_backend_idset() AS b(proc)
 *   WHERE d.datname = current_database() AND pg_stat_get_backend_dbid(b.proc) = d.oid AND EXISTS (SELECT FROM
 *   pg_shdepend AS s JOIN pg_roles AS r ON r.oid = s.refobjid CROSS JOIN LATERAL pg_identify_object(s.classid,
 *   s.objid, s.objsubid) AS o WHERE s.dbid = d.oid AND s.refclassid = 'pg_authid'::regclass AND s.deptype = 'o' AND
 *   r.rolname IN (<names>) AND o.schema = 'pg_temp_' || b.proc)
 *
 * Exactly the sessions that hold one, never every session of a login: PostgreSQL 19 names a session's temporary schema
 * pg_temp_<its proc number> (namespace.c InitTempTableNamespace), the number pg_stat_get_backend_pid and _dbid read a
 * backend by (backend_status.c pgstat_get_beentry_by_proc_number), so each backend of the database is matched to its
 * own schema; and the objects a role owns are its owner rows in pg_shdepend, the rows DROP ROLE refuses by
 * (pg_shdepend.c checkSharedDependencies), any kind of object, a table, its function or a type alike, each placed by
 * pg_identify_object, which reads the catalog as it stands, never the transaction's snapshot, so an object a session's
 * exit dropped after the snapshot is found no more. A session that holds objects only of roles that stay keeps running.
 *
 * Each end waits until the backend has exited, which it does after dropping its temporary objects (namespace.c
 * RemoveTempRelationsCallback, run before it leaves): when the statement returns, none of them stands, and DROP ROLE,
 * which reads the catalog as it stands too, finds none. A wait that ran out returns false with a warning, and DROP ROLE
 * refuses the role (2BP01): the transaction rolls back whole.
 *
 * No session makes a new one between this read and DROP ROLE: a session makes a role's temporary object only inside a
 * Db transaction, under the role its SET LOCAL ROLE takes on, and a migration's transaction took the ledger's ACCESS
 * EXCLUSIVE lock first (uninstall's DROP SCHEMA of the ledger takes it), which waited for every Db transaction in
 * flight and refuses every new one at its fence (deploy/ledger/ledger.ts). Revoking the role's TEMPORARY in the same
 * transaction would not do it: another session reads the database's privileges as committed, and makes its object
 * anyway (PostgreSQL 19, 2026-11-23: a session made a temporary table under a role after the role's DROP OWNED in a
 * transaction still open, and DROP ROLE then refused it, 2BP01).
 *
 * PostgreSQL lets a role end a backend whose session user, the login, it holds the privileges of, or any backend of a
 * role not superuser where it holds pg_signal_backend's (signalfuncs.c pg_signal_backend); a role's own membership is
 * not enough, since a session's user is its login, not the role it took on. Uninstall adopts the installation's roles,
 * its logins among them, first; a migration's identity holds pg_signal_backend (README "A migration role").
 */
const writeEndHolders = (out: Lines, names: NonEmptyReadonlyArray<string>): void => {
	const backend = `${inCatalog("pg_stat_get_backend_pid")}("b"."proc")`
	out.line(
		`SELECT ${inCatalog("pg_terminate_backend")}(${backend}, ${terminationWaitMaxMillis.toString()})`
	)
	out.line(
		`FROM ${inCatalog("pg_database")} AS "d", ${inCatalog("pg_stat_get_backend_idset")}() AS "b"("proc")`
	)
	out.line(
		`WHERE "d"."datname" = ${inCatalog("current_database")}() AND ${inCatalog("pg_stat_get_backend_dbid")}("b"."proc") = "d"."oid" AND EXISTS (SELECT FROM ${inCatalog("pg_shdepend")} AS "s" JOIN ${inCatalog("pg_roles")} AS "r" ON "r"."oid" = "s"."refobjid" CROSS JOIN LATERAL ${inCatalog("pg_identify_object")}("s"."classid", "s"."objid", "s"."objsubid") AS "o" WHERE "s"."dbid" = "d"."oid" AND "s"."refclassid" = ${quoteString("pg_catalog.pg_authid")}::${printCatalogType("regclass")} AND "s"."deptype" = ${quoteString("o")} AND "r"."rolname" IN (${names.join(", ")}) AND "o"."schema" = ${quoteString("pg_temp_")} || "b"."proc")`
	)
}

/**
 * The instant a reading counts (sql/ast.ts ClockInstant): the call's transaction's, or the instant a moved call states,
 * the Unix epoch plus its microseconds as an interval, `<n> microseconds`, which interval input reads as exactly n, an
 * int64 of the unit (REL_19_0 src/backend/utils/adt/datetime.c DecodeInterval, strtoi64 then AdjustMicroseconds), where
 * to_timestamp's float8 seconds would round an instant to a float's precision, so the instant is exactly the one
 * stated, a reading of it in microseconds the stated count itself, and one timestamptz cannot hold is PostgreSQL's
 * refusal, every reading of it inside the clock's range (core/clock.ts clockReadingRange).
 */
const printInstant = (instant: ClockInstant): string => {
	switch (instant.kind) {
		case "transaction":
			return `${inCatalog("transaction_timestamp")}()`
		case "moved":
			return `(${printLiteral({ kind: "text", value: "epoch" }, types.text).text}::${inCatalog("timestamptz")} + ${inCatalog("format")}(${printLiteral({ kind: "text", value: "%s microseconds" }, types.text).text}, ${printExpr(instant.at)})::${inCatalog("interval")})`
	}
}

/** The seconds since the Unix epoch at `instant`: numeric, exact to the microsecond. */
const clockSeconds = (instant: ClockInstant): string =>
	`${inCatalog("extract")}(${printLiteral({ kind: "text", value: "epoch" }, types.text).text}, ${printInstant(instant)})`

/**
 * The microseconds in a second, the resolution PostgreSQL's timestamps hold (SI prefix micro, 10^-6).
 *
 * @formatConstant a second in microseconds: 10^6
 */
const microsPerSecond = 1_000_000n

/**
 * The milliseconds in a second, the resolution of JavaScript's Date (SI prefix milli, 10^-3).
 *
 * @formatConstant a second in milliseconds: 10^3
 */
const millisPerSecond = 1_000n

/** The factor that counts seconds in a clock unit. */
const clockFactors: { readonly [U in ClockUnit]: bigint } = {
	micros: microsPerSecond,
	millis: millisPerSecond
}

/**
 * `instant` counted in `unit` since the Unix epoch, floored (sql/ast.ts Expr clock): its seconds times the unit's
 * factor, which counts microseconds exactly and milliseconds with a fraction `floor` drops.
 */
const clockReading = (instant: ClockInstant, unit: ClockUnit): string => {
	const counted = `${clockSeconds(instant)} * ${printLiteral({ kind: "int", value: clockFactors[unit] }, types.numeric).text}`
	switch (unit) {
		case "micros":
			return counted
		case "millis":
			return `${inCatalog("floor")}(${counted})`
	}
}

/** A table by its schema: a carrier's is pg_temp, the session's own temporary schema. */
export const printTableName = (table: TableName): string =>
	printObjectName(typeof table === "string" ? { schema: temporarySchema, name: table } : table)

/** closedSearchPath as a SET clause spells it. */
const printedSearchPath = closedSearchPath.map(quoteIdent).join(", ")

/**
 * A login default as ALTER ROLE ... SET spells it: search_path's schemas as a list, each quoted, since PostgreSQL reads
 * one string literal as a path of one schema; a text parameter's value as one string literal.
 */
export const printRoleSetting = (setting: RoleSetting): string =>
	setting.parameter === "search_path"
		? `search_path = ${printedSearchPath}`
		: `${setting.parameter} = ${quoteString(setting.value)}`

/**
 * A login default's value as PostgreSQL stores it, the text after `<parameter>=` in pg_db_role_setting, which SHOW
 * prints too: a text parameter's value as it is; search_path's schemas each as quote_identifier spells it, joined by
 * ", ", which leaves closedSearchPath's two names bare.
 */
export const storedSettingValue = (setting: RoleSetting): string =>
	setting.parameter === "search_path" ? closedSearchPath.join(", ") : setting.value

/**
 * A text as one argument of a startup packet's options, which PostgreSQL splits at whitespace, taking the character
 * after a backslash as it is: each backslash and whitespace character escaped.
 */
const optionArgument = (text: string): string => {
	let out = ""
	for (const c of text) {
		out += c === "\\" || c.trim() === "" ? `\\${c}` : c
	}
	return out
}

/**
 * Login defaults as a startup packet's `options`, `-c <parameter>=<value>` each, in order, every value as PostgreSQL
 * stores it (storedSettingValue), so each session that sends them starts under exactly the stored defaults.
 */
export const printStartupOptions = (settings: NonEmptyReadonlyArray<RoleSetting>): string =>
	settings.map((s) => `-c ${optionArgument(`${s.parameter}=${storedSettingValue(s)}`)}`).join(" ")

/**
 * A text[] literal's text: each element double-quoted, its backslashes and double quotes escaped, so any name is one
 * element, an empty one and one holding a comma, a brace or a space included.
 */
export const textArrayLiteral = (elements: ReadonlyArray<string>): string =>
	`{${elements.map((e) => `"${e.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`

/** The setting a Db's transactions hold their claims in, which the prologue sets (deploy/ledger/ledger.ts enter). */
export const claimsSettingName = "grizzle.claims"

/** `::` and a pg_catalog type, as a cast appends it. */
const castTo = (name: CatalogTypeName): string => `::${printCatalogType(name)}`

/** `::` and the array of a pg_catalog type. */
const castToArray = (name: CatalogTypeName): string => `::${printCatalogType(name)}[]`

/**
 * The refusal of an unreadable claims setting, through the installation's refusal function (write/refusal.ts): SQLSTATE
 * 22P02, the setting's name as the constraint name, and the DETAIL `c[]` for a setting that is no claims document or
 * `c["<Context>"]` for a context's member that holds other keys than its fields. It carries no claim value, and never
 * returns.
 */
const refuseClaims = (
	refusal: QualifiedFunctionRef,
	context: readonly [] | readonly [string]
): string =>
	`${printFunctionName(refusal)}('22P02'${castTo("text")}, ${quoteString(claimsSettingName)}${castTo("text")}, ${quoteString(`c${JSON.stringify(context)}`)}${castTo("text")})`

/**
 * The jsonpath of a claims document's members that break the shape the Db path writes (adapter/db/claims.ts): a member
 * that is no object, or an object holding a value that is no string.
 */
const claimsMisshapen = `'strict $.* ? (@.type() != "object" || exists (@.* ? (@.type() != "string")))'${castTo("jsonpath")}`

/**
 * The session's claims document as a one-row query of one column, "j": the empty object where the setting holds no
 * claims, which is NULL before a transaction set it in the session and `''` once that transaction ended (`NULL <> ''`
 * is no match, so both take the outer ELSE); the setting as jsonb where it is a JSON object without a repeated key at
 * any depth that jsonb reads; and refused through `refusal` otherwise, invalid JSON included. Its members' shape is
 * judged where it is read (contextClaims), over the jsonb it parsed once. pg_input_is_valid reads its type's name as
 * text, so the name is pg_catalog's, qualified.
 */
const claimsDocument = (refusal: QualifiedFunctionRef): string =>
	`SELECT CASE WHEN "k"."s" <> ''${castTo("text")} THEN CASE WHEN "k"."s" IS JSON OBJECT WITH UNIQUE KEYS AND ${inCatalog("pg_input_is_valid")}("k"."s", ${quoteString(inCatalog("jsonb"))}${castTo("text")}) THEN "k"."s"${castTo("jsonb")} ELSE ${inCatalog("to_jsonb")}(${refuseClaims(refusal, [])}) END ELSE '{}'${castTo("jsonb")} END AS "j" FROM (SELECT ${inCatalog("current_setting")}(${quoteString(claimsSettingName)}${castTo("text")}, true) AS "s") AS "k"`

/** A claim of a context source in the claims document `document`: its JSON string at `field`, cast to `type`. */
const claimRead = (document: string, source: ContextSource, field: string, type: TypeRef): string =>
	`(${document} #>> ${quoteString(textArrayLiteral([source.context, field]))}${castToArray("text")})::${printType(type)}`

/**
 * The claims document as a context source reads it (sql/ast.ts ContextSource), a scalar subquery: refused through the
 * source's refusal function where the document is no claims document, a member that is no object of strings breaking
 * the shape the Db path writes; the document where it holds no member for the context, or a member holding exactly the
 * source's fields, each a value of the type it is judged by (ContextColumn `judged`: its field's own, a contract's,
 * pattern's or roster's domain included), which reads every claim once here, so a claim its type or its refinement
 * refuses raises that error (22P02, 22003, 23514) wherever the context is read, whichever columns the source's
 * readers read (a read of a string is never NULL, so num_nonnulls counts every field); and refused where the member
 * holds any other keys. It reads no column of the statement, so PostgreSQL computes it once per statement as an
 * InitPlan, reading the setting once: when it is first read, or, under a parallel plan, before the workers start.
 */
const contextClaims = (source: ContextSource): string => {
	const context = `${quoteString(source.context)}${castTo("text")}`
	const member = `("d"."j" -> ${context})`
	const keys = `${quoteString(textArrayLiteral(source.columns.map((c) => c.field)))}${castToArray("text")}`
	const reads = source.columns
		.map((c) => claimRead(`"d"."j"`, source, c.field, c.judged))
		.join(", ")
	const readable = `${member} ?& ${keys} AND (${member} - ${keys}) = '{}'${castTo("jsonb")} AND ${inCatalog("num_nonnulls")}(${reads}) = ${source.columns.length}`
	return `(SELECT CASE WHEN ${inCatalog("jsonb_path_exists")}("d"."j", ${claimsMisshapen}) THEN ${inCatalog("to_jsonb")}(${refuseClaims(source.refusal, [])}) WHEN NOT ("d"."j" ? ${context}) OR (${readable}) THEN "d"."j" ELSE ${inCatalog("to_jsonb")}(${refuseClaims(source.refusal, [source.context])}) END FROM (${claimsDocument(source.refusal)}) AS "d")`
}

/**
 * A context source (sql/ast.ts ContextSource) as a derived table: the claims document as the source reads it, once, as
 * "m"."j", and each column its claim, collated as the column is, over the one row where the document holds the
 * context. The document's query calls the refusal function, which is VOLATILE, so PostgreSQL never pulls "m" up into
 * its readers, and the document stays one InitPlan however many columns are read.
 */
const printContextSource = (source: ContextSource): string => {
	const reads = source.columns.map((c) => {
		const read = claimRead(`"m"."j"`, source, c.field, c.column.type)
		return c.column.collation === undefined
			? read
			: `${read} COLLATE ${printObjectName(c.column.collation)}`
	})
	return `(SELECT ${reads.join(", ")} FROM (SELECT ${contextClaims(source)} AS "j") AS "m" WHERE "m"."j" ? ${quoteString(source.context)}${castTo("text")}) AS ${quoteIdent(source.alias)}(${printIdentList(source.columns.map((c) => c.column.name))})`
}

/** numeric's precision and scale, or bit(n)'s length. */
const builtinTypmod = (type: Extract<TypeRef, { readonly kind: "builtin" }>): string => {
	if (type.name === "bit") {
		return `(${type.length})`
	}
	return type.precision === undefined
		? ""
		: type.scale === undefined
			? `(${type.precision})`
			: `(${type.precision}, ${type.scale})`
}

export const printType = (type: TypeRef): string => {
	const array = type.array ? "[]" : ""
	switch (type.kind) {
		case "named":
			return `${printObjectName(type)}${namedTypmod(type)}${array}`
		case "builtin":
			return `${printCatalogType(type.name)}${builtinTypmod(type)}${array}`
	}
}

const namedTypmod = (type: Extract<TypeRef, { readonly kind: "named" }>): string =>
	type.typmod.length === 0 ? "" : `(${type.typmod.join(", ")})`

/**
 * A type as a declared function's body names it: a named type, one of the function's own schema (its row types), by
 * its name alone, which the function's pinned search_path resolves wherever the function stands, its installed schema
 * or the drift check's scratch schema, whose replay renames a header's schema and never a body's text; a builtin as it
 * prints.
 */
export const typeOnSearchPath = (type: TypeRef): string =>
	type.kind === "named"
		? `${quoteIdent(type.name)}${namedTypmod(type)}${type.array ? "[]" : ""}`
		: printType(type)

const isInt4 = (type: TypeRef): boolean =>
	type.kind === "builtin" && type.name === "integer" && !type.array

const isSpecialDecimal = (value: string): boolean =>
	value === "NaN" || value === "Infinity" || value === "-Infinity"

/**
 * The printer's precedence levels, loosest binding first, after PostgreSQL's operator table: OR, AND, NOT, IS,
 * comparisons, BETWEEN and IN, any other operator, `+ -`, `* / %`, COLLATE, unary minus, `::`, atoms. Each level binds
 * more tightly than every level before it.
 */
const levels = [
	"or",
	"and",
	"not",
	"is",
	"compare",
	"between",
	"other",
	"add",
	"mul",
	"collate",
	"negate",
	"cast",
	"atom"
] as const

type Level = (typeof levels)[number]

/** Whether level `a` binds more loosely than level `b`. */
const looser = (a: Level, b: Level): boolean => levels.indexOf(a) < levels.indexOf(b)

export interface Printed {
	readonly text: string
	readonly level: Level
}

const printed = (text: string, level: Level): Printed => ({ text, level })

/**
 * How the printer spells a literal before its cast: a string, quoted, that the type's input function reads, or bare, a
 * boolean or numeric constant PostgreSQL types itself, or a bit string's hex constant, `X'<digits>'`. A negative bare
 * number is parenthesized, the unary minus of its magnitude.
 */
export type LiteralSpelling =
	| { readonly kind: "quoted"; readonly text: string }
	| { readonly kind: "bare"; readonly text: string }

/**
 * NaN and the infinities are words, read by numeric's input function.
 *
 * String spells a finite double other than -0 in its shortest round-trip form.
 *
 * Quoted, so NaN, the infinities and -0 reach the float input function exactly.
 */
export const spellingOf = (value: LiteralValue): LiteralSpelling => {
	switch (value.kind) {
		case "bool":
			return { kind: "bare", text: value.value ? "true" : "false" }
		case "int":
			return {
				kind: "bare",
				text: value.value < 0n ? `(${value.value.toString()})` : value.value.toString()
			}
		case "decimal":
			return isSpecialDecimal(value.value)
				? { kind: "quoted", text: value.value }
				: { kind: "bare", text: value.value.startsWith("-") ? `(${value.value})` : value.value }
		case "float":
			return { kind: "quoted", text: String(value.value) }
		case "floatSpecial":
			return { kind: "quoted", text: value.value }
		case "text":
			return { kind: "quoted", text: value.value }
		case "bits":
			return { kind: "bare", text: hexConstant(value.hex) }
	}
}

/** A bit string's hex constant, X'<digits>': its digits are 0-9 and A-F alone, so none needs quoting. */
const hexConstant = (hex: string): string => `X'${hex}'`

/**
 * PostgreSQL's boolean constants are typed boolean; a boolean domain casts them.
 *
 * Only a nonnegative integer constant within int4 prints bare, since PostgreSQL types it integer itself (as in
 * `count(*) > 1`). A negative one prints parenthesized and typed, (-N)::integer like every other negative literal:
 * gram.y folds the minus into the constant, which make_const then types by its value (so -2147483648 is an
 * integer constant though its magnitude is not), and the cast states the type whatever the value.
 */
const printLiteral = (value: LiteralValue, type: TypeRef): Printed => {
	if (value.kind === "bool" && type.kind === "builtin" && type.name === "boolean" && !type.array) {
		return printed(literalText(value), "atom")
	}
	if (value.kind === "int" && isInt4(type) && value.value >= 0n) {
		return printed(literalText(value), "atom")
	}
	return typedLiteral(value, type)
}

const literalText = (value: LiteralValue): string => {
	const spelling = spellingOf(value)
	return spelling.kind === "quoted" ? quoteString(spelling.text) : spelling.text
}

/** A literal cast to its type, a constant of that type wherever it stands, whatever its value. */
const typedLiteral = (value: LiteralValue, type: TypeRef): Printed =>
	printed(`${literalText(value)}::${printType(type)}`, "cast")

/** Whether `e` is a constant as a query's clauses read one: a literal, or the unary minus of one. */
const isConstant = (e: Expr): boolean =>
	e.kind === "literal" || (e.kind === "negate" && isConstant(e.expr))

/**
 * An item of a query's GROUP BY or DISTINCT ON, or of its ORDER BY. PostgreSQL reads a bare constant there, whatever
 * parentheses hold it, as an output column's position where it is an integer and refuses any other
 * (parse_clause.c findTargetlistEntrySQL92), and gram.y folds a unary minus into a numeric constant (doNegate), so a
 * literal, under any minus, prints typed, which PostgreSQL reads as the constant itself.
 */
const clauseItem = (e: Expr): Printed =>
	e.kind === "literal"
		? typedLiteral(e.value, e.type)
		: e.kind === "negate"
			? negated(clauseItem(e.expr))
			: expr(e)

/** The unary minus of an operand: "--" would open a comment. */
const negated = (operand: Printed): Printed => {
	const text = wrap(operand, "negate")
	return printed(text.startsWith("-") ? `-(${text})` : `-${text}`, "negate")
}

const comparisonOperators: ReadonlySet<string> = new Set(["=", "<>", "<", "<=", ">", ">="])
const additiveOperators: ReadonlySet<string> = new Set(["+", "-"])
const multiplicativeOperators: ReadonlySet<string> = new Set(["*", "/", "%"])

/** A child's text, parenthesized unless it binds at least as tightly as `level`. */
const wrap = (child: Printed, level: Level): string =>
	looser(child.level, level) ? `(${child.text})` : child.text

/** A child's text, parenthesized unless it binds more tightly than `level`. */
const wrapTighter = (child: Printed, level: Level): string =>
	looser(level, child.level) ? child.text : `(${child.text})`

/** ASC, the default, prints bare. */
const directed = (text: string, direction: OrderItem["direction"]): string =>
	direction === "ASC" ? text : `${text} ${direction}`

const printOrderItem = (item: OrderItem): string => directed(printExpr(item.expr), item.direction)

const printOrderBy = (items: ReadonlyArray<OrderItem>): string =>
	items.map(printOrderItem).join(", ")

const printFrameBound = (bound: FrameBound): string => {
	switch (bound.kind) {
		case "unboundedPreceding":
			return "UNBOUNDED PRECEDING"
		case "currentRow":
			return "CURRENT ROW"
		case "unboundedFollowing":
			return "UNBOUNDED FOLLOWING"
		case "offset":
			return `${bound.offset.toString()} ${bound.direction}`
	}
}

const printWindow = (spec: WindowSpec): string => {
	const parts: Array<string> = []
	if (spec.partitionBy.length > 0) {
		parts.push(`PARTITION BY ${spec.partitionBy.map((e) => printExpr(e)).join(", ")}`)
	}
	if (spec.orderBy.length > 0) {
		parts.push(`ORDER BY ${printOrderBy(spec.orderBy)}`)
	}
	if (spec.frame !== undefined) {
		parts.push(
			`ROWS BETWEEN ${printFrameBound(spec.frame.start)} AND ${printFrameBound(spec.frame.end)}`
		)
	}
	return `(${parts.join(" ")})`
}

const printFunctionName = (fn: FunctionRef): string =>
	fn.kind === "builtin" ? inCatalog(fn.name) : printObjectName(fn)

/** A call up to its OVER clause. */
const callHead = (call: FunctionCall): string => {
	if (call.star) {
		return call.filter === undefined
			? `${inCatalog("count")}(*)`
			: `${inCatalog("count")}(*) FILTER (WHERE ${printExpr(call.filter)})`
	}
	let args = call.args.map((arg) => printExpr(arg)).join(", ")
	if (call.distinct) {
		args = `DISTINCT ${args}`
	}
	if (call.orderBy.length > 0) {
		args = `${args} ORDER BY ${printOrderBy(call.orderBy)}`
	}
	const head = `${printFunctionName(call.fn)}(${args})`
	return call.withinGroup.length === 0
		? head
		: `${head} WITHIN GROUP (ORDER BY ${printOrderBy(call.withinGroup)})`
}

/** A windowed call is parenthesized when cast, as in `(SUM(count) OVER ())::bigint`. */
const printCall = (call: FunctionCall): Printed =>
	call.over === undefined
		? printed(callHead(call), "atom")
		: printed(`${callHead(call)} OVER ${printWindow(call.over)}`, "cast")

const binaryLevels = (
	op: string,
	qualified: boolean
): { readonly self: Level; readonly assoc: "left" | "none" } => {
	if (qualified) {
		return { self: "other", assoc: "left" }
	}
	if (comparisonOperators.has(op)) {
		return { self: "compare", assoc: "none" }
	}
	if (additiveOperators.has(op)) {
		return { self: "add", assoc: "left" }
	}
	if (multiplicativeOperators.has(op)) {
		return { self: "mul", assoc: "left" }
	}
	return { self: "other", assoc: "left" }
}

/** "--" would open a comment. */
const expr = (e: Expr): Printed => {
	switch (e.kind) {
		case "column":
			return printed(
				e.table === undefined
					? quoteIdent(e.column)
					: `${quoteIdent(e.table)}.${quoteIdent(e.column)}`,
				"atom"
			)
		case "excluded":
			return printed(`EXCLUDED.${quoteIdent(e.column)}`, "atom")
		case "returning":
			return printed(`${e.side}.${quoteIdent(e.column)}`, "atom")
		case "param":
			return printed(`$${e.slot.number}::${printType(e.type)}`, "cast")
		case "clock":
			return printed(`(${clockReading(e.instant, e.unit)})::${printType(e.type)}`, "cast")
		case "literal":
			return printLiteral(e.value, e.type)
		case "cast":
			return printed(`${wrap(expr(e.expr), "atom")}::${printType(e.type)}`, "cast")
		case "collate":
			return printed(
				`${wrap(expr(e.expr), "collate")} COLLATE ${printObjectName(e.collation)}`,
				"collate"
			)
		case "binary": {
			const qualified = e.schema !== undefined
			const { self, assoc } = binaryLevels(e.op, qualified)
			const op = e.schema !== undefined ? `OPERATOR(${quoteIdent(e.schema)}.${e.op})` : e.op
			const left = assoc === "left" ? wrap(expr(e.left), self) : wrapTighter(expr(e.left), self)
			const right = wrapTighter(expr(e.right), self)
			return printed(`${left} ${op} ${right}`, self)
		}
		case "equalsAny": {
			const { self } = binaryLevels("=", e.schema !== undefined)
			const op = e.schema !== undefined ? `OPERATOR(${quoteIdent(e.schema)}.=)` : "="
			return printed(`${wrapTighter(expr(e.expr), self)} ${op} ANY (${printExpr(e.array)})`, self)
		}
		case "negate":
			return negated(expr(e.expr))
		case "and":
			return printed(e.args.map((arg) => wrapTighter(expr(arg), "and")).join(" AND "), "and")
		case "or":
			return printed(e.args.map((arg) => wrapTighter(expr(arg), "or")).join(" OR "), "or")
		case "not":
			return printed(`NOT ${wrap(expr(e.expr), "not")}`, "not")
		case "isTrue":
			return printed(`${wrap(expr(e.expr), "atom")} IS TRUE`, "is")
		case "between": {
			const keyword = e.not ? "NOT BETWEEN" : "BETWEEN"
			const operand = (x: Expr): string => wrap(expr(x), "other")
			/**
			 * The lower bound is PostgreSQL's b_expr, which has no COLLATE: anything binding at COLLATE or looser is
			 * parenthesized, so no bare COLLATE can stand there (an atom, a cast and a negation hold none outside
			 * parentheses).
			 */
			const low = wrap(expr(e.low), "negate")
			return printed(`${operand(e.expr)} ${keyword} ${low} AND ${operand(e.high)}`, "between")
		}
		case "inList": {
			const keyword = e.not ? "NOT IN" : "IN"
			const list = e.list.map((item) => printExpr(item)).join(", ")
			return printed(`${wrap(expr(e.expr), "other")} ${keyword} (${list})`, "between")
		}
		case "inQuery": {
			const keyword = e.not ? "NOT IN" : "IN"
			return printed(
				`${wrap(expr(e.expr), "other")} ${keyword} (${printSelectInline(e.query, "placed")})`,
				"between"
			)
		}
		case "exists":
			return e.not
				? printed(`NOT EXISTS (${printSelectInline(e.query, "placed")})`, "not")
				: printed(`EXISTS (${printSelectInline(e.query, "placed")})`, "atom")
		case "subquery":
			return printed(`(${printSelectInline(e.query, "placed")})`, "atom")
		case "array":
			return printed(`ARRAY(${printSelectInline(e.query, "placed")})`, "atom")
		case "row": {
			const items = e.items.map((item) => printExpr(item)).join(", ")
			return printed(e.items.length === 1 ? `ROW(${items})` : `(${items})`, "atom")
		}
		case "case": {
			const parts = ["CASE"]
			if (e.operand !== undefined) {
				parts.push(printExpr(e.operand))
			}
			for (const branch of e.whens) {
				parts.push(`WHEN ${printExpr(branch.when)} THEN ${printExpr(branch.result)}`)
			}
			parts.push(`ELSE ${printExpr(e.else)}`, "END")
			return printed(parts.join(" "), "atom")
		}
		case "call":
			return printCall(e)
		case "greatest":
		case "least":
			return printed(
				`${e.kind === "greatest" ? "GREATEST" : "LEAST"}(${e.args.map((arg) => printExpr(arg)).join(", ")})`,
				"atom"
			)
		case "coalesce":
			return printed(`COALESCE(${e.args.map((arg) => printExpr(arg)).join(", ")})`, "atom")
		case "mergeAction":
			return printed("merge_action()", "atom")
		case "domainValue":
			return printed("VALUE", "atom")
		case "user":
			return printed(e.name, "atom")
		case "plVar":
			return printed(quoteIdent(e.name), "atom")
		case "plSpecial":
			return printed(e.name, "atom")
		case "field":
			return printed(`${expr(e.record).text}.${quoteIdent(e.field)}`, "atom")
		case "regclass":
			return printed(regclassText(e.relation), "cast")
		case "complement":
			return printed(`~ ${wrap(expr(e.expr), "cast")}`, "other")
		case "lowerAscii":
			return printed(
				`${inCatalog("lower")}(${wrap(expr(e.expr), "collate")} COLLATE ${inCatalog("C")}) COLLATE ${printObjectName(cUtf8Collation)}`,
				"collate"
			)
		case "nullif":
			return printed(`NULLIF(${printExpr(e.expr)}, ${printExpr(e.absent)})`, "atom")
		case "subscript":
			return printed(`(${printExpr(e.array)})[${printExpr(e.index)}]`, "atom")
	}
}

/** A relation as a regclass value: its quoted qualified name, read by regclass's input function, never by a path. */
const regclassText = (relation: ObjectName): string =>
	`${quoteString(printObjectName(relation))}${castTo("regclass")}`

export const printExpr = (e: Expr): string => expr(e).text

/** A table's CHECK, `CHECK ((<predicate>) IS TRUE)`: a row its predicate leaves false or unknown is refused. */
const printCheck = (predicate: Expr): string => `CHECK ((${printExpr(predicate)}) IS TRUE)`

/**
 * A domain's CHECK, `CHECK (VALUE IS NULL OR (<predicate>) IS TRUE)`: NULL is a value of every domain, as of every
 * type, and a column's NOT NULL refuses it, so an expression of the domain's type that reads NULL (a closed read at an
 * absent key, a law column outside its selection) is cast to the domain as NULL, and a present value is admitted only
 * where the predicate is true.
 */
const printDomainCheck = (constraint: DomainConstraint): string =>
	`CONSTRAINT ${quoteIdent(constraint.name)} CHECK (VALUE IS NULL OR (${printExpr(constraint.predicate)}) IS TRUE)`

const printTarget = (target: Target): string =>
	target.alias === undefined
		? printExpr(target.expr)
		: `${printExpr(target.expr)} AS ${quoteIdent(target.alias)}`

/** A select list, a SELECT's or a RETURNING's: refused (ResourceBound, selectList) past PostgreSQL's selectMaxEntries. */
const printTargets = (targets: ReadonlyArray<Target>): string => {
	if (targets.length > selectMaxEntries) {
		throw new Refusal(
			resourceBound(statementTextLoc, {
				kind: "selectList",
				limit: selectMaxEntries,
				needed: targets.length
			})
		)
	}
	return targets.map(printTarget).join(", ")
}

const printIdentList = (names: ReadonlyArray<string>): string => names.map(quoteIdent).join(", ")

/** A relation alias's column list: none at all for no column, which PostgreSQL spells by absence, never `()`. */
const aliasList = (columns: ReadonlyArray<string>): string =>
	isNonEmpty(columns) ? `(${printIdentList(columns)})` : ""

/** Whether a type carries a typmod: numeric(p) or numeric(p, s), bit(n), or a named type's, vector(n). */
const hasTypmod = (type: TypeRef): boolean =>
	type.kind === "builtin"
		? type.name === "bit" || type.precision !== undefined
		: type.typmod.length > 0

/** The array type of a column's values: its type, made an array unless it is one. */
const arrayOf = (type: TypeRef): string => (type.array ? printType(type) : `${printType(type)}[]`)

/**
 * One column of a relation input's arrays: the unnest of its array, cast through its refinement's domain array where
 * its check is one (sql/ast.ts ArrayCheck), so PostgreSQL checks every element as it binds the parameter, then the
 * column's element type made an array and collated as the column is, so the output column carries the collation a stored column has (the result of unnest
 * takes its argument's collation, parse_collate.c). unnest keeps no typmod (parse_relation.c: a function's column has
 * its expression's typmod, -1 for a call that is no length coercion), so a column whose type has one, numeric(p, s)
 * or vector(n), is cast back to it, which a recursive CTE seeded from the input needs (parse_cte.c compares typmods,
 * 42804 otherwise).
 */
const printArrayColumn = ({ definition, array, check }: ArrayColumn): string =>
	printUnnested(
		check.kind === "domain"
			? `$${array.number}::${arrayOf(check.domain)}::${arrayOf(definition.type)}`
			: `$${array.number}::${arrayOf(definition.type)}`,
		definition
	)

/**
 * The column a carried array holds (sql/ast.ts CarriedColumn), as a relation input's (printArrayColumn): the array a
 * row in scope carries, an array of the column's base type, which array_agg made of the values a sub-query delivered
 * at that row (lower/shapes/share/keyed.ts KeyedLowering carried).
 */
const printCarriedColumn = ({ definition, array }: CarriedColumn): string =>
	printUnnested(printExpr(array), definition)

/** One column of rows as arrays: the elements of `elements`, collated and typed as `definition` states. */
const printUnnested = (elements: string, definition: ColumnDefinition): string => {
	const collated =
		definition.collation === undefined
			? elements
			: `${elements} COLLATE ${printObjectName(definition.collation)}`
	const unnest = `${inCatalog("unnest")}(${collated})`
	const typed = hasTypmod(definition.type) ? `${unnest}::${printType(definition.type)}` : unnest
	return `${typed} AS ${quoteIdent(definition.name)}`
}

/**
 * Rows as arrays (sql/ast.ts ArraysSource), a relation input's or a row's carried ones, in the select-list form, every
 * function qualified:
 *
 *   (SELECT pg_catalog.unnest($1::uuid[]) AS "c1",
 *     pg_catalog.unnest($2::text[] COLLATE pg_catalog.pg_c_utf8) AS "c2",
 *     pg_catalog.unnest($3::numeric(10, 2)[])::numeric(10, 2) AS "c3") AS "r1"
 *
 * Set-returning functions of one select list run in lockstep, one row per index of arrays of one length, and a
 * ProjectSet streams their rows, where the same calls in FROM would each be read into a tuplestore first
 * (nodeFunctionscan.c). The bare multi-argument unnest(a, b) is PostgreSQL's spelling of the FROM form, and only
 * unqualified (parse_clause.c), so it is never printed. Every placeholder of an execution is a constant of its custom
 * plan (postgres.c exec_bind_message), so the planner estimates each unnest as its array's length (selfuncs.c
 * estimate_array_length), the ProjectSet as the longest (pathnode.c create_set_projection_path).
 *
 * An input of no column is one row of no column per fact, `pg_catalog.generate_series(1::bigint, $1::bigint) AS "r1"`
 * of its count, whose column no reader names; its estimate is the count too (int8.c generate_series_int8_support).
 */
const printArrays = (source: ArraysSource, alias: string): string => {
	switch (source.kind) {
		case "count":
			return `${inCatalog("generate_series")}(1${castTo("bigint")}, $${source.count.number}${castTo("bigint")}) AS ${quoteIdent(alias)}`
		case "columns": {
			const columns = source.columns.map(printArrayColumn)
			const [first] = source.columns
			const ordinal =
				source.ordinal === undefined
					? []
					: [
							`${inCatalog("generate_subscripts")}($${first.array.number}::${arrayOf(first.definition.type)}, 1) AS ${quoteIdent(source.ordinal)}`
						]
			return `(SELECT ${[...columns, ...ordinal].join(", ")}) AS ${quoteIdent(alias)}`
		}
		case "carried":
			return `(SELECT ${source.columns.map(printCarriedColumn).join(", ")}) AS ${quoteIdent(alias)}`
	}
}

const printFromItem = (item: FromItem): string => {
	switch (item.kind) {
		case "table":
			return `${printTableName(item.table)} AS ${quoteIdent(item.alias)}`
		case "probe":
			return printDriven(
				item.table,
				item.inner,
				item.columns,
				item.alias,
				[...item.by.columns.map((c) => boundColumn(item.inner, c)), ...item.filter],
				probeTail(item.inner, item.by)
			)
		case "met":
			return printDriven(
				item.table,
				item.inner,
				item.columns,
				item.alias,
				[...item.key.map((k) => metBound(item.inner, k, item.rows)), ...item.filter],
				"LIMIT 1"
			)
		case "metRows": {
			const sides = [
				...item.columns,
				...item.key
					.filter((k) => !item.columns.some((c) => c.column === k.column))
					.map((k) => ({ column: k.column, returned: k.from }))
			]
			const at = (table: string, columns: ReadonlyArray<string>): string =>
				columns.map((c) => `${quoteIdent(table)}.${quoteIdent(c)}`).join(", ")
			const names = sides.map((c) => c.column)
			const proposedArm = `SELECT ${at(item.scan, names)}, false FROM ${quoteIdent(item.proposed)} AS ${quoteIdent(item.scan)}`
			const returnedArm = `SELECT ${at(
				item.returned,
				sides.map((c) => c.returned)
			)}, true FROM ${quoteIdent(item.insert)} AS ${quoteIdent(item.returned)}`
			const partition = at(
				item.sides,
				item.key.map((k) => k.column)
			)
			const hit = `${inCatalog("bool_or")}(${quoteIdent(item.sides)}.${quoteIdent(item.marker)}) OVER (PARTITION BY ${partition}) AS ${quoteIdent(item.hit)}`
			const marked = `SELECT ${at(item.sides, [...names, item.marker])}, ${hit} FROM (${proposedArm} UNION ALL ${returnedArm}) AS ${quoteIdent(item.sides)}(${printIdentList([...names, item.marker])})`
			const columns = item.columns.map((c) => c.column)
			return `(SELECT ${at(item.marked, columns)} FROM (${marked}) AS ${quoteIdent(item.marked)} WHERE NOT ${quoteIdent(item.marked)}.${quoteIdent(item.hit)}) AS ${quoteIdent(item.alias)}(${printIdentList(columns)})`
		}
		case "cte":
			return item.alias === undefined
				? quoteIdent(item.name)
				: `${quoteIdent(item.name)} AS ${quoteIdent(item.alias)}`
		case "enclosing":
			return `${quoteIdent(item.name)} AS ${quoteIdent(item.alias)}`
		case "transition":
			return `${quoteIdent(item.table)} AS ${quoteIdent(item.alias)}`
		case "derived": {
			const lateral = item.lateral ? "LATERAL " : ""
			return `${lateral}(${printSelectInline(item.query, item.columns.length > 0 ? "placed" : "named")}) AS ${quoteIdent(item.alias)}${aliasList(item.columns)}`
		}
		case "function": {
			const lateral = item.lateral ? "LATERAL " : ""
			const columns = item.columns
			if (columns.kind === "defined") {
				return `${lateral}${printCall(item.call).text} AS ${quoteIdent(item.alias)}(${columns.definitions.map(definitionText).join(", ")})`
			}
			const numbered = columns.ordinality ? " WITH ORDINALITY" : ""
			return `${lateral}${printCall(item.call).text}${numbered} AS ${quoteIdent(item.alias)}${aliasList(columns.names)}`
		}
		case "arrays":
			return printArrays(item.source, item.alias)
		case "values":
			return `(${printValuesRows(item.rows)}) AS ${quoteIdent(item.alias)}(${printIdentList(item.columns)})`
		case "context":
			return printContextSource(item)
		case "joins":
			return [printFromItem(item.first), ...item.steps.map(printJoinStep)].join(" ")
	}
}

/** One step of a join chain: its join and source, and its condition where it has one. */
const printJoinStep = (step: JoinStep): string => {
	switch (step.kind) {
		case "on":
			return `JOIN ${printFromItem(step.source)} ON ${printExpr(step.on)}`
		case "left":
			return `LEFT JOIN ${printFromItem(step.source)} ON ${printExpr(step.on)}`
		case "cross":
			return `CROSS JOIN ${printFromItem(step.source)}`
	}
}

/** A probed column bound to its driving row's value: `"<inner>"."<column>" = <value>`, at its operator. */
const boundColumn = (inner: string, c: ProbeColumn): Expr => ({
	kind: "binary",
	op: "=",
	left: { kind: "column", table: inner, column: c.column },
	right: c.value,
	schema: c.schema
})

/** A met row's column bound to a stored one: `"<inner>"."<column>" = "<rows>"."<from>"`, at its operator. */
const metBound = (inner: string, k: MetKey, rows: string): Expr => ({
	kind: "binary",
	op: "=",
	left: { kind: "column", table: inner, column: k.column },
	right: { kind: "column", table: rows, column: k.from },
	schema: k.schema
})

/** What follows a probe's WHERE: a key's LIMIT 1, a group's ORDER BY over its order columns, a group's last row's
 * ORDER BY them descending and LIMIT 1. */
const probeTail = (inner: string, by: ProbeBy): string => {
	const order = (direction: string) =>
		by.kind === "key"
			? ""
			: `ORDER BY ${by.order.map((c) => `${quoteIdent(inner)}.${quoteIdent(c)}${direction}`).join(", ")}`
	switch (by.kind) {
		case "key":
			return "LIMIT 1"
		case "group":
			return order("")
		case "last":
			return `${order(" DESC")} LIMIT 1`
	}
}

/**
 * A stored table's rows a driving row reaches (sql/ast.ts FromSource `probe` and `met`): `LATERAL (SELECT
 * "<inner>"."<column>", ... FROM <table> AS "<inner>" WHERE <conditions> <tail>) AS "<alias>"("<column>", ...)`.
 * The conditions, its key's bindings and then its filter, are one conjunction the printer parenthesizes by precedence,
 * so a condition that binds more loosely than AND, a selection's guard `φ OR ψ` among them, narrows the key's rows
 * whole and never reaches a row at another key.
 */
const printDriven = (
	table: ObjectName,
	inner: string,
	columns: NonEmptyReadonlyArray<DrivenColumn>,
	alias: string,
	conditions: ReadonlyArray<Expr>,
	tail: string
): string => {
	const read = columns.map((c) => `${quoteIdent(inner)}.${quoteIdent(c.read)}`).join(", ")
	const where = conjunction(conditions)
	return `LATERAL (SELECT ${read} FROM ${printObjectName(table)} AS ${quoteIdent(inner)} ${where === undefined ? "" : `WHERE ${printExpr(where)} `}${tail}) AS ${quoteIdent(alias)}(${printIdentList(mapNonEmpty(columns, (c) => c.as))})`
}

const printFrom = (items: ReadonlyArray<FromItem>): string => items.map(printFromItem).join(", ")

const printValuesRows = (rows: ReadonlyArray<ReadonlyArray<Expr>>): string =>
	`VALUES ${rows.map((row) => `(${row.map((e) => printExpr(e)).join(", ")})`).join(", ")}`

/**
 * Whether an expression holds a node of `kinds` anywhere in it, its nested queries' among them.
 */
const holds = (e: Expr, kinds: ReadonlySet<Expr["kind"]>): boolean => {
	let found = false
	new Transform({
		...identityHooks,
		expr: (x) => {
			found ||= kinds.has(x.kind)
			return x
		}
	}).expr(e)
	return found
}

/**
 * The expressions that call a function or read a query: a call, an aggregate's or a window's among them, or a subquery,
 * EXISTS, IN or ARRAY of one. Every other expression PostgreSQL computes from its row alone, and leaves uncomputed
 * where nothing reads it.
 */
const computing: ReadonlySet<Expr["kind"]> = new Set([
	"call",
	"subquery",
	"exists",
	"inQuery",
	"array"
])

/** A placeholder: a statement's text binds each where it stands, and PostgreSQL types each by where it is read. */
const binding: ReadonlySet<Expr["kind"]> = new Set(["param"])

/**
 * The core a pass-through projection reads, with the columns it picks, where `core` is one; undefined where it is not.
 * A pass-through projection is a core of no WHERE, GROUP BY, HAVING or DISTINCT ON whose FROM is one derived table
 * that names its columns, every target a column of it, over a query that is one core of no DISTINCT, GROUP BY or HAVING
 * and no WITH, ORDER BY, LIMIT or OFFSET: it renames and picks the inner core's columns, which PostgreSQL pulls up
 * (prepjointree.c pull_up_simple_subquery) at the cost of a range table entry, its targets' translation and their plan
 * memory at every level. It prints as the inner core, its FROM, WHERE and targets, each target the inner target its
 * column names under the outer target's alias, and the outer's DISTINCT. The rows are the same:
 *
 * - every inner target the outer reads twice is a column or a literal, so reading it twice is reading it once;
 * - an inner target the outer leaves out is never computed: where no inner target calls a function or reads a query,
 *   PostgreSQL pulls the inner core up and leaves it uncomputed as well, and one that binds a placeholder stays, so the
 *   statement reads each of its placeholders where it read them, which types them, in the order it read them; where one does, an aggregate, a
 *   window or a set-returning or volatile call among them, which keep PostgreSQL from pulling the core up, only a column
 *   or a literal is left out, whose computing changes nothing, and every call stays, so an aggregate's one row and a
 *   set-returning call's rows stay as they were.
 */
const passedThrough = (core: SelectCore, named: boolean): SelectCore | undefined => {
	const [source, ...more] = core.from
	if (
		source?.kind !== "derived" ||
		more.length > 0 ||
		core.where !== undefined ||
		core.groupBy.length > 0 ||
		core.having !== undefined ||
		typeof core.distinct === "object"
	) {
		return undefined
	}
	const inner = source.query
	const body = inner.body
	if (
		inner.with !== undefined ||
		inner.orderBy.length > 0 ||
		inner.limit !== undefined ||
		inner.offset !== undefined ||
		body.kind !== "core" ||
		body.distinct !== false ||
		body.groupBy.length > 0 ||
		body.having !== undefined ||
		body.targets.length !== source.columns.length
	) {
		return undefined
	}
	const picked = core.targets.flatMap((t) => {
		if (t.expr.kind !== "column" || t.expr.table !== source.alias) {
			return []
		}
		const at = source.columns.indexOf(t.expr.column)
		const read = body.targets[at]
		const kept = read?.expr.kind === "column" && read.expr.column === t.expr.column
		return read === undefined
			? []
			: [{ at, expr: read.expr, alias: t.alias ?? (named && !kept ? t.expr.column : undefined) }]
	})
	const anyComputing = body.targets.some((t) => holds(t.expr, computing))
	const admitted = body.targets.every((t, i) => {
		const reads = picked.filter((p) => p.at === i).length
		const plain = t.expr.kind === "column" || t.expr.kind === "literal"
		return reads === 1 || plain || (reads === 0 && !anyComputing && !holds(t.expr, binding))
	})
	const bound = picked.filter((p) => holds(p.expr, binding)).map((p) => p.at)
	if (
		picked.length !== core.targets.length ||
		!admitted ||
		bound.some((at, i) => i > 0 && at <= (bound[i - 1] ?? at))
	) {
		return undefined
	}
	const targets = picked.map((p) => ({ expr: p.expr, alias: p.alias }))
	const frame = {
		kind: "core",
		from: body.from,
		where: body.where,
		groupBy: body.groupBy,
		having: body.having
	} as const
	if (!core.distinct) {
		return { ...frame, distinct: false, rows: core.rows, targets }
	}
	const [first, ...rest] = targets
	return first === undefined ? undefined : { ...frame, distinct: true, targets: [first, ...rest] }
}

/**
 * `core` with every pass-through projection it begins with folded into the core it reads (`passedThrough`), each target
 * under the name it delivered where its reader reads its rows by name (`named`): a statement's rows, a view's, a CTE's
 * or a derived table's that names no columns, a loop's record; one that names its columns, or a test of rows, reads
 * them by place.
 */
const foldedCore = (core: SelectCore, named: boolean): SelectCore => {
	const folded = passedThrough(core, named)
	return folded === undefined ? core : foldedCore(folded, named)
}

/**
 * How a core's reader reads its rows: through its query's ORDER BY, which names the core's own FROM, so the core prints
 * as written; by its columns' names; or by their places alone.
 */
type CoreReader = "ordered" | "named" | "placed"

/**
 * A core's clauses, its leading keyword `keyword`, as its reader reads it (`CoreReader`): a core whose query orders it
 * prints as written, since its ORDER BY reads the core's own FROM by name, which a fold would take away; every other
 * folds (`foldedCore`).
 */
const coreClauses = (
	out: Lines,
	given: SelectCore,
	keyword: "SELECT" | "PERFORM",
	reader: CoreReader
): void => {
	const core = reader === "ordered" ? given : foldedCore(given, reader === "named")
	const head =
		core.distinct === false
			? keyword
			: core.distinct === true
				? `${keyword} DISTINCT`
				: `${keyword} DISTINCT ON (${core.distinct.on.map((e) => clauseItem(e).text).join(", ")})`
	out.line(isNonEmpty(core.targets) ? `${head} ${printTargets(core.targets)}` : head)
	if (core.from.length > 0) {
		out.line(`FROM ${printFrom(core.from)}`)
	}
	if (core.where !== undefined) {
		out.line(`WHERE ${printExpr(core.where)}`)
	}
	if (core.groupBy.length > 0) {
		out.line(`GROUP BY ${core.groupBy.map((e) => clauseItem(e).text).join(", ")}`)
	}
	if (core.having !== undefined) {
		out.line(`HAVING ${printExpr(core.having)}`)
	}
}

/** The clauses that follow a query body, which a SELECT and a PERFORM both carry, and the body they order. */
type Tail = Pick<OperandSelect, "body" | "orderBy" | "limit" | "offset">

/**
 * The DISTINCT ON items a query's ORDER BY must begin with (analyze.c transformDistinctOnClause): its core's, or its
 * parenthesized body's, whose clauses PostgreSQL merges with those that follow it; a set operation has none.
 */
const distinctOnOf = (body: OperandBody): ReadonlyArray<Expr> => {
	switch (body.kind) {
		case "core":
			return typeof body.distinct === "object" ? body.distinct.on : []
		case "select":
			return distinctOnOf(body.body)
		case "setOp":
			return []
	}
}

/**
 * A query's ORDER BY items. A constant orders nothing, and PostgreSQL refuses even a typed one over a set operation and
 * under a SELECT DISTINCT whose targets lack it (analyze.c transformSetOperationStatement, parse_clause.c
 * transformDistinctClause), so it is left out; but one a DISTINCT ON names prints typed, as that item does, since
 * ORDER BY must begin with DISTINCT ON's items.
 */
const queryOrder = (tail: Tail): ReadonlyArray<string> => {
	const named = new Set(distinctOnOf(tail.body).map((e) => clauseItem(e).text))
	return tail.orderBy.flatMap((item) => {
		if (!isConstant(item.expr)) {
			return [printOrderItem(item)]
		}
		const text = clauseItem(item.expr).text
		return named.has(text) ? [directed(text, item.direction)] : []
	})
}

const tailClauses = (out: Lines, tail: Tail): void => {
	const order = queryOrder(tail)
	if (order.length > 0) {
		out.line(`ORDER BY ${order.join(", ")}`)
	}
	if (tail.limit !== undefined) {
		out.line(`LIMIT ${printExpr(tail.limit)}`)
	}
	if (tail.offset !== undefined) {
		out.line(`OFFSET ${printExpr(tail.offset)}`)
	}
}

/**
 * A full query used as a body always prints parenthesized, so its own WITH and tail clauses never run into the
 * enclosing query's. PostgreSQL still merges a parenthesized query's clauses with those that follow it, so the
 * lowerings build a query body with clauses at one of the two levels only, as the kernel's structural audit checks
 * (test/support/oracle/verify/sql.ts).
 */
const nestedSelect = (select: OperandSelect, reader: "named" | "placed"): string =>
	`(${printSelectInline(select, reader)})`

/**
 * A query's body on one line, its core read as `reader` says (`coreClauses`); a set operation's arms by name, since the
 * first arm's names are the operation's, which its ORDER BY reads.
 */
const bodyInline = (body: OperandBody, reader: CoreReader): string => {
	switch (body.kind) {
		case "core":
			return inlineText((row) => coreClauses(row, body, "SELECT", reader))
		case "select":
			return nestedSelect(body, reader === "placed" ? "placed" : "named")
		case "setOp":
			return body.arms.map((arm) => bodyInline(arm, "named")).join(` ${body.op} `)
	}
}

/** A query's body as block lines, read as bodyInline's. */
const bodyBlock = (out: Lines, body: OperandBody, reader: CoreReader): void => {
	switch (body.kind) {
		case "core":
			return coreClauses(out, body, "SELECT", reader)
		case "select":
			return out.line(nestedSelect(body, reader === "placed" ? "placed" : "named"))
		case "setOp":
			for (const [i, arm] of body.arms.entries()) {
				if (i > 0) {
					out.line(body.op)
				}
				bodyBlock(out, arm, "named")
			}
	}
}

/** The reader of a query's body core: its ORDER BY where it orders, else `rest`. */
const bodyReader = (select: Pick<OperandSelect, "orderBy">, rest: "named" | "placed"): CoreReader =>
	select.orderBy.length > 0 ? "ordered" : rest

const withInline = (w: With): string => {
	const ctes = w.ctes
		.map(
			(cte) =>
				`${cteHead(cte)} (${cteBodyInline(cte.query, cte.columns.length > 0 ? "placed" : "named")})`
		)
		.join(", ")
	return `WITH ${w.recursive ? "RECURSIVE " : ""}${ctes}`
}

const cteHead = (cte: Cte): string => {
	const materialized = cte.materialized === undefined ? "" : ` ${cte.materialized}`
	return `${quoteIdent(cte.name)}${aliasList(cte.columns)} AS${materialized}`
}

/** A data-modifying body keeps its own WITH, which PostgreSQL accepts inside the CTE's parentheses. */
const cteBodyInline = (query: CteBody, reader: "named" | "placed"): string =>
	query.kind === "select"
		? printSelectInline(query, reader)
		: inlineText((out) => {
				if (query.with !== undefined) {
					out.line(withInline(query.with))
				}
				dmlBlock(out, query)
			})

/**
 * A CTE body as block lines: a query on one line, a data-modifying statement clause by clause,
 * its own WITH first.
 */
const cteBodyBlock = (out: Lines, query: CteBody, reader: "named" | "placed"): void =>
	query.kind === "select"
		? out.line(printSelectInline(query, reader))
		: dmlStatementBlock(out, query)

/** A CTE as its WITH block writes it: `open` and its head on its first line, its body a level deeper, and its closing
 * parenthesis and `close` on its last. */
const cteBlock = (out: Lines, cte: Cte, open: string, close: string): void => {
	out.line(`${open}${cteHead(cte)} (`)
	cteBodyBlock(out.nested(), cte.query, cte.columns.length > 0 ? "placed" : "named")
	out.line(`)${close}`)
}

const withBlock = (out: Lines, w: With): void => {
	for (const [i, cte] of w.ctes.entries()) {
		cteBlock(
			out,
			cte,
			i === 0 ? `WITH ${w.recursive ? "RECURSIVE " : ""}` : "",
			i === w.ctes.length - 1 ? "" : ","
		)
	}
}

/**
 * A CTE's text as a statement's top-level WITH block holds it, between that block's `WITH ` or `,` and newline before
 * it and its `,` and newline or its last newline after it (withBlock), so a single statement's units assemble into its
 * text byte for byte (runtime/write/parted.ts assembled).
 */
export const printCteBlock = (cte: Cte): string =>
	sqlText(statementTextLoc, (out) => cteBlock(out, cte, "", ""))

/** A set operation's arm as a statement's top-level body block holds it, between the blocks' `UNION ALL` lines
 * (bodyBlock). */
export const printArmBlock = (core: SelectCore): string =>
	sqlText(statementTextLoc, (out) => coreClauses(out, core, "SELECT", "named"))

/** A query on one line, its rows read by name, or by place where `reader` says so (`CoreReader`). */
const printSelectInline = (select: OperandSelect, reader: "named" | "placed"): string =>
	inlineText((out) => {
		if (select.with !== undefined) {
			out.line(withInline(select.with))
		}
		out.line(bodyInline(select.body, bodyReader(select, reader)))
		tailClauses(out, select)
	})

const selectBlock = (out: Lines, select: OperandSelect): void => {
	if (select.with !== undefined) {
		withBlock(out, select.with)
	}
	bodyBlock(out, select.body, bodyReader(select, "named"))
	tailClauses(out, select)
}

const printAssignments = (
	set: ReadonlyArray<{ readonly column: string; readonly value: Expr }>
): string => set.map((a) => `${quoteIdent(a.column)} = ${printExpr(a.value)}`).join(", ")

const returningLine = (out: Lines, returning: ReadonlyArray<Target>): void => {
	if (returning.length > 0) {
		out.line(`RETURNING ${printTargets(returning)}`)
	}
}

const conflictWhere = (out: Lines, where: Expr | undefined): void => {
	if (where !== undefined) {
		out.line(`WHERE ${printExpr(where)}`)
	}
}

const conflictLines = (out: Lines, conflict: OnConflict): void => {
	if (conflict.kind === "constraint") {
		return out.line(`ON CONFLICT ON CONSTRAINT ${quoteIdent(conflict.constraint)} DO NOTHING`)
	}
	if (conflict.kind === "every") {
		return out.line("ON CONFLICT DO NOTHING")
	}
	const action = conflict.action
	const head = `ON CONFLICT (${printIdentList(conflict.columns)})`
	switch (action.kind) {
		case "doNothing":
			return out.line(`${head} DO NOTHING`)
		case "doSelect":
			out.line(`${head} DO SELECT`)
			return conflictWhere(out.nested(), action.where)
		case "doUpdate":
			out.line(`${head} DO UPDATE SET ${printAssignments(action.set)}`)
			return conflictWhere(out.nested(), action.where)
	}
}

const insertBlock = (out: Lines, insert: Insert): void => {
	const alias = insert.alias === undefined ? "" : ` AS ${quoteIdent(insert.alias)}`
	const columns = isNonEmpty(insert.columns) ? ` (${printIdentList(insert.columns)})` : ""
	out.line(`INSERT INTO ${printTableName(insert.table)}${alias}${columns}`)
	out.line(
		insert.source.kind === "query"
			? printSelectInline(insert.source.query, "placed")
			: printValuesRows(insert.source.rows)
	)
	if (insert.onConflict !== undefined) {
		conflictLines(out, insert.onConflict)
	}
	returningLine(out, insert.returning)
}

const updateBlock = (out: Lines, update: Update): void => {
	out.line(`UPDATE ${printObjectName(update.table)} AS ${quoteIdent(update.alias)}`)
	out.line(`SET ${printAssignments(update.set)}`)
	if (update.from.length > 0) {
		out.line(`FROM ${printFrom(update.from)}`)
	}
	if (update.where !== undefined) {
		out.line(`WHERE ${printExpr(update.where)}`)
	}
	returningLine(out, update.returning)
}

const deleteBlock = (out: Lines, del: Delete): void => {
	out.line(`DELETE FROM ${printTableName(del.table)} AS ${quoteIdent(del.alias)}`)
	if (del.using.length > 0) {
		out.line(`USING ${printFrom(del.using)}`)
	}
	if (del.where !== undefined) {
		out.line(`WHERE ${printExpr(del.where)}`)
	}
	returningLine(out, del.returning)
}

const mergeActionText = (action: MergeWhen["action"]): string => {
	switch (action.kind) {
		case "update":
			return `UPDATE SET ${printAssignments(action.set)}`
		case "insert": {
			const columns = printIdentList(action.row.map((a) => a.column))
			const values = action.row.map((a) => printExpr(a.value)).join(", ")
			return `INSERT (${columns}) VALUES (${values})`
		}
		case "insertDefault":
			return "INSERT DEFAULT VALUES"
		case "delete":
			return "DELETE"
		case "doNothing":
			return "DO NOTHING"
	}
}

const mergeWhenLine = (when: MergeWhen): string => {
	const condition = when.condition === undefined ? "" : ` AND ${printExpr(when.condition)}`
	return `WHEN ${when.match}${condition} THEN ${mergeActionText(when.action)}`
}

const mergeBlock = (out: Lines, merge: Merge): void => {
	out.line(`MERGE INTO ${printObjectName(merge.table)} AS ${quoteIdent(merge.alias)}`)
	out.line(`USING ${printFromItem(merge.using)} ON ${printExpr(merge.on)}`)
	for (const when of merge.whens) {
		out.line(mergeWhenLine(when))
	}
	returningLine(out, merge.returning)
}

/** A DML statement's clauses, without its WITH. */
const dmlBlock = (out: Lines, statement: Insert | Update | Delete | Merge): void => {
	switch (statement.kind) {
		case "insert":
			return insertBlock(out, statement)
		case "update":
			return updateBlock(out, statement)
		case "delete":
			return deleteBlock(out, statement)
		case "merge":
			return mergeBlock(out, statement)
	}
}

const dmlStatementBlock = (out: Lines, statement: Insert | Update | Delete | Merge): void => {
	if (statement.with !== undefined) {
		withBlock(out, statement.with)
	}
	dmlBlock(out, statement)
}

/** Elements one per line under their head, each but the last ending in a comma. */
const listed = (out: Lines, items: ReadonlyArray<string>): void => {
	for (const [i, item] of items.entries()) {
		out.line(i === items.length - 1 ? item : `${item},`)
	}
}

/** A column's generation. STORED is always written: PostgreSQL's default is VIRTUAL, which no key or reference can
 * name. */
const printGeneration = (g: StoredGeneration): string =>
	`GENERATED ALWAYS AS (${printStoredGeneration(g)}) STORED`

/** A STORED generation's expression, as GENERATED ALWAYS AS and SET EXPRESSION AS write it. */
const printStoredGeneration = (g: StoredGeneration): string => {
	switch (g.kind) {
		case "stored":
			return printExpr(g.expr)
		case "partial":
			return `CASE WHEN ${printExpr(g.when)} THEN ${printExpr(g.expr)} END`
	}
}

/** A column up to its NOT NULL: its name, type, collation and generation. */
/**
 * A session table's column: its name, its type and its collation, and no constraint: what it holds is copied from
 * columns that hold their own.
 */
const definitionText = (column: ColumnDefinition): string =>
	[
		quoteIdent(column.name),
		printType(column.type),
		...(column.collation === undefined ? [] : [`COLLATE ${printObjectName(column.collation)}`])
	].join(" ")

/**
 * A session table's column as its storage declares it (SessionTableStorage): an inline table's STORAGE PLAIN, which
 * PostgreSQL's grammar takes after the type and before COLLATE (REL_19_0 src/backend/parser/gram.y 3894 columnDef), a
 * toasted one's as the type's default storage declares it.
 */
const sessionColumnText = (column: ColumnDefinition, storage: SessionTableStorage): string => {
	switch (storage) {
		case "inline":
			return [
				quoteIdent(column.name),
				printType(column.type),
				"STORAGE PLAIN",
				...(column.collation === undefined ? [] : [`COLLATE ${printObjectName(column.collation)}`])
			].join(" ")
		case "toasted":
			return definitionText(column)
	}
}

/** A session table's CREATE (PlStatement createSessionTable): the statement that stands up a judge's delta or sentinel,
 * as a test that stands one up before the judge runs spells it too, or a write program's carrier. */
const sessionTableCreate = (
	table: Extract<PlStatement, { readonly kind: "createSessionTable" }>
): string => {
	const columns = table.columns.map((c) =>
		table.notNull
			? `${sessionColumnText(c, table.storage)} NOT NULL`
			: sessionColumnText(c, table.storage)
	)
	const key =
		table.primaryKey === undefined
			? []
			: [
					`PRIMARY KEY (${table.primaryKey.map((c) => quoteIdent(c)).join(", ")}) DEFERRABLE INITIALLY IMMEDIATE`
				]
	return `CREATE TEMPORARY TABLE ${sessionTableName(table.name)} (${[...columns, ...key].join(", ")}) ON COMMIT PRESERVE ROWS`
}

/** The session's own table `name`, qualified by its temporary schema. */
const sessionTableName = (name: string): string =>
	printObjectName({ schema: temporarySchema, name })

/** `name`'s relation in the session's own temporary schema, or NULL where it holds none. */
const sessionRegclass = (name: string): Expr =>
	builtinCall("to_regclass", [lit.text(sessionTableName(name), types.text)])

/**
 * That the relation of pg_class under `alias` is a temporary table CURRENT_USER owns: inside a SECURITY DEFINER function
 * its definer, in a DO block the role its transaction runs as.
 */
const ownedSessionTable = (alias: string): NonEmptyReadonlyArray<Expr> => [
	eq(builtinCall("pg_get_userbyid", [col(alias, "relowner")]), {
		kind: "user",
		name: "CURRENT_USER"
	}),
	eq(col(alias, "relpersistence"), lit.text("t", types.text))
]

/**
 * Which of the session's tables `names` stand: each as its name where it is a temporary table CURRENT_USER owns
 * (`ownedSessionTable`), and as `!` and its name where it stands otherwise, a table some other role made under it, all
 * of them read by one statement over pg_catalog.pg_class, so a site that stands up several session tables plans one
 * read of the catalog and no other (physical/ddl/rules.ts standing):
 *
 *   ARRAY(SELECT CASE WHEN <owned r1> THEN r1.relname::text ELSE '!' || r1.relname::text END
 *     FROM pg_catalog.pg_class AS r1 WHERE r1.oid IN (pg_catalog.to_regclass('"pg_temp"."<name>"'), ...))
 */
export const sessionTablesStanding = (names: NonEmptyReadonlyArray<string>): Expr => {
	const name = cast(col("r1", "relname"), types.text)
	return {
		kind: "array",
		query: selectOf(
			provedCore(
				"keyed",
				[
					{
						expr: {
							kind: "case",
							operand: undefined,
							whens: [{ when: and(ownedSessionTable("r1")), result: name }],
							else: {
								kind: "binary",
								op: "||",
								left: lit.text(stoodApart, types.text),
								right: name,
								schema: undefined
							}
						},
						alias: undefined
					}
				],
				[{ kind: "table", table: objectName("pg_catalog", "pg_class"), alias: "r1" }],
				isIn(col("r1", "oid"), mapNonEmpty(names, sessionRegclass))
			)
		)
	}
}

/** The mark a session table's name takes in `sessionTablesStanding` where some other role made it. */
export const stoodApart = "!"

/**
 * The most pages a session table's heap, and its TOAST table's heap, hold that its emptying keeps rather than gives back
 * by a TRUNCATE (`sessionTableEmptied`, sessionTableKeptBytes): the point past which the dead pages a statement reads
 * cost more than the TRUNCATE that would give them back.
 *
 * Why pages accumulate: every row a use inserts takes a line pointer of its page, which the emptying's DELETE leaves
 * dead, and pruning on access marks it dead, never unused, whether or not the table has an index
 * (src/backend/access/heap/pruneheap.c 358-363, heap_page_prune_opt's options), so only a VACUUM, which no session table
 * meets, would free it. A page holds MaxHeapTuplesPerPage line pointers, (BLCKSZ - SizeOfPageHeaderData) /
 * (MAXALIGN(SizeofHeapTupleHeader) + sizeof(ItemIdData)) = (8192 - 24) / (24 + 4) = 291 (src/include/access/htup_details.h
 * 769-771), and nothing writes a session table's free space map (autovacuum never processes another backend's temporary
 * table, src/backend/postmaster/autovacuum.c 2078, 2175), so an insert past the target page extends the table (hio.c
 * 577, 585, 769): a table its uses fill with n rows each grows a page in each 291 / n uses, without bound. Every read of
 * it walks those pages, a carrier's reader's (write/carriers/carriers.ts carrierReader) and a delta's reader's alike; a TRUNCATE gives them back
 * but costs the session its own TRUNCATE and the replan of each reader's one SELECT, and costs every other backend of the
 * database a walk of each plan it holds, at each of the three relcache invalidations (the table, its TOAST table and that
 * table's index, plancache.c PlanCacheRelCallback). Waiting until the dead pages' cost since the last TRUNCATE equals one
 * TRUNCATE's, as with any rent-or-buy choice, bounds the total at twice the best one could do knowing the future: a
 * table growing a page a use and read once a use has paid c · P² / 2 for P pages, which equals T at P = √(2T / c).
 *
 * @limitKind measured
 * @owner grizzle's session tables (sql/print.ts sessionTableEmptied), under PostgreSQL 19's heap and plan cache
 * @unit pages of a session table's heap, and of its TOAST table's heap
 * @scope each session table, a write's carrier or a rule judge's delta, in one session, as a use's emptying finds it
 * @evidence ~/.cache/grizzle/PROLOGUE-tools/trunc (scan.sql with run-scan.sh, own.sql, and the two-backend run that
 *   times a 5,000-plan backend's next statement beside a truncating one), run by hand against postgres-ram@seriesplan
 * @observed 2026-11-23, 18:40 to 19:10 America/Chicago
 * @environment cassowary (64 cores, 247 GiB, shared by many lanes, load average 60 to 130), PostgreSQL 19.0 in a
 *   tmpfs cluster, temp_buffers 8 MB, grizzle at 8ab32a3bb
 * @workload a keyed carrier of an int8 key and a short text, filled 16 rows a use and emptied by DELETE until its heap
 *   held 1, 8, 64, 256, 1,024 and 4,096 pages, then read 200 times through its reader (SETOF, ROWS 1); 600 rows a use
 *   emptied by TRUNCATE against DELETE, 60 uses each, statement by statement; a second backend holding 5,000 prepared
 *   statements timing a SELECT 1 every 250 ms, 40 times, beside a session truncating its carrier every 250 ms, and alone
 * @result a read through the reader: 0.010 ms at 1 page, 0.026 at 8, 0.030 at 64, 0.099 at 256, 0.43 at 1,024
 *   (0.42 µs a page) and 14.8 at 4,096, past temp_buffers' 1,024 pages, 3.6 µs a page. The emptying: TRUNCATE 0.76 ms
 *   against DELETE 0.30, and the reader's first read after it 0.31 against 0.27. The 5,000-plan backend's next
 *   statement: 1.71 ms beside the truncating session against 0.11 alone (1.6 ms a TRUNCATE, 0.32 µs a plan held). Not
 *   measured: backends of more plans, which pay in proportion, and toasted rows' reads.
 * @decision T, one TRUNCATE beside one other backend of 5,000 plans, is 0.46 + 1.6 ≈ 2.1 ms, and c is 0.42 µs a page,
 *   so P = √(2 · 2.1 ms / 0.42 µs) = 100 pages: 800 KB a table, within temp_buffers for ten tables at once, where the
 *   cost of a page rises ninefold. A deployment of more backends or more plans each makes T, and so P, larger (√ of it);
 *   one page, the former point, truncated a table filled past it at every use and sent three invalidations a call.
 * @revalidate a PostgreSQL upgrade; a temp_buffers other than 8 MB; sessions holding far more than 5,000 plans each
 *   or far more backends, which raise T; a session table read other than whole or many times a use
 */
const sessionTableKeptPages = 100

/** The bytes of sessionTableKeptPages, as pg_relation_size counts a table's file (`sessionTableOvergrown`). */
export const sessionTableKeptBytes = sessionTableKeptPages * blockSize

/**
 * That the session's table `name` holds more than the pages its emptying keeps (sessionTableKeptBytes) in its heap or in
 * its TOAST table's heap, each as the size of its file, which pg_relation_size reads by a stat and no page: a table with no
 * TOAST table has a reltoastrelid of 0, whose size it answers NULL, so its heap alone decides.
 *
 *   EXISTS (SELECT FROM pg_catalog.pg_class AS r1 WHERE r1.oid = pg_catalog.to_regclass('"pg_temp"."<name>"')
 *     AND (pg_catalog.pg_relation_size(r1.oid) > 819200 OR pg_catalog.pg_relation_size(r1.reltoastrelid) > 819200))
 */
const sessionTableOvergrown = (name: string): Expr => {
	const kept = lit.int(sessionTableKeptBytes, types.bigint)
	return exists(
		simpleSelect(
			[],
			[{ kind: "table", table: objectName("pg_catalog", "pg_class"), alias: "r1" }],
			and([
				eq(col("r1", "oid"), sessionRegclass(name)),
				or([
					gt(builtinCall("pg_relation_size", [col("r1", "oid")]), kept),
					gt(builtinCall("pg_relation_size", [col("r1", "reltoastrelid")]), kept)
				])
			])
		)
	)
}

/**
 * The session's table `name` emptied of its rows, a rule judge's delta once its part has read them (physical/ddl/rules.ts
 * emptied) or a write's carrier before its use fills it (`carrierEmptying`): by DELETE while its heap and its TOAST
 * table's each hold the pages it keeps at most (sessionTableKeptPages), and by TRUNCATE once either holds more.
 *
 *   IF <it holds more than it keeps (sessionTableOvergrown)> THEN TRUNCATE pg_temp.<name>;
 *   ELSE DELETE FROM pg_temp.<name> AS r1; END IF;
 *
 * A DELETE keeps the table's file, so it sends no invalidation: a TRUNCATE of a table made in an earlier transaction
 * gives it, its TOAST table and that table's index each a new file (src/backend/commands/tablecmds.c 2245-2272
 * RelationSetNewRelfilenumber), a pg_class row updated for each, and the relcache invalidations of each reach every
 * backend of the database (src/backend/utils/cache/inval.c 88-95: a session's own table's among them), each of which
 * then walks every plan it holds (src/backend/utils/cache/plancache.c 2131 PlanCacheRelCallback). A session of 30,000
 * saved plans paid 86 ms of a commit that truncated five deltas, and an idle one beside it 44 ms more (SESSIONTEMP,
 * 2026-11-21), where a DELETE cost 1 ms and the other session nothing. The rows the DELETE leaves dead take their
 * page's space until a read prunes it, and their line pointers stay, so a table refilled use after use outgrows the
 * pages it keeps, and the use that finds it so truncates it: the TRUNCATE is paid once in each sessionTableKeptPages
 * pages' worth of rows, never at each use, and the statements that read the table through its reader keep their plans
 * across it (write/carriers/carriers.ts carrierReader; physical/ddl/deltas.ts addReaders). Every row is gone either way: a later transaction sees none, and one that rolls back takes its rows and
 * their emptying with it, so each use starts on an empty table.
 */
export const sessionTableEmptied = (name: string): PlStatement => ({
	kind: "if",
	branches: [
		{ condition: sessionTableOvergrown(name), body: [{ kind: "truncateSessionTable", name }] }
	],
	else: [
		{
			kind: "modify",
			statement: {
				kind: "delete",
				with: undefined,
				table: objectName(temporarySchema, name),
				alias: "r1",
				using: [],
				where: undefined,
				returning: []
			}
		}
	]
})

/**
/**
 * The most changed rows autovacuum_analyze_threshold admits, reloptions.c's maximum, which a table's declared
 * statistics set as its storage parameter beside autovacuumAnalyzeScaleMax: autovacuum then analyzes the table only past
 * 2^31 − 1 changed rows beside 100 times its rows, never in practice. PostgreSQL has no switch that stops automatic
 * ANALYZE alone. An ANALYZE of a table whose every column is declared leaves every column's statistics as declared, but
 * samples analyze.c's least sample, a hundred rows from a hundred of its blocks, and rewrites the table's size in pg_class
 * from them (vacuum.c vac_update_relstats), whose invalidation makes every session plan each statement over the table
 * again (plancache.c PlanCacheRelCallback): over a table whose live rows sit among pages of dead ones it can count none,
 * and every estimate of the table is then one row (measured, test/support/substrate/fill.ts countedAsVacuumed). VACUUM,
 * automatic or not, counts the table whole and keeps the size current; an operator's ANALYZE, a vacuumdb
 * --analyze-in-stages after an upgrade or a provider's maintenance is the hazard the plan-shape law's state after ANALYZE
 * holds every plan against (test/pg/physical/plan-shape.test.ts).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's storage parameters (reloptions.c intRelOpts)
 * @unit changed rows
 * @scope one table's autovacuum_analyze_threshold, where its declared statistics set it
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/access/common/reloptions.c#L282
 * @quote -1, 0, INT_MAX
 * @verified 2026-11-23
 */
export const autovacuumAnalyzeThresholdMax = 2 ** 31 - 1

/**
 * The largest fraction of a table's rows autovacuum_analyze_scale_factor admits, reloptions.c's maximum, which a table's
 * declared statistics set beside autovacuumAnalyzeThresholdMax (see it).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's storage parameters (reloptions.c realRelOpts)
 * @unit tables' rows
 * @scope one table's autovacuum_analyze_scale_factor, where its declared statistics set it
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/access/common/reloptions.c#L457
 * @quote -1, 0.0, 100.0
 * @verified 2026-11-23
 */
export const autovacuumAnalyzeScaleMax = 100.0

/**
 * The exact decimal spelling of a declared number of distinct values (sql/ast.ts DeclaredDistinct): 2^exponent, or
 * -1/2^exponent, whose decimal expansion is exactly 5^exponent shifted right by `exponent` places, so the float4 it is
 * cast to holds it exactly.
 */
const distinctValue = (d: DeclaredDistinct): string => {
	const e = BigInt(d.exponent)
	if (d.kind === "absolute") {
		return (2n ** e).toString()
	}
	if (e === 0n) {
		return "-1"
	}
	const digits = (5n ** e).toString().padStart(d.exponent, "0")
	return `-0.${digits}`
}

/**
 * A table's declared statistics as the DO block that installs them (declaredStatisticsSteps), its schema named by its
 * literal.
 */
const declaredStatisticsBlock = (d: DeclareStatistics): PlBlock => ({
	declare: [],
	body: declaredStatisticsSteps(d, lit.text(d.table.schema, types.text))
})

/**
 * A table's declared statistics as the PL/pgSQL steps that restore them, `schema` the expression of its schema's name:
 * the table's own literal, or, for a session's temporary table a definer's function makes, the name of the session's
 * temporary schema (pg_catalog.pg_my_temp_schema()). For each column, PERFORM pg_catalog.pg_clear_attribute_stats, so no
 * statistic an earlier ANALYZE sampled stands beside the declaration, then IF NOT
 * pg_catalog.pg_restore_attribute_stats(...) THEN RAISE: a restore answers false, with a WARNING, for an argument it
 * cannot use rather than failing (attribute_stats.c), so the steps fail instead, naming the table and column. A restore
 * needs the table's owner or MAINTAIN on it, which a definer holds over the temporary table it makes.
 */
export const declaredStatisticsSteps = (
	d: DeclareStatistics,
	schema: Expr
): NonEmptyReadonlyArray<PlStatement> => {
	const text = (v: string): Expr => lit.text(v, types.text)
	const [first, ...rest] = d.columns
	const steps = (c: (typeof d.columns)[number]): NonEmptyReadonlyArray<PlStatement> => [
		{
			kind: "perform",
			query: {
				body: operandCore(
					[
						{
							expr: qualifiedCall(
								{
									kind: "qualified",
									schema: "pg_catalog",
									name: "pg_clear_attribute_stats",
									volatility: "VOLATILE"
								},
								[schema, text(d.table.name), text(c.column), lit.bool(false)]
							),
							alias: undefined
						}
					],
					[],
					undefined
				),
				orderBy: [],
				limit: undefined,
				offset: undefined
			}
		},
		{
			kind: "if",
			branches: [
				{
					condition: not(
						qualifiedCall(
							{
								kind: "qualified",
								schema: "pg_catalog",
								name: "pg_restore_attribute_stats",
								volatility: "VOLATILE"
							},
							[
								text("schemaname"),
								schema,
								text("relname"),
								text(d.table.name),
								text("attname"),
								text(c.column),
								text("inherited"),
								lit.bool(false),
								text("n_distinct"),
								{
									kind: "cast",
									expr: lit.text(distinctValue(c.distinct), types.text),
									type: types.real
								}
							]
						)
					),
					body: [
						{
							kind: "raise",
							message: "a declared statistic was not restored",
							using: [
								{ option: "ERRCODE", value: text("internal_error") },
								{ option: "SCHEMA", value: schema },
								{ option: "TABLE", value: text(d.table.name) },
								{ option: "COLUMN", value: text(c.column) }
							]
						}
					]
				}
			],
			else: []
		}
	]
	return extendNonEmpty(steps(first), [
		...rest.flatMap(steps),
		...d.dependencies.flatMap((dependency) => dependencySteps(d.table, schema, dependency))
	])
}

/**
 * The number pg_attribute holds of `column` of `table`, its schema `schema`'s name: a declared dependency's attribute,
 * which a statistics value names by its column's number, read where the steps run.
 */
const attributeOf = (table: ObjectName, schema: Expr, column: string): Expr => ({
	kind: "subquery",
	query: {
		kind: "select",
		with: undefined,
		body: operandCore(
			[{ expr: col("a", "attnum"), alias: undefined }],
			[
				{ kind: "table", table: { schema: "pg_catalog", name: "pg_attribute" }, alias: "a" },
				{ kind: "table", table: { schema: "pg_catalog", name: "pg_class" }, alias: "c" },
				{ kind: "table", table: { schema: "pg_catalog", name: "pg_namespace" }, alias: "n" }
			],
			and([
				eq(col("a", "attrelid"), col("c", "oid")),
				eq(col("c", "relnamespace"), col("n", "oid")),
				eq(col("n", "nspname"), schema),
				eq(col("c", "relname"), lit.text(table.name, types.text)),
				eq(col("a", "attname"), lit.text(column, types.text))
			])
		),
		orderBy: [],
		limit: undefined,
		offset: undefined
	}
})

/** The exact decimal of 1/2^exponent, a declared dependency's degree. */
const degreeValue = (exponent: number): string =>
	exponent === 0 ? "1" : `0.${(5n ** BigInt(exponent)).toString().padStart(exponent, "0")}`

/**
 * A declared dependency's steps among its table's (declaredStatisticsSteps), its statistics object in the table's schema,
 * `schema`'s name: PERFORM pg_catalog.pg_clear_extended_stats, then IF NOT
 * pg_catalog.pg_restore_extended_stats(..., 'dependencies', <its one dependency, its attributes the columns' numbers>)
 * THEN RAISE: a restore answers false, with a WARNING, for a value it cannot use (extended_stats_funcs.c), so the block
 * fails instead, naming the table and the statistics object.
 */
const dependencySteps = (
	table: ObjectName,
	schema: Expr,
	d: DeclareStatistics["dependencies"][number]
): ReadonlyArray<PlStatement> => {
	const text = (v: string): Expr => lit.text(v, types.text)
	return [
		{
			kind: "perform",
			query: {
				body: operandCore(
					[
						{
							expr: qualifiedCall(
								{
									kind: "qualified",
									schema: "pg_catalog",
									name: "pg_clear_extended_stats",
									volatility: "VOLATILE"
								},
								[schema, text(table.name), schema, text(d.name.name), lit.bool(false)]
							),
							alias: undefined
						}
					],
					[],
					undefined
				),
				orderBy: [],
				limit: undefined,
				offset: undefined
			}
		},
		{
			kind: "if",
			branches: [
				{
					condition: not(
						qualifiedCall(
							{
								kind: "qualified",
								schema: "pg_catalog",
								name: "pg_restore_extended_stats",
								volatility: "VOLATILE"
							},
							[
								text("schemaname"),
								schema,
								text("relname"),
								text(table.name),
								text("statistics_schemaname"),
								schema,
								text("statistics_name"),
								text(d.name.name),
								text("inherited"),
								lit.bool(false),
								text("dependencies"),
								cast(
									qualifiedCall(
										{
											kind: "qualified",
											schema: "pg_catalog",
											name: "format",
											volatility: "STABLE"
										},
										[
											text(
												`[{"attributes": [%s], "dependency": %s, "degree": ${degreeValue(d.exponent)}}]`
											),
											attributeOf(table, schema, d.determinant),
											attributeOf(table, schema, d.dependent)
										]
									),
									types.dependencies
								)
							]
						)
					),
					body: [
						{
							kind: "raise",
							message: "a declared dependency was not restored",
							using: [
								{ option: "ERRCODE", value: text("internal_error") },
								{ option: "SCHEMA", value: schema },
								{ option: "TABLE", value: text(table.name) },
								{ option: "CONSTRAINT", value: text(d.name.name) }
							]
						}
					]
				}
			],
			else: []
		}
	]
}

/**
 * A write program's carrier as the session's stand-up makes it (sql/ast.ts CreateCarrier): a session table, ON COMMIT
 * PRESERVE ROWS, every column NOT NULL and its key its own, owned by the role whose stand-up made it, which alone may
 * empty it. Toasted, as a carrier's value may be one of no bound.
 */
const carrierTable = (carrier: CreateCarrier): string =>
	sessionTableCreate({
		kind: "createSessionTable",
		name: carrier.name,
		columns: carrier.columns.map((c) => ({ name: c.name, type: c.type, collation: c.collation })),
		notNull: true,
		primaryKey: carrier.primaryKey,
		storage: "toasted"
	})

/**
 * The rows a session table's reader declares it returns (ROWS on its CREATE FUNCTION), a rule judge's delta's
 * (physical/ddl/deltas.ts addReaders) and a write's carrier's (write/carriers/carriers.ts carrierReader): the planner's estimate of the rows a
 * statement reads first and probes each table's key from, one side of a transaction's delta or a call's carried rows,
 * one source for both, as both are read row by row into the tables a statement probes.
 *
 * @limitKind measured
 * @owner grizzle's judge emission (physical/ddl/deltas.ts addReaders), under PostgreSQL 19's planner
 * @unit rows of one side's delta
 * @scope each delta reader's estimate, in every generic plan of a judge statement that reads it
 * @evidence ~/.cache/grizzle/DECLSTATS-work/unitscale/run3.sh over setup.sql, its output unitscale3.log beside it (and
 *   run2.sh, unitscale2.log, for the per-unit form): two tables of one unit, keys holding the unit, statistics declared
 *   as grizzle declares them (the unit's anchor relative, its tail single-valued, targets 0), generic plans
 * @observed 2026-11-23, between 15:00 and 15:30 UTC
 * @environment cassowary (AWS arm64, 64 CPUs, 247 GiB), shared and loaded; PostgreSQL 19.0 in memory
 *   (postgres-ram@declstats) under default cost settings; grizzle at d76a6106
 * @workload EXPLAIN of a PREPAREd key-per-row judge (the delta's rows, NOT EXISTS the other table's row by its whole
 *   key) under force_generic_plan; the table filled with 0, 2^10, 2^14 and 2^20 rows and VACUUMed; the unit's anchor
 *   declared at 2^2 and 2^8 rows; the reader declaring ROWS 1, 10, 100 and 1000
 * @result 32 plans. ROWS 1 and ROWS 10: a Nested Loop Anti Join probing the key, an Index Cond on every key column, at
 *   every fill from 2^10 to 2^20. ROWS 100: a Hash Anti Join over a Seq Scan of the table at 2^10, probes from 2^14 on.
 *   ROWS 1000, PostgreSQL's default for a set-returning function: a Hash Anti Join over a Seq Scan at 2^10 and 2^14,
 *   probes only at 2^20. The unit's declared size changed no plan. A VACUUMed empty table is read by a Seq Scan at every
 *   ROWS. Not measured: run times, and estimates between 10 and 100. And a carrier read through its reader (lane
 *   PROLOGUE, 2026-11-23, the same cluster, grizzle at 8ab32a3bb with readers): at ROWS 1, test/pg/write/replace-cost's
 *   unit delete of a complete tree, which pairs the stored family's rows with the carrier's, planned the carrier as a
 *   nested loop's inner side, rescanned for every stored row, and read 13,500, 33,800 and 104,400 rows at 100, 200
 *   and 400 rows a family, more than doubling at each doubling; at ROWS 10 it hashed the carrier and read in proportion,
 *   and test/pg/write/carrier-keys still read every stored relation by its key's index at 1 and 4,096 keys.
 * @decision 1. A probe per delta row costs O(delta · log N) at any delta size, never worse than a hash of the table by
 *   more than a log factor, while a hash over a scan costs O(N) whatever the delta. Any larger declared delta only moves
 *   the crossover between the two to a table size the schema does not state (2^14 at 100, near 2^20 at 1000). 2. ROWS 1
 *   and ROWS 10 chose the probe alike at every size measured, and only ROWS 10 hashes a session table where it is the
 *   inner side of a join over many rows, rather than rescanning it for each, so 10 is the one estimate both take.
 * @revalidate a PostgreSQL upgrade or changed cost settings (random_page_cost, cpu_operator_cost,
 *   effective_cache_size); a judge statement that reads the delta other than key by key; a probe whose key the
 *   declared statistics estimate above one row; a statement that joins a session table as an inner side otherwise
 */
export const sessionReaderRows = 10

/**
 * A carrier's emptying (sql/ast.ts EmptyCarrier), the session function of the carrier's own name the session's stand-up
 * makes beside it, in pg_temp: the carrier emptied as every session table is (`sessionTableEmptied`), so a use's fills
 * meet no row of an earlier one. Its owner is the role that made the carrier, so as its definer it empties the
 * carrier only that role may truncate. PostgreSQL plans each statement of a PL/pgSQL function once in a session and keeps
 * the plan, where a DO block, compiled anew at every run, planned them at every call; a TRUNCATE of the carrier makes
 * its own DELETE's plan and every plan over the carrier again, once.
 *
 *   CREATE OR REPLACE FUNCTION "pg_temp"."<carrier>"() RETURNS void LANGUAGE plpgsql ... AS $$BEGIN
 *     IF <it holds more than its page> THEN TRUNCATE pg_temp.<carrier>; ELSE DELETE FROM pg_temp.<carrier> AS r1; END IF;
 *   END$$
 */
export const carrierEmptying = (name: CarrierName): PlFunction => ({
	kind: "createFunction",
	language: "plpgsql",
	name: objectName(temporarySchema, name),
	params: [],
	returns: "void",
	volatility: "VOLATILE",
	parallel: "UNSAFE",
	security: "DEFINER",
	body: { declare: [], body: [sessionTableEmptied(name)] }
})

const columnHead = (column: ColumnDef): string => {
	const parts = [quoteIdent(column.name), printType(column.type)]
	if (column.collation !== undefined) {
		parts.push(`COLLATE ${printObjectName(column.collation)}`)
	}
	if (column.generated !== undefined) {
		parts.push(printGeneration(column.generated))
	}
	return parts.join(" ")
}

/**
 * The text a drafted placeholder prints as: the token a reviewer replaces in a migration file, which the drafted
 * files' checks find (deploy/render/markers.ts).
 */
export const placeholderToken = "__GRIZZLE_PLACEHOLDER__"

/** A column with its nullity: NOT NULL, but a partial projection, which is NULL outside its selection. */
const printColumnDef = (column: ColumnDef): string =>
	column.generated?.kind === "partial" ? columnHead(column) : `${columnHead(column)} NOT NULL`

/** An ALTER COLUMN ... TYPE's USING: its conversion, or the placeholder a reviewer replaces. */
const printUsing = (using: Using): string => {
	switch (using.kind) {
		case "expr":
			return printExpr(using.expr)
		case "placeholder":
			return placeholderToken
	}
}
const printKeyColumns = (columns: ReadonlyArray<KeyColumn>): string =>
	columns
		.map((c) =>
			c.withoutOverlaps ? `${quoteIdent(c.column)} WITHOUT OVERLAPS` : quoteIdent(c.column)
		)
		.join(", ")

const printForeignKeyColumns = (columns: ReadonlyArray<ForeignKeyColumn>): string =>
	columns
		.map((c) => (c.period ? `PERIOD ${quoteIdent(c.column)}` : quoteIdent(c.column)))
		.join(", ")

const printConstraint = (constraint: TableConstraint): string => {
	const head = `CONSTRAINT ${quoteIdent(constraint.name)}`
	switch (constraint.kind) {
		case "primaryKey":
			return `${head} PRIMARY KEY (${printKeyColumns(constraint.columns)})`
		case "unique":
			return `${head} UNIQUE NULLS DISTINCT (${printKeyColumns(constraint.columns)})`
		case "foreignKey": {
			const onUpdate = constraint.onUpdate === undefined ? "" : ` ON UPDATE ${constraint.onUpdate}`
			const deferrable =
				constraint.deferrable === undefined ? "" : ` DEFERRABLE ${constraint.deferrable}`
			return `${head} FOREIGN KEY (${printForeignKeyColumns(constraint.columns)}) REFERENCES ${printObjectName(constraint.references)} (${printForeignKeyColumns(constraint.referencedColumns)}) MATCH SIMPLE${onUpdate}${deferrable}`
		}
		case "check":
			return `${head} ${printCheck(constraint.predicate)}`
		case "exclude":
			return `${head} EXCLUDE USING ${constraint.method} (${constraint.elements.map((e) => `${quoteIdent(e.column)} WITH ${e.operator}`).join(", ")})`
	}
}

const printAlterTableAction = (action: AlterTableAction): string => {
	switch (action.kind) {
		case "addColumn":
			return `ADD COLUMN ${printColumnDef(action.column)}`
		case "addColumnPlaceholder":
			return `ADD COLUMN ${columnHead(action.column)} DEFAULT ${placeholderToken} NOT NULL`
		case "addColumnDefault":
			return `ADD COLUMN ${columnHead(action.column)} DEFAULT ${printExpr(action.default)} NOT NULL`
		case "addColumnUnchecked":
			return `ADD COLUMN ${columnHead(action.column)}`
		case "setNotNull":
			return `ALTER COLUMN ${quoteIdent(action.column)} SET NOT NULL`
		case "dropColumn":
			return `DROP COLUMN ${quoteIdent(action.column)}`
		case "dropDefault":
			return `ALTER COLUMN ${quoteIdent(action.column)} DROP DEFAULT`
		case "alterColumnType":
			return `ALTER COLUMN ${quoteIdent(action.column)} TYPE ${printType(action.type)}${action.collation === undefined ? "" : ` COLLATE ${printObjectName(action.collation)}`} USING ${printUsing(action.using)}`
		case "addConstraint":
			return `ADD ${printConstraint(action.constraint)}${action.notValid ? " NOT VALID" : ""}`
		case "addConstraintUsingIndex":
			return `ADD CONSTRAINT ${quoteIdent(action.name)} ${action.constraint} USING INDEX ${quoteIdent(action.index)}`
		case "validateConstraint":
			return `VALIDATE CONSTRAINT ${quoteIdent(action.name)}`
		case "alterConstraintDeferral":
			return `ALTER CONSTRAINT ${quoteIdent(action.name)} ${action.deferrable === undefined ? "NOT DEFERRABLE" : `DEFERRABLE ${action.deferrable}`}`
		case "dropConstraint":
			return `DROP CONSTRAINT ${quoteIdent(action.name)}`
		case "enableRowSecurity":
			return "ENABLE ROW LEVEL SECURITY"
		case "disableRowSecurity":
			return "DISABLE ROW LEVEL SECURITY"
		case "replicaIdentity":
			return action.identity === "full" ? "REPLICA IDENTITY FULL" : "REPLICA IDENTITY DEFAULT"
		case "setExpression":
			return `ALTER COLUMN ${quoteIdent(action.column)} SET EXPRESSION AS (${printStoredGeneration(action.generation)})`
	}
}

/** A published table: its name, and its column list where it has one. */
const printPublishedTable = (published: PublishedTable): string =>
	published.columns.kind === "whole"
		? printObjectName(published.table)
		: `${printObjectName(published.table)} (${printIdentList(published.columns.columns)})`

const printAlterDomainAction = (action: AlterDomainAction): string => {
	switch (action.kind) {
		case "addConstraint":
			return `ADD ${printDomainCheck(action.constraint)}${action.notValid ? " NOT VALID" : ""}`
		case "validateConstraint":
			return `VALIDATE CONSTRAINT ${quoteIdent(action.name)}`
		case "dropConstraint":
			return `DROP CONSTRAINT ${quoteIdent(action.name)}`
	}
}

/** ASC, the default, prints bare. */
const printIndexKey = (key: IndexKey): string => {
	const parts = [
		key.key.kind === "column" ? quoteIdent(key.key.column) : `(${printExpr(key.key.expr)})`
	]
	if (key.collation !== undefined) {
		parts.push(`COLLATE ${printObjectName(key.collation)}`)
	}
	if (key.opclass !== undefined) {
		parts.push(printObjectName(key.opclass))
	}
	if (key.direction === "DESC") {
		parts.push(key.direction)
	}
	return parts.join(" ")
}

/** A function by its name and argument types. */
export const printFunctionSignature = (fn: FunctionName): string =>
	`${printObjectName(fn)}(${fn.args.map((t) => printType(t)).join(", ")})`

const printGrantee = (grantee: Grantee): string =>
	grantee.kind === "PUBLIC" ? "PUBLIC" : printRole(grantee.name)

/** One PostgreSQL command, as it writes its lines into a sink, unterminated: what one protocol message carries. */
export type Command = (out: Lines) => void

/**
 * The commands a statement is, by who else writes the catalog rows it writes: `own`, a row of the installation's own
 * objects alone, its own command; `databaseWide`, a row another installation in the same database writes too, the
 * database lock's command (sql/catalog.ts databaseLock) and then its own, so two installations migrating into one
 * database write it one at a time. The lock is held to the end of the transaction, and a statement takes it again at no
 * cost. The two are two commands, never one text: a file holds them each terminated (writeStatement), and a driver
 * sends them one message each (printCommands).
 */
type Emitter = (command: Command) => NonEmptyReadonlyArray<Command>

const own: Emitter = (command) => [command]

const databaseWide: Emitter = (command) => [(out) => writeCommand(out, databaseLock), command]

/**
 * How a GRANT or REVOKE on each kind of object is emitted (Emitter): the current database's ACL is a row of
 * pg_database every installation in the database writes; a schema's is a row of pg_namespace, and an installation
 * grants on the vector extension's schema (physical/ddl/roles.ts), which every installation of the database shares, by
 * the same arm it grants on its own schemas, so a grant on any schema is database-wide. A table's, a domain's and a
 * function's are the installation's own.
 */
const grantEmitter: { readonly [K in GrantObjects["kind"]]: Emitter } = {
	TABLE: own,
	DOMAIN: own,
	TYPE: own,
	FUNCTION: own,
	SCHEMA: databaseWide,
	DATABASE: databaseWide
}

/**
 * A declared function's hand-over as its three commands: CREATE on its schema granted to the owner, the ALTER FUNCTION
 * that `command` writes, and CREATE revoked, each its own command, on the installation's own schema, so no lock.
 */
const handedOver = (
	statement: HandOverFunction,
	command: Command
): NonEmptyReadonlyArray<Command> => {
	const schema = quoteIdent(statement.name.schema)
	const owner = printRole(statement.owner)
	return [
		(out) => out.line(`GRANT CREATE ON SCHEMA ${schema} TO ${owner}`),
		command,
		(out) => out.line(`REVOKE CREATE ON SCHEMA ${schema} FROM ${owner}`)
	]
}

/** What a GRANT or REVOKE names: its objects, or the current database (printDatabase). */
const printGrantOn = (on: GrantObjects): string =>
	on.kind === "DATABASE" ? `DATABASE ${printDatabase()}` : printGrantObjects(on)

const printGrantObjects = (on: NamedGrantObjects): string => {
	switch (on.kind) {
		case "SCHEMA":
			return `SCHEMA ${printIdentList(on.names)}`
		case "FUNCTION":
			return `FUNCTION ${on.names.map(printFunctionSignature).join(", ")}`
		case "TABLE":
		case "DOMAIN":
		case "TYPE":
			return `${on.kind} ${on.names.map(printObjectName).join(", ")}`
	}
}

const printAlterRoleAction = (action: AlterRoleAction): string => {
	switch (action.kind) {
		case "set":
			return `SET ${printRoleSetting(action.setting)}`
		case "reset":
			return `RESET ${action.parameter}`
	}
}

/** `PERFORM` in place of the query's leading SELECT keyword, through the same core and tail clauses, on one line. */
const performLine = (out: Lines, query: PerformQuery): void =>
	out.line(
		`${inlineText((row) => {
			coreClauses(row, query.body, "PERFORM", bodyReader(query, "placed"))
			tailClauses(row, query)
		})};`
	)

/** A RAISE EXCEPTION and its USING options, on the one line a block's statement takes (proceduralBlock). */
const raiseText = (statement: Extract<PlStatement, { readonly kind: "raise" }>): string => {
	const head = `RAISE EXCEPTION ${quoteString(statement.message)}`
	return statement.using.length === 0
		? `${head};`
		: `${head} USING ${statement.using.map((o) => `${o.option} = ${printExpr(o.value)}`).join(", ")};`
}

const plStatement = (out: Lines, statement: PlStatement): void => {
	switch (statement.kind) {
		case "if": {
			for (const [i, branch] of statement.branches.entries()) {
				out.line(`${i === 0 ? "IF" : "ELSIF"} ${printExpr(branch.condition)} THEN`)
				plStatements(out.nested(), branch.body)
			}
			if (statement.else.length > 0) {
				out.line("ELSE")
				plStatements(out.nested(), statement.else)
			}
			return out.line("END IF;")
		}
		case "assign":
			return out.line(`${quoteIdent(statement.target)} := ${printExpr(statement.value)};`)
		case "forQuery":
			out.line(
				`FOR ${quoteIdent(statement.variable)} IN ${printSelectInline(statement.query, "named")} LOOP`
			)
			plStatements(out.nested(), statement.body)
			return out.line("END LOOP;")
		case "perform":
			return performLine(out, statement.query)
		case "modify":
			dmlStatementBlock(out, statement.statement)
			return out.line(";")
		case "returnQuery":
			out.line("RETURN QUERY")
			selectBlock(out, statement.query)
			return out.line(";")
		case "createSessionTable":
			return out.line(`${sessionTableCreate(statement)};`)
		case "createSessionIndex":
			return out.line(
				`CREATE INDEX ${quoteIdent(statement.name)} ON ${sessionTableName(statement.table)} (${quoteIdent(statement.column)});`
			)
		case "truncateSessionTable":
			return out.line(`TRUNCATE ${sessionTableName(statement.name)};`)
		case "createSessionTrigger":
			return out.line(
				`CREATE CONSTRAINT TRIGGER ${quoteIdent(statement.name)} AFTER INSERT ON ${printTableName({ schema: temporarySchema, name: statement.table })} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${printObjectName(statement.function)}();`
			)
		case "whenFound":
			out.line(
				`PERFORM 1 FROM ${nestedSelect(statement.query, "placed")} AS ${quoteIdent("found")};`
			)
			out.line("IF FOUND THEN")
			plStatements(out.nested(), statement.body)
			return out.line("END IF;")
		case "case": {
			out.line(`CASE ${printExpr(statement.operand)}`)
			const arms = out.nested()
			for (const branch of statement.whens) {
				arms.line(`WHEN ${branch.values.map((v) => printExpr(v)).join(", ")} THEN`)
				plStatements(arms.nested(), branch.body)
			}
			return out.line("END CASE;")
		}
		case "raise":
			return out.line(raiseText(statement))
		case "return":
			return out.line(`RETURN ${printExpr(statement.value)};`)
	}
}

const plStatements = (out: Lines, statements: ReadonlyArray<PlStatement>): void => {
	for (const statement of statements) {
		plStatement(out, statement)
	}
}

/**
 * A PL/pgSQL block, a function's body or a DO statement's: its declarations, each on a line, and each statement of its
 * body on one line, whatever it holds, so the block compiles in time linear in its length. PL/pgSQL resolves a
 * statement's location to its line number as it reduces the statement, an IF, an ELSIF, a CASE WHEN or a loop only after
 * the statements of its body, and plpgsql_location_to_lineno rescans the source from its first byte whenever a location
 * lies before the start of the line it last resolved (PostgreSQL 19.0, src/pl/plpgsql/src/pl_scanner.c, "be correct,
 * but not fast, if input location goes backwards"), as it does at every compound statement whose body begins a later
 * line: a block of N such statements compiled in O(N x length), at CREATE FUNCTION and at the first call in every
 * backend, 17 s for one CASE of 40,000 arms. A statement on one line holds every location its reduction resolves, so no
 * location goes back but the block's own BEGIN, resolved last, whose rescan reads the declarations alone. A string
 * constant whose value holds a line feed is spelled as its escape string (sql/escape.ts lineFeedsEscaped), so the line
 * ends at the statement's end, never inside the constant.
 */
const proceduralBlock = <S>(
	out: Lines,
	declare: ReadonlyArray<PlDeclaration>,
	body: ReadonlyArray<S>,
	statement: (out: Lines, s: S) => void
): void => {
	if (declare.length > 0) {
		out.line("DECLARE")
		const declarations = out.nested()
		for (const d of declare) {
			declarations.line(`${quoteIdent(d.name)} ${printType(d.type)};`)
		}
	}
	out.line("BEGIN")
	const statements = out.nested()
	for (const s of body) {
		statements.line(lineFeedsEscaped(inlineText((row) => statement(row, s))))
	}
	out.line("END")
}

const plBlock = (out: Lines, block: PlBlock): void =>
	proceduralBlock(out, block.declare, block.body, plStatement)

/**
 * The dollar-quote tag for a body's lines: `$$` unless a line holds it, then `$gz$`, `$gz1$`, …. No tag holds a
 * newline, so an occurrence in the joined body lies inside one line.
 */
const dollarQuoteTag = (body: ReadonlyArray<string>): string => {
	const free = (tag: string): boolean => !body.some((line) => line.includes(tag))
	if (free("$$")) {
		return "$$"
	}
	if (free("$gz$")) {
		return "$gz$"
	}
	for (let n = 1; ; n++) {
		const tag = `$gz${n}$`
		if (free(tag)) {
			return tag
		}
	}
}

/** A PL/pgSQL block's lines as its dollar-quoted body holds them, from its DECLARE or BEGIN to its END. */
const blockLines = (block: PlBlock): ReadonlyArray<string> => {
	const body: Array<string> = []
	plBlock(new BlockLines(body, sqlUnit, ""), block)
	return body
}

/** Each printed PL/pgSQL function's source lines (sourceLines), by its printed form. */
const sourceLinesOf = new WeakMap<PlFunction, ReadonlyArray<string>>()

/**
 * A PL/pgSQL function's body as its CREATE FUNCTION holds it, line by line: the lines of its printed form's body
 * (sql/print-once.ts printedFunction), made once per function. Its CREATE FUNCTION writes them between its dollar quotes
 * (createFunctionBlock) and its record digests them (functionSource): one print, so no record digests a text its file
 * does not hold.
 */
const sourceLines = (fn: PlFunction): ReadonlyArray<string> => {
	const form = printedFunction(fn)
	const known = sourceLinesOf.get(form)
	if (known !== undefined) {
		return known
	}
	const lines = blockLines(form.body)
	sourceLinesOf.set(form, lines)
	return lines
}

/**
 * The source PostgreSQL stores of a PL/pgSQL function this printer writes, its pg_proc.prosrc: the value of the
 * dollar-quoted string between `AS <tag>` and `<tag>`, each on a line of its own (quotedLines), so a line feed begins
 * and ends it around its body's lines, the very lines its CREATE FUNCTION writes (sourceLines). A drafted file that
 * spells the body as an escape string (deploy/render/filed.ts) spells this value too.
 */
export const functionSource = (fn: PlFunction): string => `\n${sourceLines(fn).join("\n")}\n`

/** `<opener> <tag>`, the block's lines, and the tag: a function's `AS` body or a DO statement. */
const dollarQuoted = (out: Lines, opener: "AS" | "DO", block: PlBlock): void =>
	quotedLines(out, opener, blockLines(block))

/** `<opener> <tag>`, `body`'s lines, and the tag, a dollar-quote tag no line holds (dollarQuoteTag): a function's `AS`
 * body, a stub constant's (sql/ast.ts StubConstant) among them, or a DO statement. */
const quotedLines = (out: Lines, opener: "AS" | "DO", body: ReadonlyArray<string>): void => {
	const tag = dollarQuoteTag(body)
	out.line(`${opener} ${tag}`)
	for (const line of body) {
		out.line(line)
	}
	out.line(tag)
}

/** What a stub constant returns (sql/ast.ts StubConstant): NULL of its result type. */
const stubValue = (returns: TypeRef): string => `NULL::${printType(returns)}`

/**
 * A constant's CREATE FUNCTION (sql/ast.ts CreateConstant): its head, its language's clauses and its body. A function of
 * its own, as the stub's is, so each language arm returns from it and no value of its language another arm's statement
 * falls into.
 */
const writeConstant = (
	out: Lines,
	statement: CreateConstant,
	head: "CREATE FUNCTION" | "CREATE OR REPLACE FUNCTION"
): void => {
	out.line(constantHead(head, statement.name, statement.params, statement.returns))
	switch (statement.language) {
		case "sql":
			out.line(sqlConstantClauses("strict" in statement && statement.strict))
			return out.line(`RETURN ${printExpr(statement.body)}`)
		case "plpgsql":
			out.line(plannedConstantClauses)
			return dollarQuoted(out, "AS", {
				declare: [],
				body: [{ kind: "return", value: statement.body }]
			})
	}
}

/** A stub constant's CREATE FUNCTION (sql/ast.ts StubConstant): its head, its language's clauses and its NULL. */
const writeStubConstant = (out: Lines, statement: StubConstant): void => {
	out.line(constantHead("CREATE FUNCTION", statement.name, statement.params, statement.returns))
	switch (statement.language) {
		case "sql":
			out.line(constantClauses)
			return out.line(`RETURN ${stubValue(statement.returns)}`)
		case "plpgsql":
			out.line(plannedConstantClauses)
			return quotedLines(out, "AS", ["BEGIN", `  RETURN ${stubValue(statement.returns)};`, "END"])
	}
}

/** What a function returns, as its RETURNS clause spells it: a catalog type, or a set of one type's values. */
const printReturns = (returns: CreateFunction["returns"]): string =>
	typeof returns === "string" ? printCatalogType(returns) : `SETOF ${printType(returns.setOf)}`

/** A function's estimate of its rows as its clause, after its volatility: ROWS where it declares one, else none. */
const rowsClause = (
	returns: CreateFunction["returns"] | CreateDeclaredFunction["returns"]
): string => {
	if (typeof returns === "string" || !("setOf" in returns)) {
		return ""
	}
	switch (returns.rows.kind) {
		case "planner":
			return ""
		case "declared":
			return ` ROWS ${returns.rows.rows}`
	}
}

/** A function's parallel safety as its clause, after its volatility: none for UNSAFE, PostgreSQL's own default. */
const parallelClause = (parallel: CreateFunction["parallel"]): string =>
	parallel === "SAFE" ? " PARALLEL SAFE" : ""

const createFunctionBlock = (out: Lines, fn: CreateFunction): void => {
	out.line(
		`CREATE OR REPLACE FUNCTION ${printObjectName(fn.name)}(${fn.params.map((p) => `${quoteIdent(p.name)} ${printType(p.type)}`).join(", ")}) RETURNS ${printReturns(fn.returns)}`
	)
	out.line(
		`LANGUAGE ${fn.language} ${fn.volatility}${parallelClause(fn.parallel)}${rowsClause(fn.returns)} SECURITY ${fn.security} SET search_path = ${printedSearchPath}`
	)
	switch (fn.language) {
		case "plpgsql":
			return quotedLines(out, "AS", sourceLines(fn))
		case "sql":
			return out.line(`RETURN ${printExpr(fn.body)}`)
	}
}

/**
 * The dollar-quote tag for a declared function's body: `$$` unless the body holds it, then `$gz$`, `$gz1$`, …, the first
 * whose one occurrence in the body followed by it is its own, so no `$` the body ends in joins the tag and PostgreSQL's
 * scanner ends the body exactly where it ends.
 */
const declaredBodyTag = (body: string): string => {
	const free = (tag: string): boolean => `${body}${tag}`.indexOf(tag) === body.length
	if (free("$$")) {
		return "$$"
	}
	if (free("$gz$")) {
		return "$gz$"
	}
	for (let n = 1; ; n++) {
		const tag = `$gz${n}$`
		if (free(tag)) {
			return tag
		}
	}
}

/** A declared function's search_path, as its SET clause spells it: pg_catalog, its own schema, then pg_temp. */
const declaredSearchPath = (schema: string): string =>
	[closedSearchPath[0], schema, closedSearchPath[1]].map(quoteIdent).join(", ")

/**
 * A declared function's CREATE OR REPLACE FUNCTION (sql/ast.ts CreateDeclaredFunction): its head and clauses on two lines,
 * then `AS`, its tag, the body exactly as declared and the tag again, so the value between the tags, which PostgreSQL
 * stores as its pg_proc.prosrc, is the body itself, byte for byte.
 */
const createDeclaredFunction = (out: Lines, fn: CreateDeclaredFunction): void => {
	out.line(
		`CREATE OR REPLACE FUNCTION ${printObjectName(fn.name)}(${fn.params.map((p) => `${quoteIdent(p.name)} ${printType(p.type)}`).join(", ")}) RETURNS ${"setOf" in fn.returns ? `SETOF ${printType(fn.returns.setOf)}` : printType(fn.returns)}`
	)
	out.line(
		`LANGUAGE ${fn.language} ${fn.volatility}${fn.nullInput === undefined ? "" : ` ${fn.nullInput}`}${rowsClause(fn.returns)} SECURITY DEFINER SET search_path = ${declaredSearchPath(fn.name.schema)}`
	)
	const tag = declaredBodyTag(fn.body)
	out.line(`AS ${tag}${fn.body}${tag}`)
}

/** A constant's head, CREATE FUNCTION <name>(<params>) RETURNS <type>. */
const constantHead = (
	head: "CREATE FUNCTION" | "CREATE OR REPLACE FUNCTION",
	name: ObjectName,
	params: ReadonlyArray<FunctionParam>,
	returns: TypeRef
): string =>
	`${head} ${printObjectName(name)}(${params.map((p) => `${quoteIdent(p.name)} ${printType(p.type)}`).join(", ")}) RETURNS ${printType(returns)}`

/**
 * What every SQL constant is: a function PostgreSQL evaluates once and may run in parallel, STRICT where it is
 * (sql/ast.ts LibraryConstant).
 */
const sqlConstantClauses = (strict: boolean): string =>
	`LANGUAGE sql IMMUTABLE ${strict ? "STRICT " : ""}PARALLEL SAFE`

/** A constant's clauses that states no NULL behaviour of its own, a literal pack's among them. */
const constantClauses = sqlConstantClauses(false)

/** A PL/pgSQL constant's clauses (sql/ast.ts ConstantLanguage): planned once per backend, under the closed path. */
const plannedConstantClauses = `LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = ${printedSearchPath}`

/** What every literal pack's comment begins with (writePack), which `grizzle check` finds it by. */
const literalPackLead = "-- closed "

/** The line a literal pack's comment begins with, by its layout (writePack). */
const literalPackComment = {
	cells: `${literalPackLead}cells: `,
	payloads: `${literalPackLead}payloads: `
} as const

/** What separates a literal pack's function from its body: the head every constant has after its name. */
const literalPackBody = `() RETURNS ${printType(types.codes)} ${constantClauses} RETURN `

/** The cast that ends a literal pack's body. */
const literalPackEnd = `'::${printType(types.codes)}`

/** A literal pack's comment past its lead, by its layout: what it holds and over what. */
const layoutText = (layout: PackLayout, rows: number | bigint): string =>
	layout.kind === "cells"
		? `${rows} rows in ${layout.cells} cells`
		: `${rows} rows of ${layout.points} payload codes`

/**
 * One array of a closed relation's constant (sql/ast.ts PackConstant), one statement whose body is the array itself as
 * one literal:
 *
 *   -- closed cells: <rows> rows in <cells> cells, content <digest>
 *   -- closed payloads: <rows> rows of <points> payload codes, content <digest>
 *   CREATE FUNCTION <function>() RETURNS bigint[] LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN '{…}'::bigint[]
 *
 * the statement on one line. The comment states what `grizzle check` holds the literal to (readLiteralPack): its rows,
 * its layout, and its content's digest, which the function's name digests in turn. The literal holds digits, a minus
 * sign, commas and braces alone (ir/cells.ts cellsLiteralOf, payloadsLiteralOf), so it is quoted as it stands.
 */
const writePack = (out: Lines, pack: PackConstant): void => {
	out.line(
		`${literalPackComment[pack.layout.kind]}${layoutText(pack.layout, pack.rows)}, content ${pack.digest}`
	)
	out.line(
		`CREATE FUNCTION ${printObjectName(pack.function)}${literalPackBody}'${pack.text}${literalPackEnd}`
	)
}

/** A literal pack as its printed statement states it (readLiteralPack): its function's printed name and its literal. */
export interface LiteralPackText {
	readonly function: string
	readonly rows: bigint
	/** The layout the comment states, a payloads' of one payload code at least: a comment stating none is no pack's. */
	readonly layout: PackLayout
	readonly digest: string
	readonly text: string
}

/** A text of decimal digits as the whole number it spells, none for any other text. */
const wholeNumber = (text: string): bigint | undefined =>
	text !== "" && isAsciiDigits(text, 0, text.length) ? BigInt(text) : undefined

/** A text of decimal digits as the whole number it spells where it is at least 1, none for any other text. */
const positiveNumber = (text: string): bigint | undefined => {
	const n = wholeNumber(text)
	return n === undefined || n === 0n ? undefined : n
}

/** The text between `before` at the start of `text` and the first `after` past it, and what follows, or none. */
const between = (
	text: string,
	before: string,
	after: string
): { readonly inner: string; readonly rest: string } | undefined => {
	if (!text.startsWith(before)) {
		return undefined
	}
	const end = text.indexOf(after, before.length)
	return end < 0
		? undefined
		: { inner: text.slice(before.length, end), rest: text.slice(end + after.length) }
}

/** A literal pack's body, its one quoted array literal to the end of the statement; none for any other text. */
const packedLiteral = (body: string): string | undefined => {
	const literal = between(body, "'", literalPackEnd)
	return literal?.rest === "" ? literal.inner : undefined
}

/** A literal pack's comment past its layout's lead, read as its rows and layout: none for any other text. */
const readLayout = (
	kind: PackLayout["kind"],
	text: string
): { readonly rows: bigint; readonly layout: PackLayout; readonly rest: string } | undefined => {
	const rows = between(text, "", kind === "cells" ? " rows in " : " rows of ")
	const size =
		rows === undefined
			? undefined
			: between(rows.rest, "", kind === "cells" ? " cells, content " : " payload codes, content ")
	const count = rows === undefined ? undefined : wholeNumber(rows.inner)
	if (size === undefined || count === undefined) {
		return undefined
	}
	const measure = kind === "cells" ? wholeNumber(size.inner) : positiveNumber(size.inner)
	return measure === undefined
		? undefined
		: {
				rows: count,
				layout: kind === "cells" ? { kind, cells: measure } : { kind, points: measure },
				rest: size.rest
			}
}

/**
 * A statement of a migration file read as a literal pack, writePack's printed form, its leading comment
 * included and its terminator not; none for any statement that does not begin with a literal pack's comment. A
 * statement that begins with one but departs from the form anywhere is none too, so a pack whose text was edited out of
 * its form is no pack a reader trusts, which `grizzle check` refuses as it refuses a changed one (cli/check.ts).
 */
export const readLiteralPack = (statement: string): LiteralPackText | undefined => {
	const trimmed = statement.trimStart()
	const kind: PackLayout["kind"] | undefined = trimmed.startsWith(literalPackComment.cells)
		? "cells"
		: trimmed.startsWith(literalPackComment.payloads)
			? "payloads"
			: undefined
	const comment = kind === undefined ? undefined : between(trimmed, literalPackComment[kind], "\n")
	const read =
		kind === undefined || comment === undefined ? undefined : readLayout(kind, comment.inner)
	const head =
		comment === undefined
			? undefined
			: between(comment.rest.trim(), "CREATE FUNCTION ", literalPackBody)
	const text = head === undefined ? undefined : packedLiteral(head.rest)
	return read === undefined || head === undefined || text === undefined
		? undefined
		: { function: head.inner, rows: read.rows, layout: read.layout, digest: read.rest, text }
}

/** Whether a statement of a migration file begins as a literal pack does: what `grizzle check` holds to the form. */
export const looksLikeLiteralPack = (statement: string): boolean =>
	statement.trimStart().startsWith(literalPackLead)

/** What a COMMENT names, as it prints after COMMENT ON, and as `grizzle names` lists it. */
export const printCommentTarget = (on: CommentTarget): string => {
	switch (on.kind) {
		case "SCHEMA":
			return `SCHEMA ${quoteIdent(on.name)}`
		case "ROLE":
			return `ROLE ${printRole(on.name)}`
		case "TABLE":
		case "VIEW":
		case "DOMAIN":
		case "TYPE":
		case "INDEX":
		case "STATISTICS":
			return `${on.kind} ${printObjectName(on.name)}`
		case "COLUMN":
			return `COLUMN ${printObjectName(on.relation)}.${quoteIdent(on.column)}`
		case "CONSTRAINT":
		case "TRIGGER":
		case "POLICY":
			return `${on.kind} ${quoteIdent(on.name)} ON ${printObjectName(on.on)}`
		case "DOMAIN CONSTRAINT":
			return `CONSTRAINT ${quoteIdent(on.name)} ON DOMAIN ${printObjectName(on.domain)}`
		case "FUNCTION":
			return `FUNCTION ${printFunctionSignature(on.name)}`
	}
}

/**
 * A statement's own command, written into `out`, with no database lock before it (commandsOf decides that).
 *
 * An installed table lists one element per line.
 *
 * A carrier is a one-line runtime statement.
 *
 * One clause per line, each after the first indented once.
 *
 * The database default's reset's DO block reads the database's name (sql/ast.ts ResetDatabaseDefault, sql/catalog.ts
 * databaseResetBlock); `%I` quotes it as an identifier. A GRANT or REVOKE on the current database names it by its
 * variable (printDatabase).
 *
 * Every role of the installation prints as its variable (printRole); the owner a FOR ROLE names is no role of it and
 * prints as its name.
 *
 * A carrier is printed under pg_temp, the session's own temporary schema: never a stored relation of the same name.
 */
const writeCommand = (out: Lines, statement: SqlStatement): void => {
	switch (statement.kind) {
		case "select":
			return selectBlock(out, statement)
		case "insert":
		case "update":
		case "delete":
		case "merge":
			return dmlStatementBlock(out, statement)
		case "createSchema":
			return out.line(`CREATE SCHEMA ${quoteIdent(statement.name)}`)
		case "createTable":
			out.line(`CREATE TABLE ${printObjectName(statement.table)} (`)
			listed(out.nested(), [
				...statement.columns.map(printColumnDef),
				...tableConstraints(statement).map(printConstraint)
			])
			return out.line(")")
		case "createCarrier":
			return out.line(carrierTable(statement))
		case "emptyCarrier":
			return out.line(`SELECT ${printObjectName(objectName(temporarySchema, statement.name))}()`)
		case "alterTable": {
			const head = `ALTER TABLE ${printObjectName(statement.table)}`
			if (statement.actions.length === 1) {
				return out.line(`${head} ${printAlterTableAction(statement.actions[0])}`)
			}
			out.line(head)
			return listed(out.nested(), statement.actions.map(printAlterTableAction))
		}
		case "rename":
			switch (statement.object) {
				case "ROLE":
					return out.line(
						`ALTER ROLE ${printRole(statement.name)} RENAME TO ${printRole(statement.to)}`
					)
				case "SCHEMA":
					return out.line(
						`ALTER SCHEMA ${quoteIdent(statement.name)} RENAME TO ${quoteIdent(statement.to)}`
					)
				case "FUNCTION":
					return out.line(
						`ALTER FUNCTION ${printObjectName(statement.name)}(${statement.args.map(printType).join(", ")}) RENAME TO ${quoteIdent(statement.to)}`
					)
				case "TABLE":
				case "INDEX":
				case "DOMAIN":
					return out.line(
						`ALTER ${statement.object} ${printObjectName(statement.name)} RENAME TO ${quoteIdent(statement.to)}`
					)
			}
		case "replaceConstant":
			return writeConstant(out, statement.constant, "CREATE OR REPLACE FUNCTION")
		case "renameColumn":
			return out.line(
				`ALTER TABLE ${printObjectName(statement.table)} RENAME COLUMN ${quoteIdent(statement.from)} TO ${quoteIdent(statement.to)}`
			)
		case "renameConstraint":
			return out.line(
				`ALTER TABLE ${printObjectName(statement.table)} RENAME CONSTRAINT ${quoteIdent(statement.from)} TO ${quoteIdent(statement.to)}`
			)
		case "createDomain": {
			const parts = [
				`CREATE DOMAIN ${printObjectName(statement.name)} AS ${printType(statement.base)}`
			]
			if (statement.collation !== undefined) {
				parts.push(`COLLATE ${printObjectName(statement.collation)}`)
			}
			for (const c of statement.constraints) {
				parts.push(printDomainCheck(c))
			}
			return out.line(parts.join(" "))
		}
		case "alterDomain":
			return out.line(
				`ALTER DOMAIN ${printObjectName(statement.name)} ${printAlterDomainAction(statement.action)}`
			)
		case "createIndex": {
			const include =
				statement.include.length > 0 ? ` INCLUDE (${printIdentList(statement.include)})` : ""
			const where = statement.where === undefined ? "" : ` WHERE ${printExpr(statement.where)}`
			return out.line(
				`CREATE ${statement.unique ? "UNIQUE " : ""}INDEX ${statement.concurrently ? "CONCURRENTLY " : ""}${quoteIdent(statement.name)} ON ${printObjectName(statement.table)} USING ${statement.method} (${statement.keys.map(printIndexKey).join(", ")})${include}${where}`
			)
		}
		case "dropIndex":
			return out.line(
				`DROP INDEX ${statement.concurrently ? "CONCURRENTLY " : ""}${statement.ifExists ? "IF EXISTS " : ""}${printObjectName(statement.name)}`
			)
		case "createStoredTable":
			out.line(
				`CREATE TABLE ${printObjectName(statement.name)} (${printIdentList(statement.columns)}) AS`
			)
			selectBlock(out, statement.query)
			return out.line("WITH NO DATA")
		case "createView":
			out.line(
				`CREATE VIEW ${printObjectName(statement.name)} (${printIdentList(statement.columns)})${statement.barrier ? " WITH (security_barrier)" : ""} AS`
			)
			return selectBlock(out, statement.query)
		case "createPolicy": {
			out.line(
				`CREATE POLICY ${quoteIdent(statement.name)} ON ${printObjectName(statement.table)} AS PERMISSIVE FOR ALL TO ${printRole(statement.role)}`
			)
			const clauses = out.nested()
			clauses.line(`USING (${printExpr(statement.filter)})`)
			return clauses.line(`WITH CHECK (${printExpr(statement.filter)})`)
		}
		case "dropPolicy":
			return out.line(
				`DROP POLICY ${quoteIdent(statement.name)} ON ${printObjectName(statement.table)}`
			)
		case "drop":
			return out.line(
				`DROP ${statement.object} ${statement.ifExists ? "IF EXISTS " : ""}${statement.object === "ROLE" ? printRole(statement.name) : statement.object === "SCHEMA" ? quoteIdent(statement.name) : printObjectName(statement.name)}`
			)
		case "dropFunction":
			return out.line(
				`DROP FUNCTION ${statement.ifExists ? "IF EXISTS " : ""}${printFunctionSignature(statement.name)} RESTRICT`
			)
		case "dropTrigger":
			return out.line(
				`DROP TRIGGER ${statement.ifExists ? "IF EXISTS " : ""}${quoteIdent(statement.name)} ON ${printObjectName(statement.table)}`
			)
		case "createFunction":
			return createFunctionBlock(out, statement)
		case "createDeclaredFunction":
			return createDeclaredFunction(out, statement)
		case "handOverFunction":
			return out.line(
				`ALTER FUNCTION ${printFunctionSignature(statement.name)} OWNER TO ${printRole(statement.owner)}`
			)
		case "createRowType":
			return out.line(
				`CREATE TYPE ${printObjectName(statement.name)} AS (${statement.attributes.map(definitionText).join(", ")})`
			)
		case "adoptRole":
			return out.line(
				`GRANT ${printRole(statement.role)} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`
			)
		case "endHolders":
			return writeEndHolders(out, mapNonEmpty(statement.roles, printRoleName))
		case "packConstant":
			return writePack(out, statement)
		case "createConstant":
			return writeConstant(out, statement, "CREATE FUNCTION")
		case "stubConstant":
			return writeStubConstant(out, statement)
		case "createGuardTrigger": {
			out.line(`CREATE TRIGGER ${quoteIdent(statement.name)}`)
			const clauses = out.nested()
			clauses.line(
				`BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${printObjectName(statement.table)}`
			)
			return clauses.line(
				`FOR EACH STATEMENT EXECUTE FUNCTION ${printObjectName(statement.function)}()`
			)
		}
		case "createUpdateGuardTrigger": {
			out.line(`CREATE TRIGGER ${quoteIdent(statement.name)}`)
			const clauses = out.nested()
			clauses.line(`BEFORE UPDATE ON ${printObjectName(statement.table)}`)
			return clauses.line(`FOR EACH ROW EXECUTE FUNCTION ${printObjectName(statement.function)}()`)
		}
		case "createConstraintTrigger": {
			out.line(`CREATE CONSTRAINT TRIGGER ${quoteIdent(statement.name)}`)
			const clauses = out.nested()
			clauses.line(
				`AFTER ${statement.events.map(triggerEventText).join(" OR ")} ON ${printObjectName(statement.table)}`
			)
			clauses.line("DEFERRABLE INITIALLY DEFERRED")
			return clauses.line(`FOR EACH ROW EXECUTE FUNCTION ${printObjectName(statement.function)}()`)
		}
		case "createTransitionTrigger": {
			out.line(`CREATE TRIGGER ${quoteIdent(statement.name)}`)
			const clauses = out.nested()
			clauses.line(
				`AFTER ${transitionEventText[statement.event]} ON ${printObjectName(statement.table)}`
			)
			clauses.line(`REFERENCING ${transitionReferences[statement.event]}`)
			return clauses.line(
				`FOR EACH STATEMENT EXECUTE FUNCTION ${printObjectName(statement.function)}()`
			)
		}
		case "createPublication": {
			out.line(`CREATE PUBLICATION ${quoteIdent(statement.name)}`)
			const clauses = out.nested()
			const [first, ...rest] = statement.tables
			if (first !== undefined) {
				clauses.line(`FOR TABLE ${[first, ...rest].map(printPublishedTable).join(", ")}`)
			}
			return clauses.line("WITH (publish_generated_columns = stored)")
		}
		case "dropPublication":
			return out.line(`DROP PUBLICATION ${quoteIdent(statement.name)}`)
		case "createLiveSecret": {
			const draw = `${inCatalog("uuid_send")}(${inCatalog("gen_random_uuid")}())`
			return out.line(
				`CREATE TABLE ${printObjectName(statement.table)} (${quoteIdent("secret")}) AS SELECT ${inCatalog("sha256")}(${draw} || ${draw})`
			)
		}
		case "resetDatabaseDefault":
			return writeDo(out, databaseResetBlock(statement))
		case "createRole":
			return out.line(
				`CREATE ROLE ${printRole(statement.name)} ${statement.login ? "LOGIN NOINHERIT" : "NOLOGIN"}`
			)
		case "grantRole":
			return out.line(
				`GRANT ${printRole(statement.role)} TO ${printRole(statement.to)} WITH INHERIT FALSE, SET TRUE`
			)
		case "revokeRole":
			return out.line(`REVOKE ${printRole(statement.role)} FROM ${printRole(statement.from)}`)
		case "alterRole":
			return out.line(
				`ALTER ROLE ${printRole(statement.name)} ${printAlterRoleAction(statement.action)}`
			)
		case "grant":
			return out.line(
				`GRANT ${statement.privileges.join(", ")} ON ${printGrantOn(statement.on)} TO ${statement.to.map(printGrantee).join(", ")}`
			)
		case "revoke":
			return out.line(
				`REVOKE ${statement.privileges.join(", ")} ON ${printGrantOn(statement.on)} FROM ${statement.from.map(printGrantee).join(", ")}`
			)
		case "grantColumns":
			return out.line(
				`GRANT ${statement.privilege} (${printIdentList(statement.columns)}) ON TABLE ${printObjectName(statement.table)} TO ${printRole(statement.to)}`
			)
		case "alterDefaultPrivileges":
			return out.line(
				`ALTER DEFAULT PRIVILEGES${statement.inSchema === undefined ? "" : ` IN SCHEMA ${quoteIdent(statement.inSchema)}`} REVOKE ${statement.privileges.join(", ")} ON ${statement.on} FROM ${statement.from.map(printGrantee).join(", ")}`
			)
		case "createExtension":
			return out.line(
				`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(statement.name)} SCHEMA ${quoteIdent(statement.schema)}`
			)
		case "declareStatistics":
			return writeDoBlock(out, declaredStatisticsBlock(statement))
		case "comment":
			return out.line(
				`COMMENT ON ${printCommentTarget(statement.on)} IS ${quoteString(statement.text)}`
			)
		case "lockTable":
			return out.line(
				`LOCK TABLE ${statement.tables.map(printObjectName).join(", ")} IN ${statement.mode} MODE${statement.wait === "nowait" ? " NOWAIT" : ""}`
			)
		case "beginRead":
			return out.line("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY")
		case "beginWrite":
			return out.line(`BEGIN ISOLATION LEVEL ${isolationLevels[statement.isolation]}`)
		case "commit":
			return out.line("COMMIT")
		case "rollback":
			return out.line("ROLLBACK")
		case "setConstraintsImmediate":
			return out.line("SET CONSTRAINTS ALL IMMEDIATE")
		case "fillStored":
			out.line(
				`INSERT INTO ${printObjectName(statement.table)} (${printIdentList(statement.columns)})`
			)
			return selectBlock(out, statement.query)
	}
}

/**
 * The commands `statement` is (Emitter): a statement that writes a catalog row another installation in the same
 * database writes too is the database lock's command and its own (databaseWide): the database default's block, every
 * ALTER DEFAULT PRIVILEGES, every CREATE EXTENSION, and a GRANT or REVOKE on the database or a schema (grantEmitter).
 * Every other statement is its own command alone. A statement is printed as print once prints it (sql/print-once.ts
 * printedOnce): each CTE PostgreSQL would inline printed in place. The one source of a statement's commands: a drafted file writes
 * them (writeStatement, deploy/render/sql.ts), meta.json records them (deploy/render/sql.ts recordFile), and a driver
 * sends them (printCommands), so none of the three can split a statement another way.
 */
export const commandsOf = (given: SqlStatement): NonEmptyReadonlyArray<Command> => {
	const statement = printedOnce(given)
	const command: Command = (out) => writeCommand(out, statement)
	switch (statement.kind) {
		case "resetDatabaseDefault":
		case "alterDefaultPrivileges":
		case "createExtension":
			return databaseWide(command)
		case "grant":
		case "revoke":
			return grantEmitter[statement.on.kind](command)
		case "handOverFunction":
			return handedOver(statement, command)
		case "declareStatistics":
			return [
				(out) => {
					out.line(`ALTER TABLE ${printObjectName(statement.table)}`)
					listed(out.nested(), [
						`SET (autovacuum_analyze_threshold = ${autovacuumAnalyzeThresholdMax}, autovacuum_analyze_scale_factor = ${autovacuumAnalyzeScaleMax})`,
						...statement.columns.map((c) => `ALTER COLUMN ${quoteIdent(c.column)} SET STATISTICS 0`)
					])
				},
				...statement.dependencies.flatMap((d): ReadonlyArray<Command> => [
					(out) =>
						out.line(
							`CREATE STATISTICS IF NOT EXISTS ${printObjectName(d.name)} (dependencies) ON ${quoteIdent(d.determinant)}, ${quoteIdent(d.dependent)} FROM ${printObjectName(statement.table)}`
						),
					(out) => out.line(`ALTER STATISTICS ${printObjectName(d.name)} SET STATISTICS 0`)
				]),
				command
			]
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "createSchema":
		case "createTable":
		case "createCarrier":
		case "emptyCarrier":
		case "alterTable":
		case "rename":
		case "replaceConstant":
		case "renameColumn":
		case "renameConstraint":
		case "createDomain":
		case "alterDomain":
		case "createIndex":
		case "dropIndex":
		case "createStoredTable":
		case "createView":
		case "createPolicy":
		case "dropPolicy":
		case "drop":
		case "dropFunction":
		case "dropTrigger":
		case "createFunction":
		case "createDeclaredFunction":
		case "createRowType":
		case "adoptRole":
		case "endHolders":
		case "packConstant":
		case "createConstant":
		case "stubConstant":
		case "createGuardTrigger":
		case "createUpdateGuardTrigger":
		case "createConstraintTrigger":
		case "createTransitionTrigger":
		case "createPublication":
		case "dropPublication":
		case "createLiveSecret":
		case "createRole":
		case "grantRole":
		case "revokeRole":
		case "alterRole":
		case "grantColumns":
		case "comment":
		case "lockTable":
		case "beginRead":
		case "beginWrite":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
		case "fillStored":
			return own(command)
	}
}

/**
 * A statement's lines, written into `out` as a file holds them: its commands (commandsOf), each but the last terminated,
 * so the file's reader splits them where PostgreSQL's scanner ends each (deploy/render/markers.ts splitStatements) and
 * sends each alone. A drafted file writes statements into its own sink.
 */
export const writeStatement = (out: Lines, statement: SqlStatement): void => {
	const [first, ...rest] = commandsOf(statement)
	let pending = first
	for (const next of rest) {
		terminated(out, pending)
		pending = next
	}
	pending(out)
}

/** A catalog read's type, an array's with `[]`. */
const printCatalogCast = (type: CatalogCast): string =>
	`${printCatalogType(type.name)}${type.array ? "[]" : ""}`

/**
 * A catalog literal: a boolean typed boolean and a nonnegative integer typed integer bare, as PostgreSQL types them
 * itself; every other one cast to its type, a negative integer parenthesized, the unary minus of its magnitude.
 */
const catalogLiteral = (value: string | bigint | boolean, type: CatalogCast): Printed => {
	if (typeof value === "boolean") {
		const spelled = value ? "true" : "false"
		return !type.array && type.name === "boolean"
			? printed(spelled, "atom")
			: printed(`${spelled}::${printCatalogCast(type)}`, "cast")
	}
	if (typeof value === "bigint") {
		if (!type.array && type.name === "integer" && value >= 0n) {
			return printed(value.toString(), "atom")
		}
		const spelled = value < 0n ? `(${value.toString()})` : value.toString()
		return printed(`${spelled}::${printCatalogCast(type)}`, "cast")
	}
	return printed(`${quoteString(value)}::${printCatalogCast(type)}`, "cast")
}

const catalogCall = (call: CatalogCall): string =>
	`${inCatalog(call.fn)}(${call.args.map((arg) => catalogExpr(arg).text).join(", ")})`

const catalogExprs = (list: ReadonlyArray<CatalogExpr>): string =>
	list.map((e) => catalogExpr(e).text).join(", ")

/** A catalog expression, parenthesized by the precedence levels grizzle's value SQL prints by. */
export const catalogExpr = (e: CatalogExpr): Printed => {
	switch (e.kind) {
		case "column":
			return printed(`${quoteIdent(e.from)}.${quoteIdent(e.column)}`, "atom")
		case "param":
			return printed(`$${e.number}::${printCatalogCast(e.type)}`, "cast")
		case "literal":
			return catalogLiteral(e.value, e.type)
		case "cast":
			return printed(`${wrap(catalogExpr(e.expr), "atom")}::${printCatalogCast(e.type)}`, "cast")
		case "call":
			return printed(catalogCall(e), "atom")
		case "countStar":
			return printed(`${inCatalog("count")}(*)`, "atom")
		case "null":
			return printed(`NULL::${printCatalogCast(e.type)}`, "cast")
		case "joinedSet": {
			const value = catalogExpr(e.value).text
			return printed(
				`${inCatalog("string_agg")}(DISTINCT ${value}, ${catalogExpr(e.separator).text} ORDER BY ${value})`,
				"atom"
			)
		}
		case "compare":
			return printed(
				`${wrapTighter(catalogExpr(e.left), "compare")} ${e.op} ${wrapTighter(catalogExpr(e.right), "compare")}`,
				"compare"
			)
		case "distinctFrom":
			return printed(
				`${wrap(catalogExpr(e.left), "other")} IS DISTINCT FROM ${wrap(catalogExpr(e.right), "other")}`,
				"is"
			)
		case "concat":
			return printed(
				e.parts.map((part) => wrapTighter(catalogExpr(part), "other")).join(" || "),
				"other"
			)
		case "and":
			return printed(e.args.map((arg) => wrapTighter(catalogExpr(arg), "and")).join(" AND "), "and")
		case "or":
			return printed(e.args.map((arg) => wrapTighter(catalogExpr(arg), "or")).join(" OR "), "or")
		case "not":
			return printed(`NOT ${wrap(catalogExpr(e.expr), "not")}`, "not")
		case "in":
			return printed(
				`${wrap(catalogExpr(e.expr), "other")} ${e.not ? "NOT IN" : "IN"} (${catalogExprs(e.list)})`,
				"between"
			)
		case "any":
			return printed(
				`${wrap(catalogExpr(e.expr), "other")} = ANY (${catalogExpr(e.array).text})`,
				"compare"
			)
		case "exists":
			return e.not
				? printed(`NOT EXISTS (${catalogSelectText(e.query)})`, "not")
				: printed(`EXISTS (${catalogSelectText(e.query)})`, "atom")
		case "scalar":
			return printed(`(${catalogSelectText(e.query)})`, "atom")
		case "case": {
			const parts = ["CASE"]
			if (e.operand !== undefined) {
				parts.push(catalogExpr(e.operand).text)
			}
			for (const branch of e.whens) {
				parts.push(`WHEN ${catalogExpr(branch.when).text} THEN ${catalogExpr(branch.result).text}`)
			}
			if (e.else !== undefined) {
				parts.push(`ELSE ${catalogExpr(e.else).text}`)
			}
			parts.push("END")
			return printed(parts.join(" "), "atom")
		}
		case "coalesce":
			return printed(`COALESCE(${catalogExprs(e.args)})`, "atom")
		case "array":
			return printed(
				`ARRAY[${catalogExprs(e.items)}]::${printCatalogCast({ ...e.type, array: true })}`,
				"cast"
			)
		case "collateC":
			return printed(`${wrap(catalogExpr(e.expr), "collate")} COLLATE ${inCatalog("C")}`, "collate")
		case "currentUser":
			return printed("CURRENT_USER", "atom")
		case "regclass":
			return printed(regclassText(e.relation), "cast")
		case "arithmetic":
			return printed(`(${catalogExpr(e.left).text} ${e.op} ${catalogExpr(e.right).text})`, "atom")
	}
}

const catalogFrom = (item: CatalogFrom): string => {
	switch (item.kind) {
		case "catalog":
			return `${inCatalog(item.relation)} AS ${quoteIdent(item.alias)}`
		case "object":
			return `${printObjectName(item.name)} AS ${quoteIdent(item.alias)}`
		case "cte":
			return `${quoteIdent(item.name)} AS ${quoteIdent(item.alias)}`
		case "function":
			return `${item.lateral ? "LATERAL " : ""}${catalogCall(item.call)} AS ${quoteIdent(item.alias)}(${printIdentList(item.columns)})`
		case "rowsFrom":
			return `ROWS FROM (${item.calls.map(catalogCall).join(", ")}) AS ${quoteIdent(item.alias)}(${printIdentList(item.columns)})`
		case "values":
			return `(VALUES ${item.rows.map((row) => `(${catalogExprs(row)})`).join(", ")}) AS ${quoteIdent(item.alias)}(${printIdentList(item.columns)})`
		case "constantElements":
			return `${inCatalog("unnest")}(${printObjectName(item.constant)}()) WITH ORDINALITY AS ${quoteIdent(item.alias)}(${printIdentList(["element", "position"])})`
		case "join": {
			const right =
				item.right.kind === "join" || item.right.kind === "crossJoin"
					? `(${catalogFrom(item.right)})`
					: catalogFrom(item.right)
			return `${catalogFrom(item.left)} JOIN ${right} ON ${catalogExpr(item.on).text}`
		}
		case "crossJoin": {
			const right =
				item.right.kind === "join" || item.right.kind === "crossJoin"
					? `(${catalogFrom(item.right)})`
					: catalogFrom(item.right)
			return `${catalogFrom(item.left)} CROSS JOIN ${right}`
		}
	}
}

/** One arm of a catalog read, its INTO variables after its targets, as PL/pgSQL's SELECT INTO writes them. */
const catalogCoreText = (core: CatalogCore, into: ReadonlyArray<string>): string => {
	const clauses = [
		`SELECT ${catalogExprs(core.targets)}${into.length === 0 ? "" : ` INTO ${printIdentList(into)}`}`
	]
	if (core.from.length > 0) {
		clauses.push(`FROM ${core.from.map(catalogFrom).join(", ")}`)
	}
	if (core.where !== undefined) {
		clauses.push(`WHERE ${catalogExpr(core.where).text}`)
	}
	if (core.groupBy.length > 0) {
		clauses.push(`GROUP BY ${catalogExprs(core.groupBy)}`)
	}
	if (core.having !== undefined) {
		clauses.push(`HAVING ${catalogExpr(core.having).text}`)
	}
	if (core.orderBy.length > 0) {
		clauses.push(`ORDER BY ${catalogExprs(core.orderBy)}`)
	}
	if (core.limit !== undefined) {
		clauses.push(`LIMIT ${core.limit.toString()}`)
	}
	return clauses.join(" ")
}

/** A catalog read on one line: its CTEs, then the UNION of its arms, each with its own ORDER BY or LIMIT parenthesized. */
const catalogSelectText = (select: CatalogSelect): string => {
	const ctes =
		select.with.length === 0
			? ""
			: `WITH ${select.with.map((c) => `${quoteIdent(c.name)}(${printIdentList(c.columns)}) AS (${catalogSelectText(c.query)})`).join(", ")} `
	const several = select.arms.length > 1
	const arms = select.arms.map((arm) => {
		const text = catalogCoreText(arm, [])
		return several && (arm.orderBy.length > 0 || arm.limit !== undefined) ? `(${text})` : text
	})
	return `${ctes}${arms.join(" UNION ")}`
}

/** What an EXECUTE runs: a statement printed and quoted, or the text an expression computes. */
const executedText = (
	command: Extract<DoStatement, { readonly kind: "execute" }>["command"]
): string => {
	switch (command.kind) {
		case "statement":
			return quoteString(catalogSelectText(command.statement))
		case "formatted":
			return printExpr(command.text)
	}
}

const doStatement = (out: Lines, statement: DoStatement): void => {
	switch (statement.kind) {
		case "selectInto":
			return out.line(`${catalogCoreText(statement.query, statement.into)};`)
		case "execute": {
			const into = statement.into === undefined ? "" : ` INTO ${quoteIdent(statement.into)}`
			const using =
				statement.using.length === 0
					? ""
					: ` USING ${statement.using.map((e) => printExpr(e)).join(", ")}`
			return out.line(`EXECUTE ${executedText(statement.command)}${into}${using};`)
		}
		case "if": {
			for (const [i, branch] of statement.branches.entries()) {
				out.line(`${i === 0 ? "IF" : "ELSIF"} ${printExpr(branch.condition)} THEN`)
				doStatements(out.nested(), branch.body)
			}
			if (statement.else.length > 0) {
				out.line("ELSE")
				doStatements(out.nested(), statement.else)
			}
			return out.line("END IF;")
		}
		case "perform":
			return performLine(out, statement.query)
		case "raise":
			return out.line(raiseText(statement))
	}
}

const doStatements = (out: Lines, statements: ReadonlyArray<DoStatement>): void => {
	for (const statement of statements) {
		doStatement(out, statement)
	}
}

/** DO and a catalog-language block, dollar-quoted under a tag its body does not hold. */
const writeDo = (out: Lines, block: DoBlock): void => {
	const body: Array<string> = []
	proceduralBlock(new BlockLines(body, sqlUnit, ""), block.declare, block.body, doStatement)
	quotedLines(out, "DO", body)
}

/** A statement of the catalog language (sql/catalog.ts), written into `out`: a read on one line, a DO block nested. */
const writeCatalogStatement = (out: Lines, statement: CatalogStatement): void => {
	switch (statement.kind) {
		case "catalogSelect":
			return out.line(catalogSelectText(statement))
		case "setClosedSearchPath":
			return out.line(`SET LOCAL search_path TO ${printedSearchPath}`)
		case "do":
			return writeDo(out, statement)
		case "dropSchemas":
			return out.line(`DROP SCHEMA ${printIdentList(statement.schemas)} CASCADE`)
		case "adoptRoles":
			return out.line(
				`GRANT ${statement.roles.map(quoteIdent).join(", ")} TO CURRENT_ROLE WITH INHERIT TRUE, SET FALSE`
			)
		case "endHolders":
			return writeEndHolders(out, mapNonEmpty(statement.roles, quoteString))
		case "dropOwned":
			return out.line(`DROP OWNED BY ${statement.roles.map(quoteIdent).join(", ")}`)
		case "dropRoles":
			return out.line(`DROP ROLE ${statement.roles.map(quoteIdent).join(", ")}`)
		case "listen":
			return out.line(`LISTEN ${quoteIdent(statement.channel)}`)
	}
}

const catalogTextLoc = SourceLoc("catalog statement text", [])

/**
 * One catalog statement's text, without a terminator: what a driver sends (statementText). Its placeholders are the
 * catalog language's few, each written where its read is (sql/catalog.ts), so none is counted.
 */
export const printCatalogStatement = (statement: CatalogStatement): string =>
	statementText(catalogTextLoc, (out) => writeCatalogStatement(out, statement))

/** A PL/pgSQL block as a DO statement, dollar-quoted as a function body is. */
export const writeDoBlock = (out: Lines, block: PlBlock): void => dollarQuoted(out, "DO", block)

/** Lines commented out at the printer's indentation unit, written into `out`. */
export const commented = (out: Lines): Lines => new CommentedLines(out, sqlUnit, "")

/** The lines `write` writes, the last ending in `;`: each command of a statement of several but its last (writeStatement). */
const terminated = (out: Lines, write: (out: Lines) => void): void => {
	const lines: Array<string> = []
	write(new BlockLines(lines, sqlUnit, ""))
	for (const [i, line] of lines.entries()) {
		out.line(i === lines.length - 1 ? `${line};` : line)
	}
}

/** The SQL text `write` writes, refused (ResourceBound, stringLength) past V8's longest string. */
export const sqlText = (at: SourceLoc, write: (out: Lines) => void): string => {
	return unwrap(textOf(maxStringLength, sqlUnit, at, write))
}

/**
 * The SQL text `write` writes, a file's, as its chunks (core/lines.ts chunkedTextOf), never joined into one string, so
 * no length bounds it: a drafted migration file (deploy/render/sql.ts renderFile), written a chunk at a time.
 */
export const sqlChunks = (write: (out: Lines) => void): TextChunks => chunkedTextOf(sqlUnit, write)

/**
 * The text of one statement a driver sends, `write`'s (sqlText): refused (ResourceBound, statementBytes) when its UTF-8
 * bytes are more than PostgreSQL's longest message, messageMaxBytes, which no message holding it could fit.
 */
export const statementText = (at: SourceLoc, write: (out: Lines) => void): string => {
	const text = sqlText(at, write)
	const bytes = utf8Length(text)
	if (bytes > messageMaxBytes) {
		throw new Refusal(
			resourceBound(at, { kind: "statementBytes", limit: messageMaxBytes, needed: bytes })
		)
	}
	return text
}

/** Refuses (ResourceBound, statementParams) a statement that binds more parameters than a Bind message counts. */
const boundParams = (statement: SqlStatement): void => {
	const params = statementParams(statement)
	if (params > statementMaxParams) {
		throw new Refusal(
			resourceBound(statementTextLoc, {
				kind: "statementParams",
				limit: statementMaxParams,
				needed: params
			})
		)
	}
}

/**
 * One statement's text, without a terminator, as a file holds it (writeStatement): its commands, each but the last
 * terminated (statementText), refused when it binds more parameters than a Bind message counts (boundParams). A
 * statement of one command is what a driver sends; a driver sends any statement as printCommands.
 */
export const printStatement = (statement: SqlStatement): string => {
	boundParams(statement)
	return statementText(statementTextLoc, (out) => writeStatement(out, statement))
}

/**
 * A statement's commands (commandsOf), each one's text without a terminator: what a driver sends, one protocol message
 * each, since an extended-protocol message carries one command (42601, cannot insert multiple commands into a prepared
 * statement). Refused as printStatement is.
 */
export const printCommands = (statement: SqlStatement): NonEmptyReadonlyArray<string> => {
	boundParams(statement)
	return mapNonEmpty(commandsOf(statement), (command) => statementText(statementTextLoc, command))
}
