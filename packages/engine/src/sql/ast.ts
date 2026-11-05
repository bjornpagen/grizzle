import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { CarrierName, NameMap } from "#compiler/sql/naming.ts"

/** A schema object's name, always schema-qualified: every object grizzle installs or names lives in a named schema. */
export interface ObjectName {
	readonly schema: string
	readonly name: string
}

/**
 * A table a data-modifying statement or a FROM item names: a stored relation by its qualified name, or a write
 * program's transaction-scoped carrier, which prints qualified by pg_temp, the session's own temporary schema.
 */
export type TableName = ObjectName | CarrierName

/** A function as GRANT, REVOKE and DROP name it: its name and its argument types, none for a law function. */
export interface FunctionName extends ObjectName {
	readonly args: ReadonlyArray<TypeRef>
}

/**
 * The one collation grizzle ever names: the builtin pg_catalog.pg_c_utf8, forced on every schema. It is a closed
 * constant, so no other collation, locale or provider is representable; the kernel's audit requires it on every column
 * and domain of builtin type text.
 */
export interface Collation {
	readonly schema: "pg_catalog"
	readonly name: "pg_c_utf8"
}

/** The pg_catalog types a value has: a column's, a domain's base, a parameter's, a cast's, a PL/pgSQL variable's. */
export const builtinTypeNames = [
	"smallint",
	"integer",
	"bigint",
	"numeric",
	"real",
	"double precision",
	"boolean",
	"text",
	"uuid",
	"jsonb",
	"money",
	"int4range",
	"int8range",
	"int4multirange",
	"int8multirange",
	"record"
] as const
export type BuiltinTypeName = (typeof builtinTypeNames)[number]

/** What a function grizzle installs returns. */
export type FunctionReturns = "trigger" | "boolean" | "void"

/** The pg_catalog types only a catalog read, or a relation reference, names. */
export type CatalogReadType =
	| "name"
	| "oid"
	| "char"
	| "regclass"
	| "regnamespace"
	| "regtype"
	| "regprocedure"

/** Every pg_catalog type grizzle's SQL names. */
export type CatalogTypeName = BuiltinTypeName | FunctionReturns | CatalogReadType | "jsonpath"

/**
 * How a pg_catalog type is spelled so that it names pg_catalog's type under every search_path: an SQL keyword, which
 * PostgreSQL's grammar resolves into pg_catalog itself, or its name qualified by pg_catalog.
 */
export type CatalogSpelling = "keyword" | "qualified"

export const catalogSpelling: { readonly [T in CatalogTypeName]: CatalogSpelling } = {
	smallint: "keyword",
	integer: "keyword",
	bigint: "keyword",
	numeric: "keyword",
	real: "keyword",
	"double precision": "keyword",
	boolean: "keyword",
	text: "qualified",
	uuid: "qualified",
	jsonb: "qualified",
	jsonpath: "qualified",
	money: "qualified",
	int4range: "qualified",
	int8range: "qualified",
	int4multirange: "qualified",
	int8multirange: "qualified",
	record: "qualified",
	trigger: "qualified",
	void: "qualified",
	name: "qualified",
	oid: "qualified",
	char: "qualified",
	regclass: "qualified",
	regnamespace: "qualified",
	regtype: "qualified",
	regprocedure: "qualified"
}

/**
 * The schema of a named type: the installation's, for a domain or an enum, or the vector extension's. Only the doors
 * that name those schemas mint it (physical/ddl/names.ts, physical/install/extension.ts), and a snapshot read back holds
 * the ones they minted, so no named type sits in pg_catalog: a pg_catalog type is builtin.
 */
export type TypeSchema = string & { readonly [typeSchemaBrand]: true }
declare const typeSchemaBrand: unique symbol

/** A named type by its schema and its name: a domain's, an enum's, or the vector extension's vector. */
export interface TypeName {
	readonly schema: TypeSchema
	readonly name: string
}

/** `array` is whether the type is the array of the type it names. */
export type TypeRef =
	| {
			readonly kind: "builtin"
			readonly name: BuiltinTypeName
			readonly precision: undefined
			readonly scale: undefined
			readonly array: boolean
	  }
	| {
			readonly kind: "builtin"
			readonly name: "numeric"
			readonly precision: number
			readonly scale: number | undefined
			readonly array: boolean
	  }
	| {
			readonly kind: "named"
			readonly schema: TypeSchema
			readonly name: string
			readonly typmod: ReadonlyArray<number>
			readonly array: boolean
	  }

/**
 * The one search_path grizzle sets: pg_catalog, then the session's temporary schema. Every function grizzle installs
 * pins it, so no caller's path reaches a body, every login's sessions start under it (RoleSetting), and the drift check
 * reads under it, since PostgreSQL's deparsers spell a name bare exactly when the path finds it first.
 */
export const closedSearchPath = ["pg_catalog", "pg_temp"] as const

/**
 * The spellings of a double no persisted number holds: JSON has no NaN or infinity, and canonical JSON writes -0 as 0.
 */
export const floatSpecials = ["NaN", "Infinity", "-Infinity", "-0"] as const
type FloatSpecial = (typeof floatSpecials)[number]
/** A finite double other than -0. Only lit.float (build.ts) makes one. */
export type FiniteFloat = number & { readonly [finiteFloatBrand]: true }
declare const finiteFloatBrand: unique symbol
/**
 * The typed value of a Literal. Each prints as a typed literal (print.ts):
 * - bool: `true` or `false`, PostgreSQL's boolean constants;
 * - int: a nonnegative integer typed integer prints bare, PostgreSQL types it int4; otherwise `N::type`;
 * - decimal: an exact decimal string (`-?digits(.digits)?`) or NaN/Infinity/-Infinity, for numeric, which lit.decimal
 *   (build.ts) spells from a value's parts, so no builder writes an exponent;
 * - float: a finite double other than -0, for real or double precision, printed in shortest round-trip form as a
 *   quoted literal;
 * - floatSpecial: NaN, an infinity or -0, for real or double precision, printed as its quoted spelling, which the
 *   float input function reads as exactly that double;
 * - text: any value spelled by its type's input function: text, uuid, enum labels, ranges, money, vectors.
 */
export type LiteralValue =
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "int"; readonly value: bigint }
	| { readonly kind: "decimal"; readonly value: string }
	| { readonly kind: "float"; readonly value: FiniteFloat }
	| { readonly kind: "floatSpecial"; readonly value: FloatSpecial }
	| { readonly kind: "text"; readonly value: string }

export const binaryOperators = [
	"=",
	"<>",
	"<",
	"<=",
	">",
	">=",
	"+",
	"-",
	"*",
	"/",
	"%",
	"||",
	"~",
	"&&",
	"@>",
	"<@",
	"<<",
	">>",
	"&<",
	"&>",
	"-|-",
	"<=>"
] as const
export type BinaryOperator = (typeof binaryOperators)[number]

/**
 * PostgreSQL builtin functions grizzle emits, printed qualified by pg_catalog. Compute's catalogue, the aggregates,
 * window and ordered-set functions of the compile-target catalog, the exact value of a double's bits (float8send and
 * get_byte, build.ts exactNumericOfDouble), the span functions, the attachment transport, the runtime probes and the
 * database default's statement; a recordset is a FROM item of its own. Extension functions (pgvector) are qualified by
 * their extension's schema instead.
 */
