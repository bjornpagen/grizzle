import { appendAll, sameOrder } from "@bjornpagen/grizzle-text/base/array"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { type NonEmptyReadonlyArray, sortNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { compareCodePoints, isAsciiDigit } from "@bjornpagen/grizzle-text/text"
import { nominal } from "#compiler/core/brand.ts"
import {
	canonicalTextOf,
	catchRefusal,
	type FloatSpecialName,
	Refusal
} from "#compiler/core/canonical.ts"
import type { DecimalParts } from "#compiler/core/decimal.ts"
import { isSha256Text } from "#compiler/core/digest.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { FunctionDigest } from "#compiler/core/fingerprint.ts"
import type { FunctionNullInput, FunctionVolatility } from "#compiler/core/function.ts"
import type { IdentityValue } from "#compiler/core/identity.ts"
import { ExprId, type NodeId, type ParamId } from "#compiler/core/ids.ts"
import { type Comparator, compareStrings, mapInput, thenBy } from "#compiler/core/order.ts"
import {
	belowPowerOfTen,
	type CanonicalFloat,
	floatLiteral,
	integerRanges,
	isIntegerTypmod,
	type MoneyValue,
	moneyMinorUnits,
	uuidHyphens,
	uuidTextLength,
	type VectorText
} from "#compiler/ir/carriers.ts"
import {
	type CalendarDate,
	dateOfDayNumber,
	dayNumber,
	lastCalendarDate,
	toCalendarDate
} from "#compiler/ir/date.ts"
import { type DecimalValue, decimalPayload } from "#compiler/ir/decimal.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import type { PatternValue } from "#compiler/ir/pattern.ts"
import type { NativeProof, OperationProof } from "#compiler/ir/proof.ts"
import {
	baseOf,
	enteredType,
	type NonIdentityCarrier,
	type NumericTypmod,
	type ScalarType,
	type SpanCarrier,
	sameScalarType,
	spanCarriers,
	subsumes,
	typeLabel
} from "#compiler/ir/scalar.ts"
import * as S from "#compiler/ir/shape.ts"
import { moneyFractionDigits } from "#compiler/scalar/values/decimal.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/scalar/values/fault.ts"
import { type Cidr, type Inet, isCidrText, isInetText } from "#compiler/scalar/values/net.ts"

/**
 * The identity of one native overload, resolved against the installed capability registry. The scalar package owns
 * the registry; the IR only carries the identity, one of two kinds:
 * - an overload its catalog identity alone names, such as the operator "int8pl" or the function "abs(bigint)"
 *   (scalar/compute/registry.ts lists the conventions); OpId constructs it;
 * - a range-polymorphic overload, one catalog object for every range type: its catalog identity with the range carrier
 *   it is instantiated at, so that a range4 and a range8 instance are distinct overloads; rangeOp interns it.
 */
export type CatalogOpId = string & { readonly [opIdBrand]: true }
declare const opIdBrand: unique symbol
export const OpId = nominal<string, CatalogOpId>()

/**
 * The range-polymorphic catalog objects the IR names: the range comparisons, the Allen atoms' operators
 * (range_eq among them), the range-contains-element operator r.pointIn is, each by its pg_operator.oprcode, and the
 * endpoint functions by their regprocedure signatures.
 */
export const rangeOpCodes = [
	"range_eq",
	"range_ne",
	"range_lt",
	"range_le",
	"range_gt",
	"range_ge",
	"range_overlaps",
	"range_contains",
	"range_contained_by",
	"range_before",
	"range_after",
	"range_overleft",
	"range_overright",
	"range_adjacent",
	"range_contains_elem",
	"lower(anyrange)",
	"upper(anyrange)"
] as const
export type RangeOpCode = (typeof rangeOpCodes)[number]

export type RangeOpParts = { readonly code: RangeOpCode; readonly carrier: SpanCarrier }
export type RangeOpId = RangeOpParts & { readonly [rangeOpIdBrand]: true }
declare const rangeOpIdBrand: unique symbol
const rangeOpId = nominal<RangeOpParts, RangeOpId>()

/** A code's overloads, one frozen instance per carrier. */
const rangeOpsOf = (code: RangeOpCode): { readonly [C in SpanCarrier]: RangeOpId } =>
	Object.freeze({
		range4: rangeOpId(Object.freeze({ code, carrier: "range4" })),
		range8: rangeOpId(Object.freeze({ code, carrier: "range8" })),
		rangeDate: rangeOpId(Object.freeze({ code, carrier: "rangeDate" }))
	})

/** Every code's overloads, made once at load, so two range overloads are the same exactly when they are one value. */
const rangeOps: { readonly [K in RangeOpCode]: { readonly [C in SpanCarrier]: RangeOpId } } = {
	range_eq: rangeOpsOf("range_eq"),
	range_ne: rangeOpsOf("range_ne"),
	range_lt: rangeOpsOf("range_lt"),
	range_le: rangeOpsOf("range_le"),
	range_gt: rangeOpsOf("range_gt"),
	range_ge: rangeOpsOf("range_ge"),
	range_overlaps: rangeOpsOf("range_overlaps"),
	range_contains: rangeOpsOf("range_contains"),
	range_contained_by: rangeOpsOf("range_contained_by"),
	range_before: rangeOpsOf("range_before"),
	range_after: rangeOpsOf("range_after"),
	range_overleft: rangeOpsOf("range_overleft"),
	range_overright: rangeOpsOf("range_overright"),
	range_adjacent: rangeOpsOf("range_adjacent"),
	range_contains_elem: rangeOpsOf("range_contains_elem"),
	"lower(anyrange)": rangeOpsOf("lower(anyrange)"),
	"upper(anyrange)": rangeOpsOf("upper(anyrange)")
}

export const rangeOp = (code: RangeOpCode, carrier: SpanCarrier): RangeOpId =>
	rangeOps[code][carrier]

/** The range overload of `code` over `carrier` where both texts name one, none for any other: a range overload a served
 * file names, read back as its one instance (served/json.ts). */
export const rangeOpNamed = (code: string, carrier: string): RangeOpId | undefined => {
	const named = rangeOpCodes.find((c) => c === code)
	const over = spanCarriers.find((c) => c === carrier)
	return named === undefined || over === undefined ? undefined : rangeOps[named][over]
}

/** `value` where it is one of the range overloads' instances, none for any other value, a record of the same parts
 * among them: the one form a served file writes by name (served/json.ts). */
export const internedRangeOp = (
	value: Readonly<Record<string, unknown>>
): RangeOpId | undefined => {
	const code = value["code"]
	const carrier = value["carrier"]
	const op =
		typeof code === "string" && typeof carrier === "string"
			? rangeOpNamed(code, carrier)
			: undefined
	return op === value ? op : undefined
}

export type OpId = CatalogOpId | RangeOpId

/**
 * The identity of each canonical form, of a carrier whose equality is no identity (ir/scalar.ts NonIdentityCarrier), an
 * operation no scalar function names (scalar/compute/registry.ts canonical): the value a read delivers of a term several
 * equal values may stand for (check/merge.ts), one value of each class PostgreSQL's `=` holds equal, a float's -0
 * written +0.
 */
export const canonicalIds = {
	float4: "canonical:real",
	float8: "canonical:double precision"
} as const satisfies { readonly [C in NonIdentityCarrier]: string }

/** Whether an operation is a canonical form (canonicalIds). */
const isCanonical = (op: OpId): boolean => op === canonicalIds.float4 || op === canonicalIds.float8

/**
 * A head output as a reading of its term takes it: the term it delivers and whether it delivers the term's canonical
 * form (check/merge.ts), which a merge that may take one value of several equal ones puts on each value of a
 * non-identity equality type it delivers. The canonical form keeps every value's order and maps distinct values to
 * distinct ones, so what reads the term (an equality's compared value, a composition's selected column, an approximate
 * search's score) reads it through.
 */
export const canonicalPeeled = (
	e: ScalarExpr
): { readonly term: ScalarExpr; readonly canonical: boolean } => {
	const [arg] = e.args
	return e.kind === "op" && isCanonical(e.op) && arg !== undefined
		? { term: arg, canonical: true }
		: { term: e, canonical: false }
}

declare const definedBrand: unique symbol

/**
 * An overload or cast the registry vouches is defined on every value its operands admit: its Totality is total,
 * exact or ieee (scalar/compute/registry.ts mints it, and the decoder of a stored expression).
 */
export type DefinedOp = OpId & { readonly [definedBrand]: "everywhere" }

/**
 * An overload or cast defined only where its precondition holds (Totality requires): an expression names one only
 * beside the proof of that precondition, so no expression can raise on a value its operands admit.
 */
export type PartialOp = OpId & { readonly [definedBrand]: "where proved" }

/**
 * The mints of DefinedOp and PartialOp, unchecked: the overload registry calls them for each entry by its Totality,
 * and the decoder of a stored expression for each node by whether it carries a proof; nothing else mints either.
 */
export const definedOp = nominal<OpId, DefinedOp>()
export const partialOp = nominal<OpId, PartialOp>()

/**
 * The order proofs list the overloads they use in: catalog identities by their text, then range overloads by code and
 * carrier.
 */
/** Range operators by code, then by carrier. */
const rangeOpOrder: Comparator<RangeOpId> = thenBy(
	mapInput(compareStrings, (op: RangeOpId) => op.code),
	mapInput(compareStrings, (op: RangeOpId) => op.carrier)
)

/** Catalog operators first, by name, then range operators. */
const opOrder: Comparator<OpId> = (a, b) => {
	if (typeof a === "string") {
		return typeof b === "string" ? compareStrings(a, b) : -1
	}
	if (typeof b === "string") {
		return 1
	}
	return rangeOpOrder(a, b)
}

/** Distinct overloads, sorted. */
export const sortedOps = (ops: Iterable<OpId>): ReadonlyArray<OpId> =>
	Object.freeze([...new Set(ops)].toSorted(opOrder))

/** An overload as a diagnostic names it. */
export const describeOp = (op: OpId): string =>
	typeof op === "string" ? op : `${op.code} over ${op.carrier}`

const exprKinds = [
	"column",
	"value",
	"param",
	"literal",
	"op",
	"cast",
	"domainCast",
	"cond",
	"closedAt",
	"closedRow",
	"closedHas",
	"call",
	"variant"
] as const
type ExprKind = (typeof exprKinds)[number]

declare const patternTableBrand: unique symbol

/**
 * Every value a Text.matches pattern operand can take, each its pattern value (ir/pattern.ts PatternValue), its
 * spelling admitted when the node was typed (scalar/regex/admit.ts admitMatch): at least one, each spelling once, by
 * its language's key and then its spelling in code point order, so one set of patterns has one table and its identity
 * is its languages. The host's automaton reads a spelling; only a lowering into SQL translates one into the PostgreSQL
 * ARE `~` reads (scalar/regex/admit.ts matchAre). patternTableOf alone mints one.
 */
export type PatternTable = NonEmptyReadonlyArray<PatternValue> & {
	readonly [patternTableBrand]: true
}

const mintPatternTable = nominal<NonEmptyReadonlyArray<PatternValue>, PatternTable>()

/** Pattern values by their language's key, then their spelling, each in code point order. */
const byLanguage: Comparator<PatternValue> = thenBy(
	mapInput(compareCodePoints, (p: PatternValue) => p.pattern),
	mapInput(compareCodePoints, (p: PatternValue) => p.spelling)
)

/**
 * The one table of the patterns `values` holds, in whatever order and with whatever repeats they arrive: each spelling
 * once, by language and spelling (byLanguage).
 */
export const patternTableOf = (values: NonEmptyReadonlyArray<PatternValue>): PatternTable => {
	const [head, ...tail] = values
	const others = new Map(tail.map((p) => [p.spelling, p] as const))
	others.delete(head.spelling)
	return mintPatternTable(Object.freeze(sortNonEmpty([head, ...others.values()], byLanguage)))
}

/** How a parameter's placeholder is cast: compare binds the base type; write and emit cast to the domain. */
export type ParamRole = "compare" | "write" | "emit"

export type Volatility = "immutable" | "stable"

export interface ColumnRef {
	readonly node: NodeId
	readonly name: string
}

/**
 * A typed literal ("every literal is a typed literal"). The kind fixes the host representation and the
 * expression's type fixes the native type, and the two agree (literalProblem). Numeric, Money and Vector values are
 * held parsed and spell their canonical tags from their parts: the owned Numeric and Money travel here unchanged, and a
 * Vector as the frozen snapshot of its components (Vector.canonical). A Text.matches pattern is its pattern value
 * (ir/pattern.ts PatternValue), a text whose identity is its language and whose spelling the lowering reads, and it
 * stands only where a match reads its pattern.
 */
export type TypedLiteral =
	| { readonly kind: "int"; readonly value: bigint }
	| { readonly kind: "numeric"; readonly value: DecimalValue }
	| { readonly kind: "float"; readonly value: CanonicalFloat }
	| { readonly kind: "floatSpecial"; readonly value: FloatSpecialName }
	| { readonly kind: "money"; readonly value: MoneyValue }
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "uuid"; readonly value: string }
	| {
			readonly kind: "sha256"
			/** The digest's one text, `\x` and two lowercase hex digits a byte (scalar/values/sha256.ts sha256Text). */
			readonly value: string
	  }
	| { readonly kind: "date"; readonly value: CalendarDate }
	| { readonly kind: "inet"; readonly value: Inet }
	| { readonly kind: "cidr"; readonly value: Cidr }
	| {
			readonly kind: "handle"
			/** One of the closed id's roster's live handles, which lowers to its code under the installation's codebook. */
			readonly handle: string
	  }
	| {
			readonly kind: "handles"
			/**
			 * A set over the literal's roster: its handles in the roster's declared order, each once. No handles is the
			 * empty set, the identity of a union.
			 */
			readonly handles: ReadonlyArray<string>
	  }
	| { readonly kind: "span"; readonly start: bigint; readonly end: bigint }
	| { readonly kind: "vector"; readonly value: VectorText }
	| { readonly kind: "pattern"; readonly value: PatternValue }

