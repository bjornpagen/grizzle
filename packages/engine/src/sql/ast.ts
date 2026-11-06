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
	"record",
	"bit varying",
	"name"
] as const
export type BuiltinTypeName = (typeof builtinTypeNames)[number]

/** What a function grizzle installs returns. */
export type FunctionReturns = "trigger" | "boolean" | "void"

/** The pg_catalog types only a catalog read, or a relation reference, names. */
export type CatalogReadType =
	| "oid"
	| "char"
	| "regclass"
	| "regnamespace"
	| "regtype"
	| "regprocedure"

/** Every pg_catalog type grizzle's SQL names. */
export type CatalogTypeName =
	| BuiltinTypeName
	| FunctionReturns
	| CatalogReadType
	| "jsonpath"
	| "bit"

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
	bit: "keyword",
	"bit varying": "keyword",
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
 * The schema of a named type: the installation's, for a domain, or the vector extension's. Only the doors
 * that name those schemas mint it (physical/ddl/names.ts, physical/install/extension.ts), and a snapshot read back holds
 * the ones they minted, so no named type sits in pg_catalog: a pg_catalog type is builtin.
 */
export type TypeSchema = string & { readonly [typeSchemaBrand]: true }
declare const typeSchemaBrand: unique symbol

/** A named type by its schema and its name: a domain's, or the vector extension's vector. */
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
			readonly kind: "builtin"
			readonly name: "bit"
			readonly precision: undefined
			readonly scale: undefined
			/** n of bit(n): a set over a roster has one bit per code, holes included. */
			readonly length: number
			readonly array: false
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
 * - text: any value spelled by its type's input function: text, uuid, bit strings, ranges, money, vectors.
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
	"&",
	"|",
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
 * database default's statement; a relation input's arrays are a FROM item of their own. Extension functions
 * (pgvector) are qualified by their extension's schema instead.
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
	"current_database",
	"substring",
	"bit_count",
	"bit_or",
	"string_agg",
	"generate_subscripts"
] as const
export type BuiltinFunctionName = (typeof builtinFunctionNames)[number]

/**
 * A function of a named schema, qualified by it and quoted: an extension's, or one of the installation's constants, a
 * call of which with no arguments reads the constant.
 */
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
	| {
			readonly kind: "inQuery"
			readonly expr: Expr
			readonly query: OperandSelect
			readonly not: boolean
	  }
	| { readonly kind: "exists"; readonly query: OperandSelect; readonly not: boolean }
	| { readonly kind: "subquery"; readonly query: OperandSelect }
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
	| {
			/** ~ x, PostgreSQL's prefix bitnot of a bit string: it sets the hole and padding bits, so no set is read off it. */
			readonly kind: "complement"
			readonly expr: Expr
	  }
	| {
			/** NULLIF(expr, absent): a closed relation's absent cell as NULL, never a value that could feed another read. */
			readonly kind: "nullif"
			readonly expr: Expr
			readonly absent: Expr
	  }
	| {
			/** (array)[index], counted from 1, NULL past either end: a names constant's element. */
			readonly kind: "subscript"
			readonly array: Expr
			readonly index: Expr
	  }

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
 * One column of a relation input or a context source: its name, its type and its collation. A column of builtin text
 * names the fixed collation, so an input's text column carries pg_catalog.pg_c_utf8 like every stored column:
 * otherwise it has the database default collation, and a recursive CTE seeded from it disagrees with its step's stored
 * columns and is refused with 42P21.
 */
export interface ColumnDefinition {
	readonly name: string
	readonly type: TypeRef
	readonly collation: Collation | undefined
}

/**
 * One column of a relation input read from arrays: its definition, whose type is the element type, and the value
 * placeholder of the array of its values, one element per fact, in the input's fact order.
 */
export interface ArrayColumn {
	readonly definition: ColumnDefinition
	readonly array: ValuePlaceholder
}

/**
 * What a relation input's arrays hold: one array per column, all of one length, read in lockstep, one row per index;
 * or, for an input of no column, which PostgreSQL holds as rows of no column, the count of its facts.
 */
export type ArraysSource =
	| { readonly kind: "columns"; readonly columns: NonEmptyReadonlyArray<ArrayColumn> }
	| { readonly kind: "count"; readonly count: ValuePlaceholder }

/**
 * A FROM item that is no join chain: a relation, a CTE reference, a derived table, a function's rows, a relation
 * input's arrays, a VALUES list or a context source. A join chain joins sources only, so its length is never a depth.
 */
