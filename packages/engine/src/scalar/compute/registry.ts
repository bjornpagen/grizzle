import type { PreconditionKind } from "#compiler/core/errors.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	type DefinedOp,
	definedOp,
	type OpId,
	OpId as opId,
	type PartialOp,
	partialOp,
	type RangeOpCode,
	rangeOp,
	type Volatility
} from "#compiler/ir/expr.ts"
import type { OperandIndex, Precondition } from "#compiler/ir/proof.ts"
import { type Carrier, carriers, type SpanCarrier } from "#compiler/ir/scalar.ts"
import {
	floatCast,
	type HostCast,
	type IntCarrier,
	integerCast,
	moneyCast,
	numericCast,
	textCast
} from "#compiler/scalar/compute/cast.ts"
import type { ResultCarrier } from "#compiler/scalar/compute/types.ts"
import { whitespaceRun } from "#compiler/scalar/regex/whitespace.ts"

/**
 * Why a host computation has no value: the precondition of the operation its operands fail, or a numeric result past
 * numeric's format, which the lowering's digit bounds rule out (lower.ts). The evaluator meets either only on an
 * expression no lowering admits.
 */
export type Undefined = PreconditionKind | "format"

/**
 * The IEEE 754 operations a float overload computes: the four arithmetic operations, the square root, and the one
 * rounding a conversion into a float carrier is.
 */
export type IeeeOp = "add" | "sub" | "mul" | "div" | "sqrt" | "round"

/**
 * How an overload is defined on every value its operand types admit. Every overload states one, so none can be added
 * partial without deciding, and the lowering and the SQL rendering dispatch on it exhaustively:
 * - `total`: defined everywhere as PostgreSQL computes it: comparisons, boolean composition, numeric arithmetic within
 *   the digit bounds every numeric expression has (lower.ts), sign, char_length, octet_length, span endpoints, widening
 *   casts;
 * - `exact`: integer or money arithmetic computed exactly (T1): its value is an exact integer or exact money
 *   (ir/scalar.ts ExactType), never the overflowing native result, so the overload's catalog result is its PostgreSQL
 *   identity only, and SQL rendering computes it over its operands widened into the exact space
 *   (lower/conservative/expr/exact.ts);
 * - `ieee`: float arithmetic as IEEE 754 defines it (T2): overflow is ±Infinity, underflow the correctly rounded
 *   subnormal or the one zero, x / ±0 is ±Infinity, 0 / 0 and the square root of a negative are NaN, computed by SQL
 *   rendering without letting PostgreSQL raise (lower/conservative/expr/ieee.ts);
 * - `requires`: defined where its preconditions hold, which the lowering proves at the node (T3), or refuses the
 *   operation as PartialOperation.
 */
type Totality =
	| { readonly kind: "total" }
	| { readonly kind: "exact"; readonly yields: "integer" | "money" }
	| { readonly kind: "ieee"; readonly op: IeeeOp }
	| { readonly kind: "requires"; readonly preconditions: NonEmptyReadonlyArray<Precondition> }

const total: Totality = Object.freeze({ kind: "total" })
const exactInteger: Totality = Object.freeze({ kind: "exact", yields: "integer" })
const exactMoney: Totality = Object.freeze({ kind: "exact", yields: "money" })
const ieee = (op: IeeeOp): Totality => Object.freeze({ kind: "ieee", op })
const requires = (preconditions: NonEmptyReadonlyArray<Precondition>): Totality =>
	Object.freeze({ kind: "requires", preconditions: Object.freeze(preconditions) })
const nonzero = (operand: OperandIndex): Precondition => Object.freeze({ kind: "nonzero", operand })
const finite = (operand: OperandIndex): Precondition => Object.freeze({ kind: "finite", operand })
const fits: Precondition = Object.freeze({ kind: "fits" })
const lexical: Precondition = Object.freeze({ kind: "lexical" })
const divisor: Totality = requires([nonzero(1)])
const narrowing: Totality = requires([fits])
const finiteNarrowing: Totality = requires([finite(0), fits])

/** The infix operators an overload is spelled with: arithmetic, comparisons, bit's set algebra, and text's || and ~. */
type Infix =
	| "+"
	| "-"
	| "*"
	| "/"
	| "%"
	| "="
	| "<>"
	| "<"
	| "<="
	| ">"
	| ">="
	| "&"
	| "|"
	| "||"
	| "~"

/**
 * The catalogue that owns an operator or function: PostgreSQL's own, in pg_catalog, or the pgvector extension's, which
 * SQL qualifies by the installation's extension schema.
 */
type Owner = "catalog" | "vector"

/**
 * How the node is spelled in SQL. A set's difference, subset and disjointness are constructs of bit's own operators:
 * `a & ~b`, `bit_count(a & ~b) = 0` and `bit_count(a & b) = 0`; a text's suffix test is one of right, char_length and
 * text's =, `right(a, char_length(b)) = b`, since PostgreSQL has no ends_with.
 */
type SqlForm =
	| { readonly kind: "infix"; readonly op: Infix; readonly owner: Owner }
	| { readonly kind: "prefix"; readonly op: "-" | "~" }
	| { readonly kind: "function"; readonly name: string; readonly owner: Owner }
	| { readonly kind: "cast"; readonly target: Carrier }
	| {
			readonly kind:
				| "between"
				| "in"
				| "least"
				| "greatest"
				| "and"
				| "or"
				| "not"
				| "difference"
				| "subset"
				| "disjoint"
				| "endsWith"
	  }
	| {
			/** whiteSpace collapse, `btrim(regexp_replace(x, run, ' ', 'g'))`, `run` the ARE of a run of white space. */
			readonly kind: "collapse"
			readonly run: string
	  }