/**
 * A literal as an identity of the naming door takes it (core/identity.ts): its canonical text as its part, a boolean or
 * integer as written, a handle or text as its words for its stem, any other kind, a set of handles among them, by its
 * kind.
 */
export const identityValueOf = (value: TypedLiteral): IdentityValue => {
	const part = canonicalTextOf(value)
	switch (value.kind) {
		case "bool":
			return { part, stem: value.value ? "true" : "false", display: value.value ? "true" : "false" }
		case "int":
			return {
				part,
				stem: value.value < 0n ? `minus_${-value.value}` : `${value.value}`,
				display: `${value.value}`
			}
		case "handle":
			return { part, stem: value.handle, display: value.handle }
		case "text":
			return { part, stem: value.value, display: JSON.stringify(value.value) }
		case "numeric":
		case "float":
		case "floatSpecial":
		case "money":
		case "uuid":
		case "sha256":
		case "date":
		case "inet":
		case "cidr":
		case "handles":
		case "span":
		case "vector":
			return { part, stem: value.kind, display: part }
		case "pattern":
			defect("a pattern literal names nothing: it stands only where a match reads its pattern")
	}
}

/**
 * A declared function as a call names it (schema/function.ts fn): its declared name, by which the lowering reads its
 * installed name (ir/physical.ts PhysicalNames declaredFunction), its volatility, and the digest of its Description
 * (core/fingerprint.ts FunctionDigest), so a call's meaning, and the identity of every law and program that reads it,
 * changes with any part of the function, its body included.
 */
