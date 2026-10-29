import { boolean, constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Formatter, Option } from "effect"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type {
	CompareOp,
	ComputeFn,
	ExprDesc,
	FieldDesc,
	ScaledComputeFn
} from "#compiler/ir/desc.ts"
import type { ExprSpec, ScalarExpr } from "#compiler/ir/expr.ts"
import type { Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import { baseOf, type Carrier, contractOf, rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	type LowerEnv,
	lowerPredicate,
	lowerTerm,
	noExtension
} from "#compiler/scalar/compute/lower.ts"
import { firstOperand, nativeOps } from "#compiler/scalar/compute/registry.ts"
import { type PlainCarrier, plainType } from "#compiler/scalar/compute/types.ts"
import { bareEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { regexMember } from "#compiler/text/refinement.ts"
import {
	fieldDescOf,
	floatSpecialSketches,
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
 * literal's adopted type, and the canFail marks the error frontier reads: an expression over an operand that can
 * fail can fail too.
 *
 * Many terms can fail on the generated values: an integer overflow at a type's bound, a division by zero, a NaN cast to
 * an integer, a negative square root. Whether one does is the case's business: the frontier comparison
 * (reference/frontier.ts) compares "error or rows" between the lowerings and the reference evaluator.
 *
 * The sketch is a tree of plain numbers resolved against the input heading: each choice reduced modulo what fits the
 * operand carriers in scope, and a choice with nothing to choose from degrading to a column, so every sketch resolves
 * and shrinking keeps it valid.
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
	| { readonly tag: "cosine"; readonly left: number; readonly right: TermSketch }
	| { readonly tag: "power"; readonly left: number; readonly right: TermSketch }
	| { readonly tag: "cast"; readonly target: number; readonly arg: TermSketch }
	| {
			readonly tag: "cond"
			readonly pred: CompareSketch
			readonly onTrue: TermSketch
			readonly onFalse: TermSketch
	  }
	| {
			readonly tag: "byZero"
			readonly fn: number
			readonly zero: number
			readonly sp: number
			readonly arg: TermSketch
	  }

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
			arg: source.draw(leafGen)
		})
	],
	[
		1,
		(source) => ({
			tag: "cast",
			target: source.draw(int(0, 31)),
			arg: {
				tag: "cast",
				target: source.draw(int(0, 31)),
				arg: source.draw(leafGen)
			}
		})
	]
])

/**
 * A division by zero over a term of at most `depth` operations, whose dividend reads a column a division takes
 * wherever the input has one: the term a population draws to meet failures every lowering must raise wherever its query
 * delivers a row.
 */
export const byZeroSketchGen = (depth: number): Gen<TermSketch> => {
	const arg = termSketchGen(depth)
	return (source) => ({
		tag: "byZero",
		fn: source.draw(int(0, 3)),
		zero: source.draw(int(0, 2)),
		sp: source.draw(int(0, 3)),
		arg: source.draw(arg)
	})
}

/**
 * A cosine distance from a vector column to a column or literal of its type wherever the scope holds a vector column:
 * the term a finish states to reach "cosine distance" whenever its input has one.
 */
export const cosineSketchGen: Gen<TermSketch> = (source) => ({
	tag: "cosine",
	left: source.draw(int(0, 7)),
	right: source.draw(leafGen)
})

/**
 * A power of a double precision or numeric column by a column or literal of its type wherever the scope holds one: the
 * term a finish states to reach a value only PostgreSQL computes (the reference's unstated column).
 */
export const powerSketchGen: Gen<TermSketch> = (source) => ({
	tag: "power",
	left: source.draw(int(0, 7)),
	right: source.draw(leafGen)
})

/**
 * Whether a term sketch is a chain of casts over a leaf, which resolves with no wanted type to casts over one input
 * column, or to the column itself when no cast fits.
 */
export const isCastChain = (s: TermSketch): boolean =>
	s.tag === "leaf" || (s.tag === "cast" && isCastChain(s.arg))

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
 * The Compute operations the generator draws, by the carrier of their first operand. Each is a ComputeFn whose
 * overloads the registry admits over that carrier (or a composite lowering of them); casts are drawn separately.
 */
