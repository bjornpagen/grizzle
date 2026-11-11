import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import type {
	AlterDatabaseDefault,
	CatalogTypeName,
	Expr,
	Grant,
	ObjectName,
	PlDeclaration,
	PlStatement,
	Refresh,
	Revoke
} from "#compiler/sql/ast.ts"
import { call as valueCall, core as valueCore, lit, target, types } from "#compiler/sql/build.ts"

/**
 * The catalog-read AST: the SQL grizzle's shell sends to read PostgreSQL's catalog (admission, drift, the ledger's
 * presence, the apply locks, the refresh's populated reads) and the DO blocks it runs, printed by the one printer
 * (sql/print.ts printCatalogStatement) and emitted through sql/emit.ts emitCatalog.
 *
 * A catalog read is its own language beside grizzle's value SQL (sql/ast.ts Expr): its types are catalog types (name,
 * oid, "char", the reg* types), its functions are catalog functions, and its descriptions leave a part out by NULL, a
 * CASE without ELSE or a scalar subquery of no row, which concat_ws skips. None of that is representable in a lowered
 * query or a table's DDL, and nothing here is in a snapshot. Every relation, function and type is a closed name of
 * pg_catalog's, printed qualified, so a read means one thing under every search_path.
 */

/** A pg_catalog relation a catalog read names: exactly those grizzle's reads name. */
export const catalogRelations = [
	"pg_attrdef",
	"pg_attribute",
	"pg_auth_members",
	"pg_class",
	"pg_collation",
	"pg_constraint",
	"pg_database",
	"pg_db_role_setting",
	"pg_default_acl",
	"pg_depend",
	"pg_enum",
	"pg_extension",
	"pg_index",
	"pg_namespace",
	"pg_policy",
	"pg_proc",
	"pg_rewrite",
	"pg_roles",
	"pg_sequence",
	"pg_settings",
	"pg_statistic_ext",
	"pg_trigger",
	"pg_type"
] as const
export type CatalogRelation = (typeof catalogRelations)[number]

/** A pg_catalog function a catalog read calls: exactly those grizzle's reads call. */
export const catalogFunctions = [
	"acldefault",
	"aclexplode",
	"array_agg",
	"bool_or",
	"concat_ws",
	"current_database",
	"current_setting",
	"format",
	"format_type",
	"has_column_privilege",
	"has_function_privilege",
	"has_schema_privilege",
	"has_sequence_privilege",
	"has_table_privilege",
	"has_type_privilege",
	"pg_advisory_unlock",
	"pg_encoding_to_char",
	"pg_get_constraintdef",
	"pg_get_expr",
	"pg_get_function_identity_arguments",
	"pg_get_functiondef",
	"pg_get_indexdef",
	"pg_get_ruledef",
	"pg_get_statisticsobjdef_expressions",
	"pg_get_triggerdef",
	"pg_get_userbyid",
	"pg_get_viewdef",
	"pg_input_is_valid",
	"pg_relation_filenode",
	"pg_try_advisory_lock",
	"quote_ident",
	"string_agg",
	"to_regnamespace",
	"to_regprocedure",
	"to_regtype",
	"unnest"
] as const
export type CatalogFunction = (typeof catalogFunctions)[number]

/** The type a catalog cast, parameter or literal is read as. */
export interface CatalogCast {
	readonly name: CatalogTypeName
	readonly array: boolean
}

/** A comparison of two catalog values. */
export type CatalogComparison = "=" | "<>" | "<" | "<=" | ">" | ">="

/** A function call of a catalog read. */
export interface CatalogCall {
	readonly kind: "call"
	readonly fn: CatalogFunction
	readonly args: ReadonlyArray<CatalogExpr>
}

/**
 * An expression of a catalog read. A CASE's undefined operand is none, and its undefined ELSE is NULL, which concat_ws
 * leaves out. A literal prints typed: a boolean typed boolean and a nonnegative integer typed integer bare, as
 * PostgreSQL types them itself, and every other one cast to its type.
 */