export interface CalledFunction {
	readonly name: string
	readonly volatility: FunctionVolatility
	readonly definition: FunctionDigest
}

/**
 * A declared function's call's non-null proof, by its function's null input (core/function.ts FunctionNullInput):
 * `returned`, a function called on NULL input, whose NULL value is refused where it is returned, so the call is never
 * NULL; `strict`, a strict function, NULL exactly where an argument is NULL, as every strict operation is.
 */
export const callNonNulls = ["returned", "strict"] as const
export type CallNonNull = (typeof callNonNulls)[number]

/** A call's non-null proof by its function's null input (CallNonNull). */
export const callNonNull: { readonly [N in FunctionNullInput]: CallNonNull } = {
	called: "returned",
	strict: "strict"
}

/** The free parameters and source nodes an expression reads, transitively ("dependencies"). */
export interface ExprDeps {
	readonly params: ReadonlyArray<ParamId>
	readonly nodes: ReadonlyArray<NodeId>
}

/**
 * What evaluating an expression may do: read the session's settings (stable) or not (immutable). Raising is no effect:
 * every operation is total over the values its operands admit, or its precondition was proved where it stands
 * (scalar/compute/registry.ts Totality), so no expression raises on a value.
 */
export interface Effects {
	readonly volatility: Volatility
}

/** What an expression's arguments are in one form: the argument expressions themselves, or their identifiers. */
export interface ArgKinds {
	readonly expr: unknown
}

/** A live expression's arguments: the argument expressions themselves. */
export interface LiveArgs {
	readonly expr: ScalarExpr
}

/** A tabled expression's arguments: the identifiers its table keys them by (ExprTable, dag.ts toTable). */
export interface TableArgs {
	readonly expr: ExprId
}

/**
 * Each kind with its inputs, in operand order, at its arity (leaves have none, an operator any number: least,
 * greatest), its non-null proof, and the volatility only it can state of itself: an operator's (the registry's) and a
 * cast's. Every other kind is immutable of itself, and every kind's volatility joins its arguments' (exprEffects),
 * which builtExpr computes. An operator names its overload and a cast its registered cast (or the binary coercion),
 * each a DefinedOp or a PartialOp: a partial one stands only with the proof of its precondition, and a domain cast,
 * which PostgreSQL validates, always does. An IEEE 754 operation or rounding (a DefinedOp whose Totality is ieee) may
 * stand with the proof that PostgreSQL's own overload computes its value there (NativeProof), and then renders as it.
 */
export type ExprSpecOver<R extends ArgKinds> = { readonly type: ScalarType } & (
	| {
			readonly kind: "column"
			readonly column: ColumnRef
			readonly args: readonly []
			readonly nonNull: "storage" | "codec"
	  }
	| { readonly kind: "value"; readonly args: readonly []; readonly nonNull: "storage" }
	| {
			readonly kind: "param"
			readonly param: ParamId
			readonly role: ParamRole
			readonly args: readonly []
			readonly nonNull: "codec"
	  }
	| {
			readonly kind: "literal"
			readonly value: TypedLiteral
			readonly args: readonly []
			readonly nonNull: "literal"
	  }
	| {
			readonly kind: "op"
			readonly op: DefinedOp
			readonly args: ReadonlyArray<R["expr"]>
			readonly nonNull: "strict"
			readonly volatility: Volatility
	  }
	| {
			readonly kind: "op"
			readonly op: DefinedOp
			readonly args: ReadonlyArray<R["expr"]>
			readonly nonNull: "strict"
			readonly volatility: Volatility
			readonly native: NativeProof
	  }
	| {
			readonly kind: "op"
			readonly op: PartialOp
			readonly args: ReadonlyArray<R["expr"]>
			readonly nonNull: "strict"
			readonly volatility: Volatility
			readonly proof: OperationProof
	  }
	| {
			/**
			 * Text.matches(text, pattern), PostgreSQL's textregexeq: its pattern operand's every value with the ARE
			 * PostgreSQL reads in its place (PatternTable), which the lowering spells for `~`.
			 */
			readonly kind: "op"
			readonly op: DefinedOp
			readonly args: ReadonlyArray<R["expr"]>
			readonly nonNull: "strict"
			readonly volatility: Volatility
			readonly patterns: PatternTable
	  }
	| {
			readonly kind: "cast"
			readonly cast: DefinedOp
			readonly args: readonly [R["expr"]]
			readonly nonNull: "strict"
			readonly volatility: Volatility
	  }
	| {
			readonly kind: "cast"
			readonly cast: DefinedOp
			readonly args: readonly [R["expr"]]
			readonly nonNull: "strict"
			readonly volatility: Volatility
			readonly native: NativeProof
	  }
	| {
			readonly kind: "cast"
			readonly cast: PartialOp
			readonly args: readonly [R["expr"]]
			readonly nonNull: "strict"
			readonly volatility: Volatility
			readonly proof: OperationProof
	  }
	| {
			readonly kind: "domainCast"
			readonly args: readonly [R["expr"]]
			readonly nonNull: "strict"
			readonly proof: OperationProof
	  }
	| {
			readonly kind: "cond"
			readonly args: readonly [R["expr"], R["expr"], R["expr"]]
			readonly nonNull: "cond"
	  }
	| {
			/**
			 * A variant's operation (VariantOp) over its arguments: its tag, of its one argument; one field of an arm of
			 * its one argument, NULL where the argument's tag is another arm, which only a cond of the tag's equality
			 * guards, so no reader meets it there ("arm"); or a value of an arm, its fields its arguments in declared
			 * order, a value of `type`, the variant.
			 */
			readonly kind: "variant"
			readonly op: VariantOp
			readonly args: ReadonlyArray<R["expr"]>
			readonly nonNull: "strict" | "arm"
	  }
	| {
			/**
			 * C.at(field, t…): the payload field `field` of the closed relation `relation` at the key its arguments are, one
			 * per key field in key order. A key the relation holds no tuple at reads NULL, never a value of the type: the
			 * reader refuses it, IS TRUE in a predicate and NOT NULL in a generated column, so absence is no value.
			 */
			readonly kind: "closedAt"
			readonly relation: string
			readonly field: string
			readonly args: NonEmptyReadonlyArray<R["expr"]>
			readonly nonNull: "absentRefused"
	  }
	| {
			/**
			 * C.row(t…): the completions of the key prefix its arguments are in the closed relation `relation`, in key order,
			 * a set over the roster of the one key field the prefix leaves open. Every prefix has one, empty where the
			 * relation holds none.
			 */
			readonly kind: "closedRow"
			readonly relation: string
			readonly args: ReadonlyArray<R["expr"]>
			readonly nonNull: "strict"
	  }
	| {
			/**
			 * C.has(t…): whether the closed relation `relation` holds a tuple at the key its arguments are, one per key field
			 * in key order: a boolean, false at a key it holds no tuple at, never NULL of itself, so a law branches on a
			 * key's absence. The closed rewrite (lower/optimize/closed) also states with it an occurrence of the relation's
			 * full facts that only tests membership. It lowers to one bit of the relation's installed key set.
			 */
			readonly kind: "closedHas"
			readonly relation: string
			readonly args: NonEmptyReadonlyArray<R["expr"]>
			readonly nonNull: "strict"
	  }
	| {
			/**
			 * Fn.call(f, args) of a declared function `function` that returns a value: its value at its arguments, one
			 * per declared argument in declared order, each passed at its declared type's base (`params`), and its value
			 * of its declared type, which the lowering casts it to. Its non-null proof is its function's null input
			 * (CallNonNull): a function called on NULL input runs its body at every argument and a NULL value is refused
			 * where it is returned, so the value is never NULL ("returned"); a strict one's value is NULL exactly where
			 * an argument is, its body never run there, and a NULL it returns at values is refused ("strict"). PostgreSQL
			 * alone runs a body, so a host evaluator reads a strict call's value at a NULL argument alone. Its volatility
			 * is its function's, an immutable or a stable one: a term is a function of its operands, so a volatile
			 * function is called as a source alone.
			 */
			readonly kind: "call"
			readonly function: CalledFunction
			readonly params: ReadonlyArray<ScalarType>
			readonly args: ReadonlyArray<R["expr"]>
			readonly nonNull: CallNonNull
			readonly volatility: Volatility
	  }
)