/**
 * The catalog object that implements the node, as PostgreSQL's catalog names it. Every type it names is a carrier's
 * regtype spelling (catalogTypeName), never a carrier's own name; a range-polymorphic function returns its range's
 * element, anyelement. An operator's implementing function, pg_operator.oprcode, is its OpId: the catalog identity, or a
 * range overload's code. A parse from text is an I/O conversion, which pg_cast lists for no type (CoerceViaIO): the
 * target's input function, pg_type.typinput, over textout's text (`input`).
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
	| { readonly kind: "input"; readonly target: CatalogTypeName }
	| { readonly kind: "construct"; readonly uses: ReadonlyArray<OpId> }

/**
 * The Compute operation a native node serves, the comparisons, the boolean constructs, the set algebra over a roster,
 * the text operations and the casts; cond has no entry, it is the IR's cond node. The complement serves only the
 * difference and the subset test: it sets a set's hole and padding bits, so no Compute operation yields it; right serves
 * only the suffix test, endsWith.
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
	| "minScale"
	| "lower"
	| "upper"
	| "charLength"
	| "octetLength"
	| "concat"
	| "startsWith"
	| "endsWith"
	| "right"
	| "matches"
	| "translate"
	| "collapse"
	| "regexpReplace"
	| "btrim"
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
	| "union"
	| "intersection"
	| "difference"
	| "complement"
	| "cardinality"
	| "subset"
	| "disjoint"
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

/**
 * What an overload reads of its numeric operands: their values, or also the display scale PostgreSQL keeps beside a
 * value (numeric_div's select_div_scale, sqrt's and power_var's result scales, numeric_avg's quotient). Every overload
 * says which, so a new entry cannot be added without deciding. SQL rendering passes each operand of a "displayScale"
 * overload through trim_scale (lower/conservative/expr/ops.ts operandsAsRead), so the scale it reads is the value's
 * least, a function of the value.
 */
export type OperandReading = "value" | "displayScale"

/** What every overload of the table records: everything about it but its function, result and identity. */
interface OverloadBase {
	readonly operands: Operands
	readonly sql: SqlForm
	readonly catalog: CatalogRef
	readonly volatility: Volatility
	/** How the overload is defined on every value its operands admit. */
	readonly totality: Totality
	/** What the overload reads of its numeric operands. */
	readonly reads: OperandReading
}

/**
 * A function, operator, cast or construct with a fixed result type: a plain carrier, an exact one whose digit bound
 * the lowering derives, or text, any text, of no pattern; an `exact` overload's result is its PostgreSQL identity's,
 * the Compute result its Totality's.
 */
interface FixedOverload extends OverloadBase {
	readonly fn: FixedFn
	readonly result: OverloadResult
}

/** A fixed result: a registered result carrier, or text, which the lowering types as text of no pattern. */
type OverloadResult = ResultCarrier | "text"

/**
 * An operation PostgreSQL types by its operands' common type, a value of its operand carrier: LEAST and GREATEST over
 * any number, and a set's union, intersection, difference and complement, whose result is a set over its operands'
 * roster, which no fixed result carrier holds.
 */
interface CommonTypeOverload extends OverloadBase {
	readonly fn: CommonTypeFn
	readonly result: Carrier
	/** Every one is defined on every value of its operands, so none stands beside a proof. */
	readonly totality: Exclude<Totality, { readonly kind: "requires" }>
}

/** One overload of the table: everything about it but its identity, the key the table lists it under. */
type Overload = FixedOverload | CommonTypeOverload

/** The Compute operations whose result is the common type of their operands. */
export type CommonTypeFn =
	| "least"
	| "greatest"
	| "union"
	| "intersection"
	| "difference"
	| "complement"

/** The Compute operations with a fixed result type. */
export type FixedFn = Exclude<NativeFn, CommonTypeFn>

/**
 * An overload's identity as an expression names it, by its Totality: a DefinedOp, or a PartialOp that stands only
 * beside the proof of its precondition (ir/expr.ts); `partial` tells the two apart.
 */
type Identified =
	| {
			readonly partial: false
			readonly id: DefinedOp
			readonly totality: Exclude<Totality, { readonly kind: "requires" }>
	  }
	| {
			readonly partial: true
			readonly id: PartialOp
			readonly totality: Extract<Totality, { readonly kind: "requires" }>
	  }

/** The identity `id` has under `totality`, minted once per entry. */
const identified = (id: OpId, totality: Totality): Identified =>
	totality.kind === "requires"
		? { partial: true, id: partialOp(id), totality }
		: { partial: false, id: definedOp(id), totality }

/** A native node of a fixed result type. */
export type FixedOp = FixedOverload & Identified

/** A native node typed by its operands' common type, defined everywhere. */
export type CommonTypeOp = CommonTypeOverload & Extract<Identified, { readonly partial: false }>

/** A native node: an overload of the table with its identity. */
export type NativeOp = FixedOp | CommonTypeOp

/**
 * PostgreSQL's regtype spelling of a carrier in pg_operator and pg_proc. A closed id's are smallint's, its code's;
 * range operators are polymorphic, and vector's extension-owned.
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
	date: "date",
	text: "text",
	code: "smallint",
	bits: "bit",
	range4: "anyrange",
	range8: "anyrange",
	vector: "vector",
	exactInteger: "numeric",
	exactMoney: "numeric"
} as const satisfies { readonly [C in Carrier]: string }
type CatalogTypeName = (typeof catalogTypeName)[Carrier]

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

/** An overload, frozen. */
const frozen = <O extends Overload>(overload: O): O => Object.freeze(overload)

/** A pg_catalog infix operator over two operands of one carrier. */
const infix = (
	fn: FixedFn,
	op: Infix,
	carrier: Carrier,
	result: OverloadResult,
	totality: Totality,
	reads: OperandReading
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
		totality,
		reads
	})
}

/** A pg_catalog prefix minus. */
const negation = (carrier: ResultCarrier, totality: Totality): FixedOverload =>
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
		totality,
		reads: "value"
	})

/** A pg_catalog function call over its operands' catalog types; its OpId is its regprocedure signature. */
const fnCall = (
	fn: FixedFn,
	name: string,
	args: NonEmptyReadonlyArray<Carrier>,
	result: OverloadResult,
	totality: Totality,
	reads: OperandReading
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
		totality,
		reads
	})