export const builtinFunctionNames = [
	"count",
	"sum",
	"avg",
	"min",
	"max",
	"bool_and",
	"bool_or",
	"range_agg",
	"array_agg",
	"jsonb_agg",
	"row_number",
	"rank",
	"dense_rank",
	"lead",
	"lag",
	"percentile_disc",
	"percentile_cont",
	"mode",
	"abs",
	"sign",
	"gcd",
	"lcm",
	"power",
	"sqrt",
	"min_scale",
	"trim_scale",
	"float8send",
	"get_byte",
	"width_bucket",
	"round",
	"trunc",
	"ceil",
	"floor",
	"div",
	"mod",
	"char_length",
	"lower",
	"upper",
	"isempty",
	"lower_inc",
	"upper_inc",
	"lower_inf",
	"upper_inf",
	"int4range",
	"int8range",
	"range_minus_multi",
	"unnest",
	"to_jsonb",
	"setval",
	"pg_advisory_xact_lock",
	"current_setting",
	"set_config",
	"pg_jit_available",
	"format",
	"current_database"
] as const
export type BuiltinFunctionName = (typeof builtinFunctionNames)[number]

/** An extension's function, qualified by its schema and quoted. */
export interface QualifiedFunctionRef {
	readonly kind: "qualified"
	readonly schema: string
	readonly name: string
}

export type FunctionRef =
	| { readonly kind: "builtin"; readonly name: BuiltinFunctionName }
	| QualifiedFunctionRef

/** ASC, PostgreSQL's default order, prints bare. */
export interface OrderItem {
	readonly expr: Expr
	readonly direction: "ASC" | "DESC"
}

export type FrameBound =
	| { readonly kind: "unboundedPreceding" }
	| { readonly kind: "currentRow" }
	| { readonly kind: "unboundedFollowing" }
	| {
			readonly kind: "offset"
			readonly offset: bigint
			readonly direction: "PRECEDING" | "FOLLOWING"
	  }

/** An empty PARTITION BY or ORDER BY is none. */
export interface WindowSpec {
	readonly partitionBy: ReadonlyArray<Expr>
	readonly orderBy: ReadonlyArray<OrderItem>
	/** An explicit ROWS frame, or undefined for none. */
	readonly frame: { readonly start: FrameBound; readonly end: FrameBound } | undefined
}

/**
 * count(*), the one call whose argument is the star. It alone takes FILTER (WHERE ...): count is a value over no
 * qualifying row, while every other aggregate is NULL there, so a conditional sum is sum(CASE WHEN p THEN x ELSE 0 END).
 * Its FILTER and OVER are undefined when it has none.
 */
export interface CountStar {
	readonly kind: "call"
	readonly fn: { readonly kind: "builtin"; readonly name: "count" }
	readonly args: readonly []
	readonly star: true
	readonly filter: Expr | undefined
	readonly over: WindowSpec | undefined
}

/**
 * Every other call: a function of its arguments, an aggregate, an ordered-set aggregate or a window function. An empty
 * ORDER BY or WITHIN GROUP is none, and an undefined OVER is a plain call.
 */
export interface Call {
	readonly kind: "call"
	readonly fn: FunctionRef
	readonly args: ReadonlyArray<Expr>
	readonly star: false
	readonly distinct: boolean
	/** An aggregate's own ORDER BY, as in array_agg(x ORDER BY y). */
	readonly orderBy: ReadonlyArray<OrderItem>
	/** An ordered-set aggregate's WITHIN GROUP (ORDER BY ...). */
	readonly withinGroup: ReadonlyArray<OrderItem>
	readonly over: WindowSpec | undefined
}

export type FunctionCall = CountStar | Call

/** A record-valued PL/pgSQL name: a declared variable, or the trigger row images NEW and OLD. */
export type PlRecord =
	| { readonly kind: "plVar"; readonly name: string }
	| { readonly kind: "plSpecial"; readonly name: "NEW" | "OLD" }

/**
 * A value placeholder, printed `$n::type`: its number n is its position in its statement's slots, from 1, which a slot
 * carries from allocation. A lowering's scalar and page slots are value placeholders, as is a positional one no
 * lowering allocates (a function's argument, the deploy ledger's). A statement holds the placeholder alone, never the
 * slot that numbers it: its slots stand beside it in number order and are matched by number, so a statement holds
 * exactly what its stored form does, and the snapshot's codec reads it back as itself.
 */
export interface ValuePlaceholder {
	readonly placeholder: "value"
	readonly number: number
}

/**
 * The placeholder a recordset reads, printed `jsonb_to_recordset($n::jsonb)`, numbered and held as a value placeholder
 * is: a relation parameter's or a write's member slot. It is a recordset's source and never an expression, so a
 * statement reads a relation-valued slot only through its recordsets.
 */
export interface RecordsetPlaceholder {
	readonly placeholder: "recordset"
	readonly number: number
}

export type Expr =
	| { readonly kind: "column"; readonly table: string | undefined; readonly column: string }
	| { readonly kind: "excluded"; readonly column: string }
	| { readonly kind: "returning"; readonly side: "old" | "new"; readonly column: string }
	| { readonly kind: "param"; readonly slot: ValuePlaceholder; readonly type: TypeRef }
	| { readonly kind: "literal"; readonly value: LiteralValue; readonly type: TypeRef }
	| { readonly kind: "cast"; readonly expr: Expr; readonly type: TypeRef }
	| { readonly kind: "collate"; readonly expr: Expr; readonly collation: Collation }
	| {
			readonly kind: "binary"
			readonly op: BinaryOperator
			readonly left: Expr
			readonly right: Expr
			readonly schema: string | undefined
	  }
	| { readonly kind: "negate"; readonly expr: Expr }
	| { readonly kind: "and"; readonly args: NonEmptyReadonlyArray<Expr> }
	| { readonly kind: "or"; readonly args: NonEmptyReadonlyArray<Expr> }
	| { readonly kind: "not"; readonly expr: Expr }
	| { readonly kind: "isTrue"; readonly expr: Expr }
	| {
			readonly kind: "between"
			readonly expr: Expr
			readonly low: Expr
			readonly high: Expr
			readonly not: boolean
	  }
	| {
			readonly kind: "inList"
			readonly expr: Expr
			/**
			 * At least one item: PostgreSQL has no empty IN list, so an empty membership is `false` (`true` NOT) at its
			 * source.
			 */
			readonly list: NonEmptyReadonlyArray<Expr>
			readonly not: boolean
	  }
	| { readonly kind: "inQuery"; readonly expr: Expr; readonly query: Select; readonly not: boolean }
	| { readonly kind: "exists"; readonly query: Select; readonly not: boolean }
	| { readonly kind: "subquery"; readonly query: Select }
	| { readonly kind: "array"; readonly query: Select }
	| { readonly kind: "row"; readonly items: NonEmptyReadonlyArray<Expr> }
	| {
			readonly kind: "case"
			readonly operand: Expr | undefined
			readonly whens: NonEmptyReadonlyArray<{ readonly when: Expr; readonly result: Expr }>
			readonly else: Expr
	  }
	| FunctionCall
	| { readonly kind: "greatest" | "least"; readonly args: NonEmptyReadonlyArray<Expr> }
	| { readonly kind: "mergeAction" }
	| { readonly kind: "domainValue" }
	| User
	| PlRecord
	| { readonly kind: "plSpecial"; readonly name: "TG_TABLE_NAME" | "TG_TABLE_SCHEMA" }
	| { readonly kind: "field"; readonly record: PlRecord; readonly field: string }
	| RegclassRef