/**
 * A variant's operation (ir/scalar.ts VariantType): its tag; one field of the arm `handle`; a value of the arm `handle`
 * made of its fields; or its identity image (scalar/variant-digest.ts), a SHA-256 digest.
 */
export type VariantOp =
	| { readonly kind: "tag" }
	| { readonly kind: "digest" }
	| { readonly kind: "field"; readonly handle: string; readonly field: string }
	| { readonly kind: "make"; readonly handle: string }

/** An expression as a builder states it: its kind, its type, and its argument expressions themselves. */
export type ExprSpec = ExprSpecOver<LiveArgs>

/** A stored column's reference: the column `name` of `node` at `type`, its nullability its storage's. */
export const storedColumn = (node: NodeId, name: string, type: ScalarType): ExprSpec => ({
	kind: "column",
	column: { node, name },
	args: [],
	type,
	nonNull: "storage"
})

/**
 * The scalar expression IR.
 *
 * One node is exactly one PostgreSQL operator, function, or cast: the vocabulary is the scalar
 * catalogue, with no library-defined composite operation. Each node records its exact native overload, its argument
 * expressions, its output descriptor, its non-null proof, its volatility, and its dependencies. No node raises on a
 * value its operands admit: the registry's Totality of its overload says how it is defined on every one, and the
 * scalar lowering emits a partial overload only with the proof of its precondition.
 * There is no NULL literal, no COALESCE and no NULLIF node: absence is zero rows. The one value that may be absent is a
 * closed relation's application at a key it holds no tuple at (closedAt), which its reader refuses.
 *
 * An expression holds its arguments themselves: one frozen tree, shared by every node that reads it. A column reference
 * names the node whose heading supplies the column, a name compared and never followed, so an expression is meaningful
 * inside the scope of its DAG. Its id is a label, minted once per construction, for outputs and the outside form.
 *
 * An expression is its spec with what builtExpr derives from its arguments: its dependencies, its effects
 * (exprEffects) and the type PostgreSQL gives its lowered SQL (pgTypeOf). Its spec's effects, read again as a spec, are
 * claims no weaker than its own, so rebuilding it derives the same effects. Its PostgreSQL type is the lowering's alone:
 * the outside form (TableExpr) never carries it.
 */
export type ScalarExpr = ExprSpec &
	Effects & { readonly id: ExprId; readonly deps: ExprDeps; readonly pgType: ScalarType }

/**
 * The outside form of an expression, its arguments by identifier: an entry of a contract predicate's table (ExprTable),
 * and of a DAG's table (dag.ts toTable).
 */
export type TableExpr = ExprSpecOver<TableArgs> &
	Effects & { readonly id: ExprId; readonly deps: ExprDeps }

export type ExprOf<K extends ExprKind> = Extract<ScalarExpr, { readonly kind: K }>
export type TableExprOf<K extends ExprKind> = Extract<TableExpr, { readonly kind: K }>

const pure: Effects = Object.freeze({ volatility: "immutable" })

/**
 * What an expression of `spec` does of itself, before its arguments: the one classification of an operation's
 * volatility that every reader shares (exprEffects, a contract predicate's immutability, a query entry's definition).
 */
const ownEffects = <R extends ArgKinds>(spec: ExprSpecOver<R>): Effects => {
	switch (spec.kind) {
		case "op":
		case "cast":
		case "call":
			return { volatility: spec.volatility }
		case "domainCast":
		case "column":
		case "value":
		case "param":
		case "literal":
		case "cond":
		case "variant":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return pure
	}
}

/**
 * The effects of an expression of `spec` over arguments of effects `args`: its own joined with theirs, so a stable
 * argument makes its reader stable. The one rule every expression derives effects by: builtExpr, a contract
 * predicate's table, the rewrite editors and the scalar lowering.
 */
export const exprEffects = <R extends ArgKinds>(
	spec: ExprSpecOver<R>,
	args: ReadonlyArray<Effects>
): Effects => {
	const own = ownEffects(spec)
	return {
		volatility:
			own.volatility === "stable" || args.some((a) => a.volatility === "stable")
				? "stable"
				: "immutable"
	}
}

const noIds: ReadonlyArray<never> = Object.freeze([])

/**
 * The distinct items in code unit order; no items is the one shared empty list, so the many empty dependency lists of a
 * DAG are one decoded value.
 */
export const sortedUnique = <A extends string>(items: Iterable<A>): ReadonlyArray<A> => {
	const distinct = [...new Set(items)]
	return distinct.length === 0 ? noIds : Object.freeze(distinct.toSorted(compareStrings))
}

/**
 * Two lists each in code unit order without repeats (sortedUnique's), merged in one pass into one such list: either
 * list itself where it holds every item of the other, the second first, so a union folded over its parts in turn is the
 * very list of a part that holds every other part's items: a dependency list an expression or a node adds nothing to is
 * its argument's or input's own, one value however many nodes and expressions read it.
 */
export const sortedUnion = <A extends string>(
	a: ReadonlyArray<A>,
	b: ReadonlyArray<A>
): ReadonlyArray<A> => {
	if (b.length === 0 || a === b) {
		return a
	}
	if (a.length === 0) {
		return b
	}
	const out: Array<A> = []
	let i = 0
	let j = 0
	for (;;) {
		const x = a[i]
		const y = b[j]
		if (x === undefined || y === undefined) {
			break
		}
		const order = compareStrings(x, y)
		out.push(order <= 0 ? x : y)
		i += order <= 0 ? 1 : 0
		j += order >= 0 ? 1 : 0
	}
	appendAll(out, a.slice(i))
	appendAll(out, b.slice(j))
	return out.length === b.length ? b : out.length === a.length ? a : Object.freeze(out)
}

/**
 * The expression of `spec` labelled `id`, with what its arguments derive: its dependencies, its own parameter or column
 * source with every argument's, and its effects (exprEffects). The one constructor of an expression, frozen; its
 * arguments are expressions built before it, so what they derive is final.
 */
export const builtExpr = (spec: ExprSpec, id: ExprId): ScalarExpr => {
	if (spec.kind === "cast" && subsumes(spec.type, spec.args[0].type)) {
		defect(
			`a cast of ${typeLabel(spec.args[0].type)} up to ${typeLabel(spec.type)}, which subsumes it: an expression of a type stands where a type that subsumes it is asked for, with no node of its own (ir/scalar.ts subsumes), so its builder typed its operand by equality where subsumption decides`
		)
	}
	let params: ReadonlyArray<ParamId> = spec.kind === "param" ? sortedUnique([spec.param]) : noIds
	let nodes: ReadonlyArray<NodeId> =
		spec.kind === "column" ? sortedUnique([spec.column.node]) : noIds
	for (const a of spec.args) {
		params = sortedUnion(params, a.deps.params)
		nodes = sortedUnion(nodes, a.deps.nodes)
	}
	return Object.freeze({
		...spec,
		...exprEffects(spec, spec.args),
		id,
		deps: Object.freeze({ params, nodes }),
		pgType: pgTypeOf(spec)
	})
}