/** A total pgvector function, which SQL qualifies by the installation's extension schema. */
const vectorCall = (
	fn: FixedFn,
	name: string,
	args: NonEmptyReadonlyArray<Carrier>,
	result: ResultCarrier
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
		totality: total,
		reads: "value"
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
		totality: total,
		reads: "value"
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
		totality: total,
		reads: "value"
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
		totality: total,
		reads: "value"
	})

/** LEAST or GREATEST over any number of operands of one carrier, composed of its < or >. */
const extreme = (fn: "least" | "greatest", carrier: Carrier, order: OpId): CommonTypeOverload =>
	frozen({
		fn,
		operands: variadic(carrier),
		result: carrier,
		sql: { kind: fn },
		catalog: { kind: "construct", uses: Object.freeze([order]) },
		volatility: "immutable",
		totality: total,
		reads: "value"
	})

/** A set's union or intersection, bit's `|` or `&` over two sets of one roster: a set over it. */
const setInfix = (fn: "union" | "intersection", op: "|" | "&"): CommonTypeOverload =>
	frozen({
		fn,
		operands: positional(["bits", "bits"]),
		result: "bits",
		sql: { kind: "infix", op, owner: "catalog" },
		catalog: {
			kind: "operator",
			name: op,
			operands: { kind: "infix", left: "bit", right: "bit" },
			result: "bit",
			owner: "catalog"
		},
		volatility: "immutable",
		totality: total,
		reads: "value"
	})

