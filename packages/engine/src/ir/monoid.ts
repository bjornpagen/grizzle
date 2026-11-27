/**
 * The closed monoids a fold accumulates in, each over the carriers it admits: its planes, each the operation it
 * accumulates by and what it accumulates at a step, and its identity on each. Every operation but concat commutes, so a
 * fold over a counted family, whose order is hidden, has one value whatever order its members are in; concat, text's
 * free monoid, does not, so only a sequence, an ordered family or a tree, folds by it (check/fold.ts foldRule).
 *
 * A monoid is data, read by every site that draws or proves a fold: the CHECK that proves each after and the law of a
 * fold's ends (`combine` over descriptions), the host's fill (`combine` over host values), and each window a statement
 * draws a plane by (`accumulations`: its aggregate, its arithmetic, and a step off the fold's selection). No site
 * dispatches on a monoid's name.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { int8Min } from "#compiler/ir/carriers.ts"
import { integerRanges, MoneyText } from "#compiler/ir/carriers.ts"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { MonoidName } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { baseOf, naturalName, type ScalarType } from "#compiler/ir/scalar.ts"

/** The associative operations a plane accumulates by, each total over the carriers its monoid admits: an exact sum, a
 * set's union, the greater of two values, and text's concatenation. */
export type AccumulateFn = "add" | "union" | "greatest" | "concat"

/** The scalar operations a combine applies: a plane's accumulation, and the meet twos's second plane steps by. */
export type CombineFn = AccumulateFn | "intersection"

/** What a fold's step reads of its member: nothing, the count's step of one, or a value. */
export type CombineStep<E> = { readonly kind: "one" } | { readonly kind: "value"; readonly expr: E }

/**
 * How a combine builds an expression of its caller's representation: the constant one a count adds, and an
 * application of one of the scalar operations to two operands.
 */
export interface CombineBuild<E> {
	readonly one: E
	readonly apply: (fn: CombineFn, left: E, right: E) => E
}

/**
 * One plane of a monoid: its after is `fn(before, delta)`, the delta at a step its value (count's one), or (`met`)
 * that value met with the first plane's before, the handles a step sets that a step before it set (twos's second
 * plane).
 */
export interface MonoidPlane {
	readonly fn: AccumulateFn
	readonly delta: "step" | "met"
}

/**
 * A step off a fold's selection, as a window of masked steps reads it: a value the operation leaves any accumulation
 * unchanged by, its identity where it has one of its own (`zero`, add's 0; `empty`, concat's empty text), or, for an
 * idempotent operation (greatest, union), the plane's first before, which it combines with to itself.
 */
export type OffStep = "zero" | "empty" | "first"

/**
 * How an operation accumulates a run of steps: whether their order is invisible (`commutative`); the aggregate a window
 * of a group's rows in slot order accumulates them by, which is also the one a counted family's hidden end is stated by
 * where the theory has it (sum and max; a union's end is stated handle by handle, and concat's order is visible);
 * whether the steps accumulate exactly, in numeric (`exact`, add's), so no sum rounds or overflows before it is
 * stored; and the step off a fold's selection (`off`).
 */
export interface Accumulation {
	readonly commutative: boolean
	readonly aggregate: "sum" | "max" | "bit_or" | "string_agg"
	readonly exact: boolean
	readonly off: OffStep
}

/** Each operation's accumulation. */
export const accumulations: { readonly [F in AccumulateFn]: Accumulation } = Object.freeze({
	add: Object.freeze({
		commutative: true,
		aggregate: "sum",
		exact: true,
		off: "zero"
	}),
	union: Object.freeze({
		commutative: true,
		aggregate: "bit_or",
		exact: false,
		off: "first"
	}),
	greatest: Object.freeze({
		commutative: true,
		aggregate: "max",
		exact: false,
		off: "first"
	}),
	concat: Object.freeze({
		commutative: false,
		aggregate: "string_agg",
		exact: false,
		off: "empty"
	})
})