/**
 * The type PostgreSQL gives the lowered SQL of an expression of `spec`, where the IR may record another for the host.
 * A leaf, a cast and a domain cast are typed as the IR types them. A conditional, and an operation, keep the IR's type
 * only when every operand PostgreSQL resolves it from (a conditional's two branches, an operation's operands) has that
 * type in PostgreSQL, and are typed by its base otherwise: PostgreSQL's common type of CASE, GREATEST and LEAST keeps a
 * domain only when every input has it, and a native function or operator with a fixed result type, such as lower or
 * upper of a span over a contract (whose IR type keeps the endpoint's contract for the host), is typed by that result,
 * never a domain. Every other operation the IR holds is typed by its plain registered result, its own base.
 */
const pgTypeOf = (spec: ExprSpec): ScalarType => {
	switch (spec.kind) {
		case "column":
		case "value":
		case "param":
		case "literal":
		case "cast":
		case "domainCast":
		case "closedAt":
		case "closedRow":
		case "closedHas":
		case "call":
		case "variant":
			return spec.type
		case "cond":
			return commonPgType([spec.args[1], spec.args[2]], spec.type)
		case "op":
			return commonPgType(spec.args, spec.type)
	}
}

const commonPgType = (operands: ReadonlyArray<ScalarExpr>, type: ScalarType): ScalarType =>
	operands.every((a) => sameScalarType(a.pgType, type)) ? type : baseOf(type)

/**
 * The expression with each argument yielded, in operand order, and the value sent back in its place; its kind's arity
 * kept. Its other fields are carried as they are.
 */
export function* mapArgs<R extends ArgKinds, S extends ArgKinds>(
	spec: ExprSpecOver<R>
): Generator<R["expr"], ExprSpecOver<S>, S["expr"]> {
	switch (spec.kind) {
		case "column":
		case "value":
		case "param":
		case "literal":
			return spec
		case "op": {
			const args: Array<S["expr"]> = []
			for (const a of spec.args) {
				const value: S["expr"] = yield a
				args.push(value)
			}
			return { ...spec, args }
		}
		case "cast": {
			const a: S["expr"] = yield spec.args[0]
			return { ...spec, args: [a] }
		}
		case "domainCast": {
			const a: S["expr"] = yield spec.args[0]
			return { ...spec, args: [a] }
		}
		case "cond": {
			const p: S["expr"] = yield spec.args[0]
			const t: S["expr"] = yield spec.args[1]
			const e: S["expr"] = yield spec.args[2]
			return { ...spec, args: [p, t, e] }
		}
		case "closedAt":
		case "closedHas": {
			const [first, ...rest] = spec.args
			const head: S["expr"] = yield first
			const tail: Array<S["expr"]> = []
			for (const a of rest) {
				const value: S["expr"] = yield a
				tail.push(value)
			}
			return { ...spec, args: [head, ...tail] }
		}
		case "closedRow":
		case "call":
		case "variant": {
			const args: Array<S["expr"]> = []
			for (const a of spec.args) {
				const value: S["expr"] = yield a
				args.push(value)
			}
			return { ...spec, args }
		}
	}
}

/** The expression with each argument mapped by `f`, in operand order, its kind's arity kept. */
export const withArgs = <R extends ArgKinds, S extends ArgKinds>(
	spec: ExprSpecOver<R>,
	f: (arg: R["expr"]) => S["expr"]
): ExprSpecOver<S> => drive(mapArgs<R, S>(spec), f)

/**
 * Whether a restated expression holds the same arguments as `before`, argument for argument: a copy-on-write rewrite
 * that changed none of them keeps the expression itself.
 */
export const sameArgs = (before: ExprSpec, after: ExprSpec): boolean =>
	sameOrder<ScalarExpr>(before.args, after.args)

/** An expression without its PostgreSQL type, which its outside form (TableExpr) never carries. */
export const outsideSpec = ({ pgType: _lowered, ...expr }: ScalarExpr): ExprSpec => expr

/**
 * A closed expression graph with one root, the stored form of a contract predicate: its entries keyed by identifier,
 * in normal form, numbered "e#0" from the root and then breadth-first through the arguments in operand order
 * (predicateTable). It lives inside a ScalarType, whose canonical text is its identity, so this form is what the
 * snapshot and every fingerprint spell; a reader that walks it parses it once into a tree (predicateTree).
 */
export interface ExprTable {
	readonly root: ExprId
	readonly exprs: Readonly<Record<ExprId, TableExpr>>
}

/**
 * pgvector's vector_norm over a vector literal's components: each binary32 component squared and summed in double, then
 * the root (scalar/values/vector.ts norm), which a literal's place in the cosine domain is read by.
 */
const nativeNorm = (components: ReadonlyArray<number>): number => {
	let sum = 0
	for (const x of components) {
		sum += x * x
	}
	return Math.sqrt(sum)
}

const isLowerHex = (ch: string): boolean =>
	isAsciiDigit(ch.charCodeAt(0)) || (ch >= "a" && ch <= "f")

/** Whether `text` is the canonical UUID text: lowercase hex digits in groups of 8, 4, 4, 4 and 12, joined by hyphens. */
const isUuidText = (text: string): boolean =>
	text.length === uuidTextLength &&
	Array.from(text).every((ch, i) => (uuidHyphens.has(i) ? ch === "-" : isLowerHex(ch)))

/**
 * Host text grizzle can store: well-formed UTF-16 (no lone surrogate) and no NUL, which PostgreSQL text cannot hold.
 */
const isStorableText = (text: string): boolean => text.isWellFormed() && !text.includes("\u0000")

/**
 * A span literal's range text, `[start,end)`, as its type's range input reads it: its integers, or over dates the
 * dates its day numbers are.
 */
export const spanLiteralText = (
	literal: { readonly start: bigint; readonly end: bigint },
	type: ScalarType
): string =>
	baseOf(type).carrier === "rangeDate"
		? `[${dateOfDayNumber(literal.start)},${dateOfDayNumber(literal.end)})`
		: `[${literal.start.toString()},${literal.end.toString()})`

/**
 * A date span literal's endpoints, day numbers from 0001-01-01's: a span's endpoints are dates a CalendarDate spells,
 * its exclusive end among them.
 */
const dayRange: readonly [bigint, bigint] = [0n, BigInt(dayNumber(lastCalendarDate))]

const inRange = (value: bigint, [lo, hi]: readonly [bigint, bigint]): boolean =>
	value >= lo && value <= hi

/**
 * Why `handles` is not a set over the roster `closed` of `roster`'s handles, or undefined when it is: each a handle of
 * the roster, in the roster's declared order, each once, so one set has one literal.
 */
const handlesProblem = (
	handles: ReadonlyArray<string>,
	roster: ReadonlyArray<string>,
	closed: string
): string | undefined => {
	let before = -1
	for (const handle of handles) {
		const position = roster.indexOf(handle)
		if (position < 0) {
			return `${JSON.stringify(handle)} is not a handle of ${closed}`
		}
		if (position <= before) {
			return `a set's handles are distinct and in ${closed}'s declared order`
		}
		before = position
	}
	return undefined
}

