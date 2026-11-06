import { defect } from "#compiler/core/invariant.ts"
import { int8Min } from "#compiler/core/limits.ts"
/**
 * The closed monoids a fold accumulates in, each over the carriers it admits: its planes, its identity on each, and how
 * each plane's after is combined from the befores and the step. Every one but concat is commutative, so a fold over a
 * counted family, whose order is hidden, has one value whatever order its members are in; concat, text's free monoid,
 * is not, so only a sequence, an ordered family or a tree, folds by it (check/fold.ts foldRule).
 */
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { integerRanges, MoneyText } from "#compiler/ir/carriers.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { MonoidName } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { baseOf, contractOf, type ScalarType } from "#compiler/ir/scalar.ts"

/** The Compute operations a combine applies: each total over the carriers its monoid admits. */
export type CombineFn = "add" | "union" | "intersection" | "greatest" | "concat"

/** What a fold's step reads of its member: nothing, the count's step of one, or a value. */
export type CombineStep<E> = { readonly kind: "one" } | { readonly kind: "value"; readonly expr: E }

/**
 * How a combine builds an expression of its caller's representation: the constant one a count adds, and an
 * application of one of the Compute operations to two operands.
 */
export interface CombineBuild<E> {
	readonly one: E
	readonly apply: (fn: CombineFn, left: E, right: E) => E
}

/** A closed monoid: its name, its planes, the step it reads, the carriers it admits, its identity and its combine. */
export interface MonoidSpec {
	readonly name: MonoidName
	readonly planes: 1 | 2
	/**
	 * Whether its combine's order is invisible: count, sum, or, twos and max are, so a counted family admits each and
	 * refuses only a visible accumulator; concat is not, so a counted family refuses it.
	 */
	readonly commutative: boolean
	/** count takes no step value; the others one of a carrier `admits` accepts. */
	readonly step: "none" | "value"
	readonly admits: (carrier: ScalarType) => boolean
	/**
	 * The identity of each plane on an admitted carrier: 0, the empty set, the carrier's least value (a closed id's its
	 * roster's first live handle, which the lowering writes as its code), or the empty text. A carrier the monoid does
	 * not admit is a defect: the checker admits the fold's carriers first.
	 */
	readonly identity: (carrier: ScalarType) => NonEmptyReadonlyArray<TypedLiteral>
	/**
	 * Each plane's after from the befores, one per plane, and the step, built by `build`: total operations only, so
	 * every after is a generation expression.
	 */
	readonly combine: <E>(
		befores: NonEmptyReadonlyArray<E>,
		step: CombineStep<E>,
		build: CombineBuild<E>
	) => NonEmptyReadonlyArray<E>
}

/** Whether a type is natural: the builtin contract over bigint whose values are never below zero. */
const isNatural = (t: ScalarType): boolean => {
	const contract = contractOf(t)
	return contract?.name === "natural" && baseOf(t).carrier === "int8"
}

/**
 * The carriers sum admits: an exact one, whose sums never round and whose combine a CHECK proves in exact arithmetic:
 * the integer types, natural and numeric(p, s), never a float. Money is none: its exact arithmetic is through its
 * STABLE cast to numeric, which no CHECK holds, and its own addition raises on overflow instead of failing the law, so
 * a sum of money is a numeric(p, s) or a bigint of its minor units.
 */
const summable = (t: ScalarType): boolean => {
	const base = baseOf(t)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return true
		case "numeric":
			return base.typmod !== undefined
		case "money":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return false
	}
}

/**
 * The carriers max admits: those with min and max and a least value, which its identity is: the integer types,
 * natural, a closed id and money.
 */
const bounded = (t: ScalarType): boolean => {
	switch (baseOf(t).carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "code":
		case "money":
			return true
		case "numeric":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bits":
		case "range4":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return false
	}
}

const isSet = (t: ScalarType): boolean => baseOf(t).carrier === "bits"

/** The carriers concat admits: text, refined or not; an accumulator's start, the empty text, is of its language. */
const isText = (t: ScalarType): boolean => baseOf(t).carrier === "text"

const zeroInteger: TypedLiteral = Object.freeze({ kind: "int", value: 0n })
const emptySet: TypedLiteral = Object.freeze({ kind: "handles", handles: Object.freeze([]) })
const emptyText: TypedLiteral = Object.freeze({ kind: "text", value: "" })