const unaryFns: Readonly<Partial<Record<Carrier, ReadonlyArray<ComputeFn>>>> = {
	int2: ["neg", "abs", "sign"],
	int4: ["neg", "abs", "sign"],
	int8: ["neg", "abs", "sign"],
	numeric: ["neg", "abs", "sign", "round", "trunc", "ceil", "floor", "sqrt", "trimScale"],
	float4: ["neg", "abs", "sign"],
	float8: ["neg", "abs", "sign", "sqrt"]
}

/** The operations that take no scale argument, which is every binary operation. */
type UnscaledComputeFn = Exclude<ComputeFn, ScaledComputeFn>

const binaryFns: Readonly<Partial<Record<Carrier, ReadonlyArray<UnscaledComputeFn>>>> = {
	int2: ["add", "sub", "mul", "div", "mod", "gcd", "lcm", "least", "greatest"],
	int4: ["add", "sub", "mul", "div", "mod", "gcd", "lcm", "least", "greatest"],
	int8: ["add", "sub", "mul", "div", "mod", "gcd", "lcm", "least", "greatest"],
	numeric: [
		"add",
		"sub",
		"mul",
		"div",
		"mod",
		"quot",
		"rem",
		"gcd",
		"lcm",
		"power",
		"least",
		"greatest"
	],
	float4: ["add", "sub", "mul", "div", "least", "greatest"],
	float8: ["add", "sub", "mul", "div", "power", "least", "greatest"],
	money: ["add", "sub", "div", "least", "greatest"],
	bool: ["least", "greatest"],
	uuid: ["least", "greatest"],
	text: ["least", "greatest"],
	enum: ["least", "greatest"],
	/** pgvector's exact cosine distance, a double precision. */
	vector: ["cosineDistance"]
}

