import { boolean, constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Formatter, Option } from "effect"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import type {
	CompareOp,
	ComputeFn,
	ExprDesc,
	FieldDesc,
	GuardDesc,
	LiteralDesc,
	ScaledComputeFn
} from "#compiler/ir/desc.ts"
import type { ExprSpec, ScalarExpr } from "#compiler/ir/expr.ts"
import type { Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import {
	baseOf,
	type Carrier,
	contractOf,
	exactDigitsOf,
	rosterOf,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import { digitsOfExact, exactOf } from "#compiler/scalar/compute/bounds.ts"
import {
	type LowerEnv,
	lowerPredicate,
	lowerTerm,
	noClosedRelations
} from "#compiler/scalar/compute/lower.ts"
import { firstOperand, nativeOps } from "#compiler/scalar/compute/registry.ts"
import {
	anyNumeric,
	commonType,
	exactType,
	isComputedNumeric,
	meets as engineMeets,
	meetingType,
	mixesExact
} from "#compiler/scalar/compute/types.ts"
import { type PlainCarrier, plainType } from "#compiler/scalar/native.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { bareEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { noExtension } from "#test/support/compute.ts"
import {
	fieldDescOf,
	floatSpecialSketches,
	numeric,
	numericPaddings,
	type ValueSketch
} from "#test/support/oracle/gen/domain.ts"
import { at, nonEmptyList } from "#test/support/oracle/pick.ts"

/**
 * Generated scalar computation inside queries: arithmetic, casts, CASE and the rest of the Compute catalogue.
 *
 * A term is arithmetic, a cast, a conditional or a LEAST/GREATEST over a node's input columns, literals and scalar
 * parameters, drawn from the Compute catalogue (packages/engine/src/scalar/compute/registry.ts). The generator builds the
 * ExprDesc the public builders record and types it with the checker's own resolution, lowerTerm and lowerPredicate in
 * "query" mode (packages/engine/src/scalar/compute/lower.ts), so every node is the one the checker would emit: the exact
 * native overload, the composite lowerings the registry records (sign over an integer, gcd over smallint), the
 * literal's adopted type, and each partial operation's proof.
 *
 * Every term is total, as every term a program writes is: integer and money arithmetic is exact, float arithmetic
 * IEEE 754, and each partial operation stands under the guard that proves its precondition, as a program writes it
 * (Compute.when): a division under its divisor's nonzero guard, a numeric square root under its radicand's
 * nonnegative one, every cast from a numeric-family value under a `within` guard whose bounds prove its range, and
 * the otherwise branch a value of the branch's type. A literal divisor is nonzero by its own value.
 *
 * The sketch is a tree of plain numbers resolved against the input heading: each choice reduced modulo what fits the
 * operand carriers in scope, and a choice with nothing to choose from degrading to a column, so every sketch resolves
 * and shrinking keeps it valid.
 *
 * A `pad` is a numeric padded in PostgreSQL: cast to numeric(1000, s), then its Compute.numeric, a value at display scale
 * s (domain.ts numericPaddings), which only a reading of the display scale could tell from the value; the term every
 * merge, key and reading must see as its value alone.
 */
export type TermSketch =
	| {
			readonly tag: "leaf"
			readonly pick: number
			readonly literal: boolean
			readonly param: boolean
			readonly value: ValueSketch
	  }
	| { readonly tag: "unary"; readonly fn: number; readonly scale: number; readonly arg: TermSketch }
	| {
			readonly tag: "binary"
			readonly fn: number
			readonly left: TermSketch
			readonly right: TermSketch
	  }
	| {
			readonly tag: "cast"
			readonly target: number
			/** The guard's bound at a float narrowing's edge (floatEdges), where its target is one. */
			readonly guard: number
			readonly arg: TermSketch
	  }
	| {
			readonly tag: "cond"
			readonly pred: CompareSketch
			readonly onTrue: TermSketch
			readonly onFalse: TermSketch
	  }
	| { readonly tag: "pad"; readonly depth: number; readonly arg: TermSketch }

export interface CompareSketch {
	readonly op: number
	readonly left: TermSketch
	readonly right: TermSketch
}

/** Whether a leaf is a literal: three draws in five. */
const literalLeafGen: Gen<boolean> = weighted([
	[2, constant(false)],
	[3, constant(true)]
])

/** A leaf's value: a small value class and spelling, or one of float8's special values one draw in five. */
const leafValueGen: Gen<ValueSketch> = weighted<ValueSketch>([
	[4, (source) => ({ cls: source.draw(int(0, 15)), sp: source.draw(int(0, 3)) })],
	[1, element(nonEmptyList(floatSpecialSketches, "the float special sketches"))]
])

const leafGen: Gen<TermSketch> = (source) => ({
	tag: "leaf",
	pick: source.draw(int(0, 7)),
	literal: source.draw(literalLeafGen),
	param: source.draw(boolean),
	value: source.draw(leafValueGen)
})

/** Terms of at most `depth` operations. */
export const termSketchGen = (depth: number): Gen<TermSketch> => {
	if (depth <= 0) {
		return leafGen
	}
	const sub = termSketchGen(depth - 1)
	const pred = compareSketchGen(depth - 1)
	return weighted<TermSketch>([
		[2, leafGen],
		[
			2,
			(source) => ({
				tag: "unary",
				fn: source.draw(int(0, 15)),
				scale: source.draw(int(0, 3)),
				arg: source.draw(sub)
			})
		],
		[
			4,
			(source) => ({
				tag: "binary",
				fn: source.draw(int(0, 15)),
				left: source.draw(sub),
				right: source.draw(sub)
			})
		],
		[
			2,
			(source) => ({
				tag: "cast",
				target: source.draw(int(0, 31)),
				guard: source.draw(int(0, 3)),
				arg: source.draw(sub)
			})
		],
		[
			1,
			(source) => ({
				tag: "cond",
				pred: source.draw(pred),
				onTrue: source.draw(sub),
				onFalse: source.draw(sub)
			})
		],
		[
			1,
			(source) => ({
				tag: "pad",
				depth: source.draw(int(0, 3)),
				arg: source.draw(sub)
			})
		]
	])
}

/**
 * A chain of one or two casts over one input column: the computed terms of the injective-cast population, whose
 * targets include every native cast of the column's carrier and the numeric typmods that keep, round and overflow.
 */
export const castChainSketchGen: Gen<TermSketch> = weighted<TermSketch>([
	[
		3,
		(source) => ({
			tag: "cast",
			target: source.draw(int(0, 31)),
			guard: source.draw(int(0, 3)),
			arg: source.draw(leafGen)
		})
	],
	[
		1,
		(source) => ({
			tag: "cast",
			target: source.draw(int(0, 31)),
			guard: source.draw(int(0, 3)),
			arg: {
				tag: "cast",
				target: source.draw(int(0, 31)),
				guard: source.draw(int(0, 3)),
				arg: source.draw(leafGen)
			}
		})
	]
])

export const compareSketchGen = (depth: number): Gen<CompareSketch> => {
	const left = termSketchGen(depth)
	const right = termSketchGen(Math.max(0, depth - 1))
	return (source) => ({
		op: source.draw(int(0, 5)),
		left: source.draw(left),
		right: source.draw(right)
	})
}

/**
 * The Compute operations the generator draws, by the carrier they compute at: a unary operation's operand's, a binary
 * one's the carrier its operands meet at (types.ts meetingType). Each is a ComputeFn whose overloads the registry admits
 * over that carrier (or a composite lowering of them); casts are drawn separately.
 */
const unaryFns: Readonly<Partial<Record<Carrier, ReadonlyArray<ComputeFn>>>> = {
	int2: ["neg", "abs", "sign"],
	int4: ["neg", "abs", "sign"],
	int8: ["neg", "abs", "sign"],
	exactInteger: ["neg", "abs", "sign"],
	numeric: ["neg", "abs", "sign", "round", "trunc", "ceil", "floor", "sqrt"],
	float4: ["neg", "abs", "sign"],
	float8: ["neg", "abs", "sign", "sqrt"]
}

/** The operations that take no scale argument, which is every binary operation. */
type UnscaledComputeFn = Exclude<ComputeFn, ScaledComputeFn>

const binaryFns: Readonly<Partial<Record<Carrier, ReadonlyArray<UnscaledComputeFn>>>> = {
	int2: ["add", "sub", "mul", "div", "mod", "gcd", "lcm", "least", "greatest"],
	int4: ["add", "sub", "mul", "div", "mod", "gcd", "lcm", "least", "greatest"],
	int8: ["add", "sub", "mul", "div", "mod", "gcd", "lcm", "least", "greatest"],
	exactInteger: ["add", "sub", "mul", "div", "mod", "gcd", "lcm", "least", "greatest"],
	numeric: ["add", "sub", "mul", "div", "mod", "quot", "rem", "gcd", "lcm", "least", "greatest"],
	float4: ["add", "sub", "mul", "div", "least", "greatest"],
	float8: ["add", "sub", "mul", "div", "least", "greatest"],
	money: ["add", "sub", "div", "least", "greatest"],
	exactMoney: ["add", "sub", "least", "greatest"],
	bool: ["least", "greatest"],
	uuid: ["least", "greatest"],
	text: ["least", "greatest"],
	code: ["least", "greatest"],
	/** pgvector's exact cosine distance, a double precision. */
	vector: ["cosineDistance"]
}

/**
 * The registry's casts by source carrier, but a parse: a cast from text stands only where the text's type proves its
 * target's lexical form, which no generated text field's pattern does (test/unit/scalar/lexical.test.ts draws parses).
 */
const castTargets: ReadonlyMap<Carrier, ReadonlyArray<Carrier>> = (() => {
	const out = new Map<Carrier, Array<Carrier>>()
	for (const op of nativeOps) {
		if (
			op.fn !== "cast" ||
			(op.totality.kind === "requires" &&
				Arr.some(op.totality.preconditions, (p) => p.kind === "lexical"))
		) {
			continue
		}
		const source = firstOperand(op.operands)
		if (source === op.result) {
			continue
		}
		const list = out.get(source) ?? []
		list.push(op.result)
		out.set(source, list)
	}
	return out
})()

/**
 * The numeric cast targets: typmods that round, keep and overflow the generated values, wide and narrow
 * (numeric(1,0) overflows 10, numeric(38,10) holds every finite generated value), and numeric(1,3), whose scale lies
 * above its precision, so its values lie below 10^-2 and its integer digits are negative. Compute.numeric, the numeric
 * of a value, is a conversion and no target: a cast term draws it beside them.
 */
const numericTargets: ReadonlyArray<FieldDesc> = [
	{ kind: "numeric", precision: 5, scale: 2 },
	{ kind: "numeric", precision: 1, scale: 0 },
	{ kind: "numeric", precision: 38, scale: 10 },
	{ kind: "numeric", precision: 3, scale: 1 },
	{ kind: "numeric", precision: 7, scale: 0 },
	{ kind: "numeric", precision: 16, scale: 0 },
	{ kind: "numeric", precision: 1, scale: 3 }
]

/**
 * The float narrowings at their target's edge: per float carrier, a numeric typmod of more integer digits than the
 * float keeps cast to numeric (cast.ts floatNumericDigits: real 6, double precision 15), and the guard bounds a cast
 * into it draws: 9, and three at the edge of float4_numeric's or float8_numeric's rounding, the widest bound whose
 * every value rounds inside the range (9999994::real::numeric is 9999990), the least past it, which rounds out of it
 * (9999995::real::numeric is 10000000, half to even), and the range's own last value but one. The generator keeps a
 * bound only where the checker proves the narrowing under it (provesNarrowing), and the facts hold the edge bounds as
 * values (domain.ts), so PostgreSQL evaluates every narrowing the checker proves at the edge: a bound proved past the
 * edge overflows there (22003), and the oracle reports it.
 */
const floatEdges: {
	readonly [C in "float4" | "float8"]: {
		readonly precision: number
		readonly bounds: Arr.NonEmptyReadonlyArray<number>
	}
} = {
	float4: { precision: 7, bounds: [9, 9999994, 9999995, 9999998] },
	float8: { precision: 16, bounds: [9, 9999999999999994, 9999999999999996, 9999999999999998] }
}

const isPlain = (c: Carrier): c is PlainCarrier =>
	c === "int2" ||
	c === "int4" ||
	c === "int8" ||
	c === "float4" ||
	c === "float8" ||
	c === "money" ||
	c === "bool"

/**
 * The ScalarType of a cast target descriptor among the generated types (numeric and the pg types): the descriptor
 * registry's reading of it, as the checker's.
 */
const fieldTypeOf = (desc: FieldDesc): ScalarType | undefined => {
	if (desc.kind !== "numeric" && desc.kind !== "pg") {
		return undefined
	}
	const typed = scalarTypeOf(desc, bareEnv, SourceLoc("a generated cast target", []))
	return typed.ok ? typed.value : undefined
}

/** The operations that divide, each defined where its divisor is nonzero, a float's division excepted (IEEE 754). */
const divisions: ReadonlySet<ComputeFn> = new Set<ComputeFn>(["div", "mod", "quot", "rem"])

/**
 * The operations over an integer or money that compute exactly, delivering an exact integer or exact money; mod keeps
 * its operands' type, since a remainder is smaller than its divisor.
 */
const exactFns: ReadonlySet<ComputeFn> = new Set<ComputeFn>([
	"add",
	"sub",
	"mul",
	"neg",
	"abs",
	"div",
	"gcd",
	"lcm"
])

const integerCarriers: ReadonlySet<Carrier> = new Set<Carrier>([
	"int2",
	"int4",
	"int8",
	"exactInteger"
])
const moneyCarriers: ReadonlySet<Carrier> = new Set<Carrier>(["money", "exactMoney"])
const floatCarriers: ReadonlySet<Carrier> = new Set<Carrier>(["float4", "float8"])

/** The carriers a `within` guard takes a subject of: the numeric family. */
const guardable: ReadonlySet<Carrier> = new Set<Carrier>([
	...integerCarriers,
	...moneyCarriers,
	...floatCarriers,
	"numeric"
])

/**
 * The type `fn` over a first operand of `carrier` computes, as the generator tracks it: an exact integer or exact money
 * for exact arithmetic over the integers and money (lowerTerm's digits are authoritative), money / money double
 * precision, and otherwise the operand's plain type.
 */
const resultOf = (fn: ComputeFn, carrier: Carrier, operand: ScalarType): ScalarType =>
	exactFns.has(fn) && integerCarriers.has(carrier)
		? exactType("exactInteger", 0)
		: exactFns.has(fn) && moneyCarriers.has(carrier) && fn !== "div"
			? exactType("exactMoney", 0)
			: fn === "div" && carrier === "money"
				? plainType("float8")
				: plainOf(carrier, operand)

/** The literal of `n` at a numeric-family carrier, as a guard's bound or a divisor spells it. */
const numberLiteral = (carrier: Carrier, n: number): LiteralDesc => {
	switch (carrier) {
		case "int8":
		case "exactInteger":
			return BigInt(n)
		case "numeric":
			return Decimal.of(BigInt(n))
		case "money":
		case "exactMoney":
			return Money.of(BigInt(n) * 100n)
		case "int2":
		case "int4":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "bytes":
		case "text":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			return n
	}
}

const literalOf = (carrier: Carrier, n: number): ExprDesc => ({
	kind: "literal",
	value: numberLiteral(carrier, n)
})

/** The guard that its subject lies within [-n, n], over a subject of `carrier`. */
const withinGuard = (carrier: Carrier, low: number, high: number): GuardDesc => ({
	kind: "within",
	low: numberLiteral(carrier, low),
	high: numberLiteral(carrier, high)
})

/** The plain carrier a literal opposite a term of `carrier` is spelled at: an exact value's family's. */
const literalCarrier = (carrier: Carrier): Carrier =>
	carrier === "exactInteger" ? "int8" : carrier === "exactMoney" ? "money" : carrier

const literalShy: ReadonlySet<ComputeFn> = new Set<ComputeFn>(["least", "greatest", "gcd", "lcm"])

const compareOpsList: ReadonlyArray<CompareOp> = ["eq", "ne", "lt", "le", "gt", "ge"]

/**
 * Operands meet when they share a carrier, and a closed id's roster (the generated types carry no contract), or when one
 * is an exact value of the other's family (types.ts meets).
 */
const meets = (a: ScalarType, b: ScalarType): boolean => {
	if (baseOf(a).carrier !== baseOf(b).carrier) {
		return engineMeets(a, b)
	}
	if (a.carrier !== "code") {
		return true
	}
	return b.carrier === "code" && a.roster.closed === b.roster.closed
}

/**
 * What a term resolves against: the input heading, the case's types for literals, and the hooks the query resolver
 * supplies for parameters and value spelling.
 */
export interface TermScope {
	readonly heading: Heading
	readonly params: boolean
	/** The literal of `type` a value sketch spells, as a comparison operand (it never reaches the output as stored). */
	readonly literal: (type: ScalarType, value: ValueSketch) => ExprDesc
	/**
	 * Registers a parameter of `type` whose value the sketch spells, returning the name the description uses.
	 */
	readonly param: (value: ValueSketch, type: ScalarType) => string
}

interface Resolved {
	readonly desc: ExprDesc
	/** The type the term computes, as the generator tracks it to choose operations; lowerTerm's is authoritative. */
	readonly type: ScalarType
	/**
	 * Whether the term is a bare literal, which never stands first, or a parameter of the type the term it meets wants:
	 * the generator places either opposite a term.
	 */
	readonly free: boolean
}

const resolveLeaf = (
	scope: TermScope,
	s: Extract<TermSketch, { tag: "leaf" }>,
	want: ScalarType | undefined
): Resolved | undefined => {
	/**
	 * A contract column meets no plain operand without Compute.base, which the generator does not draw, so computed
	 * terms read plain columns only; contracts take part in comparisons with literals and parameters instead.
	 */
	const plainColumns = Arr.filter(scope.heading, (c) => contractOf(c.type) === undefined)
	const columns =
		want === undefined ? plainColumns : Arr.filter(plainColumns, (c) => meets(c.type, want))
	if (want !== undefined && (s.literal || columns.length === 0)) {
		const spelled = literalCarrier(want.carrier)
		const at = isComputedNumeric(want)
			? numeric
			: spelled === want.carrier
				? want
				: plainOf(spelled, want)
		if (s.param && scope.params && want.carrier !== "code") {
			return {
				desc: { kind: "param", name: scope.param(s.value, at), type: fieldDescOf(at) },
				type: want,
				free: true
			}
		}
		return { desc: scope.literal(at, s.value), type: want, free: true }
	}
	if (columns.length === 0) {
		return undefined
	}
	const c: HeadingColumn = at(columns, s.pick)
	return { desc: { kind: "var", var: c.name }, type: c.type, free: false }
}

/**
 * The plain type of a carrier the generator tracks a term at: numeric's the widest generated numeric (domain.ts
 * numeric), which a typed literal or a parameter can declare, as a computed numeric cannot.
 */
const plainOf = (c: Carrier, fallback: ScalarType): ScalarType =>
	c === "numeric" ? numeric : isPlain(c) ? plainType(c) : fallback

/**
 * The term a sketch resolves to, of a type meeting `want` when one is given (types.ts meets), each node typed as the
 * checker types it:
 * - a binary operation is drawn among those over the carrier its operands meet at (types.ts meetingType), the carrier
 *   the checker computes it at, so money is never divided by exact money, which has no division; and it stands only
 *   where its result meets `want`, so money / money and a cosine distance, double precision, stand only opposite
 *   double precision. A binary sketch whose operation cannot stand is its left operand.
 * - LEAST, GREATEST, gcd and lcm take terms or parameters, never a bare literal (the checker refuses one).
 * - a conditional is of its branches' common type (types.ts commonType); a conditional, LEAST or GREATEST of an exact
 *   value beside a plain value of its family cannot stand (types.ts mixesExact), nor a bare literal beside an exact
 *   branch of fewer digits than its value (lower.ts branchOperand), so such a sketch is its first operand.
 * - a numeric typmod coercion is the cast numeric -> numeric, which rounds and can overflow.
 */
const resolveTerm = (
	scope: TermScope,
	s: TermSketch,
	want: ScalarType | undefined
): Resolved | undefined => {
	switch (s.tag) {
		case "leaf":
			return resolveLeaf(scope, s, want)
		case "unary": {
			const arg = resolveTerm(scope, s.arg, want)
			if (arg === undefined || arg.free) {
				return arg
			}
			const fns = unaryFns[baseOf(arg.type).carrier] ?? []
			if (fns.length === 0) {
				return arg
			}
			const fn = at(fns, s.fn)
			const carrier = baseOf(arg.type).carrier
			const desc: ExprDesc =
				fn === "round" || fn === "trunc"
					? {
							kind: "compute",
							fn,
							args: [arg.desc],
							scale: s.scale % 2 === 1 ? s.scale - 1 : undefined
						}
					: fn === "sqrt" && carrier === "numeric"
						? {
								kind: "when",
								guard: { kind: "nonnegative" },
								subject: arg.desc,
								proved: { kind: "compute", fn, args: [arg.desc] },
								otherwise: arg.desc
							}
						: { kind: "compute", fn, args: [arg.desc] }
			return { desc, type: resultOf(fn, carrier, arg.type), free: false }
		}
		case "binary": {
			const left = resolveTerm(scope, s.left, want)
			if (left === undefined || left.free) {
				return left
			}
			const right = resolveTerm(scope, s.right, left.type)
			if (right === undefined) {
				return left
			}
			const operand = meetingType(left.type, right.type)
			const carrier = baseOf(operand).carrier
			const fns = binaryFns[carrier] ?? []
			if (fns.length === 0) {
				return left
			}
			const fn = at(fns, s.fn)
			if (literalShy.has(fn) && right.desc.kind === "literal") {
				return left
			}
			if ((fn === "least" || fn === "greatest") && !standsBeside(left.type, right)) {
				return left
			}
			const type =
				fn === "least" || fn === "greatest"
					? operand
					: fn === "cosineDistance"
						? plainType("float8")
						: resultOf(fn, carrier, operand)
			if (want !== undefined && !meets(type, want)) {
				return left
			}
			if (!divisions.has(fn) || floatCarriers.has(carrier)) {
				return { desc: { kind: "compute", fn, args: [left.desc, right.desc] }, type, free: false }
			}
			if (right.free) {
				return {
					desc: {
						kind: "compute",
						fn,
						args: [left.desc, literalOf(literalCarrier(baseOf(right.type).carrier), 3)]
					},
					type,
					free: false
				}
			}
			return {
				desc: {
					kind: "when",
					guard: { kind: "nonzero" },
					subject: right.desc,
					proved: { kind: "compute", fn, args: [left.desc, right.desc] },
					otherwise: literalOf(literalCarrier(baseOf(type).carrier), 0)
				},
				type,
				free: false
			}
		}
		case "cast": {
			const arg = resolveTerm(scope, s.arg, undefined)
			if (arg === undefined || arg.free) {
				return arg
			}
			const source = baseOf(arg.type).carrier
			const targets: ReadonlyArray<FieldDesc> = [
				...Arr.flatMap(castTargets.get(source) ?? [], (t) =>
					t === "numeric" ? numericTargets : isPlain(t) ? [fieldDescOf(plainType(t))] : []
				),
				...(source === "numeric" ? numericTargets : [])
			]
			const usable = Arr.filter(targets, (t) => {
				const type = fieldTypeOf(t)
				return type !== undefined && (want === undefined || meets(type, want))
			})
			/** With no cast to a type the caller wants, the operand stands for itself only if it meets that type. */
			const uncast = want === undefined || meets(arg.type, want) ? arg : undefined
			const converts =
				(castTargets.get(source) ?? []).includes("numeric") &&
				(want === undefined || meets(anyNumeric, want))
			if (converts && s.target % (usable.length + 1) === usable.length) {
				return {
					desc: { kind: "compute", fn: "numeric", args: [arg.desc] },
					type: anyNumeric,
					free: false
				}
			}
			if (usable.length === 0) {
				return uncast
			}
			const to = at(usable, s.target)
			const type = fieldTypeOf(to)
			if (type === undefined) {
				return uncast
			}
			const cast: ExprDesc = { kind: "cast", to, arg: arg.desc }
			if (!guardable.has(source) || !guardable.has(baseOf(type).carrier)) {
				return { desc: cast, type, free: false }
			}
			const bound = guardBound(source, to, s.guard)
			return {
				desc: {
					kind: "when",
					guard: withinGuard(source, -bound, bound),
					subject: arg.desc,
					proved: cast,
					otherwise: literalOf(baseOf(type).carrier, 0)
				},
				type,
				free: false
			}
		}
		case "pad": {
			const arg = resolveTerm(scope, s.arg, want)
			if (arg === undefined || arg.free || baseOf(arg.type).carrier !== "numeric") {
				return arg
			}
			const padded: FieldDesc = {
				kind: "numeric",
				precision: 1000,
				scale: at(numericPaddings, s.depth)
			}
			return {
				desc: {
					kind: "when",
					guard: withinGuard("numeric", -1000, 1000),
					subject: arg.desc,
					proved: {
						kind: "compute",
						fn: "numeric",
						args: [{ kind: "cast", to: padded, arg: arg.desc }]
					},
					otherwise: arg.desc
				},
				type: anyNumeric,
				free: false
			}
		}
		case "cond": {
			const pred = resolveCompare(scope, s.pred)
			const onTrue = resolveTerm(scope, s.onTrue, want)
			if (pred === undefined || onTrue === undefined || onTrue.free) {
				return onTrue
			}
			const onFalse = resolveTerm(scope, s.onFalse, onTrue.type)
			if (onFalse === undefined || !standsBeside(onTrue.type, onFalse)) {
				return onTrue
			}
			return {
				desc: { kind: "cond", pred: pred, onTrue: onTrue.desc, onFalse: onFalse.desc },
				type: commonType(onTrue.type, onFalse.type),
				free: false
			}
		}
	}
}

/**
 * Whether a conditional's other branch, or LEAST's and GREATEST's other operand, stands beside a first of type `first`
 * (lower.ts exactBeside, branchOperand): a term neither of them an exact value beside a plain value of its family
 * (types.ts mixesExact); a parameter, which is declared at a plain carrier wherever its term wants an exact value
 * (resolveLeaf), beside no exact first; and a bare literal within an exact first's digits.
 */
const standsBeside = (first: ScalarType, other: Resolved): boolean => {
	const digits = exactDigitsOf(first)
	if (other.desc.kind === "param") {
		return digits === undefined
	}
	if (other.desc.kind !== "literal" || other.desc.type !== undefined) {
		return !mixesExact(first, other.type)
	}
	if (digits === undefined) {
		return true
	}
	const value = other.desc.value
	const exact =
		typeof value === "bigint"
			? exactOf(value, 0)
			: value instanceof Money
				? exactOf(value.minorUnits, 2)
				: undefined
	return exact !== undefined && digitsOfExact(exact) <= digits
}

/** A comparison of two terms of one carrier. */
export const resolveCompare = (scope: TermScope, s: CompareSketch): ExprDesc | undefined => {
	const left = resolveTerm(scope, s.left, undefined)
	if (left === undefined || left.free) {
		return undefined
	}
	const right = resolveTerm(scope, s.right, left.type)
	if (right === undefined) {
		return undefined
	}
	return { kind: "compare", op: at(compareOpsList, s.op), left: left.desc, right: right.desc }
}

/**
 * The checker's typing environment for a term over `node`'s heading: leaves are the node's columns, a parameter is of
 * the type it was registered with (TermScope.param), bound as its base (never a refined domain), and plain results are
 * production's (plainType).
 */
export interface LowerHooks {
	readonly emit: (spec: ExprSpec) => ScalarExpr
	readonly column: (column: HeadingColumn) => ExprSpec
	readonly param: (name: string) => { readonly spec: ExprSpec; readonly type: ScalarType }
}

const refusal = (loc: SourceLoc, capability: string): CompileError =>
	malformedDescription(loc, capability)

const lowerEnv = (heading: Heading, hooks: LowerHooks): LowerEnv => ({
	mode: "query",
	loc: SourceLoc("a generated term", []),
	emit: hooks.emit,
	leaf: (desc, loc) => {
		const c =
			desc.kind === "var"
				? Option.getOrUndefined(Arr.findFirst(heading, (h) => h.name === desc.var))
				: undefined
		if (c === undefined) {
			return Result.err(refusal(loc, "a column of the term's input"))
		}
		return Result.ok(hooks.column(c))
	},
	params: { kind: "scope", lower: ({ name }) => Result.ok(hooks.param(name)) },
	fieldType: (desc) => {
		const t = fieldTypeOf(desc)
		return t === undefined
			? Result.err(refusal(SourceLoc("a generated cast", []), "a generated cast target"))
			: Result.ok(t)
	},
	patterns: new CompilePatterns(),
	patternLanguage: textLookup,
	extension: noExtension,
	closed: noClosedRelations("a generated term reads no closed relation")
})

/** A column of the probed float alone, for provesNarrowing: no relation holds it, and no parameter is named. */
const probeHooks = (): LowerHooks => {
	const ids = makeIdSupply()
	const b = new DagBuilder(ids)
	const node = ids.node()
	return {
		emit: (spec) => b.expr(spec),
		column: (c) => ({
			kind: "column",
			column: { node, name: c.name },
			args: [],
			type: c.type,
			nonNull: "storage"
		}),
		param: (name) => {
			throw new Error(`a narrowing probe names no parameter, ${name}`)
		}
	}
}

/**
 * Whether the checker proves the narrowing of a `source` value into `to` under within(-bound, bound), over a column of
 * the float alone. A subject's bounds lie inside its type's, so a narrowing proved here is proved over any subject.
 */
const provesNarrowing = (source: "float4" | "float8", to: FieldDesc, bound: number): boolean => {
	const x: HeadingColumn = { name: "x", type: plainType(source) }
	const desc: ExprDesc = {
		kind: "when",
		guard: withinGuard(source, -bound, bound),
		subject: { kind: "var", var: x.name },
		proved: { kind: "cast", to, arg: { kind: "var", var: x.name } },
		otherwise: literalOf("numeric", 0)
	}
	return lowerTerm(desc, lowerEnv([x], probeHooks())).ok
}

/**
 * The bound of a cast's within guard: 9, inside every target's range but one whose scale lies at or above its
 * precision, whose values lie below one and which the bound 0 proves; or for a float narrowing into its edge target,
 * the drawn edge bound where the checker proves the narrowing under it, and 9 where it does not.
 */
const guardBound = (source: Carrier, to: FieldDesc, pick: number): number => {
	if (to.kind === "numeric" && to.scale >= to.precision) {
		return 0
	}
	if ((source !== "float4" && source !== "float8") || to.kind !== "numeric") {
		return 9
	}
	const edge = floatEdges[source]
	if (to.precision !== edge.precision || to.scale !== 0) {
		return 9
	}
	const bound = at(edge.bounds, pick)
	return provesNarrowing(source, to, bound) ? bound : 9
}

/** A lowered term: its expression, which carries its own volatility, and its type. */
export interface LoweredTerm {
	readonly expr: ScalarExpr
	readonly type: ScalarType
}

/**
 * A term's output: the term itself, or an exact integer or exact money narrowed into bigint or money under the guard
 * that it fits, its otherwise zero, so every generated output column is of a carrier the generators draw (domain.ts
 * genCarriers), as a program stores an exact result in a field.
 */
const plainOutput = (r: Resolved): ExprDesc => {
	const carrier = baseOf(r.type).carrier
	if (carrier !== "exactInteger" && carrier !== "exactMoney") {
		return r.desc
	}
	const integer = carrier === "exactInteger"
	const min = -(2n ** 63n)
	const max = 2n ** 63n - 1n
	return {
		kind: "when",
		guard: {
			kind: "within",
			low: integer ? min : Money.of(min),
			high: integer ? max : Money.of(max)
		},
		subject: r.desc,
		proved: { kind: "cast", to: { kind: "pg", type: integer ? "bigint" : "money" }, arg: r.desc },
		otherwise: literalOf(integer ? "int8" : "money", 0)
	}
}

/** A term sketch resolved and lowered over `heading`, or undefined when the heading offers no column to start it. */
export const buildTerm = (
	scope: TermScope,
	hooks: LowerHooks,
	s: TermSketch
): LoweredTerm | undefined => {
	const resolved = resolveTerm(scope, s, undefined)
	if (resolved === undefined || resolved.free) {
		return undefined
	}
	const lowered = lowerTerm(plainOutput(resolved), lowerEnv(scope.heading, hooks))
	if (!lowered.ok) {
		throw new Error(
			`a generated term the checker refuses: ${lowered.error.message}\n${Formatter.format(plainOutput(resolved))}\n${Formatter.format(Arr.map(scope.heading, (h) => [h.name, h.type.carrier, rosterOf(h.type)?.closed]))}`
		)
	}
	return {
		expr: lowered.value.expr,
		type: lowered.value.actual
	}
}

/**
 * A column of an exact type narrowed into the carrier a program stores it at (plainOutput), lowered over `scope`'s
 * heading: how a generated aggregate's exact money sum becomes a money column the generators draw.
 */
export const storedColumn = (
	scope: TermScope,
	hooks: LowerHooks,
	column: HeadingColumn
): LoweredTerm => {
	const desc = plainOutput({
		desc: { kind: "var", var: column.name },
		type: column.type,
		free: false
	})
	const lowered = lowerTerm(desc, lowerEnv(scope.heading, hooks))
	if (!lowered.ok) {
		throw new Error(
			`a stored column the checker refuses: ${lowered.error.message}\n${Formatter.format(desc)}`
		)
	}
	return {
		expr: lowered.value.expr,
		type: lowered.value.actual
	}
}

/** A comparison sketch resolved and lowered over `heading` as a predicate. */
export const buildCompare = (
	scope: TermScope,
	hooks: LowerHooks,
	s: CompareSketch
): LoweredTerm | undefined => {
	const desc = resolveCompare(scope, s)
	if (desc === undefined) {
		return undefined
	}
	const lowered = lowerPredicate(desc, lowerEnv(scope.heading, hooks))
	if (!lowered.ok) {
		throw new Error(
			`a generated predicate the checker refuses: ${lowered.error.message}\n${Formatter.format(desc)}`
		)
	}
	return {
		expr: lowered.value.expr,
		type: lowered.value.actual
	}
}