/**
 * A relation as a regclass value, by its name: it prints as the quoted qualified name in a string literal cast to
 * pg_catalog's regclass, and a rewrite of schema object names (sql/transform.ts) moves it as it moves every other.
 */
export interface RegclassRef {
	readonly kind: "regclass"
	readonly relation: ObjectName
}

/**
 * A user name SQL spells without parentheses: CURRENT_USER, the role privileges are checked as (inside a SECURITY
 * DEFINER function, the function's owner), or SESSION_USER, the role the session authenticated as or SET SESSION
 * AUTHORIZATION named.
 */
export interface User {
	readonly kind: "user"
	readonly name: "CURRENT_USER" | "SESSION_USER"
}

/** An unaliased target's alias is undefined. */
export interface Target {
	readonly expr: Expr
	readonly alias: string | undefined
}

/**
 * One column of a function's column definition list. A column of builtin text names the fixed collation, so a
 * recordset's text column carries pg_catalog.pg_c_utf8 like every stored column: otherwise it
 * has the database default collation, and a recursive CTE seeded from it disagrees with its step's stored columns and
 * is refused with 42P21.
 */
export interface ColumnDefinition {
	readonly name: string
	readonly type: TypeRef
	readonly collation: Collation | undefined
}

/**
 * A FROM item that is no join chain: a relation, a CTE reference, a derived table, a function's rows, a recordset, a
 * VALUES list or a context source. A join chain joins sources only, so its length is never a depth.
 */
export type FromSource =
	| { readonly kind: "table"; readonly table: TableName; readonly alias: string }
	| { readonly kind: "cte"; readonly name: string; readonly alias: string | undefined }
	| { readonly kind: "enclosing"; readonly name: string; readonly alias: string }
	| {
			readonly kind: "derived"
			readonly query: Select
			readonly alias: string
			/** The column alias list; an empty one is none, as PostgreSQL spells a relation of no column. */
			readonly columns: ReadonlyArray<string>
			readonly lateral: boolean
	  }
	| {
			/** A function's rows. */
			readonly kind: "function"
			readonly call: Call
			readonly alias: string
			/** The column alias list; an empty one is none. */
			readonly columns: ReadonlyArray<string>
			readonly lateral: boolean
	  }
	| {
			readonly kind: "recordset"
			/** The jsonb placeholder whose facts are the relation. */
			readonly source: RecordsetPlaceholder
			readonly alias: string
			/**
			 * The relation's columns, of any width: a recordset of no column is one row of no column per fact, which the
			 * printer spells as the placeholder's array elements.
			 */
			readonly columns: ReadonlyArray<ColumnDefinition>
	  }
	| {
			readonly kind: "values"
			readonly rows: NonEmptyReadonlyArray<ReadonlyArray<Expr>>
			readonly alias: string
			/**
			 * At least one column: PostgreSQL has no VALUES row of no value. A row of no column is the derived
			 * `(SELECT)`.
			 */
			readonly columns: NonEmptyReadonlyArray<string>
	  }
	| ContextSource

/** One join of a join chain: its source joined to everything before it, on a condition or crosswise. */
export type JoinStep =
	| { readonly kind: "on"; readonly source: FromSource; readonly on: Expr }
	| { readonly kind: "cross"; readonly source: FromSource }

/**
 * Sources joined left to right, `a JOIN b ON p CROSS JOIN c` being `(a JOIN b ON p) CROSS JOIN c`: one node however
 * many sources it joins.
 */
export interface JoinChain {
	readonly kind: "joins"
	readonly first: FromSource
	readonly steps: NonEmptyReadonlyArray<JoinStep>
}

export type FromItem = FromSource | JoinChain

/**
 * A context's one fact, read from the session's claims (sql/print.ts printContextSource): one row when the claims hold
 * a member for `context` holding exactly the source's fields, each column its field's claim, the member's JSON string
 * at the field's key, read by the column's type and collated as the column is; no row when they hold no member for it;
 * and refused through `refusal`, the installation's refusal function, when the setting is no claims document, the
 * member holds any other keys, or a claim is no value of its column's type. Every claim the statement reads at the
 * source is a column reference to it, so the source reads the setting and judges the member once, however many columns
 * are read.
 */
export interface ContextSource {
	readonly kind: "context"
	readonly context: string
	/**
	 * Every field the context declares, in its heading's order, at least one (ir/desc.ts ContextDesc): its claim's key,
	 * and the column it is delivered as.
	 */
	readonly columns: NonEmptyReadonlyArray<ContextColumn>
	readonly refusal: QualifiedFunctionRef
	readonly alias: string
}

/** One field of a context source: the key of its claim in the context's member, and its column. */
export interface ContextColumn {
	readonly field: string
	readonly column: ColumnDefinition
}

/**
 * A SELECT core: its projection (CoreProjection) over its FROM. An empty FROM or GROUP BY is none, and an undefined
 * WHERE or HAVING is none.
 */
export type SelectCore = {
	readonly kind: "core"
	readonly from: ReadonlyArray<FromItem>
	readonly where: Expr | undefined
	readonly groupBy: ReadonlyArray<Expr>
	readonly having: Expr | undefined
} & CoreProjection

/**
 * What a core delivers of each row it reads: `distinct` is false for none, true for DISTINCT, or DISTINCT ON its
 * expressions, at least one. DISTINCT reads at least one target, as PostgreSQL's grammar requires; a core of no target
 * reads one row of no column for each row of its FROM, the unit relation's rows.
 */
export type CoreProjection =
	| { readonly distinct: false; readonly targets: ReadonlyArray<Target> }
	| {
			readonly distinct: true | { readonly on: NonEmptyReadonlyArray<Expr> }
			readonly targets: NonEmptyReadonlyArray<Target>
	  }

export type SetOperator = "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT"

/**
 * A set-operation arm: a core, or a parenthesized full query with its own clauses. A set operation nests only as the body
 * of such a query, so a chain of one operator is one node however many arms it has.
 */
export type SetOperand = SelectCore | Select

/** At least two arms combined by one operator, left to right: `a op b op c` is `(a op b) op c`. */
export interface SetOperation {
	readonly kind: "setOp"
	readonly op: SetOperator
	readonly arms: readonly [SetOperand, SetOperand, ...Array<SetOperand>]
}

export type SelectBody = SelectCore | SetOperation | Select

export type CteBody = Select | Insert | Update | Delete | Merge

export interface Cte {
	readonly name: string
	/**
	 * A query CTE lists its columns, none for a relation of no column. A data-modifying CTE is named by its RETURNING
	 * aliases instead, unless it lists columns. An empty list is none, as PostgreSQL spells it by leaving it out.
	 */
	readonly columns: ReadonlyArray<string>
	/** Undefined leaves the choice to PostgreSQL. */
	readonly materialized: "MATERIALIZED" | "NOT MATERIALIZED" | undefined
	readonly query: CteBody
}

/** A WITH of at least one CTE: a query with none has no WITH (an undefined `with`). */
export interface With {
	readonly recursive: boolean
	readonly ctes: NonEmptyReadonlyArray<Cte>
}

/**
 * An undefined WITH, LIMIT or OFFSET is none, and so is an empty ORDER BY. No query locks a row: every transaction is
 * SERIALIZABLE, and SSI orders it (physical/ddl/isolation.ts).
 */
export interface Select {
	readonly kind: "select"
	readonly with: With | undefined
	readonly body: SelectBody
	readonly orderBy: ReadonlyArray<OrderItem>
	readonly limit: Expr | undefined
	readonly offset: Expr | undefined
}

