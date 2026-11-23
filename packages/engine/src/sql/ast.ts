import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { nominal } from "#compiler/core/brand.ts"
import type { FloatSpecialName } from "#compiler/core/canonical.ts"
import type { ClockUnit } from "#compiler/core/clock.ts"
import type { DeclaredLanguage } from "#compiler/core/function.ts"
import type { IndexMethod } from "#compiler/core/identity.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { Assignments } from "#compiler/sql/generation.ts"
import type { CarrierName, NameMap } from "#compiler/sql/naming.ts"

/** A schema object's name, always schema-qualified: every object grizzle installs or names lives in a named schema. */
export interface ObjectName {
	readonly schema: string
	readonly name: string
}

declare const nameKeyBrand: unique symbol
declare const storedColumnKeyBrand: unique symbol

/**
 * A schema object's name as one text, the key every map of objects by name is keyed by: its schema's identifier and
 * its own, a NUL between, which no PostgreSQL identifier holds, so two names share a key only where they are one name,
 * where a key spelled `<schema>.<name>` is shared by `"a.b"."c"` and `"a"."b.c"`.
 */
export type NameKey = string & { readonly [nameKeyBrand]: true }

/** A column of a table or a materialized view as one text: its relation's key (NameKey), a NUL, and its own name. */
export type StoredColumnKey = string & { readonly [storedColumnKeyBrand]: true }

const mintNameKey = nominal<string, NameKey>()
const mintStoredColumnKey = nominal<string, StoredColumnKey>()

/** The key of the object `name` names (NameKey). */
export const nameKey = (name: ObjectName): NameKey =>
	mintNameKey(`${name.schema}\u0000${name.name}`)

/** The key of the column `column` of the relation whose key is `table` (StoredColumnKey). */
export const storedColumnKey = (table: NameKey, column: string): StoredColumnKey =>
	mintStoredColumnKey(`${table}\u0000${column}`)

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
 * The one collation grizzle names on a column, a domain or an expression: the builtin pg_catalog.pg_c_utf8, forced on
 * every schema. It is a closed constant, so no other collation, locale or provider is representable; the kernel's audit
 * requires it on every column and domain of builtin type text. The C collation stands only inside a text's ASCII case
 * fold (Expr's `lowerAscii`), as lower's operand, and no expression's value is collated C.
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
	"date",
	"inet",
	"cidr",
	"bytea",
	"jsonb",
	"money",
	"int4range",
	"int8range",
	"daterange",
	"int4multirange",
	"int8multirange",
	"datemultirange",
	"record",
	"bit varying",
	"name",
	"tsvector",
	"regconfig",
	"char",
	"interval",
	"pg_dependencies"
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
	| "pg_lsn"

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
	date: "qualified",
	inet: "qualified",
	cidr: "qualified",
	bytea: "qualified",
	jsonb: "qualified",
	jsonpath: "qualified",
	money: "qualified",
	int4range: "qualified",
	int8range: "qualified",
	daterange: "qualified",
	int4multirange: "qualified",
	int8multirange: "qualified",
	datemultirange: "qualified",
	record: "qualified",
	bit: "keyword",
	"bit varying": "keyword",
	trigger: "qualified",
	void: "qualified",
	name: "qualified",
	tsvector: "qualified",
	regconfig: "qualified",
	oid: "qualified",
	char: "qualified",
	regclass: "qualified",
	regnamespace: "qualified",
	regtype: "qualified",
	regprocedure: "qualified",
	pg_lsn: "qualified",
	interval: "keyword",
	pg_dependencies: "qualified"
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
 * - text: any value spelled by its type's input function: text, uuid, ranges, money, vectors;
 * - bits: a bit string as its hex digits (core/hex.ts), whole digits in 0-9 and A-F, printed `X'<digits>'` and cast:
 *   the one spelling of every bit string grizzle writes, a set's literal and a constant's alike.
 *
 * No literal is NULL: grizzle writes no NULL for a value (the SQL audit's null rule).
 */
export type LiteralValue =
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "int"; readonly value: bigint }
	| { readonly kind: "decimal"; readonly value: string }
	| { readonly kind: "float"; readonly value: FiniteFloat }
	| { readonly kind: "floatSpecial"; readonly value: FloatSpecialName }
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "bits"; readonly hex: string }

const binaryOperators = [
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
	"<<=",
	">>",
	"&",
	"|",
	"&<",
	"&>",
	"-|-",
	"<=>",
	"@@"
] as const
export type BinaryOperator = (typeof binaryOperators)[number]

/**
 * PostgreSQL builtin functions grizzle emits, printed qualified by pg_catalog. the scalar catalogue, the text functions
 * a double's parse reads its text by (lower/conservative/expr/parse-double.ts), the aggregates, window and ordered-set
 * functions of the compile-target catalog, a float's identity image (float8send, ops.ts floatBitsForm), the exact value of a double's bits (float8send and
 * get_byte, build.ts exactNumericOfDouble), the span functions, the attachment transport, a bytes value's chunks
 * (lower/delivery.ts), the runtime probes, the rule judge's reads of its session tables in the catalog
 * (physical/ddl/rules.ts judged), the database default's
 * statement and the binary comparison of two rows, the function of PostgreSQL's `*<>` (record_image_ne), by which a
 * migration's backfill writes only the rows whose drawn values change (deploy/diff/backfill.ts staged), and full text
 * search's parse, weighting, query parse and ranks (lower/conservative/search), and a stamp function's reading of its own
 * transaction's id (physical/ddl/stamps.ts); a relation input's arrays are a FROM
 * item of their own. Extension functions (pgvector) are qualified by their extension's schema instead. Each with where
 * its call computes (`reach`): over its row's values, or over many rows, as an aggregate or a window function does.
 */
export const builtinFunctions = {
	count: { reach: "rows" },
	sum: { reach: "rows" },
	avg: { reach: "rows" },
	min: { reach: "rows" },
	max: { reach: "rows" },
	bool_and: { reach: "rows" },
	bool_or: { reach: "rows" },
	range_agg: { reach: "rows" },
	array_agg: { reach: "rows" },
	jsonb_agg: { reach: "rows" },
	row_number: { reach: "rows" },
	rank: { reach: "rows" },
	dense_rank: { reach: "rows" },
	lead: { reach: "rows" },
	lag: { reach: "rows" },
	first_value: { reach: "rows" },
	percentile_disc: { reach: "rows" },
	percentile_cont: { reach: "rows" },
	mode: { reach: "rows" },
	abs: { reach: "row" },
	sign: { reach: "row" },
	gcd: { reach: "row" },
	lcm: { reach: "row" },
	power: { reach: "row" },
	sqrt: { reach: "row" },
	min_scale: { reach: "row" },
	trim_scale: { reach: "row" },
	scale: { reach: "row" },
	float8send: { reach: "row" },
	get_byte: { reach: "row" },
	width_bucket: { reach: "row" },
	round: { reach: "row" },
	trunc: { reach: "row" },
	ceil: { reach: "row" },
	floor: { reach: "row" },
	div: { reach: "row" },
	mod: { reach: "row" },
	char_length: { reach: "row" },
	octet_length: { reach: "row" },
	regexp_count: { reach: "row" },
	starts_with: { reach: "row" },
	right: { reach: "row" },
	strpos: { reach: "row" },
	translate: { reach: "row" },
	btrim: { reach: "row" },
	ltrim: { reach: "row" },
	rtrim: { reach: "row" },
	split_part: { reach: "row" },
	string_to_table: { reach: "row" },
	reverse: { reach: "row" },
	replace: { reach: "row" },
	left: { reach: "row" },
	lower: { reach: "row" },
	upper: { reach: "row" },
	isempty: { reach: "row" },
	lower_inc: { reach: "row" },
	upper_inc: { reach: "row" },
	lower_inf: { reach: "row" },
	upper_inf: { reach: "row" },
	int4range: { reach: "row" },
	int8range: { reach: "row" },
	daterange: { reach: "row" },
	range_minus_multi: { reach: "row" },
	unnest: { reach: "row" },
	string_to_array: { reach: "row" },
	regexp_split_to_table: { reach: "row" },
	ascii: { reach: "row" },
	chr: { reach: "row" },
	to_jsonb: { reach: "row" },
	pg_advisory_xact_lock: { reach: "row" },
	pg_advisory_xact_lock_shared: { reach: "row" },
	pg_drop_replication_slot: { reach: "row" },
	current_setting: { reach: "row" },
	set_config: { reach: "row" },
	pg_jit_available: { reach: "row" },
	format: { reach: "row" },
	current_database: { reach: "row" },
	substring: { reach: "row" },
	bit_count: { reach: "row" },
	set_bit: { reach: "row" },
	get_bit: { reach: "row" },
	bit_or: { reach: "rows" },
	string_agg: { reach: "rows" },
	generate_subscripts: { reach: "row" },
	make_date: { reach: "row" },
	encode: { reach: "row" },
	decode: { reach: "row" },
	convert_to: { reach: "row" },
	generate_series: { reach: "row" },
	num_nonnulls: { reach: "row" },
	sha256: { reach: "row" },
	to_regclass: { reach: "row" },
	pg_relation_size: { reach: "row" },
	to_regprocedure: { reach: "row" },
	pg_get_userbyid: { reach: "row" },
	pg_my_temp_schema: { reach: "row" },
	record_image_ne: { reach: "row" },
	to_tsvector: { reach: "row" },
	setweight: { reach: "row" },
	websearch_to_tsquery: { reach: "row" },
	plainto_tsquery: { reach: "row" },
	ts_rank: { reach: "row" },
	ts_rank_cd: { reach: "row" },
	timezone: { reach: "row" },
	extract: { reach: "row" },
	pg_current_xact_id: { reach: "row" },
	xid: { reach: "row" }
} as const satisfies { readonly [name: string]: { readonly reach: "row" | "rows" } }
export type BuiltinFunctionName = keyof typeof builtinFunctions

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

