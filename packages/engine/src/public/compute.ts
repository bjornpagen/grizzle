import { callFields, callRows, callTerm } from "#compiler/query/build/call.ts"
import { compute as C } from "#compiler/scalar/compute/builders.ts"
import { guarded } from "#compiler/scalar/compute/term.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type {
	CryptoApi,
	DistanceApi,
	FnApi,
	LogicApi,
	NetApi,
	NumApi,
	RangeApi,
	SearchApi,
	TextApi,
	TimeApi,
	TypeApi,
	XmlApi
} from "#compiler/types/compute/compute.ts"

/**
 * Public barrel: the scalar catalogue of expressions and their typing, in the namespaces whose domain each member reads
 * (types/compute/compute.ts), Bit the field barrel's, beside Bit.of. Term and Predicate are the scalar
 * expression types every area threads, Meets the one relation a position takes a term by, and Facts what a term's
 * values are proved to have; LiteralOf and SqlOf are the field barrel's.
 *
 * Each namespace is the typed builders of packages/engine/src/scalar/compute bound to its public signature (TypeApi,
 * NumApi, …): every member is implemented under its signature, and returns the term its builder made, whose column the
 * builder read off its operand's or descriptor's carrier, or off the result table keyed by its operand's SQL type, so
 * the term has the column and SQL type the signature gives it by construction. A term's parameters and origin are
 * phantoms no runtime value holds. Logic.when hands its branch's function the term its guard holds, which is the
 * guard's subject with the guard's facts proved, and builds over the term the function returns.
 *
 * Type: a typed constant of a descriptor's type, a domain dropped to its base, and a checked cast, into a consumer's
 * domain under its key.
 */
export const Type: TypeApi = Object.freeze<TypeApi>({
	literal: (type, value) => C.literal(type, value),
	base: (x) => C.base(x),
	cast: (x, to, ...key) => C.cast(x, to, ...key)
})

/** Num: arithmetic, rounding and the numeric functions over the numeric family, and the guards over it. */
export const Num: NumApi = Object.freeze<NumApi>({
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
	widthBucket: (x, low, high, count) => C.widthBucket(x, low, high, count),
	minScale: (a) => C.minScale(a),
	numeric: (a) => C.numeric(a),
	floatBits: (x) => C.floatBits(x),
	nonzero: (x) => C.nonzero(x),
	nonnegative: (x) => C.nonnegative(x),
	positive: (x) => C.positive(x),
	isFinite: (x) => C.isFinite(x),
	within: (x, low, high) => C.within(x, low, high)
})

/**
 * Logic: the comparisons, LEAST and GREATEST, the connectives and the conditionals, over any type they order or
 * compare.
 */
export const Logic: LogicApi = Object.freeze<LogicApi>({
	cond: (p, then, otherwise) => C.cond(p, then, otherwise),
	when: (guard, then, otherwise) => C.when(guard, then(guard[guarded]), otherwise),
	not: (p) => C.not(p),
	and: (ps) => C.and(ps),
	or: (ps) => C.or(ps),
	eq: (a, b) => C.eq(a, b),
	ne: (a, b) => C.ne(a, b),
	lt: (a, b) => C.lt(a, b),
	le: (a, b) => C.le(a, b),
	gt: (a, b) => C.gt(a, b),
	ge: (a, b) => C.ge(a, b),
	between: (a, low, high) => C.between(a, low, high),
	in: (a, values) => C.in(a, values),
	least: (first, ...rest) => C.least(first, rest),
	greatest: (first, ...rest) => C.greatest(first, rest)
})

/** Range: a range term's endpoints and its width, each of the range's endpoint descriptor's type. */
export const Range: RangeApi = Object.freeze<RangeApi>({
	lower: (s, endpoint) => C.lower(s, endpoint),
	upper: (s, endpoint) => C.upper(s, endpoint),
	width: (s, endpoint) => C.width(s, endpoint)
})

/** A range's host value, its start and its end, as a read delivers one and a write takes it, half-open: [start, end). */
export type Range<E> = Span<E>

