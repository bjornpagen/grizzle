import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	type OpId,
	OpId as opId,
	type RangeOpCode,
	rangeOp,
	type Volatility
} from "#compiler/ir/expr.ts"
import { type Carrier, carriers, type SpanCarrier } from "#compiler/ir/scalar.ts"
import {
	floatCast,
	type HostCast,
	type IntCarrier,
	integerCast,
	moneyToNumeric,
	numericCast
} from "#compiler/scalar/compute/cast.ts"
import type { PlainCarrier } from "#compiler/scalar/compute/types.ts"

/**
 * The SQLSTATEs an operation can raise, and "null", the NULL a native function returns on some non-null input
 * (scale and min_scale over NaN and the infinities), which grizzle treats as an execution failure.
 */
const failureCodes = {
	"22003": "numeric value out of range: overflow, underflow, or an out-of-range cast",
	"0A000": "a numeric NaN or infinity cast to an integer type or money, which has no such value",
	"22012": "division by zero",
	"2201F":
		"invalid argument for the power function: a negative square root, zero to a negative power, or a complex result",
	"2201G": "invalid argument for width_bucket",
	"23514": "a domain check violation: the value is not a value of the contract",
	null: "a NULL result, which no admitted value is"
} as const
export type FailureCode = keyof typeof failureCodes

/**
 * The catalogue that owns an operator or function: PostgreSQL's own, in pg_catalog, or the pgvector extension's, which
 * SQL qualifies by the installation's extension schema.
 */
type Owner = "catalog" | "vector"

/** How the node is spelled in SQL. */
type SqlForm =
	| {
			readonly kind: "infix"
			readonly op: "+" | "-" | "*" | "/" | "%" | "=" | "<>" | "<" | "<=" | ">" | ">="
			readonly owner: Owner
	  }
	| { readonly kind: "prefix"; readonly op: "-" }
	| { readonly kind: "function"; readonly name: string; readonly owner: Owner }
	| { readonly kind: "cast"; readonly target: Carrier }
	| { readonly kind: "between" | "in" | "least" | "greatest" | "and" | "or" | "not" }

/**
 * The catalog object that implements the node, as PostgreSQL's catalog names it. Every type it names is a carrier's
 * regtype spelling (catalogTypeName), never a carrier's own name; a range-polymorphic function returns its range's
 * element, anyelement. An operator's implementing function, pg_operator.oprcode, is its OpId: the catalog identity, or a
 * range overload's code.
 */
type CatalogRef =
	| {
			readonly kind: "operator"
			readonly name: string
			/** A prefix operator's one operand type, or an infix operator's two (pg_operator.oprleft and oprright). */
			readonly operands:
				| { readonly kind: "prefix"; readonly right: CatalogTypeName }
				| {
						readonly kind: "infix"
						readonly left: CatalogTypeName
						readonly right: CatalogTypeName
				  }
			readonly result: CatalogTypeName
			readonly owner: Owner
	  }
	| {
			readonly kind: "function"
			readonly name: string
			readonly args: ReadonlyArray<CatalogTypeName>
			readonly result: CatalogTypeName | "anyelement"
			readonly owner: Owner
	  }
	| { readonly kind: "cast"; readonly source: CatalogTypeName; readonly target: CatalogTypeName }
	| { readonly kind: "construct"; readonly uses: ReadonlyArray<OpId> }

/**
 * The Compute operation a native node serves, the comparisons, the boolean constructs, and the
 * casts; cond has no entry, it is the IR's cond node.
 */
export type NativeFn =
	| "add"
	| "sub"
	| "mul"
	| "div"
	| "mod"
	| "neg"
	| "quot"
	| "rem"
	| "abs"
	| "sign"
	| "round"
	| "trunc"
	| "ceil"
	| "floor"
	| "gcd"
	| "lcm"
	| "power"
	| "sqrt"
	| "least"
	| "greatest"
	| "widthBucket"
	| "scale"
	| "minScale"
	| "trimScale"
	| "lower"
	| "upper"
	| "charLength"
	| "cosineDistance"
	| "eq"
	| "ne"
	| "lt"
	| "le"
	| "gt"
	| "ge"
	| "between"
	| "in"
	| "and"
	| "or"
	| "not"
	| "cast"

/** Operands of one carrier each, in order, at least one. */
interface PositionalOperands<L extends NonEmptyReadonlyArray<Carrier>> {
	readonly kind: "positional"
	readonly carriers: L
}

/** Any number of operands, at least one, each of the element carrier: IN, LEAST, GREATEST, AND and OR. */
interface VariadicOperands {
	readonly kind: "variadic"
	readonly element: Carrier
}

/** The operands a node takes. */
export type Operands = PositionalOperands<NonEmptyReadonlyArray<Carrier>> | VariadicOperands

/** What every overload of the table records: everything about it but its function, result and identity. */
interface OverloadBase {
	readonly operands: Operands
	readonly sql: SqlForm
	readonly catalog: CatalogRef
	readonly volatility: Volatility
	/** Empty when the node is total on non-null inputs. */
	readonly failures: ReadonlyArray<FailureCode>
}

/** A function, operator, cast or construct with a fixed result type, a plain carrier. */
interface FixedOverload extends OverloadBase {
	readonly fn: FixedFn
	readonly result: PlainCarrier
}