export interface Assignment {
	readonly column: string
	readonly value: Expr
}

export interface DoNothing {
	readonly kind: "doNothing"
}

export type ConflictAction =
	| DoNothing
	| { readonly kind: "doSelect"; readonly where: Expr | undefined }
	| {
			readonly kind: "doUpdate"
			readonly set: NonEmptyReadonlyArray<Assignment>
			readonly where: Expr | undefined
	  }

export type OnConflict =
	| {
			readonly kind: "columns"
			readonly columns: NonEmptyReadonlyArray<string>
			readonly action: ConflictAction
	  }
	| { readonly kind: "constraint"; readonly constraint: string; readonly action: DoNothing }

/**
 * The columns an INSERT assigns and the source of their values, in order. A query's columns may be none, PostgreSQL's
 * implicit list of the table's first zero columns: every column takes its default, an identity's its next value. A
 * VALUES source has at least one row and at least one column: PostgreSQL has no VALUES row of no value. Each row holds
 * one value per column, a width TypeScript does not relate to the columns' (the SQL audit checks it).
 */
export type InsertTarget =
	| {
			readonly columns: ReadonlyArray<string>
			readonly source: { readonly kind: "query"; readonly query: Select }
	  }
	| {
			readonly columns: NonEmptyReadonlyArray<string>
			readonly source: {
				readonly kind: "values"
				readonly rows: NonEmptyReadonlyArray<ReadonlyArray<Expr>>
			}
	  }

export type InsertSource = InsertTarget["source"]

/** An INSERT target whose source is a VALUES list, its columns at least one. */
export type ValuesTarget = Extract<InsertTarget, { readonly source: { readonly kind: "values" } }>

/** Whether an INSERT's source is a VALUES list: the arm of InsertTarget whose columns are at least one. */
export const isValuesTarget = (t: InsertTarget): t is ValuesTarget => t.source.kind === "values"

/** In each data-modifying statement an undefined clause is none, and so is an empty list. */
export type Insert = {
	readonly kind: "insert"
	readonly with: With | undefined
	readonly table: TableName
	readonly alias: string | undefined
	/** SYSTEM VALUE: explicit serial values into GENERATED ALWAYS columns. */
	readonly overriding: "SYSTEM VALUE" | undefined
	readonly onConflict: OnConflict | undefined
	readonly returning: ReadonlyArray<Target>
} & InsertTarget

export interface Update {
	readonly kind: "update"
	readonly with: With | undefined
	readonly table: ObjectName
	readonly alias: string
	readonly set: NonEmptyReadonlyArray<Assignment>
	readonly from: ReadonlyArray<FromItem>
	readonly where: Expr | undefined
	/** May name old."c" and new."c". */
	readonly returning: ReadonlyArray<Target>
}

export interface Delete {
	readonly kind: "delete"
	readonly with: With | undefined
	readonly table: TableName
	readonly alias: string
	readonly using: ReadonlyArray<FromItem>
	readonly where: Expr | undefined
	readonly returning: ReadonlyArray<Target>
}

export interface MergeUpdate {
	readonly kind: "update"
	readonly set: NonEmptyReadonlyArray<Assignment>
}

/**
 * INSERT (<columns>) [OVERRIDING SYSTEM VALUE] VALUES (<values>), each column with the value it takes, at least one;
 * or INSERT DEFAULT VALUES, PostgreSQL's spelling of an insert of no column, every column its default.
 */
export type MergeInsert =
	| {
			readonly kind: "insert"
			readonly overriding: "SYSTEM VALUE" | undefined
			readonly row: NonEmptyReadonlyArray<Assignment>
	  }
	| { readonly kind: "insertDefault" }

type MergeAction = MergeUpdate | MergeInsert | { readonly kind: "delete" } | DoNothing

/**
 * What a WHEN clause may do follows from its match. A target row (MATCHED, and NOT MATCHED BY SOURCE, which has no
 * source row) is updated, deleted or left; a source row without a target (NOT MATCHED) is inserted or left. An
 * undefined condition is none.
 */
export type MergeWhen =
	| {
			readonly match: "MATCHED" | "NOT MATCHED BY SOURCE"
			readonly condition: Expr | undefined
			readonly action: Exclude<MergeAction, MergeInsert>
	  }
	| {
			readonly match: "NOT MATCHED"
			readonly condition: Expr | undefined
			readonly action: MergeInsert | DoNothing
	  }

export interface Merge {
	readonly kind: "merge"
	readonly with: With | undefined
	readonly table: ObjectName
	readonly alias: string
	readonly using: FromItem
	readonly on: Expr
	readonly whens: NonEmptyReadonlyArray<MergeWhen>
	/** May name merge_action(). */
	readonly returning: ReadonlyArray<Target>
}

export type ColumnGeneration =
	| { readonly kind: "identity"; readonly sequence: ObjectName }
	| { readonly kind: "stored"; readonly expr: Expr }

/**
 * A column. NOT NULL is not optional: every column is NOT NULL. An undefined collation or generation is none, and a
 * column has no default: a drafted ADD COLUMN's placeholder is its own action (AlterTableAction addColumnPlaceholder).
 */
export interface ColumnDef {
	readonly name: string
	readonly type: TypeRef
	/** Required when the type is builtin text or text[]. */
	readonly collation: Collation | undefined
	readonly generated: ColumnGeneration | undefined
}

export interface KeyColumn {
	readonly column: string
	/** The span of a temporal key, last in the list. */
	readonly withoutOverlaps: boolean
}

export interface ForeignKeyColumn {
	readonly column: string
	/** The span of a PERIOD foreign key, last in the list. */
	readonly period: boolean
}

export interface ExclusionElement {
	readonly column: string
	readonly operator: "&&"
}

export type TableConstraint =
	| {
			readonly kind: "primaryKey"
			readonly name: string
			readonly columns: NonEmptyReadonlyArray<KeyColumn>
	  }
	| {
			readonly kind: "unique"
			readonly name: string
			readonly columns: NonEmptyReadonlyArray<KeyColumn>
	  }
	| {
			readonly kind: "foreignKey"
			readonly name: string
			readonly columns: NonEmptyReadonlyArray<ForeignKeyColumn>
			readonly references: ObjectName
			readonly referencedColumns: NonEmptyReadonlyArray<ForeignKeyColumn>
			/** Undefined: NOT DEFERRABLE. */
			readonly deferrable: "INITIALLY DEFERRED" | "INITIALLY IMMEDIATE" | undefined
	  }
	| { readonly kind: "check"; readonly name: string; readonly predicate: Expr }
	| {
			readonly kind: "exclude"
			readonly name: string
			readonly method: "gist"
			readonly elements: NonEmptyReadonlyArray<ExclusionElement>
	  }

/** An undefined AUTHORIZATION is the current role's. */
export interface CreateSchema {
	readonly kind: "createSchema"
	readonly name: string
	readonly authorization: string | undefined
}

export type PrimaryKey = Extract<TableConstraint, { readonly kind: "primaryKey" }>
export type ForeignKey = Extract<TableConstraint, { readonly kind: "foreignKey" }>

/**
 * A constraint a table declares inline beside its primary key: a candidate key, a span key's exclusion constraint, or a
 * CHECK. A foreign key is never inline: it is its own ALTER TABLE ... ADD CONSTRAINT, after every table.
 */
export type InlineConstraint = Extract<
	TableConstraint,
	{ readonly kind: "unique" | "exclude" | "check" }