/**
 * Text: text's lengths, concatenation, prefixes, suffixes and containment, patterns in grizzle's grammar and their
 * matches, transforms, references, cuts at the first of a set of characters and lexical parses.
 */
export const Text: TextApi = Object.freeze<TextApi>({
	charLength: (s) => C.charLength(s),
	octetLength: (s) => C.octetLength(s),
	utf16Length: (s) => C.utf16Length(s),
	concat: (a, b) => C.concat(a, b),
	startsWith: (a, b) => C.startsWith(a, b),
	endsWith: (a, b) => C.endsWith(a, b),
	contains: (haystack, needle) => C.contains(haystack, needle),
	pattern: (source) => C.pattern(source),
	matches: (subject, pattern) => C.matches(subject, pattern),
	translate: (x, from, to) => C.translate(x, from, to),
	lowerAscii: (x) => C.lowerAscii(x),
	replaceWhitespace: (x) => C.replaceWhitespace(x),
	collapse: (x) => C.collapse(x),
	resolveReference: (base, reference) => C.resolveReference(base, reference),
	cutBefore: (x, chars) => C.cutBefore(x, chars),
	cutFrom: (x, chars) => C.cutFrom(x, chars),
	replace: (x, from, to) => C.replace(x, from, to),
	parseFloat8: (x) => C.parseFloat8(x),
	parseNumeric: (x) => C.parseNumeric(x)
})

/** Xml: XML Schema 1.0's pattern dialect, a pattern facet written in it and the test that a text is one. */
export const Xml: XmlApi = Object.freeze<XmlApi>({
	pattern: (source) => C.xsdPattern(source),
	isPattern: (x) => C.isXsdPattern(x)
})

/** Crypto: a value's SHA-256 digest. */
export const Crypto: CryptoApi = Object.freeze<CryptoApi>({
	sha256: (x) => C.sha256(x)
})

/** Distance: the distance between two vectors. */
export const Distance: DistanceApi = Object.freeze<DistanceApi>({
	cosine: (a, b) => C.cosineDistance(a, b)
})

/** Search: a text search query made under a document's configuration, a document's match of one and its ranks. */
export const Search: SearchApi = Object.freeze<SearchApi>({
	websearch: (text) => C.websearchQuery(text),
	plain: (text) => C.plainQuery(text),
	matches: (document, query) => C.textMatches(document, query),
	rank: (document, query) => C.textRank(document, query),
	rankCd: (document, query) => C.textRankCd(document, query)
})

/** Net: the containment of the network address types, inet and cidr. */
export const Net: NetApi = Object.freeze<NetApi>({
	within: (a, b) => C.netWithin(a, b),
	strictlyWithin: (a, b) => C.netStrictlyWithin(a, b),
	overlaps: (a, b) => C.netOverlaps(a, b)
})

/** Time: a zone's wall clock at an instant, by PostgreSQL's tzdata, and a date's epoch day and the date of one. */
export const Time: TimeApi = Object.freeze<TimeApi>({
	wall: (instant, zone) => C.wall(instant, zone),
	epochDay: (date) => C.epochDay(date),
	dateOfEpochDay: (days) => C.dateOfEpochDay(days)
})

/** Fn: a declared function called at its arguments, for its value, its rows or its one row. */
export const Fn: FnApi = Object.freeze<FnApi>({
	call: (f, args) => callTerm(f, args),
	rows: (f, args) => callRows(f, args),
	row: (f, args) => callFields(f, args)
})

export { floatBits } from "#compiler/scalar/compute/float.ts"

export type { AvgSql, PlainHost, QuotientSql, SumSql } from "#compiler/scalar/compute/tables.ts"
export type { BaseOf, Facts, Meets, Predicate, Term } from "#compiler/types/core/phantom.ts"
export type { Scalar } from "#compiler/types/compute/scalar.ts"
export type { ScalarHelpers } from "#compiler/types/compute/compute.ts"