/** A closed monoid: its name, its planes, the step it reads, the carriers it admits and its identity. */
export interface MonoidSpec {
	readonly name: MonoidName
	readonly planes: NonEmptyReadonlyArray<MonoidPlane>
	/**
	 * Whether its combine's order is invisible, its planes' operations all commuting: count, sum, or, twos and max are,
	 * so a counted family admits each and refuses only a visible accumulator; concat is not, so a counted family refuses
	 * it.
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
}

/** A step's value: its own, or the one a count adds. */
export const stepValue = <E>(step: CombineStep<E>, build: CombineBuild<E>): E =>
	step.kind === "value" ? step.expr : build.one

/**
 * A plane's delta at `step` (MonoidPlane): the step itself, or its value met with the first plane's before, `ones`,
 * which only a met plane reads.
 */
export const deltaOf = <E>(
	plane: MonoidPlane,
	step: CombineStep<E>,
	ones: () => E,
	build: CombineBuild<E>
): CombineStep<E> => {
	switch (plane.delta) {
		case "step":
			return step
		case "met":
			return { kind: "value", expr: build.apply("intersection", ones(), stepValue(step, build)) }
	}
}

/**
 * Each plane's after from the befores, one per plane, and the step, built by `build`: `fn(before, delta)` (MonoidPlane),
 * total operations only, so every after is a generation expression.
 */
export const combine = <E>(
	monoid: MonoidSpec,
	befores: NonEmptyReadonlyArray<E>,
	step: CombineStep<E>,
	build: CombineBuild<E>
): NonEmptyReadonlyArray<E> =>
	mapNonEmpty(monoid.planes, (plane, p) => {
		const before = defined(befores[p], "a combine reads a before per plane")
		const delta = stepValue(
			deltaOf(plane, step, () => befores[0], build),
			build
		)
		return build.apply(plane.fn, before, delta)
	})

/** Whether a type is natural: the builtin contract over bigint whose values are never below zero. */
const isNatural = (t: ScalarType): boolean => {
	const { contract } = t
	return contract?.name === naturalName && baseOf(t).carrier === "int8"
}

/**
 * The carriers sum admits: an exact one, whose sums never round and whose combine a CHECK proves in exact arithmetic:
 * the integer types, natural and numeric, numeric(p, s) and pg.numeric alike, never a float. numeric's addition is exact
 * at every typmod and at none, its NaN and infinities combining as numeric.c says (scalar/compute/numeric.ts add), and
 * a sum past what its plane holds, numeric(p, s)'s precision or numeric's own limit, is refused with 22003 as an
 * integer's past its width is. Money is none: its exact arithmetic is through its STABLE cast to numeric, which no
 * CHECK holds, and its own addition raises on overflow instead of failing the law, so a sum of money is a numeric or a
 * bigint of its minor units.
 */
const summable = (t: ScalarType): boolean => {
	switch (baseOf(t).carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
			return true
		case "money":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "exactInteger":
		case "exactMoney":
		case "variant":
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
		defect(`${what} is a canonical payload`)
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
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "exactInteger":
		case "exactMoney":
		case "variant":
			defect(`sum admits ${base.carrier}`)
	}
}

/**
 * The least value of a type, which max's identity is, where it has one: natural's 0, an integer type's minimum, money's,
 * and an ordered roster's closed id's first handle, which holds its least code. None for every other: an unordered
 * roster's closed id has no min or max (scalar/native.ts unorderedCodeCapabilities), since no handle comes before
 * another, and an empty roster's has no value at all.
 */
const leastOf = (t: ScalarType): TypedLiteral | undefined => {
	if (isNatural(t)) {
		return zeroInteger
	}
	const base = baseOf(t)
	switch (base.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return { kind: "int", value: integerRanges[base.carrier][0] }
		case "code": {
			const [first] = base.roster.handles
			return base.caps.includes("minMax") && first !== undefined
				? { kind: "handle", handle: first }
				: undefined
		}
		case "money":
			return { kind: "money", value: parsed(MoneyText.parse(`${int8Min}`), "money's least") }
		case "numeric":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "exactInteger":
		case "exactMoney":
		case "variant":
			return undefined
	}
}

/** The carriers max admits: those with a least value (leastOf), which its identity is. */
const bounded = (t: ScalarType): boolean => leastOf(t) !== undefined

/** A monoid of `planes`, its commutativity theirs. */
const monoid = (spec: Omit<MonoidSpec, "commutative">): MonoidSpec =>
	Object.freeze({
		...spec,
		planes: Object.freeze(mapNonEmpty(spec.planes, (p) => Object.freeze(p))),
		commutative: spec.planes.every((p) => accumulations[p.fn].commutative)
	})

const count = monoid({
	name: "count",
	planes: [{ fn: "add", delta: "step" }],
	step: "none",
	admits: isNatural,
	identity: () => [zeroInteger]
})

const sum = monoid({
	name: "sum",
	planes: [{ fn: "add", delta: "step" }],
	step: "value",
	admits: summable,
	identity: (carrier) => [zeroOf(carrier)]
})

const or = monoid({
	name: "or",
	planes: [{ fn: "union", delta: "step" }],
	step: "value",
	admits: isSet,
	identity: () => [emptySet]
})

/** Two planes over a set: the handles some step sets, and the handles two steps set. */
const twos = monoid({
	name: "twos",
	planes: [
		{ fn: "union", delta: "step" },
		{ fn: "union", delta: "met" }
	],
	step: "value",
	admits: isSet,
	identity: () => [emptySet, emptySet]
})

const max = monoid({
	name: "max",
	planes: [{ fn: "greatest", delta: "step" }],
	step: "value",
	admits: bounded,
	identity: (carrier) => [defined(leastOf(carrier), `max admits ${baseOf(carrier).carrier}`)]
})

/**
 * Text's free monoid: the empty text, and `before || x`. A separator is no part of it: a separated join has no identity
 * on text, since the empty text joined to x would be the separator and x. A sequence's member, which knows its index,
 * states the separator in its own step value instead: its token with the separator before it, but at index 0, so the
 * fold's end is the tokens joined by the separator.
 */
const concat = monoid({
	name: "concat",
	planes: [{ fn: "concat", delta: "step" }],
	step: "value",
	admits: isText,
	identity: () => [emptyText]
})

/** The admitted monoids, by name. */
export const monoidSpecs: { readonly [M in MonoidName]: MonoidSpec } = Object.freeze({
	count,
	sum,
	or,
	twos,
	max,
	concat
})
