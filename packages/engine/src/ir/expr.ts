import { appendAll } from "#compiler/core/array.ts"
import { nominal } from "#compiler/core/brand.ts"
import { canonicalTextOf, catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { IdentityValue } from "#compiler/core/identity.ts"
import { ExprId, type NodeId, type ParamId } from "#compiler/core/ids.ts"
import { type Comparator, combine, compareStrings, mapInput } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import type { CanonicalFloat, MoneyValue, VectorText } from "#compiler/ir/carriers.ts"
import { type DecimalParts, type DecimalValue, decimalPayload } from "#compiler/ir/decimal.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import type { PreconditionProof } from "#compiler/ir/proof.ts"
import {
	baseOf,
	type NumericTypmod,
	type ScalarType,
	type SpanCarrier,
	sameScalarType
} from "#compiler/ir/scalar.ts"
import * as S from "#compiler/ir/shape.ts"

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
		range8: rangeOpId(Object.freeze({ code, carrier: "range8" }))
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

export type OpId = CatalogOpId | RangeOpId

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
const rangeOpOrder: Comparator<RangeOpId> = combine(
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
	"cond"
] as const
type ExprKind = (typeof exprKinds)[number]

/** How a parameter's placeholder is cast: compare binds the base type; write and emit cast to the domain. */
export type ParamRole = "compare" | "write" | "emit"

export type Volatility = "immutable" | "stable"

export interface ColumnRef {
	readonly node: NodeId
	readonly name: string
}

/**
 * A typed literal ("every literal is a typed literal"). The kind fixes the host representation and the
 * expression's type fixes the native type, and the two agree (literalProblem). Decimal, Money and Vector values are
 * held parsed and spell their canonical tags from their parts: the owned Decimal and Money travel here unchanged, and a
 * Vector as the frozen snapshot of its components (Vector.canonical).
 */
export type TypedLiteral =
	| { readonly kind: "int"; readonly value: bigint }
	| { readonly kind: "numeric"; readonly value: DecimalValue }
	| { readonly kind: "float"; readonly value: CanonicalFloat }
	| { readonly kind: "floatSpecial"; readonly value: "NaN" | "Infinity" | "-Infinity" }
	| { readonly kind: "money"; readonly value: MoneyValue }
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "uuid"; readonly value: string }
	| { readonly kind: "enum"; readonly handle: string }
	| { readonly kind: "span"; readonly start: bigint; readonly end: bigint }
	| { readonly kind: "vector"; readonly value: VectorText }

/**
 * A literal as an identity of the naming door takes it (core/identity.ts): its canonical text as its part, a boolean or
 * integer as written, a handle or text as its words for its stem, any other kind by its kind.
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
		case "enum":
			return { part, stem: value.handle, display: value.handle }
		case "text":
			return { part, stem: value.value, display: JSON.stringify(value.value) }
		case "numeric":
		case "float":
		case "floatSpecial":
		case "money":
		case "uuid":
		case "span":
		case "vector":
			return { part, stem: value.kind, display: part }
	}
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
 * which PostgreSQL validates, always does.
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
			readonly op: PartialOp
			readonly args: ReadonlyArray<R["expr"]>
			readonly nonNull: "strict"
			readonly volatility: Volatility
			readonly proof: PreconditionProof
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
			readonly cast: PartialOp
			readonly args: readonly [R["expr"]]
			readonly nonNull: "strict"
			readonly volatility: Volatility
			readonly proof: PreconditionProof
	  }
	| {
			readonly kind: "domainCast"
			readonly args: readonly [R["expr"]]
			readonly nonNull: "strict"
			readonly proof: PreconditionProof
	  }
	| {
			readonly kind: "cond"
			readonly args: readonly [R["expr"], R["expr"], R["expr"]]
			readonly nonNull: "cond"
	  }
)

/** An expression as a builder states it: its kind, its type, and its argument expressions themselves. */
export type ExprSpec = ExprSpecOver<LiveArgs>

