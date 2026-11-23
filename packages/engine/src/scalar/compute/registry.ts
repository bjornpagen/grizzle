import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { PreconditionKind } from "#compiler/core/errors.ts"
import { deepFreeze } from "#compiler/core/record.ts"
import type { ComputeFn } from "#compiler/ir/desc.ts"
import {
	type DefinedOp,
	canonicalZeroIds,
	definedOp,
	type ExprSpec,
	type OpId,
	OpId as opId,
	type PartialOp,
	partialOp,
	type RangeOpCode,
	rangeOp,
	type ScalarExpr,
	type Volatility
} from "#compiler/ir/expr.ts"
import type { LibraryFn } from "#compiler/ir/physical.ts"
import type { OperandIndex, ParseForm, Precondition } from "#compiler/ir/proof.ts"
import {
	type Carrier,
	carriers,
	floatCarrierOf,
	nativeNames,
	type SpanCarrier
} from "#compiler/ir/scalar.ts"
import type { TextQueryParser } from "#compiler/ir/search.ts"
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
import type { carrierSql } from "#compiler/scalar/registry.ts"

/**
 * Why a host computation has no value: the precondition of the operation its operands fail, or a numeric result past
 * numeric's format, which the lowering's digit bounds rule out (lower.ts) but over an operand bounded by nothing but
 * numeric's own limit, where it is PostgreSQL's 22003, numeric_value_out_of_range (scalar/values/fault.ts
 * resultDigits). The evaluator meets a precondition only on an expression no lowering admits.
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
 *   the digit bounds every numeric expression has (typing.ts), sign, char_length, octet_length, a bytes value's digest,
 *   span endpoints, widening casts;
 * - `exact`: integer or money arithmetic computed exactly: its value is an exact integer or exact money
 *   (ir/scalar.ts ExactType), never the overflowing native result, so the overload's catalog result is its PostgreSQL
 *   identity only, and SQL rendering computes it over its operands widened into the exact space
 *   (lower/conservative/expr/total.ts exactForm);
 * - `ieee`: float arithmetic as IEEE 754 defines it but for a quotient by zero: overflow is ±Infinity, underflow the
 *   correctly rounded subnormal or the one zero, and the square root of a negative is NaN; a quotient by zero is the
 *   infinity of the dividend's sign, NaN over a zero or NaN dividend, whichever zero divides, where IEEE 754 gives the
 *   infinity of the two signs' XOR, so 1 / -0 is Infinity. Equal operands give equal results, as every scalar
 *   operation's do (check/merge.ts): -0 = 0 under PostgreSQL's equality, a plan may read a divisor from either of two
 *   equal fields or take either zero where it merges, and the quotient is one value under every plan, where IEEE 754's
 *   would differ by an infinity's sign, which the canonical zero, erasing only a zero's sign, cannot. It is computed by
 *   SQL rendering without letting PostgreSQL raise (lower/conservative/expr/total.ts ieeeForm), and on the host by the
 *   same rule (evaluate.ts quotient);
 * - `requires`: defined where its preconditions hold, which the lowering proves at the node, or refuses the
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
const lexical = (form: ParseForm): Precondition => Object.freeze({ kind: "lexical", form })
const bounded: Precondition = Object.freeze({ kind: "bounded" })
const clock: Precondition = Object.freeze({ kind: "clock" })
const divisor: Totality = requires([nonzero(1)])
const narrowing: Totality = requires([fits])
const finiteNarrowing: Totality = requires([finite(0), fits])

/**
 * The infix operators an overload is spelled with: arithmetic, comparisons, bit's set algebra, text's || and ~, and the
 * network types' containment, <<=, << and &&.
 */
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
	| "<<="
	| "<<"
	| "&&"

/**
 * What a text search node reads of a document and a query (SqlForm textSearch): whether the document matches it, `@@`
 * (ts_match_vq), or its rank by ts_rank or ts_rank_cd, each in its two-argument form, PostgreSQL's default weights and
 * no normalization.
 */
export type TextSearchRead = "match" | "rank" | "rankCd"

/**
 * The catalogue that owns an operator or function: PostgreSQL's own, in pg_catalog, or the pgvector extension's, which
 * SQL qualifies by the installation's extension schema.
 */
type Owner = "catalog" | "vector"

/**
 * How the node is spelled in SQL. A set's difference, subset and disjointness are constructs of bit's own operators:
 * `a & ~b`, `bit_count(a & ~b) = 0` and `bit_count(a & b) = 0`; a set with one more handle is set_bit at a closed id's
 * code read as an integer, `set_bit(a, c::integer, 1)`; a text's suffix test is one of right, char_length and text's =,
 * `right(a, char_length(b)) = b`, since PostgreSQL has no ends_with, and its containment test strpos's position of b
 * in a past 0, `strpos(a, b) > 0` (textContains), no pattern; a double's parse is a reading of its text's digits
 * and exponent into a numeric rounded to a double (lower/conservative/expr/parse-double.ts); a decimal's parse is the
 * I/O conversion into numeric of no typmod, `x::numeric`, an op node of its own beside Type.cast's cast nodes; a text's UTF-16 code units
 * are its code points and its supplementary ones once more, `char_length(x) + regexp_count(x, '[\U00010000-\U0010FFFF]')`;
 * a text's ASCII case fold is lower under the C collation, collated back as every text is,
 * `lower(x COLLATE "C") COLLATE pg_c_utf8` (textLowerAscii); a reference's resolution against a base is a call of the
 * installation's own function of grizzle's library (ir/physical.ts LibraryFn), `<schema>.<fn>(base, reference)`
 * (textResolveReference), a text's digest among them, `<schema>.<textDigest>(x)` (textSha256); a part of a search document is its text parsed under the
 * document's configuration and labelled by its weight, `setweight(to_tsvector('<configuration>'::regconfig, x), w)`
 * (searchPart, lower/conservative/search); a date's epoch day is its days after 1970-01-01, `x - '1970-01-01'::date`,
 * and the date of an epoch day the epoch plus its days, `'1970-01-01'::date + n` (dateEpochDay, dateOfEpochDayFrom); a
 * zone's wall clock at an instant is a call of the installation's library function over the instant and the zone's
 * name, the name read from its roster's names constant by its closed id's code, `<schema>.<wall>(t, (names())[z + 1])`
 * (zoneWall, lower/conservative/expr/index.ts zoneCall); and a match or a rank of a document reads a query's text parsed under the
 * document's own configuration, `d @@ websearch_to_tsquery('<configuration>'::regconfig, q)` and
 * `ts_rank(d, plainto_tsquery(...))` (textSearch), the configuration read off the document's type.
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
				| "adjoin"
				| "endsWith"
				| "contains"
				| "parseDouble"
				| "parseDecimal"
				| "collapse"
				| "lowerAscii"
				| "utf16Length"
				| "epochDay"
				| "dateOfEpochDay"
	  }
	| { readonly kind: "floatBits"; readonly from: "float4" | "float8" }
	| { readonly kind: "library"; readonly fn: LibraryFn }
	| { readonly kind: "zoneLibrary"; readonly fn: LibraryFn }
	| { readonly kind: "searchPart" }
	| { readonly kind: "textSearch"; readonly read: TextSearchRead; readonly parser: TextQueryParser }
	| { readonly kind: "canonicalZero"; readonly carrier: "float4" | "float8" }

/**
 * The library function a node's SQL calls (ir/physical.ts LibraryFn), which its installation installs: a library
 * call's own, a zone's among them; none for any other form.
 */