/**
 * Why the decimal `value` is not exactly a value of numeric(p, s), or undefined when it is. A value that numeric(p,
 * s) would round, or whose rounded magnitude needs more than p - s integer digits (negative scales included), or an
 * infinity, is refused: PostgreSQL would change the value or fail at run time. NaN is a value of every numeric typmod
 * but numeric(p, 0), whose values are integers held as bigints (ir/carriers.ts isIntegerTypmod).
 */
const numericTypmodProblem = (value: DecimalValue, typmod: NumericTypmod): string | undefined => {
	const { precision, scale } = typmod
	const label = `numeric(${precision},${scale})`
	const parts: DecimalParts = value.parts
	switch (parts.kind) {
		case "nan":
			return isIntegerTypmod(typmod) ? `${label} holds integers alone, never NaN` : undefined
		case "infinity":
		case "-infinity":
			return `${label} cannot hold an infinite value`
		case "finite": {
			const { coefficient, minScale } = parts
			if (coefficient === 0n) {
				return undefined
			}
			const shift = scale - minScale
			if (shift < 0 && coefficient % 10n ** BigInt(-shift) !== 0n) {
				return `${decimalPayload(value)} has more fractional digits than ${label} keeps; it would round`
			}
			const units =
				shift >= 0 ? coefficient * 10n ** BigInt(shift) : coefficient / 10n ** BigInt(-shift)
			return units >= 10n ** BigInt(precision)
				? `${decimalPayload(value)} overflows ${label}`
				: undefined
		}
	}
}

/**
 * Why an exact value, `units` at `scale` fraction digits, is no value of the exact type `type` of `digits` integer
 * digits, |x| < 10^digits (ir/scalar.ts ExactType), or undefined where it is one: a literal takes an exact type as any
 * type, its host value a value of it within its digits, and one past them is refused naming the bound.
 */
const exactProblem = (
	units: bigint,
	scale: number,
	digits: number,
	shown: string,
	type: ScalarType
): string | undefined =>
	belowPowerOfTen(units < 0n ? -units : units, digits + scale)
		? undefined
		: `${shown} lies outside ${typeLabel(type)}, whose values are below 10^${digits} in magnitude`

/** A literal's identity under PostgreSQL's native equality: two literals are equal exactly when their keys are. */
export type EqualityKey = string & { readonly [equalityKeyBrand]: true }
declare const equalityKeyBrand: unique symbol
const equalityKey = nominal<string, EqualityKey>()

/**
 * A literal's key under PostgreSQL's native equality, for comparing discriminant tuples and closed facts and deciding a
 * key, a distinctness or a selection by literals: its canonical text, since every literal holds its value in the one
 * form (a decimal without display scale), but a float's -0, which that equality holds equal to +0 and keys as +0, as a
 * key text does (scalar/values/identity.ts keyText), where its canonical text, its identity, tells the two zeros apart.
 * A column is fixed to a literal, or two columns are one, by their literals' identities (canonicalTextOf), so the
 * literal read for the column is the column's own value. The literal is a value of its type (literalProblem), which
 * encodes.
 */
export const nativeEqualityKey = (literal: TypedLiteral): EqualityKey =>
	equalityKey(
		canonicalTextOf(
			literal.kind === "floatSpecial" && literal.value === "-0" ? floatLiteral(0) : literal
		)
	)

/**
 * The integer a literal is, or undefined: an int literal, or a finite numeric literal whose least scale is 0. A
 * numeric literal is in its one form, so 1.0 is the integer 1.
 */
export const integerLiteral = (literal: TypedLiteral): bigint | undefined => {
	switch (literal.kind) {
		case "int":
			return literal.value
		case "numeric": {
			const parts = literal.value.parts
			return parts.kind === "finite" && parts.minScale === 0
				? parts.negative
					? -parts.coefficient
					: parts.coefficient
				: undefined
		}
		case "float":
		case "floatSpecial":
		case "money":
		case "bool":
		case "text":
		case "uuid":
		case "sha256":
		case "date":
		case "inet":
		case "cidr":
		case "handle":
		case "handles":
		case "span":
		case "vector":
		case "pattern":
			return undefined
	}
}

/**
 * Why `literal` cannot be a value of `type`, or undefined when it can: a handle is one of its roster's, and one of the
 * subset a closed id of a subset holds, so a typed literal's type is a type its value is of. The type's refinements (a
 * contract predicate, a regex) are not evaluated here: checking a literal against them is the ContractLiteral check. A computed numeric,
 * numeric of no typmod, holds every numeric value: its bound is what the node's making proves (scalar/compute/lower.ts
 * literalNode types a literal by its own value), never a domain a literal adopting it is checked against.
 */
export const literalProblem = (literal: TypedLiteral, outer: ScalarType): string | undefined => {
	/** A contract's value is a value of its base: its typmod, roster and dimensions are the base's. */
	const type = baseOf(outer)
	const { carrier } = type
	switch (literal.kind) {
		case "int": {
			if (type.carrier === "exactInteger") {
				return exactProblem(literal.value, 0, type.digits, String(literal.value), type)
			}
			const range =
				carrier === "int2" || carrier === "int4" || carrier === "int8"
					? integerRanges[carrier]
					: undefined
			if (range === undefined) {
				return `an int literal is not a ${carrier} value`
			}
			return inRange(literal.value, range) ? undefined : `${literal.value} lies outside ${carrier}`
		}
		case "numeric":
			if (carrier !== "numeric") {
				return `a numeric literal is not a ${carrier} value`
			}
			return type.typmod === undefined
				? undefined
				: numericTypmodProblem(literal.value, type.typmod)
		case "float":
			if (carrier === "float8") {
				return undefined
			}
			if (carrier !== "float4") {
				return `a float literal is not a ${carrier} value`
			}
			return Math.fround(literal.value) === literal.value
				? undefined
				: "a float4 literal is exactly a float32 value"
		case "floatSpecial":
			return carrier === "float4" || carrier === "float8"
				? undefined
				: `a float literal is not a ${carrier} value`
		case "money":
			if (type.carrier === "exactMoney") {
				const units = moneyMinorUnits(literal.value)
				return exactProblem(units, moneyFractionDigits, type.digits, `${units} minor units`, type)
			}
			return carrier === "money" ? undefined : `a money literal is not a ${carrier} value`
		case "bool":
			return carrier === "bool" ? undefined : `a boolean literal is not a ${carrier} value`
		case "text":
			if (carrier !== "text") {
				return `a text literal is not a ${carrier} value`
			}
			return isStorableText(literal.value) ? undefined : "text is well-formed UTF-16 without NUL"
		case "uuid":
			if (carrier !== "uuid") {
				return `a uuid literal is not a ${carrier} value`
			}
			return isUuidText(literal.value) ? undefined : "a uuid literal is lowercase 8-4-4-4-12 hex"
		case "sha256":
			if (carrier !== "sha256") {
				return `a digest literal is not a ${carrier} value`
			}
			return isSha256Text(literal.value)
				? undefined
				: "a digest literal is \\x and 64 lowercase hex digits"
		case "date":
			if (carrier !== "date") {
				return `a date literal is not a ${carrier} value`
			}
			return toCalendarDate(literal.value).ok
				? undefined
				: "a date literal is a day from 0001-01-01 to 9999-12-31, written YYYY-MM-DD"
		case "inet":
			if (carrier !== "inet") {
				return `an inet literal is not a ${carrier} value`
			}
			return isInetText(literal.value)
				? undefined
				: "an inet literal is its value's one text, as inet_out prints it"
		case "cidr":
			if (carrier !== "cidr") {
				return `a cidr literal is not a ${carrier} value`
			}
			return isCidrText(literal.value)
				? undefined
				: "a cidr literal is its value's one text, as cidr_out prints it"
		case "handle":
			if (carrier !== "code") {
				return `a handle literal is not a ${carrier} value`
			}
			return !type.roster.handles.includes(literal.handle)
				? `${JSON.stringify(literal.handle)} is not a handle of ${type.roster.closed}`
				: type.only !== undefined && !type.only.includes(literal.handle)
					? `${JSON.stringify(literal.handle)} is not a handle of the subset of ${type.roster.closed} its type holds (${type.only.join(", ")})`
					: undefined
		case "handles":
			if (carrier !== "bits") {
				return `a set literal is not a ${carrier} value`
			}
			return handlesProblem(literal.handles, type.roster.handles, type.roster.closed)
		case "span": {
			const range =
				carrier === "range4"
					? integerRanges.int4
					: carrier === "range8"
						? integerRanges.int8
						: carrier === "rangeDate"
							? dayRange
							: undefined
			if (range === undefined) {
				return `a range literal is not a ${carrier} value`
			}
			if (!(literal.start < literal.end)) {
				return "a range has start < end"
			}
			return inRange(literal.start, range) && inRange(literal.end, range)
				? undefined
				: `a range endpoint lies outside ${carrier}`
		}
		case "vector": {
			if (carrier !== "vector") {
				return `a vector literal is not a ${carrier} value`
			}
			const { components } = literal.value
			if (components.length !== type.typmod.dims) {
				return `a vector literal has ${type.typmod.dims} components`
			}
			const norm = nativeNorm(components)
			return norm >= cosineNormMin && norm <= cosineNormMax
				? undefined
				: `a vector literal whose native norm lies in the cosine domain [${cosineNormMin}, ${cosineNormMax}]`
		}
		case "pattern":
			if (carrier !== "text") {
				return `a pattern literal is not a ${carrier} value`
			}
			return isStorableText(literal.value.spelling)
				? undefined
				: "a pattern's spelling is well-formed UTF-16 without NUL"
	}
}