/**
 * The scalar expression IR.
 *
 * One node is exactly one PostgreSQL operator, function, or cast: the vocabulary is the Compute
 * catalogue, with no library-defined composite operation. Each node records its exact native overload, its argument
 * expressions, its output descriptor, its non-null proof, its volatility, and its dependencies. No node raises on a
 * value its operands admit: the registry's Totality of its overload says how it is defined on every one, and the
 * Compute lowering emits a partial overload only with the proof of its precondition.
 * There is no NULL literal, no COALESCE and no NULLIF node: absence is zero rows.
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
			return { volatility: spec.volatility }
		case "domainCast":
		case "column":
		case "value":
		case "param":
		case "literal":
		case "cond":
			return pure
	}
}

/**
 * The effects of an expression of `spec` over arguments of effects `args`: its own joined with theirs, so a stable
 * argument makes its reader stable. The one rule every expression derives effects by: builtExpr, a contract
 * predicate's table, the rewrite editors and the Compute lowering.
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
 * The expression of `spec` labelled `id`, with what its arguments derive: its dependencies, its own parameter or column
 * source with every argument's, and its effects (exprEffects). The one constructor of an expression, frozen; its
 * arguments are expressions built before it, so what they derive is final.
 */
export const builtExpr = (spec: ExprSpec, id: ExprId): ScalarExpr => {
	const params = new Set<ParamId>()
	const nodes = new Set<NodeId>()
	if (spec.kind === "param") {
		params.add(spec.param)
	}
	if (spec.kind === "column") {
		nodes.add(spec.column.node)
	}
	for (const a of spec.args) {
		for (const p of a.deps.params) {
			params.add(p)
		}
		for (const n of a.deps.nodes) {
			nodes.add(n)
		}
	}
	return Object.freeze({
		...spec,
		...exprEffects(spec, spec.args),
		id,
		deps: Object.freeze({ params: sortedUnique(params), nodes: sortedUnique(nodes) }),
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
export const sameArgs = (before: ExprSpec, after: ExprSpec): boolean => {
	const was: ReadonlyArray<ScalarExpr> = before.args
	const now: ReadonlyArray<ScalarExpr> = after.args
	return was.length === now.length && was.every((a, i) => now[i] === a)
}

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

const int2Range = [-32768n, 32767n] as const
const int4Range = [-2147483648n, 2147483647n] as const
const int8Range = [-9223372036854775808n, 9223372036854775807n] as const

/** Where the canonical UUID text has its hyphens, between hex groups of 8, 4, 4, 4 and 12 digits. */
const uuidHyphens: ReadonlySet<number> = new Set([8, 13, 18, 23])

const isLowerHex = (ch: string): boolean => (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f")

/** Whether `text` is the canonical UUID text: lowercase hex digits in groups of 8, 4, 4, 4 and 12, joined by hyphens. */
const isUuidText = (text: string): boolean =>
	text.length === 36 &&
	Array.from(text).every((ch, i) => (uuidHyphens.has(i) ? ch === "-" : isLowerHex(ch)))

/**
 * Host text grizzle can store: well-formed UTF-16 (no lone surrogate) and no NUL, which PostgreSQL text cannot hold.
 */
const isStorableText = (text: string): boolean => text.isWellFormed() && !text.includes("\u0000")

const inRange = (value: bigint, [lo, hi]: readonly [bigint, bigint]): boolean =>
	value >= lo && value <= hi

/**
 * Why the decimal `value` is not exactly a value of numeric(p, s), or undefined when it is. A value that numeric(p,
 * s) would round, or whose rounded magnitude needs more than p - s integer digits (negative scales included), or an
 * infinity, is refused: PostgreSQL would change the value or fail at run time. NaN is a
 * value of every numeric typmod. Without a precision the type is unconstrained numeric and holds every value.
 */
const numericTypmodProblem = (
	value: DecimalValue,
	typmod: NumericTypmod | undefined
): string | undefined => {
	if (typmod === undefined) {
		return undefined
	}
	const { precision, scale } = typmod
	const label = `numeric(${precision},${scale})`
	const parts: DecimalParts = value.parts
	switch (parts.kind) {
		case "nan":
			return undefined
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

/** A literal's identity under PostgreSQL's native equality: two literals are equal exactly when their keys are. */
export type EqualityKey = string & { readonly [equalityKeyBrand]: true }
declare const equalityKeyBrand: unique symbol
const equalityKey = nominal<string, EqualityKey>()

/**
 * The native identity of a literal, for comparing discriminant tuples and closed facts: its canonical text, since
 * every literal holds its value in the one form (a decimal without display scale, a float with one zero). The literal
 * is a value of its type (literalProblem), which encodes.
 */
export const nativeEqualityKey = (literal: TypedLiteral): EqualityKey =>
	equalityKey(canonicalTextOf(literal))

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
		case "enum":
		case "span":
		case "vector":
			return undefined
	}
}

/**
 * Why `literal` cannot be a value of `type`, or undefined when it can. The type's refinements (a contract predicate,
 * a regex) are not evaluated here: checking a literal against them is the ContractLiteral check.
 */
export const literalProblem = (literal: TypedLiteral, outer: ScalarType): string | undefined => {
	/** A contract's value is a value of its base: its typmod, roster and dimensions are the base's. */
	const type = baseOf(outer)
	const { carrier } = type
	switch (literal.kind) {
		case "int": {
			const range =
				carrier === "int2"
					? int2Range
					: carrier === "int4"
						? int4Range
						: carrier === "int8"
							? int8Range
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
			return numericTypmodProblem(literal.value, type.typmod)
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
		case "enum":
			if (carrier !== "enum") {
				return `an enum literal is not a ${carrier} value`
			}
			return type.roster.handles.includes(literal.handle)
				? undefined
				: `${JSON.stringify(literal.handle)} is not a handle of ${type.roster.closed}`
		case "span": {
			const range = carrier === "range4" ? int4Range : carrier === "range8" ? int8Range : undefined
			if (range === undefined) {
				return `a span literal is not a ${carrier} value`
			}
			if (!(literal.start < literal.end)) {
				return "a span has start < end"
			}
			return inRange(literal.start, range) && inRange(literal.end, range)
				? undefined
				: `a span endpoint lies outside ${carrier}`
		}
		case "vector": {
			if (carrier !== "vector") {
				return `a vector literal is not a ${carrier} value`
			}
			const { components } = literal.value
			if (components.length !== type.typmod.dims) {
				return `a vector literal has ${type.typmod.dims} components`
			}
			/**
			 * A vector literal lies in the cosine domain: vector_norm, summed in double, in [2^-16, 2^16]
			 * (scalar/values/vector.ts norm).
			 */
			let sum = 0
			for (const x of components) {
				sum += x * x
			}
			const norm = Math.sqrt(sum)
			return norm >= 2 ** -16 && norm <= 2 ** 16
				? undefined
				: "a vector literal whose native norm lies in the cosine domain [2^-16, 2^16]"
		}
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

const predicateKinds: ReadonlyArray<ExprKind> = ["value", "literal", "op", "cast", "cond"]

const tableAt = (exprs: Readonly<Record<ExprId, TableExpr>>, id: ExprId): TableExpr | undefined =>
	Object.hasOwn(exprs, id) ? exprs[id] : undefined

const normalName = (index: number): ExprId => ExprId(`e#${index}`)

/**
 * The normal form of the predicate tree rooted at `root`: its expressions numbered "e#0" from the root and then
 * breadth-first through the arguments in operand order, each at its first occurrence, every argument by its number.
 * The number of an expression met for the first time is minted as it is met, so every argument has one.
 */
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

/** The table renamed to its normal form, unreachable entries dropped. A dangling argument is MalformedDescription. */
export const normalizeExprTable = (table: ExprTable): Result.Result<ExprTable, CompileError> =>
	Result.map(predicateTree(table), predicateTable)

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
 * The problems of a conditional of type `type`, given its arguments, a dangling one left out: its condition is boolean
 * and both branches have its own type.
 */
export const condProblems = (
	type: ScalarType,
	args: ReadonlyArray<{ readonly type: ScalarType }>
): ReadonlyArray<string> => {
	const [p, t, e] = args
	const branchesTyped =
		t === undefined ||
		e === undefined ||
		(sameScalarType(t.type, type) && sameScalarType(e.type, type))
	return [
		...(p !== undefined && baseOf(p.type).carrier !== "bool" ? ["a boolean condition"] : []),
		...(branchesTyped ? [] : ["both branches of the conditional's own type"])
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
		case "column":
		case "param":
		case "domainCast":
		case "op":
		case "cast":
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