>

/**
 * An installed table, schema-qualified: its columns, its primary key, and its secondary constraints, the inline ones
 * beside the primary key. It prints its primary key first, after its columns. A reader of every constraint the table
 * declares reads tableConstraints, never `secondary` alone.
 */
export interface CreateTable {
	readonly kind: "createTable"
	readonly table: ObjectName
	readonly columns: NonEmptyReadonlyArray<ColumnDef>
	readonly primaryKey: PrimaryKey
	readonly secondary: ReadonlyArray<InlineConstraint>
}

/** Every constraint a table declares inline, its primary key first. */
export const tableConstraints = (t: CreateTable): NonEmptyReadonlyArray<TableConstraint> => [
	t.primaryKey,
	...t.secondary
]

/**
 * A write program's transaction-scoped carrier: CREATE TEMPORARY TABLE ... ON COMMIT DROP. It lives in pg_temp, the
 * session's own temporary schema, by which it prints qualified, and it declares no constraint.
 */
export interface CreateCarrier {
	readonly kind: "createCarrier"
	readonly name: CarrierName
	/** Of any width: PostgreSQL holds a table of no column, the carrier of the unit relation. */
	readonly columns: ReadonlyArray<ColumnDef>
}

export type AlterTableAction =
	| { readonly kind: "addColumn"; readonly column: ColumnDef }
	| {
			/**
			 * ADD COLUMN ... DEFAULT <placeholder> NOT NULL: a drafted column whose value for the rows already stored the
			 * reviewer writes in place of the placeholder (print.ts placeholderToken).
			 */
			readonly kind: "addColumnPlaceholder"
			readonly column: ColumnDef
	  }
	| { readonly kind: "dropColumn"; readonly column: string }
	| { readonly kind: "dropDefault"; readonly column: string }
	| {
			readonly kind: "alterColumnType"
			readonly column: string
			readonly type: TypeRef
			/** Required when the type is builtin text or text[]. */
			readonly collation: Collation | undefined
			readonly using: Using
	  }
	| { readonly kind: "addIdentity"; readonly column: string; readonly sequence: ObjectName }
	| { readonly kind: "dropIdentity"; readonly column: string }
	| {
			readonly kind: "addConstraint"
			readonly constraint: TableConstraint
			readonly notValid: boolean
	  }
	| {
			readonly kind: "addConstraintUsingIndex"
			readonly name: string
			readonly constraint: "PRIMARY KEY" | "UNIQUE"
			readonly index: string
	  }
	| { readonly kind: "validateConstraint"; readonly name: string }
	| { readonly kind: "dropConstraint"; readonly name: string }
	| { readonly kind: "enableRowSecurity" }
	| { readonly kind: "disableRowSecurity" }

/**
 * An ALTER COLUMN ... TYPE's USING: the conversion of each stored value, or a drafted placeholder the reviewer replaces
 * with one (print.ts placeholderToken).
 */
export type Using =
	| { readonly kind: "expr"; readonly expr: Expr }
	| { readonly kind: "placeholder" }

export interface AlterTable {
	readonly kind: "alterTable"
	readonly table: ObjectName
	readonly actions: NonEmptyReadonlyArray<AlterTableAction>
}

type RenamableObject =
	| "TABLE"
	| "INDEX"
	| "MATERIALIZED VIEW"
	| "TYPE"
	| "DOMAIN"
	| "SEQUENCE"
	| "STATISTICS"

/**
 * ALTER <object> <name> RENAME TO <to>: a schema object by its qualified name, or a role or a schema, which live in
 * no schema, by its bare name. ALTER ROLE ... RENAME keeps a login's password.
 */
export type RenameObject =
	| {
			readonly kind: "rename"
			readonly object: RenamableObject
			readonly name: ObjectName
			readonly to: string
	  }
	| { readonly kind: "rename"; readonly object: "ROLE"; readonly name: string; readonly to: string }
	| {
			readonly kind: "rename"
			readonly object: "SCHEMA"
			readonly name: string
			readonly to: string
	  }

export interface RenameColumn {
	readonly kind: "renameColumn"
	readonly table: ObjectName
	readonly from: string
	readonly to: string
}

export interface RenameConstraint {
	readonly kind: "renameConstraint"
	readonly table: ObjectName
	readonly from: string
	readonly to: string
}

export interface DomainConstraint {
	readonly name: string
	/** Over VALUE; prints as CHECK ((<predicate>) IS TRUE). */
	readonly predicate: Expr
}

/** A domain carries no NOT NULL; the column does. */
export interface CreateDomain {
	readonly kind: "createDomain"
	readonly name: ObjectName
	readonly base: TypeRef
	/** Required when the base is builtin text or text[]. */
	readonly collation: Collation | undefined
	readonly constraints: ReadonlyArray<DomainConstraint>
}

export type AlterDomainAction =
	| {
			readonly kind: "addConstraint"
			readonly constraint: DomainConstraint
			readonly notValid: boolean
	  }
	| { readonly kind: "validateConstraint"; readonly name: string }
	| { readonly kind: "dropConstraint"; readonly name: string }

export interface AlterDomain {
	readonly kind: "alterDomain"
	readonly name: ObjectName
	readonly action: AlterDomainAction
}

export interface CreateEnum {
	readonly kind: "createEnum"
	readonly name: ObjectName
	/** Labels in declared order. */
	readonly labels: ReadonlyArray<string>
}

/**
 * ALTER TYPE ... ADD VALUE [IF NOT EXISTS]. A label goes in a no-transaction Setup file, which a failure reruns
 * from the top, so the drafted statement says IF NOT EXISTS: a label cannot be dropped and re-added.
 */
export interface AlterEnumAddValue {
	readonly kind: "alterEnumAddValue"
	readonly name: ObjectName
	readonly label: string
	readonly ifNotExists: boolean
	/** Undefined: after the last label. */
	readonly position: { readonly kind: "BEFORE" | "AFTER"; readonly label: string } | undefined
}

/** ALTER TYPE ... RENAME VALUE: a closed handle renamed in place, every row holding it then holding the new label. */
export interface AlterEnumRenameValue {
	readonly kind: "alterEnumRenameValue"
	readonly name: ObjectName
	readonly from: string
	readonly to: string
}

/** An undefined collation or operator class is the column's or type's default; ASC, the default order, prints bare. */
export interface IndexKey {
	/** A column, or an expression that prints parenthesized. */
	readonly key:
		| { readonly kind: "column"; readonly column: string }
		| { readonly kind: "expr"; readonly expr: Expr }
	readonly collation: Collation | undefined
	readonly opclass: ObjectName | undefined
	readonly direction: "ASC" | "DESC"
}

/** An empty INCLUDE is none, and an undefined WHERE is a full index. */
export interface CreateIndex {
	readonly kind: "createIndex"
	readonly name: string
	readonly table: ObjectName
	readonly unique: boolean
	/** Outside a transaction block only. */
	readonly concurrently: boolean
	readonly method: "btree" | "gist" | "hnsw"
	readonly keys: NonEmptyReadonlyArray<IndexKey>
	readonly include: ReadonlyArray<string>
	readonly where: Expr | undefined
}

export interface DropIndex {
	readonly kind: "dropIndex"
	readonly name: ObjectName
	readonly concurrently: boolean
	/** A rerun of a failed no-transaction file must be safe. */
	readonly ifExists: boolean
}