/** A literal of a parsed payload: a payload the module spells itself always parses, so a miss is a defect. */
const parsed = <A>(value: A | undefined, what: string): A => {
	if (value === undefined) {
		throw defect(`${what} is a canonical payload`)
	}
	return value
}

/** Zero of a summable carrier. */
const zeroOf = (t: ScalarType): TypedLiteral => {
	const base = baseOf(t)
	switch (base.carrier) {
		case "numeric":
			return { kind: "numeric", value: parsed(DecimalText.parse("0"), "0") }
		case "int2":
		case "int4":
		case "int8":
			return zeroInteger
		case "money":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			throw defect(`sum admits ${base.carrier}`)
	}
}

/** The least value of a carrier max admits: natural's 0, an integer type's minimum, a closed id's first code. */
const leastOf = (t: ScalarType): TypedLiteral => {
	if (isNatural(t)) {
		return zeroInteger
	}
	const base = baseOf(t)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return { kind: "int", value: integerRanges[base.carrier][0] }
		case "code":
			return { kind: "handle", handle: base.roster.handles[0] }
		case "money":
			return { kind: "money", value: parsed(MoneyText.parse(`${int8Min.value}`), "money's least") }
		case "numeric":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bits":
		case "range4":
		case "range8":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			throw defect(`max admits ${base.carrier}`)
	}
}

/** The step value of a monoid that reads one: count's reads none, so a value step there is a defect. */
const stepValue = <E>(step: CombineStep<E>, build: CombineBuild<E>): E =>
	step.kind === "value" ? step.expr : build.one

const count: MonoidSpec = {
	name: "count",
	planes: 1,
	commutative: true,
	step: "none",
	admits: isNatural,
	identity: () => [zeroInteger],
	combine: ([before], step, build) => {
		if (step.kind === "value") {
			throw defect("count reads no step value")
		}
		return [build.apply("add", before, build.one)]
	}
}

const sum: MonoidSpec = {
	name: "sum",
	planes: 1,
	commutative: true,
	step: "value",
	admits: summable,
	identity: (carrier) => [zeroOf(carrier)],
	combine: ([before], step, build) => [build.apply("add", before, stepValue(step, build))]
}

const or: MonoidSpec = {
	name: "or",
	planes: 1,
	commutative: true,
	step: "value",
	admits: isSet,
	identity: () => [emptySet],
	combine: ([before], step, build) => [build.apply("union", before, stepValue(step, build))]
}

const twos: MonoidSpec = {
	name: "twos",
	planes: 2,
	commutative: true,
	step: "value",
	admits: isSet,
	identity: () => [emptySet, emptySet],
	combine: ([ones, plane], step, build) => {
		if (plane === undefined) {
			throw defect("twos has two planes")
		}
		const x = stepValue(step, build)
		return [
			build.apply("union", ones, x),
			build.apply("union", plane, build.apply("intersection", ones, x))
		]
	}
}

const max: MonoidSpec = {
	name: "max",
	planes: 1,
	commutative: true,
	step: "value",
	admits: bounded,
	identity: (carrier) => [leastOf(carrier)],
	combine: ([before], step, build) => [build.apply("greatest", before, stepValue(step, build))]
}

/**
 * Text's free monoid: the empty text, and `before || x`. A separator is no part of it: a separated join has no identity
 * on text, since the empty text joined to x would be the separator and x. A sequence's member, which knows its index,
 * states the separator in its own step value instead: its token with the separator before it, but at index 0, so the
 * fold's end is the tokens joined by the separator.
 */
const concat: MonoidSpec = {
	name: "concat",
	planes: 1,
	commutative: false,
	step: "value",
	admits: isText,
	identity: () => [emptyText],
	combine: ([before], step, build) => [build.apply("concat", before, stepValue(step, build))]
}

/** The admitted monoids, by name. */
export const monoids: { readonly [M in MonoidName]: MonoidSpec } = Object.freeze({
	count: Object.freeze(count),
	sum: Object.freeze(sum),
	or: Object.freeze(or),
	twos: Object.freeze(twos),
	max: Object.freeze(max),
	concat: Object.freeze(concat)
})