/** LEAST or GREATEST, which PostgreSQL types by its operands' common type: a value of its element carrier. */
interface ExtremeOverload extends OverloadBase {
	readonly fn: ExtremeFn
	readonly operands: VariadicOperands
	readonly result: Carrier
}

/** One overload of the table: everything about it but its identity, the key the table lists it under. */
type Overload = FixedOverload | ExtremeOverload

/** The Compute operations whose result is the common type of their operands. */
type ExtremeFn = "least" | "greatest"

/** The Compute operations with a fixed result type. */
export type FixedFn = Exclude<NativeFn, ExtremeFn>

/** A native node of a fixed result type. */
export interface FixedOp extends FixedOverload {
	readonly id: OpId
}

/** A native LEAST or GREATEST. */
export interface ExtremeOp extends ExtremeOverload {
	readonly id: OpId
}

/** A native node: an overload of the table with its identity. */
export type NativeOp = FixedOp | ExtremeOp

/**
 * PostgreSQL's regtype spelling of a carrier in pg_operator and pg_proc. Enum, range and vector operators are
 * polymorphic or extension-owned.
 */
export const catalogTypeName = {
	int2: "smallint",
	int4: "integer",
	int8: "bigint",
	numeric: "numeric",
	float4: "real",
	float8: "double precision",
	money: "money",
	bool: "boolean",
	uuid: "uuid",
	text: "text",
	enum: "anyenum",
	range4: "anyrange",
	range8: "anyrange",
	vector: "vector"
} as const satisfies { readonly [C in Carrier]: string }
type CatalogTypeName = (typeof catalogTypeName)[Carrier]

/** The concrete PostgreSQL type of a carrier, as a cast or pg_typeof names it. */
export const concreteTypeName: { readonly [C in Carrier]: string } = {
	...catalogTypeName,
	enum: "enum",
	range4: "int4range",
	range8: "int8range"
}

/** Operands of `list`'s carriers, in order, frozen with the list. */
const positional = <L extends NonEmptyReadonlyArray<Carrier>>(list: L): PositionalOperands<L> => {
	Object.freeze(list)
	const operands: PositionalOperands<L> = { kind: "positional", carriers: list }
	return Object.freeze(operands)
}

/** Any number of operands of `element`, at least one. */
const variadic = (element: Carrier): VariadicOperands => {
	const operands: VariadicOperands = { kind: "variadic", element }
	return Object.freeze(operands)
}

/** An overload frozen with its failure list, which every builder writes inline for it. */
const frozen = <O extends Overload>(overload: O): O => {
	Object.freeze(overload.failures)
	return Object.freeze(overload)
}

type Infix = "+" | "-" | "*" | "/" | "%" | "=" | "<>" | "<" | "<=" | ">" | ">="

/** A pg_catalog infix operator over two operands of one carrier. */
const infix = (
	fn: FixedFn,
	op: Infix,
	carrier: Carrier,
	result: PlainCarrier,
	failures: ReadonlyArray<FailureCode>
): FixedOverload => {
	const t = catalogTypeName[carrier]
	return frozen({
		fn,
		operands: positional([carrier, carrier]),
		result,
		sql: { kind: "infix", op, owner: "catalog" },
		catalog: {
			kind: "operator",
			name: op,
			operands: { kind: "infix", left: t, right: t },
			result: catalogTypeName[result],
			owner: "catalog"
		},
		volatility: "immutable",
		failures
	})
}

/** A pg_catalog prefix minus. */
const negation = (carrier: PlainCarrier, failures: ReadonlyArray<FailureCode>): FixedOverload =>
	frozen({
		fn: "neg",
		operands: positional([carrier]),
		result: carrier,
		sql: { kind: "prefix", op: "-" },
		catalog: {
			kind: "operator",
			name: "-",
			operands: { kind: "prefix", right: catalogTypeName[carrier] },
			result: catalogTypeName[carrier],
			owner: "catalog"
		},
		volatility: "immutable",
		failures
	})

/** A pg_catalog function call over its operands' catalog types; its OpId is its regprocedure signature. */
const fnCall = (
	fn: FixedFn,
	name: string,
	args: NonEmptyReadonlyArray<Carrier>,
	result: PlainCarrier,
	failures: ReadonlyArray<FailureCode>
): FixedOverload =>
	frozen({
		fn,
		operands: positional(args),
		result,
		sql: { kind: "function", name, owner: "catalog" },
		catalog: {
			kind: "function",
			name,
			args: mapNonEmpty(args, (c) => catalogTypeName[c]),
			result: catalogTypeName[result],
			owner: "catalog"
		},
		volatility: "immutable",
		failures
	})

/** A total pgvector function, which SQL qualifies by the installation's extension schema. */
const vectorCall = (
	fn: FixedFn,
	name: string,
	args: NonEmptyReadonlyArray<Carrier>,
	result: PlainCarrier
): FixedOverload =>
	frozen({
		fn,
		operands: positional(args),
		result,
		sql: { kind: "function", name, owner: "vector" },
		catalog: {
			kind: "function",
			name,
			args: mapNonEmpty(args, (c) => catalogTypeName[c]),
			result: catalogTypeName[result],
			owner: "vector"
		},
		volatility: "immutable",
		failures: []
	})

type Comparison = "eq" | "ne" | "lt" | "le" | "gt" | "ge"