export const libraryOf = (sql: SqlForm): LibraryFn | undefined =>
	sql.kind === "library" || sql.kind === "zoneLibrary" ? sql.fn : undefined

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
 * The scalar operation a native node serves (computeSpecs), the comparisons, the boolean constructs, the set algebra
 * over a roster, the text operations, a bytes value's digest and the casts; cond has no entry, it is the IR's cond node. The complement serves
 * only the difference and the subset test: it sets a set's hole and padding bits, so no scalar operation yields it;
 * right serves only the suffix test, endsWith; strpos only the containment test, contains; replace and btrim serve only the whiteSpace collapse, and regexp_count
 * only a text's UTF-16 code units, utf16Length; datePlus, date + integer, only the date of an epoch day,
 * dateOfEpochDay. canonicalZero serves no scalar operation
 * either: it is the canonical zero a set delivers wherever it may merge -0 and +0 (check/merge.ts).
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
	| "utf16Length"
	| "regexpCount"
	| "concat"
	| "startsWith"
	| "endsWith"
	| "right"
	| "contains"
	| "strpos"
	| "matches"
	| "translate"
	| "lowerAscii"
	| "collapse"
	| "resolveReference"
	| "isXsdPattern"
	| "replace"
	| "btrim"
	| "parseDouble"
	| "parseDecimal"
	| "sha256"
	| "floatBits"
	| "cosineDistance"
	| "searchPart"
	| "searchConcat"
	| "websearchMatches"
	| "plainMatches"
	| "websearchRank"
	| "plainRank"
	| "websearchRankCd"
	| "plainRankCd"
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
	| "adjoin"
	| "netWithin"
	| "netStrictlyWithin"
	| "netOverlaps"
	| "wall"
	| "epochDay"
	| "dateOfEpochDay"
	| "datePlus"
	| "cast"
	| "canonicalZero"

/**
 * How a native node meets a NULL operand, as PostgreSQL applies it: the one statement of it, which the host evaluator
 * applies (evaluate.ts operation) and every library function a node calls is declared by (physical/ddl/library.ts
 * strictOf), so the host and PostgreSQL meet a NULL alike. `strict`: NULL wherever an operand is NULL. `least` and
 * `greatest`: LEAST's and GREATEST's, over their operands that are no NULL, NULL where none is. `between`: BETWEEN's,
 * as `a >= low AND a <= high` by Kleene's logic. `in`: IN's, as the OR of its equalities by Kleene's logic. `node`:
 * AND's, OR's and a cast's, which their own nodes apply (evaluate.ts), never an operation's.
 */
export type NullRule = "strict" | "least" | "greatest" | "between" | "in" | "node"

/** Every native node's NULL rule, total over NativeFn, so a new node states how it meets a NULL where it is added. */
export const nullRules: { readonly [F in NativeFn]: NullRule } = Object.freeze({
	add: "strict",
	sub: "strict",
	mul: "strict",
	div: "strict",
	mod: "strict",
	neg: "strict",
	quot: "strict",
	rem: "strict",
	abs: "strict",
	sign: "strict",
	round: "strict",
	trunc: "strict",
	ceil: "strict",
	floor: "strict",
	gcd: "strict",
	lcm: "strict",
	power: "strict",
	sqrt: "strict",
	least: "least",
	greatest: "greatest",
	widthBucket: "strict",
	minScale: "strict",
	lower: "strict",
	upper: "strict",
	charLength: "strict",
	octetLength: "strict",
	utf16Length: "strict",
	regexpCount: "strict",
	concat: "strict",
	startsWith: "strict",
	endsWith: "strict",
	right: "strict",
	contains: "strict",
	strpos: "strict",
	matches: "strict",
	translate: "strict",
	lowerAscii: "strict",
	collapse: "strict",
	resolveReference: "strict",
	isXsdPattern: "strict",
	replace: "strict",
	btrim: "strict",
	parseDouble: "strict",
	parseDecimal: "strict",
	sha256: "strict",
	floatBits: "strict",
	cosineDistance: "strict",
	searchPart: "strict",
	searchConcat: "strict",
	websearchMatches: "strict",
	plainMatches: "strict",
	websearchRank: "strict",
	plainRank: "strict",
	websearchRankCd: "strict",
	plainRankCd: "strict",
	eq: "strict",
	ne: "strict",
	lt: "strict",
	le: "strict",
	gt: "strict",
	ge: "strict",
	between: "between",
	in: "in",
	and: "node",
	or: "node",
	not: "strict",
	union: "strict",
	intersection: "strict",
	difference: "strict",
	complement: "strict",
	cardinality: "strict",
	subset: "strict",
	disjoint: "strict",
	adjoin: "strict",
	netWithin: "strict",
	netStrictlyWithin: "strict",
	netOverlaps: "strict",
	wall: "strict",
	epochDay: "strict",
	dateOfEpochDay: "strict",
	datePlus: "strict",
	cast: "node",
	canonicalZero: "strict"
})

/**
 * What a scalar function is, one record each (computeSpecs): how many arguments it takes, a count or any number of
 * one or more (least and greatest); whether a contract predicate or a row check admits it, which is whether the host
 * evaluates its nodes for the ContractLiteral check (evaluate.ts), beside comparisons, boolean composition,
 * Logic.cond, Logic.when and casts; and the nodes it lowers to (typing.ts), the node of its own name or the nodes it
 * composes: Num.numeric is a cast into numeric, Range.width a span's upper endpoint less its lower,
 * Bits.singleton a set with one more handle over the empty set.
 */
export interface ComputeSpec {
	readonly arity: number | "variadic"
	readonly check: boolean
	readonly nodes: NonEmptyReadonlyArray<NativeFn>
}