/** Always WITH NO DATA; db.refresh populates it. */
export interface CreateMaterializedView {
	readonly kind: "createMaterializedView"
	readonly name: ObjectName
	readonly columns: NonEmptyReadonlyArray<string>
	readonly query: Select
}

/**
 * CREATE VIEW <schema>.<view> (<columns>) [WITH (security_barrier)] AS <query>: a role relation's view in its role
 * schema.
 */
export interface CreateView {
	readonly kind: "createView"
	readonly name: ObjectName
	readonly columns: NonEmptyReadonlyArray<string>
	/**
	 * WITH (security_barrier): a view that hides rows of what it reads, so a qual a reader adds runs after the view's
	 * own and no error a qual raises can show a row outside it; a view that hides none is plain, so PostgreSQL may
	 * flatten it and push a reader's quals into the table it reads.
	 */
	readonly barrier: boolean
	readonly query: Select
}

/**
 * CREATE POLICY <name> ON <table> AS PERMISSIVE FOR ALL TO <role> USING (<filter>) WITH CHECK (<filter>): the one
 * policy of a role's writable entry over its table, the same predicate on the rows a statement reads and on the rows
 * it writes.
 */
export interface CreatePolicy {
	readonly kind: "createPolicy"
	readonly name: string
	readonly table: ObjectName
	readonly role: string
	readonly filter: Expr
}

export interface DropPolicy {
	readonly kind: "dropPolicy"
	readonly name: string
	readonly table: ObjectName
}

/**
 * DROP of a schema object by its qualified name, or of a role or a schema, which live in no schema, by its bare name.
 */
export type DropObject =
	| {
			readonly kind: "drop"
			readonly object: "TABLE" | "MATERIALIZED VIEW" | "VIEW" | "TYPE" | "DOMAIN" | "SEQUENCE"
			readonly name: ObjectName
			readonly ifExists: boolean
	  }
	| {
			readonly kind: "drop"
			readonly object: "ROLE"
			readonly name: string
			readonly ifExists: boolean
	  }
	| {
			readonly kind: "drop"
			readonly object: "SCHEMA"
			readonly name: string
			readonly ifExists: boolean
	  }

export interface DropFunction {
	readonly kind: "dropFunction"
	readonly name: FunctionName
	readonly ifExists: boolean
}

export interface DropTrigger {
	readonly kind: "dropTrigger"
	readonly name: string
	readonly table: ObjectName
	readonly ifExists: boolean
}

export type TriggerEvent =
	| { readonly kind: "INSERT" }
	| { readonly kind: "DELETE" }
	| { readonly kind: "UPDATE"; readonly of: NonEmptyReadonlyArray<string> }

/**
 * CREATE CONSTRAINT TRIGGER ... AFTER <event> ON <table> DEFERRABLE INITIALLY DEFERRED FOR EACH ROW [WHEN (<when>)]
 * EXECUTE FUNCTION <function>(): a law unit's trigger, for one event.
 */
export interface CreateConstraintTrigger {
	readonly kind: "createConstraintTrigger"
	readonly name: string
	readonly table: ObjectName
	readonly event: TriggerEvent
	/** The row filter PostgreSQL evaluates when the row event happens, before it queues the deferred event; none when
	 * every row of the event threatens the law. */
	readonly when: Expr | undefined
	readonly function: ObjectName
}

/**
 * CREATE TRIGGER <name> BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON <table> FOR EACH STATEMENT EXECUTE FUNCTION
 * <function>(): the isolation guard every table carries (physical/ddl/isolation.ts), the one statement trigger.
 */
export interface CreateGuardTrigger {
	readonly kind: "createGuardTrigger"
	readonly name: string
	readonly table: ObjectName
	readonly function: ObjectName
}

/**
 * The current database's default of a configuration parameter, whatever the database is named, printed as a DO block
 * (sql/catalog.ts DoBlock, built by sql/build.ts databaseDefaultBlock):
 *
 *   DO $$
 *   BEGIN
 *     PERFORM "pg_catalog"."pg_advisory_xact_lock"(<key>::bigint);
 *     EXECUTE "pg_catalog"."format"('ALTER DATABASE %I SET <parameter> = %L'::"pg_catalog"."text",
 *       "pg_catalog"."current_database"(), '<value>'::"pg_catalog"."text");
 *   END
 *   $$
 *
 * ALTER DATABASE names its database and an installation's statements name none, so the block reads its name; PostgreSQL
 * reads `ALTER DATABASE CURRENT_DATABASE` as a database of that name. The installation's one database default is
 * SERIALIZABLE for every transaction (physical/ddl/isolation.ts).
 */
export interface AlterDatabaseDefault {
	readonly kind: "alterDatabaseDefault"
	readonly parameter: "default_transaction_isolation"
	readonly value: "serializable"
}

/**
 * The role-level settings of one text value Publish stores for a login: the fixed session settings
 * and the vector library's search policy (check/approximate/policy.ts). An `hnsw.*` name is a
 * placeholder until the vector library is loaded in the session that stores it.
 */
export const textParameters = [
	"jit",
	"extra_float_digits",
	"lc_monetary",
	"lc_numeric",
	"lc_time",
	"lc_messages",
	"hnsw.ef_search",
	"hnsw.iterative_scan",
	"hnsw.max_scan_tuples",
	"hnsw.scan_mem_multiplier"
] as const
export type TextParameter = (typeof textParameters)[number]

/** Every role-level setting Publish stores for a login: its search_path, and the settings of one text value. */
export const configurationParameters = ["search_path", ...textParameters] as const
export type ConfigurationParameter = (typeof configurationParameters)[number]

/** A login default of one text value: its parameter, and the value it stores. */
export interface TextSetting {
	readonly parameter: TextParameter
	readonly value: string
}

/**
 * A login default, as ALTER ROLE ... SET stores it: a text parameter at its value, or search_path at closedSearchPath,
 * the one search_path grizzle sets, printed as its list of schemas. A role's own default outranks its database's, so
 * a login's sessions resolve no name through a path the database, the cluster or an operator chose; no other path is
 * representable.
 */
export type RoleSetting = TextSetting | { readonly parameter: "search_path" }

/**
 * The text parameters only a superuser, or a role granted SET on them, may set: a login's own startup options naming
 * one are refused (42501), so only a role default the migration identity stores through its SET privilege sets it.
 */
export type SuperuserParameter = Extract<TextParameter, "lc_messages">

/**
 * A login default the login's own sessions may set at startup: search_path, or a text parameter no superuser alone may
 * set. The startup options of every session of a login carry each of them (physical/ddl/roles.ts
 * loginStartupOptions).
 */
export type SessionSetting =
	| { readonly parameter: Exclude<TextParameter, SuperuserParameter>; readonly value: string }
	| { readonly parameter: "search_path" }

/**
 * CREATE ROLE <name> LOGIN NOINHERIT, a login, or CREATE ROLE <name> NOLOGIN, a theory role: a login holds no
 * privilege but its memberships, and acts only after SET ROLE to one of its theory roles.
 */
export interface CreateRole {
	readonly kind: "createRole"
	readonly name: string
	readonly login: boolean
}

/**
 * GRANT <role> TO <login> WITH INHERIT FALSE, SET TRUE: the login may SET ROLE to the theory role and holds none of
 * its privileges otherwise.
 */
export interface GrantRole {
	readonly kind: "grantRole"
	readonly role: string
	readonly to: string
}

export interface RevokeRole {
	readonly kind: "revokeRole"
	readonly role: string
	readonly from: string
}