export type FromSource =
	| { readonly kind: "table"; readonly table: TableName; readonly alias: string }
	| { readonly kind: "cte"; readonly name: string; readonly alias: string | undefined }
	| { readonly kind: "enclosing"; readonly name: string; readonly alias: string }
	| {
			readonly kind: "derived"
			/** A query whose rows may repeat only under a core that is an operand or deduplicates (OperandCore). */
			readonly query: OperandSelect
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
			/**
			 * A relation input, a relation parameter's or a write's member slot, as the rows of its arrays (sql/print.ts):
			 * its columns' arrays read in lockstep, or its count of rows of no column.
			 */
			readonly kind: "arrays"
			readonly source: ArraysSource
			readonly alias: string
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
 * Why a plain core, one without DISTINCT, delivers no row twice: the proof a set core carries in place of a duplicate
 * elimination, a claim its builder states and the SQL audit holds it to where the core's own shape shows it.
 *
 * - `oneRow`: at most one row: no FROM, aggregates and no GROUP BY, or the body of a query whose LIMIT is 1.
 * - `grouped`: grouped, each GROUP BY expression among its targets, so each group is one row.
 * - `keyed`: every source its FROM reads is a set, and its targets hold a key of their rows: a stored relation's or a
 *   catalog's key, a set's whole heading, or a key its WHERE fixes.
 * - `certified`: the physical analysis proved its plain form unique, which the plan's multiplicity certificate states.
 * - `input`: it reads relation inputs' arrays, which the host codec made sets, through every column.
 */
export type RowsProof = "oneRow" | "grouped" | "keyed" | "certified" | "input"

/** What every core holds besides its projection. An empty FROM or GROUP BY is none, an undefined WHERE or HAVING none. */
interface CoreFrame {
	readonly kind: "core"
	readonly from: ReadonlyArray<FromItem>
	readonly where: Expr | undefined
	readonly groupBy: ReadonlyArray<Expr>
	readonly having: Expr | undefined
}

/**
 * A core whose rows are a set (SELECT DISTINCT, DISTINCT ON, or a plain core carrying its RowsProof), which may stand
 * anywhere a query stands.
 */
export type SetCore = CoreFrame & (ProvedProjection | DistinctProjection)

/**
 * A plain core with no proof: its rows may repeat, so it stands only as the operand of the operator that makes them a
 * set: an arm of UNION, INTERSECT or EXCEPT, the query of EXISTS, IN or a scalar subquery, or a derived table under a
 * core that is itself one or deduplicates (the SQL audit holds every operand there).
 */
export type OperandCore = CoreFrame & OperandProjection

/** A SELECT core: its projection over its FROM, a set core or an operand. */
export type SelectCore = SetCore | OperandCore

/** A plain core's projection under its proof. */
interface ProvedProjection {
	readonly distinct: false
	readonly rows: RowsProof
	readonly targets: ReadonlyArray<Target>
}

/** A plain core's projection whose rows may repeat. */
interface OperandProjection {
	readonly distinct: false
	readonly rows: "operand"
	readonly targets: ReadonlyArray<Target>
}

/**
 * DISTINCT, or DISTINCT ON its expressions, at least one, which reads at least one target, as PostgreSQL's grammar
 * requires.
 */
interface DistinctProjection {
	readonly distinct: true | { readonly on: NonEmptyReadonlyArray<Expr> }
	readonly targets: NonEmptyReadonlyArray<Target>
}

/**
 * What a core delivers of each row it reads: `distinct` is false for none, under its `rows` (a proof, or `operand`), true
 * for DISTINCT, or DISTINCT ON its expressions. A core of no target reads one row of no column for each row of its
 * FROM, the unit relation's rows.
 */
export type CoreProjection = ProvedProjection | OperandProjection | DistinctProjection

/**
 * The set operators. INTERSECT and EXCEPT have no ALL form here, and UNION ALL is set-making only over arms proved
 * pairwise disjoint (UnionAll).
 */
export type SetOperator = "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT"

/**
 * A set-operation arm: a core, or a parenthesized full query with its own clauses. A set operation nests only as the
 * body of such a query, so a chain of one operator is one node however many arms it has.
 */
export type SetOperand = SelectCore | OperandSelect

/** A set arm: a set core, or a parenthesized query whose rows are a set. */
export type SetArm = SetCore | Select

/**
 * Why a UNION ALL repeats no row: its arms are sets told apart pairwise by a discriminant column whose values its
 * builder fixes apart, a literal in each arm or a column of literals no other arm holds (`disjoint`); the physical
 * analysis proved them unique and disjoint (`certified`, R17.unionAll); or it is the body of a query whose LIMIT is 1,
 * at most one row of any arms (`oneRow`). Or `operand`, a UNION ALL that stands only as an operand, as an operand core
 * does.
 */
export type UnionAllRows = "disjoint" | "certified" | "oneRow" | "operand"

/** At least two arms combined by one operator, left to right: `a op b op c` is `(a op b) op c`. */
export type SetOperation =
	| {
			readonly kind: "setOp"
			readonly op: "UNION" | "INTERSECT" | "EXCEPT"
			readonly arms: readonly [SetOperand, SetOperand, ...Array<SetOperand>]
	  }
	| UnionAll

/** A UNION ALL: over set arms under its proof, over any arms under its query's LIMIT 1, or over any arms as an operand. */
export type UnionAll =
	| {
			readonly kind: "setOp"
			readonly op: "UNION ALL"
			readonly rows: "disjoint" | "certified"
			readonly arms: readonly [SetArm, SetArm, ...Array<SetArm>]
	  }
	| {
			readonly kind: "setOp"
			readonly op: "UNION ALL"
			readonly rows: "oneRow"
			readonly arms: readonly [SetOperand, SetOperand, ...Array<SetOperand>]
	  }
	| {
			readonly kind: "setOp"
			readonly op: "UNION ALL"
			readonly rows: "operand"
			readonly arms: readonly [SetOperand, SetOperand, ...Array<SetOperand>]
	  }

/** A set operation whose rows are a set: every one but a UNION ALL that stands as an operand. */
export type SetSetOperation = Exclude<SetOperation, { readonly rows: "operand" }>

/** A query body whose rows are a set. */
export type SelectBody = SetCore | SetSetOperation | Select

/** Any query body: one whose rows may repeat stands only as an operand (OperandSelect). */
export type OperandBody = SelectCore | SetOperation | OperandSelect

/**
 * Whether a body's rows are a set: a set core, a set operation but a UNION ALL that stands as an operand, or a query of
 * a set body. A traversal that rebuilt a set query reads it back as one through this check.
 */
export const isSetBody = (body: OperandBody): body is SelectBody => {
	switch (body.kind) {
		case "core":
			return body.distinct !== false || body.rows !== "operand"
		case "setOp":
			return body.op !== "UNION ALL" || body.rows !== "operand"
		case "select":
			return isSetQuery(body)
	}
}

/** Whether a query's rows are a set: its body's are (isSetBody). */
export const isSetQuery = (query: OperandSelect): query is Select => isSetBody(query.body)

/** A query CTE's rows may repeat only where every reader of it is an operand or deduplicates, as a derived table's. */
export type CteBody = OperandSelect | Insert | Update | Delete | Merge

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
 * A full query whose rows are a set, its body a set body. An undefined WITH, LIMIT or OFFSET is none, and so is an
 * empty ORDER BY. No query locks a row: every transaction is SERIALIZABLE, and SSI orders it
 * (physical/ddl/isolation.ts).
 */
export interface Select {
	readonly kind: "select"
	readonly with: With | undefined
	readonly body: SelectBody
	readonly orderBy: ReadonlyArray<OrderItem>
	readonly limit: Expr | undefined
	readonly offset: Expr | undefined
}

/**
 * A full query whose rows may repeat: the operand of the operator that makes them a set, where an operand core stands
 * (OperandCore). Every Select is one.
 */
export interface OperandSelect {
	readonly kind: "select"
	readonly with: With | undefined
	readonly body: OperandBody
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

/**
 * How a column is generated: an identity from its sequence; a STORED expression of the row; or a partial projection,
 * `GENERATED ALWAYS AS (CASE WHEN <when> THEN <expr> END) STORED`, which holds `expr` where `when` is true and NULL
 * everywhere else. A partial projection is the one form that yields NULL, so it never reaches an expression.
 */
export type ColumnGeneration =
	| { readonly kind: "identity"; readonly sequence: ObjectName }
	| { readonly kind: "stored"; readonly expr: Expr }
	| { readonly kind: "partial"; readonly when: Expr; readonly expr: Expr }

/**
 * A column. Every column is NOT NULL but a partial projection's, which is NULL outside its selection, so a key over it is
 * a key of the selected rows alone (UNIQUE NULLS DISTINCT) and a reference out of it binds only those (MATCH SIMPLE). An
 * undefined collation or generation is none, and a column has no default: a drafted ADD COLUMN's placeholder is its own
 * action (AlterTableAction addColumnPlaceholder).
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
			/** Printed `UNIQUE NULLS DISTINCT`: a row NULL in a column is never a duplicate. */
			readonly kind: "unique"
			readonly name: string
			readonly columns: NonEmptyReadonlyArray<KeyColumn>
	  }
	| {
			/** Printed `MATCH SIMPLE`: a row NULL in a referencing column references nothing. */
			readonly kind: "foreignKey"
			readonly name: string
			readonly columns: NonEmptyReadonlyArray<ForeignKeyColumn>
			readonly references: ObjectName
			readonly referencedColumns: NonEmptyReadonlyArray<ForeignKeyColumn>
			/** Undefined: NOT DEFERRABLE. */
			readonly deferrable: "INITIALLY DEFERRED" | "INITIALLY IMMEDIATE" | undefined
			/** ON UPDATE CASCADE, or undefined for NO ACTION, PostgreSQL's default, which prints no clause. */
			readonly onUpdate: "CASCADE" | undefined
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
	| {
			/**
			 * ADD COLUMN ... DEFAULT <default> NOT NULL: a column grizzle draws, added to a table that may hold rows under a
			 * value its migration's backfill overwrites before the DROP DEFAULT (deploy/diff/backfill.ts).
			 */
			readonly kind: "addColumnDefault"
			readonly column: ColumnDef
			readonly default: Expr
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
	| {
			/**
			 * ALTER COLUMN <column> SET EXPRESSION AS (<expr>): a generated column's expression replaced, which rewrites
			 * the table once for every column the statement re-expresses.
			 */
			readonly kind: "setExpression"
			readonly column: string
			readonly expr: Expr
	  }

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
			readonly object: "TABLE" | "MATERIALIZED VIEW" | "VIEW" | "DOMAIN" | "SEQUENCE"
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
 * The role-level settings of one text value Publish stores for a login, each one a grizzle guarantee rests on:
 * extra_float_digits, under which float text is shortest round-trip; lc_monetary, lc_numeric and lc_time, the locale
 * categories a value's text can depend on, money's two fractional digits among them; and pgvector's strict-order
 * iterative scan, on which an approximate read's order and its cursors rest (check/approximate/policy.ts). An
 * `hnsw.*` name is a placeholder until the vector library is loaded in the session that stores it. Every other
 * setting is the database owner's.
 */
export const textParameters = [
	"extra_float_digits",
	"lc_monetary",
	"lc_numeric",
	"lc_time",
	"hnsw.iterative_scan"
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

/**
 * The migration's pack of a closed relation into its constant, printed as one DO block: the string of cells built
 * from rows of codes in one LEFT JOIN over the key space, then EXECUTE format('CREATE FUNCTION … RETURN %L::bit
 * varying', cells). Its outer join and its PL/pgSQL exist only inside this printed form: no Select and no PlStatement
 * can hold either.
 */
export interface PackConstant {
	readonly kind: "packConstant"
	readonly function: ObjectName
	/** Each key field's code space, holes included, in key order; their product is the count of cells. */
	readonly radices: NonEmptyReadonlyArray<number>
	/** w, a cell's bits: 1 for a set. */
	readonly width: number
	/**
	 * The relation's tuples, its key checked before the pack: none for a relation that holds no fact, whose constant is
	 * its cells' zero bits, which the printer builds with no VALUES list, since PostgreSQL has no empty one.
	 */
	readonly rows: ReadonlyArray<PackRow>
}

/** One tuple of a packed relation: its key's codes in key order, its payload's code, and the names they stand for. */
export interface PackRow {
	readonly key: NonEmptyReadonlyArray<number>
	/** The payload's mixed-radix code, exact over any payload space. */
	readonly payload: bigint
	/** The handles the codes stand for, printed as the row's comment, each a JSON string. */
	readonly names: NonEmptyReadonlyArray<string>
}

/**
 * CREATE FUNCTION <name>(<params>) RETURNS <type> LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN <body>: a constant.
 * Never OR REPLACE: a domain's planned check keeps the constant it folded, so a function changed under it would go
 * unseen, and a new constant is a new name. No SET clause: a function with one is never inlined, and its body names
 * every type and function by its schema. A parameter is read by position, $n, as every grizzle SQL body reads.
 */
export interface CreateConstant {
	readonly kind: "createConstant"
	readonly name: ObjectName
	readonly params: ReadonlyArray<FunctionParam>
	readonly returns: TypeRef
	readonly body: Expr
}

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
	| PackConstant
	| CreateConstant
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