export type CatalogExpr =
	| { readonly kind: "column"; readonly from: string; readonly column: string }
	| { readonly kind: "param"; readonly number: number; readonly type: CatalogCast }
	| {
			readonly kind: "literal"
			readonly value: string | bigint | boolean
			readonly type: CatalogCast
	  }
	| { readonly kind: "cast"; readonly expr: CatalogExpr; readonly type: CatalogCast }
	| CatalogCall
	| { readonly kind: "countStar" }
	| {
			readonly kind: "joinedSet"
			readonly value: CatalogExpr
			readonly separator: CatalogExpr
	  }
	| {
			readonly kind: "compare"
			readonly op: CatalogComparison
			readonly left: CatalogExpr
			readonly right: CatalogExpr
	  }
	| { readonly kind: "distinctFrom"; readonly left: CatalogExpr; readonly right: CatalogExpr }
	| { readonly kind: "concat"; readonly parts: NonEmptyReadonlyArray<CatalogExpr> }
	| { readonly kind: "and" | "or"; readonly args: NonEmptyReadonlyArray<CatalogExpr> }
	| { readonly kind: "not"; readonly expr: CatalogExpr }
	| {
			readonly kind: "in"
			readonly expr: CatalogExpr
			readonly list: NonEmptyReadonlyArray<CatalogExpr>
			readonly not: boolean
	  }
	| { readonly kind: "any"; readonly expr: CatalogExpr; readonly array: CatalogExpr }
	| { readonly kind: "exists"; readonly query: CatalogSelect; readonly not: boolean }
	| { readonly kind: "scalar"; readonly query: CatalogSelect }
	| {
			readonly kind: "case"
			readonly operand: CatalogExpr | undefined
			readonly whens: NonEmptyReadonlyArray<{
				readonly when: CatalogExpr
				readonly result: CatalogExpr
			}>
			readonly else: CatalogExpr | undefined
	  }
	| { readonly kind: "coalesce"; readonly args: NonEmptyReadonlyArray<CatalogExpr> }
	| {
			/** ARRAY[<items>] cast to the array of `type`, so an empty list is typed too. */
			readonly kind: "array"
			readonly items: ReadonlyArray<CatalogExpr>
			readonly type: CatalogCast
	  }
	| {
			/** COLLATE "pg_catalog"."C": byte order, whatever the database's collation. */
			readonly kind: "collateC"
			readonly expr: CatalogExpr
	  }
	| { readonly kind: "currentUser" }
	| {
			/** A relation as a regclass value, by its qualified name (sql/ast.ts RegclassRef). */
			readonly kind: "regclass"
			readonly relation: ObjectName
	  }

/** A FROM item of a catalog read; a function's column alias list names its columns. */
export type CatalogFrom =
	| { readonly kind: "catalog"; readonly relation: CatalogRelation; readonly alias: string }
	| { readonly kind: "object"; readonly name: ObjectName; readonly alias: string }
	| { readonly kind: "cte"; readonly name: string; readonly alias: string }
	| {
			readonly kind: "function"
			readonly call: CatalogCall
			readonly alias: string
			readonly columns: NonEmptyReadonlyArray<string>
			readonly lateral: boolean
	  }
	| {
			readonly kind: "rowsFrom"
			readonly calls: NonEmptyReadonlyArray<CatalogCall>
			readonly alias: string
			readonly columns: NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "values"
			readonly rows: NonEmptyReadonlyArray<NonEmptyReadonlyArray<CatalogExpr>>
			readonly alias: string
			readonly columns: NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "join"
			readonly left: CatalogFrom
			readonly right: CatalogFrom
			readonly on: CatalogExpr
	  }
	| { readonly kind: "crossJoin"; readonly left: CatalogFrom; readonly right: CatalogFrom }

/**
 * One arm of a catalog read: an empty FROM, GROUP BY or ORDER BY is none, and an undefined WHERE, HAVING or LIMIT is
 * none. Its own ORDER BY, ascending, and LIMIT parenthesize it inside a UNION.
 */