/**
 * The closure of `roots` over their arguments, each expression once, breadth-first in first-visit order: the roots in
 * order, then their arguments in operand order.
 */
export const exprClosure = (roots: ReadonlyArray<ScalarExpr>): ReadonlyArray<ScalarExpr> => {
	const seen = new Set<ScalarExpr>()
	const queue = [...roots]
	for (const e of queue) {
		if (seen.has(e)) {
			continue
		}
		seen.add(e)
		appendAll(queue, e.args)
	}
	return [...seen]
}

/**
 * Whether the expression trees `roots` evaluate a declared function's call (`call`) anywhere: a node whose expressions
 * do evaluates it once for each row of its input, so it is a boundary of that evaluation. A function is called once per
 * distinct row it is evaluated over: the node observes its input's repeats (analysis/physical/consumers.ts), so its
 * input is a set before it; navigation keeps a rule whose head calls one whole where it reads it, never inlined into the
 * rule that matches it (analysis/theory/navigate.ts sharedImports), so its call is evaluated over its own rows; and
 * PostgreSQL never pulls the call into the query that reads the node's rows, where it would run again for every row
 * that query joins to one of the node's: the call's refusal of a NULL it returns calls the refusal function
 * (lower/conservative/expr declaredCall), which is VOLATILE (write/refusal.ts), and PostgreSQL pulls up no subquery
 * whose outputs call a volatile function (src/backend/optimizer/prep/prepjointree.c is_simple_subquery).
 */
export const evaluatesCall = (roots: ReadonlyArray<ScalarExpr>): boolean =>
	exprClosure(roots).some((e) => e.kind === "call")

/** The columns the expressions `exprs` read, each a column among them, in their order. */
const columnsAmong = (exprs: ReadonlyArray<ScalarExpr | TableExpr>): ReadonlyArray<ColumnRef> =>
	exprs.flatMap((e) => (e.kind === "column" ? [e.column] : []))

/**
 * The columns the expression trees `roots` read, each column of their closure once, in its first-visit order
 * (exprClosure): the one reading of the columns an expression reads, iterative, which tableReads is of a table.
 */
export const columnReads = (roots: ReadonlyArray<ScalarExpr>): ReadonlyArray<ColumnRef> =>
	columnsAmong(exprClosure(roots))

/** The fields the expression trees `roots` read of their row, by name, each once, in columnReads's order. */
export const fieldReads = (roots: ReadonlyArray<ScalarExpr>): ReadonlyArray<string> => [
	...new Set(columnReads(roots).map((c) => c.name))
]

/** The closed relations the expression trees `roots` read, by C.at, C.row or C.has, each once, in exprClosure's
 * order. */
export const closedRelationsRead = (roots: ReadonlyArray<ScalarExpr>): ReadonlyArray<string> => [
	...new Set(
		exprClosure(roots).flatMap((e) =>
			e.kind === "closedAt" || e.kind === "closedRow" || e.kind === "closedHas" ? [e.relation] : []
		)
	)
]

/**
 * The kinds a domain's predicate reads VALUE through: a literal, an operator, a cast, a conditional, and a variant's
 * operation, an arm check's read of its arm's fields of a variant's VALUE (kindProblems `variant`).
 */
const predicateKinds: ReadonlyArray<ExprKind> = [
	"value",
	"literal",
	"op",
	"cast",
	"cond",
	"variant"
]

const tableAt = (exprs: Readonly<Record<ExprId, TableExpr>>, id: ExprId): TableExpr | undefined =>
	Object.hasOwn(exprs, id) ? exprs[id] : undefined

const normalName = (index: number): ExprId => ExprId(`e#${index}`)

/**
 * The normal form of the predicate tree rooted at `root`: its expressions numbered "e#0" from the root and then
 * breadth-first through the arguments in operand order, each at its first occurrence, every argument by its number.
 * The number of an expression met for the first time is minted as it is met, so every argument has one.
 */
/** The field names an expression's table reads of its row, each once, in the table's order (fieldReads of a tree). */
export const tableReads = (table: ExprTable): ReadonlyArray<string> => [
	...new Set(columnsAmong(Object.values(table.exprs)).map((c) => c.name))
]

export const predicateTable = (root: ScalarExpr): ExprTable => {
	const names = new Map<ScalarExpr, ExprId>()
	const queue: Array<ScalarExpr> = []
	const nameOf = (e: ScalarExpr): ExprId => {
		const known = names.get(e)
		if (known !== undefined) {
			return known
		}
		const name = normalName(names.size)
		names.set(e, name)
		queue.push(e)
		return name
	}
	const rootName = nameOf(root)
	const exprs: Record<ExprId, TableExpr> = {}
	for (const e of queue) {
		const id = nameOf(e)
		const spec = withArgs<LiveArgs, TableArgs>(outsideSpec(e), nameOf)
		exprs[id] = Object.freeze({
			...spec,
			volatility: e.volatility,
			id,
			deps: e.deps
		})
	}
	return Object.freeze({ root: rootName, exprs: Object.freeze(exprs) })
}

/**
 * The first argument that reaches itself among the expressions `exprs` holds, by an iterative depth-first search from
 * each of `starts` in order; undefined when the arguments are acyclic. A dangling argument is not followed.
 */