/**
 * A PL/pgSQL name: a declared variable or parameter, as the rule judge's flags and its session's deltas' names are
 * (physical/ddl/rules.ts addRules), or the trigger row images NEW and OLD, each a record.
 */
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
 * What a reading of the database's clock stands for (Expr `clock`): the declared parameter `param` its served member
 * binds to the clock (ir/clock.ts), or the reading an insert stamps an instant from (write/insert/stamp.ts), which binds
 * no parameter.
 */
export type ClockOf =
	| { readonly kind: "param"; readonly param: string }
	| { readonly kind: "stamp" }

/**
 * The instant a reading of the database's clock counts (Expr `clock`): `transaction`, the instant the call's transaction
 * began, transaction_timestamp(), as every served Db reads it; or `moved`, the instant `at` states, a bigint count of
 * microseconds since the Unix epoch, the placeholder of the instant a Db over a moved clock states at each call
 * (ir/clock.ts ClockSource), one timestamptz, in the range PostgreSQL's timestamptz holds or refused by it.
 */
export type ClockInstant =
	| { readonly kind: "transaction" }
	| { readonly kind: "moved"; readonly at: Expr }

/** The instant the call's transaction began: every reading of a production compile's (ClockInstant `transaction`). */
export const transactionInstant: ClockInstant = Object.freeze({ kind: "transaction" })

/**
 * An expression. A `clock` is a reading of the database's clock, as `of` says (ClockOf): the instant `instant`
 * (ClockInstant), the call's transaction's or that instant moved, counted in `unit` since the Unix epoch and floored,
 * cast to `type` as a placeholder of a parameter would be. It fills no slot of its own: the server reads it, never the
 * call, which states at most a moved instant's offset.
 */