export interface CatalogCore {
	readonly targets: NonEmptyReadonlyArray<CatalogExpr>
	readonly from: ReadonlyArray<CatalogFrom>
	readonly where: CatalogExpr | undefined
	readonly groupBy: ReadonlyArray<CatalogExpr>
	readonly having: CatalogExpr | undefined
	readonly orderBy: ReadonlyArray<CatalogExpr>
	readonly limit: number | undefined
}

/** A CTE of a catalog read: its name, the names of its columns, and its query. */
export interface CatalogCte {
	readonly name: string
	readonly columns: NonEmptyReadonlyArray<string>
	readonly query: CatalogSelect
}

/**
 * A catalog read: its CTEs, none when empty, then the UNION of its arms, a set union, so every read is a set of rows
 * whatever its arms hold: no catalog read can state the ALL form.
 */
export interface CatalogSelect {
	readonly kind: "catalogSelect"
	readonly with: ReadonlyArray<CatalogCte>
	readonly arms: NonEmptyReadonlyArray<CatalogCore>
}

/** What the drift transaction sets first: sql/ast.ts closedSearchPath, against which every description is spelled. */
export interface SetClosedSearchPath {
	readonly kind: "setClosedSearchPath"
}

/** The command a DO block's EXECUTE runs: a statement printed and quoted, or a text it computes. */
export type ExecutedCommand =
	| { readonly kind: "statement"; readonly statement: Refresh | CatalogSelect }
	| { readonly kind: "formatted"; readonly text: Expr }

/**
 * A statement of a DO block grizzle sends: a catalog read into its variables, an EXECUTE, an IF over DO statements, or
 * a PL/pgSQL PERFORM or RAISE. No installed function holds a catalog read or an EXECUTE, so a function body (sql/ast.ts
 * PlStatement) never holds one.
 */
export type DoStatement =
	| {
			readonly kind: "selectInto"
			readonly query: CatalogCore
			readonly into: NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "execute"
			readonly command: ExecutedCommand
			readonly into: string | undefined
			readonly using: ReadonlyArray<Expr>
	  }
	| {
			readonly kind: "if"
			readonly branches: NonEmptyReadonlyArray<{
				readonly condition: Expr
				readonly body: NonEmptyReadonlyArray<DoStatement>
			}>
			readonly else: ReadonlyArray<DoStatement>
	  }
	| Extract<PlStatement, { readonly kind: "perform" | "raise" }>

/** DO <block>: an anonymous PL/pgSQL block, dollar-quoted as a function body is. */
export interface DoBlock {
	readonly kind: "do"
	readonly declare: ReadonlyArray<PlDeclaration>
	readonly body: NonEmptyReadonlyArray<DoStatement>
}

/** Every statement of the catalog language: what sql/emit.ts emitCatalog emits. */
export type CatalogStatement = CatalogSelect | SetClosedSearchPath | DoBlock

/** A pg_catalog type, not an array. */
export const catalogType = (name: CatalogTypeName): CatalogCast => ({ name, array: false })

/** The array of a pg_catalog type. */
export const catalogArray = (name: CatalogTypeName): CatalogCast => ({ name, array: true })

/** A FROM item and the columns of the alias it introduces. */
export interface CatalogSource {
	readonly item: CatalogFrom
	readonly col: (column: string) => CatalogExpr
}

const source = (item: CatalogFrom, alias: string): CatalogSource => ({
	item,
	col: (column) => ({ kind: "column", from: alias, column })
})

/** A pg_catalog relation under `alias`. */
export const from = (relation: CatalogRelation, alias: string): CatalogSource =>
	source({ kind: "catalog", relation, alias }, alias)

/** A schema object, by its qualified name, under `alias`. */
export const fromObject = (name: ObjectName, alias: string): CatalogSource =>
	source({ kind: "object", name, alias }, alias)