const comparisonSymbols = { eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" } as const

/**
 * A comparison over two operands of one carrier, by its pg_operator.oprcode: a range comparison is one polymorphic
 * catalog operator for both range carriers, listed once per carrier (spanOverloads); pgvector's are the extension's
 * operators.
 */
const comparison = (cmp: Comparison, carrier: Carrier): FixedOverload => {
	const t = catalogTypeName[carrier]
	const owner: Owner = carrier === "vector" ? "vector" : "catalog"
	return frozen({
		fn: cmp,
		operands: positional([carrier, carrier]),
		result: "bool",
		sql: { kind: "infix", op: comparisonSymbols[cmp], owner },
		catalog: {
			kind: "operator",
			name: comparisonSymbols[cmp],
			operands: { kind: "infix", left: t, right: t },
			result: "boolean",
			owner
		},
		volatility: "immutable",
		failures: []
	})
}

/** BETWEEN over three operands of one carrier, composed of its >= and <=. */
const between = (carrier: Carrier, ge: OpId, le: OpId): FixedOverload =>
	frozen({
		fn: "between",
		operands: positional([carrier, carrier, carrier]),
		result: "bool",
		sql: { kind: "between" },
		catalog: { kind: "construct", uses: Object.freeze([ge, le]) },
		volatility: "immutable",
		failures: []
	})

/** IN over any number of operands of one carrier, composed of its =. */
const membership = (carrier: Carrier, eq: OpId): FixedOverload =>
	frozen({
		fn: "in",
		operands: variadic(carrier),
		result: "bool",
		sql: { kind: "in" },
		catalog: { kind: "construct", uses: Object.freeze([eq]) },
		volatility: "immutable",
		failures: []
	})

/** LEAST or GREATEST over any number of operands of one carrier, composed of its < or >. */
const extreme = (fn: ExtremeFn, carrier: Carrier, order: OpId): ExtremeOverload =>
	frozen({
		fn,
		operands: variadic(carrier),
		result: carrier,
		sql: { kind: fn },
		catalog: { kind: "construct", uses: Object.freeze([order]) },
		volatility: "immutable",
		failures: []
	})

/** A boolean connective over any number of boolean operands. */
const connective = (fn: "and" | "or"): FixedOverload =>
	frozen({
		fn,
		operands: variadic("bool"),
		result: "bool",
		sql: { kind: fn },
		catalog: { kind: "construct", uses: [] },
		volatility: "immutable",
		failures: []
	})

const booleanNot: FixedOverload = frozen({
	fn: "not",
	operands: positional(["bool"]),
	result: "bool",
	sql: { kind: "not" },
	catalog: { kind: "construct", uses: [] },
	volatility: "immutable",
	failures: []
})

/** A span's lower or upper endpoint, which never returns NULL: a grizzle span is bounded and nonempty. */
const endpoint = (fn: "lower" | "upper", range: SpanCarrier, point: IntCarrier): FixedOverload =>
	frozen({
		fn,
		operands: positional([range]),
		result: point,
		sql: { kind: "function", name: fn, owner: "catalog" },
		catalog: {
			kind: "function",
			name: fn,
			args: ["anyrange"],
			result: "anyelement",
			owner: "catalog"
		},
		volatility: "immutable",
		failures: []
	})

/**
 * The static overload registry of the Compute catalogue, one entry per OpId: a table keyed by the identity the IR
 * carries (ir/expr.ts), so two entries under one identity are a compile error.
 *
 * Every scalar expression node is exactly one PostgreSQL operator, function or cast, or one of the SQL constructs that
 * compose them (BETWEEN, IN, LEAST, GREATEST, AND, OR, NOT); CASE is the IR's own cond node. Each native
 * node records its exact overload: its operand and result carriers, its SQL spelling, the catalog object that
 * implements it, its volatility, and the SQLSTATEs it can raise. The registry is static data: no catalog I/O happens
 * in the compiler, and every entry is the one PostgreSQL 19's pg_operator, pg_proc and pg_cast define.
 *
 * The OpId of an entry:
 * - an operator: its implementing function, pg_operator.oprcode, such as "int8pl" or "numeric_mul";
 * - a function: its regprocedure signature, such as "abs(bigint)" or "round(numeric,integer)"; pgvector's one function
 *   is prefixed with its extension, "vector:cosine_distance(vector,vector)", because its schema is the installation's;
 * - a construct: "between:<type>", "in:<type>", "least:<type>", "greatest:<type>", "and", "or", "not";
 * - a range-polymorphic operator or function, one catalog object for both range carriers: its code and the carrier
 *   (ir/expr.ts rangeOp), listed by both in spanOverloads;
 * - a cast: "cast:<source>-><target>" over PostgreSQL type names, listed by its carriers in castOverloads.
 *
 * What the registry admits is the catalogue, not the catalog: same-type operands only, because Compute's operations
 * take two terms of one type; no bit, string or array function; no money * money,
 * money unary minus, abs(money) or float %, which PostgreSQL does not define; and no money / integer, which the public
 * signatures cannot spell. The gaps where PostgreSQL has no same-type overload are compositions of entries here,
 * resolved in lower.ts: sign over an integer type is sign(numeric) cast back,
 * sign over real is sign(double precision) cast back, and gcd and lcm over smallint are the integer forms cast back.
 *
 * The entries record:
 * - arithmetic: integer overflow, numeric format overflow, float overflow and underflow are 22003; a zero divisor is
 *   22012;
 * - money follows money rules: sums and differences overflow the signed 64-bit count; money / money is double
 *   precision;
 * - numeric functions: a quotient whose weight leaves numeric's format, and a rounding, ceiling or floor that carries
 *   a value at the weight limit (131072 integer digits) past it, is 22003; trunc never grows a value;
 * - comparisons: every carrier with equality has = and <>, every ordered carrier the four orderings;
 * - text length, for contract predicates and row checks only;
 * - pgvector's cosine distance, the one score an approximate search ranks by, never the <=> operator.
 */
const catalogOverloads = {
	int2pl: infix("add", "+", "int2", "int2", ["22003"]),
	int2mi: infix("sub", "-", "int2", "int2", ["22003"]),
	int2mul: infix("mul", "*", "int2", "int2", ["22003"]),
	int2div: infix("div", "/", "int2", "int2", ["22012", "22003"]),
	int2mod: infix("mod", "%", "int2", "int2", ["22012"]),
	int2um: negation("int2", ["22003"]),
	"abs(smallint)": fnCall("abs", "abs", ["int2"], "int2", ["22003"]),
	int4pl: infix("add", "+", "int4", "int4", ["22003"]),
	int4mi: infix("sub", "-", "int4", "int4", ["22003"]),
	int4mul: infix("mul", "*", "int4", "int4", ["22003"]),
	int4div: infix("div", "/", "int4", "int4", ["22012", "22003"]),
	int4mod: infix("mod", "%", "int4", "int4", ["22012"]),
	int4um: negation("int4", ["22003"]),
	"abs(integer)": fnCall("abs", "abs", ["int4"], "int4", ["22003"]),
	int8pl: infix("add", "+", "int8", "int8", ["22003"]),
	int8mi: infix("sub", "-", "int8", "int8", ["22003"]),
	int8mul: infix("mul", "*", "int8", "int8", ["22003"]),
	int8div: infix("div", "/", "int8", "int8", ["22012", "22003"]),
	int8mod: infix("mod", "%", "int8", "int8", ["22012"]),
	int8um: negation("int8", ["22003"]),
	"abs(bigint)": fnCall("abs", "abs", ["int8"], "int8", ["22003"]),
	numeric_add: infix("add", "+", "numeric", "numeric", ["22003"]),
	numeric_sub: infix("sub", "-", "numeric", "numeric", ["22003"]),
	numeric_mul: infix("mul", "*", "numeric", "numeric", ["22003"]),
	numeric_div: infix("div", "/", "numeric", "numeric", ["22012", "22003"]),
	numeric_mod: infix("mod", "%", "numeric", "numeric", ["22012"]),
	numeric_uminus: negation("numeric", []),
	"abs(numeric)": fnCall("abs", "abs", ["numeric"], "numeric", []),
	float4pl: infix("add", "+", "float4", "float4", ["22003"]),
	float4mi: infix("sub", "-", "float4", "float4", ["22003"]),
	float4mul: infix("mul", "*", "float4", "float4", ["22003"]),
	float4div: infix("div", "/", "float4", "float4", ["22012", "22003"]),
	float4um: negation("float4", []),
	"abs(real)": fnCall("abs", "abs", ["float4"], "float4", []),
	float8pl: infix("add", "+", "float8", "float8", ["22003"]),
	float8mi: infix("sub", "-", "float8", "float8", ["22003"]),
	float8mul: infix("mul", "*", "float8", "float8", ["22003"]),
	float8div: infix("div", "/", "float8", "float8", ["22012", "22003"]),
	float8um: negation("float8", []),
	"abs(double precision)": fnCall("abs", "abs", ["float8"], "float8", []),
	cash_pl: infix("add", "+", "money", "money", ["22003"]),
	cash_mi: infix("sub", "-", "money", "money", ["22003"]),
	cash_div_cash: infix("div", "/", "money", "float8", ["22012"]),
	"div(numeric,numeric)": fnCall("quot", "div", ["numeric", "numeric"], "numeric", [
		"22012",
		"22003"
	]),
	"mod(numeric,numeric)": fnCall("rem", "mod", ["numeric", "numeric"], "numeric", ["22012"]),
	"sign(numeric)": fnCall("sign", "sign", ["numeric"], "numeric", []),
	"sign(double precision)": fnCall("sign", "sign", ["float8"], "float8", []),
	"round(numeric)": fnCall("round", "round", ["numeric"], "numeric", ["22003"]),
	"round(numeric,integer)": fnCall("round", "round", ["numeric", "int4"], "numeric", ["22003"]),
	"trunc(numeric)": fnCall("trunc", "trunc", ["numeric"], "numeric", []),
	"trunc(numeric,integer)": fnCall("trunc", "trunc", ["numeric", "int4"], "numeric", []),
	"ceil(numeric)": fnCall("ceil", "ceil", ["numeric"], "numeric", ["22003"]),
	"floor(numeric)": fnCall("floor", "floor", ["numeric"], "numeric", ["22003"]),
	"gcd(integer,integer)": fnCall("gcd", "gcd", ["int4", "int4"], "int4", ["22003"]),
	"lcm(integer,integer)": fnCall("lcm", "lcm", ["int4", "int4"], "int4", ["22003"]),
	"gcd(bigint,bigint)": fnCall("gcd", "gcd", ["int8", "int8"], "int8", ["22003"]),
	"lcm(bigint,bigint)": fnCall("lcm", "lcm", ["int8", "int8"], "int8", ["22003"]),
	"gcd(numeric,numeric)": fnCall("gcd", "gcd", ["numeric", "numeric"], "numeric", []),
	"lcm(numeric,numeric)": fnCall("lcm", "lcm", ["numeric", "numeric"], "numeric", ["22003"]),
	"power(numeric,numeric)": fnCall("power", "power", ["numeric", "numeric"], "numeric", [
		"2201F",
		"22003"
	]),
	"power(double precision,double precision)": fnCall(
		"power",
		"power",
		["float8", "float8"],
		"float8",
		["2201F", "22003"]
	),
	"sqrt(numeric)": fnCall("sqrt", "sqrt", ["numeric"], "numeric", ["2201F"]),
	"sqrt(double precision)": fnCall("sqrt", "sqrt", ["float8"], "float8", ["2201F"]),
	"width_bucket(numeric,numeric,numeric,integer)": fnCall(
		"widthBucket",
		"width_bucket",
		["numeric", "numeric", "numeric", "int4"],
		"int4",
		["2201G", "22003"]
	),
	"scale(numeric)": fnCall("scale", "scale", ["numeric"], "int4", ["null"]),
	"min_scale(numeric)": fnCall("minScale", "min_scale", ["numeric"], "int4", ["null"]),
	"trim_scale(numeric)": fnCall("trimScale", "trim_scale", ["numeric"], "numeric", []),
	"char_length(text)": fnCall("charLength", "char_length", ["text"], "int4", []),
	"vector:cosine_distance(vector,vector)": vectorCall(
		"cosineDistance",
		"cosine_distance",
		["vector", "vector"],
		"float8"
	),
	int2eq: comparison("eq", "int2"),
	int2ne: comparison("ne", "int2"),
	int2lt: comparison("lt", "int2"),
	int2le: comparison("le", "int2"),
	int2gt: comparison("gt", "int2"),
	int2ge: comparison("ge", "int2"),
	"between:smallint": between("int2", opId("int2ge"), opId("int2le")),
	"in:smallint": membership("int2", opId("int2eq")),
	"least:smallint": extreme("least", "int2", opId("int2lt")),
	"greatest:smallint": extreme("greatest", "int2", opId("int2gt")),
	int4eq: comparison("eq", "int4"),
	int4ne: comparison("ne", "int4"),
	int4lt: comparison("lt", "int4"),
	int4le: comparison("le", "int4"),
	int4gt: comparison("gt", "int4"),
	int4ge: comparison("ge", "int4"),
	"between:integer": between("int4", opId("int4ge"), opId("int4le")),
	"in:integer": membership("int4", opId("int4eq")),
	"least:integer": extreme("least", "int4", opId("int4lt")),
	"greatest:integer": extreme("greatest", "int4", opId("int4gt")),
	int8eq: comparison("eq", "int8"),
	int8ne: comparison("ne", "int8"),
	int8lt: comparison("lt", "int8"),
	int8le: comparison("le", "int8"),
	int8gt: comparison("gt", "int8"),
	int8ge: comparison("ge", "int8"),
	"between:bigint": between("int8", opId("int8ge"), opId("int8le")),
	"in:bigint": membership("int8", opId("int8eq")),
	"least:bigint": extreme("least", "int8", opId("int8lt")),
	"greatest:bigint": extreme("greatest", "int8", opId("int8gt")),
	numeric_eq: comparison("eq", "numeric"),
	numeric_ne: comparison("ne", "numeric"),
	numeric_lt: comparison("lt", "numeric"),
	numeric_le: comparison("le", "numeric"),
	numeric_gt: comparison("gt", "numeric"),
	numeric_ge: comparison("ge", "numeric"),
	"between:numeric": between("numeric", opId("numeric_ge"), opId("numeric_le")),
	"in:numeric": membership("numeric", opId("numeric_eq")),
	"least:numeric": extreme("least", "numeric", opId("numeric_lt")),
	"greatest:numeric": extreme("greatest", "numeric", opId("numeric_gt")),
	float4eq: comparison("eq", "float4"),
	float4ne: comparison("ne", "float4"),
	float4lt: comparison("lt", "float4"),
	float4le: comparison("le", "float4"),
	float4gt: comparison("gt", "float4"),
	float4ge: comparison("ge", "float4"),
	"between:real": between("float4", opId("float4ge"), opId("float4le")),
	"in:real": membership("float4", opId("float4eq")),
	"least:real": extreme("least", "float4", opId("float4lt")),
	"greatest:real": extreme("greatest", "float4", opId("float4gt")),
	float8eq: comparison("eq", "float8"),
	float8ne: comparison("ne", "float8"),
	float8lt: comparison("lt", "float8"),
	float8le: comparison("le", "float8"),
	float8gt: comparison("gt", "float8"),
	float8ge: comparison("ge", "float8"),
	"between:double precision": between("float8", opId("float8ge"), opId("float8le")),
	"in:double precision": membership("float8", opId("float8eq")),
	"least:double precision": extreme("least", "float8", opId("float8lt")),
	"greatest:double precision": extreme("greatest", "float8", opId("float8gt")),
	cash_eq: comparison("eq", "money"),
	cash_ne: comparison("ne", "money"),
	cash_lt: comparison("lt", "money"),
	cash_le: comparison("le", "money"),
	cash_gt: comparison("gt", "money"),
	cash_ge: comparison("ge", "money"),
	"between:money": between("money", opId("cash_ge"), opId("cash_le")),
	"in:money": membership("money", opId("cash_eq")),
	"least:money": extreme("least", "money", opId("cash_lt")),
	"greatest:money": extreme("greatest", "money", opId("cash_gt")),
	booleq: comparison("eq", "bool"),
	boolne: comparison("ne", "bool"),
	boollt: comparison("lt", "bool"),
	boolle: comparison("le", "bool"),
	boolgt: comparison("gt", "bool"),
	boolge: comparison("ge", "bool"),
	"between:boolean": between("bool", opId("boolge"), opId("boolle")),
	"in:boolean": membership("bool", opId("booleq")),
	"least:boolean": extreme("least", "bool", opId("boollt")),
	"greatest:boolean": extreme("greatest", "bool", opId("boolgt")),
	uuid_eq: comparison("eq", "uuid"),
	uuid_ne: comparison("ne", "uuid"),
	uuid_lt: comparison("lt", "uuid"),
	uuid_le: comparison("le", "uuid"),
	uuid_gt: comparison("gt", "uuid"),
	uuid_ge: comparison("ge", "uuid"),
	"between:uuid": between("uuid", opId("uuid_ge"), opId("uuid_le")),
	"in:uuid": membership("uuid", opId("uuid_eq")),
	"least:uuid": extreme("least", "uuid", opId("uuid_lt")),
	"greatest:uuid": extreme("greatest", "uuid", opId("uuid_gt")),
	texteq: comparison("eq", "text"),
	textne: comparison("ne", "text"),
	text_lt: comparison("lt", "text"),
	text_le: comparison("le", "text"),
	text_gt: comparison("gt", "text"),
	text_ge: comparison("ge", "text"),
	"between:text": between("text", opId("text_ge"), opId("text_le")),
	"in:text": membership("text", opId("texteq")),
	"least:text": extreme("least", "text", opId("text_lt")),
	"greatest:text": extreme("greatest", "text", opId("text_gt")),
	enum_eq: comparison("eq", "enum"),
	enum_ne: comparison("ne", "enum"),
	enum_lt: comparison("lt", "enum"),
	enum_le: comparison("le", "enum"),
	enum_gt: comparison("gt", "enum"),
	enum_ge: comparison("ge", "enum"),
	"between:enum": between("enum", opId("enum_ge"), opId("enum_le")),
	"in:enum": membership("enum", opId("enum_eq")),
	"least:enum": extreme("least", "enum", opId("enum_lt")),
	"greatest:enum": extreme("greatest", "enum", opId("enum_gt")),
	"between:int4range": between(
		"range4",
		rangeOp("range_ge", "range4"),
		rangeOp("range_le", "range4")
	),
	"in:int4range": membership("range4", rangeOp("range_eq", "range4")),
	"least:int4range": extreme("least", "range4", rangeOp("range_lt", "range4")),
	"greatest:int4range": extreme("greatest", "range4", rangeOp("range_gt", "range4")),
	"between:int8range": between(
		"range8",
		rangeOp("range_ge", "range8"),
		rangeOp("range_le", "range8")
	),
	"in:int8range": membership("range8", rangeOp("range_eq", "range8")),
	"least:int8range": extreme("least", "range8", rangeOp("range_lt", "range8")),
	"greatest:int8range": extreme("greatest", "range8", rangeOp("range_gt", "range8")),
	vector_eq: comparison("eq", "vector"),
	vector_ne: comparison("ne", "vector"),
	vector_lt: comparison("lt", "vector"),
	vector_le: comparison("le", "vector"),
	vector_gt: comparison("gt", "vector"),
	vector_ge: comparison("ge", "vector"),
	"between:vector": between("vector", opId("vector_ge"), opId("vector_le")),
	"in:vector": membership("vector", opId("vector_eq")),
	"least:vector": extreme("least", "vector", opId("vector_lt")),
	"greatest:vector": extreme("greatest", "vector", opId("vector_gt")),
	and: connective("and"),
	or: connective("or"),
	not: booleanNot
} as const satisfies Readonly<Record<string, Overload>>

/** The range-polymorphic overloads the registry lists: the range comparisons and the endpoint functions. */
const listedSpanCodes = [
	"lower(anyrange)",
	"upper(anyrange)",
	"range_eq",
	"range_ne",
	"range_lt",
	"range_le",
	"range_gt",
	"range_ge"
] as const satisfies ReadonlyArray<RangeOpCode>

const listedSpanCarriers = ["range4", "range8"] as const satisfies ReadonlyArray<SpanCarrier>

/** Each range-polymorphic overload by its code and the range carrier it is instantiated at (ir/expr.ts rangeOp). */
const spanOverloads: {
	readonly [K in (typeof listedSpanCodes)[number]]: { readonly [C in SpanCarrier]: Overload }
} = {
	"lower(anyrange)": {
		range4: endpoint("lower", "range4", "int4"),
		range8: endpoint("lower", "range8", "int8")
	},
	"upper(anyrange)": {
		range4: endpoint("upper", "range4", "int4"),
		range8: endpoint("upper", "range8", "int8")
	},
	range_eq: { range4: comparison("eq", "range4"), range8: comparison("eq", "range8") },
	range_ne: { range4: comparison("ne", "range4"), range8: comparison("ne", "range8") },
	range_lt: { range4: comparison("lt", "range4"), range8: comparison("lt", "range8") },
	range_le: { range4: comparison("le", "range4"), range8: comparison("le", "range8") },
	range_gt: { range4: comparison("gt", "range4"), range8: comparison("gt", "range8") },
	range_ge: { range4: comparison("ge", "range4"), range8: comparison("ge", "range8") }
}

/** A registered cast: its node, and the host conversion the evaluator runs for it. */
export interface CastOp extends FixedOp {
	readonly fn: "cast"
	readonly operands: PositionalOperands<readonly [PlainCarrier]>
	readonly host: HostCast
}

/** A registered cast from `S` to `T`. */
interface CastOpOf<S extends PlainCarrier, T extends PlainCarrier> extends CastOp {
	readonly operands: PositionalOperands<readonly [S]>
	readonly result: T
}

/** The cast from `source` to `target`, under its OpId "cast:<source>-><target>" over their PostgreSQL type names. */
const castOp = <S extends PlainCarrier, T extends PlainCarrier>(
	source: S,
	target: T,
	failures: ReadonlyArray<FailureCode>,
	volatility: Volatility,
	host: HostCast
): CastOpOf<S, T> => {
	const op: CastOpOf<S, T> = {
		id: opId(`cast:${catalogTypeName[source]}->${catalogTypeName[target]}`),
		fn: "cast",
		operands: positional([source] as const),
		result: target,
		sql: { kind: "cast", target },
		catalog: { kind: "cast", source: catalogTypeName[source], target: catalogTypeName[target] },
		volatility,
		failures: Object.freeze(failures),
		host
	}
	return Object.freeze(op)
}

/** A cast of each source family, its host conversion the family's for its target. */
const fromInteger = <
	S extends IntCarrier,
	T extends IntCarrier | "numeric" | "float4" | "float8" | "money"
>(
	source: S,
	target: T,
	failures: ReadonlyArray<FailureCode>,
	volatility: Volatility
): CastOpOf<S, T> => castOp(source, target, failures, volatility, integerCast(target))

const fromNumeric = <T extends IntCarrier | "numeric" | "float4" | "float8" | "money">(
	target: T,
	failures: ReadonlyArray<FailureCode>,
	volatility: Volatility
): CastOpOf<"numeric", T> => castOp("numeric", target, failures, volatility, numericCast(target))

const fromFloat = <
	S extends "float4" | "float8",
	T extends IntCarrier | "numeric" | "float4" | "float8"
>(
	source: S,
	target: T,
	failures: ReadonlyArray<FailureCode>,
	volatility: Volatility
): CastOpOf<S, T> => castOp(source, target, failures, volatility, floatCast(source, target))

const fromMoney = (
	target: "numeric",
	failures: ReadonlyArray<FailureCode>,
	volatility: Volatility
): CastOpOf<"money", "numeric"> => castOp("money", target, failures, volatility, moneyToNumeric)

/**
 * Each cast by its source and target carriers, which its OpId "cast:<source>-><target>" spells by their PostgreSQL
 * type names, so two casts under one identity are a compile error. Casts among the numeric family and money: integer
 * narrowing, numeric and float to integer, float8 to real, and numeric or float to a narrower value overflow with
 * 22003; numeric to an integer rounds half away from zero and float to an integer rounds half to even, as
 * PostgreSQL's numeric_int and dtoi casts do. The money casts run in the fixed monetary context and are STABLE in the
 * catalog.
 */
const castOverloads = {
	int2: {
		int4: fromInteger("int2", "int4", [], "immutable"),
		int8: fromInteger("int2", "int8", [], "immutable"),
		numeric: fromInteger("int2", "numeric", [], "immutable"),
		float4: fromInteger("int2", "float4", [], "immutable"),
		float8: fromInteger("int2", "float8", [], "immutable")
	},
	int4: {
		int2: fromInteger("int4", "int2", ["22003"], "immutable"),
		int8: fromInteger("int4", "int8", [], "immutable"),
		numeric: fromInteger("int4", "numeric", [], "immutable"),
		float4: fromInteger("int4", "float4", [], "immutable"),
		float8: fromInteger("int4", "float8", [], "immutable"),
		money: fromInteger("int4", "money", ["22003"], "stable")
	},
	int8: {
		int2: fromInteger("int8", "int2", ["22003"], "immutable"),
		int4: fromInteger("int8", "int4", ["22003"], "immutable"),
		numeric: fromInteger("int8", "numeric", [], "immutable"),
		float4: fromInteger("int8", "float4", [], "immutable"),
		float8: fromInteger("int8", "float8", [], "immutable"),
		money: fromInteger("int8", "money", ["22003"], "stable")
	},
	numeric: {
		int2: fromNumeric("int2", ["22003", "0A000"], "immutable"),
		int4: fromNumeric("int4", ["22003", "0A000"], "immutable"),
		int8: fromNumeric("int8", ["22003", "0A000"], "immutable"),
		float4: fromNumeric("float4", ["22003"], "immutable"),
		float8: fromNumeric("float8", ["22003"], "immutable"),
		numeric: fromNumeric("numeric", ["22003"], "immutable"),
		money: fromNumeric("money", ["22003", "0A000"], "stable")
	},
	float4: {
		int2: fromFloat("float4", "int2", ["22003"], "immutable"),
		int4: fromFloat("float4", "int4", ["22003"], "immutable"),
		int8: fromFloat("float4", "int8", ["22003"], "immutable"),
		float8: fromFloat("float4", "float8", [], "immutable"),
		numeric: fromFloat("float4", "numeric", [], "immutable")
	},
	float8: {
		int2: fromFloat("float8", "int2", ["22003"], "immutable"),
		int4: fromFloat("float8", "int4", ["22003"], "immutable"),
		int8: fromFloat("float8", "int8", ["22003"], "immutable"),
		float4: fromFloat("float8", "float4", ["22003"], "immutable"),
		numeric: fromFloat("float8", "numeric", [], "immutable")
	},
	money: {
		numeric: fromMoney("numeric", [], "stable")
	}
} as const satisfies {
	readonly [S in PlainCarrier]?: { readonly [T in PlainCarrier]?: CastOpOf<S, T> }
}

/** Every cast by its source and target carriers, for a lookup by any pair. */
const castTable: { readonly [S in Carrier]?: { readonly [T in Carrier]?: CastOp } } = castOverloads

const listedOp = (id: OpId, overload: Overload): NativeOp => Object.freeze({ id, ...overload })

/** The registry's node listed under a catalog identity. */
const catalogOp = (id: keyof typeof catalogOverloads): NativeOp =>
	listedOp(opId(id), catalogOverloads[id])

/** Every native node: the catalog identities, the range-polymorphic overloads, then the casts. */
export const nativeOps: ReadonlyArray<NativeOp> = Object.freeze([
	...Object.entries(catalogOverloads).map(([id, overload]) => listedOp(opId(id), overload)),
	...listedSpanCodes.flatMap((code) =>
		listedSpanCarriers.map((carrier) =>
			listedOp(rangeOp(code, carrier), spanOverloads[code][carrier])
		)
	),
	...carriers.flatMap((source) =>
		carriers.flatMap((target) => {
			const op = castTable[source]?.[target]
			return op === undefined ? [] : [op]
		})
	)
])

/** pgvector's cosine distance, the one score an approximate search ranks by. */
export const cosineDistance: NativeOp = catalogOp("vector:cosine_distance(vector,vector)")

/** Boolean AND, the conjunction of any number of boolean operands. */
export const booleanAnd: NativeOp = catalogOp("and")

/** The carrier of a node's first operand. */
export const firstOperand = (operands: Operands): Carrier => {
	switch (operands.kind) {
		case "positional":
			return operands.carriers[0]
		case "variadic":
			return operands.element
	}
}

/** The carriers a node's operands are of: its positional carriers in order, or its one element carrier. */
export const operandCarriers = (operands: Operands): NonEmptyReadonlyArray<Carrier> => {
	switch (operands.kind) {
		case "positional":
			return operands.carriers
		case "variadic":
			return [operands.element]
	}
}

/** Whether a node takes `count` operands: exactly its positional carriers' count, or at least one of its element. */
export const admitsArity = (operands: Operands, count: number): boolean => {
	switch (operands.kind) {
		case "positional":
			return count === operands.carriers.length
		case "variadic":
			return count > 0
	}
}

/** Whether a node takes operands of `actual`'s carriers, in order. */
export const admits = (operands: Operands, actual: ReadonlyArray<Carrier>): boolean => {
	switch (operands.kind) {
		case "positional":
			return (
				actual.length === operands.carriers.length &&
				operands.carriers.every((c, i) => c === actual[i])
			)
		case "variadic":
			return actual.length > 0 && actual.every((c) => c === operands.element)
	}
}

const byId: ReadonlyMap<OpId, NativeOp> = new Map(nativeOps.map((op) => [op.id, op]))

/** The native node an OpId names, or undefined when the registry has no such overload. */
export const nativeOp = (id: OpId): NativeOp | undefined => byId.get(id)

const isExtreme = (op: NativeOp): op is ExtremeOp => op.fn === "least" || op.fn === "greatest"

/**
 * Each function's overloads of a fixed result type, which their operand carriers tell apart: one per function and
 * carriers (test/pg/compute/registry.test.ts checks the table).
 */
const fixedByFn: ReadonlyMap<FixedFn, ReadonlyArray<FixedOp>> = Map.groupBy(
	nativeOps.flatMap((op) => (isExtreme(op) ? [] : [op])),
	(op) => op.fn
)

/** LEAST's and GREATEST's overloads, one per element carrier. */
const extremesByFn: ReadonlyMap<ExtremeFn, ReadonlyArray<ExtremeOp>> = Map.groupBy(
	nativeOps.filter(isExtreme),
	(op) => op.fn
)

/** The overload of `fn` over operands of `args`, or undefined. */
export const overloadOf = (
	fn: Exclude<FixedFn, "cast">,
	args: ReadonlyArray<Carrier>
): FixedOp | undefined => fixedByFn.get(fn)?.find((op) => admits(op.operands, args))

/** LEAST or GREATEST over operands of `carrier`, or undefined. */
export const extremeOf = (fn: ExtremeFn, carrier: Carrier): ExtremeOp | undefined =>
	extremesByFn.get(fn)?.find((op) => op.operands.element === carrier)

/** The native cast from one carrier to another, or undefined when PostgreSQL has none grizzle admits. */
export const castOf = (source: Carrier, target: Carrier): CastOp | undefined =>
	castTable[source]?.[target]

/** A source carrier of a registered cast, and the targets it has one to. */
type CastSource = keyof typeof castOverloads
type CastTarget<S extends CastSource> = keyof (typeof castOverloads)[S]

/** The registered cast between two carriers the table lists a cast between. */
export const registeredCast = <S extends CastSource, T extends CastTarget<S>>(
	source: S,
	target: T
): (typeof castOverloads)[S][T] => castOverloads[source][target]