const castTargets: ReadonlyMap<Carrier, ReadonlyArray<Carrier>> = (() => {
	const out = new Map<Carrier, Array<Carrier>>()
	for (const op of nativeOps) {
		if (op.fn !== "cast") {
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
 * The numeric cast targets: the bare type, and typmods that round, keep and overflow the generated values, wide and
 * narrow (numeric(1,0) overflows 10, numeric(38,10) holds every finite generated value).
 */
const numericTargets: ReadonlyArray<FieldDesc> = [
	{ kind: "numeric" },
	{ kind: "numeric", precision: 5, scale: 2 },
	{ kind: "numeric", precision: 1, scale: 0 },
	{ kind: "numeric", precision: 38, scale: 10 },
	{ kind: "numeric", precision: 3, scale: 1 }
]

const isPlain = (c: Carrier): c is PlainCarrier =>
	c === "int2" ||
	c === "int4" ||
	c === "int8" ||
	c === "numeric" ||
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

/** The operations that divide, each failing on a zero divisor. */
const divisions: ReadonlySet<ComputeFn> = new Set<ComputeFn>(["div", "mod", "quot", "rem"])

const divisionsOf = (carrier: Carrier): ReadonlyArray<UnscaledComputeFn> =>
	Arr.filter(binaryFns[carrier] ?? [], (fn) => divisions.has(fn))

const literalShy: ReadonlySet<ComputeFn> = new Set<ComputeFn>(["least", "greatest", "gcd", "lcm"])

const compareOpsList: ReadonlyArray<CompareOp> = ["eq", "ne", "lt", "le", "gt", "ge"]

/** Operands meet when they share a carrier, and an enum's roster (the generated types carry no contract). */
const meets = (a: ScalarType, b: ScalarType): boolean => {
	if (baseOf(a).carrier !== baseOf(b).carrier) {
		return false
	}
	if (a.carrier !== "enum") {
		return true
	}
	return b.carrier === "enum" && a.roster.closed === b.roster.closed
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
	/** Registers a parameter whose value the sketch spells, returning the name the description uses. */
	readonly param: (value: ValueSketch) => string
}

interface Resolved {
	readonly desc: ExprDesc
	/** The type the term computes, as the generator tracks it to choose operations; lowerTerm's is authoritative. */
	readonly type: ScalarType
	/**
	 * Whether the term is a bare literal or parameter, which never stands first: it adopts the type of the term it meets.
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
		if (s.param && scope.params && want.carrier !== "enum") {
			return { desc: { kind: "param", name: scope.param(s.value) }, type: want, free: true }
		}
		return { desc: scope.literal(want, s.value), type: want, free: true }
	}
	if (columns.length === 0) {
		return undefined
	}
	const c: HeadingColumn = at(columns, s.pick)
	return { desc: { kind: "var", var: c.name }, type: c.type, free: false }
}

const plainOf = (c: Carrier, fallback: ScalarType): ScalarType =>
	isPlain(c) ? plainType(c) : fallback

/**
 * The term a sketch resolves to, of a type meeting `want` when one is given.
 *
 * money / money is double precision; it meets a double precision `want` only by a cast, so it is left out
 * where a money operand is wanted.
 *
 * A cosine distance is double precision, which never meets a vector operand.
 *
 * LEAST, GREATEST, gcd and lcm take terms or parameters, never a bare literal (the checker refuses one).
 *
 * A cosine distance is double precision, which meets no other wanted type.
 *
 * A numeric typmod coercion is the cast numeric -> numeric, which rounds and can overflow.
 *
 * money / money is double precision, which meets a money operand only by a cast.
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
			const desc: ExprDesc =
				fn === "round" || fn === "trunc"
					? {
							kind: "compute",
							fn,
							args: [arg.desc],
							scale: s.scale % 2 === 1 ? s.scale - 1 : undefined
						}
					: { kind: "compute", fn, args: [arg.desc] }
			return { desc, type: plainOf(baseOf(arg.type).carrier, arg.type), free: false }
		}
		case "binary": {
			const left = resolveTerm(scope, s.left, want)
			if (left === undefined || left.free) {
				return left
			}
			const carrier = baseOf(left.type).carrier
			const fns = binaryFns[carrier] ?? []
			if (fns.length === 0) {
				return left
			}
			const fn = at(fns, s.fn)
			if (fn === "div" && carrier === "money" && want?.carrier === "money") {
				return left
			}
			if (fn === "cosineDistance" && want !== undefined && want.carrier !== "float8") {
				return left
			}
			const right = resolveTerm(scope, s.right, left.type)
			if (right === undefined) {
				return left
			}
			if (literalShy.has(fn) && right.desc.kind === "literal") {
				return left
			}
			const type =
				fn === "least" || fn === "greatest"
					? left.type
					: (fn === "div" && carrier === "money") || fn === "cosineDistance"
						? plainType("float8")
						: plainOf(carrier, left.type)
			return { desc: { kind: "compute", fn, args: [left.desc, right.desc] }, type, free: false }
		}
		case "cosine": {
			const vectors = Arr.filter(
				scope.heading,
				(c) => c.type.carrier === "vector" && contractOf(c.type) === undefined
			)
			const degraded: TermSketch = {
				tag: "binary",
				fn: 0,
				left: { tag: "leaf", pick: s.left, literal: false, param: false, value: { cls: 0, sp: 0 } },
				right: s.right
			}
			if (vectors.length === 0 || (want !== undefined && want.carrier !== "float8")) {
				return resolveTerm(scope, degraded, want)
			}
			const left: HeadingColumn = at(vectors, s.left)
			const right = resolveTerm(scope, s.right, left.type)
			if (right === undefined) {
				return resolveTerm(scope, degraded, want)
			}
			return {
				desc: {
					kind: "compute",
					fn: "cosineDistance",
					args: [{ kind: "var", var: left.name }, right.desc]
				},
				type: plainType("float8"),
				free: false
			}
		}
		case "power": {
			const plain = Arr.filter(scope.heading, (c) => contractOf(c.type) === undefined)
			const floats = Arr.filter(plain, (c) => c.type.carrier === "float8")
			const bases =
				floats.length > 0 ? floats : Arr.filter(plain, (c) => c.type.carrier === "numeric")
			const degraded: TermSketch = {
				tag: "binary",
				fn: 0,
				left: { tag: "leaf", pick: s.left, literal: false, param: false, value: { cls: 0, sp: 0 } },
				right: s.right
			}
			const [first] = bases
			const carrier = first?.type.carrier
			if (first === undefined || (want !== undefined && want.carrier !== carrier)) {
				return resolveTerm(scope, degraded, want)
			}
			const left: HeadingColumn = at(bases, s.left)
			const right = resolveTerm(scope, s.right, left.type)
			if (right === undefined) {
				return resolveTerm(scope, degraded, want)
			}
			return {
				desc: { kind: "compute", fn: "power", args: [{ kind: "var", var: left.name }, right.desc] },
				type: plainOf(baseOf(left.type).carrier, left.type),
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
				...(source === "numeric" ? numericTargets.slice(1) : [])
			]
			const usable = Arr.filter(targets, (t) => {
				const type = fieldTypeOf(t)
				return type !== undefined && (want === undefined || meets(type, want))
			})
			/** With no cast to a type the caller wants, the operand stands for itself only if it meets that type. */
			const uncast = want === undefined || meets(arg.type, want) ? arg : undefined
			if (usable.length === 0) {
				return uncast
			}
			const to = at(usable, s.target)
			const type = fieldTypeOf(to)
			if (type === undefined) {
				return uncast
			}
			return { desc: { kind: "cast", to, arg: arg.desc }, type, free: false }
		}
		case "byZero": {
			const divisible = Arr.filter(
				scope.heading,
				(c) => divisionsOf(baseOf(c.type).carrier).length > 0
			)
			const arg = resolveTerm(
				divisible.length > 0 ? { ...scope, heading: divisible } : scope,
				s.arg,
				want
			)
			if (arg === undefined || arg.free) {
				return arg
			}
			const carrier = baseOf(arg.type).carrier
			const fns = divisionsOf(carrier)
			if (fns.length === 0 || (carrier === "money" && want?.carrier === "money")) {
				return arg
			}
			/** Value class 0 is zero in every carrier a division takes. */
			const zero: ValueSketch = { cls: 0, sp: s.sp }
			const choice = s.zero % 3
			const divisor: ExprDesc =
				choice === 0
					? { kind: "compute", fn: "sub", args: [arg.desc, arg.desc] }
					: choice === 1 && scope.params
						? { kind: "param", name: scope.param(zero) }
						: scope.literal(arg.type, zero)
			return {
				desc: { kind: "compute", fn: at(fns, s.fn), args: [arg.desc, divisor] },
				type: carrier === "money" ? plainType("float8") : plainOf(carrier, arg.type),
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
			if (onFalse === undefined) {
				return onTrue
			}
			return {
				desc: { kind: "cond", pred: pred, onTrue: onTrue.desc, onFalse: onFalse.desc },
				type: onTrue.type,
				free: false
			}
		}
	}
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
 * The checker's typing environment for a term over `node`'s heading: leaves are the node's columns, parameters adopt
 * the term they meet bound as its base type (never a refined domain), and plain results are production's (plainType).
 */
export interface LowerHooks {
	readonly emit: (spec: ExprSpec) => ScalarExpr
	readonly column: (column: HeadingColumn) => ExprSpec
	readonly param: (name: string, type: ScalarType) => ExprSpec
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
	params: { kind: "scope", lower: ({ name }, type) => Result.ok(hooks.param(name, type)) },
	fieldType: (desc) => {
		const t = fieldTypeOf(desc)
		return t === undefined
			? Result.err(refusal(SourceLoc("a generated cast", []), "a generated cast target"))
			: Result.ok(t)
	},
	regexMember,
	extension: noExtension
})

export interface LoweredTerm {
	readonly expr: ScalarExpr
	readonly type: ScalarType
	readonly canFail: boolean
	readonly stable: boolean
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
	const lowered = lowerTerm(resolved.desc, lowerEnv(scope.heading, hooks))
	if (!lowered.ok) {
		throw new Error(
			`a generated term the checker refuses: ${lowered.error.message}\n${Formatter.format(resolved.desc)}\n${Formatter.format(Arr.map(scope.heading, (h) => [h.name, h.type.carrier, rosterOf(h.type)?.closed]))}`
		)
	}
	return {
		expr: lowered.value.expr,
		type: lowered.value.actual,
		canFail: lowered.value.failure === "canFail",
		stable: lowered.value.volatility === "stable"
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
		type: lowered.value.actual,
		canFail: lowered.value.failure === "canFail",
		stable: lowered.value.volatility === "stable"
	}
}