/** A CTE of the read under `alias`. */
export const fromCte = (name: string, alias: string): CatalogSource =>
	source({ kind: "cte", name, alias }, alias)

/** A function's rows under `alias`, its columns named, LATERAL or not. */
export const fromFunction = (
	call: CatalogCall,
	alias: string,
	columns: NonEmptyReadonlyArray<string>,
	lateral: boolean
): CatalogSource => source({ kind: "function", call, alias, columns, lateral }, alias)

/** ROWS FROM (<calls>) under `alias`, its columns named. */
export const fromRows = (
	calls: NonEmptyReadonlyArray<CatalogCall>,
	alias: string,
	columns: NonEmptyReadonlyArray<string>
): CatalogSource => source({ kind: "rowsFrom", calls, alias, columns }, alias)

/** (VALUES <rows>) under `alias`, its columns named. */
export const fromValues = (
	rows: NonEmptyReadonlyArray<NonEmptyReadonlyArray<CatalogExpr>>,
	alias: string,
	columns: NonEmptyReadonlyArray<string>
): CatalogSource => source({ kind: "values", rows, alias, columns }, alias)

export const join = (left: CatalogFrom, right: CatalogFrom, on: CatalogExpr): CatalogFrom => ({
	kind: "join",
	left,
	right,
	on
})

export const crossJoin = (left: CatalogFrom, right: CatalogFrom): CatalogFrom => ({
	kind: "crossJoin",
	left,
	right
})

/** The placeholder $<number>, cast to `type`. */
export const param = (number: number, type: CatalogTypeName): CatalogExpr => ({
	kind: "param",
	number,
	type: catalogType(type)
})

/** The placeholder $<number>, cast to the array of `type`. */
export const arrayParam = (number: number, type: CatalogTypeName): CatalogExpr => ({
	kind: "param",
	number,
	type: catalogArray(type)
})

/** A literal of `type`. */
export const literal = (value: string | bigint | boolean, type: CatalogTypeName): CatalogExpr => ({
	kind: "literal",
	value,
	type: catalogType(type)
})

/** A text literal. */
export const text = (value: string): CatalogExpr => literal(value, "text")

/** A "char" literal, a catalog's one-letter code. */
export const letter = (value: string): CatalogExpr => literal(value, "char")

/** Each of `values` as a "char" literal: a catalog's set of one-letter codes. */
export const letters = (
	values: NonEmptyReadonlyArray<string>
): NonEmptyReadonlyArray<CatalogExpr> => {
	const [first, ...rest] = values
	return [letter(first), ...rest.map(letter)]
}

export const bool = (value: boolean): CatalogExpr => literal(value, "boolean")

export const cast = (expr: CatalogExpr, type: CatalogTypeName): CatalogExpr => ({
	kind: "cast",
	expr,
	type: catalogType(type)
})

/** `expr::text`, the one type every value of a read arrives as. */
export const asText = (expr: CatalogExpr): CatalogExpr => cast(expr, "text")

export const call = (fn: CatalogFunction, args: ReadonlyArray<CatalogExpr>): CatalogCall => ({
	kind: "call",
	fn,
	args
})

/**
 * The distinct texts `value` takes over the read's rows, ascending, joined by `separator`: `string_agg(DISTINCT value,
 * separator ORDER BY value)`. It aggregates a set, whatever the rows repeat, a catalog array that may hold an element
 * twice (pg_policy.polroles of `TO a, a`) included, and orders by the value itself, which DISTINCT requires.
 */
export const joinedSet = (value: CatalogExpr, separator: CatalogExpr): CatalogExpr => ({
	kind: "joinedSet",
	value,
	separator
})

export const countStar: CatalogExpr = { kind: "countStar" }

const compare =
	(op: CatalogComparison) =>
	(left: CatalogExpr, right: CatalogExpr): CatalogExpr => ({ kind: "compare", op, left, right })

export const eq = compare("=")
export const ne = compare("<>")
export const gt = compare(">")