/** Every scalar function's spec, total over ComputeFn, so a new function states each fact where it is added. */
export const computeSpecs: { readonly [F in ComputeFn]: ComputeSpec } = deepFreeze({
	add: { arity: 2, check: true, nodes: ["add"] },
	sub: { arity: 2, check: true, nodes: ["sub"] },
	mul: { arity: 2, check: true, nodes: ["mul"] },
	div: { arity: 2, check: true, nodes: ["div"] },
	mod: { arity: 2, check: true, nodes: ["mod"] },
	neg: { arity: 1, check: true, nodes: ["neg"] },
	quot: { arity: 2, check: false, nodes: ["quot"] },
	rem: { arity: 2, check: false, nodes: ["rem"] },
	abs: { arity: 1, check: true, nodes: ["abs"] },
	sign: { arity: 1, check: true, nodes: ["sign"] },
	round: { arity: 1, check: false, nodes: ["round"] },
	trunc: { arity: 1, check: false, nodes: ["trunc"] },
	ceil: { arity: 1, check: false, nodes: ["ceil"] },
	floor: { arity: 1, check: false, nodes: ["floor"] },
	gcd: { arity: 2, check: false, nodes: ["gcd"] },
	lcm: { arity: 2, check: false, nodes: ["lcm"] },
	power: { arity: 2, check: false, nodes: ["power"] },
	sqrt: { arity: 1, check: false, nodes: ["sqrt"] },
	least: { arity: "variadic", check: true, nodes: ["least"] },
	greatest: { arity: "variadic", check: true, nodes: ["greatest"] },
	widthBucket: { arity: 4, check: false, nodes: ["widthBucket"] },
	minScale: { arity: 1, check: false, nodes: ["minScale"] },
	numeric: { arity: 1, check: false, nodes: ["cast"] },
	lower: { arity: 1, check: true, nodes: ["lower"] },
	upper: { arity: 1, check: true, nodes: ["upper"] },
	width: { arity: 1, check: true, nodes: ["upper", "lower", "sub"] },
	charLength: { arity: 1, check: true, nodes: ["charLength"] },
	octetLength: { arity: 1, check: true, nodes: ["octetLength"] },
	utf16Length: { arity: 1, check: true, nodes: ["utf16Length"] },
	concat: { arity: 2, check: true, nodes: ["concat"] },
	startsWith: { arity: 2, check: true, nodes: ["startsWith"] },
	endsWith: { arity: 2, check: true, nodes: ["endsWith"] },
	contains: { arity: 2, check: true, nodes: ["contains"] },
	matches: { arity: 2, check: true, nodes: ["matches"] },
	translate: { arity: 3, check: true, nodes: ["translate"] },
	lowerAscii: { arity: 1, check: true, nodes: ["lowerAscii"] },
	collapse: { arity: 1, check: true, nodes: ["collapse"] },
	resolveReference: { arity: 2, check: true, nodes: ["resolveReference"] },
	isXsdPattern: { arity: 1, check: true, nodes: ["isXsdPattern"] },
	parseDouble: { arity: 1, check: true, nodes: ["parseDouble"] },
	parseDecimal: { arity: 1, check: true, nodes: ["parseDecimal"] },
	sha256: { arity: 1, check: true, nodes: ["sha256"] },
	floatBits: { arity: 1, check: true, nodes: ["floatBits"] },
	cosineDistance: { arity: 2, check: false, nodes: ["cosineDistance"] },
	textDocument: { arity: "variadic", check: true, nodes: ["searchPart", "searchConcat"] },
	websearchMatches: { arity: 2, check: false, nodes: ["websearchMatches"] },
	plainMatches: { arity: 2, check: false, nodes: ["plainMatches"] },
	websearchRank: { arity: 2, check: false, nodes: ["websearchRank"] },
	plainRank: { arity: 2, check: false, nodes: ["plainRank"] },
	websearchRankCd: { arity: 2, check: false, nodes: ["websearchRankCd"] },
	plainRankCd: { arity: 2, check: false, nodes: ["plainRankCd"] },
	union: { arity: 2, check: true, nodes: ["union"] },
	intersection: { arity: 2, check: true, nodes: ["intersection"] },
	difference: { arity: 2, check: true, nodes: ["difference"] },
	cardinality: { arity: 1, check: true, nodes: ["cardinality"] },
	subset: { arity: 2, check: true, nodes: ["subset"] },
	disjoint: { arity: 2, check: true, nodes: ["disjoint"] },
	singleton: { arity: 1, check: true, nodes: ["adjoin"] },
	netWithin: { arity: 2, check: true, nodes: ["netWithin"] },
	netStrictlyWithin: { arity: 2, check: true, nodes: ["netStrictlyWithin"] },
	netOverlaps: { arity: 2, check: true, nodes: ["netOverlaps"] },
	wall: { arity: 2, check: false, nodes: ["wall"] },
	epochDay: { arity: 1, check: true, nodes: ["epochDay"] },
	dateOfEpochDay: { arity: 1, check: true, nodes: ["dateOfEpochDay"] }
})

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
 * the scalar result its Totality's.
 */
interface FixedOverload extends OverloadBase {
	readonly fn: FixedFn
	readonly result: OverloadResult
}

/**
 * A fixed result: a registered result carrier; text, which the lowering types as text of no pattern; or a search
 * document, which the typing types by the configuration it is parsed under (typing.ts textDocument).
 */
type OverloadResult = ResultCarrier | "text" | "tsvector"

/**
 * An operation whose result is a value of its first operand's type, which no fixed result carrier holds: LEAST and
 * GREATEST over any number, of their operands' common type, and a set's union, intersection, difference and complement,
 * and a set with one more handle (adjoin), each a set over its first operand's roster.
 */
interface CommonTypeOverload extends OverloadBase {
	readonly fn: CommonTypeFn
	readonly result: Carrier
	/** Every one is defined on every value of its operands, so none stands beside a proof. */
	readonly totality: Exclude<Totality, { readonly kind: "requires" }>
}

/** One overload of the table: everything about it but its identity, the key the table lists it under. */
type Overload = FixedOverload | CommonTypeOverload

/** The scalar operations whose result is a value of their first operand's type. */
export type CommonTypeFn =
	| "least"
	| "greatest"
	| "union"
	| "intersection"
	| "difference"
	| "complement"
	| "adjoin"

/** The scalar operations with a fixed result type. */
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
 * PostgreSQL's regtype spelling of a carrier in pg_operator and pg_proc: its type's own name (ir/scalar.ts nativeNames),
 * a closed id's smallint's, its code's, a cidr's inet's, whose operators and functions a cidr reads through its binary
 * coercion to inet, and a range's anyrange, since range operators are polymorphic.
 */