/** bit's prefix `~`, which sets the hole and padding bits too: only the difference and the subset test read it. */
const setComplement: CommonTypeOverload = frozen({
	fn: "complement",
	operands: positional(["bits"]),
	result: "bits",
	sql: { kind: "prefix", op: "~" },
	catalog: {
		kind: "operator",
		name: "~",
		operands: { kind: "prefix", right: "bit" },
		result: "bit",
		owner: "catalog"
	},
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/** A set's difference, `a & ~b`: a set over the operands' roster, its holes and padding clear, since a's are. */
const setDifference: CommonTypeOverload = frozen({
	fn: "difference",
	operands: positional(["bits", "bits"]),
	result: "bits",
	sql: { kind: "difference" },
	catalog: { kind: "construct", uses: Object.freeze([opId("bitand"), opId("bitnot")]) },
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * Whether one set is a subset of another, `bit_count(a & ~b) = 0`, or disjoint from it, `bit_count(a & b) = 0`: a
 * count of no member, so a hole or padding bit, which neither operand sets, never counts.
 */
const setTest = (fn: "subset" | "disjoint", uses: ReadonlyArray<OpId>): FixedOverload =>
	frozen({
		fn,
		operands: positional(["bits", "bits"]),
		result: "bool",
		sql: { kind: fn },
		catalog: { kind: "construct", uses: Object.freeze(uses) },
		volatility: "immutable",
		totality: total,
		reads: "value"
	})

/**
 * A text's suffix test, `right(a, char_length(b)) = b`: right of more characters than a holds is a itself, which
 * equals b only where the two are one text, so the test is defined on every pair of texts.
 */
const textSuffix: FixedOverload = frozen({
	fn: "endsWith",
	operands: positional(["text", "text"]),
	result: "bool",
	sql: { kind: "endsWith" },
	catalog: {
		kind: "construct",
		uses: Object.freeze([opId("right(text,integer)"), opId("char_length(text)"), opId("texteq")])
	},
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * whiteSpace collapse, `btrim(regexp_replace(x, '[ \t\n\r]+', ' ', 'g'))`: each run of white space one space, then the
 * spaces at either end trimmed. Both functions are IMMUTABLE, and a bracket of four literal characters reads no
 * collation, so it is one value wherever it stands, a generated column among them.
 */
const textCollapse: FixedOverload = frozen({
	fn: "collapse",
	operands: positional(["text"]),
	result: "text",
	sql: { kind: "collapse", run: whitespaceRun },
	catalog: {
		kind: "construct",
		uses: Object.freeze([opId("regexp_replace(text,text,text,text)"), opId("btrim(text)")])
	},
	volatility: "immutable",
	totality: total,
	reads: "value"
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
		totality: total,
		reads: "value"
	})

const booleanNot: FixedOverload = frozen({
	fn: "not",
	operands: positional(["bool"]),
	result: "bool",
	sql: { kind: "not" },
	catalog: { kind: "construct", uses: [] },
	volatility: "immutable",
	totality: total,
	reads: "value"
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
		totality: total,
		reads: "value"
	})

/**
 * The static overload registry of the Compute catalogue, one entry per OpId: a table keyed by the identity the IR
 * carries (ir/expr.ts), so two entries under one identity are a compile error.
 *
 * Every scalar expression node is exactly one PostgreSQL operator, function or cast, or one of the SQL constructs that
 * compose them (BETWEEN, IN, LEAST, GREATEST, AND, OR, NOT); CASE is the IR's own cond node. Each native
 * node records its exact overload: its operand and result carriers, its SQL spelling, the catalog object that
 * implements it, its volatility, and how it is defined on every value (Totality). The registry is static data: no catalog I/O happens
 * in the compiler, and every entry is the one PostgreSQL 19's pg_operator, pg_proc and pg_cast define.
 *
 * The OpId of an entry:
 * - an operator: its implementing function, pg_operator.oprcode, such as "int8pl" or "numeric_mul";
 * - a function: its regprocedure signature, such as "abs(bigint)" or "round(numeric,integer)"; pgvector's one function
 *   is prefixed with its extension, "vector:cosine_distance(vector,vector)", because its schema is the installation's;
 * - a closed id's operator: smallint's, its code's, prefixed "code:", as "code:int2eq";
 * - a construct: "between:<type>", "in:<type>", "least:<type>", "greatest:<type>", "and", "or", "not", a set's
 *   "difference:bits", "subset:bits" and "disjoint:bits", and a text's "endsWith:text";
 * - a range-polymorphic operator or function, one catalog object for both range carriers: its code and the carrier
 *   (ir/expr.ts rangeOp), listed by both in spanOverloads;
 * - a cast: "cast:<source>-><target>" over its carriers, as castOverloads lists it.
 *
 * What the registry admits is the catalogue, not the catalog: same-type operands only, because Compute's operations
 * take two terms of one type, but right(text, integer), which only the suffix test reads; of text's functions only
 * its length, concatenation, prefix and suffix tests, regex match and translate, no array function, and of bit's only the set
 * algebra over a roster; no money * money,
 * money unary minus, abs(money) or float %, which PostgreSQL does not define; and no money / integer, which the public
 * signatures cannot spell. The gaps where PostgreSQL has no same-type overload are compositions of entries here,
 * resolved in lower.ts: sign over an integer type is sign(numeric) cast back, sign over real is sign(double precision)
 * cast back, gcd and lcm over smallint are the integer forms, and integer division is the exact integers' truncating
 * div, so int2div, int4div and int8div, which overflow at the type's minimum over -1, are no entries.
 *
 * The entries record, each with its Totality, so that no expression raises on a value its operands admit:
 * - integer arithmetic (+, -, *, unary minus, abs, gcd, lcm over smallint, integer and bigint) is `exact`: an exact
 *   integer, delivered as bigint; money + and - are `exact` money. The exact carriers' own overloads (OpIds prefixed
 *   "exact:" and "exactMoney:") take exact operands and are numeric's, total within the digit bounds;
 * - float +, -, *, / and the square root over double precision are `ieee`;
 * - numeric arithmetic, rounding, ceiling, floor, trunc, gcd and lcm are total: every numeric field declares its
 *   precision and every computed numeric carries the bound its making proved, a making past numericMaxIntegerDigits
 *   being ResourceBound where the value is made, so none reaches numeric's limit;
 * - a divisor (/, %, div, mod over numeric, the exact integers, the integers' %, money / money) is `nonzero`; numeric
 *   sqrt's radicand `nonnegative`; min_scale's operand `finite`; power its `powerDomain`; width_bucket its
 *   `bucketDomain`;
 * - money / money is double precision;
 * - comparisons: every carrier with equality has = and <>, every ordered carrier the four orderings;
 * - a set over a roster's union (bitor), intersection (bitand) and cardinality (bit_count(bit)), its difference, subset
 *   and disjointness composed of them, all total; bitnot only inside those, since it sets the hole and padding bits;
 * - text length in code points (char_length) and in UTF-8 bytes (octet_length), concatenation (textcat), and the
 *   prefix and suffix tests (starts_with, and right, char_length and = composed), each for checks only; and the regex match (textregexeq), whose pattern operand's every value was
 *   admitted inside PostgreSQL's regex compile space where the node was typed (compute/lower.ts), everywhere. textcat
 *   allocates its result, which past PostgreSQL's MaxAllocSize raises "invalid memory alloc request size": no query
 *   holds it, an equation with a concatenation lowering without it (compute/lower.ts concatEquation), and a check or
 *   generated column holding it fails a write whose texts would pass 1 GB;
 * - translate(text, text, text), whose map lowering admits of from and to literals of one length, each character of
 *   from once (scalar/regex/translate.ts charMapOf): it allocates four bytes per byte of its operand, and past
 *   MaxAllocSize raises "requested length too large", so a query holds it only over an operand whose pattern bounds its
 *   bytes within translateMaxBytes, and a check or generated column holding it fails a write whose operand is longer;
 * - pgvector's cosine distance, the one score an approximate search ranks by, never the <=> operator;
 * - readings: numeric_div, power(numeric,numeric) and sqrt(numeric) take their result scale from their operands'
 *   display scales (numeric.c select_div_scale, sqrt's and power_var's rscale, the exponent's included), so they are
 *   "displayScale" and render their operands through trim_scale. Every other entry reads values: add, sub, mul
 *   (rounded past 16383 digits at a fixed position), mod, abs, neg, gcd, lcm, div (truncated, exact) and width_bucket
 *   (compute_bucket divides exactly at scale 0) are exact; sign, round, trunc, ceil, floor and min_scale are functions
 *   of the value by definition; comparisons, hashing and casts are value-based.
 */
const catalogOverloads = {
	int2pl: infix("add", "+", "int2", "int2", exactInteger, "value"),
	int2mi: infix("sub", "-", "int2", "int2", exactInteger, "value"),
	int2mul: infix("mul", "*", "int2", "int2", exactInteger, "value"),
	int2mod: infix("mod", "%", "int2", "int2", divisor, "value"),
	int2um: negation("int2", exactInteger),
	"abs(smallint)": fnCall("abs", "abs", ["int2"], "int2", exactInteger, "value"),
	int4pl: infix("add", "+", "int4", "int4", exactInteger, "value"),
	int4mi: infix("sub", "-", "int4", "int4", exactInteger, "value"),
	int4mul: infix("mul", "*", "int4", "int4", exactInteger, "value"),
	int4mod: infix("mod", "%", "int4", "int4", divisor, "value"),
	int4um: negation("int4", exactInteger),
	"abs(integer)": fnCall("abs", "abs", ["int4"], "int4", exactInteger, "value"),
	int8pl: infix("add", "+", "int8", "int8", exactInteger, "value"),
	int8mi: infix("sub", "-", "int8", "int8", exactInteger, "value"),
	int8mul: infix("mul", "*", "int8", "int8", exactInteger, "value"),
	int8mod: infix("mod", "%", "int8", "int8", divisor, "value"),
	int8um: negation("int8", exactInteger),
	"abs(bigint)": fnCall("abs", "abs", ["int8"], "int8", exactInteger, "value"),
	numeric_add: infix("add", "+", "numeric", "numeric", total, "value"),
	numeric_sub: infix("sub", "-", "numeric", "numeric", total, "value"),
	numeric_mul: infix("mul", "*", "numeric", "numeric", total, "value"),
	numeric_div: infix("div", "/", "numeric", "numeric", divisor, "displayScale"),
	numeric_mod: infix("mod", "%", "numeric", "numeric", divisor, "value"),
	numeric_uminus: negation("numeric", total),
	"abs(numeric)": fnCall("abs", "abs", ["numeric"], "numeric", total, "value"),
	float4pl: infix("add", "+", "float4", "float4", ieee("add"), "value"),
	float4mi: infix("sub", "-", "float4", "float4", ieee("sub"), "value"),
	float4mul: infix("mul", "*", "float4", "float4", ieee("mul"), "value"),
	float4div: infix("div", "/", "float4", "float4", ieee("div"), "value"),
	float4um: negation("float4", total),
	"abs(real)": fnCall("abs", "abs", ["float4"], "float4", total, "value"),
	float8pl: infix("add", "+", "float8", "float8", ieee("add"), "value"),
	float8mi: infix("sub", "-", "float8", "float8", ieee("sub"), "value"),
	float8mul: infix("mul", "*", "float8", "float8", ieee("mul"), "value"),
	float8div: infix("div", "/", "float8", "float8", ieee("div"), "value"),
	float8um: negation("float8", total),
	"abs(double precision)": fnCall("abs", "abs", ["float8"], "float8", total, "value"),
	cash_pl: infix("add", "+", "money", "money", exactMoney, "value"),
	cash_mi: infix("sub", "-", "money", "money", exactMoney, "value"),
	cash_div_cash: infix("div", "/", "money", "float8", divisor, "value"),
	"div(numeric,numeric)": fnCall(
		"quot",
		"div",
		["numeric", "numeric"],
		"numeric",
		divisor,
		"value"
	),
	"mod(numeric,numeric)": fnCall("rem", "mod", ["numeric", "numeric"], "numeric", divisor, "value"),
	"sign(numeric)": fnCall("sign", "sign", ["numeric"], "numeric", total, "value"),
	"sign(double precision)": fnCall("sign", "sign", ["float8"], "float8", total, "value"),
	"round(numeric)": fnCall("round", "round", ["numeric"], "numeric", total, "value"),
	"round(numeric,integer)": fnCall(
		"round",
		"round",
		["numeric", "int4"],
		"numeric",
		total,
		"value"
	),
	"trunc(numeric)": fnCall("trunc", "trunc", ["numeric"], "numeric", total, "value"),
	"trunc(numeric,integer)": fnCall(
		"trunc",
		"trunc",
		["numeric", "int4"],
		"numeric",
		total,
		"value"
	),
	"ceil(numeric)": fnCall("ceil", "ceil", ["numeric"], "numeric", total, "value"),
	"floor(numeric)": fnCall("floor", "floor", ["numeric"], "numeric", total, "value"),
	"gcd(integer,integer)": fnCall("gcd", "gcd", ["int4", "int4"], "int4", exactInteger, "value"),
	"lcm(integer,integer)": fnCall("lcm", "lcm", ["int4", "int4"], "int4", exactInteger, "value"),
	"gcd(bigint,bigint)": fnCall("gcd", "gcd", ["int8", "int8"], "int8", exactInteger, "value"),
	"lcm(bigint,bigint)": fnCall("lcm", "lcm", ["int8", "int8"], "int8", exactInteger, "value"),
	"gcd(numeric,numeric)": fnCall("gcd", "gcd", ["numeric", "numeric"], "numeric", total, "value"),
	"lcm(numeric,numeric)": fnCall("lcm", "lcm", ["numeric", "numeric"], "numeric", total, "value"),
	"power(numeric,numeric)": fnCall(
		"power",
		"power",
		["numeric", "numeric"],
		"numeric",
		requires([{ kind: "powerDomain" }]),
		"displayScale"
	),
	"power(double precision,double precision)": fnCall(
		"power",
		"power",
		["float8", "float8"],
		"float8",
		requires([{ kind: "powerDomain" }]),
		"value"
	),
	"sqrt(numeric)": fnCall(
		"sqrt",
		"sqrt",
		["numeric"],
		"numeric",
		requires([{ kind: "nonnegative", operand: 0 }]),
		"displayScale"
	),
	"sqrt(double precision)": fnCall("sqrt", "sqrt", ["float8"], "float8", ieee("sqrt"), "value"),
	"width_bucket(numeric,numeric,numeric,integer)": fnCall(
		"widthBucket",
		"width_bucket",
		["numeric", "numeric", "numeric", "int4"],
		"int4",
		requires([{ kind: "bucketDomain" }]),
		"value"
	),
	"min_scale(numeric)": fnCall(
		"minScale",
		"min_scale",
		["numeric"],
		"int4",
		requires([finite(0)]),
		"value"
	),
	"char_length(text)": fnCall("charLength", "char_length", ["text"], "int4", total, "value"),
	"octet_length(text)": fnCall("octetLength", "octet_length", ["text"], "int4", total, "value"),
	textcat: infix("concat", "||", "text", "text", total, "value"),
	"starts_with(text,text)": fnCall(
		"startsWith",
		"starts_with",
		["text", "text"],
		"bool",
		total,
		"value"
	),
	"right(text,integer)": fnCall("right", "right", ["text", "int4"], "text", total, "value"),
	"endsWith:text": textSuffix,
	textregexeq: infix("matches", "~", "text", "bool", total, "value"),
	"regexp_replace(text,text,text,text)": fnCall(
		"regexpReplace",
		"regexp_replace",
		["text", "text", "text", "text"],
		"text",
		total,
		"value"
	),
	"btrim(text)": fnCall("btrim", "btrim", ["text"], "text", total, "value"),
	"collapse:text": textCollapse,
	"translate(text,text,text)": fnCall(
		"translate",
		"translate",
		["text", "text", "text"],
		"text",
		total,
		"value"
	),
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
	date_eq: comparison("eq", "date"),
	date_ne: comparison("ne", "date"),
	date_lt: comparison("lt", "date"),
	date_le: comparison("le", "date"),
	date_gt: comparison("gt", "date"),
	date_ge: comparison("ge", "date"),
	"between:date": between("date", opId("date_ge"), opId("date_le")),
	"in:date": membership("date", opId("date_eq")),
	"least:date": extreme("least", "date", opId("date_lt")),
	"greatest:date": extreme("greatest", "date", opId("date_gt")),
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
	"code:int2eq": comparison("eq", "code"),
	"code:int2ne": comparison("ne", "code"),
	"code:int2lt": comparison("lt", "code"),
	"code:int2le": comparison("le", "code"),
	"code:int2gt": comparison("gt", "code"),
	"code:int2ge": comparison("ge", "code"),
	"between:code": between("code", opId("code:int2ge"), opId("code:int2le")),
	"in:code": membership("code", opId("code:int2eq")),
	"least:code": extreme("least", "code", opId("code:int2lt")),
	"greatest:code": extreme("greatest", "code", opId("code:int2gt")),
	biteq: comparison("eq", "bits"),
	bitne: comparison("ne", "bits"),
	bitor: setInfix("union", "|"),
	bitand: setInfix("intersection", "&"),
	bitnot: setComplement,
	"bit_count(bit)": fnCall("cardinality", "bit_count", ["bits"], "int8", total, "value"),
	"difference:bits": setDifference,
	"subset:bits": setTest("subset", [
		opId("bitand"),
		opId("bitnot"),
		opId("bit_count(bit)"),
		opId("int8eq")
	]),
	"disjoint:bits": setTest("disjoint", [opId("bitand"), opId("bit_count(bit)"), opId("int8eq")]),
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
	"exact:numeric_add": infix("add", "+", "exactInteger", "exactInteger", total, "value"),
	"exact:numeric_sub": infix("sub", "-", "exactInteger", "exactInteger", total, "value"),
	"exact:numeric_mul": infix("mul", "*", "exactInteger", "exactInteger", total, "value"),
	"exact:numeric_uminus": negation("exactInteger", total),
	"exact:abs(numeric)": fnCall("abs", "abs", ["exactInteger"], "exactInteger", total, "value"),
	"exact:div(numeric,numeric)": fnCall(
		"div",
		"div",
		["exactInteger", "exactInteger"],
		"exactInteger",
		divisor,
		"value"
	),
	"exact:mod(numeric,numeric)": fnCall(
		"mod",
		"mod",
		["exactInteger", "exactInteger"],
		"exactInteger",
		divisor,
		"value"
	),
	"exact:gcd(numeric,numeric)": fnCall(
		"gcd",
		"gcd",
		["exactInteger", "exactInteger"],
		"exactInteger",
		total,
		"value"
	),
	"exact:lcm(numeric,numeric)": fnCall(
		"lcm",
		"lcm",
		["exactInteger", "exactInteger"],
		"exactInteger",
		total,
		"value"
	),
	"exact:sign(numeric)": fnCall("sign", "sign", ["exactInteger"], "exactInteger", total, "value"),
	"exact:numeric_eq": comparison("eq", "exactInteger"),
	"exact:numeric_ne": comparison("ne", "exactInteger"),
	"exact:numeric_lt": comparison("lt", "exactInteger"),
	"exact:numeric_le": comparison("le", "exactInteger"),
	"exact:numeric_gt": comparison("gt", "exactInteger"),
	"exact:numeric_ge": comparison("ge", "exactInteger"),
	"between:exact integer": between(
		"exactInteger",
		opId("exact:numeric_ge"),
		opId("exact:numeric_le")
	),
	"in:exact integer": membership("exactInteger", opId("exact:numeric_eq")),
	"least:exact integer": extreme("least", "exactInteger", opId("exact:numeric_lt")),
	"greatest:exact integer": extreme("greatest", "exactInteger", opId("exact:numeric_gt")),
	"exactMoney:numeric_add": infix("add", "+", "exactMoney", "exactMoney", total, "value"),
	"exactMoney:numeric_sub": infix("sub", "-", "exactMoney", "exactMoney", total, "value"),
	"exactMoney:numeric_eq": comparison("eq", "exactMoney"),
	"exactMoney:numeric_ne": comparison("ne", "exactMoney"),
	"exactMoney:numeric_lt": comparison("lt", "exactMoney"),
	"exactMoney:numeric_le": comparison("le", "exactMoney"),
	"exactMoney:numeric_gt": comparison("gt", "exactMoney"),
	"exactMoney:numeric_ge": comparison("ge", "exactMoney"),
	"between:exact money": between(
		"exactMoney",
		opId("exactMoney:numeric_ge"),
		opId("exactMoney:numeric_le")
	),
	"in:exact money": membership("exactMoney", opId("exactMoney:numeric_eq")),
	"least:exact money": extreme("least", "exactMoney", opId("exactMoney:numeric_lt")),
	"greatest:exact money": extreme("greatest", "exactMoney", opId("exactMoney:numeric_gt")),
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
export type CastOp = FixedOp & {
	readonly fn: "cast"
	readonly operands: PositionalOperands<readonly [ResultCarrier | "text"]>
	readonly host: HostCast
}

/** A registered cast from `S` to `T`. */
type CastOpOf<S extends ResultCarrier | "text", T extends ResultCarrier> = CastOp & {
	readonly operands: PositionalOperands<readonly [S]>
	readonly result: T
}

/**
 * The cast from `source` to `target`, under its OpId "cast:<source>-><target>" over their carriers: an exact carrier
 * and numeric share PostgreSQL's type name, and their casts differ in what they need (numeric into numeric is a
 * typmod's narrowing, an exact integer into numeric total), so only the carriers name one cast.
 */
const castOp = <S extends ResultCarrier | "text", T extends ResultCarrier>(
	source: S,
	target: T,
	totality: Totality,
	volatility: Volatility,
	host: HostCast
): CastOpOf<S, T> => {
	const op: CastOpOf<S, T> = {
		...identified(opId(`cast:${source}->${target}`), totality),
		fn: "cast",
		operands: positional([source] as const),
		result: target,
		sql: { kind: "cast", target },
		catalog: { kind: "cast", source: catalogTypeName[source], target: catalogTypeName[target] },
		volatility,
		reads: "value",
		host
	}
	return Object.freeze(op)
}

/** A cast of each source family, its host conversion the family's for its target. */
const fromInteger = <
	S extends IntCarrier | "exactInteger",
	T extends IntCarrier | "numeric" | "float4" | "float8" | "money" | "exactInteger"
>(
	source: S,
	target: T,
	totality: Totality,
	volatility: Volatility
): CastOpOf<S, T> => castOp(source, target, totality, volatility, integerCast(target))

const fromNumeric = <T extends IntCarrier | "numeric" | "float4" | "float8" | "money">(
	target: T,
	totality: Totality,
	volatility: Volatility
): CastOpOf<"numeric", T> => castOp("numeric", target, totality, volatility, numericCast(target))

const fromFloat = <
	S extends "float4" | "float8",
	T extends IntCarrier | "numeric" | "float4" | "float8"
>(
	source: S,
	target: T,
	totality: Totality,
	volatility: Volatility
): CastOpOf<S, T> => castOp(source, target, totality, volatility, floatCast(source, target))

const fromMoney = <S extends "money" | "exactMoney", T extends "numeric" | "money" | "exactMoney">(
	source: S,
	target: T,
	totality: Totality,
	volatility: Volatility
): CastOpOf<S, T> => castOp(source, target, totality, volatility, moneyCast(target))

/**
 * A parse, the cast from text into a type with a lexical form (scalar/lexical.ts): PostgreSQL's input function of the
 * target over the text, an I/O conversion whose volatility is its input function's and textout's (nodeFuncs.c
 * check_functions_in_node, CoerceViaIO), IMMUTABLE for int2in, int4in, int8in, numeric_in, float8in and boolin, and
 * for a date make_date over the text's year, month and day, since date_in is STABLE (sql/lexical.ts). It is defined
 * where the text is a member of the target's lexical form ("lexical"), which the lowering proves by language
 * inclusion.
 */
const fromText = <T extends "int2" | "int4" | "int8" | "numeric" | "float8" | "bool" | "date">(
	target: T
): CastOpOf<"text", T> =>
	Object.freeze({
		...castOp("text", target, requires([lexical]), "immutable", textCast),
		catalog:
			target === "date"
				? dateOfTextCatalog
				: { kind: "input" as const, target: catalogTypeName[target] }
	})

/**
 * What a date's parse calls: make_date over the text's year, month and day, each an integer's parse (sql/lexical.ts
 * dateOfText), IMMUTABLE where date_in, the I/O conversion's, is STABLE.
 */
const dateOfTextCatalog: CatalogRef = {
	kind: "function",
	name: "make_date",
	args: [catalogTypeName.int4, catalogTypeName.int4, catalogTypeName.int4],
	result: catalogTypeName.date,
	owner: "catalog"
}

/**
 * Each cast by its source and target carriers, which its OpId "cast:<source>-><target>" spells, so no two casts share
 * an identity. Casts among the numeric family, money and the
 * exact carriers, each with its Totality: a widening is total; integer narrowing, an exact integer or exact amount
 * into a storage carrier, numeric and float to an integer or money, and a numeric typmod coercion are defined where
 * the value fits (numeric and floats also finite); a conversion into a float rounds once as IEEE 754 does (`ieee`
 * round). Numeric to an integer rounds half away from zero and float to an integer rounds half to even, as
 * PostgreSQL's numeric_int and dtoi casts do. The money casts run in the fixed monetary context and are STABLE in the
 * catalog.
 */
const castOverloads = {
	int2: {
		int4: fromInteger("int2", "int4", total, "immutable"),
		int8: fromInteger("int2", "int8", total, "immutable"),
		numeric: fromInteger("int2", "numeric", total, "immutable"),
		float4: fromInteger("int2", "float4", total, "immutable"),
		float8: fromInteger("int2", "float8", total, "immutable"),
		exactInteger: fromInteger("int2", "exactInteger", total, "immutable")
	},
	int4: {
		int2: fromInteger("int4", "int2", narrowing, "immutable"),
		int8: fromInteger("int4", "int8", total, "immutable"),
		numeric: fromInteger("int4", "numeric", total, "immutable"),
		float4: fromInteger("int4", "float4", total, "immutable"),
		float8: fromInteger("int4", "float8", total, "immutable"),
		money: fromInteger("int4", "money", total, "stable"),
		exactInteger: fromInteger("int4", "exactInteger", total, "immutable")
	},
	int8: {
		int2: fromInteger("int8", "int2", narrowing, "immutable"),
		int4: fromInteger("int8", "int4", narrowing, "immutable"),
		numeric: fromInteger("int8", "numeric", total, "immutable"),
		float4: fromInteger("int8", "float4", total, "immutable"),
		float8: fromInteger("int8", "float8", total, "immutable"),
		money: fromInteger("int8", "money", narrowing, "stable"),
		exactInteger: fromInteger("int8", "exactInteger", total, "immutable")
	},
	numeric: {
		int2: fromNumeric("int2", finiteNarrowing, "immutable"),
		int4: fromNumeric("int4", finiteNarrowing, "immutable"),
		int8: fromNumeric("int8", finiteNarrowing, "immutable"),
		float4: fromNumeric("float4", ieee("round"), "immutable"),
		float8: fromNumeric("float8", ieee("round"), "immutable"),
		numeric: fromNumeric("numeric", narrowing, "immutable"),
		money: fromNumeric("money", finiteNarrowing, "stable")
	},
	float4: {
		int2: fromFloat("float4", "int2", finiteNarrowing, "immutable"),
		int4: fromFloat("float4", "int4", finiteNarrowing, "immutable"),
		int8: fromFloat("float4", "int8", finiteNarrowing, "immutable"),
		float8: fromFloat("float4", "float8", total, "immutable"),
		numeric: fromFloat("float4", "numeric", total, "immutable")
	},
	float8: {
		int2: fromFloat("float8", "int2", finiteNarrowing, "immutable"),
		int4: fromFloat("float8", "int4", finiteNarrowing, "immutable"),
		int8: fromFloat("float8", "int8", finiteNarrowing, "immutable"),
		float4: fromFloat("float8", "float4", ieee("round"), "immutable"),
		numeric: fromFloat("float8", "numeric", total, "immutable")
	},
	money: {
		numeric: fromMoney("money", "numeric", total, "stable"),
		exactMoney: fromMoney("money", "exactMoney", total, "stable")
	},
	exactInteger: {
		int2: fromInteger("exactInteger", "int2", narrowing, "immutable"),
		int4: fromInteger("exactInteger", "int4", narrowing, "immutable"),
		int8: fromInteger("exactInteger", "int8", narrowing, "immutable"),
		numeric: fromInteger("exactInteger", "numeric", total, "immutable"),
		float4: fromInteger("exactInteger", "float4", ieee("round"), "immutable"),
		float8: fromInteger("exactInteger", "float8", ieee("round"), "immutable"),
		money: fromInteger("exactInteger", "money", narrowing, "stable")
	},
	exactMoney: {
		money: fromMoney("exactMoney", "money", narrowing, "stable"),
		numeric: fromMoney("exactMoney", "numeric", total, "immutable")
	},
	text: {
		int2: fromText("int2"),
		int4: fromText("int4"),
		int8: fromText("int8"),
		numeric: fromText("numeric"),
		float8: fromText("float8"),
		bool: fromText("bool"),
		date: fromText("date")
	}
} as const satisfies {
	readonly [S in ResultCarrier | "text"]?: { readonly [T in ResultCarrier]?: CastOpOf<S, T> }
}

/**
 * Whether a cast node is the parse of a date text, which SQL spells as make_date over the text's parts, never as its
 * catalog cast `text::date`, whose input function is STABLE (sql/lexical.ts dateOfText).
 */
export const isDateParse = (cast: OpId): boolean => cast === castOverloads.text.date.id

/** Every cast by its source and target carriers, for a lookup by any pair. */
const castTable: { readonly [S in Carrier]?: { readonly [T in Carrier]?: CastOp } } = castOverloads

const commonTypeFns: ReadonlySet<NativeFn> = new Set<CommonTypeFn>([
	"least",
	"greatest",
	"union",
	"intersection",
	"difference",
	"complement"
])

/** Whether an overload is typed by its operands' common type: its function is one of CommonTypeFn. */
const isCommonOverload = (overload: Overload): overload is CommonTypeOverload =>
	commonTypeFns.has(overload.fn)

const listedOp = (id: OpId, overload: Overload): NativeOp =>
	isCommonOverload(overload)
		? Object.freeze({ ...overload, partial: false, id: definedOp(id) })
		: Object.freeze({ ...overload, ...identified(id, overload.totality) })

/**
 * The binary coercion a cast node names where it drops only a refinement PostgreSQL never checks on the way (a
 * contract's base, a numeric typmod, a text refinement, a span width: types.ts wideningOf): defined everywhere.
 */
export const binaryCoercion: DefinedOp = definedOp(opId("coercion"))

/**
 * Where an overload an expression names is defined: everywhere, the binary coercion, every range-polymorphic operator
 * the IR holds (definedRangeOp) and a listed overload or cast whose Totality is total, exact or ieee; partially, a listed
 * one whose Totality requires preconditions, each of which its node's proof proves (ir/proof.ts OperationProof); or
 * unknown, an identity the registry does not hold.
 */
export const definedness = (
	op: OpId
):
	| { readonly kind: "everywhere" }
	| { readonly kind: "partial"; readonly preconditions: NonEmptyReadonlyArray<Precondition> }
	| { readonly kind: "unknown" } => {
	if (op === binaryCoercion) {
		return { kind: "everywhere" }
	}
	const native = nativeOp(op)
	if (native !== undefined) {
		return native.totality.kind === "requires"
			? { kind: "partial", preconditions: native.totality.preconditions }
			: { kind: "everywhere" }
	}
	return typeof op === "string" ? { kind: "unknown" } : { kind: "everywhere" }
}

/** An overload's identity where it is defined everywhere, for a caller that builds an expression with no proof. */
export const definedIdOf = (op: NativeOp): DefinedOp | undefined => (op.partial ? undefined : op.id)

/** The boolean connectives' identities, defined on every boolean. */
export const connectiveOps: { readonly [C in "and" | "or" | "not"]: DefinedOp } = Object.freeze({
	and: definedOp(opId("and")),
	or: definedOp(opId("or")),
	not: definedOp(opId("not"))
})

/**
 * A range-polymorphic operator or function at a range carrier, as an expression names it: every one the IR holds (the
 * comparisons, the Allen atoms' operators, the endpoints) is defined on every span.
 */
export const definedRangeOp = (code: RangeOpCode, carrier: SpanCarrier): DefinedOp =>
	definedOp(rangeOp(code, carrier))

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

const isCommonType = (op: NativeOp): op is CommonTypeOp => commonTypeFns.has(op.fn)

/**
 * Each function's overloads of a fixed result type, which their operand carriers tell apart: one per function and
 * carriers (test/pg/compute/registry.test.ts checks the table).
 */
const fixedByFn: ReadonlyMap<FixedFn, ReadonlyArray<FixedOp>> = Map.groupBy(
	nativeOps.flatMap((op) => (isCommonType(op) ? [] : [op])),
	(op) => op.fn
)

/** The overloads typed by their operands' common type, one per function and operand carrier. */
const commonByFn: ReadonlyMap<CommonTypeFn, ReadonlyArray<CommonTypeOp>> = Map.groupBy(
	nativeOps.filter(isCommonType),
	(op) => op.fn
)

/** The overload of `fn` over operands of `args`, or undefined. */
export const overloadOf = (
	fn: Exclude<FixedFn, "cast">,
	args: ReadonlyArray<Carrier>
): FixedOp | undefined => fixedByFn.get(fn)?.find((op) => admits(op.operands, args))

/** The overload of `fn` typed by its operands' common type over operands of `carrier`, or undefined. */
export const commonTypeOf = (fn: CommonTypeFn, carrier: Carrier): CommonTypeOp | undefined =>
	commonByFn.get(fn)?.find((op) => firstOperand(op.operands) === carrier)

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