export const distinctFrom = (left: CatalogExpr, right: CatalogExpr): CatalogExpr => ({
	kind: "distinctFrom",
	left,
	right
})

/** The parts joined by `||`. */
export const concat = (parts: NonEmptyReadonlyArray<CatalogExpr>): CatalogExpr => ({
	kind: "concat",
	parts
})

export const and = (args: NonEmptyReadonlyArray<CatalogExpr>): CatalogExpr => ({
	kind: "and",
	args
})
export const or = (args: NonEmptyReadonlyArray<CatalogExpr>): CatalogExpr => ({ kind: "or", args })
export const not = (expr: CatalogExpr): CatalogExpr => ({ kind: "not", expr })

export const inList = (
	expr: CatalogExpr,
	list: NonEmptyReadonlyArray<CatalogExpr>
): CatalogExpr => ({
	kind: "in",
	expr,
	list,
	not: false
})

export const notInList = (
	expr: CatalogExpr,
	list: NonEmptyReadonlyArray<CatalogExpr>
): CatalogExpr => ({ kind: "in", expr, list, not: true })

/** `expr = ANY (array)`. */
export const any = (expr: CatalogExpr, array: CatalogExpr): CatalogExpr => ({
	kind: "any",
	expr,
	array
})

export const exists = (query: CatalogSelect): CatalogExpr => ({ kind: "exists", query, not: false })
export const notExists = (query: CatalogSelect): CatalogExpr => ({
	kind: "exists",
	query,
	not: true
})

/** A scalar subquery: its one value, or NULL for no row. */
export const scalar = (query: CatalogSelect): CatalogExpr => ({ kind: "scalar", query })

/** CASE WHEN ... END, NULL where no WHEN holds and `otherwise` is undefined. */
export const caseWhen = (
	whens: NonEmptyReadonlyArray<{ readonly when: CatalogExpr; readonly result: CatalogExpr }>,
	otherwise: CatalogExpr | undefined
): CatalogExpr => ({ kind: "case", operand: undefined, whens, else: otherwise })

/** CASE <operand> WHEN ... END, NULL where no WHEN matches and `otherwise` is undefined. */
export const caseOf = (
	operand: CatalogExpr,
	whens: NonEmptyReadonlyArray<{ readonly when: CatalogExpr; readonly result: CatalogExpr }>,
	otherwise: CatalogExpr | undefined
): CatalogExpr => ({ kind: "case", operand, whens, else: otherwise })

export const coalesce = (args: NonEmptyReadonlyArray<CatalogExpr>): CatalogExpr => ({
	kind: "coalesce",
	args
})

/** ARRAY[<items>] as the array of `type`. */
export const array = (items: ReadonlyArray<CatalogExpr>, type: CatalogTypeName): CatalogExpr => ({
	kind: "array",
	items,
	type: catalogType(type)
})

export const collateC = (expr: CatalogExpr): CatalogExpr => ({ kind: "collateC", expr })

export const currentUser: CatalogExpr = { kind: "currentUser" }

/** A relation as a regclass value. */
export const regclass = (relation: ObjectName): CatalogExpr => ({ kind: "regclass", relation })

/** A pg_catalog relation as a regclass value. */
export const catalogRegclass = (relation: CatalogRelation): CatalogExpr =>
	regclass({ schema: "pg_catalog", name: relation })

/**
 * SELECT <targets> [FROM <from>] [WHERE <where>]: no GROUP BY, HAVING, ORDER BY or LIMIT. A caller that needs one
 * spreads the core and states it.
 */
export const core = (
	targets: NonEmptyReadonlyArray<CatalogExpr>,
	items: ReadonlyArray<CatalogFrom>,
	where: CatalogExpr | undefined
): CatalogCore => ({
	targets,
	from: items,
	where,
	groupBy: [],
	having: undefined,
	orderBy: [],
	limit: undefined
})