export const catalogTypeName = {
	...nativeNames,
	cidr: "inet",
	range4: "anyrange",
	range8: "anyrange",
	rangeDate: "anyrange"
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

/** The network carriers, inet and cidr, which every containment operator takes on either side. */
type NetOperand = "inet" | "cidr"

/**
 * A network containment test, pg_catalog's operator over two inets at its operands' carriers: an inet or a cidr on
 * either side, a cidr read through its binary coercion to inet, so an address is tested against a network as it is
 * stored. Each is false across the address families (network.c network_sub, network_subeq, network_overlap), so it is
 * defined on every pair of values.
 */
const netContainment = (
	fn: "netWithin" | "netStrictlyWithin" | "netOverlaps",
	op: "<<=" | "<<" | "&&",
	left: NetOperand,
	right: NetOperand
): FixedOverload =>
	frozen({
		fn,
		operands: positional([left, right]),
		result: "bool",
		sql: { kind: "infix", op, owner: "catalog" },
		catalog: {
			kind: "operator",
			name: op,
			operands: { kind: "infix", left: catalogTypeName[left], right: catalogTypeName[right] },
			result: "boolean",
			owner: "catalog"
		},
		volatility: "immutable",
		totality: total,
		reads: "value"
	})

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

/**
 * A float's canonical zero: the value itself, its -0 written +0, `x + 0::type`, IEEE 754's sum, exact for every value
 * (NaN and the infinities their own) and never past the type's range; what a set delivers of a float wherever it may
 * take one of the two zeros for the other (check/merge.ts). Equal values give one result, so it maps distinct values
 * to distinct values under PostgreSQL's equality (ir/injective.ts comparedValue).
 */
const canonicalZero = (carrier: "float4" | "float8"): FixedOverload =>
	frozen({
		fn: "canonicalZero",
		operands: positional([carrier]),
		result: carrier,
		sql: { kind: "canonicalZero", carrier },
		catalog: {
			kind: "construct",
			uses: Object.freeze([opId(carrier === "float4" ? "float4pl" : "float8pl")])
		},
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
 * A set with one more handle, `set_bit(a, c::integer, 1)` at a closed id's code c: a set over the operands' roster, bit
 * c from the left code c's, as a set's literal writes it (ir/codes.ts handlesHex). c is a live code, below the set's
 * width, so set_bit never reads past its string, and a's holes and padding stay clear; a NULL operand gives NULL, as
 * set_bit is strict. Bits.singleton is it over the empty set.
 */
const setAdjoin: CommonTypeOverload = frozen({
	fn: "adjoin",
	operands: positional(["bits", "code"]),
	result: "bits",
	sql: { kind: "adjoin" },
	catalog: {
		kind: "function",
		name: "set_bit",
		args: ["bit", "integer", "integer"],
		result: "bit",
		owner: "catalog"
	},
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
 * A text's containment test, Text.contains wherever it stands (compute/typing.ts), `strpos(a, b) > 0`: strpos's
 * 1-based position of the first b in a, 0 where a holds none. No pattern: b is read as its characters, so no character
 * of it, `%`, `_` and `\` among them, is escaped or special. The empty b is at position 1 of every a, the empty one
 * included, and a b of more bytes than a is in none. Every text is collated pg_c_utf8, a deterministic collation, in a
 * UTF8 database, so the search is of b's bytes in a's, which in UTF-8 match only at a character's start, and the test
 * is whether b's characters stand together in a, on every pair of texts. strpos allocates nothing past its operands,
 * so the test is defined on every pair of texts, in a query, a CHECK and a generated field alike; it reads no index,
 * and no access reads it (physical/access/atoms.ts), so a query filters by it.
 *
 * @derivation strpos is "proname => 'strpos', prorettype => 'int4', proargtypes => 'text text', prosrc => 'textpos'"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_proc.dat#L3719-L3720), whose body is
 *   "PG_RETURN_INT32((int32) text_position(str, search_str, PG_GET_COLLATION()));"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/varlena.c#L898). text_position states
 *   "/* Empty needle always matches at position 1 *\/ if (VARSIZE_ANY_EXHDR(t2) < 1) return 1;" and "/* Otherwise,
 *   can't match if haystack is shorter than needle *\/ if (VARSIZE_ANY_EXHDR(t1) < VARSIZE_ANY_EXHDR(t2) &&
 *   pg_newlocale_from_collation(collid)->deterministic) return 0;"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/varlena.c#L923-L930), and its search
 *   "using the raw byte sequence, ignoring multibyte issues. For UTF-8, that works fine, because in UTF-8 the byte
 *   sequence of one character cannot contain another character", "else if (GetDatabaseEncoding() == PG_UTF8)
 *   state->is_multibyte_char_in_char = false;"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/varlena.c#L980-L991).
 * @verified 2026-11-21
 */
const textContains: FixedOverload = frozen({
	fn: "contains",
	operands: positional(["text", "text"]),
	result: "bool",
	sql: { kind: "contains" },
	catalog: {
		kind: "construct",
		uses: Object.freeze([opId("strpos(text,text)"), opId("int4gt")])
	},
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * whiteSpace collapse: each run of white space one space, then the spaces at either end trimmed, by replace alone
 * (lower/conservative/expr/ops.ts collapseText): tab, LF and CR each a space; then each pair of spaces a space and a
 * tab, each tab before a space two tabs, and every tab deleted, which leaves one space of each run, since the first
 * step left no tab of the text's own; then btrim. replace never lengthens a text here and allocates nothing past its
 * operand's bytes, so the collapse is defined on every text, in a query as in a check. Both functions are IMMUTABLE
 * and compare bytes under pg_c_utf8, a deterministic collation, so it is one value wherever it stands, a generated
 * column among them.
 */
const textCollapse: FixedOverload = frozen({
	fn: "collapse",
	operands: positional(["text"]),
	result: "text",
	sql: { kind: "collapse" },
	catalog: {
		kind: "construct",
		uses: Object.freeze([opId("replace(text,text,text)"), opId("btrim(text)")])
	},
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * A text's ASCII case fold, Text.lowerAscii wherever it stands (compute/typing.ts lowerAscii): lower under the C
 * collation, collated back as every text is, `lower(x COLLATE "C") COLLATE pg_c_utf8` (sql/ast.ts Expr's lowerAscii).
 * The C collation's ctype is C, so lower folds the text byte by byte, each of A to Z to its small letter and every
 * other byte as it is; every byte of a UTF-8 character past ASCII, a lead byte or a continuation byte, is 0x80 or more,
 * and a text holds no NUL, at which the fold would stop, so the fold is translate's by the ASCII capitals and their
 * small letters on every text. It allocates its operand's own length and its header, within MaxAllocSize for every
 * text, where translate allocates four bytes for each byte (compute/typing.ts translateMaxBytes), so it is defined on
 * every text, in a query, a CHECK and a generated field alike. lower's result takes the explicit collation of its
 * operand, "C", which would compare it in C's order, keep a pg_c_utf8 index from serving an equation with it and read
 * its regex classes as C's; the outer COLLATE gives it pg_c_utf8, every text's. lower(text) is IMMUTABLE in pg_proc and
 * a COLLATE calls nothing, so it is one value wherever it stands, a generated column among them.
 *
 * @derivation lower folds by its call's collation: "out_string = str_tolower(VARDATA_ANY(in_string),
 *   VARSIZE_ANY_EXHDR(in_string), PG_GET_COLLATION());" then "result = cstring_to_text(out_string);"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/oracle_compat.c#L55-L58). The collation
 *   "C" is "{ oid => '950', oid_symbol => 'C_COLLATION_OID'" with "collname => 'C'"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_collation.dat#L18-L21), whose locale
 *   is "if (collid == C_COLLATION_OID) return &c_locale;"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/pg_locale.c#L1207-L1208), which states
 *   ".ctype_is_c = true,"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/pg_locale.c#L115). So str_tolower
 *   takes "if (mylocale->ctype_is_c)", "result = asc_tolower(buff, nbytes);"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/formatting.c#L1645-L1647), whatever the
 *   database's encoding, and asc_tolower is "result = pnstrdup(buff, nbytes);" then "for (char *p = result; *p; p++)
 *   *p = pg_ascii_tolower((unsigned char) *p);"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/formatting.c#L1889-L1892), whose fold
 *   is "if (ch >= 'A' && ch <= 'Z') ch += 'a' - 'A';"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/port.h#L191-L192). A UTF-8 text's verification
 *   stops at a NUL, "if (*s == '\0') break;"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/common/wchar.c#L1758-L1759), so the loop reads every
 *   byte. Its two allocations are linear in the operand's len bytes: pnstrdup's "out = palloc(len + 1);"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/mmgr/mcxt.c#L1934) and
 *   cstring_to_text_with_len's "palloc(len + VARHDRSZ)"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/varlena.c#L198), each within
 *   MaxAllocSize, since a text's bytes and its header are.
 * @verified 2026-11-20
 */
const textLowerAscii: FixedOverload = frozen({
	fn: "lowerAscii",
	operands: positional(["text"]),
	result: "text",
	sql: { kind: "lowerAscii" },
	catalog: { kind: "function", name: "lower", args: ["text"], result: "text", owner: "catalog" },
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * A reference's target resolved against a base, RFC 3986 §5.2's strict transformation and §5.3's recomposition, as
 * @bjornpagen/grizzle-text's uri.ts resolveReference computes it on the host, Text.resolveReference wherever it
 * stands (compute/typing.ts resolveReference): a call of the installation's library function
 * (physical/ddl/library.ts), `<schema>.<fn>(base, reference)`, an IMMUTABLE, STRICT, PARALLEL SAFE SQL function of the
 * reference's and the base's components and the target path's segments, which no RegExp reads, so no operand's
 * length is bounded and it is defined on every pair of texts, in a query, a CHECK and a generated field alike, its
 * result within their bytes and the delimiters it adds. It reads no catalog object a scalar operation is, so it uses
 * no entry here.
 */
const textResolveReference: FixedOverload = frozen({
	fn: "resolveReference",
	operands: positional(["text", "text"]),
	result: "text",
	sql: { kind: "library", fn: "resolveReference" },
	catalog: { kind: "construct", uses: [] },
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * Whether a text is a string of XML Schema 1.0's regExp production (Part 2, Appendix F), as @bjornpagen/grizzle-text's
 * regex/xsd.ts reader reads it on the host, Xml.isPattern wherever it stands (compute/typing.ts isXsdPattern): a
 * call of the installation's library function (physical/ddl/library.ts xsdPatternDefinition), `<schema>.<fn>(x)`, an
 * IMMUTABLE, STRICT, PARALLEL SAFE SQL function whose recursive query reads the text's characters once each by a table
 * of the reader's moves, with no state budget and no bound on a count, so it is defined on every text, in a query, a
 * CHECK and a generated field alike. It reads no catalog object a scalar operation is, so it uses no entry here.
 */
const textIsXsdPattern: FixedOverload = frozen({
	fn: "isXsdPattern",
	operands: positional(["text"]),
	result: "bool",
	sql: { kind: "library", fn: "isXsdPattern" },
	catalog: { kind: "construct", uses: [] },
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * A text's UTF-16 code units, JavaScript's String.length: one for each code point, and one more for each supplementary
 * one, which UTF-16 writes as a surrogate pair, `char_length(x) + regexp_count(x, '[\U00010000-\U0010FFFF]')`
 * (lower/conservative/expr/ops.ts utf16Units). A text holds at most MaxAllocSize bytes, so at most that many code points
 * and a quarter as many supplementary ones, and the sum stays within integer. regexp_count widens its subject to one
 * pg_wchar for every byte before it matches, so it is defined where the text is within regexTextMaxBytes (`bounded`),
 * which the lowering proves from the operand's byte bound, its type's or a guard's. Both functions are IMMUTABLE in
 * pg_proc, so it is one value wherever it stands, a generated column among them.
 */
const textUtf16Length: FixedOverload = frozen({
	fn: "utf16Length",
	operands: positional(["text"]),
	result: "int4",
	sql: { kind: "utf16Length" },
	catalog: {
		kind: "construct",
		uses: Object.freeze([
			opId("char_length(text)"),
			opId("regexp_count(text,text)"),
			opId("int4pl")
		])
	},
	volatility: "immutable",
	totality: requires([bounded]),
	reads: "value"
})

/**
 * A double's parse from its decimal text (scalar/lexical.ts doubleOfText), IEEE 754-2019's conversion from decimal
 * character sequences, defined where the text is one ("lexical" over `doubleText`), which the lowering proves by
 * language inclusion: its digits and exponent read by ltrim, rtrim, split_part, replace, left, char_length and
 * starts_with, the numeric they name with its significant digits cut to a sticky last one and its exponent clamped
 * where neither changes its double, rounded once (lower/conservative/expr/parse-double.ts). Every function it reads is
 * IMMUTABLE in pg_proc, so it is one value wherever it stands, a generated column among them; none is a scalar
 * operation, so it uses no entry here.
 */
const textParseDouble: FixedOverload = frozen({
	fn: "parseDouble",
	operands: positional(["text"]),
	result: "float8",
	sql: { kind: "parseDouble" },
	catalog: { kind: "construct", uses: [] },
	volatility: "immutable",
	totality: requires([lexical("doubleText")]),
	reads: "value"
})

/**
 * A decimal's parse from its text (scalar/lexical.ts decimalOfText), xs:decimal's lexical mapping into numeric of no
 * typmod, exactly, defined where the text is one within decimalTextMaxBytes ("lexical" over `decimalText`), which the
 * lowering proves by language inclusion and the operand's byte bound: `x::numeric`, numeric_in over textout's text, an
 * I/O conversion (CoerceViaIO) as Type.cast's parse is, IMMUTABLE, so it is one value wherever it stands, a
 * generated column among them. Every member names a value numeric holds, its digits past the point at most
 * NUMERIC_DSCALE_MAX, so numeric_in neither rounds nor raises.
 */
const textParseDecimal: FixedOverload = frozen({
	fn: "parseDecimal",
	operands: positional(["text"]),
	result: "numeric",
	sql: { kind: "parseDecimal" },
	catalog: { kind: "input", target: catalogTypeName.numeric },
	volatility: "immutable",
	totality: requires([lexical("decimalText")]),
	reads: "value"
})

/**
 * A bytes value's SHA-256 digest, its 32 bytes, PostgreSQL's `sha256(x)`, the one operation that reads a bytes value,
 * read whole: sha256(bytea) reads a bytea of any length and returns its digest, so it is defined on every value, and it
 * is IMMUTABLE in pg_proc, so it is one value wherever it stands, a generated column among them. Its result is a digest
 * (ir/scalar.ts DigestType), bytea of exactly 32 bytes, which the digest domain admits.
 */
const bytesDigest: FixedOverload = frozen({
	fn: "sha256",
	operands: positional(["bytes"]),
	result: "sha256",
	sql: { kind: "function", name: "sha256", owner: "catalog" },
	catalog: { kind: "function", name: "sha256", args: ["bytea"], result: "bytea", owner: "catalog" },
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * A float's identity image: float8send's 8 bytes, the bits of its IEEE 754 binary64 encoding most significant first,
 * read as a signed bigint, a real widened exactly to double precision first, NaN's in one form (float.ts
 * canonicalNanBits), as Java's doubleToLongBits reads them: `CASE WHEN x = 'NaN' THEN <NaN's bits> ELSE ('x' ||
 * encode(float8send(x), 'hex'))::bit(64)::bigint END` (lower/conservative/expr/ops.ts floatBitsForm). Two floats have
 * one image exactly when they are one value: -0 and 0 differ, every NaN is one, and each infinity and subnormal is its
 * own, where `=` holds -0 equal to 0; so a key over the image holds both zeros, and a read by `=` on the float finds
 * either. Every function it reads is IMMUTABLE and defined on every float, and the text-to-bit(64) input reads exactly
 * the hex digits float8send's bytes write, so the image stands in a generated column, a check and a query.
 */
const floatBitsOf = (carrier: "float4" | "float8"): FixedOverload =>
	frozen({
		fn: "floatBits",
		operands: positional([carrier]),
		result: "int8",
		sql: { kind: "floatBits", from: carrier },
		catalog: { kind: "construct", uses: [] },
		volatility: "immutable",
		totality: total,
		reads: "value"
	})

/**
 * A text's SHA-256 digest, the digest of its UTF-8 bytes, as Crypto.sha256 reads a bytes value's: a call of the
 * installation's library function (physical/ddl/library.ts textDigest, `sha256(convert_to(x, 'UTF8'))`),
 * `<schema>.<textDigest>(x)`, IMMUTABLE, STRICT and defined on every text, so it stands in a query, a CHECK and a
 * generated field alike, and a generated field of it is a digest a key may be declared over (README "Keys and
 * indexes"). It reads no catalog object a scalar operation is, so it uses no entry here.
 */
const textSha256: FixedOverload = frozen({
	fn: "sha256",
	operands: positional(["text"]),
	result: "sha256",
	sql: { kind: "library", fn: "textDigest" },
	catalog: { kind: "construct", uses: [] },
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * A date's epoch day, Time.epochDay wherever it stands (compute/typing.ts epochDay): its days after 1970-01-01, the
 * epoch of PostgreSQL's date arithmetic as of Unix time, `x - '1970-01-01'::date`, date_mi's integer count of days,
 * negative before the epoch. A date grizzle holds is from 0001-01-01 to 9999-12-31 (ir/date.ts), so its epoch day lies
 * in epochDayRange and no subtraction overflows: it is defined on every date, and date_mi is IMMUTABLE in pg_proc, so it
 * stands in a query, a CHECK and a generated field alike. The host computes it by the same day count
 * (scalar/compute/evaluate.ts, ir/date.ts dayNumber).
 */
const dateEpochDay: FixedOverload = frozen({
	fn: "epochDay",
	operands: positional(["date"]),
	result: "int4",
	sql: { kind: "epochDay" },
	catalog: { kind: "construct", uses: Object.freeze([opId("date_mi")]) },
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * The date of an epoch day, Time.dateOfEpochDay wherever it stands (compute/typing.ts dateOfEpochDay): 1970-01-01 plus
 * its days, `'1970-01-01'::date + n`, date_pli over an integer, a bigint read as one (`n::integer`). It is defined where
 * the day is one of a date grizzle holds, 0001-01-01 to 9999-12-31 (`fits`, its result type's epochDayRange,
 * compute/lower.ts fitRange), which the lowering proves from the operand's bounds or a Num.within guard, so the
 * date is one of grizzle's and the cast to integer never overflows. Both are IMMUTABLE in pg_proc, so it stands in a
 * query, a CHECK and a generated field alike.
 */
const dateOfEpochDayFrom = (carrier: "int4" | "int8"): FixedOverload =>
	frozen({
		fn: "dateOfEpochDay",
		operands: positional([carrier]),
		result: "date",
		sql: { kind: "dateOfEpochDay" },
		catalog: { kind: "construct", uses: Object.freeze([opId("date_pli")]) },
		volatility: "immutable",
		totality: narrowing,
		reads: "value"
	})

/**
 * date + integer, a date the integer's days after another (date_pli), which only the date of an epoch day reads
 * (dateOfEpochDayFrom, `'1970-01-01'::date + n`), since grizzle admits no date arithmetic: an entry of its own, so the
 * catalog's operator, its result type and its volatility are the registry's to state and its catalog check's to hold.
 * PostgreSQL refuses a date past its range ("date out of range"), so it is defined where the result fits, as the
 * construct that reads it is.
 */
const datePlus: FixedOverload = frozen({
	fn: "datePlus",
	operands: positional(["date", "int4"]),
	result: "date",
	sql: { kind: "infix", op: "+", owner: "catalog" },
	catalog: {
		kind: "operator",
		name: "+",
		operands: { kind: "infix", left: "date", right: "integer" },
		result: "date",
		owner: "catalog"
	},
	volatility: "immutable",
	totality: narrowing,
	reads: "value"
})

/**
 * A zone's wall clock at an instant, Time.wall in a query (compute/typing.ts wall): the instant's milliseconds since
 * the Unix epoch, as PostgreSQL's tzdata reads the zone, counted as milliseconds since the local epoch, by a call of the
 * installation's library function `wall` (physical/ddl/library.ts wallDefinition) over the instant and the zone's
 * IANA name, the handle its closed id's code names in its roster's names constant (lower/conservative/expr/index.ts
 * zoneCall), a zone roster's (closed.zones), whose every handle the migration that installs it finds among the
 * server's time zones. It is defined where the instant lies in timestamptz's range (`clock`), which the lowering proves
 * from its bounds: a millis reading of the database's clock is one. timezone(text, timestamptz) and every function the
 * library function reads are IMMUTABLE in pg_proc, but the host holds no tzdata, so it never evaluates the zone: the
 * term stands in a query alone (computeSpecs `check`), as a declared function's call does.
 */
const zoneWall: FixedOverload = frozen({
	fn: "wall",
	operands: positional(["int8", "code"]),
	result: "int8",
	sql: { kind: "zoneLibrary", fn: "wall" },
	catalog: { kind: "construct", uses: [] },
	volatility: "immutable",
	totality: requires([clock]),
	reads: "value"
})

/**
 * A part of a search document: its text parsed under the document's configuration, each position labelled by its
 * weight, `setweight(pg_catalog.to_tsvector('pg_catalog.<configuration>'::regconfig, x), '<w>'::"char")`
 * (lower/conservative/search), the configuration the node's type states and the weight its second operand, a literal
 * of a weight label (typing.ts textDocument). to_tsvector(regconfig, text) and setweight(tsvector, "char") are IMMUTABLE
 * in pg_proc, and a configuration's name is read into its oid where the statement is parsed, so the part stands in a
 * generated column, the one place a document is made. A document of more than 1,048,575 bytes of lexemes and positions
 * (MAXSTRPOS) is refused by PostgreSQL as it is made (54000), which refuses the row's write, as a translation's past its
 * own bound does; no read makes one.
 */
const searchPart: FixedOverload = frozen({
	fn: "searchPart",
	operands: positional(["text", "text"]),
	result: "tsvector",
	sql: { kind: "searchPart" },
	catalog: { kind: "construct", uses: [] },
	volatility: "immutable",
	totality: total,
	reads: "value"
})

/**
 * A match or a rank of a search document against a query's text, which websearch_to_tsquery or plainto_tsquery parses
 * under the document's own configuration (SqlForm textSearch): `d @@ q`, ts_rank(d, q) or ts_rank_cd(d, q), each a
 * real but the match. Every function it reads is IMMUTABLE in pg_proc and raises on no document; a query's text is read
 * within textQueryMaxBytes (typing.ts textQuery), within which no query PostgreSQL parses raises either.
 */
const textSearchOf = (
	fn:
		| "websearchMatches"
		| "plainMatches"
		| "websearchRank"
		| "plainRank"
		| "websearchRankCd"
		| "plainRankCd",
	read: TextSearchRead,
	parser: TextQueryParser
): FixedOverload =>
	frozen({
		fn,
		operands: positional(["tsvector", "text"]),
		result: read === "match" ? "bool" : "float4",
		sql: { kind: "textSearch", read, parser },
		catalog: { kind: "construct", uses: [] },
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
const endpoint = (
	fn: "lower" | "upper",
	range: SpanCarrier,
	point: IntCarrier | "date"
): FixedOverload =>
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
 * The static overload registry of the scalar catalogue, one entry per OpId: a table keyed by the identity the IR
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
 * - a closed id's operator: smallint's, its code's, prefixed "code:", as "code:int2eq"; a cidr's comparison, inet's
 *   read through cidr's binary coercion, prefixed "cidr:", as "cidr:network_eq"; a digest's comparison, bytea's over
 *   its 32 bytes, prefixed "sha256:", as "sha256:byteaeq"; and a network containment over an inet and a cidr, or two
 *   cidrs, prefixed by its operands' carriers, as "inet,cidr:network_subeq";
 * - a construct: "between:<type>", "in:<type>", "least:<type>", "greatest:<type>", "and", "or", "not", a set's
 *   "difference:bits", "subset:bits" and "disjoint:bits", a text's "endsWith:text", "contains:text" and its ASCII
 *   case fold's "lowerAscii:text", a reference's resolution "resolveReference:text", a pattern's test
 *   "isXsdPattern:text", and a float's identity image "floatBits:float8" and "floatBits:float4";
 * - a range-polymorphic operator or function, one catalog object for both range carriers: its code and the carrier
 *   (ir/expr.ts rangeOp), listed by both in spanOverloads;
 * - a cast: "cast:<source>-><target>" over its carriers, as castOverloads lists it.
 *
 * What the registry admits is the catalogue, not the catalog: same-type operands only, because the scalar operations
 * take two terms of one type, but right(text, integer), which only the suffix test reads, strpos(text, text), which only
 * the containment test reads, date + integer, which only the date of an epoch day reads, and set_bit over a set and a closed id's code, which only Bits.singleton reads; of text's
 * functions only its length, concatenation, prefix, suffix and containment tests, regex match, translate and lower
 * under the C collation, no array
 * function, of bit's only the set algebra over a roster, and of bytea's only its SHA-256 digest; no money * money,
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
 * - numeric arithmetic, rounding, ceiling, floor, trunc, gcd and lcm are total: a numeric(p, s) field declares its
 *   precision and every computed numeric carries the bound its making proved, a making past numericMaxIntegerDigits
 *   being ResourceBound where the value is made, so none reaches numeric's limit; but over an operand bounded by
 *   nothing but that limit, pg.numeric's, whose result PostgreSQL holds to it, refusing one past it with 22003
 *   (scalar/values/fault.ts resultDigits);
 * - a divisor (/, %, div, mod over numeric, the exact integers, the integers' %, money / money) is `nonzero`; numeric
 *   sqrt's radicand `nonnegative`; min_scale's operand `finite`; power its base's sign, `powerDomain`, then its
 *   result's range, `powerRange`; width_bucket its operand and bounds `finite`, facts their types state as min_scale's
 *   operand's are, then its `bucketDomain`;
 * - money / money is double precision;
 * - comparisons: every carrier with equality has = and <>, and every one a scalar call compares, all but bytea, IN,
 *   composed of its =; every ordered carrier the four orderings;
 * - a set over a roster's union (bitor), intersection (bitand) and cardinality (bit_count(bit)), its difference, subset
 *   and disjointness composed of them, and a set with one more handle (set_bit(bit,integer,integer) at a live code),
 *   all total; bitnot only inside those, since it sets the hole and padding bits;
 * - text length in code points (char_length) and in UTF-8 bytes (octet_length), concatenation (textcat), and the
 *   prefix and suffix tests (starts_with, and right, char_length and = composed), each for checks only; the
 *   containment test (strpos and > composed), everywhere; and the regex match (textregexeq), whose pattern operand's every value was
 *   admitted inside PostgreSQL's regex compile space where the node was typed (compute/typing.ts), everywhere. textcat
 *   allocates its result, which past PostgreSQL's MaxAllocSize raises "invalid memory alloc request size": no query
 *   holds it, an equation with a concatenation lowering without it (compute/typing.ts concatEquation), and a check or
 *   generated column holding it fails a write whose texts would pass 1 GB;
 * - translate(text, text, text), whose map lowering admits of from and to literals of one length, each character of
 *   from once (scalar/regex/translate.ts charMapOf): it allocates four bytes per byte of its operand, and past
 *   MaxAllocSize raises "requested length too large", so a query holds it only over an operand whose pattern bounds its
 *   bytes within translateMaxBytes, and a check or generated column holding it fails a write whose operand is longer;
 * - a text's ASCII case fold, lower under the C collation (textLowerAscii), total, everywhere: it allocates its
 *   operand's own length;
 * - a double's parse from its decimal text, `lexical` over every double's text, everywhere: no function it reads
 *   allocates past its operand's own size;
 * - a decimal's parse from its text, `lexical` over every decimal text within decimalTextMaxBytes, everywhere: numeric_in
 *   reads a member of at most that many bytes into a value numeric holds;
 * - a bytes value's SHA-256 digest as lowercase hex, total, everywhere: it allocates 64 characters whatever its
 *   operand's length;
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
		requires([{ kind: "powerDomain" }, { kind: "powerRange" }]),
		"displayScale"
	),
	"power(double precision,double precision)": fnCall(
		"power",
		"power",
		["float8", "float8"],
		"float8",
		requires([{ kind: "powerDomain" }, { kind: "powerRange" }]),
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
		requires([finite(0), finite(1), finite(2), { kind: "bucketDomain" }]),
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
	"utf16Length:text": textUtf16Length,
	"regexp_count(text,text)": fnCall(
		"regexpCount",
		"regexp_count",
		["text", "text"],
		"int4",
		requires([bounded]),
		"value"
	),
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
	"strpos(text,text)": fnCall("strpos", "strpos", ["text", "text"], "int4", total, "value"),
	"contains:text": textContains,
	textregexeq: infix("matches", "~", "text", "bool", total, "value"),
	"replace(text,text,text)": fnCall(
		"replace",
		"replace",
		["text", "text", "text"],
		"text",
		total,
		"value"
	),
	"btrim(text)": fnCall("btrim", "btrim", ["text"], "text", total, "value"),
	"collapse:text": textCollapse,
	"lowerAscii:text": textLowerAscii,
	"resolveReference:text": textResolveReference,
	"isXsdPattern:text": textIsXsdPattern,
	"parseDouble:text": textParseDouble,
	"parseDecimal:text": textParseDecimal,
	"sha256(bytea)": bytesDigest,
	"floatBits:float8": floatBitsOf("float8"),
	"floatBits:float4": floatBitsOf("float4"),
	"sha256:text": textSha256,
	"epochDay:date": dateEpochDay,
	"dateOfEpochDay:integer": dateOfEpochDayFrom("int4"),
	"dateOfEpochDay:bigint": dateOfEpochDayFrom("int8"),
	"wall:bigint": zoneWall,
	"searchPart:text": searchPart,
	tsvector_concat: infix("searchConcat", "||", "tsvector", "tsvector", total, "value"),
	"websearchMatches:tsvector": textSearchOf("websearchMatches", "match", "websearch"),
	"plainMatches:tsvector": textSearchOf("plainMatches", "match", "plain"),
	"websearchRank:tsvector": textSearchOf("websearchRank", "rank", "websearch"),
	"plainRank:tsvector": textSearchOf("plainRank", "rank", "plain"),
	"websearchRankCd:tsvector": textSearchOf("websearchRankCd", "rankCd", "websearch"),
	"plainRankCd:tsvector": textSearchOf("plainRankCd", "rankCd", "plain"),
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
	[canonicalZeroIds.float4]: canonicalZero("float4"),
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
	[canonicalZeroIds.float8]: canonicalZero("float8"),
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
	/**
	 * date - date, the integer count of days between them, which no two dates a CalendarDate spells overflow: a date
	 * span's width alone (compute/typing.ts width), since grizzle admits no date arithmetic.
	 */
	date_mi: infix("sub", "-", "date", "int4", total, "value"),
	date_pli: datePlus,
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
	network_eq: comparison("eq", "inet"),
	network_ne: comparison("ne", "inet"),
	network_lt: comparison("lt", "inet"),
	network_le: comparison("le", "inet"),
	network_gt: comparison("gt", "inet"),
	network_ge: comparison("ge", "inet"),
	"between:inet": between("inet", opId("network_ge"), opId("network_le")),
	"in:inet": membership("inet", opId("network_eq")),
	"least:inet": extreme("least", "inet", opId("network_lt")),
	"greatest:inet": extreme("greatest", "inet", opId("network_gt")),
	"cidr:network_eq": comparison("eq", "cidr"),
	"cidr:network_ne": comparison("ne", "cidr"),
	"cidr:network_lt": comparison("lt", "cidr"),
	"cidr:network_le": comparison("le", "cidr"),
	"cidr:network_gt": comparison("gt", "cidr"),
	"cidr:network_ge": comparison("ge", "cidr"),
	"between:cidr": between("cidr", opId("cidr:network_ge"), opId("cidr:network_le")),
	"in:cidr": membership("cidr", opId("cidr:network_eq")),
	"least:cidr": extreme("least", "cidr", opId("cidr:network_lt")),
	"greatest:cidr": extreme("greatest", "cidr", opId("cidr:network_gt")),
	network_subeq: netContainment("netWithin", "<<=", "inet", "inet"),
	"inet,cidr:network_subeq": netContainment("netWithin", "<<=", "inet", "cidr"),
	"cidr,inet:network_subeq": netContainment("netWithin", "<<=", "cidr", "inet"),
	"cidr,cidr:network_subeq": netContainment("netWithin", "<<=", "cidr", "cidr"),
	network_sub: netContainment("netStrictlyWithin", "<<", "inet", "inet"),
	"inet,cidr:network_sub": netContainment("netStrictlyWithin", "<<", "inet", "cidr"),
	"cidr,inet:network_sub": netContainment("netStrictlyWithin", "<<", "cidr", "inet"),
	"cidr,cidr:network_sub": netContainment("netStrictlyWithin", "<<", "cidr", "cidr"),
	network_overlap: netContainment("netOverlaps", "&&", "inet", "inet"),
	"inet,cidr:network_overlap": netContainment("netOverlaps", "&&", "inet", "cidr"),
	"cidr,inet:network_overlap": netContainment("netOverlaps", "&&", "cidr", "inet"),
	"cidr,cidr:network_overlap": netContainment("netOverlaps", "&&", "cidr", "cidr"),
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
	/**
	 * bytea's equality and inequality, which no scalar call reaches, since a bytes value has no equality capability:
	 * what grizzle's own statements compare a stored bytes column by, a rewrite's proof (carrierEquality) and a key
	 * law's violation, two facts of one key that differ in a payload field (analysis/theory/laws.ts keyViolation).
	 */
	byteaeq: comparison("eq", "bytes"),
	byteane: comparison("ne", "bytes"),
	/**
	 * A digest's comparisons, bytea's operators over its 32 bytes (ir/scalar.ts DigestType): its equality and bytea's
	 * order, the bytes compared one by one, which bytea_ops for B-tree and a key's index read.
	 */
	"sha256:byteaeq": comparison("eq", "sha256"),
	"sha256:byteane": comparison("ne", "sha256"),
	"sha256:bytealt": comparison("lt", "sha256"),
	"sha256:byteale": comparison("le", "sha256"),
	"sha256:byteagt": comparison("gt", "sha256"),
	"sha256:byteage": comparison("ge", "sha256"),
	"between:sha256": between("sha256", opId("sha256:byteage"), opId("sha256:byteale")),
	"in:sha256": membership("sha256", opId("sha256:byteaeq")),
	"least:sha256": extreme("least", "sha256", opId("sha256:bytealt")),
	"greatest:sha256": extreme("greatest", "sha256", opId("sha256:byteagt")),
	/**
	 * tsvector's equality and inequality, which no scalar call reaches either, since a search document has no equality
	 * capability: they stand as its native equality (equalities).
	 */
	tsvector_eq: comparison("eq", "tsvector"),
	tsvector_ne: comparison("ne", "tsvector"),
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
	"in:bits": membership("bits", opId("biteq")),
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
	"set_bit(bit,integer,integer)": setAdjoin,
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
	"between:daterange": between(
		"rangeDate",
		rangeOp("range_ge", "rangeDate"),
		rangeOp("range_le", "rangeDate")
	),
	"in:daterange": membership("rangeDate", rangeOp("range_eq", "rangeDate")),
	"least:daterange": extreme("least", "rangeDate", rangeOp("range_lt", "rangeDate")),
	"greatest:daterange": extreme("greatest", "rangeDate", rangeOp("range_gt", "rangeDate")),
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

const listedSpanCarriers = [
	"range4",
	"range8",
	"rangeDate"
] as const satisfies ReadonlyArray<SpanCarrier>

/** A range comparison at each span carrier. */
const spanComparison = (
	op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"
): { readonly [C in SpanCarrier]: Overload } => ({
	range4: comparison(op, "range4"),
	range8: comparison(op, "range8"),
	rangeDate: comparison(op, "rangeDate")
})

/** Each range-polymorphic overload by its code and the range carrier it is instantiated at (ir/expr.ts rangeOp). */
const spanOverloads: {
	readonly [K in (typeof listedSpanCodes)[number]]: { readonly [C in SpanCarrier]: Overload }
} = {
	"lower(anyrange)": {
		range4: endpoint("lower", "range4", "int4"),
		range8: endpoint("lower", "range8", "int8"),
		rangeDate: endpoint("lower", "rangeDate", "date")
	},
	"upper(anyrange)": {
		range4: endpoint("upper", "range4", "int4"),
		range8: endpoint("upper", "range8", "int8"),
		rangeDate: endpoint("upper", "rangeDate", "date")
	},
	range_eq: spanComparison("eq"),
	range_ne: spanComparison("ne"),
	range_lt: spanComparison("lt"),
	range_le: spanComparison("le"),
	range_gt: spanComparison("gt"),
	range_ge: spanComparison("ge")
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
		...castOp("text", target, requires([lexical("target")]), "immutable", textCast),
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
	"complement",
	"adjoin"
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

/** A listed comparison's identity: every comparison is total (comparison), so it is defined on every value. */
const comparisonId = (id: keyof typeof catalogOverloads): DefinedOp => definedOp(opId(id))

/**
 * Each carrier's native equality, its `eq` comparison: what a rewrite's proof compares two of its values under. Every
 * carrier has one, defined on every value, so the table is total and a carrier without one is a type error here.
 */
const equalities: { readonly [C in Carrier]: DefinedOp } = Object.freeze({
	int2: comparisonId("int2eq"),
	int4: comparisonId("int4eq"),
	int8: comparisonId("int8eq"),
	numeric: comparisonId("numeric_eq"),
	float4: comparisonId("float4eq"),
	float8: comparisonId("float8eq"),
	money: comparisonId("cash_eq"),
	bool: comparisonId("booleq"),
	uuid: comparisonId("uuid_eq"),
	date: comparisonId("date_eq"),
	inet: comparisonId("network_eq"),
	cidr: comparisonId("cidr:network_eq"),
	text: comparisonId("texteq"),
	bytes: comparisonId("byteaeq"),
	sha256: comparisonId("sha256:byteaeq"),
	tsvector: comparisonId("tsvector_eq"),
	code: comparisonId("code:int2eq"),
	bits: comparisonId("biteq"),
	range4: definedRangeOp("range_eq", "range4"),
	range8: definedRangeOp("range_eq", "range8"),
	rangeDate: definedRangeOp("range_eq", "rangeDate"),
	vector: comparisonId("vector_eq"),
	exactInteger: comparisonId("exact:numeric_eq"),
	exactMoney: comparisonId("exactMoney:numeric_eq")
})

/** The native equality of `carrier` (equalities). */
export const carrierEquality = (carrier: Carrier): DefinedOp => equalities[carrier]

/**
 * The spec of a float term's canonical zero (canonicalZero), of the term's type: what a merge delivers of a float it may
 * take one of two zeros of (check/merge.ts), and what a catalog rewrite delivers of one in the composition's place
 * (lower/shapes/catalog); a term of any other type has none.
 */
export const canonicalZeroSpec = (expr: ScalarExpr): ExprSpec | undefined => {
	const carrier = floatCarrierOf(expr.type)
	const overload = carrier === undefined ? undefined : overloadOf("canonicalZero", [carrier])
	const op = overload === undefined ? undefined : definedIdOf(overload)
	return op === undefined
		? undefined
		: {
				kind: "op",
				op,
				args: [expr],
				type: expr.type,
				nonNull: "strict",
				volatility: "immutable"
			}
}

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

/**
 * The SQL types each SQL type has a registered cast into, castOverloads read through carrierSql, a text's its parses:
 * what Type.cast's types admit between two SQL types (types/compute/scalar.ts CastAdmitted), so this table is the one
 * statement of which casts there are, for the types as for compilation (castOf).
 */
export type CastTargetsBySql = {
	readonly [S in CastSource as (typeof carrierSql)[S]]: (typeof carrierSql)[CastTarget<S> & Carrier]
}

/** The registered cast between two carriers the table lists a cast between. */
export const registeredCast = <S extends CastSource, T extends CastTarget<S>>(
	source: S,
	target: T
): (typeof castOverloads)[S][T] => castOverloads[source][target]