export type Expr =
	| { readonly kind: "column"; readonly table: string | undefined; readonly column: string }
	| { readonly kind: "excluded"; readonly column: string }
	| { readonly kind: "returning"; readonly side: "old" | "new"; readonly column: string }
	| { readonly kind: "param"; readonly slot: ValuePlaceholder; readonly type: TypeRef }
	| {
			readonly kind: "clock"
			readonly of: ClockOf
			readonly instant: ClockInstant
			readonly unit: ClockUnit
			readonly type: TypeRef
	  }
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
			 * At least two items (sql/build.ts isIn): PostgreSQL has no empty IN list, so an empty membership is
			 * `false` (`true` NOT) at its source, and stores an IN list of one item as the equality with it (`<>` NOT,
			 * parse_expr.c transformAExprIn), which is how a membership of one is written.
			 */
			readonly list: readonly [Expr, Expr, ...Array<Expr>]
			readonly not: boolean
	  }
	| {
			readonly kind: "inQuery"
			readonly expr: Expr
			readonly query: OperandSelect
			readonly not: boolean
	  }
	| {
			/**
			 * `<expr> = ANY (<array>)`, through the operator of `schema` where it names one (an extension type's): whether
			 * `expr` equals an element of `array`. Over a column, an index on it serves the comparison as one condition, its
			 * array read once (write/probe.ts keyedAt).
			 */
			readonly kind: "equalsAny"
			readonly expr: Expr
			readonly array: Expr
			readonly schema: string | undefined
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
	| {
			/**
			 * COALESCE(value, …, otherwise): the first of its arguments that is not NULL, each evaluated only while every one
			 * before it is NULL.
			 */
			readonly kind: "coalesce"
			readonly args: NonEmptyReadonlyArray<Expr>
	  }
	| { readonly kind: "mergeAction" }
	| { readonly kind: "domainValue" }
	| User
	| PlRecord
	| { readonly kind: "plSpecial"; readonly name: "TG_TABLE_NAME" | "TG_TABLE_SCHEMA" | "TG_OP" }
	| { readonly kind: "field"; readonly record: PlRecord; readonly field: string }
	| RegclassRef
	| {
			/** ~ x, PostgreSQL's prefix bitnot of a bit string: it sets the hole and padding bits, so no set is read off it. */
			readonly kind: "complement"
			readonly expr: Expr
	  }
	| {
			/**
			 * lower(expr COLLATE "C") COLLATE pg_catalog.pg_c_utf8, a text's ASCII case fold (scalar/compute/registry.ts
			 * textLowerAscii): the C collation's ctype is C, so lower folds A to Z alone, byte by byte, and the fold is
			 * collated back as every text is, so the C collation reaches no comparison, index or regex.
			 */
			readonly kind: "lowerAscii"
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
 * What a relation input's array is checked by as its parameter is bound, beyond its element type: nothing, or a
 * refinement's domain, which the array is cast through before its element type, so PostgreSQL checks every element
 * against the domain's CHECK and the column keeps its base type: a declared relation parameter's refined column, whose
 * contract or pattern nothing on the host checks.
 */
export type ArrayCheck =
	| { readonly kind: "base" }
	| { readonly kind: "domain"; readonly domain: TypeRef }

/**
 * One column of a relation input read from arrays: its definition, whose type is the element type, the value
 * placeholder of the array of its values, one element per fact, in the input's fact order, and what checks the array
 * as it is bound.
 */
export interface ArrayColumn {
	readonly definition: ColumnDefinition
	readonly array: ValuePlaceholder
	readonly check: ArrayCheck
}

/**
 * What a relation input's arrays hold: one array per column, all of one length, read in lockstep, one row per index;
 * or, for an input of no column, which PostgreSQL holds as rows of no column, the count of its facts.
 */
export type ArraysSource =
	| {
			readonly kind: "columns"
			readonly columns: NonEmptyReadonlyArray<ArrayColumn>
			/** The column each row's position among the facts is delivered as, 1 for the first, by the first column's
			 * array's subscripts read in lockstep with the arrays; none where no reader needs the order. */
			readonly ordinal: string | undefined
	  }
	| { readonly kind: "count"; readonly count: ValuePlaceholder }

/**
 * One column of a probed table bound to a value of the row that drives the probe, a column of a source before it, and
 * compared by equality: the builtin operator, or the extension's qualified one over a vector (`schema`, as Expr
 * `binary` holds it).
 */
export interface ProbeColumn {
	readonly column: string
	readonly value: Expr
	readonly schema: string | undefined
}

/** A column a read driven by a row delivers (FromSource `probe`, `met`): the stored table's column it reads, and the
 * statement's own generated name it delivers it under. */
export interface DrivenColumn {
	readonly read: string
	readonly as: string
}

/** A column of an INSERT's met rows (FromSource `metRows`): the proposed CTE's `column`, and the INSERT's RETURNING of
 * the same field, `returned`. */
export interface MetColumn {
	readonly column: string
	readonly returned: string
}

/**
 * A column bound to a met row's column (FromSource `metRows`, `met`): a column of the bound side, `column`, equal to the
 * met rows' column `from`, compared by the builtin operator or the extension's qualified one over a vector (`schema`).
 */
export interface MetKey {
	readonly column: string
	readonly from: string
	readonly schema: string | undefined
}

/**
 * How a probe reaches a stored table's rows from its driving row: at a key, at most one row, its columns of the table,
 * none for a span key whose scalars are none, which its span's overlap in the probe's filter reaches (laws/model/uniques.ts
 * UniqueObject `span`); at a group, the group's rows in `order`, its columns of the table, never none; or at a group's
 * last row in `order`, at most one.
 */
export type ProbeBy =
	| { readonly kind: "key"; readonly columns: ReadonlyArray<ProbeColumn> }
	| {
			readonly kind: "group" | "last"
			readonly columns: NonEmptyReadonlyArray<ProbeColumn>
			readonly order: NonEmptyReadonlyArray<string>
	  }

/**
 * A FROM item that is no join chain: a relation, a CTE reference, a derived table, a function's rows, a relation
 * input's arrays, a VALUES list, a context source, or a write's read of a stored table driven by its rows, a probe or
 * the row an arbitration met. A join chain joins sources only, so its length is never a depth.
 */
export type FromSource =
	| { readonly kind: "table"; readonly table: TableName; readonly alias: string }
	| {
			/**
			 * The stored rows of a table that one driving row reaches by a key or a group (ProbeBy), read once per driving
			 * row: `LATERAL (SELECT "<inner>"."<read>", ... FROM <table> AS "<inner>" WHERE "<inner>"."<by column>" =
			 * <value> AND ... AND <filter> <tail>) AS "<alias>"("<as>", ...)`, the tail a key's `LIMIT 1`, a group's
			 * `ORDER BY <order>`, a group's last row's `ORDER BY <order> DESC LIMIT 1`. A subquery that sorts or limits is
			 * never flattened into a join (prepjointree.c is_simple_subquery), and one in an EXISTS that reads the outer
			 * row in its FROM is never a semi-join (subselect.c convert_EXISTS_sublink_to_join), so PostgreSQL plans it
			 * apart, once per driving row with its values as parameters, and a driver of no row reads nothing. It stands
			 * only as an inner FROM item beside its driver or in an EXISTS, never under an outer join. Every value and
			 * filter reads the row that drives it or the probed row, `<inner>`. The one source a write statement reads a
			 * stored table through besides `met`, so no write reads a relation whole.
			 */
			readonly kind: "probe"
			readonly table: ObjectName
			readonly inner: string
			readonly by: ProbeBy
			readonly filter: ReadonlyArray<Expr>
			readonly columns: NonEmptyReadonlyArray<DrivenColumn>
			readonly alias: string
	  }
	| {
			/**
			 * The requested rows an INSERT proposed and did not insert, its met rows. `insert` is the statement's
			 * data-modifying CTE whose INSERT proposes `proposed` alone, every column of it, and arbitrates by ON CONFLICT
			 * DO NOTHING, with no target or at its primary key, each of `columns` paired with that INSERT's RETURNING of it
			 * (`returned`), each key column too: every row it reads is a row the INSERT proposed and its arbitration met.
			 * They are the proposed rows less those whose key the INSERT returned, a set difference read by sorting, never
			 * by pairing rows: the proposed rows, marked false, and the returned rows, marked true, are one UNION ALL,
			 * `sides`, whose rows of one key are one window partition, and a proposed row is met where no row of its
			 * partition is marked, `hit` false:
			 *
			 *   (SELECT "<marked>"."<column>", ... FROM (SELECT "<sides>"."<column>", ..., "<sides>"."<marker>",
			 *   pg_catalog.bool_or("<sides>"."<marker>") OVER (PARTITION BY "<sides>"."<key column>", ...) AS "<hit>" FROM
			 *   (SELECT "<scan>"."<column>", ..., false FROM "<proposed>" AS "<scan>" UNION ALL SELECT
			 *   "<returned>"."<returned column>", ..., true FROM "<insert>" AS "<returned>") AS "<sides>"("<column>", ...,
			 *   "<marker>")) AS "<marked>" WHERE NOT "<marked>"."<hit>") AS "<alias>"("<column>", ...)
			 *
			 * The sides list `columns`, then each key column `columns` leaves out. A partition holds the rows equal at every
			 * key column by its type's default ordering, the equality `=` compares it by, a vector's included, and no NULL
			 * key reaches either side: the key is the relation's primary key, which no stored row and no row the INSERT
			 * accepts holds NULL. So a proposed row is met exactly where no returned row shares its key, as `NOT EXISTS
			 * (SELECT 1 FROM "<insert>" WHERE <its key> = <the row's key>)` reads it; a returned row's other columns are
			 * read for no row the source delivers. The window sorts the sides once, so no plan reads more than every row of
			 * both once, however PostgreSQL estimates either CTE (two CTEs estimated at a row each were paired as a nested
			 * loop, every proposed row against every returned one), and the source names no NULL and no outer join. The
			 * sides carry every column, never the key alone with the met keys joined back to the proposed rows: under the
			 * same estimate PostgreSQL may plan that join as a nested loop, the proposed rows times the met ones, every row
			 * of both where every row is met, the pairing the window replaces.
			 */
			readonly kind: "metRows"
			readonly insert: string
			readonly proposed: string
			readonly key: NonEmptyReadonlyArray<MetKey>
			readonly columns: NonEmptyReadonlyArray<MetColumn>
			readonly scan: string
			readonly returned: string
			readonly sides: string
			readonly marker: string
			readonly marked: string
			readonly hit: string
			readonly alias: string
	  }
	| {
			/**
			 * The stored row an INSERT's arbitration met for a met row of `rows`, a `metRows` source in scope, at `key`, each
			 * column of `table` bound to a column of `rows`: `LATERAL (SELECT "<inner>"."<column>", ... FROM <table> AS
			 * "<inner>" WHERE "<inner>"."<key column>" = "<rows>"."<from>" AND ... AND <filter> LIMIT 1) AS
			 * "<alias>"("<column>", ...)`, `filter` the object's own conditions over the stored row, a guard's or a span's
			 * overlap. Under a transaction snapshot ON CONFLICT waits on a conflicting row in flight and raises 40001 on one
			 * its snapshot cannot see (nodeModifyTable.c ExecCheckTupleVisible), so the row met is committed and visible to
			 * the statement, and this read finds it. At READ COMMITTED the arbiter skips a row committed after the
			 * statement's snapshot, which this read cannot see, so only the SERIALIZABLE lowering states it
			 * (write/insert/protocol.ts Arbitration).
			 */
			readonly kind: "met"
			readonly table: ObjectName
			readonly inner: string
			readonly rows: string
			readonly key: ReadonlyArray<MetKey>
			readonly filter: ReadonlyArray<Expr>
			readonly columns: NonEmptyReadonlyArray<DrivenColumn>
			readonly alias: string
	  }
	| { readonly kind: "cte"; readonly name: string; readonly alias: string | undefined }
	| {
			/**
			 * A transition table of the statement trigger whose function reads it (CreateTransitionTrigger): the rows the
			 * statement wrote, as it left them (`news`) or found them (`olds`), under `alias`.
			 */
			readonly kind: "transition"
			readonly table: TransitionTable
			readonly alias: string
	  }
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
			/**
			 * A function's rows, each `WITH ORDINALITY` numbered by its place among them, from 1, in one more column
			 * after the function's own: the one order SQL states of a function's rows.
			 */
			readonly kind: "function"
			readonly call: Call
			readonly alias: string
			/** The column alias list, the number's column last where the rows are numbered; an empty one is none. */
			readonly columns: ReadonlyArray<string>
			readonly lateral: boolean
			readonly ordinality: boolean
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
/**
 * One step of a join chain: an inner join on a condition, a LEFT JOIN on one, which keeps each row before it that meets
 * no row of its source, that source's columns NULL, or a cross join.
 */
export type JoinStep =
	| { readonly kind: "on"; readonly source: FromSource; readonly on: Expr }
	| { readonly kind: "left"; readonly source: FromSource; readonly on: Expr }
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
 * member holds any other keys, or a claim is no value of the type it is judged by (ContextColumn `judged`). Every
 * claim the statement reads at the source is a column reference to it, so the source reads the setting and judges the
 * member once, however many columns are read.
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

/**
 * One field of a context source: the key of its claim in the context's member; the column it is delivered as, of its
 * base type; and the type its claim is judged by where the source reads the member, its field's own: a contract's, a
 * pattern's or a roster's domain, else its base. Whoever set the claims, a Db or a direct writer by hand, a claim its
 * refinement refuses raises the domain's 23514 wherever the context is read, never reaching a reader as a base value.
 */
export interface ContextColumn {
	readonly field: string
	readonly column: ColumnDefinition
	readonly judged: TypeRef
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
 * - `input`: it reads relation inputs' arrays, which the host codec made sets, through every column, or a staged member
 *   slot's carrier, which holds those arrays' rows (write/program/slot-carriers.ts).
 * - `facts`: grouped by each of its targets and each float target's being -0, so it delivers no fact twice: a set of
 *   facts by their identity (ir/compare.ts factSet), where -0 and +0 at otherwise equal targets are two rows.
 */
export type RowsProof = "oneRow" | "grouped" | "keyed" | "certified" | "input" | "facts"

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
 * A set-operation arm: a core, or a parenthesized full query with its own clauses. A set operation nests only as the
 * body of such a query, so a chain of one operator is one node however many arms it has.
 */
export type SetOperand = SelectCore | OperandSelect

/** A set arm: a set core, or a parenthesized query whose rows are a set. */
export type SetArm = SetCore | Select

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
			readonly set: Assignments
			readonly where: Expr | undefined
	  }

export type OnConflict =
	| {
			readonly kind: "columns"
			readonly columns: NonEmptyReadonlyArray<string>
			readonly action: ConflictAction
	  }
	| { readonly kind: "constraint"; readonly constraint: string; readonly action: DoNothing }
	| {
			/**
			 * ON CONFLICT DO NOTHING with no conflict target: every unique and exclusion object of the table arbitrates, each
			 * checked speculatively (execIndexing.c ExecInsertIndexTuples, applyNoDupErr), so a row in flight at any of them
			 * sends the insert back to its pre-check, never to a 23505 or 23P01; it arbitrates every declared key of the
			 * table. Under a transaction snapshot a conflicting row the snapshot cannot see raises 40001.
			 */
			readonly kind: "every"
			readonly action: DoNothing
	  }

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
	readonly onConflict: OnConflict | undefined
	readonly returning: ReadonlyArray<Target>
} & InsertTarget

export interface Update {
	readonly kind: "update"
	readonly with: With | undefined
	readonly table: ObjectName
	readonly alias: string
	readonly set: Assignments
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
	readonly set: Assignments
}

/**
 * INSERT (<columns>) VALUES (<values>), each column with the value it takes, at least one;
 * or INSERT DEFAULT VALUES, PostgreSQL's spelling of an insert of no column, every column its default.
 */
export type MergeInsert =
	| {
			readonly kind: "insert"
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
 * How a column is generated, a generation PostgreSQL computes from its row, STORED: an expression of the row, or a
 * partial projection, `GENERATED ALWAYS AS (CASE WHEN <when> THEN <expr> END) STORED`, which holds `expr` where `when`
 * is true and NULL everywhere else. A partial projection is the one form that yields NULL, so it never reaches an
 * expression.
 */
export type StoredGeneration =
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
	readonly generated: StoredGeneration | undefined
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

/** A schema the role that creates it owns: the migration identity, whoever connects. */
export interface CreateSchema {
	readonly kind: "createSchema"
	readonly name: string
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
 * A write program's carrier, a session table of pg_temp, the session's own temporary schema, by which it prints
 * qualified: CREATE TEMPORARY TABLE pg_temp.<name> (...) ON COMMIT PRESERVE ROWS, made once in a session by the
 * session's stand-up of the write (runtime/write/flight.ts StandUp), never by a write's own transaction, so no
 * transaction of a write makes or drops a relation, and no plan it makes meets a catalog change of its own session at
 * the next call. Its one constraint is its primary key, if it has one. Its emptying (`EmptyCarrier`) is a session
 * function made beside it (sql/print.ts carrierEmptying).
 */
export interface CreateCarrier {
	readonly kind: "createCarrier"
	readonly name: CarrierName
	/** Of any width: PostgreSQL holds a table of no column, the carrier of the unit relation. */
	readonly columns: ReadonlyArray<ColumnDef>
	/**
	 * Its key's columns, in key order, or none. Printed `PRIMARY KEY (...) DEFERRABLE INITIALLY IMMEDIATE`, which
	 * PostgreSQL checks at the end of each statement rather than at each row: one statement's sibling data-modifying
	 * CTEs may delete a carrier's fact and insert another at its key, in an order PostgreSQL leaves unspecified, and the
	 * carrier must be a set by its key wherever a later statement reads it.
	 */
	readonly primaryKey: NonEmptyReadonlyArray<string> | undefined
}

/**
 * SELECT pg_temp.<name>(): a write program's carrier emptied before a use fills it, by the session function of the
 * carrier's own name the session's stand-up made beside it (sql/print.ts carrierEmptying), whose body empties it as
 * every session table is emptied (sql/print.ts sessionTableEmptied). A PL/pgSQL function plans its statements once a
 * session, where a DO block of the same body planned them at every call. It reads and writes the carrier alone.
 */
export interface EmptyCarrier {
	readonly kind: "emptyCarrier"
	readonly name: CarrierName
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
	| {
			/**
			 * ADD COLUMN ... with no NOT NULL and no default: a column a migration fills before it sets its NOT NULL
			 * (setNotNull), a field set aside while the reviewer's value converts it (deploy/diff/plan.ts SetAside), or a
			 * generated column over one.
			 */
			readonly kind: "addColumnUnchecked"
			readonly column: ColumnDef
	  }
	| { readonly kind: "setNotNull"; readonly column: string }
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
	| {
			/**
			 * ALTER CONSTRAINT ... [NOT] DEFERRABLE [INITIALLY ...]: a foreign key's deferral changed in place, a
			 * catalog update under ACCESS EXCLUSIVE that reads no row, the constraint and its every reference kept.
			 */
			readonly kind: "alterConstraintDeferral"
			readonly name: string
			readonly deferrable: ForeignKey["deferrable"]
	  }
	| { readonly kind: "dropConstraint"; readonly name: string }
	| { readonly kind: "enableRowSecurity" }
	| { readonly kind: "disableRowSecurity" }
	| {
			/**
			 * REPLICA IDENTITY FULL or DEFAULT: what an update's or a delete's WAL record keeps of the row it changed, every
			 * column or the primary key's, which the installation's live source decodes its old routing values from
			 * (physical/ddl/live.ts).
			 */
			readonly kind: "replicaIdentity"
			readonly identity: "full" | "default"
	  }
	| {
			/**
			 * ALTER COLUMN <column> SET EXPRESSION AS (...): a generated column's generation replaced by another STORED
			 * one, which rewrites the table once for every column the statement re-expresses, and rebuilds the indexes and
			 * constraints over the columns it re-expresses in that rewrite, checking each CHECK, key and foreign key over
			 * the rewritten rows.
			 */
			readonly kind: "setExpression"
			readonly column: string
			readonly generation: StoredGeneration
	  }

/** The column an ALTER TABLE subcommand adds, under whatever value it adds it, each taking its table's next attribute
 * number; none for any other subcommand. */
export const addedColumn = (a: AlterTableAction): ColumnDef | undefined => {
	switch (a.kind) {
		case "addColumn":
		case "addColumnPlaceholder":
		case "addColumnDefault":
		case "addColumnUnchecked":
			return a.column
		case "setNotNull":
		case "dropColumn":
		case "dropDefault":
		case "alterColumnType":
		case "addConstraint":
		case "addConstraintUsingIndex":
		case "validateConstraint":
		case "alterConstraintDeferral":
		case "dropConstraint":
		case "enableRowSecurity":
		case "disableRowSecurity":
		case "replicaIdentity":
		case "setExpression":
			return undefined
	}
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

type RenamableObject = "TABLE" | "INDEX" | "MATERIALIZED VIEW" | "DOMAIN"

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
	| {
			/** ALTER FUNCTION <name>(<args>) RENAME TO <to>: a function by its signature, which keeps its OID, so what
			 * depends on it (a CHECK that calls it) stands. */
			readonly kind: "rename"
			readonly object: "FUNCTION"
			readonly name: ObjectName
			readonly args: ReadonlyArray<TypeRef>
			readonly to: string
	  }

/**
 * CREATE OR REPLACE FUNCTION of a constant under the name and signature it holds: its text written again, what it
 * computes the same, as a declared rename that keeps a row function leaves it naming a renamed type
 * (deploy/diff/declared.ts pairedConstants). PostgreSQL swaps the body under the OID every CHECK that calls it depends
 * on, checking no row, so it is drafted for no other change: a constant that computes otherwise is another function.
 */
export interface ReplaceConstant {
	readonly kind: "replaceConstant"
	readonly constant: PlainConstant
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
	/** Over a present VALUE; prints as CHECK (VALUE IS NULL OR (<predicate>) IS TRUE), so the domain admits NULL. */
	readonly predicate: Expr
}

/** A domain carries no NOT NULL and admits NULL; the column refuses it. */
export interface CreateDomain {
	readonly kind: "createDomain"
	readonly name: ObjectName
	readonly base: TypeRef
	/** Required when the base is builtin text or text[]. */
	readonly collation: Collation | undefined
	readonly constraints: ReadonlyArray<DomainConstraint>
}

/**
 * CREATE TYPE <schema>.<name> AS (<attribute> <type> [COLLATE pg_catalog.pg_c_utf8], ...): the row type of a heading a
 * declared function's argument or result takes (physical/ddl/functions.ts), named by its definition's digest, so a
 * changed heading is another type. Each attribute is its field's base type, never a domain: PostgreSQL holds a
 * function's result rows to its row type's attribute types exactly (pl_exec.c exec_stmt_return_query), so a body's
 * query of the base types fits it, and a value's refinement is checked where a statement reads it.
 */
export interface CreateRowType {
	readonly kind: "createRowType"
	readonly name: ObjectName
	readonly attributes: NonEmptyReadonlyArray<ColumnDefinition>
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
	readonly method: IndexMethod
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

/** Always WITH NO DATA; the migration that creates it populates it (deploy/diff/diff.ts view), and db.refresh after. */
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
			/**
			 * A function among them by its name alone, which PostgreSQL drops where it is the only function of its name in
			 * its schema, as grizzle installs every function (physical/obligations/graph.ts names a function by its name):
			 * the drop of an installed function whose signature no record states, one `grizzle upgrade` finds departed
			 * (deploy/diff/departed.ts). A function whose record states it is dropped by its signature (DropFunction).
			 */
			readonly kind: "drop"
			readonly object:
				| "TABLE"
				| "MATERIALIZED VIEW"
				| "VIEW"
				| "DOMAIN"
				| "STATISTICS"
				| "TYPE"
				| "FUNCTION"
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
 * CREATE TRIGGER <name> BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION <function>(): an immutable relation's
 * immutability guard (physical/ddl/immutable.ts), which PostgreSQL fires for every row an UPDATE of the table finds,
 * whoever runs it, the table's owner and a foreign key's ON UPDATE CASCADE among them.
 */
export interface CreateUpdateGuardTrigger {
	readonly kind: "createUpdateGuardTrigger"
	readonly name: string
	readonly table: ObjectName
	readonly function: ObjectName
}

/**
 * CREATE CONSTRAINT TRIGGER <name> AFTER <events> ON <table> DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE
 * FUNCTION <function>(): a rule over a query's trigger on one table it reads (physical/ddl/rules.ts), which PostgreSQL
 * fires at COMMIT for every row an event of it touched.
 */
export interface CreateConstraintTrigger {
	readonly kind: "createConstraintTrigger"
	readonly name: string
	readonly table: ObjectName
	readonly events: NonEmptyReadonlyArray<TriggerEvent>
	readonly function: ObjectName
}

/**
 * CREATE TRIGGER <name> AFTER <event> ON <table> REFERENCING <transition tables> FOR EACH STATEMENT EXECUTE FUNCTION
 * <function>(): a rule capture (physical/ddl/rules.ts judged), which PostgreSQL fires once at the end of each statement
 * that writes the table, its rows foreign-key actions write among them, the rows it wrote its transition tables. An
 * INSERT's names its new rows `transitionTables.news`, a DELETE's its old rows `transitionTables.olds`, an UPDATE's both.
 * PostgreSQL holds transition tables only on a trigger of one event and no column list that is no constraint trigger
 * (trigger.c CreateTriggerFiringOn), so each event is a trigger of its own.
 */
export interface CreateTransitionTrigger {
	readonly kind: "createTransitionTrigger"
	readonly name: string
	readonly table: ObjectName
	readonly event: TransitionEvent
	readonly function: ObjectName
}

/** The statement event a transition trigger fires on. */
export type TransitionEvent = "insert" | "update" | "delete"

/** The names a transition trigger gives its rows: the rows a statement wrote, as they stand after it and before it. */
export const transitionTables = { news: "news", olds: "olds" } as const

/** A transition table's name (`transitionTables`). */
export type TransitionTable = (typeof transitionTables)[keyof typeof transitionTables]

/** A row event a constraint trigger fires on: an INSERT, a DELETE, or an UPDATE of one of `columns`. */
export type TriggerEvent =
	| { readonly kind: "insert" | "delete" }
	| { readonly kind: "update"; readonly columns: NonEmptyReadonlyArray<string> }

/**
 * A table a publication publishes (physical/ddl/live.ts): `whole`, every column, as a table of REPLICA IDENTITY FULL
 * must be, which no column list may narrow; or `listed`, the columns named, which hold its replica identity.
 */
export interface PublishedTable {
	readonly table: ObjectName
	readonly columns:
		| { readonly kind: "whole" }
		| { readonly kind: "listed"; readonly columns: NonEmptyReadonlyArray<string> }
}

/**
 * CREATE PUBLICATION <name> [FOR TABLE <table> [(<columns>)], ...] WITH (publish_generated_columns = stored): the
 * installation's live source's publication, of every footprint table, every kind of change (publish's default, insert,
 * update, delete and truncate, stated by its omission, since a definition element takes a bare string constant and no
 * typed literal), and a stored generated column of a table published whole, as REPLICA IDENTITY FULL asks; none, a
 * publication of no table, where the live plan reads only materialized views.
 */
export interface CreatePublication {
	readonly kind: "createPublication"
	readonly name: string
	readonly tables: ReadonlyArray<PublishedTable>
}

export interface DropPublication {
	readonly kind: "dropPublication"
	readonly name: string
}

/**
 * CREATE TABLE <table> ("secret") AS SELECT sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())): the
 * installation's live secret, drawn from PostgreSQL's strong random source as the table is created, in the one
 * statement that creates it, so a migration draws it exactly once: two version 4 UUIDs, 244 random bits, hashed into
 * the 32 bytes of an AES-256 key.
 */
export interface CreateLiveSecret {
	readonly kind: "createLiveSecret"
	readonly table: ObjectName
}

/**
 * The reset of the current database's default of a configuration parameter, whatever the database is named, printed as
 * a DO block (sql/catalog.ts DoBlock, built by sql/catalog.ts databaseResetBlock) after the database lock (sql/print.ts
 * databaseWide), since every installation in the database writes the same pg_db_role_setting row:
 *
 *   SELECT "pg_catalog"."pg_advisory_xact_lock"(<key>::bigint);
 *   DO $$
 *   BEGIN
 *     EXECUTE "pg_catalog"."format"('ALTER DATABASE %I RESET <parameter>'::"pg_catalog"."text",
 *       "pg_catalog"."current_database"());
 *   END
 *   $$
 *
 * ALTER DATABASE names its database and an installation's statements name none, so the block reads its name; PostgreSQL
 * reads `ALTER DATABASE CURRENT_DATABASE` as a database of that name. grizzle sets no database default: an installation
 * of format 7 or before set default_transaction_isolation to serializable, which `grizzle upgrade` resets where a live
 * database still holds it (deploy/diff/departed.ts Departure `databaseDefault`), so every session grizzle does not open
 * starts at the server's default (physical/ddl/isolation.ts).
 */
export interface ResetDatabaseDefault {
	readonly kind: "resetDatabaseDefault"
	readonly parameter: "default_transaction_isolation"
}

/**
 * The role-level settings of one text value Publish stores for a login, each one a grizzle guarantee rests on:
 * extra_float_digits, under which float text is shortest round-trip; DateStyle, under which date_out writes ISO 8601's
 * YYYY-MM-DD, a date's host text; bytea_output, under which byteaout writes `\x` and two hex digits a byte, a bytes
 * value's text; lc_monetary, lc_numeric and lc_time, the locale categories a value's text can depend
 * on, money's two fractional digits among them; pgvector's strict-order
 * iterative scan, on which an approximate read's order and its cursors rest, and its scan bound, at which the scan and
 * an approximate read's ordered stream both stop (check/approximate/policy.ts); and
 * plan_cache_mode, at force_generic_plan, under which a session plans each statement it prepares once, generically, and
 * keeps that plan, where PostgreSQL's auto mode plans its first five calls with their values and may go on doing so for
 * good (physical/ddl/roles.ts genericPlans). An `hnsw.*` name is a placeholder until the vector library is loaded in the
 * session that stores it. Every other setting is the database owner's.
 */
const textParameters = [
	"plan_cache_mode",
	"extra_float_digits",
	"DateStyle",
	"bytea_output",
	"lc_monetary",
	"lc_numeric",
	"lc_time",
	"hnsw.iterative_scan",
	"hnsw.max_scan_tuples"
] as const
export type TextParameter = (typeof textParameters)[number]

/** Every role-level setting Publish stores for a login: its search_path, and the settings of one text value. */
const configurationParameters = ["search_path", ...textParameters] as const
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

const privileges = [
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
	"TEMPORARY",
	"ALL"
] as const
export type Privilege = (typeof privileges)[number]

/**
 * What a GRANT or REVOKE names, at least one object: PostgreSQL has no grant on no object. `DATABASE` is the current
 * database, whatever it is named: an installation's statements name no database, so its GRANT and REVOKE name the
 * database's variable, which migrate fills with its connection's (sql/print.ts printDatabase). A grant on the database
 * or on a schema writes a row another installation in the database may write too, the database's own or the vector
 * extension's schema's, so it prints after the database lock (sql/print.ts grantEmitter).
 */
export type GrantObjects =
	| { readonly kind: "TABLE"; readonly names: NonEmptyReadonlyArray<ObjectName> }
	| { readonly kind: "SCHEMA"; readonly names: NonEmptyReadonlyArray<string> }
	| { readonly kind: "DOMAIN"; readonly names: NonEmptyReadonlyArray<ObjectName> }
	| { readonly kind: "TYPE"; readonly names: NonEmptyReadonlyArray<ObjectName> }
	| { readonly kind: "FUNCTION"; readonly names: NonEmptyReadonlyArray<FunctionName> }
	| { readonly kind: "DATABASE" }

/** The objects of a GRANT or REVOKE that names them, every kind but the current database. */
export type NamedGrantObjects = Exclude<GrantObjects, { readonly kind: "DATABASE" }>

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
const columnPrivileges = ["SELECT", "INSERT", "UPDATE"] as const
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
 * ALTER DEFAULT PRIVILEGES [IN SCHEMA <s>] REVOKE ALL ON <kind> FROM PUBLIC: the current role's, the migration
 * identity's, the owner of everything the installation creates, so no statement names the owner.
 * PostgreSQL adds per-schema default ACLs to the global ones and cannot revoke a global default per schema, so the
 * built-in PUBLIC EXECUTE on functions and PUBLIC USAGE on types are reset only by the global form, without
 * IN SCHEMA (future objects receive nothing implicitly): a global entry replaces the hard-wired default and a schema's
 * is added on (PostgreSQL 19 src/backend/catalog/aclchk.c 1152-1161, and get_user_default_acl's aclmerge of the two
 * at 4304-4318). The global form writes the owner's one pg_default_acl row of the kind, which every installation of
 * the same owner in the database writes, so every ALTER DEFAULT PRIVILEGES prints after the database lock (sql/print.ts
 * databaseWide).
 */
export interface AlterDefaultPrivileges {
	readonly kind: "alterDefaultPrivileges"
	/** Undefined: the global form, for every schema in the database. */
	readonly inSchema: string | undefined
	readonly privileges: NonEmptyReadonlyArray<Privilege>
	readonly on: "TABLES" | "SEQUENCES" | "FUNCTIONS" | "TYPES"
	readonly from: NonEmptyReadonlyArray<Grantee>
}

/** Always IF NOT EXISTS: Setup creates an extension only when absent. An extension is the database's, one of a name
 * (pg_extension_name_index), which every installation that needs it creates, so it prints after the database lock
 * (sql/print.ts databaseWide). */
export interface CreateExtension {
	readonly kind: "createExtension"
	readonly name: string
	/** The schema the extension's objects live in: the installation names one for every extension it creates. */
	readonly schema: string
}

/**
 * A column's declared number of distinct values (physical/statistics/declared.ts): -1/2^exponent, each value 2^exponent
 * of the table's rows at any size of it (`relative`), or 2^exponent values (`absolute`), each exact in a float4.
 */
export type DeclaredDistinct =
	| { readonly kind: "relative"; readonly exponent: number }
	| { readonly kind: "absolute"; readonly exponent: number }

/**
 * A table's declared statistics, two commands (print.ts commandsOf): ALTER TABLE ... SET (autovacuum_analyze_threshold,
 * autovacuum_analyze_scale_factor) at their maxima, so autovacuum analyzes the table never in practice, and ALTER COLUMN
 * ... SET STATISTICS 0 of every column, so an ANALYZE, a consumer's included, samples nothing of them and keeps what is
 * declared (analyze.c attribute_is_analyzable); each declared dependency's CREATE STATISTICS IF NOT EXISTS ...
 * (dependencies) and ALTER STATISTICS ... SET STATISTICS 0; then one DO block (print.ts declaredStatisticsBlock) that, for each column, clears its
 * statistics and restores its declared number of distinct values (pg_clear_attribute_stats,
 * pg_restore_attribute_stats), and each dependency's (pg_clear_extended_stats, pg_restore_extended_stats, its
 * attributes the columns' numbers read from pg_attribute), a restore answering false raising, so every one is restored
 * or the statement fails. Its
 * null fraction and average width are the restore's own defaults, 0 and unknown, so the planner reads a column of no
 * declared width by its type.
 */
export interface DeclareStatistics {
	readonly kind: "declareStatistics"
	readonly table: ObjectName
	readonly columns: NonEmptyReadonlyArray<{
		readonly column: string
		readonly distinct: DeclaredDistinct
	}>
	/**
	 * Each declared dependency of one anchor on another (physical/statistics/declared.ts DeclaredDependency): a
	 * statistics object of the dependencies kind in the table's schema, its statistics target 0, so no ANALYZE samples
	 * it, its degree 1/2^exponent restored.
	 */
	readonly dependencies: ReadonlyArray<{
		readonly name: ObjectName
		readonly determinant: string
		readonly dependent: string
		readonly exponent: number
	}>
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

/**
 * How a session table stores its values (PlStatement createSessionTable): `inline`, every value in its row, each column
 * STORAGE PLAIN, for which PostgreSQL makes no TOAST table (REL_19_0 src/backend/access/heap/heapam_handler.c 2002-2039
 * heapam_relation_needs_toast_table: none where no column's storage is other than PLAIN), so a table whose widest row
 * its columns' bounds prove fits one heap tuple is one relation, where with its TOAST table and that table's index it
 * was three, each a file its emptying's TRUNCATE gives a new one and each a relation its session's exit drops; or
 * `toasted`, PostgreSQL's default, a value too long for its row moved out of line into the table's TOAST table.
 */
export type SessionTableStorage = "inline" | "toasted"

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
			/**
			 * PERFORM 1 FROM (<query>) AS "found"; IF FOUND THEN <body> END IF: the query read whole and what a row of it
			 * obliges, one statement, so FOUND is read only right after the probe that set it (sql/build.ts whenFound). The
			 * PERFORM around the query is the printer's spelling, so any query stands in it, its WITH and its set operations
			 * included, and every walk of the statement meets the query itself. PostgreSQL plans a PERFORM for every
			 * row of its query (PostgreSQL 19, src/pl/plpgsql/src/pl_exec.c exec_run_select at 5929-5935, no
			 * CURSOR_OPT_FAST_PLAN; src/backend/optimizer/plan/planner.c at 485-488, tuple_fraction 0) and an EXISTS
			 * sublink for its first (src/backend/optimizer/plan/subselect.c make_subplan at 215-216, "just like a LIMIT
			 * 1"), the plan of a query that returns rows. A probe whose row refuses, a law's violation, returns none
			 * wherever the law holds, so a first-row plan of it runs to its end.
			 */
			readonly kind: "whenFound"
			readonly query: OperandSelect
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
	| {
			/** A data-modifying statement run for its effect alone: a rule capture's rows into its delta and its arming of
			 * the judge, and the judge's disarming. */
			readonly kind: "modify"
			readonly statement: Insert | Update | Delete
	  }
	| {
			/**
			 * RETURN QUERY <query>: the query's rows appended to a set-returning function's result, in its order, each
			 * as often as the query delivers it: a stamp function returns its children's heads (physical/ddl/stamps.ts);
			 * a rule judge's delta reader returns
			 * the delta's rows as they stand, which every statement that reads them takes as a Delta node's DISTINCT of
			 * the fields it delivers (physical/ddl/deltas.ts addReaders).
			 */
			readonly kind: "returnQuery"
			readonly query: OperandSelect
	  }
	| {
			/**
			 * CREATE TEMPORARY TABLE pg_temp.<name> (<columns>[, PRIMARY KEY (<key>) DEFERRABLE INITIALLY IMMEDIATE]) ON
			 * COMMIT PRESERVE ROWS: a table of the session's own temporary schema, made once in a session and kept by every
			 * COMMIT, owned by the role that runs the statement, so no COMMIT truncates or drops it (tablecmds.c
			 * PreCommit_on_commit_actions truncates every ON COMMIT DELETE ROWS table of a session at each COMMIT of a
			 * transaction that touched any temporary relation, each truncation an ACCESS EXCLUSIVE lock and an invalidation
			 * every backend reads; a table dropped at COMMIT is made again by the next transaction, whose catalog rows
			 * overflow the shared invalidation queue and reset every cache of the session, its cached plans among them): a
			 * rule judge's delta or sentinel (physical/ddl/rules.ts addStandUps), its columns nullable, its owner the
			 * stand-up's definer, or a write program's carrier (sql/ast.ts CreateCarrier), every column NOT NULL and its key
			 * its own. A table of no column is the sentinel's, or the unit relation's carrier.
			 */
			readonly kind: "createSessionTable"
			readonly name: string
			readonly columns: ReadonlyArray<ColumnDefinition>
			/** Whether every column is NOT NULL: a carrier's, whose every value is a fact's field. */
			readonly notNull: boolean
			/** The table's key, in key order, or none: a carrier's (CreateCarrier primaryKey). */
			readonly primaryKey: NonEmptyReadonlyArray<string> | undefined
			/** How it stores its values (SessionTableStorage). */
			readonly storage: SessionTableStorage
	  }
	| {
			/**
			 * TRUNCATE pg_temp.<name>: a session table, a rule judge's delta or a write's carrier, that has outgrown its
			 * one reused page given a new file, the old one given back (sql/print.ts sessionTableEmptied, which empties
			 * one that has not by DELETE, keeping its file).
			 */
			readonly kind: "truncateSessionTable"
			readonly name: string
	  }
	| {
			/**
			 * CREATE CONSTRAINT TRIGGER <name> AFTER INSERT ON pg_temp.<table> DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
			 * EXECUTE FUNCTION <function>(): the sentinel's trigger, which runs the rule judge at COMMIT, or at SET
			 * CONSTRAINTS ALL IMMEDIATE, once per row the sentinel takes (physical/ddl/rules.ts judged).
			 */
			readonly kind: "createSessionTrigger"
			readonly name: string
			readonly table: string
			readonly function: ObjectName
	  }

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
 * - PL/pgSQL: CREATE OR REPLACE FUNCTION <schema>.<name>(<params>) RETURNS trigger | boolean | void | SETOF <type>
 *   LANGUAGE plpgsql VOLATILE [PARALLEL SAFE] SECURITY DEFINER SET search_path = pg_catalog, pg_temp: the law
 *   functions, the isolation
 *   guard, and the refusal function `<schema>.__refuse(text, text, text) RETURNS boolean`, whose body raises its
 *   arguments. A trigger function
 *   takes no argument;
 * - SQL: CREATE OR REPLACE FUNCTION <schema>.<name>(<params>) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 *   SET search_path = pg_catalog, pg_temp RETURN <expr>: a writable entry's world functions, its filter that reads
 *   another relation, which its policy and its writes' prechecks call, and its key and unique probes
 *   (physical/ddl/roles.ts). Its body names its arguments by position (`$n`), never by name, so no argument can be read
 *   as a column of a relation the body reads. PostgreSQL parses this body under the creating session's path, not the
 *   function's, so only its absolute names make it mean one thing.
 *
 * `parallel` is the function's parallel safety: SAFE prints PARALLEL SAFE; UNSAFE, PostgreSQL's own default, prints no
 * clause. Only the refusal function is SAFE, so a statement that reads the claims still plans in parallel. It declares a
 * property of the function, as its volatility does, never a planner directive.
 */
export type CreateFunction =
	| ({
			readonly kind: "createFunction"
			readonly language: "plpgsql"
			readonly name: ObjectName
			readonly volatility: "VOLATILE"
			readonly parallel: "SAFE" | "UNSAFE"
			readonly security: "DEFINER"
			readonly body: PlBlock
	  } & (
			| { readonly returns: "trigger"; readonly params: readonly [] }
			| { readonly returns: "boolean"; readonly params: ReadonlyArray<FunctionParam> }
			| { readonly returns: "void"; readonly params: ReadonlyArray<FunctionParam> }
			| { readonly returns: SetOf; readonly params: ReadonlyArray<FunctionParam> }
	  ))
	| {
			readonly kind: "createFunction"
			readonly language: "sql"
			readonly name: ObjectName
			readonly volatility: "STABLE"
			readonly parallel: "SAFE" | "UNSAFE"
			readonly security: "DEFINER"
			readonly returns: "boolean"
			readonly params: ReadonlyArray<FunctionParam>
			readonly body: Expr
	  }

/**
 * RETURNS SETOF <type>: a set-returning function's rows, each one value of `type`, which its RETURN QUERY appends, and
 * the rows a call is estimated to return (`rows`): PostgreSQL's own estimate for a set-returning function where the
 * function states none (`planner`, no clause), or the ROWS its CREATE FUNCTION declares (`declared`), a property of the
 * function the planner reads, as its volatility is, never a planner setting.
 */
export interface SetOf {
	readonly setOf: TypeRef
	readonly rows: { readonly kind: "planner" } | { readonly kind: "declared"; readonly rows: number }
}

/** A PL/pgSQL function, and an SQL one. */
export type PlFunction = Extract<CreateFunction, { readonly language: "plpgsql" }>
export type SqlFunction = Extract<CreateFunction, { readonly language: "sql" }>

/**
 * The body a PL/pgSQL function is read with where its own never runs: one RAISE, which PL/pgSQL accepts in a function of
 * any result and which names no object. The drift check replays a recorded function with it (deploy/snapshot/recorded.ts
 * replayedStatement), its text no part of any description, and a function's names are read with it in place of its own
 * (physical/obligations/graph.ts namedEdges), since PostgreSQL resolves no name of a PL/pgSQL body until it runs.
 */
export const stubBody: PlBlock = {
	declare: [],
	body: [
		{
			kind: "raise",
			message: "the drift check's stub of a recorded body, which never runs",
			using: []
		}
	]
}

/**
 * A closed relation's constant as the migration states it, `cells` cells of `width` bits: CREATE FUNCTION … RETURN
 * X'<hex>'::bit varying, its body the string of cells itself as one hex literal, under a comment of its row count and
 * its content's digest (ir/cells.ts constantDigestOf), which `grizzle check` decodes the literal and holds it to.
 */
export interface PackConstant {
	readonly kind: "packConstant"
	readonly function: ObjectName
	/** The count of cells: the points of the key's space, a product's or a dependent sum's (ir/cells.ts keyCells). */
	readonly cells: bigint
	/** w, a cell's bits: 1 for a set. */
	readonly width: number
	/** The cells' bits as whole hex digits, the bits past the last cell 0 (ir/cells.ts literalOf). */
	readonly hex: string
	/** The cells it holds, one per row of its relation or side. */
	readonly rows: number
	readonly digest: string
}

/**
 * CREATE FUNCTION <name>(<params>) RETURNS <type> <language's clauses> <body>: a constant, an IMMUTABLE PARALLEL SAFE
 * function named by its content's digest, its body `RETURN <body>` in its language (ConstantLanguage). Never OR
 * REPLACE: a domain's planned check keeps the constant it folded, so a function changed under it would go unseen, and
 * a new constant is a new name. A parameter is read by position, $n, as every grizzle SQL body reads. A function of
 * grizzle's library is a constant of parameters that states how a NULL argument meets it (LibraryConstant); every
 * other constant states none: one of no parameter, which no argument reaches, and a row function, whose body meets a
 * NULL column by its own three-valued logic, as the CHECK or generation it stands for does.
 */
export type CreateConstant = PlainConstant | LibraryConstant

/** A constant that states no NULL behaviour: a closed relation's, a roster's or a dictionary's, or a row function. */
export interface PlainConstant {
	readonly kind: "createConstant"
	readonly language: ConstantLanguage
	readonly name: ObjectName
	readonly params: ReadonlyArray<FunctionParam>
	readonly returns: TypeRef
	readonly body: Expr
}

/**
 * A function of grizzle's library (physical/ddl/library.ts): an SQL constant of parameters, STRICT where `strict`
 * holds, NULL wherever an argument is NULL, which PostgreSQL returns without running the body and folds where it plans
 * a call of a NULL argument; it is exactly where the host term over it is strict (library.ts strictOf).
 */
export interface LibraryConstant extends PlainConstant {
	readonly language: "sql"
	readonly strict: boolean
}

/**
 * CREATE FUNCTION <name>(<params>) RETURNS <type> <language's clauses> RETURN NULL::<type>: a constant as the drift
 * check replays it from its record (deploy/snapshot/recorded.ts RecordedConstant), which holds its header alone, its
 * body in the committed migration that created it. The function is the constant's but for its value, NULL of its
 * result type, the one value every type holds whatever it refines: the replay may run it, since PostgreSQL evaluates an
 * IMMUTABLE call of no argument where it plans a stored generation, an index's expression or predicate, or a default
 * it stores (a generated set field whose term reads no column is the call of a row function of no parameter), and
 * every check it meets there admits NULL. A domain grizzle creates carries no NOT NULL and holds each of its CHECKs as
 * `VALUE IS NULL OR (<predicate>) IS TRUE` (CreateDomain, DomainConstraint), so NULL passes it before its predicate
 * reads any other constant; a strict operator or function over NULL returns NULL without raising; and the replay
 * writes no row, so no table's CHECK or NOT NULL is evaluated. Where the constant's value read back, as an empty bit
 * string, a domain's CHECK over a constant of another width raised (22026). The language's clauses are the constant's
 * own, as the drift check describes it by them.
 */
export interface StubConstant {
	readonly kind: "stubConstant"
	readonly language: ConstantLanguage
	readonly name: ObjectName
	readonly params: ReadonlyArray<FunctionParam>
	readonly returns: TypeRef
}

/**
 * A constant's body language, by when PostgreSQL plans what the body reads:
 *
 * - `sql`, `LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN <body>`, planned into each statement that calls it, which
 *   inlines the body or evaluates the call once per statement: a closed relation's, a roster's or a dictionary's
 *   constant, and a library function. No SET clause: a function with one is never inlined, and its body names every
 *   type and function by its schema.
 * - `plpgsql`, `LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$BEGIN RETURN
 *   <body>; END$$`, planned once per backend, at its first call, every constant its body calls folded into that plan and
 *   every literal read with it: a row function (physical/ddl/row-functions.ts). PL/pgSQL resolves the body's operators
 *   as it plans it, under the path its SET clause fixes, so no caller's path changes what it means.
 */
export type ConstantLanguage = "sql" | "plpgsql"

/** A declared function's volatility as CREATE FUNCTION spells it. */
export type DeclaredVolatility = "IMMUTABLE" | "STABLE" | "VOLATILE"

/**
 * A declared function's null input as CREATE FUNCTION spells it: STRICT, whose call at any NULL argument is NULL
 * without running its body; none for CALLED ON NULL INPUT, PostgreSQL's default, which the statement leaves unspelled,
 * so a function called on NULL input states what it stated before a function could be strict.
 */
export type DeclaredNullInput = "STRICT" | undefined

/**
 * A declared function's body: the application's own PL/pgSQL or SQL text, carried byte for byte, which the statement
 * dollar-quotes under a tag the text does not hold, so PostgreSQL stores exactly it as the function's pg_proc.prosrc.
 * Minted only by `declaredBody`, at the one place a body leaves its declaration (physical/ddl/functions.ts).
 */
export type DeclaredBody = string & { readonly [declaredBodyBrand]: true }
declare const declaredBodyBrand: unique symbol

/** A declared function's body, its declaration's text as it stands. */
export const declaredBody = nominal<string, DeclaredBody>()

/**
 * CREATE OR REPLACE FUNCTION <schema>.<name>(<params>) RETURNS <type> | SETOF <row type> LANGUAGE <language>
 * <volatility> [STRICT] SECURITY DEFINER SET search_path = pg_catalog, <path>, pg_temp AS <tag><body><tag>: a function the
 * application declares (physical/ddl/functions.ts). Its owner is the installation's function owner, a role of no
 * privilege on any table, so a body that reads a table fails as it runs; its path names pg_catalog first, so no name
 * of the level's shadows a builtin, then its own schema, the one its name names, so the body names the declared
 * functions and row types of its level unqualified, and pg_temp last, so no session's temporary object shadows one.
 * Its parameters and result are base types and row types alone.
 */
export interface CreateDeclaredFunction {
	readonly kind: "createDeclaredFunction"
	readonly name: ObjectName
	readonly params: ReadonlyArray<FunctionParam>
	readonly returns: TypeRef | SetOf
	readonly language: DeclaredLanguage
	readonly volatility: DeclaredVolatility
	readonly nullInput: DeclaredNullInput
	readonly body: DeclaredBody
}

/**
 * A declared function handed over to the installation's function owner, three commands: GRANT CREATE ON SCHEMA <its
 * schema> TO <owner>, ALTER FUNCTION <name>(<args>) OWNER TO <owner>, REVOKE CREATE ON SCHEMA <its schema> FROM
 * <owner>. PostgreSQL hands a function to a role only from one that may SET ROLE to it, and only while the role holds
 * CREATE on the function's schema (alter.c AlterObjectOwner_internal), which the owner holds for the hand-over alone.
 */
export interface HandOverFunction {
	readonly kind: "handOverFunction"
	readonly name: FunctionName
	readonly owner: string
}

/**
 * GRANT <role> TO CURRENT_USER WITH INHERIT TRUE, SET TRUE: the migration identity's membership in the installation's
 * function owner, which hands each declared function to it (HandOverFunction) and replaces or drops each later as a
 * member of its owner (pg_proc_ownercheck reads has_privs_of_role). The identity holds no privilege of the owner's it
 * lacks: the owner holds none on any table.
 */
export interface AdoptRole {
	readonly kind: "adoptRole"
	readonly role: string
}

/**
 * The end of every session that holds a temporary object of one of `roles`, by stem, which a migration sends right
 * before the role's DROP ROLE (sql/print.ts writeEndHolders, the one text of it, which uninstall's sends too: sql/catalog.ts
 * UninstallStatement). A write's carrier, or any object a transaction under the role makes in its session's temporary
 * schema, is the role's, and stands until its session ends; PostgreSQL refuses DROP ROLE (2BP01) while one stands. Such a
 * session belongs to the installation that is ending, so the drop ends it.
 */
export interface EndHolders {
	readonly kind: "endHolders"
	readonly roles: NonEmptyReadonlyArray<string>
}

/**
 * Transaction control: a read's BEGIN, SERIALIZABLE READ ONLY (core/isolation.ts); a write's BEGIN at its isolation
 * level; COMMIT, ROLLBACK, and SET CONSTRAINTS ALL IMMEDIATE, under which every
 * deferrable constraint's check runs at the end of each statement, so no trigger event waits for the commit.
 */
export type TransactionControl =
	| { readonly kind: "beginRead" }
	| { readonly kind: "beginWrite"; readonly isolation: Isolation }
	| { readonly kind: "commit" }
	| { readonly kind: "rollback" }
	| { readonly kind: "setConstraintsImmediate" }

/** REFRESH MATERIALIZED VIEW [CONCURRENTLY]. */
export interface Refresh {
	readonly kind: "refresh"
	readonly view: ObjectName
	readonly concurrently: boolean
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
				| "TYPE"
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
	| ReplaceConstant
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
	| CreateDeclaredFunction
	| HandOverFunction
	| CreateRowType
	| AdoptRole
	| EndHolders
	| PackConstant
	| CreateConstant
	| StubConstant
	| CreateGuardTrigger
	| CreateUpdateGuardTrigger
	| CreateConstraintTrigger
	| CreateTransitionTrigger
	| CreatePublication
	| DropPublication
	| CreateLiveSecret
	| ResetDatabaseDefault
	| CreateRole
	| AlterRole
	| GrantRole
	| RevokeRole
	| Grant
	| Revoke
	| GrantColumns
	| AlterDefaultPrivileges
	| CreateExtension
	| DeclareStatistics
	| LockTable
	| Comment

export type SqlStatement = Dml | Ddl | CreateCarrier | EmptyCarrier | TransactionControl | Refresh

/** SQL text printed from a statement's AST: emit (sql/emit.ts) spells it, and nothing else. */
export type EmittedText = string & { readonly [emittedTextBrand]: true }
declare const emittedTextBrand: unique symbol

/** The emitted product of one statement: its text and the generated-name map diagnostics show. */
export interface EmittedSql {
	readonly text: EmittedText
	readonly nameMap: NameMap
}
