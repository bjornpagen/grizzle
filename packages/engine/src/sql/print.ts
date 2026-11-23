import {
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
	type ClockInstant,
	type CatalogTypeName,
	catalogSpelling,
	closedSearchPath,
	type ColumnDef,
	type ColumnDefinition,
	type CreateCarrier,
	type FromSource,
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
	type PerformQuery,
	type PlBlock,
	type PlDeclaration,
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
import { statementParams } from "#compiler/sql/transform.ts"

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
 * `grizzle generate` commits, the one way a statement prints an installation's role. Migrate fills it with the role the
 * installation's role space installs (deploy/render/variables.ts resolveVariables), so one drafted file installs under every
 * role space, and one never filled is a syntax error, never another role.
 */
const printRole = (stem: string): string => `:${quoteIdent(stem)}`

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
 * The instant a reading counts (sql/ast.ts ClockInstant): the call's transaction's, or that instant plus its offset's
 * microseconds as an interval, `<n> microseconds`, which interval input reads as exactly n, an int64 of the unit
 * (REL_19_0 src/backend/utils/adt/datetime.c DecodeInterval, strtoi64 then AdjustMicroseconds), where interval * float8
 * would round an offset past 2^53, so the sum is exact and a moved instant timestamptz cannot hold is PostgreSQL's
 * refusal, every reading of it inside the clock's range (core/clock.ts clockReadingRange).
 */
const printInstant = (instant: ClockInstant): string => {
	const began = `${inCatalog("transaction_timestamp")}()`
	switch (instant.kind) {
		case "transaction":
			return began
		case "moved":
			return `(${began} + ${inCatalog("format")}(${printLiteral({ kind: "text", value: "%s microseconds" }, types.text).text}, ${printExpr(instant.offset)})::${inCatalog("interval")})`
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
				`${wrap(expr(e.expr), "other")} ${keyword} (${printSelectInline(e.query)})`,
				"between"
			)
		}
		case "exists":
			return e.not
				? printed(`NOT EXISTS (${printSelectInline(e.query)})`, "not")
				: printed(`EXISTS (${printSelectInline(e.query)})`, "atom")
		case "subquery":
			return printed(`(${printSelectInline(e.query)})`, "atom")
		case "array":
			return printed(`ARRAY(${printSelectInline(e.query)})`, "atom")
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
const printArrayColumn = ({ definition, array, check }: ArrayColumn): string => {
	const elements =
		check.kind === "domain"
			? `$${array.number}::${arrayOf(check.domain)}::${arrayOf(definition.type)}`
			: `$${array.number}::${arrayOf(definition.type)}`
	const collated =
		definition.collation === undefined
			? elements
			: `${elements} COLLATE ${printObjectName(definition.collation)}`
	const unnest = `${inCatalog("unnest")}(${collated})`
	const typed = hasTypmod(definition.type) ? `${unnest}::${printType(definition.type)}` : unnest
	return `${typed} AS ${quoteIdent(definition.name)}`
}

/**
 * A relation input's arrays (sql/ast.ts ArraysSource) in the select-list form, every function qualified:
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
			return `${lateral}(${printSelectInline(item.query)}) AS ${quoteIdent(item.alias)}${aliasList(item.columns)}`
		}
		case "function": {
			const lateral = item.lateral ? "LATERAL " : ""
			const numbered = item.ordinality ? " WITH ORDINALITY" : ""
			return `${lateral}${printCall(item.call).text}${numbered} AS ${quoteIdent(item.alias)}${aliasList(item.columns)}`
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

const coreClauses = (out: Lines, core: SelectCore, keyword: "SELECT" | "PERFORM"): void => {
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
const nestedSelect = (select: OperandSelect): string => `(${printSelectInline(select)})`

const bodyInline = (body: OperandBody): string => {
	switch (body.kind) {
		case "core":
			return inlineText((row) => coreClauses(row, body, "SELECT"))
		case "select":
			return nestedSelect(body)
		case "setOp":
			return body.arms.map((arm) => bodyInline(arm)).join(` ${body.op} `)
	}
}

const bodyBlock = (out: Lines, body: OperandBody): void => {
	switch (body.kind) {
		case "core":
			return coreClauses(out, body, "SELECT")
		case "select":
			return out.line(nestedSelect(body))
		case "setOp":
			for (const [i, arm] of body.arms.entries()) {
				if (i > 0) {
					out.line(body.op)
				}
				bodyBlock(out, arm)
			}
	}
}

const withInline = (w: With): string => {
	const ctes = w.ctes.map((cte) => `${cteHead(cte)} (${cteBodyInline(cte.query)})`).join(", ")
	return `WITH ${w.recursive ? "RECURSIVE " : ""}${ctes}`
}

const cteHead = (cte: Cte): string => {
	const materialized = cte.materialized === undefined ? "" : ` ${cte.materialized}`
	return `${quoteIdent(cte.name)}${aliasList(cte.columns)} AS${materialized}`
}

/** A data-modifying body keeps its own WITH, which PostgreSQL accepts inside the CTE's parentheses. */
const cteBodyInline = (query: CteBody): string =>
	query.kind === "select"
		? printSelectInline(query)
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
const cteBodyBlock = (out: Lines, query: CteBody): void =>
	query.kind === "select" ? out.line(printSelectInline(query)) : dmlStatementBlock(out, query)

/** A CTE as its WITH block writes it: `open` and its head on its first line, its body a level deeper, and its closing
 * parenthesis and `close` on its last. */
const cteBlock = (out: Lines, cte: Cte, open: string, close: string): void => {
	out.line(`${open}${cteHead(cte)} (`)
	cteBodyBlock(out.nested(), cte.query)
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
	sqlText(statementTextLoc, (out) => coreClauses(out, core, "SELECT"))

const printSelectInline = (select: OperandSelect): string =>
	inlineText((out) => {
		if (select.with !== undefined) {
			out.line(withInline(select.with))
		}
		out.line(bodyInline(select.body))
		tailClauses(out, select)
	})

const selectBlock = (out: Lines, select: OperandSelect): void => {
	if (select.with !== undefined) {
		withBlock(out, select.with)
	}
	bodyBlock(out, select.body)
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
			? printSelectInline(insert.source.query)
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
export const sessionTableCreate = (
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
 * That the session's relation named `name` is a temporary table CURRENT_USER owns (`ownedSessionTable`), read with
 * `from` beside its pg_class row, r2, where each of `more` holds of it.
 */
const sessionTableOurs = (
	name: string,
	from: ReadonlyArray<FromSource>,
	more: ReadonlyArray<Expr>
): Expr =>
	exists(
		simpleSelect(
			[],
			[{ kind: "table", table: objectName("pg_catalog", "pg_class"), alias: "r2" }, ...from],
			and([eq(col("r2", "oid"), sessionRegclass(name)), ...ownedSessionTable("r2"), ...more])
		)
	)

/**
 * Which of the session's tables `names` stand: each as its name where it is a temporary table CURRENT_USER owns
 * (`ownedSessionTable`) of which each of `more(r1)` holds, and as `!` and its name where it stands otherwise, a table
 * some other role made under it, all of them read by one statement over pg_catalog.pg_class, so a site that stands up
 * several session tables plans one read of the catalog (physical/ddl/rules.ts standing):
 *
 *   ARRAY(SELECT CASE WHEN <owned r1> AND <more> THEN r1.relname::text ELSE '!' || r1.relname::text END
 *     FROM pg_catalog.pg_class AS r1 WHERE r1.oid IN (pg_catalog.to_regclass('"pg_temp"."<name>"'), ...))
 */
export const sessionTablesStanding = (
	names: NonEmptyReadonlyArray<string>,
	more: (alias: string) => ReadonlyArray<Expr>
): Expr => {
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
							whens: [{ when: and([...ownedSessionTable("r1"), ...more("r1")]), result: name }],
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

/** That the session's temporary schema holds a relation named `name`: what a session table's stand-up asks. */
const sessionTableStands = (name: string): Expr =>
	exists(
		simpleSelect(
			[],
			[{ kind: "table", table: objectName("pg_catalog", "pg_class"), alias: "r1" }],
			eq(col("r1", "oid"), sessionRegclass(name))
		)
	)

/**
 * The most bytes a session table's heap, and its TOAST table's heap, hold that its emptying keeps rather than gives back
 * (`sessionTableEmptied`): one page, the page every insert into it reuses. An insert goes to the relation's target page,
 * then to a page its free space map records, and otherwise extends it (REL_19_0 src/backend/access/heap/hio.c 577, 585,
 * 769). Nothing writes a session table's free space map: autovacuum never processes another backend's temporary table
 * (src/backend/postmaster/autovacuum.c 2078, 2175), and pruning on access records a page's free space only where it
 * makes the page all-visible (src/backend/access/heap/pruneheap.c 386-413), which a page whose deleted rows left their
 * line pointers dead never is. So the target page, the last, is the one page a later insert fills again: a table of one
 * page holds nothing a TRUNCATE would give back, and every page of a longer one before its last is space no insert
 * reaches again, which only a TRUNCATE gives back.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the heap of one session table, a rule judge's delta or a write's carrier, and its TOAST table's heap, each as
 *   one of its uses ends
 * @derivation one page: the target page every insert reuses, past which no page is reused (hio.c's choice of a page)
 * @from {@link blockSize}
 */
const sessionTableKeptBytes = blockSize

/**
 * That the session's table `name` holds more than its one reused page (sessionTableKeptBytes) in its heap or in its
 * TOAST table's heap, each as the size of its file, which pg_relation_size reads by a stat and no page: a table with no
 * TOAST table has a reltoastrelid of 0, whose size it answers NULL, so its heap alone decides.
 *
 *   EXISTS (SELECT FROM pg_catalog.pg_class AS r1 WHERE r1.oid = pg_catalog.to_regclass('"pg_temp"."<name>"')
 *     AND (pg_catalog.pg_relation_size(r1.oid) > 8192 OR pg_catalog.pg_relation_size(r1.reltoastrelid) > 8192))
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
 * emptied) or a write's carrier before its use fills it (`carrierStandUp`): by DELETE while its heap and its TOAST
 * table's each hold one page at most (sessionTableKeptBytes), and by TRUNCATE once either holds more.
 *
 *   IF <it holds more than its page (sessionTableOvergrown)> THEN TRUNCATE pg_temp.<name>;
 *   ELSE DELETE FROM pg_temp.<name> AS r1; END IF;
 *
 * A DELETE keeps the table's file, so it sends no invalidation: a TRUNCATE of a table made in an earlier transaction
 * gives it, its TOAST table and that table's index each a new file (src/backend/commands/tablecmds.c 2245-2272
 * RelationSetNewRelfilenumber), a pg_class row updated for each, and the relcache invalidations of each reach every
 * backend of the database (src/backend/utils/cache/inval.c 88-95: a session's own table's among them), each of which
 * then walks every plan it holds (src/backend/utils/cache/plancache.c 2131 PlanCacheRelCallback). A session of 30,000
 * saved plans paid 86 ms of a commit that truncated five deltas, and an idle one beside it 44 ms more (SESSIONTEMP,
 * 2026-11-21), where a DELETE cost 1 ms and the other session nothing. The rows the DELETE leaves dead take their
 * page's space until a read prunes it, and their line pointers stay, so a table refilled use after use outgrows its one
 * reused page, and the use that finds it so truncates it: the TRUNCATE is paid once a page's worth of rows, never at
 * each use. Every row is gone either way: a later transaction sees none, and one that rolls back takes its rows and
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
 * A write program's carrier stood up for its use, as one DO block: made where the session holds none, ON COMMIT
 * PRESERVE ROWS, every column NOT NULL and its key its own, and emptied where it stands (`sessionTableEmptied`), so the
 * use's fills meet no row of an earlier one; a write's transaction past the session's first therefore makes and drops
 * no relation, whose catalog rows, a carrier's columns, type and key, overflowed PostgreSQL's shared invalidation queue
 * (4096 messages) at every COMMIT that dropped them and reset every cache of the session, the rule judge's cached plans
 * among them, which the next COMMIT made again. A carrier holds no row its use did not write: the use empties it first,
 * a transaction that rolls back takes its rows and its emptying with it, and one that commits leaves its rows to the
 * next use, which empties them. The emptying keeps the carrier's file while it holds its one reused page, so a use
 * sends no invalidation, and gives the file back once it holds more: a session's carriers hold at most one use's rows
 * and a page.
 */
const carrierStandUp = (carrier: CreateCarrier): PlBlock => ({
	declare: [],
	body: [
		{
			kind: "if",
			branches: [
				{
					condition: not(sessionTableStands(carrier.name)),
					body: [
						{
							kind: "createSessionTable",
							name: carrier.name,
							columns: carrier.columns.map((c) => ({
								name: c.name,
								type: c.type,
								collation: c.collation
							})),
							notNull: true,
							primaryKey: carrier.primaryKey,
							storage: "toasted"
						}
					]
				},
				{
					condition: not(sessionTableOurs(carrier.name, [], [])),
					body: [
						{
							kind: "raise",
							message: "a session carrier of the write that another role made",
							using: [
								{ option: "ERRCODE", value: lit.text("insufficient_privilege", types.text) },
								{ option: "SCHEMA", value: lit.text(temporarySchema, types.text) },
								{ option: "TABLE", value: lit.text(carrier.name, types.text) }
							]
						}
					]
				}
			],
			else: [sessionTableEmptied(carrier.name)]
		}
	]
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
			coreClauses(row, query.body, "PERFORM")
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
				`FOR ${quoteIdent(statement.variable)} IN ${printSelectInline(statement.query)} LOOP`
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
		case "truncateSessionTable":
			return out.line(`TRUNCATE ${sessionTableName(statement.name)};`)
		case "createSessionTrigger":
			return out.line(
				`CREATE CONSTRAINT TRIGGER ${quoteIdent(statement.name)} AFTER INSERT ON ${printTableName({ schema: temporarySchema, name: statement.table })} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${printObjectName(statement.function)}();`
			)
		case "whenFound":
			out.line(`PERFORM 1 FROM ${nestedSelect(statement.query)} AS ${quoteIdent("found")};`)
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

/**
 * The source PostgreSQL stores of a PL/pgSQL function this printer writes, its pg_proc.prosrc: the value of the
 * dollar-quoted string between `AS <tag>` and `<tag>`, each on a line of its own (dollarQuoted), so a line feed begins
 * and ends it around the block's lines. A drafted file that spells the body as an escape string (deploy/render/filed.ts)
 * spells this value too.
 */
export const functionSource = (block: PlBlock): string => `\n${blockLines(block).join("\n")}\n`

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

/** A function's parallel safety as its clause, after its volatility: none for UNSAFE, PostgreSQL's own default. */
const parallelClause = (parallel: CreateFunction["parallel"]): string =>
	parallel === "SAFE" ? " PARALLEL SAFE" : ""

const createFunctionBlock = (out: Lines, fn: CreateFunction): void => {
	out.line(
		`CREATE OR REPLACE FUNCTION ${printObjectName(fn.name)}(${fn.params.map((p) => `${quoteIdent(p.name)} ${printType(p.type)}`).join(", ")}) RETURNS ${printReturns(fn.returns)}`
	)
	out.line(
		`LANGUAGE ${fn.language} ${fn.volatility}${parallelClause(fn.parallel)} SECURITY ${fn.security} SET search_path = ${printedSearchPath}`
	)
	switch (fn.language) {
		case "plpgsql":
			return dollarQuoted(out, "AS", fn.body)
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
		`LANGUAGE ${fn.language} ${fn.volatility}${fn.nullInput === undefined ? "" : ` ${fn.nullInput}`} SECURITY DEFINER SET search_path = ${declaredSearchPath(fn.name.schema)}`
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

/** The line a literal pack's comment begins with (writePack), which `grizzle check` finds it by. */
const literalPackComment = "-- closed constant: "

/** What separates a literal pack's function from its body: the head every constant has after its name. */
const literalPackBody = `() RETURNS ${printType(types.varbit)} ${constantClauses} RETURN `

/** The cast that ends a literal pack's body. */
const literalPackEnd = `'::${printType(types.varbit)}`

/**
 * A closed relation's constant (sql/ast.ts PackConstant), one statement whose body is the constant itself as one hex
 * literal:
 *
 *   -- closed constant: <rows> rows in <cells> cells of <width> bits, content <digest>
 *   CREATE FUNCTION <function>() RETURNS bit varying LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN X'<hex>'::bit varying
 *
 * the statement on one line, and X'' for a constant of no bit. The comment states what `grizzle check` holds the
 * literal to (readLiteralPack): its rows, its layout, and its content's digest, which the function's name digests in
 * turn.
 */
const writePack = (out: Lines, pack: PackConstant): void => {
	out.line(
		`${literalPackComment}${pack.rows} rows in ${pack.cells} cells of ${pack.width} bits, content ${pack.digest}`
	)
	out.line(
		`CREATE FUNCTION ${printObjectName(pack.function)}${literalPackBody}${hexConstant(pack.hex)}::${printType(types.varbit)}`
	)
}

/** A literal pack as its printed statement states it (readLiteralPack): its function's printed name and its digits. */
export interface LiteralPackText {
	readonly function: string
	readonly rows: bigint
	readonly cells: bigint
	readonly width: bigint
	readonly digest: string
	readonly hex: string
}

/** A text of decimal digits as the whole number it spells, none for any other text. */
const wholeNumber = (text: string): bigint | undefined =>
	text !== "" && isAsciiDigits(text, 0, text.length) ? BigInt(text) : undefined

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

/** A literal pack's body, its one hex constant to the end of the statement; none for any other text. */
const literalDigits = (body: string): string | undefined => {
	const hex = between(body, "X'", literalPackEnd)
	return hex?.rest === "" ? hex.inner : undefined
}

/**
 * A statement of a migration file read as a literal pack, writePack's printed form, its leading comment
 * included and its terminator not; none for any statement that does not begin with a literal pack's comment. A
 * statement that begins with one but departs from the form anywhere is none too, so a pack whose text was edited out of
 * its form is no pack a reader trusts, which `grizzle check` refuses as it refuses a changed one (cli/check.ts).
 */
export const readLiteralPack = (statement: string): LiteralPackText | undefined => {
	const comment = between(statement.trimStart(), literalPackComment, "\n")
	const rows = comment === undefined ? undefined : between(comment.inner, "", " rows in ")
	const cells = rows === undefined ? undefined : between(rows.rest, "", " cells of ")
	const width = cells === undefined ? undefined : between(cells.rest, "", " bits, content ")
	const head =
		comment === undefined
			? undefined
			: between(comment.rest.trim(), "CREATE FUNCTION ", literalPackBody)
	const hex = head === undefined ? undefined : literalDigits(head.rest)
	const counted = {
		rows: rows === undefined ? undefined : wholeNumber(rows.inner),
		cells: cells === undefined ? undefined : wholeNumber(cells.inner),
		width: width === undefined ? undefined : wholeNumber(width.inner)
	}
	if (
		width === undefined ||
		head === undefined ||
		hex === undefined ||
		counted.rows === undefined ||
		counted.cells === undefined ||
		counted.width === undefined
	) {
		return undefined
	}
	return {
		function: head.inner,
		rows: counted.rows,
		cells: counted.cells,
		width: counted.width,
		digest: width.rest,
		hex
	}
}

/** Whether a statement of a migration file begins as a literal pack does: what `grizzle check` holds to the form. */
export const looksLikeLiteralPack = (statement: string): boolean =>
	statement.trimStart().startsWith(literalPackComment)

/** What a COMMENT names, as it prints after COMMENT ON, and as `grizzle names` lists it. */
export const printCommentTarget = (on: CommentTarget): string => {
	switch (on.kind) {
		case "SCHEMA":
			return `SCHEMA ${quoteIdent(on.name)}`
		case "ROLE":
			return `ROLE ${printRole(on.name)}`
		case "TABLE":
		case "VIEW":
		case "MATERIALIZED VIEW":
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
			return writeDoBlock(out, carrierStandUp(statement))
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
				case "MATERIALIZED VIEW":
				case "DOMAIN":
				case "STATISTICS":
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
		case "createMaterializedView":
			out.line(
				`CREATE MATERIALIZED VIEW ${printObjectName(statement.name)} (${printIdentList(statement.columns)}) AS`
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
		case "createStatistics": {
			const kinds = statement.statistics.length === 0 ? "" : ` (${statement.statistics.join(", ")})`
			return out.line(
				`CREATE STATISTICS ${printObjectName(statement.name)}${kinds} ON ${printIdentList(statement.columns)} FROM ${printObjectName(statement.table)}`
			)
		}
		case "comment":
			return out.line(
				`COMMENT ON ${printCommentTarget(statement.on)} IS ${quoteString(statement.text)}`
			)
		case "lockTable":
			return out.line(
				`LOCK TABLE ${statement.tables.map(printObjectName).join(", ")} IN ${statement.mode} MODE${statement.wait === "nowait" ? " NOWAIT" : ""}`
			)
		case "beginRead":
			return out.line(
				`BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY${statement.deferrable ? " DEFERRABLE" : ""}`
			)
		case "beginWrite":
			return out.line(`BEGIN ISOLATION LEVEL ${isolationLevels[statement.isolation]}`)
		case "commit":
			return out.line("COMMIT")
		case "rollback":
			return out.line("ROLLBACK")
		case "setConstraintsImmediate":
			return out.line("SET CONSTRAINTS ALL IMMEDIATE")
		case "refresh":
			return out.line(
				`REFRESH MATERIALIZED VIEW ${statement.concurrently ? "CONCURRENTLY " : ""}${printObjectName(statement.view)}`
			)
	}
}

/**
 * The commands `statement` is (Emitter): a statement that writes a catalog row another installation in the same
 * database writes too is the database lock's command and its own (databaseWide): the database default's block, every
 * ALTER DEFAULT PRIVILEGES, every CREATE EXTENSION, and a GRANT or REVOKE on the database or a schema (grantEmitter).
 * Every other statement is its own command alone. The one source of a statement's commands: a drafted file writes
 * them (writeStatement, deploy/render/sql.ts), meta.json records them (deploy/render/sql.ts recordFile), and a driver
 * sends them (printCommands), so none of the three can split a statement another way.
 */
export const commandsOf = (statement: SqlStatement): NonEmptyReadonlyArray<Command> => {
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
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "createSchema":
		case "createTable":
		case "createCarrier":
		case "alterTable":
		case "rename":
		case "replaceConstant":
		case "renameColumn":
		case "renameConstraint":
		case "createDomain":
		case "alterDomain":
		case "createIndex":
		case "dropIndex":
		case "createMaterializedView":
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
		case "createStatistics":
		case "comment":
		case "lockTable":
		case "beginRead":
		case "beginWrite":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
		case "refresh":
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
			return quoteString(
				command.statement.kind === "refresh"
					? printStatement(command.statement)
					: catalogSelectText(command.statement)
			)
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
