import { compute as C } from "#compiler/scalar/compute/builders.ts"
import { guarded } from "#compiler/scalar/compute/term.ts"
import type { ComputeApi } from "#compiler/types/compute/compute.ts"

const catalogue: ComputeApi = {
	literal: (type, value) => C.literal(type, value),
	base: (x) => C.base(x),
	cast: (x, to) => C.cast(x, to),
	add: (a, b) => C.add(a, b),
	sub: (a, b) => C.sub(a, b),
	mul: (a, b) => C.mul(a, b),
	div: (a, b) => C.div(a, b),
	mod: (a, b) => C.mod(a, b),
	neg: (a) => C.neg(a),
	quot: (a, b) => C.quot(a, b),
	rem: (a, b) => C.rem(a, b),
	abs: (a) => C.abs(a),
	sign: (a) => C.sign(a),
	round: (a, ...scale) => C.round(a, ...scale),
	trunc: (a, ...scale) => C.trunc(a, ...scale),
	ceil: (a) => C.ceil(a),
	floor: (a) => C.floor(a),
	gcd: (a, b) => C.gcd(a, b),
	lcm: (a, b) => C.lcm(a, b),
	power: (a, b) => C.power(a, b),
	sqrt: (a) => C.sqrt(a),
	least: (first, ...rest) => C.least(first, rest),
	greatest: (first, ...rest) => C.greatest(first, rest),
	widthBucket: (x, low, high, count) => C.widthBucket(x, low, high, count),
	minScale: (a) => C.minScale(a),
	cond: (p, then, otherwise) => C.cond(p, then, otherwise),
	when: (guard, then, otherwise) => C.when(guard, then(guard[guarded]), otherwise),
	nonzero: (x) => C.nonzero(x),
	nonnegative: (x) => C.nonnegative(x),
	positive: (x) => C.positive(x),
	isFinite: (x) => C.isFinite(x),
	within: (x, low, high) => C.within(x, low, high),
	not: (p) => C.not(p),
	and: (...ps) => C.and(ps),
	or: (...ps) => C.or(ps),
	eq: (a, b) => C.eq(a, b),
	ne: (a, b) => C.ne(a, b),
	lt: (a, b) => C.lt(a, b),
	le: (a, b) => C.le(a, b),
	gt: (a, b) => C.gt(a, b),
	ge: (a, b) => C.ge(a, b),
	between: (a, low, high) => C.between(a, low, high),
	in: (a, values) => C.in(a, values),
	lower: (s, endpoint) => C.lower(s, endpoint),
	upper: (s, endpoint) => C.upper(s, endpoint),
	width: (s, endpoint) => C.width(s, endpoint),
	charLength: (s) => C.charLength(s),
	cosineDistance: (a, b) => C.cosineDistance(a, b)
}

/**
 * Public barrel: the Compute catalogue of scalar expressions and their typing. Term and Predicate are the scalar
 * expression types every area threads, Meets the one relation a position takes a term by, and Facts what a term's
 * values are proved to have; LiteralOf and SqlOf are the field barrel's.
 *
 * Compute is the typed builders of packages/engine/src/scalar/compute bound to their public signature, ComputeApi
 * (types/compute): every member is implemented under its signature, and returns the term its builder made, whose
 * column the builder read off its operand's or descriptor's carrier, or off the result table keyed by its operand's SQL
 * type, so the term has the column and SQL type the signature gives it by construction. A term's parameters and origin
 * are phantoms no runtime value holds. Compute.when hands its branch's function the term its guard holds, which is
 * the guard's subject with the guard's facts proved, and builds over the term the function returns.
 */
export const Compute: ComputeApi = Object.freeze(catalogue)

export type { AvgSql, PlainHost, QuotientSql, SumSql } from "#compiler/scalar/compute/tables.ts"
export type { BaseOf, Facts, Meets, Predicate, Term } from "#compiler/types/core/phantom.ts"
export type { Scalar } from "#compiler/types/compute/scalar.ts"
export type { ScalarHelpers } from "#compiler/types/compute/compute.ts"