/** The UNION of `arms`, with no CTE. */
export const union = (arms: NonEmptyReadonlyArray<CatalogCore>): CatalogSelect => ({
	kind: "catalogSelect",
	with: [],
	arms
})

/** A read of one arm, with no CTE. */
export const select = (arm: CatalogCore): CatalogSelect => union([arm])

/** SELECT <targets> [FROM <from>] [WHERE <where>] as a read. */
export const query = (
	targets: NonEmptyReadonlyArray<CatalogExpr>,
	items: ReadonlyArray<CatalogFrom>,
	where: CatalogExpr | undefined
): CatalogSelect => select(core(targets, items, where))

/** A CTE of its name, its columns and its query. */
export const cte = (
	name: string,
	columns: NonEmptyReadonlyArray<string>,
	body: CatalogSelect
): CatalogCte => ({ name, columns, query: body })

/** `body` under the CTEs `ctes`, in order. */
export const withCtes = (
	ctes: NonEmptyReadonlyArray<CatalogCte>,
	body: CatalogSelect
): CatalogSelect => ({
	...body,
	with: ctes
})

/** SELECT 1 FROM <from> WHERE <where>: the read an EXISTS tests. */
export const anyRow = (items: ReadonlyArray<CatalogFrom>, where: CatalogExpr): CatalogSelect =>
	query([literal(1n, "integer")], items, where)

/** The current database's oid. */
export const currentDatabaseOid = (): CatalogExpr => {
	const b = from("pg_database", "b")
	return scalar(query([b.col("oid")], [b.item], eq(b.col("datname"), call("current_database", []))))
}

/** The oid of the role named by `name`, NULL when there is none. */
export const roleOid = (name: CatalogExpr): CatalogExpr => {
	const r = from("pg_roles", "r")
	return scalar(query([r.col("oid")], [r.item], eq(r.col("rolname"), name)))
}

/** The statement that sets the closed search path for the rest of the transaction. */
export const setClosedSearchPath: SetClosedSearchPath = { kind: "setClosedSearchPath" }

/**
 * An advisory lock grizzle takes, by what it serializes: the database default an installation sets, so concurrent
 * installations into one database set it one at a time (databaseDefaultBlock); the database's privileges an
 * installation grants or revokes, which every installation in the database writes on the database's one pg_database row,
 * one at a time alike (databasePrivilegeBlock); or the apply of one schema's
 * migrations, so two applies of the schema never interleave their files (adapter/migrate/apply.ts). Each lives in the
 * database's one bigint key space, which the application's own locks share, so its key is grizzle's by derivation from
 * its name (advisoryKey), never a chosen number, and is known on the host before any statement is sent: every statement
 * that takes or releases one prints its key as a literal.
 *
 * The advance function of a serial field (physical/ddl/advance.ts) takes the one advisory lock not here: it is keyed by
 * its sequence itself, the sequence's class and OID, which only the server knows, in the two-integer key space, which
 * no bigint key meets; a key derived from the sequence's name would join the same-named sequences of two schemas, or,
 * qualified by its schema, differ in the drift check's scratch replay, which moves the function into another schema.
 */
export type AdvisoryLock =
	| { readonly kind: "databaseDefault" }
	| { readonly kind: "databasePrivilege" }
	| { readonly kind: "apply"; readonly schema: string }

/**
 * The name of an advisory lock in grizzle's own namespace, whose digest is its key: one name per lock, since an apply
 * lock's name ends in `apply ` and its schema's name, and the database default's and the database privilege's do not.
 */
const advisoryLockName = (lock: AdvisoryLock): string => {
	switch (lock.kind) {
		case "databaseDefault":
			return "grizzle advisory lock: database default"
		case "databasePrivilege":
			return "grizzle advisory lock: database privilege"
		case "apply":
			return `grizzle advisory lock: apply ${lock.schema}`
	}
}

/**
 * The bytes of an advisory lock key, a PostgreSQL bigint, which pg_advisory_xact_lock, pg_try_advisory_lock and
 * pg_advisory_unlock take.
 *
 * @formatConstant PostgreSQL's bigint: a signed integer of 8 bytes
 */