export const firstArgumentCycle = (
	exprs: Readonly<Record<ExprId, TableExpr>>,
	starts: ReadonlyArray<ExprId>
): ExprId | undefined => {
	const state = new Map<ExprId, "open" | "done">()
	const walk = (start: ExprId): ExprId | undefined => {
		const stack: Array<{ readonly id: ExprId; next: number }> = [{ id: start, next: 0 }]
		state.set(start, "open")
		for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
			const a = tableAt(exprs, frame.id)?.args[frame.next]
			if (a === undefined) {
				stack.pop()
				state.set(frame.id, "done")
				continue
			}
			frame.next++
			const argState = state.get(a)
			if (tableAt(exprs, a) !== undefined && argState === "open") {
				return a
			}
			if (tableAt(exprs, a) !== undefined && argState === undefined) {
				state.set(a, "open")
				stack.push({ id: a, next: 0 })
			}
		}
		return undefined
	}
	for (const start of starts) {
		const cycle = state.has(start) ? undefined : walk(start)
		if (cycle !== undefined) {
			return cycle
		}
	}
	return undefined
}

/**
 * The predicate tree a table holds, parsed once: each entry built over its arguments (builtExpr), under its table
 * identifier. A dangling argument or an argument that reaches itself is MalformedDescription, the refusal of a table no
 * construction made (a hand-edited snapshot).
 */
export const predicateTree = (table: ExprTable): Result.Result<ScalarExpr, CompileError> =>
	catchRefusal(() => {
		const cycle = firstArgumentCycle(table.exprs, [table.root])
		if (cycle !== undefined) {
			throw new Refusal(
				S.malformedAt("contract predicate", ["exprs", cycle], "acyclic predicate arguments")
			)
		}
		const parsed = new Fold<ExprId, ScalarExpr>(function* (id) {
			const entry = tableAt(table.exprs, id)
			if (entry === undefined) {
				throw new Refusal(
					S.malformedAt("contract predicate", ["exprs"], `an expression named ${id} in the table`)
				)
			}
			const spec = yield* mapArgs<TableArgs, LiveArgs>(entry)
			return builtExpr(spec, id)
		})
		return parsed.of(table.root)
	})

/** The problems of the entry under `key` in a predicate table over a domain whose VALUE has type `base`. */
const entryProblems = (
	table: ExprTable,
	key: string,
	expr: TableExpr,
	base: ScalarType
): ReadonlyArray<string> => {
	const at = `predicate ${key}`
	const args = expr.args.flatMap((a) => tableAt(table.exprs, a) ?? [])
	return [
		...(expr.id === key ? [] : [`the table key equal to the expression's id ${expr.id}`]),
		...(predicateKinds.includes(expr.kind)
			? []
			: [`VALUE, literals, operators, casts and conditionals only, not ${expr.kind}`]),
		...(expr.deps.params.length > 0 || expr.deps.nodes.length > 0
			? ["no parameter or node dependencies; a predicate reads only VALUE"]
			: []),
		...(expr.volatility === "immutable" ? [] : ["immutable"]),
		...kindProblems(expr, args, base)
	].map((problem) => `${at}: ${problem}`)
}

/**
 * The types a branch of a conditional of type `type` stands at: its own, and its entered type (scalar.ts enteredType),
 * what a binary coercion into it delivers (scalar/compute/typing.ts castNode), since a coercion drops what only a
 * domain enforces and never adds it. They are one type where `type` is no pattern's text. A branch of a type either
 * subsumes (scalar.ts subsumes) stands there with no node of its own: a coercion into it builds none (bbfa4eca06), so a
 * refined text's branch of a conditional of another refinement is the branch as it stands.
 */
const branchTypes = (type: ScalarType): readonly [ScalarType, ScalarType] => [
	type,
	enteredType(type)
]

/**
 * The problems of a conditional of type `type`, given its arguments, a dangling one left out: its condition is boolean
 * and each branch stands at one of its branch types (branchTypes).
 */
export const condProblems = (
	type: ScalarType,
	args: ReadonlyArray<{ readonly type: ScalarType }>
): ReadonlyArray<string> => {
	const [p, t, e] = args
	const typed = branchTypes(type)
	const branchesTyped =
		t === undefined ||
		e === undefined ||
		[t, e].every((b) => typed.some((branch) => subsumes(branch, b.type)))
	return [
		...(p !== undefined && baseOf(p.type).carrier !== "bool" ? ["a boolean condition"] : []),
		...(branchesTyped
			? []
			: [
					`both branches of a type the conditional's own type ${typeLabel(type)} or its entered type subsumes, not ${typeLabel(t.type)} and ${typeLabel(e.type)}`
				])
	]
}

/** The problems a predicate entry's kind has of its own, given its arguments' entries. */
const kindProblems = (
	expr: TableExpr,
	args: ReadonlyArray<TableExpr>,
	base: ScalarType
): ReadonlyArray<string> => {
	switch (expr.kind) {
		case "value":
			return sameScalarType(expr.type, base) ? [] : ["VALUE at the contract's base type"]
		case "literal": {
			const problem = literalProblem(expr.value, expr.type)
			return problem === undefined ? [] : [problem]
		}
		case "cond":
			return condProblems(expr.type, args)
		case "variant":
			return baseOf(base).carrier === "variant" && expr.op.kind === "field"
				? []
				: ["a variant's operation only as an arm check's read of a field of its variant's VALUE"]
		case "column":
		case "param":
		case "domainCast":
		case "op":
		case "cast":
		case "closedAt":
		case "closedRow":
		case "closedHas":
		case "call":
			return []
	}
}

/**
 * The entries reachable from the root, in normal-form order: the root, then breadth-first through the arguments in
 * operand order, each at its first occurrence. A dangling argument is reported, not followed.
 */
const normalOrder = (
	table: ExprTable
): { readonly order: ReadonlyArray<ExprId>; readonly dangling: ReadonlySet<ExprId> } => {
	const seen = new Set<ExprId>()
	const dangling = new Set<ExprId>()
	const order: Array<ExprId> = []
	const queue: Array<ExprId> = [table.root]
	for (const id of queue) {
		if (seen.has(id) || dangling.has(id)) {
			continue
		}
		const expr = tableAt(table.exprs, id)
		if (expr === undefined) {
			dangling.add(id)
			continue
		}
		seen.add(id)
		order.push(id)
		appendAll(queue, expr.args)
	}
	return { order, dangling }
}

/**
 * Why `table` is not a well-formed predicate over a domain whose VALUE has type `base`, each problem one line of prose.
 * The predicate is in normal form; it is acyclic and every argument resolves; it reads only VALUE and literals
 * through operators, casts and conditionals, with no parameter, no column and no domain cast; it is immutable; and its
 * root is boolean.
 */
export const predicateProblems = (table: ExprTable, base: ScalarType): ReadonlyArray<string> => {
	const problems: Array<string> = []
	const { order, dangling } = normalOrder(table)
	if (tableAt(table.exprs, table.root) === undefined) {
		problems.push(`a predicate root named ${table.root} in its table`)
	}
	for (const id of dangling) {
		if (id !== table.root) {
			problems.push(`an argument named ${id} in the predicate table`)
		}
	}
	const reachable = new Set(order)
	for (const key of Object.keys(table.exprs)) {
		if (!reachable.has(ExprId(key))) {
			problems.push(`a predicate table of reachable entries only, not ${key}`)
		}
	}
	for (const [i, id] of order.entries()) {
		if (id !== normalName(i)) {
			problems.push(
				`a predicate in normal form: ${id} is e#${i}, numbered from the root breadth-first`
			)
		}
	}
	const cycle = firstArgumentCycle(table.exprs, order)
	if (cycle !== undefined) {
		problems.push(`acyclic predicate arguments: ${cycle} reaches itself`)
		return problems
	}
	for (const [key, expr] of Object.entries(table.exprs)) {
		appendAll(problems, entryProblems(table, key, expr, base))
	}
	const root = tableAt(table.exprs, table.root)
	if (root !== undefined && baseOf(root.type).carrier !== "bool") {
		problems.push("a boolean predicate root")
	}
	return problems
}