export type AlterRoleAction =
	| { readonly kind: "set"; readonly setting: RoleSetting }
	| { readonly kind: "reset"; readonly parameter: ConfigurationParameter }

export interface AlterRole {
	readonly kind: "alterRole"
	readonly name: string
	readonly action: AlterRoleAction
}

export const privileges = [
	"SELECT",
	"INSERT",
	"UPDATE",
	"DELETE",
	"TRUNCATE",
	"REFERENCES",
	"TRIGGER",
	"MAINTAIN",
	"USAGE",
	"EXECUTE",
	"ALL"
] as const
export type Privilege = (typeof privileges)[number]

/** What a GRANT or REVOKE names, at least one object: PostgreSQL has no grant on no object. */
export type GrantObjects =
	| { readonly kind: "TABLE"; readonly names: NonEmptyReadonlyArray<ObjectName> }
	| { readonly kind: "SEQUENCE"; readonly names: NonEmptyReadonlyArray<ObjectName> }
	| { readonly kind: "SCHEMA"; readonly names: NonEmptyReadonlyArray<string> }
	| { readonly kind: "TYPE"; readonly names: NonEmptyReadonlyArray<ObjectName> }
	| { readonly kind: "DOMAIN"; readonly names: NonEmptyReadonlyArray<ObjectName> }
	| { readonly kind: "FUNCTION"; readonly names: NonEmptyReadonlyArray<FunctionName> }

export type Grantee = { readonly kind: "role"; readonly name: string } | { readonly kind: "PUBLIC" }

export interface Grant {
	readonly kind: "grant"
	readonly privileges: NonEmptyReadonlyArray<Privilege>
	readonly on: GrantObjects
	readonly to: NonEmptyReadonlyArray<Grantee>
}

export interface Revoke {
	readonly kind: "revoke"
	readonly privileges: NonEmptyReadonlyArray<Privilege>
	readonly on: GrantObjects
	readonly from: NonEmptyReadonlyArray<Grantee>
}

/** The privileges PostgreSQL grants on columns that a role's write of a query entry holds on its table's columns. */
export const columnPrivileges = ["SELECT", "INSERT", "UPDATE"] as const
export type ColumnPrivilege = (typeof columnPrivileges)[number]

/**
 * GRANT <privilege> (<columns>) ON TABLE <table> TO <role>. Its revocation is the table's REVOKE of the privilege, which
 * PostgreSQL applies to every column of the table as well, whatever the columns are named by then.
 */
export interface GrantColumns {
	readonly kind: "grantColumns"
	readonly privilege: ColumnPrivilege
	readonly table: ObjectName
	readonly columns: NonEmptyReadonlyArray<string>
	readonly to: string
}

/**
 * ALTER DEFAULT PRIVILEGES [FOR ROLE <owner>] [IN SCHEMA <s>] REVOKE ALL ON <kind> FROM PUBLIC. Without
 * FOR ROLE it is the current role's, the migration identity's when a migration runs it, so a drafted migration never
 * names the owner.
 * PostgreSQL adds per-schema default ACLs to the global ones and cannot revoke a global default per schema, so the
 * built-in PUBLIC EXECUTE on functions and PUBLIC USAGE on types are reset only by the global form, without
 * IN SCHEMA (future objects receive nothing implicitly).
 */
export interface AlterDefaultPrivileges {
	readonly kind: "alterDefaultPrivileges"
	/** Undefined: the current role. */
	readonly forRole: string | undefined
	/** Undefined: the global form, for every schema in the database. */
	readonly inSchema: string | undefined
	readonly privileges: NonEmptyReadonlyArray<Privilege>
	readonly on: "TABLES" | "SEQUENCES" | "FUNCTIONS" | "TYPES"
	readonly from: NonEmptyReadonlyArray<Grantee>
}

/** Always IF NOT EXISTS: Setup creates an extension only when absent. */
export interface CreateExtension {
	readonly kind: "createExtension"
	readonly name: string
	/** The schema the extension's objects live in: the installation names one for every extension it creates. */
	readonly schema: string
}

/** Extended statistics over at least two columns, as PostgreSQL requires; an empty kind list is every kind. */
export interface CreateStatistics {
	readonly kind: "createStatistics"
	readonly name: ObjectName
	readonly statistics: ReadonlyArray<"ndistinct" | "dependencies" | "mcv">
	readonly columns: readonly [string, string, ...Array<string>]
	readonly table: ObjectName
}

type LockMode = "ACCESS SHARE" | "SHARE" | "SHARE ROW EXCLUSIVE" | "EXCLUSIVE" | "ACCESS EXCLUSIVE"

/**
 * LOCK TABLE: the Validate phase's lock excluding every writer to a law's participating tables, and the ledger's fence
 * (deploy/ledger/ledger.ts): a migration file's ACCESS EXCLUSIVE, which waits, and a Db transaction's ACCESS SHARE,
 * which a conflict refuses at once (NOWAIT).
 */
export interface LockTable {
	readonly kind: "lockTable"
	readonly tables: NonEmptyReadonlyArray<ObjectName>
	readonly mode: LockMode
	readonly wait: "wait" | "nowait"
}

export interface PlDeclaration {
	readonly name: string
	readonly type: TypeRef
}

export interface RaiseOption {
	readonly option:
		| "ERRCODE"
		| "CONSTRAINT"
		| "DETAIL"
		| "HINT"
		| "MESSAGE"
		| "SCHEMA"
		| "TABLE"
		| "COLUMN"
	readonly value: Expr
}

/** A PERFORM's query: the SELECT whose leading keyword PERFORM replaces, so it has no WITH and its body is one core. */
export interface PerformQuery {
	readonly body: SelectCore
	readonly orderBy: ReadonlyArray<OrderItem>
	readonly limit: Expr | undefined
	readonly offset: Expr | undefined
}

export type PlStatement =
	| {
			readonly kind: "if"
			readonly branches: NonEmptyReadonlyArray<{
				readonly condition: Expr
				readonly body: ReadonlyArray<PlStatement>
			}>
			readonly else: ReadonlyArray<PlStatement>
	  }
	| { readonly kind: "assign"; readonly target: string; readonly value: Expr }
	| {
			readonly kind: "forQuery"
			readonly variable: string
			readonly query: Select
			readonly body: ReadonlyArray<PlStatement>
	  }
	| { readonly kind: "perform"; readonly query: PerformQuery }
	| {
			/** PERFORM <probe>; IF NOT FOUND THEN <body> END IF: the probe and what its emptiness obliges, one statement,
			 * so FOUND is read only right after the probe that set it. */
			readonly kind: "whenAbsent"
			readonly probe: PerformQuery
			readonly body: NonEmptyReadonlyArray<PlStatement>
	  }
	| {
			/** An exhaustive CASE: no ELSE, so a value no WHEN lists raises CASE_NOT_FOUND. */
			readonly kind: "case"
			readonly operand: Expr
			readonly whens: NonEmptyReadonlyArray<{
				readonly values: NonEmptyReadonlyArray<Expr>
				readonly body: ReadonlyArray<PlStatement>
			}>
	  }
	| { readonly kind: "raise"; readonly message: string; readonly using: ReadonlyArray<RaiseOption> }
	| { readonly kind: "return"; readonly value: Expr }

/** A block's statements are at least one: a trigger function that falls off its end without RETURN fails. */
export interface PlBlock {
	readonly declare: ReadonlyArray<PlDeclaration>
	readonly body: NonEmptyReadonlyArray<PlStatement>
}