const advisoryKeyBytes = 8

/**
 * The key of an advisory lock: the first advisoryKeyBytes bytes of the SHA-256 of its name (advisoryLockName,
 * core/sha256.ts), two hex digits each, read big-endian and wrapped to a signed integer of 8 * advisoryKeyBytes bits,
 * bigint's range. Another lock, grizzle's or the application's, meets it only by a collision of those 64 bits.
 */
export const advisoryKey = (lock: AdvisoryLock): bigint =>
	BigInt.asIntN(
		8 * advisoryKeyBytes,
		BigInt(`0x${sha256Hex(advisoryLockName(lock)).slice(0, 2 * advisoryKeyBytes)}`)
	)

/** PERFORM pg_advisory_xact_lock(<key>): `lock`, held to the end of the transaction. */
const advisoryXactLock = (lock: AdvisoryLock): DoStatement => ({
	kind: "perform",
	query: {
		body: valueCore(
			[target(valueCall("pg_advisory_xact_lock", [lit.int(advisoryKey(lock), types.bigint)]))],
			[],
			undefined
		),
		orderBy: [],
		limit: undefined,
		offset: undefined
	}
})

/**
 * The DO block that sets the current database's default (sql/ast.ts AlterDatabaseDefault): the database default's
 * advisory lock, then ALTER DATABASE of the database's own name, which format quotes as an identifier (`%I`).
 */
export const databaseDefaultBlock = (statement: AlterDatabaseDefault): DoBlock => ({
	kind: "do",
	declare: [],
	body: [
		advisoryXactLock({ kind: "databaseDefault" }),
		{
			kind: "execute",
			command: {
				kind: "formatted",
				text: valueCall("format", [
					lit.text(`ALTER DATABASE %I SET ${statement.parameter} = %L`, types.text),
					valueCall("current_database", []),
					lit.text(statement.value, types.text)
				])
			},
			into: undefined,
			using: []
		}
	]
})

/**
 * The DO block of a GRANT or REVOKE on the current database (sql/ast.ts GrantObjects `DATABASE`): the database
 * privilege's advisory lock, then the statement on the database's own name, which format quotes as an identifier
 * (`%I`), as it quotes each role it names:
 *
 *   DO $$
 *   BEGIN
 *     PERFORM "pg_catalog"."pg_advisory_xact_lock"(<key>::bigint);
 *     EXECUTE "pg_catalog"."format"('GRANT TEMPORARY ON DATABASE %I TO %I'::"pg_catalog"."text",
 *       "pg_catalog"."current_database"(), '<role>'::"pg_catalog"."text");
 *   END
 *   $$
 *
 * A GRANT or REVOKE on a database writes its pg_database row, which every installation in the database shares, and two
 * that write it at once fail with XX000 (tuple concurrently updated), so the block first takes the lock: a second
 * installation waits for the first to commit, then writes it again.
 */
export const databasePrivilegeBlock = (statement: Grant | Revoke): DoBlock => {
	const [verb, preposition, grantees] =
		statement.kind === "grant"
			? (["GRANT", "TO", statement.to] as const)
			: (["REVOKE", "FROM", statement.from] as const)
	const named = grantees.map((g) => (g.kind === "PUBLIC" ? "PUBLIC" : "%I"))
	return {
		kind: "do",
		declare: [],
		body: [
			advisoryXactLock({ kind: "databasePrivilege" }),
			{
				kind: "execute",
				command: {
					kind: "formatted",
					text: valueCall("format", [
						lit.text(
							`${verb} ${statement.privileges.join(", ")} ON DATABASE %I ${preposition} ${named.join(", ")}`,
							types.text
						),
						valueCall("current_database", []),
						...grantees.flatMap((g) => (g.kind === "role" ? [lit.text(g.name, types.text)] : []))
					])
				},
				into: undefined,
				using: []
			}
		]
	}
}