/** One argument of a function: the refusal function's three texts (write/refusal.ts). A trigger function takes none. */
export interface FunctionParam {
	readonly name: string
	readonly type: TypeRef
}

/**
 * A function grizzle installs, by language, each under closedSearchPath (`SET search_path = pg_catalog, pg_temp`), so
 * no caller's path reaches its body:
 *
 * - PL/pgSQL: CREATE OR REPLACE FUNCTION <schema>.<name>(<params>) RETURNS trigger | boolean | void LANGUAGE plpgsql
 *   VOLATILE [PARALLEL SAFE] SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET plan_cache_mode =
 *   force_custom_plan: the law functions, the isolation guard, and the refusal function `<schema>.__refuse(text, text,
 *   text) RETURNS boolean`, whose body raises its arguments, and the serial advance functions, which return nothing
 *   (physical/ddl/advance.ts).
 *   The plan cache mode plans each of a law function's queries for the key values of
 *   the firing, so a skewed group never moves the function onto a generic plan that scans the whole source. A trigger
 *   function takes no argument;
 * - SQL: CREATE OR REPLACE FUNCTION <schema>.<name>(<params>) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 *   SET search_path = pg_catalog, pg_temp SET plan_cache_mode = force_generic_plan RETURN <expr>: a writable entry's
 *   world functions, its filter that reads another relation, which its policy and its writes' prechecks call, and its
 *   key and unique probes (physical/ddl/roles.ts). Its body names its arguments by position (`$n`), never by name, so
 *   no argument can be read as a column of a relation the body reads. PostgreSQL parses this body under the creating
 *   session's path, not the function's, so only its absolute names make it mean one thing.
 *
 * `parallel` is the function's parallel safety: SAFE prints PARALLEL SAFE; UNSAFE, PostgreSQL's own default, prints no
 * clause. Only the refusal function is SAFE, so a statement that reads the claims still plans in parallel.
 */
export type CreateFunction =
	| ({
			readonly kind: "createFunction"
			readonly language: "plpgsql"
			readonly name: ObjectName
			readonly volatility: "VOLATILE"
			readonly parallel: "SAFE" | "UNSAFE"
			readonly security: "DEFINER"
			readonly planCacheMode: "force_custom_plan"
			readonly body: PlBlock
	  } & (
			| { readonly returns: "trigger"; readonly params: readonly [] }
			| { readonly returns: "boolean"; readonly params: ReadonlyArray<FunctionParam> }
			| { readonly returns: "void"; readonly params: ReadonlyArray<FunctionParam> }
	  ))
	| {
			readonly kind: "createFunction"
			readonly language: "sql"
			readonly name: ObjectName
			readonly volatility: "STABLE"
			readonly parallel: "SAFE" | "UNSAFE"
			readonly security: "DEFINER"
			/**
			 * The body is planned once per session, its arguments as parameters: an existence test its indexes serve at
			 * any argument values gains nothing from a custom plan.
			 */
			readonly planCacheMode: "force_generic_plan"
			readonly returns: "boolean"
			readonly params: ReadonlyArray<FunctionParam>
			readonly body: Expr
	  }

/** A PL/pgSQL function, and an SQL one. */
export type PlFunction = Extract<CreateFunction, { readonly language: "plpgsql" }>
export type SqlFunction = Extract<CreateFunction, { readonly language: "sql" }>

/** Every transaction is SERIALIZABLE. */
export type Txn =
	| { readonly kind: "begin"; readonly readOnly: boolean }
	| { readonly kind: "commit" }
	| { readonly kind: "rollback" }

/** REFRESH MATERIALIZED VIEW [CONCURRENTLY]. */
export interface Refresh {
	readonly kind: "refresh"
	readonly view: ObjectName
	readonly concurrently: boolean
}

/**
 * ANALYZE of a write program's own transaction-scoped carriers after they are filled, so the statements that join them
 * against stored relations plan with their exact row counts. It names carriers only, each printed under pg_temp, which
 * resolves to the session's own temporary schema and never to a stored relation; the library never analyzes a stored
 * relation. Each name is a carrier an earlier statement of the program created, which the test kernel's program audit
 * checks.
 */
export interface Analyze {
	readonly kind: "analyze"
	/** At least one: ANALYZE of no relation analyzes every relation of the database. */
	readonly carriers: NonEmptyReadonlyArray<CarrierName>
}

/**
 * What a COMMENT names: a schema or a role by its bare name; a relation, type, domain, sequence, index or statistics
 * object by its qualified name; a column of a table or view; a table's constraint, trigger or policy, on its table; a
 * domain's constraint, on its domain; a function by its signature.
 */
export type CommentTarget =
	| { readonly kind: "SCHEMA" | "ROLE"; readonly name: string }
	| {
			readonly kind:
				| "TABLE"
				| "VIEW"
				| "MATERIALIZED VIEW"
				| "TYPE"
				| "DOMAIN"
				| "SEQUENCE"
				| "INDEX"
				| "STATISTICS"
			readonly name: ObjectName
	  }
	| { readonly kind: "COLUMN"; readonly relation: ObjectName; readonly column: string }
	| {
			readonly kind: "CONSTRAINT" | "TRIGGER" | "POLICY"
			readonly name: string
			readonly on: ObjectName
	  }
	| { readonly kind: "DOMAIN CONSTRAINT"; readonly name: string; readonly domain: ObjectName }
	| { readonly kind: "FUNCTION"; readonly name: FunctionName }

/**
 * COMMENT ON <object> IS <text>: an installed object's comment holds what the naming door says it is, its declared
 * name or its identity spelled out (core/identity.ts displayOf), so a direct SQL writer reads the mapping in the
 * catalog.
 */
export interface Comment {
	readonly kind: "comment"
	readonly on: CommentTarget
	readonly text: string
}

export type Dml = Select | Insert | Update | Delete | Merge

/**
 * Every statement that creates, changes or drops a schema object grizzle installs. Grizzle writes names into the type,
 * function and relation namespaces only: no variant creates an operator, an operator class or a collation, which is why
 * an operator prints bare while every other name prints by its schema. A variant that creates an operator reopens that
 * rule, and with it the search_path every bare operator resolves through.
 */
export type Ddl =
	| CreateSchema
	| CreateTable
	| AlterTable
	| RenameObject
	| RenameColumn
	| RenameConstraint
	| CreateDomain
	| AlterDomain
	| CreateEnum
	| AlterEnumAddValue
	| AlterEnumRenameValue
	| CreateIndex
	| DropIndex
	| CreateMaterializedView
	| CreateView
	| CreatePolicy
	| DropPolicy
	| DropObject
	| DropFunction
	| DropTrigger
	| CreateFunction
	| CreateConstraintTrigger
	| CreateGuardTrigger
	| AlterDatabaseDefault
	| CreateRole
	| AlterRole
	| GrantRole
	| RevokeRole
	| Grant
	| Revoke
	| GrantColumns
	| AlterDefaultPrivileges
	| CreateExtension
	| CreateStatistics
	| LockTable
	| Comment

export type SqlStatement = Dml | Ddl | CreateCarrier | Txn | Refresh | Analyze

/** SQL text printed from a statement's AST: emit (sql/emit.ts) spells it, and nothing else. */
export type EmittedText = string & { readonly [emittedTextBrand]: true }
declare const emittedTextBrand: unique symbol

/** The emitted product of one statement: its text and the generated-name map diagnostics show. */
export interface EmittedSql {
	readonly text: EmittedText
	readonly nameMap: NameMap
}
